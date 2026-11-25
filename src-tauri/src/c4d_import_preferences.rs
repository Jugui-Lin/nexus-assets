use crate::AppState;
use nexus_core::clean_path;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

mod cache;

const FILE: &str = "c4d-import-preferences.json";
const WORKSPACES: &str = "c4d-import-workspaces";

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MaxMode {
    Direct,
    #[default]
    Application,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    directory: Option<String>,
    cleanup_on_startup: bool,
    blender_executable: Option<String>,
    max_batch_executable: Option<String>,
    max_mode: MaxMode,
}

fn workspace_key(workspace: Option<&str>) -> Result<Option<String>, String> {
    let Some(workspace) = workspace.filter(|value| *value != "personal:personal") else {
        return Ok(None);
    };
    let (kind, id) = workspace
        .split_once(':')
        .ok_or("C4D 导入设置所属资产库无效")?;
    let id = Uuid::parse_str(id).map_err(|_| "C4D 导入设置所属资产库无效")?;
    if !matches!(kind, "personal" | "team") {
        return Err("C4D 导入设置所属资产库无效".into());
    }
    Ok(Some(format!("{kind}-{}", id.simple())))
}

fn preference_root(root: &Path, workspace_key: Option<&str>) -> PathBuf {
    match workspace_key {
        Some(key) => root.join(WORKSPACES).join(key),
        None => root.to_owned(),
    }
}

fn cache_directory(root: &Path, workspace_key: Option<&str>, directory: Option<&str>) -> PathBuf {
    match (directory, workspace_key) {
        (Some(path), Some(key)) => Path::new(path).join(format!("Nexus-C4D-Import-Cache-{key}")),
        (Some(path), None) => Path::new(path).join("Nexus-C4D-Import-Cache"),
        (None, _) => root.join("c4d-import-cache"),
    }
}

fn view(root: &Path, workspace_key: Option<&str>, preferences: &Preferences) -> Value {
    let mut result = json!(preferences);
    result["effectiveDirectory"] = json!(clean_path(&cache_directory(
        root,
        workspace_key,
        preferences.directory.as_deref(),
    )));
    result
}

fn absolute_path(path: &str, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(format!("请选择{name}的完整路径"));
    }
    fs::canonicalize(path).map_err(|_| format!("无法访问{name}"))
}

fn converter_names(kind: &str) -> Result<&'static [&'static str], String> {
    match kind {
        "blender" => Ok(&["blender", "blender.exe"]),
        "max" if cfg!(windows) => Ok(&["3dsmaxbatch.exe"]),
        "max" => Err("3ds Max Batch 仅支持 Windows".into()),
        _ => Err("未知的转换程序".into()),
    }
}

fn checked_executable(value: Option<String>, kind: &str) -> Result<Option<String>, String> {
    let Some(value) = value.filter(|path| !path.trim().is_empty()) else {
        return Ok(None);
    };
    let names = converter_names(kind)?;
    let path = absolute_path(&value, "转换程序")?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if !path.is_file() || !names.iter().any(|name| filename.eq_ignore_ascii_case(name)) {
        return Err(format!("请选择 {}", names.join(" / ")));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(&path)
            .map_err(|_| "无法读取转换程序权限")?
            .permissions();
        if permissions.mode() & 0o111 == 0 {
            return Err("所选文件没有执行权限".into());
        }
    }
    Ok(Some(clean_path(&path)))
}

fn read(root: &Path) -> Result<Preferences, String> {
    match fs::read(root.join(FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "无法读取 C4D 导入设置".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(_) => Err("无法读取 C4D 导入设置".into()),
    }
}

fn write(
    root: &Path,
    workspace_key: Option<&str>,
    mut preferences: Preferences,
) -> Result<Value, String> {
    preferences.directory = preferences
        .directory
        .filter(|path| !path.trim().is_empty())
        .map(|path| -> Result<String, String> {
            let directory = absolute_path(&path, "临时文件夹")?;
            if !directory.is_dir() {
                return Err("请选择一个可读写的临时文件夹".into());
            }
            Ok(clean_path(&directory))
        })
        .transpose()?;
    preferences.blender_executable = checked_executable(preferences.blender_executable, "blender")?;
    preferences.max_batch_executable = checked_executable(preferences.max_batch_executable, "max")?;
    let cache = cache_directory(root, workspace_key, preferences.directory.as_deref());
    fs::create_dir_all(&cache).map_err(|_| "无法创建 Nexus 的 C4D 缓存目录")?;
    fs::read_dir(&cache).map_err(|_| "无法读取 C4D 缓存目录")?;
    tempfile::NamedTempFile::new_in(&cache).map_err(|_| "没有 C4D 缓存目录的写入权限")?;
    fs::create_dir_all(root).map_err(|_| "无法保存 C4D 导入设置")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(root).map_err(|_| "无法保存 C4D 导入设置")?;
    serde_json::to_writer(temporary.as_file_mut(), &preferences)
        .map_err(|_| "无法保存 C4D 导入设置")?;
    temporary.flush().map_err(|_| "无法保存 C4D 导入设置")?;
    temporary
        .persist(root.join(FILE))
        .map_err(|_| "无法保存 C4D 导入设置")?;
    Ok(view(root, workspace_key, &preferences))
}

pub(crate) fn job_preferences(root: &Path, workspace: &str) -> Result<Value, String> {
    let key = workspace_key(Some(workspace))?;
    let settings = read(&preference_root(root, key.as_deref()))?;
    Ok(json!({"workspaceKey": key, "settings": settings}))
}

#[tauri::command]
pub(crate) async fn get_c4d_import_preferences(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Value, String> {
    let key = workspace_key(workspace.as_deref())?;
    let root = preference_root(&state.root, key.as_deref());
    tauri::async_runtime::spawn_blocking(move || Ok(view(&root, key.as_deref(), &read(&root)?)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn set_c4d_import_preferences(
    state: tauri::State<'_, AppState>,
    preferences: Preferences,
    workspace: Option<String>,
) -> Result<Value, String> {
    let key = workspace_key(workspace.as_deref())?;
    let root = preference_root(&state.root, key.as_deref());
    tauri::async_runtime::spawn_blocking(move || write(&root, key.as_deref(), preferences))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn clear_c4d_import_cache(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<cache::Cleanup, String> {
    let key = workspace_key(workspace.as_deref())?;
    let root = preference_root(&state.root, key.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        let preferences = read(&root)?;
        let directory = cache_directory(&root, key.as_deref(), preferences.directory.as_deref());
        cache::clear(&directory)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheUsage {
    #[serde(flatten)]
    size: cache::Size,
    effective_directory: String,
}

#[tauri::command]
pub(crate) async fn c4d_import_cache_size(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<CacheUsage, String> {
    let key = workspace_key(workspace.as_deref())?;
    let root = preference_root(&state.root, key.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        let preferences = read(&root)?;
        let directory = cache_directory(&root, key.as_deref(), preferences.directory.as_deref());
        Ok(CacheUsage {
            size: cache::size(&directory)?,
            effective_directory: clean_path(&directory),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn pick_c4d_converter(
    window: tauri::WebviewWindow,
    kind: String,
) -> Result<Option<String>, String> {
    converter_names(&kind)?;
    tauri::async_runtime::spawn_blocking(move || {
        let title = if kind == "max" {
            "选择 3ds Max Batch"
        } else {
            "选择 Blender"
        };
        let dialog = rfd::FileDialog::new().set_parent(&window).set_title(title);
        let dialog = if cfg!(windows) {
            dialog.add_filter("可执行文件", &["exe"])
        } else {
            dialog
        };
        checked_executable(dialog.pick_file().map(|path| clean_path(&path)), &kind)
    })
    .await
    .map_err(|error| error.to_string())?
}
