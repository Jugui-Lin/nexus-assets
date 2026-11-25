use crate::{lock_db, AppState};
use nexus_core::{AssetCollection, Catalog};

fn with_collection_db<T>(
    state: &AppState,
    scope: &str,
    action: impl FnOnce(&mut Catalog) -> Result<T, String>,
) -> Result<T, String> {
    let mut active = lock_db(state)?;
    if scope.starts_with("team:") && active.dir != state.root {
        drop(active);
        action(&mut Catalog::open(&state.root)?)
    } else {
        action(&mut active)
    }
}

#[tauri::command]
pub(super) async fn list_collections(
    state: tauri::State<'_, AppState>,
    scope: String,
) -> Result<Vec<AssetCollection>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_collection_db(&state, &scope, |catalog| catalog.list_collections(&scope))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(super) async fn create_collection(
    state: tauri::State<'_, AppState>,
    scope: String,
    name: String,
) -> Result<AssetCollection, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_collection_db(&state, &scope, |catalog| {
            catalog.create_collection(&scope, &name)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(super) async fn rename_collection(
    state: tauri::State<'_, AppState>,
    scope: String,
    id: String,
    name: String,
) -> Result<AssetCollection, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_collection_db(&state, &scope, |catalog| {
            catalog.rename_collection(&scope, &id, &name)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(super) async fn delete_collection(
    state: tauri::State<'_, AppState>,
    scope: String,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_collection_db(&state, &scope, |catalog| {
            catalog.delete_collection(&scope, &id)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(super) async fn set_collection_membership(
    state: tauri::State<'_, AppState>,
    scope: String,
    id: String,
    asset_ids: Vec<String>,
    include: bool,
) -> Result<AssetCollection, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_collection_db(&state, &scope, |catalog| {
            catalog.set_collection_membership(&scope, &id, &asset_ids, include)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
