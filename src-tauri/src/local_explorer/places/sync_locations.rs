use crate::{folder_browser::FolderEntry, local_explorer::validate_file_path};
use std::{collections::HashSet, path::Path};
use windows::{
    core::{w, GUID, PCWSTR, PWSTR},
    Win32::{
        Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS},
        System::Registry::{
            RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CLASSES_ROOT,
            HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_DWORD,
            RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
        },
    },
};

const DESKTOP_NAMESPACE: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace";
const MAX_NAMESPACE_ENTRIES: u32 = 256;

pub(super) fn read() -> Vec<FolderEntry> {
    let mut seen_paths = HashSet::new();
    let mut folders = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let Some(namespace) = NamespaceKey::open(hive) else {
            continue;
        };
        let mut buffer = [0u16; 256];
        for index in 0..MAX_NAMESPACE_ENTRIES {
            let mut size = buffer.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    namespace.0,
                    index,
                    Some(PWSTR(buffer.as_mut_ptr())),
                    &mut size,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if status == ERROR_MORE_DATA {
                continue;
            }
            if status != ERROR_SUCCESS {
                break;
            }
            let Ok(id) = String::from_utf16(&buffer[..size as usize]) else {
                continue;
            };
            if let Some(folder) = pinned_folder(&namespace, &id) {
                let key = folder.path.trim_end_matches(['\\', '/']).to_lowercase();
                if seen_paths.insert(key) {
                    folders.push(folder);
                }
            }
        }
    }
    folders.sort_by_cached_key(|folder| folder.name.to_lowercase());
    folders
}

fn pinned_folder(namespace: &NamespaceKey, id: &str) -> Option<FolderEntry> {
    GUID::try_from(id.strip_prefix('{')?.strip_suffix('}')?).ok()?;
    let class = format!(r"CLSID\{id}");
    let class_key = wide(&class);
    let class_key = PCWSTR(class_key.as_ptr());
    let mut pinned = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CLASSES_ROOT,
            class_key,
            w!("System.IsPinnedToNameSpaceTree"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut pinned as *mut u32).cast()),
            Some(&mut size),
        )
    };
    if result != ERROR_SUCCESS || pinned != 1 {
        return None;
    }

    // Windows cloud storage shortcuts declare the real directory in this
    // property bag. Read the registration without instantiating its handler.
    let definition = wide(&format!(r"{class}\Instance\InitPropertyBag"));
    let path = text(
        HKEY_CLASSES_ROOT,
        PCWSTR(definition.as_ptr()),
        w!("TargetFolderPath"),
    )?;
    let path = Path::new(&path);
    validate_file_path(path).ok()?;
    let path = nexus_core::clean_path(path);

    let namespace_id = wide(id);
    let name = text(HKEY_CLASSES_ROOT, class_key, PCWSTR::null())
        .or_else(|| text(namespace.0, PCWSTR(namespace_id.as_ptr()), PCWSTR::null()))?;
    Some(FolderEntry { name, path })
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn text(hive: HKEY, key: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut buffer = [0u16; 4096];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            hive,
            key,
            value,
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let end = buffer.iter().position(|&word| word == 0)?;
    let value = String::from_utf16(&buffer[..end]).ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty() && !trimmed.starts_with('@') && !trimmed.chars().any(char::is_control))
        .then(|| trimmed.to_owned())
}

struct NamespaceKey(HKEY);

impl NamespaceKey {
    fn open(hive: HKEY) -> Option<Self> {
        let path = wide(DESKTOP_NAMESPACE);
        let mut handle = HKEY::default();
        let status =
            unsafe { RegOpenKeyExW(hive, PCWSTR(path.as_ptr()), None, KEY_READ, &mut handle) };
        (status == ERROR_SUCCESS).then(|| Self(handle))
    }
}

impl Drop for NamespaceKey {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}
