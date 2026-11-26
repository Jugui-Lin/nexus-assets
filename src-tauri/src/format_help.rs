use crate::{mesh_preview, session_supports_asset, AppState};
use nexus_core::{
    asset_raster_preview_limit, asset_thumbnail, c4d_smart_compatible, clean_path, compatible,
    kind, now, video_mime,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs::File,
    path::{Path, PathBuf},
};
use tauri::{State, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    path: String,
    name: String,
    readable: bool,
    bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCapability {
    mode: &'static str,
    byte_limit: Option<u64>,
    cover_found: Option<bool>,
    condition: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DccCapability {
    host: &'static str,
    label: &'static str,
    online: usize,
    direct: usize,
    smart: usize,
    condition: Option<&'static str>,
}

#[derive(Serialize)]
pub(crate) struct FormatReport {
    extension: String,
    kind: Option<&'static str>,
    file: Option<Candidate>,
    preview: PreviewCapability,
    dcc: Vec<DccCapability>,
}

fn extension_query(raw: &str) -> Result<String, String> {
    let extension = raw.trim().trim_start_matches('.');
    if extension.is_empty()
        || extension.len() > 20
        || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("请输入单个文件扩展名，例如 png、fbx 或 hiplc。".into());
    }
    Ok(extension.to_ascii_lowercase())
}

fn candidate_file(path: PathBuf) -> Candidate {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let bytes = File::open(&path)
        .ok()
        .and_then(|file| file.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len());
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    Candidate {
        path: clean_path(&canonical),
        name,
        readable: bytes.is_some(),
        bytes,
    }
}

fn preview(extension: &str, category: Option<&str>, file: Option<&Candidate>) -> PreviewCapability {
    let cover_found = file
        .filter(|_| category.is_some_and(|kind| kind != "texture"))
        .map(|file| file.readable && asset_thumbnail(Path::new(&file.path)).is_some());
    let (mode, byte_limit, condition) = match extension {
        _ if category.is_none() => ("unsupported", None, None),
        _ if video_mime(extension).is_some() => (
            "video",
            None,
            Some("实际播放取决于视频编码和 WebView 解码能力"),
        ),
        ext if mesh_preview::source_byte_limit(ext, false).is_some() => (
            "mesh",
            mesh_preview::source_byte_limit(ext, false),
            (ext == "gltf").then_some("交互预览需要内嵌几何，外部缓冲区由兼容的创作软件加载"),
        ),
        ext if asset_raster_preview_limit(ext).is_some() => (
            if ext == "ies" { "photometric" } else { "image" },
            asset_raster_preview_limit(ext),
            None,
        ),
        "c4d" | "max" => ("embedded", None, Some("显示工程内嵌图或独立封面")),
        _ if category != Some("texture") => {
            ("cover", None, Some("可使用同名图片或文件夹预览图作封面"))
        }
        _ => ("unsupported", None, None),
    };
    PreviewCapability {
        mode,
        byte_limit,
        cover_found,
        condition,
    }
}

fn dcc_formats(extension: &str, sessions: &[Value], now: u64) -> Vec<DccCapability> {
    const HOSTS: &[(&str, &str)] = &[
        ("blender", "Blender"),
        ("c4d", "Cinema 4D"),
        ("maya", "Maya"),
        ("max", "3ds Max"),
        ("houdini", "Houdini"),
    ];
    HOSTS
        .iter()
        .filter_map(|&(host, label)| {
            let smart_supported = host == "c4d" && c4d_smart_compatible(extension);
            if !compatible(host, extension) && !smart_supported {
                return None;
            }
            let (mut online, mut direct, mut smart) = (0, 0, 0);
            for session in sessions.iter().filter(|session| {
                session["dcc"] == host
                    && now.saturating_sub(session["lastSeen"].as_u64().unwrap_or(0)) < 15
            }) {
                online += 1;
                direct += usize::from(session_supports_asset(session, extension));
                smart += usize::from(smart_supported && session["smartImport"] == true);
            }
            let condition = match (host, extension) {
                ("blender", "max") => Some("需要支持 MAX 导入的 Blender 桥接"),
                ("c4d", "blend") => Some("智能导入使用 Blender 转换工程"),
                ("c4d", "max") => Some("智能导入需要可用的工程转换工具"),
                ("c4d", "sbsar") => Some("智能导入需要 Substance 3D 的 sbsrender"),
                _ if !compatible(host, extension) => Some("通过 Cinema 4D 智能导入"),
                _ => None,
            };
            Some(DccCapability {
                host,
                label,
                online,
                direct,
                smart,
                condition,
            })
        })
        .collect()
}

fn report(extension: String, file: Option<Candidate>, sessions: &[Value]) -> FormatReport {
    let category = kind(&extension);
    FormatReport {
        preview: preview(&extension, category, file.as_ref()),
        dcc: dcc_formats(&extension, sessions, now()),
        kind: category,
        file,
        extension,
    }
}

#[tauri::command]
pub(crate) async fn query_format_capabilities(
    state: State<'_, AppState>,
    window: WebviewWindow,
    extension: Option<String>,
    pick_file: Option<bool>,
) -> Result<Option<FormatReport>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (extension, file) = if pick_file == Some(true) {
            let Some(path) = rfd::FileDialog::new()
                .set_parent(&window)
                .set_title("选择要查询格式的文件")
                .pick_file()
            else {
                return Ok(None);
            };
            crate::local_explorer::validate_file_path(&path)?;
            let ext = path
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            (ext, Some(candidate_file(path)))
        } else {
            (
                extension_query(extension.as_deref().unwrap_or_default())?,
                None,
            )
        };
        let sessions = state
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        Ok(Some(report(extension, file, &sessions)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn separates_real_file_index_and_preview_boundaries() {
        assert_eq!(extension_query(" .HiPlc ").unwrap(), "hiplc");
        assert!(extension_query("scene.fbx").is_err());
        let scratch = tempfile::tempdir().unwrap();
        let raw = scratch.path().join("fixture.HIPLC");
        let cover = scratch.path().join("fixture.HIPLC.png");
        std::fs::write(&raw, b"fixture").unwrap();
        std::fs::write(&cover, b"cover presence").unwrap();
        let file = candidate_file(raw);
        assert!(file.readable);
        assert_eq!(file.bytes, Some(7));
        let result = report("hiplc".into(), Some(file), &[]);
        assert_eq!(result.kind, Some("scene"));
        assert_eq!(result.preview.mode, "cover");
        assert_eq!(result.preview.cover_found, Some(true));
        assert_eq!(result.dcc[0].host, "houdini");
        assert_eq!(result.dcc[0].online, 0);

        let svg = report("svg".into(), None, &[]);
        assert_eq!(svg.kind, Some("texture"));
        assert_eq!(svg.preview.mode, "unsupported");
        let fbx = report("fbx".into(), None, &[]);
        assert_eq!(fbx.preview.mode, "mesh");
        assert_eq!(
            fbx.preview.byte_limit,
            mesh_preview::source_byte_limit("fbx", false)
        );
        assert_eq!(report("mkv".into(), None, &[]).preview.mode, "video");
        let unsupported = report("exe".into(), None, &[]);
        assert!(unsupported.kind.is_none() && unsupported.dcc.is_empty());
    }

    #[test]
    fn counts_each_live_bridge_and_its_actual_routes() {
        let sessions = vec![
            json!({"dcc":"blender","lastSeen":100}),
            json!({"dcc":"blender","lastSeen":101,"maxImport":true}),
            json!({"dcc":"blender","lastSeen":85,"maxImport":true}),
            json!({"dcc":"c4d","lastSeen":101,"smartImport":true}),
            json!({"dcc":"c4d","lastSeen":101}),
        ];
        let hosts = dcc_formats("max", &sessions, 102);
        let blender = hosts.iter().find(|entry| entry.host == "blender").unwrap();
        assert_eq!((blender.online, blender.direct, blender.smart), (2, 1, 0));
        let c4d = hosts.iter().find(|entry| entry.host == "c4d").unwrap();
        assert_eq!((c4d.online, c4d.direct, c4d.smart), (2, 0, 1));
        assert_eq!(dcc_formats("sbsar", &sessions, 102)[0].smart, 1);
        assert_eq!(dcc_formats("gltf", &sessions, 102)[0].direct, 2);
    }
}
