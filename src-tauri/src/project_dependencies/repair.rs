use super::{
    buffer_length, canonical_regular_file, image_media_type, project_path, read_manifest,
    reference_status, regular_file, relative_uri_path, rows, sibling_uri, temporary_root,
    validate_image, validate_local_path, within_temporary, DependencyKind, DependencyStatus, KINDS,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsStr,
    fs::{self, Metadata},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 2400;
const MAX_FOLDERS: usize = 64;
const MAX_PENDING_REFERENCES: usize = 64;
const MAX_RESULTS: usize = 4;
const MAX_VALIDATIONS: usize = 400;
static SEARCH_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Serialize)]
pub(crate) struct ReplacementPreview {
    pub(super) path: String,
    pub(super) uri: String,
    pub(super) stamp: String,
    evidence: Vec<&'static str>,
    temporary: bool,
}

#[derive(Serialize)]
struct Suggestions {
    kind: DependencyKind,
    index: usize,
    choices: Vec<ReplacementPreview>,
}

#[derive(Serialize)]
pub(crate) struct ReplacementSuggestions {
    groups: Vec<Suggestions>,
    truncated: bool,
}

pub(super) fn file_stamp(metadata: &Metadata) -> Result<String, String> {
    let modified = metadata
        .modified()
        .map_err(|error| format!("无法读取候选文件修改时间（{error}）"))?;
    Ok(format!(
        "{}:{modified:?}:{:?}",
        metadata.len(),
        metadata.created().ok()
    ))
}

pub(super) fn validate_candidate(
    kind: DependencyKind,
    entry: &Value,
    directory: &Path,
    replacement: &Path,
    require_exact: bool,
    temporary_root: Option<&Path>,
) -> Result<ReplacementPreview, String> {
    let original = entry
        .get("uri")
        .and_then(Value::as_str)
        .and_then(|uri| relative_uri_path(directory, uri))
        .ok_or("只支持替换本机相对路径引用的依赖")?;
    let path = canonical_regular_file(replacement)?;
    let uri = sibling_uri(directory, &path)?;
    let metadata = regular_file(&path).map_err(|error| error.to_string())?;
    let stamp = file_stamp(&metadata)?;
    let same_name = original
        .file_name()
        .zip(path.file_name())
        .is_some_and(|(before, after)| candidate_name(before) == candidate_name(after));
    let mut evidence = Vec::new();
    if same_name {
        evidence.push("文件名相同");
    }
    match kind {
        DependencyKind::Buffer => {
            let length = buffer_length(entry).ok_or("原缓冲区未声明有效的 byteLength")?;
            if metadata.len() < length || require_exact && metadata.len() != length {
                return Err("替换缓冲区字节数与工程要求不兼容".into());
            }
            evidence.push(if metadata.len() == length {
                "声明与实际字节数相同"
            } else {
                "满足声明字节数"
            });
        }
        DependencyKind::Image => {
            validate_image(
                &path,
                entry
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .or_else(|| image_media_type(&original)),
            )?;
            evidence.push("贴图格式和文件头一致");
        }
    }
    if file_stamp(&regular_file(&path).map_err(|error| error.to_string())?)? != stamp {
        return Err("候选文件已变化，请重新选择".into());
    }
    Ok(ReplacementPreview {
        path: nexus_core::clean_path(&path),
        uri,
        stamp,
        evidence,
        temporary: within_temporary(&path, temporary_root),
    })
}

fn candidate_name(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.into_owned()
    }
}

fn manifest_for(path: &Path, revision: &str) -> Result<(PathBuf, Value), String> {
    let path = project_path(path)?;
    let (manifest, current) = read_manifest(&path)?;
    if current != revision {
        return Err("原工程已改变，请重新检查依赖".into());
    }
    Ok((path, manifest))
}

fn suggest(path: &Path, revision: &str, folder: &Path) -> Result<ReplacementSuggestions, String> {
    let (path, manifest) = manifest_for(path, revision)?;
    let directory = path.parent().ok_or("工程没有有效的父目录")?;
    validate_local_path(folder)?;
    if !crate::asset_availability::real_relink_directory(folder)? {
        return Err("候选文件夹不可访问".into());
    }
    let folder = PathBuf::from(nexus_core::clean_path(
        &fs::canonicalize(folder).map_err(|error| error.to_string())?,
    ));
    sibling_uri(directory, &folder.join("dependency-candidate"))?;
    let mut pending = HashMap::<String, Vec<_>>::new();
    let mut groups = Vec::new();
    let mut truncated = false;
    for kind in KINDS {
        for (index, entry) in rows(&manifest, kind)?.iter().enumerate() {
            let Some(target) = entry
                .get("uri")
                .and_then(Value::as_str)
                .and_then(|uri| relative_uri_path(directory, uri))
            else {
                continue;
            };
            if !matches!(
                reference_status(kind, entry, &target).0,
                DependencyStatus::Missing | DependencyStatus::Incompatible
            ) {
                continue;
            }
            let Some(basename) = target.file_name() else {
                continue;
            };
            if groups.len() >= MAX_PENDING_REFERENCES {
                truncated = true;
                break;
            }
            pending
                .entry(candidate_name(basename))
                .or_default()
                .push((groups.len(), entry));
            groups.push(Suggestions {
                kind,
                index,
                choices: Vec::new(),
            });
        }
    }
    if pending.is_empty() {
        return Ok(ReplacementSuggestions { groups, truncated });
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut visited_folders = 0;
    let mut visited_entries = 0;
    let mut validations = 0;
    let mut folders = VecDeque::from([(folder, 0)]);
    let temp = temporary_root();
    'search: while let Some((folder, depth)) = folders.pop_front() {
        if Instant::now() >= deadline || visited_folders >= MAX_FOLDERS {
            truncated = true;
            break;
        }
        visited_folders += 1;
        if !crate::asset_availability::real_relink_directory(&folder).unwrap_or(false) {
            truncated = true;
            continue;
        }
        let Ok(entries) = fs::read_dir(&folder) else {
            truncated = true;
            continue;
        };
        for entry in entries {
            if Instant::now() >= deadline || visited_entries >= MAX_ENTRIES {
                truncated = true;
                break 'search;
            }
            visited_entries += 1;
            let Ok(entry) = entry else { continue };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < 3 && visited_folders + folders.len() < MAX_FOLDERS {
                    folders.push_back((entry.path(), depth + 1));
                } else {
                    truncated = true;
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let Some(requests) = pending.get(&candidate_name(&entry.file_name())) else {
                continue;
            };
            for &(group, original) in requests {
                let group = &mut groups[group];
                if group.choices.len() >= MAX_RESULTS {
                    truncated = true;
                    continue;
                }
                if validations >= MAX_VALIDATIONS {
                    truncated = true;
                    break 'search;
                }
                validations += 1;
                if let Ok(candidate) = validate_candidate(
                    group.kind,
                    original,
                    directory,
                    &entry.path(),
                    true,
                    temp.as_deref(),
                ) {
                    group.choices.push(candidate);
                }
            }
        }
    }
    for group in &mut groups {
        group.choices.sort_by(|a, b| {
            a.temporary
                .cmp(&b.temporary)
                .then_with(|| a.path.cmp(&b.path))
        });
    }
    groups.retain(|group| !group.choices.is_empty());
    Ok(ReplacementSuggestions { groups, truncated })
}

#[tauri::command]
pub(crate) async fn suggest_project_dependency_replacements(
    path: PathBuf,
    revision: String,
    folder: PathBuf,
) -> Result<ReplacementSuggestions, String> {
    let _search = SEARCH_SLOT
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || suggest(&path, &revision, &folder))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn preview_project_dependency_replacement(
    path: PathBuf,
    revision: String,
    kind: DependencyKind,
    index: usize,
    replacement_path: PathBuf,
) -> Result<ReplacementPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, manifest) = manifest_for(&path, &revision)?;
        let entry = rows(&manifest, kind)?
            .get(index)
            .ok_or("选中的依赖条目不存在")?;
        let directory = path.parent().ok_or("工程没有有效的父目录")?;
        let temp = temporary_root();
        validate_candidate(
            kind,
            entry,
            directory,
            &replacement_path,
            false,
            temp.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_dependencies::{inspect, write_copy, DependencyReplacement};
    use serde_json::json;

    #[test]
    fn suggests_only_compatible_exact_names_and_requires_selected_files_to_stay_current() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let project = root.join("scene.gltf");
        let candidates = root.join("backup");
        for folder in ["release A", "release B", "invalid"] {
            fs::create_dir_all(candidates.join(folder)).unwrap();
        }
        fs::write(candidates.join("release A/mesh.bin"), b"1234").unwrap();
        fs::write(candidates.join("release B/mesh.bin"), b"abcd").unwrap();
        fs::write(candidates.join("invalid/mesh.bin"), b"12345").unwrap();
        fs::write(
            candidates.join("release A/diffuse.png"),
            b"\x89PNG\r\n\x1a\nABCD",
        )
        .unwrap();
        fs::write(candidates.join("invalid/diffuse.png"), b"bad header").unwrap();
        let original = json!({
            "asset":{"version":"2.0"},
            "extensionsRequired":["KHR_texture_transform"],
            "buffers":[{"uri":"old/mesh.bin","byteLength":4}],
            "images":[{"uri":"old/diffuse.png","mimeType":"image/png"}]
        });
        fs::write(&project, serde_json::to_vec(&original).unwrap()).unwrap();
        let inspection = inspect(&project).unwrap();
        assert_eq!(inspection.required_extensions, ["KHR_texture_transform"]);
        let report = suggest(&project, &inspection.revision, &candidates).unwrap();
        assert!(!report.truncated);
        assert_eq!(report.groups.len(), 2);
        let buffer = &report.groups[0];
        assert_eq!(buffer.choices.len(), 2);
        let image = &report.groups[1];
        assert_eq!(image.choices.len(), 1);
        let planned = &buffer.choices[0];
        assert_eq!(planned.uri, "backup/release%20A/mesh.bin");
        assert_eq!(planned.evidence, ["文件名相同", "声明与实际字节数相同"]);
        let change = || DependencyReplacement {
            kind: DependencyKind::Buffer,
            index: 0,
            path: PathBuf::from(&planned.path),
            stamp: Some(planned.stamp.clone()),
        };
        fs::write(&planned.path, b"123456").unwrap();
        assert!(write_copy(&project, &inspection.revision, "stale.gltf", vec![change()]).is_err());
        assert!(!root.join("stale.gltf").exists());
        let alternative = &buffer.choices[1];
        let accepted = DependencyReplacement {
            kind: DependencyKind::Buffer,
            index: 0,
            path: PathBuf::from(&alternative.path),
            stamp: Some(alternative.stamp.clone()),
        };
        let result =
            write_copy(&project, &inspection.revision, "fixed.gltf", vec![accepted]).unwrap();
        let rewritten = read_manifest(Path::new(&result.path)).unwrap().0;
        assert_eq!(
            rewritten["buffers"][0]["uri"],
            "backup/release%20B/mesh.bin"
        );
        assert_eq!(rewritten["images"], original["images"]);
        assert_eq!(read_manifest(&project).unwrap().0, original);
    }

    #[test]
    fn detects_minimum_version_bad_header_and_actual_temp_directory() {
        let fixture = tempfile::tempdir().unwrap();
        let project = fixture.path().join("scene.gltf");
        let reference = fixture.path().join("bad.png");
        fs::write(&reference, b"wrong encoding").unwrap();
        let mut document = json!({
            "asset":{"version":"2.0","minVersion":"2.1"},
            "images":[{"uri":"bad.png","mimeType":"image/png"}]
        });
        fs::write(&project, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(inspect(&project).err().unwrap().contains("2.1"));
        document["asset"]["minVersion"] = json!("2.0");
        fs::write(&project, serde_json::to_vec(&document).unwrap()).unwrap();
        let report = serde_json::to_value(inspect(&project).unwrap()).unwrap();
        assert_eq!(report["references"][0]["status"], "incompatible");
        assert_eq!(report["references"][0]["temporary"], true);
    }
}
