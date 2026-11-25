use super::{stage_copy, AssetVersion};
use crate::{
    asset_cover::valid_id,
    team_covers::library_namespace,
    team_desktop::{Desktop, TeamAssetStorage},
    workspace_data::workspace_data_directory,
};
use nexus_core::{
    now,
    team::{mapped_file, relative_path, SharedAsset},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;
use uuid::Uuid;

const MAX_METADATA: u64 = 16 * 1024;

pub(super) struct Location {
    mount: PathBuf,
    relative: String,
    storage_mount: PathBuf,
    namespace: String,
    asset_id: String,
}

#[derive(Deserialize, Serialize)]
struct Record {
    #[serde(flatten)]
    summary: AssetVersion,
    filename: String,
}

impl Location {
    pub(super) fn resolve(app: &tauri::AppHandle, id: &str) -> Result<Self, String> {
        let (asset, mount, team_id) = app.state::<Desktop>().mounted_asset(id)?;
        Self::from_asset(id, asset, mount, &team_id)
    }

    fn from_asset(
        id: &str,
        asset: SharedAsset,
        mount: PathBuf,
        team_id: &str,
    ) -> Result<Self, String> {
        if !valid_id(id) || !mount.is_absolute() || relative_path(&asset.relative_path).is_none() {
            return Err("团队资产位置无效".into());
        }
        let storage = TeamAssetStorage::for_asset(mount.clone(), &asset)?;
        Ok(Self {
            mount,
            relative: asset.relative_path,
            storage_mount: storage.data_mount()?,
            namespace: library_namespace(team_id, &storage.library_id),
            asset_id: id.to_owned(),
        })
    }

    pub(super) fn original(&self) -> PathBuf {
        self.mount.join(&self.relative)
    }

    fn workspace_dir(&self, create: bool) -> Result<Option<PathBuf>, String> {
        workspace_data_directory(
            &self.storage_mount,
            &[".nexus", "asset-versions", &self.namespace, &self.asset_id],
            create,
        )
    }

    pub(super) fn list(&self) -> Result<Vec<(AssetVersion, PathBuf)>, String> {
        let Some(directory) = self.workspace_dir(false)? else {
            return Ok(Vec::new());
        };
        let mut versions = Vec::new();
        for entry in
            fs::read_dir(&directory).map_err(|error| format!("无法读取团队版本目录：{error}"))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let Some((name, number)) = name
                .to_str()
                .and_then(|name| version_number(name).map(|number| (name, number)))
            else {
                continue;
            };
            let Ok(Some(path)) = workspace_data_directory(&directory, &[name], false) else {
                continue;
            };
            if let Ok(summary) = read_record(&path, &self.asset_id, number) {
                versions.push((summary, path));
            }
        }
        versions.sort_by(|a, b| b.0.version.cmp(&a.0.version));
        Ok(versions)
    }

    pub(super) fn read(&self, version_id: &str) -> Result<(AssetVersion, PathBuf), String> {
        self.list()?
            .into_iter()
            .find(|(version, _)| version.id == version_id)
            .ok_or("版本不存在或文件无法读取".into())
    }

    pub(super) fn create(&self, note: &str) -> Result<AssetVersion, String> {
        let source = mapped_file(&self.mount, &self.relative)?;
        let filename = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("资产文件路径无效")?
            .to_owned();
        let directory = self.workspace_dir(true)?.ok_or("无法创建团队版本目录")?;
        let staging = tempfile::Builder::new()
            .prefix(".nexus-version-")
            .tempdir_in(&directory)
            .map_err(|error| format!("无法创建临时版本目录：{error}"))?;

        let handle = same_file::Handle::from_path(&source)
            .map_err(|error| format!("无法读取资产文件：{error}"))?;
        let (snapshot, size) = stage_copy(&source, staging.path())?;
        let current = mapped_file(&self.mount, &self.relative)?;
        let current_handle =
            same_file::Handle::from_path(current).map_err(|error| error.to_string())?;
        if handle != current_handle {
            return Err("资产在复制时被替换，请保存文件后重试".into());
        }
        let id = Uuid::new_v4().to_string();
        snapshot
            .persist_noclobber(staging.path().join(&id))
            .map_err(|error| format!("无法保存版本文件：{}", error.error))?;

        let first = next_version(&directory)?;
        let mut record = Record {
            summary: AssetVersion {
                id,
                asset_id: format!("team:{}", self.asset_id),
                version: first,
                created: now(),
                note: note.trim().chars().take(1000).collect(),
                size,
                filename: filename.clone(),
            },
            filename,
        };
        // Each completed directory contains both the immutable file and its
        // metadata, so a concurrent rename cannot replace a published version.
        for offset in 0..64 {
            record.summary.version = first.checked_add(offset).ok_or("团队版本编号已满")?;
            let target = directory.join(format!("v{}", record.summary.version));
            match fs::symlink_metadata(&target) {
                Ok(_) => continue,
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
            write_record(staging.path(), &record)?;
            match fs::rename(staging.path(), &target) {
                Ok(()) => {
                    let _ = staging.keep();
                    return Ok(record.summary);
                }
                Err(_) if fs::symlink_metadata(&target).is_ok() => continue,
                Err(error) => return Err(format!("无法发布团队版本：{error}")),
            }
        }
        Err("团队版本正在被其他电脑保存，请重试".into())
    }
}

fn version_number(name: &str) -> Option<u64> {
    let value = name.strip_prefix('v')?;
    let parsed: u64 = value.parse().ok()?;
    (parsed > 0 && parsed.to_string() == value).then_some(parsed)
}

fn next_version(directory: &Path) -> Result<u64, String> {
    let mut latest = 0;
    for entry in
        fs::read_dir(directory).map_err(|error| format!("无法读取团队版本目录：{error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        if let Some(number) = entry.file_name().to_str().and_then(version_number) {
            latest = latest.max(number);
        }
    }
    latest.checked_add(1).ok_or("团队版本编号已满".into())
}

fn ordinary_file(path: &Path) -> Result<Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("团队版本不能通过链接指向其他位置".into());
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("团队版本文件无效".into());
    }
    Ok(metadata)
}

fn write_record(directory: &Path, record: &Record) -> Result<(), String> {
    let metadata = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    if metadata.len() as u64 > MAX_METADATA {
        return Err("团队版本备注或文件名太长".into());
    }
    let mut file =
        File::create(directory.join("version.json")).map_err(|error| error.to_string())?;
    file.write_all(&metadata)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("无法保存团队版本记录：{error}"))
}

fn read_record(directory: &Path, asset: &str, number: u64) -> Result<AssetVersion, String> {
    let metadata = directory.join("version.json");
    if ordinary_file(&metadata)?.len() > MAX_METADATA {
        return Err("团队版本记录过大".into());
    }
    let file = File::open(metadata).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_METADATA + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_METADATA {
        return Err("团队版本记录过大".into());
    }
    let mut record: Record = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let filename = relative_path(&record.filename)
        .filter(|path| path.components().count() == 1)
        .ok_or("团队版本文件名无效")?;
    let id = Uuid::parse_str(&record.summary.id).map_err(|_| "团队版本编号无效")?;
    if record.summary.asset_id != format!("team:{asset}")
        || record.summary.version != number
        || id.to_string() != record.summary.id
    {
        return Err("团队版本记录与所属资产不符".into());
    }
    if ordinary_file(&directory.join(id.to_string()))?.len() != record.summary.size {
        return Err("团队版本文件大小与记录不符".into());
    }
    record.summary.filename = filename.to_string_lossy().into_owned();
    Ok(record.summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consolidated_assets_keep_versions_and_covers_in_their_original_namespace() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path();
        let former_root = mount.join("媒体");
        fs::create_dir(&former_root).unwrap();
        let source = former_root.join("asset.obj");
        fs::write(&source, "first").unwrap();

        let old_library = Uuid::new_v4().to_string();
        let asset_id = Uuid::new_v4().to_string();
        let legacy: SharedAsset = serde_json::from_value(serde_json::json!({
            "id":asset_id, "libraryId":old_library, "relativePath":"asset.obj", "name":"Asset",
            "ext":"obj", "kind":"model", "size":5, "modified":1, "added":1, "tags":[],
            "notes":"", "revision":1, "editedBy":"Fixture"
        }))
        .unwrap();
        let before =
            Location::from_asset(&asset_id, legacy.clone(), former_root.clone(), "team").unwrap();
        let first = before.create("first").unwrap();
        let cover_id = format!("team-{asset_id}");
        let cover =
            crate::team_covers::cover_target(&former_root, "team", &old_library, &cover_id, true)
                .unwrap()
                .unwrap();
        fs::write(&cover, "cover fixture").unwrap();

        // The original file can subsequently move without moving its workspace data.
        let current_file = mount.join("asset.obj");
        fs::rename(&source, &current_file).unwrap();
        fs::write(&current_file, "second source").unwrap();
        let consolidated = SharedAsset {
            library_id: Uuid::new_v4().to_string(),
            storage_library_id: Some(old_library),
            storage_folder: Some("媒体".into()),
            ..legacy
        };
        let after =
            Location::from_asset(&asset_id, consolidated.clone(), mount.to_path_buf(), "team")
                .unwrap();
        assert_eq!(after.original(), current_file);
        assert_eq!(after.read(&first.id).unwrap().0.note, "first");
        let second = after.create("second").unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(second.size, 13);
        let storage = TeamAssetStorage::for_asset(mount.to_path_buf(), &consolidated).unwrap();
        assert_eq!(
            crate::team_covers::cover_target(
                &storage.data_mount().unwrap(),
                "team",
                &storage.library_id,
                &cover_id,
                false,
            )
            .unwrap(),
            Some(cover)
        );
        assert!(!mount.join(".nexus").exists());

        for unsafe_folder in ["../外部", "/absolute", ".nexus", "不存在"] {
            let invalid = SharedAsset {
                storage_folder: Some(unsafe_folder.into()),
                ..consolidated.clone()
            };
            assert!(Location::from_asset(&asset_id, invalid, mount.to_path_buf(), "team").is_err());
        }
    }

    #[test]
    fn mounted_clients_publish_distinct_immutable_versions() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("nas");
        fs::create_dir(&mount).unwrap();
        let path = mount.join("水杯.obj");
        fs::write(&path, b"initial file").unwrap();
        let location = || Location {
            mount: mount.clone(),
            relative: "水杯.obj".into(),
            storage_mount: mount.clone(),
            namespace: library_namespace("team", "library"),
            asset_id: "shared-asset-42".into(),
        };
        let first_client = location();
        let second_client = location();
        assert!(first_client.list().unwrap().is_empty());
        assert!(!mount.join(".nexus").exists());
        let first = first_client.create("  最初文件  ").unwrap();
        fs::write(&path, b"next file contents").unwrap();

        std::thread::scope(|threads| {
            let a = threads.spawn(|| first_client.create("a").unwrap().version);
            let b = threads.spawn(|| second_client.create("b").unwrap().version);
            let mut numbers = [a.join().unwrap(), b.join().unwrap()];
            numbers.sort();
            assert_eq!(numbers, [2, 3]);
        });
        assert_eq!(second_client.list().unwrap().len(), 3);
        let (stored, dir) = second_client.read(&first.id).unwrap();
        assert_eq!(stored.note, "最初文件");
        assert_eq!(stored.suggested_filename(), "水杯-v1.obj");
        assert_eq!(stored.asset_id, "team:shared-asset-42");

        assert!(super::super::export_to(&dir, &stored, &path, &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"next file contents");
        fs::remove_file(&path).unwrap();
        let export = scratch.path().join(stored.suggested_filename());
        super::super::export_to(&dir, &stored, &path, &export).unwrap();
        assert_eq!(fs::read(&export).unwrap(), b"initial file");
        assert!(super::super::export_to(&dir, &stored, &path, &export).is_err());
        assert!(!path.exists());
        assert_eq!(first_client.list().unwrap().len(), 3);
        assert_eq!(
            fs::read_dir(first_client.workspace_dir(false).unwrap().unwrap())
                .unwrap()
                .count(),
            3
        );
    }
}
