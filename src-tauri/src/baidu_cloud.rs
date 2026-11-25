//! Asset access through Baidu's bundled OAuth client.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex, OnceLock, Weak,
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const ROOT: &str = "/apps/bdpan";
const APP_FOLDER_NAME: &str = "Nexus Assets";
const CONFIG: &str = "config.json";
const CONNECTION: &str = "connection-id";
const PAGE_LIMIT: u32 = 500;
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(310);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(800);
const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;
const LOGIN_OUTPUT_LIMIT: u64 = 64 * 1024;
const DEVICE_URL: &str = "https://openapi.baidu.com/device";
const PROFILE_FAILED: &str = "无法打开百度网盘授权配置";
const COMPONENT_FAILED: &str = "无法启动百度网盘组件";
const LOGIN_FAILED: &str = "百度网盘授权组件已退出，请重试";
const LOGIN_DNS_FAILED: &str = "NAS 无法解析百度授权服务地址，请检查 DNS";
const LOGIN_TLS_FAILED: &str = "NAS 无法验证百度授权服务的证书，请检查系统时间和证书";
const LOGIN_NETWORK_FAILED: &str = "NAS 无法连接百度授权服务，请检查网络";
const LOGIN_ENDPOINT_MISSING: &str = "百度授权接口不可用，请检查 NAS 的网盘组件版本";
const LOGIN_CLIENT_REJECTED: &str = "百度授权服务拒绝了当前组件的请求，请检查 NAS 的网盘组件版本";
const LOGIN_DECLINED: &str = "百度授权已取消或已过期，请重新登录";
const AUTH_EXPIRED: &str = "百度网盘登录已失效，请重新授权";
const FOLDER_MISSING: &str = "百度网盘文件夹不存在，请返回上一级刷新";
const LIST_INVALID: &str = "百度网盘返回的目录列表无法读取，请稍后重试";
const LIST_NETWORK_FAILED: &str = "暂时无法读取百度网盘目录，请检查网络后重试";
const APP_FOLDER_CONFLICT: &str = "百度网盘中已有名为 Nexus Assets 的文件，请重命名该文件后重试";
const APP_FOLDER_FAILED: &str = "无法创建 Nexus Assets 文件夹，请检查百度网盘授权和可用空间后重试";

#[derive(Clone)]
pub struct BaiduClient {
    executable: PathBuf,
    profile: PathBuf,
    busy: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaiduStatus {
    pub connected: bool,
    pub connection_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaiduEntry {
    pub path: String,
    pub name: String,
    pub id: String,
    pub directory: bool,
    pub size: u64,
    pub modified: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaiduPage {
    pub entries: Vec<BaiduEntry>,
    pub next_offset: Option<u32>,
}

#[derive(Clone, Copy)]
pub enum LoginMode {
    Browser,
    Device,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProgress {
    pub pending: bool,
    pub connected: bool,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
}

pub struct BaiduLogin {
    progress: Arc<Mutex<Result<LoginProgress, String>>>,
    cancelled: Arc<AtomicBool>,
}

impl BaiduLogin {
    pub fn poll(&self) -> Result<LoginProgress, String> {
        self.progress
            .lock()
            .map_err(|_| "无法读取百度网盘登录状态".to_string())?
            .clone()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl Drop for BaiduLogin {
    fn drop(&mut self) {
        self.cancel();
    }
}

type ProfileLocks = Mutex<HashMap<PathBuf, Weak<AtomicBool>>>;
static PROFILE_LOCKS: OnceLock<ProfileLocks> = OnceLock::new();

struct ProfileLease(Arc<AtomicBool>);

impl Drop for ProfileLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Deserialize)]
struct ProviderStatus {
    authenticated: bool,
    has_valid_token: Option<bool>,
}

#[derive(Deserialize)]
struct ProviderEntry {
    path: String,
    server_filename: String,
    fsid: Option<String>,
    fs_id: Option<u64>,
    isdir: ProviderDirectory,
    size: Option<u64>,
    server_mtime: Option<ProviderTime>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ProviderDirectory {
    Boolean(bool),
    Number(u8),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ProviderTime {
    Text(String),
    Seconds(u64),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ProviderList {
    Array(Option<Vec<serde_json::Value>>),
    Envelope {
        code: u32,
        data: Option<Vec<serde_json::Value>>,
    },
}

#[derive(Deserialize)]
struct CommandResult {
    code: u32,
}

impl BaiduClient {
    /// `executable` comes from a verified installation, never from a request or PATH.
    pub fn new(executable: PathBuf, profile: PathBuf) -> Result<Self, String> {
        if !executable.is_absolute() || !profile.is_absolute() || !ordinary_file(&executable) {
            return Err("百度网盘组件尚未安装或配置路径无效".into());
        }
        create_profile(&profile)?;
        let lock_key = profile.canonicalize().map_err(|_| profile_failed())?;
        let mut profiles = PROFILE_LOCKS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "无法打开百度网盘配置".to_string())?;
        profiles.retain(|_, lock| lock.strong_count() > 0);
        let busy = profiles
            .get(&lock_key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let lock = Arc::new(AtomicBool::new(false));
                profiles.insert(lock_key, Arc::downgrade(&lock));
                lock
            });
        Ok(Self {
            executable,
            profile,
            busy,
        })
    }

    pub fn status(&self) -> Result<BaiduStatus, String> {
        let _lease = self.claim()?;
        let connection_id = self.connection_id()?;
        let connected = connection_id.is_some() && self.authenticated()?;
        Ok(BaiduStatus {
            connected,
            connection_id: connection_id.filter(|_| connected),
        })
    }

    pub fn start_login(&self, mode: LoginMode) -> Result<BaiduLogin, String> {
        let lease = self.claim()?;
        let existing = self.connection_id()?;
        if existing.is_some() && self.authenticated()? {
            return Ok(BaiduLogin {
                progress: Arc::new(Mutex::new(Ok(completed_login()))),
                cancelled: Arc::new(AtomicBool::new(false)),
            });
        }
        self.clear_connection()?;
        let mut command = self.command("login")?;
        command.arg("--accept-disclaimer");
        let device = matches!(mode, LoginMode::Device);
        if device {
            command.arg("--device-code").stdin(Stdio::piped());
        }
        let mut child = command.spawn().map_err(|_| component_failed())?;
        // bdpan 3.8.9 still asks for confirmation in device mode. The team
        // login action already confirms it, so write one answer and close stdin.
        if device
            && !child
                .stdin
                .take()
                .is_some_and(|mut stdin| stdin.write_all(b"yes\n").is_ok())
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(component_failed());
        }
        let progress = Arc::new(Mutex::new(Ok(LoginProgress {
            pending: true,
            connected: false,
            verification_url: None,
            user_code: None,
        })));
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_progress = progress.clone();
        let worker_cancelled = cancelled.clone();
        let client = self.clone();
        thread::spawn(move || {
            let result = finish_login(child, &worker_progress, &worker_cancelled).and_then(|()| {
                if !client.authenticated()? || worker_cancelled.load(Ordering::Acquire) {
                    return Err("百度网盘尚未完成授权。请重新登录。".into());
                }
                client.write_connection()?;
                Ok(completed_login())
            });
            drop(lease);
            if let Ok(mut state) = worker_progress.lock() {
                *state = result;
            }
        });
        Ok(BaiduLogin {
            progress,
            cancelled,
        })
    }

    pub fn logout(&self) -> Result<(), String> {
        let _lease = self.claim()?;
        self.clear_connection()?;
        run(self.command("logout")?, IO_TIMEOUT).map(|_| ())
    }

    pub fn create_app_folder(&self) -> Result<String, String> {
        let _lease = self.claim()?;
        self.require_connection(None)?;
        let path = format!("{ROOT}/{APP_FOLDER_NAME}");
        let mut command = self.command("mkdir")?;
        command.args([APP_FOLDER_NAME, "--json"]);
        let created = run(command, IO_TIMEOUT).and_then(|output| {
            let response: serde_json::Value = parse_json(&output)?;
            if response.get("status").and_then(|status| status.as_str()) == Some("ok")
                || response.get("code").and_then(|code| code.as_u64()) == Some(0)
            {
                Ok(())
            } else {
                Err(APP_FOLDER_FAILED.into())
            }
        });
        if created.is_ok() {
            return Ok(path);
        }
        match self.metadata_current(&path) {
            Ok(folder) if folder.directory => Ok(path),
            Ok(_) => Err(APP_FOLDER_CONFLICT.into()),
            Err(_) => Err(created
                .err()
                .as_deref()
                .and_then(listing_diagnostic)
                .unwrap_or(APP_FOLDER_FAILED)
                .into()),
        }
    }

    pub fn list(
        &self,
        path: &str,
        folders_only: bool,
        offset: u32,
        limit: u32,
    ) -> Result<BaiduPage, String> {
        self.list_with(None, path, folders_only, offset, limit)
    }

    pub fn list_for(
        &self,
        connection: &str,
        path: &str,
        folders_only: bool,
        offset: u32,
        limit: u32,
    ) -> Result<BaiduPage, String> {
        self.list_with(Some(connection), path, folders_only, offset, limit)
    }

    fn list_with(
        &self,
        connection: Option<&str>,
        path: &str,
        folders_only: bool,
        offset: u32,
        limit: u32,
    ) -> Result<BaiduPage, String> {
        let path = normalize_path(path)?;
        let _lease = self.claim()?;
        self.require_connection(connection)?;
        self.list_current(&path, folders_only, offset, limit)
    }

    pub fn metadata(&self, path: &str) -> Result<BaiduEntry, String> {
        self.metadata_with(None, path)
    }

    pub fn metadata_for(&self, connection: &str, path: &str) -> Result<BaiduEntry, String> {
        self.metadata_with(Some(connection), path)
    }

    fn metadata_with(&self, connection: Option<&str>, path: &str) -> Result<BaiduEntry, String> {
        let path = normalize_path(path)?;
        let _lease = self.claim()?;
        self.require_connection(connection)?;
        self.metadata_current(&path)
    }

    pub fn download(&self, path: &str, destination: &Path) -> Result<(), String> {
        self.download_with(None, path, destination, u64::MAX)
    }

    pub fn download_for(
        &self,
        connection: &str,
        path: &str,
        destination: &Path,
    ) -> Result<(), String> {
        self.download_for_limit(connection, path, destination, u64::MAX)
    }

    pub fn download_for_limit(
        &self,
        connection: &str,
        path: &str,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(), String> {
        self.download_with(Some(connection), path, destination, max_bytes)
    }

    fn download_with(
        &self,
        connection: Option<&str>,
        path: &str,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(), String> {
        if !destination.is_absolute() || destination.symlink_metadata().is_ok() {
            return Err("无法创建本地百度网盘文件".into());
        }
        let path = normalize_path(path)?;
        let _lease = self.claim()?;
        self.require_connection(connection)?;
        let entry = self.metadata_current(&path)?;
        if entry.directory {
            return Err("请选择单个百度网盘文件".into());
        }
        if entry.size > max_bytes {
            return Err("百度网盘文件超过当前下载大小上限".into());
        }
        let parent = destination.parent().ok_or("本地缓存目录无效")?;
        let stage = tempfile::Builder::new()
            .prefix(".baidu-download-")
            .tempdir_in(parent)
            .map_err(|_| "无法创建百度网盘下载缓存".to_string())?;
        let staged_file = stage.path().join("asset");
        let mut command = self.command("download")?;
        command.arg(path).arg(&staged_file).arg("--json");
        let downloaded = run_guarded(command, DOWNLOAD_TIMEOUT, || {
            staged_file.symlink_metadata().is_ok_and(|meta| {
                !meta.is_file() || is_reparse_point(&meta) || meta.len() > entry.size
            })
        })?;
        let response: CommandResult = parse_json(&downloaded)?;
        if response.code != 0
            || !ordinary_file(&staged_file)
            || staged_file.metadata().map(|f| f.len()).ok() != Some(entry.size)
        {
            return Err("百度网盘文件下载不完整，请重试".into());
        }
        fs::hard_link(staged_file, destination).map_err(|_| "无法写入本地百度网盘文件".into())
    }

    fn claim(&self) -> Result<ProfileLease, String> {
        let deadline = Instant::now() + Duration::from_secs(2);
        while self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            if Instant::now() >= deadline {
                return Err("百度网盘正在处理另一个操作，请稍后重试".into());
            }
            thread::sleep(Duration::from_millis(25));
        }
        Ok(ProfileLease(self.busy.clone()))
    }

    fn connection_id(&self) -> Result<Option<String>, String> {
        let path = self.profile.join(CONNECTION);
        match path.symlink_metadata() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Ok(meta) if meta.len() == 36 && meta.is_file() && !is_reparse_point(&meta) => {
                let id = fs::read_to_string(&path).map_err(|_| profile_failed())?;
                Uuid::parse_str(&id).map_err(|_| profile_failed())?;
                Ok(Some(id))
            }
            _ => Err(profile_failed()),
        }
    }

    fn require_connection(&self, expected: Option<&str>) -> Result<(), String> {
        let current = self.connection_id()?.ok_or("请先登录百度网盘")?;
        if expected.is_some_and(|id| id != current) {
            return Err("百度网盘授权已更改，请重新选择文件夹".into());
        }
        Ok(())
    }

    fn clear_connection(&self) -> Result<(), String> {
        match fs::remove_file(self.profile.join(CONNECTION)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(profile_failed()),
        }
    }

    fn write_connection(&self) -> Result<(), String> {
        let mut temp =
            tempfile::NamedTempFile::new_in(&self.profile).map_err(|_| profile_failed())?;
        temp.write_all(Uuid::new_v4().to_string().as_bytes())
            .map_err(|_| profile_failed())?;
        temp.persist_noclobber(self.profile.join(CONNECTION))
            .map_err(|_| profile_failed())?;
        Ok(())
    }

    fn authenticated(&self) -> Result<bool, String> {
        let mut command = self.command("whoami")?;
        command.arg("--json");
        let state: ProviderStatus = parse_json(&run(command, IO_TIMEOUT)?)?;
        Ok(state.authenticated && state.has_valid_token.unwrap_or(true))
    }

    fn command(&self, subcommand: &str) -> Result<Command, String> {
        let config = self.profile.join(CONFIG);
        match config.symlink_metadata() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Ok(meta) if meta.is_file() && !is_reparse_point(&meta) => {}
            _ => return Err(profile_failed()),
        }
        let mut command = private_command(&self.executable);
        command
            .arg(subcommand)
            .arg("--config-path")
            .arg(config)
            .arg("--no-check-update");
        // bdpan writes its disclaimer marker under the default home directory
        // even when the authorization config itself uses --config-path.
        #[cfg(unix)]
        command
            .env("HOME", &self.profile)
            .current_dir(&self.profile);
        // These variables target other tools' profiles or insert an authorization code.
        for variable in [
            "BDPAN_AUTH_CODE",
            "BDPAN_CONFIG_DIR",
            "BDPAN_CONFIG_PATH",
            "BDPAN_INSTALL_DIR",
            "BDPAN_BIN",
        ] {
            command.env_remove(variable);
        }
        Ok(command)
    }

    fn list_current(
        &self,
        path: &str,
        folders_only: bool,
        offset: u32,
        limit: u32,
    ) -> Result<BaiduPage, String> {
        if !(1..=PAGE_LIMIT).contains(&limit) || offset > 1_000_000 {
            return Err("百度网盘目录分页参数无效".into());
        }
        let mut command = self.command("ls")?;
        if path != ROOT {
            command.arg(path);
        }
        command.args([
            "--start",
            &offset.to_string(),
            "--limit",
            &limit.to_string(),
            "--json",
        ]);
        let raw =
            match run(command, IO_TIMEOUT).and_then(|response| parse_directory_list(&response)) {
                Ok(entries) => entries,
                Err(failure) if path == ROOT && failure == FOLDER_MISSING => Vec::new(),
                Err(failure) => return Err(failure),
            };
        decode_page(raw, path, folders_only, offset, limit)
    }

    fn metadata_current(&self, path: &str) -> Result<BaiduEntry, String> {
        if path == ROOT {
            return Ok(BaiduEntry {
                path: ROOT.to_string(),
                name: "bdpan".into(),
                id: "root".into(),
                directory: true,
                size: 0,
                modified: String::new(),
            });
        }
        let parent = path.rsplit_once('/').ok_or_else(invalid_path)?.0;
        let mut offset = 0;
        let deadline = Instant::now() + IO_TIMEOUT;
        while Instant::now() < deadline {
            let page = self.list_current(parent, false, offset, PAGE_LIMIT)?;
            if let Some(entry) = page.entries.into_iter().find(|entry| entry.path == path) {
                return Ok(entry);
            }
            let Some(next) = page.next_offset else { break };
            offset = next;
        }
        Err("百度网盘文件或文件夹不存在，或目录读取超时".into())
    }
}

/// Accept the API path only. Shell, local filesystem and share URLs never enter the CLI.
pub fn normalize_path(path: &str) -> Result<String, String> {
    if path == ROOT || path == "/apps/bdpan/" {
        return Ok(ROOT.to_string());
    }
    let relative = path.strip_prefix("/apps/bdpan/").ok_or_else(invalid_path)?;
    if path.len() > 4096 || relative.split('/').any(|name| !valid_segment(name)) {
        return Err(invalid_path());
    }
    Ok(path.to_string())
}

fn valid_segment(segment: &str) -> bool {
    if segment.is_empty() || segment.len() > 1024 || segment.chars().any(char::is_control) {
        return false;
    }
    let mut bytes = segment.as_bytes().to_vec();
    // Reject encoded delimiters and traversal without altering valid display names.
    for _ in 0..8 {
        if bytes == b"."
            || bytes == b".."
            || bytes
                .iter()
                .any(|&b| b < 32 || b == 127 || b"/\\:~".contains(&b))
        {
            return false;
        }
        let mut decoded = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    decoded.push(a * 16 + b);
                    i += 3;
                    continue;
                }
            }
            decoded.push(bytes[i]);
            i += 1;
        }
        if bytes == decoded {
            return true;
        }
        bytes = decoded;
    }
    false
}

fn hex(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|n| n as u8)
}

fn parse_directory_list(bytes: &[u8]) -> Result<Vec<serde_json::Value>, String> {
    match serde_json::from_slice(bytes) {
        Ok(ProviderList::Array(entries))
        | Ok(ProviderList::Envelope {
            code: 0,
            data: entries,
        }) => Ok(entries.unwrap_or_default()),
        Ok(ProviderList::Envelope { .. }) => Err(command_failed(bytes, &[])),
        Err(_) => Err(LIST_INVALID.into()),
    }
}

fn decode_page(
    raw: Vec<serde_json::Value>,
    parent: &str,
    folders_only: bool,
    offset: u32,
    limit: u32,
) -> Result<BaiduPage, String> {
    if raw.len() > limit as usize {
        return Err(LIST_INVALID.into());
    }
    let row_count = raw.len();
    let next_offset = (row_count == limit as usize).then_some(offset + limit);
    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(row_count);
    for item in raw {
        let Some(entry) = directory_entry(item) else {
            continue;
        };
        // bdpan 3.8.9 returns the requested directory itself when the child page is empty.
        if row_count == 1 && entry.directory && entry.path == parent {
            return Ok(BaiduPage {
                entries,
                next_offset: None,
            });
        }
        if entry.path.rsplit_once('/').map(|(folder, _)| folder) != Some(parent) {
            continue;
        }
        if seen.insert(entry.path.clone()) && (!folders_only || entry.directory) {
            entries.push(entry);
        }
    }
    if row_count > 0 && seen.is_empty() {
        return Err(LIST_INVALID.into());
    }
    Ok(BaiduPage {
        entries,
        next_offset,
    })
}

fn directory_entry(item: serde_json::Value) -> Option<BaiduEntry> {
    let entry: ProviderEntry = serde_json::from_value(item).ok()?;
    let path = match entry.path.strip_prefix("我的应用数据/bdpan/") {
        Some(relative) => normalize_path(&format!("{ROOT}/{relative}")).ok()?,
        None => normalize_path(&entry.path).ok()?,
    };
    if path.rsplit('/').next() != Some(entry.server_filename.as_str()) {
        return None;
    }
    let id = entry.fsid.or_else(|| entry.fs_id.map(|n| n.to_string()))?;
    if id.is_empty() || id.len() > 24 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let directory = match entry.isdir {
        ProviderDirectory::Boolean(value) => value,
        ProviderDirectory::Number(0) => false,
        ProviderDirectory::Number(1) => true,
        ProviderDirectory::Number(_) => return None,
    };
    let size = if directory { 0 } else { entry.size? };
    let modified = match entry.server_mtime {
        Some(ProviderTime::Text(value))
            if value.len() <= 64 && !value.chars().any(char::is_control) =>
        {
            value
        }
        Some(ProviderTime::Seconds(value)) => value.to_string(),
        _ => String::new(),
    };
    Some(BaiduEntry {
        path,
        name: entry.server_filename,
        id,
        directory,
        size,
        modified,
    })
}

fn completed_login() -> LoginProgress {
    LoginProgress {
        pending: false,
        connected: true,
        verification_url: None,
        user_code: None,
    }
}

fn finish_login(
    mut child: Child,
    progress: &Mutex<Result<LoginProgress, String>>,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let (send, receive) = mpsc::sync_channel::<Vec<u8>>(16);
    for input in [
        child.stdout.take().map(|p| Box::new(p) as Reader),
        child.stderr.take().map(|p| Box::new(p) as Reader),
    ]
    .into_iter()
    .flatten()
    {
        let send = send.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(input.take(LOGIN_OUTPUT_LIMIT));
            loop {
                let mut line = Vec::new();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if send.send(line).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    drop(send);
    let mut issue = None;
    let mut inspect = |line: &[u8]| {
        let line = String::from_utf8_lossy(line);
        if issue.is_none() {
            issue = login_failure_in(&line);
        }
        if let Ok(mut state) = progress.lock() {
            if let Ok(value) = &mut *state {
                update_login(value, &line);
            }
        }
    };
    let status = wait_child(&mut child, LOGIN_TIMEOUT, || {
        while let Ok(line) = receive.try_recv() {
            inspect(&line);
        }
        cancelled.load(Ordering::Acquire)
    })?;
    if !status.success() {
        // The process can exit before its pipe readers have forwarded the last line.
        let deadline = Instant::now() + Duration::from_millis(200);
        while let Ok(line) =
            receive.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            inspect(&line);
        }
        return Err(issue.unwrap_or(LOGIN_FAILED).into());
    }
    Ok(())
}

fn login_failure_in(line: &str) -> Option<&'static str> {
    let line = line.to_ascii_lowercase();
    let has = |terms: &[&str]| terms.iter().any(|term| line.contains(term));
    if has(&[
        "no such host",
        "name resolution",
        "server misbehaving",
        "域名解析失败",
    ]) {
        Some(LOGIN_DNS_FAILED)
    } else if has(&[
        "x509:",
        "tls handshake",
        "certificate verify failed",
        "证书验证失败",
    ]) {
        Some(LOGIN_TLS_FAILED)
    } else if has(&[
        "permission denied",
        "read-only file system",
        "无法创建配置目录",
        "无法读取配置文件",
        "无法写入配置",
    ]) {
        Some(PROFILE_FAILED)
    } else if has(&[
        "unknown flag: --device-code",
        "unknown flag: --accept-disclaimer",
        "404 not found",
        "status code 404",
        "http 404",
    ]) {
        Some(LOGIN_ENDPOINT_MISSING)
    } else if has(&[
        "unsupported_grant_type",
        "invalid_client",
        "unauthorized_client",
    ]) {
        Some(LOGIN_CLIENT_REJECTED)
    } else if has(&[
        "expired_token",
        "access_denied",
        "用户取消授权",
        "设备码已过期",
    ]) {
        Some(LOGIN_DECLINED)
    } else if has(&[
        "context deadline exceeded",
        "i/o timeout",
        "network is unreachable",
        "connection refused",
        "connection reset",
        "dial tcp",
        "网络请求失败",
        "请求超时",
    ]) {
        Some(LOGIN_NETWORK_FAILED)
    } else {
        None
    }
}

/// Only messages defined by Nexus may be included in a team response or log.
pub fn login_diagnostic(message: &str) -> Option<&'static str> {
    [
        PROFILE_FAILED,
        COMPONENT_FAILED,
        LOGIN_FAILED,
        LOGIN_DNS_FAILED,
        LOGIN_TLS_FAILED,
        LOGIN_NETWORK_FAILED,
        LOGIN_ENDPOINT_MISSING,
        LOGIN_CLIENT_REJECTED,
        LOGIN_DECLINED,
        "百度网盘组件尚未安装或配置路径无效",
        "百度网盘操作已取消",
        "百度网盘响应超时，请重试",
        "百度网盘正在处理另一个操作，请稍后重试",
        "百度网盘尚未完成授权。请重新登录。",
        "百度网盘返回的数据格式有误",
        AUTH_EXPIRED,
    ]
    .into_iter()
    .find(|known| *known == message)
}

fn update_login(progress: &mut LoginProgress, line: &str) {
    // Only the short user code is forwarded. Device codes, tokens and arbitrary URLs
    // are intentionally never returned from CLI stdout or stderr.
    let line = line.trim();
    if let Some(code) = line
        .strip_prefix("用户码:")
        .or_else(|| line.strip_prefix("用户码："))
    {
        let code = code.trim();
        if (4..=16).contains(&code.len())
            && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            progress.user_code = Some(code.to_string());
            progress.verification_url = Some(DEVICE_URL.into());
        }
    }
}

type Reader = Box<dyn Read + Send>;

fn private_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn run(command: Command, timeout: Duration) -> Result<Vec<u8>, String> {
    run_guarded(command, timeout, || false)
}

fn run_guarded(
    mut command: Command,
    timeout: Duration,
    cancelled: impl FnMut() -> bool,
) -> Result<Vec<u8>, String> {
    let mut child = command.spawn().map_err(|_| component_failed())?;
    let stdout = child.stdout.take().ok_or_else(component_failed)?;
    let stderr = child.stderr.take().ok_or_else(component_failed)?;
    let output = capture(stdout);
    let errors = capture(stderr);
    let status = wait_child(&mut child, timeout, cancelled)?;
    let output = output
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| component_failed())??;
    if !status.success() {
        let errors = errors
            .recv_timeout(Duration::from_secs(2))
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        return Err(command_failed(&output, &errors));
    }
    Ok(output)
}

fn capture(input: impl Read + Send + 'static) -> Receiver<Result<Vec<u8>, String>> {
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = input
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| component_failed())
            .and_then(|_| {
                if bytes.len() as u64 > OUTPUT_LIMIT {
                    Err(unexpected_response())
                } else {
                    Ok(bytes)
                }
            });
        let _ = send.send(result);
    });
    receive
}

fn wait_child(
    child: &mut Child,
    timeout: Duration,
    mut cancelled: impl FnMut() -> bool,
) -> Result<ExitStatus, String> {
    let start = Instant::now();
    loop {
        let cancel = cancelled();
        if cancel || start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if cancel {
                "百度网盘操作已取消"
            } else {
                "百度网盘响应超时，请重试"
            }
            .into());
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(component_failed());
            }
        }
    }
}

fn parse_json<T: serde::de::DeserializeOwned>(output: &[u8]) -> Result<T, String> {
    serde_json::from_slice(output).map_err(|_| unexpected_response())
}

fn command_failed(output: &[u8], errors: &[u8]) -> String {
    let received = [
        String::from_utf8_lossy(output),
        String::from_utf8_lossy(errors),
    ];
    if received.iter().any(|s| {
        [
            "未登录",
            "Token 过期",
            "Token expired",
            "请先执行 bdpan login",
        ]
        .iter()
        .any(|term| s.contains(term))
    }) {
        return AUTH_EXPIRED.into();
    }
    if received.iter().any(|s| {
        [
            "目录不存在",
            "No such directory",
            "directory not found",
            "errno=-9 ",
        ]
        .iter()
        .any(|term| s.contains(term))
    }) {
        return FOLDER_MISSING.into();
    }
    if received.iter().any(|s| {
        matches!(
            login_failure_in(s),
            Some(LOGIN_DNS_FAILED | LOGIN_TLS_FAILED | LOGIN_NETWORK_FAILED)
        )
    }) {
        return LIST_NETWORK_FAILED.into();
    }
    "百度网盘无法完成请求，请检查网络、授权或文件是否仍在原处".into()
}

/// Only allowlisted, provider-independent text may reach a team response or log.
pub fn listing_diagnostic(message: &str) -> Option<&'static str> {
    [
        AUTH_EXPIRED,
        FOLDER_MISSING,
        LIST_INVALID,
        LIST_NETWORK_FAILED,
        APP_FOLDER_CONFLICT,
        APP_FOLDER_FAILED,
        PROFILE_FAILED,
        COMPONENT_FAILED,
        "请先登录百度网盘",
        "百度网盘响应超时，请重试",
        "百度网盘正在处理另一个操作，请稍后重试",
    ]
    .into_iter()
    .find(|known| *known == message)
}

fn create_profile(profile: &Path) -> Result<(), String> {
    fs::create_dir_all(profile).map_err(|_| profile_failed())?;
    let metadata = profile.symlink_metadata().map_err(|_| profile_failed())?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(profile_failed());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(profile, fs::Permissions::from_mode(0o700))
            .map_err(|_| profile_failed())?;
    }
    Ok(())
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn ordinary_file(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|metadata| metadata.is_file() && !is_reparse_point(&metadata))
}

fn invalid_path() -> String {
    "请选择「我的应用数据 / bdpan」中的路径".into()
}
fn component_failed() -> String {
    COMPONENT_FAILED.into()
}
fn profile_failed() -> String {
    PROFILE_FAILED.into()
}
fn unexpected_response() -> String {
    "百度网盘返回的数据格式有误".into()
}

#[cfg(all(feature = "desktop", target_os = "windows", target_arch = "x86_64"))]
pub async fn ensure_windows_cli(root: &Path) -> Result<PathBuf, String> {
    const URL: &str = "https://issuecdn.baidupcs.com/issue/netdisk/ai-bdpan/win/3.8.9/bdpan-3.8.9-windows-amd64.zip";
    const ZIP_HASH: &str = "ea1058ceb658446225f0cfc9a025221b3f8b3496af7da3b18bf87da3f47a645c";
    const EXE_HASH: &str = "26a74a97fe701fb68f81245d105bb50c13aa95802e78fff24ac49727db25a695";
    const ZIP_SIZE: usize = 6_490_414;
    static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    let _lease = INSTALL.lock().await;
    let directory = root.join("cloud-provider").join("bdpan-3.8.9");
    let executable = directory.join("bdpan.exe");
    if ordinary_file(&executable) && check_file_hash(&executable, EXE_HASH) {
        return Ok(executable);
    }
    create_profile(&directory)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| package_failed())?;
    let mut response = client
        .get(URL)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| package_failed())?;
    if response
        .content_length()
        .is_some_and(|size| size != ZIP_SIZE as u64)
    {
        return Err(package_failed());
    }
    let mut archive = tempfile::Builder::new()
        .suffix(".zip")
        .tempfile_in(&directory)
        .map_err(|_| package_failed())?;
    let mut size = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| package_failed())? {
        size += chunk.len();
        if size > ZIP_SIZE {
            return Err(package_failed());
        }
        archive.write_all(&chunk).map_err(|_| package_failed())?;
    }
    if size != ZIP_SIZE || !check_file_hash(archive.path(), ZIP_HASH) {
        return Err(package_failed());
    }
    tokio::task::spawn_blocking(move || {
        let tar = PathBuf::from(std::env::var_os("SystemRoot").ok_or_else(package_failed)?)
            .join("System32")
            .join("tar.exe");
        if !tar.is_absolute() || !ordinary_file(&tar) {
            return Err(package_failed());
        }
        let binary = tempfile::NamedTempFile::new_in(&directory).map_err(|_| package_failed())?;
        let mut command = private_command(&tar);
        command
            .arg("-xOf")
            .arg(archive.path())
            .arg("bdpan/bdpan.exe")
            .stdout(binary.reopen().map_err(|_| package_failed())?)
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|_| package_failed())?;
        let finished = wait_child(&mut child, Duration::from_secs(15), || false)?;
        if !finished.success() || !check_file_hash(binary.path(), EXE_HASH) {
            return Err(package_failed());
        }
        binary.persist(&executable).map_err(|_| package_failed())?;
        Ok(executable)
    })
    .await
    .map_err(|_| package_failed())?
}

#[cfg(all(
    feature = "desktop",
    not(all(target_os = "windows", target_arch = "x86_64"))
))]
pub async fn ensure_windows_cli(_: &Path) -> Result<PathBuf, String> {
    Err("本机百度网盘组件暂支持 Windows x64".into())
}

#[cfg(all(feature = "desktop", target_os = "windows", target_arch = "x86_64"))]
fn check_file_hash(path: &Path, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    if !file
        .metadata()
        .is_ok_and(|meta| meta.len() < 40 * 1024 * 1024)
    {
        return false;
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => {
                let digest: String = hash
                    .finalize()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                return digest == expected;
            }
            Ok(size) => hash.update(&buffer[..size]),
            Err(_) => return false,
        }
    }
}

#[cfg(all(feature = "desktop", target_os = "windows", target_arch = "x86_64"))]
fn package_failed() -> String {
    "无法下载或验证百度网盘官方组件，请检查网络后重试".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_paths_keep_names_and_block_encoded_traversal() {
        assert_eq!(normalize_path("/apps/bdpan/").unwrap(), ROOT);
        let path = "/apps/bdpan/素材/50% 贴图...png";
        assert_eq!(normalize_path(path).unwrap(), path);
        for invalid in [
            "/apps/bdpan2/asset",
            "/apps/bdpan/../private",
            "/apps/bdpan/%252e%252e/file",
            "/apps/bdpan/dir%2ffile",
            "/apps/bdpan/a\\file",
            "/apps/bdpan/a//file",
            "https://pan.baidu.com/s/test",
            "--config-path",
        ] {
            assert!(normalize_path(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn filtered_pages_keep_provider_offsets_and_file_ids() {
        let raw = br#"[{"path":"/apps/bdpan/folder","server_filename":"folder","fsid":"9007199254740993","fs_id":9007199254740993,"isdir":true,"size":0,"server_mtime":"2026-01-01T00:00:00+08:00"},
                         {"path":"/apps/bdpan/example.jpg","server_filename":"example.jpg","fsid":"7","isdir":false,"size":10,"server_mtime":"2026-01-01T00:00:00+08:00"}]"#;
        let page = decode_page(parse_json(raw).unwrap(), ROOT, true, 4, 2).unwrap();
        assert_eq!(page.next_offset, Some(6));
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].id, "9007199254740993");
        assert!(decode_page(parse_json(raw).unwrap(), "/apps/bdpan/other", false, 0, 2).is_err());
    }

    #[test]
    fn empty_and_wrapped_directory_results_keep_the_authorization_valid() {
        for raw in [
            b"null".as_slice(),
            b"[]",
            br#"{"code":0,"data":null,"error":""}"#,
        ] {
            let rows = parse_directory_list(raw).unwrap();
            assert!(decode_page(rows, ROOT, true, 0, 100)
                .unwrap()
                .entries
                .is_empty());
        }
        let wrapped = r#"{"code":0,"data":[
            {"path":"我的应用数据/bdpan/资料","server_filename":"资料","fsid":"9007199254740993","isdir":1,"server_mtime":1795563200},
            {"path":"/apps/bdpan/../私密","server_filename":"私密","fsid":"8","isdir":1},
            {"path":"/apps/bdpan/a/b","server_filename":"b","fsid":"9","isdir":1},
            {"path":"/apps/bdpan/readme.txt","server_filename":"readme.txt","fsid":"10","isdir":false,"size":2}
        ]}"#;
        let page = decode_page(
            parse_directory_list(wrapped.as_bytes()).unwrap(),
            ROOT,
            true,
            5,
            4,
        )
        .unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].path, "/apps/bdpan/资料");
        assert_eq!(page.entries[0].id, "9007199254740993");
        assert_eq!(page.next_offset, Some(9));
    }

    #[test]
    fn provider_directory_metadata_on_an_empty_child_page_is_not_a_child() {
        let path = "/apps/bdpan/Nexus Assets";
        let metadata = br#"[{"fs_id":1002,"fsid":"1002","path":"/apps/bdpan/Nexus Assets",
            "server_filename":"Nexus Assets","size":0,"isdir":true,
            "server_mtime":"2026-07-14T21:24:03+08:00"}]"#;
        let rows = parse_directory_list(metadata).unwrap();
        for folders_only in [false, true] {
            let page = decode_page(rows.clone(), path, folders_only, 20, 1).unwrap();
            assert!(page.entries.is_empty());
            assert_eq!(page.next_offset, None);
        }
        assert!(decode_page(rows.clone(), "/apps/bdpan/Other", true, 0, 100).is_err());
        assert_eq!(
            decode_page(rows, ROOT, true, 0, 100).unwrap().entries[0].path,
            path
        );

        let file = br#"[{"path":"/apps/bdpan/Nexus Assets","server_filename":"Nexus Assets",
            "fsid":"1002","size":12,"isdir":false}]"#;
        assert!(decode_page(parse_directory_list(file).unwrap(), path, false, 0, 100).is_err());
    }

    #[test]
    fn directory_errors_do_not_report_an_unconfirmed_authorization_failure() {
        let missing = r#"{"code":1,"data":null,"error":"目录不存在"}"#.as_bytes();
        assert_eq!(parse_directory_list(missing).unwrap_err(), FOLDER_MISSING);
        let logged_out = r#"{"code":1,"data":null,"error":"请先执行 bdpan login 命令"}"#.as_bytes();
        assert_eq!(parse_directory_list(logged_out).unwrap_err(), AUTH_EXPIRED);
        assert_eq!(
            parse_directory_list(b"{not-json}").unwrap_err(),
            LIST_INVALID
        );
        assert_eq!(listing_diagnostic("access_token=private"), None);
    }

    #[test]
    fn only_provider_user_code_can_reach_the_login_view() {
        let mut state = completed_login();
        update_login(
            &mut state,
            "授权链接: https://evil.invalid/device?access_token=secret",
        );
        update_login(&mut state, "用户码: https://evil.invalid");
        update_login(&mut state, "用户码: 0123456789ABCDEF0123456789ABCDEF");
        assert!(state.user_code.is_none());
        assert!(state.verification_url.is_none());
        update_login(&mut state, "用户码: ab12cd34\n");
        assert_eq!(state.user_code.as_deref(), Some("ab12cd34"));
        assert_eq!(state.verification_url.as_deref(), Some(DEVICE_URL));
    }

    #[test]
    fn provider_command_keeps_its_authorization_files_in_the_member_profile() {
        let scratch = tempfile::tempdir().unwrap();
        let profile = scratch.path().join("member");
        let client = BaiduClient::new(std::env::current_exe().unwrap(), profile.clone()).unwrap();
        let command = client.command("login").unwrap();
        let args = command.get_args().collect::<Vec<_>>();
        assert_eq!(args[0], "login");
        assert_eq!(args[1], "--config-path");
        assert_eq!(args[2], profile.join(CONFIG).as_os_str());
        #[cfg(unix)]
        {
            let home = command
                .get_envs()
                .find_map(|(key, value)| (key == "HOME").then_some(value))
                .flatten();
            assert_eq!(home, Some(profile.as_os_str()));
            assert_eq!(command.get_current_dir(), Some(profile.as_path()));
        }
    }

    #[test]
    fn provider_login_failures_return_only_predefined_messages() {
        for (output, expected) in [
            (
                "dial tcp: lookup openapi.baidu.com: no such host",
                LOGIN_DNS_FAILED,
            ),
            (
                "x509: certificate has expired or is not yet valid",
                LOGIN_TLS_FAILED,
            ),
            ("write config.json: read-only file system", PROFILE_FAILED),
            ("Authorization endpoint: HTTP 404", LOGIN_ENDPOINT_MISSING),
            ("error=unauthorized_client", LOGIN_CLIENT_REJECTED),
            ("error=expired_token", LOGIN_DECLINED),
            ("network is unreachable", LOGIN_NETWORK_FAILED),
        ] {
            let raw = format!("{output} access_token=private");
            let label = login_failure_in(&raw).unwrap();
            assert_eq!(label, expected);
            assert_eq!(login_diagnostic(label), Some(expected));
            assert_eq!(login_diagnostic(&raw), None);
        }
        assert_eq!(login_failure_in("access_token=private"), None);
    }

    #[test]
    fn a_profile_alias_cannot_read_an_old_authorization() {
        let dir = tempfile::tempdir().unwrap();
        let exe = std::env::current_exe().unwrap();
        let client = BaiduClient::new(exe.clone(), dir.path().to_path_buf()).unwrap();
        let alias = BaiduClient::new(exe, dir.path().join(".")).unwrap();
        assert!(Arc::ptr_eq(&client.busy, &alias.busy));
        assert!(!client.status().unwrap().connected);
        client.write_connection().unwrap();
        let first = client.connection_id().unwrap().unwrap();
        client.clear_connection().unwrap();
        client.write_connection().unwrap();
        let second = client.connection_id().unwrap().unwrap();
        assert_ne!(first, second);
        assert!(alias.require_connection(Some(&first)).is_err());
        assert!(alias.require_connection(Some(&second)).is_ok());
    }
}
