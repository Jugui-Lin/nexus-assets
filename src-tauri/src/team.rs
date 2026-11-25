use crate::{kind, WorkflowStatus};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub watching: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedAsset {
    pub id: String,
    pub library_id: String,
    pub relative_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_library_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_folder: Option<String>,
    pub name: String,
    pub ext: String,
    pub kind: String,
    pub size: u64,
    pub modified: u64,
    pub added: u64,
    pub tags: Vec<String>,
    pub notes: String,
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub workflow: WorkflowStatus,
    pub revision: u64,
    pub edited_by: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publish {
    pub library: Library,
    pub files: Vec<PublishedFile>,
    #[serde(default)]
    pub complete: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedFile {
    pub relative_path: String,
    pub name: String,
    pub size: u64,
    pub modified: u64,
    pub tags: Vec<String>,
    pub notes: String,
    #[serde(skip)]
    pub file_identity: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataPatch {
    pub revision: u64,
    pub name: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
    pub rating: Option<u8>,
    pub workflow: Option<WorkflowStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub team: Team,
    pub member: Member,
    pub revision: u64,
    pub catalog: Option<SharedCatalog>,
    #[serde(default)]
    pub folder_visibility: bool,
    #[serde(default)]
    pub member_folder_visibility: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedCatalog {
    pub libraries: Vec<Library>,
    pub assets: Vec<SharedAsset>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_folders: Vec<HiddenFolder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all_libraries: Option<Vec<Library>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub visible_folders: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub linked_folders: Vec<LinkedFolder>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub source_paths: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub defined_tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenFolder {
    pub library_id: String,
    pub folder: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFolder {
    pub library_id: String,
    pub folder: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderLinks {
    pub folders: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFolderVisibility {
    pub library_id: String,
    pub folder: String,
    pub hidden: bool,
}

pub const MAX_FILES: usize = 50_000;
pub const MAX_PUBLISH_BYTES: usize = 48 * 1024 * 1024;
pub const MAX_FOLDERS_PER_LINK_REQUEST: usize = 128;

pub fn asset_format(relative: &str) -> Option<(String, &'static str)> {
    let ext = Path::new(relative)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    let kind = kind(&ext)?;
    Some((ext, kind))
}

pub fn normalized_tags(tags: Vec<String>) -> Vec<String> {
    let mut output = vec![];
    for tag in tags.into_iter().take(100) {
        let tag: String = tag.trim().chars().take(40).collect();
        if !tag.is_empty() && !output.contains(&tag) {
            output.push(tag);
            if output.len() == 30 {
                break;
            }
        }
    }
    output
}

pub fn relative_path(path: &str) -> Option<PathBuf> {
    if path.len() > 4096 {
        return None;
    }
    let mut result = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\x22|?*".contains(c))
        {
            return None;
        }
        let stem = part.split('.').next()?.trim_end().to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(
                &stem[3..],
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ))
        {
            return None;
        }
        result.push(part);
    }
    Some(result)
}

pub fn mapped_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative_path(relative).ok_or("资产路径无效")?;
    let root = std::fs::canonicalize(root).map_err(|_| "团队库挂载目录无法访问，请检查目录映射")?;
    let file = std::fs::canonicalize(root.join(relative))
        .map_err(|_| "找不到源文件，请检查团队库挂载目录")?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("资产必须是挂载目录内的文件".into());
    }
    Ok(file)
}

pub fn scan_team_files(
    root: &Path,
    progress: impl FnMut(usize),
) -> Result<(Vec<PublishedFile>, usize), String> {
    scan_team_entries(root, root, progress, |_| Ok(()))
}

pub struct TeamTreeScan {
    pub files: Vec<PublishedFile>,
    pub folders: Vec<String>,
    pub skipped: usize,
}

pub fn scan_team_tree(root: &Path, progress: impl FnMut(usize)) -> Result<TeamTreeScan, String> {
    scan_team_subtree(root, root, progress)
}

pub fn scan_team_subtree(
    root: &Path,
    subtree: &Path,
    progress: impl FnMut(usize),
) -> Result<TeamTreeScan, String> {
    let mut folders = Vec::new();
    let (files, skipped) = scan_team_entries(root, subtree, progress, |folder| {
        if folders.len() == MAX_FILES {
            return Err(format!(
                "单次扫描最多 {MAX_FILES} 个文件夹，请把大目录分成多个团队库"
            ));
        }
        folders.push(folder);
        Ok(())
    })?;
    Ok(TeamTreeScan {
        files,
        folders,
        skipped,
    })
}

fn scan_team_entries(
    root: &Path,
    subtree: &Path,
    mut progress: impl FnMut(usize),
    mut add_folder: impl FnMut(String) -> Result<(), String>,
) -> Result<(Vec<PublishedFile>, usize), String> {
    let depth = subtree
        .strip_prefix(root)
        .map_err(|_| "扫描文件夹必须在团队库目录内")?
        .components()
        .count();
    let mut files = Vec::new();
    let mut skipped = 0;
    for entry in WalkDir::new(subtree)
        .follow_links(false)
        .follow_root_links(false)
        .max_depth(32_usize.saturating_sub(depth))
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
    {
        let Ok(entry) = entry else {
            skipped += 1;
            continue;
        };
        let is_folder = entry.file_type().is_dir();
        if entry.depth() == 0 || (!is_folder && !entry.file_type().is_file()) {
            continue;
        }
        let path = entry.path();
        let Some(relative) = path.strip_prefix(root).ok().and_then(|p| {
            p.iter()
                .map(|part| part.to_str())
                .collect::<Option<Vec<_>>>()
                .map(|p| p.join("/"))
        }) else {
            if !is_folder {
                skipped += 1;
            }
            continue;
        };
        if is_folder {
            if relative_path(&relative).is_some() {
                add_folder(relative)?;
            }
            continue;
        }
        if asset_format(&relative).is_none() {
            continue;
        }
        if relative_path(&relative).is_none() {
            skipped += 1;
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            skipped += 1;
            continue;
        };
        if files.len() == MAX_FILES {
            return Err(format!(
                "单次扫描最多 {MAX_FILES} 项，请把大目录分成多个团队库"
            ));
        }
        let name: String = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .trim()
            .chars()
            .take(200)
            .collect();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|t| t.as_millis() as u64)
            .unwrap_or(0);
        files.push(PublishedFile {
            relative_path: relative,
            name,
            size: metadata.len(),
            modified,
            tags: vec![],
            notes: String::new(),
            file_identity: scan_file_identity(&metadata),
        });
        if files.len() % 100 == 0 {
            progress(files.len());
        }
    }
    Ok((files, skipped))
}

fn scan_file_identity(metadata: &std::fs::Metadata) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.ino() == 0 || metadata.nlink() != 1 {
            return None;
        }
        // Device/inode identify a move. Size and precise modification time help reject inode reuse.
        Some(format!(
            "{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec()
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_team_path_resolves_under_each_members_mount() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let relative = "家具/休闲椅.obj";
        for (root, bytes) in [(first.path(), "a"), (second.path(), "b")] {
            let file = root.join(relative);
            std::fs::create_dir(file.parent().unwrap()).unwrap();
            std::fs::write(&file, bytes).unwrap();
            let resolved = mapped_file(root, relative).unwrap();
            assert_eq!(resolved, std::fs::canonicalize(file).unwrap());
            assert_eq!(std::fs::read_to_string(resolved).unwrap(), bytes);
        }
        for invalid in [
            "../a.obj", "C:/a.obj", "a\\b.obj", "/a.obj", "NUL.obj", "a//b.obj",
        ] {
            assert!(relative_path(invalid).is_none(), "accepted {invalid}");
        }
    }
}
