pub(super) fn normalize_drive(drive: &str) -> Result<String, String> {
    let drive = drive.trim().trim_end_matches(['\\', '/']);
    let letter = drive.trim_end_matches(':').as_bytes();
    if letter.len() != 1 || !letter[0].is_ascii_alphabetic() || drive.len() > 2 {
        return Err("请输入有效的 Windows 盘符，例如 Z:。".into());
    }
    Ok(format!("{}:", letter[0].to_ascii_uppercase() as char))
}

pub(super) fn smb_remote(address: &str) -> Result<String, String> {
    let address = address.trim().replace('/', "\\");
    let invalid_address = || r"请输入 SMB 共享路径，例如 \\NAS\素材库。".to_string();
    let remote = address
        .strip_prefix(r"\\")
        .ok_or_else(invalid_address)?
        .trim_end_matches('\\');
    let mut parts = remote.split('\\');
    let server = parts.next().unwrap_or_default();
    if server.is_empty()
        || server == "."
        || server == ".."
        || server
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "@:?*\"<>|".contains(c))
        || parts.clone().next().is_none()
        || parts.any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part
                    .chars()
                    .any(|c| c.is_control() || ":?*\"<>|".contains(c))
        })
    {
        return Err(invalid_address());
    }
    Ok(format!(r"\\{remote}"))
}

pub(super) fn webdav_url(address: &str) -> Result<reqwest::Url, String> {
    let address = address.trim();
    let invalid_address =
        || "请输入 WebDAV 服务地址，例如 https://nas.example.com/dav/。".to_string();
    if !address.contains("://") || address.contains('\\') || address.chars().any(char::is_control) {
        return Err(invalid_address());
    }
    let url = reqwest::Url::parse(address).map_err(|_| invalid_address())?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(invalid_address());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("请将用户名和密码填写在单独的字段中。".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("请使用 WebDAV 服务目录地址，去掉查询参数和片段。".into());
    }
    Ok(url)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DriveConnection {
    Vacant,
    Occupied,
    Remembered,
    Connected(String),
}

pub(super) fn same_remote(left: &str, right: &str, webdav: bool) -> bool {
    let left = left.trim_end_matches('\\');
    let right = right.trim_end_matches('\\');
    if !webdav {
        return left.eq_ignore_ascii_case(right);
    }
    // A WebDAV server can treat paths as case sensitive.
    match (
        left.trim_start_matches('\\').split_once('\\'),
        right.trim_start_matches('\\').split_once('\\'),
    ) {
        (Some((left_host, left_path)), Some((right_host, right_path))) => {
            left_host.eq_ignore_ascii_case(right_host) && left_path == right_path
        }
        _ => left.eq_ignore_ascii_case(right),
    }
}

#[cfg(windows)]
pub(super) use win::{available_drives, connection, drive_present, mount, unmount, webdav_remote};

#[cfg(windows)]
mod win {
    use super::{normalize_drive, same_remote, webdav_url, DriveConnection};
    use std::{ptr, sync::Mutex};
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::{
                ERROR_ACCESS_DENIED, ERROR_ALREADY_ASSIGNED, ERROR_BAD_DEVICE, ERROR_BAD_NETPATH,
                ERROR_BAD_NET_NAME, ERROR_BAD_USERNAME, ERROR_BUSY, ERROR_CONNECTION_UNAVAIL,
                ERROR_DEVICE_ALREADY_REMEMBERED, ERROR_DEVICE_IN_USE, ERROR_INSUFFICIENT_BUFFER,
                ERROR_INVALID_PASSWORD, ERROR_LOGON_FAILURE, ERROR_MORE_DATA, ERROR_NOT_CONNECTED,
                ERROR_NO_NETWORK, ERROR_NO_NET_OR_BAD_PATH, ERROR_OPEN_FILES,
                ERROR_SESSION_CREDENTIAL_CONFLICT, ERROR_SUCCESS, WIN32_ERROR,
            },
            NetworkManagement::{
                WNet::{
                    WNetAddConnection2W, WNetCancelConnection2W, WNetGetConnectionW,
                    CONNECT_TEMPORARY, NETRESOURCEW, NET_CONNECT_FLAGS, RESOURCETYPE_DISK,
                },
                WebDav::DavGetUNCFromHTTPPath,
            },
            Storage::FileSystem::GetLogicalDrives,
        },
    };

    static CONNECTION_CHANGES: Mutex<()> = Mutex::new(());

    fn utf16(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Password(Vec<u16>);

    impl Drop for Password {
        fn drop(&mut self) {
            for unit in &mut self.0 {
                // Clear the local UTF-16 copy after WNet has returned.
                unsafe { ptr::write_volatile(unit, 0) };
            }
        }
    }

    fn wide_string(buffer: &[u16]) -> String {
        let end = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    pub(in crate::cloud_mounts) fn webdav_remote(address: &str) -> Result<String, String> {
        let url = webdav_url(address)?;
        let url = utf16(url.as_str());
        let mut buffer = vec![0; 1024];
        loop {
            let mut size = buffer.len() as u32;
            // Both pointers reference live, terminated or writable buffers as required by the API.
            let result = WIN32_ERROR(unsafe {
                DavGetUNCFromHTTPPath(
                    PCWSTR(url.as_ptr()),
                    Some(PWSTR(buffer.as_mut_ptr())),
                    &mut size,
                )
            });
            match result {
                ERROR_SUCCESS => return Ok(wide_string(&buffer)),
                ERROR_INSUFFICIENT_BUFFER if size as usize > buffer.len() => {
                    buffer.resize(size as usize, 0);
                }
                error => return Err(windows_error("处理 WebDAV 地址", error, true)),
            }
        }
    }

    fn drive_mask() -> Result<u32, String> {
        let mask = unsafe { GetLogicalDrives() };
        if mask == 0 {
            return Err("Windows 无法读取盘符列表。".into());
        }
        Ok(mask)
    }

    fn drive_bit(drive: &str) -> u32 {
        1 << (drive.as_bytes()[0] - b'A')
    }

    pub(in crate::cloud_mounts) fn drive_present(drive: &str) -> Result<bool, String> {
        let drive = normalize_drive(drive)?;
        Ok(drive_mask()? & drive_bit(&drive) != 0)
    }

    pub(in crate::cloud_mounts) fn available_drives() -> Result<Vec<String>, String> {
        let mask = drive_mask()?;
        Ok((b'D'..=b'Z')
            .rev()
            .filter(|letter| mask & (1 << (letter - b'A')) == 0)
            .map(|letter| format!("{}:", letter as char))
            .collect())
    }

    pub(in crate::cloud_mounts) fn connection(drive: &str) -> Result<DriveConnection, String> {
        let drive = normalize_drive(drive)?;
        let local = utf16(&drive);
        let mut buffer = vec![0; 1024];
        loop {
            let mut size = buffer.len() as u32;
            // The output buffer has room for `size` UTF-16 code units.
            let result = unsafe {
                WNetGetConnectionW(
                    PCWSTR(local.as_ptr()),
                    Some(PWSTR(buffer.as_mut_ptr())),
                    &mut size,
                )
            };
            match result {
                ERROR_SUCCESS => return Ok(DriveConnection::Connected(wide_string(&buffer))),
                ERROR_MORE_DATA if size as usize > buffer.len() => buffer.resize(size as usize, 0),
                ERROR_CONNECTION_UNAVAIL => return Ok(DriveConnection::Remembered),
                ERROR_NOT_CONNECTED | ERROR_BAD_DEVICE => {
                    return Ok(if drive_mask()? & drive_bit(&drive) == 0 {
                        DriveConnection::Vacant
                    } else {
                        DriveConnection::Occupied
                    });
                }
                error => return Err(windows_error("检查网络盘符", error, false)),
            }
        }
    }

    pub(in crate::cloud_mounts) fn mount(
        drive: &str,
        remote: &str,
        webdav: bool,
        username: Option<&str>,
        password: Option<&str>,
    ) -> Result<(), String> {
        let drive = normalize_drive(drive)?;
        if remote.contains('\0')
            || username.is_some_and(|value| value.contains('\0'))
            || password.is_some_and(|value| value.contains('\0'))
        {
            return Err("挂载地址、用户名或密码含有无效字符。".into());
        }
        let _change = CONNECTION_CHANGES
            .lock()
            .map_err(|_| "无法获取网络盘符操作锁。")?;
        if connection(&drive)? != DriveConnection::Vacant {
            return Err(format!(
                "盘符 {drive} 已被占用或由 Windows 保留，请选择其他盘符。"
            ));
        }

        let mut local = utf16(&drive);
        let mut remote = utf16(remote);
        let resource = NETRESOURCEW {
            dwType: RESOURCETYPE_DISK,
            lpLocalName: PWSTR(local.as_mut_ptr()),
            lpRemoteName: PWSTR(remote.as_mut_ptr()),
            ..Default::default()
        };
        let username = username.map(utf16);
        let password = password.map(|value| Password(utf16(value)));
        // The input buffers stay alive for the call. A null credential tells Windows to use its current credentials.
        let result = unsafe {
            WNetAddConnection2W(
                &resource,
                PCWSTR(
                    password
                        .as_ref()
                        .map_or(ptr::null(), |value| value.0.as_ptr()),
                ),
                PCWSTR(
                    username
                        .as_ref()
                        .map_or(ptr::null(), |value| value.as_ptr()),
                ),
                CONNECT_TEMPORARY,
            )
        };
        if result == ERROR_SUCCESS {
            return Ok(());
        }
        Err(windows_error("挂载网络盘符", result, webdav))
    }

    pub(in crate::cloud_mounts) fn unmount(
        drive: &str,
        expected_remote: &str,
        webdav: bool,
    ) -> Result<(), String> {
        let drive = normalize_drive(drive)?;
        let _change = CONNECTION_CHANGES
            .lock()
            .map_err(|_| "无法获取网络盘符操作锁。")?;
        match connection(&drive)? {
            DriveConnection::Vacant => return Ok(()),
            DriveConnection::Connected(remote) if same_remote(&remote, expected_remote, webdav) => {
            }
            _ => return Err(format!("盘符 {drive} 的映射已改变，无法确认它属于此挂载。")),
        }
        let drive = utf16(&drive);
        // Disconnect only the verified drive letter. Zero flags leave Windows profile settings intact.
        let result =
            unsafe { WNetCancelConnection2W(PCWSTR(drive.as_ptr()), NET_CONNECT_FLAGS(0), false) };
        if matches!(result, ERROR_SUCCESS | ERROR_NOT_CONNECTED) {
            return Ok(());
        }
        Err(windows_error("断开网络盘符", result, webdav))
    }

    fn windows_error(operation: &str, error: WIN32_ERROR, webdav: bool) -> String {
        let detail = match error {
            ERROR_ALREADY_ASSIGNED | ERROR_DEVICE_ALREADY_REMEMBERED => {
                "盘符已被占用，请选择其他盘符。"
            }
            ERROR_ACCESS_DENIED => "Windows 拒绝访问，请检查账号和共享目录权限。",
            ERROR_INVALID_PASSWORD | ERROR_LOGON_FAILURE | ERROR_BAD_USERNAME => {
                "身份验证失败，请检查用户名和密码。"
            }
            ERROR_SESSION_CREDENTIAL_CONFLICT => {
                "Windows 已用其他账号连接该服务器，请使用当前会话账号或通过资源管理器管理已有连接。"
            }
            ERROR_OPEN_FILES | ERROR_DEVICE_IN_USE => {
                "盘符仍有文件或任务正在使用，请关闭后再断开。"
            }
            ERROR_BUSY => "Windows 网络服务正忙，请重试。",
            ERROR_BAD_NETPATH
            | ERROR_BAD_NET_NAME
            | ERROR_NO_NET_OR_BAD_PATH
            | ERROR_NO_NETWORK => {
                if webdav {
                    "请检查 WebDAV 服务地址、网络连接和 Windows WebClient 服务。也可以添加已挂载的盘符。"
                } else {
                    "请检查服务器、共享路径和网络连接。"
                }
            }
            _ if webdav => "请检查 WebDAV 服务地址、访问权限和 Windows WebClient 服务。",
            _ => "请检查 Windows 网络连接和共享目录。",
        };
        format!("{operation}失败（Windows 错误 {}）。{detail}", error.0)
    }
}

#[cfg(not(windows))]
const UNSUPPORTED: &str = "此系统请先用系统工具挂载网络位置，再添加已挂载的文件夹。";

#[cfg(not(windows))]
pub(super) fn available_drives() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(not(windows))]
pub(super) fn connection(_drive: &str) -> Result<DriveConnection, String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(windows))]
pub(super) fn drive_present(_drive: &str) -> Result<bool, String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(windows))]
pub(super) fn webdav_remote(_address: &str) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(windows))]
pub(super) fn mount(
    _drive: &str,
    _remote: &str,
    _webdav: bool,
    _username: Option<&str>,
    _password: Option<&str>,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(windows))]
pub(super) fn unmount(_drive: &str, _expected_remote: &str, _webdav: bool) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_network_drive_and_smb_path() {
        assert_eq!(normalize_drive(" z:/ ").unwrap(), "Z:");
        assert!(normalize_drive("Z:/path").is_err());
        assert_eq!(smb_remote("//nas/素材/预设/").unwrap(), r"\\nas\素材\预设");
        for bad in [
            r"\nas\素材",
            r"\\nas",
            r"\\?\C:\素材",
            r"\\.\PIPE\test",
            r"\\nas\share\..",
        ] {
            assert!(smb_remote(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn validates_webdav_url_without_credentials_or_share_links() {
        assert_eq!(
            webdav_url("https://nas:5006/素材").unwrap().host_str(),
            Some("nas")
        );
        for bad in [
            "https://name:pass@nas/share",
            "https://nas/shared?token=secret",
            "https://nas/shared#folder",
            "smb://nas/share",
            "https:nas/share",
            "https://nas\\share",
        ] {
            assert!(webdav_url(bad).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn converts_webdav_address_without_connecting() {
        let remote = webdav_remote("https://nexus.example:5006/dav").unwrap();
        assert!(remote.starts_with(r"\\nexus.example@SSL@5006\"));
        assert!(remote.ends_with(r"\dav"));
    }
}
