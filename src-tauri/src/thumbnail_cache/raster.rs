use crate::decode_scaled_preview;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, OnceLock, Weak},
    time::SystemTime,
};

const MAX_RECENT_BYTES: usize = 24 * 1024 * 1024;
const MAX_RECENT_IMAGES: usize = 96;

#[derive(Clone, Hash, PartialEq, Eq)]
struct SourceVersion {
    path: PathBuf,
    extension: String,
    size: u32,
    length: u64,
    modified: SystemTime,
}

type Image = Arc<Vec<u8>>;
type DecodeResult = Result<Option<Image>, String>;
type Flight = OnceLock<DecodeResult>;

#[derive(Default)]
struct SharedRaster {
    pending: HashMap<SourceVersion, Weak<Flight>>,
    recent: VecDeque<(SourceVersion, Image)>,
    bytes: usize,
}

static SHARED: LazyLock<Mutex<SharedRaster>> = LazyLock::new(Mutex::default);

impl SharedRaster {
    fn remember(&mut self, source: SourceVersion, image: Image) {
        if image.len() > MAX_RECENT_BYTES {
            return;
        }
        while self.recent.len() >= MAX_RECENT_IMAGES || self.bytes + image.len() > MAX_RECENT_BYTES
        {
            let (_, oldest) = self
                .recent
                .pop_front()
                .expect("the new image fits by itself");
            self.bytes -= oldest.len();
        }
        self.bytes += image.len();
        self.recent.push_back((source, image));
    }
}

fn lock_shared() -> std::sync::MutexGuard<'static, SharedRaster> {
    SHARED.lock().unwrap_or_else(|error| error.into_inner())
}

fn load(source: SourceVersion, decode: impl FnOnce() -> DecodeResult) -> DecodeResult {
    let request = {
        let mut shared = lock_shared();
        if let Some(index) = shared.recent.iter().position(|(key, _)| key == &source) {
            let entry = shared
                .recent
                .remove(index)
                .expect("the index was found under the lock");
            let image = Arc::clone(&entry.1);
            shared.recent.push_back(entry);
            return Ok(Some(image));
        }
        shared.pending.retain(|_, value| value.strong_count() != 0);
        let pending = shared.pending.entry(source.clone()).or_default();
        pending.upgrade().unwrap_or_else(|| {
            let request = Arc::new(Flight::new());
            *pending = Arc::downgrade(&request);
            request
        })
    };
    request
        .get_or_init(|| {
            let result = decode();
            let mut shared = lock_shared();
            if let Ok(Some(image)) = &result {
                shared.remember(source, Arc::clone(image));
            }
            result
        })
        .clone()
}

pub(crate) fn read(
    path: &Path,
    extension: &str,
    size: u32,
    length: u64,
    modified: Option<SystemTime>,
) -> Result<Option<Vec<u8>>, String> {
    let Some(modified) = modified else {
        return decode_scaled_preview(path, extension, size, length);
    };
    // Each caller chooses and validates its own original or cover before reaching
    // this cache. Assets, attachments and Explorer may use different asset IDs
    // and disk locations for the same selected file.
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key = SourceVersion {
        path: canonical,
        extension: extension.into(),
        size,
        length,
        modified,
    };
    load(key, || {
        let bytes = decode_scaled_preview(path, extension, size, length)?;
        let current = fs::metadata(path).map_err(|error| format!("无法读取预览来源：{error}"))?;
        if current.len() != length || current.modified().ok() != Some(modified) {
            return Err("预览来源已更新，请重新生成缩略图".into());
        }
        Ok(bytes.map(Arc::new))
    })
    .map(|bytes| bytes.map(|bytes| bytes.as_ref().clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Barrier,
        },
        thread,
        time::Duration,
    };

    #[test]
    fn same_source_version_and_size_share_work_across_callers() {
        let fixture = tempfile::tempdir().unwrap();
        let source = SourceVersion {
            path: fixture.path().join("source.png"),
            extension: "png".into(),
            size: 256,
            length: 3,
            modified: SystemTime::UNIX_EPOCH,
        };
        let started = Barrier::new(4);
        let decodes = AtomicUsize::new(0);
        let decode = || {
            decodes.fetch_add(1, Ordering::Relaxed);
            // Keep the first request in flight when the other views ask for it.
            thread::sleep(Duration::from_millis(30));
            Ok(Some(Arc::new(vec![1, 2, 3])))
        };
        thread::scope(|threads| {
            for _ in 0..3 {
                threads.spawn(|| {
                    started.wait();
                    assert_eq!(
                        load(source.clone(), decode).unwrap().as_deref(),
                        Some(&vec![1, 2, 3])
                    );
                });
            }
            started.wait();
        });
        assert_eq!(decodes.load(Ordering::Relaxed), 1);
        assert!(load(source.clone(), || unreachable!()).unwrap().is_some());
        let changed_size = SourceVersion {
            size: 320,
            ..source.clone()
        };
        assert!(load(changed_size, decode).unwrap().is_some());
        let changed_file = SourceVersion {
            modified: source.modified + Duration::from_secs(1),
            ..source
        };
        assert!(load(changed_file, decode).unwrap().is_some());
        assert_eq!(decodes.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn a_decode_failure_can_be_retried() {
        let fixture = tempfile::tempdir().unwrap();
        let source = SourceVersion {
            path: fixture.path().join("source.png"),
            extension: "png".into(),
            size: 256,
            length: 1,
            modified: SystemTime::UNIX_EPOCH,
        };
        assert!(load(source.clone(), || Err("file busy".into())).is_err());
        assert!(load(source, || Ok(Some(Arc::new(vec![1]))))
            .unwrap()
            .is_some());
    }
}
