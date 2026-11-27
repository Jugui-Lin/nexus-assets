use super::{
    windows_move::{
        db_error, fixed_drive, guarded_directory, identity, lock_directory, lock_original,
        move_open_file, position, protected_paths, read_ordinary, unoccupied,
    },
    FileMoveRecovery, IndexedFileMove, RecoveryEntry, RecoveryStatus, MAX_FILES,
};
use crate::{
    folder_deletion::{canonical_directory, path_key},
    library_visibility::folder_is_hidden,
};
use nexus_core::{clean_path, Catalog};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
};
use windows::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(super) struct Identity {
    volume: u32,
    index: u64,
    created: u64,
}

impl Identity {
    pub(super) fn read(handle: &Handle) -> Result<Self, String> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // The file handle stays open until Windows finishes filling its identity record.
        unsafe { GetFileInformationByHandle(HANDLE(handle.as_file().as_raw_handle()), &mut info) }
            .map_err(|error| format!("无法读取原件的磁盘身份：{error}"))?;
        let pair = |high, low| (u64::from(high) << 32) | u64::from(low);
        Ok(Self {
            volume: info.dwVolumeSerialNumber,
            index: pair(info.nFileIndexHigh, info.nFileIndexLow),
            created: pair(
                info.ftCreationTime.dwHighDateTime,
                info.ftCreationTime.dwLowDateTime,
            ),
        })
    }
}

#[derive(Deserialize, Serialize)]
pub(super) struct Entry {
    pub(super) paths: IndexedFileMove,
    pub(super) file: Identity,
    pub(super) source_parent: Identity,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Intent {
    pub(super) workspace_id: String,
    pub(super) workspace_dir: String,
    pub(super) library_id: String,
    pub(super) library_root: String,
    pub(super) library_identity: Identity,
    pub(super) target_parent: Identity,
    pub(super) entries: Vec<Entry>,
}

struct Journal {
    id: String,
    committed: bool,
    intent: Intent,
}

pub(super) fn durable<T>(
    catalog: &Catalog,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let previous: i32 = catalog
        .conn
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(db_error)?;
    catalog
        .conn
        .pragma_update(None, "synchronous", "FULL")
        .map_err(db_error)?;
    let result = operation();
    if let Err(error) = catalog.conn.pragma_update(None, "synchronous", previous) {
        eprintln!("无法恢复资产索引的写入设置：{error}");
    }
    result
}

pub(super) fn persist(catalog: &Catalog, id: &str, intent: &Intent) -> Result<(), String> {
    catalog
        .conn
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS indexed_file_move_intent (
            slot INTEGER PRIMARY KEY CHECK (slot=1), operation_id TEXT NOT NULL,
            committed INTEGER NOT NULL CHECK (committed IN (0,1)), intent TEXT NOT NULL
        )",
        )
        .map_err(db_error)?;
    let payload = serde_json::to_string(intent).map_err(|error| error.to_string())?;
    catalog
        .conn
        .execute(
            "INSERT INTO indexed_file_move_intent VALUES (1,?1,0,?2)",
            params![id, payload],
        )
        .map_err(db_error)?;
    Ok(())
}

pub(super) fn mark_committed(catalog: &Catalog, id: &str) -> Result<(), String> {
    if catalog
        .conn
        .execute(
            "UPDATE indexed_file_move_intent SET committed=1 WHERE operation_id=?1",
            [id],
        )
        .map_err(db_error)?
        != 1
    {
        return Err("本次原件移动记录已变化".into());
    }
    Ok(())
}

pub(super) fn clear(catalog: &Catalog, id: &str) -> Result<(), String> {
    catalog
        .conn
        .execute(
            "DELETE FROM indexed_file_move_intent WHERE operation_id=?1",
            [id],
        )
        .map_err(db_error)?;
    Ok(())
}

fn load(catalog: &Catalog) -> Result<Option<Journal>, String> {
    let exists: bool = catalog.conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='indexed_file_move_intent' AND type='table')", [], |row| row.get(0)
    ).map_err(db_error)?;
    if !exists {
        return Ok(None);
    }
    let row = catalog
        .conn
        .query_row(
            "SELECT operation_id,committed,intent FROM indexed_file_move_intent WHERE slot=1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?;
    let Some((id, committed, payload)) = row else {
        return Ok(None);
    };
    let intent: Intent =
        serde_json::from_str(&payload).map_err(|_| "无法读取中断的原件移动记录")?;
    if !(1..=MAX_FILES).contains(&intent.entries.len()) {
        return Err("中断的原件移动记录无效".into());
    }
    Ok(Some(Journal {
        id,
        committed,
        intent,
    }))
}

fn report(
    workspace: &str,
    status: RecoveryStatus,
    id: Option<String>,
    entries: Vec<RecoveryEntry>,
) -> FileMoveRecovery {
    FileMoveRecovery {
        workspace_id: workspace.to_owned(),
        operation_id: id,
        status,
        entries,
    }
}

fn entry_report(entry: &Entry, reason: Option<String>) -> RecoveryEntry {
    RecoveryEntry {
        paths: entry.paths.clone(),
        reason,
    }
}

struct Scope {
    root: PathBuf,
    protected: Vec<PathBuf>,
}

fn scope(catalog: &Catalog, app_data: &Path, intent: &Intent) -> Result<Scope, String> {
    let registered: String = catalog
        .conn
        .query_row(
            "SELECT path FROM libraries WHERE id=?1",
            [&intent.library_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or("原件所在的登记目录已移除")?;
    let path = position(&registered)?;
    fixed_drive(path)?;
    let root = canonical_directory(path)?;
    if path_key(&root) != path_key(Path::new(&intent.library_root))
        || Identity::read(&identity(&root)?)? != intent.library_identity
    {
        return Err("原件所在资产库的目录或磁盘身份已改变".into());
    }
    let protected = protected_paths(catalog, app_data, &intent.library_id)?;
    Ok(Scope { root, protected })
}

fn paths(
    catalog: &Catalog,
    scope: &Scope,
    journal: &Journal,
    entry: &Entry,
) -> Result<(PathBuf, PathBuf), String> {
    let original = position(&entry.paths.old_path)?;
    let destination = position(&entry.paths.path)?;
    if original.file_name() != destination.file_name()
        || path_key(original) == path_key(destination)
    {
        return Err("恢复记录中的文件名或移动位置无效".into());
    }
    let expected = if journal.committed {
        &entry.paths.path
    } else {
        &entry.paths.old_path
    };
    let row: Option<(String, String)> = catalog
        .conn
        .query_row(
            "SELECT path,library_id FROM assets WHERE id=?1",
            [&entry.paths.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    if !row.is_some_and(|(path, library)| path == *expected && library == journal.intent.library_id)
    {
        return Err("资产索引路径已变化，请先核对该资产记录".into());
    }
    let validate = |file: &Path, expected: Identity| -> Result<PathBuf, String> {
        let (parent, folder) = guarded_directory(
            &scope.root,
            file.parent().ok_or("恢复路径缺少目录")?,
            &scope.protected,
        )?;
        if Identity::read(&identity(&parent)?)? != expected
            || !journal.committed && folder_is_hidden(catalog, &journal.intent.library_id, &folder)?
        {
            return Err(format!(
                "原件目录已更换或已从资产库移除（{}）",
                clean_path(&parent)
            ));
        }
        Ok(parent.join(file.file_name().ok_or("恢复文件名无效")?))
    };
    Ok((
        if journal.committed {
            original.to_path_buf()
        } else {
            validate(original, entry.source_parent)?
        },
        validate(destination, journal.intent.target_parent)?,
    ))
}

#[derive(PartialEq)]
enum Presence {
    Missing,
    Original,
    Foreign,
}

fn presence(path: &Path, expected: Identity) -> Result<Presence, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Presence::Missing),
        Err(error) => return Err(format!("无法核对原件（{}）：{error}", clean_path(path))),
    }
    if read_ordinary(path).is_err() {
        return Ok(Presence::Foreign);
    }
    Ok(if Identity::read(&identity(path)?)? == expected {
        Presence::Original
    } else {
        Presence::Foreign
    })
}

struct Restore {
    from: PathBuf,
    to: PathBuf,
    from_parent: Identity,
    to_parent: Identity,
}

fn plan(
    catalog: &Catalog,
    scope: &Scope,
    journal: &Journal,
    entry: &Entry,
) -> Result<Option<Restore>, String> {
    let (old, new) = paths(catalog, scope, journal, entry)?;
    if journal.committed {
        return if presence(&new, entry.file)? == Presence::Original {
            Ok(None)
        } else {
            Err(format!(
                "移动已提交，但新位置的原件已变化（{}）",
                clean_path(&new)
            ))
        };
    }
    let (from, to) = (new, old);
    match (presence(&from, entry.file)?, presence(&to, entry.file)?) {
        (Presence::Original, Presence::Original) => {
            Err("两个位置都指向该原件，请先核对重复路径".into())
        }
        (_, Presence::Original) => Ok(None),
        (Presence::Original, Presence::Missing) => Ok(Some(Restore {
            from,
            to,
            from_parent: journal.intent.target_parent,
            to_parent: entry.source_parent,
        })),
        (_, Presence::Foreign) => Err(format!("恢复位置已被其他文件占用（{}）", clean_path(&to))),
        _ => Err("两个位置都未找到身份一致的原件".into()),
    }
}

fn restore(plan: &Restore, expected: Identity) -> Result<(), String> {
    let parent = |file: &Path, expected| -> Result<Handle, String> {
        let path = canonical_directory(file.parent().ok_or("恢复路径缺少目录")?)?;
        let handle = lock_directory(&path)?;
        if Identity::read(&handle)? != expected {
            return Err("恢复期间原件目录已更换".into());
        }
        Ok(handle)
    };
    let _from = parent(&plan.from, plan.from_parent)?;
    let _to = parent(&plan.to, plan.to_parent)?;
    let (file, _) = lock_original(&plan.from)?;
    if Identity::read(&file)? != expected {
        return Err("恢复期间原件已更换".into());
    }
    unoccupied(&plan.to)?;
    move_open_file(&file, &plan.to)?;
    if presence(&plan.to, expected)? != Presence::Original {
        return Err("无法确认恢复后的原件位置".into());
    }
    Ok(())
}

fn conflicting_paths<'a>(
    catalog: &Catalog,
    entries: &'a [Entry],
    committed: bool,
) -> Result<HashSet<&'a str>, String> {
    let mut paths = HashMap::new();
    for entry in entries {
        paths.insert(
            path_key(Path::new(&entry.paths.path)),
            entry.paths.id.as_str(),
        );
        if !committed {
            paths.insert(
                path_key(Path::new(&entry.paths.old_path)),
                entry.paths.id.as_str(),
            );
        }
    }
    let mut conflict = HashSet::new();
    let mut query = catalog
        .conn
        .prepare("SELECT id,path FROM assets")
        .map_err(db_error)?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    for row in rows {
        let (id, path) = row.map_err(db_error)?;
        if let Some(owner) = paths
            .get(&path_key(Path::new(&path)))
            .filter(|owner| **owner != id)
        {
            conflict.insert(*owner);
        }
    }
    Ok(conflict)
}

fn resolve(
    catalog: &Catalog,
    app_data: &Path,
    workspace: &str,
    journal: &Journal,
    apply: bool,
) -> Result<FileMoveRecovery, String> {
    if workspace != journal.intent.workspace_id
        || path_key(&catalog.dir) != path_key(Path::new(&journal.intent.workspace_dir))
    {
        return Err("恢复记录来自不同的个人资产库".into());
    }
    let context = match scope(catalog, app_data, &journal.intent) {
        Ok(scope) => scope,
        Err(error) => {
            return Ok(report(
                workspace,
                RecoveryStatus::Blocked,
                Some(journal.id.clone()),
                journal
                    .intent
                    .entries
                    .iter()
                    .map(|entry| entry_report(entry, Some(error.clone())))
                    .collect(),
            ))
        }
    };
    let mut pending = Vec::new();
    let mut blocked = Vec::new();
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    let conflicts = conflicting_paths(catalog, &journal.intent.entries, journal.committed)?;
    for entry in &journal.intent.entries {
        if !ids.insert(entry.paths.id.as_str())
            || !keys.insert(path_key(Path::new(&entry.paths.old_path)))
            || !keys.insert(path_key(Path::new(&entry.paths.path)))
        {
            blocked.push(entry_report(
                entry,
                Some("恢复记录含有重复的原件或位置".into()),
            ));
            continue;
        }
        if conflicts.contains(entry.paths.id.as_str()) {
            blocked.push(entry_report(
                entry,
                Some("恢复位置已有其他资产记录，请先核对索引".into()),
            ));
            continue;
        }
        match plan(catalog, &context, journal, entry) {
            Ok(Some(next)) => pending.push((entry, next)),
            Ok(None) => {}
            Err(error) => blocked.push(entry_report(entry, Some(error))),
        }
    }
    if !blocked.is_empty() || !apply {
        let reason = if blocked.is_empty() {
            "等待恢复原件"
        } else {
            "等待解决本次移动的其他冲突"
        };
        blocked.extend(
            pending
                .iter()
                .map(|(entry, _)| entry_report(entry, Some(reason.into()))),
        );
        let status = if blocked.is_empty() {
            RecoveryStatus::Clear
        } else {
            RecoveryStatus::Blocked
        };
        let operation = (!blocked.is_empty()).then(|| journal.id.clone());
        return Ok(report(workspace, status, operation, blocked));
    }
    for (entry, next) in &pending {
        if let Err(error) = restore(next, entry.file) {
            let mut result = resolve(catalog, app_data, workspace, journal, false)?;
            if matches!(result.status, RecoveryStatus::Clear) {
                break;
            }
            if let Some(row) = result
                .entries
                .iter_mut()
                .find(|row| row.paths.id == entry.paths.id)
            {
                row.reason = Some(error);
            }
            return Ok(result);
        }
    }
    clear(catalog, &journal.id)?;
    Ok(report(
        workspace,
        RecoveryStatus::Recovered,
        Some(journal.id.clone()),
        journal
            .intent
            .entries
            .iter()
            .map(|entry| entry_report(entry, None))
            .collect(),
    ))
}

pub(super) fn inspect(
    catalog: &Catalog,
    app_data: &Path,
    workspace: &str,
) -> Result<FileMoveRecovery, String> {
    match load(catalog)? {
        Some(journal) => resolve(catalog, app_data, workspace, &journal, false),
        None => Ok(report(workspace, RecoveryStatus::Clear, None, Vec::new())),
    }
}

pub(super) fn recover(
    catalog: &Catalog,
    app_data: &Path,
    workspace: &str,
    expected: Option<&str>,
) -> Result<FileMoveRecovery, String> {
    if load(catalog)?.is_none() {
        return Ok(report(workspace, RecoveryStatus::Clear, None, Vec::new()));
    }
    durable(catalog, || {
        let transaction = Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let Some(journal) = load(catalog)? else {
            return Ok(report(workspace, RecoveryStatus::Clear, None, Vec::new()));
        };
        if expected.is_some_and(|id| id != journal.id) {
            return Err("待恢复的移动记录已变化，请刷新后重试".into());
        }
        let result = resolve(catalog, app_data, workspace, &journal, true)?;
        transaction.commit().map_err(db_error)?;
        Ok(result)
    })
}
