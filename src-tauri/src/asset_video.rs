use crate::{
    lock_db,
    team_desktop::Desktop,
    thumbnail_desktop::{checked_size, PreviewSource},
    AppState,
};
use nexus_core::{clean_path, team::mapped_file, thumbnail_cache, video_mime, Asset};
use serde::Serialize;
use std::{
    fs::File,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[cfg(windows)]
mod shell_thumbnail;
pub(crate) mod stream;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoSource {
    path: String,
    mime: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_key: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct SystemVideoThumbnail {
    state: thumbnail_cache::ThumbnailState,
    url: String,
}

fn indexed_video_mime(path: &Path) -> Option<&'static str> {
    if !path.is_absolute() {
        return None;
    }
    video_mime(&path.extension()?.to_str()?.to_ascii_lowercase())
}

struct ApprovedVideo {
    path: PathBuf,
    file: File,
    length: u64,
    mime: &'static str,
}

fn open_approved_video(path: PathBuf, mime: &'static str) -> Result<ApprovedVideo, String> {
    if indexed_video_mime(&path) != Some(mime) {
        return Err("视频路径必须指向受支持的视频文件".into());
    }
    let file = File::open(&path).map_err(|e| format!("无法打开视频：{e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取视频属性：{e}"))?;
    if !metadata.is_file() {
        return Err("视频路径必须指向受支持的视频文件".into());
    }
    Ok(ApprovedVideo {
        path,
        file,
        length: metadata.len(),
        mime,
    })
}

fn approved_video_file(asset: &Asset) -> Result<ApprovedVideo, String> {
    let path = Path::new(&asset.path);
    let mime = indexed_video_mime(path)
        .filter(|_| asset.kind == "video")
        .ok_or("请从资产库中选择受支持的视频")?;
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("无法读取视频文件，请检查文件位置或 NAS 挂载：{e}"))?;
    open_approved_video(canonical, mime)
}

fn approve_indexed_video(
    state: &AppState,
    app: &tauri::AppHandle,
    id: &str,
) -> Result<ApprovedVideo, String> {
    if let Some(id) = id.strip_prefix("team:") {
        // Playback needs the mounted video, not cover sidecars or thumbnail storage.
        let (asset, root, _) = app.state::<Desktop>().mounted_asset(id)?;
        let mime = video_mime(&asset.ext)
            .filter(|_| asset.kind == "video")
            .ok_or("请从资产库中选择受支持的视频")?;
        return open_approved_video(mapped_file(&root, &asset.relative_path)?, mime);
    }
    let asset = lock_db(state)?.asset(id)?;
    approved_video_file(&asset)
}

#[tauri::command]
pub(crate) async fn asset_video_source(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    size: Option<u32>,
    path_only: Option<bool>,
) -> Result<VideoSource, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (approved, cache_key) = if size.is_some() {
            let size = checked_size(size)?;
            let source = PreviewSource::resolve(&state, &app, &id)?;
            let key = thumbnail_cache::video_key(&source.asset, size)?
                .ok_or("视频已使用封面，请刷新缩略图")?;
            (approved_video_file(&source.asset)?, Some(key))
        } else {
            (approve_indexed_video(&state, &app, &id)?, None)
        };
        let path = clean_path(&approved.path);
        let scope = app.asset_protocol_scope();
        scope.allow_file(&path).map_err(|e| e.to_string())?;
        // The protocol may canonicalize an SMB path to its verbatim Windows form.
        scope
            .allow_file(&approved.path)
            .map_err(|e| e.to_string())?;
        let url = if cfg!(windows) && path_only != Some(true) {
            app.state::<stream::VideoStreams>().issue(
                approved.file,
                approved.length,
                approved.mime,
                cache_key.is_some(),
            )
        } else {
            None
        };
        if url.is_none() && !scope.is_allowed(&path) {
            return Err("内置播放器无法访问此视频路径".into());
        }
        Ok(VideoSource {
            path,
            mime: approved.mime,
            url,
            cache_key,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn generate_system_video_thumbnail(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    size: u32,
    cache_key: String,
    batch: Option<bool>,
) -> Result<SystemVideoThumbnail, String> {
    #[cfg(windows)]
    {
        use base64::Engine;

        static SHELL_THUMBNAILS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let size = checked_size(Some(size))?;
        let permit = SHELL_THUMBNAILS
            .try_acquire()
            .map_err(|_| "系统正在提取另一个视频的缩略图")?;
        let state = state.inner().clone();
        let worker_app = app.clone();
        let worker_state = state.clone();
        let worker_id = id.clone();
        let worker_key = cache_key.clone();
        let frame = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let source = PreviewSource::resolve(&worker_state, &worker_app, &worker_id)?;
            if thumbnail_cache::video_key(&source.asset, size)?.as_deref()
                != Some(worker_key.as_str())
            {
                return Err("视频文件或封面已变化，请刷新后重试".into());
            }
            let approved = approved_video_file(&source.asset)?;
            let image = shell_thumbnail::read(&approved.path, size)?;
            let mut bytes = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut bytes, image::ImageFormat::WebP)
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(bytes.into_inner())
        });
        let bytes = tokio::time::timeout(std::time::Duration::from_secs(8), frame)
            .await
            .map_err(|_| "系统提取视频缩略图超时")?
            .map_err(|e| e.to_string())??;
        let _permit = crate::thumbnail_desktop::image_slot().await?;
        tauri::async_runtime::spawn_blocking(move || {
            let source = PreviewSource::resolve(&state, &app, &id)?;
            let status =
                source.store_video_thumbnail(size, &cache_key, &bytes, batch.unwrap_or(false))?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            Ok(SystemVideoThumbnail {
                state: status.state,
                url: format!("data:image/webp;base64,{encoded}"),
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state, id, size, cache_key, batch);
        Err("当前系统未提供视频缩略图提取接口".into())
    }
}

#[tauri::command]
pub(crate) async fn open_asset_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let approved = approve_indexed_video(&state, &app, &id)?;
        open_video(&approved.path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn open_video(path: &Path) -> Result<(), String> {
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        },
    };
    let path: Vec<u16> = clean_path(path).encode_utf16().chain([0]).collect();
    let result = unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
            .ok()
            .map_err(|e| format!("无法启动系统播放器：{e}"))?;
        let result = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        CoUninitialize();
        result.0 as isize
    };
    if result <= 32 {
        return Err(format!("无法用系统默认播放器打开视频（{result}）"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_video(path: &Path) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(path)
        .spawn()
        .map_err(|e| format!("无法用系统默认播放器打开视频：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::Catalog;

    #[test]
    fn approves_only_existing_video_files_and_keeps_original_mp4_path() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("演示 [01].MP4");
        let image = temp.path().join("封面.png");
        std::fs::write(&path, b"video fixture").unwrap();
        std::fs::write(&image, b"image fixture").unwrap();
        let catalog = Catalog::open(&temp.path().join("catalog")).unwrap();
        assert!(catalog.add_file(&path, "loose").unwrap());
        assert!(catalog.add_file(&image, "loose").unwrap());
        let assets = catalog.assets().unwrap();
        let video = assets.iter().find(|asset| asset.kind == "video").unwrap();
        let approved = approved_video_file(video).unwrap();
        assert_eq!(approved.path, std::fs::canonicalize(&path).unwrap());
        assert_eq!(approved.mime, "video/mp4");
        assert_eq!(approved.length, b"video fixture".len() as u64);
        drop(approved);
        assert!(
            approved_video_file(assets.iter().find(|asset| asset.kind == "texture").unwrap())
                .is_err()
        );
        std::fs::remove_file(&path).unwrap();
        assert!(approved_video_file(video).is_err());
    }
}
