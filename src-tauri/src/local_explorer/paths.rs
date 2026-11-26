use super::{parse_address, Address};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const MAX_PATHS: usize = 48;
const TIMEOUT: Duration = Duration::from_secs(6);
static PATH_READ_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathCheck {
    index: usize,
    status: &'static str,
    path: Option<String>,
}

#[tauri::command]
pub(crate) async fn local_explorer_check_folder_paths(
    paths: Vec<String>,
    allow_network: bool,
) -> Result<Vec<PathCheck>, String> {
    if paths.len() > MAX_PATHS {
        return Err("一次最多核验 48 个文件夹路径".into());
    }
    crate::folder_browser::read_with_slots(&PATH_READ_SLOT, TIMEOUT, move |cancelled| {
        Ok(inspect(paths, allow_network, cancelled))
    })
    .await
}

#[cfg(windows)]
fn network_path(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    match prefix.kind() {
        Prefix::UNC(..) | Prefix::VerbatimUNC(..) => true,
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
            let root = [letter.into(), b':'.into(), b'\\'.into(), 0];
            crate::folder_browser::windows_drive_kind(&root) == "network"
        }
        _ => false,
    }
}

#[cfg(not(windows))]
fn network_path(_: &Path) -> bool {
    false
}

fn status_of_error(error: &std::io::Error) -> &'static str {
    match error.kind() {
        ErrorKind::NotFound => "missing",
        ErrorKind::NotADirectory => "file",
        _ => "unavailable",
    }
}

fn inspect(paths: Vec<String>, allow_network: bool, cancelled: &AtomicBool) -> Vec<PathCheck> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .enumerate()
        .take_while(|_| !cancelled.load(Ordering::Acquire))
        .map(|(index, address)| {
            let mut result = PathCheck {
                index,
                status: "invalid",
                path: None,
            };
            let Ok(Address::Path(path)) = parse_address(&address) else {
                return result;
            };
            if path
                .components()
                .any(|part| part == std::path::Component::ParentDir)
            {
                return result;
            }
            result.status = match probe(&path, allow_network, cancelled) {
                Ok(path) => {
                    let identity = same_file::Handle::from_path(&path).ok();
                    result.path = Some(nexus_core::clean_path(&path));
                    if identity.is_some_and(|key| !seen.insert(key)) {
                        "duplicate"
                    } else {
                        "directory"
                    }
                }
                Err(status) => status,
            };
            result
        })
        .collect()
}

fn probe(
    path: &Path,
    allow_network: bool,
    cancelled: &AtomicBool,
) -> Result<std::path::PathBuf, &'static str> {
    if !allow_network {
        if network_path(path) {
            return Err("network");
        }
        let ancestors = path.ancestors().collect::<Vec<_>>();
        for ancestor in ancestors.into_iter().rev() {
            if cancelled.load(Ordering::Acquire) {
                return Err("unavailable");
            }
            let metadata =
                fs::symlink_metadata(ancestor).map_err(|error| status_of_error(&error))?;
            // Avoid crossing a link that may point to a network share or offline store.
            if crate::workspace_folder_move::link_or_reparse(&metadata) {
                return Err("linked");
            }
            if !metadata.is_dir() {
                return Err("file");
            }
        }
    } else if !fs::metadata(path)
        .map_err(|error| status_of_error(&error))?
        .is_dir()
    {
        return Err("file");
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("unavailable");
    }
    fs::read_dir(path).map_err(|error| status_of_error(&error))?;
    fs::canonicalize(path).map_err(|error| status_of_error(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_folders_duplicates_missing_and_files_without_probing_shares() {
        let temp = tempfile::tempdir().unwrap();
        let valid = temp.path().join("有效 [1]");
        fs::create_dir(&valid).unwrap();
        let file = temp.path().join("file.c4d");
        fs::write(&file, b"asset").unwrap();
        let mut paths = vec![valid.clone(), valid, file, temp.path().join("missing")]
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        #[cfg(windows)]
        paths.push(r"\\nexus-offline-pretend\share\folder".into());
        let results = inspect(paths, false, &AtomicBool::new(false));
        assert_eq!(
            (
                results[0].status,
                results[1].status,
                results[2].status,
                results[3].status
            ),
            ("directory", "duplicate", "file", "missing")
        );
        #[cfg(windows)]
        assert_eq!(results[4].status, "network");
    }
}
