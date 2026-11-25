use crate::AppState;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use tauri::State;
use tokio::{sync::Mutex, time::Instant};
use uuid::Uuid;

const TEAM_PORT: u16 = 47822;
const CACHE_FILE: &str = "host.json";
static HOST_OPERATION: Mutex<()> = Mutex::const_new(());

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    team_id: Uuid,
    admin_id: Uuid,
    token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedTeam {
    team_name: String,
    admin_name: String,
    listen: SocketAddrV4,
    credentials: Credentials,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunningTeam {
    team_id: Uuid,
    member_id: Uuid,
    role: String,
}

impl HostedTeam {
    fn url(&self) -> String {
        format!("http://{}", self.listen)
    }

    fn status(&self, running: bool) -> Value {
        json!({
            "teamId": self.credentials.team_id,
            "teamName": self.team_name,
            "adminName": self.admin_name,
            "url": self.url(),
            "allowLanHttp": !self.listen.ip().is_loopback(),
            "running": running,
        })
    }

    fn access(&self) -> Value {
        let mut status = self.status(true);
        status["token"] = json!(self.credentials.token);
        status
    }
}

fn name(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 200
        || value.chars().any(char::is_control)
        || matches!(value, "-h" | "--help")
    {
        return Err(format!("请输入有效的{label}（1 至 200 个字符）"));
    }
    Ok(value.into())
}

fn eligible_address(address: SocketAddrV4) -> bool {
    address.port() > 0 && (address.ip().is_loopback() || address.ip().is_private())
}

fn listen_address(input: Option<&str>) -> Result<SocketAddrV4, String> {
    let value = input.unwrap_or_default().trim();
    let address = if value.is_empty() {
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, TEAM_PORT)
    } else if let Ok(ip) = value.parse::<Ipv4Addr>() {
        SocketAddrV4::new(ip, TEAM_PORT)
    } else {
        value
            .parse()
            .map_err(|_| "请填写本机 IPv4 地址，端口可省略")?
    };
    if !eligible_address(address) {
        return Err("团队服务需使用本机回环地址或本机私有局域网 IPv4 地址".into());
    }
    Ok(address)
}

fn read_host(dir: &Path) -> Result<Option<HostedTeam>, String> {
    let bytes = match fs::read(dir.join(CACHE_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound && !dir.exists() => return Ok(None),
        Err(error) => return Err(format!("无法读取已有团队的本机配置：{error}")),
    };
    let host: HostedTeam = serde_json::from_slice(&bytes).map_err(|_| "本机团队配置无法读取")?;
    if !eligible_address(host.listen) || !valid_token(&host.credentials.token) {
        return Err("本机团队配置无效".into());
    }
    Ok(Some(host))
}

fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn service_binary() -> Result<PathBuf, String> {
    let desktop = std::env::current_exe().map_err(|error| error.to_string())?;
    let binary = desktop.with_file_name(format!("nexus-team{}", std::env::consts::EXE_SUFFIX));
    if !binary.is_file() {
        return Err(
            "找不到团队服务程序。请将发布包中的 nexus-team 与 Nexus 桌面程序放在同一个目录".into(),
        );
    }
    Ok(binary)
}

fn service_command(binary: &Path, dir: &Path) -> Command {
    let mut command = Command::new(binary);
    command.arg("--data").arg(dir).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn initialize(
    dir: &Path,
    team_name: String,
    admin_name: String,
    listen: SocketAddrV4,
) -> Result<HostedTeam, String> {
    if let Some(host) = read_host(dir)? {
        if host.team_name == team_name && host.admin_name == admin_name && host.listen == listen {
            return Ok(host);
        }
        return Err("已创建一个本机团队，可从团队面板启动或连接它".into());
    }
    TcpListener::bind(listen).map_err(|error| format!("无法使用团队监听地址 {listen}：{error}"))?;
    let binary = service_binary()?;
    let parent = dir.parent().ok_or("无法确定本机团队目录")?;
    let staging = tempfile::Builder::new()
        .prefix(".nexus-team-new-")
        .tempdir_in(parent)
        .map_err(|error| error.to_string())?;
    let output = service_command(&binary, staging.path())
        .args(["init", &team_name, &admin_name, "--json"])
        .output()
        .map_err(|error| format!("无法运行团队初始化程序：{error}"))?;
    if !output.status.success() {
        return Err("团队数据库初始化失败，未改动现有数据".into());
    }
    let credentials: Credentials = serde_json::from_slice(&output.stdout)
        .map_err(|_| "团队服务返回的数据无法读取，请确认桌面程序和团队服务版本一致")?;
    if !valid_token(&credentials.token) {
        return Err("团队服务返回了无效的管理员凭据".into());
    }
    let host = HostedTeam {
        team_name,
        admin_name,
        listen,
        credentials,
    };
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(staging.path().join(CACHE_FILE))
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, &host).map_err(|error| error.to_string())?;
    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(staging.path(), dir).map_err(|error| format!("无法保存本机团队：{error}"))?;
    Ok(host)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| error.to_string())
}

async fn ready(client: &Client, host: &HostedTeam) -> bool {
    let response = client
        .get(format!("{}/v1/info", host.url()))
        .bearer_auth(&host.credentials.token)
        .send()
        .await;
    let Ok(response) = response.and_then(reqwest::Response::error_for_status) else {
        return false;
    };
    response.json::<RunningTeam>().await.is_ok_and(|service| {
        service.team_id == host.credentials.team_id
            && service.member_id == host.credentials.admin_id
            && service.role == "admin"
    })
}

fn spawn_service(dir: &Path, host: &HostedTeam) -> Result<Child, String> {
    TcpListener::bind(host.listen)
        .map_err(|error| format!("无法使用团队监听地址 {}：{error}", host.listen))?;
    let binary = service_binary()?;
    let mut command = service_command(&binary, dir);
    command.args(["serve", &host.listen.to_string(), "--allow-address-join"]);
    if !host.listen.ip().is_loopback() {
        command.arg("--allow-lan-http");
    }
    command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动团队服务：{error}"))
}

async fn start_service(dir: PathBuf, host: HostedTeam) -> Result<Value, String> {
    let client = client()?;
    if ready(&client, &host).await {
        return Ok(host.access());
    }
    let mut child = spawn_service(&dir, &host)?;
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        if ready(&client, &host).await {
            return Ok(host.access());
        }
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("团队服务未能启动。已保留团队数据库，可再次尝试启动".into());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("团队服务启动超时。已保留团队数据库，可再次尝试启动".into());
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

#[tauri::command]
pub async fn create_hosted_team(
    state: State<'_, AppState>,
    team_name: String,
    admin_name: String,
    listen: Option<String>,
) -> Result<Value, String> {
    let dir = state.root.join("hosted-team");
    let team_name = name(&team_name, "团队名称")?;
    let admin_name = name(&admin_name, "管理员名称")?;
    let listen = listen_address(listen.as_deref())?;
    let _operation = HOST_OPERATION.lock().await;
    let destination = dir.clone();
    let host = tauri::async_runtime::spawn_blocking(move || {
        initialize(&destination, team_name, admin_name, listen)
    })
    .await
    .map_err(|error| error.to_string())??;
    start_service(dir, host).await
}

#[tauri::command]
pub async fn start_hosted_team(state: State<'_, AppState>) -> Result<Value, String> {
    let dir = state.root.join("hosted-team");
    let _operation = HOST_OPERATION.lock().await;
    let host = read_host(&dir)?.ok_or("尚未创建本机团队")?;
    start_service(dir, host).await
}

#[tauri::command]
pub async fn hosted_team_status(state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let Some(host) = read_host(&state.root.join("hosted-team"))? else {
        return Ok(None);
    };
    let running = ready(&client()?, &host).await;
    Ok(Some(host.status(running)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_address_defaults_to_loopback_and_checks_private_listeners() {
        assert_eq!(listen_address(None).unwrap().to_string(), "127.0.0.1:47822");
        assert_eq!(
            listen_address(Some("192.168.1.9")).unwrap().to_string(),
            "192.168.1.9:47822"
        );
        assert_eq!(
            listen_address(Some("10.0.0.2:48000")).unwrap().port(),
            48000
        );
        for invalid in ["0.0.0.0", "8.8.8.8", "localhost", "127.0.0.1:0", "1.2."] {
            assert!(listen_address(Some(invalid)).is_err());
        }
    }

    #[test]
    fn only_authorized_start_and_create_responses_expose_the_admin_key() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("hosted-team");
        assert!(read_host(&dir).unwrap().is_none());
        fs::create_dir(&dir).unwrap();
        let host = HostedTeam {
            team_name: "我的团队".into(),
            admin_name: "管理员".into(),
            credentials: Credentials {
                team_id: Uuid::new_v4(),
                admin_id: Uuid::new_v4(),
                token: "a".repeat(64),
            },
            listen: listen_address(None).unwrap(),
        };
        fs::write(dir.join(CACHE_FILE), serde_json::to_vec(&host).unwrap()).unwrap();
        let saved = read_host(&dir).unwrap().unwrap();
        assert_eq!(saved.access()["token"], host.credentials.token);
        assert!(saved.status(false).get("token").is_none());
        let repeated = initialize(&dir, "我的团队".into(), "管理员".into(), host.listen).unwrap();
        assert_eq!(repeated.credentials.team_id, host.credentials.team_id);
        assert!(initialize(&dir, "其他团队".into(), "管理员".into(), host.listen).is_err());
    }
}
