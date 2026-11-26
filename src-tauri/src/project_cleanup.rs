use serde::Serialize;
use std::{
    fs::{self, Metadata},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 25_000;
const MAX_CANDIDATES: usize = 120;
const MAX_DEPTH: usize = 12;
const MAX_DURATION: Duration = Duration::from_secs(6);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupInventory {
    directory: String,
    candidates: Vec<CleanupCandidate>,
    skipped: CleanupSkipped,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupCandidate {
    path: String,
    relative_path: String,
    kind: &'static str,
    files: u64,
    bytes: u64,
    last_modified: Option<u64>,
    partial: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupSkipped {
    protected: usize,
    linked_or_mounted: usize,
    offline: usize,
    unreadable: usize,
    depth_limit: usize,
}

#[tauri::command]
pub(crate) async fn inspect_project_cleanup(
    directory_path: String,
) -> Result<CleanupInventory, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(Path::new(&directory_path)))
        .await
        .map_err(|error| error.to_string())?
}

fn marker(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        ".cache" | "cache" | "caches" | "_cache" | "simcache" | "sim_cache" | "shadercache"
        | "shader_cache" | "mediacache" | "media cache" | "缓存" | "模拟缓存" => {
            Some("cache")
        }
        "proxy" | "proxies" | "_proxy" | "proxy_media" | "proxy media" | "代理素材"
        | "代理文件" => Some("proxy"),
        "temp_render" | "temp_renders" | "temp render" | "render_temp" | "render_tmp"
        | "preview_render" | "preview_renders" | "test_renders" | "临时渲染" | "测试渲染"
        | "预览渲染" => Some("render"),
        _ => None,
    }
}

fn protected_name(name: &str) -> bool {
    crate::folder_deletion::protected_name(name)
        || [
            ".git",
            ".svn",
            ".hg",
            "node_modules",
            ".venv",
            "$RECYCLE.BIN",
            "System Volume Information",
            "lost+found",
        ]
        .iter()
        .any(|part| name.eq_ignore_ascii_case(part))
}

enum Excluded {
    Protected,
    LinkedOrMounted,
    Offline,
}

fn excluded(metadata: &Metadata, root: &Metadata) -> Option<Excluded> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
            FILE_ATTRIBUTE_RECALL_ON_OPEN, FILE_ATTRIBUTE_SYSTEM,
        };
        let flags = metadata.file_attributes();
        if flags
            & (FILE_ATTRIBUTE_OFFLINE.0
                | FILE_ATTRIBUTE_RECALL_ON_OPEN.0
                | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0)
            != 0
        {
            return Some(Excluded::Offline);
        }
        if flags & (FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0) != 0 {
            return Some(Excluded::Protected);
        }
    }
    if crate::workspace_folder_move::link_or_reparse(metadata) {
        return Some(Excluded::LinkedOrMounted);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != root.dev() {
            return Some(Excluded::LinkedOrMounted);
        }
    }
    #[cfg(not(unix))]
    let _ = root;
    None
}

fn modified(metadata: &Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

impl CleanupInventory {
    fn partial(&mut self, candidate: Option<usize>) {
        if let Some(index) = candidate {
            self.candidates[index].partial = true;
        }
    }

    fn skip(&mut self, reason: Excluded, candidate: Option<usize>) {
        match reason {
            Excluded::Protected => self.skipped.protected += 1,
            Excluded::LinkedOrMounted => self.skipped.linked_or_mounted += 1,
            Excluded::Offline => self.skipped.offline += 1,
        }
        self.partial(candidate);
    }
}

struct PendingDirectory {
    path: PathBuf,
    depth: usize,
    candidate: Option<usize>,
}

fn inspect(root: &Path) -> Result<CleanupInventory, String> {
    crate::local_explorer::validate_file_path(root)?;
    if root.parent().is_none()
        || root.components().any(|part| {
            part == Component::ParentDir || protected_name(&part.as_os_str().to_string_lossy())
        })
    {
        return Err("请选择可访问的项目文件夹".into());
    }
    // A directory below a link or mount can look ordinary itself. Check each ancestor
    // before traversal, without resolving the link or opening a placeholder.
    let root_metadata =
        fs::symlink_metadata(root).map_err(|error| format!("无法读取项目文件夹：{error}"))?;
    if !root_metadata.is_dir() || excluded(&root_metadata, &root_metadata).is_some() {
        return Err("该位置是离线、系统保护、隐藏或链接项目".into());
    }
    for ancestor in root
        .ancestors()
        .skip(1)
        .filter(|path| path.parent().is_some())
    {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|error| format!("无法验证上级文件夹：{error}"))?;
        if matches!(
            excluded(&metadata, &root_metadata),
            Some(Excluded::Offline | Excluded::LinkedOrMounted)
        ) {
            return Err("所选目录经由离线或链接位置打开，无法检查".into());
        }
    }
    let mut report = CleanupInventory {
        directory: root.to_string_lossy().into_owned(),
        candidates: Vec::new(),
        skipped: CleanupSkipped::default(),
        truncated: false,
    };
    let started = Instant::now();
    let mut scanned = 0;
    let mut pending = vec![PendingDirectory {
        path: root.to_owned(),
        depth: 0,
        candidate: None,
    }];
    while let Some(PendingDirectory {
        path,
        depth,
        candidate,
    }) = pending.pop()
    {
        if depth != 0 {
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                report.skipped.unreadable += 1;
                report.partial(candidate);
                continue;
            };
            if let Some(reason) = excluded(&metadata, &root_metadata) {
                report.skip(reason, candidate);
                continue;
            }
        }
        let read = match fs::read_dir(&path) {
            Ok(read) => read,
            Err(error) if depth == 0 => return Err(format!("无法读取项目文件夹：{error}")),
            Err(_) => {
                report.skipped.unreadable += 1;
                report.partial(candidate);
                continue;
            }
        };
        for record in read {
            if scanned >= MAX_ENTRIES || started.elapsed() >= MAX_DURATION {
                report.truncated = true;
                report.partial(candidate);
                break;
            }
            scanned += 1;
            let Ok(entry) = record else {
                report.skipped.unreadable += 1;
                report.partial(candidate);
                continue;
            };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if protected_name(&name) {
                report.skip(Excluded::Protected, candidate);
                continue;
            }
            let child = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&child) else {
                report.skipped.unreadable += 1;
                report.partial(candidate);
                continue;
            };
            if let Some(reason) = excluded(&metadata, &root_metadata) {
                report.skip(reason, candidate);
                continue;
            }
            if metadata.is_dir() {
                let mut matched = candidate;
                if matched.is_none() {
                    if let Some(kind) = marker(&name) {
                        if report.candidates.len() == MAX_CANDIDATES {
                            report.truncated = true;
                            continue;
                        }
                        matched = Some(report.candidates.len());
                        report.candidates.push(CleanupCandidate {
                            path: child.to_string_lossy().into_owned(),
                            relative_path: child
                                .strip_prefix(root)
                                .map_err(|_| "项目路径已变更")?
                                .to_string_lossy()
                                .into_owned(),
                            kind,
                            files: 0,
                            bytes: 0,
                            last_modified: modified(&metadata),
                            partial: false,
                        });
                    }
                }
                if depth < MAX_DEPTH {
                    pending.push(PendingDirectory {
                        path: child,
                        depth: depth + 1,
                        candidate: matched,
                    });
                } else {
                    report.skipped.depth_limit += 1;
                    report.partial(matched);
                }
            } else if let Some(index) = candidate.filter(|_| metadata.is_file()) {
                let row = &mut report.candidates[index];
                row.files += 1;
                row.bytes = row.bytes.saturating_add(metadata.len());
                row.last_modified = row.last_modified.max(modified(&metadata));
            }
        }
        if scanned >= MAX_ENTRIES || started.elapsed() >= MAX_DURATION {
            report.truncated |= !pending.is_empty();
            for directory in &pending {
                report.partial(directory.candidate);
            }
            break;
        }
    }
    report
        .candidates
        .sort_by(|first, second| first.relative_path.cmp(&second.relative_path));
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventories_only_exact_markers_and_aggregates_nested_files_once() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("Project [测试]");
        for folder in [
            "Cache/nested/Proxy",
            "Delivery/cache notes",
            "Proxy",
            ".nexus/cache",
            "Final Render",
            "临时渲染",
        ] {
            fs::create_dir_all(root.join(folder)).unwrap();
        }
        fs::write(root.join("Cache/nested/Proxy/frame.exr"), b"raw").unwrap();
        fs::write(root.join("Cache/blobs.bin"), b"b").unwrap();
        fs::write(root.join(".nexus/cache/secret"), b"protected").unwrap();
        fs::write(root.join("Final Render/master.exr"), b"ignored").unwrap();
        let inventory = inspect(&root).unwrap();
        assert_eq!(inventory.candidates.len(), 3);
        assert_eq!(
            inventory
                .candidates
                .iter()
                .map(|item| item.files)
                .sum::<u64>(),
            2
        );
        assert_eq!(
            inventory
                .candidates
                .iter()
                .map(|item| item.bytes)
                .sum::<u64>(),
            4
        );
        assert_eq!(inventory.skipped.protected, 1);
        assert!(!inventory.truncated);
        assert!(inventory.candidates.iter().all(|item| !item.partial));
    }

    #[test]
    fn skips_links_without_following_nested_target() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("Project");
        let outside = directory.path().join("Outside");
        fs::create_dir_all(root.join("Cache")).unwrap();
        fs::create_dir_all(outside.join("Proxy")).unwrap();
        fs::write(outside.join("Proxy/input.bin"), b"external").unwrap();
        let linked = root.join("Cache").join("Linked");
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&linked)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(result.status.success(), "{result:?}");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &linked).unwrap();
        let inventory = inspect(&root).unwrap();
        assert_eq!(inventory.skipped.linked_or_mounted, 1);
        assert_eq!(inventory.candidates.len(), 1);
        assert_eq!(inventory.candidates[0].files, 0);
        assert!(inventory.candidates[0].partial);
        assert!(inspect(&root.join("Cache/Linked/Proxy")).is_err());
    }
}
