#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use axum::{
    extract::State as HttpState,
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use base64::Engine;
use nexus_core::{
    c4d_smart_compatible, compatible, now, scaled_preview_image, Catalog, RecycledAsset,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

mod asset_availability;
mod asset_catalog_export;
mod asset_cover;
mod asset_files;
mod asset_versions;
mod asset_video;
mod baidu_cloud_desktop;
mod bridge_install;
mod browser_capture;
mod browser_capture_import;
mod browser_extension_install;
mod asset_ai;
mod c4d_import_preferences;
mod c4d_material_sets;
mod cloud_mounts;
mod collection_desktop;
mod drop_ingest;
mod duplicate_review;
mod exr_channel_desktop;
mod folder_browser;
mod format_help;
mod folder_deletion;
mod folder_shell;
mod indexed_file_move;
mod library_visibility;
mod local_explorer;
mod desktop_shortcut;
mod local_explorer_clipboard;
mod local_explorer_details;
mod local_explorer_drop;
mod local_explorer_new;
mod local_explorer_paste;
mod mesh_preview;
mod native_drag;
mod nexus_updater;
mod personal_tags;
mod placement;
mod project_cleanup;
mod project_dependencies;
mod render_sequences;
mod subscription_feed;
mod subscription_open;
mod team_avatar_picker;
mod team_covers;
mod team_desktop;
mod team_host;
mod team_import;
mod team_nas;
mod team_network_paths;
mod team_update_version;
mod thumbnail_desktop;
mod workspace_asset_deletion;
mod workspace_data;
mod catalog_health;
mod delivery_template;
mod shot_delivery;
mod workspace_files;
mod workspace_folder_move;
mod workspace_windows;
mod workspaces;
#[cfg(windows)]
mod youtube_player;
use team_desktop::Desktop;

const DCC_JOB_QUEUE_TIMEOUT: u64 = 120;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Catalog>>,
    root: PathBuf,
    workspace_io: Arc<Mutex<()>>,
    placement: placement::PlacementTickets,
    sessions: Arc<Mutex<HashMap<String, Value>>>,
    token: String,
    port: u16,
}
fn lock_db(s: &AppState) -> Result<std::sync::MutexGuard<'_, Catalog>, String> {
    s.db.lock().map_err(|_| "数据库锁不可用".into())
}
#[tauri::command]
async fn get_state(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions: Vec<Value> = state.sessions.lock().unwrap().values()
            .filter(|s| now().saturating_sub(s["lastSeen"].as_u64().unwrap_or(0)) < 15)
            .cloned().collect();
        let c = lock_db(&state)?;
        let (assets, libraries, hidden_folders) = library_visibility::visible_catalog(&c)?;
        let defined_tags = personal_tags::defined_tags(&c)?;
        Ok(json!({"assets":assets,"libraries":libraries,"hiddenFolders":hidden_folders,"definedTags":defined_tags,"jobs":c.jobs()?,"sessions":sessions,"engine":"Rust · SQLite","dataDir":c.dir,"port":state.port,"coverIds":asset_cover::cover_ids(&c.dir)}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_recycled_assets(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RecycledAsset>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = workspaces::lock_io(&state)?;
        lock_db(&state)?.list_recycled_assets()
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn update_recycled_assets(
    state: AppState,
    ids: Vec<String>,
    recycled: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = workspaces::lock_io(&state)?;
        let changed = lock_db(&state)?.set_assets_recycled(&ids, recycled)?;
        Ok(json!({ "changed": changed }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn recycle_assets(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Value, String> {
    update_recycled_assets(state.inner().clone(), ids, true).await
}

#[tauri::command]
async fn restore_recycled_assets(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Value, String> {
    update_recycled_assets(state.inner().clone(), ids, false).await
}

#[tauri::command]
async fn get_activity(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions: Vec<Value> = state
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| now().saturating_sub(s["lastSeen"].as_u64().unwrap_or(0)) < 15)
            .cloned()
            .collect();
        Ok(json!({"sessions":sessions,"jobs":lock_db(&state)?.jobs()?}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn scan_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    name: Option<String>,
    source: Option<String>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = workspaces::lock_io(&state)?;
        let dir = lock_db(&state)?.dir.clone();
        let mut scanner = Catalog::open(&dir)?;
        scanner.scan(
            Path::new(&path),
            name,
            &source.unwrap_or("local".into()),
            |count| {
                let _ = app.emit("scan-progress", count);
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_workspace_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    library_id: String,
    folder: String,
    expected_path: Option<String>,
    expected_workspace_id: Option<String>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = workspaces::lock_io(&state)?;
        let dir = {
            let catalog = lock_db(&state)?;
            if let Some(expected) = expected_workspace_id.as_deref() {
                if workspaces::read_id(&catalog)?.as_deref() != Some(expected) {
                    return Err("个人资产库已切换，请重新定位文件夹。".into());
                }
            }
            catalog.dir.clone()
        };
        Catalog::open(&dir)?.scan_registered_folder(
            &library_id,
            &folder,
            expected_path.as_deref().map(Path::new),
            |count| {
                let _ = app.emit("scan-progress", count);
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn patch_asset(
    state: tauri::State<'_, AppState>,
    id: String,
    patch: Value,
    expected_metadata: Option<Value>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let catalog = lock_db(&state)?;
        if let Some(expected) = expected_metadata {
            let asset = catalog.asset(&id)?;
            let current = json!({
                "path": asset.path,
                "name": asset.name,
                "tags": asset.tags,
                "notes": asset.notes,
                "rating": asset.rating,
                "workflow": asset.workflow,
            });
            if current != expected {
                return Err("资产资料或路径已变化，请载入最新信息".into());
            }
        }
        Ok(json!(catalog.patch(&id, patch)?))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn pick_folder(purpose: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let title = match purpose.as_deref() {
            Some("c4d-project") => "选择 Cinema 4D 工程的输出目录",
            Some("c4d-cache") => "选择 Cinema 4D 导入缓存位置",
            Some("inventory-root") => "选择清单使用的项目根目录",
            Some("delivery-template") => "选择交付目录的上级文件夹",
            Some("asset-original-move") => "选择原件的新位置",
            _ => "选择资产文件夹（只建立索引，不移动原文件）",
        };
        rfd::FileDialog::new()
            .set_title(title)
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_asset_folders(window: tauri::WebviewWindow) -> Result<Vec<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = rfd::FileDialog::new()
            .set_parent(&window)
            .set_title("选择一个或多个资产文件夹");
        #[cfg(windows)]
        let dialog = match std::env::var_os("SystemRoot").map(PathBuf::from) {
            Some(root) if root.parent().is_some() => {
                dialog.set_directory(root.parent().unwrap_or(&root))
            }
            _ => dialog,
        };
        dialog.pick_folders().unwrap_or_default()
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_folder_location(path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !path.is_absolute() || !path.is_dir() {
            return Err("无法访问此文件夹".into());
        }
        launch_folder_location(&path)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn launch_folder_location(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(windows, target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn scan_selected_folders(
    catalog: &mut Catalog,
    paths: Vec<PathBuf>,
    name: Option<String>,
    source: &str,
    mut report_progress: impl FnMut(u64),
) -> Value {
    let mut errors = Vec::new();
    let mut roots = Vec::new();
    for path in paths {
        match fs::canonicalize(&path) {
            Ok(root) if root.is_dir() => roots.push(root),
            _ => errors.push(format!("无法访问文件夹：{}", path.display())),
        }
    }
    roots.sort_by_key(|root| root.components().count());
    let mut selected = Vec::<PathBuf>::new();
    for root in roots {
        if !selected.iter().any(|parent| root.starts_with(parent)) {
            selected.push(root);
        }
    }
    let name = if selected.len() == 1 { name } else { None };
    let mut found = 0;
    let mut libraries = Vec::new();
    for root in selected {
        let result = catalog.scan(&root, name.clone(), source, |count| {
            report_progress(found + count as u64)
        });
        match result {
            Ok(result) => {
                found += result["found"].as_u64().unwrap_or(0);
                libraries.push(result["library"].clone());
                if let Some(scan_errors) = result["errors"].as_array() {
                    errors.extend(
                        scan_errors
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned),
                    );
                }
            }
            Err(error) => errors.push(format!("{} · {error}", root.display())),
        }
    }
    json!({"found":found,"errors":errors,"libraries":libraries})
}

#[tauri::command]
async fn scan_selected_libraries(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<PathBuf>,
    name: Option<String>,
    source: Option<String>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = workspaces::lock_io(&state)?;
        let dir = lock_db(&state)?.dir.clone();
        let mut catalog = Catalog::open(&dir)?;
        Ok(scan_selected_folders(
            &mut catalog,
            paths,
            name,
            source.as_deref().unwrap_or("local"),
            |count| {
                let _ = app.emit("scan-progress", count);
            },
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
async fn pick_asset_files(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        asset_file_dialog(&window)
            .pick_files()
            .unwrap_or_default()
            .iter()
            .map(|path| nexus_core::clean_path(path))
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

fn asset_file_dialog(window: &tauri::WebviewWindow) -> rfd::FileDialog {
    rfd::FileDialog::new()
        .set_parent(window)
        .set_title("选择要索引的资产文件")
}

#[tauri::command]
async fn import_files(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = workspaces::lock_io(&state)?;
        let Some(files) = asset_file_dialog(&window).pick_files() else {
            return Ok(json!({"found":0,"duplicates":0,"skipped":0,"failed":0,"errors":[]}));
        };
        let directory = lock_db(&state)?.dir.clone();
        let catalog = Catalog::open(&directory)?;
        let mut importer = catalog.file_import();
        let (mut found, mut duplicates, mut skipped, mut failed) = (0, 0, 0, 0);
        let mut errors = Vec::new();
        for path in files {
            match importer.add(&path, "loose") {
                Ok(nexus_core::FileImportOutcome::Indexed) => found += 1,
                Ok(nexus_core::FileImportOutcome::Duplicate) => duplicates += 1,
                Ok(nexus_core::FileImportOutcome::Unsupported) => skipped += 1,
                Err(error) => {
                    failed += 1;
                    if errors.len() < 100 {
                        errors.push(format!("{}：{error}", nexus_core::clean_path(&path)));
                    }
                }
            }
        }
        Ok(json!({"found":found,"duplicates":duplicates,"skipped":skipped,"failed":failed,"errors":errors}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_preview(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
    mode: String,
    size: Option<u32>,
) -> Result<Value, String> {
    let size = thumbnail_desktop::checked_size(size)?;
    let mesh = matches!(mode.as_str(), "mesh" | "mesh_thumbnail");
    let _preview_slot = if mesh {
        mesh_preview::slot().await?
    } else {
        thumbnail_desktop::image_slot().await?
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if mode == "thumbnail_cached" {
            return Ok(preview_image_payload(thumbnail_desktop::read_indexed_thumbnail(&state, &app, &id, size)?));
        }
        if mode == "thumbnail_shared" {
            return Ok(preview_image_payload(thumbnail_desktop::read_shared_thumbnail(&state, &app, &id, size)?));
        }
        let source = thumbnail_desktop::PreviewSource::resolve(&state, &app, &id)?;
        if mode == "original_pixels" {
            let Some((mime, bytes, (width, height))) = thumbnail_desktop::read_original_pixels(&source.asset)? else {
                return Ok(Value::Null);
            };
            let mut payload = preview_image_payload(Some((mime, bytes)));
            payload["width"] = json!(width);
            payload["height"] = json!(height);
            return Ok(payload);
        }
        if mode == "dimensions" {
            if source.asset.kind != "texture" {
                return Ok(Value::Null);
            }
            let dimensions = image::image_dimensions(&source.asset.path).ok();
            return Ok(dimensions.map_or(Value::Null, |(width, height)| {
                json!({"width":width,"height":height})
            }));
        }
        if mesh {
            let a = &source.asset;
            let thumbnail = mode == "mesh_thumbnail";
            let cache_key = if thumbnail { source.mesh_key(size) } else { None };
            let mut payload = match mesh_preview::read(Path::new(&a.path), &a.ext, thumbnail)? {
                mesh_preview::Preview::Obj(text) => json!({"text":text}),
                mesh_preview::Preview::Binary(bytes) => {
                    json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes)})
                }
            };
            if let Some(cache_key) = cache_key {
                payload["cacheKey"] = json!(cache_key);
            }
            return Ok(payload);
        }
        let visual = match mode.as_str() {
            "preview" | "large" => scaled_preview_image(
                &source.asset,
                &source.data_dir.join("thumbnail-cache"),
                if mode == "large" { 1600 } else { 512 },
            )?,
            _ => source.thumbnail(size)?,
        };
        Ok(preview_image_payload(visual))
    }).await.map_err(|e|e.to_string())?
}

fn preview_image_payload(image: Option<(String, Vec<u8>)>) -> Value {
    let Some((mime, bytes)) = image else { return Value::Null; };
    json!({"url":format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(bytes))})
}
#[tauri::command]
async fn reveal_asset(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = resolve_asset(&state, &app, &id)?.path;
        reveal_path(&p)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn resolve_asset(
    state: &AppState,
    app: &tauri::AppHandle,
    id: &str,
) -> Result<nexus_core::Asset, String> {
    if let Some(id) = id.strip_prefix("team:") {
        return app.state::<Desktop>().local_asset(id);
    }
    lock_db(state)?.asset(id)
}

fn reveal_path(p: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(&p)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(Path::new(&p).parent().unwrap())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
async fn export_bridge(state: tauri::State<'_, AppState>, dcc: String) -> Result<Value, String> {
    let state = state.inner().clone();
    if !["blender", "c4d", "maya", "max", "houdini"].contains(&dcc.as_str()) {
        return Err("未知 DCC".into());
    }
    tauri::async_runtime::spawn_blocking(move||{
        let Some(p)=rfd::FileDialog::new().set_file_name(format!("nexus_{}.py",dcc)).save_file() else {return Ok(Value::Null);};
        let config=json!({"url":format!("http://127.0.0.1:{}",state.port),"token":state.token,"dcc":dcc});
        let encoded=base64::engine::general_purpose::STANDARD.encode(config.to_string());
        let script=format!("# Nexus Assets local bridge; contains a local access token.\nimport base64, json\nCONFIG=json.loads(base64.b64decode('{}'))\n{}",encoded,include_str!("../../bridges/nexus_bridge.py"));
        fs::write(&p,script).map_err(|e|e.to_string())?;
        Ok(json!({"path":p,"dcc":dcc}))
    }).await.map_err(|e|e.to_string())?
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct SmartImportOptions {
    kind: String,
    renderer: String,
    lod: Option<u8>,
    texture_resolution: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    map_keywords: Option<HashMap<String, Vec<String>>>,
    #[serde(skip_serializing)]
    pbr_material_set: Option<c4d_material_sets::MaterialSetRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_mode: Option<c4d_import_preferences::MaxMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene_import: Option<C4dSceneImportOptions>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct C4dSceneImportOptions {
    objects: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    normals: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    store_textures: Option<bool>,
    materials: bool,
    textures: bool,
    cameras: bool,
    lights: bool,
    animation: bool,
    empty_objects: bool,
}

impl SmartImportOptions {
    fn scene_overrides(&self) -> bool {
        self.scene_import.is_some() || self.max_mode.is_some()
    }

    fn direct_max_textures(&self, extension: &str, saved_mode: Option<&str>) -> bool {
        use c4d_import_preferences::MaxMode;
        extension == "max"
            && matches!(self.kind.as_str(), "auto" | "scene")
            && self.scene_import.as_ref().is_none_or(|scene| scene.materials && scene.textures)
            && match self.max_mode {
                Some(mode) => matches!(mode, MaxMode::Direct),
                None => saved_mode == Some("direct"),
            }
    }

    fn validate(&self) -> Result<(), String> {
        if !matches!(
            self.kind.as_str(),
            "auto" | "scene" | "pbr" | "texture" | "hdri" | "ies"
        ) || !matches!(
            self.renderer.as_str(),
            "auto" | "standard" | "redshift" | "octane" | "arnold" | "vray" | "corona"
        ) || self.lod.is_some_and(|lod| lod > 8)
            || self
                .texture_resolution
                .is_some_and(|size| !matches!(size, 512 | 1024 | 2048 | 4096 | 8192))
        {
            return Err("Cinema 4D 智能导入设置无效。".into());
        }
        if self.scene_overrides() && self.kind != "scene" {
            return Err("模型导入选项需要场景导入模式。".into());
        }
        if self.scene_import.as_ref().is_some_and(|options| !options.objects && !options.materials) {
            return Err("请至少导入对象或材质。".into());
        }
        if self.scene_import.as_ref().is_some_and(|options| options.store_textures == Some(true) &&
            (!options.materials || !options.textures)) {
            return Err("归档贴图需要导入材质和贴图。".into());
        }
        if self.map_keywords.as_ref().is_some_and(|channels| {
            channels.iter().any(|(channel, aliases)| {
                !matches!(channel.as_str(),
                    "base_color" | "ao" | "metallic" | "roughness" | "specular" | "glossiness" |
                    "bump" | "normal" | "opacity" | "displacement" | "emission" | "translucency")
                    || aliases.len() > 16
                    || aliases.iter().any(|alias| alias.trim().is_empty() || alias.len() > 120
                        || alias.chars().any(char::is_control))
            })
        }) {
            return Err("贴图通道关键词设置无效。".into());
        }
        Ok(())
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct C4dProjectExport {
    destination: String,
    mode: c4d_import_preferences::MaxMode,
}

impl C4dProjectExport {
    fn check(&mut self, extension: &str) -> Result<(), String> {
        use c4d_import_preferences::MaxMode;
        if !matches!((extension, self.mode), ("max", _) | ("blend", MaxMode::Application)) {
            return Err("此转换方式不支持所选源工程".into());
        }
        let destination = Path::new(&self.destination);
        if !destination.is_absolute() {
            return Err("请选择 Cinema 4D 工程的保存目录".into());
        }
        let destination = fs::canonicalize(destination).map_err(|_| "无法访问工程保存目录")?;
        if !destination.is_dir() {
            return Err("所选工程保存路径不是文件夹".into());
        }
        self.destination = nexus_core::clean_path(&destination);
        Ok(())
    }
}

#[tauri::command]
async fn queue_import(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    asset_id: String,
    session_id: String,
    smart_options: Option<SmartImportOptions>,
    project_export: Option<C4dProjectExport>,
    workspace: Option<String>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
    let _workspace = workspaces::lock_io(&state)?;
    let session = state.sessions.lock().unwrap().get(&session_id).cloned().ok_or("目标实例已离线")?;
    if now().saturating_sub(session["lastSeen"].as_u64().unwrap_or(0)) >= 15 {
        return Err("目标实例已离线".into());
    }
    let a = resolve_asset(&state, &app, &asset_id)?;
    let host = session["dcc"].as_str().unwrap_or("");
    if let Some(options) = &smart_options {
        options.validate()?;
        if options.pbr_material_set.is_some() && (options.kind != "pbr"
            || host != "c4d" || session["pbrMaterialSets"] != true || project_export.is_some())
        {
            return Err("请更新 Cinema 4D 桥接并重新连接，再发送材质套图。".into());
        }
        if options.scene_overrides() && session["sceneImportOptions"] != true {
            return Err("请在 DCC 连接中心查看同步状态，重开 Cinema 4D 后使用模型导入选项。".into());
        }
        if options.scene_import.as_ref().is_some_and(|scene| scene.store_textures == Some(true)) &&
            (host != "c4d" || session["archiveTextures"] != true || project_export.is_some()) {
            return Err("请更新并重启 Cinema 4D 插件，再归档到当前工程。".into());
        }
    }
    let mut project_export = project_export;
    if let Some(project) = &mut project_export {
        if host != "c4d" || session["projectExport"] != true {
            return Err("请在 DCC 连接中心查看同步状态，重开 Cinema 4D 后再转换。".into());
        }
        project.check(&a.ext)?;
    } else if smart_options.is_some() {
        if host != "c4d" || session["smartImport"] != true {
            return Err("请从 DCC 连接中心更新 Cinema 4D 插件并重启。".into());
        }
        if !c4d_smart_compatible(&a.ext) {
            return Err(format!("Cinema 4D 智能导入无法处理 .{}。", a.ext));
        }
    } else if !session_supports_asset(&session, &a.ext) {
        if host == "blender" && a.ext.eq_ignore_ascii_case("max") {
            return Err("请从 DCC 连接中心更新 Blender 插件并重启 Blender 后导入 MAX。".into());
        }
        return Err(format!(
            "目标 DCC 暂不支持 .{}，请先使用源软件转换为 OBJ / FBX",
            a.ext
        ));
    }
    if !Path::new(&a.path).is_file() {
        return Err("资产文件不可用，请检查本地路径或网盘挂载".into());
    }
    let mut j = json!({"id":Uuid::new_v4().to_string(),"sessionId":session_id,"dcc":session["dcc"],"assetId":a.id,"name":a.name,"path":a.path,"status":"queued","created":now()});
    if let Some(options) = &smart_options {
        j["mode"] = json!("smart");
        j["options"] = json!(options);
        if let Some(request) = &options.pbr_material_set {
            let maps = request.resolve(&asset_id, &a, |id| resolve_asset(&state, &app, id))?;
            j["options"]["pbr_maps"] = json!(maps);
            j["options"]["pbr_name"] = json!(request.name);
        }
    }
    if let Some(project) = project_export {
        j["mode"] = json!("smart");
        j["projectExport"] = json!(project);
    }
    if j["mode"] == "smart" {
        if let Some(workspace) = workspace.as_deref() {
            if session["scopedC4dPreferences"] == true {
                j["c4dPreferences"] = c4d_import_preferences::job_preferences(&state.root, workspace)?;
                let converter = match a.ext.as_str() {
                    "blend" => Some(("blender", "blenderExecutable")),
                    "max" => {
                        let mode = j["projectExport"]["mode"].as_str()
                            .or_else(|| j["options"]["maxMode"].as_str())
                            .or_else(|| j["c4dPreferences"]["settings"]["maxMode"].as_str());
                        if mode == Some("direct") {
                            Some(("blender", "blenderExecutable"))
                        } else {
                            Some(("max", "maxBatchExecutable"))
                        }
                    }
                    _ => None,
                };
                if let Some((kind, field)) = converter {
                    let setting = &mut j["c4dPreferences"]["settings"][field];
                    if setting.is_null() {
                        if let Some(path) = bridge_install::converter_executable(&app, kind) {
                            *setting = json!(path);
                        }
                    }
                }
            } else if workspace != "personal:personal" {
                return Err("请在 DCC 连接中心查看同步状态，重开 Cinema 4D 后使用当前资产库的导入设置。".into());
            }
        }
    }
    if host == "c4d" && session["maxTextureBindings"] != true && j["projectExport"].is_null() {
        let saved_mode = j["c4dPreferences"]["settings"]["maxMode"].as_str();
        if smart_options.as_ref().is_some_and(|options| options.direct_max_textures(&a.ext, saved_mode)) {
            return Err("当前 Cinema 4D 会话还在运行旧桥接。请保存工程，待 DCC 连接中心同步完成后重开 Cinema 4D，再导入 MAX 贴图。".into());
        }
    }
    lock_db(&state)?.put_job(&j)?;
    Ok(j)
    }).await.map_err(|e|e.to_string())?
}
type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;
fn api_error(code: StatusCode, s: &str) -> (StatusCode, Json<Value>) {
    (code, Json(json!({"error":s})))
}
fn auth(s: &AppState, h: &HeaderMap) -> Result<(), (StatusCode, Json<Value>)> {
    // DCC operations accept only bridge clients, independent of the media routes.
    if h.contains_key("origin")
        || h.get("authorization").and_then(|v| v.to_str().ok())
            != Some(&format!("Bearer {}", s.token))
    {
        return Err(api_error(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    Ok(())
}
async fn register(
    HttpState(s): HttpState<AppState>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    auth(&s, &headers)?;
    let dcc = v["dcc"].as_str().unwrap_or("");
    if !["blender", "c4d", "maya", "max", "houdini"].contains(&dcc) {
        return Err(api_error(StatusCode::BAD_REQUEST, "Unknown DCC"));
    }
    let id = Uuid::new_v4().to_string();
    let placement = matches!(dcc, "blender" | "c4d") && v["placement"] == true;
    let smart_import = dcc == "c4d" && v["smartImport"] == true;
    let project_export = smart_import && v["projectExport"] == true;
    let scene_import = smart_import && v["sceneImportOptions"] == true;
    let scoped_c4d_preferences = smart_import && v["scopedC4dPreferences"] == true;
    let max_texture_bindings = smart_import && v["maxTextureBindings"] == true;
    let max_import = dcc == "blender" && v["maxImport"] == true;
    let archive_textures = scene_import && v["archiveTextures"] == true;
    let pbr_material_sets = smart_import && v["pbrMaterialSets"] == true;
    let session = json!({"id":id,"dcc":dcc,"pid":v["pid"],"placement":placement,"maxImport":max_import,"smartImport":smart_import,"projectExport":project_export,"sceneImportOptions":scene_import,"scopedC4dPreferences":scoped_c4d_preferences,"maxTextureBindings":max_texture_bindings,"archiveTextures":archive_textures,"pbrMaterialSets":pbr_material_sets,"label":v["label"].as_str().unwrap_or(dcc).chars().take(100).collect::<String>(),"lastSeen":now()});
    s.sessions.lock().unwrap().insert(id.clone(), session);
    Ok(Json(json!({"id":id})))
}

fn session_supports_asset(session: &Value, ext: &str) -> bool {
    let dcc = session["dcc"].as_str().unwrap_or("");
    let ext = if ext.eq_ignore_ascii_case("max") {
        "max"
    } else {
        ext
    };
    compatible(dcc, ext) && (dcc != "blender" || ext != "max" || session["maxImport"] == true)
}

async fn heartbeat(
    HttpState(s): HttpState<AppState>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    auth(&s, &headers)?;
    let mut sessions = s.sessions.lock().unwrap();
    let session = sessions
        .get_mut(v["sessionId"].as_str().unwrap_or(""))
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "Session expired"))?;
    session["lastSeen"] = json!(now());
    if let Some(label) = v["label"].as_str() {
        session["label"] = json!(label.chars().take(100).collect::<String>());
    }
    Ok(Json(json!({"ok":true})))
}
async fn claim(
    HttpState(s): HttpState<AppState>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    auth(&s, &headers)?;
    let session = v["sessionId"].as_str().unwrap_or("");
    if !s.sessions.lock().unwrap().contains_key(session) {
        return Err(api_error(StatusCode::NOT_FOUND, "Session expired"));
    }
    if let Some(job) = s.placement.claim(session) {
        return Ok(Json(json!({"job":job})));
    }
    let c = lock_db(&s).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    while let Some(mut j) = c
        .next_queued_job(session)
        .map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?
    {
        if now().saturating_sub(j["created"].as_u64().unwrap_or(0)) > DCC_JOB_QUEUE_TIMEOUT {
            j["status"] = json!("failed");
            j["error"] = json!("等待超时，请重新发送");
            c.put_job(&j)
                .map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
            continue;
        }
        j["status"] = json!("running");
        j["started"] = json!(now());
        c.put_job(&j)
            .map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
        return Ok(Json(json!({"job":j})));
    }
    Ok(Json(json!({"job":null})))
}
async fn ack(
    HttpState(s): HttpState<AppState>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    auth(&s, &headers)?;
    let session = v["sessionId"].as_str().unwrap_or("");
    if !s.sessions.lock().unwrap().contains_key(session) {
        return Err(api_error(StatusCode::NOT_FOUND, "Session expired"));
    }
    let id = v["jobId"]
        .as_str()
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "Job not found"))?;
    let c = lock_db(&s).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    let mut j = c
        .session_job(session, id)
        .map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "Job not found"))?;
    if j["status"] == "running" {
        if let Some(job) = j.as_object_mut() {
            job.remove("progress");
            job.remove("progressStage");
        }
        j["status"] = json!(if v["ok"] == true { "done" } else { "failed" });
        j["error"] = json!(v["error"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(1000)
            .collect::<String>());
        if j["mode"] == "smart" && v["ok"] == true {
            j["message"] = json!(v["message"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(1000)
                .collect::<String>());
        }
        if let (Some(destination), true) = (j["projectExport"]["destination"].as_str(), v["ok"] == true) {
            let project = v["projectPath"].as_str().map(Path::new);
            let destination = Path::new(destination);
            let project = project.filter(|path| {
                path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("c4d"))
                    && path.strip_prefix(destination).ok().is_some_and(|relative| {
                        relative.components().count() == 2
                            && relative.components().all(|part| matches!(part, std::path::Component::Normal(_)))
                    })
            });
            if let Some(project) = project {
                j["projectPath"] = json!(project);
            } else {
                j["status"] = json!("failed");
                j["error"] = json!("Cinema 4D 未返回所选目录内的有效工程路径");
            }
        }
        j["finished"] = json!(now());
        c.put_job(&j)
            .map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    }
    Ok(Json(json!({"ok":true})))
}

async fn bridge_import_progress(
    HttpState(s): HttpState<AppState>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> ApiResult {
    auth(&s, &headers)?;
    let session = v["sessionId"].as_str().unwrap_or("");
    if !s.sessions.lock().unwrap().get(session).is_some_and(|item| item["sceneImportOptions"] == true) {
        return Err(api_error(StatusCode::NOT_FOUND, "Session expired"));
    }
    let id = v["jobId"].as_str().unwrap_or("");
    let stage_key = v["stage"].as_str();
    let stage = match stage_key {
        Some("preparing") => "正在检查模型与贴图",
        Some("direct-max") => "正在使用 Blender 直接解析 MAX",
        Some("application-max") => "正在调用 3ds Max Batch 转换 MAX",
        Some("blender") => "正在调用 Blender 转换工程",
        Some("importing") => "正在将模型合并到 Cinema 4D 工程",
        Some("exporting") => "正在保存 Cinema 4D 工程与贴图",
        _ => return Err(api_error(StatusCode::BAD_REQUEST, "Unknown import stage")),
    };
    let catalog = lock_db(&s).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    if let Some(mut job) = catalog.session_job(session, id)
        .map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?
        .filter(|job| job["status"] == "running" && job["mode"] == "smart")
    {
        job["progress"] = json!(stage);
        job["progressStage"] = json!(stage_key);
        catalog.put_job(&job).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Clone, Default)]
struct FolderLaunches(Arc<Mutex<VecDeque<String>>>);

impl FolderLaunches {
    fn push(&self, path: String) {
        if let Ok(mut paths) = self.0.lock() {
            if paths.back() == Some(&path) {
                return;
            }
            if paths.len() == 24 {
                paths.pop_front();
            }
            paths.push_back(path);
        }
    }

    fn pending(&self) -> bool {
        self.0.lock().is_ok_and(|paths| !paths.is_empty())
    }
}

#[tauri::command]
fn take_shell_folder_launches(
    launches: tauri::State<'_, FolderLaunches>,
) -> Result<Vec<String>, String> {
    let mut paths = launches.0.lock().map_err(|_| "无法读取待打开的文件夹")?;
    Ok(paths.drain(..).collect())
}

fn shell_folder_argument(args: &[String]) -> Option<String> {
    let [_, command, path] = args else { return None };
    (command == "--open-folder")
        .then(|| local_explorer::shell_folder_address(path))
        .flatten()
}

#[cfg(windows)]
fn configure_main_window_frame(window: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    let configured = window.hwnd().ok().is_some_and(|handle| unsafe {
        let corner = DWMWCP_ROUND;
        let border = 0x0042_403c_u32;
        DwmSetWindowAttribute(
            handle,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&corner).cast(),
            size_of_val(&corner) as u32,
        )
        .and_then(|_| {
            DwmSetWindowAttribute(
                handle,
                DWMWA_BORDER_COLOR,
                std::ptr::from_ref(&border).cast(),
                size_of_val(&border) as u32,
            )
        })
        .is_ok()
    });
    if !configured {
        let _ = window.set_shadow(false);
    }
}

#[cfg(all(test, windows))]
#[test]
fn shell_folder_argument_accepts_drive_and_unicode_paths() {
    let run = |flag: &str, path: &str| {
        shell_folder_argument(&["nexus-assets.exe".into(), flag.into(), path.into()])
    };
    assert_eq!(run("--open-folder", r"C:\\."), Some(r"C:\".into()));
    assert_eq!(
        run("--open-folder", r"D:\项目 文件夹\."),
        Some(r"D:\项目 文件夹".into())
    );
    assert_eq!(run("--open-folder", "shell:Downloads"), None);
    assert_eq!(run("--open-folder", "relative"), None);
    assert_eq!(run("--unrelated", r"C:\"), None);
}

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    #[cfg(windows)]
    if args.len() == 2 && args[1] == "--restore-system-folders" {
        let status = if folder_shell::restore_for_uninstall().is_ok() { 0 } else { 1 };
        std::process::exit(status);
    }

    let launches = FolderLaunches::default();
    if let Ok(args) = args.into_iter().map(|arg| arg.into_string()).collect::<Result<Vec<_>, _>>() {
        if let Some(path) = shell_folder_argument(&args) {
            launches.push(path);
        }
    }

    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = {
        let forwarded = launches.clone();
        builder.plugin(tauri_plugin_single_instance::init(move |app, args, _| {
            let folder = shell_folder_argument(&args);
            let requested_folder = folder.is_some();
            if let Some(path) = folder {
                forwarded.push(path);
            }
            workspace_windows::focus_after_relaunch(app, requested_folder);
        }))
    };
    let result = builder
        .manage(launches)
        .manage(workspace_windows::WorkspaceWindows::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                workspace_windows::discard_window(window.app_handle(), window.label());
            }
        })
        .setup(|app| {
            nexus_updater::register(app)?;
            // Reserve the bridge endpoint before a second instance can touch the catalog.
            let listener = std::net::TcpListener::bind(("127.0.0.1", 47821))?;
            listener.set_nonblocking(true)?;
            if !app.state::<FolderLaunches>().pending() {
                nexus_updater::install_cached_on_startup(app.handle());
            }
            let root = app.path().app_data_dir()?;
            let global_catalog = Catalog::open(&root).map_err(std::io::Error::other)?;
            let token = global_catalog.token().map_err(std::io::Error::other)?;
            app.manage(Desktop::new(&global_catalog).map_err(std::io::Error::other)?);
            app.manage(cloud_mounts::Mounts::new(&root));
            app.manage(baidu_cloud_desktop::PersonalLogins::default());
            let catalog = workspaces::open_startup_catalog(&root).map_err(std::io::Error::other)?;
            #[cfg(windows)]
            indexed_file_move::recover_on_startup(&catalog, &root);
            let state = AppState {
                db: Arc::new(Mutex::new(catalog)),
                root,
                workspace_io: Arc::new(Mutex::new(())),
                placement: placement::PlacementTickets::default(),
                sessions: Arc::new(Mutex::new(HashMap::new())),
                token,
                port: 47821,
            };
            app.manage(state.clone());
            let browser_capture = browser_capture::BrowserCapture::new(&state.root, state.port);
            app.manage(browser_capture.clone());
            let video_streams = asset_video::stream::VideoStreams::new(state.port);
            app.manage(video_streams.clone());
            workspace_windows::initialize_main(app.handle())?;
            let expiring_placements = state.placement.clone();
            let expiring_videos = video_streams.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(45));
                loop {
                    interval.tick().await;
                    expiring_placements.reap();
                    expiring_videos.reap();
                }
            });
            tauri::async_runtime::spawn(async move {
                let router = Router::new()
                    .route("/bridge/register", post(register))
                    .route("/bridge/heartbeat", post(heartbeat))
                    .route("/bridge/claim", post(claim))
                    .route("/bridge/ack", post(ack))
                    .route("/bridge/progress", post(bridge_import_progress))
                    .route("/bridge/placement/resolve", post(placement::resolve))
                    .route("/bridge/placement/finish", post(placement::finish))
                    .with_state(state)
                    .merge(video_streams.router())
                    .merge(browser_capture.router());
                if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                    if let Err(e) = axum::serve(listener, router).await {
                        eprintln!("Bridge listener failed: {e}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            catalog_health::inspect_personal_catalog_health,
            delivery_template::preview_delivery_template,
            delivery_template::create_delivery_template,
            team_network_paths::workspace_network_path,
            team_network_paths::search_network_paths,
            shot_delivery::lock_shot_preview,
            workspace_windows::open_detached_workspace_tab,
            workspace_windows::take_detached_workspace_tab,
            workspace_windows::finish_detached_workspace_tab,
            nexus_updater::check_nexus_update,
            nexus_updater::install_nexus_update,
            nexus_updater::prepare_nexus_update,
            nexus_updater::apply_prepared_nexus_update,
            get_activity,
            list_recycled_assets,
            recycle_assets,
            duplicate_review::review_asset_duplicates,
            duplicate_review::recycle_verified_duplicates,
            restore_recycled_assets,
            workspace_asset_deletion::delete_workspace_assets,
            baidu_cloud_desktop::baidu_cloud,
            baidu_cloud_desktop::baidu_open_authorization,
            subscription_feed::subscription_feed,
            subscription_feed::subscription_discover,
            subscription_feed::creative_video_reference_metadata,
            subscription_feed::site::browser_site_metadata,
            subscription_feed::subscription_profile,
            subscription_feed::xinpianchang_player,
            browser_capture::browser_capture_pairing,
            browser_capture::browser_capture_status,
            browser_capture::browser_capture_open_inbox,
            browser_capture::browser_capture_open_extension,
            browser_capture_import::browser_capture_personal_libraries,
            browser_capture_import::browser_capture_import,
            browser_extension_install::browser_extension_detect,
            browser_extension_install::browser_extension_open_install,
            asset_ai::asset_ai_models,
            asset_ai::suggest_asset_ai,
            subscription_open::subscription_open,
            team_desktop::browser_sites::team_browser_sites,
            team_desktop::browser_sites::team_save_browser_sites,
            team_desktop::asset_messages::team_send_asset_message,
            team_desktop::asset_messages::team_send_video_reference_message,
            team_desktop::asset_messages::team_send_poke,
            team_desktop::asset_messages::team_asset_messages,
            team_desktop::creative_subscriptions::team_creative_subscriptions,
            team_desktop::creative_subscriptions::team_create_creative_subscription,
            team_desktop::creative_subscriptions::team_update_creative_subscription,
            team_desktop::creative_subscriptions::team_delete_creative_subscription,
            team_desktop::creative_subscriptions::team_creative_video_references,
            team_desktop::creative_subscriptions::team_save_creative_video_reference,
            team_desktop::creative_subscriptions::team_delete_creative_video_reference,
            team_desktop::organization::team_organization,
            team_desktop::organization::team_local_organization,
            team_desktop::organization::team_set_favorite,
            team_desktop::organization::team_create_collection,
            team_desktop::organization::team_rename_collection,
            team_desktop::organization::team_delete_collection,
            team_desktop::organization::team_set_collection_membership,
            team_desktop::asset_messages::team_dismiss_asset_message,
            team_desktop::quick_access::team_quick_access,
            team_desktop::quick_access::team_set_quick_access,
            team_desktop::whiteboard::team_whiteboard_get,
            team_desktop::whiteboard::team_whiteboard_presence,
            team_desktop::whiteboard::team_whiteboard_apply,
            team_desktop::whiteboard::team_whiteboard_projects,
            team_desktop::whiteboard::team_whiteboard_create_project,
            team_desktop::whiteboard::team_whiteboard_rename_project,
            team_desktop::whiteboard::team_whiteboard_put_image,
            team_desktop::whiteboard::team_whiteboard_get_image,
            team_desktop::whiteboard::read_whiteboard_image_file,
            team_desktop::whiteboard::read_whiteboard_clipboard_files,
            team_desktop::whiteboard::team_import_whiteboard_files,
            team_desktop::whiteboard::team_reference_whiteboard_files,
            team_desktop::whiteboard::team_reveal_whiteboard_file,
            team_desktop::whiteboard::team_preview_whiteboard_file,
            team_desktop::recycle::team_list_recycled_assets,
            team_desktop::recycle::team_recycle_assets,
            team_desktop::recycle::team_restore_recycled_assets,
            team_desktop::recycle::team_delete_workspace_assets,
            c4d_import_preferences::get_c4d_import_preferences,
            c4d_import_preferences::set_c4d_import_preferences,
            c4d_import_preferences::c4d_import_cache_size,
            c4d_import_preferences::clear_c4d_import_cache,
            c4d_import_preferences::pick_c4d_converter,
            scan_library,
            scan_workspace_folder,
            scan_selected_libraries,
            patch_asset,
            pick_folder,
            pick_asset_folders,
            folder_browser::list_import_folders,
            local_explorer::list_local_files,
            local_explorer::paths::local_explorer_check_folder_paths,
            local_explorer::local_explorer_tree_children,
            local_explorer_new::local_explorer_new_templates,
            local_explorer_new::local_explorer_create_item,
            local_explorer::local_explorer_selection,
            local_explorer_details::local_explorer_entry_details,
            local_explorer::local_explorer_places,
            desktop_shortcut::create_desktop_shortcut,
            local_explorer::local_explorer_drive_details,
            local_explorer_drop::local_explorer_drop_files,
            local_explorer_drop::local_explorer_file_action,
            indexed_file_move::move_indexed_local_files,
            indexed_file_move::indexed_file_move_recovery_status,
            indexed_file_move::recover_indexed_local_file_moves,
            local_explorer_clipboard::local_explorer_clipboard,
            local_explorer_paste::local_explorer_preview_paste,
            local_explorer_paste::local_explorer_resolve_paste,
            thumbnail_desktop::local_explorer_thumbnail,
            thumbnail_desktop::local_explorer_folder_thumbnail,
            thumbnail_desktop::local_explorer_file_icon,
            asset_catalog_export::export_offline_asset_catalog,
            local_explorer::open_local_file,
            local_explorer::reveal_local_file,
            take_shell_folder_launches,
            folder_shell::folder_shell_status,
            folder_shell::enable_folder_shell,
            folder_shell::restore_folder_shell,
            folder_deletion::delete_workspace_folder,
            cloud_mounts::cloud_mount_list,
            cloud_mounts::cloud_mount_remotes,
            cloud_mounts::cloud_mount_connect,
            cloud_mounts::cloud_mount_disconnect,
            cloud_mounts::cloud_mount_forget,
            library_visibility::set_library_folder_hidden,
            open_folder_location,
            import_files,
            pick_asset_files,
            read_preview,
            format_help::query_format_capabilities,
            exr_channel_desktop::read_exr_channel_view,
            thumbnail_desktop::build_thumbnail_cache,
            thumbnail_desktop::store_model_thumbnail,
            thumbnail_desktop::store_video_thumbnail,
            reveal_asset,
            asset_video::asset_video_source,
            asset_video::generate_system_video_thumbnail,
            asset_video::open_asset_video,
            native_drag::start_asset_drag,
            native_drag::start_local_file_drag,
            native_drag::wait_asset_drag_exit,
            drop_ingest::ingest_drop,
            asset_files::copy_asset_files,
            asset_versions::list_asset_versions,
            asset_versions::create_asset_version,
            asset_versions::export_asset_version,
            asset_availability::check_asset_files,
            asset_availability::suggest_asset_relinks,
            asset_availability::relink_asset_file,
            project_cleanup::inspect_project_cleanup,
            project_dependencies::inspect_project_dependencies,
            project_dependencies::pick_project_dependency_file,
            project_dependencies::repair::suggest_project_dependency_replacements,
            project_dependencies::repair::preview_project_dependency_replacement,
            project_dependencies::write_project_dependency_copy,
            render_sequences::inspect_render_sequences,
            render_sequences::render_sequence_frame_sizes,
            thumbnail_desktop::render_sequence_frame_preview,
            asset_cover::change_asset_cover,
            asset_cover::set_clipboard_cover,
            asset_cover::start_cover_capture,
            export_bridge,
            bridge_install::bridge_install_status,
            bridge_install::choose_bridge_executable,
            bridge_install::install_bridge,
            bridge_install::sync_bridges,
            workspaces::personal_workspaces,
            workspaces::change_personal_workspace,
            workspace_files::create_library_folder,
            workspace_files::check_workspace_files,
            workspace_files::copy_workspace_files,
            workspace_folder_move::move_library_folder,
            queue_import,
            collection_desktop::list_collections,
            collection_desktop::create_collection,
            collection_desktop::rename_collection,
            collection_desktop::delete_collection,
            collection_desktop::set_collection_membership,
            personal_tags::create_local_tag,
            personal_tags::rename_local_tag,
            personal_tags::delete_local_tag,
            team_desktop::team_status,
            team_desktop::team_service_info,
            team_update_version::latest_team_service_version,
            team_desktop::team_online_members,
            team_desktop::team_get_profile,
            team_desktop::team_save_profile,
            team_desktop::team_rename_workspace,
            team_desktop::team_member_avatar,
            team_desktop::team_create_tag,
            team_desktop::team_rename_tag,
            team_desktop::team_delete_tag,
            team_avatar_picker::team_pick_avatar,
            team_covers::team_cover_revisions,
            team_host::create_hosted_team,
            team_host::start_hosted_team,
            team_host::hosted_team_status,
            team_nas::export_team_for_nas,
            team_desktop::team_connect,
            team_desktop::team_join_by_address,
            team_desktop::team_reconnect_nas,
            team_desktop::team_disconnect,
            team_desktop::team_cached_catalog,
            team_desktop::team_catalog,
            team_desktop::team_set_folder_visibility,
            team_desktop::team_set_mount,
            team_desktop::team_link_folders,
            team_desktop::classify_team_drop,
            team_desktop::team_import_paths,
            team_desktop::team_unlink_folder,
            team_desktop::team_create_folder,
            team_desktop::team_move_folder,
            team_desktop::team_refresh_library,
            team_desktop::team_rescan_folder,
            team_desktop::team_publish,
            team_desktop::team_edit,
            team_desktop::team_favorite
        ])
        .build(tauri::generate_context!())
        .map(|app| {
            app.run(|handle, event| {
                if matches!(event, tauri::RunEvent::Exit) {
                    handle
                        .state::<cloud_mounts::Mounts>()
                        .stop_owned_processes();
                }
            })
        });
    if let Err(e) = result {
        rfd::MessageDialog::new()
            .set_title("Nexus 启动失败")
            .set_description(format!("无法启动资产工作台。请检查本地端口 47821 是否已被占用，或 WebView2 是否已安装。\n\n{}", e))
            .set_level(rfd::MessageLevel::Error)
            .show();
    }
}

#[cfg(test)]
mod bridge_tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, AppState, HeaderMap) {
        let dir = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(dir.path()).unwrap();
        let token = catalog.token().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {}", token).parse().unwrap(),
        );
        let state = AppState {
            db: Arc::new(Mutex::new(catalog)),
            root: dir.path().to_path_buf(),
            workspace_io: Arc::new(Mutex::new(())),
            placement: placement::PlacementTickets::default(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            token,
            port: 47821,
        };
        (dir, state, headers)
    }
    #[test]
    fn bridge_rejects_missing_token_and_browser_origin() {
        let (_dir, state, headers) = setup();
        assert!(auth(&state, &HeaderMap::new()).is_err());
        assert!(auth(&state, &headers).is_ok());
        let mut browser = headers.clone();
        browser.insert("origin", "http://evil.example".parse().unwrap());
        assert!(auth(&state, &browser).is_err());
    }
    #[test]
    fn folder_batch_preserves_roots_and_does_not_index_a_selected_child_twice() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("资产一");
        let second = dir.path().join("资产二");
        let deep = first.join("文件夹").join("空目录");
        fs::create_dir_all(&deep).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("model.obj"), "v 0 0 0").unwrap();
        let mut catalog = Catalog::open(&dir.path().join("database")).unwrap();
        let result = scan_selected_folders(
            &mut catalog,
            vec![deep, first.clone(), second, first],
            None,
            "local",
            |_| {},
        );
        assert_eq!(result["found"], 1);
        assert_eq!(result["errors"].as_array().unwrap().len(), 0);
        let libraries = result["libraries"].as_array().unwrap();
        assert_eq!(libraries.len(), 2);
        assert!(libraries.iter().any(|library| library["folders"]
            .as_array()
            .is_some_and(|folders| folders.contains(&json!("文件夹/空目录")))));
    }
    #[test]
    fn blender_max_import_requires_capability_from_the_target_bridge() {
        tauri::async_runtime::block_on(async {
            let (_dir, state, headers) = setup();
            for (client, max_ready) in [
                (json!({"dcc":"blender","pid":2,"placement":true}), false),
                (json!({"dcc":"blender","pid":3,"placement":true,"maxImport":true}), true),
            ] {
                let Json(response) = register(HttpState(state.clone()), headers.clone(), Json(client))
                    .await
                    .unwrap();
                let sessions = state.sessions.lock().unwrap();
                let blender = &sessions[response["id"].as_str().unwrap()];
                assert!(session_supports_asset(blender, "obj"));
                assert_eq!(session_supports_asset(blender, "MAX"), max_ready);
            }
        });
    }
    #[test]
    fn jobs_are_claimed_once_and_receipts_are_bound_to_session() {
        tauri::async_runtime::block_on(async {
            let (_dir, state, headers) = setup();
            let s = register(
                HttpState(state.clone()),
                headers.clone(),
                Json(json!({"dcc":"blender","pid":1})),
            )
            .await
            .unwrap()
            .0;
            let session = s["id"].as_str().unwrap().to_string();
            let other = register(
                HttpState(state.clone()),
                headers.clone(),
                Json(json!({"dcc":"c4d","pid":2})),
            )
            .await
            .unwrap()
            .0;
            let j = json!({"id":"test-job","sessionId":session,"status":"queued","created":now(),"name":"测试资产"});
            state.db.lock().unwrap().put_job(&j).unwrap();
            let payload = json!({"sessionId":session});
            let first = claim(
                HttpState(state.clone()),
                headers.clone(),
                Json(payload.clone()),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(first["job"]["status"], "running");
            let second = claim(HttpState(state.clone()), headers.clone(), Json(payload))
                .await
                .unwrap()
                .0;
            assert!(second["job"].is_null());
            let wrong = ack(
                HttpState(state.clone()),
                headers.clone(),
                Json(json!({"sessionId":other["id"],"jobId":"test-job","ok":true})),
            )
            .await;
            assert!(wrong.is_err());
            let _ = ack(
                HttpState(state.clone()),
                headers.clone(),
                Json(json!({"sessionId":session,"jobId":"test-job","ok":true})),
            )
            .await
            .unwrap();
            assert_eq!(
                state.db.lock().unwrap().jobs().unwrap()[0]["status"],
                "done"
            );
            let _ = ack(HttpState(state.clone()),headers,Json(json!({"sessionId":session,"jobId":"test-job","ok":false,"error":"late duplicate"}))).await.unwrap();
            assert_eq!(
                state.db.lock().unwrap().jobs().unwrap()[0]["status"],
                "done"
            );
        });
    }

    #[test]
    fn jobs_are_claimed_in_order_beyond_the_activity_limit() {
        tauri::async_runtime::block_on(async {
            let (_dir, state, headers) = setup();
            let registered = register(
                HttpState(state.clone()),
                headers.clone(),
                Json(json!({"dcc":"blender","pid":1})),
            )
            .await
            .unwrap()
            .0;
            let session = registered["id"].as_str().unwrap();
            let created = now();
            {
                let catalog = state.db.lock().unwrap();
                for (id, created) in [
                    ("expired", created.saturating_sub(121)),
                    ("first", created),
                    ("second", created),
                ] {
                    catalog
                        .put_job(&json!({"id":id,"sessionId":session,"status":"queued","created":created}))
                        .unwrap();
                }
                for index in 0..101 {
                    catalog
                        .put_job(&json!({"id":format!("other-{index}"),"sessionId":"other-session","status":"queued","created":created}))
                        .unwrap();
                }
                let activity = catalog.jobs().unwrap();
                assert_eq!(activity.len(), 100);
                assert!(activity
                    .iter()
                    .all(|job| job["sessionId"] == "other-session"));
            }

            for id in ["first", "second"] {
                let claimed = claim(
                    HttpState(state.clone()),
                    headers.clone(),
                    Json(json!({"sessionId":session})),
                )
                .await
                .unwrap()
                .0;
                assert_eq!(claimed["job"]["id"], id);
                assert_eq!(claimed["job"]["status"], "running");
                let receipt = ack(
                    HttpState(state.clone()),
                    headers.clone(),
                    Json(json!({"sessionId":session,"jobId":id,"ok":true})),
                )
                .await
                .unwrap()
                .0;
                assert_eq!(receipt["ok"], true);
            }

            let catalog = state.db.lock().unwrap();
            for (id, status) in [("expired", "failed"), ("first", "done"), ("second", "done")] {
                assert_eq!(
                    catalog.session_job(session, id).unwrap().unwrap()["status"],
                    status
                );
            }
        });
    }

    #[test]
    fn cinema_import_progress_is_bound_to_running_smart_jobs() {
        tauri::async_runtime::block_on(async {
            let (_dir, state, headers) = setup();
            let bridge = json!({"dcc":"c4d","pid":2,"smartImport":true,"sceneImportOptions":true});
            let registered = register(HttpState(state.clone()), headers.clone(), Json(bridge.clone()))
                .await.unwrap().0;
            let other = register(HttpState(state.clone()), headers.clone(), Json(bridge))
                .await.unwrap().0;
            let session = registered["id"].as_str().unwrap();
            let job_id = "progress-test";
            let job = json!({"id":job_id,"sessionId":session,"mode":"smart","status":"running","created":now()});
            state.db.lock().unwrap().put_job(&job).unwrap();
            let progress = |owner: &Value| json!({"sessionId":owner["id"],"jobId":job_id,"stage":"direct-max"});
            let _ = bridge_import_progress(HttpState(state.clone()), headers.clone(), Json(progress(&other)))
                .await.unwrap();
            assert!(state.db.lock().unwrap().session_job(session, job_id).unwrap().unwrap()["progress"].is_null());
            let _ = bridge_import_progress(HttpState(state.clone()), headers.clone(), Json(progress(&registered)))
                .await.unwrap();
            let running = state.db.lock().unwrap().session_job(session, job_id).unwrap().unwrap();
            assert_eq!(running["progress"], "正在使用 Blender 直接解析 MAX");
            let _ = ack(HttpState(state.clone()), headers.clone(), Json(json!({"sessionId":session,"jobId":job_id,"ok":true})))
                .await.unwrap();
            let _ = bridge_import_progress(HttpState(state.clone()), headers, Json(progress(&registered)))
                .await.unwrap();
            let done = state.db.lock().unwrap().session_job(session, job_id).unwrap().unwrap();
            assert_eq!(done["status"], "done");
            assert!(done["progress"].is_null());
        });
    }
}
