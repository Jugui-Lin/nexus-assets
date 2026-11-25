use serde_json::Value;
use std::{
    fs::{self, File},
    io::{self, ErrorKind, Read, Write},
    path::Path,
};

const MAGIC: &[u8; 4] = b"NUP1";
const MAX_MANIFEST_SIZE: usize = 64 * 1024;
const MAX_INSTALLER_SIZE: usize = 256 * 1024 * 1024;
const MAX_CACHE_SIZE: u64 = (8 + MAX_MANIFEST_SIZE + MAX_INSTALLER_SIZE) as u64;

fn invalid_cache() -> io::Error {
    io::Error::new(ErrorKind::InvalidData, "无效的更新缓存")
}

pub(super) fn store(path: &Path, manifest: &Value, installer: &[u8]) -> io::Result<()> {
    let manifest = serde_json::to_vec(manifest)?;
    if manifest.len() > MAX_MANIFEST_SIZE || !(1..=MAX_INSTALLER_SIZE).contains(&installer.len()) {
        return Err(invalid_cache());
    }
    let parent = path.parent().ok_or_else(invalid_cache)?;
    fs::create_dir_all(parent)?;
    let mut pending = tempfile::NamedTempFile::new_in(parent)?;
    pending.write_all(MAGIC)?;
    pending.write_all(&(manifest.len() as u32).to_le_bytes())?;
    pending.write_all(&manifest)?;
    pending.write_all(installer)?;
    pending.as_file().sync_all()?;
    pending.persist(path)?;
    Ok(())
}

fn read(mut file: File) -> io::Result<(Value, Vec<u8>)> {
    if file.metadata()?.len() > MAX_CACHE_SIZE {
        return Err(invalid_cache());
    }
    let mut magic = [0; MAGIC.len()];
    let mut manifest_size = [0; 4];
    file.read_exact(&mut magic)?;
    file.read_exact(&mut manifest_size)?;
    let manifest_size = u32::from_le_bytes(manifest_size) as usize;
    if &magic != MAGIC || !(1..=MAX_MANIFEST_SIZE).contains(&manifest_size) {
        return Err(invalid_cache());
    }

    let mut manifest = vec![0; manifest_size];
    file.read_exact(&mut manifest)?;
    let manifest = serde_json::from_slice(&manifest)?;
    let mut installer = Vec::new();
    file.take((MAX_INSTALLER_SIZE + 1) as u64)
        .read_to_end(&mut installer)?;
    if !(1..=MAX_INSTALLER_SIZE).contains(&installer.len()) {
        return Err(invalid_cache());
    }
    Ok((manifest, installer))
}

pub(super) fn discard(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(super) fn take(path: &Path) -> io::Result<Option<(Value, Vec<u8>)>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let payload = read(file);
    // The caller holds the single-instance listener. Consume the package even
    // if validation or installer startup fails so reopening cannot keep retrying it.
    discard(path)?;
    payload.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn atomically_replaces_and_consumes_package_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cache").join("pending.bin");
        store(&path, &json!({"version": "0.10.51"}), b"old").unwrap();
        let manifest = json!({"version": "0.10.52"});
        store(&path, &manifest, b"new package").unwrap();
        assert_eq!(
            take(&path).unwrap(),
            Some((manifest, b"new package".to_vec()))
        );
        assert!(take(&path).unwrap().is_none());
    }

    #[test]
    fn rejects_and_consumes_oversized_or_truncated_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pending.bin");
        for manifest_size in [(MAX_MANIFEST_SIZE + 1) as u32, 4] {
            let mut incomplete = MAGIC.to_vec();
            incomplete.extend_from_slice(&manifest_size.to_le_bytes());
            fs::write(&path, incomplete).unwrap();
            assert!(take(&path).is_err());
            assert!(take(&path).unwrap().is_none());
        }
    }

    #[test]
    fn rejects_invalid_replacement_without_damaging_prepared_package() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pending.bin");
        let manifest = json!({"version": "0.10.51"});
        store(&path, &manifest, b"original").unwrap();
        assert!(store(&path, &json!("a".repeat(MAX_MANIFEST_SIZE)), b"new").is_err());
        assert!(store(&path, &manifest, b"").is_err());
        assert_eq!(take(&path).unwrap(), Some((manifest, b"original".to_vec())));
    }
}
