use crate::folder_deletion::canonical_directory;
use serde::Serialize;
use std::{
    fs::{self, File, Metadata, OpenOptions, TryLockError},
    io::ErrorKind,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize)]
pub(crate) struct Cleanup {
    removed: usize,
    skipped: usize,
}

#[derive(Default, Serialize)]
pub(crate) struct Size {
    bytes: u64,
}

fn is_plain(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    metadata.is_dir() || metadata.is_file()
}

fn is_plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && is_plain(&metadata))
}

fn exclusive_lease(cache: &Path) -> Result<File, String> {
    let path = cache.join(".nexus-cache-lease");
    let invalid = "Cinema 4D 缓存的锁文件无效";
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && is_plain(&metadata) => (),
        Err(error) if error.kind() == ErrorKind::NotFound => (),
        _ => return Err(invalid.into()),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        options
            .share_mode(3)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(&path)
        .map_err(|_| "无法打开 Cinema 4D 缓存锁")?;
    if !is_plain_file(&path)
        || !file
            .metadata()
            .is_ok_and(|meta| meta.is_file() && is_plain(&meta))
    {
        return Err(invalid.into());
    }
    let opened = same_file::Handle::from_file(file.try_clone().map_err(|_| invalid)?)
        .map_err(|_| invalid)?;
    let current = same_file::Handle::from_path(&path).map_err(|_| invalid)?;
    if opened != current {
        return Err(invalid.into());
    }
    // The bridge holds a shared lock starting at byte zero on Windows and uses flock on Unix.
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => {
            Err("Cinema 4D 正在使用此缓存，请关闭使用它的 Cinema 4D 后重试。".into())
        }
        Err(TryLockError::Error(_)) => Err("无法锁定 Cinema 4D 缓存".into()),
    }
}

fn is_prepared_cache(name: &str) -> bool {
    name.split_once('-').is_some_and(|(kind, hash)| {
        matches!(kind, "zip" | "texture" | "sbsar")
            && hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn is_converted_cache(name: &str) -> bool {
    name.rsplit_once('-').is_some_and(|(kind, suffix)| {
        matches!(kind, "scene-fbx" | "max-decode")
            && suffix.len() == 8
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

fn plain_tree_bytes(path: &Path) -> Option<u64> {
    let mut bytes = 0u64;
    let mut folders = vec![fs::read_dir(path).ok()?];
    while let Some(entries) = folders.last_mut() {
        let Some(entry) = entries.next() else {
            folders.pop();
            continue;
        };
        let path = entry.ok()?.path();
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !is_plain(&metadata) {
            return None;
        }
        if metadata.is_dir() {
            folders.push(fs::read_dir(&path).ok()?);
        } else {
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Some(bytes)
}

fn visit_children(
    parent: &Path,
    matches: fn(&str) -> bool,
    markers: &[&str],
    visit: &mut impl FnMut(Option<(&Path, u64)>),
) -> std::io::Result<()> {
    for entry in fs::read_dir(parent)? {
        let Ok(entry) = entry else {
            visit(None);
            continue;
        };
        if !entry.file_name().to_str().is_some_and(matches) {
            continue;
        }
        let path = entry.path();
        if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir() && is_plain(&meta))
            || !fs::canonicalize(&path).is_ok_and(|resolved| resolved.parent() == Some(parent))
            || !markers
                .iter()
                .all(|marker| is_plain_file(&path.join(marker)))
        {
            visit(None);
            continue;
        }
        visit(plain_tree_bytes(&path).map(|bytes| (path.as_path(), bytes)));
    }
    Ok(())
}

fn existing_cache(directory: &Path) -> Result<Option<PathBuf>, String> {
    if fs::symlink_metadata(directory).is_err_and(|error| error.kind() == ErrorKind::NotFound) {
        return Ok(None);
    }
    canonical_directory(directory).map(Some)
}

fn visit_cache(cache: &Path, mut visit: impl FnMut(Option<(&Path, u64)>)) -> Result<(), String> {
    visit_children(cache, is_prepared_cache, &[".nexus-ready"], &mut visit)
        .map_err(|_| "无法读取 Cinema 4D 缓存目录")?;

    let converted = cache.join("converted");
    match fs::symlink_metadata(&converted) {
        Ok(metadata) if metadata.is_dir() && is_plain(&metadata) => {
            if !fs::canonicalize(&converted).is_ok_and(|resolved| resolved.parent() == Some(cache))
                || visit_children(
                    &converted,
                    is_converted_cache,
                    &["scene.fbx", "converter.log"],
                    &mut visit,
                )
                .is_err()
            {
                visit(None);
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => (),
        _ => visit(None),
    }
    Ok(())
}

pub(super) fn clear(directory: &Path) -> Result<Cleanup, String> {
    let mut result = Cleanup::default();
    let Some(cache) = existing_cache(directory)? else {
        return Ok(result);
    };
    let _lease = exclusive_lease(&cache)?;
    visit_cache(&cache, |eligible| {
        if eligible.is_some_and(|(path, _)| fs::remove_dir_all(path).is_ok()) {
            result.removed += 1;
        } else {
            result.skipped += 1;
        }
    })?;
    Ok(result)
}

pub(super) fn size(directory: &Path) -> Result<Size, String> {
    let mut result = Size::default();
    let Some(cache) = existing_cache(directory)? else {
        return Ok(result);
    };
    visit_cache(&cache, |eligible| {
        if let Some((_, bytes)) = eligible {
            result.bytes = result.bytes.saturating_add(bytes);
        }
    })?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(parent: &Path, name: &str, markers: &[&str]) -> std::path::PathBuf {
        let directory = parent.join(name);
        fs::create_dir_all(&directory).unwrap();
        for marker in markers {
            fs::write(directory.join(marker), b"cache fixture").unwrap();
        }
        directory
    }

    #[test]
    fn clears_only_marked_cache_entries_inside_the_saved_directory() {
        let temp = tempfile::tempdir().unwrap();
        let cache = fixture(temp.path(), "c4d-import-cache", &[]);
        let prepared = fixture(
            &cache,
            &format!("texture-{}", "a".repeat(64)),
            &[".nexus-ready"],
        );
        let incomplete = fixture(&cache, &format!("zip-{}", "b".repeat(64)), &[]);
        let converted = fixture(
            &cache.join("converted"),
            "max-decode-a1b2c3d4",
            &["scene.fbx", "converter.log"],
        );
        fixture(&converted, "scene.fbm", &["nested texture.png"]);
        let unrelated = fixture(&cache, "user-files", &["picture.png"]);
        let neighboring_cache = fixture(temp.path(), "other-cache", &[".nexus-ready"]);

        assert_eq!(
            size(&cache).unwrap().bytes,
            4 * b"cache fixture".len() as u64
        );
        assert!(!cache.join(".nexus-cache-lease").exists());
        assert!(prepared.exists() && converted.exists());
        let report = clear(&cache).unwrap();
        assert_eq!((report.removed, report.skipped), (2, 1));
        assert!(!prepared.exists() && !converted.exists());
        assert!(incomplete.exists() && unrelated.exists() && neighboring_cache.exists());
        assert_eq!(size(&cache).unwrap().bytes, 0);
    }

    #[test]
    fn measures_missing_cache_without_creating_it() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("missing");
        assert_eq!(size(&cache).unwrap().bytes, 0);
        assert!(!cache.exists());
    }

    #[test]
    fn skips_entries_with_linked_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let cache = fixture(temp.path(), "c4d-import-cache", &[]);
        let prepared = fixture(
            &cache,
            &format!("zip-{}", "e".repeat(64)),
            &[".nexus-ready"],
        );
        let outside = fixture(temp.path(), "outside", &["not cached.png"]);
        let link = prepared.join("linked");
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(result.status.success(), "{:?}", result);
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &link).unwrap();
        }
        assert_eq!(size(&cache).unwrap().bytes, 0);
        let report = clear(&cache).unwrap();
        assert_eq!((report.removed, report.skipped), (0, 1));
        assert!(prepared.exists() && outside.join("not cached.png").exists());
    }

    #[test]
    fn leaves_shared_cache_in_use_and_clears_it_after_release() {
        let temp = tempfile::tempdir().unwrap();
        let cache = fixture(temp.path(), "c4d-import-cache", &[]);
        let prepared = fixture(
            &cache,
            &format!("zip-{}", "a".repeat(64)),
            &[".nexus-ready"],
        );
        let cache = canonical_directory(&cache).unwrap();
        let lease = exclusive_lease(&cache).unwrap();
        lease.unlock().unwrap();
        lease.lock_shared().unwrap();

        assert_eq!(size(&cache).unwrap().bytes, b"cache fixture".len() as u64);
        assert!(clear(&cache).err().unwrap().contains("Cinema 4D 正在使用"));
        assert!(prepared.exists());
        drop(lease);
        assert_eq!(clear(&cache).unwrap().removed, 1);
    }
}
