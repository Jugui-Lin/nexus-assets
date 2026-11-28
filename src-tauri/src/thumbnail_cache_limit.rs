use serde::Serialize;
use tauri::State;

use crate::AppState;

#[cfg(windows)]
const DEFAULT_GIB: u32 = 5;
const MAX_GIB: u32 = 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    supported: bool,
    limit_gib: Option<u32>,
    used_bytes: u64,
    removed_bytes: u64,
    complete: bool,
}

#[tauri::command]
pub(super) async fn get_thumbnail_cache_limit(
    state: State<'_, AppState>,
) -> Result<Status, String> {
    #[cfg(windows)]
    {
        let root = state.root.clone();
        tauri::async_runtime::spawn_blocking(move || windows::measure(&root))
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Ok(Status {
            supported: false,
            limit_gib: None,
            used_bytes: 0,
            removed_bytes: 0,
            complete: true,
        })
    }
}

#[tauri::command]
pub(super) async fn set_thumbnail_cache_limit(
    state: State<'_, AppState>,
    limit_gib: Option<u32>,
) -> Result<Status, String> {
    if limit_gib.is_some_and(|limit| !(1..=MAX_GIB).contains(&limit)) {
        return Err(format!("容量上限应为 1 至 {MAX_GIB} GB"));
    }
    #[cfg(windows)]
    {
        let root = state.root.clone();
        tauri::async_runtime::spawn_blocking(move || windows::save(&root, limit_gib))
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Err("当前系统暂不支持清理本机缩略图缓存".into())
    }
}

#[cfg(windows)]
pub(super) fn start(root: std::path::PathBuf) {
    windows::start(root);
}

#[cfg(windows)]
mod windows {
    use super::{Status, DEFAULT_GIB, MAX_GIB};
    use crate::{folder_deletion::is_link, workspace_data::workspace_data_directory, workspaces};
    use ::windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDriveTypeW};
    use nexus_core::{
        clean_path,
        thumbnail_cache::{self, LocalCacheActivity},
    };
    use serde::{Deserialize, Serialize};
    use std::{
        collections::HashSet,
        ffi::{OsStr, OsString},
        fs::{self, Metadata, OpenOptions},
        io::{self, ErrorKind},
        os::windows::fs::OpenOptionsExt,
        path::{Component, Path, PathBuf, Prefix},
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex, MutexGuard,
        },
        time::{Duration, SystemTime},
    };

    const CONFIG: &str = "local-thumbnail-cache-limit.json";
    const TEAM_CACHE: &str = "team-thumbnail-cache";
    const MAX_RECORD_BYTES: u64 = 8 * 1024 * 1024;
    const GIB: u64 = 1024 * 1024 * 1024;
    const READ_INTERVAL: Duration = Duration::from_secs(60);
    const SWEEP_INTERVAL: Duration = Duration::from_secs(40);

    static MAINTENANCE: Mutex<()> = Mutex::new(());
    static TRACKING: Mutex<Option<Tracking>> = Mutex::new(None);
    static DIRTY: AtomicBool = AtomicBool::new(true);

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Preferences {
        limit_gib: Option<u32>,
    }

    #[derive(PartialEq, Eq)]
    struct Tracking {
        flat: HashSet<String>,
        team: Option<String>,
    }

    struct Layout {
        roots: HashSet<PathBuf>,
        app_root: Option<PathBuf>,
    }

    struct Directory {
        root: PathBuf,
        components: Vec<String>,
        path: PathBuf,
    }

    struct Record {
        directory: usize,
        name: OsString,
        modified: SystemTime,
        bytes: u64,
    }

    fn cache_error(error: impl std::fmt::Display) -> String {
        format!("无法访问本机缩略图缓存设置：{error}")
    }

    fn read_limit(root: &Path) -> Result<Option<u32>, String> {
        let bytes = match fs::read(root.join(CONFIG)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Some(DEFAULT_GIB)),
            Err(error) => return Err(cache_error(error)),
        };
        let preferences: Preferences = serde_json::from_slice(&bytes).map_err(cache_error)?;
        if preferences
            .limit_gib
            .is_some_and(|limit| !(1..=MAX_GIB).contains(&limit))
        {
            return Err("本机缩略图缓存容量设置无效".into());
        }
        Ok(preferences.limit_gib)
    }

    fn write_limit(root: &Path, limit_gib: Option<u32>) -> Result<(), String> {
        let mut file = tempfile::NamedTempFile::new_in(root).map_err(cache_error)?;
        serde_json::to_writer(&mut file, &Preferences { limit_gib }).map_err(cache_error)?;
        file.as_file().sync_all().map_err(cache_error)?;
        file.persist(root.join(CONFIG)).map_err(cache_error)?;
        Ok(())
    }

    fn local_drive(path: &Path) -> bool {
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return false;
        };
        let drive = match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return false,
        };
        let root = [u16::from(drive), u16::from(b':'), u16::from(b'\\'), 0];
        matches!(unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) }, 2 | 3 | 6)
    }

    fn local_data_root(path: &Path) -> Option<PathBuf> {
        if !local_drive(path)
            || !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !is_link(&meta))
        {
            return None;
        }
        fs::canonicalize(path).ok().filter(|path| local_drive(path))
    }

    fn path_key(path: &Path) -> String {
        clean_path(path).to_lowercase()
    }

    fn hash_name(name: &str) -> bool {
        name.len() == 64
            && name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn record_name(name: &OsStr, indexed: bool) -> bool {
        let Some((key, extension)) = name.to_str().and_then(|name| name.rsplit_once('.')) else {
            return false;
        };
        hash_name(key)
            && if indexed {
                extension == "preview"
            } else {
                matches!(extension, "png" | "svg" | "webp" | "video-size")
            }
    }

    impl Layout {
        fn read(root: &Path) -> Result<Self, String> {
            let app_root = local_data_root(root);
            let roots = workspaces::registered_data_roots(root)?
                .into_iter()
                .filter_map(|path| local_data_root(&path))
                .chain(app_root.clone())
                .collect();
            Ok(Self { roots, app_root })
        }

        fn flat(&self) -> impl Iterator<Item = (&Path, &'static str)> {
            let personal = self.roots.iter().flat_map(|root| {
                ["thumbnail-cache", "indexed-thumbnails"].map(|name| (root.as_path(), name))
            });
            personal.chain(
                self.app_root
                    .iter()
                    .map(|root| (root.as_path(), "explorer-thumbnail-cache")),
            )
        }

        fn track(&self, limit: Option<u32>) -> bool {
            let next = limit.map(|_| Tracking {
                flat: self
                    .flat()
                    .map(|(root, name)| path_key(&root.join(name)))
                    .collect(),
                team: self
                    .app_root
                    .as_ref()
                    .map(|root| path_key(&root.join(TEAM_CACHE))),
            });
            let mut current = TRACKING.lock().unwrap_or_else(|error| error.into_inner());
            let changed = *current != next;
            *current = next;
            changed
        }

        fn directories(&self, complete: &mut bool) -> Vec<Directory> {
            let mut directories = Vec::new();
            for (root, name) in self.flat() {
                if let Some(path) = safe_directory(root, &[name], complete) {
                    directories.push(Directory {
                        root: root.to_path_buf(),
                        components: vec![name.into()],
                        path,
                    });
                }
            }
            if let Some(root) = &self.app_root {
                if let Some(team) = safe_directory(root, &[TEAM_CACHE], complete) {
                    for_each_entry(&team, complete, |entry, complete| {
                        let name = entry.file_name();
                        let Some(name) = name.to_str().filter(|name| hash_name(name)) else {
                            return;
                        };
                        if let Some(path) = safe_directory(root, &[TEAM_CACHE, name], complete) {
                            directories.push(Directory {
                                root: root.clone(),
                                components: vec![TEAM_CACHE.into(), name.into()],
                                path,
                            });
                        }
                    });
                }
            }
            directories
        }
    }

    fn safe_directory(root: &Path, components: &[&str], complete: &mut bool) -> Option<PathBuf> {
        match workspace_data_directory(root, components, false) {
            Ok(directory) => directory,
            Err(_) => {
                *complete = false;
                None
            }
        }
    }

    fn for_each_entry(
        path: &Path,
        complete: &mut bool,
        mut visit: impl FnMut(fs::DirEntry, &mut bool),
    ) {
        match fs::read_dir(path) {
            Ok(entries) => {
                for entry in entries {
                    match entry {
                        Ok(entry) => visit(entry, complete),
                        Err(error) if error.kind() == ErrorKind::NotFound => {}
                        Err(_) => *complete = false,
                    }
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => *complete = false,
        }
    }

    fn sweep(layout: &Layout, limit_gib: Option<u32>, budget: Option<u64>) -> Status {
        let mut status = Status {
            supported: true,
            limit_gib,
            used_bytes: 0,
            removed_bytes: 0,
            complete: true,
        };
        let directories = layout.directories(&mut status.complete);
        let mut records = Vec::new();
        for (directory, entry_dir) in directories.iter().enumerate() {
            let indexed = entry_dir
                .components
                .last()
                .is_some_and(|name| name == "indexed-thumbnails");
            for_each_entry(&entry_dir.path, &mut status.complete, |entry, complete| {
                let name = entry.file_name();
                if !record_name(&name, indexed) {
                    return;
                }
                match fs::symlink_metadata(entry.path()) {
                    Ok(meta)
                        if meta.is_file()
                            && !is_link(&meta)
                            && (1..=MAX_RECORD_BYTES).contains(&meta.len()) =>
                    {
                        let bytes = meta.len();
                        status.used_bytes = status.used_bytes.saturating_add(bytes);
                        if budget.is_some() {
                            match meta.modified() {
                                Ok(modified) => records.push(Record {
                                    directory,
                                    name,
                                    modified,
                                    bytes,
                                }),
                                Err(_) => *complete = false,
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(_) => *complete = false,
                }
            });
        }
        let Some(budget) = budget.filter(|budget| status.used_bytes > *budget) else {
            return status;
        };
        records.sort_unstable_by_key(|record| (record.modified, record.directory));
        for record in records {
            if status.used_bytes <= budget {
                break;
            }
            let directory = &directories[record.directory];
            let components: Vec<_> = directory.components.iter().map(String::as_str).collect();
            if safe_directory(&directory.root, &components, &mut status.complete).as_ref()
                != Some(&directory.path)
            {
                status.complete = false;
                continue;
            }
            let path = directory.path.join(record.name);
            let result = fs::symlink_metadata(&path).and_then(|meta| {
                if !meta.is_file()
                    || is_link(&meta)
                    || meta.len() != record.bytes
                    || meta.modified()? != record.modified
                {
                    return Err(io::Error::other("缩略图缓存记录已更新"));
                }
                fs::remove_file(&path)
            });
            match result {
                Ok(()) => {
                    status.used_bytes -= record.bytes;
                    status.removed_bytes += record.bytes;
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    status.used_bytes -= record.bytes
                }
                Err(_) => status.complete = false,
            }
        }
        status
    }

    fn tracked(path: &Path) -> bool {
        let Some(directory) = path.parent() else {
            return false;
        };
        let tracks = TRACKING.lock().unwrap_or_else(|error| error.into_inner());
        let Some(tracks) = tracks.as_ref() else {
            return false;
        };
        if tracks.flat.contains(&path_key(directory)) {
            return true;
        }
        tracks.team.as_ref().is_some_and(|team| {
            directory
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(hash_name)
                && directory
                    .parent()
                    .is_some_and(|parent| path_key(parent) == *team)
        })
    }

    fn record_access(path: &Path, meta: &Metadata) {
        let Ok(modified) = meta.modified() else {
            return;
        };
        let now = SystemTime::now();
        if now.duration_since(modified).unwrap_or_default() < READ_INTERVAL {
            return;
        }
        let file = OpenOptions::new()
            .access_mode(0x0180) // FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES
            .custom_flags(0x00200000) // FILE_FLAG_OPEN_REPARSE_POINT
            .open(path);
        if let Ok(file) = file {
            if file.metadata().is_ok_and(|current| {
                current.is_file()
                    && !is_link(&current)
                    && current.len() == meta.len()
                    && current.created().ok() == meta.created().ok()
                    && current.modified().ok() == Some(modified)
            }) {
                let _ = file.set_modified(now);
            }
        }
    }

    fn observe(path: &Path, activity: LocalCacheActivity<'_>) {
        if !tracked(path) {
            return;
        }
        match activity {
            LocalCacheActivity::Write => DIRTY.store(true, Ordering::Relaxed),
            LocalCacheActivity::Read(meta) => record_access(path, meta),
        }
    }

    fn lock_maintenance() -> MutexGuard<'static, ()> {
        MAINTENANCE
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn maintain(root: &Path) -> Result<(), String> {
        let _guard = lock_maintenance();
        let limit = match read_limit(root) {
            Ok(limit) => limit,
            Err(error) => {
                *TRACKING.lock().unwrap_or_else(|error| error.into_inner()) = None;
                return Err(error);
            }
        };
        let layout = Layout::read(root)?;
        let changed = layout.track(limit);
        if let Some(budget) = limit.map(|limit| u64::from(limit) * GIB) {
            if DIRTY.swap(false, Ordering::Relaxed) || changed {
                let status = sweep(&layout, limit, Some(budget));
                if status.used_bytes > budget {
                    DIRTY.store(true, Ordering::Relaxed);
                }
            }
        }
        Ok(())
    }

    pub(super) fn measure(root: &Path) -> Result<Status, String> {
        let _guard = lock_maintenance();
        let limit = read_limit(root)?;
        Ok(sweep(&Layout::read(root)?, limit, None))
    }

    pub(super) fn save(root: &Path, limit: Option<u32>) -> Result<Status, String> {
        let _guard = lock_maintenance();
        let layout = Layout::read(root)?;
        write_limit(root, limit)?;
        layout.track(limit);
        DIRTY.store(false, Ordering::Relaxed);
        let budget = limit.map(|limit| u64::from(limit) * GIB);
        let status = sweep(&layout, limit, budget);
        if budget.is_some_and(|budget| status.used_bytes > budget) {
            DIRTY.store(true, Ordering::Relaxed);
        }
        Ok(status)
    }

    pub(super) fn start(root: PathBuf) {
        thumbnail_cache::observe_local_cache(observe);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(SWEEP_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let root = root.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || maintain(&root)).await;
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn file(root: &Path, directory: &str, name: &str, age: u64) -> PathBuf {
            let directory = root.join(directory);
            fs::create_dir_all(&directory).unwrap();
            let path = directory.join(name);
            let handle = fs::File::create(&path).unwrap();
            handle.set_len(8).unwrap();
            handle
                .set_modified(SystemTime::now() - Duration::from_secs(age))
                .unwrap();
            path
        }

        #[test]
        fn thumbnail_quota_keeps_recent_cache_and_ignores_other_files() {
            let scratch = tempfile::tempdir().unwrap();
            let app = scratch.path().join("app");
            let library = scratch.path().join("library");
            let folder = format!("{TEAM_CACHE}/{}", "a".repeat(64));
            let cached_name = format!("{}.png", "b".repeat(64));
            let index_name = format!("{}.preview", "c".repeat(64));
            let accessed = file(&app, &folder, &cached_name, 480);
            let old = file(&library, "indexed-thumbnails", &index_name, 360);
            let current = file(&app, "explorer-thumbnail-cache", &cached_name, 120);
            let original = file(&library, "assets", &cached_name, 600);
            let share = file(&library, ".nexus/thumbnail-cache", &cached_name, 600);
            let cover = file(&library, "asset-covers", &cached_name, 600);
            let custom = file(&library, "thumbnail-cache", "manual-cover.png", 600);
            let staging = file(
                &library,
                "thumbnail-cache",
                ".nexus-thumbnail-test.tmp",
                600,
            );
            let detached = file(
                &scratch.path().join("elsewhere"),
                "thumbnail-cache",
                &cached_name,
                600,
            );
            fs::write(
                app.join("personal-workspaces.json"),
                serde_json::json!({
                    "workspaces":[{"id":"test","name":"测试资料库","path":clean_path(&library)}],
                })
                .to_string(),
            )
            .unwrap();
            let layout = Layout::read(&app).unwrap();
            assert!(!local_drive(Path::new(r"\\nas.invalid\shared")));
            assert_eq!(sweep(&layout, Some(5), None).used_bytes, 24);

            let old_time = fs::metadata(&accessed).unwrap();
            record_access(&accessed, &old_time);
            assert!(
                fs::metadata(&accessed).unwrap().modified().unwrap() > old_time.modified().unwrap()
            );
            let result = sweep(&layout, Some(5), Some(16));
            assert!(result.complete);
            assert_eq!((result.used_bytes, result.removed_bytes), (16, 8));
            assert!(!old.exists());
            for path in [
                accessed, current, original, share, cover, custom, staging, detached,
            ] {
                assert!(path.is_file(), "should preserve {path:?}");
            }
        }

        #[test]
        fn thumbnail_quota_preferences_default_to_five_and_preserve_unlimited() {
            let scratch = tempfile::tempdir().unwrap();
            let root = scratch.path();
            assert_eq!(read_limit(root).unwrap(), Some(5));
            write_limit(root, None).unwrap();
            assert_eq!(read_limit(root).unwrap(), None);
            write_limit(root, Some(20)).unwrap();
            assert_eq!(read_limit(root).unwrap(), Some(20));
            write_limit(root, Some(0)).unwrap();
            assert!(read_limit(root).is_err());
        }
    }
}
