use crate::{
    asset_cover, lock_db, team_covers, team_desktop::{Desktop, IndexedTeamPreview},
    workspace_data::workspace_data_directory, AppState,
};
use base64::Engine;
use nexus_core::{thumbnail_cache, thumbnail_cache::ThumbnailState, Asset};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use tauri::Manager;

mod explorer;
#[cfg(windows)]
mod file_icon;

const MAX_BATCH: usize = 64;
const MAX_RENDERED_IMAGE_BYTES: usize = 6 * 1024 * 1024;
const MAX_ORIGINAL_IMAGE_BYTES: u64 = 24 * 1024 * 1024;
const MAX_ORIGINAL_IMAGE_PIXELS: u64 = 40 * 1024 * 1024;
const MAX_ORIGINAL_IMAGE_EDGE: u32 = 16_384;
static IMAGE_PREVIEWS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub(super) async fn image_slot() -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    IMAGE_PREVIEWS.acquire().await.map_err(|e| e.to_string())
}

pub(super) fn checked_size(size: Option<u32>) -> Result<u32, String> {
    let size = size.unwrap_or(256);
    if !(128..=1024).contains(&size) {
        return Err("缩略图尺寸必须在 128 到 1024 像素之间".into());
    }
    Ok(size)
}

#[tauri::command]
pub(super) async fn local_explorer_thumbnail(
    state: tauri::State<'_, AppState>,
    path: String,
    size: u32,
) -> Result<Option<String>, String> {
    explorer::read(state.inner().clone(), path, checked_size(Some(size))?).await
}

#[tauri::command]
pub(super) async fn render_sequence_frame_preview(
    state: tauri::State<'_, AppState>,
    path: String,
    size: u32,
) -> Result<Option<String>, String> {
    explorer::read_render_frame(state.inner().clone(), path, checked_size(Some(size))?).await
}

#[tauri::command]
pub(super) async fn local_explorer_folder_thumbnail(
    state: tauri::State<'_, AppState>,
    path: String,
    size: u32,
) -> Result<Option<String>, String> {
    explorer::read_folder(state.inner().clone(), path, checked_size(Some(size))?).await
}

#[tauri::command]
pub(super) async fn local_explorer_file_icon(
    path: String,
    size: u32,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    return file_icon::read(path, size).await;
    #[cfg(not(windows))]
    {
        let _ = (path, size);
        Ok(None)
    }
}

pub(super) struct PreviewSource {
    pub asset: Asset,
    pub data_dir: PathBuf,
    team: Option<TeamThumbnailCache>,
}

struct TeamThumbnailCache {
    source_mount: Option<PathBuf>,
    shared_root: Option<PathBuf>,
    unified_root_configured: bool,
    namespace: String,
    relative_path: String,
}

impl TeamThumbnailCache {
    fn legacy_directory(&self, create: bool) -> Result<Option<PathBuf>, String> {
        if let Some(mount) = &self.source_mount {
            team_shared_cache_directory(mount, &self.namespace, create)
        } else {
            Ok(None)
        }
    }
}

type OriginalImage = (String, Vec<u8>, (u32, u32));

pub(super) fn read_original_pixels(asset: &Asset) -> Result<Option<OriginalImage>, String> {
    use image::ImageFormat;

    if asset.kind != "texture" {
        return Ok(None);
    }
    let path = Path::new(&asset.path);
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or_default();
    let format = match ext.to_ascii_lowercase().as_str() {
        "png" => ImageFormat::Png,
        "jpg" | "jpeg" | "jfif" => ImageFormat::Jpeg,
        "webp" => ImageFormat::WebP,
        "bmp" => ImageFormat::Bmp,
        _ => return Ok(None),
    };
    let metadata = fs::metadata(path).map_err(|error| format!("无法访问原图（{error}）"))?;
    if !metadata.is_file() {
        return Err("原图路径不是文件".into());
    }
    let too_large = || "原图超过 24 MiB，已保留缩放预览".to_owned();
    if metadata.len() > MAX_ORIGINAL_IMAGE_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| file.take(MAX_ORIGINAL_IMAGE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("无法读取原图（{error}）"))?;
    if bytes.len() as u64 > MAX_ORIGINAL_IMAGE_BYTES {
        return Err(too_large());
    }
    if image::guess_format(&bytes).ok() != Some(format) {
        return Err("原图内容与格式不符，已保留缩放预览".into());
    }
    let dimensions = image::ImageReader::with_format(Cursor::new(&bytes), format)
        .into_dimensions()
        .map_err(|error| format!("无法读取原图像素尺寸（{error}）"))?;
    let (width, height) = dimensions;
    if width == 0 || height == 0 || width.max(height) > MAX_ORIGINAL_IMAGE_EDGE ||
        u64::from(width) * u64::from(height) > MAX_ORIGINAL_IMAGE_PIXELS {
        return Err("原图像素尺寸超过 100% 预览范围，已保留缩放预览".into());
    }
    Ok(Some((format.to_mime_type().to_owned(), bytes, dimensions)))
}

pub(super) fn read_indexed_thumbnail(
    state: &AppState,
    app: &tauri::AppHandle,
    id: &str,
    size: u32,
) -> Result<Option<(String, Vec<u8>)>, String> {
    if let Some(id) = id.strip_prefix("team:") {
        let preview = app.state::<Desktop>().indexed_preview_asset(id)?;
        return Ok(read_team_indexed_thumbnail(&preview, &state.root, size));
    }

    let catalog = lock_db(state)?;
    let asset = catalog.asset(id)?;
    let data_dir = catalog.dir.clone();
    drop(catalog);
    read_personal_thumbnail_index(&asset, &data_dir, &state.root, size)
}

fn team_shared_cache_directory(
    root: &Path,
    namespace: &str,
    create: bool,
) -> Result<Option<PathBuf>, String> {
    workspace_data_directory(root, &[".nexus", "thumbnail-cache", namespace], create)
}

fn read_team_indexed_thumbnail(
    preview: &IndexedTeamPreview,
    local_root: &Path,
    size: u32,
) -> Option<(String, Vec<u8>)> {
    let asset = &preview.asset;
    if let Ok(Some(image)) = read_thumbnail_index(asset, local_root, size) {
        return Some(image);
    }
    if let Ok(Some(directory)) =
        workspace_data_directory(local_root, &["team-thumbnail-cache", &preview.namespace], false)
    {
        if let Ok(Some(image)) = thumbnail_cache::read_team_original_from_index(asset, &directory, size) {
            return Some(image);
        }
    }

    let root = preview.thumbnail_cache_root.as_ref()?;
    let directory = team_shared_cache_directory(root, &preview.namespace, false).ok()??;
    let (mime, bytes) = read_thumbnail_index(asset, &directory, size)
        .ok()
        .flatten()
        .or_else(|| thumbnail_cache::read_team_original_from_index(asset, &directory, size).ok().flatten())?;
    store_thumbnail_index(asset, local_root, size, &mime, &bytes);
    Some((mime, bytes))
}

fn read_thumbnail_index(
    asset: &Asset,
    root: &Path,
    size: u32,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some(directory) = workspace_data_directory(root, &["indexed-thumbnails"], false)? else {
        return Ok(None);
    };
    thumbnail_cache::read_indexed(asset, &directory, size)
}

fn store_thumbnail_index(asset: &Asset, root: &Path, size: u32, mime: &str, bytes: &[u8]) {
    if let Ok(Some(dir)) = workspace_data_directory(root, &["indexed-thumbnails"], true) {
        let _ = thumbnail_cache::store_indexed(asset, &dir, size, mime, bytes);
    }
}

fn read_personal_thumbnail_index(
    asset: &Asset,
    data_dir: &Path,
    legacy_root: &Path,
    size: u32,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let cached = read_thumbnail_index(asset, data_dir, size)?;
    if cached.is_some() || data_dir == legacy_root {
        return Ok(cached);
    }
    let legacy = read_thumbnail_index(asset, legacy_root, size)?;
    if let Some((mime, bytes)) = &legacy {
        store_thumbnail_index(asset, data_dir, size, mime, bytes);
    }
    Ok(legacy)
}

pub(super) fn read_shared_thumbnail(
    state: &AppState,
    app: &tauri::AppHandle,
    id: &str,
    size: u32,
) -> Result<Option<(String, Vec<u8>)>, String> {
    if !id.starts_with("team:") {
        return Ok(None);
    }
    PreviewSource::resolve(state, app, id)?.browse_shared_thumbnail(size)
}

impl PreviewSource {
    pub(super) fn resolve(
        state: &AppState,
        app: &tauri::AppHandle,
        id: &str,
    ) -> Result<Self, String> {
        if let Some(id) = id.strip_prefix("team:") {
            let source = app.state::<Desktop>().preview_asset(id)?;
            let mut asset = source.asset;
            let team = match source.storage {
                Ok(storage) => {
                    let mount = storage.data_mount().ok();
                    if let Some(mount) = &mount {
                        team_covers::apply_cover(
                            &mut asset,
                            mount,
                            &source.team_id,
                            &storage.library_id,
                        );
                    }
                    let namespace =
                        team_covers::library_namespace(&source.team_id, &storage.library_id);
                    TeamThumbnailCache {
                        source_mount: mount,
                        shared_root: source.thumbnail_cache_root,
                        unified_root_configured: source.unified_thumbnail_cache_configured,
                        namespace,
                        relative_path: source.relative_path,
                    }
                }
                Err(_) => TeamThumbnailCache {
                    source_mount: None,
                    shared_root: None,
                    unified_root_configured: source.unified_thumbnail_cache_configured,
                    namespace: team_covers::library_namespace(&source.team_id, &asset.library_id),
                    relative_path: source.relative_path,
                },
            };
            Ok(Self {
                asset,
                data_dir: state.root.clone(),
                team: Some(team),
            })
        } else {
            let catalog = lock_db(state)?;
            let mut asset = catalog.asset(id)?;
            let data_dir = catalog.dir.clone();
            drop(catalog);
            if !asset.demo && nexus_core::is_houdini_scene_extension(&asset.ext) {
                asset.thumbnail = nexus_core::asset_thumbnail(Path::new(&asset.path));
            }
            asset_cover::apply_cover(&mut asset, &data_dir);
            Ok(Self {
                asset,
                data_dir,
                team: None,
            })
        }
    }

    fn shared_directory(&self, create: bool) -> Result<Option<PathBuf>, String> {
        let Some(team) = &self.team else {
            return Ok(None);
        };
        if let Some(root) = &team.shared_root {
            team_shared_cache_directory(root, &team.namespace, create)
        } else {
            team.legacy_directory(create)
        }
    }

    fn write_directory(&self, batch: bool) -> Result<PathBuf, String> {
        if batch && self.team.is_some() {
            return self
                .shared_directory(true)?
                .ok_or_else(|| "无法创建 NAS 缩略图目录".into());
        }
        self.local_directory(true)?
            .ok_or_else(|| "无法创建缩略图目录".into())
    }

    fn write_batch_thumbnail<T>(
        &self,
        write: impl Fn(&Path, Option<&Path>) -> Result<T, String>,
    ) -> Result<T, String> {
        let unified = self.team.as_ref().is_some_and(|team| team.unified_root_configured);
        if unified {
            if let Some(directory) = self.preferred_browse_cache() {
                if let Ok(result) = write(&directory, Some(&directory)) {
                    return Ok(result);
                }
            }
            return write(&self.write_directory(false)?, None);
        }
        let directory = self.write_directory(true)?;
        let selected = self.team.as_ref().is_some_and(|team| team.shared_root.is_some());
        write(&directory, selected.then_some(directory.as_path()))
    }

    fn preferred_browse_cache(&self) -> Option<PathBuf> {
        self.team.as_ref()?.shared_root.as_ref()?;
        self.shared_directory(true).ok().flatten()
    }

    fn local_directory(&self, create: bool) -> Result<Option<PathBuf>, String> {
        match &self.team {
            Some(team) => workspace_data_directory(
                &self.data_dir,
                &["team-thumbnail-cache", &team.namespace],
                create,
            ),
            None => workspace_data_directory(&self.data_dir, &["thumbnail-cache"], create),
        }
    }

    fn cached_thumbnail(&self, directory: &Path, size: u32) -> Option<(String, Vec<u8>)> {
        let image = thumbnail_cache::read_with_video_fallback(&self.asset, directory, size)
            .ok().flatten()?;
        self.cache_indexed_thumbnail(image.size, &image.mime, &image.bytes);
        Some((image.mime, image.bytes))
    }

    fn cached_shared_thumbnail(&self, size: u32) -> Option<(String, Vec<u8>)> {
        let team = self.team.as_ref()?;
        self.shared_directory(false)
            .ok()
            .flatten()
            .and_then(|directory| self.cached_thumbnail(&directory, size))
            .or_else(|| {
                team.shared_root.as_ref()?;
                let legacy = team.legacy_directory(false).ok()??;
                self.cached_thumbnail(&legacy, size)
            })
    }

    fn browse_shared_thumbnail(&self, size: u32) -> Result<Option<(String, Vec<u8>)>, String> {
        if let Some(image) = self.cached_shared_thumbnail(size) {
            return Ok(Some(image));
        }
        if let Some(directory) = self.local_directory(false).ok().flatten() {
            if let Some(image) = self.cached_thumbnail(&directory, size) {
                return Ok(Some(image));
            }
        }
        if self.asset.thumbnail.is_none() || self.asset.kind == "texture" {
            return Ok(None);
        }
        let directory = self.write_directory(false)?;
        let image = thumbnail_cache::read_or_generate_sidecar(&self.asset, &directory, size, || {
            self.preferred_browse_cache()
        })?;
        if let Some((mime, bytes)) = &image {
            self.cache_indexed_thumbnail(size, mime, bytes);
        }
        Ok(image)
    }

    pub(super) fn thumbnail(&self, size: u32) -> Result<Option<(String, Vec<u8>)>, String> {
        if matches!(self.asset.ext.as_str(), "max" | "ies") {
            if let Some(path) = self.local_directory(false).ok().flatten() {
                if let Some(image) = self.cached_thumbnail(&path, size) {
                    return Ok(Some(image));
                }
            }
        }
        if let Some(image) = self.cached_shared_thumbnail(size) {
            return Ok(Some(image));
        }
        let local = self.write_directory(false)?;
        if self.asset.kind == "video" {
            if let Some(image) = self.cached_thumbnail(&local, size) {
                return Ok(Some(image));
            }
        }
        let image = thumbnail_cache::read_or_generate_preferring(&self.asset, &local, size, || {
            self.preferred_browse_cache()
        })?;
        if let Some((mime, bytes)) = &image {
            self.cache_indexed_thumbnail(size, mime, bytes);
        }
        Ok(image)
    }

    fn cache_indexed_thumbnail(&self, size: u32, mime: &str, bytes: &[u8]) {
        self.cache_indexed_thumbnail_at(size, mime, bytes, self.preferred_browse_cache().as_deref());
    }

    fn cache_indexed_thumbnail_at(&self, size: u32, mime: &str, bytes: &[u8], shared: Option<&Path>) {
        if let Some(team) = &self.team {
            let mut indexed = self.asset.clone();
            indexed.path.clone_from(&team.relative_path);
            store_thumbnail_index(&indexed, &self.data_dir, size, mime, bytes);
            if let Some(directory) = shared {
                store_thumbnail_index(&indexed, directory, size, mime, bytes);
            }
        } else {
            store_thumbnail_index(&self.asset, &self.data_dir, size, mime, bytes);
        }
    }

    pub(super) fn mesh_key(&self, size: u32) -> Option<String> {
        let dir = self.write_directory(false).ok()?;
        thumbnail_cache::inspect(&self.asset, &dir, size).ok()?.key
    }

    pub(super) fn store_video_thumbnail(
        &self,
        size: u32,
        cache_key: &str,
        bytes: &[u8],
        batch: bool,
    ) -> Result<thumbnail_cache::ThumbnailStatus, String> {
        self.store_rendered_thumbnail(size, cache_key, bytes, batch, true)
    }

    fn store_rendered_thumbnail(
        &self,
        size: u32,
        cache_key: &str,
        bytes: &[u8],
        batch: bool,
        video: bool,
    ) -> Result<thumbnail_cache::ThumbnailStatus, String> {
        let save = |directory: &Path, shared: Option<&Path>| {
            let status = if video {
                thumbnail_cache::store_video(&self.asset, directory, size, cache_key, bytes)?
            } else {
                thumbnail_cache::store_mesh(&self.asset, directory, size, cache_key, bytes)?
            };
            if let Ok(Some((mime, frame))) = thumbnail_cache::read(&self.asset, directory, size) {
                if batch {
                    self.cache_indexed_thumbnail_at(size, &mime, &frame, shared);
                } else {
                    self.cache_indexed_thumbnail(size, &mime, &frame);
                }
            }
            Ok::<_, String>(status)
        };
        if batch {
            return self.write_batch_thumbnail(save);
        }
        let preferred = if video {
            self.shared_directory(true).ok().flatten()
        } else {
            self.preferred_browse_cache()
        };
        if let Some(directory) = preferred {
            if let Ok(status) = save(&directory, None) {
                return Ok(status);
            }
        }
        save(&self.write_directory(false)?, None)
    }
}

#[tauri::command]
pub(super) async fn build_thumbnail_cache(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    size: u32,
) -> Result<Value, String> {
    let size = checked_size(Some(size))?;
    if ids.len() > MAX_BATCH {
        return Err(format!("每批最多生成 {MAX_BATCH} 项缩略图"));
    }
    let state = state.inner().clone();
    let _permit = image_slot().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cached = 0;
        let mut generated = 0;
        let mut unsupported = 0;
        let mut failed = 0;
        let mut errors = Vec::new();
        let mut models = Vec::new();
        let mut videos = Vec::new();
        let mut visited = HashSet::new();
        for id in &ids {
            if !visited.insert(id) {
                continue;
            }
            let mut label = id.as_str().to_owned();
            let result = (|| {
                let source = PreviewSource::resolve(&state, &app, id)?;
                label = source.asset.name.clone();
                source.write_batch_thumbnail(|directory, shared| {
                    let status = thumbnail_cache::generate(&source.asset, directory, size)?;
                    let indexed = source.team.as_ref().is_some_and(|team| team.shared_root.is_some() || team.unified_root_configured);
                    if indexed && matches!(status.state, ThumbnailState::Cached | ThumbnailState::Generated | ThumbnailState::Image)
                    {
                        if let Ok(Some((mime, bytes))) = thumbnail_cache::read(&source.asset, directory, size) {
                            source.cache_indexed_thumbnail_at(size, &mime, &bytes, shared);
                        }
                    }
                    Ok(status)
                })
            })();
            match result {
                Ok(status) => match status.state {
                    ThumbnailState::Cached => cached += 1,
                    ThumbnailState::Generated | ThumbnailState::Image => generated += 1,
                    ThumbnailState::Mesh => models.push(id),
                    ThumbnailState::Video => videos.push(id),
                    ThumbnailState::Unavailable => unsupported += 1,
                },
                Err(error) => {
                    failed += 1;
                    if errors.len() < 5 {
                        errors.push(format!("{label}：{error}"));
                    }
                }
            }
        }
        Ok(
            json!({"cached":cached,"generated":generated,"unsupported":unsupported,
            "failed":failed,"errors":errors,"models":models,"videos":videos}),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) async fn store_model_thumbnail(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    size: u32,
    cache_key: String,
    data_url: String,
    batch: Option<bool>,
) -> Result<Value, String> {
    store_thumbnail(
        app,
        state,
        RenderedThumbnail {
            id,
            size,
            cache_key,
            data_url,
            batch: batch.unwrap_or(false),
            video: false,
        },
    )
    .await
}

#[tauri::command]
pub(super) async fn store_video_thumbnail(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    size: u32,
    cache_key: String,
    data_url: String,
    batch: Option<bool>,
) -> Result<Value, String> {
    store_thumbnail(
        app,
        state,
        RenderedThumbnail {
            id,
            size,
            cache_key,
            data_url,
            batch: batch.unwrap_or(false),
            video: true,
        },
    )
    .await
}

struct RenderedThumbnail {
    id: String,
    size: u32,
    cache_key: String,
    data_url: String,
    batch: bool,
    video: bool,
}

async fn store_thumbnail(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    frame: RenderedThumbnail,
) -> Result<Value, String> {
    let RenderedThumbnail {
        id,
        size,
        cache_key,
        data_url,
        batch,
        video,
    } = frame;
    let size = checked_size(Some(size))?;
    const WEBP_PREFIX: &str = "data:image/webp;base64,";
    const PNG_PREFIX: &str = "data:image/png;base64,";
    if data_url.len() > WEBP_PREFIX.len() + MAX_RENDERED_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("缩略图数据超过大小限制".into());
    }
    let state = state.inner().clone();
    let _permit = image_slot().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let encoded = data_url
            .strip_prefix(WEBP_PREFIX)
            .or_else(|| {
                if video {
                    data_url.strip_prefix(PNG_PREFIX)
                } else {
                    None
                }
            })
            .ok_or("缩略图格式无效")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "缩略图数据无效")?;
        let source = PreviewSource::resolve(&state, &app, &id)?;
        let status = source.store_rendered_thumbnail(size, &cache_key, &bytes, batch, video)?;
        serde_json::to_value(status).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;
    use nexus_core::{clean_path, Catalog};
    use std::fs;

    fn mounted_fixture(root: &Path, mount: &Path, path: &Path) -> PreviewSource {
        let catalog = Catalog::open(&root.join("index")).unwrap();
        catalog.add_file(path, "fixture").unwrap();
        let mut asset = catalog.assets().unwrap().remove(0);
        asset.id = format!("team-{}", asset.id);
        PreviewSource {
            asset,
            data_dir: root.to_owned(),
            team: Some(TeamThumbnailCache {
                source_mount: Some(mount.to_owned()),
                shared_root: None,
                unified_root_configured: false,
                namespace: "fixture-library".into(),
                relative_path: path.file_name().unwrap().to_string_lossy().into_owned(),
            }),
        }
    }

    #[test]
    fn original_pixels_preserve_source_bytes_and_dims() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("texture.png");
        RgbImage::new(1920, 42).save(&path).unwrap();
        let preview = mounted_fixture(scratch.path(), scratch.path(), &path);

        let (mime, bytes, dimensions) = read_original_pixels(&preview.asset).unwrap().unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(dimensions, (1920, 42));
        assert_eq!(bytes, fs::read(&path).unwrap());
        assert_eq!(read_original_pixels(&preview.asset).unwrap().unwrap().1, bytes);
    }

    #[test]
    fn original_pixels_reject_mismatched_and_oversize_sources() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("texture.png");
        RgbImage::new(24, 16).save(&path).unwrap();
        let preview = mounted_fixture(scratch.path(), scratch.path(), &path);

        RgbImage::new(MAX_ORIGINAL_IMAGE_EDGE + 1, 1).save(&path).unwrap();
        assert!(read_original_pixels(&preview.asset).unwrap_err().contains("像素尺寸"));
        fs::write(&path, b"not a PNG").unwrap();
        assert!(read_original_pixels(&preview.asset).unwrap_err().contains("格式不符"));
        let file = File::options().write(true).open(&path).unwrap();
        file.set_len(MAX_ORIGINAL_IMAGE_BYTES + 1).unwrap();
        drop(file);
        assert!(read_original_pixels(&preview.asset).unwrap_err().contains("24 MiB"));
    }

    #[test]
    fn personal_thumbnails_live_with_the_catalog_and_reuse_the_old_index() {
        let scratch = tempfile::tempdir().unwrap();
        let legacy = scratch.path().join("app-data");
        let sources = scratch.path().join("linked-originals");
        let data_dir = scratch.path().join("personal-library");
        let other_data_dir = scratch.path().join("relocated-library");
        for dir in [&legacy, &sources, &data_dir, &other_data_dir] {
            fs::create_dir(dir).unwrap();
        }
        let path = sources.join("texture.png");
        RgbImage::new(48, 24).save(&path).unwrap();
        let catalog = Catalog::open(&data_dir).unwrap();
        catalog.add_file(&path, "fixture").unwrap();
        let preview = PreviewSource {
            asset: catalog.assets().unwrap().remove(0),
            data_dir: catalog.dir.clone(),
            team: None,
        };
        let expected = preview.thumbnail(256).unwrap().unwrap();
        assert!(data_dir.join("nexus.sqlite3").is_file());
        assert!(data_dir.join("thumbnail-cache").is_dir());
        assert!(!sources.join("thumbnail-cache").exists());
        assert!(!legacy.join("indexed-thumbnails").exists());
        assert_eq!(
            read_personal_thumbnail_index(&preview.asset, &data_dir, &legacy, 256).unwrap(),
            Some(expected.clone())
        );

        store_thumbnail_index(&preview.asset, &legacy, 256, &expected.0, &expected.1);
        assert_eq!(
            read_personal_thumbnail_index(&preview.asset, &other_data_dir, &legacy, 256).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(
            read_thumbnail_index(&preview.asset, &other_data_dir, 256).unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn shared_preview_loads_a_same_name_max_cover_without_writing_to_the_mount() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("mapped-team-library");
        fs::create_dir(&mount).unwrap();
        let scene = mount.join("2014-101.max");
        fs::write(&scene, b"unrenderable scene fixture").unwrap();
        let cover = scene.with_extension("jpg");
        RgbImage::new(48, 24).save(&cover).unwrap();
        let mut preview = mounted_fixture(scratch.path(), &mount, &scene);
        preview.asset.thumbnail = Some(clean_path(&cover));

        let (mime, data) = preview.browse_shared_thumbnail(256).unwrap().unwrap();
        assert_eq!(mime, "image/png");
        let image = image::load_from_memory(&data).unwrap();
        assert_eq!((image.width(), image.height()), (48, 24));
        assert!(!mount.join(".nexus").exists());
        let indexed = preview.data_dir.join("indexed-thumbnails");
        assert_eq!(
            thumbnail_cache::read_indexed(&preview.asset, &indexed, 256).unwrap(),
            Some((mime, data))
        );
    }

    #[test]
    fn shared_preview_reads_existing_texture_cache_but_does_not_generate_originals() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("mounted-team-library");
        fs::create_dir(&mount).unwrap();
        let texture = mount.join("texture.png");
        RgbImage::new(64, 32).save(&texture).unwrap();
        let preview = mounted_fixture(scratch.path(), &mount, &texture);

        assert!(preview.browse_shared_thumbnail(256).unwrap().is_none());
        assert!(!mount.join(".nexus").exists());
        assert!(!scratch.path().join("team-thumbnail-cache").exists());
        let directory = preview.shared_directory(true).unwrap().unwrap();
        assert_eq!(
            thumbnail_cache::generate(&preview.asset, &directory, 256).unwrap().state,
            ThumbnailState::Generated
        );
        assert!(preview.browse_shared_thumbnail(256).unwrap().is_some());
        assert!(!scratch.path().join("team-thumbnail-cache").exists());
    }

    #[test]
    fn selected_team_cache_writes_outside_the_source_and_falls_back_safely() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("originals");
        let selected = scratch.path().join("shared-cache");
        let invalid = scratch.path().join("unavailable-cache");
        for directory in [&mount, &selected, &invalid] {
            fs::create_dir(directory).unwrap();
        }
        let texture = mount.join("texture.png");
        RgbImage::new(640, 320).save(&texture).unwrap();
        let mut preview = mounted_fixture(scratch.path(), &mount, &texture);
        let legacy = preview.write_directory(true).unwrap();
        thumbnail_cache::generate(&preview.asset, &legacy, 208).unwrap();
        let old_thumbnail = thumbnail_cache::read(&preview.asset, &legacy, 208).unwrap();

        preview.team.as_mut().unwrap().shared_root = Some(selected.clone());
        assert_eq!(preview.browse_shared_thumbnail(208).unwrap(), old_thumbnail);
        let expected_directory = selected
            .canonicalize()
            .unwrap()
            .join(".nexus")
            .join("thumbnail-cache")
            .join("fixture-library");
        assert_eq!(read_thumbnail_index(&preview.asset, &expected_directory, 208).unwrap(), old_thumbnail);
        assert!(thumbnail_cache::read(&preview.asset, &expected_directory, 208).unwrap().is_none());
        let generated = preview.thumbnail(256).unwrap();
        assert_eq!(preview.write_directory(true).unwrap(), expected_directory);
        assert_eq!(thumbnail_cache::read(&preview.asset, &expected_directory, 256).unwrap(), generated);
        assert!(thumbnail_cache::read(&preview.asset, &legacy, 256).unwrap().is_none());

        let blocked_key = thumbnail_cache::inspect(&preview.asset, &expected_directory, 320)
            .unwrap()
            .key
            .unwrap();
        fs::create_dir(expected_directory.join(format!("{blocked_key}.png"))).unwrap();
        let blocked_write_fallback = preview.thumbnail(320).unwrap();
        let local = preview.local_directory(false).unwrap().unwrap();
        assert_eq!(thumbnail_cache::read(&preview.asset, &local, 320).unwrap(), blocked_write_fallback);

        fs::create_dir(invalid.join(".nexus")).unwrap();
        fs::write(invalid.join(".nexus").join("thumbnail-cache"), b"not a cache directory").unwrap();
        preview.team.as_mut().unwrap().shared_root = Some(invalid);
        assert!(preview.write_directory(true).is_err());
        assert_eq!(preview.browse_shared_thumbnail(208).unwrap(), old_thumbnail);
        let fallback = preview.thumbnail(360).unwrap();
        assert_eq!(thumbnail_cache::read(&preview.asset, &local, 360).unwrap(), fallback);

        preview.team.as_mut().unwrap().shared_root = None;
        assert_eq!(preview.write_directory(true).unwrap(), legacy);
    }

    #[test]
    fn unified_team_batch_writes_fall_back_to_local_without_touching_original_mounts() {
        let scratch = tempfile::tempdir().unwrap();
        let originals = scratch.path().join("originals");
        let shared = scratch.path().join("shared");
        fs::create_dir(&originals).unwrap();
        fs::create_dir(&shared).unwrap();
        let source = originals.join("texture.png");
        RgbImage::new(640, 320).save(&source).unwrap();
        let mut preview = mounted_fixture(scratch.path(), &originals, &source);

        let resolve = |preview: &PreviewSource| preview.write_batch_thumbnail(|directory, shared_index| {
            Ok((directory.to_path_buf(), shared_index.map(Path::to_path_buf)))
        }).unwrap();
        let legacy = resolve(&preview).0;
        assert!(legacy.starts_with(originals.canonicalize().unwrap()));
        preview.team.as_mut().unwrap().unified_root_configured = true;
        let local = preview.local_directory(true).unwrap().unwrap();
        assert_eq!(resolve(&preview), (local.clone(), None));

        preview.team.as_mut().unwrap().shared_root = Some(scratch.path().join("unavailable"));
        assert_eq!(resolve(&preview), (local.clone(), None));

        preview.team.as_mut().unwrap().shared_root = Some(shared.clone());
        let expected = team_shared_cache_directory(&shared, "fixture-library", true).unwrap().unwrap();
        assert_eq!(resolve(&preview), (expected.clone(), Some(expected.clone())));
        let key = thumbnail_cache::inspect(&preview.asset, &expected, 320).unwrap().key.unwrap();
        fs::create_dir(expected.join(format!("{key}.png"))).unwrap();
        let mut attempts = std::cell::RefCell::new(Vec::new());
        let result = preview.write_batch_thumbnail(|directory, shared_index| {
            attempts.borrow_mut().push((directory.to_path_buf(), shared_index.is_some()));
            thumbnail_cache::generate(&preview.asset, directory, 320)
        }).unwrap();
        assert_eq!(result.state, ThumbnailState::Generated);
        assert_eq!(*attempts.get_mut(), vec![(expected, true), (local.clone(), false)]);
        assert!(thumbnail_cache::read(&preview.asset, &local, 320).unwrap().is_some());
        assert!(thumbnail_cache::read(&preview.asset, &legacy, 320).unwrap().is_none());
    }

    #[test]
    fn shared_team_cache_previews_work_without_the_original_or_local_mount() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("originals");
        let shared = scratch.path().join("shared-cache");
        let viewer = scratch.path().join("unmounted-client");
        for directory in [&mount, &shared, &viewer] {
            fs::create_dir(directory).unwrap();
        }
        let texture = mount.join("texture.png");
        RgbImage::new(640, 320).save(&texture).unwrap();
        let mut writer = mounted_fixture(scratch.path(), &mount, &texture);
        let modified = texture
            .metadata()
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        writer.asset.modified = json!(modified);
        let team = writer.team.as_mut().unwrap();
        team.shared_root = Some(shared.clone());
        team.relative_path = "nested/texture.png".into();
        let thumbnail = writer.thumbnail(256).unwrap();
        let directory = writer.shared_directory(false).unwrap().unwrap();
        let raw_thumbnail = thumbnail_cache::read_or_generate(&writer.asset, &directory, 320).unwrap();
        let mut indexed = IndexedTeamPreview {
            asset: writer.asset.clone(),
            namespace: "fixture-library".into(),
            thumbnail_cache_root: Some(shared),
        };
        indexed.asset.path = "nested/texture.png".into();
        assert_eq!(read_thumbnail_index(&indexed.asset, &directory, 256).unwrap(), thumbnail);
        assert!(read_thumbnail_index(&indexed.asset, &directory, 320).unwrap().is_none());
        fs::remove_file(texture).unwrap();

        indexed.namespace = "another-library".into();
        assert!(read_team_indexed_thumbnail(&indexed, &viewer, 256).is_none());
        indexed.namespace = "fixture-library".into();
        assert_eq!(read_team_indexed_thumbnail(&indexed, &viewer, 256), thumbnail);
        assert_eq!(read_team_indexed_thumbnail(&indexed, &viewer, 320), raw_thumbnail);
        assert!(read_team_indexed_thumbnail(&indexed, &viewer, 512).is_none());
        indexed.thumbnail_cache_root = None;
        assert_eq!(read_team_indexed_thumbnail(&indexed, &viewer, 256), thumbnail);
    }
}
