use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct NewTemplate {
    id: String,
    label: String,
    extension: String,
}

#[tauri::command]
pub(crate) async fn local_explorer_new_templates() -> Result<Vec<NewTemplate>, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(windows_new::templates)
        .await
        .map_err(|error| error.to_string());
    #[cfg(not(windows))]
    Ok(Vec::new())
}

#[tauri::command]
pub(crate) async fn local_explorer_create_item(
    directory_path: String,
    name: String,
    template_id: String,
    target: Option<String>,
) -> Result<String, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        windows_new::create(directory_path, name, template_id, target)
    })
    .await
    .map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = (directory_path, name, template_id, target);
        Err("当前平台不支持 Windows 新建项目".into())
    }
}

#[cfg(windows)]
mod windows_new {
    use super::NewTemplate;
    use crate::local_explorer::validate_file_path;
    use std::{
        ffi::{OsStr, OsString},
        fs::{self, File},
        io::{self, Read, Write},
        os::windows::ffi::{OsStrExt, OsStringExt},
        path::{Component, Path, PathBuf, Prefix},
    };
    use windows::{
        core::{w, GUID, PCWSTR, PWSTR},
        Win32::{
            Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS},
            System::{
                Com::CoTaskMemFree,
                Registry::{
                    RegEnumKeyExW, RegGetValueW, HKEY_CLASSES_ROOT, REG_ROUTINE_FLAGS, RRF_RT_ANY,
                    RRF_RT_REG_BINARY, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
                },
            },
            UI::Shell::{
                FOLDERID_CommonTemplates, FOLDERID_LocalAppData, FOLDERID_ProgramFiles,
                FOLDERID_ProgramFilesX86, FOLDERID_Templates, FOLDERID_Windows,
                SHGetKnownFolderPath, KF_FLAG_DONT_VERIFY,
            },
        },
    };

    const MAX_REGISTRY_KEYS: u32 = 8192;
    const MAX_MENU_TEMPLATES: usize = 60;
    const MAX_INLINE_BYTES: u32 = 4 * 1024 * 1024;
    const MAX_TEMPLATE_BYTES: u64 = 32 * 1024 * 1024;
    const STRING_TYPES: REG_ROUTINE_FLAGS =
        REG_ROUTINE_FLAGS(RRF_RT_REG_SZ.0 | RRF_RT_REG_EXPAND_SZ.0);

    enum TemplateData {
        Empty,
        Data(String),
        File(PathBuf),
    }

    fn item(id: &str, label: &str, extension: &str) -> NewTemplate {
        NewTemplate {
            id: id.into(),
            label: label.into(),
            extension: extension.into(),
        }
    }

    pub(super) fn templates() -> Vec<NewTemplate> {
        let mut base = vec![
            item("shortcut", "快捷方式", ".lnk"),
            item("text", "文本文档", ".txt"),
        ];
        let roots = template_roots();
        let mut installed = Vec::new();
        let mut name = [0u16; 256];
        for index in 0..MAX_REGISTRY_KEYS {
            let mut length = name.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    HKEY_CLASSES_ROOT,
                    index,
                    Some(PWSTR(name.as_mut_ptr())),
                    &mut length,
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
            if name[0] != b'.' as u16 {
                continue;
            }
            let Ok(extension) = String::from_utf16(&name[..length as usize]) else {
                continue;
            };
            let extension = extension.to_ascii_lowercase();
            if !safe_extension(&extension) {
                continue;
            }
            if let Some((_, label)) = registered_template(&extension, &roots) {
                installed.push(item(&format!("shell:{extension}"), &label, &extension));
            }
        }
        installed.sort_by(|left, right| {
            (&left.label, &left.extension).cmp(&(&right.label, &right.extension))
        });
        base.extend(installed.into_iter().take(MAX_MENU_TEMPLATES));
        base
    }

    pub(super) fn create(
        directory: String,
        name: String,
        id: String,
        target: Option<String>,
    ) -> Result<String, String> {
        let directory = checked_path(&directory)?;
        if !fs::metadata(directory).map_err(io_error)?.is_dir() {
            return Err("请选择现有文件夹".into());
        }
        let extension = match id.as_str() {
            "text" => ".txt",
            "shortcut" => ".lnk",
            _ => id
                .strip_prefix("shell:")
                .filter(|ext| safe_extension(ext))
                .ok_or("此新建类型不可用")?,
        };
        let destination = destination(directory, &name, extension)?;
        let mut draft = tempfile::Builder::new();
        draft.prefix(".nexus-new-");

        if id == "shortcut" {
            let target = target.as_deref().ok_or("请输入快捷方式目标")?.trim();
            let target = checked_path(target.trim_matches('"'))?;
            let metadata = fs::metadata(target).map_err(io_error)?;
            if !metadata.is_file() && !metadata.is_dir() {
                return Err("快捷方式目标必须是文件或文件夹".into());
            }
            let draft = draft
                .suffix(extension)
                .tempfile_in(directory)
                .map_err(io_error)?
                .into_temp_path();
            crate::desktop_shortcut::write_file_shortcut(&draft, target)?;
            draft
                .persist_noclobber(&destination)
                .map_err(|error| io_error(error.error))?;
        } else {
            let data = if id == "text" {
                TemplateData::Empty
            } else {
                registered_template(extension, &template_roots())
                    .map(|(data, _)| data)
                    .ok_or("此新建模板已不可用")?
            };
            let mut draft = draft.tempfile_in(directory).map_err(io_error)?;
            write_template(data, &mut draft)?;
            draft
                .persist_noclobber(&destination)
                .map_err(|error| io_error(error.error))?;
        }
        Ok(nexus_core::clean_path(&destination))
    }

    fn checked_path(value: &str) -> Result<&Path, String> {
        if value.len() > 32_768 {
            return Err("文件路径过长".into());
        }
        let path = Path::new(value);
        validate_file_path(path)?;
        Ok(path)
    }

    fn destination(directory: &Path, name: &str, extension: &str) -> Result<PathBuf, String> {
        if name.is_empty()
            || name.ends_with([' ', '.'])
            || name.contains(['\\', '/'])
            || Path::new(name).file_name() != Some(OsStr::new(name))
        {
            return Err("请输入有效的文件名称".into());
        }
        let file_name = if name.to_ascii_lowercase().ends_with(extension) {
            name.to_owned()
        } else {
            format!("{name}{extension}")
        };
        if file_name.encode_utf16().count() > 255 {
            return Err("文件名过长".into());
        }
        let path = directory.join(file_name);
        validate_file_path(&path)?;
        Ok(path)
    }

    fn io_error(error: io::Error) -> String {
        if error.kind() == io::ErrorKind::AlreadyExists {
            return "已存在同名文件或文件夹".into();
        }
        format!("无法新建项目（{error}）")
    }

    fn safe_extension(extension: &str) -> bool {
        let Some(ext) = extension.strip_prefix('.') else {
            return false;
        };
        !ext.is_empty()
            && ext.len() <= 24
            && ext
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && nexus_core::kind(ext) != Some("script")
            && !matches!(
                ext,
                "txt"
                    | "lnk"
                    | "url"
                    | "exe"
                    | "dll"
                    | "com"
                    | "scr"
                    | "cpl"
                    | "msi"
                    | "msix"
                    | "reg"
                    | "hta"
                    | "bat"
                    | "cmd"
                    | "ps1"
                    | "vbs"
                    | "scf"
                    | "pif"
                    | "desktop"
            )
    }

    fn registered_template(
        extension: &str,
        roots: &TemplateRoots,
    ) -> Option<(TemplateData, String)> {
        let class = registry_string(extension, PCWSTR::null())
            .filter(|value| !value.is_empty() && !value.contains(['\\', '/', '\0']));
        let direct = format!(r"{extension}\ShellNew");
        let nested = class
            .as_ref()
            .map(|class| format!(r"{extension}\{class}\ShellNew"));
        let data = [Some(direct), nested]
            .into_iter()
            .flatten()
            .find_map(|key| shell_new_data(&key, extension, roots))?;
        let label = class
            .as_ref()
            .and_then(|class| registry_string(class, PCWSTR::null()))
            .filter(|label| !label.trim().is_empty() && !label.trim_start().starts_with('@'))
            .unwrap_or_else(|| format!("{} 文件", extension[1..].to_ascii_uppercase()));
        Some((data, label.chars().take(80).collect()))
    }

    fn shell_new_data(key: &str, extension: &str, roots: &TemplateRoots) -> Option<TemplateData> {
        let inline = || {
            registry_size(key, w!("Data"), RRF_RT_REG_BINARY)
                .filter(|&size| size <= MAX_INLINE_BYTES)
                .map(|_| TemplateData::Data(key.to_owned()))
        };
        let data = if registry_size(key, w!("NullFile"), RRF_RT_ANY).is_some() {
            // The standard Windows ZIP registration includes the empty archive
            // record in Data alongside NullFile. A zero-byte ZIP is not an archive.
            if extension == ".zip" {
                inline()?
            } else {
                TemplateData::Empty
            }
        } else if let Some(filename) = registry_string(key, w!("FileName")) {
            TemplateData::File(roots.resolve(&filename)?)
        } else {
            inline()?
        };
        (registry_size(key, w!("Command"), RRF_RT_ANY).is_none()
            && registry_size(key, w!("Handler"), RRF_RT_ANY).is_none())
        .then_some(data)
    }

    fn registry_size(key: &str, value: PCWSTR, flags: REG_ROUTINE_FLAGS) -> Option<u32> {
        let key = wide(OsStr::new(key));
        let mut size = 0;
        let result = unsafe {
            RegGetValueW(
                HKEY_CLASSES_ROOT,
                PCWSTR(key.as_ptr()),
                value,
                flags,
                None,
                None,
                Some(&mut size),
            )
        };
        (result == ERROR_SUCCESS).then_some(size)
    }

    fn registry_string(key: &str, value: PCWSTR) -> Option<String> {
        let key = wide(OsStr::new(key));
        let mut data = [0u16; 4096];
        let mut size = (data.len() * 2) as u32;
        let result = unsafe {
            RegGetValueW(
                HKEY_CLASSES_ROOT,
                PCWSTR(key.as_ptr()),
                value,
                STRING_TYPES,
                None,
                Some(data.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if result != ERROR_SUCCESS {
            return None;
        }
        let end = data.iter().position(|&unit| unit == 0)?;
        String::from_utf16(&data[..end]).ok()
    }

    fn write_template(data: TemplateData, file: &mut impl Write) -> Result<(), String> {
        match data {
            TemplateData::Empty => Ok(()),
            TemplateData::Data(key) => {
                let mut size = registry_size(&key, w!("Data"), RRF_RT_REG_BINARY)
                    .filter(|&size| size <= MAX_INLINE_BYTES)
                    .ok_or("此新建模板已不可用")?;
                let mut bytes = vec![0u8; size as usize];
                let key = wide(OsStr::new(&key));
                let result = unsafe {
                    RegGetValueW(
                        HKEY_CLASSES_ROOT,
                        PCWSTR(key.as_ptr()),
                        w!("Data"),
                        RRF_RT_REG_BINARY,
                        None,
                        Some(bytes.as_mut_ptr().cast()),
                        Some(&mut size),
                    )
                };
                if result != ERROR_SUCCESS {
                    return Err("此新建模板已不可用".into());
                }
                bytes.truncate(size as usize);
                file.write_all(&bytes).map_err(io_error)
            }
            TemplateData::File(path) => {
                let template = File::open(path).map_err(io_error)?;
                let copied =
                    io::copy(&mut template.take(MAX_TEMPLATE_BYTES + 1), file).map_err(io_error)?;
                if copied > MAX_TEMPLATE_BYTES {
                    return Err("此新建模板的文件过大".into());
                }
                Ok(())
            }
        }
    }

    struct TemplateRoots {
        defaults: Vec<PathBuf>,
        allowed: Vec<PathBuf>,
        canonical: Vec<PathBuf>,
        user_apps: Option<(PathBuf, PathBuf)>,
    }

    fn template_roots() -> TemplateRoots {
        let defaults = [
            known_folder(&FOLDERID_Templates),
            known_folder(&FOLDERID_CommonTemplates),
            known_folder(&FOLDERID_Windows).map(|path| path.join("ShellNew")),
        ]
        .into_iter()
        .flatten()
        .filter(|path| disk_path(path))
        .collect::<Vec<_>>();
        let allowed = defaults
            .iter()
            .cloned()
            .chain(
                [FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86]
                    .iter()
                    .filter_map(known_folder)
                    .filter(|path| disk_path(path)),
            )
            .collect::<Vec<_>>();
        let canonical = allowed
            .iter()
            .filter_map(|path| fs::canonicalize(path).ok())
            .filter(|path| disk_path(path))
            .collect();
        let user_apps = known_folder(&FOLDERID_LocalAppData)
            .filter(|path| disk_path(path))
            .and_then(|path| {
                let canonical = fs::canonicalize(&path).ok()?;
                disk_path(&canonical).then(|| (comparable_path(&path), canonical))
            });
        TemplateRoots {
            defaults,
            allowed,
            canonical,
            user_apps,
        }
    }

    impl TemplateRoots {
        fn resolve(&self, name: &str) -> Option<PathBuf> {
            let path = Path::new(name.trim_matches('"'));
            if path.is_absolute() {
                return self.local_file(path);
            }
            if !matches!(path.components().next(), Some(Component::Normal(_)))
                || path.components().count() != 1
            {
                return None;
            }
            self.defaults
                .iter()
                .find_map(|directory| self.local_file(&directory.join(path)))
        }

        fn local_file(&self, path: &Path) -> Option<PathBuf> {
            if !disk_path(path)
                || validate_file_path(path).is_err()
                || path.components().any(|part| part == Component::ParentDir)
            {
                return None;
            }
            let comparable = comparable_path(path);
            if !self
                .allowed
                .iter()
                .any(|root| comparable.starts_with(comparable_path(root)))
                && !self
                    .user_apps
                    .as_ref()
                    .is_some_and(|(root, _)| app_template(&comparable, root))
            {
                return None;
            }
            let canonical = fs::canonicalize(path).ok()?;
            if !self
                .canonical
                .iter()
                .any(|root| canonical.starts_with(root))
                && !self
                    .user_apps
                    .as_ref()
                    .is_some_and(|(_, root)| app_template(&canonical, root))
            {
                return None;
            }
            let metadata = fs::metadata(&canonical).ok()?;
            (metadata.is_file() && metadata.len() <= MAX_TEMPLATE_BYTES).then_some(canonical)
        }
    }

    fn comparable_path(path: &Path) -> PathBuf {
        PathBuf::from(nexus_core::clean_path(path).to_lowercase())
    }

    fn app_template(path: &Path, root: &Path) -> bool {
        path.strip_prefix(root)
            .ok()
            .and_then(Path::parent)
            .is_some_and(|parent| {
                // Per-user applications such as WPS may use LocalAppData, but
                // the registry must point to a template directory inside the app.
                parent.components().skip(1).any(|component| {
                    component.as_os_str().to_str().is_some_and(|part| {
                        part.eq_ignore_ascii_case("templates")
                            || part.eq_ignore_ascii_case("shellnew")
                    })
                })
            })
    }

    fn disk_path(path: &Path) -> bool {
        matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
    }

    fn known_folder(id: &GUID) -> Option<PathBuf> {
        let path = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY, None) }.ok()?;
        let result = unsafe { PathBuf::from(OsString::from_wide(path.as_wide())) };
        unsafe { CoTaskMemFree(Some(path.0.cast())) };
        Some(result)
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain([0]).collect()
    }
}
