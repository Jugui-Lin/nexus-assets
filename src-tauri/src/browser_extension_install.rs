use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};
use tauri::Manager;

const MANIFEST_READ_LIMIT: u64 = 64 * 1024;
const PROFILE_READ_LIMIT: u64 = 16 * 1024 * 1024;
const MAX_PROFILE_ENTRIES: usize = 256;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Browser {
    Chrome,
    Edge,
}

impl Browser {
    fn name(self) -> &'static str {
        match self {
            Self::Chrome => "Google Chrome",
            Self::Edge => "Microsoft Edge",
        }
    }

    #[cfg(windows)]
    fn install_paths(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Chrome => ("Google/Chrome", "chrome.exe", "chrome://extensions/"),
            Self::Edge => ("Microsoft/Edge", "msedge.exe", "edge://extensions/"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Detection {
    supported: bool,
    extension_path: Option<String>,
    extension_version: Option<String>,
    browsers: Vec<BrowserStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStatus {
    id: Browser,
    name: &'static str,
    available: bool,
    #[serde(flatten)]
    profiles: ProfileStatus,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileStatus {
    installed_profiles: usize,
    disabled_profiles: usize,
    update_profiles: usize,
    profile_read_incomplete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallPage {
    extension_path: String,
}

#[derive(Deserialize)]
struct ExtensionManifest {
    manifest_version: u8,
    name: String,
    version: String,
    background: ManifestBackground,
    action: ManifestAction,
}

#[derive(Deserialize)]
struct ManifestBackground {
    service_worker: String,
}

#[derive(Deserialize)]
struct ManifestAction {
    default_popup: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Preferences {
    extensions: ExtensionSettings,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ExtensionSettings {
    settings: BTreeMap<String, ExtensionRecord>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ExtensionRecord {
    path: Option<PathBuf>,
    location: Option<u8>,
    state: Option<i32>,
    disable_reasons: serde_json::Value,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, limit: u64) -> io::Result<T> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || redirected(&metadata) || metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid JSON file",
        ));
    }
    serde_json::from_reader(io::BufReader::new(fs::File::open(path)?.take(limit)))
        .map_err(io::Error::other)
}

fn redirected(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn numeric_version(value: &str) -> Option<[u32; 4]> {
    let mut version = [0; 4];
    for (index, part) in value.split('.').enumerate() {
        *version.get_mut(index)? = part.parse().ok()?;
    }
    Some(version)
}

fn capture_manifest(directory: &Path) -> Option<ExtensionManifest> {
    let manifest: ExtensionManifest =
        read_json(&directory.join("manifest.json"), MANIFEST_READ_LIMIT).ok()?;
    (manifest.manifest_version == 3
        && manifest.name == "Nexus 网页采集"
        && manifest.background.service_worker == "background.js"
        && manifest.action.default_popup == "popup.html"
        && numeric_version(&manifest.version).is_some())
    .then_some(manifest)
}

fn bundled_extension(app: &tauri::AppHandle) -> Option<(PathBuf, ExtensionManifest)> {
    let directory = app.path().resource_dir().ok()?.join("browser-extension");
    capture_manifest(&directory).map(|manifest| (directory, manifest))
}

fn local_absolute(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        return matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)));
    }
    #[cfg(not(windows))]
    true
}

impl ExtensionRecord {
    fn capture_version(&self) -> Option<[u32; 4]> {
        // Chromium stores unpacked and command-line extensions with an absolute path.
        if !matches!(self.location, Some(4 | 8)) {
            return None;
        }
        let directory = self.path.as_deref().filter(|path| local_absolute(path))?;
        let metadata = fs::symlink_metadata(directory).ok()?;
        if !metadata.is_dir() || redirected(&metadata) {
            return None;
        }
        numeric_version(&capture_manifest(directory)?.version)
    }

    fn disabled(&self) -> bool {
        self.state.is_some_and(|value| value != 1)
            || self
                .disable_reasons
                .as_i64()
                .is_some_and(|value| value != 0)
            || self.disable_reasons.as_array().is_some_and(|reasons| {
                reasons
                    .iter()
                    .any(|value| value.as_i64().is_some_and(|reason| reason != 0))
            })
    }
}

fn profile_directory(name: &str) -> bool {
    name == "Default"
        || name.strip_prefix("Profile ").is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn scan_profiles(root: &Path, bundle: Option<[u32; 4]>) -> ProfileStatus {
    let mut result = ProfileStatus::default();
    let profiles = match fs::read_dir(root) {
        Ok(profiles) => profiles,
        Err(error) => {
            result.profile_read_incomplete = error.kind() != io::ErrorKind::NotFound;
            return result;
        }
    };
    for (index, profile) in profiles.enumerate() {
        if index == MAX_PROFILE_ENTRIES {
            result.profile_read_incomplete = true;
            break;
        }
        let Ok(profile) = profile else {
            result.profile_read_incomplete = true;
            continue;
        };
        if !profile_directory(&profile.file_name().to_string_lossy()) {
            continue;
        }
        let profile = profile.path();
        if !fs::symlink_metadata(&profile).is_ok_and(|meta| meta.is_dir() && !redirected(&meta)) {
            result.profile_read_incomplete = true;
            continue;
        }
        let mut extensions = BTreeMap::new();
        for filename in ["Preferences", "Secure Preferences"] {
            match read_json::<Preferences>(&profile.join(filename), PROFILE_READ_LIMIT) {
                Ok(preferences) => extensions.extend(preferences.extensions.settings),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => result.profile_read_incomplete = true,
            }
        }
        let matching: Vec<_> = extensions
            .values()
            .filter_map(|entry| entry.capture_version().map(|version| (entry, version)))
            .collect();
        if !matching.is_empty() {
            result.installed_profiles += 1;
            if matching.iter().all(|(entry, _)| entry.disabled()) {
                result.disabled_profiles += 1;
            }
            if bundle.is_some_and(|bundle| matching.iter().all(|(_, version)| *version < bundle)) {
                result.update_profiles += 1;
            }
        }
    }
    result
}

#[cfg(windows)]
mod windows_install {
    use super::*;
    use std::{env, ffi::OsString, os::windows::ffi::OsStringExt, process::Command};
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::ERROR_SUCCESS,
            System::Registry::{
                RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ,
                RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY,
            },
        },
    };

    fn registered_executable(browser: Browser) -> Option<PathBuf> {
        let key = match browser {
            Browser::Chrome => {
                w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe")
            }
            Browser::Edge => {
                w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe")
            }
        };
        let (_, expected, _) = browser.install_paths();
        let mut buffer = vec![0u16; 32 * 1024];
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY] {
                let mut bytes = (buffer.len() * 2) as u32;
                // The registry writes at most `bytes` bytes to the local UTF-16 buffer.
                let status = unsafe {
                    RegGetValueW(
                        hive,
                        key,
                        PCWSTR::null(),
                        view | RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                        None,
                        Some(buffer.as_mut_ptr().cast()),
                        Some(&mut bytes),
                    )
                };
                if status == ERROR_SUCCESS {
                    let end = buffer.iter().position(|&unit| unit == 0).unwrap_or(0);
                    let value = OsString::from_wide(&buffer[..end]);
                    let candidate = PathBuf::from(value.to_string_lossy().trim().trim_matches('"'));
                    if local_absolute(&candidate)
                        && candidate
                            .file_name()
                            .is_some_and(|name| name.eq_ignore_ascii_case(expected))
                        && candidate.is_file()
                    {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }

    fn executable(browser: Browser) -> Option<PathBuf> {
        let (product, name, _) = browser.install_paths();
        [
            "ProgramW6432",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "LOCALAPPDATA",
        ]
        .into_iter()
        .filter_map(env::var_os)
        .map(|directory| {
            PathBuf::from(directory)
                .join(product)
                .join("Application")
                .join(name)
        })
        .find(|path| local_absolute(path) && path.is_file())
        .or_else(|| registered_executable(browser))
    }

    pub(super) fn detect(browser: Browser, bundle: Option<[u32; 4]>) -> BrowserStatus {
        let available = executable(browser).is_some();
        let (product, _, _) = browser.install_paths();
        let profiles = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|path| local_absolute(path))
            .map(|directory| scan_profiles(&directory.join(product).join("User Data"), bundle))
            .unwrap_or_default();
        BrowserStatus {
            id: browser,
            name: browser.name(),
            available,
            profiles,
        }
    }

    pub(super) fn open(browser: Browser) -> Result<(), String> {
        let path = executable(browser).ok_or_else(|| format!("未检测到 {}", browser.name()))?;
        let (_, _, page) = browser.install_paths();
        Command::new(path)
            .arg(page)
            .spawn()
            .map_err(|_| format!("无法打开 {} 的扩展管理页", browser.name()))?;
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn browser_extension_detect(app: tauri::AppHandle) -> Result<Detection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = bundled_extension(&app);
        #[cfg(windows)]
        let browsers = {
            let version = bundle
                .as_ref()
                .and_then(|(_, manifest)| numeric_version(&manifest.version));
            [Browser::Chrome, Browser::Edge]
                .into_iter()
                .map(|browser| windows_install::detect(browser, version))
                .collect()
        };
        #[cfg(not(windows))]
        let browsers = [Browser::Chrome, Browser::Edge]
            .into_iter()
            .map(|browser| BrowserStatus {
                id: browser,
                name: browser.name(),
                available: false,
                profiles: ProfileStatus::default(),
            })
            .collect();
        Ok(Detection {
            supported: cfg!(windows),
            extension_path: bundle
                .as_ref()
                .map(|(path, _)| nexus_core::clean_path(path)),
            extension_version: bundle.map(|(_, manifest)| manifest.version),
            browsers,
        })
    })
    .await
    .map_err(|_| "暂时无法检测浏览器扩展".to_owned())?
}

#[tauri::command]
pub(crate) async fn browser_extension_open_install(
    app: tauri::AppHandle,
    browser: Browser,
) -> Result<InstallPage, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let (directory, _) =
                bundled_extension(&app).ok_or("安装包中的网页采集扩展文件不可用")?;
            windows_install::open(browser)?;
            Ok(InstallPage {
                extension_path: nexus_core::clean_path(&directory),
            })
        })
        .await
        .map_err(|_| "无法打开浏览器扩展管理页".to_owned())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, browser);
        Err("当前平台请在浏览器扩展管理页手动加载 Nexus 扩展".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn write_json(path: &Path, value: Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    fn fixture_extension(directory: &Path, name: &str, version: &str) {
        write_json(
            &directory.join("manifest.json"),
            json!({
                "manifest_version":3, "name":name, "version":version,
                "background":{"service_worker":"background.js"},
                "action":{"default_popup":"popup.html"}
            }),
        );
    }

    #[test]
    fn detects_unpacked_extension_only_in_actual_browser_profiles() {
        let temp = tempfile::tempdir().unwrap();
        let profiles = temp.path().join("User Data");
        let old = temp.path().join("旧版 Nexus");
        let current = temp.path().join("新版 Nexus");
        let unrelated = temp.path().join("Unrelated");
        fixture_extension(&old, "Nexus 网页采集", "1.1.0");
        fixture_extension(&current, "Nexus 网页采集", "1.10.0");
        fixture_extension(&unrelated, "Other extension", "1.1.0");

        write_json(
            &profiles.join("Default/Preferences"),
            json!({"extensions":{"settings":{
                "nexus":{"location":4,"path":old}
            }}}),
        );
        write_json(
            &profiles.join("Default/Secure Preferences"),
            json!({"extensions":{"settings":{
                "nexus":{"location":4,"path":old,"disable_reasons":[1]}
            }}}),
        );
        write_json(
            &profiles.join("Profile 3/Secure Preferences"),
            json!({"extensions":{"settings":{
                "nexus":{"location":8,"path":current,"state":1,"disable_reasons":[]},
                "different":{"location":4,"path":unrelated,"disable_reasons":1},
                "stale":{"location":5,"path":old}
            }}}),
        );
        write_json(
            &profiles.join("System Profile/Secure Preferences"),
            json!({"extensions":{"settings":{
                "nexus":{"location":4,"path":old}
            }}}),
        );
        let invalid = profiles.join("Profile 4/Secure Preferences");
        fs::create_dir_all(invalid.parent().unwrap()).unwrap();
        fs::write(invalid, b"not json").unwrap();

        let result = scan_profiles(&profiles, numeric_version("1.10"));
        assert_eq!(result.installed_profiles, 2);
        assert_eq!(result.disabled_profiles, 1);
        assert_eq!(result.update_profiles, 1);
        assert!(result.profile_read_incomplete);
        let encoded = serde_json::to_value(result).unwrap();
        assert_eq!(encoded.as_object().unwrap().len(), 4);
        assert!(!encoded.to_string().contains("Profile 3"));
    }
}
