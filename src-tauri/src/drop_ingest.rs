use crate::{lock_db, AppState};
use nexus_core::{clean_path, relative_folder, Catalog, FileImportOutcome, ScanResult};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DropReport {
    found: usize,
    duplicates: usize,
    failed: usize,
    skipped: usize,
    errors: Vec<String>,
    libraries: Vec<Value>,
}

impl DropReport {
    fn record_error(&mut self, path: &Path, error: impl std::fmt::Display) {
        self.failed += 1;
        if self.errors.len() < 100 {
            self.errors.push(format!("{}: {error}", clean_path(path)));
        }
    }

    fn merge_scan(&mut self, scan: ScanResult) {
        self.found += scan.found;
        self.failed += scan.failed;
        self.skipped += scan.skipped;
        self.errors
            .extend(scan.errors.into_iter().take(100 - self.errors.len()));
    }
}

struct Library {
    id: String,
    path: PathBuf,
    path_key: PathBuf,
    depth: usize,
}

impl Library {
    fn from_row(row: Value) -> Option<Self> {
        let id = row["id"].as_str()?.to_owned();
        let path = PathBuf::from(row["path"].as_str()?);
        let depth = path.components().count();
        let path_key = match_key(&path);
        path.is_absolute().then_some(Self {
            id,
            path,
            path_key,
            depth,
        })
    }
}

fn match_key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

fn containing_library<'a>(
    libraries: &'a [Library],
    path: &Path,
    preferred: Option<&str>,
) -> Option<&'a Library> {
    libraries
        .iter()
        .filter(|library| path.starts_with(&library.path_key))
        .max_by_key(|library| (library.depth, preferred == Some(library.id.as_str())))
}

pub(crate) fn library_at_folder(
    catalog: &Catalog,
    folder: &Path,
) -> Result<Option<String>, String> {
    let libraries: Vec<_> = catalog
        .libraries()?
        .into_iter()
        .filter_map(Library::from_row)
        .collect();
    let key = match_key(Path::new(&clean_path(folder)));
    Ok(containing_library(&libraries, &key, None).map(|library| library.id.clone()))
}

fn index_drop(
    catalog: &Catalog,
    paths: Vec<PathBuf>,
    preferred: Option<&str>,
    mut progress: impl FnMut(usize),
) -> Result<DropReport, String> {
    if paths.is_empty() {
        return Err("没有可导入的文件或文件夹".into());
    }

    let mut report = DropReport::default();
    let mut libraries: Vec<Library> = catalog
        .libraries()?
        .into_iter()
        .filter_map(Library::from_row)
        .collect();
    let mut roots = Vec::new();
    let mut files = Vec::new();
    let mut unique = HashSet::new();
    for path in paths {
        if !path.is_absolute() {
            report.record_error(&path, "拖入路径必须是本机绝对路径");
            continue;
        }
        let source = match fs::canonicalize(&path) {
            Ok(source) => source,
            Err(error) => {
                report.record_error(&path, error);
                continue;
            }
        };
        // Case-fold Windows paths once and compare components at each lookup.
        // Path::starts_with rejects sibling prefixes such as "asset" and "assets".
        let key = match_key(Path::new(&clean_path(&source)));
        if !unique.insert(key.clone()) {
            report.skipped += 1;
            continue;
        }
        match source.metadata() {
            Ok(metadata) if metadata.is_dir() => roots.push((source, key)),
            Ok(metadata) if metadata.is_file() => files.push((source, key)),
            Ok(_) => report.record_error(&path, "此路径不是文件或文件夹"),
            Err(error) => report.record_error(&path, error),
        }
    }

    // Explorer and Finder can supply a folder and a selected descendant together.
    // Scan each physical path once and route new files to the deepest registered root.
    roots.sort_by_key(|(_, path)| path.components().count());
    let mut scan_roots = Vec::new();
    for (source, key) in roots {
        if scan_roots
            .iter()
            .any(|(_, parent): &(PathBuf, PathBuf)| key.starts_with(parent))
        {
            report.skipped += 1;
            continue;
        }
        if containing_library(&libraries, &key, preferred).is_none() {
            match catalog.register_library(&source, None, "local") {
                Ok(row) => {
                    let library = Library::from_row(row).ok_or("拖入目录的资产库路径无效")?;
                    libraries.push(library);
                }
                Err(error) => {
                    report.record_error(&source, error);
                    continue;
                }
            }
        }
        scan_roots.push((source, key));
    }

    let mut affected_ids = HashSet::new();
    for (source, key) in &scan_roots {
        if let Some(library) = containing_library(&libraries, key, preferred) {
            affected_ids.insert(library.id.clone());
        }
        let already_found = report.found;
        let scan = catalog.scan_files(
            source,
            |path| {
                let key = match_key(Path::new(&clean_path(path)));
                match containing_library(&libraries, &key, preferred) {
                    Some(library) => {
                        affected_ids.insert(library.id.clone());
                        library.id.as_str()
                    }
                    None => "loose",
                }
            },
            |found| progress(already_found + found),
        );
        for library in &libraries {
            if !key.starts_with(&library.path_key) && !library.path_key.starts_with(key) {
                continue;
            }
            let folders = scan
                .directories
                .iter()
                .filter_map(|path| relative_folder(&library.path, path))
                .collect::<Vec<_>>();
            let complete = key == &library.path_key && scan.failed == 0;
            if complete || !folders.is_empty() {
                affected_ids.insert(library.id.clone());
                if let Err(error) = catalog.store_library_folders(&library.id, &folders, complete) {
                    report.record_error(&library.path, error);
                }
            }
        }
        report.merge_scan(scan);
    }

    let mut importer = catalog.file_import();
    for (source, key) in files {
        if scan_roots.iter().any(|(_, root)| key.starts_with(root)) {
            report.skipped += 1;
            continue;
        }
        let library = containing_library(&libraries, &key, preferred);
        let library_id = library.map_or("loose", |library| library.id.as_str());
        match importer.add(&source, library_id) {
            Ok(FileImportOutcome::Indexed) => {
                report.found += 1;
                if report.found % 100 == 0 {
                    progress(report.found);
                }
                if let Some(library) = library {
                    affected_ids.insert(library.id.clone());
                }
            }
            Ok(FileImportOutcome::Duplicate) => report.duplicates += 1,
            Ok(FileImportOutcome::Unsupported) => report.skipped += 1,
            Err(error) => report.record_error(&source, error),
        }
    }
    report.libraries = catalog
        .libraries()?
        .into_iter()
        .filter(|library| {
            library["id"]
                .as_str()
                .is_some_and(|id| affected_ids.contains(id))
        })
        .collect();
    progress(report.found);
    Ok(report)
}

#[tauri::command]
pub(crate) async fn ingest_drop(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    library_id: Option<String>,
) -> Result<DropReport, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = crate::workspaces::lock_io(&state)?;
        let database = lock_db(&state)?.dir.clone();
        let catalog = Catalog::open(&database)?;
        index_drop(&catalog, paths, library_id.as_deref(), |count| {
            let _ = app.emit("drop-ingest-progress", count);
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn folder_scan_preserves_copies_but_explicit_loose_file_is_checked() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let root = scratch.path().join("scene");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("model-a.obj"), b"v 0 0 0\n").unwrap();
        fs::write(root.join("model-b.obj"), b"v 0 0 0\n").unwrap();
        let loose = scratch.path().join("model-copy.obj");
        fs::write(&loose, b"v 0 0 0\n").unwrap();

        let report = index_drop(&catalog, vec![root, loose.clone()], None, |_| {}).unwrap();
        assert_eq!((report.found, report.duplicates, report.failed), (2, 1, 0));
        assert_eq!(catalog.assets().unwrap().len(), 2);
        assert!(loose.is_file());
    }

    #[test]
    fn repeated_and_mixed_drops_keep_asset_identity_and_metadata() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let root = scratch.path().join("家具");
        let subfolder = root.join("椅子");
        fs::create_dir_all(&subfolder).unwrap();
        let model = subfolder.join("扶手椅.obj");
        let unknown = root.join("说明.txt");
        let missing = root.join("missing.obj");
        fs::write(&model, "v 0 0 0\n").unwrap();
        fs::write(&unknown, "说明").unwrap();

        let first = index_drop(&catalog, vec![model.clone()], None, |_| {}).unwrap();
        assert_eq!(first.found, 1);
        assert!(first.libraries.is_empty());
        let asset = &catalog.assets().unwrap()[0];
        let id = asset.id.clone();
        assert_eq!(asset.library_id, "loose");
        catalog
            .patch(
                &id,
                json!({"name":"手工名称","notes":"素材备注","tags":["精选"],"favorite":true}),
            )
            .unwrap();

        let mut counts = Vec::new();
        let second = index_drop(
            &catalog,
            vec![model.clone(), model.clone(), missing, root.clone()],
            None,
            |count| counts.push(count),
        )
        .unwrap();
        assert_eq!(second.found, 1);
        assert_eq!(second.failed, 1);
        assert_eq!(second.skipped, 3);
        assert_eq!(second.errors.len(), 1);
        assert!(second.errors[0].contains("missing.obj"));
        assert_eq!(second.libraries.len(), 1);
        assert_eq!(second.libraries[0]["name"], "家具");
        assert_eq!(counts.last(), Some(&1));
        let asset = catalog.asset(&id).unwrap();
        assert_eq!(
            asset.library_id,
            second.libraries[0]["id"].as_str().unwrap()
        );
        assert_eq!(
            (asset.name.as_str(), asset.notes.as_str()),
            ("手工名称", "素材备注")
        );
        assert_eq!(asset.tags, ["精选"]);
        assert!(asset.favorite);
        assert_eq!(catalog.assets().unwrap().len(), 1);
        assert_eq!(fs::read_to_string(&model).unwrap(), "v 0 0 0\n");

        let nested = index_drop(&catalog, vec![subfolder], None, |_| {}).unwrap();
        assert_eq!(nested.found, 1);
        assert_eq!(catalog.libraries().unwrap().len(), 1);
        assert_eq!(nested.libraries[0]["id"], second.libraries[0]["id"]);
    }

    #[test]
    fn dropping_outside_the_selected_root_preserves_physical_folder_membership() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let root = scratch.path().join("asset");
        let sibling = scratch.path().join("assets");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        let registered = catalog
            .register_library(
                &fs::canonicalize(&root).unwrap(),
                Some("目录".into()),
                "mounted",
            )
            .unwrap();
        let id = registered["id"].as_str().unwrap();
        let file = sibling.join("model.obj");
        fs::write(&file, "v 0 0 0\n").unwrap();
        let report = index_drop(&catalog, vec![file], Some(id), |_| {}).unwrap();
        assert_eq!(report.found, 1);
        assert!(report.libraries.is_empty());
        assert_eq!(catalog.assets().unwrap()[0].library_id, "loose");
        assert_eq!(catalog.libraries().unwrap()[0]["source"], "mounted");
    }

    #[test]
    fn dropping_subtrees_adds_empty_folders_without_discarding_existing_branches() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let root = scratch.path().join("项目");
        fs::create_dir_all(root.join("Archive/Empty")).unwrap();
        fs::create_dir_all(root.join("Props/Old")).unwrap();
        let first = index_drop(&catalog, vec![root.clone()], None, |_| {}).unwrap();
        assert_eq!(first.found, 0);
        assert_eq!(
            first.libraries[0]["folders"],
            json!(["Archive", "Archive/Empty", "Props", "Props/Old"])
        );
        let added = root.join("Props/New");
        fs::create_dir_all(added.join("Drafts")).unwrap();
        let next = index_drop(&catalog, vec![added], None, |_| {}).unwrap();
        assert_eq!(next.found, 0);
        assert_eq!(next.libraries[0]["id"], first.libraries[0]["id"]);
        assert_eq!(
            next.libraries[0]["folders"],
            json!([
                "Archive",
                "Archive/Empty",
                "Props",
                "Props/New",
                "Props/New/Drafts",
                "Props/Old"
            ])
        );
    }
}
