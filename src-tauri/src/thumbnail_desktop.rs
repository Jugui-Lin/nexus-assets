use crate::{
    asset_cover, lock_db, team_covers, team_desktop::Desktop,
    workspace_data::workspace_data_directory, AppState,
};
use base64::Engine;
use nexus_core::{thumbnail_cache, thumbnail_cache::ThumbnailState, Asset};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_BATCH: usize = 64;
const MAX_RENDERED_IMAGE_BYTES: usize = 6 * 1024 * 1024;
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

pub(super) struct PreviewSource {
    pub asset: Asset,
    pub data_dir: PathBuf,
    team: Option<(Option<PathBuf>, String)>,
    index_root: PathBuf,
}

pub(super) fn read_indexed_thumbnail(
    state: &AppState,
    app: &tauri::AppHandle,
    id: &str,
    size: u32,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let (asset, namespace) = if let Some(id) = id.strip_prefix("team:") {
        let (asset, namespace) = app.state::<Desktop>().indexed_preview_asset(id)?;
        (asset, Some(namespace))
    } else {
        (lock_db(state)?.asset(id)?, None)
    };
    if let Some(dir) = workspace_data_directory(&state.root, &["indexed-thumbnails"], false)? {
        if let Some(image) = thumbnail_cache::read_indexed(&asset, &dir, size)? {
            return Ok(Some(image));
        }
    }
    if let Some(namespace) = namespace {
        if let Some(dir) = workspace_data_directory(&state.root, &["team-thumbnail-cache", &namespace], false)? {
            return thumbnail_cache::read_team_original_from_index(&asset, &dir, size);
        }
    }
    Ok(None)
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
                    (mount, namespace)
                }
                Err(_) => (None, team_covers::library_namespace(&source.team_id, &asset.library_id)),
            };
            Ok(Self {
                asset,
                data_dir: state.root.clone(),
                team: Some(team),
                index_root: state.root.clone(),
            })
        } else {
            let catalog = lock_db(state)?;
            let mut asset = catalog.asset(id)?;
            asset_cover::apply_cover(&mut asset, &catalog.dir);
            Ok(Self {
                asset,
                data_dir: catalog.dir.clone(),
                team: None,
                index_root: state.root.clone(),
            })
        }
    }

    fn shared_directory(&self, create: bool) -> Result<Option<PathBuf>, String> {
        match &self.team {
            Some((Some(mount), namespace)) => {
                workspace_data_directory(mount, &[".nexus", "thumbnail-cache", namespace], create)
            }
            _ => Ok(None),
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

    fn local_directory(&self, create: bool) -> Result<Option<PathBuf>, String> {
        match &self.team {
            Some((_, namespace)) => workspace_data_directory(
                &self.data_dir,
                &["team-thumbnail-cache", namespace],
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

    fn browse_shared_thumbnail(&self, size: u32) -> Result<Option<(String, Vec<u8>)>, String> {
        for directory in [self.shared_directory(false).ok().flatten(), self.local_directory(false).ok().flatten()].into_iter().flatten() {
            if let Some(image) = self.cached_thumbnail(&directory, size) {
                return Ok(Some(image));
            }
        }
        if self.asset.thumbnail.is_none() || self.asset.kind == "texture" {
            return Ok(None);
        }
        let directory = self.write_directory(false)?;
        let image = thumbnail_cache::read_or_generate_sidecar(&self.asset, &directory, size)?;
        if let Some((mime, bytes)) = &image {
            self.cache_indexed_thumbnail(size, mime, bytes);
        }
        Ok(image)
    }

    pub(super) fn thumbnail(&self, size: u32) -> Result<Option<(String, Vec<u8>)>, String> {
        if self.asset.ext == "max" {
            if let Some(path) = self.local_directory(false).ok().flatten() {
                if let Some(image) = self.cached_thumbnail(&path, size) {
                    return Ok(Some(image));
                }
            }
        }
        if let Some(path) = self.shared_directory(false).ok().flatten() {
            if let Some(image) = self.cached_thumbnail(&path, size) {
                return Ok(Some(image));
            }
        }
        let local = self.write_directory(false)?;
        if self.asset.kind == "video" {
            if let Some(image) = self.cached_thumbnail(&local, size) {
                return Ok(Some(image));
            }
        }
        let image = thumbnail_cache::read_or_generate(&self.asset, &local, size)?;
        if let Some((mime, bytes)) = &image {
            self.cache_indexed_thumbnail(size, mime, bytes);
        }
        Ok(image)
    }

    fn cache_indexed_thumbnail(&self, size: u32, mime: &str, bytes: &[u8]) {
        if let Ok(Some(dir)) = workspace_data_directory(&self.index_root, &["indexed-thumbnails"], true) {
            let _ = thumbnail_cache::store_indexed(&self.asset, &dir, size, mime, bytes);
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
        let save = |directory: &Path| {
            let status = thumbnail_cache::store_video(&self.asset, directory, size, cache_key, bytes)?;
            if let Ok(Some((mime, frame))) = thumbnail_cache::read(&self.asset, directory, size) {
                self.cache_indexed_thumbnail(size, &mime, &frame);
            }
            Ok::<_, String>(status)
        };
        if !batch {
            if let Ok(Some(directory)) = self.shared_directory(true) {
                if let Ok(status) = save(&directory) {
                    return Ok(status);
                }
            }
        }
        save(&self.write_directory(batch)?)
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
                let directory = source.write_directory(true)?;
                thumbnail_cache::generate(&source.asset, &directory, size)
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
        let status = if video {
            source.store_video_thumbnail(size, &cache_key, &bytes, batch)?
        } else {
            thumbnail_cache::store_mesh(&source.asset, &source.write_directory(batch)?, size, &cache_key, &bytes)?
        };
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
            team: Some((Some(mount.to_owned()), "fixture-library".into())),
            index_root: root.to_owned(),
        }
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
        let indexed = preview.index_root.join("indexed-thumbnails");
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
}
