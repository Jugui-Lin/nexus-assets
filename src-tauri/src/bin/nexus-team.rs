use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
    Extension, Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use nexus_core::{now, team::*, WorkflowStatus};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    env, fs,
    io::Cursor,
    net::{IpAddr, SocketAddr},
    path::{Path as FilePath, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Notify, Semaphore};
use uuid::Uuid;

#[path = "nexus-team/asset_messages.rs"]
mod asset_messages;
#[path = "nexus-team/browser_sites.rs"]
mod browser_sites;
#[path = "nexus-team/creative_subscriptions.rs"]
mod creative_subscriptions;
#[path = "nexus-team/creative_video_references.rs"]
mod creative_video_references;
#[path = "nexus-team/organization.rs"]
mod organization;
#[path = "nexus-team/asset_recycle.rs"]
mod asset_recycle;
#[path = "nexus-team/baidu_cloud.rs"]
mod baidu_cloud;
#[path = "nexus-team/sources.rs"]
mod sources;
#[path = "nexus-team/quick_access.rs"]
mod quick_access;
#[path = "nexus-team/whiteboard.rs"]
mod whiteboard;
#[path = "nexus-team/whiteboard_presence.rs"]
mod whiteboard_presence;

#[derive(Clone)]
struct Store(Arc<Mutex<Connection>>);
type ApiError = (StatusCode, Json<Value>);
type ApiResult<T> = Result<Json<T>, ApiError>;
type WatchReply = watch::Sender<Option<Result<WatchReport, ApiError>>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchReport {
    found: usize,
    changed: usize,
    errors: Vec<String>,
    revision: u64,
    completed_at: u64,
}

#[derive(Default)]
struct WatchRefresh {
    pending: Mutex<BTreeMap<(String, String), WatchReply>>,
    wake: Notify,
}

impl WatchRefresh {
    async fn request(&self, library: String) -> Result<u64, ApiError> {
        self.request_folder(library, String::new())
            .await
            .map(|report| report.revision)
    }

    async fn request_folder(
        &self,
        library: String,
        folder: String,
    ) -> Result<WatchReport, ApiError> {
        let mut receiver = {
            let mut pending = self.pending.lock().map_err(|_| watch_busy())?;
            let target = (library, folder);
            if let Some(reply) = pending.get(&target) {
                reply.subscribe()
            } else {
                if pending.len() >= 8 {
                    return Err(watch_busy());
                }
                let (reply, receiver) = watch::channel(None);
                pending.insert(target, reply);
                self.wake.notify_one();
                receiver
            }
        };
        let response =
            tokio::time::timeout(Duration::from_secs(12), receiver.wait_for(Option::is_some))
                .await
                .map_err(|_| watch_busy())?
                .map_err(|_| watch_busy())?;
        response.clone().unwrap_or_else(|| Err(watch_busy()))
    }
}

fn watch_busy() -> ApiError {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "NAS 正在扫描团队库，资产会继续自动同步",
    )
}

#[derive(Clone)]
struct AddressJoinLimit(Arc<Mutex<JoinWindow>>);

struct JoinWindow {
    started: Instant,
    total: usize,
    peers: HashMap<IpAddr, usize>,
}

impl AddressJoinLimit {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(JoinWindow {
            started: Instant::now(),
            total: 0,
            peers: HashMap::new(),
        })))
    }

    fn admit(&self, ip: IpAddr) -> bool {
        let Ok(mut window) = self.0.lock() else {
            return false;
        };
        if window.started.elapsed() >= Duration::from_secs(60) {
            window.started = Instant::now();
            window.total = 0;
            window.peers.clear();
        }
        if window.total >= 120 || window.peers.get(&ip).copied().unwrap_or_default() >= 8 {
            return false;
        }
        *window.peers.entry(ip).or_default() += 1;
        window.total += 1;
        true
    }
}

const PRESENCE_TTL: Duration = Duration::from_secs(30);
const MAX_ONLINE_MEMBERS: usize = 512;

#[derive(Clone, Default)]
struct TeamPresence(Arc<Mutex<HashMap<String, PresenceTimes>>>);

#[derive(Clone, Copy, Debug)]
struct PresenceTimes {
    online_since: u64,
    last_seen: u64,
    heartbeat: Instant,
}

impl TeamPresence {
    fn heartbeat(
        &self,
        id: &str,
        clock: Instant,
        timestamp: u64,
    ) -> Result<HashMap<String, PresenceTimes>, ApiError> {
        let mut active = self.0.lock().map_err(|_| presence_busy())?;
        active.retain(|_, entry| clock.saturating_duration_since(entry.heartbeat) < PRESENCE_TTL);
        if let Some(member) = active.get_mut(id) {
            member.last_seen = timestamp;
            member.heartbeat = clock;
        } else {
            if active.len() >= MAX_ONLINE_MEMBERS {
                return Err(presence_busy());
            }
            active.insert(
                id.into(),
                PresenceTimes {
                    online_since: timestamp,
                    last_seen: timestamp,
                    heartbeat: clock,
                },
            );
        }
        Ok(active.clone())
    }
}

fn presence_busy() -> ApiError {
    error(StatusCode::SERVICE_UNAVAILABLE, "在线成员暂时不可用")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OnlineMember {
    id: String,
    name: String,
    online_since: u64,
    last_seen: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_revision: Option<String>,
    #[serde(rename = "self")]
    is_self: bool,
}

#[derive(Serialize)]
struct PresenceResponse {
    members: Vec<OnlineMember>,
}

async fn presence(
    State(store): State<Store>,
    Extension(online): Extension<TeamPresence>,
    headers: HeaderMap,
) -> ApiResult<PresenceResponse> {
    with_member(store, headers, move |conn, caller| {
        let active = online.heartbeat(&caller.id, Instant::now(), now())?;
        let mut names = conn
            .prepare_cached(
                "SELECT members.id, members.name, member_avatars.revision
                 FROM json_each(?1) AS online JOIN members ON members.id=online.value
                 LEFT JOIN member_avatars ON member_avatars.member=members.id WHERE members.enabled=1",
            )
            .map_err(db_error)?;
        let ids = json!(active.keys().collect::<Vec<_>>()).to_string();
        let mut members = names
            .query_map([ids], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(db_error)?
            .map(|row| {
                let (id, name, avatar_revision) = row.map_err(db_error)?;
                let times = active.get(&id).ok_or_else(presence_busy)?;
                Ok(OnlineMember {
                    is_self: id == caller.id,
                    id,
                    name,
                    online_since: times.online_since,
                    last_seen: times.last_seen,
                    avatar_revision,
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        members.sort_by(|left, right| {
            right
                .is_self
                .cmp(&left.is_self)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(PresenceResponse { members })
    })
    .await
}

fn error(code: StatusCode, message: &str) -> ApiError {
    (code, Json(json!({"error": message})))
}

fn db_error(e: rusqlite::Error) -> ApiError {
    eprintln!("SQLite: {e}");
    error(StatusCode::INTERNAL_SERVER_ERROR, "团队数据库暂时无法访问")
}

fn token_digest(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn open_store(dir: &FilePath) -> Result<Connection, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(dir)?;
    let conn = Connection::open(dir.join("team.sqlite3"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS team (
             singleton INTEGER PRIMARY KEY CHECK(singleton=1),
             id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS members (
             id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
             digest BLOB NOT NULL UNIQUE, enabled INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS member_avatars (
             member TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
             png BLOB NOT NULL CHECK(length(png) BETWEEN 1 AND 65536),
             revision TEXT NOT NULL
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS defined_tags (
             tag_key TEXT PRIMARY KEY,
             name TEXT NOT NULL
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY, name TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS hidden_folders (
             library TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
             folder TEXT NOT NULL,
             PRIMARY KEY (library, folder)
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS watched_libraries (
             library TEXT PRIMARY KEY REFERENCES libraries(id), root TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS watched_folders (
             library TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
             folder TEXT NOT NULL,
             PRIMARY KEY (library, folder)
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS linked_folders (
             library TEXT NOT NULL REFERENCES watched_libraries(library) ON DELETE CASCADE,
             folder TEXT NOT NULL,
             PRIMARY KEY (library, folder)
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS library_source_paths (
             library TEXT PRIMARY KEY REFERENCES watched_libraries(library) ON DELETE CASCADE,
             unc TEXT NOT NULL
         ) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS library_consolidations (
             previous_library TEXT PRIMARY KEY,
             library TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
             folder TEXT NOT NULL
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS library_consolidations_target ON library_consolidations(library);
         CREATE TABLE IF NOT EXISTS assets (
             id TEXT PRIMARY KEY, library TEXT NOT NULL REFERENCES libraries(id),
             relative TEXT NOT NULL, size INTEGER NOT NULL, modified INTEGER NOT NULL,
             data TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1, UNIQUE(library, relative)
         );
         CREATE TABLE IF NOT EXISTS watched_file_identities (
             asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
             identity TEXT NOT NULL
         ) WITHOUT ROWID;",
    )?;
    baidu_cloud::init_schema(&conn)?;
    browser_sites::init_schema(&conn)?;
    creative_subscriptions::init_schema(&conn)?;
    creative_video_references::init_schema(&conn)?;
    asset_messages::init_schema(&conn)?;
    organization::init_schema(&conn)?;
    asset_recycle::init_schema(&conn)?;
    quick_access::init_schema(&conn)?;
    whiteboard::init_schema(&conn)?;
    Ok(conn)
}

fn member_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Member> {
    Ok(Member {
        id: row.get(0)?,
        name: row.get(1)?,
        role: row.get(2)?,
    })
}

fn authenticate(conn: &Connection, headers: &HeaderMap) -> Result<Member, ApiError> {
    let unauthorized = || error(StatusCode::UNAUTHORIZED, "团队访问密钥无效或已停用");
    if headers.contains_key("origin") {
        return Err(unauthorized());
    }
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(unauthorized)?;
    conn.query_row(
        "SELECT id, name, role FROM members WHERE digest=?1 AND enabled=1",
        [token_digest(token)],
        member_from_row,
    )
    .optional()
    .map_err(db_error)?
    .ok_or_else(unauthorized)
}

async fn with_member<T: Send + 'static>(
    store: Store,
    headers: HeaderMap,
    action: impl FnOnce(&mut Connection, Member) -> Result<T, ApiError> + Send + 'static,
) -> ApiResult<T> {
    tokio::task::spawn_blocking(move || {
        let mut conn = store
            .0
            .lock()
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "团队数据库不可用"))?;
        let member = authenticate(&conn, &headers)?;
        action(&mut conn, member).map(Json)
    })
    .await
    .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "团队服务处理失败"))?
}

fn parse_asset(data: String, size: u64, modified: u64) -> Result<SharedAsset, ApiError> {
    let mut asset: SharedAsset = serde_json::from_str(&data)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "团队资产记录无法读取"))?;
    asset.size = size;
    asset.modified = modified;
    Ok(asset)
}

async fn snapshot(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(since): Path<String>,
) -> ApiResult<Snapshot> {
    with_member(store, headers, move |conn, member| {
        // One read transaction keeps the revision and the associated records consistent.
        let tx = conn.transaction().map_err(db_error)?;
        let (team, revision) = tx
            .query_row(
                "SELECT id,name,revision FROM team WHERE singleton=1",
                [],
                |r| {
                    Ok((
                        Team {
                            id: r.get(0)?,
                            name: r.get(1)?,
                        },
                        r.get::<_, u64>(2)?,
                    ))
                },
            )
            .map_err(db_error)?;
        let catalog = if since.parse::<u64>().ok() == Some(revision) {
            None
        } else {
            let mut query = tx
                .prepare(
                    "SELECT l.id,l.name,w.library IS NOT NULL FROM libraries l
                    LEFT JOIN watched_libraries w ON l.id=w.library ORDER BY l.name,l.id",
                )
                .map_err(db_error)?;
            let libraries = query
                .query_map([], |r| {
                    Ok(Library {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        watching: r.get(2)?,
                    })
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            let mut query = tx
                .prepare(&format!(
                    "SELECT a.data,a.size,a.modified FROM assets a WHERE a.available=1 AND {}
                     ORDER BY a.rowid DESC",
                    asset_recycle::ASSET_NOT_RECYCLED
                ))
                .map_err(db_error)?;
            let assets = query
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(db_error)?
                .map(|row| {
                    let (data, size, modified) = row.map_err(db_error)?;
                    parse_asset(data, size, modified)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut query = tx
                .prepare("SELECT library,folder FROM hidden_folders ORDER BY library,folder")
                .map_err(db_error)?;
            let hidden_folders = query
                .query_map([], |row| {
                    Ok(HiddenFolder {
                        library_id: row.get(0)?,
                        folder: row.get(1)?,
                    })
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            let mut query = tx
                .prepare("SELECT library,folder FROM watched_folders")
                .map_err(db_error)?;
            let watched_folders = query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            let mut linked = tx
                .prepare(
                    "SELECT l.library,l.folder FROM linked_folders l
                     WHERE l.folder='' OR EXISTS (SELECT 1 FROM watched_folders w
                       WHERE w.library=l.library AND w.folder=l.folder)
                     ORDER BY l.library,l.folder",
                )
                .map_err(db_error)?;
            let linked_folders = linked
                .query_map([], |row| {
                    Ok(LinkedFolder {
                        library_id: row.get(0)?,
                        folder: row.get(1)?,
                    })
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            let source_paths = sources::catalog_paths(&tx)?;
            let defined_tags = defined_tags(&tx)?;
            Some(visible_catalog(
                libraries,
                assets,
                hidden_folders,
                watched_folders,
                linked_folders,
                source_paths,
                defined_tags,
            ))
        };
        Ok(Snapshot {
            team,
            member,
            revision,
            catalog,
            folder_visibility: true,
            member_folder_visibility: true,
        })
    })
    .await
}

fn visible_catalog(
    mut libraries: Vec<Library>,
    mut assets: Vec<SharedAsset>,
    hidden_folders: Vec<HiddenFolder>,
    watched_folders: Vec<(String, String)>,
    mut linked_folders: Vec<LinkedFolder>,
    source_paths: BTreeMap<String, String>,
    defined_tags: Vec<String>,
) -> SharedCatalog {
    let mut all_libraries = None;
    let mut ancestors = BTreeMap::<String, BTreeSet<String>>::new();
    let mut by_library = HashMap::<&str, HashSet<&str>>::new();
    if !hidden_folders.is_empty() {
        for rule in &hidden_folders {
            by_library
                .entry(&rule.library_id)
                .or_default()
                .insert(&rule.folder);
        }
        all_libraries = Some(libraries.clone());
        libraries.retain(|library| {
            !by_library
                .get(library.id.as_str())
                .is_some_and(|paths| paths.contains(""))
        });
        assets.retain(|asset| {
            let Some(paths) = by_library.get(asset.library_id.as_str()) else {
                return true;
            };
            if paths.contains("") {
                return false;
            }
            let mut folders = asset
                .relative_path
                .match_indices('/')
                .map(|(index, _)| &asset.relative_path[..index]);
            let Some(hidden) = folders.find(|folder| paths.contains(folder)) else {
                return true;
            };
            if let Some((parent, _)) = hidden.rsplit_once('/') {
                ancestors
                    .entry(asset.library_id.clone())
                    .or_default()
                    .insert(parent.to_owned());
            }
            false
        });
    }
    let hidden = |library: &str, folder: &str| {
        by_library
            .get(library)
            .is_some_and(|paths| folder_is_hidden(paths, folder))
    };
    for (library, folder) in watched_folders {
        if !hidden(&library, &folder) {
            ancestors.entry(library).or_default().insert(folder);
        }
    }
    linked_folders.retain(|link| !hidden(&link.library_id, &link.folder));
    SharedCatalog {
        libraries,
        assets,
        hidden_folders,
        all_libraries,
        visible_folders: ancestors
            .into_iter()
            .map(|(library, folders)| (library, folders.into_iter().collect()))
            .collect(),
        linked_folders,
        source_paths,
        defined_tags,
    }
}

fn folder_is_hidden(paths: &HashSet<&str>, folder: &str) -> bool {
    paths.contains("")
        || paths.contains(folder)
        || folder
            .match_indices('/')
            .any(|(index, _)| paths.contains(&folder[..index]))
}

fn restore_link_visibility(
    conn: &Connection,
    library: &str,
    folder: &str,
) -> Result<usize, ApiError> {
    let mut delete = conn
        .prepare_cached("DELETE FROM hidden_folders WHERE library=?1 AND folder=?2")
        .map_err(db_error)?;
    // An explicit relink reveals the selected directory and its parents, leaving child rules alone.
    std::iter::once("")
        .chain(folder.match_indices('/').map(|(index, _)| &folder[..index]))
        .chain(std::iter::once(folder).filter(|folder| !folder.is_empty()))
        .try_fold(0, |count, ancestor| {
            delete
                .execute(params![library, ancestor])
                .map(|removed| count + removed)
                .map_err(db_error)
        })
}

const MAX_LINKS_PER_LIBRARY: usize = 2_048;
static FOLDER_LINK_VALIDATIONS: Semaphore = Semaphore::const_new(4);

#[derive(Default, Serialize)]
struct LinkReport {
    linked: usize,
    existing: usize,
    failed: usize,
    errors: Vec<String>,
    folders: Vec<String>,
    revision: u64,
}

impl LinkReport {
    fn fail(&mut self, position: usize, message: &str) {
        self.failed += 1;
        if self.errors.len() < 20 {
            self.errors
                .push(format!("第 {} 个文件夹：{message}", position + 1));
        }
    }
}

fn validate_link_batch(library: &str, folders: &[String]) -> Result<(), ApiError> {
    if Uuid::parse_str(library).is_err() {
        return Err(error(StatusCode::BAD_REQUEST, "团队库编号无效"));
    }
    if folders.is_empty() || folders.len() > MAX_FOLDERS_PER_LINK_REQUEST {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "单次关联需选择 1 至 128 个文件夹",
        ));
    }
    Ok(())
}

fn watch_root(conn: &Connection, library: &str) -> Result<String, ApiError> {
    conn.query_row(
        "SELECT root FROM watched_libraries WHERE library=?1",
        [library],
        |row| row.get(0),
    )
    .optional()
    .map_err(db_error)?
    .ok_or_else(|| error(StatusCode::CONFLICT, "请先为团队库配置 NAS 扫描目录"))
}

fn link_relative_path(folder: &str) -> Option<PathBuf> {
    if folder.is_empty() {
        return Some(PathBuf::new());
    }
    if folder.split('/').any(|part| part.starts_with('.')) {
        return None;
    }
    relative_path(folder).filter(|path| path.components().count() <= 32)
}

fn validate_link_folder(root: &FilePath, folder: &str) -> Result<String, &'static str> {
    let invalid = "请选择团队 NAS 扫描目录下可索引的文件夹";
    let inaccessible = "无法访问此 NAS 文件夹，请确认目录仍存在且有读取权限";
    let relative = link_relative_path(folder).ok_or(invalid)?;
    let mut target = root.to_path_buf();
    for component in &relative {
        target.push(component);
        let metadata = fs::symlink_metadata(&target).map_err(|_| inaccessible)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid);
        }
    }
    let target = fs::canonicalize(target).map_err(|_| inaccessible)?;
    let normalized = target
        .strip_prefix(root)
        .map_err(|_| invalid)?
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()
        .ok_or(invalid)?
        .join("/");
    link_relative_path(&normalized).ok_or(invalid)?;
    Ok(normalized)
}

fn team_revision(conn: &Connection) -> Result<u64, ApiError> {
    conn.query_row("SELECT revision FROM team WHERE singleton=1", [], |row| {
        row.get(0)
    })
    .map_err(db_error)
}

async fn link_folders(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(library): Path<String>,
    Json(payload): Json<FolderLinks>,
) -> ApiResult<LinkReport> {
    validate_link_batch(&library, &payload.folders)?;
    let Json(root) = {
        let library = library.clone();
        with_member(store.clone(), headers.clone(), move |conn, _| {
            watch_root(conn, &library)
        })
        .await?
    };
    let busy = || {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "NAS 正在响应，请稍后重试关联",
        )
    };
    let slot = FOLDER_LINK_VALIDATIONS.try_acquire().map_err(|_| busy())?;
    let configured = root.clone();
    let validation = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let root = fs::canonicalize(&configured)
            .ok()
            .filter(|path| path.is_dir() && nexus_core::clean_path(path) == configured)
            .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "NAS 扫描目录不可用"))?;
        Ok::<_, ApiError>(
            payload
                .folders
                .iter()
                .map(|folder| validate_link_folder(&root, folder))
                .collect::<Vec<_>>(),
        )
    });
    let found = tokio::time::timeout(Duration::from_secs(8), validation)
        .await
        .map_err(|_| busy())?
        .map_err(|_| busy())??;

    with_member(store, headers, move |conn, _| {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if watch_root(&tx, &library)? != root {
            return Err(error(
                StatusCode::CONFLICT,
                "NAS 扫描目录已切换，请重新选择文件夹",
            ));
        }
        let mut report = LinkReport::default();
        let mut changes = 0;
        {
            let mut select_links = tx
                .prepare("SELECT folder FROM linked_folders WHERE library=?1")
                .map_err(db_error)?;
            let mut known = select_links
                .query_map([&library], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(db_error)?;
            let mut insert_link = tx
                .prepare("INSERT INTO linked_folders VALUES(?1,?2)")
                .map_err(db_error)?;
            let mut insert_folder = tx
                .prepare("INSERT OR IGNORE INTO watched_folders VALUES(?1,?2)")
                .map_err(db_error)?;
            for (position, folder) in found.into_iter().enumerate() {
                let folder = match folder {
                    Ok(folder) => folder,
                    Err(message) => {
                        report.fail(position, message);
                        continue;
                    }
                };
                if known.contains(&folder) {
                    report.existing += 1;
                } else if known.len() >= MAX_LINKS_PER_LIBRARY {
                    report.fail(position, "此团队库的文件夹关联已达到 2048 个");
                    continue;
                } else {
                    changes += insert_link
                        .execute(params![library, folder])
                        .map_err(db_error)?;
                    known.insert(folder.clone());
                    report.linked += 1;
                }
                changes += restore_link_visibility(&tx, &library, &folder)?;
                if !folder.is_empty() {
                    changes += insert_folder
                        .execute(params![library, folder])
                        .map_err(db_error)?;
                }
                if !report.folders.contains(&folder) {
                    report.folders.push(folder);
                }
            }
        }
        if changes > 0 {
            bump_revision(&tx)?;
        }
        report.revision = team_revision(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(report)
    })
    .await
}

async fn unlink_folders(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(library): Path<String>,
    Json(payload): Json<FolderLinks>,
) -> ApiResult<Value> {
    validate_link_batch(&library, &payload.folders)?;
    if payload
        .folders
        .iter()
        .any(|folder| link_relative_path(folder).is_none())
    {
        return Err(error(StatusCode::BAD_REQUEST, "文件夹关联路径无效"));
    }
    with_member(store, headers, move |conn, _| {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let removed = {
            let mut delete = tx
                .prepare("DELETE FROM linked_folders WHERE library=?1 AND folder=?2")
                .map_err(db_error)?;
            payload.folders.into_iter().try_fold(0, |count, folder| {
                delete
                    .execute(params![library, folder])
                    .map(|rows| count + rows)
                    .map_err(db_error)
            })?
        };
        if removed > 0 {
            bump_revision(&tx)?;
        }
        let revision = team_revision(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(json!({"removed": removed, "revision": revision}))
    })
    .await
}

async fn request_watch_refresh(
    State(store): State<Store>,
    Extension(refresh): Extension<Arc<WatchRefresh>>,
    headers: HeaderMap,
    Path(library): Path<String>,
) -> ApiResult<Value> {
    let Json(library) = with_member(store, headers, move |conn, _| {
        if Uuid::parse_str(&library).is_err() {
            return Err(error(StatusCode::BAD_REQUEST, "团队库编号无效"));
        }
        let watched = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM watched_libraries WHERE library=?1)",
                [&library],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db_error)?;
        if !watched {
            return Err(error(StatusCode::CONFLICT, "该团队库未启用 NAS 自动扫描"));
        }
        Ok(library)
    })
    .await?;
    let revision = refresh.request(library).await?;
    Ok(Json(json!({ "revision": revision })))
}

#[derive(Deserialize)]
struct FolderRescan {
    folder: String,
}

async fn request_folder_rescan(
    State(store): State<Store>,
    Extension(refresh): Extension<Arc<WatchRefresh>>,
    headers: HeaderMap,
    Path(library): Path<String>,
    Json(payload): Json<FolderRescan>,
) -> ApiResult<WatchReport> {
    let Json((library, folder)) = with_member(store, headers, move |conn, _| {
        if Uuid::parse_str(&library).is_err() || link_relative_path(&payload.folder).is_none() {
            return Err(error(StatusCode::BAD_REQUEST, "团队库或文件夹路径无效"));
        }
        watch_root(conn, &library)?;
        check_rescan_visible(conn, &library, &payload.folder)?;
        Ok((library, payload.folder))
    })
    .await?;
    refresh.request_folder(library, folder).await.map(Json)
}

fn check_rescan_visible(conn: &Connection, library: &str, folder: &str) -> Result<(), ApiError> {
    let mut stmt = conn
        .prepare("SELECT folder FROM hidden_folders WHERE library=?1")
        .map_err(db_error)?;
    let hidden = stmt
        .query_map([library], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if folder_is_hidden(&hidden.iter().map(String::as_str).collect(), folder) {
        return Err(error(StatusCode::FORBIDDEN, "此文件夹已从团队库移除"));
    }
    Ok(())
}

fn bump_revision(conn: &Connection) -> Result<(), ApiError> {
    conn.execute("UPDATE team SET revision=revision+1 WHERE singleton=1", [])
        .map_err(db_error)?;
    Ok(())
}

fn defined_tags(conn: &Connection) -> Result<Vec<String>, ApiError> {
    let mut query = conn
        .prepare("SELECT name FROM defined_tags ORDER BY tag_key")
        .map_err(db_error)?;
    let rows = query.query_map([], |row| row.get(0)).map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

#[derive(Deserialize)]
struct CreateTag {
    name: String,
}

fn valid_tag_name(text: &str) -> Result<&str, ApiError> {
    let name = text.trim();
    if name.is_empty() || name.chars().count() > 40 || name.chars().any(char::is_control) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "标签名称需包含 1 至 40 个字符",
        ));
    }
    Ok(name)
}

async fn create_tag(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(payload): Json<CreateTag>,
) -> ApiResult<Value> {
    with_member(store, headers, move |conn, _| {
        let name = valid_tag_name(&payload.name)?;
        let key = name.to_lowercase();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let old_name = tx
            .query_row(
                "SELECT name FROM defined_tags WHERE tag_key=?1",
                [&key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        let created = old_name.is_none();
        let name = if let Some(old_name) = old_name {
            old_name
        } else {
            let count: usize = tx
                .query_row("SELECT COUNT(*) FROM defined_tags", [], |row| row.get(0))
                .map_err(db_error)?;
            if count >= 4096 {
                return Err(error(
                    StatusCode::CONFLICT,
                    "团队已达到可保存的标签数量上限",
                ));
            }
            tx.execute(
                "INSERT INTO defined_tags(tag_key,name) VALUES(?1,?2)",
                params![key, name],
            )
            .map_err(db_error)?;
            bump_revision(&tx)?;
            name.to_owned()
        };
        let revision = team_revision(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(json!({"name":name,"created":created,"revision":revision}))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameTag {
    name: String,
    new_name: String,
}

async fn rename_tag(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(payload): Json<RenameTag>,
) -> ApiResult<Value> {
    with_member(store, headers, move |conn, member| {
        let new_name = valid_tag_name(&payload.new_name)?;
        change_tag(conn, &member, &payload.name, Some(new_name))
    })
    .await
}

async fn delete_tag(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(payload): Json<CreateTag>,
) -> ApiResult<Value> {
    with_member(store, headers, move |conn, member| {
        change_tag(conn, &member, &payload.name, None)
    })
    .await
}

fn change_tag(
    conn: &mut Connection,
    member: &Member,
    name: &str,
    replacement: Option<&str>,
) -> Result<Value, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(error(StatusCode::BAD_REQUEST, "标签名称无效"));
    }
    let key = name.to_lowercase();
    let replacement_key = replacement
        .map(str::to_lowercase)
        .filter(|other| other != &key);
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let definition = |key: &str| {
        tx.query_row(
            "SELECT name FROM defined_tags WHERE tag_key=?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)
    };
    let defined = definition(&key)?;
    let mut collision = replacement_key
        .as_deref()
        .map(definition)
        .transpose()?
        .flatten()
        .is_some();
    let mut found = defined.is_some();
    let mut updates = Vec::new();
    {
        let mut select = tx.prepare("SELECT id,json_extract(data,'$.tags') FROM assets WHERE json_array_length(data,'$.tags')>0").map_err(db_error)?;
        let rows = select
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        for row in rows {
            let (id, raw) = row.map_err(db_error)?;
            let tags: Vec<String> = serde_json::from_str(&raw)
                .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "无法读取资产标签"))?;
            let mut found_on_asset = false;
            let mut next = Vec::with_capacity(tags.len());
            for tag in &tags {
                let tag_key = tag.to_lowercase();
                if tag_key == key {
                    if !found_on_asset {
                        if let Some(value) = replacement {
                            next.push(value.to_owned());
                        }
                        found_on_asset = true;
                    }
                } else {
                    collision |= replacement_key.as_ref() == Some(&tag_key);
                    next.push(tag.clone());
                }
            }
            found |= found_on_asset;
            if found_on_asset && next != tags {
                updates.push((id, next));
            }
        }
    }
    if !found && replacement.is_some() {
        return Err(error(StatusCode::NOT_FOUND, "团队标签不存在，请刷新后重试"));
    }
    if collision {
        return Err(error(StatusCode::CONFLICT, "团队中已存在同名标签"));
    }
    let mut changes = 0;
    if let Some(old) = defined {
        match replacement {
            Some(new_name) if new_name != old => {
                changes += tx
                    .execute(
                        "UPDATE defined_tags SET tag_key=?1,name=?2 WHERE tag_key=?3",
                        params![new_name.to_lowercase(), new_name, key],
                    )
                    .map_err(db_error)?;
            }
            None => {
                changes += tx
                    .execute("DELETE FROM defined_tags WHERE tag_key=?1", [&key])
                    .map_err(db_error)?;
            }
            _ => {}
        }
    }
    {
        let mut update = tx
            .prepare(
                "UPDATE assets SET data=json_set(data,'$.tags',json(?1),
            '$.revision',json_extract(data,'$.revision')+1,'$.editedBy',?2) WHERE id=?3",
            )
            .map_err(db_error)?;
        for (id, tags) in updates {
            changes += update
                .execute(params![json!(tags).to_string(), member.name, id])
                .map_err(db_error)?;
        }
    }
    if changes > 0 {
        bump_revision(&tx)?;
    }
    let revision = team_revision(&tx)?;
    tx.commit().map_err(db_error)?;
    Ok(json!({"name":replacement.unwrap_or(name),"revision":revision}))
}

async fn set_folder_visibility(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(payload): Json<SetFolderVisibility>,
) -> ApiResult<Value> {
    with_member(store, headers, move |conn, _| {
        if Uuid::parse_str(&payload.library_id).is_err()
            || (!payload.folder.is_empty() && relative_path(&payload.folder).is_none())
        {
            return Err(error(StatusCode::BAD_REQUEST, "团队库编号或文件夹路径无效"));
        }
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let exists = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1)",
                [&payload.library_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err(error(StatusCode::NOT_FOUND, "找不到团队资产库"));
        }
        let sql = if payload.hidden {
            "INSERT INTO hidden_folders (library,folder) VALUES (?1,?2) ON CONFLICT DO NOTHING"
        } else {
            "DELETE FROM hidden_folders WHERE library=?1 AND folder=?2"
        };
        if tx
            .execute(sql, params![payload.library_id, payload.folder])
            .map_err(db_error)?
            > 0
        {
            bump_revision(&tx)?;
        }
        let revision = tx
            .query_row("SELECT revision FROM team WHERE singleton=1", [], |row| {
                row.get::<_, u64>(0)
            })
            .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(json!({ "revision": revision }))
    })
    .await
}

fn valid_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err(error(StatusCode::BAD_REQUEST, "名称需包含 1 至 200 个字符"));
    }
    Ok(name.to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameTeam {
    team_id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamNameUpdate {
    team: Team,
    previous_revision: u64,
    revision: u64,
}

fn rename_team(
    conn: &mut Connection,
    member: &Member,
    payload: RenameTeam,
) -> Result<TeamNameUpdate, ApiError> {
    if member.role != "admin" {
        return Err(error(StatusCode::FORBIDDEN, "只有管理员可以重命名团队库"));
    }
    let name = valid_name(&payload.name)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let (id, old_name, previous_revision) = tx
        .query_row(
            "SELECT id,name,revision FROM team WHERE singleton=1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?)),
        )
        .map_err(db_error)?;
    if id != payload.team_id {
        return Err(error(StatusCode::CONFLICT, "团队已切换，请重新打开工作空间"));
    }
    let revision = if old_name == name {
        previous_revision
    } else {
        tx.execute("UPDATE team SET name=?1 WHERE singleton=1", [&name])
            .map_err(db_error)?;
        bump_revision(&tx)?;
        team_revision(&tx)?
    };
    tx.commit().map_err(db_error)?;
    Ok(TeamNameUpdate {
        team: Team { id, name },
        previous_revision,
        revision,
    })
}

async fn patch_team_name(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(payload): Json<RenameTeam>,
) -> ApiResult<TeamNameUpdate> {
    with_member(store, headers, move |conn, member| rename_team(conn, &member, payload)).await
}

const AVATAR_EDGE: u32 = 96;
const MAX_AVATAR_BYTES: usize = 64 * 1024;
const AVATAR_PREFIX: &str = "data:image/png;base64,";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberProfile {
    name: String,
    avatar_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberAvatar {
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AvatarAction {
    Keep,
    Replace,
    Remove,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfilePatch {
    name: String,
    avatar_action: AvatarAction,
    avatar_url: Option<String>,
}

fn normalize_avatar(value: &str) -> Result<Vec<u8>, ApiError> {
    let invalid = || {
        error(
            StatusCode::BAD_REQUEST,
            "头像需为 96 × 96 的 PNG 图片，大小不超过 64 KiB",
        )
    };
    let encoded = value
        .strip_prefix(AVATAR_PREFIX)
        .filter(|value| value.len() <= MAX_AVATAR_BYTES.div_ceil(3) * 4)
        .ok_or_else(invalid)?;
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err(invalid());
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(AVATAR_EDGE);
    limits.max_image_height = Some(AVATAR_EDGE);
    limits.max_alloc = Some(1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| invalid())?;
    if decoded.width() != AVATAR_EDGE || decoded.height() != AVATAR_EDGE {
        return Err(invalid());
    }
    // Re-encode to keep only validated pixels and strip embedded metadata.
    let normalized = image::DynamicImage::ImageRgba8(decoded.into_rgba8());
    let mut buffer = Cursor::new(Vec::new());
    normalized
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|_| invalid())?;
    let png = buffer.into_inner();
    if png.len() > MAX_AVATAR_BYTES {
        return Err(invalid());
    }
    Ok(png)
}

fn read_avatar(conn: &Connection, id: &str) -> Result<MemberAvatar, ApiError> {
    let missing = || error(StatusCode::NOT_FOUND, "此团队成员不存在或已停用");
    if Uuid::parse_str(id).is_err() {
        return Err(missing());
    }
    let png: Option<Vec<u8>> = conn
        .query_row(
            "SELECT member_avatars.png FROM members
             LEFT JOIN member_avatars ON member_avatars.member=members.id
             WHERE members.id=?1 AND members.enabled=1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(missing)?;
    Ok(MemberAvatar {
        avatar_url: png.map(|bytes| format!("{AVATAR_PREFIX}{}", STANDARD.encode(bytes))),
    })
}

async fn get_profile(State(store): State<Store>, headers: HeaderMap) -> ApiResult<MemberProfile> {
    with_member(store, headers, |conn, member| {
        Ok(MemberProfile {
            name: member.name,
            avatar_url: read_avatar(conn, &member.id)?.avatar_url,
        })
    })
    .await
}

async fn patch_profile(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(patch): Json<ProfilePatch>,
) -> ApiResult<MemberProfile> {
    with_member(store, headers, move |conn, member| {
        let name = valid_name(&patch.name)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if name != member.name {
            tx.execute(
                "UPDATE members SET name=?1 WHERE id=?2",
                params![name, member.id],
            )
            .map_err(db_error)?;
        }
        match patch.avatar_action {
            AvatarAction::Keep => {}
            AvatarAction::Remove => {
                tx.execute("DELETE FROM member_avatars WHERE member=?1", [&member.id])
                    .map_err(db_error)?;
            }
            AvatarAction::Replace => {
                let data_url = patch
                    .avatar_url
                    .as_deref()
                    .ok_or_else(|| error(StatusCode::BAD_REQUEST, "请选择要保存的头像图片"))?;
                let png = normalize_avatar(data_url)?;
                let revision: String = Sha256::digest(&png)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                tx.execute(
                    "INSERT INTO member_avatars(member,png,revision) VALUES(?1,?2,?3)
                     ON CONFLICT(member) DO UPDATE SET png=excluded.png,revision=excluded.revision
                     WHERE member_avatars.revision<>excluded.revision",
                    params![member.id, png, revision],
                )
                .map_err(db_error)?;
            }
        }
        let avatar_url = read_avatar(&tx, &member.id)?.avatar_url;
        tx.commit().map_err(db_error)?;
        Ok(MemberProfile { name, avatar_url })
    })
    .await
}

async fn get_member_avatar(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<MemberAvatar> {
    with_member(store, headers, move |conn, _| read_avatar(conn, &id)).await
}

async fn publish(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(payload): Json<Publish>,
) -> ApiResult<Value> {
    with_member(store, headers, move |conn, member| {
        if member.role != "admin" {
            return Err(error(
                StatusCode::FORBIDDEN,
                "只有管理员可以发布或扫描团队库",
            ));
        }
        if Uuid::parse_str(&payload.library.id).is_err() || payload.files.len() > MAX_FILES {
            return Err(error(StatusCode::BAD_REQUEST, "资产库编号或扫描文件数无效"));
        }
        let library_name = valid_name(&payload.library.name)?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut changes = tx.execute(
            "INSERT INTO libraries VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET name=excluded.name
             WHERE libraries.name!=excluded.name",
            params![payload.library.id,library_name],
        ).map_err(db_error)?;
        let found = payload.files.len();
        let watched = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM watched_libraries WHERE library=?1)",
                [&payload.library.id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db_error)?;
        changes += sync_files(
            &tx,
            &payload.library.id,
            &payload.files,
            &member.name,
            payload.complete && !watched,
            "",
        )?;
        if changes > 0 {
            bump_revision(&tx)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(json!({"found":found,"libraryId":payload.library.id}))
    })
    .await
}

fn sync_files(
    conn: &Connection,
    library: &str,
    files: &[PublishedFile],
    author: &str,
    complete: bool,
    folder: &str,
) -> Result<usize, ApiError> {
    let mut changes = 0;
    let branch = branch_prefix(folder);
    let mut current = conn
        .prepare(
            "SELECT relative,size,modified,available FROM assets WHERE library=?1
                  AND substr(relative,1,length(?2))=?2",
        )
        .map_err(db_error)?;
    let mut remaining = current
        .query_map(params![library, branch], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, u64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, bool>(3)?,
                ),
            ))
        })
        .map_err(db_error)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(db_error)?;
    let mut insert = conn
        .prepare(
            "INSERT INTO assets (id,library,relative,size,modified,data) VALUES(?1,?2,?3,?4,?5,?6)",
        )
        .map_err(db_error)?;
    let mut update = conn
        .prepare(
            "UPDATE assets SET size=?3, modified=?4, available=1 WHERE library=?1 AND relative=?2",
        )
        .map_err(db_error)?;
    for file in files {
        let (ext, kind) = asset_format(&file.relative_path)
            .filter(|_| relative_path(&file.relative_path).is_some())
            .ok_or_else(|| error(StatusCode::BAD_REQUEST, "存在无效或不可跨平台的资产路径"))?;
        if let Some(previous) = remaining.remove(&file.relative_path) {
            if previous != (file.size, file.modified, true) {
                changes += update
                    .execute(params![
                        library,
                        file.relative_path,
                        file.size,
                        file.modified
                    ])
                    .map_err(db_error)?;
            }
            continue;
        }
        let asset = SharedAsset {
            id: Uuid::new_v4().to_string(),
            library_id: library.into(),
            relative_path: file.relative_path.clone(),
            storage_library_id: None,
            storage_folder: None,
            name: valid_name(&file.name)?,
            ext,
            kind: kind.into(),
            size: file.size,
            modified: file.modified,
            added: now(),
            tags: normalized_tags(file.tags.clone()),
            notes: file.notes.chars().take(10_000).collect(),
            rating: 0,
            workflow: WorkflowStatus::Unset,
            revision: 1,
            edited_by: author.into(),
        };
        changes += insert
            .execute(params![
                asset.id,
                asset.library_id,
                asset.relative_path,
                asset.size,
                asset.modified,
                serde_json::to_string(&asset).expect("asset is serializable")
            ])
            .map_err(db_error)?;
    }
    if complete {
        let mut hide = conn
            .prepare("UPDATE assets SET available=0 WHERE library=?1 AND relative=?2")
            .map_err(db_error)?;
        for (relative, (_, _, available)) in remaining {
            if available {
                changes += hide.execute(params![library, relative]).map_err(db_error)?;
            }
        }
    }
    Ok(changes)
}

fn reconcile_watch_moves(
    conn: &Connection,
    library: &str,
    files: &[PublishedFile],
    folder: &str,
) -> Result<usize, ApiError> {
    let scanned_paths: HashSet<_> = files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect();
    let mut incoming = HashMap::new();
    for file in files {
        if let Some(identity) = file.file_identity.as_deref() {
            incoming
                .entry(identity)
                .and_modify(|entry| *entry = None)
                .or_insert(Some(file));
        }
    }
    if incoming.is_empty() {
        return Ok(0);
    }
    let mut known = conn
        .prepare(
            "SELECT assets.id, relative, available, identity FROM assets
             LEFT JOIN watched_file_identities ON asset=assets.id
             WHERE library=?1 AND substr(relative,1,length(?2))=?2",
        )
        .map_err(db_error)?;
    let records = known
        .query_map(params![library, branch_prefix(folder)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let occupied: HashSet<_> = records
        .iter()
        .map(|(_, path, _, _)| path.as_str())
        .collect();
    let mut previous = HashMap::new();
    for (id, path, available, identity) in &records {
        if let (true, Some(identity)) = (available, identity.as_deref()) {
            previous
                .entry(identity)
                .and_modify(|entry| *entry = None)
                .or_insert(Some((id, path)));
        }
    }
    let mut changes = 0;
    for (identity, candidate) in incoming {
        let (Some(file), Some((id, source))) =
            (candidate, previous.get(identity).copied().flatten())
        else {
            continue;
        };
        if scanned_paths.contains(source.as_str()) || occupied.contains(file.relative_path.as_str())
        {
            continue;
        }
        let Some((ext, kind)) = asset_format(&file.relative_path) else {
            continue;
        };
        let data = conn
            .query_row("SELECT data FROM assets WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .map_err(db_error)?;
        let mut asset = parse_asset(data, file.size, file.modified)?;
        asset.relative_path = file.relative_path.clone();
        asset.ext = ext;
        asset.kind = kind.into();
        asset.revision += 1;
        changes += conn
            .execute(
                "UPDATE assets SET relative=?2,size=?3,modified=?4,data=?5 WHERE id=?1",
                params![
                    id,
                    file.relative_path,
                    file.size,
                    file.modified,
                    serde_json::to_string(&asset).expect("asset is serializable")
                ],
            )
            .map_err(db_error)?;
    }
    Ok(changes)
}

fn save_watch_identities(
    conn: &Connection,
    library: &str,
    files: &[PublishedFile],
) -> Result<(), ApiError> {
    let mut upsert = conn
        .prepare(
            "INSERT INTO watched_file_identities(asset,identity)
         SELECT id,?3 FROM assets WHERE library=?1 AND relative=?2
         ON CONFLICT(asset) DO UPDATE SET identity=excluded.identity
         WHERE watched_file_identities.identity<>excluded.identity",
        )
        .map_err(db_error)?;
    let mut clear = conn.prepare(
        "DELETE FROM watched_file_identities WHERE asset=(SELECT id FROM assets WHERE library=?1 AND relative=?2)",
    ).map_err(db_error)?;
    for file in files {
        if let Some(identity) = file.file_identity.as_deref() {
            upsert
                .execute(params![library, file.relative_path, identity])
                .map_err(db_error)?;
        } else {
            clear
                .execute(params![library, file.relative_path])
                .map_err(db_error)?;
        }
    }
    Ok(())
}

fn sync_watch_folders(
    conn: &Connection,
    library: &str,
    folders: Vec<String>,
    complete: bool,
    folder: &str,
) -> Result<usize, ApiError> {
    let mut query = conn
        .prepare(
            "SELECT folder FROM watched_folders WHERE library=?1
                  AND (folder=?2 OR substr(folder,1,length(?3))=?3)",
        )
        .map_err(db_error)?;
    let mut remaining = query
        .query_map(params![library, folder, branch_prefix(folder)], |row| {
            row.get::<_, String>(0)
        })
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)?;
    let mut insert = conn
        .prepare("INSERT OR IGNORE INTO watched_folders(library,folder) VALUES (?1,?2)")
        .map_err(db_error)?;
    let mut changes = 0;
    for folder in folders {
        if !remaining.remove(&folder) {
            changes += insert.execute(params![library, folder]).map_err(db_error)?;
        }
    }
    if complete {
        let mut remove = conn
            .prepare("DELETE FROM watched_folders WHERE library=?1 AND folder=?2")
            .map_err(db_error)?;
        for folder in remaining {
            changes += remove.execute(params![library, folder]).map_err(db_error)?;
        }
    }
    Ok(changes)
}

fn branch_prefix(folder: &str) -> String {
    if folder.is_empty() {
        String::new()
    } else {
        format!("{folder}/")
    }
}

fn apply_watch_scan(
    conn: &mut Connection,
    library: &str,
    watch_root: &str,
    folder: &str,
    revision: u64,
    scan: TeamTreeScan,
) -> Result<Option<usize>, ApiError> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let current = tx
        .query_row(
            "SELECT root,(SELECT revision FROM team) FROM watched_libraries WHERE library=?1",
            [library],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    if !current
        .is_some_and(|(root, current_revision)| root == watch_root && current_revision == revision)
    {
        return Ok(None);
    }
    let complete = scan.skipped == 0;
    let mut changes = sync_watch_folders(&tx, library, scan.folders, complete, folder)?;
    if complete {
        changes += reconcile_watch_moves(&tx, library, &scan.files, folder)?;
    }
    changes += sync_files(&tx, library, &scan.files, "NAS 扫描", complete, folder)?;
    if complete {
        save_watch_identities(&tx, library, &scan.files)?;
    }
    if changes > 0 {
        bump_revision(&tx)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(Some(changes))
}

fn checked_scan_branch(root: &FilePath, folder: &str) -> Result<Option<PathBuf>, ApiError> {
    let outside = || error(StatusCode::BAD_REQUEST, "请选择团队库内的实际文件夹");
    let inaccessible = || {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "无法读取 NAS 文件夹，已保留已有索引",
        )
    };
    let branch = link_relative_path(folder).ok_or_else(outside)?;
    let mut target = root.to_path_buf();
    for component in &branch {
        target.push(component);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(outside()),
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Ok(None),
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(inaccessible()),
        }
    }
    let canonical = fs::canonicalize(&target).map_err(|_| inaccessible())?;
    // In particular, a Windows junction may not be reported as a symbolic link.
    if canonical != target {
        return Err(outside());
    }
    Ok(Some(canonical))
}

fn scan_watch(store: &Store, library: &str, folder: &str) -> Result<WatchReport, ApiError> {
    let (root, revision) = {
        let conn = store.0.lock().map_err(|_| watch_busy())?;
        if !folder.is_empty() {
            check_rescan_visible(&conn, library, folder)?;
        }
        conn.query_row(
            "SELECT root,(SELECT revision FROM team) FROM watched_libraries WHERE library=?1",
            [library],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::CONFLICT, "该团队库未启用 NAS 自动扫描"))?
    };
    let path = FilePath::new(&root);
    if !path.is_dir() {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "NAS 目录不可用，保留已有索引",
        ));
    }
    let scan_issue = |message: String| error(StatusCode::SERVICE_UNAVAILABLE, &message);
    let scan = if folder.is_empty() {
        scan_team_tree(path, |_| {}).map_err(scan_issue)?
    } else {
        let root_path = fs::canonicalize(path).map_err(|_| watch_busy())?;
        if !root_path.is_dir() || nexus_core::clean_path(&root_path) != root {
            return Err(watch_busy());
        }
        let branch = checked_scan_branch(&root_path, folder)?;
        let scan = if let Some(branch) = branch.as_ref() {
            let mut scan = scan_team_subtree(&root_path, branch, |_| {}).map_err(scan_issue)?;
            scan.folders.push(folder.to_owned());
            scan
        } else {
            // Confirmed missing under an accessible root. Reconcile only this branch.
            TeamTreeScan {
                files: Vec::new(),
                folders: Vec::new(),
                skipped: 0,
            }
        };
        if checked_scan_branch(&root_path, folder)? != branch {
            return Err(watch_busy());
        }
        scan
    };
    let found = scan.files.len();
    let mut errors = Vec::new();
    if scan.skipped > 0 {
        eprintln!(
            "团队库 {library} 扫描跳过 {} 项，保留未扫到的已有记录",
            scan.skipped
        );
        errors.push(format!(
            "有 {} 项无法读取，已保留未扫到的索引记录",
            scan.skipped
        ));
    }
    let mut conn = store.0.lock().map_err(|_| watch_busy())?;
    let changes = apply_watch_scan(&mut conn, library, &root, folder, revision, scan)?
        .ok_or_else(watch_busy)?;
    if changes > 0 {
        println!("团队库 {library} 检测到 {changes} 项文件或目录变化");
    }
    Ok(WatchReport {
        found,
        changed: changes,
        errors,
        revision: team_revision(&conn)?,
        completed_at: now(),
    })
}

fn scan_watches(store: &Store, refresh: &WatchRefresh, periodic: bool) -> Result<(), ApiError> {
    let pending = std::mem::take(&mut *refresh.pending.lock().map_err(|_| watch_busy())?);
    let mut watches: Vec<_> = pending
        .into_iter()
        .map(|((library, folder), reply)| (library, folder, Some(reply)))
        .collect();
    if periodic {
        let conn = store.0.lock().map_err(|_| watch_busy())?;
        let mut query = conn
            .prepare("SELECT library FROM watched_libraries ORDER BY library")
            .map_err(db_error)?;
        let pending: HashSet<_> = watches
            .iter()
            .map(|(library, _, _)| library.as_str())
            .collect();
        let other = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .filter(|library| {
                !library
                    .as_ref()
                    .is_ok_and(|id| pending.contains(id.as_str()))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        watches.extend(
            other
                .into_iter()
                .map(|library| (library, String::new(), None)),
        );
    }
    for (library, folder, reply) in watches {
        let result = scan_watch(store, &library, &folder);
        if let Err((_, message)) = &result {
            eprintln!("团队库 {library} 扫描失败 {}", message.0["error"]);
        }
        if let Some(reply) = reply {
            reply.send_replace(Some(result));
        }
    }
    Ok(())
}

async fn maintain_watches(store: Store, refresh: Arc<WatchRefresh>) {
    let mut next_periodic = tokio::time::Instant::now();
    loop {
        if tokio::time::Instant::now() < next_periodic {
            let _ = tokio::time::timeout_at(next_periodic, refresh.wake.notified()).await;
        }
        let periodic = tokio::time::Instant::now() >= next_periodic;
        let scanning_store = store.clone();
        let scanning_refresh = refresh.clone();
        match tokio::task::spawn_blocking(move || {
            scan_watches(&scanning_store, &scanning_refresh, periodic)
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err((_, message))) => eprintln!("团队库扫描失败 {}", message.0["error"]),
            Err(e) => eprintln!("团队库扫描任务失败 {e}"),
        }
        if periodic {
            next_periodic = tokio::time::Instant::now() + Duration::from_secs(30);
        }
        // Coalesce rapid successive import requests before the next manual scan.
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn edit(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(patch): Json<MetadataPatch>,
) -> ApiResult<SharedAsset> {
    with_member(store, headers, move |conn, member| {
        let tx = conn.transaction().map_err(db_error)?;
        let (data, size, modified) = tx
            .query_row(
                &format!(
                    "SELECT a.data,a.size,a.modified FROM assets a WHERE a.id=?1 AND {}",
                    asset_recycle::visible_asset_sql()
                ),
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| error(StatusCode::NOT_FOUND, "团队资产不存在"))?;
        let mut asset = parse_asset(data, size, modified)?;
        if asset.revision != patch.revision {
            return Err(error(
                StatusCode::CONFLICT,
                "同事已更新这项资产。请载入最新资料后再保存",
            ));
        }
        if let Some(name) = patch.name {
            asset.name = valid_name(&name)?;
        }
        if let Some(notes) = patch.notes {
            asset.notes = notes.chars().take(10_000).collect();
        }
        if let Some(tags) = patch.tags {
            asset.tags = normalized_tags(tags);
        }
        if let Some(rating) = patch.rating {
            if rating > 5 {
                return Err(error(StatusCode::BAD_REQUEST, "评分必须为 0 至 5"));
            }
            asset.rating = rating;
        }
        if let Some(workflow) = patch.workflow {
            asset.workflow = workflow;
        }
        asset.revision += 1;
        asset.edited_by = member.name;
        tx.execute(
            "UPDATE assets SET data=?1 WHERE id=?2",
            params![
                serde_json::to_string(&asset).expect("asset is serializable"),
                id
            ],
        )
        .map_err(db_error)?;
        bump_revision(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(asset)
    })
    .await
}

fn router(
    store: Store,
    allow_address_join: bool,
    refresh: Arc<WatchRefresh>,
    sources: sources::SourceRoots,
    baidu: baidu_cloud::BaiduCloud,
) -> Router {
    let router = Router::new()
        .route("/v1/info", get(service_info))
        .route(
            "/v1/profile",
            get(get_profile)
                .patch(patch_profile)
                .layer(DefaultBodyLimit::max(128 * 1024)),
        )
        .route("/v1/members/{id}/avatar", get(get_member_avatar))
        .route(
            "/v1/presence",
            post(presence).layer(Extension(TeamPresence::default())),
        )
        .route("/v1/team/name", patch(patch_team_name).layer(DefaultBodyLimit::max(4 * 1024)))
        .route("/v1/catalog/{since}", get(snapshot))
        .merge(sources.routes(Arc::clone(&refresh)))
        .merge(baidu.routes())
        .merge(asset_messages::routes())
        .merge(browser_sites::routes())
        .merge(creative_subscriptions::routes())
        .merge(creative_video_references::routes())
        .merge(organization::routes())
        .merge(asset_recycle::routes())
        .merge(quick_access::routes())
        .merge(whiteboard::routes())
        .merge(whiteboard_presence::routes())
        .route(
            "/v1/tags",
            post(create_tag)
                .patch(rename_tag)
                .delete(delete_tag)
                .layer(DefaultBodyLimit::max(2048)),
        )
        .route("/v1/folder-visibility", patch(set_folder_visibility))
        .route(
            "/v1/libraries/{library}/rescan-folder",
            post(request_folder_rescan)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(4096))
                .layer(Extension(Arc::clone(&refresh))),
        )
        .route(
            "/v1/libraries/{library}/refresh",
            post(request_watch_refresh).layer(Extension(refresh)),
        )
        .route(
            "/v1/libraries/{library}/links",
            post(link_folders)
                .delete(unlink_folders)
                .layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route("/v1/assets/{id}", patch(edit))
        .route(
            "/v1/publish",
            post(publish).layer(DefaultBodyLimit::max(MAX_PUBLISH_BYTES)),
        );
    let router = if allow_address_join {
        router.route(
            "/v1/join",
            post(address_join)
                .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(4096))
                .layer(Extension(AddressJoinLimit::new())),
        )
    } else {
        router
    };
    router.with_state(store)
}

#[derive(Deserialize)]
struct AddressJoinRequest {
    #[serde(default)]
    name: String,
}

async fn address_join(
    State(store): State<Store>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(limit): Extension<AddressJoinLimit>,
    headers: HeaderMap,
    Json(request): Json<AddressJoinRequest>,
) -> ApiResult<Value> {
    if headers.contains_key("origin") {
        return Err(error(StatusCode::FORBIDDEN, "请从 Nexus 桌面端连接团队"));
    }
    let requested_name = request.name.trim();
    let name = valid_name(if requested_name.is_empty() {
        "团队成员"
    } else {
        requested_name
    })?;
    if !limit.admit(peer.ip()) {
        return Err(error(
            StatusCode::TOO_MANY_REQUESTS,
            "加入团队的请求太多，请稍后再试",
        ));
    }
    tokio::task::spawn_blocking(move || {
        let conn = store
            .0
            .lock()
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "团队数据库不可用"))?;
        require_team(&conn)
            .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "团队尚未初始化"))?;
        let (_, token) = create_member(&conn, &name, "member")
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "未能创建团队成员"))?;
        Ok(Json(json!({"token":token})))
    })
    .await
    .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "团队服务处理失败"))?
}

async fn service_info(State(store): State<Store>, headers: HeaderMap) -> ApiResult<Value> {
    with_member(store, headers, |conn, member| {
        let team_id: String = conn
            .query_row("SELECT id FROM team WHERE singleton=1", [], |row| {
                row.get(0)
            })
            .map_err(db_error)?;
        Ok(json!({
            "teamId": team_id,
            "memberId": member.id,
            "role": member.role,
            "serverVersion": env!("CARGO_PKG_VERSION")
        }))
    })
    .await
}

fn create_member(
    conn: &Connection,
    name: &str,
    role: &str,
) -> Result<(String, String), Box<dyn std::error::Error>> {
    let name = valid_name(name).map_err(|_| "成员名称必须包含 1 至 200 个字符")?;
    if !matches!(role, "admin" | "member") {
        return Err("角色必须为 admin 或 member".into());
    }
    let id = Uuid::new_v4().to_string();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    conn.execute(
        "INSERT INTO members VALUES(?1,?2,?3,?4,1)",
        params![id, name, role, token_digest(&token)],
    )?;
    Ok((id, token))
}

fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    }
}

fn configure_library_watch(
    conn: &mut Connection,
    library: &str,
    path: &FilePath,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::fs::canonicalize(path)?;
    if !root.is_dir() {
        return Err("请填写服务器可访问的 NAS 文件夹".into());
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let exists = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1)",
        [library],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        return Err("团队库不存在，请先从桌面端发布".into());
    }
    let changed = tx.execute(
        "INSERT INTO watched_libraries(library,root) VALUES(?1,?2)
         ON CONFLICT(library) DO UPDATE SET root=excluded.root
         WHERE watched_libraries.root<>excluded.root",
        params![library, nexus_core::clean_path(&root)],
    )?;
    if changed > 0 {
        tx.execute(
            "DELETE FROM watched_file_identities WHERE asset IN (SELECT id FROM assets WHERE library=?1)",
            [library],
        )?;
        tx.execute("DELETE FROM linked_folders WHERE library=?1", [library])?;
        tx.execute(
            "DELETE FROM library_source_paths WHERE library=?1",
            [library],
        )?;
        tx.execute("UPDATE team SET revision=revision+1 WHERE singleton=1", [])?;
    }
    tx.commit()?;
    Ok(())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Nexus Team\n  nexus-team --data <服务数据目录> init <团队名> <管理员名>\n  nexus-team --data <服务数据目录> member-add <姓名> [member|admin]\n  nexus-team --data <服务数据目录> members\n  nexus-team --data <服务数据目录> member-disable <成员编号>\n  nexus-team --data <服务数据目录> libraries\n  nexus-team --data <服务数据目录> library-watch <库编号> <服务器可访问的 NAS 文件夹>\n  nexus-team --data <服务数据目录> library-unwatch <库编号>\n  nexus-team --data <服务数据目录> serve [监听地址:端口] [--allow-lan-http] [--allow-address-join]");
        return Ok(());
    }
    if args.len() < 3 || args[0] != "--data" {
        return Err("请用 --data 指定服务数据目录。运行 --help 查看用法".into());
    }
    let dir = PathBuf::from(args.remove(1));
    let mut conn = open_store(&dir)?;
    let command = &args[1..];
    match command {
        [cmd, team_name, admin_name, options @ ..]
            if cmd == "init" && (options.is_empty() || options == ["--json"]) =>
        {
            let name = valid_name(team_name).map_err(|_| "团队名称必须包含 1 至 200 个字符")?;
            let tx = conn.transaction()?;
            if tx
                .query_row("SELECT id FROM team", [], |r| r.get::<_, String>(0))
                .optional()?
                .is_some()
            {
                return Err("团队已经初始化。可用 member-add 添加管理员或成员".into());
            }
            let team_id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO team VALUES(1,?1,?2,0)", params![team_id, name])?;
            let (id, token) = create_member(&tx, admin_name, "admin")?;
            tx.commit()?;
            if options.is_empty() {
                println!("管理员编号 {id}\n访问密钥 {token}");
            } else {
                println!("{}", json!({"teamId":team_id,"adminId":id,"token":token}));
            }
        }
        [cmd, name, rest @ ..] if cmd == "member-add" && rest.len() <= 1 => {
            require_team(&conn)?;
            let (id, token) = create_member(
                &conn,
                name,
                rest.first().map(String::as_str).unwrap_or("member"),
            )?;
            println!("成员编号 {id}\n访问密钥 {token}");
        }
        [cmd] if cmd == "members" => {
            let mut query =
                conn.prepare("SELECT id,name,role,enabled FROM members ORDER BY rowid")?;
            for row in query.query_map([], |r| Ok((member_from_row(r)?, r.get::<_, bool>(3)?)))? {
                let (member, enabled) = row?;
                println!(
                    "{}\t{}\t{}\t{}",
                    member.id,
                    member.name,
                    member.role,
                    if enabled { "启用" } else { "停用" }
                );
            }
        }
        [cmd, id] if cmd == "member-disable" => {
            let changed = conn.execute(
                "UPDATE members SET enabled=0 WHERE id=?1 AND enabled=1",
                [id],
            )?;
            if changed == 0 {
                return Err("没有找到启用中的成员编号".into());
            }
            println!("已停用成员 {id}");
        }
        [cmd] if cmd == "libraries" => {
            let mut query = conn.prepare(
                "SELECT l.id,l.name,w.root FROM libraries l LEFT JOIN watched_libraries w ON w.library=l.id ORDER BY l.name"
            )?;
            for row in query.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })? {
                let (id, name, root) = row?;
                println!("{id}\t{name}\t{}", root.as_deref().unwrap_or("手动扫描"));
            }
        }
        [cmd, id, path] if cmd == "library-watch" => {
            configure_library_watch(&mut conn, id, FilePath::new(path))?;
            println!("已开启团队库 {id} 的定期扫描。运行中的服务会自动读取配置");
        }
        [cmd, id] if cmd == "library-unwatch" => {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if tx.execute("DELETE FROM watched_libraries WHERE library=?1", [id])? > 0 {
                tx.execute("UPDATE team SET revision=revision+1 WHERE singleton=1", [])?;
            }
            tx.commit()?;
            println!("已关闭团队库 {id} 的定期扫描");
        }
        [cmd, rest @ ..] if cmd == "serve" => {
            require_team(&conn)?;
            let sources = sources::SourceRoots::from_env()?;
            let baidu = baidu_cloud::BaiduCloud::from_env(&dir)?;
            let allow_lan_http = rest.iter().any(|x| x == "--allow-lan-http");
            let allow_address_join = rest.iter().any(|x| x == "--allow-address-join");
            let addresses: Vec<_> = rest
                .iter()
                .filter(|x| *x != "--allow-lan-http" && *x != "--allow-address-join")
                .collect();
            if addresses.len() > 1 {
                return Err("只能指定一个监听地址".into());
            }
            let address: SocketAddr = addresses
                .first()
                .map(|s| s.as_str())
                .unwrap_or("127.0.0.1:47822")
                .parse()?;
            if !address.ip().is_loopback() && !(allow_lan_http && private_ip(address.ip())) {
                return Err("请监听本机回环地址并经 HTTPS 代理访问。受信任的私有网络可指定具体私网 IP 和 --allow-lan-http".into());
            }
            match (
                env::var_os("NEXUS_TEAM_WATCH_LIBRARY"),
                env::var_os("NEXUS_TEAM_WATCH_ROOT"),
            ) {
                (Some(library), Some(root)) => configure_library_watch(
                    &mut conn,
                    library.to_str().ok_or("自动扫描团队库编号无效")?,
                    FilePath::new(&root),
                )?,
                (None, None) => {}
                _ => {
                    return Err(
                        "请同时设置 NEXUS_TEAM_WATCH_LIBRARY 和 NEXUS_TEAM_WATCH_ROOT".into(),
                    )
                }
            }
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(async {
                    let listener = tokio::net::TcpListener::bind(address).await?;
                    println!("Nexus Team listening on http://{}", listener.local_addr()?);
                    let store = Store(Arc::new(Mutex::new(conn)));
                    let refresh = Arc::new(WatchRefresh::default());
                    tokio::spawn(maintain_watches(store.clone(), refresh.clone()));
                    axum::serve(
                        listener,
                        router(store, allow_address_join, refresh, sources, baidu)
                            .into_make_service_with_connect_info::<SocketAddr>(),
                    )
                    .await
                })?;
        }
        _ => return Err("参数无效。运行 --help 查看用法".into()),
    }
    Ok(())
}

fn require_team(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    if conn
        .query_row("SELECT id FROM team", [], |r| r.get::<_, String>(0))
        .optional()?
        .is_none()
    {
        return Err("请先运行 init 初始化团队".into());
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_admin_can_rename_the_shared_workspace_and_advance_revision() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn = open_store(directory.path()).unwrap();
        let id = Uuid::new_v4().to_string();
        conn.execute("INSERT INTO team VALUES(1,?1,'原名称',7)", [&id])
            .unwrap();
        let mut member = Member { id: "member".into(), name: "用户".into(), role: "member".into() };
        let change = |team_id: &str, name: &str| RenameTeam {
            team_id: team_id.into(),
            name: name.into(),
        };
        assert!(matches!(
            rename_team(&mut conn, &member, change(&id, "新名称")),
            Err((StatusCode::FORBIDDEN, _))
        ));
        member.role = "admin".into();
        assert!(matches!(
            rename_team(&mut conn, &member, change("other", "新名称")),
            Err((StatusCode::CONFLICT, _))
        ));
        assert!(matches!(
            rename_team(&mut conn, &member, change(&id, "  ")),
            Err((StatusCode::BAD_REQUEST, _))
        ));
        let renamed = rename_team(&mut conn, &member, change(&id, " 新名称 ")).unwrap();
        assert_eq!(renamed.team.id, id);
        assert_eq!(renamed.team.name, "新名称");
        assert_eq!((renamed.previous_revision, renamed.revision), (7, 8));
        let repeated = rename_team(&mut conn, &member, change(&id, "新名称")).unwrap();
        assert_eq!((repeated.previous_revision, repeated.revision), (8, 8));
    }

    #[test]
    fn profile_avatar_requires_exact_dimensions_and_a_bounded_png() {
        let data_url = |width, height| {
            let pixels =
                image::RgbaImage::from_pixel(width, height, image::Rgba([12, 34, 56, 255]));
            let mut png = Cursor::new(Vec::new());
            pixels.write_to(&mut png, image::ImageFormat::Png).unwrap();
            format!("{AVATAR_PREFIX}{}", STANDARD.encode(png.into_inner()))
        };
        let valid = normalize_avatar(&data_url(96, 96)).unwrap();
        assert!(valid.len() <= MAX_AVATAR_BYTES);
        for invalid in [
            data_url(95, 96),
            data_url(96, 97),
            format!(
                "{AVATAR_PREFIX}{}",
                STANDARD.encode(vec![0; MAX_AVATAR_BYTES + 1])
            ),
            data_url(96, 96).replace("image/png", "image/jpeg"),
        ] {
            assert_eq!(
                normalize_avatar(&invalid).unwrap_err().0,
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[test]
    fn presence_expires_sessions_and_bounds_authenticated_members() {
        let online = TeamPresence::default();
        let start = Instant::now();
        for id in 0..MAX_ONLINE_MEMBERS {
            online.heartbeat(&id.to_string(), start, 100).unwrap();
        }
        assert_eq!(
            online.heartbeat("overflow", start, 100).unwrap_err().0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let same_member = online
            .heartbeat("0", start + Duration::from_secs(10), 110)
            .unwrap();
        assert_eq!(same_member.len(), MAX_ONLINE_MEMBERS);
        assert_eq!(same_member["0"].online_since, 100);
        assert_eq!(same_member["0"].last_seen, 110);
        let later = online.heartbeat("1", start + PRESENCE_TTL, 130).unwrap();
        assert_eq!(later.len(), 2);
        assert_eq!(later["1"].online_since, 130);
        assert_eq!(later["0"].online_since, 100);
    }

    #[test]
    fn address_join_budget_bounds_one_peer_and_total_enrollments() {
        let limit = AddressJoinLimit::new();
        let local: IpAddr = "127.0.0.1".parse().unwrap();
        assert!((0..8).all(|_| limit.admit(local)));
        assert!(!limit.admit(local));
        for last in 1..=112 {
            assert!(limit.admit(IpAddr::from([192, 168, 0, last])));
        }
        assert!(!limit.admit(IpAddr::from([192, 168, 0, 113])));
    }

    #[test]
    fn scoped_watch_refresh_keeps_sibling_files_and_reconciles_deleted_folders() {
        let fixture = tempfile::tempdir().unwrap();
        let mount = fixture.path().join("mount");
        let branch = mount.join("Selected");
        let sibling = mount.join("Selected-other");
        fs::create_dir_all(branch.join("Old")).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(branch.join("original.jpg"), "old").unwrap();
        fs::write(sibling.join("untouched.jpg"), "outside").unwrap();
        let mut db = open_store(&fixture.path().join("db")).unwrap();
        let library = Uuid::new_v4().to_string();
        db.execute("INSERT INTO team VALUES(1,'test','Team',1)", [])
            .unwrap();
        db.execute("INSERT INTO libraries VALUES(?1,'Assets')", [&library])
            .unwrap();
        configure_library_watch(&mut db, &library, &mount).unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        assert_eq!(scan_watch(&store, &library, "").unwrap().found, 2);

        fs::remove_file(branch.join("original.jpg")).unwrap();
        fs::remove_dir(branch.join("Old")).unwrap();
        fs::create_dir(branch.join("New")).unwrap();
        fs::write(branch.join("New/incoming.jpg"), "new").unwrap();
        fs::remove_file(sibling.join("untouched.jpg")).unwrap();
        fs::write(sibling.join("later.jpg"), "outside branch").unwrap();
        let report = scan_watch(&store, &library, "Selected").unwrap();
        assert_eq!(report.found, 1);
        assert!(report.errors.is_empty());

        let state = |query: &str| {
            let db = store.0.lock().unwrap();
            let mut stmt = db.prepare(query).unwrap();
            stmt.query_map([&library], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let assets =
            "SELECT relative FROM assets WHERE library=?1 AND available=1 ORDER BY relative";
        let folders = "SELECT folder FROM watched_folders WHERE library=?1 ORDER BY folder";
        assert_eq!(
            state(assets),
            vec!["Selected-other/untouched.jpg", "Selected/New/incoming.jpg"]
        );
        assert_eq!(
            state(folders),
            vec!["Selected", "Selected-other", "Selected/New"]
        );

        fs::remove_file(branch.join("New/incoming.jpg")).unwrap();
        fs::remove_dir(branch.join("New")).unwrap();
        fs::remove_dir(&branch).unwrap();
        assert_eq!(scan_watch(&store, &library, "Selected").unwrap().found, 0);
        assert_eq!(state(assets), vec!["Selected-other/untouched.jpg"]);
        assert_eq!(state(folders), vec!["Selected-other"]);
    }

    #[test]
    fn complete_watch_moves_preserve_existing_asset_and_metadata() {
        let fixture = tempfile::tempdir().unwrap();
        let mount = fixture.path().join("mount");
        let source = mount.join("old/椅子.obj");
        let target = mount.join("new/椅子.obj");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&source, "v 0 0 0\n").unwrap();
        let mut db = open_store(&fixture.path().join("db")).unwrap();
        let library = Uuid::new_v4().to_string();
        db.execute("INSERT INTO team VALUES(1,'test','测试团队',1)", [])
            .unwrap();
        db.execute("INSERT INTO libraries VALUES(?1,'素材')", [&library])
            .unwrap();
        let revision = |conn: &Connection| {
            conn.query_row("SELECT revision FROM team", [], |row| row.get::<_, u64>(0))
                .unwrap()
        };
        configure_library_watch(&mut db, &library, &mount).unwrap();
        let registered_revision = revision(&db);
        configure_library_watch(&mut db, &library, &mount).unwrap();
        assert_eq!(registered_revision, revision(&db));
        let root = nexus_core::clean_path(&std::fs::canonicalize(&mount).unwrap());
        let scan = || {
            let mut scan = scan_team_tree(&mount, |_| {}).unwrap();
            assert_eq!(scan.skipped, 0);
            assert_eq!(scan.files.len(), 1);
            // The watched NAS scanner provides the identity on Unix. This fixture exercises the
            // same reconciliation on Windows, where std metadata does not expose a stable ID.
            scan.files[0]
                .file_identity
                .get_or_insert_with(|| "fixture-file-identity".into());
            scan
        };
        let mut first_scan = scan();
        first_scan.files[0].tags = vec!["已审核".into()];
        first_scan.files[0].notes = "保留备注".into();
        assert_eq!(
            apply_watch_scan(
                &mut db,
                &library,
                &root,
                "",
                registered_revision,
                first_scan
            )
            .unwrap(),
            Some(3)
        );
        let read_asset = |db: &Connection| {
            let data: String = db
                .query_row("SELECT data FROM assets WHERE available=1", [], |row| {
                    row.get(0)
                })
                .unwrap();
            serde_json::from_str::<SharedAsset>(&data).unwrap()
        };
        let original = read_asset(&db);
        std::fs::rename(&source, &target).unwrap();
        let previous = revision(&db);
        assert_eq!(
            apply_watch_scan(&mut db, &library, &root, "", previous, scan()).unwrap(),
            Some(1)
        );
        let moved = read_asset(&db);
        assert_eq!(moved.relative_path, "new/椅子.obj");
        assert_eq!(moved.id, original.id);
        assert_eq!(moved.tags, original.tags);
        assert_eq!(moved.notes, original.notes);
        assert_eq!(moved.added, original.added);
        assert_eq!(moved.revision, original.revision + 1);
        assert_eq!(revision(&db), previous + 1);
        assert_eq!(std::fs::read_to_string(target).unwrap(), "v 0 0 0\n");
    }
}
