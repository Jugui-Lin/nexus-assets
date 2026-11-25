use crate::{lock_db, AppState};
use nexus_core::{clean_path, now, Asset, Catalog};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};
use tauri::{Manager, State, WebviewWindow};
use tempfile::NamedTempFile;
use uuid::Uuid;

#[path = "team_versions.rs"]
mod team_versions;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetVersion {
    id: String,
    asset_id: String,
    version: u64,
    created: u64,
    note: String,
    size: u64,
    #[serde(skip)]
    filename: String,
}

impl AssetVersion {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            asset_id: row.get(1)?,
            version: row.get(2)?,
            created: row.get(3)?,
            note: row.get(4)?,
            size: row.get(5)?,
            filename: row.get(6)?,
        })
    }

    fn suggested_filename(&self) -> String {
        let filename = Path::new(&self.filename);
        let stem: String = filename
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("asset")
            .chars()
            .take(80)
            .collect();
        let version_name = format!("{stem}-v{}", self.version);
        match filename
            .extension()
            .and_then(|extension| extension.to_str())
        {
            Some(extension) => format!("{version_name}.{extension}"),
            None => version_name,
        }
    }
}

#[derive(Serialize)]
pub(crate) struct ExportedVersion {
    path: String,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS asset_versions (
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL,
                version INTEGER NOT NULL CHECK (version > 0),
                created INTEGER NOT NULL,
                note TEXT NOT NULL,
                size INTEGER NOT NULL,
                filename TEXT NOT NULL,
                UNIQUE (asset_id, version)
            );",
        )
        .map_err(|error| error.to_string())
}

fn local_asset(catalog: &Catalog, id: &str) -> Result<Asset, String> {
    if id.starts_with("team:") {
        return Err("版本快照仅适用于个人资产库".into());
    }
    catalog.asset(id)
}

fn snapshots(catalog: &Catalog) -> PathBuf {
    catalog.dir.join("asset-versions")
}

fn list_versions(catalog: &Catalog, id: &str) -> Result<Vec<AssetVersion>, String> {
    local_asset(catalog, id)?;
    let mut statement = catalog
        .conn
        .prepare(
            "SELECT id, asset_id, version, created, note, size, filename
             FROM asset_versions WHERE asset_id = ? ORDER BY version DESC",
        )
        .map_err(|error| error.to_string())?;
    let versions = statement
        .query_map([id], AssetVersion::from_row)
        .map_err(|error| error.to_string())?;
    versions
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

fn read_version(catalog: &Catalog, id: &str, version_id: &str) -> Result<AssetVersion, String> {
    local_asset(catalog, id)?;
    catalog
        .conn
        .query_row(
            "SELECT id, asset_id, version, created, note, size, filename
             FROM asset_versions WHERE asset_id = ?1 AND id = ?2",
            params![id, version_id],
            AssetVersion::from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "版本不存在".into())
}

fn stage_copy(source: &Path, dir: &Path) -> Result<(NamedTempFile, u64), String> {
    if !fs::metadata(source)
        .map_err(|error| format!("无法读取资产文件：{error}"))?
        .is_file()
    {
        return Err("资产路径已不是文件".into());
    }
    let mut input = File::open(source).map_err(|error| format!("无法打开资产文件：{error}"))?;
    let before = input.metadata().map_err(|error| error.to_string())?;
    if !before.is_file() {
        return Err("资产路径已不是文件".into());
    }
    let mut output =
        NamedTempFile::new_in(dir).map_err(|error| format!("无法创建临时版本文件：{error}"))?;
    let copied =
        io::copy(&mut input, &mut output).map_err(|error| format!("无法复制版本文件：{error}"))?;
    let after = input.metadata().map_err(|error| error.to_string())?;
    if copied != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("资产在复制时发生更改，请保存文件后重试".into());
    }
    output
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法写入版本文件：{error}"))?;
    Ok((output, copied))
}

fn create_version(state: &AppState, id: &str, note: &str) -> Result<AssetVersion, String> {
    let (asset, dir) = {
        let catalog = lock_db(state)?;
        (local_asset(&catalog, id)?, snapshots(&catalog))
    };
    let source = Path::new(&asset.path);
    let filename = source
        .file_name()
        .and_then(|filename| filename.to_str())
        .filter(|_| source.is_absolute())
        .ok_or("资产文件路径无效")?
        .to_owned();
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建版本目录：{error}"))?;
    let (staged, size) = stage_copy(source, &dir)?;

    let mut catalog = lock_db(state)?;
    if local_asset(&catalog, id)?.path != asset.path {
        return Err("资产路径已更改，请重试".into());
    }
    let transaction = catalog
        .conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let next = transaction
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM asset_versions WHERE asset_id = ?",
            [id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let version = AssetVersion {
        id: Uuid::new_v4().to_string(),
        asset_id: asset.id,
        version: next,
        created: now(),
        note: note.trim().chars().take(1000).collect(),
        size,
        filename,
    };
    transaction
        .execute(
            "INSERT INTO asset_versions (id, asset_id, version, created, note, size, filename)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                version.id,
                version.asset_id,
                version.version,
                version.created,
                version.note,
                version.size,
                version.filename
            ],
        )
        .map_err(|error| error.to_string())?;

    // Publish the complete snapshot before committing the visible catalog entry.
    let target = dir.join(&version.id);
    let published = staged
        .persist_noclobber(&target)
        .map_err(|error| format!("无法保存版本文件：{}", error.error))?;
    drop(published);
    if let Err(error) = transaction.commit() {
        let message = format!("无法保存版本记录：{error}");
        if let Err(cleanup_error) = fs::remove_file(&target) {
            return Err(format!(
                "{message}，无法清理未登记的版本文件：{cleanup_error}"
            ));
        }
        return Err(message);
    }
    Ok(version)
}

fn is_original_path(original: &Path, target: &Path) -> bool {
    let (Some(original_name), Some(target_name)) = (original.file_name(), target.file_name())
    else {
        return false;
    };
    let same_name = original_name == target_name
        || (cfg!(any(windows, target_os = "macos"))
            && original_name.to_string_lossy().to_lowercase()
                == target_name.to_string_lossy().to_lowercase());
    match (same_name, original.parent(), target.parent()) {
        (true, Some(original), Some(target)) => {
            original == target || same_file::is_same_file(original, target).unwrap_or(false)
        }
        _ => false,
    }
}

fn export_to(
    dir: &Path,
    version: &AssetVersion,
    original: &Path,
    target: &Path,
) -> Result<ExportedVersion, String> {
    if !target.is_absolute() || target.file_name().is_none() {
        return Err("另存路径无效".into());
    }
    if is_original_path(original, target) {
        return Err("请选择与原资产不同的文件名或目录".into());
    }
    let filename = Uuid::parse_str(&version.id).map_err(|_| "版本编号无效".to_string())?;
    let source = dir.join(filename.to_string());
    match fs::symlink_metadata(target) {
        Ok(_) => return Err("目标文件已存在，请选择新文件名".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查目标文件：{error}")),
    }
    let parent = target.parent().ok_or("另存路径无效")?;
    let (staged, size) = stage_copy(&source, parent)?;
    if size != version.size {
        return Err("版本文件大小与记录不符，无法导出".into());
    }
    staged.persist_noclobber(target).map_err(|error| {
        if error.error.kind() == ErrorKind::AlreadyExists {
            "目标文件已存在，请选择新文件名".to_string()
        } else {
            format!("无法另存版本文件：{}", error.error)
        }
    })?;
    Ok(ExportedVersion {
        path: clean_path(target),
    })
}

#[tauri::command]
pub(crate) async fn list_asset_versions(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<AssetVersion>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(id) = id.strip_prefix("team:") {
            let location = team_versions::Location::resolve(&app, id)?;
            return location
                .list()
                .map(|versions| versions.into_iter().map(|(version, _)| version).collect());
        }
        let catalog = lock_db(&state)?;
        list_versions(&catalog, &id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn create_asset_version(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
    note: String,
) -> Result<AssetVersion, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(id) = id.strip_prefix("team:") {
            return team_versions::Location::resolve(&app, id)?.create(&note);
        }
        let _workspace = crate::workspaces::lock_io(&state)?;
        create_version(&state, &id, &note)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn export_asset_version(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    version_id: String,
) -> Result<Option<ExportedVersion>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let shared = id
            .strip_prefix("team:")
            .map(|id| team_versions::Location::resolve(window.app_handle(), id))
            .transpose()?;
        let (version, dir) = match &shared {
            Some(location) => location.read(&version_id)?,
            None => {
                let catalog = lock_db(&state)?;
                (
                    read_version(&catalog, &id, &version_id)?,
                    snapshots(&catalog),
                )
            }
        };
        let Some(path) = rfd::FileDialog::new()
            .set_parent(&window)
            .set_title("另存资产版本")
            .set_file_name(version.suggested_filename())
            .save_file()
        else {
            return Ok(None);
        };
        let original = match shared {
            Some(location) => location.original(),
            None => {
                let catalog = lock_db(&state)?;
                PathBuf::from(local_asset(&catalog, &id)?.path)
            }
        };
        export_to(&dir, &version, &original, &path).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    fn setup() -> (tempfile::TempDir, AppState, PathBuf, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        let asset = source.join("chair.obj");
        fs::write(&asset, b"first version").unwrap();
        fs::write(source.join("table.obj"), b"another asset").unwrap();
        let mut catalog = Catalog::open(&dir.path().join("catalog")).unwrap();
        initialize(&catalog.conn).unwrap();
        catalog.scan(&source, None, "local", |_| {}).unwrap();
        let assets = catalog.assets().unwrap();
        let chair_id = assets
            .iter()
            .find(|asset| asset.name == "chair")
            .unwrap()
            .id
            .clone();
        let table_id = assets
            .iter()
            .find(|asset| asset.name == "table")
            .unwrap()
            .id
            .clone();
        let state = AppState {
            db: Arc::new(Mutex::new(catalog)),
            root: dir.path().join("catalog"),
            workspace_io: Arc::new(Mutex::new(())),
            placement: crate::placement::PlacementTickets::default(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            token: String::new(),
            port: 0,
        };
        (dir, state, asset, chair_id, table_id)
    }

    #[test]
    fn exports_a_separate_immutable_version_without_overwrite() {
        let (dir, state, source, id, other_id) = setup();
        let first = create_version(&state, &id, "  初稿  ").unwrap();
        fs::write(&source, b"updated original").unwrap();
        let second = create_version(&state, &id, "新版本").unwrap();
        let data = {
            let catalog = lock_db(&state).unwrap();
            assert!(read_version(&catalog, &other_id, &first.id).is_err());
            assert!(list_versions(&catalog, "team:asset").is_err());
            let listed = list_versions(&catalog, &id).unwrap();
            assert_eq!(listed[0].id, second.id);
            assert_eq!(listed[0].version, 2);
            assert_eq!(listed[1].note, "初稿");
            snapshots(&catalog)
        };
        assert_eq!(first.suggested_filename(), "chair-v1.obj");
        let target = dir.path().join(first.suggested_filename());
        export_to(&data, &first, &source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"first version");
        assert!(export_to(&data, &second, &source, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"first version");
        assert_eq!(fs::read(&source).unwrap(), b"updated original");

        fs::remove_file(&source).unwrap();
        assert!(export_to(&data, &first, &source, &source).is_err());
        assert!(!source.exists());
        assert!(create_version(&state, &id, "").is_err());
        assert_eq!(
            list_versions(&lock_db(&state).unwrap(), &id).unwrap().len(),
            2
        );
    }

    #[test]
    fn concurrent_snapshots_get_distinct_version_numbers() {
        let (_dir, state, _source, id, _other_id) = setup();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| create_version(&state, &id, "one").unwrap());
            let second = scope.spawn(|| create_version(&state, &id, "two").unwrap());
            let mut numbers = [
                first.join().unwrap().version,
                second.join().unwrap().version,
            ];
            numbers.sort();
            assert_eq!(numbers, [1, 2]);
        });
        let catalog = lock_db(&state).unwrap();
        assert_eq!(list_versions(&catalog, &id).unwrap().len(), 2);
        assert_eq!(fs::read_dir(snapshots(&catalog)).unwrap().count(), 2);
    }
}
