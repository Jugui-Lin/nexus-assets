use crate::{asset_cover, team_desktop::Desktop, workspace_data::workspace_data_directory};
use nexus_core::Asset;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, Metadata},
    io::ErrorKind,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub(crate) fn library_namespace(team_id: &str, library_id: &str) -> String {
    Sha256::digest(
        serde_json::json!([team_id, library_id])
            .to_string()
            .as_bytes(),
    )
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect()
}

fn covers_directory(
    mount: &Path,
    team_id: &str,
    library_id: &str,
    create: bool,
) -> Result<Option<PathBuf>, String> {
    let namespace = library_namespace(team_id, library_id);
    workspace_data_directory(mount, &[".nexus", "asset-covers", &namespace], create)
}

fn ordinary_file(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    metadata.is_file() && !metadata.file_type().is_symlink()
}

pub(crate) fn cover_target(
    mount: &Path,
    team_id: &str,
    library_id: &str,
    id: &str,
    create: bool,
) -> Result<Option<PathBuf>, String> {
    let Some(directory) = covers_directory(mount, team_id, library_id, create)? else {
        return Ok(None);
    };
    let filename = asset_cover::cover_filename(id).ok_or("团队资产标识无效")?;
    let path = directory.join(filename);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if ordinary_file(&metadata) => Ok(Some(path)),
        Ok(_) => Err("团队封面位置必须是普通文件".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let screenshot = asset_cover::screenshot_reference_name(id).is_some_and(|name| {
                fs::symlink_metadata(directory.join(name)).is_ok_and(|meta| ordinary_file(&meta))
            });
            Ok((create || screenshot).then_some(path))
        }
        Err(error) => Err(format!("无法读取团队封面：{error}")),
    }
}

pub(crate) fn apply_cover(
    asset: &mut Asset,
    mount: &Path,
    team_id: &str,
    library_id: &str,
) -> bool {
    let Ok(Some(directory)) = covers_directory(mount, team_id, library_id, false) else {
        return false;
    };
    if asset_cover::apply_screenshot_reference(asset, &directory) {
        return true;
    }
    let Some(path) = asset_cover::cover_filename(&asset.id).map(|name| directory.join(name)) else {
        return false;
    };
    if !fs::symlink_metadata(&path).is_ok_and(|meta| ordinary_file(&meta)) {
        return false;
    }
    asset_cover::apply_cover_path(asset, &path);
    true
}

fn read_revisions(
    mount: &Path,
    team_id: &str,
    library_id: &str,
    result: &mut HashMap<String, String>,
) -> Result<(), String> {
    let Some(directory) = covers_directory(mount, team_id, library_id, false)? else {
        return Ok(());
    };
    for entry in
        fs::read_dir(directory).map_err(|error| format!("无法读取团队封面目录：{error}"))?
    {
        let Ok(entry) = entry else { continue };
        let filename = entry.file_name();
        let Some(name) = filename.to_str() else {
            continue;
        };
        let screenshot = name
            .strip_prefix("screenshot-team-")
            .and_then(|name| name.strip_suffix(".ref"));
        let Some(id) = screenshot.or_else(|| {
            name.strip_prefix("cover-team-")
                .and_then(|name| name.strip_suffix(".png"))
        }) else {
            continue;
        };
        if !asset_cover::valid_id(id) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !ordinary_file(&metadata) || metadata.len() == 0 {
            continue;
        }
        let stamp = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok());
        let revision = format!(
            "{}-{}-{}",
            if screenshot.is_some() {
                "screenshot"
            } else {
                "cover"
            },
            metadata.len(),
            stamp.map_or(0, |time| time.as_nanos() / 100)
        );
        if screenshot.is_some() {
            result.insert(format!("team:{id}"), revision);
        } else {
            result.entry(format!("team:{id}")).or_insert(revision);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn team_cover_revisions(
    state: tauri::State<'_, Desktop>,
) -> Result<HashMap<String, String>, String> {
    let (team_id, mounts) = state.cover_mounts();
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = HashMap::new();
        for storage in mounts {
            let Ok(mount) = storage.data_mount() else {
                continue;
            };
            read_revisions(&mount, &team_id, &storage.library_id, &mut result)?;
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_screenshot_is_discovered_by_revisions_and_reads_the_project_png() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("share");
        fs::create_dir(&mount).unwrap();
        let mount = fs::canonicalize(mount).unwrap();
        let project = mount.join("team-project.c4d");
        fs::write(&project, b"team scene").unwrap();
        let catalog = nexus_core::Catalog::open(&scratch.path().join("db")).unwrap();
        catalog.add_file(&project, "test").unwrap();
        let mut asset = catalog.assets().unwrap().remove(0);
        asset.id = "team-project-id".into();
        let target = cover_target(&mount, "team", "library", &asset.id, true)
            .unwrap()
            .unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(19, 31)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let png =
            asset_cover::store_screenshot_sidecar(bytes.get_ref(), &asset, &target, Some(&mount))
                .unwrap();
        assert_eq!(png, project.with_extension("png"));
        assert!(!target.exists());
        assert_eq!(
            cover_target(&mount, "team", "library", &asset.id, false).unwrap(),
            Some(target)
        );

        let mut revisions = HashMap::new();
        read_revisions(&mount, "team", "library", &mut revisions).unwrap();
        assert!(revisions["team:project-id"].starts_with("screenshot-"));
        assert!(apply_cover(&mut asset, &mount, "team", "library"));
        assert_eq!(image::open(asset.thumbnail.unwrap()).unwrap().height(), 31);
        assert_eq!(fs::read(project).unwrap(), b"team scene");
    }

    #[test]
    fn two_clients_read_the_same_custom_cover_and_its_removal() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("share");
        fs::create_dir(&mount).unwrap();
        let source = mount.join("texture.png");
        image::RgbImage::new(5, 7).save(&source).unwrap();
        let original = fs::read(&source).unwrap();
        let catalog = nexus_core::Catalog::open(&scratch.path().join("db")).unwrap();
        catalog.add_file(&source, "test").unwrap();
        let mut asset = catalog.assets().unwrap().remove(0);
        asset.id = "team-asset-123".to_owned();

        assert!(!apply_cover(&mut asset.clone(), &mount, "team", "library"));
        assert!(!mount.join(".nexus").exists());
        let target = cover_target(&mount, "team", "library", &asset.id, true)
            .unwrap()
            .unwrap();
        let mut image = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(13, 9)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        asset_cover::store_cover(image.get_ref(), &target).unwrap();

        let mut preview = asset.clone();
        assert!(apply_cover(&mut preview, &mount, "team", "library"));
        let (_, image) = nexus_core::thumbnail_cache::read_or_generate(
            &preview,
            &scratch.path().join("cache"),
            256,
        )
        .unwrap()
        .unwrap();
        assert_eq!(image::load_from_memory(&image).unwrap().width(), 13);
        assert_eq!(preview.path, asset.path);
        assert!(!apply_cover(
            &mut asset.clone(),
            &mount,
            "other team",
            "library"
        ));

        let mut revisions = HashMap::new();
        read_revisions(&mount, "team", "library", &mut revisions).unwrap();
        assert!(revisions.contains_key("team:asset-123"));
        fs::remove_file(target).unwrap();
        assert!(!apply_cover(&mut asset.clone(), &mount, "team", "library"));
        revisions.clear();
        read_revisions(&mount, "team", "library", &mut revisions).unwrap();
        assert!(revisions.is_empty());
        assert_eq!(fs::read(&source).unwrap(), original);
    }
}
