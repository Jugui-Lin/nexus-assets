use nexus_core::clean_path;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs::{self, File, Metadata},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REFERENCES: usize = 1024;
const MAX_URI_BYTES: usize = 4096;
pub(crate) mod repair;

#[derive(Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DependencyKind {
    Buffer,
    Image,
}

impl DependencyKind {
    fn field(self) -> &'static str {
        match self {
            Self::Buffer => "buffers",
            Self::Image => "images",
        }
    }
}

const KINDS: [DependencyKind; 2] = [DependencyKind::Buffer, DependencyKind::Image];

#[derive(Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DependencyStatus {
    Available,
    Missing,
    Unavailable,
    Embedded,
    Unsupported,
    Incompatible,
    Unverified,
}

#[derive(Serialize)]
struct DependencyReference {
    kind: DependencyKind,
    index: usize,
    uri: String,
    status: DependencyStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    temporary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDependencies {
    revision: String,
    references: Vec<DependencyReference>,
    required_extensions: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct DependencyReplacement {
    kind: DependencyKind,
    index: usize,
    path: PathBuf,
    stamp: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct DependencyCopy {
    path: String,
    updated: usize,
}

fn is_gltf(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("gltf"))
}

#[cfg(windows)]
fn local_drive(path: &Path) -> bool {
    use std::path::Prefix;
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    let (Prefix::Disk(letter) | Prefix::VerbatimDisk(letter)) = prefix.kind() else {
        return false;
    };
    crate::folder_browser::windows_drive_kind(&[
        u16::from(letter),
        u16::from(b':'),
        u16::from(b'\\'),
        0,
    ]) == "fixed"
}

#[cfg(not(windows))]
fn local_drive(_path: &Path) -> bool {
    true
}

fn validate_local_path(path: &Path) -> Result<(), String> {
    crate::local_explorer::validate_file_path(path)?;
    if !path.is_absolute()
        || path.components().any(|part| part == Component::ParentDir)
        || !local_drive(path)
    {
        return Err("请选择本机固定磁盘上的完整文件路径".into());
    }
    Ok(())
}

fn regular_file(path: &Path) -> io::Result<Metadata> {
    let ancestors: Vec<_> = path.ancestors().collect();
    for part in ancestors.into_iter().rev() {
        let metadata = fs::symlink_metadata(part)?;
        if crate::workspace_folder_move::link_or_reparse(&metadata) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "路径含符号链接或重分析点",
            ));
        }
        if part == path && metadata.is_file() {
            return Ok(metadata);
        }
        if !metadata.is_dir() || part == path {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "不是普通文件"));
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "找不到文件"))
}

fn canonical_regular_file(path: &Path) -> Result<PathBuf, String> {
    validate_local_path(path)?;
    regular_file(path).map_err(|error| format!("无法访问文件（{error}）"))?;
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("无法确认文件位置（{error}）"))?;
    Ok(PathBuf::from(clean_path(&canonical)))
}

fn project_path(path: &Path) -> Result<PathBuf, String> {
    if !is_gltf(path) {
        return Err("只支持 glTF 2.0 的 .gltf 文本工程".into());
    }
    canonical_regular_file(path)
}

fn version_bytes(path: &Path) -> Result<(Vec<u8>, String), String> {
    regular_file(path).map_err(|error| format!("无法读取工程文件（{error}）"))?;
    let file = File::open(path).map_err(|error| format!("无法打开工程文件（{error}）"))?;
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取工程文件（{error}）"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("工程 JSON 超过 16 MB，无法查找或改写依赖".into());
    }
    let revision = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((bytes, revision))
}

fn rows(document: &Value, kind: DependencyKind) -> Result<&[Value], String> {
    document.get(kind.field()).map_or(Ok(&[]), |value| {
        value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| format!("glTF 的 {} 字段应为数组", kind.field()))
    })
}

fn read_manifest(path: &Path) -> Result<(Value, String), String> {
    let (bytes, revision) = version_bytes(path)?;
    // Accept files exported with a BOM. Copies are written as plain UTF-8 JSON.
    let json = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let document: Value = serde_json::from_slice(json)
        .map_err(|error| format!("无法解析 glTF 工程 JSON（{error}）"))?;
    if document.pointer("/asset/version").and_then(Value::as_str) != Some("2.0") {
        return Err("此工程未声明为 glTF 2.0".into());
    }
    if let Some(minimum) = document.pointer("/asset/minVersion") {
        let version = minimum
            .as_str()
            .and_then(|value| value.split_once('.'))
            .and_then(|(major, minor)| {
                Some((major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?))
            })
            .ok_or("工程声明了无效的 glTF 最低版本")?;
        if version > (2, 0) {
            return Err(format!(
                "工程要求 glTF {}.{}，此工具支持 glTF 2.0",
                version.0, version.1
            ));
        }
    }
    let mut count = 0;
    for kind in KINDS {
        let entries = rows(&document, kind)?;
        count += entries.len();
        if count > MAX_REFERENCES {
            return Err("工程的缓冲区和图片依赖超过 1024 项".into());
        }
        if entries.iter().any(|entry| !entry.is_object()) {
            return Err(format!("glTF 的 {} 数组包含无效条目", kind.field()));
        }
    }
    Ok((document, revision))
}

fn decode_component(component: &str) -> Option<String> {
    let mut output = Vec::with_capacity(component.len());
    let mut bytes = component.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = char::from(bytes.next()?).to_digit(16)?;
            let low = char::from(bytes.next()?).to_digit(16)?;
            output.push((high * 16 + low) as u8);
        } else {
            output.push(byte);
        }
    }
    String::from_utf8(output).ok()
}

fn relative_uri_path(parent: &Path, uri: &str) -> Option<PathBuf> {
    if uri.is_empty()
        || uri.len() > MAX_URI_BYTES
        || uri.starts_with('/')
        || uri.contains(['\\', ':', '?', '#'])
    {
        return None;
    }
    let mut path = parent.to_path_buf();
    for part in uri.split('/') {
        let decoded = decode_component(part)?;
        if decoded.contains(['/', '\\', ':']) || decoded.chars().any(char::is_control) {
            return None;
        }
        match decoded.as_str() {
            "" => return None,
            "." => {}
            ".." => {
                if !path.pop() {
                    return None;
                }
            }
            name => path.push(name),
        }
    }
    validate_local_path(&path).ok()?;
    Some(path)
}

fn sibling_uri(parent: &Path, replacement: &Path) -> Result<String, String> {
    let source: Vec<_> = parent.components().collect();
    let destination: Vec<_> = replacement.components().collect();
    let common = source
        .iter()
        .zip(&destination)
        .take_while(|(left, right)| left == right)
        .count();
    if common == 0
        || source[common..]
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("请选择与工程位于同一磁盘的依赖文件".into());
    }
    let mut uri = "../".repeat(source.len() - common);
    for (index, part) in destination[common..].iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err("无法生成安全的相对路径".into());
        };
        let name = name.to_str().ok_or("依赖文件名不是有效的 Unicode")?;
        if index > 0 {
            uri.push('/');
        }
        for byte in name.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                uri.push(char::from(byte));
            } else {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                uri.push('%');
                uri.push(char::from(HEX[(byte >> 4) as usize]));
                uri.push(char::from(HEX[(byte & 15) as usize]));
            }
        }
    }
    if relative_uri_path(parent, &uri).as_deref() != Some(replacement) {
        return Err("无法生成可解析的相对依赖路径".into());
    }
    Ok(uri)
}

fn buffer_length(entry: &Value) -> Option<u64> {
    entry
        .get("byteLength")
        .and_then(Value::as_u64)
        .filter(|&size| size > 0)
}

fn required_extensions(document: &Value) -> Result<Vec<String>, String> {
    let Some(field) = document.get("extensionsRequired") else {
        return Ok(Vec::new());
    };
    let items = field
        .as_array()
        .filter(|items| items.len() <= 64)
        .ok_or("工程的必需扩展列表无效或超过 64 项")?;
    items
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|value| {
                    !value.is_empty() && value.len() <= 120 && !value.chars().any(char::is_control)
                })
                .map(str::to_owned)
                .ok_or_else(|| "工程包含无效的必需扩展名称".to_owned())
        })
        .collect()
}

fn temporary_root() -> Option<PathBuf> {
    let raw = std::env::temp_dir();
    fs::canonicalize(&raw)
        .ok()
        .map(|path| PathBuf::from(clean_path(&path)))
        .or_else(|| raw.is_absolute().then_some(raw))
}

fn within_temporary(path: &Path, root: Option<&Path>) -> bool {
    let Some(root) = root else {
        return false;
    };
    if cfg!(windows) {
        let mut segments = path.components();
        root.components().all(|component| {
            segments.next().is_some_and(|part| {
                component.as_os_str().to_string_lossy().to_lowercase()
                    == part.as_os_str().to_string_lossy().to_lowercase()
            })
        })
    } else {
        path.starts_with(root)
    }
}

fn reference_status(
    kind: DependencyKind,
    entry: &Value,
    path: &Path,
) -> (DependencyStatus, Option<String>) {
    let metadata = match regular_file(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return (DependencyStatus::Missing, None)
        }
        Err(_) => {
            return (
                DependencyStatus::Unavailable,
                Some("文件不可读取，或路径经过链接".into()),
            )
        }
    };
    match kind {
        DependencyKind::Buffer => {
            let Some(length) = buffer_length(entry) else {
                return (
                    DependencyStatus::Incompatible,
                    Some("工程未声明有效的缓冲区长度".into()),
                );
            };
            if metadata.len() < length {
                return (
                    DependencyStatus::Incompatible,
                    Some(format!(
                        "实际 {} 字节，工程需要至少 {} 字节",
                        metadata.len(),
                        length
                    )),
                );
            }
        }
        DependencyKind::Image => {
            let media = entry
                .get("mimeType")
                .and_then(Value::as_str)
                .or_else(|| image_media_type(path));
            if !matches!(
                media,
                Some("image/png" | "image/jpeg" | "image/webp" | "image/ktx2")
            ) {
                return (
                    DependencyStatus::Unverified,
                    Some("可读取原文件，贴图格式需在相应工具中核对".into()),
                );
            }
            match image_signature(path, media.unwrap_or_default()) {
                Ok(true) => {}
                Ok(false) => {
                    return (
                        DependencyStatus::Incompatible,
                        Some("贴图文件内容与声明或扩展名不符".into()),
                    )
                }
                Err(_) => {
                    return (
                        DependencyStatus::Unavailable,
                        Some("无法读取贴图文件头".into()),
                    )
                }
            }
        }
    }
    (DependencyStatus::Available, None)
}

fn inspect(path: &Path) -> Result<ProjectDependencies, String> {
    let path = project_path(path)?;
    let parent = path.parent().ok_or("工程没有有效的父目录")?;
    let (document, revision) = read_manifest(&path)?;
    let required_extensions = required_extensions(&document)?;
    let temp = temporary_root();
    let mut references = Vec::new();
    for kind in KINDS {
        for (index, entry) in rows(&document, kind)?.iter().enumerate() {
            let uri = entry.get("uri").and_then(Value::as_str).unwrap_or("");
            let data = uri
                .get(..5)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"));
            let embedded = data
                || (kind == DependencyKind::Image
                    && uri.is_empty()
                    && entry.get("bufferView").and_then(Value::as_u64).is_some());
            let path = (!embedded)
                .then(|| relative_uri_path(parent, uri))
                .flatten();
            let (status, detail) = match path.as_ref() {
                Some(path) => reference_status(kind, entry, path),
                None if embedded => (DependencyStatus::Embedded, None),
                None => (DependencyStatus::Unsupported, None),
            };
            let visible_uri = if data {
                "data:"
            } else if uri.len() > MAX_URI_BYTES {
                "路径过长"
            } else {
                uri
            };
            let temporary = path
                .as_ref()
                .is_some_and(|path| within_temporary(path, temp.as_deref()));
            references.push(DependencyReference {
                kind,
                index,
                uri: visible_uri.to_owned(),
                status,
                path: path.as_deref().map(clean_path),
                detail,
                temporary,
            });
        }
    }
    Ok(ProjectDependencies {
        revision,
        references,
        required_extensions,
    })
}

fn image_media_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "ktx2" => Some("image/ktx2"),
        _ => None,
    }
}

fn validate_image(path: &Path, expected: Option<&str>) -> Result<(), String> {
    let media = image_media_type(path).ok_or("请选择 PNG、JPEG、WebP 或 KTX2 文件")?;
    if expected.is_some_and(|expected| expected != media) {
        return Err("替换贴图的格式须与原依赖一致".into());
    }
    if !image_signature(path, media).map_err(|error| format!("无法读取贴图文件头（{error}）"))?
    {
        return Err("贴图文件内容与扩展名不符".into());
    }
    Ok(())
}

fn image_signature(path: &Path, media: &str) -> io::Result<bool> {
    let mut header = Vec::new();
    File::open(path)?.take(12).read_to_end(&mut header)?;
    Ok(match media {
        "image/png" => header.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => header.starts_with(b"\xff\xd8\xff"),
        "image/webp" => header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP"),
        "image/ktx2" => header.starts_with(b"\xabKTX 20\xbb\r\n\x1a\n"),
        _ => false,
    })
}

fn sibling_output(parent: &Path, output_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(output_name);
    if path.file_name() != Some(OsStr::new(output_name))
        || !is_gltf(path)
        || output_name.encode_utf16().count() > 255
    {
        return Err("请输入带 .gltf 后缀的副本文件名，不能包含目录".into());
    }
    let output = parent.join(path);
    validate_local_path(&output)?;
    Ok(output)
}

fn same_path(left: &Path, right: &Path) -> bool {
    left == right
        || (cfg!(windows) && clean_path(left).to_lowercase() == clean_path(right).to_lowercase())
}

fn write_copy(
    path: &Path,
    revision: &str,
    output_name: &str,
    replacements: Vec<DependencyReplacement>,
) -> Result<DependencyCopy, String> {
    if replacements.is_empty() || replacements.len() > MAX_REFERENCES {
        return Err("请至少选择一项要替换的依赖".into());
    }
    let path = project_path(path)?;
    let parent = path.parent().ok_or("工程没有有效的父目录")?;
    let output = sibling_output(parent, output_name)?;
    let (mut document, current) = read_manifest(&path)?;
    if current != revision {
        return Err("原工程已改变，请重新检查依赖后再保存副本".into());
    }
    for kind in KINDS {
        for entry in rows(&document, kind)? {
            if entry
                .get("uri")
                .and_then(Value::as_str)
                .and_then(|uri| relative_uri_path(parent, uri))
                .is_some_and(|reference| same_path(&reference, &output))
            {
                return Err("副本名称与原工程的依赖路径冲突，请更换文件名".into());
            }
        }
    }
    let mut changed = HashSet::new();
    let mut checked_files = Vec::new();
    let temporary_root = temporary_root();
    for DependencyReplacement {
        kind,
        index,
        path: replacement,
        stamp,
    } in replacements
    {
        if !changed.insert((kind, index)) {
            return Err("同一依赖只能选择一个替换文件".into());
        }
        let entry = document
            .get_mut(kind.field())
            .and_then(Value::as_array_mut)
            .and_then(|rows| rows.get_mut(index))
            .ok_or("选中的依赖条目不存在")?;
        let candidate = repair::validate_candidate(
            kind,
            entry,
            parent,
            &replacement,
            false,
            temporary_root.as_deref(),
        )?;
        if let Some(expected) = stamp {
            if candidate.stamp != expected {
                return Err("已经检查的依赖文件发生变化，请重新选择".into());
            }
        }
        checked_files.push((PathBuf::from(candidate.path), candidate.stamp));
        entry["uri"] = Value::String(candidate.uri);
    }

    let bytes = serde_json::to_vec(&document).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("替换后的工程 JSON 超过 16 MB".into());
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法在工程目录写入副本（{error}）"))?;
    staged
        .write_all(&bytes)
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|error| format!("保存副本失败（{error}）"))?;
    if version_bytes(&path)?.1 != current {
        return Err("原工程已改变，请重新检查依赖后再保存副本".into());
    }
    for (file, stamp) in checked_files {
        if repair::file_stamp(&regular_file(&file).map_err(|error| error.to_string())?)? != stamp {
            return Err("依赖文件在保存时发生变化，请重新检查".into());
        }
    }
    staged.persist_noclobber(&output).map_err(|error| {
        if error.error.kind() == io::ErrorKind::AlreadyExists {
            "副本文件名已存在，请使用新名称".to_owned()
        } else {
            format!("保存副本失败（{}）", error.error)
        }
    })?;
    Ok(DependencyCopy {
        path: clean_path(&output),
        updated: changed.len(),
    })
}

#[tauri::command]
pub(crate) async fn inspect_project_dependencies(
    path: PathBuf,
) -> Result<ProjectDependencies, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn pick_project_dependency_file(
    window: tauri::WebviewWindow,
    project_path: PathBuf,
    gltf_only: Option<bool>,
    folder: Option<bool>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = self::project_path(&project_path)?;
        let picker = rfd::FileDialog::new()
            .set_parent(&window)
            .set_directory(path.parent().ok_or("工程没有有效的父目录")?);
        if folder == Some(true) {
            return Ok(picker
                .set_title("选择查找候选依赖的文件夹")
                .pick_folder()
                .as_deref()
                .map(clean_path));
        }
        let picker = if gltf_only == Some(true) {
            picker
                .set_title("选择参考 glTF 工程版本")
                .add_filter("glTF 工程", &["gltf"])
        } else {
            picker.set_title("选择依赖文件")
        };
        Ok(picker.pick_file().as_deref().map(clean_path))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn write_project_dependency_copy(
    path: PathBuf,
    revision: String,
    output_name: String,
    replacements: Vec<DependencyReplacement>,
) -> Result<DependencyCopy, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_copy(&path, &revision, &output_name, replacements)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_project(directory: &Path, document: &Value) -> PathBuf {
        let path = directory.join("scene.gltf");
        fs::write(&path, serde_json::to_vec(document).unwrap()).unwrap();
        path
    }

    fn buffer(index: usize, path: &Path) -> DependencyReplacement {
        DependencyReplacement {
            kind: DependencyKind::Buffer,
            index,
            path: path.to_owned(),
            stamp: None,
        }
    }

    #[test]
    fn inspection_classifies_local_embedded_and_unsupported_references() {
        let fixture = tempfile::tempdir().unwrap();
        fs::write(fixture.path().join("present buffer.bin"), b"1234").unwrap();
        fs::write(fixture.path().join("short.bin"), b"abc").unwrap();
        let path = make_project(
            fixture.path(),
            &json!({
                "asset": {"version": "2.0"},
                "buffers": [
                    {"uri": "present%20buffer.bin", "byteLength": 4},
                    {"uri": "gone.bin", "byteLength": 8},
                    {"uri": "short.bin", "byteLength": 14}
                ],
                "images": [
                    {"uri": "data:image/png;base64,secret"},
                    {"bufferView": 0, "mimeType": "image/png"},
                    {"uri": "https://unreachable.invalid/image.png"},
                    {"uri": "subdir%2Fimage.png"}
                ]
            }),
        );

        let result = serde_json::to_value(inspect(&path).unwrap()).unwrap();
        let references = result["references"].as_array().unwrap();
        let statuses: Vec<_> = references
            .iter()
            .map(|entry| entry["status"].as_str().unwrap())
            .collect();
        assert_eq!(
            statuses,
            [
                "available",
                "missing",
                "incompatible",
                "embedded",
                "embedded",
                "unsupported",
                "unsupported"
            ]
        );
        assert_eq!(references[0]["kind"], "buffer");
        assert_eq!(references[6]["kind"], "image");
        assert_eq!(references[6]["index"], 3);
        assert_eq!(references[3]["uri"], "data:");
        assert!(references[6].get("path").is_none());
    }

    #[test]
    fn copy_rewrites_only_selected_uris_and_preserves_original() {
        let fixture = tempfile::tempdir().unwrap();
        let projects = fixture.path().join("projects");
        let shared = fixture.path().join("shared");
        fs::create_dir(&projects).unwrap();
        fs::create_dir(&shared).unwrap();
        let replacement_buffer = shared.join("mesh 含#%.bin");
        fs::write(&replacement_buffer, b"12345").unwrap();
        let replacement_image = shared.join("面 #.png");
        fs::write(&replacement_image, b"\x89PNG\r\n\x1a\nABCD").unwrap();
        let before = json!({
            "asset": {"version": "2.0", "generator": "fixture"},
            "buffers": [
                {"uri": "leave.bin", "byteLength": 8},
                {"uri": "missing.bin", "byteLength": 4, "name": "keep this name"}
            ],
            "images": [{"uri": "missing.png", "mimeType": "image/png"}],
            "extras": {"editor": "fixture"}
        });
        let project = make_project(&projects, &before);
        let original = fs::read(&project).unwrap();
        let revision = inspect(&project).unwrap().revision;
        let result = write_copy(
            &project,
            &revision,
            "scene-copy.gltf",
            vec![
                buffer(1, &replacement_buffer),
                DependencyReplacement {
                    kind: DependencyKind::Image,
                    index: 0,
                    path: replacement_image.clone(),
                    stamp: None,
                },
            ],
        )
        .unwrap();

        assert_eq!(result.updated, 2);
        assert_eq!(Path::new(&result.path), projects.join("scene-copy.gltf"));
        let mut after = before;
        after["buffers"][1]["uri"] = json!("../shared/mesh%20%E5%90%AB%23%25.bin");
        after["images"][0]["uri"] = json!("../shared/%E9%9D%A2%20%23.png");
        assert_eq!(read_manifest(Path::new(&result.path)).unwrap().0, after);
        assert_eq!(fs::read(&project).unwrap(), original);
    }

    #[test]
    fn rejects_stale_invalid_and_colliding_saves_without_writes() {
        let fixture = tempfile::tempdir().unwrap();
        let project = make_project(
            fixture.path(),
            &json!({
                "asset": {"version": "2.0"},
                "buffers": [
                    {"uri": "missing.bin", "byteLength": 4},
                    {"uri": "data:application/octet-stream;base64,AA==", "byteLength": 1},
                    {"uri": "conflicting.gltf", "byteLength": 4}
                ]
            }),
        );
        let good = fixture.path().join("working.bin");
        let short = fixture.path().join("short.bin");
        let occupied = fixture.path().join("occupied.gltf");
        fs::write(&good, b"12345").unwrap();
        fs::write(&short, b"1").unwrap();
        fs::write(&occupied, b"keep").unwrap();
        let revision = inspect(&project).unwrap().revision;
        for name in [
            "../escape.gltf",
            "conflicting.gltf",
            "occupied.gltf",
            "scene.gltf",
        ] {
            assert!(write_copy(&project, &revision, name, vec![buffer(0, &good)]).is_err());
        }
        assert!(write_copy(&project, &revision, "copy.gltf", vec![buffer(1, &good)]).is_err());
        assert!(write_copy(&project, &revision, "copy.gltf", vec![buffer(0, &short)]).is_err());
        let mut newer = fs::read(&project).unwrap();
        newer.push(b'\n');
        fs::write(&project, &newer).unwrap();
        assert!(write_copy(&project, &revision, "copy.gltf", vec![buffer(0, &good)]).is_err());
        assert_eq!(fs::read(&occupied).unwrap(), b"keep");
        assert_eq!(fs::read(&project).unwrap(), newer);
        assert!(!fixture.path().join("copy.gltf").exists());
        assert!(!fixture.path().join("conflicting.gltf").exists());
    }
}
