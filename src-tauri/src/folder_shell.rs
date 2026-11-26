use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderShellStatus {
    supported: bool,
    enabled: bool,
    can_enable: bool,
    can_restore: bool,
    current_handler: Option<String>,
    previous_handler: Option<String>,
    detail: String,
}

#[tauri::command]
pub(crate) async fn folder_shell_status() -> Result<FolderShellStatus, String> {
    run(operation::status).await
}

#[tauri::command]
pub(crate) async fn enable_folder_shell() -> Result<FolderShellStatus, String> {
    run(operation::enable).await
}

#[tauri::command]
pub(crate) async fn restore_folder_shell() -> Result<FolderShellStatus, String> {
    run(operation::restore).await
}

async fn run(
    operation: fn() -> Result<FolderShellStatus, String>,
) -> Result<FolderShellStatus, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn restore_for_uninstall() -> Result<(), String> {
    operation::restore_for_uninstall()
}

#[cfg(not(windows))]
mod operation {
    use super::FolderShellStatus;

    pub(super) fn status() -> Result<FolderShellStatus, String> {
        Ok(FolderShellStatus {
            supported: false,
            enabled: false,
            can_enable: false,
            can_restore: false,
            current_handler: None,
            previous_handler: None,
            detail: "此设置适用于 Windows。".into(),
        })
    }

    pub(super) fn enable() -> Result<FolderShellStatus, String> {
        Err("此设置适用于 Windows。".into())
    }

    pub(super) fn restore() -> Result<FolderShellStatus, String> {
        Err("此设置适用于 Windows。".into())
    }

    pub(super) fn restore_for_uninstall() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
mod operation {
    use super::FolderShellStatus;
    use serde::{Deserialize, Serialize};
    use std::{
        path::{Path, PathBuf},
        sync::Mutex,
    };
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR},
            System::Registry::{
                RegCloseKey, RegCreateKeyW, RegDeleteKeyW, RegDeleteValueW, RegOpenKeyExW,
                RegQueryInfoKeyW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CLASSES_ROOT,
                HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_BINARY, REG_DWORD, REG_EXPAND_SZ,
                REG_SAM_FLAGS, REG_SZ, REG_VALUE_TYPE,
            },
            UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST},
        },
    };

    const SHELL_KEY: &str = r"Software\Classes\Folder\shell";
    const VERB_KEY: &str = r"Software\Classes\Folder\shell\NexusAssets.OpenFolder";
    const COMMAND_KEY: &str = r"Software\Classes\Folder\shell\NexusAssets.OpenFolder\command";
    const VERB: &str = "NexusAssets.OpenFolder";
    const LABEL: &str = "用 Nexus Assets 打开";
    const FILESYSTEM_FOLDER: u32 = 0x6000_0000; // SFGAO_FILESYSTEM | SFGAO_FOLDER
    const VERB_ATTRIBUTES: [(&str, u32); 3] = [
        ("AttributeMask", FILESYSTEM_FOLDER),
        ("AttributeValue", FILESYSTEM_FOLDER),
        ("ImpliedSelectionModel", 0),
    ];
    const JOURNAL_KEY: &str = r"Software\Nexus Assets\FolderShell";
    const JOURNAL_VALUE: &str = "PreviousFolderV1";
    const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Nexus Assets";
    const MAX_VALUE: usize = 128 * 1024;
    const MAX_PRIOR: usize = 8 * 1024;
    static CHANGE: Mutex<()> = Mutex::new(());

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    struct Value {
        kind: u32,
        bytes: Vec<u8>,
    }

    impl Value {
        fn text(value: &str) -> Self {
            Self {
                kind: REG_SZ.0,
                bytes: value
                    .encode_utf16()
                    .chain([0])
                    .flat_map(u16::to_le_bytes)
                    .collect(),
            }
        }

        fn dword(value: u32) -> Self {
            Self {
                kind: REG_DWORD.0,
                bytes: value.to_le_bytes().to_vec(),
            }
        }

        fn as_text(&self) -> Option<String> {
            if !matches!(REG_VALUE_TYPE(self.kind), REG_SZ | REG_EXPAND_SZ)
                || self.bytes.len() % 2 != 0
            {
                return None;
            }
            let words = self
                .bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .take_while(|word| *word != 0)
                .collect::<Vec<_>>();
            String::from_utf16(&words).ok()
        }
    }

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    struct Prior {
        existed: bool,
        default: Option<Value>,
    }

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    struct Journal {
        previous: Prior,
        command: Value,
    }

    trait Registry {
        fn value(&self, path: &str, name: &str) -> Result<Option<Value>, String>;
        fn exists(&self, path: &str) -> Result<bool, String>;
        fn set(&self, path: &str, name: &str, value: &Value) -> Result<(), String>;
        fn delete(&self, path: &str, name: &str) -> Result<(), String>;
        fn prune(&self, path: &str) -> Result<(), String>;
    }

    fn journal(registry: &impl Registry) -> Result<Option<Journal>, String> {
        let Some(value) = registry.value(JOURNAL_KEY, JOURNAL_VALUE)? else {
            return Ok(None);
        };
        if value.kind != REG_BINARY.0 {
            return Err("文件管理器恢复记录格式无效".into());
        }
        serde_json::from_slice(&value.bytes)
            .map(Some)
            .map_err(|_| "文件管理器恢复记录无法读取".into())
    }

    fn our_default(value: Option<&Value>) -> bool {
        value
            .and_then(Value::as_text)
            .is_some_and(|name| name.eq_ignore_ascii_case(VERB))
    }

    fn owns(registry: &impl Registry, command: &Value) -> Result<bool, String> {
        if registry.value(VERB_KEY, "")?.as_ref() != Some(&Value::text(LABEL))
            || registry.value(COMMAND_KEY, "")?.as_ref() != Some(command)
        {
            return Ok(false);
        }
        for (name, expected) in VERB_ATTRIBUTES {
            if registry.value(VERB_KEY, name)? != Some(Value::dword(expected)) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn save_prior(registry: &impl Registry) -> Result<Prior, String> {
        let default = registry.value(SHELL_KEY, "")?;
        if our_default(default.as_ref()) || registry.exists(VERB_KEY)? {
            return Err("现有 Nexus 文件夹注册与恢复记录不匹配，请先检查当前设置".into());
        }
        if default
            .as_ref()
            .is_some_and(|value| value.bytes.len() > MAX_PRIOR)
        {
            return Err("现有文件夹设置过长，无法安全备份".into());
        }
        Ok(Prior {
            existed: registry.exists(SHELL_KEY)?,
            default,
        })
    }

    fn enable_registry(registry: &impl Registry, command: Value) -> Result<(), String> {
        if journal(registry)?.is_some() {
            return Err("请先恢复当前的文件夹打开设置".into());
        }
        let saved = Journal {
            previous: save_prior(registry)?,
            command,
        };
        // Save the displaced default before touching its shell key.
        let bytes = serde_json::to_vec(&saved).map_err(|error| error.to_string())?;
        registry.set(
            JOURNAL_KEY,
            JOURNAL_VALUE,
            &Value {
                kind: REG_BINARY.0,
                bytes,
            },
        )?;
        let result = (|| {
            if registry.exists(VERB_KEY)?
                || registry.value(SHELL_KEY, "")? != saved.previous.default
            {
                return Err("文件夹打开方式刚刚发生变化".to_owned());
            }
            registry.set(VERB_KEY, "", &Value::text(LABEL))?;
            registry.set(COMMAND_KEY, "", &saved.command)?;
            // Folder supplies the default for drives and directories. Only
            // filesystem folders may use this verb.
            for (name, value) in VERB_ATTRIBUTES {
                registry.set(VERB_KEY, name, &Value::dword(value))?;
            }
            if registry.value(SHELL_KEY, "")? != saved.previous.default {
                return Err("文件夹打开方式刚刚发生变化".to_owned());
            }
            registry.set(SHELL_KEY, "", &Value::text(VERB))
        })();
        if let Err(error) = result {
            return match restore_registry(registry, &saved) {
                Ok(_) => Err(error),
                Err(rollback) => Err(format!("{error}。恢复记录已保留。{rollback}")),
            };
        }
        Ok(())
    }

    fn remove_owned_verb(registry: &impl Registry, command: &Value) -> Result<(), String> {
        if registry.value(VERB_KEY, "")? != Some(Value::text(LABEL)) {
            return Ok(());
        }
        if registry
            .value(COMMAND_KEY, "")?
            .is_some_and(|value| value != *command)
        {
            return Ok(());
        }
        // Missing values are normal when rolling back an incomplete install.
        for (name, expected) in VERB_ATTRIBUTES {
            if registry
                .value(VERB_KEY, name)?
                .is_some_and(|value| value != Value::dword(expected))
            {
                return Ok(());
            }
        }
        registry.delete(COMMAND_KEY, "")?;
        registry.prune(COMMAND_KEY)?;
        for (name, _) in VERB_ATTRIBUTES {
            registry.delete(VERB_KEY, name)?;
        }
        registry.delete(VERB_KEY, "")?;
        registry.prune(VERB_KEY)?;
        Ok(())
    }

    fn restore_registry(registry: &impl Registry, saved: &Journal) -> Result<bool, String> {
        let current = registry.value(SHELL_KEY, "")?;
        let kept_newer_choice = if our_default(current.as_ref()) {
            if !owns(registry, &saved.command)? {
                return Err("默认文件夹命令已被其他程序修改，请在该程序中检查设置".into());
            }
            if registry.value(SHELL_KEY, "")? != current {
                return Err("默认文件夹命令已发生变化".into());
            }
            if let Some(value) = &saved.previous.default {
                registry.set(SHELL_KEY, "", value)?;
            } else {
                registry.delete(SHELL_KEY, "")?;
            }
            false
        } else {
            current != saved.previous.default
        };
        remove_owned_verb(registry, &saved.command)?;
        if !saved.previous.existed {
            registry.prune(SHELL_KEY)?;
        }
        if journal(registry)?.as_ref() == Some(saved) {
            registry.delete(JOURNAL_KEY, JOURNAL_VALUE)?;
            registry.prune(JOURNAL_KEY)?;
        }
        Ok(kept_newer_choice)
    }

    fn process_exe() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        exe.file_name()
            .and_then(|name| name.to_str())?
            .eq_ignore_ascii_case("nexus-assets.exe")
            .then_some(exe)
    }

    fn command_for(exe: &Path) -> Option<Value> {
        let path = exe.to_str()?;
        if !exe.is_absolute() || path.len() > 4096 || path.contains(['"', '\0', '\r', '\n', '%']) {
            return None;
        }
        // The suffix prevents a drive or UNC root's last slash from
        // escaping the closing quote when Windows substitutes %1.
        Some(Value::text(&format!(r#""{path}" --open-folder "%1\.""#)))
    }

    fn canonical_command(exe: &Path) -> Option<Value> {
        let resolved = exe.canonicalize().ok()?;
        resolved.to_str()?;
        command_for(Path::new(&nexus_core::clean_path(&resolved)))
    }

    fn command_at_installation(exe: &Path, location: &str) -> Option<Value> {
        let installed = PathBuf::from(location.trim().trim_matches('"')).join("nexus-assets.exe");
        if !installed.is_absolute() || !same_file::is_same_file(exe, &installed).ok()? {
            return None;
        }
        canonical_command(&installed)
    }

    fn installed_command() -> Option<Value> {
        // Only a current-user installation can restore the same HKCU on uninstall.
        let location = WinRegistry(HKEY_CURRENT_USER)
            .value(UNINSTALL_KEY, "InstallLocation")
            .ok()??
            .as_text()?;
        command_at_installation(&process_exe()?, &location)
    }

    fn merged_collision() -> Result<bool, String> {
        WinRegistry(HKEY_CLASSES_ROOT).exists(&format!(r"Folder\shell\{VERB}"))
    }

    fn display_handler(value: Option<&Value>) -> Option<String> {
        let value = value.and_then(Value::as_text)?;
        let name = value.trim();
        if name.eq_ignore_ascii_case(VERB) {
            Some("Nexus Assets".into())
        } else if name.is_empty()
            || name.eq_ignore_ascii_case("none")
            || name.eq_ignore_ascii_case("open")
        {
            Some("Windows 默认打开方式".into())
        } else {
            Some(name.chars().take(160).collect())
        }
    }

    fn read_status(registry: &impl Registry) -> Result<FolderShellStatus, String> {
        let saved = journal(registry)?;
        let merged = WinRegistry(HKEY_CLASSES_ROOT)
            .value(r"Folder\shell", "")
            .ok()
            .flatten();
        let current_handler =
            display_handler(merged.as_ref()).or_else(|| Some("Windows 默认打开方式".into()));
        let previous_handler = saved.as_ref().map(|saved| {
            display_handler(saved.previous.default.as_ref())
                .unwrap_or_else(|| "使用系统关联（接管前没有单独指定）".into())
        });
        let enabled = if let Some(saved) = &saved {
            our_default(registry.value(SHELL_KEY, "")?.as_ref()) && owns(registry, &saved.command)?
        } else {
            false
        };
        let installed = installed_command().is_some();
        let collision = saved.is_none() && merged_collision()?;
        let detail = if enabled {
            "Nexus 已接管常规文件夹和磁盘的默认打开方式。"
        } else if saved.is_some() {
            "文件夹打开方式已变化，可以检查并恢复原设置。"
        } else if collision {
            "检测到其他 Nexus 文件夹注册，请先检查现有设置。"
        } else if installed {
            "启用后，常规文件夹和磁盘会由 Nexus 打开。"
        } else {
            "请从已安装的 Nexus 中启用此设置。"
        };
        Ok(FolderShellStatus {
            supported: true,
            enabled,
            can_enable: installed && saved.is_none() && !collision,
            can_restore: saved.is_some(),
            current_handler,
            previous_handler,
            detail: detail.into(),
        })
    }

    pub(super) fn status() -> Result<FolderShellStatus, String> {
        let _guard = CHANGE.lock().map_err(|_| "无法读取文件管理器设置")?;
        read_status(&WinRegistry(HKEY_CURRENT_USER))
    }

    fn notify_shell() {
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) }
    }

    pub(super) fn enable() -> Result<FolderShellStatus, String> {
        let _guard = CHANGE.lock().map_err(|_| "无法修改文件管理器设置")?;
        let registry = WinRegistry(HKEY_CURRENT_USER);
        if merged_collision()? {
            return Err("检测到现有 Nexus 文件夹注册，请先恢复或检查设置".into());
        }
        let command = installed_command().ok_or("请从已安装的 Nexus 中启用此设置")?;
        let result = enable_registry(&registry, command);
        notify_shell();
        result?;
        read_status(&registry)
    }

    pub(super) fn restore() -> Result<FolderShellStatus, String> {
        let _guard = CHANGE.lock().map_err(|_| "无法恢复文件管理器设置")?;
        let registry = WinRegistry(HKEY_CURRENT_USER);
        let kept_newer_choice = if let Some(saved) = journal(&registry)? {
            let result = restore_registry(&registry, &saved);
            notify_shell();
            result?
        } else {
            false
        };
        let mut status = read_status(&registry)?;
        status.detail = if kept_newer_choice {
            "已停用 Nexus 接管，保留了此后更改的文件夹打开方式。".into()
        } else {
            "已恢复接管前的文件夹打开方式。".into()
        };
        Ok(status)
    }

    pub(super) fn restore_for_uninstall() -> Result<(), String> {
        let _guard = CHANGE.lock().map_err(|_| "无法恢复文件管理器设置")?;
        let registry = WinRegistry(HKEY_CURRENT_USER);
        if let Some(saved) = journal(&registry)? {
            let command = process_exe().and_then(|exe| canonical_command(&exe));
            if command.as_ref() == Some(&saved.command) {
                let result = restore_registry(&registry, &saved);
                notify_shell();
                result?;
            }
        }
        Ok(())
    }

    struct WinRegistry(HKEY);
    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            let _ = unsafe { RegCloseKey(self.0) };
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain([0]).collect()
    }

    fn missing(status: WIN32_ERROR) -> bool {
        matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
    }

    fn reg_error(status: WIN32_ERROR) -> String {
        format!("无法访问文件管理器设置（Windows 错误 {}）", status.0)
    }

    impl WinRegistry {
        fn open(&self, path: &str, access: REG_SAM_FLAGS) -> Result<Option<Key>, String> {
            let path = wide(path);
            let mut key = HKEY::default();
            let status =
                unsafe { RegOpenKeyExW(self.0, PCWSTR(path.as_ptr()), None, access, &mut key) };
            if missing(status) {
                Ok(None)
            } else if status == ERROR_SUCCESS {
                Ok(Some(Key(key)))
            } else {
                Err(reg_error(status))
            }
        }
    }

    impl Registry for WinRegistry {
        fn value(&self, path: &str, name: &str) -> Result<Option<Value>, String> {
            let Some(key) = self.open(path, KEY_READ)? else {
                return Ok(None);
            };
            let name = wide(name);
            let name = PCWSTR(name.as_ptr());
            let (mut kind, mut length) = (REG_VALUE_TYPE(0), 0);
            let status = unsafe {
                RegQueryValueExW(key.0, name, None, Some(&mut kind), None, Some(&mut length))
            };
            if missing(status) {
                return Ok(None);
            }
            if status != ERROR_SUCCESS {
                return Err(reg_error(status));
            }
            if length as usize > MAX_VALUE {
                return Err("文件管理器设置过长".into());
            }
            let mut bytes = vec![0; length as usize];
            let status = unsafe {
                RegQueryValueExW(
                    key.0,
                    name,
                    None,
                    Some(&mut kind),
                    Some(bytes.as_mut_ptr()),
                    Some(&mut length),
                )
            };
            if status != ERROR_SUCCESS {
                return Err(reg_error(status));
            }
            bytes.truncate(length as usize);
            Ok(Some(Value {
                kind: kind.0,
                bytes,
            }))
        }

        fn exists(&self, path: &str) -> Result<bool, String> {
            Ok(self.open(path, KEY_READ)?.is_some())
        }

        fn set(&self, path: &str, name: &str, value: &Value) -> Result<(), String> {
            let path = wide(path);
            let mut key = HKEY::default();
            let status = unsafe { RegCreateKeyW(self.0, PCWSTR(path.as_ptr()), &mut key) };
            if status != ERROR_SUCCESS {
                return Err(reg_error(status));
            }
            let key = Key(key);
            let name = wide(name);
            let status = unsafe {
                RegSetValueExW(
                    key.0,
                    PCWSTR(name.as_ptr()),
                    None,
                    REG_VALUE_TYPE(value.kind),
                    Some(&value.bytes),
                )
            };
            if status != ERROR_SUCCESS {
                return Err(reg_error(status));
            }
            Ok(())
        }

        fn delete(&self, path: &str, name: &str) -> Result<(), String> {
            let Some(key) = self.open(path, KEY_SET_VALUE)? else {
                return Ok(());
            };
            let name = wide(name);
            let status = unsafe { RegDeleteValueW(key.0, PCWSTR(name.as_ptr())) };
            if status != ERROR_SUCCESS && !missing(status) {
                return Err(reg_error(status));
            }
            Ok(())
        }

        fn prune(&self, path: &str) -> Result<(), String> {
            let Some(key) = self.open(path, KEY_READ)? else {
                return Ok(());
            };
            let (mut subkeys, mut values) = (0, 0);
            let status = unsafe {
                RegQueryInfoKeyW(
                    key.0,
                    None,
                    None,
                    None,
                    Some(&mut subkeys),
                    None,
                    None,
                    Some(&mut values),
                    None,
                    None,
                    None,
                    None,
                )
            };
            if status != ERROR_SUCCESS {
                return Err(reg_error(status));
            }
            if subkeys != 0 || values != 0 {
                return Ok(());
            }
            drop(key);
            let path = wide(path);
            let status = unsafe { RegDeleteKeyW(self.0, PCWSTR(path.as_ptr())) };
            if status != ERROR_SUCCESS && !missing(status) {
                return Err(reg_error(status));
            }
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{cell::RefCell, collections::BTreeMap};

        #[derive(Default)]
        struct MemoryRegistry {
            data: RefCell<BTreeMap<String, BTreeMap<String, Value>>>,
            fail_at: RefCell<Option<(String, String)>>,
        }

        impl Registry for MemoryRegistry {
            fn value(&self, path: &str, name: &str) -> Result<Option<Value>, String> {
                Ok(self
                    .data
                    .borrow()
                    .get(path)
                    .and_then(|key| key.get(name))
                    .cloned())
            }

            fn exists(&self, path: &str) -> Result<bool, String> {
                let data = self.data.borrow();
                let prefix = format!(r"{path}\");
                Ok(data.contains_key(path) || data.keys().any(|key| key.starts_with(&prefix)))
            }

            fn set(&self, path: &str, name: &str, value: &Value) -> Result<(), String> {
                if self
                    .fail_at
                    .borrow()
                    .as_ref()
                    .is_some_and(|pair| pair.0 == path && pair.1 == name)
                {
                    self.fail_at.borrow_mut().take();
                    return Err("failed registry write".into());
                }
                self.data
                    .borrow_mut()
                    .entry(path.into())
                    .or_default()
                    .insert(name.into(), value.clone());
                Ok(())
            }

            fn delete(&self, path: &str, name: &str) -> Result<(), String> {
                if let Some(key) = self.data.borrow_mut().get_mut(path) {
                    key.remove(name);
                }
                Ok(())
            }

            fn prune(&self, path: &str) -> Result<(), String> {
                let mut data = self.data.borrow_mut();
                if data.get(path).is_some_and(|key| key.is_empty())
                    && !data.keys().any(|key| key.starts_with(&format!(r"{path}\")))
                {
                    data.remove(path);
                }
                Ok(())
            }
        }

        fn example_command() -> Value {
            command_for(Path::new(r"C:\Nexus Assets\nexus-assets.exe")).unwrap()
        }

        #[test]
        fn restores_exact_previous_default_without_touching_other_verbs() {
            let registry = MemoryRegistry::default();
            let mut original = Value::text("360FileBrowser");
            original.kind = REG_EXPAND_SZ.0;
            let other_verb = r"Software\Classes\Folder\shell\360FileBrowser\command";
            let other_command = Value::text("external command");
            registry.set(SHELL_KEY, "", &original).unwrap();
            registry.set(other_verb, "", &other_command).unwrap();
            enable_registry(&registry, example_command()).unwrap();
            assert!(our_default(registry.value(SHELL_KEY, "").unwrap().as_ref()));
            for (name, expected) in VERB_ATTRIBUTES {
                assert_eq!(
                    registry.value(VERB_KEY, name).unwrap(),
                    Some(Value::dword(expected))
                );
            }
            let saved = journal(&registry).unwrap().unwrap();
            assert!(!restore_registry(&registry, &saved).unwrap());
            assert_eq!(registry.value(SHELL_KEY, "").unwrap(), Some(original));
            assert_eq!(registry.value(other_verb, "").unwrap(), Some(other_command));
            assert!(!registry.exists(VERB_KEY).unwrap());
            assert!(journal(&registry).unwrap().is_none());
        }

        #[test]
        fn retains_more_recent_external_choice() {
            let registry = MemoryRegistry::default();
            enable_registry(&registry, example_command()).unwrap();
            registry
                .set(SHELL_KEY, "", &Value::text("LaterDefault"))
                .unwrap();
            let saved = journal(&registry).unwrap().unwrap();
            assert!(restore_registry(&registry, &saved).unwrap());
            assert_eq!(
                registry.value(SHELL_KEY, "").unwrap(),
                Some(Value::text("LaterDefault"))
            );
            assert!(!registry.exists(VERB_KEY).unwrap());
        }

        #[test]
        fn retyped_default_still_points_to_our_verb() {
            let registry = MemoryRegistry::default();
            enable_registry(&registry, example_command()).unwrap();
            let mut retyped = Value::text(VERB);
            retyped.kind = REG_EXPAND_SZ.0;
            registry.set(SHELL_KEY, "", &retyped).unwrap();
            let saved = journal(&registry).unwrap().unwrap();
            assert!(!restore_registry(&registry, &saved).unwrap());
            assert_eq!(registry.value(SHELL_KEY, "").unwrap(), None);
            assert!(!registry.exists(VERB_KEY).unwrap());
        }

        #[test]
        fn rolls_back_when_the_scope_or_default_write_fails() {
            for (key, name) in [(VERB_KEY, "AttributeValue"), (SHELL_KEY, "")] {
                let registry = MemoryRegistry::default();
                let original = Value::text("Previous");
                registry.set(SHELL_KEY, "", &original).unwrap();
                *registry.fail_at.borrow_mut() = Some((key.into(), name.into()));
                assert!(enable_registry(&registry, example_command()).is_err());
                assert_eq!(registry.value(SHELL_KEY, "").unwrap(), Some(original));
                assert!(!registry.exists(VERB_KEY).unwrap());
                assert!(journal(&registry).unwrap().is_none());
            }
        }

        #[test]
        fn avoids_overwriting_foreign_command_or_preexisting_verb() {
            let registry = MemoryRegistry::default();
            registry
                .set(COMMAND_KEY, "", &Value::text("external"))
                .unwrap();
            assert!(enable_registry(&registry, example_command()).is_err());
            assert!(journal(&registry).unwrap().is_none());
            assert_eq!(
                registry.value(COMMAND_KEY, "").unwrap(),
                Some(Value::text("external"))
            );

            let registry = MemoryRegistry::default();
            enable_registry(&registry, example_command()).unwrap();
            registry
                .set(COMMAND_KEY, "", &Value::text("edited"))
                .unwrap();
            let saved = journal(&registry).unwrap().unwrap();
            assert!(restore_registry(&registry, &saved).is_err());
            assert_eq!(
                registry.value(COMMAND_KEY, "").unwrap(),
                Some(Value::text("edited"))
            );
            assert!(journal(&registry).unwrap().is_some());
        }

        #[test]
        fn leaves_a_reconfigured_scoped_verb_untouched() {
            let registry = MemoryRegistry::default();
            enable_registry(&registry, example_command()).unwrap();
            registry
                .set(VERB_KEY, "AttributeValue", &Value::dword(0x4000_0000))
                .unwrap();
            let saved = journal(&registry).unwrap().unwrap();
            assert!(restore_registry(&registry, &saved).is_err());
            assert!(our_default(registry.value(SHELL_KEY, "").unwrap().as_ref()));
            assert!(journal(&registry).unwrap().is_some());
        }

        #[test]
        fn command_uses_quoted_explicit_handoff_with_root_suffix() {
            assert_eq!(
                example_command().as_text().unwrap(),
                r#""C:\Nexus Assets\nexus-assets.exe" --open-folder "%1\.""#
            );
            assert!(command_for(Path::new(r"C:\Nexus %test%\nexus-assets.exe")).is_none());
            assert!(command_for(Path::new("nexus-assets.exe")).is_none());
        }

        #[test]
        fn verified_alias_registers_the_installed_path() {
            let scratch = tempfile::tempdir().unwrap();
            let installed = scratch.path().join("nexus-assets.exe");
            let hard_link = scratch.path().join("alias.exe");
            let portable = scratch.path().join("portable.exe");
            std::fs::write(&installed, b"installed").unwrap();
            std::fs::write(&portable, b"portable").unwrap();
            let location = format!(r#""{}""#, scratch.path().display());
            assert_eq!(
                command_at_installation(&installed, &location),
                canonical_command(&installed),
            );
            assert!(command_at_installation(&portable, &location).is_none());
            // Some alternate temporary volumes don't support hard links.
            if std::fs::hard_link(&installed, &hard_link).is_ok() {
                assert_eq!(
                    command_at_installation(&hard_link, &location),
                    canonical_command(&installed),
                );
            }
        }
    }
}
