use crate::{
    asset_availability::{check_items, check_paths, AvailabilityReport, CheckItem},
    asset_files::{copy_asset_files, CopyReport},
    library_visibility::folder_is_hidden,
    lock_db,
    team_desktop::Desktop,
    team_import::{create_team_folder, mounted_folder, share_path},
    workspaces::lock_io,
    AppState,
};
use nexus_core::clean_path;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use tauri::{State, WebviewWindow};

#[tauri::command]
pub(crate) async fn create_library_folder(
    state: State<'_, AppState>,
    library_id: String,
    folder: String,
    name: String,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = lock_io(&state)?;
        let root = {
            let catalog = lock_db(&state)?;
            let child = if folder.is_empty() {
                name.clone()
            } else {
                format!("{folder}/{name}")
            };
            if folder_is_hidden(&catalog, &library_id, &child)? {
                return Err("目标文件夹已从个人资产库移除".into());
            }
            catalog
                .libraries()?
                .into_iter()
                .find(|library| library["id"].as_str() == Some(library_id.as_str()))
                .and_then(|library| library["path"].as_str().map(PathBuf::from))
                .filter(|path| path.is_absolute())
                .ok_or("请选择已添加的个人库文件夹")?
        };
        let created = create_team_folder(&root, &folder, &name)?;
        lock_db(&state)?
            .store_library_folders(&library_id, std::slice::from_ref(&created), false)
            .map_err(|error| format!("物理文件夹已新建，但更新索引失败：{error}"))?;
        Ok(json!({"folder": created}))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn check_workspace_files(
    state: State<'_, AppState>,
    team: State<'_, Desktop>,
    ids: Vec<String>,
) -> Result<AvailabilityReport, String> {
    let mut seen = HashSet::new();
    let (shared, personal): (Vec<_>, Vec<_>) = ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .partition(|id| id.starts_with("team:"));
    let mut mapped = team.mapped_workspace_files(&shared);
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut items = if personal.is_empty() {
            Vec::new()
        } else {
            check_items(&*lock_db(&state)?, personal)?
        };
        items.extend(shared.into_iter().map(|id| {
            let file = mapped
                .remove(&id)
                .map(|(root, relative)| (root.join(relative), root));
            CheckItem::mapped(id, file)
        }));
        Ok(check_paths(items))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn copy_workspace_files(
    state: State<'_, AppState>,
    team: State<'_, Desktop>,
    window: WebviewWindow,
    ids: Vec<String>,
) -> Result<Option<CopyReport>, String> {
    if ids.iter().all(|id| !id.starts_with("team:")) {
        return copy_asset_files(state, window, ids).await;
    }
    if ids.iter().any(|id| !id.starts_with("team:")) {
        return Err("请从同一个工作空间选择要复制的资产".into());
    }
    team.copy_workspace_files(window, ids).await
}

type CopyDestination = (PathBuf, Option<(String, String)>);

pub(crate) fn pick_team_copy_folder(
    window: WebviewWindow,
    mounts: HashMap<String, String>,
) -> Result<Option<CopyDestination>, String> {
    let Some(folder) = rfd::FileDialog::new()
        .set_parent(&window)
        .set_title("选择资产复制到的文件夹")
        .pick_folder()
    else {
        return Ok(None);
    };
    let folder = std::fs::canonicalize(&folder)
        .map_err(|error| format!("无法打开目标文件夹（{}）：{error}", clean_path(&folder)))?;
    let matched = match_copy_destination(&folder, mounts)?;
    Ok(Some((folder, matched)))
}

fn match_copy_destination(
    folder: &Path,
    mounts: HashMap<String, String>,
) -> Result<Option<(String, String)>, String> {
    mounts
        .into_iter()
        .filter_map(|(id, mount)| mounted_folder(Path::new(&mount), folder).map(|path| (id, path)))
        .min_by(|(left_id, left_path), (right_id, right_path)| {
            left_path
                .components()
                .count()
                .cmp(&right_path.components().count())
                .then_with(|| left_id.cmp(right_id))
        })
        .map(|(id, path)| share_path(&path).map(|relative| (id, relative)))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolves_team_copy_to_the_most_specific_mount_and_rejects_internal_folders() {
        let scratch = tempfile::tempdir().unwrap();
        let library = scratch.path().join("团队");
        let nested = library.join("模型");
        let target = nested.join("新素材");
        let private = nested.join(".nexus");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir(&private).unwrap();
        let mounts = HashMap::from([
            ("outer".to_owned(), clean_path(&library)),
            ("inner".to_owned(), clean_path(&nested)),
        ]);
        assert_eq!(
            match_copy_destination(&fs::canonicalize(target).unwrap(), mounts.clone()).unwrap(),
            Some(("inner".into(), "新素材".into())),
        );
        assert!(
            match_copy_destination(&fs::canonicalize(private).unwrap(), mounts.clone()).is_err()
        );
        assert_eq!(
            match_copy_destination(&fs::canonicalize(scratch.path()).unwrap(), mounts).unwrap(),
            None,
        );
    }
}
