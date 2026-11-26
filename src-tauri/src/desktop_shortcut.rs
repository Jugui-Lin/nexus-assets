#[tauri::command]
pub(crate) async fn create_desktop_shortcut(folder_path: Option<String>) -> Result<String, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || windows_shortcut::create(folder_path))
        .await
        .map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = folder_path;
        Err("当前系统不支持添加 Windows 桌面快捷方式".into())
    }
}

#[cfg(windows)]
pub(crate) fn write_file_shortcut(
    shortcut: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    windows_shortcut::write_file_shortcut(shortcut, target)
}

#[cfg(windows)]
pub(crate) fn read_file_shortcut(shortcut: &std::path::Path) -> Option<std::path::PathBuf> {
    windows_shortcut::read_file_shortcut(shortcut)
}

#[cfg(windows)]
mod windows_shortcut {
    use sha2::{Digest, Sha256};
    use std::{
        ffi::{OsStr, OsString},
        fs,
        io::ErrorKind,
        os::windows::ffi::{OsStrExt, OsStringExt},
        path::{Path, PathBuf},
    };
    use windows::{
        core::{w, Interface, PCWSTR},
        Win32::{
            Storage::FileSystem::MoveFileW,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
            },
            UI::Shell::{
                FOLDERID_Desktop, IShellLinkW, SHGetKnownFolderPath, ShellLink,
                KF_FLAG_DONT_VERIFY, SLGP_RAWPATH,
            },
        },
    };

    const SHORTCUT_NAME: &str = "Nexus Assets.lnk";

    struct Apartment;

    impl Apartment {
        fn initialize() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|error| format!("无法初始化 Windows 快捷方式：{error}"))?;
            Ok(Self)
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub(super) fn create(folder_path: Option<String>) -> Result<String, String> {
        let _apartment = Apartment::initialize()?;
        let desktop = unsafe { SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DONT_VERIFY, None) }
            .map_err(|error| format!("无法找到当前用户的桌面：{error}"))?;
        let desktop_path = unsafe { PathBuf::from(OsString::from_wide(desktop.as_wide())) };
        unsafe { CoTaskMemFree(Some(desktop.0.cast())) };
        let executable = std::env::current_exe()
            .map_err(|error| format!("无法找到 Nexus Assets 程序：{error}"))?;
        if let Some(folder_path) = folder_path {
            let folder = Path::new(&folder_path);
            crate::local_explorer::validate_file_path(folder)?;
            if !folder.is_dir() {
                return Err("目前无法访问这个文件夹".into());
            }
            let (filename, arguments) = folder_shortcut(folder, &folder_path);
            create_in(&desktop_path, &executable, &filename, &arguments)
        } else {
            create_in(&desktop_path, &executable, SHORTCUT_NAME, "")
        }
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain([0]).collect()
    }

    fn folder_shortcut(folder: &Path, path: &str) -> (String, String) {
        let label: String = folder
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("文件夹")
            .chars()
            .take(60)
            .collect();
        let hash: String = Sha256::digest(path.as_bytes())[..5]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let filename = format!(
            "Nexus - {} [{hash}].lnk",
            label.trim_end_matches([' ', '.'])
        );
        // A trailing dot segment prevents a drive root backslash from escaping the quote.
        let arguments = format!(r#"--open-folder "{path}\.""#);
        (filename, arguments)
    }

    fn create_in(
        directory: &Path,
        executable: &Path,
        filename: &str,
        arguments: &str,
    ) -> Result<String, String> {
        let shortcut = directory.join(filename);
        if check_existing(&shortcut, executable, arguments)? {
            return Ok("桌面快捷方式已存在".into());
        }

        // Save next to the destination so a later same-volume move can publish the
        // complete link without replacing anything that appeared in the meantime.
        let temporary = tempfile::Builder::new()
            .prefix(".nexus-shortcut-")
            .suffix(".lnk")
            .tempfile_in(directory)
            .map_err(|error| format!("无法在桌面创建快捷方式：{error}"))?
            .into_temp_path();
        save_shortcut(&temporary, executable, w!("Nexus Assets"), arguments)
            .map_err(|error| format!("无法保存桌面快捷方式：{error}"))?;
        let source = wide(temporary.as_os_str());
        let destination = wide(shortcut.as_os_str());
        if let Err(error) =
            unsafe { MoveFileW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr())) }
        {
            if check_existing(&shortcut, executable, arguments)? {
                return Ok("桌面快捷方式已存在".into());
            }
            return Err(format!("无法放置桌面快捷方式：{error}"));
        }
        Ok("已添加桌面快捷方式".into())
    }

    pub(super) fn write_file_shortcut(shortcut: &Path, target: &Path) -> Result<(), String> {
        let _apartment = Apartment::initialize()?;
        save_shortcut(shortcut, target, w!(""), "")
            .map_err(|error| format!("无法保存快捷方式：{error}"))
    }

    fn save_shortcut(
        shortcut: &Path,
        executable: &Path,
        description: PCWSTR,
        arguments: &str,
    ) -> windows::core::Result<()> {
        let target = wide(executable.as_os_str());
        let filename = wide(shortcut.as_os_str());
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(PCWSTR(target.as_ptr()))?;
            link.SetDescription(description)?;
            if !arguments.is_empty() {
                let arguments = wide(OsStr::new(arguments));
                link.SetArguments(PCWSTR(arguments.as_ptr()))?;
            }
            if let Some(parent) = executable.parent() {
                let working_directory = wide(parent.as_os_str());
                link.SetWorkingDirectory(PCWSTR(working_directory.as_ptr()))?;
            }
            link.cast::<IPersistFile>()?
                .Save(PCWSTR(filename.as_ptr()), true)
        }
    }

    fn check_existing(shortcut: &Path, executable: &Path, arguments: &str) -> Result<bool, String> {
        match fs::symlink_metadata(shortcut) {
            Ok(metadata) if metadata.is_file() => {
                if let Some(link) = load_link(shortcut) {
                    if let Some(target) = shortcut_target(&link) {
                        let mut stored = vec![0u16; 32_768];
                        if same_file::is_same_file(target, executable).unwrap_or(false)
                            && unsafe { link.GetArguments(&mut stored) }.is_ok()
                            && stored
                                .iter()
                                .position(|&unit| unit == 0)
                                .is_some_and(|end| {
                                    stored[..end].iter().copied().eq(arguments.encode_utf16())
                                })
                        {
                            return Ok(true);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("无法检查现有桌面快捷方式：{error}")),
        }
        Err(format!(
            "桌面已有同名项目 {}，已保留原文件",
            shortcut.file_name().unwrap_or_default().to_string_lossy()
        ))
    }

    pub(super) fn read_file_shortcut(shortcut: &Path) -> Option<PathBuf> {
        let _apartment = Apartment::initialize().ok()?;
        shortcut_target(&load_link(shortcut)?)
    }

    fn load_link(shortcut: &Path) -> Option<IShellLinkW> {
        let filename = wide(shortcut.as_os_str());
        unsafe {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            link.cast::<IPersistFile>()
                .ok()?
                .Load(PCWSTR(filename.as_ptr()), STGM_READ)
                .ok()?;
            Some(link)
        }
    }

    fn shortcut_target(link: &IShellLinkW) -> Option<PathBuf> {
        let mut target = vec![0u16; 32_768];
        unsafe {
            link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                .ok()?;
        }
        let end = target.iter().position(|&unit| unit == 0)?;
        let path = PathBuf::from(OsString::from_wide(&target[..end]));
        path.is_absolute().then_some(path)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn creates_shortcut_once_and_preserves_a_conflicting_item() {
            let _apartment = Apartment::initialize().unwrap();
            let desktop = tempfile::tempdir().unwrap();
            let executable = std::env::current_exe().unwrap();
            assert_eq!(
                create_in(desktop.path(), &executable, SHORTCUT_NAME, "").unwrap(),
                "已添加桌面快捷方式"
            );
            let shortcut = desktop.path().join(SHORTCUT_NAME);
            assert!(
                same_file::is_same_file(read_file_shortcut(&shortcut).unwrap(), &executable)
                    .unwrap()
            );
            let original = fs::read(&shortcut).unwrap();
            assert_eq!(
                create_in(desktop.path(), &executable, SHORTCUT_NAME, "").unwrap(),
                "桌面快捷方式已存在"
            );
            assert_eq!(fs::read(&shortcut).unwrap(), original);

            let conflict = tempfile::tempdir().unwrap();
            let existing = conflict.path().join(SHORTCUT_NAME);
            fs::write(&existing, b"existing item").unwrap();
            assert!(create_in(conflict.path(), &executable, SHORTCUT_NAME, "").is_err());
            assert_eq!(fs::read(existing).unwrap(), b"existing item");
        }

        #[test]
        fn project_link_preserves_spaced_unicode_path_and_arguments() {
            let _apartment = Apartment::initialize().unwrap();
            let desktop = tempfile::tempdir().unwrap();
            let executable = std::env::current_exe().unwrap();
            let folder = r"D:\项目 [2]\原始文件";
            let (filename, arguments) = folder_shortcut(Path::new(folder), folder);
            assert_eq!(arguments, r#"--open-folder "D:\项目 [2]\原始文件\.""#);
            create_in(desktop.path(), &executable, &filename, &arguments).unwrap();
            let shortcut = desktop.path().join(&filename);
            assert!(check_existing(&shortcut, &executable, &arguments).unwrap());
            assert!(check_existing(&shortcut, &executable, "").is_err());
            let other = r"E:\项目 [2]\原始文件";
            assert_ne!(folder_shortcut(Path::new(other), other).0, filename);
        }
    }
}
