use crate::{
    folder_deletion::{
        canonical_directory, is_link, path_key, protected_data_roots, protected_name,
    },
    lock_db, team_import,
    workspaces::lock_io,
    AppState,
};
use nexus_core::{clean_path, Asset, Catalog};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, Metadata},
    io::ErrorKind,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_DELETE_IDS: usize = 500;

#[derive(Clone, Copy)]
pub(crate) enum IndexedMtime {
    Seconds(u64),
    Milliseconds(u64),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DiskRemoval {
    Deleted,
    Missing,
}

fn check_metadata(metadata: Metadata, size: u64, modified: IndexedMtime) -> Result<(), String> {
    if !metadata.is_file() || is_link(&metadata) {
        return Err("资产路径必须是普通文件，不能是目录或链接".into());
    }
    let current = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    let matches = match modified {
        IndexedMtime::Seconds(value) => current.as_secs() == value,
        IndexedMtime::Milliseconds(value) => current.as_millis() == u128::from(value),
    };
    if metadata.len() != size || !matches {
        return Err("源文件自索引后已经变更，请重新扫描后再删除".into());
    }
    Ok(())
}

pub(crate) fn delete_checked_file(
    path: &Path,
    root: Option<&Path>,
    size: u64,
    modified: IndexedMtime,
    data_roots: &[PathBuf],
) -> Result<DiskRemoval, String> {
    let filename = path
        .file_name()
        .filter(|_| path.is_absolute())
        .ok_or("资产文件路径无效")?;
    #[cfg(windows)]
    if filename.to_string_lossy().contains(':') {
        return Err("不能删除文件的备用数据流".into());
    }
    let parent = canonical_directory(path.parent().ok_or("缺少源文件所在目录")?)?;
    let target = parent.join(filename);
    if path_key(&target) != path_key(path) {
        return Err("源文件位置已变化，请重新选择资产".into());
    }
    if let Some(root) = root {
        let root = canonical_directory(root)?;
        if !path_key(&target).starts_with(path_key(&root)) {
            return Err("源文件不在当前登记的资产库中".into());
        }
    }
    let key = path_key(&target);
    if target
        .components()
        .any(|part| protected_name(&part.as_os_str().to_string_lossy()))
        || data_roots.iter().any(|root| {
            key.starts_with(path_key(root))
                || fs::canonicalize(root).is_ok_and(|root| {
                    key.starts_with(path_key(&root))
                        || team_import::mounted_folder(&root, &parent).is_some()
                })
        })
    {
        return Err("不能删除 Nexus 工作空间数据或索引文件".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(metadata) => check_metadata(metadata, size, modified)?,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if path_key(&canonical_directory(&parent)?) != path_key(&parent) {
                return Err("源目录已变化，未清理资产索引".into());
            }
            return Ok(DiskRemoval::Missing);
        }
        Err(error) => return Err(format!("无法检查源文件：{error}")),
    };
    remove_verified_file(&target, size, modified)?;
    Ok(DiskRemoval::Deleted)
}

#[cfg(windows)]
fn remove_verified_file(path: &Path, size: u64, modified: IndexedMtime) -> Result<(), String> {
    use std::os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            FileDispositionInfo, GetFinalPathNameByHandleW, SetFileInformationByHandle, DELETE,
            FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
            FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        },
    };
    let file = fs::OpenOptions::new()
        .read(true)
        .access_mode(DELETE.0 | FILE_READ_ATTRIBUTES.0)
        .share_mode(FILE_SHARE_READ.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
        .map_err(|error| format!("无法打开源文件以删除：{error}"))?;
    check_metadata(
        file.metadata().map_err(|error| error.to_string())?,
        size,
        modified,
    )?;
    let handle = HANDLE(file.as_raw_handle());
    let mut buffer = vec![0; 32768];
    // Resolve the owned handle before marking it for deletion, without reopening by path.
    let length =
        unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, FILE_NAME_NORMALIZED) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("无法确认打开后的源文件位置".into());
    }
    let opened = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
    if path_key(&opened) != path_key(path) {
        return Err("源文件在检查期间已变化，请重新选择".into());
    }
    let delete = FILE_DISPOSITION_INFO { DeleteFile: true };
    // The handle owns DELETE access and excludes competing write/delete opens until it closes.
    unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfo,
            (&delete as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .map_err(|error| format!("无法永久删除源文件：{error}"))?;
    drop(file);
    Ok(())
}

#[cfg(not(windows))]
fn remove_verified_file(path: &Path, size: u64, modified: IndexedMtime) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|error| format!("无法打开源文件以删除：{error}"))?;
    check_metadata(
        file.metadata().map_err(|error| error.to_string())?,
        size,
        modified,
    )?;
    let identity = same_file::Handle::from_file(file).map_err(|error| error.to_string())?;
    check_metadata(
        fs::symlink_metadata(path).map_err(|error| error.to_string())?,
        size,
        modified,
    )?;
    let parent = canonical_directory(path.parent().ok_or("缺少源文件所在目录")?)?;
    if path_key(&parent.join(path.file_name().ok_or("资产文件路径无效")?)) != path_key(path)
        || same_file::Handle::from_path(path).ok().as_ref() != Some(&identity)
    {
        return Err("源文件在检查期间已变化，请重新选择".into());
    }
    fs::remove_file(path).map_err(|error| format!("无法永久删除源文件：{error}"))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersonalDeleteReport {
    deleted: usize,
    missing: usize,
    failed: usize,
    deleted_ids: Vec<String>,
    errors: Vec<String>,
    index_pending: bool,
}

impl PersonalDeleteReport {
    fn error(&mut self, label: &str, error: impl std::fmt::Display) {
        if self.errors.len() < 100 {
            self.errors.push(format!("{label}：{error}"));
        }
    }
}

fn read_asset(catalog: &Catalog, id: &str) -> Result<Option<Asset>, String> {
    let row: Option<(String, String, String)> = catalog
        .conn
        .query_row(
            "SELECT path, library_id, data FROM assets WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((path, library, data)) = row else {
        return Ok(None);
    };
    let asset: Asset = serde_json::from_str(&data).map_err(|error| error.to_string())?;
    if asset.id != id || asset.path != path || asset.library_id != library || asset.demo {
        return Err("只能删除当前个人库中的真实已索引资产".into());
    }
    Ok(Some(asset))
}

fn remove_index(catalog: &mut Catalog, asset: &Asset) -> Result<(), String> {
    let transaction = catalog
        .conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let removed = transaction
        .execute(
            "DELETE FROM assets WHERE id=?1 AND path=?2",
            params![asset.id, asset.path],
        )
        .map_err(|error| error.to_string())?;
    if removed != 1 {
        return Err("资产索引已变化，请刷新后重试".into());
    }
    transaction
        .execute(
            "DELETE FROM asset_collection_members WHERE asset_id=?1 AND collection_id IN(
            SELECT id FROM asset_collections WHERE scope='personal')",
            [&asset.id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn delete_personal_assets(
    catalog: &mut Catalog,
    ids: Vec<String>,
    data_roots: &[PathBuf],
) -> Result<PersonalDeleteReport, String> {
    if ids.is_empty() || ids.len() > MAX_DELETE_IDS {
        return Err(format!("请选择 1 到 {MAX_DELETE_IDS} 项个人资产"));
    }
    if ids.iter().any(|id| {
        id.trim().is_empty()
            || id.len() > 128
            || id.starts_with("team:")
            || id.chars().any(char::is_control)
    }) {
        return Err("个人资产标识无效".into());
    }
    let mut result = PersonalDeleteReport::default();
    let mut seen = HashSet::new();
    for id in ids.into_iter().filter(|id| seen.insert(id.clone())) {
        let asset = match read_asset(catalog, &id) {
            Ok(Some(asset)) => asset,
            Ok(None) => {
                result.missing += 1;
                continue;
            }
            Err(error) => {
                result.failed += 1;
                result.error(&id, error);
                continue;
            }
        };
        let deleted = (|| {
            let path = Path::new(&asset.path);
            if nexus_core::kind(&asset.ext).is_none()
                || !path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case(&asset.ext))
            {
                return Err("资产格式与索引不一致".into());
            }
            let disk_mtime = asset
                .modified
                .as_u64()
                .ok_or("资产索引缺少有效修改时间，请重新扫描")?;
            let root = if asset.library_id == "loose" {
                None
            } else {
                let path: String = catalog
                    .conn
                    .query_row(
                        "SELECT path FROM libraries WHERE id=?1",
                        [&asset.library_id],
                        |row| row.get(0),
                    )
                    .map_err(|_| "登记的资产库已不可用")?;
                Some(PathBuf::from(path))
            };
            delete_checked_file(
                path,
                root.as_deref(),
                asset.size,
                IndexedMtime::Seconds(disk_mtime),
                data_roots,
            )
        })();
        match deleted {
            Ok(DiskRemoval::Deleted) => result.deleted += 1,
            Ok(DiskRemoval::Missing) => result.missing += 1,
            Err(error) => {
                result.failed += 1;
                result.error(&asset.name, error);
                continue;
            }
        }
        result.deleted_ids.push(id);
        if let Err(error) = remove_index(catalog, &asset) {
            result.index_pending = true;
            result.error(
                &clean_path(Path::new(&asset.path)),
                format!("无法更新个人库索引：{error}"),
            );
        }
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn delete_workspace_assets(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<PersonalDeleteReport, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = lock_io(&state)?;
        let data_roots = protected_data_roots(&state)?;
        let directory = lock_db(&state)?.dir.clone();
        let mut catalog = Catalog::open(&directory)?;
        delete_personal_assets(&mut catalog, ids, &data_roots)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(catalog: &Catalog, path: &Path, bytes: &[u8]) -> Asset {
        fs::write(path, bytes).unwrap();
        catalog.add_file(path, "loose").unwrap();
        catalog
            .assets()
            .unwrap()
            .into_iter()
            .find(|asset| path_key(Path::new(&asset.path)) == path_key(path))
            .unwrap()
    }

    #[test]
    fn permanent_delete_is_idempotent_and_preserves_failed_items() {
        let scratch = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(scratch.path()).unwrap();
        let data = root.join("db");
        let mut catalog = Catalog::open(&data).unwrap();
        let file = root.join("selected.obj");
        let stale = root.join("stale.obj");
        let already_gone = root.join("gone.obj");
        let unselected = root.join("selected-sidecar.png");
        let selected = index(&catalog, &file, b"v 1 2 3");
        let changed = index(&catalog, &stale, b"v 4 5 6");
        let gone = index(&catalog, &already_gone, b"v 7 8 9");
        let sibling = index(&catalog, &unselected, b"sidecar bytes");
        let collection = catalog.create_collection("personal", "项目").unwrap();
        catalog
            .set_collection_membership(
                "personal",
                &collection.id,
                &[selected.id.clone(), sibling.id.clone()],
                true,
            )
            .unwrap();
        catalog
            .set_assets_recycled(&[selected.id.clone()], true)
            .unwrap();
        fs::write(&stale, b"new content with a different size").unwrap();
        fs::remove_file(&already_gone).unwrap();

        assert!(delete_personal_assets(
            &mut catalog,
            vec![selected.id.clone(), "team:foreign".into()],
            &[data.clone()]
        )
        .is_err());
        assert!(file.is_file());
        let result = delete_personal_assets(
            &mut catalog,
            vec![
                selected.id.clone(),
                changed.id.clone(),
                gone.id.clone(),
                selected.id.clone(),
                "already-unknown".into(),
            ],
            &[data.clone()],
        )
        .unwrap();
        assert_eq!((result.deleted, result.missing, result.failed), (1, 2, 1));
        assert_eq!(
            result.deleted_ids,
            vec![selected.id.clone(), gone.id.clone()]
        );
        assert!(!result.index_pending);
        assert!(!file.exists());
        assert_eq!(
            fs::read(&stale).unwrap(),
            b"new content with a different size"
        );
        assert_eq!(fs::read(&unselected).unwrap(), b"sidecar bytes");
        assert_eq!(catalog.assets().unwrap().len(), 2);
        assert!(catalog.list_recycled_assets().unwrap().is_empty());
        assert_eq!(
            catalog.list_collections("personal").unwrap()[0].asset_ids,
            vec![sibling.id]
        );
        let retried =
            delete_personal_assets(&mut catalog, vec![selected.id, gone.id], &[data]).unwrap();
        assert_eq!(
            (retried.deleted, retried.missing, retried.failed),
            (0, 2, 0)
        );
    }

    #[test]
    fn protected_unmounted_and_nonfile_paths_are_never_removed() {
        let scratch = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(scratch.path()).unwrap();
        let data = root.join("db");
        let mut catalog = Catalog::open(&data).unwrap();
        let protected = data.join("failed.png");
        let fake_file = root.join("was-a-file.obj");
        let unavailable_root = root.join("disconnected");
        fs::create_dir_all(&unavailable_root).unwrap();
        let unavailable = unavailable_root.join("file.obj");
        let hot = index(&catalog, &protected, b"app data");
        let fake = index(&catalog, &fake_file, b"old");
        let unplugged = index(&catalog, &unavailable, b"volume source");
        fs::remove_file(&fake_file).unwrap();
        fs::create_dir(&fake_file).unwrap();
        fs::remove_file(&unavailable).unwrap();
        fs::remove_dir(&unavailable_root).unwrap();
        let result =
            delete_personal_assets(&mut catalog, vec![hot.id, fake.id, unplugged.id], &[data])
                .unwrap();
        assert_eq!((result.deleted, result.missing, result.failed), (0, 0, 3));
        assert_eq!(fs::read(&protected).unwrap(), b"app data");
        assert!(fake_file.is_dir());
        assert_eq!(catalog.assets().unwrap().len(), 3);
    }

    #[cfg(windows)]
    #[test]
    fn windows_file_with_active_writer_is_preserved_then_deleted_after_close() {
        let scratch = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(scratch.path()).unwrap();
        let file = root.join("scene.c4d");
        fs::write(&file, b"scene").unwrap();
        let micros = fs::metadata(&file)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let writer = fs::OpenOptions::new().write(true).open(&file).unwrap();
        assert!(delete_checked_file(
            &file,
            Some(&root),
            5,
            IndexedMtime::Milliseconds(micros),
            &[]
        )
        .is_err());
        assert!(file.is_file());
        drop(writer);
        assert_eq!(
            delete_checked_file(
                &file,
                Some(&root),
                5,
                IndexedMtime::Milliseconds(micros),
                &[]
            )
            .unwrap(),
            DiskRemoval::Deleted
        );
        assert!(!file.exists());
    }
}
