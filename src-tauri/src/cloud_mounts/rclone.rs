use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use windows::core::w;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;
const LIST_TIMEOUT: Duration = Duration::from_secs(6);
const OUTPUT_LIMIT: u64 = 64 * 1024;

pub(super) struct RcloneMount {
    child: Child,
    stderr: File,
    _cache: tempfile::TempDir,
}

impl RcloneMount {
    pub(super) fn is_running(&mut self) -> Result<bool, String> {
        match self.child.try_wait().map_err(|error| error.to_string())? {
            None => Ok(true),
            Some(status) if status.success() => Ok(false),
            Some(_) => Err(mount_error(&mut self.stderr)),
        }
    }

    pub(super) fn stop(&mut self) -> Result<(), String> {
        terminate(&mut self.child)
            .map(|_| ())
            .map_err(|error| format!("无法停止网盘挂载进程：{error}"))
    }
}

impl Drop for RcloneMount {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub(super) fn check_win_fsp() -> Result<(), String> {
    let mut size = 0;
    // WinFsp records its installer directory in the 32-bit registry view.
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\WinFsp"),
            w!("InstallDir"),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6432KEY,
            None,
            None,
            Some(&mut size),
        )
    };
    if result == ERROR_SUCCESS && size > 2 {
        Ok(())
    } else {
        Err("未检测到 WinFsp。安装 WinFsp 后即可通过 rclone 挂载网盘。".into())
    }
}

pub(super) fn list_remotes() -> Result<Vec<String>, String> {
    configured_remotes(&find_rclone()?)
}

pub(super) fn mount(
    remote: &str,
    subpath: Option<&str>,
    drive: char,
    cache_root: &Path,
) -> Result<RcloneMount, String> {
    let drive = drive.to_ascii_uppercase();
    if !drive.is_ascii_uppercase() {
        return Err("请选择有效的 Windows 盘符。".into());
    }
    let source = remote_source(remote, subpath)?;
    check_win_fsp()?;
    let executable = find_rclone()?;
    if !configured_remotes(&executable)?
        .iter()
        .any(|name| name == remote)
    {
        return Err("rclone 中找不到所选网盘，请刷新网盘列表。".into());
    }

    fs::create_dir_all(cache_root).map_err(|error| format!("无法创建网盘缓存目录：{error}"))?;
    // Separate caches make simultaneous mounts of overlapping remote folders safe.
    let cache = tempfile::Builder::new()
        .prefix("mount-")
        .tempdir_in(cache_root)
        .map_err(|error| format!("无法创建网盘缓存：{error}"))?;
    let stderr = tempfile::tempfile().map_err(|error| format!("无法创建挂载诊断输出：{error}"))?;
    let mut command = rclone_command(&executable);
    command
        .arg("mount")
        .arg(source)
        .arg(format!("{drive}:"))
        .args(["--network-mode", "--volname"])
        .arg(format!("Nexus-{drive}"))
        .args([
            "--read-only",
            "--dir-perms",
            "0700",
            "--file-perms",
            "0600",
            "--vfs-cache-mode",
            "full",
            "--vfs-cache-max-size",
            "2G",
            "--cache-dir",
        ])
        .arg(cache.path())
        .stdout(Stdio::null())
        .stderr(stderr.try_clone().map_err(|error| error.to_string())?);
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动 rclone：{error}"))?;
    Ok(RcloneMount {
        child,
        stderr,
        _cache: cache,
    })
}

fn find_rclone() -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("rclone.exe"))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "未找到 rclone。安装后请将 rclone.exe 所在目录加入 Windows PATH，并重启 Nexus。".into()
        })
}

fn rclone_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .creation_flags(CREATE_NO_WINDOW)
        .env_remove("RCLONE_DAEMON")
        .env_remove("RCLONE_LOG_FILE")
        .stdin(Stdio::null())
        .args(["--ask-password=false", "--rc=false", "--log-level", "ERROR"]);
    if let Some(parent) = executable.parent() {
        command.current_dir(parent);
    }
    command
}

fn configured_remotes(executable: &Path) -> Result<Vec<String>, String> {
    let mut stdout = tempfile::tempfile().map_err(|error| error.to_string())?;
    let mut child = rclone_command(executable)
        .arg("listremotes")
        .stdout(stdout.try_clone().map_err(|error| error.to_string())?)
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动 rclone：{error}"))?;

    let result = wait_for_list(&mut child);
    if !result? {
        return Err("无法读取 rclone 的网盘列表，请检查 rclone 配置及其解锁方式。".into());
    }
    let output = read_output(&mut stdout).map_err(|error| format!("无法读取网盘列表：{error}"))?;
    Ok(parse_remotes(&output))
}

fn wait_for_list(child: &mut Child) -> Result<bool, String> {
    let deadline = Instant::now() + LIST_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            result => {
                let _ = terminate(child);
                return Err(match result {
                    Err(error) => format!("无法读取 rclone 进程状态：{error}"),
                    _ => "读取 rclone 网盘列表超时。".into(),
                });
            }
        }
    }
}

fn terminate(child: &mut Child) -> std::io::Result<ExitStatus> {
    if let Some(status) = child.try_wait()? {
        return Ok(status);
    }
    if let Err(error) = child.kill() {
        return child.try_wait()?.ok_or(error);
    }
    child.wait()
}

fn read_output(file: &mut File) -> std::io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(OUTPUT_LIMIT).read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn mount_error(stderr: &mut File) -> String {
    let output = read_output(stderr).unwrap_or_default().to_ascii_lowercase();
    // Keep cloud paths, tokens, and provider response details out of Nexus UI and logs.
    if output.contains("winfsp") {
        "rclone 无法加载 WinFsp，请检查 WinFsp 安装。"
    } else if output.contains("401 unauthorized") || output.contains("invalid_grant") {
        "网盘的 rclone 授权已失效，请重新授权后再挂载。"
    } else if output.contains("403 forbidden") || output.contains("access denied") {
        "网盘或挂载盘符拒绝访问，请检查访问权限。"
    } else if output.contains("directory not found") || output.contains("path not found") {
        "网盘内找不到所填目录，请检查路径。"
    } else {
        "rclone 挂载已退出，请检查网盘配置、网络和盘符。"
    }
    .into()
}

fn valid_remote(name: &str) -> bool {
    !name.is_empty()
        && !(name.len() == 1 && name.as_bytes()[0].is_ascii_alphabetic())
        && !name.starts_with(['-', ' '])
        && !name.ends_with(' ')
        && name
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.' | '+' | '@' | ' '))
}

fn parse_remotes(output: &str) -> Vec<String> {
    let mut remotes: Vec<_> = output
        .lines()
        .filter_map(|line| line.strip_suffix(':'))
        .filter(|name| valid_remote(name))
        .map(str::to_owned)
        .collect();
    remotes.sort();
    remotes.dedup();
    remotes
}

fn remote_source(remote: &str, subpath: Option<&str>) -> Result<String, String> {
    if !valid_remote(remote) {
        return Err("请选择 rclone 中已配置的有效网盘。".into());
    }
    let subpath = subpath.unwrap_or_default().replace('\\', "/");
    let subpath = subpath.trim_matches('/');
    if subpath.chars().any(char::is_control) || subpath.split('/').any(|part| part == "..") {
        return Err("请输入有效的网盘内相对目录。".into());
    }
    Ok(format!("{remote}:{subpath}"))
}

#[cfg(test)]
mod tests {
    use super::{parse_remotes, remote_source};

    #[test]
    fn only_lists_configured_remote_names_usable_on_windows() {
        assert_eq!(
            parse_remotes(
                "Z:\r\n团队+盘@studio:\r\nwork drive:\r\n:drive:\r\n--rc:\r\nwork drive:\r\n"
            ),
            ["work drive", "团队+盘@studio"]
        );
    }

    #[test]
    fn mount_uses_the_configured_remote_and_relative_folder() {
        assert_eq!(remote_source("团队盘", None).unwrap(), "团队盘:");
        assert_eq!(
            remote_source("团队盘", Some(r"\贴图\PBR & HDR")).unwrap(),
            "团队盘:贴图/PBR & HDR"
        );
        assert!(remote_source("C", None).is_err());
        assert!(remote_source(":drive", None).is_err());
        assert!(remote_source("cloud", Some("textures/../other")).is_err());
        assert!(remote_source("cloud", Some("textures\0other")).is_err());
    }
}
