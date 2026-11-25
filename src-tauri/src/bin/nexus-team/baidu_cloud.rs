use super::{db_error, error, with_member, ApiError, ApiResult, Store};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::{delete, get, post},
    Extension, Json, Router,
};
use nexus_core::{
    baidu_cloud::{
        listing_diagnostic, login_diagnostic, normalize_path, BaiduClient, BaiduLogin, BaiduPage,
        LoginMode, LoginProgress, ROOT,
    },
    team::Member,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    fs::File,
    hash::{DefaultHasher, Hash, Hasher},
    io::{Seek, SeekFrom},
    path::{Path as FilePath, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::{
    io::AsyncReadExt,
    sync::{OwnedSemaphorePermit, Semaphore},
};
use uuid::Uuid;

const PAGE_SIZE: u32 = 100;
const MAX_SHARES: i64 = 64;
const MAX_DOWNLOAD: u64 = 2 * 1024 * 1024 * 1024;
const LOGIN_LIFETIME: Duration = Duration::from_secs(600);

type LoginSession = (Instant, BaiduLogin);

#[derive(Clone)]
pub(super) struct BaiduCloud(Arc<CloudState>);

struct CloudState {
    executable: Option<PathBuf>,
    profiles: PathBuf,
    logins: Mutex<HashMap<String, LoginSession>>,
    profiles_busy: [Mutex<()>; 32],
    queries: Arc<Semaphore>,
    downloads: Arc<Semaphore>,
}

impl BaiduCloud {
    pub(super) fn from_env(data_dir: &FilePath) -> std::io::Result<Self> {
        let executable = env::var_os("NEXUS_BDPAN_BIN")
            .map(PathBuf::from)
            .or_else(|| {
                #[cfg(target_os = "linux")]
                {
                    Some(PathBuf::from("/usr/local/bin/bdpan"))
                }
                #[cfg(not(target_os = "linux"))]
                None
            });
        Ok(Self(Arc::new(CloudState {
            executable,
            profiles: data_dir.canonicalize()?.join("baidu-profiles"),
            logins: Mutex::new(HashMap::new()),
            profiles_busy: std::array::from_fn(|_| Mutex::new(())),
            queries: Arc::new(Semaphore::new(8)),
            downloads: Arc::new(Semaphore::new(2)),
        })))
    }

    fn available(&self) -> bool {
        self.0
            .executable
            .as_ref()
            .is_some_and(|exe| exe.is_absolute() && exe.is_file())
    }

    fn client(&self, owner: &str) -> Result<BaiduClient, ApiError> {
        if !self.available() {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "团队服务尚未安装百度网盘组件",
            ));
        }
        let id = Uuid::parse_str(owner).map_err(|_| database_unavailable())?;
        let exe = self.0.executable.clone().ok_or_else(database_unavailable)?;
        BaiduClient::new(exe, self.0.profiles.join(id.to_string()))
            .map_err(|failure| authorization_error("profile", &failure))
    }

    fn login_sessions(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, LoginSession>>, ApiError> {
        let mut sessions = self.0.logins.lock().map_err(|_| database_unavailable())?;
        sessions.retain(|_, (started, _)| started.elapsed() < LOGIN_LIFETIME);
        Ok(sessions)
    }

    fn profile_access(&self, owner: &str) -> Result<std::sync::MutexGuard<'_, ()>, ApiError> {
        let mut hasher = DefaultHasher::new();
        owner.hash(&mut hasher);
        let index = hasher.finish() as usize % self.0.profiles_busy.len();
        self.0.profiles_busy[index].try_lock().map_err(|_| busy())
    }

    async fn run<T: Send + 'static>(
        &self,
        action: impl FnOnce(Self) -> Result<T, ApiError> + Send + 'static,
    ) -> Result<T, ApiError> {
        let state = self.clone();
        let slot = Arc::clone(&self.0.queries)
            .try_acquire_owned()
            .map_err(|_| busy())?;
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            action(state)
        })
        .await
        .map_err(|_| drive_error())?
    }

    pub(super) fn routes(self) -> Router<Store> {
        Router::new()
            .route("/v1/baidu/status", get(status))
            .route("/v1/baidu/login", get(poll_login).post(start_login))
            .route("/v1/baidu/login/cancel", post(cancel_login))
            .route("/v1/baidu/app-folder", post(create_app_folder))
            .route("/v1/baidu/logout", post(logout))
            .route("/v1/baidu/folders", get(owner_folders))
            .route("/v1/baidu/shares", get(list_shares).post(create_share))
            .route("/v1/baidu/shares/{id}", delete(remove_share))
            .route("/v1/baidu/shares/{id}/files", get(shared_files))
            .route("/v1/baidu/shares/{id}/download", get(download))
            .layer(DefaultBodyLimit::max(8192))
            .layer(Extension(self))
    }
}

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS baidu_shares (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            remote_path TEXT NOT NULL,
            remote_id TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            name TEXT NOT NULL,
            UNIQUE (owner, connection_id, remote_path)
        );",
    )
}

fn database_unavailable() -> ApiError {
    error(StatusCode::INTERNAL_SERVER_ERROR, "团队数据库不可用")
}

fn drive_error() -> ApiError {
    error(
        StatusCode::BAD_GATEWAY,
        "百度网盘暂时无法访问，请检查授权后重试",
    )
}

fn authorization_error(phase: &str, failure: &str) -> ApiError {
    let message = login_diagnostic(failure).unwrap_or("百度网盘授权未完成，请重试");
    eprintln!("Baidu authorization ({phase}): {message}");
    error(StatusCode::BAD_GATEWAY, message)
}

fn listing_error(failure: &str) -> ApiError {
    let message = listing_diagnostic(failure).unwrap_or("暂时无法读取百度网盘目录，请稍后重试");
    eprintln!("Baidu folder listing failed: {message}");
    error(StatusCode::BAD_GATEWAY, message)
}

fn invalid_path() -> ApiError {
    error(StatusCode::BAD_REQUEST, "网盘路径无效")
}

fn busy() -> ApiError {
    error(StatusCode::TOO_MANY_REQUESTS, "网盘访问繁忙，请稍后重试")
}

fn share_missing() -> ApiError {
    error(StatusCode::NOT_FOUND, "网盘共享文件夹已取消或无法访问")
}

async fn member(store: Store, headers: HeaderMap) -> Result<Member, ApiError> {
    Ok(with_member(store, headers, |_, member| Ok(member)).await?.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    available: bool,
    connected: bool,
}

async fn status(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
) -> ApiResult<Status> {
    let owner = member(store, headers).await?.id;
    let available = cloud.available();
    let connected = if available {
        cloud
            .run(move |cloud| {
                let _profile = cloud.profile_access(&owner)?;
                if cloud.login_sessions()?.contains_key(&owner) {
                    return Ok(false);
                }
                let status = cloud
                    .client(&owner)?
                    .status()
                    .map_err(|failure| authorization_error("status", &failure))?;
                Ok(status.connected && status.connection_id.is_some())
            })
            .await?
    } else {
        false
    };
    Ok(Json(Status {
        available,
        connected,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    pending: bool,
    connected: bool,
    verification_url: Option<String>,
    user_code: Option<String>,
}

impl From<LoginProgress> for Login {
    fn from(progress: LoginProgress) -> Self {
        Self {
            pending: progress.pending,
            connected: progress.connected,
            verification_url: progress.verification_url,
            user_code: progress.user_code,
        }
    }
}

fn login_progress(cloud: &BaiduCloud, owner: String, start: bool) -> Result<Login, ApiError> {
    let _profile = cloud.profile_access(&owner)?;
    let mut sessions = cloud.login_sessions()?;
    if start && !sessions.contains_key(&owner) {
        if sessions.len() >= 8 {
            return Err(error(
                StatusCode::TOO_MANY_REQUESTS,
                "网盘授权繁忙，请稍后重试",
            ));
        }
        let login = cloud
            .client(&owner)?
            .start_login(LoginMode::Device)
            .map_err(|failure| authorization_error("start", &failure))?;
        sessions.insert(owner.clone(), (Instant::now(), login));
    }
    let Some((_, login)) = sessions.get(&owner) else {
        drop(sessions);
        let connected = cloud.available()
            && cloud
                .client(&owner)?
                .status()
                .map_err(|failure| authorization_error("status", &failure))?
                .connected;
        return Ok(Login {
            pending: false,
            connected,
            verification_url: None,
            user_code: None,
        });
    };
    let result = login
        .poll()
        .map(Login::from)
        .map_err(|failure| authorization_error("poll", &failure));
    if !result.as_ref().is_ok_and(|progress| progress.pending) {
        sessions.remove(&owner);
    }
    result
}

async fn start_login(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
) -> ApiResult<Login> {
    let id = member(store, headers).await?.id;
    cloud
        .run(move |cloud| login_progress(&cloud, id, true))
        .await
        .map(Json)
}

async fn poll_login(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
) -> ApiResult<Login> {
    let id = member(store, headers).await?.id;
    cloud
        .run(move |cloud| login_progress(&cloud, id, false))
        .await
        .map(Json)
}

async fn cancel_login(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
) -> ApiResult<()> {
    let id = member(store, headers).await?.id;
    cloud
        .run(move |cloud| {
            let _profile = cloud.profile_access(&id)?;
            cloud.login_sessions()?.remove(&id);
            Ok(())
        })
        .await
        .map(Json)
}

#[derive(Serialize)]
struct AppFolder {
    path: String,
}

async fn create_app_folder(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
) -> ApiResult<AppFolder> {
    let owner = member(store, headers).await?.id;
    cloud
        .run(move |cloud| {
            let _profile = cloud.profile_access(&owner)?;
            if cloud.login_sessions()?.contains_key(&owner) {
                return Err(error(StatusCode::CONFLICT, "请先完成百度网盘登录"));
            }
            let path = cloud
                .client(&owner)?
                .create_app_folder()
                .map_err(|failure| listing_error(&failure))?;
            Ok(AppFolder { path })
        })
        .await
        .map(Json)
}

async fn logout(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
) -> ApiResult<Status> {
    let owner = member(store, headers).await?.id;
    cloud
        .run(move |cloud| {
            let _profile = cloud.profile_access(&owner)?;
            cloud.login_sessions()?.remove(&owner);
            cloud
                .client(&owner)?
                .logout()
                .map_err(|failure| authorization_error("logout", &failure))?;
            Ok(Status {
                available: true,
                connected: false,
            })
        })
        .await
        .map(Json)
}

#[derive(Default, Deserialize)]
struct Browse {
    #[serde(default)]
    path: String,
    #[serde(default)]
    offset: u32,
}

async fn owner_folders(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
    Query(query): Query<Browse>,
) -> ApiResult<BaiduPage> {
    let id = member(store, headers).await?.id;
    let path = normalize_path(if query.path.is_empty() {
        ROOT
    } else {
        &query.path
    })
    .map_err(|_| invalid_path())?;
    cloud
        .run(move |cloud| {
            let _profile = cloud.profile_access(&id)?;
            let client = cloud.client(&id)?;
            if cloud.login_sessions()?.contains_key(&id) {
                return Err(error(StatusCode::CONFLICT, "请先完成百度网盘登录"));
            }
            client
                .list(&path, true, query.offset, PAGE_SIZE)
                .map_err(|failure| listing_error(&failure))
        })
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    path: String,
}

#[derive(Serialize)]
struct Share {
    id: String,
    name: String,
    owner: String,
    owned: bool,
}

async fn list_shares(State(store): State<Store>, headers: HeaderMap) -> ApiResult<Vec<Share>> {
    with_member(store, headers, |conn, member| {
        let mut statement = conn
            .prepare(
                "SELECT s.id,s.name,m.name,s.owner=?1
             FROM baidu_shares s JOIN members m ON s.owner=m.id AND m.enabled=1
             ORDER BY s.name,s.id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([member.id], |row| {
                Ok(Share {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    owner: row.get(2)?,
                    owned: row.get(3)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
    })
    .await
}

async fn create_share(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
    Json(selection): Json<Selection>,
) -> ApiResult<Share> {
    let owner = member(store.clone(), headers.clone()).await?.id;
    let path = normalize_path(&selection.path).map_err(|_| invalid_path())?;
    if path == ROOT {
        return Err(error(StatusCode::BAD_REQUEST, "请选择要共享的具体文件夹"));
    }
    let (folder, connection_id) = cloud
        .run(move |cloud| {
            let _profile = cloud.profile_access(&owner)?;
            let client = cloud.client(&owner)?;
            if cloud.login_sessions()?.contains_key(&owner) {
                return Err(error(StatusCode::CONFLICT, "请先完成百度网盘登录"));
            }
            let status = client.status().map_err(|_| drive_error())?;
            let connection_id = status
                .connection_id
                .filter(|_| status.connected)
                .ok_or_else(drive_error)?;
            let folder = client
                .metadata_for(&connection_id, &path)
                .map_err(|_| share_missing())?;
            if !folder.directory || folder.id.is_empty() || folder.path != path {
                return Err(invalid_path());
            }
            Ok((folder, connection_id))
        })
        .await?;
    with_member(store, headers, move |conn, member| {
        let previous: Option<(String, String)> = conn.query_row(
            "SELECT id,remote_id FROM baidu_shares WHERE owner=?1 AND connection_id=?2 AND remote_path=?3",
            params![member.id, connection_id, folder.path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(db_error)?;
        let id = if let Some((id, _)) = previous.as_ref().filter(|(_, previous_folder)| previous_folder == &folder.id) {
            id.clone()
        } else {
            let count = conn.query_row("SELECT count(*) FROM baidu_shares", [], |row| row.get::<_, i64>(0)).map_err(db_error)?;
            if previous.is_none() && count >= MAX_SHARES {
                return Err(error(StatusCode::CONFLICT, "团队网盘共享数量已达上限"));
            }
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO baidu_shares VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(owner,connection_id,remote_path) DO UPDATE SET id=excluded.id,remote_id=excluded.remote_id,name=excluded.name",
                params![id, member.id, folder.path, folder.id, connection_id, folder.name],
            ).map_err(db_error)?;
            id
        };
        Ok(Share { id, name: folder.name, owner: member.name, owned: true })
    }).await
}

async fn remove_share(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<()> {
    with_member(store, headers, move |conn, member| {
        let removed = conn
            .execute(
                "DELETE FROM baidu_shares WHERE id=?1 AND owner=?2",
                params![id, member.id],
            )
            .map_err(db_error)?;
        if removed == 0 {
            return Err(share_missing());
        }
        Ok(())
    })
    .await
}

#[derive(Clone, PartialEq, Eq)]
struct ShareSource {
    owner: String,
    path: String,
    remote_id: String,
    connection_id: String,
}

async fn share_source(
    store: Store,
    headers: HeaderMap,
    id: String,
) -> Result<ShareSource, ApiError> {
    Ok(with_member(store, headers, move |conn, _| {
        conn.query_row(
            "SELECT s.owner,s.remote_path,s.remote_id,s.connection_id
             FROM baidu_shares s JOIN members m ON s.owner=m.id AND m.enabled=1 WHERE s.id=?1",
            [id],
            |row| {
                Ok(ShareSource {
                    owner: row.get(0)?,
                    path: row.get(1)?,
                    remote_id: row.get(2)?,
                    connection_id: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(share_missing)
    })
    .await?
    .0)
}

impl ShareSource {
    fn remote_path(&self, relative: &str) -> Result<String, ApiError> {
        if relative.is_empty() {
            return Ok(self.path.clone());
        }
        if relative.starts_with('/')
            || relative
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(invalid_path());
        }
        let path =
            normalize_path(&format!("{}/{}", self.path, relative)).map_err(|_| invalid_path())?;
        self.relative_path(&path).ok_or_else(invalid_path)?;
        Ok(path)
    }

    fn relative_path<'a>(&self, path: &'a str) -> Option<&'a str> {
        path.strip_prefix(&self.path)?
            .strip_prefix('/')
            .filter(|path| !path.is_empty())
    }

    fn client(&self, cloud: &BaiduCloud) -> Result<BaiduClient, ApiError> {
        if cloud.login_sessions()?.contains_key(&self.owner) {
            return Err(share_missing());
        }
        let client = cloud.client(&self.owner)?;
        let status = client.status().map_err(|_| drive_error())?;
        if !status.connected || status.connection_id.as_deref() != Some(&self.connection_id) {
            return Err(share_missing());
        }
        let root = client
            .metadata_for(&self.connection_id, &self.path)
            .map_err(|_| share_missing())?;
        if !root.directory || root.id != self.remote_id || root.path != self.path {
            return Err(share_missing());
        }
        Ok(client)
    }
}

async fn shared_files(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<Browse>,
) -> ApiResult<BaiduPage> {
    let source = share_source(store.clone(), headers.clone(), id.clone()).await?;
    let returned_source = source.clone();
    let path = source.remote_path(&query.path)?;
    let files = cloud
        .run(move |cloud| {
            let _profile = cloud.profile_access(&source.owner)?;
            let client = source.client(&cloud)?;
            let mut page = client
                .list_for(&source.connection_id, &path, false, query.offset, PAGE_SIZE)
                .map_err(|failure| listing_error(&failure))?;
            for entry in &mut page.entries {
                entry.path = source
                    .relative_path(&entry.path)
                    .ok_or_else(drive_error)?
                    .to_owned();
            }
            Ok(page)
        })
        .await?;
    if share_source(store, headers, id).await? != returned_source {
        return Err(share_missing());
    }
    Ok(Json(files))
}

struct DownloadFile {
    file: tokio::fs::File,
    _storage: TempDir,
    _slot: OwnedSemaphorePermit,
    remaining: u64,
}

async fn download(
    State(store): State<Store>,
    Extension(cloud): Extension<BaiduCloud>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<Selection>,
) -> Result<Response, ApiError> {
    let source = share_source(store.clone(), headers.clone(), id.clone()).await?;
    let returned_source = source.clone();
    let path = source.remote_path(&query.path)?;
    if path == source.path {
        return Err(invalid_path());
    }
    let slot = Arc::clone(&cloud.0.downloads)
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let (mut file, storage, size, slot) = tokio::task::spawn_blocking(move || {
        let _profile = cloud.profile_access(&source.owner)?;
        let client = source.client(&cloud)?;
        let entry = client
            .metadata_for(&source.connection_id, &path)
            .map_err(|_| share_missing())?;
        if entry.directory || entry.path != path {
            return Err(share_missing());
        }
        if entry.size > MAX_DOWNLOAD {
            return Err(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "此网盘文件超过团队传输限制",
            ));
        }
        // The NAS container's /tmp is a small RAM filesystem. Keep file staging on disk.
        let data_dir = cloud.0.profiles.parent().ok_or_else(drive_error)?;
        let storage = tempfile::Builder::new()
            .prefix(".baidu-transfer-")
            .tempdir_in(data_dir)
            .map_err(|_| drive_error())?;
        let local = storage.path().join("asset");
        client
            .download_for_limit(&source.connection_id, &path, &local, MAX_DOWNLOAD)
            .map_err(|_| drive_error())?;
        let file = File::open(&local).map_err(|_| drive_error())?;
        let size = file.metadata().map_err(|_| drive_error())?.len();
        if size != entry.size {
            return Err(drive_error());
        }
        Ok((file, storage, size, slot))
    })
    .await
    .map_err(|_| drive_error())??;
    if share_source(store, headers.clone(), id).await? != returned_source {
        return Err(share_missing());
    }
    let selected = headers.get(header::RANGE).map(|header| {
        header
            .to_str()
            .ok()
            .and_then(|value| byte_range(value, size))
    });
    let (code, start, len) = match selected {
        None => (StatusCode::OK, 0, size),
        Some(Some((start, end))) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        Some(None) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Body::empty())
                .map_err(|_| drive_error())
        }
    };
    file.seek(SeekFrom::Start(start))
        .map_err(|_| drive_error())?;
    let stream = futures_util::stream::try_unfold(
        DownloadFile {
            file: tokio::fs::File::from_std(file),
            _storage: storage,
            _slot: slot,
            remaining: len,
        },
        |mut part| async move {
            if part.remaining == 0 {
                return Ok::<_, std::io::Error>(None);
            }
            let mut chunk = vec![0; part.remaining.min(64 * 1024) as usize];
            part.file.read_exact(&mut chunk).await?;
            part.remaining -= chunk.len() as u64;
            Ok(Some((Bytes::from(chunk), part)))
        },
    );
    let mut response = Response::builder()
        .status(code)
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_DISPOSITION, "attachment")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, len);
    if code == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", start + len - 1),
        );
    }
    response
        .body(Body::from_stream(stream))
        .map_err(|_| drive_error())
}

fn byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let last = size.checked_sub(1)?;
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let tail: u64 = end.parse().ok()?;
        return (tail > 0).then_some((size.saturating_sub(tail), last));
    }
    let start: u64 = start.parse().ok()?;
    let end = if end.is_empty() {
        last
    } else {
        end.parse::<u64>().ok()?.min(last)
    };
    (start <= end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_cannot_escape_the_explicitly_shared_folder() {
        let source = ShareSource {
            owner: String::new(),
            path: format!("{ROOT}/团队素材"),
            remote_id: "1".to_owned(),
            connection_id: "verified".to_owned(),
        };
        assert_eq!(source.remote_path("").unwrap(), source.path);
        assert_eq!(
            source.remote_path("子目录/素材.blend").unwrap(),
            format!("{ROOT}/团队素材/子目录/素材.blend")
        );
        for invalid in [
            "../private",
            "a/../../private",
            "/private",
            "a//file",
            "a/",
            "..\\private",
            "a/./file",
        ] {
            assert!(source.remote_path(invalid).is_err(), "accepted {invalid}");
        }
        assert_eq!(
            source.relative_path(&format!("{ROOT}/团队素材-old/secret")),
            None
        );
    }

    #[test]
    fn file_ranges_are_inclusive_bounded_and_single() {
        assert_eq!(byte_range("bytes=0-10", 20), Some((0, 10)));
        assert_eq!(byte_range("bytes=5-", 20), Some((5, 19)));
        assert_eq!(byte_range("bytes=-3", 20), Some((17, 19)));
        assert_eq!(byte_range("bytes=-30", 20), Some((0, 19)));
        assert_eq!(byte_range("bytes=5-900", 20), Some((5, 19)));
        assert_eq!(byte_range("bytes=20-", 20), None);
        assert_eq!(byte_range("bytes=1-0", 20), None);
        assert_eq!(byte_range("bytes=0-1,3-4", 20), None);
        assert_eq!(byte_range("bytes=0-", 0), None);
    }

    #[test]
    fn shared_links_require_team_membership_and_only_the_owner_can_revoke() {
        let fixture = tempfile::tempdir().unwrap();
        let conn = super::super::open_store(fixture.path()).unwrap();
        let (owner, owner_token) = super::super::create_member(&conn, "Owner", "member").unwrap();
        let (_, admin_token) = super::super::create_member(&conn, "Viewer", "admin").unwrap();
        conn.execute(
            "INSERT INTO baidu_shares VALUES('link',?1,?2,'folder-id','grant-id','Library')",
            params![owner, format!("{ROOT}/private-parent/Library")],
        )
        .unwrap();
        let store = Store(Arc::new(Mutex::new(conn)));
        let bearer = |token: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
            headers
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let visitor = list_shares(State(store.clone()), HeaderMap::new()).await;
            assert!(matches!(visitor, Err((StatusCode::UNAUTHORIZED, _))));
            let mut origin = bearer(&admin_token);
            origin.insert(
                header::ORIGIN,
                "https://unauthorized.invalid".parse().unwrap(),
            );
            let visitor = list_shares(State(store.clone()), origin).await;
            assert!(matches!(visitor, Err((StatusCode::UNAUTHORIZED, _))));
            let viewer = bearer(&admin_token);
            let owner_headers = bearer(&owner_token);
            let listing = list_shares(State(store.clone()), viewer.clone())
                .await
                .unwrap();
            let public = serde_json::to_value(listing.0).unwrap();
            assert_eq!(
                public,
                serde_json::json!([{"id":"link","name":"Library","owner":"Owner","owned":false}])
            );
            let cannot_remove =
                remove_share(State(store.clone()), viewer.clone(), Path("link".into())).await;
            assert!(matches!(cannot_remove, Err((StatusCode::NOT_FOUND, _))));
            let available = share_source(store.clone(), viewer.clone(), "link".into()).await;
            assert!(available.is_ok());
            let _ = remove_share(State(store.clone()), owner_headers, Path("link".into()))
                .await
                .unwrap();
            let disconnected = share_source(store.clone(), viewer, "link".into()).await;
            assert!(matches!(disconnected, Err((StatusCode::NOT_FOUND, _))));
        });
    }
}
