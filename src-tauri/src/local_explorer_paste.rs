use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Choice {
    KeepBoth,
    Skip,
}

#[derive(Deserialize)]
pub(crate) struct PasteDecision {
    index: usize,
    choice: Choice,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PastePreview {
    sequence: u32,
    signature: Option<String>,
    total: usize,
    conflicts: Vec<PasteConflict>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteConflict {
    index: usize,
    source: String,
    name: String,
    blocking_path: Option<String>,
    blocking_size: Option<u64>,
    blocking_directory: bool,
    source_size: u64,
    suggested_name: String,
    kind: &'static str,
}

#[derive(Default, Serialize)]
pub(crate) struct PasteOutcome {
    copied: usize,
    skipped: usize,
    errors: Vec<String>,
}

#[tauri::command]
pub(crate) async fn local_explorer_preview_paste(path: String) -> Result<PastePreview, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        let (paths, moved, sequence) = crate::local_explorer_clipboard::read_files()?;
        let total = paths.len();
        let plan = windows_paste::inspect(&path, paths, moved)?;
        Ok(PastePreview {
            sequence,
            signature: plan.as_ref().map(|plan| plan.signature.clone()),
            total,
            conflicts: plan.map_or_else(Vec::new, |plan| plan.conflicts),
        })
    })
    .await
    .map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("当前平台暂不支持粘贴预览".into())
    }
}

#[tauri::command]
pub(crate) async fn local_explorer_resolve_paste(
    path: String,
    sequence: u32,
    signature: String,
    decisions: Vec<PasteDecision>,
) -> Result<PasteOutcome, String> {
    #[cfg(windows)]
    {
        let permit = crate::local_explorer_drop::FILE_OPERATION
            .try_acquire()
            .map_err(|_| "请等当前文件操作完成")?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let (paths, moved, actual_sequence) = crate::local_explorer_clipboard::read_files()?;
            if sequence != actual_sequence {
                return Err("剪贴板内容已变化，请重新粘贴".into());
            }
            let plan = windows_paste::inspect(&path, paths, moved)?
                .ok_or("粘贴项目已变化，请重新检查重名")?;
            if signature != plan.signature {
                return Err("源文件或目标目录已变化，请重新检查重名".into());
            }
            windows_paste::commit(plan, decisions)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (path, sequence, signature, decisions);
        Err("当前平台暂不支持处理粘贴重名".into())
    }
}

#[cfg(windows)]
mod windows_paste {
    use super::{Choice, PasteConflict, PasteDecision, PasteOutcome};
    use crate::local_explorer::validate_file_path;
    use crate::workspace_folder_move::{link_or_reparse, rename_no_replace};
    use same_file::Handle;
    use sha2::{Digest, Sha256};
    use std::{
        collections::{HashMap, HashSet},
        ffi::OsStr,
        fs::{self, File, Metadata},
        io::ErrorKind,
        os::windows::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
        path::{Path, PathBuf},
    };
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                CopyFileW, FileCaseSensitiveInfo, GetFileInformationByHandleEx, SetFileAttributesW,
                FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_OFFLINE,
                FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
                FILE_ATTRIBUTE_SYSTEM, FILE_CASE_SENSITIVE_INFO, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            },
        },
    };

    const MAX_FILES: usize = 128;
    const MAX_SUFFIX: usize = 250;

    struct Item {
        path: PathBuf,
        name: String,
        size: u64,
        modified: Option<std::time::SystemTime>,
    }

    pub(super) struct Plan {
        destination: PathBuf,
        identity: Handle,
        entries: Vec<Item>,
        pub(super) signature: String,
        pub(super) conflicts: Vec<PasteConflict>,
    }

    fn kind(name: &str) -> &'static str {
        let extension = Path::new(name)
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        match extension.as_str() {
            "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "exr" | "hdr"
            | "psd" => "image",
            "mp4" | "mov" | "mkv" | "avi" | "m4v" | "webm" | "mxf" => "video",
            "wav" | "mp3" | "aiff" | "flac" | "aac" | "ogg" | "m4a" => "audio",
            "c4d" | "hip" | "hiplc" | "hipnc" | "blend" | "prproj" | "aep" | "max" | "ma"
            | "mb" => "project",
            _ => "other",
        }
    }

    fn ordinary(metadata: &Metadata) -> bool {
        !link_or_reparse(metadata)
            && metadata.file_attributes()
                & (FILE_ATTRIBUTE_SYSTEM.0
                    | FILE_ATTRIBUTE_OFFLINE.0
                    | FILE_ATTRIBUTE_RECALL_ON_OPEN.0
                    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0)
                == 0
    }

    fn exists(path: &Path) -> Result<Option<Metadata>, String> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => Ok(Some(metadata)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("无法核对「{}」：{error}", path.display())),
        }
    }

    fn case_sensitive(path: &Path) -> bool {
        let Ok(directory) = File::options()
            .access_mode(FILE_READ_ATTRIBUTES.0)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)
        else {
            return false;
        };
        let mut info = FILE_CASE_SENSITIVE_INFO::default();
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(directory.as_raw_handle()),
                FileCaseSensitiveInfo,
                (&raw mut info).cast(),
                size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
            )
        }
        .is_ok()
            && info.Flags & 1 != 0
    }

    fn alternate(
        destination: &Path,
        name: &str,
        reserved: &mut HashSet<String>,
        key: &impl Fn(&str) -> String,
    ) -> Result<Option<String>, String> {
        let path = Path::new(name);
        let stem = path.file_stem().and_then(OsStr::to_str).unwrap_or(name);
        let extension = path
            .extension()
            .and_then(OsStr::to_str)
            .map_or(String::new(), |ext| format!(".{ext}"));
        for number in 2..=MAX_SUFFIX {
            let suffix = format!(" ({number}){extension}");
            let maximum = 255usize.saturating_sub(suffix.encode_utf16().count());
            if maximum == 0 {
                return Ok(None);
            }
            let mut length = 0;
            let base: String = stem
                .chars()
                .take_while(|value| {
                    length += value.len_utf16();
                    length <= maximum
                })
                .collect();
            let candidate = format!("{base}{suffix}");
            let canonical = key(&candidate);
            if !reserved.contains(&canonical) && exists(&destination.join(&candidate))?.is_none() {
                reserved.insert(canonical);
                return Ok(Some(candidate));
            }
        }
        Ok(None)
    }

    pub(super) fn inspect(
        path: &str,
        paths: Vec<String>,
        moved: bool,
    ) -> Result<Option<Plan>, String> {
        if moved || paths.is_empty() || paths.len() > MAX_FILES {
            return Ok(None);
        }
        let destination = PathBuf::from(path);
        validate_file_path(&destination)?;
        let metadata = fs::symlink_metadata(&destination)
            .map_err(|error| format!("无法读取目标文件夹：{error}"))?;
        if !metadata.is_dir() || !ordinary(&metadata) {
            return Ok(None);
        }
        let identity = Handle::from_path(&destination)
            .map_err(|error| format!("无法核对目标文件夹：{error}"))?;
        let destination = fs::canonicalize(destination)
            .map_err(|error| format!("无法读取目标文件夹：{error}"))?;
        let case_sensitive = case_sensitive(&destination);
        let key = |name: &str| {
            if case_sensitive {
                name.to_owned()
            } else {
                name.to_lowercase()
            }
        };
        let mut entries = Vec::with_capacity(paths.len());
        let mut seen = HashSet::new();
        for path in paths {
            let path = PathBuf::from(path);
            validate_file_path(&path)?;
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("无法读取源文件「{}」：{error}", path.display()))?;
            if !metadata.is_file() || !ordinary(&metadata) {
                return Ok(None);
            }
            let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                return Ok(None);
            };
            if name.ends_with(['.', ' ']) {
                return Ok(None);
            }
            if seen.insert(path.clone()) {
                entries.push(Item {
                    name: name.to_owned(),
                    path,
                    size: metadata.len(),
                    modified: metadata.modified().ok(),
                });
            }
        }
        let mut conflicts = Vec::new();
        let mut used = HashSet::new();
        let mut reserved = entries.iter().map(|entry| key(&entry.name)).collect();
        let mut facts = Vec::with_capacity(entries.len());
        for (index, item) in entries.iter().enumerate() {
            let target = destination.join(&item.name);
            let existing = exists(&target)?;
            let duplicate = !used.insert(key(&item.name));
            let stamp = existing.as_ref().and_then(|meta| meta.modified().ok());
            facts.push((&item.path, item.size, item.modified, stamp));
            if existing.is_some() || duplicate {
                let Some(suggested_name) =
                    alternate(&destination, &item.name, &mut reserved, &key)?
                else {
                    return Ok(None);
                };
                conflicts.push(PasteConflict {
                    index,
                    source: item.path.to_string_lossy().into_owned(),
                    name: item.name.clone(),
                    blocking_path: existing
                        .as_ref()
                        .map(|_| target.to_string_lossy().into_owned()),
                    blocking_size: existing
                        .as_ref()
                        .filter(|meta| meta.is_file())
                        .map(Metadata::len),
                    blocking_directory: existing.as_ref().is_some_and(Metadata::is_dir),
                    source_size: item.size,
                    suggested_name,
                    kind: kind(&item.name),
                });
            }
        }
        let state = serde_json::to_vec(&(path, &destination, case_sensitive, facts, &conflicts))
            .map_err(|_| "无法计算粘贴状态")?;
        let signature = Sha256::digest(state)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Some(Plan {
            destination,
            identity,
            entries,
            signature,
            conflicts,
        }))
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }

    fn copy_file(plan: &Plan, item: &Item, target: &Path, staging: &Path) -> Result<(), String> {
        let metadata =
            fs::symlink_metadata(&item.path).map_err(|error| format!("源文件不可用（{error}）"))?;
        if !metadata.is_file()
            || !ordinary(&metadata)
            || metadata.len() != item.size
            || metadata.modified().ok() != item.modified
        {
            return Err("源文件已变化，请重新粘贴".into());
        }
        let source = wide(&item.path);
        let stage = wide(staging);
        let result = (|| {
            unsafe { CopyFileW(PCWSTR(source.as_ptr()), PCWSTR(stage.as_ptr()), true) }
                .map_err(|error| format!("无法复制（{error}）"))?;
            if !Handle::from_path(&plan.destination).is_ok_and(|current| current == plan.identity) {
                return Err("目标文件夹已变化".into());
            }
            rename_no_replace(staging, target)
                .map_err(|error| format!("未能以所选名称保存（{error}）"))
        })();
        if result.is_err() && staging.is_file() {
            let _ = unsafe { SetFileAttributesW(PCWSTR(stage.as_ptr()), FILE_ATTRIBUTE_NORMAL) };
            let _ = fs::remove_file(staging);
        }
        result
    }

    pub(super) fn commit(
        plan: Plan,
        decisions: Vec<PasteDecision>,
    ) -> Result<PasteOutcome, String> {
        if plan.conflicts.is_empty() || decisions.len() != plan.conflicts.len() {
            return Err("请确认每个重名项目的处理方式".into());
        }
        let decisions: HashMap<_, _> = decisions
            .into_iter()
            .map(|decision| (decision.index, decision.choice))
            .collect();
        if plan
            .conflicts
            .iter()
            .any(|entry| !decisions.contains_key(&entry.index))
        {
            return Err("重名处理范围已变化，请重新粘贴".into());
        }
        let conflicts: HashMap<_, _> = plan
            .conflicts
            .iter()
            .map(|entry| (entry.index, entry))
            .collect();
        if !Handle::from_path(&plan.destination).is_ok_and(|current| current == plan.identity) {
            return Err("目标文件夹已变化，请重新粘贴".into());
        }
        if plan.entries.len() == decisions.len()
            && decisions
                .values()
                .all(|choice| matches!(choice, Choice::Skip))
        {
            return Ok(PasteOutcome {
                skipped: decisions.len(),
                ..Default::default()
            });
        }
        let staging = tempfile::Builder::new()
            .prefix(".nexus-paste-")
            .tempdir_in(&plan.destination)
            .map_err(|error| format!("无法在目标文件夹中准备粘贴（{error}）"))?;
        let staging_name = wide(staging.path());
        let _ = unsafe { SetFileAttributesW(PCWSTR(staging_name.as_ptr()), FILE_ATTRIBUTE_HIDDEN) };
        let mut outcome = PasteOutcome::default();
        for (index, item) in plan.entries.iter().enumerate() {
            let name = match decisions.get(&index) {
                Some(Choice::Skip) => {
                    outcome.skipped += 1;
                    continue;
                }
                Some(Choice::KeepBoth) => &conflicts[&index].suggested_name,
                None => &item.name,
            };
            let target = plan.destination.join(name);
            if let Err(error) = copy_file(
                &plan,
                item,
                &target,
                &staging.path().join(index.to_string()),
            ) {
                outcome.errors.push(format!("{name}：{error}"));
            } else {
                outcome.copied += 1;
            }
        }
        Ok(outcome)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn text(path: &Path) -> String {
            path.to_string_lossy().into_owned()
        }

        #[test]
        fn chooses_names_before_copy_and_skips_existing_without_replacement() {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("input");
            let other = temp.path().join("other");
            let target = temp.path().join("target");
            for path in [&source, &other, &target] {
                fs::create_dir(path).unwrap();
            }
            fs::write(target.join("镜头.exr"), b"keep").unwrap();
            fs::write(source.join("镜头.exr"), b"new").unwrap();
            fs::write(source.join("fresh.wav"), b"one").unwrap();
            fs::write(other.join("fresh.wav"), b"two").unwrap();
            let paths = vec![
                text(&source.join("镜头.exr")),
                text(&source.join("fresh.wav")),
                text(&other.join("fresh.wav")),
            ];
            let plan = inspect(&text(&target), paths.clone(), false)
                .unwrap()
                .unwrap();
            assert_eq!(plan.conflicts.len(), 2);
            assert_eq!(plan.conflicts[0].suggested_name, "镜头 (2).exr");
            assert_eq!(plan.conflicts[1].kind, "audio");
            assert!(plan.conflicts[1].blocking_path.is_none());
            let outcome = commit(
                plan,
                vec![
                    PasteDecision {
                        index: 0,
                        choice: Choice::KeepBoth,
                    },
                    PasteDecision {
                        index: 2,
                        choice: Choice::Skip,
                    },
                ],
            )
            .unwrap();
            assert_eq!(
                (outcome.copied, outcome.skipped, outcome.errors.len()),
                (2, 1, 0)
            );
            assert_eq!(fs::read(target.join("镜头.exr")).unwrap(), b"keep");
            assert_eq!(fs::read(target.join("镜头 (2).exr")).unwrap(), b"new");
            assert_eq!(fs::read(target.join("fresh.wav")).unwrap(), b"one");
            assert_eq!(fs::read(other.join("fresh.wav")).unwrap(), b"two");
            assert!(inspect(&text(&target), paths, true).unwrap().is_none());
        }

        #[test]
        fn racing_destination_is_never_replaced() {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("input");
            let target = temp.path().join("target");
            fs::create_dir(&source).unwrap();
            fs::create_dir(&target).unwrap();
            fs::write(source.join("same.jpg"), b"source").unwrap();
            fs::write(target.join("same.jpg"), b"original").unwrap();
            let paths = vec![text(&source.join("same.jpg"))];
            let plan = inspect(&text(&target), paths.clone(), false)
                .unwrap()
                .unwrap();
            let signature = plan.signature.clone();
            fs::write(target.join("same (2).jpg"), b"external").unwrap();
            assert_ne!(
                inspect(&text(&target), paths, false)
                    .unwrap()
                    .unwrap()
                    .signature,
                signature
            );
            let outcome = commit(
                plan,
                vec![PasteDecision {
                    index: 0,
                    choice: Choice::KeepBoth,
                }],
            )
            .unwrap();
            assert_eq!((outcome.copied, outcome.errors.len()), (0, 1));
            assert_eq!(fs::read(target.join("same (2).jpg")).unwrap(), b"external");
        }
    }
}
