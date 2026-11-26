use super::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

mod blender;
mod c4d;
mod other;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;

const HOSTS: [&str; 5] = ["blender", "c4d", "maya", "max", "houdini"];
const HOUDINI_EXECUTABLES: &[&str] = &[
    "houdini.exe",
    "houdinifx.exe",
    "houdinicore.exe",
    "houdiniindie.exe",
    "hmaster.exe",
];
const HOST_LOCATIONS: &str = "host-executables.json";
const BLOCK_START: &[u8] = b"# >>> Nexus Assets Bridge (managed) >>>";
const BLOCK_END: &[u8] = b"# <<< Nexus Assets Bridge (managed) <<<";
const RUNTIME_SOURCE: &str = include_str!("../../../bridges/nexus_bridge.py");
const INSTALLED_SOURCE: &str = include_str!("../../../bridges/install/runtime_config.py");
static INSTALL: Mutex<()> = Mutex::new(());
type Receipts = BTreeMap<PathBuf, String>;
type RunningHosts = BTreeMap<&'static str, BTreeSet<u32>>;
type Discovery = (Vec<InstallTarget>, Vec<(String, PathBuf)>);
static RESTART_PENDING: Mutex<RunningHosts> = Mutex::new(BTreeMap::new());

pub(super) struct InstallEnvironment {
    home: PathBuf,
    documents: PathBuf,
    roaming: PathBuf,
    local: PathBuf,
    program_files: Vec<PathBuf>,
    runtime_dir: PathBuf,
    dcc_executables: BTreeMap<String, PathBuf>,
}

impl InstallEnvironment {
    fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        let path = app.path();
        let home = path.home_dir().map_err(|e| e.to_string())?;
        let mut program_files: Vec<_> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .collect();
        program_files.sort();
        program_files.dedup();
        let runtime_dir = path
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("bridge-runtime");
        let dcc_executables = read_host_executables(&runtime_dir).unwrap_or_default();
        Ok(Self {
            documents: path
                .document_dir()
                .unwrap_or_else(|_| home.join("Documents")),
            roaming: path.data_dir().map_err(|e| e.to_string())?,
            local: path.local_data_dir().map_err(|e| e.to_string())?,
            runtime_dir,
            home,
            program_files,
            dcc_executables,
        })
    }

    fn configured_executable(&self, dcc: &str) -> Option<&Path> {
        let path = self.dcc_executables.get(dcc)?;
        (path.is_absolute() && path.is_file()).then_some(path.as_path())
    }

    fn bootstrap(&self, template: &str) -> Vec<u8> {
        let path = self.runtime_dir.join("nexus_runtime.py");
        template
            .replace("__NEXUS_RUNTIME_PATH__", &python_literal(&path))
            .into_bytes()
    }
}

fn python_literal(path: &Path) -> String {
    let mut literal = String::from("\"");
    for ch in path.to_string_lossy().chars() {
        match ch {
            '\\' => literal.push_str("\\\\"),
            '"' => literal.push_str("\\\""),
            ch if ch.is_ascii() && !ch.is_control() => literal.push(ch),
            ch => literal.push_str(&format!("\\U{:08x}", ch as u32)),
        }
    }
    literal.push('"');
    literal
}

enum InstallKind {
    Managed,
    StartupBlock,
}

pub(super) struct InstallFile {
    relative: PathBuf,
    contents: Vec<u8>,
    kind: InstallKind,
}

impl InstallFile {
    fn managed(relative: impl Into<PathBuf>, contents: impl Into<Vec<u8>>) -> Self {
        Self {
            relative: relative.into(),
            contents: contents.into(),
            kind: InstallKind::Managed,
        }
    }

    fn startup_block(relative: impl Into<PathBuf>, contents: impl Into<Vec<u8>>) -> Self {
        Self {
            relative: relative.into(),
            contents: contents.into(),
            kind: InstallKind::StartupBlock,
        }
    }
}

pub(super) struct InstallTarget {
    host: &'static str,
    version: String,
    root: PathBuf,
    files: Vec<InstallFile>,
    activation: String,
}

impl InstallTarget {
    fn new(
        host: &'static str,
        version: impl Into<String>,
        root: impl Into<PathBuf>,
        files: Vec<InstallFile>,
        activation: impl Into<String>,
    ) -> Self {
        Self {
            host,
            version: version.into(),
            root: root.into(),
            files,
            activation: activation.into(),
        }
    }

    fn path(&self, file: &InstallFile) -> Result<PathBuf, String> {
        if !self.root.is_absolute()
            || file.relative.as_os_str().is_empty()
            || file
                .relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("插件安装位置无效".into());
        }
        Ok(self.root.join(&file.relative))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    version: String,
    path: PathBuf,
    status: &'static str,
    activation: String,
    restart_required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    dcc: &'static str,
    supported: bool,
    targets: Vec<TargetStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    completed: Vec<String>,
    errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSyncResult {
    statuses: Vec<HostStatus>,
    completed: Vec<BridgeChange>,
    errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeChange {
    dcc: &'static str,
    version: String,
    action: &'static str,
    restart_required: bool,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct RuntimeConfig {
    token: String,
    url: String,
}

impl RuntimeConfig {
    fn from_state(state: &AppState) -> Self {
        Self {
            token: state.token.clone(),
            url: format!("http://127.0.0.1:{}", state.port),
        }
    }

    fn read(bytes: &[u8]) -> Option<Self> {
        let config: Self = serde_json::from_slice(bytes).ok()?;
        let port = config
            .url
            .strip_prefix("http://127.0.0.1:")?
            .parse::<u16>()
            .ok()?;
        (port != 0
            && config.token.len() == 64
            && config
                .token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .then_some(config)
    }
}

fn discover(env: &InstallEnvironment) -> Discovery {
    let mut targets = blender::targets(env);
    let (cinema_targets, uninitialized_cinema) = c4d::discover(env);
    targets.extend(cinema_targets);
    targets.extend(other::targets(env));
    (targets, uninitialized_cinema)
}

fn read_host_executables(runtime: &Path) -> Result<BTreeMap<String, PathBuf>, String> {
    match file_bytes(&runtime.join(HOST_LOCATIONS))? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        None => Ok(BTreeMap::new()),
    }
}

pub(crate) fn converter_executable(app: &tauri::AppHandle, kind: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let variable = match kind {
            "blender" => "NEXUS_BLENDER_EXECUTABLE",
            "max" => "NEXUS_3DSMAX_BATCH_EXECUTABLE",
            _ => return None,
        };
        if std::env::var_os(variable).is_some() {
            return None;
        }
        let env = InstallEnvironment::for_app(app).ok()?;
        let configured = env.configured_executable(kind);
        let executable = if kind == "blender" {
            configured
                .map(Path::to_path_buf)
                .or_else(blender::detected_converter)
        } else {
            configured
                .and_then(Path::parent)
                .map(|directory| directory.join("3dsmaxbatch.exe"))
                .filter(|path| path.is_file())
                .or_else(|| {
                    windows::directories("max", "3dsmax.exe")
                        .into_iter()
                        .map(|directory| directory.join("3dsmaxbatch.exe"))
                        .filter(|path| path.is_file())
                        .max_by_key(|path| windows::file_version(path))
                })
        }?;
        Some(nexus_core::clean_path(&executable))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, kind);
        None
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn file_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta)
            if meta.is_file()
                && !meta.file_type().is_symlink()
                && meta.len() <= 4 * 1024 * 1024 =>
        {
            fs::read(path).map(Some).map_err(|e| e.to_string())
        }
        Ok(_) => Err(format!("路径不是可维护的普通文件：{}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn check_directory(path: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = meta.file_type().is_symlink();
    if reparse || !meta.is_dir() {
        return Err(format!("插件目录存在链接或文件冲突：{}", path.display()));
    }
    Ok(())
}

fn safe_parent(target: &InstallTarget, file: &InstallFile) -> Result<(), String> {
    let mut path = target.root.clone();
    check_directory(&path)?;
    if let Some(parent) = file.relative.parent() {
        for part in parent.components() {
            path.push(part.as_os_str());
            check_directory(&path)?;
        }
    }
    Ok(())
}

fn write_file(path: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("缺少目标目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    if replace {
        if let Ok(meta) = fs::metadata(path) {
            file.as_file()
                .set_permissions(meta.permissions())
                .map_err(|e| e.to_string())?;
        }
        file.persist(path).map_err(|e| e.to_string())?;
    } else {
        file.persist_noclobber(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn startup_bytes(previous: &[u8], body: &[u8]) -> Result<Vec<u8>, String> {
    if previous.starts_with(b"\xff\xfe")
        || previous.starts_with(b"\xfe\xff")
        || previous.contains(&0)
    {
        return Err("Maya 启动文件编码不适合安全追加插件，请使用手动脚本".into());
    }
    let eol: &[u8] = if previous.windows(2).any(|pair| pair == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    };
    let mut begin = None;
    let mut end = None;
    let mut position = 0;
    for line in previous.split_inclusive(|byte| *byte == b'\n') {
        let content = line.strip_suffix(b"\n").unwrap_or(line);
        let content = content.strip_suffix(b"\r").unwrap_or(content);
        if content == BLOCK_START && begin.replace(position).is_some()
            || content == BLOCK_END && end.replace(position + line.len()).is_some()
        {
            return Err("启动脚本含重复的 Nexus 区段".into());
        }
        position += line.len();
    }
    let mut output = Vec::new();
    match (begin, end) {
        (Some(start), Some(end)) if end > start => output.extend_from_slice(&previous[..start]),
        (None, None) => {
            output.extend_from_slice(previous);
            if !previous.is_empty() && !previous.ends_with(b"\n") {
                output.extend_from_slice(eol);
            }
        }
        _ => return Err("启动脚本中的 Nexus 区段不完整".into()),
    }
    output.extend_from_slice(BLOCK_START);
    output.extend_from_slice(eol);
    for line in body.split_inclusive(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        output.extend_from_slice(line.strip_suffix(b"\r").unwrap_or(line));
        output.extend_from_slice(eol);
    }
    output.extend_from_slice(BLOCK_END);
    output.extend_from_slice(eol);
    if let Some(end) = end {
        output.extend_from_slice(&previous[end..]);
    }
    Ok(output)
}

fn read_receipts(runtime: &Path) -> Result<Receipts, String> {
    match file_bytes(&runtime.join("files.json"))? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        None => Ok(Receipts::new()),
    }
}

struct FileChange {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
    track: bool,
}

fn plan(target: &InstallTarget, receipts: &Receipts) -> Result<Vec<FileChange>, String> {
    target
        .files
        .iter()
        .map(|file| {
            let path = target.path(file)?;
            safe_parent(target, file)?;
            let before = file_bytes(&path)?;
            let after = match file.kind {
                InstallKind::Managed => {
                    if let Some(old) = &before {
                        if old != &file.contents && receipts.get(&path) != Some(&digest(old)) {
                            return Err(format!("已有同名文件，已保留：{}", path.display()));
                        }
                    }
                    file.contents.clone()
                }
                InstallKind::StartupBlock => {
                    startup_bytes(before.as_deref().unwrap_or_default(), &file.contents)?
                }
            };
            Ok(FileChange {
                path,
                before,
                after,
                track: matches!(file.kind, InstallKind::Managed),
            })
        })
        .collect()
}

fn apply_changes(
    updates: &[FileChange],
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut applied: Vec<&FileChange> = Vec::new();
    let result = (|| {
        for update in updates {
            if file_changed(update) {
                if file_bytes(&update.path)? != update.before {
                    return Err(format!("安装期间文件发生变更：{}", update.path.display()));
                }
                write_file(&update.path, &update.after, update.before.is_some())?;
                applied.push(update);
            }
        }
        commit()
    })();
    if let Err(error) = result {
        for update in applied.into_iter().rev() {
            if file_bytes(&update.path).ok().flatten().as_ref() != Some(&update.after) {
                continue;
            }
            if let Some(before) = &update.before {
                let _ = write_file(&update.path, before, true);
            } else {
                let _ = fs::remove_file(&update.path);
            }
        }
        return Err(error);
    }
    Ok(())
}

fn file_changed(update: &FileChange) -> bool {
    update.before.as_ref() != Some(&update.after)
}

fn install_target(
    target: &InstallTarget,
    receipts: &mut Receipts,
    runtime: &Path,
) -> Result<(), String> {
    let updates = plan(target, receipts)?;
    let mut new_receipts = receipts.clone();
    for update in &updates {
        if update.track {
            new_receipts.insert(update.path.clone(), digest(&update.after));
        }
    }
    apply_changes(&updates, || {
        if new_receipts == *receipts {
            return Ok(());
        }
        let manifest = runtime.join("files.json");
        let existing = file_bytes(&manifest)?;
        let current: Receipts = existing
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or_default();
        if current != *receipts {
            return Err("插件安装记录已更改，请重新检测".into());
        }
        let bytes = serde_json::to_vec_pretty(&new_receipts).map_err(|e| e.to_string())?;
        write_file(&manifest, &bytes, existing.is_some())
    })?;
    *receipts = new_receipts;
    Ok(())
}

fn current_runtime() -> Vec<u8> {
    [RUNTIME_SOURCE, "\n\n", INSTALLED_SOURCE]
        .concat()
        .into_bytes()
}

fn runtime_updates(runtime: &Path, config: &RuntimeConfig) -> Result<[FileChange; 2], String> {
    check_directory(runtime)?;
    let runtime_path = runtime.join("nexus_runtime.py");
    let runtime_before = file_bytes(&runtime_path)?;
    let payload = current_runtime();
    if runtime_before
        .as_ref()
        .is_some_and(|bytes| bytes != &payload && !legacy_runtime(bytes))
    {
        return Err("桥接运行目录存在未识别的运行时文件，已保留".into());
    }

    let config_path = runtime.join("config.json");
    let config_before = file_bytes(&config_path)?;
    let previous = config_before
        .as_deref()
        .map(|bytes| RuntimeConfig::read(bytes).ok_or("桥接运行目录存在未识别的连接配置，已保留"))
        .transpose()?;
    let config_after = if previous.as_ref() == Some(config) {
        config_before.clone().unwrap_or_default()
    } else {
        serde_json::to_vec(config).map_err(|_| "无法准备桥接连接配置")?
    };
    Ok([
        FileChange {
            path: runtime_path,
            before: runtime_before,
            after: payload,
            track: false,
        },
        FileChange {
            path: config_path,
            before: config_before,
            after: config_after,
            track: false,
        },
    ])
}

fn legacy_runtime(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    text.starts_with("\"\"\"Nexus bridge runtime.")
        && text.contains("def read_config(dcc):")
        && text.contains("Private connection parameters shared by the plugins on this machine.")
}

fn installation_status(files: &[FileChange], runtime_current: bool) -> &'static str {
    if runtime_current && !files.iter().any(file_changed) {
        "installed"
    } else if files.iter().any(|item| {
        item.before.as_ref().is_some_and(|bytes| {
            item.track
                || bytes
                    .split(|byte| *byte == b'\n')
                    .any(|line| line.strip_suffix(b"\r").unwrap_or(line) == BLOCK_START)
        })
    }) {
        "update"
    } else {
        "ready"
    }
}

fn host_supported(dcc: &str) -> bool {
    cfg!(windows) || (dcc != "max" && cfg!(target_os = "macos"))
}

fn detected_status(
    (targets, uninitialized_cinema): &Discovery,
    receipts: &Receipts,
    runtime_current: bool,
    restart: &BTreeSet<&'static str>,
) -> Vec<HostStatus> {
    HOSTS
        .into_iter()
        .map(|dcc| HostStatus {
            dcc,
            supported: host_supported(dcc),
            targets: targets
                .iter()
                .filter(|target| target.host == dcc)
                .map(|target| {
                    let status = plan(target, receipts).map_or("conflict", |files| {
                        installation_status(&files, runtime_current)
                    });
                    TargetStatus {
                        version: target.version.clone(),
                        path: target.root.clone(),
                        status,
                        activation: target.activation.clone(),
                        restart_required: status == "installed" && restart.contains(dcc),
                    }
                })
                .chain(uninitialized_cinema.iter().filter(|_| dcc == "c4d").map(
                    |(version, executable)| TargetStatus {
                        version: version.clone(),
                        path: executable.clone(),
                        status: "initialize",
                        activation:
                            "先启动 Cinema 4D 一次，生成用户首选项目录后再重新检测。".into(),
                        restart_required: false,
                    },
                ))
                .collect(),
        })
        .collect()
}

fn status(
    env: &InstallEnvironment,
    config: Option<&RuntimeConfig>,
    restart: &BTreeSet<&'static str>,
) -> Result<Vec<HostStatus>, String> {
    let receipts = read_receipts(&env.runtime_dir)?;
    let runtime_current = file_bytes(&env.runtime_dir.join("nexus_runtime.py"))?.as_ref()
        == Some(&current_runtime())
        && file_bytes(&env.runtime_dir.join("config.json"))?
            .as_deref()
            .and_then(RuntimeConfig::read)
            .is_some_and(|previous| config.is_none_or(|config| &previous == config));
    Ok(detected_status(
        &discover(env),
        &receipts,
        runtime_current,
        restart,
    ))
}

fn running_hosts(state: &AppState) -> RunningHosts {
    #[cfg(windows)]
    let mut running = windows::running_hosts();
    #[cfg(not(windows))]
    let mut running = RunningHosts::new();
    if let Ok(sessions) = state.sessions.lock() {
        let now = nexus_core::now();
        for session in sessions.values() {
            if now.saturating_sub(session["lastSeen"].as_u64().unwrap_or(0)) >= 15 {
                continue;
            }
            let host = HOSTS
                .into_iter()
                .find(|host| session["dcc"].as_str() == Some(host));
            let pid = session["pid"]
                .as_u64()
                .and_then(|pid| u32::try_from(pid).ok());
            if let (Some(host), Some(pid)) = (host, pid) {
                running.entry(host).or_default().insert(pid);
            }
        }
    }
    running
}

fn restart_status(
    running: &RunningHosts,
    changed: &BTreeSet<&'static str>,
) -> BTreeSet<&'static str> {
    let Ok(mut pending) = RESTART_PENDING.lock() else {
        return changed
            .iter()
            .filter(|host| running.contains_key(*host))
            .copied()
            .collect();
    };
    pending.retain(|host, previous| {
        let Some(current) = running.get(host) else {
            return false;
        };
        previous.retain(|pid| current.contains(pid));
        !previous.is_empty()
    });
    for &host in changed {
        if let Some(pids) = running.get(host) {
            pending.entry(host).or_default().extend(pids);
        }
    }
    pending.keys().copied().collect()
}

fn synchronize_targets(
    runtime: &Path,
    discovery: &Discovery,
    dcc: Option<&str>,
    config: &RuntimeConfig,
    running: &RunningHosts,
) -> Result<BridgeSyncResult, String> {
    check_directory(runtime)?;
    let mut receipts = read_receipts(runtime)?;
    let updates = runtime_updates(runtime, config);
    let mut current = updates
        .as_ref()
        .is_ok_and(|updates| !updates.iter().any(file_changed));
    let mut completed = Vec::new();
    let mut errors = Vec::new();
    let mut targets = Vec::new();
    for target in &discovery.0 {
        if !host_supported(target.host) || dcc.is_some_and(|selected| selected != target.host) {
            continue;
        }
        match plan(target, &receipts) {
            Ok(files) => {
                let status = installation_status(&files, current);
                let needs_receipt = files
                    .iter()
                    .any(|file| file.track && !receipts.contains_key(&file.path));
                if status != "installed" || needs_receipt {
                    targets.push((target, status));
                }
            }
            Err(error) => errors.push(format!("{} {} · {error}", target.host, target.version)),
        }
    }

    let mut changed_hosts = BTreeSet::new();
    if !current && !targets.is_empty() {
        match updates.and_then(|updates| apply_changes(&updates, || Ok(()))) {
            Ok(()) => {
                current = true;
                // The runtime is shared. Existing bridges may still have the old
                // module or loopback connection in memory until their host restarts.
                for target in &discovery.0 {
                    if plan(target, &receipts)
                        .is_ok_and(|files| installation_status(&files, false) == "update")
                    {
                        changed_hosts.insert(target.host);
                    }
                }
            }
            Err(error) => {
                errors.push(error);
                targets.clear();
            }
        }
    }

    for (target, status) in targets {
        match install_target(target, &mut receipts, runtime) {
            Ok(()) if status != "installed" => {
                changed_hosts.insert(target.host);
                completed.push(BridgeChange {
                    dcc: target.host,
                    version: target.version.clone(),
                    action: if status == "ready" {
                        "installed"
                    } else {
                        "updated"
                    },
                    restart_required: running.contains_key(target.host),
                });
            }
            Ok(()) => {}
            Err(error) => errors.push(format!("{} {} · {error}", target.host, target.version)),
        }
    }
    let restart = restart_status(running, &changed_hosts);
    Ok(BridgeSyncResult {
        statuses: detected_status(discovery, &receipts, current, &restart),
        completed,
        errors,
    })
}

#[tauri::command]
pub async fn bridge_install_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<HostStatus>, String> {
    let env = InstallEnvironment::for_app(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = INSTALL.lock().map_err(|_| "插件检测暂不可用")?;
        let running = running_hosts(&state);
        status(
            &env,
            Some(&RuntimeConfig::from_state(&state)),
            &restart_status(&running, &BTreeSet::new()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sync_bridges(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    dcc: Option<String>,
) -> Result<BridgeSyncResult, String> {
    if dcc.as_deref().is_some_and(|dcc| !HOSTS.contains(&dcc)) {
        return Err("未知 DCC".into());
    }
    let env = InstallEnvironment::for_app(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = INSTALL.lock().map_err(|_| "插件维护暂不可用")?;
        let targets = discover(&env);
        synchronize_targets(
            &env.runtime_dir,
            &targets,
            dcc.as_deref(),
            &RuntimeConfig::from_state(&state),
            &running_hosts(&state),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn choose_bridge_executable(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    dcc: String,
) -> Result<Option<Vec<HostStatus>>, String> {
    if !cfg!(windows) {
        return Err("手动选择创作软件程序仅支持 Windows。".into());
    }
    let expected: &'static [&'static str] = match dcc.as_str() {
        "blender" => &["blender.exe"],
        "c4d" => &["Cinema 4D.exe"],
        "maya" => &["maya.exe"],
        "max" => &["3dsmax.exe"],
        "houdini" => HOUDINI_EXECUTABLES,
        _ => return Err("未知 DCC".into()),
    };
    let mut env = InstallEnvironment::for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let selection = rfd::FileDialog::new()
            .set_parent(&window)
            .set_title(format!("选择 {}", expected[0]))
            .add_filter("创作软件程序", &["exe"]);
        let selection = if let Some(existing) = env.configured_executable(&dcc) {
            selection.set_directory(existing.parent().unwrap_or(existing))
        } else {
            selection
        };
        let Some(path) = selection.pick_file() else {
            return Ok(None);
        };
        let filename = path
            .file_name()
            .and_then(|part| part.to_str())
            .unwrap_or_default();
        if !expected
            .iter()
            .any(|name| filename.eq_ignore_ascii_case(name))
            || !path.is_file()
        {
            return Err(format!(
                "请选择正确的软件程序（{}）。",
                expected.join(" / ")
            ));
        }
        let _guard = INSTALL.lock().map_err(|_| "暂时无法保存软件路径")?;
        let mut selected = read_host_executables(&env.runtime_dir)?;
        selected.insert(dcc, path);
        write_file(
            &env.runtime_dir.join(HOST_LOCATIONS),
            &serde_json::to_vec(&selected).map_err(|error| error.to_string())?,
            true,
        )?;
        env.dcc_executables = selected;
        status(&env, None, &BTreeSet::new()).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn install_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    dcc: String,
) -> Result<InstallResult, String> {
    if !HOSTS.contains(&dcc.as_str()) {
        return Err("未知 DCC".into());
    }
    let env = InstallEnvironment::for_app(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = INSTALL.lock().map_err(|_| "插件安装暂不可用")?;
        let targets = discover(&env);
        if !targets.0.iter().any(|target| target.host == dcc) {
            return Err("未检测到可安装的版本。首次使用请先启动对应软件一次，再重新检测。".into());
        }
        let result = synchronize_targets(
            &env.runtime_dir,
            &targets,
            Some(&dcc),
            &RuntimeConfig::from_state(&state),
            &running_hosts(&state),
        )?;
        let completed = result
            .statuses
            .into_iter()
            .filter(|host| host.dcc == dcc)
            .flat_map(|host| host.targets.into_iter())
            .filter(|target| target.status == "installed")
            .map(|target| target.version)
            .collect();
        Ok(InstallResult {
            completed,
            errors: result.errors,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
