//! Locate registered DCC applications and conventional installations on local disks.

use std::{
    collections::HashSet,
    env,
    ffi::{c_void, OsStr, OsString},
    fs,
    mem::size_of,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    ptr,
};
use windows::{
    core::{w, PCWSTR, PWSTR},
    Win32::{
        Foundation::ERROR_SUCCESS,
        Storage::FileSystem::{
            GetDriveTypeW, GetFileVersionInfoSizeW, GetFileVersionInfoW, GetLogicalDrives,
            VerQueryValueW, VS_FIXEDFILEINFO,
        },
        System::Registry::{
            RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
            HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_ROUTINE_FLAGS,
            REG_SAM_FLAGS, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY,
            RRF_SUBKEY_WOW6464KEY,
        },
    },
};

const DRIVE_FIXED: u32 = 3;
const UNINSTALL: PCWSTR = w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall");

struct Product {
    names: &'static [&'static str],
    vendors: &'static [&'static str],
    steam: bool,
}

fn product(dcc: &str) -> Option<Product> {
    let (names, vendors, steam): (&[_], &[_], _) = match dcc {
        "blender" => (&["blender"], &["Blender Foundation"], true),
        "c4d" => (&["maxon cinema 4d", "cinema 4d"], &["Maxon"], false),
        "maya" => (&["autodesk maya", "maya"], &["Autodesk"], false),
        "max" => (
            &["autodesk 3ds max", "3ds max", "3dsmax"],
            &["Autodesk"],
            false,
        ),
        "houdini" => (
            &["sidefx houdini", "houdini", "hfs"],
            &["Side Effects Software", "SideFX"],
            false,
        ),
        _ => return None,
    };
    Some(Product {
        names,
        vendors,
        steam,
    })
}

fn matches_product(value: &OsStr, product: &Product) -> bool {
    let name = value.to_string_lossy().to_ascii_lowercase();
    product.names.iter().any(|prefix| name.starts_with(prefix))
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain([0]).collect()
}

fn registered_value(
    root: HKEY,
    key: PCWSTR,
    value: PCWSTR,
    view: REG_ROUTINE_FLAGS,
) -> Option<OsString> {
    let flags = view | RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut size = 0;
    // The registry owns the initial size and fills our caller-allocated UTF-16 buffer.
    if unsafe { RegGetValueW(root, key, value, flags, None, None, Some(&mut size)) }
        != ERROR_SUCCESS
        || !(2..=64 * 1024).contains(&size)
    {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    if unsafe {
        RegGetValueW(
            root,
            key,
            value,
            flags,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    } != ERROR_SUCCESS
    {
        return None;
    }
    let end = buffer.iter().position(|&unit| unit == 0)?;
    (end > 0).then(|| OsString::from_wide(&buffer[..end]))
}

fn registered_executable(value: &OsStr, executable: &str) -> Option<PathBuf> {
    let raw = value.to_string_lossy();
    let raw = raw.trim();
    let path = if let Some(quoted) = raw.strip_prefix('"') {
        quoted.split_once('"')?.0
    } else {
        raw.rsplit_once(',')
            .filter(|(_, index)| index.trim().parse::<i32>().is_ok())
            .map_or(raw, |(path, _)| path.trim())
    };
    let mut path = PathBuf::from(path);
    if path.is_absolute() && path.extension().is_none() {
        path.set_extension("exe");
    }
    let name = path.file_name()?.to_str()?;
    (path.is_absolute() && name.eq_ignore_ascii_case(executable)).then_some(path)
}

fn app_paths(executable: &str) -> Vec<PathBuf> {
    let key = wide(OsStr::new(&format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{executable}"
    )));
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .flat_map(|root| {
            [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY]
                .into_iter()
                .filter_map({
                    let key = &key;
                    move |view| {
                        let value =
                            registered_value(root, PCWSTR(key.as_ptr()), PCWSTR::null(), view)?;
                        registered_executable(&value, executable)
                    }
                })
        })
        .collect()
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        // RegistryKey is only constructed from a successful RegOpenKeyExW.
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn uninstall_locations(
    root: HKEY,
    view: REG_SAM_FLAGS,
    product: &Product,
    executable: &str,
) -> Vec<PathBuf> {
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(root, UNINSTALL, None, KEY_READ | view, &mut key) } != ERROR_SUCCESS {
        return Vec::new();
    }
    let key = RegistryKey(key);
    let mut paths = Vec::new();
    for index in 0..4096 {
        let mut name = [0u16; 256];
        let mut length = name.len() as u32;
        // Windows limits subkey names to 255 characters plus their null terminator.
        if unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut length,
                None,
                None,
                None,
                None,
            )
        } != ERROR_SUCCESS
        {
            break;
        }
        let name = PCWSTR(name.as_ptr());
        let flags = REG_ROUTINE_FLAGS(0);
        let display = registered_value(key.0, name, w!("DisplayName"), flags);
        if !display.is_some_and(|value| matches_product(&value, product)) {
            continue;
        }
        if let Some(location) = registered_value(key.0, name, w!("InstallLocation"), flags) {
            let location = PathBuf::from(location);
            if location.is_absolute() {
                paths.extend(installation_executables(&location, executable));
            }
        }
        if let Some(icon) = registered_value(key.0, name, w!("DisplayIcon"), flags)
            .and_then(|value| registered_executable(&value, executable))
        {
            paths.push(icon);
        }
    }
    paths
}

fn installation_executables(folder: &Path, executable: &str) -> [PathBuf; 2] {
    [folder.join(executable), folder.join("bin").join(executable)]
}

fn fixed_volumes() -> impl Iterator<Item = PathBuf> {
    let drives = unsafe { GetLogicalDrives() };
    (0..26)
        .filter(move |index| drives & (1 << index) != 0)
        .filter_map(|index| {
            let root = [(b'A' + index) as u16, b':' as u16, b'\\' as u16, 0];
            (unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } == DRIVE_FIXED)
                .then(|| PathBuf::from(OsString::from_wide(&root[..3])))
        })
}

fn named_folders<'a>(directory: &Path, product: &'a Product) -> impl Iterator<Item = PathBuf> + 'a {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(move |entry| matches_product(&entry.file_name(), product))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
}

fn disk_locations(root: &Path, product: &Product, executable: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    // Examine one named application directory and, when present, one vendor directory below it.
    for relative in [
        "",
        "Program Files",
        "Program Files (x86)",
        "Programs",
        "Software",
        "Applications",
        "软件",
    ] {
        let directory = root.join(relative);
        for product_root in named_folders(&directory, product) {
            paths.extend(installation_executables(&product_root, executable));
        }
        for vendor in product.vendors {
            let vendor = directory.join(vendor);
            paths.extend(installation_executables(&vendor, executable));
            for product_root in named_folders(&vendor, product) {
                paths.extend(installation_executables(&product_root, executable));
            }
        }
        if product.steam {
            paths.push(
                directory
                    .join("Steam/steamapps/common/Blender")
                    .join(executable),
            );
        }
    }
    paths
}

pub(super) fn directories(dcc: &str, executable: &str) -> Vec<PathBuf> {
    let Some(product) = product(dcc) else {
        return Vec::new();
    };
    let mut candidates = app_paths(executable);
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(
            env::split_paths(&path)
                .filter(|root| root.is_absolute())
                .map(|root| root.join(executable)),
        );
    }
    for registry in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            candidates.extend(uninstall_locations(registry, view, &product, executable));
        }
    }
    for volume in fixed_volumes() {
        candidates.extend(disk_locations(&volume, &product, executable));
    }
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| candidate.is_file())
        .filter_map(|candidate| {
            let parent = candidate.parent()?;
            let key = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_owned());
            seen.insert(key).then(|| parent.to_owned())
        })
        .collect()
}

pub(super) fn file_version(path: &Path) -> Option<(u16, u16, u16, u16)> {
    let path = wide(path.as_os_str());
    let path = PCWSTR(path.as_ptr());
    let size = unsafe { GetFileVersionInfoSizeW(path, None) };
    if !(size_of::<VS_FIXEDFILEINFO>() as u32..=4 * 1024 * 1024).contains(&size) {
        return None;
    }
    let mut disk = vec![0u8; size as usize];
    unsafe { GetFileVersionInfoW(path, None, size, disk.as_mut_ptr().cast()) }.ok()?;
    let mut fixed = ptr::null_mut::<c_void>();
    let mut length = 0;
    // The root query returns a VS_FIXEDFILEINFO record within the version resource buffer.
    if !unsafe { VerQueryValueW(disk.as_ptr().cast(), w!("\\"), &mut fixed, &mut length) }.as_bool()
        || length < size_of::<VS_FIXEDFILEINFO>() as u32
    {
        return None;
    }
    let offset = (fixed as usize).checked_sub(disk.as_ptr() as usize)?;
    if offset.checked_add(size_of::<VS_FIXEDFILEINFO>())? > disk.len() {
        return None;
    }
    let info = unsafe { fixed.cast::<VS_FIXEDFILEINFO>().read_unaligned() };
    if info.dwSignature != 0xFEEF04BD {
        return None;
    }
    let (major_minor, patch_build) = if info.dwProductVersionMS != 0 {
        (info.dwProductVersionMS, info.dwProductVersionLS)
    } else {
        (info.dwFileVersionMS, info.dwFileVersionLS)
    };
    (major_minor != 0).then_some((
        (major_minor >> 16) as u16,
        major_minor as u16,
        (patch_build >> 16) as u16,
        patch_build as u16,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_quoted_registry_and_icon_paths() {
        for path in [
            r#""D:\三维软件\Blender 4.5\blender.exe",0"#,
            r"D:\三维软件\Blender 4.5\blender.exe,-1",
            r"D:\三维软件\Blender 4.5\blender",
        ] {
            assert_eq!(
                registered_executable(OsStr::new(path), "blender.exe").as_deref(),
                Some(Path::new(r"D:\三维软件\Blender 4.5\blender.exe")),
            );
        }
        for path in [r"D:\Blender\uninstall.exe", r"Blender\blender.exe"] {
            assert!(registered_executable(OsStr::new(path), "blender.exe").is_none());
        }
    }

    #[test]
    fn finds_alternate_drive_layouts_without_recursive_walk() {
        let root = tempfile::tempdir().unwrap();
        for (dcc, executable, relative) in [
            ("blender", "blender.exe", "软件/Blender 4.5/blender.exe"),
            (
                "c4d",
                "Cinema 4D.exe",
                "Maxon/Maxon Cinema 4D 2026/Cinema 4D.exe",
            ),
            ("maya", "maya.exe", "Autodesk/Maya2026/bin/maya.exe"),
            (
                "max",
                "3dsmax.exe",
                "Program Files/Autodesk/3ds Max 2026/3dsmax.exe",
            ),
            (
                "houdini",
                "houdini.exe",
                "Software/SideFX/Houdini21.0/bin/houdini.exe",
            ),
        ] {
            let path = root.path().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"fixture").unwrap();
            let product = product(dcc).unwrap();
            assert!(disk_locations(root.path(), &product, executable).contains(&path));
        }
    }
}
