use crate::{
    library_visibility::folder_is_hidden,
    lock_db,
    team_desktop::Desktop,
    team_import,
    workspaces::{lock_io, registered_data_roots},
    AppState,
};
use nexus_core::{clean_path, team::relative_path, Catalog};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    fs::{self, Metadata},
    path::{Component, Path, PathBuf},
};
use tauri::State;
use walkdir::WalkDir;

pub(crate) fn inside_folder(parent: &str, child: &str) -> bool {
    let (parent, child) = if cfg!(windows) {
        (parent.to_lowercase(), child.to_lowercase())
    } else {
        (parent.to_owned(), child.to_owned())
    };
    parent.is_empty()
        || parent == child
        || child
            .strip_prefix(&parent)
            .is_some_and(|tail| tail.starts_with('/'))
}

pub(crate) fn path_key(path: &Path) -> PathBuf {
    let path = clean_path(path);
    if cfg!(windows) {
        path.to_lowercase().into()
    } else {
        path.into()
    }
}

pub(crate) fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

pub(crate) fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("目标必须是已登记的完整文件夹路径".into());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)
                | Prefix::UNC(..) | Prefix::VerbatimUNC(..)))
        {
            return Err("目标必须位于磁盘或 NAS 共享目录".into());
        }
    }
    for part in path.ancestors().filter(|part| part.is_absolute()) {
        let metadata = fs::symlink_metadata(part)
            .map_err(|error| format!("无法访问文件夹或其上级目录：{error}"))?;
        if !metadata.is_dir() || is_link(&metadata) {
            return Err("此路径包含符号链接、目录联接或挂载点".into());
        }
    }
    fs::canonicalize(path).map_err(|error| format!("无法确定实际文件夹目录：{error}"))
}

pub(crate) fn protected_name(name: &str) -> bool {
    [".nexus", "nexus.sqlite3", "team.sqlite3"]
        .iter()
        .any(|protected| name.eq_ignore_ascii_case(protected))
}

pub(crate) fn protected_data_roots(state: &AppState) -> Result<Vec<PathBuf>, String> {
    let mut roots = registered_data_roots(&state.root)?;
    roots.push(state.root.clone());
    roots.push(lock_db(state)?.dir.clone());
    Ok(roots)
}

fn overlaps(target: &Path, other: &Path, protect_children: bool) -> bool {
    let target_key = path_key(target);
    let overlaps = |other: &Path| {
        let other_key = path_key(other);
        other_key.starts_with(&target_key)
            || (protect_children && target_key.starts_with(other_key))
    };
    overlaps(other)
        || fs::canonicalize(other).is_ok_and(|canonical| {
            overlaps(&canonical)
                || team_import::mounted_folder(target, &canonical).is_some()
                || (protect_children && team_import::mounted_folder(&canonical, target).is_some())
        })
}

pub(crate) fn delete_indexed_directory(
    root: &Path,
    folder: &str,
    data_roots: &[PathBuf],
    other_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let relative = if folder.is_empty() {
        PathBuf::new()
    } else {
        relative_path(folder).ok_or("文件夹路径无效")?
    };
    team_import::share_path(&relative)?;
    let root = canonical_directory(root)?;
    let target = canonical_directory(&root.join(&relative))?;
    if target.file_name().is_none()
        || !path_key(&target).starts_with(path_key(&root))
        || (!folder.is_empty() && path_key(&target) == path_key(&root))
    {
        return Err("磁盘根目录、NAS 共享根目录或资产库外的目录不可删除".into());
    }
    if target
        .components()
        .any(|part| protected_name(&part.as_os_str().to_string_lossy()))
        || data_roots.iter().any(|path| overlaps(&target, path, true))
    {
        return Err("此位置包含 Nexus 工作空间数据或索引，无法删除".into());
    }
    if other_roots
        .iter()
        .any(|path| overlaps(&target, path, false))
    {
        return Err("此文件夹包含另一个已登记的资产库，无法删除".into());
    }

    let identity = same_file::Handle::from_path(&target)
        .map_err(|error| format!("无法检查目标目录：{error}"))?;
    #[cfg(unix)]
    let device = {
        use std::os::unix::fs::MetadataExt;
        let device = fs::metadata(&target).map_err(|e| e.to_string())?.dev();
        let parent = target.parent().ok_or("磁盘根目录不可删除")?;
        if fs::metadata(parent).map_err(|e| e.to_string())?.dev() != device {
            return Err("文件系统挂载点不可删除".into());
        }
        device
    };
    for entry in WalkDir::new(&target)
        .follow_root_links(false)
        .follow_links(false)
    {
        let entry = entry.map_err(|error| format!("无法检查文件夹内容：{error}"))?;
        let meta = entry
            .metadata()
            .map_err(|error| format!("无法检查目录项：{error}"))?;
        if is_link(&meta) {
            return Err("文件夹内包含符号链接、目录联接或挂载点，无法删除".into());
        }
        if protected_name(&entry.file_name().to_string_lossy()) {
            return Err("文件夹内包含 Nexus 工作空间数据或索引，无法删除".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.dev() != device {
                return Err("文件夹内包含其他文件系统的挂载点，无法删除".into());
            }
        }
    }
    let current = canonical_directory(&target)?;
    if path_key(&current) != path_key(&target)
        || same_file::Handle::from_path(&current).ok().as_ref() != Some(&identity)
    {
        return Err("目标文件夹在检查期间已变化，请重新选择".into());
    }
    fs::remove_dir_all(&target)
        .map_err(|error| format!("磁盘删除未完成，部分内容可能已经删除：{error}"))?;
    Ok(target)
}

fn personal_target(
    catalog: &Catalog,
    library_id: &str,
    folder: &str,
) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let libraries = catalog.libraries()?;
    let selected = libraries
        .iter()
        .find(|row| row["id"].as_str() == Some(library_id))
        .ok_or("目标资产库已改变，请重新选择")?;
    let root = selected["path"]
        .as_str()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("个人库文件夹位置不可用")?;
    if folder_is_hidden(catalog, library_id, folder)? {
        return Err("目标文件夹已从资产库移除，请重新选择".into());
    }
    if !folder.is_empty() {
        let relative = relative_path(folder).ok_or("文件夹路径无效")?;
        team_import::share_path(&relative)?;
        let target = path_key(&root.join(relative));
        let indexed = selected["folders"].as_array().is_some_and(|folders| {
            folders
                .iter()
                .filter_map(Value::as_str)
                .any(|child| inside_folder(folder, child))
        });
        if !indexed {
            let mut assets = catalog
                .conn
                .prepare("SELECT path FROM assets WHERE library_id=?1")
                .map_err(|error| error.to_string())?;
            let paths = assets
                .query_map([library_id], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            let mut found = false;
            for path in paths {
                let path = path.map_err(|error| error.to_string())?;
                if path_key(Path::new(&path)).starts_with(&target) {
                    found = true;
                    break;
                }
            }
            if !found {
                return Err("只能删除已在当前资产库中索引的文件夹".into());
            }
        }
    }
    let others = libraries
        .iter()
        .filter(|row| row["id"].as_str() != Some(library_id))
        .filter_map(|row| row["path"].as_str().map(PathBuf::from))
        .collect();
    Ok((root, others))
}

fn update_personal_index(
    catalog: &mut Catalog,
    library_id: &str,
    folder: &str,
    target: &Path,
) -> Result<(), String> {
    let target = path_key(target);
    let transaction = catalog
        .conn
        .transaction()
        .map_err(|error| error.to_string())?;
    let assets: Vec<(String, String)> = {
        let mut query = transaction
            .prepare("SELECT id,path FROM assets")
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?
    };
    {
        let mut delete = transaction
            .prepare("DELETE FROM assets WHERE id=?1")
            .map_err(|error| error.to_string())?;
        for (id, path) in assets {
            if path_key(Path::new(&path)).starts_with(&target) {
                delete.execute([id]).map_err(|error| error.to_string())?;
            }
        }
    }
    if folder.is_empty() {
        transaction
            .execute("DELETE FROM libraries WHERE id=?1", [library_id])
            .map_err(|error| error.to_string())?;
    } else {
        let data: String = transaction
            .query_row(
                "SELECT data FROM libraries WHERE id=?1",
                [library_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let mut data: Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
        if let Some(folders) = data["folders"].as_array_mut() {
            folders.retain(|child| {
                child
                    .as_str()
                    .is_none_or(|child| !inside_folder(folder, child))
            });
        }
        transaction
            .execute(
                "UPDATE libraries SET data=?2 WHERE id=?1",
                params![library_id, data.to_string()],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub(crate) fn deletion_result(index_error: Option<String>) -> Value {
    json!({"deleted":true,"indexPending":index_error.is_some(),"indexError":index_error})
}

#[tauri::command]
pub(crate) async fn delete_workspace_folder(
    state: State<'_, AppState>,
    team: State<'_, Desktop>,
    library_id: String,
    folder: String,
    team_id: Option<String>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    if let Some(team_id) = team_id {
        return team
            .delete_workspace_folder(state, team_id, library_id, folder)
            .await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = lock_io(&state)?;
        let (root, others) = personal_target(&*lock_db(&state)?, &library_id, &folder)?;
        let target =
            delete_indexed_directory(&root, &folder, &protected_data_roots(&state)?, &others)?;
        let index_error = lock_db(&state)
            .and_then(|mut catalog| {
                update_personal_index(&mut catalog, &library_id, &folder, &target)
            })
            .err();
        Ok(deletion_result(index_error))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_one_indexed_folder_removes_only_its_disk_and_index_entries() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("db");
        let media = temp.path().join("media");
        for folder in ["目录", "目录同名"] {
            let folder = media.join(folder);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("mesh.obj"), "v 0 0 0").unwrap();
        }
        fs::create_dir(media.join("未索引")).unwrap();
        let mut catalog = Catalog::open(&data).unwrap();
        let scan = catalog.scan(&media, None, "local", |_| {}).unwrap();
        let id = scan["library"]["id"].as_str().unwrap();
        fs::create_dir(media.join("扫描后新增")).unwrap();
        assert!(personal_target(&catalog, id, "扫描后新增").is_err());

        let (root, others) = personal_target(&catalog, id, "目录").unwrap();
        let removed = delete_indexed_directory(&root, "目录", &[data.clone()], &others).unwrap();
        update_personal_index(&mut catalog, id, "目录", &removed).unwrap();
        assert!(!media.join("目录").exists());
        assert!(media.join("目录同名").join("mesh.obj").is_file());
        assert_eq!(catalog.assets().unwrap().len(), 1);
        assert!(!catalog.libraries().unwrap()[0]["folders"]
            .as_array()
            .unwrap()
            .contains(&json!("目录")));

        let removed = delete_indexed_directory(&root, "", &[data.clone()], &[]).unwrap();
        update_personal_index(&mut catalog, id, "", &removed).unwrap();
        assert!(!media.exists());
        assert!(data.join("nexus.sqlite3").is_file());
        assert!(catalog.assets().unwrap().is_empty());
        assert!(catalog.libraries().unwrap().is_empty());
    }

    #[test]
    fn preflight_preserves_nested_sources_and_workspace_data() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("share");
        let target = root.join("media");
        let nested = target.join("separate-library");
        fs::create_dir_all(&nested).unwrap();
        let sentinel = target.join("mesh.obj");
        fs::write(&sentinel, "v 0 0 0").unwrap();
        assert!(delete_indexed_directory(&root, "media", &[], &[nested.clone()]).is_err());
        assert!(delete_indexed_directory(&root, "media", &[nested], &[]).is_err());
        fs::create_dir(target.join(".nexus")).unwrap();
        assert!(delete_indexed_directory(&root, "media", &[], &[]).is_err());
        assert!(delete_indexed_directory(&root, "../outside", &[], &[]).is_err());
        assert!(sentinel.is_file());
    }
}
