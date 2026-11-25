use crate::{drop_ingest::library_at_folder, lock_db, AppState};
use nexus_core::{clean_path, Catalog, ScanResult};
use same_file::Handle;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, File, FileTimes},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};
use tauri::{State, WebviewWindow};
use tempfile::NamedTempFile;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyReport {
    pub(crate) copied: usize,
    pub(crate) folder: String,
    pub(crate) paths: Vec<String>,
    pub(crate) indexed: usize,
    pub(crate) index_errors: Vec<String>,
}

struct CopyItem {
    source: PathBuf,
    target: PathBuf,
}

fn io_message(action: &str, path: &Path, error: impl std::fmt::Display) -> String {
    format!("{action}（{}）\n{error}", clean_path(path))
}

fn plan_copy(sources: Vec<PathBuf>, folder: &Path) -> Result<Vec<CopyItem>, String> {
    let mut sources_seen = HashSet::new();
    let mut names = HashSet::new();
    let mut plan = Vec::new();
    for source in sources {
        if !sources_seen.insert(source.clone()) {
            continue;
        }
        let filename = source
            .file_name()
            .filter(|_| source.is_absolute())
            .ok_or("资产的文件路径无效")?;
        let target = folder.join(filename);
        if !names.insert(filename.to_owned()) {
            return Err(format!(
                "所选资产存在同名文件（{}）",
                filename.to_string_lossy()
            ));
        }
        match fs::symlink_metadata(&target) {
            Ok(_) => return Err(format!("目标文件已存在（{}）", clean_path(&target))),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(io_message("无法检查目标文件", &target, error)),
        }
        plan.push(CopyItem { source, target });
    }
    Ok(plan)
}

pub(crate) fn stage_copy(source: &Path, staging: &Path) -> Result<NamedTempFile, String> {
    let source_metadata =
        fs::metadata(source).map_err(|error| io_message("无法读取资产信息", source, error))?;
    if !source_metadata.is_file() {
        return Err(format!("资产路径已不是文件（{}）", clean_path(source)));
    }
    let mut input =
        File::open(source).map_err(|error| io_message("无法打开资产", source, error))?;
    let metadata = input
        .metadata()
        .map_err(|error| io_message("无法读取资产信息", source, error))?;
    if !metadata.is_file() {
        return Err(format!("资产路径已不是文件（{}）", clean_path(source)));
    }
    let mut output = NamedTempFile::new_in(staging)
        .map_err(|error| io_message("无法在目标文件夹创建临时文件", staging, error))?;
    io::copy(&mut input, &mut output).map_err(|error| io_message("复制资产失败", source, error))?;
    if let Ok(modified) = metadata.modified() {
        // Some mounted filesystems cannot set custom timestamps.
        let _ = output
            .as_file()
            .set_times(FileTimes::new().set_modified(modified));
    }
    output
        .as_file()
        .sync_all()
        .map_err(|error| io_message("无法写入复制的资产", source, error))?;
    Ok(output)
}

pub(crate) fn rollback(published: Vec<(PathBuf, File)>) -> Vec<String> {
    let mut remaining = Vec::new();
    for (target, file) in published.into_iter().rev() {
        match fs::symlink_metadata(&target) {
            Ok(metadata) if !metadata.is_file() => continue,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            _ => {}
        }
        let owned = Handle::from_file(file);
        let current = Handle::from_path(&target);
        match (owned, current) {
            (Ok(owned), Ok(current)) if owned == current => {
                if let Err(error) = fs::remove_file(&target) {
                    remaining.push(io_message("无法撤回已复制文件", &target, error));
                }
            }
            (_, Err(error)) if error.kind() == ErrorKind::NotFound => {}
            (Ok(_), Ok(_)) => {} // The folder now has someone else's file at this path.
            _ => remaining.push(format!("无法确认要撤回的文件（{}）", clean_path(&target))),
        }
    }
    remaining
}

fn publish_files(staged: Vec<(PathBuf, NamedTempFile)>) -> Result<Vec<PathBuf>, String> {
    let mut published = Vec::new();
    for (target, file) in staged {
        // This final step must also reject races after the initial conflict check.
        match file.persist_noclobber(&target) {
            Ok(file) => published.push((target, file)),
            Err(error) => {
                let mut message = if error.error.kind() == ErrorKind::AlreadyExists {
                    format!("目标文件已存在（{}）", clean_path(&target))
                } else {
                    io_message("无法保存复制的资产", &target, error.error)
                };
                for problem in rollback(published) {
                    message.push('\n');
                    message.push_str(&problem);
                }
                return Err(message);
            }
        }
    }
    Ok(published.into_iter().map(|(path, _)| path).collect())
}

pub(crate) fn copy_files(sources: Vec<PathBuf>, folder: &Path) -> Result<Vec<PathBuf>, String> {
    let plan = plan_copy(sources, folder)?;
    let staging = tempfile::Builder::new()
        .prefix(".nexus-copy-")
        .tempdir_in(folder)
        .map_err(|error| io_message("无法在目标文件夹暂存复制内容", folder, error))?;
    let staged = plan
        .into_iter()
        .map(|item| Ok((item.target, stage_copy(&item.source, staging.path())?)))
        .collect::<Result<Vec<_>, String>>()?;
    publish_files(staged)
}

fn index_copies(database: &Path, folder: &Path, paths: &[PathBuf]) -> Result<ScanResult, String> {
    let catalog = Catalog::open(database)?;
    let mut result = ScanResult::default();
    if let Some(library_id) = library_at_folder(&catalog, folder)? {
        for path in paths {
            match catalog.add_file(path, &library_id) {
                Ok(true) => result.found += 1,
                Ok(false) => result.skipped += 1,
                Err(error) => result.record_error(io_message("无法索引复制的资产", path, error)),
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn copy_asset_files(
    state: State<'_, AppState>,
    window: WebviewWindow,
    ids: Vec<String>,
) -> Result<Option<CopyReport>, String> {
    if ids.is_empty() {
        return Err("请选择要复制的个人资产".into());
    }
    if ids.iter().any(|id| id.starts_with("team:")) {
        return Err("请切换到个人资产库后复制文件".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = crate::workspaces::lock_io(&state)?;
        let (database, sources) = {
            let catalog = lock_db(&state)?;
            let sources = ids
                .iter()
                .map(|id| catalog.asset(id).map(|asset| PathBuf::from(asset.path)))
                .collect::<Result<Vec<_>, _>>()?;
            (catalog.dir.clone(), sources)
        };

        let Some(folder) = rfd::FileDialog::new()
            .set_parent(&window)
            .set_title("选择资产复制到的文件夹")
            .pick_folder()
        else {
            return Ok(None);
        };
        let folder = fs::canonicalize(&folder)
            .map_err(|error| io_message("无法打开目标文件夹", &folder, error))?;
        let paths = copy_files(sources, &folder)?;
        // Files are already copied. An unavailable index must not undo the user's copy.
        let (indexed, index_errors) = match index_copies(&database, &folder, &paths) {
            Ok(result) => (result.found, result.errors),
            Err(error) => (0, vec![io_message("无法更新个人资产索引", &folder, error)]),
        };
        Ok(Some(CopyReport {
            copied: paths.len(),
            folder: clean_path(&folder),
            paths: paths.iter().map(|path| clean_path(path)).collect(),
            indexed,
            index_errors,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_files_and_indexes_only_inside_an_existing_root() {
        let sandbox = tempfile::tempdir().unwrap();
        let source = sandbox.path().join("材质.png");
        let root = sandbox.path().join("library");
        let folder = root.join("Textures");
        let external = sandbox.path().join("exports");
        fs::create_dir_all(&folder).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(&source, b"selected asset").unwrap();

        let database = sandbox.path().join("index");
        let catalog = Catalog::open(&database).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        let folder = fs::canonicalize(&folder).unwrap();
        let external = fs::canonicalize(&external).unwrap();
        let library = catalog.register_library(&root, None, "local").unwrap();
        let copied = copy_files(vec![source.clone(), source.clone()], &folder).unwrap();
        assert_eq!(copied.len(), 1);
        assert_eq!(fs::read(&copied[0]).unwrap(), fs::read(&source).unwrap());
        assert_eq!(index_copies(&database, &folder, &copied).unwrap().found, 1);
        let indexed = catalog.assets().unwrap();
        assert_eq!(indexed[0].library_id, library["id"].as_str().unwrap());

        let copied = copy_files(vec![source.clone()], &external).unwrap();
        assert_eq!(
            index_copies(&database, &external, &copied).unwrap().found,
            0
        );
        assert_eq!(catalog.assets().unwrap().len(), 1);
        assert!(source.is_file());
    }

    #[test]
    fn existing_target_and_missing_source_leave_destination_contents_unchanged() {
        let sandbox = tempfile::tempdir().unwrap();
        let folder = sandbox.path().join("target");
        fs::create_dir(&folder).unwrap();
        let one = sandbox.path().join("one.obj");
        let two = sandbox.path().join("two.obj");
        let occupied = folder.join("two.obj");
        fs::write(&one, "copy").unwrap();
        fs::write(&two, "another copy").unwrap();
        fs::write(&occupied, "preexisting").unwrap();

        let error = copy_files(vec![one.clone(), two], &folder).unwrap_err();
        assert!(error.contains("目标文件已存在"));
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "preexisting");
        let missing = sandbox.path().join("missing.obj");
        assert!(copy_files(vec![one, missing], &folder).is_err());
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
    }

    #[test]
    fn a_publishing_conflict_rolls_back_only_our_files() {
        let sandbox = tempfile::tempdir().unwrap();
        let source = sandbox.path().join("source.obj");
        fs::write(&source, "copy").unwrap();
        let first = sandbox.path().join("first.obj");
        let second = sandbox.path().join("second.obj");
        let staged = vec![
            (first.clone(), stage_copy(&source, sandbox.path()).unwrap()),
            (second.clone(), stage_copy(&source, sandbox.path()).unwrap()),
        ];
        fs::write(&second, "arrived during staging").unwrap();

        assert!(publish_files(staged)
            .unwrap_err()
            .contains("目标文件已存在"));
        assert!(!first.exists());
        assert_eq!(
            fs::read_to_string(&second).unwrap(),
            "arrived during staging"
        );
        assert_eq!(fs::read_dir(sandbox.path()).unwrap().count(), 2);
    }
}
