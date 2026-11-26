use crate::{folder_browser, local_explorer::validate_file_path};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, UNIX_EPOCH},
};

const MAX_DETAIL_PATHS: usize = 50;
const MAX_DETAIL_COLUMNS: usize = 32;
const MAX_PATH_LENGTH: usize = 32_768;
const DETAIL_TIMEOUT: Duration = Duration::from_secs(5);
static DETAIL_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Serialize)]
pub(crate) struct EntryDetails {
    path: String,
    values: BTreeMap<&'static str, String>,
}

#[tauri::command]
pub(crate) async fn local_explorer_entry_details(
    paths: Vec<String>,
    columns: Vec<String>,
) -> Result<Vec<EntryDetails>, String> {
    if paths.len() > MAX_DETAIL_PATHS || columns.len() > MAX_DETAIL_COLUMNS {
        return Err("一次请求的文件或详情列过多".into());
    }
    if paths.is_empty() || columns.is_empty() {
        return Ok(Vec::new());
    }

    folder_browser::read_with_slots(&DETAIL_SLOTS, DETAIL_TIMEOUT, move |cancelled| {
        Ok(read_details(paths, &columns, cancelled))
    })
    .await
}

fn read_details(
    paths: Vec<String>,
    columns: &[String],
    cancelled: &AtomicBool,
) -> Vec<EntryDetails> {
    let read_creation_date = columns.iter().any(|column| column == "created");
    let read_link_target = columns.iter().any(|column| column == "linkTarget");
    let find_parent = columns.iter().any(|column| column == "nearestParent");
    let classify_folder = columns.iter().any(|column| column == "isDirectory");
    #[cfg(windows)]
    let properties = windows_details::Properties::new(columns);

    paths
        .into_iter()
        .take_while(|_| !cancelled.load(Ordering::Acquire))
        .map(|path| {
            let file = Path::new(&path);
            let mut values = BTreeMap::new();
            if path.len() <= MAX_PATH_LENGTH && validate_file_path(file).is_ok() {
                if read_creation_date {
                    if let Some(value) = creation_milliseconds(file) {
                        values.insert("created", value);
                    }
                }
                if read_link_target {
                    if let Some(value) = link_target(file) {
                        values.insert("linkTarget", value);
                    }
                }
                if find_parent {
                    if let Some(value) = nearest_parent(file, cancelled) {
                        values.insert("nearestParent", value);
                    }
                }
                if classify_folder && std::fs::metadata(file).is_ok_and(|entry| entry.is_dir()) {
                    values.insert("isDirectory", "yes".into());
                }
                #[cfg(windows)]
                if let Some(properties) = &properties {
                    properties.read(file, &mut values, cancelled);
                }
            }
            EntryDetails { path, values }
        })
        .collect()
}

fn link_target(path: &Path) -> Option<String> {
    let symlink = std::fs::read_link(path).ok();
    #[cfg(windows)]
    let symlink = symlink.or_else(|| {
        path.extension()
            .and_then(|value| value.to_str())
            .filter(|value| value.eq_ignore_ascii_case("lnk"))?;
        crate::desktop_shortcut::read_file_shortcut(path)
    });
    let target = symlink?;
    let target = if target.is_absolute() {
        target
    } else {
        path.parent()?.join(target)
    };
    validate_file_path(&target).ok()?;
    target.to_str().map(str::to_owned)
}

fn nearest_parent(path: &Path, cancelled: &AtomicBool) -> Option<String> {
    path.ancestors()
        .skip(1)
        .take_while(|_| !cancelled.load(Ordering::Acquire))
        .filter(|parent| parent.is_absolute())
        .find(|parent| std::fs::metadata(parent).is_ok_and(|entry| entry.is_dir()))?
        .to_str()
        .map(str::to_owned)
}

fn creation_milliseconds(path: &Path) -> Option<String> {
    let created = std::fs::symlink_metadata(path).ok()?.created().ok()?;
    Some(
        created
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis()
            .to_string(),
    )
}

#[cfg(windows)]
mod windows_details {
    use super::{AtomicBool, BTreeMap, Ordering, Path};
    use std::{iter, os::windows::ffi::OsStrExt};
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::PROPERTYKEY,
            System::{
                Com::{
                    CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx,
                    COINIT_APARTMENTTHREADED,
                },
                Variant::{VT_EMPTY, VT_NULL},
            },
            UI::Shell::PropertiesSystem::{
                IPropertyStore, PSFormatForDisplayAlloc, PSGetPropertyKeyFromName,
                SHGetPropertyStoreFromParsingName, GPS_BESTEFFORT, PDFF_DEFAULT,
            },
        },
    };

    const MAX_DISPLAY_LENGTH: usize = 2_048;
    const SHELL_COLUMNS: &[(&str, PCWSTR)] = &[
        ("author", w!("System.Author")),
        ("tags", w!("System.Keywords")),
        ("title", w!("System.Title")),
        ("dimensions", w!("System.Image.Dimensions")),
        ("duration", w!("System.Media.Duration")),
        ("attributes", w!("System.FileAttributes")),
        ("copyright", w!("System.Copyright")),
        ("subject", w!("System.Subject")),
        ("comments", w!("System.Comment")),
        ("company", w!("System.Company")),
        ("fileVersion", w!("System.FileVersion")),
        ("owner", w!("System.FileOwner")),
        ("dateTaken", w!("System.Photo.DateTaken")),
    ];

    pub(super) struct Properties {
        columns: Vec<(&'static str, PROPERTYKEY)>,
        _apartment: Apartment,
    }

    impl Properties {
        pub(super) fn new(requested: &[String]) -> Option<Self> {
            let requested = SHELL_COLUMNS
                .iter()
                .copied()
                .filter(|(key, _)| requested.iter().any(|column| column == key));
            let mut requested = requested.peekable();
            requested.peek()?;

            let apartment = Apartment::new()?;
            let columns = requested
                .filter_map(|(column, name)| {
                    let mut key = PROPERTYKEY::default();
                    unsafe { PSGetPropertyKeyFromName(name, &mut key) }.ok()?;
                    Some((column, key))
                })
                .collect::<Vec<_>>();
            (!columns.is_empty()).then_some(Self {
                columns,
                _apartment: apartment,
            })
        }

        pub(super) fn read(
            &self,
            path: &Path,
            values: &mut BTreeMap<&'static str, String>,
            cancelled: &AtomicBool,
        ) {
            if cancelled.load(Ordering::Acquire) {
                return;
            }
            let path: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(iter::once(0))
                .collect();
            let store = unsafe {
                SHGetPropertyStoreFromParsingName::<_, _, IPropertyStore>(
                    PCWSTR(path.as_ptr()),
                    None::<&IBindCtx>,
                    GPS_BESTEFFORT,
                )
            };
            let Ok(store) = store else {
                return;
            };
            for (column, key) in &self.columns {
                if cancelled.load(Ordering::Acquire) {
                    break;
                }
                if let Some(value) = display_value(&store, key) {
                    values.insert(column, value);
                }
            }
        }
    }

    struct Apartment;

    impl Apartment {
        fn new() -> Option<Self> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .ok()?;
            Some(Self)
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn display_value(store: &IPropertyStore, key: &PROPERTYKEY) -> Option<String> {
        let value = unsafe { store.GetValue(key) }.ok()?;
        if matches!(value.vt(), VT_EMPTY | VT_NULL) {
            return None;
        }
        let formatted = unsafe { PSFormatForDisplayAlloc(key, &value, PDFF_DEFAULT) }.ok()?;
        if formatted.is_null() {
            return None;
        }
        let decoded = unsafe { formatted.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(formatted.0.cast())) };
        let trimmed = decoded.as_deref()?.trim();
        (!trimmed.is_empty()).then(|| trimmed.chars().take(MAX_DISPLAY_LENGTH).collect())
    }
}
