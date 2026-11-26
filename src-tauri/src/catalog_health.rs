use crate::{
    folder_deletion::{is_link, path_key},
    lock_db,
    workspace_data::workspace_data_directory,
    AppState,
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const EXPECTED_INDEXES: &[&str] = &[
    "asset_kind",
    "asset_library",
    "asset_favorite",
    "asset_content_size",
    "job_session_status",
];
const MAX_DETAILS: usize = 100;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogHealth {
    checked_at: u64,
    client_version: String,
    schema_version: u64,
    directory: PathBuf,
    database_bytes: u64,
    wal_bytes: u64,
    assets: u64,
    catalogs: usize,
    registered_references: u64,
    loose_references: u64,
    orphan_references: u64,
    orphan_collection_members: u64,
    thumbnail_cache: CacheHealth,
    missing_indexes: Vec<&'static str>,
    database_issues: Vec<String>,
    registered_roots: Vec<PathBuf>,
    directory_overlaps: Vec<DirectoryOverlap>,
    directory_overlap_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheHealth {
    kind: &'static str,
    files: u64,
    bytes: u64,
    skipped: u64,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryOverlap {
    parent: PathBuf,
    child: PathBuf,
}

fn files_size(root: &Path, name: &str) -> Result<u64, String> {
    match fs::symlink_metadata(root.join(name)) {
        Ok(metadata) if metadata.is_file() && !is_link(&metadata) => Ok(metadata.len()),
        Ok(_) => Err(format!("{name} 必须是实际文件")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!("无法读取 {name} 的占用量：{error}")),
    }
}

fn cache_health(root: &Path, kind: &'static str) -> CacheHealth {
    let mut cache = CacheHealth {
        kind,
        files: 0,
        bytes: 0,
        skipped: 0,
        error: None,
    };
    let read = || {
        workspace_data_directory(root, &[kind], false)?
            .map(fs::read_dir)
            .transpose()
            .map_err(|error| error.to_string())
    };
    match read() {
        Ok(Some(entries)) => {
            for entry in entries {
                match entry.and_then(|entry| entry.metadata()) {
                    Ok(metadata) if metadata.is_file() && !is_link(&metadata) => {
                        cache.files += 1;
                        cache.bytes = cache.bytes.saturating_add(metadata.len());
                    }
                    _ => cache.skipped += 1,
                }
            }
        }
        Ok(None) => {}
        Err(error) => cache.error = Some(error),
    }
    cache
}

fn overlaps(roots: &[PathBuf]) -> (usize, Vec<DirectoryOverlap>) {
    let mut normalized: Vec<_> = roots
        .iter()
        .filter(|path| {
            path.is_absolute()
                && !path
                    .components()
                    .any(|component| component == Component::ParentDir)
        })
        .map(|path| (path_key(path), path))
        .collect();
    normalized.sort_by(|left, right| left.0.cmp(&right.0));
    let mut ancestors: Vec<(PathBuf, &PathBuf)> = Vec::new();
    let mut count = 0;
    let mut details = Vec::new();
    for (path, original) in normalized {
        while ancestors
            .last()
            .is_some_and(|(ancestor, _)| !path.starts_with(ancestor))
        {
            ancestors.pop();
        }
        count += ancestors.len();
        for (_, ancestor) in ancestors
            .iter()
            .take(MAX_DETAILS.saturating_sub(details.len()))
        {
            details.push(DirectoryOverlap {
                parent: (*ancestor).clone(),
                child: original.clone(),
            });
        }
        ancestors.push((path, original));
    }
    (count, details)
}

fn database_health(directory: &Path, version: String) -> Result<CatalogHealth, String> {
    let db_error = |error| format!("只读检查无法完成：{error}");
    let mut db = Connection::open_with_flags(
        directory.join("nexus.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(db_error)?;
    db.busy_timeout(Duration::from_secs(2)).map_err(db_error)?;
    let snapshot = db.transaction().map_err(db_error)?;

    let query = |sql| {
        snapshot
            .query_row(sql, [], |row| row.get::<_, u64>(0))
            .map_err(db_error)
    };
    let strings = |sql| -> Result<Vec<String>, String> {
        let mut statement = snapshot.prepare(sql).map_err(db_error)?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)
    };
    let schema_version = query("PRAGMA user_version")?;
    let indexes: HashSet<_> = strings("SELECT name FROM sqlite_schema WHERE type='index'")?
        .into_iter()
        .collect();
    let missing_indexes = EXPECTED_INDEXES
        .iter()
        .copied()
        .filter(|name| !indexes.contains(*name))
        .collect();
    let mut database_issues = strings("PRAGMA quick_check(20)")?;
    database_issues.retain(|result| result != "ok");
    database_issues.extend(strings(
        "SELECT printf('%s (row %s) → %s', [table], coalesce(rowid, '?'), parent)
         FROM pragma_foreign_key_check LIMIT 100",
    )?);
    let assets = query("SELECT count(*) FROM assets")?;
    let loose_references = query("SELECT count(*) FROM assets WHERE library_id='loose'")?;
    let orphan_references = query(
        "SELECT count(*) FROM assets AS a LEFT JOIN libraries AS l ON l.id=a.library_id
         WHERE a.library_id<>'loose' AND l.id IS NULL",
    )?;
    let orphan_collection_members = query(
        "SELECT count(*) FROM asset_collection_members AS m
         LEFT JOIN asset_collections AS c ON c.id=m.collection_id
         LEFT JOIN assets AS a ON a.id=m.asset_id
         WHERE c.id IS NULL OR (c.scope='personal' AND a.id IS NULL)",
    )?;
    let registered_roots: Vec<_> = strings("SELECT path FROM libraries ORDER BY path")?
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let (directory_overlap_count, directory_overlaps) = overlaps(&registered_roots);
    snapshot.rollback().map_err(db_error)?;
    let thumbnail_cache = cache_health(directory, "thumbnail-cache");

    Ok(CatalogHealth {
        checked_at: nexus_core::now(),
        client_version: version,
        schema_version,
        directory: directory.to_owned(),
        database_bytes: files_size(directory, "nexus.sqlite3")?,
        wal_bytes: files_size(directory, "nexus.sqlite3-wal")?,
        assets,
        catalogs: registered_roots.len(),
        registered_references: assets
            .saturating_sub(loose_references)
            .saturating_sub(orphan_references),
        loose_references,
        orphan_references,
        orphan_collection_members,
        thumbnail_cache,
        missing_indexes,
        database_issues,
        registered_roots,
        directory_overlaps,
        directory_overlap_count,
    })
}

#[tauri::command]
pub(super) async fn inspect_personal_catalog_health(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<CatalogHealth, String> {
    let version = app.package_info().version.to_string();
    let directory = lock_db(&state)?.dir.clone();
    tauri::async_runtime::spawn_blocking(move || database_health(&directory, version))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_existing_index_and_reference_problems_without_repairing_the_catalog() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = nexus_core::Catalog::open(scratch.path()).unwrap();
        let parent = scratch.path().join("assets");
        let child = parent.join("models");
        for (id, path) in [("primary", parent), ("nested", child)] {
            catalog
                .conn
                .execute(
                    "INSERT INTO libraries VALUES(?1,?2,'{}')",
                    [id, path.to_str().unwrap()],
                )
                .unwrap();
        }
        catalog
            .conn
            .execute_batch(
                "INSERT INTO assets VALUES('a','file-a','file-a','image','primary',0,'{}');
             INSERT INTO assets VALUES('b','file-b','file-b','image','loose',0,'{}');
             INSERT INTO assets VALUES('c','file-c','file-c','image','missing',0,'{}');
             INSERT INTO asset_collections VALUES('collection','personal','Collection');
             INSERT INTO asset_collection_members VALUES('collection','missing');
             DROP INDEX asset_favorite;",
            )
            .unwrap();
        let thumb = scratch.path().join("thumbnail-cache");
        fs::create_dir(&thumb).unwrap();
        fs::write(thumb.join("sample.webp"), [1, 2, 3]).unwrap();
        let result = database_health(scratch.path(), "test".into()).unwrap();
        assert_eq!(result.assets, 3);
        assert_eq!(result.registered_references, 1);
        assert_eq!(result.loose_references, 1);
        assert_eq!(result.orphan_references, 1);
        assert_eq!(result.orphan_collection_members, 1);
        assert_eq!(result.missing_indexes, ["asset_favorite"]);
        assert_eq!(result.directory_overlap_count, 1);
        assert_eq!(result.thumbnail_cache.bytes, 3);
        assert!(result.database_issues.is_empty());
        assert_eq!(
            database_health(scratch.path(), "test".into())
                .unwrap()
                .missing_indexes,
            ["asset_favorite"]
        );
    }
}
