use crate::{asset_versions, lock_db, AppState};
use nexus_core::{clean_path, Catalog};
use rusqlite::{Connection, DatabaseName, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    sync::MutexGuard,
};
use tauri::{Manager, State, WebviewWindow};
use tempfile::{NamedTempFile, TempDir};
use uuid::Uuid;

const DATABASE: &str = "nexus.sqlite3";
const REGISTRY: &str = "personal-workspaces.json";
const DEFAULT_ID: &str = "personal";
const DEFAULT_NAME: &str = "默认个人库";
const MANAGED_FOLDERS: [&str; 2] = ["asset-covers", "asset-versions"];

#[derive(Clone, Deserialize, Serialize)]
pub struct WorkspaceEntry {
    id: String,
    name: String,
    path: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Registry {
    active: Option<String>,
    workspaces: Vec<WorkspaceEntry>,
}

#[derive(Serialize)]
pub struct WorkspaceSnapshot {
    current: WorkspaceEntry,
    workspaces: Vec<WorkspaceEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

pub(crate) fn lock_io(state: &AppState) -> Result<MutexGuard<'_, ()>, String> {
    state
        .workspace_io
        .lock()
        .map_err(|_| "资料库锁不可用".into())
}

fn read_registry(root: &Path) -> Result<Registry, String> {
    match fs::read(root.join(REGISTRY)) {
        Ok(data) => {
            serde_json::from_slice(&data).map_err(|error| format!("无法读取个人库设置：{error}"))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Registry::default()),
        Err(error) => Err(format!("无法读取个人库设置：{error}")),
    }
}

pub(crate) fn registered_data_roots(root: &Path) -> Result<Vec<PathBuf>, String> {
    Ok(read_registry(root)?
        .workspaces
        .into_iter()
        .map(|entry| PathBuf::from(entry.path))
        .filter(|path| path.is_absolute())
        .collect())
}

fn save_registry(root: &Path, registry: &Registry) -> Result<(), String> {
    let mut staged =
        NamedTempFile::new_in(root).map_err(|error| format!("无法创建个人库设置：{error}"))?;
    serde_json::to_writer_pretty(&mut staged, registry).map_err(|error| error.to_string())?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法写入个人库设置：{error}"))?;
    staged
        .persist(root.join(REGISTRY))
        .map_err(|error| format!("无法保存个人库设置：{}", error.error))?;
    Ok(())
}

fn normalized_directory(path: &Path) -> Result<PathBuf, String> {
    let normalized =
        fs::canonicalize(path).map_err(|error| format!("无法访问资料库目录：{error}"))?;
    if !normalized.is_dir() || normalized.to_str().is_none() {
        return Err("请选择可访问的资料库目录".into());
    }
    Ok(PathBuf::from(clean_path(&normalized)))
}

fn empty_directory(path: &Path) -> Result<(), String> {
    if fs::read_dir(path)
        .map_err(|error| format!("无法读取目标目录：{error}"))?
        .next()
        .transpose()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("请选择空文件夹".into());
    }
    Ok(())
}

fn validate_database(directory: &Path) -> Result<(), String> {
    let path = directory.join(DATABASE);
    if !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_file()) {
        return Err("该目录中没有 Nexus 资料库数据库".into());
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("无法打开资料库：{error}"))?;
    db.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
        .map_err(|error| format!("无法检查资料库：{error}"))?;
    let table_count: usize = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='table' AND name IN ('assets','libraries','jobs','settings')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法检查资料库：{error}"))?;
    if table_count != 4 {
        return Err("此 SQLite 文件不是 Nexus 个人资料库".into());
    }
    for schema in [
        "SELECT id,path,name,kind,library_id,favorite,data FROM assets LIMIT 0",
        "SELECT id,path,data FROM libraries LIMIT 0",
        "SELECT id,session,status,data FROM jobs LIMIT 0",
        "SELECT key,value FROM settings LIMIT 0",
    ] {
        db.prepare(schema)
            .map_err(|error| format!("Nexus 资料库结构不完整：{error}"))?;
    }
    let check: String = db
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| format!("无法检查资料库：{error}"))?;
    if check != "ok" {
        return Err(format!("资料库校验失败：{check}"));
    }
    Ok(())
}

fn existing_catalog(path: &Path) -> Result<Catalog, String> {
    let path = normalized_directory(path)?;
    validate_database(&path)?;
    let catalog = Catalog::open(&path)?;
    asset_versions::initialize(&catalog.conn)?;
    Ok(catalog)
}

fn read_id(catalog: &Catalog) -> Result<Option<String>, String> {
    let id: Option<String> = catalog
        .conn
        .query_row(
            "SELECT value FROM settings WHERE key='workspace_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if id
        .as_deref()
        .is_some_and(|id| id != DEFAULT_ID && Uuid::parse_str(id).is_err())
    {
        return Err("个人资料库编号无效".into());
    }
    Ok(id)
}

fn assign_id(catalog: &Catalog, id: &str) -> Result<(), String> {
    catalog
        .conn
        .execute(
            "INSERT INTO settings (key,value) VALUES ('workspace_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn default_catalog(root: &Path) -> Result<Catalog, String> {
    let catalog = Catalog::open(root)?;
    asset_versions::initialize(&catalog.conn)?;
    if read_id(&catalog)?.as_deref() != Some(DEFAULT_ID) {
        assign_id(&catalog, DEFAULT_ID)?;
    }
    catalog.seed()?;
    Ok(catalog)
}

fn default_entry(root: &Path) -> WorkspaceEntry {
    WorkspaceEntry {
        id: DEFAULT_ID.into(),
        name: DEFAULT_NAME.into(),
        path: clean_path(root),
    }
}

pub(crate) fn open_registered_catalog(state: &AppState, id: &str) -> Result<Catalog, String> {
    let current = lock_db(state)?;
    if read_id(&current)?.as_deref() == Some(id) {
        return Catalog::open(&current.dir);
    }
    drop(current);

    let entry = if id == DEFAULT_ID {
        default_entry(&state.root)
    } else {
        read_registry(&state.root)?
            .workspaces
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or("找不到所选个人库。请重新选择目标。")?
    };
    let directory = Path::new(&entry.path);
    if !directory.is_absolute() {
        return Err("所选个人库目录无效".into());
    }
    let catalog = existing_catalog(directory)?;
    if read_id(&catalog)?.as_deref() != Some(id) {
        return Err("个人库目录中的资料库编号已变化。请重新选择目标。".into());
    }
    Ok(catalog)
}

fn configured_workspace(registry: &Registry) -> Option<&WorkspaceEntry> {
    let id = registry.active.as_ref()?;
    registry.workspaces.iter().find(|entry| &entry.id == id)
}

pub fn open_startup_catalog(root: &Path) -> Result<Catalog, String> {
    let selected = read_registry(root).ok().and_then(|registry| {
        let entry = configured_workspace(&registry)?;
        let path = Path::new(&entry.path);
        if is_same_path(path, root) {
            return None;
        }
        let catalog = existing_catalog(path).ok()?;
        let id = read_id(&catalog).ok()??;
        (id == entry.id).then_some(catalog)
    });
    let catalog = match selected {
        Some(catalog) => catalog,
        None => default_catalog(root)?,
    };
    catalog.recover_jobs()?;
    Ok(catalog)
}

fn is_same_path(left: &Path, right: &Path) -> bool {
    left == right || same_file::is_same_file(left, right).unwrap_or(false)
}

fn display_name(path: &Path, preferred: Option<String>) -> Result<String, String> {
    if let Some(name) = preferred {
        let name = name.trim();
        if name.chars().count() > 100 || name.chars().any(char::is_control) {
            return Err("资料库名称须为 1 到 100 个字符".into());
        }
        if !name.is_empty() {
            return Ok(name.into());
        }
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("个人资料库");
    Ok(name
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
        .collect())
}

fn entry_for(
    catalog: &Catalog,
    root: &Path,
    registry: &Registry,
) -> Result<WorkspaceEntry, String> {
    let id = read_id(catalog)?.ok_or("当前资料库缺少编号")?;
    let name = registry
        .workspaces
        .iter()
        .find(|entry| entry.id == id && is_same_path(Path::new(&entry.path), &catalog.dir))
        .map(|entry| entry.name.clone());
    let name = match name {
        Some(name) => name,
        None if is_same_path(&catalog.dir, root) => DEFAULT_NAME.into(),
        None => display_name(&catalog.dir, None)?,
    };
    Ok(WorkspaceEntry {
        id,
        name,
        path: clean_path(&catalog.dir),
    })
}

fn snapshot(root: &Path, catalog: &Catalog) -> Result<WorkspaceSnapshot, String> {
    let (registry, mut warning) = match read_registry(root) {
        Ok(registry) => (registry, None),
        Err(error) => (Registry::default(), Some(error)),
    };
    let current = entry_for(catalog, root, &registry)?;
    if let Some(configured) = configured_workspace(&registry) {
        if !is_same_path(Path::new(&configured.path), &catalog.dir) {
            warning = Some("已登记的资料库暂不可用，当前使用默认个人库。".into());
        }
    }
    let mut workspaces = registry.workspaces;
    workspaces.retain(|entry| entry.id != current.id);
    if current.id != DEFAULT_ID && workspaces.iter().all(|entry| entry.id != DEFAULT_ID) {
        workspaces.insert(0, default_entry(root));
    }
    workspaces.insert(0, current.clone());
    Ok(WorkspaceSnapshot {
        current,
        workspaces,
        warning,
    })
}

fn require_idle(catalog: &Catalog) -> Result<(), String> {
    let has_jobs: bool = catalog
        .conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued','running'))",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if has_jobs {
        return Err("请等待当前 DCC 导入任务结束，再切换或迁移资料库。".into());
    }
    Ok(())
}

fn normalize_staged_database(path: &Path) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE);
             PRAGMA journal_mode=DELETE;
             PRAGMA foreign_keys=ON;
             PRAGMA secure_delete=ON;
             DELETE FROM settings WHERE key IN ('team_preferences', 'bridge_token');
             DELETE FROM asset_collections WHERE scope != 'personal';
             DELETE FROM jobs WHERE json_extract(data,'$.assetId') LIKE 'team:%';
             VACUUM;",
        )
        .map_err(|error| format!("无法整理资料库副本：{error}"))?;
    Ok(())
}

fn allowed_support_file(folder: &str, name: &str) -> bool {
    if folder == "asset-versions" {
        return Uuid::parse_str(name).is_ok_and(|id| id.to_string() == name);
    }
    name.strip_prefix("cover-")
        .and_then(|name| name.strip_suffix(".png"))
        .is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 100
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

fn copy_support(source: &Path, staging: &Path, folder: &str) -> Result<(), String> {
    let source = source.join(folder);
    match fs::symlink_metadata(&source) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err(format!("托管资料目录类型无效：{folder}")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法读取托管资料：{error}")),
    }
    let destination = staging.join(folder);
    fs::create_dir(&destination).map_err(|error| error.to_string())?;
    let entries = fs::read_dir(&source).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|name| allowed_support_file(folder, name))
        {
            continue;
        }
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            return Err(format!("托管资料文件类型无效：{}", name.to_string_lossy()));
        }
        let mut input = File::open(entry.path()).map_err(|error| error.to_string())?;
        let mut output =
            File::create_new(destination.join(&name)).map_err(|error| error.to_string())?;
        io::copy(&mut input, &mut output).map_err(|error| format!("无法复制托管资料：{error}"))?;
    }
    Ok(())
}

fn validate_versions(staging: &Path) -> Result<(), String> {
    let database =
        Connection::open_with_flags(staging.join(DATABASE), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| error.to_string())?;
    let mut query = database
        .prepare("SELECT id,size FROM asset_versions")
        .map_err(|error| error.to_string())?;
    let versions = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for version in versions {
        let (id, size) = version.map_err(|error| error.to_string())?;
        if !allowed_support_file("asset-versions", &id) {
            return Err("资料库的版本编号无效".into());
        }
        let metadata = fs::metadata(staging.join("asset-versions").join(&id));
        if !metadata.is_ok_and(|file| file.is_file() && file.len() == size) {
            return Err(format!("版本文件缺失或损坏：{id}"));
        }
    }
    Ok(())
}

struct Publication {
    files: Vec<(PathBuf, same_file::Handle)>,
    directories: Vec<PathBuf>,
    committed: bool,
}

impl Publication {
    fn new() -> Self {
        Self {
            files: Vec::new(),
            directories: Vec::new(),
            committed: false,
        }
    }

    fn publish_file(&mut self, staged: &Path, target: PathBuf) -> Result<(), String> {
        let mut input = File::open(staged).map_err(|error| error.to_string())?;
        let mut output = NamedTempFile::new_in(target.parent().ok_or("目标路径无效")?)
            .map_err(|error| error.to_string())?;
        io::copy(&mut input, &mut output).map_err(|error| format!("无法复制资料库：{error}"))?;
        output
            .as_file()
            .sync_all()
            .map_err(|error| format!("无法写入资料库：{error}"))?;
        let identity = same_file::Handle::from_file(
            output
                .as_file()
                .try_clone()
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        output
            .persist_noclobber(&target)
            .map_err(|error| format!("无法在目标目录保存资料库：{}", error.error))?;
        self.files.push((target, identity));
        Ok(())
    }

    fn publish(mut self, staging: &Path, destination: &Path) -> Result<(), String> {
        empty_directory(destination)?;
        for folder in MANAGED_FOLDERS {
            let origin = staging.join(folder);
            if !origin.is_dir() {
                continue;
            }
            let target = destination.join(folder);
            fs::create_dir(&target).map_err(|error| format!("无法创建资料库附属目录：{error}"))?;
            self.directories.push(target.clone());
            for entry in fs::read_dir(origin).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                self.publish_file(&entry.path(), target.join(entry.file_name()))?;
            }
        }
        self.publish_file(&staging.join(DATABASE), destination.join(DATABASE))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for Publication {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for (file, identity) in self.files.drain(..).rev() {
            let owned =
                same_file::Handle::from_path(&file).is_ok_and(|current| current == identity);
            drop(identity);
            if owned {
                let _ = fs::remove_file(file);
            }
        }
        for directory in self.directories.drain(..).rev() {
            let _ = fs::remove_dir(directory);
        }
    }
}

fn stage_at(destination: &Path) -> Result<TempDir, String> {
    empty_directory(destination)?;
    let parent = destination.parent().ok_or("目标资料库目录无效")?;
    tempfile::Builder::new()
        .prefix(".nexus-workspace-")
        .tempdir_in(parent)
        .map_err(|error| format!("无法创建资料库暂存目录：{error}"))
}

fn create_at(destination: &Path) -> Result<Catalog, String> {
    let staging = stage_at(destination)?;
    {
        let catalog = Catalog::open(staging.path())?;
        asset_versions::initialize(&catalog.conn)?;
        assign_id(&catalog, &Uuid::new_v4().to_string())?;
    }
    normalize_staged_database(&staging.path().join(DATABASE))?;
    Publication::new().publish(staging.path(), destination)?;
    existing_catalog(destination)
}

fn migrate_to(catalog: &Catalog, destination: &Path) -> Result<Catalog, String> {
    let staging = stage_at(destination)?;
    let snapshot = staging.path().join(DATABASE);
    catalog
        .conn
        .backup(DatabaseName::Main, &snapshot, None)
        .map_err(|error| format!("无法备份当前资料库：{error}"))?;
    normalize_staged_database(&snapshot)?;
    for folder in MANAGED_FOLDERS {
        copy_support(&catalog.dir, staging.path(), folder)?;
    }
    validate_versions(staging.path())?;
    Publication::new().publish(staging.path(), destination)?;
    existing_catalog(destination)
}

fn switch_to(
    catalog: &mut Catalog,
    root: &Path,
    mut registry: Registry,
    next: Catalog,
    name: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    let id = match read_id(&next)? {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4().to_string();
            assign_id(&next, &id)?;
            id
        }
    };
    let prior = registry.workspaces.iter().find(|entry| entry.id == id);
    let label = name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| prior.map(|entry| entry.name.clone()));
    let label = if is_same_path(&next.dir, root) && label.is_none() {
        DEFAULT_NAME.into()
    } else {
        display_name(&next.dir, label)?
    };
    next.recover_jobs()?;
    registry.active = Some(id.clone());
    registry.workspaces.retain(|entry| entry.id != id);
    registry.workspaces.push(WorkspaceEntry {
        id,
        name: label,
        path: clean_path(&next.dir),
    });
    save_registry(root, &registry)?;
    *catalog = next;
    snapshot(root, catalog)
}

#[tauri::command]
pub async fn personal_workspaces(state: State<'_, AppState>) -> Result<WorkspaceSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let catalog = lock_db(&state)?;
        snapshot(&state.root, &catalog)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn rename_workspace(
    root: &Path,
    catalog: &Catalog,
    id: &str,
    name: String,
) -> Result<WorkspaceSnapshot, String> {
    if name.trim().is_empty() {
        return Err("资料库名称须为 1 到 100 个字符".into());
    }
    let mut registry = read_registry(root)?;
    let current = entry_for(catalog, root, &registry)?;
    let mut entry = registry
        .workspaces
        .iter()
        .find(|entry| entry.id == id)
        .cloned()
        .or_else(|| (current.id == id).then_some(current))
        .or_else(|| (id == DEFAULT_ID).then(|| default_entry(root)))
        .ok_or("资料库不存在")?;
    entry.name = display_name(Path::new(&entry.path), Some(name))?;
    if let Some(registered) = registry.workspaces.iter_mut().find(|registered| registered.id == id) {
        *registered = entry;
    } else {
        registry.workspaces.push(entry);
    }
    save_registry(root, &registry)?;
    snapshot(root, catalog)
}

#[tauri::command]
pub async fn change_personal_workspace(
    window: WebviewWindow,
    state: State<'_, AppState>,
    action: String,
    id: Option<String>,
    name: Option<String>,
) -> Result<Option<WorkspaceSnapshot>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if action == "rename" {
            let _guard = state
                .workspace_io
                .try_lock()
                .map_err(|_| "资料库仍有文件操作，请等待完成后重试。")?;
            let catalog = lock_db(&state)?;
            return rename_workspace(
                &state.root,
                &catalog,
                id.as_deref().ok_or("请选择已登记的资料库")?,
                name.ok_or("请输入资料库名称")?,
            )
            .map(Some);
        }
        let picker_title = match action.as_str() {
            "create" => Some("选择空目录创建个人资料库"),
            "open" => Some("选择现有 Nexus 资料库的目录"),
            "migrate" => Some("选择空目录迁移当前个人资料库"),
            "activate" => None,
            _ => return Err("未知资料库操作".into()),
        };
        let original = lock_db(&state)?.dir.clone();
        let selected = match picker_title {
            Some(title) => {
                let Some(folder) = rfd::FileDialog::new()
                    .set_parent(&window)
                    .set_title(title)
                    .pick_folder()
                else {
                    return Ok(None);
                };
                Some(normalized_directory(&folder)?)
            }
            None => None,
        };
        let _guard = state
            .workspace_io
            .try_lock()
            .map_err(|_| "资料库仍有文件操作，请等待完成后重试。")?;
        let mut current = lock_db(&state)?;
        if !is_same_path(&original, &current.dir) {
            return Err("当前资料库已切换，请重新选择。".into());
        }
        let registry = read_registry(&state.root)?;
        let destination = match selected {
            Some(path) => path,
            None => {
                let id = id.as_deref().ok_or("请选择已登记的资料库")?;
                let path = registry
                    .workspaces
                    .iter()
                    .find(|entry| entry.id == id)
                    .map(|entry| PathBuf::from(&entry.path))
                    .or_else(|| (id == DEFAULT_ID).then(|| state.root.clone()))
                    .ok_or("资料库不存在")?;
                normalized_directory(&path)?
            }
        };
        if is_same_path(&destination, &current.dir) {
            return match action.as_str() {
                "open" | "activate" => snapshot(&state.root, &current).map(Some),
                _ => Err("请选择与当前资料库不同的空目录。".into()),
            };
        }
        if crate::workspace_windows::has_multiple_workspace_windows(window.app_handle()) {
            return Err("请关闭其他 Nexus 工作区窗口后再切换资料库。".into());
        }
        require_idle(&current)?;
        if name.is_some() {
            display_name(&destination, name.clone())?;
        }
        let name =
            if action == "migrate" && name.as_deref().is_none_or(|name| name.trim().is_empty()) {
                Some(entry_for(&current, &state.root, &registry)?.name)
            } else {
                name
            };
        let next = match action.as_str() {
            "create" => create_at(&destination)?,
            "migrate" => migrate_to(&current, &destination)?,
            _ if is_same_path(&destination, &state.root) => default_catalog(&state.root)?,
            _ => existing_catalog(&destination)?,
        };
        switch_to(&mut current, &state.root, registry, next, name).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder(parent: &Path, name: &str) -> PathBuf {
        let path = parent.join(name);
        fs::create_dir(&path).unwrap();
        normalized_directory(&path).unwrap()
    }

    #[test]
    fn migration_reads_wal_and_preserves_owned_files_without_copying_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let source = folder(temp.path(), "source");
        let target = folder(temp.path(), "target");
        let assets = folder(temp.path(), "assets");
        let mut catalog = default_catalog(&source).unwrap();
        let mesh = assets.join("椅子.obj");
        fs::write(&mesh, "v 0 0 0").unwrap();
        assert!(catalog.add_file(&mesh, "loose").unwrap());
        let asset = catalog
            .assets()
            .unwrap()
            .into_iter()
            .find(|asset| !asset.demo)
            .unwrap();
        catalog
            .patch(&asset.id, json!({"rating":4, "notes":"owned"}))
            .unwrap();
        let workspace = read_id(&catalog).unwrap();
        let covers = folder(&source, "asset-covers");
        fs::write(covers.join(format!("cover-{}.png", asset.id)), b"preview").unwrap();
        fs::write(covers.join("unrelated.txt"), b"don't copy").unwrap();
        let versions = folder(&source, "asset-versions");
        let version = Uuid::new_v4().to_string();
        fs::write(versions.join(&version), b"snapshot").unwrap();
        catalog
            .conn
            .execute(
                "INSERT INTO asset_versions(id,asset_id,version,created,note,size,filename)
             VALUES (?1,?2,1,0,'snapshot',8,'asset.obj')",
                [&version, &asset.id],
            )
            .unwrap();
        catalog
            .conn
            .execute_batch(
                "INSERT INTO settings VALUES('bridge_token','BRIDGE_SECRET');
             INSERT INTO settings VALUES('team_preferences','TEAM_PREFS_SECRET');",
            )
            .unwrap();
        catalog.create_collection("personal", "家具").unwrap();
        let team_scope = format!("team:{}:{}", Uuid::new_v4(), Uuid::new_v4());
        catalog
            .create_collection(&team_scope, "团队私有记录")
            .unwrap();
        catalog
            .put_job(&json!({
                "id":"team-job","sessionId":"session","status":"done","assetId":"team:remote"
            }))
            .unwrap();
        fs::write(source.join("unrelated.json"), b"not part of workspace").unwrap();

        let copy = migrate_to(&catalog, &target).unwrap();
        assert_eq!(read_id(&copy).unwrap(), workspace);
        assert_eq!(copy.asset(&asset.id).unwrap().rating, 4);
        assert_eq!(copy.asset(&asset.id).unwrap().notes, "owned");
        assert_eq!(copy.asset(&asset.id).unwrap().path, asset.path);
        assert!(Path::new(&asset.path).is_file());
        assert_eq!(
            fs::read(target.join("asset-versions").join(&version)).unwrap(),
            b"snapshot"
        );
        assert_eq!(
            fs::read(
                target
                    .join("asset-covers")
                    .join(format!("cover-{}.png", asset.id))
            )
            .unwrap(),
            b"preview"
        );
        assert!(!target.join("unrelated.json").exists());
        assert!(!target.join("asset-covers/unrelated.txt").exists());
        assert_eq!(copy.list_collections("personal").unwrap().len(), 1);
        assert!(copy.list_collections(&team_scope).unwrap().is_empty());
        assert!(copy.jobs().unwrap().is_empty());
        let secrets: i64 = copy
            .conn
            .query_row(
                "SELECT count(*) FROM settings WHERE key IN ('bridge_token','team_preferences')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(secrets, 0);
        let bytes = fs::read(target.join(DATABASE)).unwrap();
        assert!(!bytes
            .windows(b"BRIDGE_SECRET".len())
            .any(|part| part == b"BRIDGE_SECRET"));
        assert!(!bytes
            .windows(b"TEAM_PREFS_SECRET".len())
            .any(|part| part == b"TEAM_PREFS_SECRET"));
        assert!(source.join(DATABASE).is_file());
        assert_eq!(catalog.asset(&asset.id).unwrap().notes, "owned");
        let changed = switch_to(
            &mut catalog,
            &source,
            read_registry(&source).unwrap(),
            copy,
            Some(DEFAULT_NAME.into()),
        )
        .unwrap();
        assert_eq!(changed.current.id, DEFAULT_ID);
        assert_eq!(changed.current.path, clean_path(&target));
        drop(catalog);
        let resumed = open_startup_catalog(&source).unwrap();
        assert_eq!(clean_path(&resumed.dir), clean_path(&target));
        assert_eq!(resumed.asset(&asset.id).unwrap().notes, "owned");
    }

    #[test]
    fn remembers_independent_workspaces_and_recovers_from_an_unavailable_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let root = folder(temp.path(), "default");
        let target = folder(temp.path(), "target");
        let mut catalog = open_startup_catalog(&root).unwrap();
        assert_eq!(snapshot(&root, &catalog).unwrap().current.id, DEFAULT_ID);
        assert!(!catalog.assets().unwrap().is_empty());

        let created = create_at(&target).unwrap();
        assert!(created.assets().unwrap().is_empty());
        let changed = switch_to(
            &mut catalog,
            &root,
            read_registry(&root).unwrap(),
            created,
            Some("项目资料库".into()),
        )
        .unwrap();
        assert_eq!(changed.current.name, "项目资料库");
        assert_eq!(changed.workspaces.len(), 2);
        drop(catalog);
        let restored = open_startup_catalog(&root).unwrap();
        assert_eq!(read_id(&restored).unwrap().unwrap(), changed.current.id);
        drop(restored);

        fs::rename(&target, temp.path().join("moved")).unwrap();
        let fallback = open_startup_catalog(&root).unwrap();
        let info = snapshot(&root, &fallback).unwrap();
        assert_eq!(info.current.id, DEFAULT_ID);
        assert!(info.warning.is_some());
        assert!(info
            .workspaces
            .iter()
            .any(|entry| entry.id == changed.current.id));
    }

    #[test]
    fn rejects_unrelated_files_nonempty_targets_and_live_imports() {
        let temp = tempfile::tempdir().unwrap();
        let other = folder(temp.path(), "other");
        let db = Connection::open(other.join(DATABASE)).unwrap();
        db.execute_batch("CREATE TABLE unrelated(id INTEGER)")
            .unwrap();
        assert!(validate_database(&other).is_err());
        assert!(create_at(&other).is_err());
        let unchanged: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='assets'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unchanged, 0);
        let source = folder(temp.path(), "source");
        let catalog = create_at(&source).unwrap();
        assert!(require_idle(&catalog).is_ok());
        catalog
            .put_job(&json!({"id":"job","sessionId":"s","status":"queued"}))
            .unwrap();
        assert!(require_idle(&catalog).is_err());
    }

    #[test]
    fn renames_personal_workspaces_without_switching_catalogs() {
        let temp = tempfile::tempdir().unwrap();
        let root = folder(temp.path(), "default");
        let alternate = folder(temp.path(), "alternate");
        let mut catalog = default_catalog(&root).unwrap();
        let default = rename_workspace(&root, &catalog, DEFAULT_ID, " 本机素材 ".into()).unwrap();
        assert_eq!(default.current.name, "本机素材");
        assert_eq!(default.current.path, clean_path(&root));
        let next = create_at(&alternate).unwrap();
        let active = switch_to(
            &mut catalog,
            &root,
            read_registry(&root).unwrap(),
            next,
            Some("活动库".into()),
        )
        .unwrap();
        let renamed = rename_workspace(&root, &catalog, DEFAULT_ID, "备用库".into()).unwrap();
        assert_eq!(renamed.current.id, active.current.id);
        assert_eq!(renamed.current.path, active.current.path);
        let original = renamed.workspaces.iter().find(|item| item.id == DEFAULT_ID).unwrap();
        assert_eq!(original.name, "备用库");
        assert_eq!(original.path, clean_path(&root));
        assert!(rename_workspace(&root, &catalog, DEFAULT_ID, "  ".into()).is_err());
        assert!(rename_workspace(&root, &catalog, "missing", "无效".into()).is_err());
    }
}

