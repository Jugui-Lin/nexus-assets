use super::{lock_db, AppState};
use crate::{team_covers, team_desktop::Desktop};
use base64::Engine;
use image::ImageFormat;
use nexus_core::Asset;
use std::{
    fs,
    io::{Cursor, ErrorKind, Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_COVER_BYTES: usize = 64_000_000;
const MAX_COVER_EDGE: u32 = 1600;
const COVER_FORMATS: &str = "请选择不大于 64 MB 的 PNG、JPEG、WebP 或 BMP 图片。";

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn cover_filename(id: &str) -> Option<String> {
    valid_id(id).then(|| format!("cover-{id}.png"))
}

fn cover_path(dir: &Path, id: &str) -> Option<PathBuf> {
    cover_filename(id).map(|filename| dir.join("asset-covers").join(filename))
}

pub(crate) fn screenshot_reference_name(id: &str) -> Option<String> {
    valid_id(id).then(|| format!("screenshot-{id}.ref"))
}

fn screenshot_reference(cover: &Path, id: &str) -> Option<PathBuf> {
    Some(cover.with_file_name(screenshot_reference_name(id)?))
}

fn ordinary_file(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    metadata.is_file() && !metadata.file_type().is_symlink()
}

fn screenshot_path(source: &Path) -> Option<PathBuf> {
    if source
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
    {
        return None;
    }
    Some(source.with_extension("png"))
}

pub(crate) fn apply_screenshot_reference(asset: &mut Asset, directory: &Path) -> bool {
    let Some(reference) = screenshot_reference_name(&asset.id).map(|name| directory.join(name))
    else {
        return false;
    };
    if !ordinary_file(&reference) || asset.kind == "texture" {
        return false;
    }
    let Some(path) = screenshot_path(Path::new(&asset.path)).filter(|path| ordinary_file(path))
    else {
        return false;
    };
    apply_cover_path(asset, &path);
    true
}

pub fn apply_cover(asset: &mut Asset, dir: &Path) {
    if apply_screenshot_reference(asset, &dir.join("asset-covers")) {
        return;
    }
    let Some(path) = cover_path(dir, &asset.id).filter(|path| path.is_file()) else {
        return;
    };
    apply_cover_path(asset, &path);
}

pub(crate) fn apply_cover_path(asset: &mut Asset, path: &Path) {
    // The scaler uses the source image for textures. Route preview-only clones
    // through their thumbnail field when they have a saved cover.
    asset.kind = "cover".into();
    asset.thumbnail = Some(path.to_string_lossy().into_owned());
}

pub fn cover_ids(dir: &Path) -> Vec<String> {
    let mut ids: Vec<_> = fs::read_dir(dir.join("asset-covers"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_stem()?.to_str()?;
            let id = match path.extension()?.to_str()? {
                "png" => stem.strip_prefix("cover-")?,
                "ref" => stem.strip_prefix("screenshot-")?,
                _ => return None,
            };
            valid_id(id).then(|| id.to_owned())
        })
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn stage_cover(bytes: &[u8], directory: &Path) -> Result<tempfile::NamedTempFile, String> {
    if bytes.len() > MAX_COVER_BYTES {
        return Err(COVER_FORMATS.into());
    }
    let format = image::guess_format(bytes).map_err(|_| COVER_FORMATS)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Bmp
    ) {
        return Err(COVER_FORMATS.into());
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("无法读取封面图片。{error}"))?;
    let image = if image.width() > MAX_COVER_EDGE || image.height() > MAX_COVER_EDGE {
        image.thumbnail(MAX_COVER_EDGE, MAX_COVER_EDGE)
    } else {
        image
    };
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    image
        .write_to(temp.as_file_mut(), ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    Ok(temp)
}

pub(crate) fn store_cover(bytes: &[u8], target: &Path) -> Result<(), String> {
    let directory = target.parent().ok_or("缺少封面目录")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    stage_cover(bytes, directory)?
        .persist(target)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn screenshot_conflict(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    format!("工程旁已有同名图片「{name}」。请先移走或重命名这张图片后再保存截图。")
}

pub(crate) fn store_screenshot_sidecar(
    bytes: &[u8],
    asset: &Asset,
    cover: &Path,
    mount: Option<&Path>,
) -> Result<PathBuf, String> {
    if !ordinary_file(Path::new(&asset.path)) {
        return Err("源工程需要是可访问的普通文件".into());
    }
    let source =
        fs::canonicalize(&asset.path).map_err(|error| format!("无法打开源工程：{error}"))?;
    if mount.is_some_and(|mount| !source.starts_with(mount)) {
        return Err("源工程必须位于已挂载的团队目录内".into());
    }
    let target = screenshot_path(&source).ok_or("截图保存路径和原始图片相同")?;
    let target_dir = target.parent().ok_or("缺少工程文件夹")?;
    for candidate in [&target, &source.with_extension("jpg")] {
        match fs::symlink_metadata(candidate) {
            Ok(_) if candidate != &source => return Err(screenshot_conflict(candidate)),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法检查工程旁的同名图片：{error}")),
        }
    }
    let reference_path = screenshot_reference(cover, &asset.id).ok_or("资产标识无效")?;
    let reference_dir = reference_path.parent().ok_or("缺少封面目录")?;
    fs::create_dir_all(reference_dir).map_err(|error| error.to_string())?;
    let screenshot = stage_cover(bytes, target_dir)?;
    let mut reference =
        tempfile::NamedTempFile::new_in(reference_dir).map_err(|error| error.to_string())?;
    reference
        .write_all(b"1")
        .map_err(|error| error.to_string())?;
    reference
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    match screenshot.persist_noclobber(&target) {
        Ok(_) => {}
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => {
            return Err(screenshot_conflict(&target))
        }
        Err(error) => return Err(format!("无法在工程旁保存截图：{}", error.error)),
    }
    reference.persist(reference_path).map_err(|error| {
        format!(
            "截图已存为「{}」，封面引用未能保存：{}",
            target.display(),
            error.error
        )
    })?;
    Ok(target)
}

fn asset_cover_target(
    state: &AppState,
    app: &tauri::AppHandle,
    id: &str,
    create: bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(id) = id.strip_prefix("team:") {
        let source = app.state::<Desktop>().preview_asset(id)?;
        let storage = source.storage?;
        return team_covers::cover_target(
            &storage.data_mount()?,
            &source.team_id,
            &storage.library_id,
            &source.asset.id,
            create,
        );
    }
    let catalog = lock_db(state)?;
    let target = cover_path(&catalog.dir, id).ok_or("资产标识无效")?;
    catalog.asset(id)?;
    Ok(Some(target))
}

#[tauri::command]
pub async fn change_asset_cover(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
    clear: bool,
) -> Result<Option<bool>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = crate::workspaces::lock_io(&state)?;
        if clear {
            let Some(target) = asset_cover_target(&state, &app, &id, false)? else {
                return Ok(Some(false));
            };
            let cover_id = id
                .strip_prefix("team:")
                .map(|id| format!("team-{id}"))
                .unwrap_or_else(|| id.clone());
            if let Some(reference) = screenshot_reference(&target, &cover_id) {
                remove_if_present(&reference)?;
            }
            remove_if_present(&target)?;
            return Ok(Some(false));
        }
        let Some(source) = rfd::FileDialog::new()
            .set_title("选取资产封面")
            .add_filter("图像", &["png", "jpg", "jpeg", "webp", "bmp"])
            .pick_file()
        else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        fs::File::open(source)
            .and_then(|file| {
                file.take(MAX_COVER_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|error| error.to_string())?;
        let target = asset_cover_target(&state, &app, &id, true)?.ok_or("无法创建封面文件")?;
        store_cover(&bytes, &target)?;
        let cover_id = id
            .strip_prefix("team:")
            .map(|id| format!("team-{id}"))
            .unwrap_or_else(|| id.clone());
        if let Some(reference) = screenshot_reference(&target, &cover_id) {
            remove_if_present(&reference)?;
        }
        Ok(Some(true))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_clipboard_cover(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    id: String,
    image_base64: String,
) -> Result<bool, String> {
    if image_base64.len() > MAX_COVER_BYTES.div_ceil(3) * 4 {
        return Err(COVER_FORMATS.into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = crate::workspaces::lock_io(&state)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image_base64)
            .map_err(|_| "无法读取粘贴的图片数据。")?;
        if let Some(team_id) = id.strip_prefix("team:") {
            let source = app.state::<Desktop>().preview_asset(team_id)?;
            let storage = source.storage?;
            let mount = storage.data_mount()?;
            let target = team_covers::cover_target(&mount, &source.team_id, &storage.library_id,
                &source.asset.id, true)?.ok_or("无法创建封面文件")?;
            if source.asset.kind == "texture" {
                store_cover(&bytes, &target)?;
            } else {
                store_screenshot_sidecar(&bytes, &source.asset, &target, Some(&mount))?;
            }
        } else {
            let (asset, target) = {
                let catalog = lock_db(&state)?;
                (catalog.asset(&id)?, cover_path(&catalog.dir, &id).ok_or("资产标识无效")?)
            };
            if asset.kind == "texture" {
                store_cover(&bytes, &target)?;
            } else {
                let sidecar = store_screenshot_sidecar(&bytes, &asset, &target, None)?;
                lock_db(&state)?.conn.execute(
                    "UPDATE assets SET data=json_set(data,'$.thumbnail',?1) WHERE id=?2 AND path=?3",
                    rusqlite::params![nexus_core::clean_path(&sidecar), id, asset.path],
                ).map_err(|error| format!("截图已保存，更新缩略图索引失败：{error}"))?;
            }
        }
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn start_cover_capture() -> Result<(), String> {
    launch_cover_capture()
}

#[cfg(windows)]
fn launch_cover_capture() -> Result<(), String> {
    use windows::{
        core::{w, PCWSTR},
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };

    // The registered Windows handler owns the interactive capture. Nexus
    // receives image bytes only from a subsequent paste in its own window.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            w!("ms-screenclip:"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err("无法打开 Windows 截图工具。可按 Win + Shift + S 截图。".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn launch_cover_capture() -> Result<(), String> {
    Err("请使用系统截图工具，将图片复制到剪贴板后粘贴。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::Catalog;

    fn screenshot(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::new(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn screenshot_uses_real_project_sidecar_before_and_after_rescan() {
        let scratch = tempfile::tempdir().unwrap();
        let folder = scratch.path().join("工程");
        fs::create_dir(&folder).unwrap();
        let project = folder.join("项目.c4d");
        fs::write(&project, b"project contents").unwrap();
        let mut catalog = Catalog::open(&scratch.path().join("db")).unwrap();
        catalog.add_file(&project, "loose").unwrap();
        let asset = catalog.assets().unwrap().pop().unwrap();
        let cover = cover_path(&catalog.dir, &asset.id).unwrap();
        store_cover(&screenshot(5, 8), &cover).unwrap();

        let png = store_screenshot_sidecar(&screenshot(11, 13), &asset, &cover, None).unwrap();
        assert_eq!(
            nexus_core::clean_path(&png),
            nexus_core::clean_path(&folder.join("项目.png"))
        );
        assert_eq!(fs::read(&project).unwrap(), b"project contents");
        assert_eq!(image::open(&cover).unwrap().width(), 5);
        let mut preview = asset.clone();
        apply_cover(&mut preview, &catalog.dir);
        let (_, pixels) = nexus_core::thumbnail_cache::read_or_generate(
            &preview,
            &scratch.path().join("cache"),
            256,
        )
        .unwrap()
        .unwrap();
        assert_eq!(image::load_from_memory(&pixels).unwrap().width(), 11);
        assert_eq!(cover_ids(&catalog.dir), vec![asset.id.clone()]);

        remove_if_present(&screenshot_reference(&cover, &asset.id).unwrap()).unwrap();
        remove_if_present(&cover).unwrap();
        catalog.scan(&folder, None, "local", |_| {}).unwrap();
        assert_eq!(
            catalog.asset(&asset.id).unwrap().thumbnail,
            Some(nexus_core::clean_path(&png))
        );
        assert_eq!(image::open(&png).unwrap().height(), 13);
    }

    #[test]
    fn screenshot_conflicts_never_replace_existing_named_images() {
        let scratch = tempfile::tempdir().unwrap();
        let project = scratch.path().join("project.max");
        fs::write(&project, b"maximum project").unwrap();
        let unexpected_mount = scratch.path().join("different_mount");
        fs::create_dir(&unexpected_mount).unwrap();
        let catalog = Catalog::open(&scratch.path().join("db")).unwrap();
        catalog.add_file(&project, "loose").unwrap();
        let asset = catalog.assets().unwrap().pop().unwrap();
        let cover = cover_path(&catalog.dir, &asset.id).unwrap();

        for extension in ["jpg", "png"] {
            let independent = project.with_extension(extension);
            fs::write(&independent, b"independent image").unwrap();
            let error =
                store_screenshot_sidecar(&screenshot(2, 6), &asset, &cover, None).unwrap_err();
            assert!(error.contains("已有同名图片"));
            assert_eq!(fs::read(&independent).unwrap(), b"independent image");
            fs::remove_file(independent).unwrap();
        }
        assert!(store_screenshot_sidecar(
            &screenshot(2, 6),
            &asset,
            &cover,
            Some(&unexpected_mount)
        )
        .is_err());
        assert!(cover_ids(&catalog.dir).is_empty());
        assert!(!project.with_extension("png").exists());
    }

    #[test]
    fn personal_cover_survives_source_image_removal_without_changing_asset() {
        let dir = tempfile::tempdir().unwrap();
        let obj = dir.path().join("asset.obj");
        let source = dir.path().join("chosen.png");
        image::RgbImage::new(7, 11).save(&source).unwrap();
        fs::write(&obj, "v 0 0 0").unwrap();
        let catalog = Catalog::open(dir.path()).unwrap();
        assert!(catalog.add_file(&obj, "loose").unwrap());
        let asset = catalog.assets().unwrap().pop().unwrap();
        let target = cover_path(dir.path(), &asset.id).unwrap();
        store_cover(&fs::read(&source).unwrap(), &target).unwrap();
        fs::remove_file(source).unwrap();
        let mut preview = asset.clone();
        apply_cover(&mut preview, dir.path());
        assert_eq!(
            preview.thumbnail,
            Some(target.to_string_lossy().into_owned())
        );
        assert_eq!(preview.path, asset.path);
        assert_eq!(cover_ids(dir.path()), vec![asset.id]);
    }

    #[test]
    fn texture_cover_replaces_visual_only_and_can_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("texture.png");
        image::RgbImage::new(7, 11).save(&src).unwrap();
        let catalog = Catalog::open(dir.path()).unwrap();
        assert!(catalog.add_file(&src, "loose").unwrap());
        let asset = catalog.assets().unwrap().pop().unwrap();
        let target = cover_path(dir.path(), &asset.id).unwrap();
        let cover_jpeg = image::RgbImage::new(3200, 1600);
        let mut bytes = Cursor::new(Vec::new());
        cover_jpeg.write_to(&mut bytes, ImageFormat::Jpeg).unwrap();
        store_cover(bytes.get_ref(), &target).unwrap();
        let mut preview = asset.clone();
        apply_cover(&mut preview, dir.path());
        let (_, resized) = nexus_core::scaled_preview_image(&preview, dir.path(), 1600)
            .unwrap()
            .unwrap();
        assert_eq!(
            image::load_from_memory(&resized).unwrap().width(),
            MAX_COVER_EDGE
        );
        assert_eq!(preview.path, asset.path);
        assert!(store_cover(b"broken image", &target).is_err());
        assert_eq!(image::open(&target).unwrap().height(), 800);
        store_cover(&fs::read(src).unwrap(), &target).unwrap();
        assert_eq!(image::open(target).unwrap().height(), 11);
    }
}
