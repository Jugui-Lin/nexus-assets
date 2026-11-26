use super::{network_paths, watched_target, ConnectionIdentity, Desktop, Method};
use crate::team_import::{
    import_whiteboard_files, team_attachment_path, whiteboard_file_batch_size, WhiteboardFileBytes,
    WhiteboardFileReference, WhiteboardFileReport, MAX_WHITEBOARD_FILES, MAX_WHITEBOARD_FILE_BYTES,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use nexus_core::{
    clean_path,
    team::asset_format,
    whiteboard::{
        valid_whiteboard_id, valid_whiteboard_image_id, whiteboard_image_mime, WhiteboardBatch,
        WhiteboardCursor, WhiteboardImage, WhiteboardImageReceipt, WhiteboardOperation,
        WhiteboardPresenceRequest, WhiteboardPresenceSnapshot, WhiteboardProjectCreate,
        WhiteboardProjectRename, WhiteboardProjectsSnapshot, WhiteboardSnapshot,
        DEFAULT_WHITEBOARD_PROJECT, MAX_WHITEBOARD_BATCH_BYTES, MAX_WHITEBOARD_IMAGE_BASE64,
        MAX_WHITEBOARD_IMAGE_BYTES, MAX_WHITEBOARD_OPERATIONS,
    },
};
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

const ROUTE: &str = "/v1/whiteboard";
const PROJECTS_ROUTE: &str = "/v1/whiteboard-projects";
const BOARD_FEATURES: &str = "extended=1&assetReferences=1&groups=1&connections=1";

#[tauri::command]
pub(crate) async fn read_whiteboard_clipboard_files(
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        if !window.is_focused().map_err(|error| error.to_string())? {
            return Ok(Vec::new());
        }
        tauri::async_runtime::spawn_blocking(clipboard_file_paths)
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(Vec::new())
    }
}

#[cfg(windows)]
fn clipboard_file_paths() -> Result<Vec<String>, String> {
    use windows::Win32::{
        System::{
            DataExchange::{
                CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
            },
            Ole::CF_HDROP,
        },
        UI::Shell::{DragQueryFileW, HDROP},
    };
    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            // The clipboard is opened by this same thread and is only read here.
            let _ = unsafe { CloseClipboard() };
        }
    }
    let format = u32::from(CF_HDROP.0);
    // Clipboard-owned storage stays valid until Clipboard's guard closes it.
    unsafe {
        if IsClipboardFormatAvailable(format).is_err() {
            return Ok(Vec::new());
        }
        OpenClipboard(None).map_err(|_| "剪贴板正忙，请重新粘贴")?;
        let _clipboard = Clipboard;
        if IsClipboardFormatAvailable(format).is_err() {
            return Ok(Vec::new());
        }
        let drop_handle = HDROP(
            GetClipboardData(format)
                .map_err(|_| "无法读取剪贴板中的文件")?
                .0,
        );
        let count = DragQueryFileW(drop_handle, u32::MAX, None) as usize;
        if count > MAX_WHITEBOARD_FILES {
            return Err(format!("每次最多粘贴 {MAX_WHITEBOARD_FILES} 个附件文件"));
        }
        let mut paths = Vec::with_capacity(count);
        for index in 0..count as u32 {
            let length = DragQueryFileW(drop_handle, index, None) as usize;
            if !(1..=32_767).contains(&length) {
                return Err("剪贴板中的文件路径无效".into());
            }
            let mut name = vec![0; length + 1];
            if DragQueryFileW(drop_handle, index, Some(&mut name)) as usize != length {
                return Err("无法读取剪贴板中的文件路径".into());
            }
            paths.push(String::from_utf16(&name[..length]).map_err(|_| "剪贴板文件名无效")?);
        }
        Ok(paths)
    }
}

#[tauri::command]
pub(crate) async fn team_import_whiteboard_files(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: String,
    folder: String,
    paths: Option<Vec<String>>,
    files: Option<Vec<WhiteboardFileBytes>>,
) -> Result<WhiteboardFileReport, String> {
    let paths = paths.unwrap_or_default();
    let files = files.unwrap_or_default();
    whiteboard_file_batch_size(paths.len() + files.len())?;
    let encoded_limit = MAX_WHITEBOARD_FILE_BYTES.div_ceil(3) * 4 + files.len() * 4;
    if files.iter().map(|file| file.base64.len()).sum::<usize>() > encoded_limit {
        return Err("浏览器附件单次最多 16 MB".into());
    }
    let _operation = team.begin_storage_operation()?;
    let (connection, library_id, mount) = team
        .checked_write_target(&team_id, &library_id, &folder)
        .await?;
    require_nas_mount(&mount)?;
    let mut report = tauri::async_runtime::spawn_blocking(move || {
        import_whiteboard_files(&mount, &folder, paths, files)
    })
    .await
    .map_err(|error| error.to_string())??;
    if report
        .files
        .iter()
        .filter_map(|file| file.path.as_deref())
        .any(|path| asset_format(path).is_some())
    {
        report.index_pending = team
            .refresh_watched_library(&connection, &library_id)
            .await
            .is_err();
    }
    Ok(report)
}

fn require_nas_mount(path: &Path) -> Result<(), String> {
    if network_paths::folder_unc(path).is_none() {
        return Err("附件目标必须位于团队 NAS 挂载目录".into());
    }
    Ok(())
}

struct LinkedNasMount {
    id: String,
    unc: network_paths::UncDirectory,
    visible: bool,
}

struct NasAttachment {
    mount: PathBuf,
    relative: String,
    reference: WhiteboardFileReference,
}

impl NasAttachment {
    fn actual_path(&self) -> Result<(PathBuf, bool), String> {
        let (actual, is_folder) = team_attachment_path(&self.mount, &self.relative)?;
        if let Some(raw) = self.reference.unc.as_deref() {
            let expected = network_paths::UncDirectory::parse(raw).ok_or("NAS 附件路径无效")?;
            let actual_unc = network_paths::folder_unc(&actual).ok_or("NAS 附件位置已变更")?;
            if expected.relative_to(&actual_unc).as_deref() != Some("") {
                return Err("NAS 附件位置已变更，请重新引用此文件".into());
            }
        }
        Ok((actual, is_folder))
    }
}

async fn linked_nas_mounts(team: &Desktop, team_id: &str) -> Result<Vec<LinkedNasMount>, String> {
    let active = team.connection_for_team(team_id)?;
    let actual: ConnectionIdentity = team
        .request(&active.config, Method::GET, "/v1/info", None)
        .await?;
    if actual != active.identity || team.active_connection()? != active {
        return Err("团队连接已切换，请重新打开白板".into());
    }
    let mounts: Vec<_> = {
        let data = team.data.lock().unwrap();
        let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
        cached
            .catalog
            .libraries
            .iter()
            .filter(|library| library.watching)
            .filter_map(|library| {
                let mount = data.resolved_mount(cached, &library.id)?;
                let visible = !cached
                    .catalog
                    .hidden_folders
                    .iter()
                    .any(|folder| folder.library_id == library.id && folder.folder.is_empty());
                Some((library.id.clone(), mount, visible))
            })
            .collect()
    };
    Ok(mounts
        .into_iter()
        .filter_map(|(id, mount, visible)| {
            let unc = network_paths::folder_unc(Path::new(&mount))?;
            Some(LinkedNasMount { id, unc, visible })
        })
        .collect())
}

fn linked_attachment(
    team: &Desktop,
    team_id: &str,
    library_id: String,
    path: String,
    name: String,
) -> Result<NasAttachment, String> {
    let (_, _, mount) = {
        let data = team.data.lock().unwrap();
        watched_target(&data, team_id, &library_id, Some(&path))?
    };
    let mount = mount.ok_or("请先为团队库设置本机挂载目录")?;
    require_nas_mount(&mount)?;
    Ok(NasAttachment {
        mount,
        relative: path.clone(),
        reference: WhiteboardFileReference {
            name,
            is_folder: None,
            library_id: Some(library_id),
            path: Some(path),
            unc: None,
        },
    })
}

fn original_nas_attachment(
    team: &Desktop,
    team_id: &str,
    mounts: &[LinkedNasMount],
    unc: network_paths::UncDirectory,
) -> Result<NasAttachment, String> {
    let linked = mounts
        .iter()
        .filter_map(|mount| unc.relative_to(&mount.unc).map(|path| (mount, path)))
        .min_by(|(left, left_path), (right, right_path)| {
            (left_path.matches('/').count(), left_path.len(), &left.id).cmp(&(
                right_path.matches('/').count(),
                right_path.len(),
                &right.id,
            ))
        });
    if let Some((mount, path)) = linked {
        return linked_attachment(
            team,
            team_id,
            mount.id.clone(),
            path,
            unc.basename().to_owned(),
        );
    }
    if !mounts
        .iter()
        .any(|mount| mount.visible && unc.same_host(&mount.unc))
    {
        return Err("此文件所在 NAS 尚未加入当前团队，请将文件复制到已配置的团队目录".into());
    }
    let (share, relative) = unc.relative_to_share();
    Ok(NasAttachment {
        mount: PathBuf::from(share),
        relative,
        reference: WhiteboardFileReference {
            name: unc.basename().to_owned(),
            is_folder: None,
            library_id: None,
            path: None,
            unc: Some(unc.text()),
        },
    })
}

#[tauri::command]
pub(crate) async fn team_reference_whiteboard_files(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    paths: Vec<String>,
) -> Result<WhiteboardFileReport, String> {
    whiteboard_file_batch_size(paths.len())?;
    let _operation = team.begin_storage_operation()?;
    let mounts = linked_nas_mounts(&team, &team_id).await?;
    let planned = paths
        .into_iter()
        .map(|path| {
            let attachment = network_paths::folder_unc(Path::new(&path))
                .ok_or_else(|| "原位置引用只支持 NAS 文件或文件夹".to_owned())
                .and_then(|unc| original_nas_attachment(&team, &team_id, &mounts, unc));
            (path, attachment)
        })
        .collect::<Vec<_>>();
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = WhiteboardFileReport::default();
        for (path, attachment) in planned {
            report.add(
                Path::new(&path),
                attachment.and_then(|mut attachment| {
                    let (_, is_folder) = attachment.actual_path()?;
                    attachment.reference.is_folder = is_folder.then_some(true);
                    Ok(attachment.reference)
                }),
            );
        }
        report
    })
    .await
    .map_err(|error| error.to_string())
}

async fn resolve_whiteboard_file(
    team: &Desktop,
    team_id: &str,
    library_id: Option<String>,
    path: Option<String>,
    unc: Option<String>,
) -> Result<NasAttachment, String> {
    match (library_id, path, unc) {
        (Some(library_id), Some(path), None) => {
            let (_, _, mount) = team
                .checked_write_target(team_id, &library_id, &path)
                .await?;
            require_nas_mount(&mount)?;
            Ok(NasAttachment {
                mount,
                relative: path.clone(),
                reference: WhiteboardFileReference {
                    name: String::new(),
                    is_folder: None,
                    library_id: Some(library_id),
                    path: Some(path),
                    unc: None,
                },
            })
        }
        (None, None, Some(path)) => {
            let unc = network_paths::UncDirectory::parse(&path).ok_or("NAS 附件路径无效")?;
            let mounts = linked_nas_mounts(team, team_id).await?;
            original_nas_attachment(team, team_id, &mounts, unc)
        }
        _ => Err("白板附件路径无效".into()),
    }
}

#[tauri::command]
pub(crate) async fn team_reveal_whiteboard_file(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: Option<String>,
    path: Option<String>,
    unc: Option<String>,
    is_folder: Option<bool>,
) -> Result<(), String> {
    let _operation = team.begin_storage_operation()?;
    let attachment = resolve_whiteboard_file(&team, &team_id, library_id, path, unc).await?;
    let (actual, directory) =
        tauri::async_runtime::spawn_blocking(move || attachment.actual_path())
            .await
            .map_err(|error| error.to_string())??;
    if directory != is_folder.unwrap_or(false) {
        return Err("附件类型已变更，请重新添加引用".into());
    }
    let location = clean_path(&actual);
    if directory {
        crate::open_folder_location(PathBuf::from(location)).await
    } else {
        tauri::async_runtime::spawn_blocking(move || crate::reveal_path(&location))
            .await
            .map_err(|error| error.to_string())?
    }
}

fn whiteboard_preview_sidecar(
    team: &Desktop,
    team_id: &str,
    attachment: &NasAttachment,
) -> Option<String> {
    let path = Path::new(&attachment.relative);
    if !path.extension()?.to_str()?.eq_ignore_ascii_case("c4d") {
        return None;
    }
    let sibling = path.with_extension("jpg");
    let relative = sibling.to_str()?.replace('\\', "/");
    if let Some(library_id) = attachment.reference.library_id.as_deref() {
        let data = team.data.lock().unwrap();
        let (_, _, mount) = watched_target(&data, team_id, library_id, Some(&relative)).ok()?;
        if mount.as_deref() != Some(attachment.mount.as_path()) {
            return None;
        }
    }
    Some(relative)
}

fn read_whiteboard_file_preview(
    attachment: NasAttachment,
    sidecar: Option<String>,
) -> Result<Option<String>, String> {
    let (actual, is_folder) = attachment.actual_path()?;
    if is_folder {
        return Ok(None);
    }
    let preview = nexus_core::attachment_preview_png(&actual);
    let preview = match (preview, sidecar) {
        (Ok(Some(bytes)), _) => Some(bytes),
        (preview, Some(relative)) => match team_attachment_path(&attachment.mount, &relative) {
            Ok((path, false)) => nexus_core::attachment_preview_png(&path)?,
            _ => preview?,
        },
        (preview, None) => preview?,
    };
    Ok(preview.map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes))))
}

#[tauri::command]
pub(crate) async fn team_preview_whiteboard_file(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: Option<String>,
    path: Option<String>,
    unc: Option<String>,
) -> Result<Option<String>, String> {
    let Some(raw_path) = path.as_deref().or(unc.as_deref()) else {
        return Ok(None);
    };
    if !nexus_core::supports_attachment_preview(Path::new(raw_path)) {
        return Ok(None);
    }
    let _slot = crate::thumbnail_desktop::image_slot().await?;
    let active = team.connection_for_team(&team_id)?;
    let attachment = resolve_whiteboard_file(&team, &team_id, library_id, path, unc).await?;
    let sidecar = whiteboard_preview_sidecar(&team, &team_id, &attachment);
    let preview =
        tauri::async_runtime::spawn_blocking(move || read_whiteboard_file_preview(attachment, sidecar))
            .await
            .map_err(|error| error.to_string())??;
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    Ok(preview)
}

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
pub(crate) async fn team_whiteboard_presence(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    project_id: String,
    session_id: String,
    active: bool,
    cursor: Option<WhiteboardCursor>,
) -> Result<Option<WhiteboardPresenceSnapshot>, String> {
    if !valid_whiteboard_id(&project_id) || uuid::Uuid::parse_str(&session_id).is_err() {
        return Err("白板协作会话无效".into());
    }
    let board = team.connection_for_team(&team_id)?;
    let input = WhiteboardPresenceRequest {
        project_id,
        session_id,
        active,
        cursor,
    };
    let body = serde_json::to_vec(&input).map_err(|error| error.to_string())?;
    let request = team.authenticated_request(
        &board.config,
        Method::POST,
        "/v1/whiteboard-presence",
        Some(body),
    );
    let response = Desktop::send(request.timeout(Duration::from_secs(3))).await?;
    let snapshot = if matches!(response.status().as_u16(), 404 | 405 | 501) {
        None
    } else {
        Some(Desktop::decode_response(response).await?)
    };
    if team.active_connection()? != board {
        return Err("团队工作空间已切换".into());
    }
    Ok(snapshot)
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
