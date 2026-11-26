use crate::{asset_versions::stage_copy, resolve_asset, team_network_paths::folder_unc, AppState};
use nexus_core::{clean_path, now, video_mime};
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LockedPreview {
    path: String,
    version: String,
    bytes: u64,
    locked_at: u64,
}

fn version_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn copy_preview(
    source: &Path,
    directory: &Path,
    shot: &str,
    version: &str,
) -> Result<LockedPreview, String> {
    if !version_component(shot) || !version_component(version) {
        return Err("镜头号和版号只能使用字母、数字、连字符或下划线".into());
    }
    let suffix = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| video_mime(value).is_some())
        .ok_or("仅支持将视频样片锁定为送审版本")?;
    if !directory.is_absolute() {
        return Err("请选择送审样片的保存目录".into());
    }
    let directory =
        fs::canonicalize(directory).map_err(|error| format!("无法打开送审目录：{error}"))?;
    if !directory.is_dir() {
        return Err("请选择实际存在的送审目录".into());
    }
    let target = directory.join(format!("{shot}-{version}.{suffix}"));
    if target.try_exists().map_err(|error| error.to_string())? {
        return Err("送审目录已有同名版本，请使用新的版号或目录".into());
    }
    let (staged, bytes) = stage_copy(source, &directory)?;
    staged
        .persist_noclobber(&target)
        .map_err(|error| format!("无法保存送审副本：{}", error.error))?;
    Ok(LockedPreview {
        path: folder_unc(&target)
            .map(|path| path.text())
            .unwrap_or_else(|| clean_path(&target)),
        version: version.to_owned(),
        bytes,
        locked_at: now(),
    })
}

#[tauri::command]
pub(super) async fn lock_shot_preview(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    asset_id: String,
    destination: String,
    shot: String,
    version: String,
) -> Result<LockedPreview, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let asset = resolve_asset(&state, &app, &asset_id)?;
        if asset.kind != "video" {
            return Err("请先选择已入库的视频样片".into());
        }
        copy_preview(
            Path::new(&asset.path),
            Path::new(&destination),
            &shot,
            &version,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locks_once_without_overwriting_and_keeps_the_original_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("preview.mp4");
        fs::write(&source, b"version four").unwrap();
        let locked = copy_preview(&source, dir.path(), "SH010", "V04").unwrap();
        fs::write(&source, b"version five").unwrap();
        assert_eq!(fs::read(locked.path).unwrap(), b"version four");
        assert!(copy_preview(&source, dir.path(), "SH010", "V04").is_err());
        assert!(copy_preview(&source, dir.path(), "../SH010", "V04").is_err());
        assert_eq!(fs::read(&source).unwrap(), b"version five");
    }
}
