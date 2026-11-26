use crate::{
    asset_cover, folder_browser, local_explorer::validate_file_path,
    workspace_data::workspace_data_directory, AppState,
};
use base64::Engine;
use nexus_core::{asset_thumbnail, clean_path, kind, thumbnail_cache, Asset};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const CACHE_DIR: &str = "explorer-thumbnail-cache";
const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(6);
const FOLDER_SCAN_LIMIT: usize = 128;
const FOLDER_PREVIEW_ATTEMPTS: usize = 6;
static EXPLORER_THUMBNAILS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(2);

pub(super) async fn read(
    state: AppState,
    path: String,
    size: u32,
) -> Result<Option<String>, String> {
    if path.len() > 32_768 {
        return Ok(None);
    }
    let path = PathBuf::from(path);
    validate_file_path(&path)?;
    if file_kind(&path).is_none() && !shell_thumbnail_candidate(&path) {
        return Ok(None);
    }
    folder_browser::read_with_slots(&EXPLORER_THUMBNAILS, THUMBNAIL_TIMEOUT, move |cancelled| {
        let path =
            fs::canonicalize(path).map_err(|error| format!("无法读取缩略图来源：{error}"))?;
        read_file_image(&state, &path, size, cancelled).map(|image| image.map(data_url))
    })
    .await
}

pub(super) async fn read_folder(
    state: AppState,
    path: String,
    size: u32,
) -> Result<Option<String>, String> {
    if path.len() > 32_768 {
        return Ok(None);
    }
    let path = PathBuf::from(path);
    validate_file_path(&path)?;
    folder_browser::read_with_slots(&EXPLORER_THUMBNAILS, THUMBNAIL_TIMEOUT, move |cancelled| {
        let Ok(folder) = fs::canonicalize(path) else {
            return Ok(None);
        };
        validate_file_path(&folder)?;
        Ok(folder_image(&state, &folder, size, cancelled).map(data_url))
    })
    .await
}

fn read_file_image(
    state: &AppState,
    path: &Path,
    size: u32,
    cancelled: &AtomicBool,
) -> Result<Option<(String, Vec<u8>)>, String> {
    validate_file_path(path)?;
    if cancelled.load(Ordering::Acquire) || !path.is_file() {
        return Ok(None);
    }
    let Some((ext, kind)) = file_kind(path) else {
        #[cfg(windows)]
        if shell_thumbnail_candidate(path) {
            return Ok(shell_thumbnail(path, size, cancelled));
        }
        return Ok(None);
    };
    let canonical = clean_path(path);
    let mut library = indexed_asset(state, &canonical);
    if let Some((asset, directory)) = &mut library {
        if nexus_core::is_houdini_scene_extension(&asset.ext) {
            asset.thumbnail = asset_thumbnail(Path::new(&asset.path));
        }
        asset_cover::apply_cover(asset, directory);
        if let Some(image) = read_library_cache(asset, directory, size) {
            return Ok(Some(image));
        }
    }
    let asset = library
        .map(|(asset, _)| asset)
        .unwrap_or_else(|| unindexed_asset(canonical, path, ext, kind));
    thumbnail(&asset, &state.root, size, cancelled)
}

fn folder_image(
    state: &AppState,
    folder: &Path,
    size: u32,
    cancelled: &AtomicBool,
) -> Option<(String, Vec<u8>)> {
    for (_, candidate) in folder_candidates(folder, cancelled)
        .into_iter()
        .take(FOLDER_PREVIEW_ATTEMPTS)
    {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let Ok(path) = fs::canonicalize(candidate) else {
            continue;
        };
        // An immediate file could have been replaced with a link since enumeration.
        if path.parent() != Some(folder) {
            continue;
        }
        if let Ok(Some(image)) = read_file_image(state, &path, size, cancelled) {
            return Some(image);
        }
    }
    None
}

fn folder_candidates(folder: &Path, cancelled: &AtomicBool) -> Vec<(u8, PathBuf)> {
    if cancelled.load(Ordering::Acquire) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut candidates: Vec<_> = entries
        .take(FOLDER_SCAN_LIMIT)
        .take_while(|_| !cancelled.load(Ordering::Acquire))
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let (_, category) = file_kind(&path)?;
            #[cfg(windows)]
            let is_file = entry.metadata().ok().is_some_and(|metadata| {
                metadata.is_file() && crate::local_explorer::visible_windows_entry(&metadata, false)
            });
            #[cfg(not(windows))]
            let is_file = entry.file_type().ok()?.is_file();
            if !is_file {
                return None;
            }
            let rank = match category {
                "texture" => {
                    let stem = path.file_stem()?.to_str()?.to_ascii_lowercase();
                    u8::from(!matches!(
                        stem.as_str(),
                        "cover" | "folder" | "preview" | "thumbnail" | "封面" | "预览" | "缩略图"
                    ))
                }
                "video" => 2,
                "scene" | "model" => 3,
                _ => 4,
            };
            Some((rank, path))
        })
        .collect();
    candidates.sort_unstable();
    candidates
}

fn file_kind(path: &Path) -> Option<(String, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    // Passive previews use the asset formats and never invoke a script or executable.
    let category = kind(&ext).filter(|category| *category != "script")?;
    Some((ext, category))
}

fn shell_thumbnail_candidate(path: &Path) -> bool {
    cfg!(windows)
        && path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| {
            let ext = ext.to_ascii_lowercase();
            kind(&ext) != Some("script")
                && !matches!(
                    ext.as_str(),
                    "bat" | "cmd" | "com" | "cpl" | "dll" | "exe" | "hta" | "js" | "jse" | "lnk"
                        | "msc" | "msi" | "msp" | "ps1" | "scr" | "url" | "vbe" | "vbs" | "wsf"
                )
        })
}

#[cfg(windows)]
fn shell_thumbnail(path: &Path, size: u32, cancelled: &AtomicBool) -> Option<(String, Vec<u8>)> {
    if cancelled.load(Ordering::Acquire) {
        return None;
    }
    // The Explorer read already owns a bounded worker slot. Calling the
    // asset-library batch entry point here would reject concurrent files.
    let bytes = crate::asset_video::system_file_thumbnail_bytes(path, size).ok()?;
    (!cancelled.load(Ordering::Acquire)).then_some(("image/webp".into(), bytes))
}

fn indexed_asset(state: &AppState, canonical: &str) -> Option<(Asset, PathBuf)> {
    // Avoid holding or waiting for the catalog lock during any disk reads.
    let catalog = state.db.try_lock().ok()?;
    let data = catalog
        .conn
        .query_row(
            "SELECT data FROM assets WHERE path=?1",
            [canonical],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    let asset: Asset = serde_json::from_str(&data).ok()?;
    (!asset.demo && asset.path == canonical).then(|| (asset, catalog.dir.clone()))
}

fn read_library_cache(asset: &Asset, directory: &Path, size: u32) -> Option<(String, Vec<u8>)> {
    let cache = workspace_data_directory(directory, &["thumbnail-cache"], false).ok()??;
    let matching = thumbnail_cache::read_with_video_fallback(asset, &cache, size)
        .ok()
        .flatten()
        .map(|image| (image.mime, image.bytes));
    // Model previews are rendered by the asset view and have no native
    // raster generator. Reuse its standard resolution at smaller zooms.
    matching.or_else(|| {
        if size < 256 && thumbnail_cache::mesh_source_limit(&asset.ext).is_some() {
            thumbnail_cache::read(asset, &cache, 256).ok().flatten()
        } else {
            None
        }
    })
}

fn unindexed_asset(canonical: String, path: &Path, ext: String, kind: &str) -> Asset {
    let digest: String = Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let thumbnail = (kind != "texture").then(|| asset_thumbnail(path)).flatten();
    Asset {
        id: format!("explorer-{digest}"),
        name: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: canonical,
        ext,
        kind: kind.into(),
        size: 0,
        modified: serde_json::Value::Null,
        added: serde_json::Value::Null,
        library_id: String::new(),
        tags: Vec::new(),
        favorite: false,
        favorite_at: None,
        notes: String::new(),
        rating: 0,
        workflow: Default::default(),
        thumbnail,
        demo: false,
        subtitle: None,
        color: None,
        vertices: None,
        faces: None,
    }
}

fn thumbnail(
    asset: &Asset,
    root: &Path,
    size: u32,
    cancelled: &AtomicBool,
) -> Result<Option<(String, Vec<u8>)>, String> {
    if cancelled.load(Ordering::Acquire) {
        return Ok(None);
    }
    // Even when the original or asset database is on a share, generated
    // explorer thumbnails stay in the application's local data directory.
    let directory =
        workspace_data_directory(root, &[CACHE_DIR], true)?.ok_or("无法创建文件浏览缩略图缓存")?;
    if asset.kind == "video" {
        if let Some(image) = thumbnail_cache::read_with_video_fallback(asset, &directory, size)? {
            return Ok(Some((image.mime, image.bytes)));
        }
    }
    let image = thumbnail_cache::read_or_generate(asset, &directory, size);
    #[cfg(windows)]
    if !matches!(&image, Ok(Some(_))) {
        let path = Path::new(&asset.path);
        if let Some(image) = shell_thumbnail(path, size, cancelled) {
            if let Ok(Some(key)) = thumbnail_cache::video_key(asset, size) {
                let _ = thumbnail_cache::store_video(asset, &directory, size, &key, &image.1);
            }
            return Ok(Some(image));
        }
    }
    image
}

pub(super) fn data_url((mime, bytes): (String, Vec<u8>)) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn folder_cover_prefers_named_image_and_reuses_the_file_preview() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let folder = fs::canonicalize(source.path()).unwrap();
        let nested = folder.join("Nested");
        fs::create_dir(&nested).unwrap();
        image::RgbImage::from_pixel(320, 160, image::Rgb([0, 0, 200]))
            .save(nested.join("preview.png"))
            .unwrap();
        let regular = folder.join("00.png");
        image::RgbImage::from_pixel(320, 160, image::Rgb([100, 0, 0]))
            .save(&regular)
            .unwrap();
        let cover = folder.join("封面.png");
        image::RgbImage::from_pixel(320, 160, image::Rgb([0, 100, 0]))
            .save(&cover)
            .unwrap();
        fs::write(folder.join("cover.png"), b"unreadable image").unwrap();
        fs::write(folder.join("cover.py"), b"unused script").unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(nexus_core::Catalog::open(data.path()).unwrap())),
            root: data.path().to_owned(),
            workspace_io: Arc::new(Mutex::new(())),
            placement: Default::default(),
            sessions: Default::default(),
            token: String::new(),
            port: 0,
        };
        let cancelled = AtomicBool::new(false);
        let candidates = folder_candidates(&folder, &cancelled);
        assert_eq!(candidates.len(), 3);
        assert!(candidates
            .iter()
            .all(|(_, path)| path.parent() == Some(folder.as_path())
                && path.extension().is_some_and(|ext| ext == "png")));
        let cover = fs::canonicalize(cover).unwrap();
        let thumbnail = folder_image(&state, &folder, 128, &cancelled).unwrap();
        let file_thumbnail = read_file_image(&state, &cover, 128, &cancelled)
            .unwrap()
            .unwrap();
        assert_eq!(thumbnail, file_thumbnail);
        assert_eq!(image::load_from_memory(&thumbnail.1).unwrap().width(), 128);
        assert_eq!(
            fs::read_dir(data.path().join(CACHE_DIR)).unwrap().count(),
            1
        );
        fs::remove_file(cover).unwrap();
        let regular = fs::canonicalize(regular).unwrap();
        let fallback = read_file_image(&state, &regular, 128, &cancelled)
            .unwrap()
            .unwrap();
        assert_eq!(
            folder_image(&state, &folder, 128, &cancelled),
            Some(fallback)
        );
        fs::remove_file(regular).unwrap();
        assert!(folder_image(&state, &folder, 128, &cancelled).is_none());
    }

    #[test]
    fn folder_preview_bounds_enumeration_and_honors_cancellation() {
        let folder = tempfile::tempdir().unwrap();
        for index in 0..FOLDER_SCAN_LIMIT + 10 {
            fs::File::create(folder.path().join(format!("{index}.png"))).unwrap();
        }
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            folder_candidates(folder.path(), &cancelled).len(),
            FOLDER_SCAN_LIMIT
        );
        cancelled.store(true, Ordering::Release);
        assert!(folder_candidates(folder.path(), &cancelled).is_empty());
    }

    #[test]
    fn file_preview_uses_local_cache_and_distinct_private_keys() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let path = source.path().join("示例.png");
        image::RgbImage::new(320, 160).save(&path).unwrap();
        let source_path = clean_path(&fs::canonicalize(&path).unwrap());
        let (ext, kind) = file_kind(&path).unwrap();
        let asset = unindexed_asset(source_path.clone(), &path, ext.clone(), kind);
        assert_eq!(
            asset.id,
            unindexed_asset(source_path, &path, ext.clone(), kind).id
        );
        let other = data.path().join(path.file_name().unwrap());
        assert_ne!(
            asset.id,
            unindexed_asset(clean_path(&other), &other, ext, kind).id
        );
        let cancelled = AtomicBool::new(false);
        let image = thumbnail(&asset, data.path(), 128, &cancelled)
            .unwrap()
            .unwrap();
        assert_eq!(image.0, "image/png");
        assert_eq!(image::load_from_memory(&image.1).unwrap().width(), 128);
        assert_eq!(fs::read_dir(source.path()).unwrap().count(), 1);
        assert_eq!(
            fs::read_dir(data.path().join(CACHE_DIR)).unwrap().count(),
            1
        );
        assert_eq!(
            thumbnail(&asset, data.path(), 128, &cancelled).unwrap(),
            Some(image)
        );
    }
}
