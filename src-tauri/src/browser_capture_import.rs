use crate::{
    asset_files, browser_capture::BrowserCapture, team_desktop, team_import, workspaces, AppState,
};
use nexus_core::{clean_path, relative_folder, Catalog, FileImportOutcome};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ImportTarget {
    Personal {
        workspace_id: String,
        library_id: Option<String>,
        folder: String,
    },
    Team {
        team_id: String,
        library_id: String,
        folder: String,
    },
}

#[derive(Serialize)]
pub(crate) struct DestinationLibrary {
    id: String,
    name: String,
    folders: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportReport {
    copied: usize,
    found: usize,
    duplicates: usize,
    skipped: usize,
    failed: usize,
    errors: Vec<String>,
    index_pending: bool,
}

impl ImportReport {
    fn missing(&mut self, count: usize) {
        if count > 0 {
            self.failed += count;
            self.errors
                .push(format!("{count} 条采集记录的源文件已经不可用"));
        }
    }
}

fn destination_libraries(catalog: &Catalog) -> Result<Vec<DestinationLibrary>, String> {
    let mut libraries = Vec::new();
    for row in catalog.libraries()? {
        let (Some(id), Some(name), Some(path)) = (
            row["id"].as_str(),
            row["name"].as_str(),
            row["path"].as_str(),
        ) else {
            continue;
        };
        let path = Path::new(path);
        if !path.is_absolute() {
            continue;
        }
        let mut folders: BTreeSet<_> = row["folders"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|folder| nexus_core::team::relative_path(folder).is_some())
            .map(str::to_owned)
            .collect();
        if row["foldersComplete"] != true {
            let mut statement = catalog
                .conn
                .prepare_cached(
                    "SELECT path FROM assets WHERE library_id=?1
                 AND NOT EXISTS (SELECT 1 FROM recycled_assets WHERE asset_id=assets.id)",
                )
                .map_err(|error| error.to_string())?;
            let paths = statement
                .query_map([id], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            for asset_path in paths {
                let asset_path = asset_path.map_err(|error| error.to_string())?;
                let Some(folder) = Path::new(&asset_path)
                    .parent()
                    .and_then(|parent| relative_folder(path, parent))
                else {
                    continue;
                };
                if nexus_core::team::relative_path(&folder).is_some() {
                    folders.extend(
                        folder
                            .match_indices('/')
                            .map(|(end, _)| folder[..end].to_owned()),
                    );
                    folders.insert(folder);
                }
            }
        }
        libraries.push(DestinationLibrary {
            id: id.into(),
            name: name.into(),
            folders: folders.into_iter().collect(),
        });
    }
    Ok(libraries)
}

#[tauri::command]
pub(crate) async fn browser_capture_personal_libraries(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<DestinationLibrary>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = workspaces::lock_io(&state)?;
        let catalog = workspaces::open_registered_catalog(&state, &workspace_id)?;
        destination_libraries(&catalog)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn personal_destination(
    catalog: &Catalog,
    capture: &BrowserCapture,
    workspace_id: &str,
    library_id: Option<String>,
    folder: &str,
) -> Result<(PathBuf, String), String> {
    let Some(id) = library_id else {
        if !folder.is_empty() {
            return Err("默认采集目录不接受相对路径".into());
        }
        return Ok((
            capture.managed_import_directory(workspace_id)?,
            "loose".into(),
        ));
    };
    let library = catalog
        .libraries()?
        .into_iter()
        .find(|row| row["id"].as_str() == Some(id.as_str()))
        .ok_or("所选个人库目录已取消链接，请重新选择")?;
    let path = library["path"].as_str().ok_or("所选个人库目录路径无效")?;
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("所选个人库目录路径无效".into());
    }
    let (root, relative) = team_import::team_destination(path, folder)
        .map_err(|_| "无法打开个人库目标。请选择已链接目录中的实际文件夹。")?;
    Ok((root.join(relative), id))
}

fn copy_once(source: &Path, destination: &Path) -> Result<Option<File>, String> {
    let existing = || {
        let size = fs::metadata(source)
            .map_err(|error| error.to_string())?
            .len();
        if team_import::same_content(source, destination, size)? {
            Ok(None)
        } else {
            Err("目标文件夹已存在同名文件，原文件已保留".into())
        }
    };
    match fs::symlink_metadata(destination) {
        Ok(_) => return existing(),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查目标文件：{error}")),
    }
    let folder = destination.parent().ok_or("目标文件夹无效")?;
    let staged = asset_files::stage_copy(source, folder)?;
    match staged.persist_noclobber(destination) {
        Ok(file) => {
            // The fingerprint reader on Windows excludes concurrent write handles.
            // Keep the same file open read-only so rollback can still verify its identity.
            let owner = Handle::from_file(file).map_err(|error| error.to_string())?;
            let reader = Handle::from_path(destination).map_err(|error| error.to_string())?;
            if owner != reader {
                return Err("目标文件在复制后发生更改，请重新选择导入路径".into());
            }
            reader
                .as_file()
                .try_clone()
                .map(Some)
                .map_err(|error| error.to_string())
        }
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => existing(),
        Err(error) => Err(format!("无法保存采集文件：{}", error.error)),
    }
}

fn import_personal(
    catalog: &Catalog,
    sources: Vec<PathBuf>,
    destination: &Path,
    library_id: &str,
    mut report: ImportReport,
    mut progress: impl FnMut(usize),
) -> ImportReport {
    let mut importer = catalog.file_import();
    for (index, source) in sources.into_iter().enumerate() {
        let Some(filename) = source.file_name() else {
            report.failed += 1;
            report.errors.push("采集文件名无效".into());
            continue;
        };
        let target = destination.join(filename);
        match copy_once(&source, &target) {
            Ok(published) => {
                match importer.add(&target, library_id) {
                    Ok(FileImportOutcome::Indexed) => {
                        report.found += 1;
                        report.copied += usize::from(published.is_some());
                        progress(index + 1);
                        continue;
                    }
                    Ok(FileImportOutcome::Duplicate) => report.duplicates += 1,
                    Ok(FileImportOutcome::Unsupported) => report.skipped += 1,
                    Err(error) => {
                        report.failed += 1;
                        report.errors.push(format!("无法索引采集文件：{error}"));
                    }
                }
                if let Some(file) = published {
                    let errors = asset_files::rollback(vec![(target, file)]);
                    if !errors.is_empty() {
                        report.failed += 1;
                        report.copied += 1;
                        report.errors.extend(errors);
                    }
                }
            }
            Err(error) => {
                report.failed += 1;
                report.errors.push(error);
            }
        }
        progress(index + 1);
    }
    report
}

#[tauri::command]
pub(crate) async fn browser_capture_import(
    app: AppHandle,
    state: State<'_, AppState>,
    capture: State<'_, BrowserCapture>,
    ids: Vec<Uuid>,
    target: ImportTarget,
) -> Result<Value, String> {
    let capture = capture.inner().clone();
    let source_capture = capture.clone();
    let (sources, missing) =
        tauri::async_runtime::spawn_blocking(move || source_capture.import_sources(ids))
            .await
            .map_err(|error| error.to_string())??;
    let mut report = ImportReport::default();
    report.missing(missing);
    if sources.is_empty() {
        return Ok(json!(report));
    }
    match target {
        ImportTarget::Personal {
            workspace_id,
            library_id,
            folder,
        } => {
            let state = state.inner().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _workspace = workspaces::lock_io(&state)?;
                let catalog = workspaces::open_registered_catalog(&state, &workspace_id)?;
                let (destination, library_id) =
                    personal_destination(&catalog, &capture, &workspace_id, library_id, &folder)?;
                let report = import_personal(
                    &catalog,
                    sources,
                    &destination,
                    &library_id,
                    report,
                    |count| {
                        let _ = app.emit("browser-capture-import-progress", count);
                    },
                );
                Ok(json!(report))
            })
            .await
            .map_err(|error| error.to_string())?
        }
        ImportTarget::Team {
            team_id,
            library_id,
            folder,
        } => {
            let team = app.state::<team_desktop::Desktop>();
            let paths = sources.iter().map(|file| clean_path(file)).collect();
            let mut result = team_desktop::team_import_paths(
                app.clone(),
                team,
                team_id,
                library_id,
                folder,
                paths,
            )
            .await?;
            let index_pending = result["indexPending"].as_bool().unwrap_or_default();
            let found = if index_pending {
                0
            } else {
                result["files"].as_array().map_or(0, Vec::len)
            };
            result["found"] = json!(found);
            result["failed"] =
                json!(result["failed"].as_u64().unwrap_or_default() + missing as u64);
            if let Some(errors) = result["errors"].as_array_mut() {
                errors.extend(report.errors.into_iter().map(Value::String));
            }
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_capture_copies_to_the_chosen_folder_and_keeps_original_on_retry() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let catalog = Catalog::open(&root.join("db")).unwrap();
        let capture = BrowserCapture::new(root, 47821);
        let library_dir = root.join("素材");
        let subfolder = library_dir.join("收集");
        fs::create_dir_all(&subfolder).unwrap();
        let library = catalog
            .register_library(&library_dir, Some("素材".into()), "local")
            .unwrap();
        let id = library["id"].as_str().unwrap().to_owned();
        let (directory, selected) =
            personal_destination(&catalog, &capture, "personal", Some(id.clone()), "收集").unwrap();
        assert!(same_file::is_same_file(&directory, &subfolder).unwrap());
        assert!(personal_destination(&catalog, &capture, "personal", Some(id), "..").is_err());

        let source = root.join("参考.png");
        let identical = root.join("不同文件名.png");
        let conflict = root.join("同名冲突.png");
        fs::write(&source, b"captured content").unwrap();
        fs::write(&identical, b"captured content").unwrap();
        fs::write(&conflict, b"other content").unwrap();
        fs::write(directory.join("同名冲突.png"), b"keep original").unwrap();

        let report = import_personal(
            &catalog,
            vec![source.clone(), identical.clone(), conflict],
            &directory,
            &selected,
            ImportReport::default(),
            |_| {},
        );
        assert_eq!(
            (
                report.copied,
                report.found,
                report.duplicates,
                report.failed
            ),
            (1, 1, 1, 1)
        );
        assert_eq!(
            fs::read(directory.join("参考.png")).unwrap(),
            b"captured content"
        );
        assert_eq!(
            fs::read(directory.join("同名冲突.png")).unwrap(),
            b"keep original"
        );
        assert!(!directory.join("不同文件名.png").exists());
        assert!(source.is_file() && identical.is_file());
        assert_eq!(catalog.assets().unwrap()[0].library_id, selected);
        assert_eq!(
            destination_libraries(&catalog).unwrap()[0].folders,
            ["收集"]
        );
        let retry = import_personal(
            &catalog,
            vec![source],
            &directory,
            &selected,
            ImportReport::default(),
            |_| {},
        );
        assert_eq!((retry.copied, retry.duplicates, retry.failed), (0, 1, 0));
    }
}
