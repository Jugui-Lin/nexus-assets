#[tauri::command]
pub(crate) async fn create_desktop_shortcut() -> Result<String, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(windows_shortcut::create)
        .await
        .map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    Err("当前系统不支持添加 Windows 桌面快捷方式".into())
}

#[cfg(windows)]
pub(crate) fn write_file_shortcut(
    shortcut: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    windows_shortcut::write_file_shortcut(shortcut, target)
}

#[cfg(windows)]
mod windows_shortcut {
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

    pub(super) fn create() -> Result<String, String> {
        let _apartment = Apartment::initialize()?;
        let desktop = unsafe { SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DONT_VERIFY, None) }
            .map_err(|error| format!("无法找到当前用户的桌面：{error}"))?;
        let desktop_path = unsafe { PathBuf::from(OsString::from_wide(desktop.as_wide())) };
        unsafe { CoTaskMemFree(Some(desktop.0.cast())) };
        let executable = std::env::current_exe()
            .map_err(|error| format!("无法找到 Nexus Assets 程序：{error}"))?;
        create_in(&desktop_path, &executable)
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain([0]).collect()
    }

    fn create_in(directory: &Path, executable: &Path) -> Result<String, String> {
        let shortcut = directory.join(SHORTCUT_NAME);
        if check_existing(&shortcut, executable)? {
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
        save_shortcut(&temporary, executable, w!("Nexus Assets"))
            .map_err(|error| format!("无法保存桌面快捷方式：{error}"))?;
        let source = wide(temporary.as_os_str());
        let destination = wide(shortcut.as_os_str());
        if let Err(error) =
            unsafe { MoveFileW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr())) }
        {
            if check_existing(&shortcut, executable)? {
                return Ok("桌面快捷方式已存在".into());
            }
            return Err(format!("无法放置桌面快捷方式：{error}"));
        }
        Ok("已添加桌面快捷方式".into())
    }

    pub(super) fn write_file_shortcut(shortcut: &Path, target: &Path) -> Result<(), String> {
        let _apartment = Apartment::initialize()?;
        save_shortcut(shortcut, target, w!(""))
            .map_err(|error| format!("无法保存快捷方式：{error}"))
    }

    fn save_shortcut(
        shortcut: &Path,
        executable: &Path,
        description: PCWSTR,
    ) -> windows::core::Result<()> {
        let target = wide(executable.as_os_str());
        let filename = wide(shortcut.as_os_str());
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(PCWSTR(target.as_ptr()))?;
            link.SetDescription(description)?;
            if let Some(parent) = executable.parent() {
                let working_directory = wide(parent.as_os_str());
                link.SetWorkingDirectory(PCWSTR(working_directory.as_ptr()))?;
            }
            link.cast::<IPersistFile>()?
                .Save(PCWSTR(filename.as_ptr()), true)
        }
    }

    fn check_existing(shortcut: &Path, executable: &Path) -> Result<bool, String> {
        match fs::symlink_metadata(shortcut) {
            Ok(metadata) if metadata.is_file() => {
                if let Some(target) = shortcut_target(shortcut) {
                    if same_file::is_same_file(target, executable).unwrap_or(false) {
                        return Ok(true);
                    }
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("无法检查现有桌面快捷方式：{error}")),
        }
        Err(format!("桌面已有同名项目 {SHORTCUT_NAME}，已保留原文件"))
    }

    fn shortcut_target(shortcut: &Path) -> Option<PathBuf> {
        let filename = wide(shortcut.as_os_str());
        let mut target = vec![0u16; 32_768];
        unsafe {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            link.cast::<IPersistFile>()
                .ok()?
                .Load(PCWSTR(filename.as_ptr()), STGM_READ)
                .ok()?;
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
                create_in(desktop.path(), &executable).unwrap(),
                "已添加桌面快捷方式"
            );
            let shortcut = desktop.path().join(SHORTCUT_NAME);
            assert!(
                same_file::is_same_file(shortcut_target(&shortcut).unwrap(), &executable).unwrap()
            );
            let original = fs::read(&shortcut).unwrap();
            assert_eq!(
                create_in(desktop.path(), &executable).unwrap(),
                "桌面快捷方式已存在"
            );
            assert_eq!(fs::read(&shortcut).unwrap(), original);

            let conflict = tempfile::tempdir().unwrap();
            let existing = conflict.path().join(SHORTCUT_NAME);
            fs::write(&existing, b"existing item").unwrap();
            assert!(create_in(conflict.path(), &executable).is_err());
            assert_eq!(fs::read(existing).unwrap(), b"existing item");
        }
    }
}
