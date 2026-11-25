use super::{InstallEnvironment, InstallFile, InstallTarget};
use std::{
    collections::BTreeSet,
    env, fs,
    path::{Path, PathBuf},
};

const MAYA_SCRIPT: &str = include_str!("../../../bridges/install/maya_startup.py");
const MAX_PACKAGE: &str = include_str!("../../../bridges/install/max_package.xml");
const MAX_SCRIPT: &str = include_str!("../../../bridges/install/max_startup.ms");
const MAX_PYTHON: &str = include_str!("../../../bridges/install/max_startup.py");
const HOUDINI_SCRIPT: &str = include_str!("../../../bridges/install/houdini_uiready.py");
const HOUDINI_PACKAGE: &[u8] =
    b"{\n  \"hpath\": \"$HOUDINI_USER_PREF_DIR/nexus-assets-bridge\"\n}\n";

pub(super) fn targets(environment: &InstallEnvironment) -> Vec<InstallTarget> {
    let mut result = maya_targets(environment);
    if let Some(max) = max_target(environment) {
        result.push(max);
    }
    result.extend(houdini_targets(environment));
    result
}

fn children(directory: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
}

fn file_name(path: &Path) -> &str {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
}

fn absolute_env(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .map(PathBuf::from)
        .filter(|value| value.is_absolute())
}

fn release_year(name: &str, prefix: &str) -> Option<u16> {
    let lower_name = name.to_ascii_lowercase();
    let year = lower_name.strip_prefix(prefix)?.trim();
    if year.len() != 4 {
        return None;
    }
    year.parse()
        .ok()
        .filter(|value| (2022..2100).contains(value))
}

#[cfg(windows)]
fn windows_executables(
    environment: &InstallEnvironment,
    dcc: &str,
    executable: &str,
) -> impl Iterator<Item = PathBuf> {
    let configured = environment
        .configured_executable(dcc)
        .filter(|path| file_name(path).eq_ignore_ascii_case(executable) && path.is_file())
        .map(Path::to_path_buf);
    let name = executable.to_owned();
    configured.into_iter().chain(
        super::windows::directories(dcc, executable)
            .into_iter()
            .map(move |directory| directory.join(&name)),
    )
}

#[cfg(windows)]
fn installer_directory(executable: &Path) -> Option<&Path> {
    let directory = executable.parent()?;
    if file_name(directory).eq_ignore_ascii_case("bin") {
        directory.parent()
    } else {
        Some(directory)
    }
}

fn maya_targets(environment: &InstallEnvironment) -> Vec<InstallTarget> {
    let mut search_roots: Vec<_> = environment
        .program_files
        .iter()
        .map(|path| path.join("Autodesk"))
        .collect();
    if cfg!(target_os = "macos") {
        search_roots.push(PathBuf::from("/Applications/Autodesk"));
    } else if cfg!(target_os = "linux") {
        search_roots.push(PathBuf::from("/usr/autodesk"));
    }
    let application_root = absolute_env("MAYA_APP_DIR").unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            environment.documents.join("maya")
        } else if cfg!(target_os = "macos") {
            let parent = environment.home.join("Library/Preferences/Autodesk");
            if parent.join("Maya").is_dir() {
                parent.join("Maya")
            } else {
                parent.join("maya")
            }
        } else {
            environment.home.join("maya")
        }
    });
    let installed: BTreeSet<_> = search_roots
        .into_iter()
        .flat_map(|root| children(&root))
        .chain(absolute_env("MAYA_LOCATION"))
        .filter_map(|root| {
            let version = release_year(file_name(&root), "maya")?;
            let executable = if cfg!(target_os = "windows") {
                root.join("bin/maya.exe")
            } else if cfg!(target_os = "macos") {
                root.join("Maya.app/Contents/MacOS/Maya")
            } else {
                root.join("bin/maya")
            };
            executable.is_file().then_some(version)
        })
        .collect();
    #[cfg(windows)]
    let installed: BTreeSet<_> = installed
        .into_iter()
        .chain(
            windows_executables(environment, "maya", "maya.exe").filter_map(|executable| {
                installer_directory(&executable)
                    .and_then(|directory| release_year(file_name(directory), "maya"))
                    .or_else(|| {
                        let (year, _, _, _) = super::windows::file_version(&executable)?;
                        (2022..2100).contains(&year).then_some(year)
                    })
            }),
        )
        .collect();
    installed
        .into_iter()
        .map(|version| {
            let version = version.to_string();
            let root = application_root.join(&version).join("scripts");
            InstallTarget::new(
                "maya",
                version,
                root,
                vec![InstallFile::startup_block(
                    "userSetup.py",
                    environment.bootstrap(MAYA_SCRIPT),
                )],
                "重启 Maya 后桥接将自动连接。Maya 的启动脚本权限由宿主设置控制。",
            )
        })
        .collect()
}

fn max_target(environment: &InstallEnvironment) -> Option<InstallTarget> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let releases: BTreeSet<_> = environment
        .program_files
        .iter()
        .flat_map(|root| children(&root.join("Autodesk")))
        .filter(|root| root.join("3dsmax.exe").is_file())
        .filter_map(|root| release_year(file_name(&root), "3ds max "))
        .collect();
    #[cfg(windows)]
    let releases: BTreeSet<_> = releases
        .into_iter()
        .chain(
            windows_executables(environment, "max", "3dsmax.exe").filter_map(|executable| {
                installer_directory(&executable)
                    .and_then(|directory| release_year(file_name(directory), "3ds max "))
                    .or_else(|| {
                        let (version, _, _, _) = super::windows::file_version(&executable)?;
                        // 3ds Max 2022 began the supported series at internal version 24.
                        let year = if (2022..2100).contains(&version) {
                            version
                        } else {
                            version.checked_add(1998)?
                        };
                        (2022..2100).contains(&year).then_some(year)
                    })
            }),
        )
        .collect();
    if releases.is_empty() {
        return None;
    }
    let label = releases
        .into_iter()
        .map(|version| version.to_string())
        .collect::<Vec<_>>()
        .join(" / ");
    let root = environment
        .roaming
        .join("Autodesk/ApplicationPlugins/NexusAssetsBridge.bundle");
    Some(InstallTarget::new(
        "max",
        label,
        root,
        vec![
            InstallFile::managed(
                "Contents/nexus_assets_start.py",
                environment.bootstrap(MAX_PYTHON),
            ),
            InstallFile::managed(
                "Contents/nexus_assets_start.ms",
                MAX_SCRIPT.as_bytes().to_vec(),
            ),
            InstallFile::managed(
                "PackageContents.xml",
                MAX_PACKAGE
                    .replace("__NEXUS_VERSION__", env!("CARGO_PKG_VERSION"))
                    .into_bytes(),
            ),
        ],
        "重启 3ds Max 后桥接将自动连接。使用 Autodesk 的当前用户插件目录。",
    ))
}

fn houdini_version(name: &str) -> Option<(u16, u16)> {
    let suffix = name.to_ascii_lowercase();
    let suffix = suffix
        .strip_prefix("houdini")
        .or_else(|| suffix.strip_prefix("hfs"))?
        .trim();
    let mut components = suffix.split('.');
    let major = components.next()?.parse().ok()?;
    let minor = components.next()?.parse().ok()?;
    if !(20..100).contains(&major)
        || minor > 99
        || components.any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    Some((major, minor))
}

fn houdini_profile(environment: &InstallEnvironment, version: &str) -> PathBuf {
    if let Some(custom) = env::var_os("HOUDINI_USER_PREF_DIR") {
        let custom = custom.to_string_lossy();
        if custom.contains("__HVER__") {
            let expanded = custom
                .replace("__HVER__", version)
                .replace("${HOME}", &environment.home.to_string_lossy())
                .replace("$HOME", &environment.home.to_string_lossy())
                .replace("%USERPROFILE%", &environment.home.to_string_lossy());
            let path = PathBuf::from(expanded);
            if path.is_absolute() {
                return path;
            }
        }
    }
    let folder = format!("houdini{version}");
    if cfg!(target_os = "windows") {
        environment.documents.join(folder)
    } else if cfg!(target_os = "macos") && !environment.home.join(&folder).is_dir() {
        environment
            .home
            .join("Library/Preferences/houdini")
            .join(version)
    } else {
        environment.home.join(folder)
    }
}

fn houdini_targets(environment: &InstallEnvironment) -> Vec<InstallTarget> {
    let mut search_roots: Vec<_> = environment
        .program_files
        .iter()
        .map(|path| path.join("Side Effects Software"))
        .collect();
    if cfg!(target_os = "macos") {
        search_roots.push(PathBuf::from("/Applications/Houdini"));
    } else if cfg!(target_os = "linux") {
        search_roots.push(PathBuf::from("/opt"));
    }
    let installed: BTreeSet<_> = search_roots
        .into_iter()
        .flat_map(|root| children(&root))
        .chain(absolute_env("HFS"))
        .filter_map(|root| {
            let release = houdini_version(file_name(&root))?;
            let found = if cfg!(target_os = "windows") {
                root.join("bin/houdini.exe").is_file()
            } else if cfg!(target_os = "macos") {
                children(&root).any(|path| {
                    path.extension().is_some_and(|ext| ext == "app")
                        && path.join("Contents/MacOS").is_dir()
                })
            } else {
                root.join("bin/houdini").is_file()
            };
            found.then_some(release)
        })
        .collect();
    #[cfg(windows)]
    let installed: BTreeSet<_> = installed
        .into_iter()
        .chain(
            windows_executables(environment, "houdini", "houdini.exe").filter_map(|executable| {
                installer_directory(&executable)
                    .and_then(|directory| houdini_version(file_name(directory)))
                    .or_else(|| {
                        let (major, minor, _, _) = super::windows::file_version(&executable)?;
                        ((20..100).contains(&major) && minor < 100).then_some((major, minor))
                    })
            }),
        )
        .collect();
    installed
        .into_iter()
        .map(|(major, minor)| {
            let version = format!("{major}.{minor}");
            let root = houdini_profile(environment, &version);
            let bootstrap = environment.bootstrap(HOUDINI_SCRIPT);
            // Variants of one major/minor can use different Python versions but share a profile.
            let mut files: Vec<_> = (9..=13)
                .map(|python_minor| {
                    InstallFile::managed(
                        format!("nexus-assets-bridge/python3.{python_minor}libs/uiready.py"),
                        bootstrap.clone(),
                    )
                })
                .collect();
            files.push(InstallFile::managed(
                "packages/NexusAssetsBridge.json",
                HOUDINI_PACKAGE.to_vec(),
            ));
            InstallTarget::new(
                "houdini",
                version,
                root,
                files,
                "重启 Houdini 后桥接将自动连接。安装到对应版本的 Packages 目录。",
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_versioned_host_names_without_mistaking_additional_products_for_hosts() {
        assert_eq!(release_year("Maya2025", "maya"), Some(2025));
        assert_eq!(release_year("Maya 2026", "maya"), Some(2026));
        assert_eq!(release_year("Maya 2025 Help", "maya"), None);
        assert_eq!(release_year("3ds Max 2026", "3ds max "), Some(2026));
        assert_eq!(houdini_version("Houdini Server"), None);
        assert_eq!(houdini_version("Houdini 22.0.466"), Some((22, 0)));
        assert_eq!(houdini_version("hfs20.5.684"), Some((20, 5)));
        assert_eq!(houdini_version("Houdini20.5.foo"), None);
    }
}
