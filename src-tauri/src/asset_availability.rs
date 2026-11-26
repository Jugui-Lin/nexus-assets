use crate::{drop_ingest::library_at_folder, lock_db, AppState};
use nexus_core::{asset_thumbnail, clean_path, now, Asset, Catalog, FileFingerprint};
use rusqlite::{params, ErrorCode, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{State, WebviewWindow};

#[derive(Default, Serialize)]
pub(crate) struct AvailabilityReport {
    missing: Vec<String>,
    unavailable: Vec<String>,
    #[serde(skip_serializing_if = "is_zero")]
    fingerprints: usize,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

pub(crate) struct CheckItem {
    id: String,
    file: Option<(PathBuf, PathBuf)>,
    restrict_to_anchor: bool,
}

impl CheckItem {
    pub(crate) fn mapped(id: String, file: Option<(PathBuf, PathBuf)>) -> Self {
        Self {
            id,
            file,
            restrict_to_anchor: true,
        }
    }
}

fn mount_anchor(path: &Path) -> Option<&Path> {
    if !path.is_absolute() {
        return None;
    }
    #[cfg(target_os = "macos")]
    if path.starts_with("/Volumes") {
        if let Some(volume) = path
            .ancestors()
            .find(|part| part.parent() == Some(Path::new("/Volumes")))
        {
            return Some(volume);
        }
    }
    path.ancestors().last()
}

pub(crate) fn check_items(catalog: &Catalog, ids: Vec<String>) -> Result<Vec<CheckItem>, String> {
    let roots: HashMap<_, _> = catalog
        .libraries()?
        .into_iter()
        .filter_map(|row| {
            Some((
                row["id"].as_str()?.to_owned(),
                PathBuf::from(row["path"].as_str()?),
            ))
        })
        .collect();
    let mut statement = catalog
        .conn
        .prepare_cached("SELECT path, library_id FROM assets WHERE id=?1")
        .map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let asset: Option<(String, String)> = statement
            .query_row([&id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(|error| error.to_string())?;
        let file = asset.and_then(|(path, library)| {
            let path = PathBuf::from(path);
            let anchor = roots
                .get(&library)
                .filter(|root| root.is_absolute() && path.starts_with(root))
                .map(PathBuf::as_path)
                .or_else(|| mount_anchor(&path))?
                .to_path_buf();
            Some((path, anchor))
        });
        items.push(CheckItem {
            id,
            file,
            restrict_to_anchor: false,
        });
    }
    Ok(items)
}

pub(crate) fn check_paths(items: Vec<CheckItem>) -> AvailabilityReport {
    let mut result = AvailabilityReport::default();
    let mut reachable_roots = HashMap::new();
    let mut canonical_roots = HashMap::new();
    for CheckItem {
        id,
        file,
        restrict_to_anchor,
    } in items
    {
        let Some((path, anchor)) = file else {
            result.unavailable.push(id);
            continue;
        };
        let checked = if restrict_to_anchor {
            let root = canonical_roots
                .entry(anchor.clone())
                .or_insert_with_key(|path| fs::canonicalize(path).ok().filter(|p| p.is_dir()));
            let Some(root) = root else {
                result.unavailable.push(id);
                continue;
            };
            fs::canonicalize(path).and_then(|file| {
                if !file.starts_with(root.as_path()) {
                    return Err(std::io::Error::new(
                        ErrorKind::PermissionDenied,
                        "outside mount",
                    ));
                }
                fs::metadata(file)
            })
        } else {
            fs::metadata(path)
        };
        match checked {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => result.missing.push(id),
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                if restrict_to_anchor
                    || *reachable_roots
                        .entry(anchor)
                        .or_insert_with_key(|path| path.is_dir())
                {
                    result.missing.push(id);
                } else {
                    result.unavailable.push(id);
                }
            }
            Err(_) => result.unavailable.push(id),
        }
    }
    result
}

struct Replacement {
    path: PathBuf,
    size: u64,
    modified: u64,
    thumbnail: Option<String>,
    fingerprint: Option<FileFingerprint>,
}

fn matches_relink_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
}

fn prepare_replacement(file: &Path, previous: &Asset) -> Result<Replacement, String> {
    if !file.is_absolute() {
        return Err("请选择绝对路径下的文件".into());
    }
    let path = fs::canonicalize(file).map_err(|error| format!("无法打开选中的文件（{error}）"))?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("无法读取选中的文件（{error}）"))?;
    if !metadata.is_file() {
        return Err("请选择一个资产文件".into());
    }
    if !matches_relink_extension(&path, &previous.ext) {
        return Err(format!("请选择相同格式的 .{} 文件", previous.ext));
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or_else(now);
    let thumbnail = if previous.kind == "texture" {
        None
    } else if previous.demo && clean_path(&path) == previous.path {
        previous.thumbnail.clone()
    } else {
        asset_thumbnail(&path)
    };
    Ok(Replacement {
        path,
        modified,
        thumbnail,
        size: metadata.len(),
        fingerprint: None,
    })
}

fn relink_file(
    catalog: &Catalog,
    previous: &Asset,
    replacement: Replacement,
) -> Result<Asset, String> {
    let folder = replacement.path.parent().ok_or("资产文件夹路径无效")?;
    let target = clean_path(&replacement.path);
    let transaction = Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current = catalog.asset(&previous.id)?;
    if current.path != previous.path {
        return Err("资产路径已更改，请刷新后重试".into());
    }
    if let Some(fingerprint) = replacement.fingerprint {
        if !fingerprint.still_matches(&replacement.path)
            || recorded_fingerprint(catalog, &current)? != Some(fingerprint.digest)
        {
            return Err("候选文件或原有内容校验已变化，请重新查找".into());
        }
    }
    let library_id = library_at_folder(catalog, folder)?.unwrap_or_else(|| "loose".to_owned());
    let file_data = json!({"size": replacement.size, "modified": replacement.modified,
                           "thumbnail": replacement.thumbnail});
    transaction
        .execute(
            "UPDATE assets SET path=?1, library_id=?2, data=json_set(data,
                '$.path',?1, '$.libraryId',?2, '$.size',json_extract(?3,'$.size'),
                '$.modified',json_extract(?3,'$.modified'), '$.thumbnail',json_extract(?3,'$.thumbnail'))
             WHERE id=?4",
            params![target, library_id, file_data.to_string(), previous.id],
        )
        .map_err(|error| {
            if error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
                "选中的文件已在个人资产库里建立索引".to_owned()
            } else {
                error.to_string()
            }
        })?;
    catalog.record_indexed_asset_directory(&replacement.path)?;
    let updated = catalog.asset(&previous.id)?;
    if let Some(fingerprint) = replacement.fingerprint {
        store_fingerprint(catalog, &updated, fingerprint)?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

const RELINK_ENTRY_LIMIT: usize = 1200;
const RELINK_DIRECTORY_LIMIT: usize = 40;
const RELINK_DEPTH_LIMIT: usize = 3;
const RELINK_RESULT_LIMIT: usize = 12;
const RELINK_TIME_LIMIT: Duration = Duration::from_millis(450);
pub(crate) const FINGERPRINT_FILE_LIMIT: u64 = 64 * 1024 * 1024;
const FINGERPRINT_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const FINGERPRINT_COUNT_LIMIT: usize = 8;
const FINGERPRINT_SEARCH_COUNT_LIMIT: usize = 24;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelinkSuggestions {
    candidates: Vec<RelinkCandidate>,
    truncated: bool,
    has_content_fingerprint: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelinkCandidate {
    path: String,
    name: String,
    match_factors: Vec<&'static str>,
    #[serde(skip)]
    score: u8,
}

#[cfg(windows)]
pub(crate) fn fixed_relink_drive(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    let (Prefix::Disk(letter) | Prefix::VerbatimDisk(letter)) = prefix.kind() else {
        return false;
    };
    crate::folder_browser::windows_drive_kind(&[u16::from(letter), b':' as u16, b'\\' as u16, 0])
        == "fixed"
}

#[cfg(not(windows))]
pub(crate) fn fixed_relink_drive(_path: &Path) -> bool {
    false
}

pub(crate) fn real_relink_directory(path: &Path) -> Result<bool, String> {
    let ancestors: Vec<_> = path.ancestors().collect();
    for directory in ancestors.into_iter().rev() {
        let metadata = match fs::symlink_metadata(directory) {
            Ok(metadata) => metadata,
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                return Ok(false);
            }
            Err(error) => return Err(format!("无法访问查找目录（{error}）")),
        };
        if crate::workspace_folder_move::link_or_reparse(&metadata) {
            return Err("位置经过链接或重分析点，请手动选择资产的新位置".into());
        }
        if !metadata.is_dir() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn collect_relink_candidates(
    previous: &Asset,
    root: &Path,
    max_depth: usize,
) -> Result<RelinkSuggestions, String> {
    let deadline = Instant::now() + RELINK_TIME_LIMIT;
    let old_path = Path::new(&previous.path);
    let old_parent = old_path.parent().ok_or("资产原位置不完整")?;
    if !root.is_absolute() || !fixed_relink_drive(root) {
        return Err("候选查找适用于本机固定磁盘中已索引的目录".into());
    }
    let original_depth = old_parent
        .strip_prefix(root)
        .map_err(|_| "原文件不在当前资产库登记的位置")?
        .components()
        .count();
    if !real_relink_directory(root)? {
        return Err("原资产库目录不可访问，请恢复连接或手动选择新位置".into());
    }
    let parent_exists = old_parent == root || real_relink_directory(old_parent)?;
    if parent_exists {
        match fs::symlink_metadata(old_path) {
            Ok(_) => return Err("原文件仍在，请刷新文件状态".into()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法确认原文件是否缺失（{error}）")),
        }
    }
    let mut result = RelinkSuggestions::default();
    let mut pending = VecDeque::from([(root.to_path_buf(), 0)]);
    if parent_exists && old_parent != root {
        // Look beside the old file first, then consider the registered library.
        pending.push_front((old_parent.to_path_buf(), original_depth));
    }
    let mut visited = HashSet::new();
    let mut examined = 0;
    'search: while let Some((directory, depth)) = pending.pop_front() {
        if Instant::now() >= deadline || visited.len() >= RELINK_DIRECTORY_LIMIT {
            result.truncated = true;
            break;
        }
        if !visited.insert(directory.clone()) {
            continue;
        }
        if !real_relink_directory(&directory).unwrap_or(false) {
            result.truncated = true;
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            result.truncated = true;
            continue;
        };
        for entry in entries {
            if examined >= RELINK_ENTRY_LIMIT || Instant::now() >= deadline {
                result.truncated = true;
                break 'search;
            }
            examined += 1;
            let Ok(entry) = entry else {
                result.truncated = true;
                continue;
            };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir()
                && (!file_type.is_file() || !matches_relink_extension(&path, &previous.ext))
            {
                continue;
            }
            let Some(metadata) = entry
                .metadata()
                .ok()
                .filter(|entry| !crate::workspace_folder_move::link_or_reparse(entry))
            else {
                continue;
            };
            if metadata.is_dir() {
                if depth < max_depth && visited.len() + pending.len() < RELINK_DIRECTORY_LIMIT {
                    pending.push_back((path, depth + 1));
                } else if max_depth > 0 {
                    result.truncated = true;
                }
                continue;
            }
            if !metadata.is_file() || !file_type.is_file() || metadata.len() != previous.size {
                continue;
            }
            let same_name = old_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|old| old.eq_ignore_ascii_case(&name));
            let same_time = previous.modified.as_u64().is_some_and(|old| {
                metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .is_some_and(|time| time.as_secs() == old)
            });
            let same_folder = directory == old_parent;
            let mut match_factors = vec!["扩展名相同", "文件大小相同"];
            if same_name {
                match_factors.push("原文件名相同");
            }
            if same_time {
                match_factors.push("修改时间相同");
            }
            if same_folder {
                match_factors.push("位于原文件夹");
            }
            result.candidates.push(RelinkCandidate {
                path: clean_path(&path),
                name,
                match_factors,
                score: 4 * u8::from(same_name) + 2 * u8::from(same_time) + u8::from(same_folder),
            });
        }
    }
    result
        .candidates
        .sort_unstable_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    Ok(result)
}

fn recorded_fingerprint(catalog: &Catalog, asset: &Asset) -> Result<Option<[u8; 32]>, String> {
    let Some(modified) = asset.modified.as_u64() else {
        return Ok(None);
    };
    let result: Option<Vec<u8>> = catalog
        .conn
        .query_row(
            "SELECT digest FROM asset_relink_fingerprints
             WHERE asset_id=?1 AND path=?2 AND size=?3 AND modified=?4",
            params![asset.id, asset.path, asset.size, modified],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(result.and_then(|row| row.try_into().ok()))
}

fn store_fingerprint(
    catalog: &Catalog,
    asset: &Asset,
    fingerprint: FileFingerprint,
) -> Result<(), String> {
    let Some(modified) = asset.modified.as_u64() else {
        return Ok(());
    };
    catalog
        .conn
        .execute(
            "INSERT INTO asset_relink_fingerprints (asset_id,path,size,modified,digest)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(asset_id) DO UPDATE SET path=excluded.path,size=excluded.size,
                modified=excluded.modified,digest=excluded.digest",
            params![
                asset.id,
                asset.path,
                asset.size,
                modified,
                fingerprint.digest.as_slice()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn collect_source_fingerprints(state: &AppState, items: &[CheckItem]) -> Result<usize, String> {
    let (catalog_dir, candidates) = {
        let catalog = lock_db(state)?;
        let candidates = items
            .iter()
            .take(250)
            .filter_map(|item| {
                let (path, _) = item.file.as_ref()?;
                if item.restrict_to_anchor || !fixed_relink_drive(path) {
                    return None;
                }
                let asset = catalog.asset(&item.id).ok()?;
                (!asset.demo
                    && asset.size > 0
                    && asset.size <= FINGERPRINT_FILE_LIMIT
                    && recorded_fingerprint(&catalog, &asset)
                        .ok()
                        .flatten()
                        .is_none())
                .then_some(asset)
            })
            .take(FINGERPRINT_COUNT_LIMIT)
            .collect::<Vec<_>>();
        (catalog.dir.clone(), candidates)
    };
    let mut remaining = FINGERPRINT_TOTAL_BYTES;
    let mut verified = Vec::new();
    for asset in candidates {
        if asset.size > remaining {
            continue;
        }
        let path = Path::new(&asset.path);
        if !path
            .parent()
            .is_some_and(|parent| real_relink_directory(parent).unwrap_or(false))
        {
            continue;
        }
        let stamp = fs::symlink_metadata(path)
            .ok()
            .and_then(|info| info.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_secs());
        if stamp.is_none() || stamp != asset.modified.as_u64() {
            continue;
        }
        remaining -= asset.size;
        let Ok(fingerprint) = FileFingerprint::read(path, asset.size) else {
            continue;
        };
        // A replacement between the initial check and hashing must not label old content.
        if !fingerprint.still_matches(path)
            || fs::metadata(path)
                .and_then(|info| info.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_secs())
                != stamp
        {
            continue;
        }
        verified.push((asset, fingerprint));
    }
    let catalog = lock_db(state)?;
    if catalog.dir != catalog_dir {
        return Ok(0);
    }
    let mut saved = 0;
    for (previous, fingerprint) in verified {
        let Ok(current) = catalog.asset(&previous.id) else {
            continue;
        };
        if current.path == previous.path
            && current.size == previous.size
            && current.modified == previous.modified
            && fingerprint.still_matches(Path::new(&current.path))
        {
            store_fingerprint(&catalog, &current, fingerprint)?;
            saved += 1;
        }
    }
    Ok(saved)
}

fn suggest_relinks(state: &AppState, id: &str) -> Result<RelinkSuggestions, String> {
    let (previous, root, max_depth, catalog_dir, source_fingerprint) = {
        let catalog = lock_db(state)?;
        let previous = catalog.asset(id)?;
        if previous.demo
            || previous.size == 0
            || nexus_core::kind(&previous.ext) != Some(previous.kind.as_str())
        {
            return Ok(RelinkSuggestions::default());
        }
        let registered: Option<String> = catalog
            .conn
            .query_row(
                "SELECT path FROM libraries WHERE id=?1",
                [&previous.library_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let (root, max_depth) = match registered {
            Some(path) => (PathBuf::from(path), RELINK_DEPTH_LIMIT),
            None if previous.library_id == "loose" => (
                Path::new(&previous.path)
                    .parent()
                    .ok_or("资产原位置不完整")?
                    .to_path_buf(),
                0,
            ),
            None => return Err("当前个人库已无法确认此资产的原目录".into()),
        };
        let fingerprint = recorded_fingerprint(&catalog, &previous)?;
        (previous, root, max_depth, catalog.dir.clone(), fingerprint)
    };
    let mut result = collect_relink_candidates(&previous, &root, max_depth)?;
    result.has_content_fingerprint = source_fingerprint.is_some();
    let catalog = lock_db(state)?;
    let current = catalog.asset(id)?;
    if catalog.dir != catalog_dir
        || current.path != previous.path
        || current.library_id != previous.library_id
        || current.size != previous.size
    {
        return Err("资产位置或个人库已更改，请刷新后重试".into());
    }
    let mut indexed = catalog
        .conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM assets WHERE path=?1)")
        .map_err(|error| error.to_string())?;
    let mut available = Vec::new();
    for candidate in result.candidates.drain(..) {
        let already_indexed: bool = indexed
            .query_row([&candidate.path], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if already_indexed {
            continue;
        }
        let limit = if source_fingerprint.is_some() {
            FINGERPRINT_SEARCH_COUNT_LIMIT
        } else {
            RELINK_RESULT_LIMIT
        };
        if available.len() >= limit {
            result.truncated = true;
            break;
        }
        available.push(candidate);
    }
    drop(indexed);
    drop(catalog);
    if let Some(expected) = source_fingerprint {
        let mut verified = Vec::new();
        let mut remaining = FINGERPRINT_TOTAL_BYTES;
        for mut candidate in available {
            if verified.len() >= RELINK_RESULT_LIMIT || previous.size > remaining {
                result.truncated = true;
                break;
            }
            let path = Path::new(&candidate.path);
            if !path
                .parent()
                .is_some_and(|parent| real_relink_directory(parent).unwrap_or(false))
            {
                result.truncated = true;
                continue;
            }
            remaining -= previous.size;
            match FileFingerprint::read(path, previous.size) {
                Ok(fingerprint) if fingerprint.digest == expected => {
                    candidate.match_factors.insert(0, "SHA-256 内容校验一致");
                    verified.push(candidate);
                }
                Ok(_) => {}
                Err(_) => result.truncated = true,
            }
        }
        result.candidates = verified;
    } else {
        result.candidates = available;
    }
    Ok(result)
}

fn prepare_confirmed_relink(
    state: &AppState,
    previous: &Asset,
    path: &str,
) -> Result<Replacement, String> {
    let suggestions = suggest_relinks(state, &previous.id)?;
    if !suggestions
        .candidates
        .iter()
        .any(|candidate| candidate.path == path)
    {
        return Err("该候选文件已不符合条件，请重新查找或手动选择".into());
    }
    let candidate = Path::new(path);
    let metadata =
        fs::symlink_metadata(candidate).map_err(|error| format!("无法读取候选文件（{error}）"))?;
    if crate::workspace_folder_move::link_or_reparse(&metadata) {
        return Err("候选文件已被链接替换，请重新查找".into());
    }
    let mut replacement = prepare_replacement(candidate, previous)?;
    if clean_path(&replacement.path) != path || replacement.size != previous.size {
        return Err("候选文件已变化，请重新查找".into());
    }
    if suggestions.has_content_fingerprint {
        let expected = recorded_fingerprint(&*lock_db(state)?, previous)?
            .ok_or("原有内容校验已变化，请重新查找")?;
        let fingerprint = FileFingerprint::read(candidate, previous.size)
            .map_err(|error| format!("无法再次校验候选文件（{error}）"))?;
        if fingerprint.digest != expected {
            return Err("候选文件的内容已变化，请重新查找".into());
        }
        replacement.fingerprint = Some(fingerprint);
    }
    Ok(replacement)
}

#[tauri::command]
pub(crate) async fn suggest_asset_relinks(
    state: State<'_, AppState>,
    id: String,
) -> Result<RelinkSuggestions, String> {
    if id.starts_with("team:") {
        return Err("候选查找适用于个人资产库".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || suggest_relinks(&state, &id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn check_asset_files(
    state: State<'_, AppState>,
    ids: Vec<String>,
    record_content: Option<bool>,
) -> Result<AvailabilityReport, String> {
    if ids.iter().any(|id| id.starts_with("team:")) {
        return Err("文件检查适用于个人资产库".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let items = check_items(&*lock_db(&state)?, ids)?;
        let fingerprints = if record_content.unwrap_or(false) {
            collect_source_fingerprints(&state, &items).unwrap_or(0)
        } else {
            0
        };
        let mut result = check_paths(items);
        result.fingerprints = fingerprints;
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn relink_asset_file(
    state: State<'_, AppState>,
    window: WebviewWindow,
    id: String,
    candidate_path: Option<String>,
) -> Result<Option<Asset>, String> {
    if id.starts_with("team:") {
        return Err("重新链接适用于个人资产库".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = crate::workspaces::lock_io(&state)?;
        let previous = lock_db(&state)?.asset(&id)?;
        if let Some(path) = candidate_path {
            let replacement = prepare_confirmed_relink(&state, &previous, &path)?;
            return relink_file(&*lock_db(&state)?, &previous, replacement).map(Some);
        }
        let mut dialog = rfd::FileDialog::new()
            .set_parent(&window)
            .set_title("选择资产的新位置")
            .add_filter(
                format!("{} 资产", previous.ext.to_uppercase()),
                &[&previous.ext],
            );
        if let Some(parent) = Path::new(&previous.path)
            .parent()
            .filter(|path| path.is_dir())
        {
            dialog = dialog.set_directory(parent);
        }
        let Some(path) = dialog.pick_file() else {
            return Ok(None);
        };
        let replacement = prepare_replacement(&path, &previous)?;
        relink_file(&*lock_db(&state)?, &previous, replacement).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(catalog: &Catalog, path: &Path, library: &str) -> Asset {
        fs::write(path, b"v 0 0 0\n").unwrap();
        assert!(catalog.add_file(path, library).unwrap());
        catalog.assets().unwrap().remove(0)
    }

    #[test]
    fn differentiates_missing_files_from_an_unreachable_library_root() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let root = scratch.path().join("NAS");
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let library = catalog.register_library(&root, None, "mounted").unwrap();
        let attached = index(
            &catalog,
            &root.join("seat.obj"),
            library["id"].as_str().unwrap(),
        );
        let current = index(&catalog, &scratch.path().join("current.obj"), "loose");
        let missing = index(&catalog, &scratch.path().join("missing.obj"), "loose");
        fs::remove_file(&missing.path).unwrap();
        fs::remove_file(&attached.path).unwrap();

        let checked = check_paths(check_items(&catalog, vec![attached.id.clone()]).unwrap());
        assert_eq!(checked.missing, vec![attached.id.clone()]);
        fs::remove_dir(&root).unwrap();
        let checked = check_paths(
            check_items(
                &catalog,
                vec![current.id, missing.id.clone(), attached.id.clone()],
            )
            .unwrap(),
        );
        assert_eq!(checked.missing, vec![missing.id]);
        assert_eq!(checked.unavailable, vec![attached.id]);
        assert_eq!(catalog.assets().unwrap().len(), 3);
    }

    #[test]
    fn checks_mapped_team_files_and_separates_missing_from_unmapped_or_unreachable() {
        let scratch = tempfile::tempdir().unwrap();
        let mount = scratch.path().join("共享库");
        fs::create_dir(&mount).unwrap();
        let available = mount.join("chair.obj");
        fs::write(&available, b"mesh").unwrap();
        let offline = scratch.path().join("offline");
        let result = check_paths(vec![
            CheckItem::mapped("team:available".into(), Some((available, mount.clone()))),
            CheckItem::mapped(
                "team:missing".into(),
                Some((mount.join("missing.obj"), mount)),
            ),
            CheckItem::mapped("team:unmapped".into(), None),
            CheckItem::mapped(
                "team:offline".into(),
                Some((offline.join("missing.obj"), offline)),
            ),
        ]);
        assert_eq!(result.missing, ["team:missing"]);
        assert_eq!(result.unavailable, ["team:unmapped", "team:offline"]);
    }

    #[test]
    fn relinks_without_replacing_identity_and_assigns_the_destination_library() {
        let scratch = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let first = scratch.path().join("old.obj");
        let folder = scratch.path().join("model library");
        fs::create_dir(&folder).unwrap();
        let folder = fs::canonicalize(folder).unwrap();
        let library = catalog.scan(&folder, None, "local", |_| {}).unwrap()["library"].clone();
        let previous = index(&catalog, &first, "loose");
        let collection = catalog.create_collection("personal", "家具").unwrap();
        catalog
            .set_collection_membership("personal", &collection.id, &[previous.id.clone()], true)
            .unwrap();
        // Simulate an inspector edit while the relink file picker is open.
        catalog
            .patch(
                &previous.id,
                json!({"name":"My model","rating":5,
                "workflow":"review","tags":["favorite"],"favorite":true,"notes":"Remember"}),
            )
            .unwrap();
        let new_path = folder.join("新目录/renamed.OBJ");
        fs::create_dir_all(new_path.parent().unwrap()).unwrap();
        fs::rename(&first, &new_path).unwrap();
        fs::write(&new_path, "v 0 0 0\nv 1 1 1\n").unwrap();
        let thumbnail = new_path.with_extension("png");
        fs::write(&thumbnail, "sidecar").unwrap();
        let replacement = prepare_replacement(&new_path, &previous).unwrap();
        let next = relink_file(&catalog, &previous, replacement).unwrap();

        assert_eq!(next.id, previous.id);
        assert_eq!(next.name, "My model");
        assert_eq!(next.notes, "Remember");
        assert_eq!(next.rating, 5);
        assert_eq!(next.workflow, nexus_core::WorkflowStatus::Review);
        assert_eq!(next.tags, vec!["favorite"]);
        assert!(next.favorite);
        assert_eq!(next.added, previous.added);
        assert_eq!(next.library_id, library["id"].as_str().unwrap());
        assert_eq!(Path::new(&next.path), Path::new(&clean_path(&new_path)));
        assert_eq!(next.size, 16);
        assert_eq!(next.thumbnail, Some(clean_path(&thumbnail)));
        let library = catalog.libraries().unwrap().remove(0);
        assert_eq!(library["foldersComplete"], true);
        assert_eq!(library["folders"], json!(["新目录"]));
        assert_eq!(
            catalog.list_collections("personal").unwrap()[0].asset_ids,
            vec![next.id]
        );
        assert_eq!(catalog.assets().unwrap().len(), 1);
    }

    #[test]
    fn rejects_incompatible_assets_and_preserves_both_records_on_a_collision() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let asset = index(&catalog, &scratch.path().join("first.obj"), "loose");
        let occupied = index(&catalog, &scratch.path().join("second.obj"), "loose");
        let incompatible = scratch.path().join("third.fbx");
        fs::write(&incompatible, "fbx").unwrap();
        let mismatch = prepare_replacement(&incompatible, &asset).err().unwrap();
        assert!(mismatch.contains("相同格式"));
        let replacement = prepare_replacement(Path::new(&occupied.path), &asset).unwrap();
        assert!(relink_file(&catalog, &asset, replacement)
            .unwrap_err()
            .contains("已在个人资产库里建立索引"));
        assert_eq!(catalog.asset(&asset.id).unwrap().path, asset.path);
        assert_eq!(catalog.asset(&occupied.id).unwrap().path, occupied.path);
    }

    #[cfg(windows)]
    fn suggestion_fixture(registered: bool) -> (tempfile::TempDir, AppState, PathBuf, Asset) {
        use std::sync::{Arc, Mutex};

        let scratch = tempfile::tempdir().unwrap();
        fs::create_dir(scratch.path().join("模型库")).unwrap();
        let root = fs::canonicalize(scratch.path().join("模型库")).unwrap();
        let root = PathBuf::from(clean_path(&root));
        let catalog = Catalog::open(&scratch.path().join("database")).unwrap();
        let library = if registered {
            catalog.register_library(&root, None, "local").unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        } else {
            "loose".to_owned()
        };
        let original = index(&catalog, &root.join("模型.obj"), &library);
        let state = AppState {
            db: Arc::new(Mutex::new(catalog)),
            root: scratch.path().to_path_buf(),
            workspace_io: Arc::new(Mutex::new(())),
            placement: crate::placement::PlacementTickets::default(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            token: String::new(),
            port: 0,
        };
        (scratch, state, root, original)
    }

    #[cfg(windows)]
    #[test]
    fn ranks_local_candidates_without_modifying_or_returning_other_indexed_assets() {
        let (scratch, state, root, original) = suggestion_fixture(true);
        assert!(suggest_relinks(&state, &original.id).is_err());
        let moved = root.join("交付").join("模型.OBJ");
        fs::create_dir(moved.parent().unwrap()).unwrap();
        fs::rename(&original.path, &moved).unwrap();
        fs::write(root.join("同大小.obj"), b"v 0 0 0\n").unwrap();
        fs::write(root.join("尺寸不符.obj"), b"unequal size").unwrap();
        fs::write(root.join("格式不符.fbx"), b"v 0 0 0\n").unwrap();
        fs::write(scratch.path().join("外部.obj"), b"v 0 0 0\n").unwrap();
        let indexed = root.join("其他资产.obj");
        fs::write(&indexed, b"v 0 0 0\n").unwrap();
        lock_db(&state)
            .unwrap()
            .add_file(&indexed, &original.library_id)
            .unwrap();

        let result = suggest_relinks(&state, &original.id).unwrap();
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(result.candidates[0].path, clean_path(&moved));
        assert!(result.candidates[0].match_factors.contains(&"原文件名相同"));
        assert!(result.candidates[0].match_factors.contains(&"修改时间相同"));
        assert!(result.candidates[1].match_factors.contains(&"位于原文件夹"));
        assert_eq!(
            lock_db(&state).unwrap().asset(&original.id).unwrap().path,
            original.path
        );

        assert!(prepare_confirmed_relink(&state, &original, &clean_path(&indexed)).is_err());
        let replacement = prepare_confirmed_relink(&state, &original, &clean_path(&moved)).unwrap();
        let updated = relink_file(&*lock_db(&state).unwrap(), &original, replacement).unwrap();
        assert_eq!(updated.id, original.id);
        assert_eq!(updated.path, clean_path(&moved));
    }

    #[cfg(windows)]
    #[test]
    fn caps_results_and_keeps_loose_assets_in_their_original_directory() {
        let (_scratch, state, root, original) = suggestion_fixture(false);
        fs::remove_file(&original.path).unwrap();
        fs::create_dir(root.join("子目录")).unwrap();
        fs::write(root.join("子目录/模型.obj"), b"v 0 0 0\n").unwrap();
        let result = suggest_relinks(&state, &original.id).unwrap();
        assert!(result.candidates.is_empty());
        assert!(!result.truncated);
        for number in 0..=RELINK_RESULT_LIMIT {
            fs::write(root.join(format!("候选{number}.obj")), b"v 0 0 0\n").unwrap();
        }
        let result = suggest_relinks(&state, &original.id).unwrap();
        assert_eq!(result.candidates.len(), RELINK_RESULT_LIMIT);
        assert!(result.truncated);
        let candidate = &result.candidates[0].path;
        fs::write(candidate, b"new contents and size").unwrap();
        assert!(prepare_confirmed_relink(&state, &original, candidate).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn relinks_only_matching_bytes_when_original_checksum_was_recorded() {
        let (_scratch, state, root, original) = suggestion_fixture(true);
        let items = check_items(&*lock_db(&state).unwrap(), vec![original.id.clone()]).unwrap();
        assert_eq!(collect_source_fingerprints(&state, &items).unwrap(), 1);
        assert_eq!(collect_source_fingerprints(&state, &items).unwrap(), 0);
        let moved = root.join("换了名字.obj");
        fs::rename(&original.path, &moved).unwrap();
        let impostor = root.join("同样大小.obj");
        fs::write(&impostor, b"v 1 1 1\n").unwrap();

        let result = suggest_relinks(&state, &original.id).unwrap();
        assert!(result.has_content_fingerprint);
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].path, clean_path(&moved));
        assert_eq!(
            result.candidates[0].match_factors[0],
            "SHA-256 内容校验一致"
        );
        assert!(prepare_confirmed_relink(&state, &original, &clean_path(&impostor)).is_err());

        let replacement = prepare_confirmed_relink(&state, &original, &clean_path(&moved)).unwrap();
        let catalog = lock_db(&state).unwrap();
        let expected = recorded_fingerprint(&catalog, &original).unwrap();
        let changed = relink_file(&catalog, &original, replacement).unwrap();
        assert_eq!(changed.id, original.id);
        assert_eq!(changed.path, clean_path(&moved));
        assert_eq!(recorded_fingerprint(&catalog, &changed).unwrap(), expected);
    }
}
