use crate::folder_browser;
use serde::Serialize;
use tauri::AppHandle;

#[cfg(windows)]
mod sync_locations;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Places {
    folders: Vec<KnownFolder>,
    drives: Vec<Drive>,
    sync_roots: Vec<folder_browser::FolderEntry>,
}

#[derive(Serialize)]
struct KnownFolder {
    id: &'static str,
    name: &'static str,
    path: String,
}

#[derive(Serialize)]
struct Drive {
    path: String,
    name: String,
    kind: &'static str,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriveDetails {
    label: Option<String>,
    free_bytes: Option<u64>,
    total_bytes: Option<u64>,
}

pub(super) fn list(app: &AppHandle) -> Result<Places, String> {
    #[cfg(windows)]
    let roots = folder_browser::windows_drives()?;
    #[cfg(not(windows))]
    let roots = folder_browser::root_listing(app)?
        .folders
        .into_iter()
        .map(|folder| (folder, "fixed"));
    let drives = roots
        .into_iter()
        .map(|(folder, kind)| Drive {
            kind,
            name: folder.name,
            path: folder.path,
        })
        .collect();
    Ok(Places {
        folders: known_folders(app),
        drives,
        #[cfg(windows)]
        sync_roots: sync_locations::read(),
        #[cfg(not(windows))]
        sync_roots: Vec::new(),
    })
}

#[cfg(not(windows))]
fn known_folders(app: &AppHandle) -> Vec<KnownFolder> {
    use tauri::Manager;

    let path = app.path();
    [
        ("home", "主文件夹", path.home_dir()),
        ("desktop", "桌面", path.desktop_dir()),
        ("downloads", "下载", path.download_dir()),
        ("documents", "文档", path.document_dir()),
        ("pictures", "图片", path.picture_dir()),
        ("music", "音乐", path.audio_dir()),
        ("videos", "视频", path.video_dir()),
    ]
    .into_iter()
    .filter_map(|(id, name, path)| {
        Some(KnownFolder {
            id,
            name,
            path: path.ok()?.into_os_string().into_string().ok()?,
        })
    })
    .collect()
}

#[cfg(not(windows))]
pub(super) async fn drive_details(_path: String) -> Result<DriveDetails, String> {
    Ok(DriveDetails::default())
}

#[cfg(windows)]
pub(super) use windows_places::drive_details;
#[cfg(windows)]
use windows_places::known_folders;

#[cfg(windows)]
mod windows_places {
    use super::*;
    use std::{sync::atomic::Ordering, time::Duration};
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::ERROR_SUCCESS,
            NetworkManagement::WNet::WNetGetConnectionW,
            Storage::FileSystem::{GetDiskFreeSpaceExW, GetVolumeInformationW},
            System::Com::CoTaskMemFree,
            UI::Shell::{
                FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music,
                FOLDERID_Pictures, FOLDERID_Profile, FOLDERID_Videos, SHGetKnownFolderPath,
                KF_FLAG_DONT_VERIFY,
            },
        },
    };

    const DRIVE_DETAILS_TIMEOUT: Duration = Duration::from_millis(1800);
    static DRIVE_DETAILS_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetThreadErrorMode(mode: u32, previous: *mut u32) -> i32;
    }

    pub(in crate::local_explorer::places) fn known_folders(_app: &AppHandle) -> Vec<KnownFolder> {
        [
            ("home", "主文件夹", FOLDERID_Profile),
            ("desktop", "桌面", FOLDERID_Desktop),
            ("downloads", "下载", FOLDERID_Downloads),
            ("documents", "文档", FOLDERID_Documents),
            ("pictures", "图片", FOLDERID_Pictures),
            ("music", "音乐", FOLDERID_Music),
            ("videos", "视频", FOLDERID_Videos),
        ]
        .into_iter()
        .filter_map(|(id, name, folder)| {
            // DONT_VERIFY returns redirected paths without contacting a server.
            let path = unsafe { SHGetKnownFolderPath(&folder, KF_FLAG_DONT_VERIFY, None) }.ok()?;
            let result = unsafe { path.to_string() };
            unsafe { CoTaskMemFree(Some(path.0.cast())) };
            Some(KnownFolder {
                id,
                name,
                path: result.ok()?,
            })
        })
        .collect()
    }

    pub(in crate::local_explorer) async fn drive_details(
        path: String,
    ) -> Result<DriveDetails, String> {
        let root = drive_root(&path).ok_or("请选择有效的磁盘盘符")?;
        let result = folder_browser::read_with_slots(
            &DRIVE_DETAILS_SLOTS,
            DRIVE_DETAILS_TIMEOUT,
            move |cancelled| {
                // SEM_FAILCRITICALERRORS prevents Windows media-error dialogs on this
                // disposable worker when e.g. an optical drive has no disc.
                unsafe { SetThreadErrorMode(1, std::ptr::null_mut()) };
                let mut free = 0;
                let mut total = 0;
                let capacity = unsafe {
                    GetDiskFreeSpaceExW(
                        PCWSTR(root.as_ptr()),
                        Some(&mut free),
                        Some(&mut total),
                        None,
                    )
                }
                .is_ok()
                    && total != 0;
                if cancelled.load(Ordering::Acquire) {
                    return Ok(DriveDetails::default());
                }

                let label = if folder_browser::windows_drive_kind(&root) == "network" {
                    mapped_name(root)
                } else {
                    let mut label = [0; 261];
                    unsafe {
                        GetVolumeInformationW(
                            PCWSTR(root.as_ptr()),
                            Some(&mut label),
                            None,
                            None,
                            None,
                            None,
                        )
                    }
                    .ok()
                    .and_then(|()| read_wide(&label))
                };
                Ok(DriveDetails {
                    label,
                    free_bytes: capacity.then_some(free),
                    total_bytes: capacity.then_some(total),
                })
            },
        )
        .await;
        Ok(result.unwrap_or_default())
    }

    fn drive_root(path: &str) -> Option<[u16; 4]> {
        let [letter, b':', b'\\'] = path.as_bytes() else {
            return None;
        };
        letter
            .is_ascii_alphabetic()
            .then_some([u16::from(*letter), 58, 92, 0])
    }

    fn mapped_name(root: [u16; 4]) -> Option<String> {
        let name = [root[0], root[1], 0];
        let mut label = [0; 2048];
        let mut length = label.len() as u32;
        let code = unsafe {
            WNetGetConnectionW(
                PCWSTR(name.as_ptr()),
                Some(PWSTR(label.as_mut_ptr())),
                &mut length,
            )
        };
        (code == ERROR_SUCCESS).then(|| read_wide(&label)).flatten()
    }

    fn read_wide(value: &[u16]) -> Option<String> {
        let length = value.iter().position(|&word| word == 0)?;
        let value = String::from_utf16(&value[..length]).ok()?;
        (!value.trim().is_empty()).then_some(value)
    }
}
