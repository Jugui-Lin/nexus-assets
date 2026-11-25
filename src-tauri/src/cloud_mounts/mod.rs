mod native;
#[cfg(windows)]
mod rclone;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::State;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Smb,
    Webdav,
    Rclone,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mount {
    id: String,
    kind: Kind,
    name: String,
    address: String,
    drive: String,
    subpath: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connect {
    id: Option<String>,
    kind: Kind,
    name: String,
    address: String,
    drive: String,
    subpath: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MountList {
    supported: bool,
    available_drives: Vec<String>,
    mounts: Vec<MountStatus>,
}

#[derive(Serialize)]
pub(crate) struct MountStatus {
    #[serde(flatten)]
    mount: Mount,
    status: &'static str,
}

#[derive(Serialize)]
pub(crate) struct Remotes {
    names: Vec<String>,
    notice: Option<String>,
}

#[derive(Default)]
struct Processes {
    #[cfg(windows)]
    rclone: std::collections::HashMap<String, rclone::RcloneMount>,
}

#[derive(Clone)]
pub(crate) struct Mounts {
    config: PathBuf,
    #[cfg(windows)]
    cache: PathBuf,
    processes: Arc<Mutex<Processes>>,
}

impl Mounts {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            config: root.join("cloud-mounts.json"),
            #[cfg(windows)]
            cache: root.join("mount-cache"),
            processes: Arc::default(),
        }
    }

    fn read(&self) -> Result<Vec<Mount>, String> {
        match fs::read(&self.config) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "无法读取网盘挂载配置。".into())
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!("无法打开网盘挂载配置：{error}")),
        }
    }

    fn write(&self, mounts: &[Mount]) -> Result<(), String> {
        let directory = self.config.parent().ok_or("无法定位挂载配置目录。")?;
        let bytes = serde_json::to_vec_pretty(mounts).map_err(|error| error.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        file.persist(&self.config)
            .map_err(|error| format!("无法保存网盘挂载配置：{}", error.error))?;
        Ok(())
    }

    fn operate<T>(&self, f: impl FnOnce(&mut Processes) -> Result<T, String>) -> Result<T, String> {
        let mut processes = self
            .processes
            .try_lock()
            .map_err(|_| "正在处理网盘挂载，请稍后刷新。")?;
        f(&mut processes)
    }

    pub(crate) fn stop_owned_processes(&self) {
        #[cfg(windows)]
        if let Ok(mut processes) = self.processes.try_lock() {
            processes.rclone.clear();
        }
    }
}

impl Mount {
    fn new(input: &Connect) -> Result<Self, String> {
        let drive = native::normalize_drive(&input.drive)?;
        if drive.as_bytes()[0] < b'D' {
            return Err("请选择 D: 到 Z: 之间的空闲盘符。".into());
        }
        let address = match input.kind {
            Kind::Smb => native::smb_remote(&input.address)?,
            Kind::Webdav => {
                let url = native::webdav_url(&input.address)?;
                if url.scheme() != "https" {
                    return Err("请输入 HTTPS WebDAV 服务地址。".into());
                }
                url.to_string()
            }
            Kind::Rclone => input.address.trim().into(),
        };
        let name = input.name.trim();
        if name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("挂载名称最多 80 个字符，且不能包含换行。".into());
        }
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: input.kind,
            name: if name.is_empty() {
                drive.clone()
            } else {
                name.into()
            },
            address,
            drive,
            subpath: input
                .subpath
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
                .filter(|_| input.kind == Kind::Rclone),
        })
    }

    fn webdav(&self) -> bool {
        self.kind == Kind::Webdav
    }

    fn native_target(&self) -> Result<String, String> {
        if self.webdav() {
            native::webdav_remote(&self.address)
        } else {
            native::smb_remote(&self.address)
        }
    }

    fn status(&self, processes: &mut Processes) -> &'static str {
        if self.kind == Kind::Rclone {
            #[cfg(windows)]
            if let Some(process) = processes.rclone.get_mut(&self.id) {
                if process.is_running() == Ok(true) {
                    return if native::drive_present(&self.drive) == Ok(true) {
                        "connected"
                    } else {
                        "starting"
                    };
                }
                processes.rclone.remove(&self.id);
            }
            #[cfg(not(windows))]
            let _ = processes;
            return if native::drive_present(&self.drive) == Ok(true) {
                "occupied"
            } else {
                "disconnected"
            };
        }
        match native::connection(&self.drive) {
            Ok(native::DriveConnection::Vacant) => "disconnected",
            Ok(native::DriveConnection::Connected(remote)) => match self.native_target() {
                Ok(expected) if native::same_remote(&remote, &expected, self.webdav()) => {
                    "connected"
                }
                _ => "occupied",
            },
            Ok(_) => "occupied",
            Err(_) => "unknown",
        }
    }

    fn connect(
        &self,
        input: &Connect,
        state: &Mounts,
        processes: &mut Processes,
    ) -> Result<(), String> {
        if self.kind != Kind::Rclone {
            return native::mount(
                &self.drive,
                &self.native_target()?,
                self.webdav(),
                input.username.as_deref().filter(|value| !value.is_empty()),
                input.password.as_deref().filter(|value| !value.is_empty()),
            );
        }
        #[cfg(windows)]
        {
            if native::connection(&self.drive)? != native::DriveConnection::Vacant {
                return Err("盘符已被占用，请选择其他盘符。".into());
            }
            let mut process = rclone::mount(
                &self.address,
                self.subpath.as_deref(),
                self.drive.as_bytes()[0] as char,
                &state.cache,
            )?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
            loop {
                if !process.is_running()? {
                    return Err("rclone 已退出，请检查网盘配置。".into());
                }
                if native::drive_present(&self.drive)? || std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            processes.rclone.insert(self.id.clone(), process);
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (state, processes);
            Err("请先用系统工具挂载网盘，再添加文件夹。".into())
        }
    }

    fn disconnect(&self, processes: &mut Processes) -> Result<(), String> {
        if self.kind != Kind::Rclone {
            return native::unmount(&self.drive, &self.native_target()?, self.webdav());
        }
        #[cfg(windows)]
        if let Some(process) = processes.rclone.get_mut(&self.id) {
            process.stop()?;
            processes.rclone.remove(&self.id);
        }
        #[cfg(not(windows))]
        let _ = processes;
        Ok(())
    }
}

async fn in_background<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn cloud_mount_list(state: State<'_, Mounts>) -> Result<MountList, String> {
    let state = state.inner().clone();
    in_background(move || {
        state.operate(|processes| {
            let records = state.read()?;
            let available_drives = native::available_drives()?
                .into_iter()
                .filter(|drive| !records.iter().any(|item| &item.drive == drive))
                .collect();
            let mounts = records
                .into_iter()
                .map(|mount| MountStatus {
                    status: mount.status(processes),
                    mount,
                })
                .collect();
            Ok(MountList {
                supported: cfg!(windows),
                available_drives,
                mounts,
            })
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn cloud_mount_remotes() -> Result<Remotes, String> {
    in_background(|| {
        #[cfg(windows)]
        return Ok(Remotes {
            names: rclone::list_remotes()?,
            notice: rclone::check_win_fsp().err(),
        });
        #[cfg(not(windows))]
        Ok(Remotes {
            names: Vec::new(),
            notice: Some("请使用系统工具挂载网盘。".into()),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn cloud_mount_connect(
    state: State<'_, Mounts>,
    input: Connect,
) -> Result<MountStatus, String> {
    let state = state.inner().clone();
    in_background(move || {
        state.operate(|processes| {
            let mut records = state.read()?;
            if let Some(id) = &input.id {
                let mount = records
                    .into_iter()
                    .find(|item| &item.id == id)
                    .ok_or("找不到这个挂载。")?;
                let status = mount.status(processes);
                if matches!(status, "connected" | "starting") {
                    return Ok(MountStatus { mount, status });
                }
                mount.connect(&input, &state, processes)?;
                return Ok(MountStatus {
                    status: mount.status(processes),
                    mount,
                });
            }
            let mount = Mount::new(&input)?;
            if records.iter().any(|record| record.drive == mount.drive) {
                return Err("此盘符已有挂载记录，请选择其他盘符。".into());
            }
            mount.connect(&input, &state, processes)?;
            records.push(mount.clone());
            if let Err(error) = state.write(&records) {
                return match mount.disconnect(processes) {
                    Ok(()) => Err(error),
                    Err(rollback) => Err(format!("{error} {rollback}")),
                };
            }
            Ok(MountStatus {
                status: mount.status(processes),
                mount,
            })
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn cloud_mount_disconnect(
    state: State<'_, Mounts>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    in_background(move || {
        state.operate(|processes| {
            let records = state.read()?;
            let mount = records
                .iter()
                .find(|item| item.id == id)
                .ok_or("找不到这个挂载。")?;
            mount.disconnect(processes)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn cloud_mount_forget(state: State<'_, Mounts>, id: String) -> Result<(), String> {
    let state = state.inner().clone();
    in_background(move || {
        state.operate(|processes| {
            let mut records = state.read()?;
            let index = records
                .iter()
                .position(|item| item.id == id)
                .ok_or("找不到这个挂载。")?;
            if matches!(records[index].status(processes), "connected" | "starting") {
                return Err("请先断开此挂载。".into());
            }
            records.remove(index);
            state.write(&records)
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_persist_without_credentials_and_can_be_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let state = Mounts::new(dir.path());
        let input = Connect {
            id: None,
            kind: Kind::Smb,
            name: "共享素材".into(),
            address: r"\\NAS\素材".into(),
            drive: "z".into(),
            subpath: None,
            username: Some("secret-user".into()),
            password: Some("secret-pass".into()),
        };
        let mount = Mount::new(&input).unwrap();
        assert_eq!(mount.drive, "Z:");
        state.write(&[mount]).unwrap();
        assert!(!fs::read_to_string(&state.config)
            .unwrap()
            .contains("secret"));
        assert_eq!(state.read().unwrap()[0].name, "共享素材");
        state.write(&[]).unwrap();
        assert!(state.read().unwrap().is_empty());
    }
}
