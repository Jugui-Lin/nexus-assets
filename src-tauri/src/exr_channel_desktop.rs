use crate::{
    local_explorer::validate_file_path,
    preview_image_payload,
    thumbnail_desktop::{image_slot, PreviewSource},
    workspace_folder_move::link_or_reparse,
    AppState,
};
use serde_json::{json, Value};
use std::{fs, io::Cursor, path::PathBuf};

#[tauri::command]
pub(crate) async fn read_exr_channel_view(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    id: Option<String>,
    path: Option<PathBuf>,
    choice: Option<String>,
    revision: Option<String>,
) -> Result<Value, String> {
    let selection = match (choice, revision) {
        (None, None) => None,
        (Some(key), Some(revision)) if key.len() <= 2048 && revision.len() <= 128 => {
            Some((key, revision))
        }
        _ => return Err("EXR 通道选择无效。".into()),
    };
    let _slot = image_slot().await?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = match (id, path) {
            (Some(id), None) => {
                let asset = PreviewSource::resolve(&state, &app, &id)?.asset;
                if asset.demo {
                    return Err("示例资产暂无 EXR 原始文件。".into());
                }
                PathBuf::from(asset.path)
            }
            (None, Some(path)) => path,
            _ => return Err("请选择一个 EXR 文件。".into()),
        };
        validate_file_path(&path)?;
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exr"))
        {
            return Err("通道对照支持 EXR 文件。".into());
        }
        let info = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if !info.is_file() || link_or_reparse(&info) {
            return Err("请选择可直接读取的 EXR 文件。".into());
        }
        let selection = selection
            .as_ref()
            .map(|(key, version)| (key.as_str(), version.as_str()));
        let (revision, views, pixels) = nexus_core::read_exr_views(&path, selection)?;
        if let Some(pixels) = pixels {
            let mut bytes = Cursor::new(Vec::new());
            pixels
                .write_to(&mut bytes, image::ImageFormat::Png)
                .map_err(|error| error.to_string())?;
            return Ok(preview_image_payload(Some((
                "image/png".into(),
                bytes.into_inner(),
            ))));
        }
        Ok(json!({"revision":revision,"views":views}))
    })
    .await
    .map_err(|error| error.to_string())?
}
