use super::{InstallEnvironment, InstallFile, InstallTarget};
use std::{
    fs,
    path::{Path, PathBuf},
};

const PLUGIN: &str = include_str!("../../../bridges/install/c4d.pyp");
const PLACEMENT: &[u8] = include_bytes!("../../../bridges/install/c4d_placement.py");
const SMART_IMPORT: &[u8] = include_bytes!("../../../bridges/install/c4d_smart_import.py");
const ASSET_PREP: &[u8] = include_bytes!("../../../bridges/install/c4d_asset_prep.py");
const MATERIALS: &[u8] = include_bytes!("../../../bridges/install/c4d_materials.py");
const CONVERSION: &[u8] = include_bytes!("../../../bridges/install/c4d_conversion.py");
const PROJECT_EXPORT: &[u8] = include_bytes!("../../../bridges/install/c4d_project_export.py");
const TEXTURE_ARCHIVE: &[u8] = include_bytes!("../../../bridges/install/c4d_texture_archive.py");
const IMPORT_CACHE: &[u8] = include_bytes!("../../../bridges/install/c4d_cache.py");
const MAX_DECODE: &[u8] = include_bytes!("../../../bridges/install/c4d_max_decode.py");
const MAX_ADDON: &[u8] = include_bytes!("../../../bridges/install/nexus_io_scene_max_1_9_2.zip");
const MAX_ADDON_LICENSE: &[u8] =
    include_bytes!("../../../bridges/install/nexus_io_scene_max_1_9_2_LICENSE.txt");
const SYMBOLS: &[u8] = include_bytes!("../../../bridges/install/c4d-symbols.h");

fn profile_version(name: &str) -> Option<String> {
    let name = name.to_ascii_lowercase();
    let name = name.strip_prefix("maxon ").unwrap_or(&name);
    let suffix = name.strip_prefix("cinema 4d ")?;
    let (version, hash) = suffix.split_once('_')?;
    if hash.len() != 8 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let year = version.split('.').next()?.parse::<u16>().ok()?;
    (year >= 2025 && version.split('.').all(|part| part.parse::<u16>().is_ok()))
        .then(|| version.to_owned())
}

fn looks_like_profile(root: &Path) -> bool {
    root.join("prefs").is_dir() || root.join("plugins").is_dir()
}

fn profiles_from(directory: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let version = profile_version(entry.file_name().to_str()?)?;
            looks_like_profile(&path).then_some((version, path))
        })
        .collect()
}

#[cfg(windows)]
fn release_year(version: &str) -> Option<u16> {
    let year = version.split('.').next()?.parse::<u16>().ok()?;
    ((2025..2100).contains(&year) && version.split('.').all(|part| part.parse::<u16>().is_ok()))
        .then_some(year)
}

#[cfg(windows)]
fn executable_version(path: &Path) -> Option<(u16, String)> {
    if let Some((year, minor, patch, _)) = super::windows::file_version(path) {
        return (2025..2100)
            .contains(&year)
            .then(|| (year, format!("{year}.{minor}.{patch}")));
    }
    let folder = path.parent()?.file_name()?.to_str()?.to_ascii_lowercase();
    let name = folder.strip_prefix("maxon ").unwrap_or(&folder);
    let version = name.strip_prefix("cinema 4d ")?;
    Some((release_year(version)?, version.to_owned()))
}

#[cfg(windows)]
fn windows_executables(env: &InstallEnvironment) -> Vec<(u16, String, PathBuf)> {
    const EXE: &str = "Cinema 4D.exe";
    let configured = env.configured_executable("c4d").map(Path::to_path_buf);
    let mut seen = std::collections::HashSet::new();
    configured
        .into_iter()
        .chain(
            super::windows::directories("c4d", EXE)
                .into_iter()
                .map(|directory| directory.join(EXE)),
        )
        .filter(|path| {
            path.is_absolute()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(EXE))
                && path.is_file()
                && seen.insert(fs::canonicalize(path).unwrap_or_else(|_| path.clone()))
        })
        .filter_map(|path| {
            let (year, version) = executable_version(&path)?;
            Some((year, version, path))
        })
        .collect()
}

pub(super) fn discover(env: &InstallEnvironment) -> (Vec<InstallTarget>, Vec<(String, PathBuf)>) {
    let profiles = if cfg!(target_os = "windows") {
        profiles_from(&env.roaming.join("Maxon"))
    } else if cfg!(target_os = "macos") {
        let preferences = env.home.join("Library/Preferences");
        [preferences.join("MAXON"), preferences.join("Maxon")]
            .iter()
            .flat_map(|directory| profiles_from(directory))
            .collect()
    } else {
        Vec::new()
    };

    #[cfg(windows)]
    let (profiles, missing_profiles) = {
        let mut profiles = profiles;
        let installations = windows_executables(env);
        profiles.retain(|(version, _)| {
            installations
                .iter()
                .any(|(year, _, _)| Some(*year) == release_year(version))
        });
        let mut custom_profile = false;
        if let Some(preferences) = std::env::var_os("g_prefspath").map(PathBuf::from) {
            if preferences.is_absolute() && looks_like_profile(&preferences) {
                let version = preferences
                    .file_name()
                    .and_then(|name| profile_version(name.to_str()?))
                    .unwrap_or_else(|| "自定义首选项".into());
                profiles.push((version, preferences));
                custom_profile = true;
            }
        }
        let missing_profiles = installations
            .into_iter()
            .filter(|(year, _, _)| {
                !custom_profile
                    && !profiles
                        .iter()
                        .any(|(version, _)| release_year(version) == Some(*year))
            })
            .map(|(_, version, path)| (version, path))
            .collect();
        (profiles, missing_profiles)
    };
    #[cfg(not(windows))]
    let missing_profiles = Vec::new();

    let mut seen = std::collections::HashSet::new();
    let plugin = Path::new("plugins").join("NexusAssetsBridge");
    let targets = profiles
        .into_iter()
        .filter(|(_, path)| seen.insert(fs::canonicalize(path).unwrap_or_else(|_| path.clone())))
        .map(|(version, profile)| {
            InstallTarget::new(
                "c4d",
                version,
                profile,
                vec![
                    InstallFile::managed(
                        plugin.join("res").join("c4d_symbols.h"),
                        SYMBOLS.to_vec(),
                    ),
                    InstallFile::managed(plugin.join("nexus_c4d_placement.py"), PLACEMENT.to_vec()),
                    InstallFile::managed(
                        plugin.join("nexus_c4d_smart_import.py"),
                        SMART_IMPORT.to_vec(),
                    ),
                    InstallFile::managed(
                        plugin.join("nexus_c4d_asset_prep.py"),
                        ASSET_PREP.to_vec(),
                    ),
                    InstallFile::managed(plugin.join("nexus_c4d_materials.py"), MATERIALS.to_vec()),
                    InstallFile::managed(
                        plugin.join("nexus_c4d_conversion.py"),
                        CONVERSION.to_vec(),
                    ),
                    InstallFile::managed(
                        plugin.join("nexus_c4d_project_export.py"),
                        PROJECT_EXPORT.to_vec(),
                    ),
                    InstallFile::managed(
                        plugin.join("nexus_c4d_texture_archive.py"),
                        TEXTURE_ARCHIVE.to_vec(),
                    ),
                    InstallFile::managed(plugin.join("nexus_c4d_cache.py"), IMPORT_CACHE.to_vec()),
                    InstallFile::managed(
                        plugin.join("nexus_c4d_max_decode.py"),
                        MAX_DECODE.to_vec(),
                    ),
                    InstallFile::managed(
                        plugin.join("nexus_io_scene_max_1_9_2.zip"),
                        MAX_ADDON.to_vec(),
                    ),
                    InstallFile::managed(
                        plugin.join("nexus_io_scene_max_1_9_2_LICENSE.txt"),
                        MAX_ADDON_LICENSE.to_vec(),
                    ),
                    InstallFile::managed(
                        plugin.join("NexusAssetsBridge.pyp"),
                        env.bootstrap(PLUGIN),
                    ),
                ],
                "重新打开 Cinema 4D 后，桥接将随宿主启动。",
            )
        })
        .collect();
    (targets, missing_profiles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_only_supported_cinema_gui_profiles() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "Maxon Cinema 4D 2025_789E552B",
            "Cinema 4D 2026.1_12345678",
            "Maxon Cinema 4D 2025_789E552B_p",
            "Maxon Cinema 4D 2024_88888888",
            "Maxon Cinema 4D Team Render Client 2025_789E552B",
            "Maxon Cinema 4D 2025_SCRATCH0",
        ] {
            fs::create_dir_all(temp.path().join(name).join("prefs")).unwrap();
        }
        fs::create_dir_all(temp.path().join("Maxon Cinema 4D 2026_99999999")).unwrap();
        let mut versions: Vec<_> = profiles_from(temp.path())
            .into_iter()
            .map(|(version, _)| version)
            .collect();
        versions.sort();
        assert_eq!(versions, ["2025", "2026.1"]);
    }
}
