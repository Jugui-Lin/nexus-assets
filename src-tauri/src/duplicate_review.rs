use crate::{
    asset_availability::{fixed_relink_drive, real_relink_directory, FINGERPRINT_FILE_LIMIT},
    lock_db, workspaces, AppState,
};
use nexus_core::{Asset, Catalog, FileFingerprint};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    hash::{DefaultHasher, Hash, Hasher},
    path::Path,
};
use tauri::State;

const MAX_RECORDS: usize = 1500;
const MAX_HASHES: usize = 96;
const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GROUPS: usize = 24;
const MAX_GROUP_MEMBERS: usize = 12;
static REVIEW_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Serialize)]
struct DuplicateRow {
    id: String,
    name: String,
    path: String,
    added: u64,
    favorite: bool,
}

#[derive(Serialize)]
struct DuplicateGroup {
    size: u64,
    fingerprint: String,
    members: Vec<DuplicateRow>,
}

#[derive(Serialize)]
pub(crate) struct DuplicateReview {
    scope: String,
    groups: Vec<DuplicateGroup>,
    examined: usize,
    hashed: usize,
    skipped: usize,
    truncated: bool,
}

fn scope_of(catalog: &Catalog) -> String {
    let mut hash = DefaultHasher::new();
    catalog.dir.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

fn dates(start: u64, end: u64) -> Result<std::ops::Range<u64>, String> {
    if start >= end || end > 253_402_300_799 {
        return Err("请选择有效的入库日期范围。".into());
    }
    Ok(start..end)
}

fn hex(digest: [u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn open_candidate(asset: &Asset) -> Option<&Path> {
    let path = Path::new(&asset.path);
    if asset.demo
        || asset.size == 0
        || asset.size > FINGERPRINT_FILE_LIMIT
        || !path.is_absolute()
        || !fixed_relink_drive(path)
        || !path
            .parent()
            .is_some_and(|parent| real_relink_directory(parent).unwrap_or(false))
    {
        return None;
    }
    Some(path)
}

fn checked_fingerprint(asset: &Asset) -> Option<FileFingerprint> {
    let path = open_candidate(asset)?;
    FileFingerprint::read(path, asset.size).ok()
}

fn review(state: &AppState, range: std::ops::Range<u64>) -> Result<DuplicateReview, String> {
    let (scope, mut assets) = {
        let catalog = lock_db(state)?;
        let mut query = catalog
            .conn
            .prepare(
                "SELECT data FROM assets a
             WHERE json_type(a.data,'$.added')='integer'
             AND json_extract(a.data,'$.added') >= ?1 AND json_extract(a.data,'$.added') < ?2
             AND NOT EXISTS (SELECT 1 FROM recycled_assets r WHERE r.asset_id=a.id)
             ORDER BY json_extract(a.data,'$.added') DESC,a.id LIMIT ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map(params![range.start, range.end, MAX_RECORDS + 1], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        let assets = rows
            .map(|row| {
                serde_json::from_str::<Asset>(&row.map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        (scope_of(&catalog), assets)
    };
    let mut truncated = assets.len() > MAX_RECORDS;
    assets.truncate(MAX_RECORDS);
    let examined = assets.len();
    let mut sizes = HashMap::new();
    for asset in &assets {
        if !asset.demo
            && (1..=FINGERPRINT_FILE_LIMIT).contains(&asset.size)
            && fixed_relink_drive(Path::new(&asset.path))
        {
            *sizes.entry(asset.size).or_insert(0) += 1;
        }
    }
    let mut matches: BTreeMap<(u64, [u8; 32]), Vec<DuplicateRow>> = BTreeMap::new();
    let mut remaining = MAX_BYTES;
    let mut hashed = 0;
    let mut skipped = 0;
    let mut attempts = 0;
    for asset in assets {
        if asset.demo
            || asset.size == 0
            || asset.size > FINGERPRINT_FILE_LIMIT
            || !fixed_relink_drive(Path::new(&asset.path))
        {
            skipped += 1;
            continue;
        }
        if sizes.get(&asset.size).copied().unwrap_or(0) < 2 {
            continue;
        }
        if attempts >= MAX_HASHES || asset.size > remaining {
            truncated = true;
            continue;
        }
        attempts += 1;
        remaining -= asset.size;
        let Some(fingerprint) = checked_fingerprint(&asset) else {
            skipped += 1;
            continue;
        };
        hashed += 1;
        matches
            .entry((asset.size, fingerprint.digest))
            .or_default()
            .push(DuplicateRow {
                id: asset.id,
                name: asset.name,
                path: asset.path,
                favorite: asset.favorite,
                added: asset.added.as_u64().unwrap_or(0),
            });
    }
    let mut groups = Vec::new();
    for ((size, digest), mut members) in matches.into_iter().rev() {
        if members.len() < 2 {
            continue;
        }
        truncated |= members.len() > MAX_GROUP_MEMBERS;
        members.truncate(MAX_GROUP_MEMBERS);
        if groups.len() >= MAX_GROUPS {
            truncated = true;
            break;
        }
        groups.push(DuplicateGroup {
            size,
            fingerprint: hex(digest),
            members,
        });
    }
    Ok(DuplicateReview {
        scope,
        groups,
        examined,
        hashed,
        skipped,
        truncated,
    })
}

fn active_asset(catalog: &Catalog, id: &str) -> Result<Asset, String> {
    let exists: Option<String> = catalog
        .conn
        .query_row(
            "SELECT id FROM assets a WHERE a.id=?1 AND NOT EXISTS
         (SELECT 1 FROM recycled_assets r WHERE r.asset_id=a.id)",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if exists.is_none() {
        return Err("此组包含已移除或已回收的索引，请重新检查。".into());
    }
    catalog.asset(id)
}

fn recycle_verified(
    state: &AppState,
    range: std::ops::Range<u64>,
    scope: &str,
    keeper: &str,
    duplicates: &[String],
    expected: &str,
) -> Result<usize, String> {
    if duplicates.is_empty()
        || duplicates.len() >= MAX_GROUP_MEMBERS
        || duplicates.iter().any(|id| id == keeper)
        || duplicates.iter().collect::<HashSet<_>>().len() != duplicates.len()
        || expected.len() != 64
        || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("请明确选择一条保留记录和要移入回收站的重复记录。".into());
    }
    let _workspace = workspaces::lock_io(state)?;
    let ids = std::iter::once(keeper).chain(duplicates.iter().map(String::as_str));
    let assets = {
        let catalog = lock_db(state)?;
        if scope_of(&catalog) != scope {
            return Err("个人库已切换，请重新检查。".into());
        }
        ids.map(|id| active_asset(&catalog, id))
            .collect::<Result<Vec<_>, _>>()?
    };
    let size = assets[0].size;
    if size.saturating_mul(assets.len() as u64) > MAX_BYTES
        || assets.iter().any(|asset| {
            asset.size != size
                || !asset
                    .added
                    .as_u64()
                    .is_some_and(|added| range.contains(&added))
        })
    {
        return Err("重复组的大小或入库日期已变化，请重新检查。".into());
    }
    let mut checked = Vec::new();
    for asset in &assets {
        let fingerprint = checked_fingerprint(asset).ok_or("原文件暂不可校验，请重新检查。")?;
        if hex(fingerprint.digest) != expected {
            return Err("组内文件内容已变化，请重新检查。".into());
        }
        checked.push(fingerprint);
    }
    let mut catalog = lock_db(state)?;
    for (asset, fingerprint) in assets.iter().zip(checked) {
        let current = active_asset(&catalog, &asset.id)?;
        if current.path != asset.path
            || current.size != asset.size
            || current.added != asset.added
            || !fingerprint.still_matches(Path::new(&current.path))
        {
            return Err("组内文件或索引已变化，请重新检查。".into());
        }
    }
    catalog.set_assets_recycled(duplicates, true)
}

#[tauri::command]
pub(crate) async fn review_asset_duplicates(
    state: State<'_, AppState>,
    start: u64,
    end: u64,
) -> Result<DuplicateReview, String> {
    let range = dates(start, end)?;
    let _slot = REVIEW_SLOT
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || review(&state, range))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn recycle_verified_duplicates(
    state: State<'_, AppState>,
    start: u64,
    end: u64,
    scope: String,
    keeper: String,
    duplicates: Vec<String>,
    fingerprint: String,
) -> Result<usize, String> {
    let range = dates(start, end)?;
    let _slot = REVIEW_SLOT
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        recycle_verified(&state, range, &scope, &keeper, &duplicates, &fingerprint)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Arc, Mutex},
    };

    #[test]
    fn date_range_excludes_other_rows_and_recycle_rechecks_selected_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let catalog = Catalog::open(&root.join("db")).unwrap();
        let mut paths = HashMap::new();
        for (name, bytes, added) in [
            ("A.obj", b"v 0 0 0\n", 400_u64),
            ("B.obj", b"v 0 0 0\n", 500),
            ("other.obj", b"v 1 1 1\n", 500),
            ("outside.obj", b"v 0 0 0\n", 300),
        ] {
            let path = root.join(name);
            fs::write(&path, bytes).unwrap();
            assert!(catalog.add_file(&path, "loose").unwrap());
            catalog
                .conn
                .execute(
                    "UPDATE assets SET data=json_set(data,'$.added',?1) WHERE path=?2",
                    params![added, nexus_core::clean_path(&path)],
                )
                .unwrap();
            paths.insert(name, path);
        }
        let state = AppState {
            db: Arc::new(Mutex::new(catalog)),
            root: root.to_path_buf(),
            workspace_io: Arc::new(Mutex::new(())),
            placement: crate::placement::PlacementTickets::default(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            token: String::new(),
            port: 0,
        };
        let report = review(&state, 400..600).unwrap();
        assert_eq!(report.examined, 3);
        assert_eq!(report.hashed, 3);
        assert_eq!(report.groups.len(), 1);
        let group = &report.groups[0];
        assert_eq!(group.members.len(), 2);
        let keeper = &group.members[0].id;
        let remove = [group.members[1].id.clone()];
        fs::write(&paths["A.obj"], b"v 2 2 2\n").unwrap();
        assert!(recycle_verified(
            &state,
            400..600,
            &report.scope,
            keeper,
            &remove,
            &group.fingerprint
        )
        .is_err());
        assert!(lock_db(&state)
            .unwrap()
            .list_recycled_assets()
            .unwrap()
            .is_empty());
        fs::write(&paths["A.obj"], b"v 0 0 0\n").unwrap();
        assert_eq!(
            recycle_verified(
                &state,
                400..600,
                &report.scope,
                keeper,
                &remove,
                &group.fingerprint
            )
            .unwrap(),
            1
        );
        let catalog = lock_db(&state).unwrap();
        assert_eq!(catalog.list_recycled_assets().unwrap()[0].id, remove[0]);
        assert!(catalog.asset(keeper).is_ok());
        assert!(paths.values().all(|path| path.is_file()));
    }
}
