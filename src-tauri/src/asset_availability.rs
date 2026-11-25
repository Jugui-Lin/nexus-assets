use crate::{drop_ingest::library_at_folder, lock_db, AppState};
use nexus_core::{asset_thumbnail, clean_path, now, Asset, Catalog};
use rusqlite::{params, ErrorCode, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::{State, WebviewWindow};

#[derive(Default, Serialize)]
pub(crate) struct AvailabilityReport {
    missing: Vec<String>,
    unavailable: Vec<String>,
}

pub(crate) struct CheckItem {
    id: String,
    file: Option<(PathBuf, PathBuf)>,
    restrict_to_anchor: bool,
}

impl CheckItem {
    pub(crate) fn mapped(id: String, file: Option<(PathBuf, PathBuf)>) -> Self {
        Self {
            id,
            file,
            restrict_to_anchor: true,
        }
    }
}

fn mount_anchor(path: &Path) -> Option<&Path> {
    if !path.is_absolute() {
        return None;
    }
    #[cfg(target_os = "macos")]
    if path.starts_with("/Volumes") {
        if let Some(volume) = path
            .ancestors()
            .find(|part| part.parent() == Some(Path::new("/Volumes")))
        {
            return Some(volume);
        }
    }
    path.ancestors().last()
}

pub(crate) fn check_items(catalog: &Catalog, ids: Vec<String>) -> Result<Vec<CheckItem>, String> {
    let roots: HashMap<_, _> = catalog
        .libraries()?
        .into_iter()
        .filter_map(|row| {
            Some((
                row["id"].as_str()?.to_owned(),
                PathBuf::from(row["path"].as_str()?),
            ))
        })
        .collect();
    let mut statement = catalog
        .conn
        .prepare_cached("SELECT path, library_id FROM assets WHERE id=?1")
        .map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let asset: Option<(String, String)> = statement
            .query_row([&id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(|error| error.to_string())?;
        let file = asset.and_then(|(path, library)| {
            let path = PathBuf::from(path);
            let anchor = roots
                .get(&library)
                .filter(|root| root.is_absolute() && path.starts_with(root))
                .map(PathBuf::as_path)
                .or_else(|| mount_anchor(&path))?
                .to_path_buf();
            Some((path, anchor))
        });
        items.push(CheckItem {
            id,
            file,
            restrict_to_anchor: false,
        });
    }
    Ok(items)
}

pub(crate) fn check_paths(items: Vec<CheckItem>) -> AvailabilityReport {
    let mut result = AvailabilityReport::default();
    let mut reachable_roots = HashMap::new();
    let mut canonical_roots = HashMap::new();
    for CheckItem {
        id,
        file,
        restrict_to_anchor,
    } in items
    {
        let Some((path, anchor)) = file else {
            result.unavailable.push(id);
            continue;
        };
        let checked = if restrict_to_anchor {
            let root = canonical_roots
                .entry(anchor.clone())
                .or_insert_with_key(|path| fs::canonicalize(path).ok().filter(|p| p.is_dir()));
            let Some(root) = root else {
                result.unavailable.push(id);
                continue;
            };
            fs::canonicalize(path).and_then(|file| {
                if !file.starts_with(root.as_path()) {
                    return Err(std::io::Error::new(
                        ErrorKind::PermissionDenied,
                        "outside mount",
                    ));
                }
                fs::metadata(file)
            })
        } else {
            fs::metadata(path)
        };
        match checked {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => result.missing.push(id),
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                if restrict_to_anchor
                    || *reachable_roots
                        .entry(anchor)
                        .or_insert_with_key(|path| path.is_dir())
                {
                    result.missing.push(id);
                } else {
                    result.unavailable.push(id);
                }
            }
            Err(_) => result.unavailable.push(id),
        }
    }
    result
}

struct Replacement {
    path: PathBuf,
    size: u64,
    modified: u64,
    thumbnail: Option<String>,
}

fn prepare_replacement(file: &Path, previous: &Asset) -> Result<Replacement, String> {
    if !file.is_absolute() {
        return Err("请选择绝对路径下的文件".into());
    }
    let path = fs::canonicalize(file).map_err(|error| format!("无法打开选中的文件（{error}）"))?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("无法读取选中的文件（{error}）"))?;
    if !metadata.is_file() {
        return Err("请选择一个资产文件".into());
    }
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(&previous.ext))
    {
        return Err(format!("请选择相同格式的 .{} 文件", previous.ext));
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or_else(now);
    let thumbnail = if previous.kind == "texture" {
        None
    } else if previous.demo && clean_path(&path) == previous.path {
        previous.thumbnail.clone()
    } else {
        asset_thumbnail(&path)
    };
    Ok(Replacement {
        path,
        modified,
        thumbnail,
        size: metadata.len(),
    })
}

fn relink_file(
    catalog: &Catalog,
    previous: &Asset,
    replacement: Replacement,
) -> Result<Asset, String> {
    let folder = replacement.path.parent().ok_or("资产文件夹路径无效")?;
    let target = clean_path(&replacement.path);
    let transaction = Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current = catalog.asset(&previous.id)?;
    if current.path != previous.path {
        return Err("资产路径已更改，请刷新后重试".into());
    }
    let library_id = library_at_folder(catalog, folder)?.unwrap_or_else(|| "loose".to_owned());
    let file_data = json!({"size": replacement.size, "modified": replacement.modified,
                           "thumbnail": replacement.thumbnail});
    transaction
        .execute(
            "UPDATE assets SET path=?1, library_id=?2, data=json_set(data,
                '$.path',?1, '$.libraryId',?2, '$.size',json_extract(?3,'$.size'),
                '$.modified',json_extract(?3,'$.modified'), '$.thumbnail',json_extract(?3,'$.thumbnail'))
             WHERE id=?4",
            params![target, library_id, file_data.to_string(), previous.id],
        )
        .map_err(|error| {
            if error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
                "选中的文件已在个人资产库里建立索引".to_owned()
            } else {
                error.to_string()
            }
        })?;
    catalog.record_indexed_asset_directory(&replacement.path)?;
    let updated = catalog.asset(&previous.id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn check_asset_files(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<AvailabilityReport, String> {
    if ids.iter().any(|id| id.starts_with("team:")) {
        return Err("文件检查适用于个人资产库".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let items = check_items(&*lock_db(&state)?, ids)?;
        Ok(check_paths(items))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn relink_asset_file(
    state: State<'_, AppState>,
    window: WebviewWindow,
    id: String,
) -> Result<Option<Asset>, String> {
    if id.starts_with("team:") {
        return Err("重新链接适用于个人资产库".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = crate::workspaces::lock_io(&state)?;
        let previous = lock_db(&state)?.asset(&id)?;
        let mut dialog = rfd::FileDialog::new()
            .set_parent(&window)
            .set_title("选择资产的新位置")
            .add_filter(
                format!("{} 资产", previous.ext.to_uppercase()),
                &[&previous.ext],
            );
        if let Some(parent) = Path::new(&previous.path)
            .parent()
            .filter(|path| path.is_dir())
        {
            dialog = dialog.set_directory(parent);
        }
        let Some(path) = dialog.pick_file() else {
            return Ok(None);
        };
        let replacement = prepare_replacement(&path, &previous)?;
        relink_file(&*lock_db(&state)?, &previous, replacement).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(catalog: &Catalog, path: &Path, library: &str) -> Asset {
        fs::write(path, b"v 0 0 0\n").unwrap();
        assert!(catalog.add_file(path, library).unwrap());
        catalog.assets().unwrap().remove(0)
    }

    #[test]
    fn differentiates_missing_files_from_an_unreachable_library_root() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let root = scratch.path().join("NAS");
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let library = catalog.register_library(&root, None, "mounted").unwrap();
        let attached = index(
            &catalog,
            &root.join("seat.obj"),
            library["id"].as_str().unwrap(),
        );
        let current = index(&catalog, &scratch.path().join("current.obj"), "loose");
        let missing = index(&catalog, &scratch.path().join("missing.obj"), "loose");
        fs::remove_file(&missing.path).unwrap();
        fs::remove_file(&attached.path).unwrap();

        let checked = check_paths(check_items(&catalog, vec![attached.id.clone()]).unwrap());
        assert_eq!(checked.missing, vec![attached.id.clone()]);
        fs::remove_dir(&root).unwrap();
        let checked = check_paths(
            check_items(
                &catalog,
                vec![current.id, missing.id.clone(), attached.id.clone()],
            )
            .unwrap(),
        );
        assert_eq!(checked.missing, vec![missing.id]);
        assert_eq!(checked.unavailable, vec![attached.id]);
        assert_eq!(catalog.assets().unwrap().len(), 3);
    }

    #[test]
    fn checks_mapped_team_files_and_separates_missing_from_unmapped_or_unreachable() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("共享库");
        fs::create_dir(&mount).unwrap();
        let available = mount.join("chair.obj");
        fs::write(&available, b"mesh").unwrap();
        let offline = scratch.path().join("offline");
        let result = check_paths(vec![
            CheckItem::mapped("team:available".into(), Some((available, mount.clone()))),
            CheckItem::mapped(
                "team:missing".into(),
                Some((mount.join("missing.obj"), mount)),
            ),
            CheckItem::mapped("team:unmapped".into(), None),
            CheckItem::mapped(
                "team:offline".into(),
                Some((offline.join("missing.obj"), offline)),
            ),
        ]);
        assert_eq!(result.missing, ["team:missing"]);
        assert_eq!(result.unavailable, ["team:unmapped", "team:offline"]);
    }

    #[test]
    fn relinks_without_replacing_identity_and_assigns_the_destination_library() {
        let scratch = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let first = scratch.path().join("old.obj");
        let folder = scratch.path().join("model library");
        fs::create_dir(&folder).unwrap();
        let folder = fs::canonicalize(folder).unwrap();
        let library = catalog.scan(&folder, None, "local", |_| {}).unwrap()["library"].clone();
        let previous = index(&catalog, &first, "loose");
        let collection = catalog.create_collection("personal", "家具").unwrap();
        catalog
            .set_collection_membership("personal", &collection.id, &[previous.id.clone()], true)
            .unwrap();
        // Simulate an inspector edit while the relink file picker is open.
        catalog
            .patch(
                &previous.id,
                json!({"name":"My model","rating":5,
                "workflow":"review","tags":["favorite"],"favorite":true,"notes":"Remember"}),
            )
            .unwrap();
        let new_path = folder.join("新目录/renamed.OBJ");
        fs::create_dir_all(new_path.parent().unwrap()).unwrap();
        fs::rename(&first, &new_path).unwrap();
        fs::write(&new_path, "v 0 0 0\nv 1 1 1\n").unwrap();
        let thumbnail = new_path.with_extension("png");
        fs::write(&thumbnail, "sidecar").unwrap();
        let replacement = prepare_replacement(&new_path, &previous).unwrap();
        let next = relink_file(&catalog, &previous, replacement).unwrap();

        assert_eq!(next.id, previous.id);
        assert_eq!(next.name, "My model");
        assert_eq!(next.notes, "Remember");
        assert_eq!(next.rating, 5);
        assert_eq!(next.workflow, nexus_core::WorkflowStatus::Review);
        assert_eq!(next.tags, vec!["favorite"]);
        assert!(next.favorite);
        assert_eq!(next.added, previous.added);
        assert_eq!(next.library_id, library["id"].as_str().unwrap());
        assert_eq!(Path::new(&next.path), Path::new(&clean_path(&new_path)));
        assert_eq!(next.size, 16);
        assert_eq!(next.thumbnail, Some(clean_path(&thumbnail)));
        let library = catalog.libraries().unwrap().remove(0);
        assert_eq!(library["foldersComplete"], true);
        assert_eq!(library["folders"], json!(["新目录"]));
        assert_eq!(
            catalog.list_collections("personal").unwrap()[0].asset_ids,
            vec![next.id]
        );
        assert_eq!(catalog.assets().unwrap().len(), 1);
    }

    #[test]
    fn rejects_incompatible_assets_and_preserves_both_records_on_a_collision() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let asset = index(&catalog, &scratch.path().join("first.obj"), "loose");
        let occupied = index(&catalog, &scratch.path().join("second.obj"), "loose");
        let incompatible = scratch.path().join("third.fbx");
        fs::write(&incompatible, "fbx").unwrap();
        let mismatch = prepare_replacement(&incompatible, &asset).err().unwrap();
        assert!(mismatch.contains("相同格式"));
        let replacement = prepare_replacement(Path::new(&occupied.path), &asset).unwrap();
        assert!(relink_file(&catalog, &asset, replacement)
            .unwrap_err()
            .contains("已在个人资产库里建立索引"));
        assert_eq!(catalog.asset(&asset.id).unwrap().path, asset.path);
        assert_eq!(catalog.asset(&occupied.id).unwrap().path, occupied.path);
    }
}
