use crate::{lock_db, team_desktop::Desktop, AppState};
use nexus_core::baidu_cloud::{self, BaiduClient, BaiduLogin, LoginMode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::Manager;
use uuid::Uuid;

const APP_ROOT: &str = "/apps/bdpan";
const LINK_LIMIT: usize = 128;
pub(super) const DOWNLOAD_LIMIT: u64 = 64 * 1024 * 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct PersonalLogins(Arc<Mutex<HashMap<PathBuf, BaiduLogin>>>);

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum CloudAction {
    Links,
    Status,
    Start,
    Poll,
    Cancel,
    CreateAppFolder,
    Logout,
    Browse { path: String, offset: u32 },
    Add { path: String },
    Remove { id: Uuid },
    List { id: Uuid, path: String, offset: u32 },
    Download { id: Uuid, path: String },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonalLink {
    id: Uuid,
    name: String,
    root: String,
    connection: String,
}

#[tauri::command]
pub(crate) async fn baidu_cloud(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    logins: tauri::State<'_, PersonalLogins>,
    team_id: Option<String>,
    action: CloudAction,
) -> Result<Value, String> {
    if let Some(team_id) = team_id {
        return app
            .state::<Desktop>()
            .baidu_cloud_request(&team_id, action)
            .await;
    }
    let workspace = lock_db(&state)?.dir.clone();
    let identity = Sha256::digest(workspace.to_string_lossy().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let personal = state
        .root
        .join("baidu-cloud")
        .join("personal")
        .join(identity);
    let links_path = personal.join("links.json");
    let profile = personal.join("login");
    if matches!(action, CloudAction::Links | CloudAction::Remove { .. }) {
        let logins = logins.inner().clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _guard = logins.0.lock().map_err(|_| "百度网盘正在切换连接")?;
            let mut links = load_links(&links_path)?;
            if let CloudAction::Remove { id } = action {
                links.retain(|link| link.id != id);
                save_links(&links_path, &links)?;
            }
            Ok(public_links(&links))
        })
        .await
        .map_err(|_| "无法读取网盘链接")?;
    }

    #[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
    {
        let _ = profile;
        return if matches!(action, CloudAction::Status) {
            Ok(json!({"available":false,"connected":false}))
        } else {
            Err("百度网盘个人连接当前支持 Windows x64".into())
        };
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        if !profile.is_dir() && matches!(action, CloudAction::Status | CloudAction::Logout) {
            return Ok(json!({"available":true,"connected":false}));
        }
        let exe = baidu_cloud::ensure_windows_cli(&state.root.join("baidu-cloud")).await?;
        let logins = logins.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let client = BaiduClient::new(exe, profile.clone())?;
            personal_request(&client, &profile, &links_path, &logins, action)
        })
        .await
        .map_err(|_| "无法完成百度网盘操作")?
    }
}

fn load_links(path: &Path) -> Result<Vec<PersonalLink>, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|_| "百度网盘链接记录无法读取".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn save_links(path: &Path, links: &[PersonalLink]) -> Result<(), String> {
    let parent = path.parent().ok_or("网盘链接位置无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(temp.as_file(), links).map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn public_links(links: &[PersonalLink]) -> Value {
    Value::Array(
        links
            .iter()
            .map(|link| json!({"id":link.id, "name":link.name, "owned":true}))
            .collect(),
    )
}

fn personal_request(
    client: &BaiduClient,
    profile: &Path,
    links_path: &Path,
    logins: &PersonalLogins,
    action: CloudAction,
) -> Result<Value, String> {
    match action {
        CloudAction::Status => {
            Ok(json!({"available":true, "connected":client.status()?.connected}))
        }
        CloudAction::Start => {
            let mut jobs = logins.0.lock().map_err(|_| "百度网盘正在切换连接")?;
            jobs.remove(profile);
            jobs.insert(profile.to_owned(), client.start_login(LoginMode::Browser)?);
            Ok(json!({"pending":true}))
        }
        CloudAction::Poll => {
            let mut jobs = logins.0.lock().map_err(|_| "百度网盘正在切换连接")?;
            let pending = if let Some(job) = jobs.get(profile) {
                let pending = job.poll()?.pending;
                if !pending {
                    jobs.remove(profile);
                }
                pending
            } else {
                false
            };
            Ok(json!({"pending":pending,"connected":!pending && client.status()?.connected}))
        }
        CloudAction::Cancel => {
            logins
                .0
                .lock()
                .map_err(|_| "百度网盘正在切换连接")?
                .remove(profile);
            Ok(json!({"pending":false}))
        }
        CloudAction::CreateAppFolder => Ok(json!({"path":client.create_app_folder()?})),
        CloudAction::Logout => {
            logins
                .0
                .lock()
                .map_err(|_| "百度网盘正在切换连接")?
                .remove(profile);
            client.logout()?;
            Ok(json!({"available":true,"connected":false}))
        }
        CloudAction::Browse { path, offset } => {
            let page = client.list(&path, true, offset, 100)?;
            serde_json::to_value(page).map_err(|e| e.to_string())
        }
        CloudAction::Add { path } => {
            let root = baidu_cloud::normalize_path(&path)?;
            if root == APP_ROOT {
                return Err("请选一个要添加的子文件夹".into());
            }
            let connection = client.status()?.connection_id.ok_or("请先登录百度网盘")?;
            if !client.metadata_for(&connection, &root)?.directory {
                return Err("请选择网盘文件夹".into());
            }
            let _guard = logins.0.lock().map_err(|_| "百度网盘正在切换连接")?;
            if client.status()?.connection_id.as_ref() != Some(&connection) {
                return Err("百度网盘账号已切换，请重新选择目录".into());
            }
            let mut links = load_links(links_path)?;
            if let Some(link) = links
                .iter()
                .find(|link| link.root == root && link.connection == connection)
            {
                return Ok(json!({"id":link.id,"name":link.name,"owned":true}));
            }
            if links.len() >= LINK_LIMIT {
                return Err("此工作空间的百度网盘链接已达上限".into());
            }
            let name = root.rsplit('/').next().unwrap_or("百度网盘").to_owned();
            let link = PersonalLink {
                id: Uuid::new_v4(),
                name,
                root,
                connection,
            };
            let result = json!({"id":link.id,"name":link.name,"owned":true});
            links.push(link);
            save_links(links_path, &links)?;
            Ok(result)
        }
        CloudAction::List { id, path, offset } => {
            let link = selected_link(links_path, client, id)?;
            let source = linked_path(&link.root, &path)?;
            let mut page = client.list_for(&link.connection, &source, false, offset, 100)?;
            ensure_connection(client, &link)?;
            for entry in &mut page.entries {
                entry.path = entry
                    .path
                    .strip_prefix(&link.root)
                    .and_then(|p| p.strip_prefix('/'))
                    .ok_or("网盘返回的文件超出了已选目录")?
                    .to_owned();
            }
            serde_json::to_value(page).map_err(|e| e.to_string())
        }
        CloudAction::Download { id, path } => {
            let link = selected_link(links_path, client, id)?;
            let source = linked_path(&link.root, &path)?;
            let name = download_name(&path)?;
            let Some(destination) = save_destination(name) else {
                return Ok(json!({"saved":false}));
            };
            let temp = tempfile::tempdir_in(destination.parent().ok_or("保存位置无效")?)
                .map_err(|e| e.to_string())?;
            let staged = temp.path().join(name);
            ensure_connection(client, &link)?;
            client.download_for_limit(&link.connection, &source, &staged, DOWNLOAD_LIMIT)?;
            ensure_connection(client, &link)?;
            fs::rename(staged, destination).map_err(|e| e.to_string())?;
            Ok(json!({"saved":true}))
        }
        CloudAction::Links | CloudAction::Remove { .. } => unreachable!(),
    }
}

fn ensure_connection(client: &BaiduClient, link: &PersonalLink) -> Result<(), String> {
    if client.status()?.connection_id.as_ref() != Some(&link.connection) {
        return Err("此链接的授权已变更，请重新选择网盘目录".into());
    }
    Ok(())
}

fn selected_link(path: &Path, client: &BaiduClient, id: Uuid) -> Result<PersonalLink, String> {
    let link = load_links(path)?
        .into_iter()
        .find(|link| link.id == id)
        .ok_or("找不到百度网盘链接")?;
    ensure_connection(client, &link)?;
    Ok(link)
}

pub(super) fn linked_path(root: &str, relative: &str) -> Result<String, String> {
    if relative.is_empty() {
        return baidu_cloud::normalize_path(root);
    }
    baidu_cloud::normalize_path(&format!("{root}/{relative}"))
}

pub(super) fn download_name(path: &str) -> Result<&str, String> {
    linked_path(APP_ROOT, path)?;
    let name = path.rsplit('/').next().ok_or("文件名称无效")?;
    if name.is_empty()
        || name.ends_with([' ', '.'])
        || name.contains(['<', '>', ':', '"', '\\', '|', '?', '*'])
    {
        return Err("此网盘文件名称无法在本机保存".into());
    }
    Ok(name)
}

pub(super) fn save_destination(name: &str) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title("保存百度网盘文件")
        .set_file_name(name)
        .save_file()
}

#[tauri::command]
pub(crate) fn baidu_open_authorization(url: String) -> Result<(), String> {
    let address = reqwest::Url::parse(&url).map_err(|_| "百度授权链接无效")?;
    if address.scheme() != "https"
        || !matches!(
            address.host_str(),
            Some("openapi.baidu.com" | "developer.baidu.com" | "pan.baidu.com")
        )
        || address.port().is_some()
        || !address.username().is_empty()
        || address.password().is_some()
        || !(address.path() == "/device" || address.path() == "/oauth/2.0/authorize")
    {
        return Err("百度授权链接无效".into());
    }
    crate::subscription_open::open_web_page(&address).map_err(|_| "无法打开百度授权网页".into())
}
