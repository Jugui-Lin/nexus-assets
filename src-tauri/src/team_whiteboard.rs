use super::{Desktop, Method};
use base64::{engine::general_purpose::STANDARD, Engine};
use nexus_core::whiteboard::{
    valid_whiteboard_id, valid_whiteboard_image_id, whiteboard_image_mime, WhiteboardBatch,
    WhiteboardImage, WhiteboardImageReceipt, WhiteboardOperation, WhiteboardProjectCreate,
    WhiteboardProjectRename, WhiteboardProjectsSnapshot, WhiteboardSnapshot,
    DEFAULT_WHITEBOARD_PROJECT, MAX_WHITEBOARD_BATCH_BYTES, MAX_WHITEBOARD_IMAGE_BASE64,
    MAX_WHITEBOARD_IMAGE_BYTES, MAX_WHITEBOARD_OPERATIONS,
};
use serde::Serialize;
use std::{fs, io::Read, path::Path};

const ROUTE: &str = "/v1/whiteboard";
const PROJECTS_ROUTE: &str = "/v1/whiteboard-projects";
const BOARD_FEATURES: &str = "extended=1&assetReferences=1&groups=1&connections=1";

fn board_route(project: Option<&str>) -> Result<String, String> {
    match project {
        None | Some(DEFAULT_WHITEBOARD_PROJECT) => Ok(format!("{ROUTE}?{BOARD_FEATURES}")),
        Some(id) if valid_whiteboard_id(id) => Ok(format!("{ROUTE}/{id}?{BOARD_FEATURES}")),
        Some(_) => Err("白板项目编号无效".into()),
    }
}

fn image_route(image_id: &str) -> Result<String, String> {
    if !valid_whiteboard_image_id(image_id) {
        return Err("白板图片编号无效".into());
    }
    Ok(format!("/v1/whiteboard-images/{image_id}"))
}

#[tauri::command]
pub(crate) async fn team_whiteboard_put_image(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    image_id: String,
    mime: String,
    base64: String,
) -> Result<WhiteboardImageReceipt, String> {
    if base64.len() > MAX_WHITEBOARD_IMAGE_BASE64 {
        return Err("白板图片须小于或等于 8 MB".into());
    }
    let body =
        serde_json::to_vec(&WhiteboardImage { mime, base64 }).map_err(|error| error.to_string())?;
    team.scoped_request(&team_id, Method::PUT, &image_route(&image_id)?, Some(body))
        .await
}

#[tauri::command]
pub(crate) async fn team_whiteboard_get_image(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    image_id: String,
) -> Result<WhiteboardImage, String> {
    team.scoped_request(&team_id, Method::GET, &image_route(&image_id)?, None)
        .await
}

#[derive(Serialize)]
pub(crate) struct LocalWhiteboardImage {
    name: String,
    #[serde(flatten)]
    image: WhiteboardImage,
}

#[tauri::command]
pub(crate) async fn read_whiteboard_image_file(
    path: String,
) -> Result<LocalWhiteboardImage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        let invalid = || "请选择不超过 8 MB 的 PNG、JPEG、GIF 或 WebP 图片".to_owned();
        if !path.is_absolute() {
            return Err(invalid());
        }
        let metadata = fs::metadata(path).map_err(|_| invalid())?;
        if !metadata.is_file() || !(1..=MAX_WHITEBOARD_IMAGE_BYTES as u64).contains(&metadata.len())
        {
            return Err(invalid());
        }
        let mut data = Vec::with_capacity(metadata.len() as usize);
        fs::File::open(path)
            .and_then(|file| {
                file.take(MAX_WHITEBOARD_IMAGE_BYTES as u64 + 1)
                    .read_to_end(&mut data)
            })
            .map_err(|_| invalid())?;
        let mime = whiteboard_image_mime(&data).ok_or_else(invalid)?;
        let name = path
            .file_name()
            .ok_or_else(invalid)?
            .to_string_lossy()
            .into_owned();
        Ok(LocalWhiteboardImage {
            name,
            image: WhiteboardImage {
                mime: mime.into(),
                base64: STANDARD.encode(data),
            },
        })
    })
    .await
    .map_err(|_| "无法读取白板图片".to_owned())?
}

#[tauri::command]
pub(crate) async fn team_whiteboard_get(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    project_id: Option<String>,
) -> Result<WhiteboardSnapshot, String> {
    team.scoped_request(
        &team_id,
        Method::GET,
        &board_route(project_id.as_deref())?,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_whiteboard_apply(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    operations: Vec<WhiteboardOperation>,
    batch_id: Option<String>,
    project_id: Option<String>,
) -> Result<WhiteboardSnapshot, String> {
    if operations.len() > MAX_WHITEBOARD_OPERATIONS {
        return Err("白板一次最多保存 64 项修改".into());
    }
    let batch = WhiteboardBatch {
        operations,
        batch_id,
    };
    let body = serde_json::to_vec(&batch).map_err(|error| error.to_string())?;
    if body.len() > MAX_WHITEBOARD_BATCH_BYTES {
        return Err("本次白板修改数据过大".into());
    }
    team.scoped_request(
        &team_id,
        Method::POST,
        &board_route(project_id.as_deref())?,
        Some(body),
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_whiteboard_projects(
    team: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<WhiteboardProjectsSnapshot, String> {
    team.scoped_request(&team_id, Method::GET, PROJECTS_ROUTE, None)
        .await
}

#[tauri::command]
pub(crate) async fn team_whiteboard_create_project(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    project_id: String,
    name: String,
) -> Result<WhiteboardProjectsSnapshot, String> {
    let input = WhiteboardProjectCreate {
        id: project_id,
        name,
    };
    let body = serde_json::to_vec(&input).map_err(|error| error.to_string())?;
    team.scoped_request(&team_id, Method::POST, PROJECTS_ROUTE, Some(body))
        .await
}

#[tauri::command]
pub(crate) async fn team_whiteboard_rename_project(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    project_id: String,
    name: String,
) -> Result<WhiteboardProjectsSnapshot, String> {
    if !valid_whiteboard_id(&project_id) {
        return Err("白板项目编号无效".into());
    }
    let input = WhiteboardProjectRename { name };
    let body = serde_json::to_vec(&input).map_err(|error| error.to_string())?;
    team.scoped_request(
        &team_id,
        Method::PATCH,
        &format!("{PROJECTS_ROUTE}/{project_id}"),
        Some(body),
    )
    .await
}
