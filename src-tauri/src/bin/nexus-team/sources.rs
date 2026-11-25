use super::{
    bump_revision, db_error, error, link_relative_path, restore_link_visibility,
    validate_link_folder, with_member, ApiError, ApiResult, Store, WatchRefresh,
    FOLDER_LINK_VALIDATIONS, MAX_LINKS_PER_LIBRARY,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Extension, Json, Router,
};
use nexus_core::{clean_path, team::relative_path};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    env, fs, io,
    path::{Path as FilePath, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    id: String,
    path: PathBuf,
    unc: String,
}

#[derive(Clone)]
pub(super) struct SourceRoots(Arc<ConfiguredSources>);

struct ConfiguredSources {
    roots: Vec<Source>,
    register: Mutex<()>,
}

impl SourceRoots {
    pub(super) fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let entries = match env::var("NEXUS_TEAM_SOURCE_ROOTS") {
            Ok(json) => serde_json::from_str::<Vec<Source>>(&json)?,
            Err(env::VarError::NotPresent) => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        if entries.len() > 16 {
            return Err("最多配置 16 个团队 NAS 来源".into());
        }
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        let mut roots = Vec::new();
        for mut source in entries {
            let unc = normalized_unc(&source.unc).ok_or("NAS 来源需填写合法 UNC 共享路径")?;
            if source.id.is_empty()
                || source.id.len() > 64
                || !source
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                || !source.path.is_absolute()
            {
                return Err("NAS 来源编号或容器内绝对路径无效".into());
            }
            if !ids.insert(source.id.clone()) || !paths.insert(unc.to_lowercase()) {
                return Err("NAS 来源编号或 UNC 路径重复".into());
            }
            source.unc = unc;
            roots.push(source);
        }
        Ok(Self(Arc::new(ConfiguredSources {
            roots,
            register: Mutex::new(()),
        })))
    }

    pub(super) fn routes(self, refresh: Arc<WatchRefresh>) -> Router<Store> {
        Router::new()
            .route("/v1/source-roots", get(list))
            .route(
                "/v1/source-roots/{id}/libraries",
                post(add)
                    .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(8192))
                    .layer(Extension(refresh)),
            )
            .layer(Extension(self))
    }
}

fn normalized_unc(value: &str) -> Option<String> {
    let value = value.trim_end_matches('\\');
    let body = value.strip_prefix("\\\\")?;
    let (host, share) = body.split_once('\\')?;
    if host.is_empty()
        || host.len() > 253
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        || !host.bytes().any(|byte| byte.is_ascii_alphanumeric())
    {
        return None;
    }
    let share = share.replace('\\', "/");
    if share.is_empty() || link_relative_path(&share).is_none() || value.contains('/') {
        return None;
    }
    Some(value.into())
}

#[derive(Serialize)]
struct PublicSource {
    id: String,
    unc: String,
}

#[derive(Serialize)]
pub(super) struct SourceList {
    roots: Vec<PublicSource>,
}

async fn list(
    State(store): State<Store>,
    Extension(sources): Extension<SourceRoots>,
    headers: HeaderMap,
) -> ApiResult<SourceList> {
    with_member(store, headers, move |_, _| {
        Ok(SourceList {
            roots: sources
                .0
                .roots
                .iter()
                .map(|source| PublicSource {
                    id: source.id.clone(),
                    unc: source.unc.clone(),
                })
                .collect(),
        })
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkSource {
    folder: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceLink {
    library_id: String,
    folder: String,
    created: bool,
    index_pending: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    consolidated: Vec<Consolidation>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Consolidation {
    previous_library_id: String,
    library_id: String,
    folder: String,
}

struct NewWatch {
    root: PathBuf,
    name: String,
}

struct PlannedLink {
    id: String,
    folder: String,
    new_watch: Option<NewWatch>,
    unc: Option<String>,
    descendants: Vec<(String, String)>,
}

#[derive(Debug, PartialEq, Eq)]
struct Coordinates {
    device: String,
    path: PathBuf,
}

impl Coordinates {
    fn under(&self, root: &Self) -> Option<PathBuf> {
        if self.device != root.device {
            return None;
        }
        #[cfg(windows)]
        {
            let key = |path: &FilePath| PathBuf::from(path.to_string_lossy().to_lowercase());
            key(&self.path).starts_with(key(&root.path)).then(|| {
                self.path
                    .iter()
                    .skip(root.path.components().count())
                    .collect()
            })
        }
        #[cfg(not(windows))]
        self.path
            .strip_prefix(&root.path)
            .ok()
            .map(FilePath::to_path_buf)
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct Mount {
    device: String,
    root: PathBuf,
    point: PathBuf,
}

struct Mounts {
    #[cfg(target_os = "linux")]
    entries: Vec<Mount>,
}

impl Mounts {
    fn load() -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        return Ok(Self {
            entries: parse_mounts(&fs::read("/proc/self/mountinfo")?),
        });
        #[cfg(not(target_os = "linux"))]
        Ok(Self {})
    }

    fn coordinates(&self, path: &FilePath) -> Option<Coordinates> {
        // Docker bind mounts can give the same on-disk tree different paths inside the container.
        #[cfg(target_os = "linux")]
        return self
            .entries
            .iter()
            .filter_map(|mount| {
                path.strip_prefix(&mount.point)
                    .ok()
                    .map(|suffix| (mount, suffix))
            })
            .max_by_key(|(mount, _)| mount.point.components().count())
            .map(|(mount, suffix)| Coordinates {
                device: mount.device.clone(),
                path: mount.root.join(suffix),
            });
        #[cfg(not(target_os = "linux"))]
        Some(Coordinates {
            device: String::new(),
            path: path.to_path_buf(),
        })
    }
}

#[cfg(target_os = "linux")]
fn parse_mounts(data: &[u8]) -> Vec<Mount> {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    fn path(field: &[u8]) -> PathBuf {
        let mut bytes = Vec::with_capacity(field.len());
        let mut cursor = 0;
        while cursor < field.len() {
            let tail = &field[cursor..];
            match tail {
                [b'\\', a @ b'0'..=b'3', b @ b'0'..=b'7', c @ b'0'..=b'7', ..] => {
                    bytes.push((a - b'0') * 64 + (b - b'0') * 8 + (c - b'0'));
                    cursor += 4;
                }
                [byte, ..] => {
                    bytes.push(*byte);
                    cursor += 1;
                }
                [] => break,
            }
        }
        PathBuf::from(OsString::from_vec(bytes))
    }
    data.split(|byte| *byte == b'\n')
        .filter_map(|line| {
            let mut fields = line.split(|byte| *byte == b' ').skip(2);
            let device = std::str::from_utf8(fields.next()?).ok()?.into();
            let root = path(fields.next()?);
            let point = path(fields.next()?);
            (root.is_absolute() && point.is_absolute()).then_some(Mount {
                device,
                root,
                point,
            })
        })
        .collect()
}

fn slash_path(path: &FilePath) -> Option<String> {
    let folder = path
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()?
        .join("/");
    link_relative_path(&folder)?;
    Some(folder)
}

fn join_unc(root: &str, relative: &str) -> String {
    if relative.is_empty() {
        root.into()
    } else {
        format!("{root}\\{}", relative.replace('/', "\\"))
    }
}

fn watched_roots(conn: &Connection) -> Result<Vec<(String, String)>, ApiError> {
    let mut list = conn
        .prepare("SELECT library,root FROM watched_libraries ORDER BY library")
        .map_err(db_error)?;
    let rows = list
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_error)?;
    rows.collect::<Result<_, _>>().map_err(db_error)
}

pub(super) fn catalog_paths(conn: &Connection) -> Result<BTreeMap<String, String>, ApiError> {
    let mut list = conn
        .prepare("SELECT library,unc FROM library_source_paths")
        .map_err(db_error)?;
    let rows = list
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_error)?;
    rows.collect::<Result<_, _>>().map_err(db_error)
}

fn plan(
    source: Source,
    folder: &str,
    watched: &[(String, String)],
) -> Result<PlannedLink, ApiError> {
    let unavailable = || {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "无法访问 NAS 来源，请检查服务端挂载",
        )
    };
    let compare = || {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "无法确认现有团队库的挂载，请先检查 NAS 映射",
        )
    };
    let root = fs::canonicalize(&source.path)
        .ok()
        .filter(|root| root.is_dir())
        .ok_or_else(unavailable)?;
    let folder = validate_link_folder(&root, folder)
        .map_err(|message| error(StatusCode::BAD_REQUEST, message))?;
    let selected = root.join(link_relative_path(&folder).expect("normalized folder path"));
    let mounts = Mounts::load().map_err(|_| compare())?;
    let root = mounts.coordinates(&root).ok_or_else(compare)?;
    let physical = mounts.coordinates(&selected).ok_or_else(compare)?;
    if physical.under(&root).is_none() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "所选文件夹不在已配置的 NAS 来源内",
        ));
    }
    let mut ancestor = None;
    let mut descendants = Vec::new();
    for (id, watch_root) in watched {
        let watch_root = fs::canonicalize(watch_root).map_err(|_| compare())?;
        let existing = mounts.coordinates(&watch_root).ok_or_else(compare)?;
        if existing.device != physical.device
            && (watch_root.starts_with(&selected) || selected.starts_with(&watch_root))
        {
            return Err(error(
                StatusCode::CONFLICT,
                "所选文件夹与现有团队库跨越不同的 NAS 挂载，请分别链接",
            ));
        }
        if let Some(relative) = physical.under(&existing) {
            let specificity = existing.path.components().count();
            if ancestor
                .as_ref()
                .is_none_or(|(depth, _)| specificity > *depth)
            {
                let folder = slash_path(&relative).ok_or_else(compare)?;
                let unc = existing
                    .under(&root)
                    .and_then(|path| slash_path(&path))
                    .map(|path| join_unc(&source.unc, &path));
                ancestor = Some((
                    specificity,
                    PlannedLink {
                        id: id.clone(),
                        folder,
                        new_watch: None,
                        unc,
                        descendants: Vec::new(),
                    },
                ));
            }
        } else if let Some(relative) = existing.under(&physical) {
            let prefix = slash_path(&relative).ok_or_else(compare)?;
            let normalized = validate_link_folder(&selected, &prefix).map_err(|_| compare())?;
            let target = selected.join(link_relative_path(&normalized).ok_or_else(compare)?);
            let target = fs::canonicalize(target).map_err(|_| compare())?;
            if !mounts
                .coordinates(&target)
                .and_then(|target| target.under(&existing))
                .is_some_and(|relative| relative.as_os_str().is_empty())
            {
                return Err(compare());
            }
            descendants.push((id.clone(), normalized));
        }
    }
    if let Some((_, mut plan)) = ancestor {
        plan.descendants = descendants;
        return Ok(plan);
    }
    let name = folder
        .rsplit('/')
        .next()
        .unwrap_or(&folder)
        .chars()
        .take(200)
        .collect();
    Ok(PlannedLink {
        id: Uuid::new_v4().to_string(),
        folder: String::new(),
        new_watch: Some(NewWatch {
            root: selected,
            name,
        }),
        unc: Some(join_unc(&source.unc, &folder)),
        descendants,
    })
}

fn joined_folder(prefix: &str, folder: &str) -> String {
    if prefix.is_empty() {
        folder.to_owned()
    } else if folder.is_empty() {
        prefix.to_owned()
    } else {
        format!("{prefix}/{folder}")
    }
}

fn checked_rebase(prefix: &str, folder: &str) -> Result<String, ApiError> {
    let path = joined_folder(prefix, folder);
    if link_relative_path(&path).is_none() {
        return Err(error(
            StatusCode::CONFLICT,
            "合并后的文件夹路径无法索引，请选择更具体的 NAS 目录",
        ));
    }
    Ok(path)
}

fn move_assets(
    db: &Connection,
    previous: &str,
    target: &str,
    folder: &str,
    occupied: &mut HashSet<String>,
) -> Result<(), ApiError> {
    let mut query = db
        .prepare(
            "SELECT id,relative,COALESCE(json_extract(data,'$.storageLibraryId'),library),
                COALESCE(json_extract(data,'$.storageFolder'),'') FROM assets WHERE library=?1",
        )
        .map_err(db_error)?;
    let assets = query
        .query_map([previous], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut update = db
        .prepare(
            "UPDATE assets SET library=?2,relative=?3,data=json_set(data,
                '$.libraryId',?2,'$.relativePath',?3,
                '$.storageLibraryId',?4,'$.storageFolder',?5,
                '$.revision',json_extract(data,'$.revision')+1)
             WHERE id=?1",
        )
        .map_err(db_error)?;
    for (id, previous_path, storage_library, old_storage_folder) in assets {
        let path = joined_folder(folder, &previous_path);
        if relative_path(&path).is_none_or(|path| path.components().count() > 32) {
            return Err(error(
                StatusCode::CONFLICT,
                "合并后的资产路径无法索引，请选择更具体的 NAS 目录",
            ));
        }
        if !occupied.insert(path.to_lowercase()) {
            return Err(error(
                StatusCode::CONFLICT,
                &format!("已有多个团队库独立索引同一资产「{path}」，为保留原记录，本次未合并"),
            ));
        }
        let storage_folder = checked_rebase(folder, &old_storage_folder)?;
        update
            .execute(params![id, target, path, storage_library, storage_folder])
            .map_err(db_error)?;
    }
    Ok(())
}

fn move_folder_records(
    db: &Connection,
    previous: &str,
    target: &str,
    prefix: &str,
) -> Result<(), ApiError> {
    let queries = [
        (
            "SELECT folder FROM watched_folders WHERE library=?1",
            "INSERT OR IGNORE INTO watched_folders(library,folder) VALUES(?1,?2)",
        ),
        (
            "SELECT folder FROM hidden_folders WHERE library=?1",
            "INSERT OR IGNORE INTO hidden_folders(library,folder) VALUES(?1,?2)",
        ),
        (
            "SELECT folder FROM linked_folders WHERE library=?1 AND folder<>''",
            "INSERT OR IGNORE INTO linked_folders(library,folder) VALUES(?1,?2)",
        ),
    ];
    for (read, write) in queries {
        let mut query = db.prepare(read).map_err(db_error)?;
        let mut update = db.prepare(write).map_err(db_error)?;
        let folders = query
            .query_map([previous], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for folder in folders {
            let folder = checked_rebase(prefix, &folder)?;
            update.execute(params![target, folder]).map_err(db_error)?;
        }
    }
    db.execute(
        "INSERT OR IGNORE INTO watched_folders(library,folder) VALUES(?1,?2)",
        params![target, prefix],
    )
    .map_err(db_error)?;
    Ok(())
}

fn consolidate_descendants(db: &Connection, link: &PlannedLink) -> Result<usize, ApiError> {
    if link.descendants.is_empty() {
        return Ok(0);
    }
    let mut occupied_query = db
        .prepare("SELECT relative FROM assets WHERE library=?1")
        .map_err(db_error)?;
    let mut occupied = occupied_query
        .query_map([&link.id], |row| {
            Ok(row.get::<_, String>(0)?.to_lowercase())
        })
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)?;
    for (previous, relative) in &link.descendants {
        let folder = checked_rebase(&link.folder, relative)?;
        move_assets(db, previous, &link.id, &folder, &mut occupied)?;
        move_folder_records(db, previous, &link.id, &folder)?;
        let mut prior = db
            .prepare("SELECT previous_library,folder FROM library_consolidations WHERE library=?1")
            .map_err(db_error)?;
        let mut update = db
            .prepare(
                "UPDATE library_consolidations SET library=?2,folder=?3 WHERE previous_library=?1",
            )
            .map_err(db_error)?;
        let rows = prior
            .query_map([previous], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for (old, relative) in rows {
            let rebased = checked_rebase(&folder, &relative)?;
            update
                .execute(params![old, link.id, rebased])
                .map_err(db_error)?;
        }
        db.execute(
            "INSERT INTO library_consolidations(previous_library,library,folder) VALUES(?1,?2,?3)",
            params![previous, link.id, folder],
        )
        .map_err(db_error)?;
        super::quick_access::relocate_pins(db, previous, "", &link.id, &folder)?;
        // Removing only the redundant catalog entry keeps NAS files and ID-based data intact.
        db.execute("DELETE FROM watched_libraries WHERE library=?1", [previous])
            .map_err(db_error)?;
        db.execute("DELETE FROM libraries WHERE id=?1", [previous])
            .map_err(db_error)?;
    }
    Ok(link.descendants.len())
}

fn consolidated_folders(
    db: &Connection,
    link: &PlannedLink,
) -> Result<Vec<Consolidation>, ApiError> {
    let branch = format!("{}/", link.folder);
    let mut query = db.prepare(
        "SELECT previous_library,folder FROM library_consolidations WHERE library=?1 ORDER BY folder,previous_library"
    ).map_err(db_error)?;
    let rows = query
        .query_map([&link.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    let mut consolidated = Vec::new();
    for row in rows {
        let (previous_library_id, folder) = row.map_err(db_error)?;
        if link.folder.is_empty() || folder == link.folder || folder.starts_with(&branch) {
            consolidated.push(Consolidation {
                previous_library_id,
                library_id: link.id.clone(),
                folder,
            });
        }
    }
    Ok(consolidated)
}

fn persist(
    conn: &mut Connection,
    link: PlannedLink,
    checked: &[(String, String)],
) -> Result<SourceLink, ApiError> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if watched_roots(&tx)? != checked {
        return Err(error(
            StatusCode::CONFLICT,
            "团队扫描目录已更新，请重新链接文件夹",
        ));
    }
    let created = link.new_watch.is_some();
    let mut changes = 0;
    if let Some(watch) = &link.new_watch {
        tx.execute(
            "INSERT INTO libraries(id,name) VALUES(?1,?2)",
            params![link.id, watch.name],
        )
        .map_err(db_error)?;
        changes += tx
            .execute(
                "INSERT INTO watched_libraries(library,root) VALUES(?1,?2)",
                params![link.id, clean_path(&watch.root)],
            )
            .map_err(db_error)?;
    }
    changes += consolidate_descendants(&tx, &link)?;
    changes += restore_link_visibility(&tx, &link.id, &link.folder)?;
    if let Some(unc) = &link.unc {
        changes += tx
            .execute(
                "INSERT OR IGNORE INTO library_source_paths(library,unc) VALUES(?1,?2)",
                params![link.id, unc],
            )
            .map_err(db_error)?;
    }
    changes += tx
        .execute(
            "INSERT OR IGNORE INTO linked_folders(library,folder) VALUES(?1,?2)",
            params![link.id, link.folder],
        )
        .map_err(db_error)?;
    let links: usize = tx
        .query_row(
            "SELECT count(*) FROM linked_folders WHERE library=?1",
            [&link.id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if links > MAX_LINKS_PER_LIBRARY {
        return Err(error(
            StatusCode::CONFLICT,
            "合并后的关联文件夹超过 2048 个，请选择更具体的 NAS 目录",
        ));
    }
    if !link.folder.is_empty() {
        changes += tx
            .execute(
                "INSERT OR IGNORE INTO watched_folders(library,folder) VALUES(?1,?2)",
                params![link.id, link.folder],
            )
            .map_err(db_error)?;
    }
    if changes > 0 {
        bump_revision(&tx)?;
    }
    let consolidated = consolidated_folders(&tx, &link)?;
    tx.commit().map_err(db_error)?;
    Ok(SourceLink {
        library_id: link.id,
        folder: link.folder,
        created,
        index_pending: true,
        consolidated,
    })
}

async fn add(
    State(store): State<Store>,
    Extension(sources): Extension<SourceRoots>,
    Extension(refresh): Extension<Arc<WatchRefresh>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(payload): Json<LinkSource>,
) -> ApiResult<SourceLink> {
    let busy = || {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "NAS 正在响应，请稍后重试链接",
        )
    };
    let guard = tokio::time::timeout(Duration::from_secs(5), sources.0.register.lock())
        .await
        .map_err(|_| busy())?;
    let source = sources
        .0
        .roots
        .iter()
        .find(|source| source.id == id)
        .cloned();
    let Json((source, checked, folder)) =
        with_member(store.clone(), headers.clone(), move |conn, _| {
            let source =
                source.ok_or_else(|| error(StatusCode::NOT_FOUND, "团队未配置此 NAS 来源"))?;
            if payload.folder.is_empty() || link_relative_path(&payload.folder).is_none() {
                return Err(error(
                    StatusCode::BAD_REQUEST,
                    "请选择 NAS 来源下的具体子文件夹",
                ));
            }
            Ok((source, watched_roots(conn)?, payload.folder))
        })
        .await?;
    let observed = checked.clone();
    let permit = FOLDER_LINK_VALIDATIONS.try_acquire().map_err(|_| busy())?;
    let validation = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        plan(source, &folder, &observed)
    });
    let plan = tokio::time::timeout(Duration::from_secs(6), validation)
        .await
        .map_err(|_| busy())?
        .map_err(|_| busy())??;
    let Json(mut result) =
        with_member(store, headers, move |conn, _| persist(conn, plan, &checked)).await?;
    drop(guard);
    result.index_pending = refresh.request(result.library_id.clone()).await.is_err();
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{apply_watch_scan, open_store, sync_files, sync_watch_folders};
    use nexus_core::team::scan_team_tree;

    fn test_store(dir: &FilePath) -> Connection {
        let db = open_store(dir).unwrap();
        db.execute("INSERT INTO team VALUES(1,'test','Team',1)", [])
            .unwrap();
        db
    }

    fn register_index(db: &Connection, id: &str, root: &FilePath) {
        db.execute("INSERT INTO libraries VALUES(?1,'Original')", [id])
            .unwrap();
        db.execute(
            "INSERT INTO watched_libraries VALUES(?1,?2)",
            params![id, clean_path(&fs::canonicalize(root).unwrap())],
        )
        .unwrap();
        let scan = scan_team_tree(root, |_| {}).unwrap();
        sync_watch_folders(db, id, scan.folders, true, "").unwrap();
        sync_files(db, id, &scan.files, "Test", true, "").unwrap();
    }

    fn test_source(path: &FilePath) -> Source {
        Source {
            id: "test".into(),
            path: path.to_path_buf(),
            unc: "\\\\nas\\share".into(),
        }
    }

    #[test]
    fn reparenting_twice_retains_asset_identity_storage_and_relink_remaps() {
        let scratch = tempfile::tempdir().unwrap();
        let source_root = scratch.path().join("assets");
        let child = source_root.join("Parent").join("Year").join("Child");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("sample.obj"), "v 0 0 0\n").unwrap();
        let mut db = test_store(&scratch.path().join("state"));
        register_index(&db, "child", &child);
        let asset_id: String = db
            .query_row("SELECT id FROM assets", [], |row| row.get(0))
            .unwrap();
        let child_root = clean_path(&fs::canonicalize(&child).unwrap());
        let outdated = scan_team_tree(&child, |_| {}).unwrap();
        let source = test_source(&source_root);
        let first = watched_roots(&db).unwrap();
        let first_link = persist(
            &mut db,
            plan(source.clone(), "Parent/Year", &first).unwrap(),
            &first,
        )
        .unwrap();
        assert_eq!(first_link.consolidated[0].folder, "Child");
        assert_eq!(
            apply_watch_scan(&mut db, "child", &child_root, "", 1, outdated).unwrap(),
            None
        );
        let second = watched_roots(&db).unwrap();
        let next = persist(
            &mut db,
            plan(source.clone(), "Parent", &second).unwrap(),
            &second,
        )
        .unwrap();
        assert_eq!(
            next.consolidated,
            vec![
                Consolidation {
                    previous_library_id: first_link.library_id,
                    library_id: next.library_id.clone(),
                    folder: "Year".into()
                },
                Consolidation {
                    previous_library_id: "child".into(),
                    library_id: next.library_id.clone(),
                    folder: "Year/Child".into()
                },
            ]
        );
        let (id, rel, storage_id, storage_folder): (String,String,String,String) = db.query_row(
            "SELECT id,relative,json_extract(data,'$.storageLibraryId'),json_extract(data,'$.storageFolder') FROM assets",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        assert_eq!(id, asset_id);
        assert_eq!(rel, "Year/Child/sample.obj");
        assert_eq!(storage_id, "child");
        assert_eq!(storage_folder, "Year/Child");
        let current = watched_roots(&db).unwrap();
        let retry = persist(&mut db, plan(source, "Parent", &current).unwrap(), &current).unwrap();
        assert_eq!(retry.consolidated, next.consolidated);
        assert!(!retry.created);
    }

    #[test]
    fn overlapping_legacy_asset_paths_abort_without_changing_watches_or_catalog() {
        let scratch = tempfile::tempdir().unwrap();
        let source_root = scratch.path().join("assets");
        let root = source_root.join("Parent");
        let child = root.join("Child");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("sample.obj"), "v 0 0 0\n").unwrap();
        let mut db = test_store(&scratch.path().join("state"));
        register_index(&db, "parent", &root);
        register_index(&db, "child", &child);
        let checked = watched_roots(&db).unwrap();
        let plan = plan(test_source(&source_root), "Parent", &checked).unwrap();
        let failure = persist(&mut db, plan, &checked).err().unwrap();
        assert_eq!(failure.0, StatusCode::CONFLICT);
        assert_eq!(watched_roots(&db).unwrap(), checked);
        let counts: (usize, usize, usize) = db.query_row(
            "SELECT (SELECT count(*) FROM assets),(SELECT count(*) FROM library_consolidations),
                (SELECT revision FROM team)",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(counts, (2, 0, 1));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bind_aliases_resolve_to_the_same_nas_subtree() {
        let entries = parse_mounts(
            b"61 20 0:42 / / rw - overlay overlay rw\n\
64 61 253:2 /share/Assets\\040Folder /mnt/allowed ro - btrfs /dev/md1 rw\n\
65 61 253:2 /share/Assets\\040Folder/Team /mnt/original ro - btrfs /dev/md1 rw\n\
66 64 253:4 /restricted /mnt/allowed/Hidden ro - btrfs /dev/md2 rw\n",
        );
        let mounts = Mounts { entries };
        let path = |value: &str| mounts.coordinates(FilePath::new(value)).unwrap();
        let source = path("/mnt/allowed");
        let original = path("/mnt/original");
        assert_eq!(path("/mnt/allowed/Team"), original);
        assert_eq!(
            path("/mnt/allowed/Team/Subfolder").under(&original),
            Some(PathBuf::from("Subfolder"))
        );
        assert!(path("/mnt/allowed/References").under(&original).is_none());
        assert!(path("/mnt/allowed/Hidden").under(&source).is_none());
    }
}
