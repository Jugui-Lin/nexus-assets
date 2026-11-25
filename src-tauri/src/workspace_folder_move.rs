use crate::{
    folder_deletion::{canonical_directory, protected_name},
    library_visibility::{folder_is_hidden, remap_folder_exclusions},
    lock_db,
    team_import::share_path,
    workspaces::{lock_io, registered_data_roots},
    AppState,
};
use nexus_core::{clean_path, team::relative_path, Catalog};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use same_file::Handle;
use serde_json::{json, Value};
use std::{
    fs::{self, Metadata},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};
use tauri::State;
use walkdir::WalkDir;

fn path_key(path: &Path) -> PathBuf {
    let cleaned = clean_path(path);
    if cfg!(windows) {
        PathBuf::from(cleaned.to_lowercase())
    } else {
        PathBuf::from(cleaned)
    }
}

fn suffix_below(path: &Path, root: &Path) -> Option<PathBuf> {
    path_key(path).starts_with(path_key(root)).then(|| {
        Path::new(&clean_path(path))
            .components()
            .skip(Path::new(&clean_path(root)).components().count())
            .collect()
    })
}

fn contained_by(path: &Path, root: &Path) -> bool {
    if suffix_below(path, root).is_some() {
        return true;
    }
    let Ok(root) = Handle::from_path(root) else {
        return false;
    };
    path.ancestors()
        .any(|ancestor| Handle::from_path(ancestor).is_ok_and(|entry| entry == root))
}

fn link_or_reparse(entry: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if entry.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    entry.file_type().is_symlink()
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    let entry = fs::symlink_metadata(path)
        .map_err(|error| format!("无法访问文件夹（{}）：{error}", clean_path(path)))?;
    if !entry.is_dir() || link_or_reparse(&entry) {
        return Err(format!(
            "请选择实际文件夹，不能通过链接移动（{}）",
            clean_path(path)
        ));
    }
    Ok(())
}

fn real_subdirectory(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    ensure_directory(root)?;
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        ensure_directory(&path)?;
    }
    let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
    if path_key(&canonical) != path_key(&path) {
        return Err("移动位置不在实际的资产库目录内".into());
    }
    Ok(canonical)
}

fn move_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = relative_path(value).ok_or("文件夹路径无效")?;
    share_path(&path)?;
    Ok(path)
}

fn ensure_new_path(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(format!(
            "目标目录已有同名文件或文件夹（{}）",
            clean_path(path)
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查目标位置（{}）：{error}", clean_path(path))),
    }
}

pub(crate) fn folder_move_destination(
    folder: &str,
    target_folder: &str,
    new_name: Option<&str>,
) -> Result<String, String> {
    let (source_parent, original) = folder.rsplit_once('/').unwrap_or(("", folder));
    if original.is_empty() {
        return Err("不能移动资产库根目录".into());
    }
    if new_name.is_some() && target_folder != source_parent {
        return Err("重命名必须在原父目录中完成".into());
    }
    let name = new_name.unwrap_or(original);
    if new_name.is_some()
        && (name == original
            || name.encode_utf16().count() > 255
            || protected_name(name)
            || relative_path(name).is_none_or(|path| path.components().count() != 1))
    {
        return Err("请输入有效且不同的文件夹名称".into());
    }
    let target = move_relative(target_folder)?.join(name);
    share_path(&target)
}

fn ensure_destination(source: &Path, target: &Path) -> Result<(), String> {
    // Windows may resolve a new spelling to the source directory. Accept it only
    // when both handles identify that same directory and no link is involved.
    if cfg!(windows)
        && source != target
        && path_key(source) == path_key(target)
        && fs::symlink_metadata(target).is_ok_and(|entry| entry.is_dir() && !link_or_reparse(&entry))
        && folder_identity(target)? == folder_identity(source)?
    {
        return Ok(());
    }
    ensure_new_path(target)
}

struct MovePlan {
    root: PathBuf,
    from: PathBuf,
    to: PathBuf,
    old_relative: PathBuf,
    new_relative: PathBuf,
    source_id: Handle,
    target_parent_id: Handle,
    source_parent_id: Handle,
    folders: Vec<String>,
}

impl MovePlan {
    fn prepare(
        root: &Path,
        folder: &str,
        target_folder: &str,
        new_name: Option<&str>,
        protected_roots: &[PathBuf],
    ) -> Result<Self, String> {
        if folder.is_empty() {
            return Err("不能移动资产库根目录".into());
        }
        let root = canonical_directory(root)?;
        let from = real_subdirectory(&root, &move_relative(folder)?)?;
        let parent = real_subdirectory(&root, &move_relative(target_folder)?)?;
        if [&from, &parent].into_iter().any(|path| {
            path.components()
                .any(|part| protected_name(&part.as_os_str().to_string_lossy()))
        }) {
            return Err("不能移动 Nexus 工作空间数据目录".into());
        }
        if contained_by(&parent, &from) {
            return Err("不能将文件夹移动到自身或子文件夹内".into());
        }
        let basename = from.file_name().ok_or("不能移动资产库根目录")?;
        let source_parent = from.parent().ok_or("无法定位源文件夹的父目录")?;
        if new_name.is_none()
            && contained_by(source_parent, &parent)
            && contained_by(&parent, source_parent)
        {
            return Err("文件夹已经位于此目录".into());
        }
        let to = match new_name {
            Some(name) => {
                let relative = folder_move_destination(folder, target_folder, Some(name))?;
                root.join(move_relative(&relative)?)
            }
            None => parent.join(basename),
        };
        ensure_destination(&from, &to)?;
        for protected in protected_roots {
            if contained_by(protected, &from)
                || contained_by(&from, protected)
                || contained_by(&parent, protected)
                || contained_by(protected, &to)
            {
                return Err("源文件夹或目标位置与已登记的其他资产库或工作空间数据重叠".into());
            }
        }
        let old_relative = suffix_below(&from, &root).ok_or("无法定位资产库相对路径")?;
        let new_relative = suffix_below(&to, &root).ok_or("无法定位目标资产库相对路径")?;
        let source_id = folder_identity(&from)?;
        let target_parent_id = folder_identity(&parent)?;
        let source_parent_id = folder_identity(source_parent)?;
        let folders = inventory(&from, &new_relative)?;
        Ok(Self {
            root,
            from,
            to,
            old_relative,
            new_relative,
            source_id,
            target_parent_id,
            source_parent_id,
            folders,
        })
    }

    fn verify_parents(&self) -> Result<(), String> {
        for (path, expected) in [
            (&self.old_relative, &self.source_parent_id),
            (&self.new_relative, &self.target_parent_id),
        ] {
            let parent = real_subdirectory(&self.root, path.parent().ok_or("无效的父目录")?)?;
            if folder_identity(&parent)? != *expected {
                return Err("父目录已更换，请刷新文件夹后重试".into());
            }
        }
        Ok(())
    }

    fn execute(&self) -> Result<(), String> {
        self.verify_parents()?;
        let current = real_subdirectory(&self.root, &self.old_relative)?;
        if folder_identity(&current)? != self.source_id {
            return Err("源文件夹已更换，请刷新后重试".into());
        }
        move_to_empty_path(&self.from, &self.to)
    }

    fn rollback(&self) -> Result<(), String> {
        self.verify_parents()?;
        let current = real_subdirectory(&self.root, &self.new_relative)?;
        if folder_identity(&current)? != self.source_id {
            return Err("目标文件夹已由其他操作更换".into());
        }
        move_to_empty_path(&self.to, &self.from)
    }

    fn folder(&self) -> Result<String, String> {
        share_path(&self.new_relative)
    }
}

fn folder_identity(path: &Path) -> Result<Handle, String> {
    Handle::from_path(path)
        .map_err(|error| format!("无法识别文件夹（{}）：{error}", clean_path(path)))
}

fn join_suffix(base: &Path, suffix: &Path) -> PathBuf {
    if suffix.as_os_str().is_empty() {
        base.to_owned()
    } else {
        base.join(suffix)
    }
}

fn inventory(source: &Path, target: &Path) -> Result<Vec<String>, String> {
    let mut folders = Vec::new();
    for entry in WalkDir::new(source)
        .follow_links(false)
        .follow_root_links(false)
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("无法检查文件夹内容（{}）：{error}", clean_path(path)))?;
        if link_or_reparse(&metadata) {
            return Err(format!(
                "文件夹内包含链接或重分析点，无法整体移动（{}）",
                clean_path(path)
            ));
        }
        if path != source {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if protected_name(&name) || name.starts_with(".nexus-import-") {
                return Err("不能移动包含 Nexus 工作空间数据的文件夹".into());
            }
        }
        let suffix = path
            .strip_prefix(source)
            .map_err(|error| error.to_string())?;
        if suffix
            .iter()
            .any(|part| part.to_string_lossy().starts_with('.'))
        {
            continue;
        }
        let relative = share_path(&join_suffix(target, suffix))?;
        if metadata.is_dir() {
            folders.push(relative);
        }
    }
    Ok(folders)
}

fn move_to_empty_path(source: &Path, target: &Path) -> Result<(), String> {
    ensure_destination(source, target)?;
    rename_no_replace(source, target).map_err(|error| {
        if fs::symlink_metadata(target).is_ok() {
            format!("目标目录已有同名文件或文件夹（{}）", clean_path(target))
        } else {
            format!(
                "无法移动文件夹（{} → {}）：{error}",
                clean_path(source),
                clean_path(target)
            )
        }
    })
}

#[cfg(windows)]
fn rename_no_replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS},
    };
    let from: Vec<u16> = source.as_os_str().encode_wide().chain([0]).collect();
    let to: Vec<u16> = target.as_os_str().encode_wide().chain([0]).collect();
    // No replace or copy flags: the filesystem either atomically moves the directory or fails.
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(|error| io::Error::other(error.to_string()))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_no_replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::{
        ffi::{c_char, c_int, c_uint, CString},
        os::unix::ffi::OsStrExt,
    };
    #[cfg(target_os = "linux")]
    unsafe extern "C" {
        fn renameat2(
            old_fd: c_int,
            old: *const c_char,
            new_fd: c_int,
            new: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }
    #[cfg(target_os = "macos")]
    unsafe extern "C" {
        fn renamex_np(old: *const c_char, new: *const c_char, flags: c_uint) -> c_int;
    }
    let from = CString::new(source.as_os_str().as_bytes())
        .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?;
    let to = CString::new(target.as_os_str().as_bytes())
        .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?;
    #[cfg(target_os = "linux")]
    let code = unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) }; // AT_FDCWD, RENAME_NOREPLACE
    #[cfg(target_os = "macos")]
    let code = unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 4) }; // RENAME_EXCL
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn rename_no_replace(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "系统不支持无覆盖目录移动",
    ))
}

pub(crate) fn move_shared_folder(
    mount: &Path,
    folder: &str,
    target_folder: &str,
    new_name: Option<&str>,
    protected_roots: &[PathBuf],
) -> Result<String, String> {
    let plan = MovePlan::prepare(mount, folder, target_folder, new_name, protected_roots)?;
    let folder = plan.folder()?;
    plan.execute()?;
    Ok(folder)
}

fn map_asset_path(path: &str, plan: &MovePlan) -> Option<String> {
    let relative = suffix_below(Path::new(path), &plan.from)?;
    (!relative.as_os_str().is_empty()).then(|| clean_path(&plan.to.join(relative)))
}

fn update_assets(connection: &rusqlite::Connection, plan: &MovePlan) -> Result<(), String> {
    let changes = {
        let mut query = connection
            .prepare("SELECT id,path,json_extract(data,'$.thumbnail') FROM assets")
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut changes = Vec::new();
        for row in rows {
            let (id, path, thumbnail) = row.map_err(|error| error.to_string())?;
            let moved = map_asset_path(&path, plan);
            let new_thumbnail = thumbnail
                .as_deref()
                .and_then(|value| map_asset_path(value, plan));
            if moved.is_some() || new_thumbnail.is_some() {
                changes.push((id, moved.unwrap_or(path), new_thumbnail.or(thumbnail)));
            }
        }
        changes
    };
    let mut update = connection.prepare("UPDATE assets SET path=?2,data=json_set(data,'$.path',?2,'$.thumbnail',?3) WHERE id=?1")
        .map_err(|error| error.to_string())?;
    for (id, path, thumbnail) in changes {
        update
            .execute(params![id, path, thumbnail])
            .map_err(|error| format!("无法调整资产索引（{path}）：{error}"))?;
    }
    Ok(())
}

fn move_local_folder(
    catalog: &Catalog,
    app_data: &Path,
    library_id: &str,
    folder: &str,
    target_folder: &str,
    new_name: Option<&str>,
) -> Result<String, String> {
    let tx = Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let root: String = tx
        .query_row(
            "SELECT path FROM libraries WHERE id=?1",
            [library_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("请选择已添加的个人库文件夹")?;
    let mut protected = registered_data_roots(app_data)?;
    protected.extend([catalog.dir.clone(), app_data.to_path_buf()]);
    {
        let mut stmt = tx
            .prepare("SELECT path FROM libraries WHERE id<>?1")
            .map_err(|error| error.to_string())?;
        let roots = stmt
            .query_map([library_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for root in roots {
            protected.push(PathBuf::from(root.map_err(|error| error.to_string())?));
        }
    }
    let plan = MovePlan::prepare(Path::new(&root), folder, target_folder, new_name, &protected)?;
    let result = plan.folder()?;
    for path in [folder, target_folder, result.as_str()] {
        if folder_is_hidden(catalog, library_id, path)? {
            return Err("请先恢复已从资产库移除的文件夹，再进行移动".into());
        }
    }
    update_assets(&tx, &plan)?;
    let stored: Option<String> = tx
        .query_row(
            "SELECT json_extract(data,'$.folders') FROM libraries WHERE id=?1",
            [library_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut folders: Vec<String> = match stored {
        Some(value) => serde_json::from_str(&value).map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    folders.retain(|path| suffix_below(Path::new(path), &plan.old_relative).is_none());
    folders.extend(plan.folders.iter().cloned());
    folders.sort_unstable();
    folders.dedup();
    tx.execute(
        "UPDATE libraries SET data=json_set(data,'$.folders',json(?2)) WHERE id=?1",
        params![library_id, json!(folders).to_string()],
    )
    .map_err(|error| error.to_string())?;
    remap_folder_exclusions(catalog, library_id, |path| {
        let suffix = suffix_below(Path::new(path), &plan.old_relative)?;
        Some(clean_path(&join_suffix(&plan.new_relative, &suffix)).replace('\\', "/"))
    })?;

    plan.execute()?;
    if let Err(error) = tx.commit() {
        return match plan.rollback() {
            Ok(()) => Err(format!("保存资产索引失败，文件夹已移回原位：{error}")),
            Err(rollback) => Err(format!(
                "保存资产索引失败且无法移回原位。请检查文件夹 {}。索引：{error}。回退：{rollback}",
                clean_path(&plan.to)
            )),
        };
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn move_library_folder(
    state: State<'_, AppState>,
    library_id: String,
    folder: String,
    target_folder: String,
    new_name: Option<String>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = lock_io(&state)?;
        let catalog = lock_db(&state)?;
        let folder = move_local_folder(
            &catalog, &state.root, &library_id, &folder, &target_folder, new_name.as_deref(),
        )?;
        Ok(json!({"folder":folder}))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn move_fixture() -> (tempfile::TempDir, Catalog, PathBuf, String) {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("资产目录");
        fs::create_dir_all(root.join("来源/移动/不显示/空目录")).unwrap();
        fs::create_dir_all(root.join("目标")).unwrap();
        fs::write(root.join("来源/移动/模型.obj"), b"model").unwrap();
        fs::write(root.join("来源/移动/模型.png"), b"thumbnail").unwrap();
        let mut catalog = Catalog::open(&scratch.path().join("catalog")).unwrap();
        let scan = catalog.scan(&root, None, "local", |_| {}).unwrap();
        let id = scan["library"]["id"].as_str().unwrap().to_owned();
        (scratch, catalog, root, id)
    }

    #[test]
    fn personal_move_preserves_asset_identity_and_moves_folders_covers_and_rules() {
        let (scratch, catalog, root, library) = move_fixture();
        let old = catalog
            .assets()
            .unwrap()
            .into_iter()
            .find(|asset| asset.ext == "obj")
            .unwrap();
        catalog
            .patch(
                &old.id,
                json!({"notes":"保留备注","tags":["家具"],"favorite":true,"rating":4}),
            )
            .unwrap();
        catalog
            .conn
            .execute(
                "INSERT INTO settings(key,value) VALUES('hidden_library_folders_v1',?1)",
                [json!({library.clone():["来源/移动/不显示"]}).to_string()],
            )
            .unwrap();

        let result = move_local_folder(
            &catalog,
            &scratch.path().join("appdata"),
            &library,
            "来源/移动",
            "目标",
            None,
        )
        .unwrap();
        assert_eq!(result, "目标/移动");
        assert!(!root.join("来源/移动").exists());
        assert!(root.join("目标/移动/不显示/空目录").is_dir());
        assert_eq!(fs::read(root.join("目标/移动/模型.obj")).unwrap(), b"model");
        let current = catalog.asset(&old.id).unwrap();
        assert_eq!(
            current.path,
            clean_path(&fs::canonicalize(root.join("目标/移动/模型.obj")).unwrap())
        );
        assert_eq!(
            current.thumbnail,
            Some(clean_path(
                &fs::canonicalize(root.join("目标/移动/模型.png")).unwrap()
            ))
        );
        assert_eq!(current.notes, "保留备注");
        assert_eq!(current.tags, ["家具"]);
        assert!(current.favorite);
        assert_eq!(current.rating, 4);
        assert_eq!(current.added, old.added);
        assert_eq!(catalog.assets().unwrap().len(), 2);
        assert!(folder_is_hidden(&catalog, &library, "目标/移动/不显示").unwrap());
        assert!(!folder_is_hidden(&catalog, &library, "来源/移动/不显示").unwrap());
        let row = catalog.libraries().unwrap().remove(0);
        assert_eq!(row["foldersComplete"], true);
        let folders = row["folders"].as_array().unwrap();
        assert!(folders.contains(&json!("目标/移动/不显示/空目录")));
        assert!(!folders.contains(&json!("来源/移动")));
    }

    #[test]
    fn failed_catalog_commit_rolls_back_the_real_move() {
        let (scratch, catalog, root, library) = move_fixture();
        let old = catalog.assets().unwrap().remove(0);
        catalog.conn.execute_batch(
            "CREATE TABLE move_parent(id INTEGER PRIMARY KEY);
            CREATE TABLE move_child(parent INTEGER REFERENCES move_parent(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER refuse_move_commit AFTER UPDATE OF path ON assets BEGIN
                INSERT INTO move_child VALUES(999);
            END;",
        ).unwrap();
        let error = move_local_folder(
            &catalog,
            &scratch.path().join("appdata"),
            &library,
            "来源/移动",
            "目标",
            None,
        )
        .unwrap_err();
        assert!(error.contains("已移回原位"), "{error}");
        assert!(root.join("来源/移动/模型.obj").is_file());
        assert!(!root.join("目标/移动").exists());
        assert_eq!(catalog.asset(&old.id).unwrap().path, old.path);
    }

    #[test]
    fn folder_rename_preserves_asset_identity_and_rejects_conflicts() {
        let (scratch, catalog, root, library) = move_fixture();
        let app_data = scratch.path().join("appdata");
        let original = catalog.assets().unwrap().into_iter()
            .find(|asset| asset.path.ends_with("模型.obj")).unwrap();
        catalog.patch(&original.id, json!({"notes":"保留备注","favorite":true})).unwrap();
        fs::create_dir(root.join("来源/同名")).unwrap();

        for (parent, name) in [("来源", "同名"), ("目标", "换父目录"), ("来源", "../无效"), ("来源", "NUL")] {
            assert!(move_local_folder(&catalog, &app_data, &library, "来源/移动", parent, Some(name)).is_err());
            assert!(root.join("来源/移动/模型.obj").is_file());
        }

        let renamed = move_local_folder(&catalog, &app_data, &library, "来源/移动", "来源", Some("已重命名")).unwrap();
        assert_eq!(renamed, "来源/已重命名");
        assert!(!root.join("来源/移动").exists());
        assert!(root.join("来源/已重命名/不显示/空目录").is_dir());
        let asset = catalog.asset(&original.id).unwrap();
        assert_eq!(asset.path, clean_path(&fs::canonicalize(root.join("来源/已重命名/模型.obj")).unwrap()));
        assert_eq!(asset.notes, "保留备注");
        assert!(asset.favorite);
    }

    #[cfg(windows)]
    #[test]
    fn folder_rename_updates_case_without_replacing_another_directory() {
        let (_scratch, _catalog, root, _) = move_fixture();
        fs::create_dir(root.join("Desk")).unwrap();
        fs::write(root.join("Desk/model.obj"), b"model").unwrap();
        assert_eq!(move_shared_folder(&root, "Desk", "", Some("DESK"), &[]).unwrap(), "DESK");
        let names = fs::read_dir(&root).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "DESK"));
        assert!(!names.iter().any(|name| name == "Desk"));
        assert_eq!(fs::read(root.join("DESK/model.obj")).unwrap(), b"model");
    }

    #[test]
    fn physical_move_rejects_root_subtree_cross_root_and_existing_names() {
        let (_scratch, _catalog, root, _) = move_fixture();
        assert!(move_shared_folder(&root, "", "目标", None, &[]).is_err());
        assert!(move_shared_folder(&root, "来源/移动", "来源/移动/不显示", None, &[]).is_err());
        assert!(move_shared_folder(&root, "来源/移动", "..", None, &[]).is_err());
        assert!(
            move_shared_folder(&root, "来源/移动", "目标", None, &[root.join("来源/移动/不显示")])
                .is_err()
        );
        assert!(move_shared_folder(&root, "来源/移动", "目标", None, &[root.join("目标")]).is_err());
        fs::create_dir(root.join("目标/移动")).unwrap();
        assert!(move_shared_folder(&root, "来源/移动", "目标", None, &[]).is_err());
        assert!(rename_no_replace(
            &fs::canonicalize(root.join("来源/移动")).unwrap(),
            &fs::canonicalize(root.join("目标/移动")).unwrap()
        )
        .is_err());
        assert!(root.join("来源/移动/模型.obj").is_file());
        assert_eq!(fs::read_dir(root.join("目标/移动")).unwrap().count(), 0);
        fs::remove_dir(root.join("目标/移动")).unwrap();
        assert_eq!(
            move_shared_folder(&root, "来源/移动", "目标", None, &[]).unwrap(),
            "目标/移动"
        );
        assert!(!root.join("来源/移动").exists());
    }

    #[test]
    fn physical_move_protects_inactive_workspace_data() {
        let (scratch, catalog, root, library) = move_fixture();
        let database = root.join("来源/移动/不显示/nexus.sqlite3");
        fs::write(&database, b"workspace database").unwrap();
        let error = move_shared_folder(&root, "来源/移动", "目标", None, &[]).unwrap_err();
        assert!(error.contains("工作空间数据"), "{error}");
        assert_eq!(fs::read(&database).unwrap(), b"workspace database");
        fs::remove_file(&database).unwrap();

        let app_data = scratch.path().join("appdata");
        fs::create_dir(&app_data).unwrap();
        fs::write(
            app_data.join("personal-workspaces.json"),
            json!({"active":null,"workspaces":[{
                "id":"inactive","name":"Inactive","path":root.join("来源/移动/不显示")
            }]})
            .to_string(),
        )
        .unwrap();
        let error =
            move_local_folder(&catalog, &app_data, &library, "来源/移动", "目标", None).unwrap_err();
        assert!(error.contains("工作空间数据重叠"), "{error}");
        assert!(!root.join("目标/移动").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_linked_parent_and_links_inside_a_moved_tree() {
        let (scratch, _catalog, root, _) = move_fixture();
        let external = scratch.path().join("outside");
        fs::create_dir(&external).unwrap();
        std::os::unix::fs::symlink(scratch.path(), external.join("mount-alias")).unwrap();
        let linked_root = external.join("mount-alias").join(root.file_name().unwrap());
        assert!(move_shared_folder(&linked_root, "来源/移动", "目标", None, &[]).is_err());
        std::os::unix::fs::symlink(&external, root.join("link")).unwrap();
        assert!(move_shared_folder(&root, "来源/移动", "link", None, &[]).is_err());
        std::os::unix::fs::symlink(external, root.join("来源/移动/link")).unwrap();
        assert!(move_shared_folder(&root, "来源/移动", "目标", None, &[]).is_err());
        assert!(root.join("来源/移动/模型.obj").is_file());
        assert!(!root.join("目标/移动").exists());
    }
}
