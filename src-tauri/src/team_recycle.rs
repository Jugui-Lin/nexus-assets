use super::{
    watched_target, ActiveConnection, ConnectionIdentity, Desktop, Method, StatusCode, Workspace,
};
use crate::{
    folder_deletion::{canonical_directory, protected_data_roots},
    workspaces::lock_io,
    AppState,
};
use nexus_core::{clean_path, team::relative_path};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeSet, path::PathBuf};
use uuid::Uuid;

const RECYCLE_ROUTE: &str = "/v1/recycle/assets";
const RESTORE_ROUTE: &str = "/v1/recycle/assets/restore";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecycledAsset {
    id: String,
    name: String,
    path: String,
    recycled_at: u64,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Changed {
    changed: usize,
}

fn selected_team(state: &Desktop, team_id: &str) -> Result<ActiveConnection, String> {
    let active = state.active_connection()?;
    if active.identity.team_id != team_id {
        return Err("团队工作空间已切换，请重新打开回收站".into());
    }
    Ok(active)
}

async fn recycle_request<T: DeserializeOwned>(
    state: &Desktop,
    active: &ActiveConnection,
    method: Method,
    route: &str,
    body: Option<Vec<u8>>,
) -> Result<T, String> {
    let request = state.authenticated_request(&active.config, method, route, body);
    let response = Desktop::send(request).await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err("当前 NAS 团队服务尚不支持回收站，请更新团队服务".into());
    }
    let result = Desktop::decode_response(response).await?;
    if state.active_connection()? != *active {
        return Err("团队工作空间已切换，请重新打开回收站".into());
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn team_list_recycled_assets(
    state: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<Vec<RecycledAsset>, String> {
    let active = selected_team(&state, &team_id)?;
    let mut entries: Vec<RecycledAsset> =
        recycle_request(&state, &active, Method::GET, RECYCLE_ROUTE, None).await?;
    for asset in &mut entries {
        let id = Uuid::parse_str(&asset.id).map_err(|_| "回收站资产编号无效")?;
        asset.id = format!("team:{id}");
    }
    Ok(entries)
}

fn team_selection(ids: &[String]) -> Result<Vec<String>, String> {
    if ids.is_empty() || ids.len() > 500 {
        return Err("请选择 1 至 500 项团队资产".into());
    }
    ids.iter()
        .map(|id| {
            id.strip_prefix("team:")
                .and_then(|id| Uuid::parse_str(id).ok())
                .map(|id| id.to_string())
                .ok_or_else(|| "只能操作当前团队库中的资产".into())
        })
        .collect()
}

async fn update(
    state: &Desktop,
    team_id: &str,
    ids: Vec<String>,
    route: &str,
) -> Result<Changed, String> {
    let ids = team_selection(&ids)?;
    let body = serde_json::to_vec(&json!({"ids": ids})).map_err(|error| error.to_string())?;
    let _operation = state.begin_storage_operation()?;
    let active = selected_team(state, team_id)?;
    let identity: ConnectionIdentity = state
        .request(&active.config, Method::GET, "/v1/info", None)
        .await?;
    if identity != active.identity || state.active_connection()? != active {
        return Err("团队工作空间已切换，请重新打开回收站".into());
    }
    recycle_request(state, &active, Method::POST, route, Some(body)).await
}

#[tauri::command]
pub(crate) async fn team_recycle_assets(
    state: tauri::State<'_, Desktop>,
    team_id: String,
    ids: Vec<String>,
) -> Result<Changed, String> {
    update(&state, &team_id, ids, RECYCLE_ROUTE).await
}

#[tauri::command]
pub(crate) async fn team_restore_recycled_assets(
    state: tauri::State<'_, Desktop>,
    team_id: String,
    ids: Vec<String>,
) -> Result<Changed, String> {
    update(&state, &team_id, ids, RESTORE_ROUTE).await
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteReport {
    deleted: usize,
    missing: usize,
    failed: usize,
    deleted_ids: Vec<String>,
    errors: Vec<String>,
    index_pending: bool,
}

#[derive(PartialEq, Eq)]
struct DeleteItem {
    library_id: String,
    storage_library_id: Option<String>,
    storage_folder: Option<String>,
    mount: PathBuf,
    relative: PathBuf,
    size: u64,
    modified: u64,
}

fn delete_item(data: &Workspace, team_id: &str, id: &str) -> Result<DeleteItem, String> {
    let asset = data
        .cache
        .as_ref()
        .and_then(|cache| cache.asset(id))
        .ok_or("只能删除当前已索引且可见的团队资产")?;
    let relative = relative_path(&asset.relative_path).ok_or("团队资产路径无效")?;
    crate::team_import::share_path(&relative)?;
    let folder = asset
        .relative_path
        .rsplit_once('/')
        .map_or("", |(folder, _)| folder);
    let (_, _, mount) = watched_target(data, team_id, &asset.library_id, Some(folder))?;
    Ok(DeleteItem {
        library_id: asset.library_id.clone(),
        storage_library_id: asset.storage_library_id.clone(),
        storage_folder: asset.storage_folder.clone(),
        mount: mount.ok_or("请先为团队库设置本机挂载目录")?,
        relative,
        size: asset.size,
        modified: asset.modified,
    })
}

impl DeleteReport {
    fn add_error(&mut self, label: &str, error: &str) {
        if self.errors.len() < 100 {
            self.errors.push(format!("{label}：{error}"));
        }
    }

    fn fail(&mut self, label: &str, error: &str) {
        self.failed += 1;
        self.add_error(label, error);
    }
}

fn delete_files(
    items: Vec<(String, DeleteItem)>,
    data_roots: &[PathBuf],
    report: &mut DeleteReport,
) -> BTreeSet<String> {
    use crate::workspace_asset_deletion::{delete_checked_file, DiskRemoval, IndexedMtime};

    let mut changed = BTreeSet::new();
    for (id, item) in items {
        let mount = match canonical_directory(&item.mount) {
            Ok(mount) => mount,
            Err(error) => {
                report.fail(&clean_path(&item.mount.join(&item.relative)), &error);
                continue;
            }
        };
        let path = mount.join(&item.relative);
        match delete_checked_file(
            &path,
            Some(&mount),
            item.size,
            IndexedMtime::Milliseconds(item.modified),
            data_roots,
        ) {
            Ok(outcome) => {
                match outcome {
                    DiskRemoval::Deleted => report.deleted += 1,
                    DiskRemoval::Missing => report.missing += 1,
                }
                report.deleted_ids.push(format!("team:{id}"));
                changed.insert(item.library_id);
            }
            Err(error) => report.fail(&clean_path(&path), &error),
        }
    }
    changed
}

async fn delete_indexed_assets(
    desktop: &Desktop,
    state: AppState,
    team_id: &str,
    ids: Vec<String>,
) -> Result<DeleteReport, String> {
    let mut ids = team_selection(&ids)?;
    ids.sort_unstable();
    ids.dedup();
    let _operation = desktop.begin_storage_operation()?;
    let active = desktop.connection_for_team(team_id)?;
    let (revision, selection) = {
        let data = desktop.data.lock().unwrap();
        let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
        let items = ids
            .into_iter()
            .map(|id| {
                let item = delete_item(&data, team_id, &id);
                (id, item)
            })
            .collect::<Vec<_>>();
        (cached.revision, items)
    };
    desktop.synchronize_catalog(Some(revision)).await?;
    let mut report = DeleteReport::default();
    let items = {
        let data = desktop.data.lock().unwrap();
        if data.active_connection()? != active {
            return Err("团队连接已切换，请重新选择资产".into());
        }
        selection
            .into_iter()
            .filter_map(|(id, original)| match original {
                Ok(original)
                    if delete_item(&data, team_id, &id)
                        .is_ok_and(|updated| updated == original) =>
                {
                    Some((id, original))
                }
                Ok(original) => {
                    report.fail(
                        &clean_path(&original.relative),
                        "资产路径、内容或挂载已变更，请重新选择",
                    );
                    None
                }
                Err(error) => {
                    report.fail(&id, &error);
                    None
                }
            })
            .collect::<Vec<_>>()
    };
    if items.is_empty() {
        return Ok(report);
    }
    let (mut report, changed) = tauri::async_runtime::spawn_blocking(move || {
        let _workspace = lock_io(&state)?;
        let changed = delete_files(items, &protected_data_roots(&state)?, &mut report);
        Ok::<_, String>((report, changed))
    })
    .await
    .map_err(|error| error.to_string())??;
    for library_id in changed {
        if let Err(error) = desktop
            .refresh_watched_library(&active.config, &library_id)
            .await
        {
            report.index_pending = true;
            report.add_error("团队索引待同步", &error);
        }
    }
    Ok(report)
}

#[tauri::command]
pub(crate) async fn team_delete_workspace_assets(
    desktop: tauri::State<'_, Desktop>,
    state: tauri::State<'_, AppState>,
    team_id: String,
    ids: Vec<String>,
) -> Result<DeleteReport, String> {
    delete_indexed_assets(&desktop, state.inner().clone(), &team_id, ids).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_desktop::{cache_from, Connection};
    use axum::{
        http::HeaderMap,
        routing::{get, post},
        Json, Router,
    };
    use nexus_core::Catalog;
    use serde_json::Value;
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Mutex},
        time::UNIX_EPOCH,
    };

    #[test]
    fn team_disk_delete_rechecks_the_selected_index_and_refreshes_after_success() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let data_root = temp.path().join("app");
            let catalog = Catalog::open(&data_root).unwrap();
            let desktop = Desktop::new(&catalog).unwrap();
            let state = AppState {
                db: Arc::new(Mutex::new(catalog)),
                root: data_root.clone(),
                workspace_io: Default::default(),
                placement: Default::default(),
                sessions: Default::default(),
                token: String::new(),
                port: 0,
            };
            let library = Uuid::new_v4().to_string();
            let valid_id = Uuid::new_v4().to_string();
            let moved_id = Uuid::new_v4().to_string();
            let changed_id = Uuid::new_v4().to_string();
            let missing_id = Uuid::new_v4().to_string();
            let mount = temp.path().join("fixture-share");
            fs::create_dir(&mount).unwrap();
            let valid = mount.join("valid.png");
            let stale = mount.join("original.png");
            let replacement = mount.join("moved.png");
            let changed = mount.join("changed.png");
            for file in [&valid, &stale, &replacement, &changed] {
                fs::write(file, b"fixture").unwrap();
            }
            let asset = |id: &str, path: &str| {
                let meta = fs::metadata(mount.join(path)).unwrap();
                json!({"id":id,"libraryId":library,"relativePath":path,"name":path,"ext":"png","kind":"image",
                    "size":meta.len(),"modified":meta.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64,
                    "added":0,"tags":[],"notes":"","revision":1,"editedBy":"Fixture"})
            };
            let valid_asset = asset(&valid_id, "valid.png");
            let mut missing_asset = valid_asset.clone();
            missing_asset["id"] = json!(missing_id);
            missing_asset["relativePath"] = json!("missing.png");
            let initial_assets = [
                valid_asset, asset(&moved_id, "original.png"), asset(&changed_id, "changed.png"), missing_asset,
            ];
            let updated_assets = [
                initial_assets[0].clone(), asset(&moved_id, "moved.png"), initial_assets[2].clone(), initial_assets[3].clone(),
            ];
            fs::write(&changed, b"changed fixture contents").unwrap();
            let snapshot = |revision, assets: [Value; 4]| json!({
                "team":{"id":"team","name":"测试团队"},"member":{"id":"member","name":"测试成员","role":"member"},
                "revision":revision,"folderVisibility":true,"memberFolderVisibility":true,
                "catalog":{"libraries":[{"id":library,"name":"测试库","watching":true}],"assets":assets}
            });
            let refreshed = snapshot(2, updated_assets);
            let token = "ab".repeat(32);
            let expected_header = format!("Bearer {token}");
            let app = Router::new()
                .route("/v1/catalog/1", get(move |headers: HeaderMap| {
                    assert_eq!(headers["authorization"].to_str().unwrap(), expected_header);
                    let refreshed = refreshed.clone();
                    async { Json(refreshed) }
                }))
                .route(&format!("/v1/libraries/{library}/refresh"), post({
                    let valid = valid.clone();
                    move || {
                        assert!(!valid.exists());
                        async { (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"Fixture index unavailable"}))) }
                    }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let cached = cache_from(serde_json::from_value(snapshot(1, initial_assets)).unwrap()).unwrap();
            desktop.save_connection(Connection { url, token, allow_lan_http: false }, cached).unwrap();
            desktop.data.lock().unwrap().prefs.mounts.insert(
                "team".into(), HashMap::from([(library, clean_path(&mount))]),
            );
            let ids = [&valid_id, &moved_id, &changed_id, &missing_id].into_iter().map(|id| format!("team:{id}")).collect();
            let result = delete_indexed_assets(&desktop, state, "team", ids).await.unwrap();
            assert_eq!((result.deleted, result.missing, result.failed), (1, 1, 2));
            let mut resolved_ids = [format!("team:{valid_id}"), format!("team:{missing_id}")];
            resolved_ids.sort_unstable();
            assert_eq!(result.deleted_ids, resolved_ids);
            assert!(result.index_pending);
            assert!(!valid.exists());
            assert!(stale.exists() && replacement.exists() && changed.exists());
            assert!(data_root.join("nexus.sqlite3").exists());
        });
    }
}
