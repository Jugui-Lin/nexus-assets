use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DropEffect {
    Copy,
    Move,
}

#[cfg(windows)]
pub(super) static FILE_OPERATION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[cfg(windows)]
#[derive(Debug)]
enum CatalogRename {
    None,
    File,
    Folder(FolderRemap),
}

#[cfg(windows)]
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderRemap {
    library_id: String,
    from: String,
    to: String,
}

#[tauri::command]
pub(crate) async fn local_explorer_drop_files(
    window: tauri::Window,
    paths: Vec<String>,
    directory_path: String,
    effect: DropEffect,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        if !(1..=crate::local_explorer::MAX_ENTRIES).contains(&paths.len()) {
            return Err("选中的文件数量超出可处理范围".into());
        }
        let permit = FILE_OPERATION
            .try_acquire()
            .map_err(|_| "请等当前文件操作完成")?;
        let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            windows_drop::transfer(owner, paths, directory_path, effect)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, paths, directory_path, effect);
        Err("当前平台暂不支持拖放文件操作".into())
    }
}

#[tauri::command]
pub(crate) async fn local_explorer_file_action(
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
    action: String,
    path: String,
    name: Option<String>,
    paths: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        if let Some(paths) = &paths {
            if action != "trash" {
                return Err("不支持此批量文件操作".into());
            }
            if !(1..=crate::local_explorer::MAX_ENTRIES).contains(&paths.len()) {
                return Err("选中的文件数量超出可处理范围".into());
            }
        }
        let permit = FILE_OPERATION
            .try_acquire()
            .map_err(|_| "请等当前文件操作完成")?;
        let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let state = state.inner().clone();
        let (result, catalog_rename) = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            if let Some(paths) = paths {
                return windows_drop::trash(owner, paths.iter().map(std::path::Path::new))
                    .map(|()| (None, CatalogRename::None));
            }
            windows_drop::file_action(&state, owner, &action, &path, name.as_deref())
        })
        .await
        .map_err(|error| error.to_string())??;
        match catalog_rename {
            CatalogRename::None => {}
            CatalogRename::File => {
                let _ = window.emit("nexus-personal-catalog-changed", ());
            }
            CatalogRename::Folder(remap) => {
                let _ = window.emit("nexus-personal-catalog-changed", remap);
            }
        }
        Ok(result)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, state, action, path, name, paths);
        Err("当前平台暂不支持此文件操作".into())
    }
}

#[cfg(windows)]
mod windows_drop {
    use super::{CatalogRename, DropEffect, FolderRemap};
    use crate::workspace_folder_move::{link_or_reparse, move_local_folder, rename_no_replace};
    use nexus_core::{clean_path, relative_folder, Asset, Catalog};
    use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
    use same_file::Handle;
    use std::{
        collections::HashSet,
        ffi::OsStr,
        fs, io,
        os::windows::ffi::OsStrExt,
        path::{Component, Path, PathBuf, Prefix},
    };
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::HWND,
            Storage::FileSystem::GetDriveTypeW,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, IBindCtx, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::{
                Shell::{
                    FileOperation, IFileOperation, IFileOperationProgressSink, IShellItem,
                    SHCreateItemFromParsingName, SHQueryRecycleBinW, ShellExecuteExW,
                    FOFX_ADDUNDORECORD, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE,
                    FOF_NOCONFIRMMKDIR, FOF_NOERRORUI, FOF_NO_CONNECTED_ELEMENTS,
                    SEE_MASK_FLAG_NO_UI, SEE_MASK_INVOKEIDLIST, SEE_MASK_NOASYNC,
                    SHELLEXECUTEINFOW, SHQUERYRBINFO,
                },
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
    };

    struct Apartment;

    impl Apartment {
        fn initialize() -> windows::core::Result<Self> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
            Ok(Self)
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn path_key(canonical: &Path) -> PathBuf {
        PathBuf::from(nexus_core::clean_path(canonical).to_lowercase())
    }

    fn canonical_path(path: &Path) -> Result<PathBuf, String> {
        crate::local_explorer::validate_file_path(path)?;
        fs::canonicalize(path).map_err(|error| format!("无法读取「{}」（{error}）", path.display()))
    }

    fn child_path(directory: &Path, name: &str) -> Result<PathBuf, String> {
        if Path::new(name).file_name() != Some(OsStr::new(name)) || name.ends_with(['.', ' ']) {
            return Err("请输入一个有效的文件或文件夹名称".into());
        }
        let child = directory.join(name);
        crate::local_explorer::validate_file_path(&child)?;
        Ok(child)
    }

    fn existing_item(path: &Path) -> Result<PathBuf, String> {
        crate::local_explorer::validate_file_path(path)?;
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Err("请选择文件或文件夹".into());
        };
        // Resolve the parent without following a junction or symlink at the item itself.
        let item = canonical_path(parent)?.join(name);
        fs::symlink_metadata(&item)
            .map_err(|error| format!("无法读取「{}」（{error}）", path.display()))?;
        Ok(item)
    }

    fn new_folder(directory: &Path, name: Option<&str>) -> Result<String, String> {
        let parent = canonical_path(directory)?;
        if !parent.is_dir() {
            return Err("请选择现有文件夹".into());
        }
        for number in 1..=u32::MAX {
            let candidate = match (name, number) {
                (Some(name), _) => name.to_owned(),
                (None, 1) => "新建文件夹".into(),
                (None, number) => format!("新建文件夹 ({number})"),
            };
            let child = child_path(&parent, &candidate)?;
            match fs::create_dir(&child) {
                Ok(()) => return Ok(nexus_core::clean_path(&directory.join(candidate))),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists && name.is_none() => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    return Err("已存在同名文件或文件夹".into());
                }
                Err(error) => return Err(format!("无法新建文件夹（{error}）")),
            }
        }
        Err("无法取得可用的文件夹名称".into())
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }

    fn rename(
        catalog: &Catalog,
        app_data: &Path,
        path: &Path,
        name: &str,
    ) -> Result<(String, CatalogRename), String> {
        let source = existing_item(path)?;
        let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
        let reparse = link_or_reparse(&metadata);
        let source = if reparse {
            source
        } else {
            canonical_path(&source)?
        };
        let parent = source.parent().ok_or("请选择要重命名的文件或文件夹")?;
        let destination = child_path(parent, name)?;
        let result = clean_path(&path.with_file_name(name));
        if source == destination {
            return Ok((result, CatalogRename::None));
        }
        let catalog_rename = if metadata.is_dir() {
            rename_catalog_folder(catalog, app_data, &source, name, reparse)?
        } else {
            rename_catalog_file(catalog, &source, &destination, reparse)?
        };
        if matches!(catalog_rename, CatalogRename::None) {
            rename_no_replace(&source, &destination)
                .map_err(|error| format!("无法重命名（{error}）"))?;
        }
        Ok((result, catalog_rename))
    }

    fn rename_catalog_folder(
        catalog: &Catalog,
        app_data: &Path,
        source: &Path,
        name: &str,
        reparse: bool,
    ) -> Result<CatalogRename, String> {
        let source_key = path_key(source);
        let registered = {
            let mut roots = catalog
                .conn
                .prepare("SELECT id,path FROM libraries")
                .map_err(|error| error.to_string())?;
            let libraries = roots
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| error.to_string())?;
            let mut registered = None;
            for library in libraries {
                let (id, path) = library.map_err(|error| error.to_string())?;
                let root = Path::new(&path);
                let root_key = path_key(root);
                if root_key.starts_with(&source_key) {
                    return Err("请先在资产库中调整链接，避免重命名使资产脱离原目录".into());
                }
                if let Some(relative) = relative_folder(root, source) {
                    let depth = root_key.components().count();
                    if registered.as_ref().is_none_or(|(best, _, _)| depth > *best) {
                        registered = Some((depth, id, relative));
                    }
                }
            }
            registered
        };
        if let Some((_, id, folder)) = registered {
            require_local_rename(source, reparse)?;
            let parent = folder.rsplit_once('/').map_or("", |(parent, _)| parent);
            let to = move_local_folder(catalog, app_data, &id, &folder, parent, Some(name))?;
            return Ok(CatalogRename::Folder(FolderRemap {
                library_id: id,
                from: folder,
                to,
            }));
        }
        let prefix = format!("{}\\", clean_path(source));
        let contains_indexed: bool = catalog
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE substr(path,1,length(?1))=?1)",
                [prefix],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if contains_indexed {
            return Err("此文件夹包含已入库的独立文件。请先在资产库中调整这些文件的位置".into());
        }
        Ok(CatalogRename::None)
    }

    fn require_local_rename(source: &Path, reparse: bool) -> Result<(), String> {
        if reparse
            || !disk_root(source)
                .is_some_and(|root| unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } == 3)
        {
            return Err("此已入库位置暂不支持在文件页直接重命名，请在资产库中管理".into());
        }
        Ok(())
    }

    fn rename_catalog_file(
        catalog: &Catalog,
        source: &Path,
        destination: &Path,
        reparse: bool,
    ) -> Result<CatalogRename, String> {
        let source_path = clean_path(source);
        let previous: Option<String> = catalog
            .conn
            .query_row(
                "SELECT data FROM assets WHERE path=?1",
                [&source_path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(previous) = previous else {
            return Ok(CatalogRename::None);
        };
        let asset: Asset = serde_json::from_str(&previous).map_err(|error| error.to_string())?;
        require_local_rename(source, reparse)?;
        if asset.demo {
            return Err("示例资产不能在文件页重命名".into());
        }
        if !destination
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|ext| ext.eq_ignore_ascii_case(&asset.ext))
        {
            return Err(format!("已入库文件重命名时请保留 .{} 扩展名", asset.ext));
        }
        let identity = Handle::from_path(source)
            .map_err(|error| format!("无法识别要重命名的文件（{error}）"))?;
        let transaction = Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let name = if source.file_stem().and_then(OsStr::to_str) == Some(asset.name.as_str()) {
            destination
                .file_stem()
                .and_then(OsStr::to_str)
                .unwrap_or(&asset.name)
        } else {
            &asset.name
        };
        let destination_path = clean_path(destination);
        let changed = transaction
            .execute(
                "UPDATE assets SET path=?1,name=?2,data=json_set(data,'$.path',?1,'$.name',?2)
             WHERE id=?3 AND path=?4",
                params![destination_path, name, asset.id, source_path],
            )
            .map_err(|error| format!("无法调整资产索引（{error}）"))?;
        if changed != 1 || !Handle::from_path(source).is_ok_and(|current| current == identity) {
            return Err("源文件或资产记录已更换，请刷新后重试".into());
        }
        rename_no_replace(source, destination).map_err(|error| format!("无法重命名（{error}）"))?;
        if !Handle::from_path(destination).is_ok_and(|current| current == identity) {
            return Err(format!(
                "目标文件在重命名期间发生变化，请检查此路径：{destination_path}"
            ));
        }
        if let Err(error) = transaction.commit() {
            if !Handle::from_path(destination).is_ok_and(|current| current == identity) {
                return Err(format!(
                    "保存资产索引失败且目标文件已变化，请检查此路径：{destination_path}（{error}）"
                ));
            }
            return match rename_no_replace(destination, source) {
                Ok(()) => Err(format!("保存资产索引失败，已恢复原文件名（{error}）")),
                Err(rollback) => Err(format!("保存资产索引失败且无法恢复原文件名，请检查 {destination_path}（{error}，{rollback}）")),
            };
        }
        Ok(CatalogRename::File)
    }

    fn disk_root(path: &Path) -> Option<[u16; 4]> {
        let Component::Prefix(prefix) = path.components().next()? else {
            return None;
        };
        let letter = match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
            _ => return None,
        };
        Some([
            u16::from(letter.to_ascii_uppercase()),
            u16::from(b':'),
            u16::from(b'\\'),
            0,
        ])
    }

    fn verify_recycle_root(path: &Path, checked: &mut HashSet<[u16; 4]>) -> Result<(), String> {
        let root = disk_root(path).ok_or("此位置不支持回收站")?;
        if !checked.insert(root) {
            return Ok(());
        }
        let mut info = SHQUERYRBINFO {
            cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
            ..Default::default()
        };
        // Network shares have no local Recycle Bin. Treat unavailable local bins as unsupported.
        let root = PCWSTR(root.as_ptr());
        if unsafe { GetDriveTypeW(root) } != 3
            || unsafe { SHQueryRecycleBinW(root, &mut info) }.is_err()
        {
            return Err("此位置不支持回收站".into());
        }
        Ok(())
    }

    pub(super) fn trash<'a>(
        owner: isize,
        paths: impl IntoIterator<Item = &'a Path>,
    ) -> Result<(), String> {
        let _apartment = Apartment::initialize()
            .map_err(|error| format!("无法打开 Windows 文件操作（{error}）"))?;
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut checked_roots = HashSet::new();
        for path in paths {
            verify_recycle_root(path, &mut checked_roots)?;
            let item = existing_item(path)?;
            let key = path_key(&item);
            if key != path_key(path) {
                verify_recycle_root(&item, &mut checked_roots)?;
            }
            if seen.insert(key) {
                items.push(item);
            }
        }
        let prepare = || -> windows::core::Result<IFileOperation> {
            let operation: IFileOperation =
                unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)? };
            unsafe {
                operation.SetOwnerWindow(HWND(owner as _))?;
                // The recycle-only flag requires the bin. Do not offer a permanent-delete fallback.
                operation.SetOperationFlags(
                    FOFX_RECYCLEONDELETE
                        | FOF_NOERRORUI
                        | FOFX_EARLYFAILURE
                        | FOF_NO_CONNECTED_ELEMENTS,
                )?;
            }
            for item in items {
                let item = shell_item(&item)?;
                unsafe {
                    operation.DeleteItem(&item, None::<&IFileOperationProgressSink>)?;
                }
            }
            Ok(operation)
        };
        let operation = prepare().map_err(|error| format!("无法移入回收站（{error}）"))?;
        perform_operations(&operation).map_err(|error| format!("无法移入回收站（{error}）"))
    }

    fn show_properties(owner: HWND, path: &Path) -> Result<(), String> {
        crate::local_explorer::validate_file_path(path)?;
        fs::symlink_metadata(path)
            .map_err(|error| format!("无法读取「{}」（{error}）", path.display()))?;
        let _apartment = Apartment::initialize()
            .map_err(|error| format!("无法打开 Windows 文件属性（{error}）"))?;
        let path = wide_path(Path::new(&nexus_core::clean_path(path)));
        let mut execute = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            hwnd: owner,
            lpVerb: w!("properties"),
            lpFile: PCWSTR(path.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        unsafe { ShellExecuteExW(&mut execute) }
            .map_err(|error| format!("无法打开 Windows 文件属性（{error}）"))
    }

    pub(super) fn file_action(
        state: &crate::AppState,
        owner: isize,
        action: &str,
        path: &str,
        name: Option<&str>,
    ) -> Result<(Option<String>, CatalogRename), String> {
        let path = Path::new(path);
        match action {
            "new-folder" => new_folder(path, name).map(|path| (Some(path), CatalogRename::None)),
            "rename" => {
                let _workspace = crate::workspaces::lock_io(state)?;
                let catalog = crate::lock_db(state)?;
                let (result, catalog_rename) =
                    rename(&catalog, &state.root, path, name.ok_or("请输入新的名称")?)?;
                Ok((Some(result), catalog_rename))
            }
            "trash" => trash(owner, std::iter::once(path)).map(|()| (None, CatalogRename::None)),
            "properties" => {
                show_properties(HWND(owner as _), path).map(|()| (None, CatalogRename::None))
            }
            _ => Err("不支持此文件操作".into()),
        }
    }

    fn prepare_sources(
        paths: Vec<String>,
        destination: &Path,
        effect: DropEffect,
    ) -> Result<Vec<PathBuf>, String> {
        let resolved_destination = canonical_path(destination)?;
        if !resolved_destination.is_dir() {
            return Err("拖放目标必须是文件夹".into());
        }
        let destination_key = path_key(&resolved_destination);
        let mut seen = HashSet::new();
        let mut sources = Vec::with_capacity(paths.len());
        for path in paths {
            let path = PathBuf::from(path);
            let resolved = canonical_path(&path)?;
            if path.file_name().is_none() || resolved.file_name().is_none() {
                return Err("请选择要拖动的文件或文件夹".into());
            }
            let source_key = path_key(&resolved);
            if destination_key.starts_with(&source_key) {
                return Err("无法将文件夹拖到自身或子文件夹".into());
            }
            if matches!(effect, DropEffect::Move) && source_key.parent() == Some(&destination_key) {
                return Err("文件已在目标文件夹内".into());
            }
            if seen.insert(path_key(&path)) {
                // Keep the submitted path so Shell moves a link itself when applicable.
                sources.push(path);
            }
        }
        if sources.is_empty() {
            return Err("没有要拖动的文件".into());
        }
        Ok(sources)
    }

    fn shell_item(path: &Path) -> windows::core::Result<IShellItem> {
        let wide: Vec<u16> = nexus_core::clean_path(path)
            .encode_utf16()
            .chain([0])
            .collect();
        unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>) }
    }

    fn schedule_operations(
        hwnd: HWND,
        sources: &[PathBuf],
        destination: &Path,
        effect: DropEffect,
    ) -> windows::core::Result<IFileOperation> {
        let operation: IFileOperation =
            unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)? };
        let destination = shell_item(destination)?;
        unsafe {
            operation.SetOwnerWindow(hwnd)?;
            // Leave conflict, progress and error dialogs to the Shell.
            operation.SetOperationFlags(FOFX_ADDUNDORECORD | FOF_NOCONFIRMMKDIR)?;
        }
        for source in sources {
            let source = shell_item(source)?;
            let name = PCWSTR::null();
            let progress = None::<&IFileOperationProgressSink>;
            unsafe {
                match effect {
                    DropEffect::Copy => {
                        operation.CopyItem(&source, &destination, name, progress)?
                    }
                    DropEffect::Move => {
                        operation.MoveItem(&source, &destination, name, progress)?
                    }
                }
            }
        }
        Ok(operation)
    }

    pub(super) fn transfer(
        owner: isize,
        paths: Vec<String>,
        directory_path: String,
        effect: DropEffect,
    ) -> Result<(), String> {
        let destination = Path::new(&directory_path);
        let sources = prepare_sources(paths, destination, effect)?;
        let _apartment = Apartment::initialize()
            .map_err(|error| format!("无法打开 Windows 文件操作（{error}）"))?;
        let operation = schedule_operations(HWND(owner as _), &sources, destination, effect)
            .map_err(|error| format!("无法准备文件操作（{error}）"))?;
        perform_operations(&operation)
    }

    fn perform_operations(operation: &IFileOperation) -> Result<(), String> {
        let result = unsafe { operation.PerformOperations() };
        let aborted = unsafe { operation.GetAnyOperationsAborted() };
        if aborted.as_ref().is_ok_and(|value| value.as_bool()) {
            return Err("文件操作已取消，已完成的文件会保留".into());
        }
        result
            .and(aborted.map(|_| ()))
            .map_err(|error| format!("文件操作未完成（{error}）"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn new_folder_chooses_next_available_default_name() {
            let fixture = tempfile::tempdir().unwrap();
            let first = new_folder(fixture.path(), None).unwrap();
            let second = new_folder(fixture.path(), None).unwrap();
            assert!(first.ends_with("新建文件夹"));
            assert!(second.ends_with("新建文件夹 (2)"));
            assert!(new_folder(fixture.path(), Some("新建文件夹")).is_err());
            assert!(new_folder(fixture.path(), Some("../outside")).is_err());
            assert!(new_folder(fixture.path(), Some("bad.")).is_err());
        }

        #[test]
        fn rename_preserves_destination_and_supports_case_changes() {
            let fixture = tempfile::tempdir().unwrap();
            let catalog = Catalog::open(&fixture.path().join("catalog")).unwrap();
            let source = fixture.path().join("asset.txt");
            let other = fixture.path().join("留档.txt");
            fs::write(&source, "one").unwrap();
            fs::write(&other, "two").unwrap();
            assert!(rename(&catalog, fixture.path(), &source, "留档.txt").is_err());
            assert!(rename(&catalog, fixture.path(), &source, r"..\outside.txt").is_err());
            assert_eq!(fs::read_to_string(&other).unwrap(), "two");
            assert_eq!(fs::read_to_string(&source).unwrap(), "one");
            let (renamed, change) = rename(&catalog, fixture.path(), &source, "ASSET.txt").unwrap();
            assert!(matches!(change, CatalogRename::None));
            assert_eq!(fs::read_to_string(&renamed).unwrap(), "one");
            assert!(fixture
                .path()
                .read_dir()
                .unwrap()
                .any(|entry| { entry.unwrap().file_name() == OsStr::new("ASSET.txt") }));
        }

        fn indexed_fixture() -> (tempfile::TempDir, Catalog, PathBuf, Asset) {
            let sandbox = tempfile::tempdir().unwrap();
            let root = sandbox.path().join("素材");
            fs::create_dir_all(root.join("模型")).unwrap();
            let source = root.join("模型/草稿.obj");
            fs::write(&source, b"fixture").unwrap();
            let mut catalog = Catalog::open(&sandbox.path().join("catalog")).unwrap();
            catalog.scan(&root, None, "local", |_| {}).unwrap();
            let asset = catalog.assets().unwrap().remove(0);
            (sandbox, catalog, source, asset)
        }

        #[test]
        fn explorer_rename_preserves_indexed_asset_identity_and_metadata() {
            let (sandbox, mut catalog, source, original) = indexed_fixture();
            let app_data = sandbox.path().join("appdata");
            let collection = catalog.create_collection("personal", "交付").unwrap();
            catalog
                .set_collection_membership(
                    "personal",
                    &collection.id,
                    std::slice::from_ref(&original.id),
                    true,
                )
                .unwrap();
            let original = catalog
                .patch(
                    &original.id,
                    serde_json::json!({
                        "name":"客户定稿", "notes":"说明", "tags":["模型"], "favorite":true
                    }),
                )
                .unwrap();
            assert!(rename(&catalog, &app_data, &source, "成品.png").is_err());
            let (new_path, change) = rename(&catalog, &app_data, &source, "成品.obj").unwrap();
            assert!(matches!(change, CatalogRename::File));
            assert!(!source.exists());
            assert_eq!(fs::read(&new_path).unwrap(), b"fixture");
            let current = catalog.asset(&original.id).unwrap();
            assert_eq!(current.path, new_path);
            assert_eq!(current.name, original.name);
            assert_eq!(current.tags, original.tags);
            assert_eq!(current.notes, original.notes);
            assert_eq!(current.favorite_at, original.favorite_at);
            assert_eq!(current.library_id, original.library_id);
            assert_eq!(
                catalog.list_collections("personal").unwrap()[0].asset_ids,
                [original.id]
            );
            assert_eq!(catalog.assets().unwrap().len(), 1);
        }

        #[test]
        fn explorer_rename_preserves_paths_after_conflict_and_database_commit_failure() {
            let (sandbox, catalog, source, original) = indexed_fixture();
            let app_data = sandbox.path().join("appdata");
            let occupied = source.with_file_name("已存在.obj");
            fs::write(&occupied, b"other").unwrap();
            assert!(rename(&catalog, &app_data, &source, "已存在.obj").is_err());
            assert_eq!(fs::read(&occupied).unwrap(), b"other");
            catalog.conn.execute_batch(
                "CREATE TABLE rename_parent(id INTEGER PRIMARY KEY);
                 CREATE TABLE rename_child(id REFERENCES rename_parent(id) DEFERRABLE INITIALLY DEFERRED);
                 CREATE TRIGGER refuse_rename AFTER UPDATE OF path ON assets BEGIN
                   INSERT INTO rename_child VALUES(1);
                 END;",
            ).unwrap();
            let failure = rename(&catalog, &app_data, &source, "新名字.obj").unwrap_err();
            assert!(failure.contains("已恢复原文件名"), "{failure}");
            assert!(!source.with_file_name("新名字.obj").exists());
            assert_eq!(fs::read(&source).unwrap(), b"fixture");
            assert_eq!(catalog.asset(&original.id).unwrap().path, original.path);
        }

        #[test]
        fn explorer_rename_reuses_registered_subfolder_path_move_and_protects_library_root() {
            let (sandbox, catalog, source, original) = indexed_fixture();
            let app_data = sandbox.path().join("appdata");
            let library_root = source.ancestors().nth(2).unwrap();
            assert!(rename(&catalog, &app_data, library_root, "素材库新名字").is_err());
            let (new_path, change) =
                rename(&catalog, &app_data, source.parent().unwrap(), "成品").unwrap();
            let CatalogRename::Folder(remap) = change else {
                panic!("expected a folder remap")
            };
            assert_eq!(remap.library_id, original.library_id);
            assert_eq!(remap.from, "模型");
            assert_eq!(remap.to, "成品");
            assert!(!source.exists());
            let renamed = Path::new(&new_path).join("草稿.obj");
            assert_eq!(fs::read(&renamed).unwrap(), b"fixture");
            assert_eq!(
                catalog.asset(&original.id).unwrap().path,
                clean_path(&renamed)
            );
        }

        #[test]
        fn remote_items_are_rejected_before_querying_recycle_bin() {
            assert!(verify_recycle_root(Path::new(r"\\server\share\file.txt")).is_err());
        }

        #[test]
        fn rejects_moving_into_the_source_or_its_child() {
            let fixture = tempfile::tempdir().unwrap();
            let source = fixture.path().join("source");
            let child = source.join("子目录");
            fs::create_dir_all(&child).unwrap();
            let paths = vec![source.to_string_lossy().into_owned()];
            assert!(prepare_sources(paths.clone(), &source, DropEffect::Move).is_err());
            assert!(prepare_sources(paths, &child, DropEffect::Copy).is_err());
        }

        #[test]
        fn validates_all_sources_before_queueing_a_transfer() {
            let fixture = tempfile::tempdir().unwrap();
            let source = fixture.path().join("设计稿.txt");
            fs::write(&source, "nexus").unwrap();
            let path = source.to_string_lossy().into_owned();
            let paths = vec![path.clone(), path.clone()];
            assert!(prepare_sources(vec![path.clone()], fixture.path(), DropEffect::Move).is_err());
            let destination = fixture.path().join("目标");
            fs::create_dir(&destination).unwrap();
            assert_eq!(
                prepare_sources(paths, &destination, DropEffect::Copy).unwrap(),
                [source.clone()]
            );
            let missing = fixture
                .path()
                .join("missing.txt")
                .to_string_lossy()
                .into_owned();
            assert!(prepare_sources(vec![path, missing], &destination, DropEffect::Move).is_err());
            assert!(source.is_file());
            assert!(destination.read_dir().unwrap().next().is_none());
        }
    }
}
