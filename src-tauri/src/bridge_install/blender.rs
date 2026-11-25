use super::{InstallEnvironment, InstallFile, InstallTarget};
use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

const STARTUP_FILE: &str = "startup/nexus_assets_bridge.py";
const BOOTSTRAP: &str = include_str!("../../../bridges/install/blender_startup.py");
const PLACEMENT: &str = include_str!("../../../bridges/install/blender_placement.py");

/// Find the highest supported version actually bundled alongside this Blender executable.
fn bundled_version(resources: &Path, minimum: (u16, u16)) -> Option<(u16, u16)> {
    fs::read_dir(resources)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let (major, minor) = name.to_str()?.split_once('.')?;
            let version = (major.parse::<u16>().ok()?, minor.parse::<u16>().ok()?);
            if version < minimum || !entry.path().join("scripts/startup").is_dir() {
                return None;
            }
            Some(version)
        })
        .max()
}

fn absolute_override(variable: &str) -> Option<PathBuf> {
    env::var_os(variable)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn script_path(
    user_root: &Path,
    resources: &Path,
    version: &str,
    scripts_override: Option<&Path>,
    resources_override: Option<&Path>,
) -> PathBuf {
    if let Some(path) = scripts_override {
        return path.to_path_buf();
    }
    if let Some(path) = resources_override {
        return path.join("scripts");
    }
    let portable = resources.join("portable");
    if portable.is_dir() {
        return portable.join("scripts");
    }
    user_root.join(version).join("scripts")
}

fn subdirectories(path: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
}

fn windows_locations(env: &InstallEnvironment) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = env
        .configured_executable("blender")
        .and_then(Path::parent)
        .map(Path::to_owned)
        .into_iter()
        .collect();
    #[cfg(windows)]
    roots.extend(super::windows::directories("blender", "blender.exe"));
    for parent in env
        .program_files
        .iter()
        .chain(std::iter::once(&env.local.join("Programs")))
    {
        let foundation = parent.join("Blender Foundation");
        roots.extend(subdirectories(&foundation));
        roots.push(foundation);
        roots.push(parent.join("Blender"));
        roots.push(parent.join("Steam/steamapps/common/Blender"));
    }
    roots
        .into_iter()
        .filter(|root| root.join("blender.exe").is_file())
        .collect()
}

#[cfg(windows)]
pub(super) fn detected_converter() -> Option<PathBuf> {
    super::windows::directories("blender", "blender.exe")
        .into_iter()
        .filter_map(|directory| {
            let version = bundled_version(&directory, (4, 2))?;
            Some((version, directory.join("blender.exe")))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

fn macos_locations(env: &InstallEnvironment) -> Vec<PathBuf> {
    let applications = env.home.join("Applications");
    let mut bundles = vec![
        PathBuf::from("/Applications/Blender.app"),
        applications.join("Blender.app"),
    ];
    for directory in [Path::new("/Applications"), applications.as_path()] {
        bundles.extend(subdirectories(directory).filter(|bundle| {
            bundle
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.to_ascii_lowercase().starts_with("blender") && name.ends_with(".app")
                })
        }));
    }
    bundles
        .into_iter()
        .filter(|bundle| bundle.join("Contents/MacOS/Blender").is_file())
        .map(|bundle| bundle.join("Contents/Resources"))
        .collect()
}

pub(super) fn targets(env: &InstallEnvironment) -> Vec<InstallTarget> {
    let (locations, user_root) = if cfg!(windows) {
        (
            windows_locations(env),
            env.roaming.join("Blender Foundation/Blender"),
        )
    } else if cfg!(target_os = "macos") {
        (
            macos_locations(env),
            env.home.join("Library/Application Support/Blender"),
        )
    } else {
        return Vec::new();
    };
    let scripts_override = absolute_override("BLENDER_USER_SCRIPTS");
    let resources_override = absolute_override("BLENDER_USER_RESOURCES");
    let mut destinations = HashSet::new();
    locations
        .iter()
        .filter_map(|resources| {
            let (major, minor) = bundled_version(resources, (4, 5))?;
            let version = format!("{major}.{minor}");
            let scripts = script_path(
                &user_root,
                resources,
                &version,
                scripts_override.as_deref(),
                resources_override.as_deref(),
            );
            destinations.insert(scripts.clone()).then(|| {
                InstallTarget::new(
                    "blender",
                    version,
                    scripts,
                    vec![
                        InstallFile::managed(STARTUP_FILE, env.bootstrap(BOOTSTRAP)),
                        InstallFile::managed(
                            "modules/nexus_assets_placement.py",
                            PLACEMENT.as_bytes(),
                        ),
                    ],
                    "重启 Blender 后自动连接，支持三维视口交互放置。",
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_bundles_without_trusting_the_folder_name_alone() {
        let root = tempfile::tempdir().unwrap();
        for folder in ["4.4/scripts/startup", "4.5/scripts/startup", "5.0/scripts"] {
            fs::create_dir_all(root.path().join(folder)).unwrap();
        }
        assert_eq!(bundled_version(root.path(), (4, 5)), Some((4, 5)));
        assert_eq!(bundled_version(root.path(), (5, 0)), None);
    }

    #[test]
    fn picks_versioned_startup_directory_and_respects_blender_overrides() {
        let root = tempfile::tempdir().unwrap();
        let user_root = root.path().join("personal");
        let resources = root.path().join("installed");
        let portable = resources.join("portable");
        let user_scripts = root.path().join("custom-scripts");
        assert_eq!(
            script_path(&user_root, &resources, "5.0", None, None),
            user_root.join("5.0/scripts")
        );
        fs::create_dir_all(&portable).unwrap();
        assert_eq!(
            script_path(&user_root, &resources, "5.0", None, None),
            portable.join("scripts")
        );
        assert_eq!(
            script_path(&user_root, &resources, "5.0", None, Some(&user_root)),
            user_root.join("scripts")
        );
        assert_eq!(
            script_path(
                &user_root,
                &resources,
                "5.0",
                Some(&user_scripts),
                Some(&user_root)
            ),
            user_scripts
        );
    }
}
