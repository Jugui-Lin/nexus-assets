use serde::{Deserialize, Serialize};

const MAX_FILES: usize = 20;

#[cfg(windows)]
mod recovery;

#[derive(Deserialize)]
pub(crate) struct IndexedMoveSource {
    id: String,
    path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexedFileMove {
    id: String,
    old_path: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum RecoveryStatus {
    Clear,
    Blocked,
    Recovered,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryEntry {
    #[serde(flatten)]
    paths: IndexedFileMove,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileMoveRecovery {
    workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    status: RecoveryStatus,
    entries: Vec<RecoveryEntry>,
}

#[cfg(windows)]
fn active_workspace(
    catalog: &nexus_core::Catalog,
    expected: Option<&str>,
) -> Result<String, String> {
    let id = crate::workspaces::read_id(catalog)?.ok_or("无法确认当前个人资产库")?;
    if expected.is_some_and(|expected| expected != id) {
        return Err("个人资产库已切换，请重新查看原件".into());
    }
    Ok(id)
}

#[tauri::command]
pub(crate) async fn indexed_file_move_recovery_status(
    state: tauri::State<'_, crate::AppState>,
    workspace_id: Option<String>,
) -> Result<FileMoveRecovery, String> {
    #[cfg(windows)]
    {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _workspace = crate::workspaces::lock_io(&state)?;
            let catalog = crate::lock_db(&state)?;
            let id = active_workspace(&catalog, workspace_id.as_deref())?;
            recovery::inspect(&catalog, &state.root, &id)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (state, workspace_id);
        Err("当前平台暂不支持恢复原件移动".into())
    }
}

#[tauri::command]
pub(crate) async fn recover_indexed_local_file_moves(
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
    workspace_id: String,
    operation_id: String,
) -> Result<FileMoveRecovery, String> {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let permit = crate::local_explorer_drop::FILE_OPERATION
            .try_acquire()
            .map_err(|_| "请等当前文件操作完成")?;
        let state = state.inner().clone();
        let report = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let _workspace = crate::workspaces::lock_io(&state)?;
            let catalog = crate::lock_db(&state)?;
            let id = active_workspace(&catalog, Some(&workspace_id))?;
            recovery::recover(&catalog, &state.root, &id, Some(&operation_id))
        })
        .await
        .map_err(|error| error.to_string())??;
        if matches!(report.status, RecoveryStatus::Recovered) {
            let _ = window.emit("nexus-personal-catalog-changed", ());
        }
        Ok(report)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, state, workspace_id, operation_id);
        Err("当前平台暂不支持恢复原件移动".into())
    }
}

#[cfg(windows)]
pub(crate) fn recover_on_startup(catalog: &nexus_core::Catalog, app_data: &std::path::Path) {
    let result = active_workspace(catalog, None)
        .and_then(|id| recovery::recover(catalog, app_data, &id, None));
    if let Err(error) = result {
        eprintln!("原件移动恢复检查失败：{error}");
    }
}

#[tauri::command]
pub(crate) async fn move_indexed_local_files(
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
    workspace_id: String,
    directory_path: String,
    entries: Vec<IndexedMoveSource>,
) -> Result<Vec<IndexedFileMove>, String> {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let permit = crate::local_explorer_drop::FILE_OPERATION
            .try_acquire()
            .map_err(|_| "请等当前文件操作完成")?;
        let state = state.inner().clone();
        let moved = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let _workspace = crate::workspaces::lock_io(&state)?;
            let catalog = crate::lock_db(&state)?;
            let id = active_workspace(&catalog, Some(&workspace_id))?;
            windows_move::move_indexed_files(&catalog, &state.root, &id, &directory_path, &entries)
        })
        .await
        .map_err(|error| error.to_string())??;
        let _ = window.emit("nexus-personal-catalog-changed", ());
        Ok(moved)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, state, workspace_id, directory_path, entries);
        Err("当前平台暂不支持保留资产记录的文件移动".into())
    }
}

#[cfg(windows)]
mod windows_move {
    use super::{
        recovery::{self, Entry, Identity, Intent},
        IndexedFileMove, IndexedMoveSource, RecoveryStatus, MAX_FILES,
    };
    use crate::{
        folder_deletion::{canonical_directory, path_key, protected_name},
        library_visibility::folder_is_hidden,
        local_explorer::validate_file_path,
        workspace_folder_move::link_or_reparse,
        workspaces::registered_data_roots,
    };
    use nexus_core::{clean_path, relative_folder, Asset, Catalog};
    use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
    use same_file::Handle;
    use std::{
        collections::{HashMap, HashSet},
        fs::{self, Metadata},
        io::ErrorKind,
        mem::{offset_of, size_of},
        os::windows::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
        path::{Component, Path, PathBuf, Prefix},
        time::{SystemTime, UNIX_EPOCH},
    };
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileRenameInfo, GetDriveTypeW, SetFileInformationByHandle, DELETE,
                FILE_ATTRIBUTE_SYSTEM, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
                FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
                FILE_SHARE_WRITE, FILE_TRAVERSE,
            },
        },
    };

    pub(super) fn position(path: &str) -> Result<&Path, String> {
        let path = Path::new(path);
        validate_file_path(path)?;
        if path.as_os_str().len() > 32_768
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("请输入有效的完整磁盘路径".into());
        }
        Ok(path)
    }

    pub(super) fn fixed_drive(path: &Path) -> Result<u8, String> {
        let drive = match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => Some(drive),
                _ => None,
            },
            _ => None,
        }
        .ok_or("请选择本机固定磁盘上的个人库目录")?;
        let root = [u16::from(drive), u16::from(b':'), u16::from(b'\\'), 0];
        // GetDriveTypeW accepts the terminated root of this Windows drive.
        if unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } != 3 {
            return Err("仅支持本机固定磁盘上的个人库原件".into());
        }
        Ok(drive)
    }

    pub(super) fn read_ordinary(path: &Path) -> Result<Metadata, String> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("无法读取原件（{}）：{error}", clean_path(path)))?;
        require_ordinary(&metadata)?;
        Ok(metadata)
    }

    fn require_ordinary(metadata: &Metadata) -> Result<(), String> {
        if !metadata.is_file()
            || link_or_reparse(metadata)
            || metadata.file_attributes() & FILE_ATTRIBUTE_SYSTEM.0 != 0
        {
            return Err("请选择普通文件，移动不能通过符号链接、目录联接或系统文件".into());
        }
        Ok(())
    }

    pub(super) fn lock_original(path: &Path) -> Result<(Handle, Metadata), String> {
        // Permit reads and renames while retaining the original object's identity and denying writes.
        let file = fs::OpenOptions::new()
            .access_mode((FILE_READ_ATTRIBUTES | DELETE).0)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_DELETE).0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)
            .map_err(|error| format!("无法锁定原件（{}）：{error}", clean_path(path)))?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        require_ordinary(&metadata)?;
        let identity = Handle::from_file(file).map_err(|error| error.to_string())?;
        Ok((identity, metadata))
    }

    pub(super) fn lock_directory(path: &Path) -> Result<Handle, String> {
        let directory = fs::OpenOptions::new()
            .access_mode((FILE_READ_ATTRIBUTES | FILE_TRAVERSE).0)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
            .custom_flags((FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS).0)
            .open(path)
            .map_err(|error| format!("无法锁定原件目录（{}）：{error}", clean_path(path)))?;
        let metadata = directory.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() || link_or_reparse(&metadata) {
            return Err("原件所在目录已更换或变成链接".into());
        }
        Handle::from_file(directory).map_err(|error| error.to_string())
    }

    pub(super) fn move_open_file(file: &Handle, destination: &Path) -> Result<(), String> {
        let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
        let bytes = name.len() * size_of::<u16>();
        let header = size_of::<FILE_RENAME_INFO>();
        let length = header + bytes;
        let mut buffer = vec![FILE_RENAME_INFO::default(); length.div_ceil(header)];
        buffer[0].FileNameLength = bytes as u32;
        // The aligned buffer contains the header and its trailing UTF-16 filename. The zeroed
        // flags forbid replacement. Keep the verified source and parent handles held while renaming.
        unsafe {
            let buffer = buffer.as_mut_ptr().cast::<u8>();
            let tail = buffer
                .add(offset_of!(FILE_RENAME_INFO, FileName))
                .cast::<u16>();
            std::ptr::copy_nonoverlapping(name.as_ptr(), tail, name.len());
            SetFileInformationByHandle(
                HANDLE(file.as_file().as_raw_handle()),
                FileRenameInfo,
                buffer.cast(),
                length as u32,
            )
        }
        .map_err(|error| error.to_string())
    }

    pub(super) fn identity(path: &Path) -> Result<Handle, String> {
        Handle::from_path(path)
            .map_err(|error| format!("无法确认文件或目录身份（{}）：{error}", clean_path(path)))
    }

    pub(super) fn unoccupied(path: &Path) -> Result<(), String> {
        match fs::symlink_metadata(path) {
            Ok(_) => Err(format!(
                "目标位置已有同名文件或文件夹（{}）",
                clean_path(path)
            )),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("无法检查目标位置（{}）：{error}", clean_path(path))),
        }
    }

    pub(super) fn guarded_directory(
        root: &Path,
        path: &Path,
        protected: &[PathBuf],
    ) -> Result<(PathBuf, String), String> {
        let path = canonical_directory(path)?;
        path.strip_prefix(root)
            .map_err(|_| "源文件和目标目录必须位于同一个已登记的个人资产库内")?;
        let key = path_key(&path);
        if path
            .components()
            .any(|part| protected_name(&part.as_os_str().to_string_lossy()))
            || protected.iter().any(|root| key.starts_with(root))
        {
            return Err("源文件或目标目录属于其他资产库或 Nexus 工作空间数据".into());
        }
        let relative = relative_folder(root, &path).unwrap_or_default();
        Ok((path, relative))
    }

    pub(super) fn protected_paths(
        catalog: &Catalog,
        app_data: &Path,
        library: &str,
    ) -> Result<Vec<PathBuf>, String> {
        let mut protected = registered_data_roots(app_data)?;
        protected.extend([catalog.dir.clone(), app_data.to_path_buf()]);
        let mut query = catalog
            .conn
            .prepare("SELECT path FROM libraries WHERE id<>?1")
            .map_err(db_error)?;
        let paths = query
            .query_map([library], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        for path in paths {
            protected.push(PathBuf::from(path.map_err(db_error)?));
        }
        Ok(protected.into_iter().map(|path| path_key(&path)).collect())
    }

    pub(super) fn db_error(error: rusqlite::Error) -> String {
        format!("无法保存或验证资产索引：{error}")
    }

    struct MoveFile {
        asset: Asset,
        source: PathBuf,
        destination: PathBuf,
        old_parent: Handle,
        file: Handle,
        modified: SystemTime,
    }

    impl MoveFile {
        fn prepare(
            asset: Asset,
            selected: PathBuf,
            root: &Path,
            target: &Path,
            protected: &[PathBuf],
            catalog: &Catalog,
        ) -> Result<Self, String> {
            let original = position(&asset.path)?;
            let original_parent = original.parent().ok_or("找不到原件所在的文件夹")?;
            let (parent, folder) = guarded_directory(root, original_parent, protected)?;
            if folder_is_hidden(catalog, &asset.library_id, &folder)? {
                return Err("请先恢复原件所在的已移除文件夹".into());
            }
            let name = original.file_name().ok_or("原件名称无效")?;
            if protected_name(&name.to_string_lossy()) {
                return Err("不能移动 Nexus 工作空间数据".into());
            }
            let source = parent.join(name);
            let destination = target.join(name);
            if path_key(&source) == path_key(&destination) {
                return Err("原件已经位于此目录".into());
            }
            unoccupied(&destination)?;
            let (file, metadata) = lock_original(&source)?;
            let modified = metadata.modified().map_err(|error| error.to_string())?;
            if metadata.len() != asset.size
                || modified
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|time| time.as_secs())
                    != asset.modified.as_u64()
            {
                return Err(format!(
                    "原件与索引记录已不同，请更新索引后再移动（{}）",
                    clean_path(&source)
                ));
            }
            let (selected_parent, _) = guarded_directory(
                root,
                selected.parent().ok_or("找不到原件所在的文件夹")?,
                protected,
            )?;
            let selected = selected_parent.join(selected.file_name().ok_or("原件名称无效")?);
            read_ordinary(&selected)?;
            if identity(&selected)? != file {
                return Err("所选原件与资产记录已不一致，请重新选择".into());
            }
            Ok(Self {
                asset,
                source,
                destination,
                old_parent: lock_directory(&parent)?,
                file,
                modified,
            })
        }

        fn verify_parents(&self, target: &Handle) -> Result<(), String> {
            for (path, expected) in [
                (&self.source, &self.old_parent),
                (&self.destination, target),
            ] {
                let parent = canonical_directory(path.parent().ok_or("文件路径缺少目录")?)?;
                if identity(&parent)? != *expected {
                    return Err("源目录或目标目录已更换，请刷新后重试".into());
                }
            }
            Ok(())
        }

        fn verify_file(&self, path: &Path, unchanged: bool) -> Result<(), String> {
            let metadata = read_ordinary(path)?;
            if identity(path)? != self.file
                || unchanged
                    && (metadata.len() != self.asset.size
                        || metadata.modified().ok() != Some(self.modified))
            {
                return Err(format!("原件已更换或修改（{}）", clean_path(path)));
            }
            Ok(())
        }

        fn rollback(&self, target: &Handle) -> Result<(), String> {
            self.verify_parents(target)?;
            self.verify_file(&self.destination, false)?;
            unoccupied(&self.source)?;
            move_open_file(&self.file, &self.source)?;
            self.verify_file(&self.source, false)
        }
    }

    fn checked_assets(
        catalog: &Catalog,
        entries: &[IndexedMoveSource],
    ) -> Result<Vec<(Asset, PathBuf)>, String> {
        let mut ids = HashSet::new();
        let mut assets = Vec::with_capacity(entries.len());
        for entry in entries {
            if entry.id.starts_with("team:") || !ids.insert(entry.id.as_str()) {
                return Err("请选择不同的个人库资产原件".into());
            }
            let selected = position(&entry.path)?;
            let asset = catalog.asset(&entry.id)?;
            if asset.demo || path_key(Path::new(&asset.path)) != path_key(selected) {
                return Err("所选原件与资产记录已不一致，请重新选择".into());
            }
            assets.push((asset, selected.to_path_buf()));
        }
        Ok(assets)
    }

    fn stage_catalog(catalog: &Catalog, plans: &[MoveFile]) -> Result<(), String> {
        let mut sources = HashMap::new();
        let mut destinations = HashSet::new();
        for plan in plans {
            if sources.insert(path_key(&plan.source), plan).is_some()
                || !destinations.insert(path_key(&plan.destination))
            {
                return Err("所选原件将占用重复的目标文件名".into());
            }
        }
        let mut unique = HashSet::new();
        let mut thumbnails = Vec::new();
        {
            let mut query = catalog
                .conn
                .prepare("SELECT id,path,json_extract(data,'$.thumbnail') FROM assets")
                .map_err(db_error)?;
            let rows = query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(db_error)?;
            for row in rows {
                let (id, path, thumbnail) = row.map_err(db_error)?;
                let key = path_key(Path::new(&path));
                if let Some(plan) = sources.get(&key) {
                    if plan.asset.id != id || !unique.insert(plan.asset.id.as_str()) {
                        return Err("原件对应多条资产记录，请先核对索引".into());
                    }
                }
                if destinations.contains(&key) {
                    return Err(format!("目标位置已有资产记录（{path}）"));
                }
                if let Some(plan) = thumbnail
                    .as_deref()
                    .and_then(|path| sources.get(&path_key(Path::new(path))))
                {
                    thumbnails.push((id, clean_path(&plan.destination)));
                }
            }
        }
        if unique.len() != plans.len() {
            return Err("原件索引已变化，请重新选择".into());
        }
        for plan in plans {
            let path = clean_path(&plan.destination);
            let changed = catalog.conn.execute(
                "UPDATE assets SET path=?1,data=json_set(data,'$.path',?1) WHERE id=?2 AND path=?3 AND library_id=?4",
                params![path,plan.asset.id,plan.asset.path,plan.asset.library_id],
            ).map_err(db_error)?;
            if changed != 1 {
                return Err("原件索引已变化，请重新选择".into());
            }
            catalog.record_indexed_asset_directory(&plan.destination)?;
        }
        for (id, path) in thumbnails {
            catalog
                .conn
                .execute(
                    "UPDATE assets SET data=json_set(data,'$.thumbnail',?1) WHERE id=?2",
                    params![path, id],
                )
                .map_err(db_error)?;
        }
        Ok(())
    }

    fn undo_moved(plans: &[MoveFile], target: &Handle, cause: String) -> (String, bool) {
        if plans.is_empty() {
            return (cause, true);
        }
        let failures = plans
            .iter()
            .rev()
            .filter_map(|plan| {
                plan.rollback(target)
                    .err()
                    .map(|issue| format!("{}（{issue}）", clean_path(&plan.destination)))
            })
            .collect::<Vec<_>>();
        if failures.is_empty() {
            (format!("{cause}。已将本次移动的原件恢复原位。"), true)
        } else {
            (
                format!("{cause}。部分原件无法恢复，请检查：{}", failures.join("、")),
                false,
            )
        }
    }

    pub(super) fn move_indexed_files(
        catalog: &Catalog,
        app_data: &Path,
        workspace: &str,
        directory: &str,
        entries: &[IndexedMoveSource],
    ) -> Result<Vec<IndexedFileMove>, String> {
        let prior = recovery::recover(catalog, app_data, workspace, None)?;
        if matches!(prior.status, RecoveryStatus::Blocked) {
            return Err(format!(
                "请先处理上一次中断的原件移动：{}",
                prior
                    .entries
                    .iter()
                    .map(|entry| format!("{} ↔ {}", entry.paths.old_path, entry.paths.path))
                    .collect::<Vec<_>>()
                    .join("、")
            ));
        }
        recovery::durable(catalog, || {
            move_durable(catalog, app_data, workspace, directory, entries)
        })
    }

    fn move_durable(
        catalog: &Catalog,
        app_data: &Path,
        workspace: &str,
        directory: &str,
        entries: &[IndexedMoveSource],
    ) -> Result<Vec<IndexedFileMove>, String> {
        if !(1..=MAX_FILES).contains(&entries.len()) {
            return Err(format!("一次可移动 1 至 {MAX_FILES} 个已入库原件"));
        }
        let target = position(directory)?;
        let drive = fixed_drive(target)?;
        let transaction = Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let assets = checked_assets(catalog, entries)?;
        let library = assets[0].0.library_id.clone();
        if assets.iter().any(|(asset, _)| asset.library_id != library) {
            return Err("请选择同一个个人资产库内的原件".into());
        }
        let root: String = catalog
            .conn
            .query_row(
                "SELECT path FROM libraries WHERE id=?1",
                [&library],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .ok_or("请移动已登记文件夹中的原件")?;
        if fixed_drive(position(&root)?)? != drive {
            return Err("源文件和目标目录必须位于同一个本机固定磁盘".into());
        }
        let root = canonical_directory(Path::new(&root))?;
        let root_handle = lock_directory(&root)?;
        let protected = protected_paths(catalog, app_data, &library)?;
        let (target, folder) = guarded_directory(&root, target, &protected)?;
        if folder_is_hidden(catalog, &library, &folder)? {
            return Err("目标目录已从资产库移除，请先恢复".into());
        }
        let target_id = lock_directory(&target)?;
        let plans = assets
            .into_iter()
            .map(|(asset, selected)| {
                MoveFile::prepare(asset, selected, &root, &target, &protected, catalog)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if plans
            .iter()
            .map(|plan| &plan.file)
            .collect::<HashSet<_>>()
            .len()
            != plans.len()
        {
            return Err("所选原件包含指向同一个文件的多个位置".into());
        }
        let operation_id = uuid::Uuid::new_v4().to_string();
        let journal = Intent {
            workspace_id: workspace.to_owned(),
            workspace_dir: clean_path(&catalog.dir),
            library_id: library,
            library_root: clean_path(&root),
            library_identity: Identity::read(&root_handle)?,
            target_parent: Identity::read(&target_id)?,
            entries: plans
                .iter()
                .map(|plan| {
                    Ok(Entry {
                        paths: IndexedFileMove {
                            id: plan.asset.id.clone(),
                            old_path: plan.asset.path.clone(),
                            path: clean_path(&plan.destination),
                        },
                        file: Identity::read(&plan.file)?,
                        source_parent: Identity::read(&plan.old_parent)?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
        };
        recovery::persist(catalog, &operation_id, &journal)?;
        transaction.commit().map_err(db_error)?;

        let mut moved = 0;
        let execute = (|| {
            let transaction =
                Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
                    .map_err(db_error)?;
            stage_catalog(catalog, &plans)?;
            for plan in &plans {
                plan.verify_parents(&target_id)?;
                plan.verify_file(&plan.source, true)?;
                unoccupied(&plan.destination)?;
                move_open_file(&plan.file, &plan.destination).map_err(|error| {
                    format!("无法移动原件（{}）：{error}", clean_path(&plan.source))
                })?;
                moved += 1;
                plan.verify_file(&plan.destination, true)?;
            }
            for plan in &plans {
                plan.verify_parents(&target_id)?;
                plan.verify_file(&plan.destination, true)?;
            }
            recovery::mark_committed(catalog, &operation_id)?;
            transaction.commit().map_err(db_error)
        })();
        if let Err(error) = execute {
            let (error, restored) = undo_moved(&plans[..moved], &target_id, error);
            if restored {
                let _ = recovery::clear(catalog, &operation_id);
            }
            return Err(error);
        }
        // If cleanup is interrupted, the committed journal still describes the final paths.
        let _ = recovery::clear(catalog, &operation_id);
        Ok(plans
            .into_iter()
            .map(|plan| IndexedFileMove {
                id: plan.asset.id,
                old_path: clean_path(&plan.source),
                path: clean_path(&plan.destination),
            })
            .collect())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        struct Fixture {
            scratch: tempfile::TempDir,
            catalog: Catalog,
            root: PathBuf,
            target: PathBuf,
            original: Vec<Asset>,
        }

        impl Fixture {
            fn new() -> Self {
                let scratch = tempfile::tempdir().unwrap();
                let root = scratch.path().join("个人素材");
                let source = root.join("来源");
                fs::create_dir_all(&source).unwrap();
                fs::write(source.join("原件.obj"), b"mesh fixture").unwrap();
                fs::write(source.join("原件.png"), b"thumbnail fixture").unwrap();
                let mut catalog = Catalog::open(&scratch.path().join("catalog")).unwrap();
                catalog.scan(&root, None, "local", |_| {}).unwrap();
                let mut original = catalog.assets().unwrap();
                original.sort_by(|a, b| a.ext.cmp(&b.ext));
                let target = root.join("新位置");
                fs::create_dir(&target).unwrap();
                Self {
                    scratch,
                    catalog,
                    root,
                    target,
                    original,
                }
            }

            fn entries(&self) -> Vec<IndexedMoveSource> {
                self.original
                    .iter()
                    .map(|asset| IndexedMoveSource {
                        id: asset.id.clone(),
                        path: asset.path.clone(),
                    })
                    .collect()
            }

            fn move_to(
                &self,
                target: &Path,
                entries: &[IndexedMoveSource],
            ) -> Result<Vec<IndexedFileMove>, String> {
                move_indexed_files(
                    &self.catalog,
                    &self.scratch.path().join("app-data"),
                    "personal",
                    target.to_str().unwrap(),
                    entries,
                )
            }

            fn assert_unmoved(&self) {
                for asset in &self.original {
                    assert!(Path::new(&asset.path).is_file());
                    assert_eq!(self.catalog.asset(&asset.id).unwrap().path, asset.path);
                }
            }

            fn interrupt(&self, count: usize, committed: bool) -> (String, Vec<IndexedFileMove>) {
                let catalog = &self.catalog;
                let app_data = self.scratch.path().join("app-data");
                let root = canonical_directory(&self.root).unwrap();
                let target = canonical_directory(&self.target).unwrap();
                let library = &self.original[0].library_id;
                let protected = protected_paths(catalog, &app_data, library).unwrap();
                let plans = checked_assets(catalog, &self.entries())
                    .unwrap()
                    .into_iter()
                    .map(|(asset, selected)| {
                        MoveFile::prepare(asset, selected, &root, &target, &protected, catalog)
                            .unwrap()
                    })
                    .collect::<Vec<_>>();
                let journal_id = uuid::Uuid::new_v4().to_string();
                let paths = plans
                    .iter()
                    .map(|plan| IndexedFileMove {
                        id: plan.asset.id.clone(),
                        old_path: plan.asset.path.clone(),
                        path: clean_path(&plan.destination),
                    })
                    .collect::<Vec<_>>();
                let intent = Intent {
                    workspace_id: "personal".into(),
                    workspace_dir: clean_path(&catalog.dir),
                    library_id: library.to_owned(),
                    library_root: clean_path(&root),
                    library_identity: Identity::read(&identity(&root).unwrap()).unwrap(),
                    target_parent: Identity::read(&identity(&target).unwrap()).unwrap(),
                    entries: paths
                        .iter()
                        .zip(&plans)
                        .map(|(paths, plan)| Entry {
                            paths: paths.clone(),
                            file: Identity::read(&plan.file).unwrap(),
                            source_parent: Identity::read(&plan.old_parent).unwrap(),
                        })
                        .collect(),
                };
                recovery::durable(catalog, || {
                    recovery::persist(catalog, &journal_id, &intent)?;
                    let transaction =
                        Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
                            .map_err(db_error)?;
                    stage_catalog(catalog, &plans)?;
                    for plan in plans.iter().take(count) {
                        move_open_file(&plan.file, &plan.destination)?;
                    }
                    if committed {
                        recovery::mark_committed(catalog, &journal_id)?;
                        transaction.commit().map_err(db_error)?;
                    }
                    // Dropping the incomplete SQL transaction models SQLite reopening after process loss.
                    Ok(())
                })
                .unwrap();
                (journal_id, paths)
            }
        }

        #[test]
        fn indexed_file_move_recovery_restores_partial_move_and_is_idempotent() {
            let f = Fixture::new();
            let app_data = f.scratch.path().join("app-data");
            let (id, paths) = f.interrupt(1, false);
            let reopened = Catalog::open(&f.catalog.dir).unwrap();
            let pending = recovery::inspect(&reopened, &app_data, "personal").unwrap();
            assert!(matches!(pending.status, RecoveryStatus::Blocked));
            assert_eq!(pending.operation_id.as_deref(), Some(id.as_str()));
            assert_eq!(pending.entries.len(), 1);
            assert_eq!(pending.entries[0].paths.id, paths[0].id);
            assert!(!Path::new(&paths[0].old_path).exists() && Path::new(&paths[0].path).is_file());
            assert!(recovery::recover(&reopened, &app_data, "other", Some(&id)).is_err());
            assert!(
                recovery::recover(&reopened, &app_data, "personal", Some("stale-operation"))
                    .is_err()
            );
            let copied = Catalog::open(&f.scratch.path().join("different workspace")).unwrap();
            let schema: String = reopened
                .conn
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE name='indexed_file_move_intent'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let raw: String = reopened
                .conn
                .query_row("SELECT intent FROM indexed_file_move_intent", [], |row| {
                    row.get(0)
                })
                .unwrap();
            copied.conn.execute_batch(&schema).unwrap();
            copied
                .conn
                .execute(
                    "INSERT INTO indexed_file_move_intent VALUES (1,?1,0,?2)",
                    params![id, raw],
                )
                .unwrap();
            assert!(recovery::recover(&copied, &app_data, "personal", Some(&id))
                .unwrap_err()
                .contains("不同的个人资产库"));
            assert!(!Path::new(&paths[0].old_path).exists() && Path::new(&paths[0].path).is_file());
            let restored = recovery::recover(&reopened, &app_data, "personal", Some(&id)).unwrap();
            assert!(matches!(restored.status, RecoveryStatus::Recovered));
            assert_eq!(restored.entries.len(), 2);
            assert!(matches!(
                recovery::recover(&reopened, &app_data, "personal", Some(&id))
                    .unwrap()
                    .status,
                RecoveryStatus::Clear
            ));
            f.assert_unmoved();
            assert_eq!(fs::read_dir(&f.target).unwrap().count(), 0);
        }

        #[test]
        fn indexed_file_move_recovery_keeps_committed_paths_and_ignores_reused_source() {
            let f = Fixture::new();
            let app_data = f.scratch.path().join("app-data");
            let (id, paths) = f.interrupt(2, true);
            let reopened = Catalog::open(&f.catalog.dir).unwrap();
            fs::write(&paths[0].old_path, b"new unrelated file").unwrap();
            let cleaned = recovery::recover(&reopened, &app_data, "personal", Some(&id)).unwrap();
            assert!(matches!(cleaned.status, RecoveryStatus::Recovered));
            assert_eq!(fs::read(&paths[0].old_path).unwrap(), b"new unrelated file");
            for path in &paths {
                assert!(Path::new(&path.path).is_file());
                assert_eq!(reopened.asset(&path.id).unwrap().path, path.path);
            }
            assert!(matches!(
                recovery::inspect(&reopened, &app_data, "personal")
                    .unwrap()
                    .status,
                RecoveryStatus::Clear
            ));
        }

        #[test]
        fn indexed_file_move_recovery_does_not_move_a_committed_original_again() {
            let f = Fixture::new();
            let app_data = f.scratch.path().join("app-data");
            let (id, paths) = f.interrupt(2, true);
            let reopened = Catalog::open(&f.catalog.dir).unwrap();
            fs::rename(&paths[0].path, &paths[0].old_path).unwrap();
            let result = recovery::recover(&reopened, &app_data, "personal", Some(&id)).unwrap();
            assert!(matches!(result.status, RecoveryStatus::Blocked));
            assert_eq!(result.entries.len(), 1);
            assert_eq!(result.entries[0].paths.old_path, paths[0].old_path);
            assert_eq!(result.entries[0].paths.path, paths[0].path);
            assert!(result.entries[0]
                .reason
                .as_deref()
                .unwrap()
                .contains("移动已提交"));
            assert_eq!(fs::read(&paths[0].old_path).unwrap(), b"mesh fixture");
            assert!(!Path::new(&paths[0].path).exists());
            assert_eq!(reopened.asset(&paths[0].id).unwrap().path, paths[0].path);
        }

        #[test]
        fn indexed_file_move_recovery_reports_conflict_without_replacing_either_file() {
            let f = Fixture::new();
            let app_data = f.scratch.path().join("app-data");
            let (id, paths) = f.interrupt(1, false);
            let reopened = Catalog::open(&f.catalog.dir).unwrap();
            fs::write(&paths[0].old_path, b"someone else's file").unwrap();
            let result = recovery::recover(&reopened, &app_data, "personal", Some(&id)).unwrap();
            assert!(matches!(result.status, RecoveryStatus::Blocked));
            assert_eq!(result.entries.len(), 1);
            assert_eq!(result.entries[0].paths.old_path, paths[0].old_path);
            assert_eq!(result.entries[0].paths.path, paths[0].path);
            assert!(result.entries[0]
                .reason
                .as_deref()
                .unwrap()
                .contains("其他文件占用"));
            assert_eq!(
                fs::read(&paths[0].old_path).unwrap(),
                b"someone else's file"
            );
            assert_eq!(fs::read(&paths[0].path).unwrap(), b"mesh fixture");
            fs::rename(
                &paths[0].old_path,
                f.scratch.path().join("protected copy.obj"),
            )
            .unwrap();
            assert!(matches!(
                recovery::recover(&reopened, &app_data, "personal", Some(&id))
                    .unwrap()
                    .status,
                RecoveryStatus::Recovered
            ));
            f.assert_unmoved();
        }

        #[test]
        fn indexed_file_move_preserves_identity_metadata_thumbnails_and_references() {
            let mut f = Fixture::new();
            let collection = f.catalog.create_collection("personal", "交付").unwrap();
            let entries = f.entries();
            let ids = entries
                .iter()
                .map(|entry| entry.id.clone())
                .collect::<Vec<_>>();
            f.catalog
                .set_collection_membership("personal", &collection.id, &ids, true)
                .unwrap();
            let old = f.catalog.patch(&ids[0],json!({"name":"定稿","tags":["模型"],"favorite":true,"notes":"关联说明","rating":4})).unwrap();
            assert_eq!(old.thumbnail.as_deref(), Some(entries[1].path.as_str()));
            crate::asset_versions::initialize(&f.catalog.conn).unwrap();
            f.catalog
                .conn
                .execute(
                    "INSERT INTO asset_versions VALUES('first',?1,1,0,'版本备注',12,'原件.obj')",
                    [&ids[0]],
                )
                .unwrap();

            let moved = f.move_to(&f.target, &entries).unwrap();
            assert_eq!(
                moved
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                ids.iter().map(String::as_str).collect::<Vec<_>>()
            );
            assert_eq!(moved[0].old_path, entries[0].path);
            assert_eq!(moved[1].old_path, entries[1].path);
            assert_eq!(fs::read(&moved[0].path).unwrap(), b"mesh fixture");
            assert_eq!(fs::read(&moved[1].path).unwrap(), b"thumbnail fixture");
            assert!(
                !Path::new(&moved[0].old_path).exists() && !Path::new(&moved[1].old_path).exists()
            );
            let current = f.catalog.asset(&ids[0]).unwrap();
            let mut expected = old;
            expected.path = moved[0].path.clone();
            expected.thumbnail = Some(moved[1].path.clone());
            assert_eq!(
                serde_json::to_value(current).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
            let mut members = f.catalog.list_collections("personal").unwrap()[0]
                .asset_ids
                .clone();
            members.sort();
            let mut ids_sorted = ids.clone();
            ids_sorted.sort();
            assert_eq!(members, ids_sorted);
            let saved: String = f
                .catalog
                .conn
                .query_row(
                    "SELECT asset_id FROM asset_versions WHERE id='first'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(saved, ids[0]);
            let found: bool = f.catalog.conn.query_row("SELECT EXISTS(SELECT 1 FROM libraries,json_each(libraries.data,'$.folders') WHERE value='新位置')",[],|r| r.get(0)).unwrap();
            assert!(found);
        }

        #[test]
        fn indexed_file_move_rejects_conflicts_stale_files_and_other_roots_before_changes() {
            let f = Fixture::new();
            let entries = f.entries();
            let clash = f.target.join("原件.png");
            fs::write(&clash, b"existing file").unwrap();
            assert!(f
                .move_to(&f.target, &entries)
                .unwrap_err()
                .contains("已有同名"));
            assert_eq!(fs::read(&clash).unwrap(), b"existing file");
            assert!(!f.target.join("原件.obj").exists());
            fs::remove_file(clash).unwrap();

            let external = f.scratch.path().join("其他库");
            fs::create_dir(&external).unwrap();
            assert!(f
                .move_to(&external, &entries)
                .unwrap_err()
                .contains("同一个已登记"));
            let protected = f.root.join(".nexus");
            fs::create_dir(&protected).unwrap();
            assert!(f
                .move_to(&protected, &entries)
                .unwrap_err()
                .contains("工作空间数据"));
            let hidden = json!({(f.original[0].library_id.clone()):["新位置"]}).to_string();
            f.catalog
                .conn
                .execute(
                    "INSERT INTO settings VALUES('hidden_library_folders_v1',?1)",
                    [&hidden],
                )
                .unwrap();
            assert!(f
                .move_to(&f.target, &entries)
                .unwrap_err()
                .contains("资产库移除"));
            f.catalog
                .conn
                .execute(
                    "DELETE FROM settings WHERE key='hidden_library_folders_v1'",
                    [],
                )
                .unwrap();

            fs::write(&entries[1].path, b"this differs from indexed fixture").unwrap();
            assert!(f
                .move_to(&f.target, &entries)
                .unwrap_err()
                .contains("与索引记录已不同"));
            f.assert_unmoved();
            assert_eq!(fs::read_dir(&f.target).unwrap().count(), 0);
        }

        #[test]
        fn indexed_file_move_rolls_back_every_original_if_catalog_commit_fails() {
            let f = Fixture::new();
            f.catalog.conn.execute_batch(
                "CREATE TABLE move_parent(id INTEGER PRIMARY KEY);
                 CREATE TABLE move_child(id REFERENCES move_parent(id) DEFERRABLE INITIALLY DEFERRED);
                 CREATE TRIGGER refuse_move AFTER UPDATE OF path ON assets BEGIN
                   INSERT INTO move_child VALUES(1);
                 END;",
            ).unwrap();
            let error = f.move_to(&f.target, &f.entries()).unwrap_err();
            assert!(error.contains("原件恢复原位"), "{error}");
            f.assert_unmoved();
            assert_eq!(fs::read_dir(&f.target).unwrap().count(), 0);
            assert_eq!(fs::read(&f.original[0].path).unwrap(), b"mesh fixture");
            assert_eq!(fs::read(&f.original[1].path).unwrap(), b"thumbnail fixture");
        }

        #[test]
        fn indexed_file_move_refuses_junction_ancestors_and_ambiguous_case_folded_paths() {
            use std::os::windows::process::CommandExt;
            let f = Fixture::new();
            let junction = f.root.join("linked");
            let result = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&junction)
                .arg(&f.target)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "could not create the test junction"
            );
            let blocked = f.move_to(&junction, &f.entries()).unwrap_err();
            fs::remove_dir(junction).unwrap();
            assert!(blocked.contains("目录联接"), "{blocked}");

            let original = &f.original[0];
            let alias = original.path.replace(".obj", ".OBJ");
            f.catalog.conn.execute(
                "INSERT INTO assets SELECT 'different-id',?1,name,kind,library_id,favorite,json_set(data,'$.id','different-id','$.path',?1) FROM assets WHERE id=?2",
                params![alias,original.id],
            ).unwrap();
            assert!(f
                .move_to(&f.target, &f.entries())
                .unwrap_err()
                .contains("对应多条资产记录"));
            f.assert_unmoved();
        }
    }
}
