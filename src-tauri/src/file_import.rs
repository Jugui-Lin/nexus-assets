use super::Catalog;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
}

impl FileStamp {
    fn from_metadata(metadata: Metadata) -> io::Result<Self> {
        #[cfg(windows)]
        let ordinary = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 == 0
        };
        #[cfg(not(windows))]
        let ordinary = true;
        if !ordinary || !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "资产路径不是普通文件",
            ));
        }
        Ok(Self {
            size: metadata.len(),
            modified: metadata.modified()?,
            created: metadata.created().ok(),
        })
    }

    fn at(path: &Path) -> io::Result<Self> {
        Self::from_metadata(fs::symlink_metadata(path)?)
    }
}

#[derive(Clone, Copy)]
pub struct FileFingerprint {
    pub digest: [u8; 32],
    stamp: FileStamp,
}

impl FileFingerprint {
    fn open_for_read(path: &Path) -> io::Result<File> {
        let mut open = OpenOptions::new();
        open.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Keep an active writer or replacement from racing the physical read.
            const FILE_SHARE_READ: u32 = 1;
            open.share_mode(FILE_SHARE_READ);
        }
        open.open(path)
    }

    pub fn read(path: &Path, expected_size: u64) -> io::Result<Self> {
        let changed = || io::Error::new(io::ErrorKind::InvalidData, "资产在查重时发生更改，请重试");
        let stamp = FileStamp::at(path)?;
        if stamp.size != expected_size {
            return Err(changed());
        }
        let file = Self::open_for_read(path)?;
        if FileStamp::from_metadata(file.metadata()?)? != stamp {
            return Err(changed());
        }
        let mut reader = file.take(expected_size.saturating_add(1));
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 128 * 1024];
        let mut bytes_read = 0u64;
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            bytes_read += read as u64;
            hash.update(&buffer[..read]);
        }
        if bytes_read != expected_size
            || FileStamp::from_metadata(reader.get_ref().metadata()?)? != stamp
            || FileStamp::at(path)? != stamp
        {
            return Err(changed());
        }
        Ok(Self {
            digest: hash.finalize().into(),
            stamp,
        })
    }

    pub fn still_matches(&self, path: &Path) -> bool {
        FileStamp::at(path).is_ok_and(|stamp| stamp == self.stamp)
            && Self::open_for_read(path)
                .and_then(|file| FileStamp::from_metadata(file.metadata()?))
                .is_ok_and(|stamp| stamp == self.stamp)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileImportOutcome {
    Indexed,
    Duplicate,
    Unsupported,
}

pub struct FileImport<'a> {
    catalog: &'a Catalog,
    fingerprints: HashMap<PathBuf, FileFingerprint>,
}

impl Catalog {
    pub fn file_import(&self) -> FileImport<'_> {
        FileImport {
            catalog: self,
            fingerprints: HashMap::new(),
        }
    }
}

impl FileImport<'_> {
    fn fingerprint(&mut self, path: &Path, size: u64) -> io::Result<FileFingerprint> {
        if let Some(known) = self
            .fingerprints
            .get(path)
            .filter(|known| known.stamp.size == size && known.still_matches(path))
        {
            return Ok(*known);
        }
        let fingerprint = FileFingerprint::read(path, size)?;
        self.fingerprints.insert(path.to_path_buf(), fingerprint);
        Ok(fingerprint)
    }

    fn same_size_paths(&self, source: &str, size: u64) -> rusqlite::Result<Vec<String>> {
        let mut query = self.catalog.conn.prepare_cached(
            "SELECT path FROM assets WHERE json_extract(data,'$.size')=?1 AND path<>?2
             AND json_extract(data,'$.demo') IS NOT 1
             AND NOT EXISTS(SELECT 1 FROM recycled_assets WHERE asset_id=assets.id)",
        )?;
        let rows = query.query_map(params![size, source], |row| row.get(0))?;
        rows.collect()
    }

    pub fn add(&mut self, path: &Path, library: &str) -> Result<FileImportOutcome, String> {
        let Some(asset) = Catalog::prepare_asset(path, library)? else {
            return Ok(FileImportOutcome::Unsupported);
        };
        let source = Path::new(&asset.path);
        let exists = self
            .catalog
            .conn
            .query_row("SELECT 1 FROM assets WHERE path=?1", [&asset.path], |row| {
                row.get::<_, u8>(0)
            })
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        // An already-indexed path can still need updated metadata or a new library assignment.
        if exists {
            return self.catalog.index_file_asset(&asset).map(|changed| {
                if changed {
                    FileImportOutcome::Indexed
                } else {
                    FileImportOutcome::Duplicate
                }
            });
        }
        let candidates = self
            .same_size_paths(&asset.path, asset.size)
            .map_err(|error| error.to_string())?;
        if !candidates.is_empty() {
            let fingerprint = self
                .fingerprint(source, asset.size)
                .map_err(|error| format!("无法读取资产内容以查重：{error}"))?;
            for candidate in candidates {
                let path = Path::new(&candidate);
                if self.fingerprint(path, asset.size).is_ok_and(|known| {
                    known.digest == fingerprint.digest && known.still_matches(path)
                }) {
                    if !fingerprint.still_matches(source) {
                        return Err("资产在查重时发生更改，请重试".into());
                    }
                    return Ok(FileImportOutcome::Duplicate);
                }
            }
            if !fingerprint.still_matches(source) {
                return Err("资产在查重时发生更改，请重试".into());
            }
        }
        self.catalog.index_file_asset(&asset)?;
        Ok(FileImportOutcome::Indexed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_import_skips_existing_and_batch_duplicates_by_content() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let original = scratch.path().join("reference.jpg");
        let copy = scratch.path().join("different-name.jpg");
        let other_folder = scratch.path().join("another");
        fs::create_dir(&other_folder).unwrap();
        let different = other_folder.join("reference.jpg");
        let batch_copy = scratch.path().join("batch-copy.jpg");
        fs::write(&original, b"first").unwrap();
        fs::write(&copy, b"first").unwrap();
        fs::write(&different, b"other").unwrap();
        fs::write(&batch_copy, b"other").unwrap();
        catalog.add_file(&original, "loose").unwrap();
        let id = catalog.assets().unwrap()[0].id.clone();
        catalog.patch(&id, json!({"notes":"keep"})).unwrap();

        let mut import = catalog.file_import();
        assert_eq!(
            import.add(&copy, "loose").unwrap(),
            FileImportOutcome::Duplicate
        );
        assert_eq!(
            import.add(&different, "loose").unwrap(),
            FileImportOutcome::Indexed
        );
        assert_eq!(
            import.add(&batch_copy, "loose").unwrap(),
            FileImportOutcome::Duplicate
        );
        assert_eq!(
            import.add(&original, "loose").unwrap(),
            FileImportOutcome::Duplicate
        );
        assert_eq!(catalog.assets().unwrap().len(), 2);
        assert_eq!(catalog.asset(&id).unwrap().notes, "keep");
        assert_eq!(fs::read(&copy).unwrap(), b"first");
        assert_eq!(fs::read(&batch_copy).unwrap(), b"other");

        fs::write(&original, b"new file size").unwrap();
        assert_eq!(
            import.add(&original, "loose").unwrap(),
            FileImportOutcome::Indexed
        );
        assert_eq!(catalog.asset(&id).unwrap().size, 13);
        assert_eq!(catalog.asset(&id).unwrap().notes, "keep");
    }

    #[test]
    fn missing_recycled_and_changed_existing_paths_do_not_block_import() {
        let scratch = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let missing = scratch.path().join("missing.jpg");
        let archived = scratch.path().join("archived.jpg");
        let changing = scratch.path().join("changing.jpg");
        let incoming = scratch.path().join("incoming.jpg");
        for path in [&missing, &archived, &changing] {
            fs::write(path, b"same").unwrap();
            catalog.add_file(path, "loose").unwrap();
        }
        let archived_id = catalog
            .assets()
            .unwrap()
            .into_iter()
            .find(|asset| asset.name == "archived")
            .unwrap()
            .id;
        catalog.set_assets_recycled(&[archived_id], true).unwrap();
        fs::remove_file(&missing).unwrap();
        fs::write(&incoming, b"same").unwrap();
        let mut import = catalog.file_import();
        assert_eq!(
            import.add(&incoming, "loose").unwrap(),
            FileImportOutcome::Duplicate
        );
        fs::write(&changing, b"different length").unwrap();
        assert_eq!(
            import.add(&incoming, "loose").unwrap(),
            FileImportOutcome::Indexed
        );
    }

    #[cfg(windows)]
    #[test]
    fn hashing_declines_a_file_opened_for_write() {
        let scratch = tempfile::tempdir().unwrap();
        let file = scratch.path().join("writing.jpg");
        fs::write(&file, b"pending").unwrap();
        let previous = FileFingerprint::read(&file, 7).unwrap();
        let writer = OpenOptions::new().write(true).open(&file).unwrap();
        assert!(FileFingerprint::read(&file, 7).is_err());
        assert!(!previous.still_matches(&file));
        drop(writer);
        assert!(previous.still_matches(&file));
    }
}
