use super::{
    asset_raster_preview_limit, preview_image_format, video_mime, Asset,
    MAX_PREVIEW_SOURCE_BYTES,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::{self, Cursor, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) mod raster;

pub const MAX_MESH_SOURCE_BYTES: u64 = 750_000;
pub const MAX_NATIVE_MESH_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const DEFAULT_SIZE: u32 = 256;
const MAX_SIZE: u32 = 1024;
const MAX_CACHED_BYTES: u64 = 8 * 1024 * 1024;
const CACHE_VERSION: &str = "nexus-thumbnails-v1";
const LEGACY_VIDEO_SIZES: [u32; 6] = [DEFAULT_SIZE, 512, 384, 768, 128, MAX_SIZE];

#[cfg(all(windows, feature = "desktop"))]
pub enum LocalCacheActivity<'a> {
    Read(&'a Metadata),
    Write,
}

#[cfg(all(windows, feature = "desktop"))]
type LocalCacheObserver = fn(&Path, LocalCacheActivity<'_>);

#[cfg(all(windows, feature = "desktop"))]
static LOCAL_CACHE_OBSERVER: std::sync::OnceLock<LocalCacheObserver> = std::sync::OnceLock::new();

#[cfg(all(windows, feature = "desktop"))]
pub fn observe_local_cache(observer: LocalCacheObserver) {
    let _ = LOCAL_CACHE_OBSERVER.set(observer);
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThumbnailState {
    Cached,
    Generated,
    Image,
    Mesh,
    Video,
    Unavailable,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailStatus {
    pub state: ThumbnailState,
    pub key: Option<String>,
}

impl ThumbnailStatus {
    fn unavailable() -> Self {
        Self {
            state: ThumbnailState::Unavailable,
            key: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ThumbnailFormat {
    Png,
    Svg,
    Mesh,
    Video,
    VideoSizeRecord,
    IndexRecord,
}

impl ThumbnailFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Svg => "svg",
            Self::Mesh | Self::Video => "webp",
            Self::VideoSizeRecord => "video-size",
            Self::IndexRecord => "preview",
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Svg => "image/svg+xml",
            Self::Mesh | Self::Video => "image/webp",
            Self::IndexRecord | Self::VideoSizeRecord => "application/octet-stream",
        }
    }

    fn rendered(self) -> bool {
        matches!(self, Self::Mesh | Self::Video)
    }
}

struct Source<'a> {
    path: &'a Path,
    extension: String,
    format: ThumbnailFormat,
    key: String,
    bytes: u64,
    stamp: i128,
    modified: Option<SystemTime>,
}

impl Source<'_> {
    fn target(&self, cache_dir: &Path) -> PathBuf {
        cache_dir.join(format!("{}.{}", self.key, self.format.extension()))
    }

    fn status(&self, state: ThumbnailState) -> ThumbnailStatus {
        ThumbnailStatus {
            state,
            key: Some(self.key.clone()),
        }
    }

    fn pending_status(&self) -> ThumbnailStatus {
        self.status(match self.format {
            ThumbnailFormat::Mesh => ThumbnailState::Mesh,
            ThumbnailFormat::Video => ThumbnailState::Video,
            _ => ThumbnailState::Image,
        })
    }
}

pub fn normalized_size(size: u32) -> u32 {
    if size == 0 {
        DEFAULT_SIZE
    } else {
        size.clamp(128, MAX_SIZE)
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub fn mesh_source_limit(extension: &str) -> Option<u64> {
    match extension {
        "obj" | "fbx" => Some(MAX_NATIVE_MESH_SOURCE_BYTES),
        "stl" | "ply" | "glb" | "gltf" => Some(MAX_MESH_SOURCE_BYTES),
        _ => None,
    }
}

fn source(asset: &Asset, size: u32) -> Result<Option<Source<'_>>, String> {
    let visual = if asset.kind == "texture" && asset.ext != "ies" {
        Some((Path::new(&asset.path), "texture"))
    } else {
        asset.thumbnail.as_deref().map(|path| {
            let role = if asset.kind == "cover" {
                "cover"
            } else {
                "sidecar"
            };
            (Path::new(path), role)
        })
    };
    if let Some((path, role)) = visual {
        let ext = extension(path);
        let format = if asset.demo && ext == "svg" {
            Some(ThumbnailFormat::Svg)
        } else {
            preview_image_format(&ext).then_some(ThumbnailFormat::Png)
        };
        if let Some(format) = format {
            let limit = asset_raster_preview_limit(&ext).unwrap_or(MAX_PREVIEW_SOURCE_BYTES);
            match fs::metadata(path) {
                Ok(meta) if meta.is_file() && meta.len() <= limit => {
                    return make_source(asset, path, role, ext, size, format, &meta).map(Some);
                }
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::NotFound && role != "texture" => {}
                Err(error) => return Err(format!("无法读取预览来源：{error}")),
            }
        }
    }

    let (role, format) = match asset.ext.as_str() {
        ext if asset.kind == "video" && video_mime(ext).is_some() => {
            ("video", ThumbnailFormat::Video)
        }
        ext if mesh_source_limit(ext).is_some() => ("mesh", ThumbnailFormat::Mesh),
        "c4d" => ("c4d-preview", ThumbnailFormat::Png),
        "ies" => ("ies-preview", ThumbnailFormat::Png),
        "max" => ("max-preview", ThumbnailFormat::Png),
        _ => return Ok(None),
    };
    let path = Path::new(&asset.path);
    let meta = fs::metadata(path).map_err(|error| format!("无法读取预览来源：{error}"))?;
    if !meta.is_file()
        || mesh_source_limit(&asset.ext).is_some_and(|limit| meta.len() > limit)
        || asset.ext == "ies" && meta.len() > crate::ies_preview::MAX_FILE_BYTES
    {
        return Ok(None);
    }
    make_source(asset, path, role, asset.ext.clone(), size, format, &meta).map(Some)
}

fn make_source<'a>(
    asset: &Asset,
    path: &'a Path,
    role: &str,
    extension: String,
    size: u32,
    format: ThumbnailFormat,
    meta: &Metadata,
) -> Result<Source<'a>, String> {
    // Local mount prefixes vary by computer. The asset ID and source basename
    // identify the same preview on each client.
    let mtime = meta
        .modified()
        .map_err(|error| format!("无法读取预览来源的修改时间：{error}"))?;
    let stamp = match mtime.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    };
    // SMB exposes Windows file times in 100 ns units. Custom covers are
    // replaced atomically and may change more than once in a millisecond.
    let stamp = if role == "cover" {
        stamp / 100
    } else {
        stamp / 1_000_000
    };
    let mut source =
        make_stamped_source(asset, path, role, extension, size, format, meta.len(), stamp);
    source.modified = Some(mtime);
    Ok(source)
}

fn make_stamped_source<'a>(
    asset: &Asset,
    path: &'a Path,
    role: &str,
    extension: String,
    size: u32,
    format: ThumbnailFormat,
    length: u64,
    stamp: i128,
) -> Source<'a> {
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let mut digest = Sha256::new();
    for field in [CACHE_VERSION, &asset.id, &file_name, role, &extension] {
        digest.update((field.len() as u64).to_le_bytes());
        digest.update(field.as_bytes());
    }
    if format == ThumbnailFormat::Mesh {
        digest.update(asset.color.as_deref().unwrap_or_default().as_bytes());
    }
    digest.update(length.to_le_bytes());
    digest.update(stamp.to_le_bytes());
    digest.update(size.to_le_bytes());
    let key = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Source {
        path,
        extension,
        format,
        key,
        bytes: length,
        stamp,
        modified: None,
    }
}

fn index_record(asset: &Asset, size: u32) -> Source<'_> {
    make_stamped_source(
        asset, Path::new(&asset.path), "indexed-preview", asset.ext.clone(), normalized_size(size),
        ThumbnailFormat::IndexRecord, asset.size, asset.modified.as_u64().unwrap_or(0).into(),
    )
}

pub fn read_indexed(asset: &Asset, dir: &Path, size: u32) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some(mut record) = read_cached(&index_record(asset, size), dir)? else { return Ok(None) };
    let mime = match record.pop() {
        Some(1) => "image/png",
        Some(2) => "image/webp",
        Some(3) if asset.demo => "image/svg+xml",
        _ => return Ok(None),
    };
    Ok((!record.is_empty()).then(|| (mime.into(), record)))
}

pub fn store_indexed(asset: &Asset, dir: &Path, size: u32, mime: &str, bytes: &[u8]) -> Result<(), String> {
    let tag = match mime {
        "image/png" => 1,
        "image/webp" => 2,
        "image/svg+xml" if asset.demo => 3,
        _ => return Ok(()),
    };
    let indexed = index_record(asset, size);
    let mut record = Vec::with_capacity(bytes.len() + 1);
    record.extend_from_slice(bytes);
    record.push(tag);
    if read_cached(&indexed, dir)?.as_deref() != Some(record.as_slice()) {
        write_cache(&indexed, dir, &record, true)?;
    }
    Ok(())
}

// Team file metadata is indexed in milliseconds, the precision the normal local
// cache uses for the original file. Cover and sidecar timestamps are separate.
pub fn read_team_original_from_index(asset: &Asset, dir: &Path, size: u32) -> Result<Option<(String, Vec<u8>)>, String> {
    let (role, format) = match asset.ext.as_str() {
        ext if asset.kind == "texture" && preview_image_format(ext) => ("texture", ThumbnailFormat::Png),
        ext if asset.kind == "video" && video_mime(ext).is_some() => ("video", ThumbnailFormat::Video),
        ext if mesh_source_limit(ext).is_some() => ("mesh", ThumbnailFormat::Mesh),
        "c4d" => ("c4d-preview", ThumbnailFormat::Png),
        "ies" => ("ies-preview", ThumbnailFormat::Png),
        "max" => ("max-preview", ThumbnailFormat::Png),
        _ => return Ok(None),
    };
    let selected = make_stamped_source(
        asset, Path::new(&asset.path), role, asset.ext.clone(), normalized_size(size), format,
        asset.size, asset.modified.as_u64().unwrap_or(0).into(),
    );
    Ok(read_cached(&selected, dir)?.map(|bytes| (format.mime().into(), bytes)))
}

fn video_size_record<'a>(asset: &Asset, selected: &Source<'a>) -> Source<'a> {
    make_stamped_source(asset, selected.path, "video-size", selected.extension.clone(), 0,
        ThumbnailFormat::VideoSizeRecord, selected.bytes, selected.stamp)
}

fn remember_video_size(asset: &Asset, selected: &Source<'_>, dir: &Path, size: u32) {
    let record = video_size_record(asset, selected);
    let size = (size as u16).to_le_bytes();
    if read_cached(&record, dir).ok().flatten().as_deref() != Some(&size) {
        let _ = write_cache(&record, dir, &size, true);
    }
}

pub struct CachedThumbnail {
    pub size: u32,
    pub mime: String,
    pub bytes: Vec<u8>,
}

pub fn read_with_video_fallback(
    asset: &Asset,
    dir: &Path,
    size: u32,
) -> Result<Option<CachedThumbnail>, String> {
    let size = normalized_size(size);
    let Some(selected) = source(asset, size)? else {
        return Ok(None);
    };
    let mime = selected.format.mime();
    if let Some(bytes) = read_cached(&selected, dir)? {
        return Ok(Some(CachedThumbnail {size, mime:mime.into(), bytes}));
    }
    if selected.format != ThumbnailFormat::Video || !cache_dir_exists(dir)? {
        return Ok(None);
    }
    let record = video_size_record(asset, &selected);
    let stored_size = read_cached(&record, dir)
        .ok()
        .flatten()
        .and_then(|bytes| <[u8; 2]>::try_from(bytes).ok())
        .map(|bytes| u32::from(u16::from_le_bytes(bytes)))
        .filter(|&length| (128..=MAX_SIZE).contains(&length));
    for alternate_size in stored_size.into_iter().chain(LEGACY_VIDEO_SIZES.into_iter().filter(|candidate| Some(*candidate) != stored_size)) {
        if alternate_size == size {
            continue;
        }
        let alternate = make_stamped_source(asset, selected.path, "video", selected.extension.clone(), alternate_size,
            ThumbnailFormat::Video, selected.bytes, selected.stamp);
        if let Ok(Some(bytes)) = read_cached(&alternate, dir) {
            return Ok(Some(CachedThumbnail {size:alternate_size, mime:mime.into(), bytes}));
        }
    }
    Ok(None)
}

fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

fn cache_dir_exists(dir: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() && !is_link(&meta) => Ok(true),
        Ok(_) => Err("缩略图缓存目录必须是普通文件夹".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法访问缩略图缓存目录：{error}")),
    }
}

fn cache_file_exists(source: &Source<'_>, dir: &Path) -> Result<bool, String> {
    if !cache_dir_exists(dir)? {
        return Ok(false);
    }
    match fs::symlink_metadata(source.target(dir)) {
        Ok(meta)
            if meta.is_file()
                && !is_link(&meta)
                && (1..=MAX_CACHED_BYTES).contains(&meta.len()) =>
        {
            Ok(true)
        }
        Ok(_) => Err("缩略图缓存文件无效".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法访问缩略图缓存：{error}")),
    }
}

fn bounded_read(file: File, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(io::Error::new(ErrorKind::InvalidData, "缩略图文件大小无效"));
    }
    Ok(bytes)
}

fn read_cached(source: &Source<'_>, dir: &Path) -> Result<Option<Vec<u8>>, String> {
    if !cache_file_exists(source, dir)? {
        return Ok(None);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let path = source.target(dir);
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取缩略图缓存：{error}")),
    };
    let meta = file.metadata().map_err(|error| error.to_string())?;
    let entry = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if is_link(&entry) || is_link(&meta) || !meta.is_file() {
        return Err("缩略图缓存文件无效".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (meta.dev(), meta.ino()) != (entry.dev(), entry.ino()) {
            return Err("缩略图缓存文件已更换".into());
        }
    }
    let limit = if source.format == ThumbnailFormat::VideoSizeRecord { 2 } else { MAX_CACHED_BYTES };
    let bytes = bounded_read(file, limit).map_err(|error| error.to_string())?;
    #[cfg(all(windows, feature = "desktop"))]
    if let Some(observer) = LOCAL_CACHE_OBSERVER.get() {
        observer(&path, LocalCacheActivity::Read(&meta));
    }
    Ok(Some(bytes))
}

fn save(source: &Source<'_>, dir: &Path, bytes: &[u8]) -> Result<ThumbnailState, String> {
    write_cache(source, dir, bytes, false)
}

fn write_cache(source: &Source<'_>, dir: &Path, bytes: &[u8], replace: bool) -> Result<ThumbnailState, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_CACHED_BYTES {
        return Err("缩略图文件大小无效".into());
    }
    if !cache_dir_exists(dir)? {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建缩略图缓存目录：{error}"))?;
    }
    if cache_file_exists(source, dir)? && !replace {
        return Ok(ThumbnailState::Cached);
    }
    let mut staging = tempfile::Builder::new()
        .prefix(".nexus-thumbnail-")
        .suffix(".tmp")
        .tempfile_in(dir)
        .map_err(|error| format!("无法新建缩略图缓存文件：{error}"))?;
    staging
        .write_all(bytes)
        .and_then(|()| staging.as_file().sync_all())
        .map_err(|error| format!("无法写入缩略图缓存：{error}"))?;
    let path = source.target(dir);
    let published = if replace {
        staging.persist(&path).map(|_| ThumbnailState::Generated)
            .map_err(|error| format!("无法发布缩略图缓存：{}", error.error))
    } else {
        match staging.persist_noclobber(&path) {
            Ok(_) => Ok(ThumbnailState::Generated),
            Err(error)
                if error.error.kind() == ErrorKind::AlreadyExists
                    && cache_file_exists(source, dir)? =>
            {
                Ok(ThumbnailState::Cached)
            }
            Err(error) => Err(format!("无法发布缩略图缓存：{}", error.error)),
        }
    };
    #[cfg(all(windows, feature = "desktop"))]
    if matches!(published, Ok(ThumbnailState::Generated)) {
        if let Some(observer) = LOCAL_CACHE_OBSERVER.get() {
            observer(&path, LocalCacheActivity::Write);
        }
    }
    published
}

fn confirm_source(asset: &Asset, selected: &Source<'_>, size: u32) -> Result<(), String> {
    if source(asset, size)?.is_some_and(|current| current.key == selected.key) {
        Ok(())
    } else {
        Err("预览来源已更新，请重新生成缩略图".into())
    }
}

fn create_image(source: &Source<'_>, size: u32) -> Result<Option<Vec<u8>>, String> {
    if source.format == ThumbnailFormat::Svg {
        File::open(source.path)
            .and_then(|file| bounded_read(file, MAX_CACHED_BYTES))
            .map(Some)
            .map_err(|error| format!("无法读取示例缩略图：{error}"))
    } else {
        raster::read(source.path, &source.extension, size, source.bytes, source.modified)
    }
}

pub fn inspect(asset: &Asset, dir: &Path, size: u32) -> Result<ThumbnailStatus, String> {
    let Some(selected) = source(asset, normalized_size(size))? else {
        return Ok(ThumbnailStatus::unavailable());
    };
    Ok(if cache_file_exists(&selected, dir)? {
        selected.status(ThumbnailState::Cached)
    } else {
        selected.pending_status()
    })
}

pub fn generate(asset: &Asset, dir: &Path, size: u32) -> Result<ThumbnailStatus, String> {
    let size = normalized_size(size);
    let Some(selected) = source(asset, size)? else {
        return Ok(ThumbnailStatus::unavailable());
    };
    if cache_file_exists(&selected, dir)? {
        return Ok(selected.status(ThumbnailState::Cached));
    }
    if selected.format.rendered() {
        return Ok(selected.pending_status());
    }
    let Some(bytes) = create_image(&selected, size)? else {
        return Ok(ThumbnailStatus::unavailable());
    };
    confirm_source(asset, &selected, size)?;
    Ok(selected.status(save(&selected, dir, &bytes)?))
}

pub fn read(asset: &Asset, dir: &Path, size: u32) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some(selected) = source(asset, normalized_size(size))? else {
        return Ok(None);
    };
    Ok(read_cached(&selected, dir)?.map(|bytes| (selected.format.mime().into(), bytes)))
}

pub fn read_or_generate(
    asset: &Asset,
    dir: &Path,
    size: u32,
) -> Result<Option<(String, Vec<u8>)>, String> {
    read_or_generate_preferring(asset, dir, size, || None)
}

pub fn read_or_generate_preferring(
    asset: &Asset,
    dir: &Path,
    size: u32,
    preferred_directory: impl FnOnce() -> Option<PathBuf>,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let size = normalized_size(size);
    let Some(selected) = source(asset, size)? else {
        return Ok(None);
    };
    read_or_generate_source(asset, &selected, dir, size, preferred_directory)
}

pub fn read_or_generate_sidecar(
    asset: &Asset,
    dir: &Path,
    size: u32,
    preferred_directory: impl FnOnce() -> Option<PathBuf>,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some(cover) = asset.thumbnail.as_deref().filter(|_| asset.kind != "texture") else {
        return Ok(None);
    };
    let size = normalized_size(size);
    let Some(selected) = source(asset, size)?.filter(|selected| {
        selected.path == Path::new(cover) && selected.format == ThumbnailFormat::Png
    }) else {
        return Ok(None);
    };
    read_or_generate_source(asset, &selected, dir, size, preferred_directory)
}

fn read_or_generate_source(
    asset: &Asset,
    selected: &Source<'_>,
    dir: &Path,
    size: u32,
    preferred_directory: impl FnOnce() -> Option<PathBuf>,
) -> Result<Option<(String, Vec<u8>)>, String> {
    if let Ok(Some(bytes)) = read_cached(selected, dir) {
        return Ok(Some((selected.format.mime().into(), bytes)));
    }
    if selected.format.rendered() {
        return Ok(None);
    }
    let Some(bytes) = create_image(selected, size)? else {
        return Ok(None);
    };
    confirm_source(asset, selected, size)?;
    let saved = preferred_directory()
        .is_some_and(|preferred| save(selected, &preferred, &bytes).is_ok());
    if !saved {
        // Browsing returns the decoded image even if neither cache is writable.
        let _ = save(selected, dir, &bytes);
    }
    Ok(Some((selected.format.mime().into(), bytes)))
}

pub fn store_mesh(
    asset: &Asset,
    dir: &Path,
    size: u32,
    key: &str,
    bytes: &[u8],
) -> Result<ThumbnailStatus, String> {
    store_rendered(asset, dir, size, key, bytes, ThumbnailFormat::Mesh)
}

pub fn video_key(asset: &Asset, size: u32) -> Result<Option<String>, String> {
    Ok(source(asset, normalized_size(size))?
        .filter(|source| source.format == ThumbnailFormat::Video)
        .map(|source| source.key))
}

pub fn store_video(
    asset: &Asset,
    dir: &Path,
    size: u32,
    key: &str,
    bytes: &[u8],
) -> Result<ThumbnailStatus, String> {
    store_rendered(asset, dir, size, key, bytes, ThumbnailFormat::Video)
}

fn store_rendered(
    asset: &Asset,
    dir: &Path,
    size: u32,
    key: &str,
    bytes: &[u8],
    renderer: ThumbnailFormat,
) -> Result<ThumbnailStatus, String> {
    let size = normalized_size(size);
    let selected = source(asset, size)?
        .filter(|source| source.key == key && source.format == renderer)
        .ok_or("素材或封面已更新，请重新生成缩略图")?;
    if cache_file_exists(&selected, dir)? {
        if renderer == ThumbnailFormat::Video {
            remember_video_size(asset, &selected, dir, size);
        }
        return Ok(selected.status(ThumbnailState::Cached));
    }
    if bytes.len() as u64 > MAX_CACHED_BYTES {
        return Err("缩略图数据超过大小限制".into());
    }
    let format = match image::guess_format(bytes) {
        Ok(image::ImageFormat::WebP) => image::ImageFormat::WebP,
        Ok(image::ImageFormat::Png) if renderer == ThumbnailFormat::Video => {
            image::ImageFormat::Png
        }
        _ => return Err("缩略图图片格式无效".into()),
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIZE);
    limits.max_image_height = Some(MAX_SIZE);
    limits.max_alloc = Some(MAX_CACHED_BYTES);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("无法读取缩略图：{error}"))?;
    let mut resized = Cursor::new(Vec::new());
    let needs_resize = image.width() > size || image.height() > size;
    let bytes = if needs_resize || format != image::ImageFormat::WebP {
        let image = if needs_resize {
            image.thumbnail(size, size)
        } else {
            image
        };
        image
            .write_to(&mut resized, image::ImageFormat::WebP)
            .map_err(|error| format!("无法保存缩略图：{error}"))?;
        resized.get_ref()
    } else {
        bytes
    };
    confirm_source(asset, &selected, size)?;
    let status = save(&selected, dir, bytes)?;
    if renderer == ThumbnailFormat::Video {
        remember_video_size(asset, &selected, dir, size);
    }
    Ok(selected.status(status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Catalog;
    use image::{ImageFormat, RgbImage};
    use std::time::Duration;

    fn asset_for(root: &Path, source: &Path) -> Asset {
        let catalog = Catalog::open(&root.join("catalog")).unwrap();
        catalog.add_file(source, "test").unwrap();
        catalog.assets().unwrap().remove(0)
    }

    #[test]
    fn reads_local_thumbnails_from_the_index_with_the_original_unavailable() {
        let scratch = tempfile::tempdir().unwrap();
        let file = scratch.path().join("indexed.png");
        RgbImage::new(8, 8).save(&file).unwrap();
        let mut asset = asset_for(scratch.path(), &file);
        let metadata = file.metadata().unwrap();
        asset.modified = serde_json::json!(metadata.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64);
        let cache = scratch.path().join("thumbnails");
        let (mime, bytes) = read_or_generate(&asset, &cache, 256).unwrap().unwrap();
        store_indexed(&asset, &cache, 256, &mime, &bytes).unwrap();
        fs::remove_file(file).unwrap();

        assert_eq!(read_indexed(&asset, &cache, 256).unwrap(), Some((mime.clone(), bytes.clone())));
        assert_eq!(read_team_original_from_index(&asset, &cache, 256).unwrap(), Some((mime, bytes)));
        assert!(read_indexed(&asset, &cache, 512).unwrap().is_none());
        asset.size += 1;
        assert!(read_indexed(&asset, &cache, 256).unwrap().is_none());
        assert!(read_team_original_from_index(&asset, &cache, 256).unwrap().is_none());
    }

    #[test]
    fn batch_thumbnail_uses_the_disk_cache_and_tracks_size_and_source_changes() {
        let scratch = tempfile::tempdir().unwrap();
        let file = scratch.path().join("墙面.png");
        RgbImage::new(800, 400).save(&file).unwrap();
        let original = fs::read(&file).unwrap();
        let asset = asset_for(scratch.path(), &file);
        let cache = scratch.path().join("shared").join("thumbnails");
        let before = inspect(&asset, &cache, 256).unwrap();
        assert_eq!(before.state, ThumbnailState::Image);
        assert!(read(&asset, &cache, 256).unwrap().is_none());
        assert!(!cache.exists());

        let generated = generate(&asset, &cache, 256).unwrap();
        assert_eq!(generated.state, ThumbnailState::Generated);
        assert_eq!(generated.key, before.key);
        let reused = generate(&asset, &cache, 0).unwrap();
        assert_eq!(reused.state, ThumbnailState::Cached);
        assert_eq!(reused.key, generated.key);
        let (mime, data) = read(&asset, &cache, 256).unwrap().unwrap();
        let image = image::load_from_memory(&data).unwrap();
        assert_eq!(
            (mime.as_str(), image.width(), image.height()),
            ("image/png", 256, 128)
        );
        assert_eq!(fs::read(&file).unwrap(), original);
        assert_eq!(
            inspect(&asset, &cache, 512).unwrap().state,
            ThumbnailState::Image
        );
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);

        let handle = fs::OpenOptions::new().write(true).open(&file).unwrap();
        let changed_time = handle.metadata().unwrap().modified().unwrap() + Duration::from_secs(2);
        handle.set_modified(changed_time).unwrap();
        let modified = inspect(&asset, &cache, 256).unwrap();
        assert_eq!(modified.state, ThumbnailState::Image);
        assert_ne!(modified.key, generated.key);
    }

    #[test]
    fn mesh_produced_by_the_viewer_is_validated_and_can_be_reused_from_another_mount() {
        let scratch = tempfile::tempdir().unwrap();
        let first = scratch.path().join("mesh.obj");
        fs::write(&first, "v 0 0 0\n").unwrap();
        let asset = asset_for(scratch.path(), &first);
        let cache = scratch.path().join("thumbnails");
        let pending = generate(&asset, &cache, 256).unwrap();
        assert_eq!(pending.state, ThumbnailState::Mesh);
        let key = pending.key.unwrap();
        assert!(store_mesh(&asset, &cache, 256, "outdated", b"invalid").is_err());
        assert!(store_mesh(&asset, &cache, 256, &key, b"invalid").is_err());
        assert!(!cache.exists());
        let mut image = Cursor::new(Vec::new());
        RgbImage::new(320, 160)
            .write_to(&mut image, ImageFormat::WebP)
            .unwrap();
        let stored = store_mesh(&asset, &cache, 256, &key, image.get_ref()).unwrap();
        assert_eq!(stored.state, ThumbnailState::Generated);

        let other_mount = scratch.path().join("second-client");
        fs::create_dir(&other_mount).unwrap();
        let mapped = other_mount.join("mesh.obj");
        fs::copy(&first, &mapped).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&mapped)
            .unwrap()
            .set_modified(fs::metadata(&first).unwrap().modified().unwrap())
            .unwrap();
        let mut other_asset = asset.clone();
        other_asset.path = mapped.to_string_lossy().into_owned();
        let shared = inspect(&other_asset, &cache, 256).unwrap();
        assert_eq!(shared.state, ThumbnailState::Cached);
        assert_eq!(shared.key, stored.key);
        let (mime, data) = read(&other_asset, &cache, 256).unwrap().unwrap();
        let image = image::load_from_memory(&data).unwrap();
        assert_eq!(
            (mime.as_str(), image.width(), image.height()),
            ("image/webp", 256, 128)
        );

        fs::write(mapped, "v 0 0 0\nv 1 0 0\n").unwrap();
        assert_eq!(
            inspect(&other_asset, &cache, 256).unwrap().state,
            ThumbnailState::Mesh
        );
        assert!(store_mesh(&other_asset, &cache, 256, &key, &data).is_err());
    }

    #[test]
    fn video_frames_persist_per_size_and_respect_custom_covers() {
        let scratch = tempfile::tempdir().unwrap();
        let file = scratch.path().join("片段.mp4");
        fs::File::create(&file)
            .unwrap()
            .set_len(MAX_MESH_SOURCE_BYTES * 10)
            .unwrap();
        let mut asset = asset_for(scratch.path(), &file);
        let cache = scratch.path().join("thumbnails");
        let pending = generate(&asset, &cache, 256).unwrap();
        assert_eq!(pending.state, ThumbnailState::Video);
        let key = video_key(&asset, 256).unwrap().unwrap();
        assert_eq!(pending.key.as_deref(), Some(key.as_str()));
        assert_ne!(
            video_key(&asset, 512).unwrap().as_deref(),
            Some(key.as_str())
        );

        // Canvas implementations without WebP encoding can return PNG instead.
        let mut png = Cursor::new(Vec::new());
        RgbImage::new(192, 108)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        assert!(store_mesh(&asset, &cache, 256, &key, png.get_ref()).is_err());
        let stored = store_video(&asset, &cache, 256, &key, png.get_ref()).unwrap();
        assert_eq!(stored.state, ThumbnailState::Generated);
        assert_eq!(
            generate(&asset, &cache, 256).unwrap().state,
            ThumbnailState::Cached
        );
        let (mime, image) = read_or_generate(&asset, &cache, 256).unwrap().unwrap();
        assert_eq!(mime, "image/webp");
        assert_eq!(image::load_from_memory(&image).unwrap().width(), 192);

        let cover = scratch.path().join("封面.png");
        RgbImage::new(89, 89).save(&cover).unwrap();
        asset.kind = "cover".into();
        asset.thumbnail = Some(cover.to_string_lossy().into_owned());
        assert!(video_key(&asset, 256).unwrap().is_none());
        assert!(store_video(&asset, &cache, 256, &key, png.get_ref()).is_err());
        let (mime, image) = read_or_generate(&asset, &cache, 256).unwrap().unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(image::load_from_memory(&image).unwrap().width(), 89);
    }

    #[test]
    fn browsing_reuses_an_alternate_video_size_without_marking_the_exact_size_cached() {
        let scratch = tempfile::tempdir().unwrap();
        let file = scratch.path().join("shared.mp4");
        let contents = b"video fixture";
        fs::write(&file, contents).unwrap();
        let asset = asset_for(scratch.path(), &file);
        let share = scratch.path().join("cache");
        let mut frame = Cursor::new(Vec::new());
        RgbImage::new(64, 32)
            .write_to(&mut frame, ImageFormat::WebP)
            .unwrap();

        let arbitrary_size = 253;
        let key = video_key(&asset, arbitrary_size).unwrap().unwrap();
        store_video(&asset, &share, arbitrary_size, &key, frame.get_ref()).unwrap();

        // Another computer can mount the same file under a different prefix.
        let second_mount = scratch.path().join("other-mount");
        fs::create_dir(&second_mount).unwrap();
        let mounted = second_mount.join("shared.mp4");
        fs::write(&mounted, contents).unwrap();
        fs::OpenOptions::new().write(true).open(&mounted).unwrap()
            .set_modified(fs::metadata(&file).unwrap().modified().unwrap()).unwrap();
        let mut other = asset.clone();
        other.path = crate::clean_path(&mounted);

        let preferred = 461;
        let preview = read_with_video_fallback(&other, &share, preferred).unwrap().unwrap();
        assert_eq!(preview.size, arbitrary_size);
        assert_eq!(preview.mime, "image/webp");
        assert_eq!(&preview.bytes, frame.get_ref());
        assert!(read(&other, &share, preferred).unwrap().is_none());
        let batch = generate(&other, &share, preferred).unwrap();
        assert_eq!(batch.state, ThumbnailState::Video);
        store_video(&other, &share, preferred, &batch.key.unwrap(), frame.get_ref()).unwrap();
        assert_eq!(read_with_video_fallback(&other, &share, preferred).unwrap().unwrap().size, preferred);

        // A pre-upgrade cache has no size record, but known legacy sizes still work.
        let legacy = scratch.path().join("legacy-cache");
        let key = video_key(&asset, DEFAULT_SIZE).unwrap().unwrap();
        store_video(&asset, &legacy, DEFAULT_SIZE, &key, frame.get_ref()).unwrap();
        let original = source(&asset, DEFAULT_SIZE).unwrap().unwrap();
        fs::remove_file(video_size_record(&asset, &original).target(&legacy)).unwrap();
        assert_eq!(read_with_video_fallback(&other, &legacy, preferred).unwrap().unwrap().size, DEFAULT_SIZE);

        fs::write(&mounted, b"the original source changed").unwrap();
        assert!(read_with_video_fallback(&other, &share, preferred).unwrap().is_none());
    }

    #[test]
    fn concurrent_requests_publish_one_complete_thumbnail() {
        let scratch = tempfile::tempdir().unwrap();
        let file = scratch.path().join("texture.png");
        RgbImage::new(500, 350).save(&file).unwrap();
        let asset = asset_for(scratch.path(), &file);
        let cache = scratch.path().join("thumbnails");
        std::thread::scope(|scope| {
            let first = scope.spawn(|| generate(&asset, &cache, 256).unwrap());
            let second = scope.spawn(|| generate(&asset, &cache, 256).unwrap());
            let first = first.join().unwrap();
            let second = second.join().unwrap();
            assert_eq!(first.key, second.key);
            assert_ne!(first.state, second.state);
        });
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        let (_, data) = read_or_generate(&asset, &cache, 256).unwrap().unwrap();
        assert!(image::load_from_memory(&data).is_ok());
    }
}
