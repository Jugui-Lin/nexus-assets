use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::AppHandle;

const MAX_ACTIVE_READS: usize = 4;
const READ_TIMEOUT: Duration = Duration::from_secs(3);
static READ_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(MAX_ACTIVE_READS);

#[derive(Serialize)]
pub(crate) struct FolderListing {
    directory: Option<String>,
    parent: Option<String>,
    folders: Vec<FolderEntry>,
}

#[derive(Serialize)]
struct FolderEntry {
    name: String,
    path: String,
}

#[tauri::command]
pub(crate) async fn list_import_folders(
    app: AppHandle,
    directory: Option<PathBuf>,
) -> Result<FolderListing, String> {
    let Some(directory) = directory else {
        return root_listing(&app);
    };
    validate_directory(&directory)?;
    let slot = READ_SLOTS
        .try_acquire()
        .map_err(|_| "仍有文件夹等待读取，请稍后再试")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let (send, receive) = tokio::sync::oneshot::channel();
    // A disconnected share can block inside read_dir. A bounded, detached worker
    // keeps that wait outside both the window and the IPC runtime.
    std::thread::Builder::new()
        .name("nexus-folder-browser".into())
        .spawn(move || {
            let _slot = slot;
            let _ = send.send(list_children(&directory, &worker_cancelled));
        })
        .map_err(|error| format!("无法启动目录读取：{error}"))?;

    match tokio::time::timeout(READ_TIMEOUT, receive).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("目录读取提前结束".into()),
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            Err("这个文件夹响应较慢，已结束等待".into())
        }
    }
}

fn validate_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.to_str().is_none() {
        return Err("请输入文件夹的完整路径".into());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return Err("请输入磁盘或共享文件夹路径".into());
        };
        if !matches!(
            prefix.kind(),
            Prefix::Disk(_) | Prefix::VerbatimDisk(_) | Prefix::UNC(..) | Prefix::VerbatimUNC(..)
        ) {
            return Err("请输入磁盘或共享文件夹路径".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn root_listing(_app: &AppHandle) -> Result<FolderListing, String> {
    use windows::Win32::Storage::FileSystem::GetLogicalDrives;

    let drives = unsafe { GetLogicalDrives() };
    if drives == 0 {
        return Err(format!(
            "无法读取磁盘列表：{}",
            windows::core::Error::from_thread()
        ));
    }
    let folders = (0..26)
        .filter(|&bit| drives & (1 << bit) != 0)
        .map(|bit| {
            let letter = (b'A' + bit as u8) as char;
            FolderEntry {
                name: format!("{letter}:"),
                path: format!("{letter}:\\"),
            }
        })
        .collect();
    Ok(FolderListing {
        directory: None,
        parent: None,
        folders,
    })
}

#[cfg(not(windows))]
fn root_listing(app: &AppHandle) -> Result<FolderListing, String> {
    use tauri::Manager;

    let mut folders = Vec::new();
    if let Ok(home) = app.path().home_dir() {
        if let Some(path) = home.to_str().filter(|path| *path != "/") {
            folders.push(FolderEntry {
                name: "个人主目录".into(),
                path: path.into(),
            });
        }
    }
    folders.push(FolderEntry {
        name: "文件系统".into(),
        path: "/".into(),
    });
    Ok(FolderListing {
        directory: None,
        parent: None,
        folders,
    })
}

fn list_children(directory: &Path, cancelled: &AtomicBool) -> Result<FolderListing, String> {
    let mut folders = Vec::new();
    let entries = fs::read_dir(directory).map_err(|error| format!("无法读取文件夹：{error}"))?;
    for entry in entries {
        if cancelled.load(Ordering::Acquire) {
            return Err("已结束目录读取".into());
        }
        let entry = entry.map_err(|error| format!("无法读取目录项：{error}"))?;
        if !is_directory_entry(&entry) {
            continue;
        }
        if let (Some(name), Some(path)) = (entry.file_name().to_str(), entry.path().to_str()) {
            folders.push(FolderEntry {
                name: name.into(),
                path: path.into(),
            });
        }
    }
    folders.sort_by_cached_key(|folder| folder.name.to_lowercase());
    Ok(FolderListing {
        directory: directory.to_str().map(str::to_owned),
        parent: directory.parent().and_then(Path::to_str).map(str::to_owned),
        folders,
    })
}

fn is_directory_entry(entry: &fs::DirEntry) -> bool {
    let Ok(kind) = entry.file_type() else {
        return false;
    };
    if kind.is_dir() {
        return true;
    }
    #[cfg(windows)]
    if kind.is_symlink() {
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
        // A directory link can be listed using its own attributes without
        // opening its target, which may be an offline share.
        return entry
            .metadata()
            .is_ok_and(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY.0 != 0);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_immediate_folders_and_preserves_unicode() {
        let test = tempfile::tempdir().unwrap();
        let root = test.path();
        fs::create_dir_all(root.join("子目录").join("深一层")).unwrap();
        fs::create_dir(root.join("A folder")).unwrap();
        fs::write(root.join("模型.obj"), "").unwrap();

        let listing = list_children(root, &AtomicBool::new(false)).unwrap();
        assert_eq!(listing.directory.as_deref(), root.to_str());
        assert_eq!(
            listing.parent.as_deref(),
            root.parent().and_then(Path::to_str)
        );
        assert_eq!(
            listing
                .folders
                .iter()
                .map(|folder| folder.name.as_str())
                .collect::<Vec<_>>(),
            ["A folder", "子目录"]
        );
        assert_eq!(Path::new(&listing.folders[1].path), root.join("子目录"));
    }

    #[test]
    fn missing_directory_is_an_error_and_empty_directory_is_supported() {
        let test = tempfile::tempdir().unwrap();
        let cancelled = AtomicBool::new(false);
        assert!(list_children(&test.path().join("missing"), &cancelled).is_err());
        assert!(list_children(test.path(), &cancelled)
            .unwrap()
            .folders
            .is_empty());
        assert!(validate_directory(Path::new("relative")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn accepts_drive_and_shared_paths_without_resolving_them() {
        for path in [r"E:\资料", r"\\nas\share\素材", r"\\?\UNC\nas\share\素材"] {
            assert!(validate_directory(Path::new(path)).is_ok());
        }
        assert!(validate_directory(Path::new(r"\\.\C:\")).is_err());
    }
}
