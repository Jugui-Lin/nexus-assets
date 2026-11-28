use crate::team_import::{create_team_folder, share_path, team_destination};
use base64::Engine;
use nexus_core::{clean_path, team::*, Asset, Catalog};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, Url};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufReader, BufWriter, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

const MAX_AVATAR_BYTES: usize = 65_536;
const MAX_PROFILE_RESPONSE_BYTES: usize = 96 * 1024;
const AVATAR_DATA_URL_PREFIX: &str = "data:image/png;base64,";
const TEAM_CATALOG_CACHE_FILE: &str = "team-catalog-v1.json";

#[path = "team_folder_links.rs"]
mod folder_links;
#[path = "baidu_cloud_team_client.rs"]
mod baidu_cloud_client;
#[path = "team_asset_messages.rs"]
pub(crate) mod asset_messages;
#[path = "team_browser_sites.rs"]
pub(crate) mod browser_sites;
#[path = "team_creative_subscriptions.rs"]
pub(crate) mod creative_subscriptions;
#[path = "team_organization_desktop.rs"]
pub(crate) mod organization;
#[path = "team_recycle.rs"]
pub(crate) mod recycle;
use crate::team_network_paths as network_paths;
#[path = "team_quick_access.rs"]
pub(crate) mod quick_access;
#[path = "team_whiteboard.rs"]
pub(crate) mod whiteboard;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Connection {
    url: String,
    token: String,
    allow_lan_http: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionIdentity {
    team_id: String,
    member_id: String,
}

impl ConnectionIdentity {
    fn new(team: &Team, member: &Member) -> Self {
        Self {
            team_id: team.id.clone(),
            member_id: member.id.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamServiceInfo {
    #[serde(flatten)]
    identity: ConnectionIdentity,
    server_version: Option<String>,
}

#[derive(PartialEq)]
struct ActiveConnection {
    config: Connection,
    identity: ConnectionIdentity,
    generation: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamProfile {
    name: String,
    avatar_url: Option<String>,
}

impl TeamProfile {
    fn validate(&self) -> Result<(), String> {
        validate_profile_name(self.name.trim())?;
        if let Some(url) = &self.avatar_url {
            validate_profile_avatar(url)?;
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberAvatar {
    avatar_url: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum AvatarAction {
    Keep,
    Remove,
    Replace,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Preferences {
    connection: Option<Connection>,
    connection_identity: Option<ConnectionIdentity>,
    mounts: HashMap<String, HashMap<String, String>>,
    thumbnail_cache_roots: HashMap<String, String>,
    favorites: HashMap<String, HashSet<String>>,
}

#[derive(Serialize, Deserialize)]
struct Cached {
    team: Team,
    member: Member,
    revision: u64,
    catalog: SharedCatalog,
    #[serde(skip)]
    asset_indices: HashMap<String, usize>,
    // Effective permission for this member, including older admin-only servers.
    folder_visibility: bool,
}

#[derive(Serialize, Deserialize)]
struct StoredCatalog<T> {
    connection_key: String,
    index: T,
}

fn catalog_connection_key(connection: &Connection) -> String {
    let mut digest = Sha256::new();
    digest.update(connection.url.as_bytes());
    digest.update([0]);
    digest.update(connection.token.as_bytes());
    digest.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Cached {
    fn identity(&self) -> ConnectionIdentity {
        ConnectionIdentity::new(&self.team, &self.member)
    }

    fn build_asset_indices(&mut self) {
        self.asset_indices = self.catalog.assets.iter().enumerate()
            .map(|(index, asset)| (asset.id.clone(), index)).collect();
    }

    fn asset(&self, id: &str) -> Option<&SharedAsset> {
        self.asset_indices
            .get(id)
            .and_then(|&index| self.catalog.assets.get(index))
    }

    fn all_libraries(&self) -> &[Library] {
        self.catalog
            .all_libraries
            .as_deref()
            .unwrap_or(&self.catalog.libraries)
    }

    fn has_indexed_folder(&self, library_id: &str, folder: &str) -> bool {
        use crate::folder_deletion::inside_folder;

        folder.is_empty()
            || self
                .catalog
                .visible_folders
                .get(library_id)
                .is_some_and(|folders| folders.iter().any(|child| inside_folder(folder, child)))
            || self.catalog.assets.iter().any(|asset| {
                asset.library_id == library_id
                    && asset
                        .relative_path
                        .rsplit_once('/')
                        .is_some_and(|(directory, _)| inside_folder(folder, directory))
            })
    }
}

#[derive(Default)]
struct Workspace {
    prefs: Preferences,
    cache: Option<Cached>,
    pending_join: Option<Connection>,
    connection_generation: u64,
}

impl Workspace {
    fn active_connection(&self) -> Result<ActiveConnection, String> {
        let config = self.prefs.connection.clone().ok_or("请先连接团队")?;
        let cached = self.cache.as_ref().ok_or("请先同步团队目录")?;
        Ok(ActiveConnection {
            config,
            identity: ConnectionIdentity::new(&cached.team, &cached.member),
            generation: self.connection_generation,
        })
    }

    fn manual_mounts(&self, cached: &Cached) -> impl Iterator<Item = &str> {
        self.prefs
            .mounts
            .get(&cached.team.id)
            .into_iter()
            .flat_map(|mounts| mounts.values().map(String::as_str))
    }

    fn automatic_mount(&self, cached: &Cached, library_id: &str) -> Option<String> {
        if !cfg!(windows) {
            return None;
        }
        let connection = self.prefs.connection.as_ref()?;
        let unc = network_paths::UncDirectory::parse(cached.catalog.source_paths.get(library_id)?)?;
        unc.trusted(&connection.url, self.manual_mounts(cached))
            .then(|| unc.text())
    }

    fn resolved_mount(&self, cached: &Cached, library_id: &str) -> Option<String> {
        self.automatic_mount(cached, library_id).or_else(|| {
            self.prefs
                .mounts
                .get(&cached.team.id)?
                .get(library_id)
                .filter(|path| Path::new(path).is_absolute())
                .cloned()
        })
    }

    fn effective_mounts(&self, cached: &Cached) -> HashMap<String, String> {
        cached
            .all_libraries()
            .iter()
            .filter_map(|library| {
                self.resolved_mount(cached, &library.id)
                    .map(|root| (library.id.clone(), root))
            })
            .collect()
    }
}

pub struct Desktop {
    client: Client,
    db_dir: PathBuf,
    data: Mutex<Workspace>,
    connecting: tokio::sync::Mutex<()>,
}

pub(crate) struct TeamPreviewAsset {
    pub asset: Asset,
    pub team_id: String,
    pub storage: Result<TeamAssetStorage, String>,
    pub thumbnail_cache_root: Option<PathBuf>,
    pub relative_path: String,
}

pub(crate) struct IndexedTeamPreview {
    pub asset: Asset,
    pub namespace: String,
    pub thumbnail_cache_root: Option<PathBuf>,
}

#[derive(PartialEq, Eq, Hash)]
pub(crate) struct TeamAssetStorage {
    mount: PathBuf,
    pub library_id: String,
    folder: Option<String>,
}

impl TeamAssetStorage {
    pub(crate) fn for_asset(mount: PathBuf, asset: &SharedAsset) -> Result<Self, String> {
        match (&asset.storage_library_id, &asset.storage_folder) {
            (None, None) => Ok(Self {
                mount,
                library_id: asset.library_id.clone(),
                folder: None,
            }),
            (Some(library_id), Some(folder)) => {
                if Uuid::parse_str(library_id).is_err() {
                    return Err("团队资产原存储编号无效".into());
                }
                let path = relative_path(folder).ok_or("团队资产原存储目录无效")?;
                if share_path(&path)? != *folder {
                    return Err("团队资产原存储目录无效".into());
                }
                Ok(Self {
                    mount,
                    library_id: library_id.clone(),
                    folder: Some(folder.clone()),
                })
            }
            _ => Err("团队资产原存储位置不完整".into()),
        }
    }

    pub(crate) fn data_mount(&self) -> Result<PathBuf, String> {
        let Some(folder) = &self.folder else {
            return Ok(self.mount.clone());
        };
        let (root, relative) = team_destination(&self.mount, folder)?;
        Ok(root.join(relative))
    }
}

impl Desktop {
    pub(crate) fn mapped_workspace_files(
        &self,
        ids: &[String],
    ) -> HashMap<String, (PathBuf, String)> {
        if ids.is_empty() {
            return HashMap::new();
        }
        let data = self.data.lock().unwrap();
        let Some(cached) = &data.cache else {
            return HashMap::new();
        };
        let mounts = data.effective_mounts(cached);
        ids.iter()
            .filter_map(|id| {
                let asset = cached.asset(id.strip_prefix("team:")?)?;
                let root = PathBuf::from(mounts.get(&asset.library_id)?);
                relative_path(&asset.relative_path)?;
                if !root.is_absolute()
                    || asset
                        .relative_path
                        .split('/')
                        .any(|part| part.starts_with('.'))
                {
                    return None;
                }
                Some((id.clone(), (root, asset.relative_path.clone())))
            })
            .collect()
    }

    pub(crate) async fn copy_workspace_files(
        &self,
        window: tauri::WebviewWindow,
        mut ids: Vec<String>,
    ) -> Result<Option<crate::asset_files::CopyReport>, String> {
        use crate::{
            asset_files::{copy_files, CopyReport},
            team_import::team_destination,
        };

        let _operation = self.begin_storage_operation()?;
        ids.sort_unstable();
        ids.dedup();
        let mut assets = self.mapped_workspace_files(&ids);
        let sources = ids
            .iter()
            .map(|id| assets.remove(id).ok_or("找不到选中的团队资产或其挂载目录"))
            .collect::<Result<Vec<_>, _>>()?;
        let (team_id, mounts) = {
            let data = self.data.lock().unwrap();
            let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
            let mounts = data.effective_mounts(cached);
            (cached.team.id.clone(), mounts)
        };
        let selection = tauri::async_runtime::spawn_blocking(move || {
            crate::workspace_files::pick_team_copy_folder(window, mounts)
        })
        .await
        .map_err(|error| error.to_string())??;
        let Some((folder, team_target)) = selection else {
            return Ok(None);
        };
        let target = if let Some((id, relative)) = team_target {
            let (connection, id, mount) =
                self.checked_write_target(&team_id, &id, &relative).await?;
            Some((connection, id, mount, relative))
        } else {
            None
        };
        let approved = target
            .as_ref()
            .map(|(_, _, mount, relative)| (mount.clone(), relative.clone()));
        let (folder, paths) = tauri::async_runtime::spawn_blocking(move || {
            let folder = if let Some((mount, relative)) = approved {
                let (root, path) = team_destination(&mount, &relative)?;
                root.join(path)
            } else {
                folder
            };
            let sources = sources
                .into_iter()
                .map(|(root, relative)| mapped_file(&root, &relative))
                .collect::<Result<Vec<_>, _>>()?;
            copy_files(sources, &folder).map(|paths| (folder, paths))
        })
        .await
        .map_err(|error| error.to_string())??;
        let mut report = CopyReport {
            copied: paths.len(),
            folder: clean_path(&folder),
            paths: paths.iter().map(|path| clean_path(path)).collect(),
            indexed: 0,
            index_errors: Vec::new(),
        };
        if let Some((connection, id, _, _)) = target {
            match self.refresh_watched_library(&connection, &id).await {
                Ok(_) => report.indexed = report.copied,
                Err(error) => report.index_errors.push(error),
            }
        }
        Ok(Some(report))
    }

    pub fn new(catalog: &Catalog) -> Result<Self, String> {
        let saved: Option<String> = catalog
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key='team_preferences'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let prefs = saved
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            db_dir: catalog.dir.clone(),
            data: Mutex::new(Workspace {
                prefs,
                ..Workspace::default()
            }),
            connecting: tokio::sync::Mutex::new(()),
        })
    }

    fn local_catalog_path(&self) -> PathBuf {
        self.db_dir.join(TEAM_CATALOG_CACHE_FILE)
    }

    fn load_local_catalog(&self, data: &Workspace) -> Option<Cached> {
        let connection = data.prefs.connection.as_ref()?;
        let identity = data.prefs.connection_identity.as_ref()?;
        let file = File::open(self.local_catalog_path()).ok()?;
        let stored: StoredCatalog<Cached> = serde_json::from_reader(BufReader::new(file)).ok()?;
        if stored.connection_key != catalog_connection_key(connection) || stored.index.identity() != *identity {
            return None;
        }
        let mut cached = stored.index;
        cached.build_asset_indices();
        Some(cached)
    }

    fn persist_local_catalog(&self, data: &Workspace) -> Result<(), Box<dyn std::error::Error>> {
        let Some((connection, index)) = data.prefs.connection.as_ref().zip(data.cache.as_ref()) else {
            return Ok(());
        };
        if data.prefs.connection_identity.as_ref() != Some(&index.identity()) {
            return Ok(());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.db_dir)?;
        {
            let mut writer = BufWriter::new(temporary.as_file_mut());
            serde_json::to_writer(&mut writer, &StoredCatalog {connection_key:catalog_connection_key(connection), index})?;
            writer.flush()?;
        }
        temporary.as_file().sync_all()?;
        temporary.persist(self.local_catalog_path())?;
        Ok(())
    }

    fn cached_catalog(&self) -> Result<Option<Value>, String> {
        let mut data = self.data.lock().unwrap();
        if data.cache.is_none() {
            data.cache = self.load_local_catalog(&data);
        }
        data.cache.as_ref().map(|_| view(&data, true)).transpose()
    }

    fn save(&self, prefs: &Preferences) -> Result<(), String> {
        let db = rusqlite::Connection::open(self.db_dir.join("nexus.sqlite3"))
            .map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT INTO settings VALUES('team_preferences',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(prefs).map_err(|e| e.to_string())?],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection, String> {
        self.data
            .lock()
            .unwrap()
            .prefs
            .connection
            .clone()
            .ok_or_else(|| "请先连接团队".into())
    }

    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        connection: &Connection,
        method: Method,
        route: &str,
        body: Option<Vec<u8>>,
    ) -> Result<T, String> {
        let request = self.authenticated_request(connection, method, route, body);
        Self::decode_response(Self::send(request).await?).await
    }

    fn connection_for_team(&self, team_id: &str) -> Result<ActiveConnection, String> {
        let active = self.active_connection()?;
        if active.identity.team_id != team_id {
            return Err("团队工作空间已切换".into());
        }
        Ok(active)
    }

    async fn scoped_request<T: serde::de::DeserializeOwned>(
        &self,
        team_id: &str,
        method: Method,
        route: &str,
        body: Option<Vec<u8>>,
    ) -> Result<T, String> {
        let active = self.connection_for_team(team_id)?;
        let result = self.request(&active.config, method, route, body).await?;
        if self.active_connection()? != active {
            return Err("团队工作空间已切换".into());
        }
        Ok(result)
    }

    async fn synchronize_catalog(&self, since: Option<u64>) -> Result<Value, String> {
        let (config, generation) = {
            let data = self.data.lock().unwrap();
            (data.prefs.connection.clone().ok_or("请先连接团队")?, data.connection_generation)
        };
        let route = since.map_or_else(|| "/v1/catalog/full".into(), |rev| format!("/v1/catalog/{rev}"));
        let mut snapshot: Snapshot = self.request(&config, Method::GET, &route, None).await?;
        if snapshot.catalog.is_none() {
            let identity = ConnectionIdentity::new(&snapshot.team, &snapshot.member);
            let has_matching_index = {
                let data = self.data.lock().unwrap();
                if data.connection_generation != generation {
                    return Err("团队连接已切换，请重试".into());
                }
                data.cache.as_ref().is_some_and(|cached| cached.identity() == identity)
            };
            if !has_matching_index {
                // A replacement team can share the same revision number as the cached one.
                snapshot = self.request(&config, Method::GET, "/v1/catalog/full", None).await?;
                if snapshot.catalog.is_none() {
                    return Err("团队服务没有返回完整目录".into());
                }
            }
        }
        let mut data = self.data.lock().unwrap();
        if data.connection_generation != generation || data.prefs.connection.as_ref() != Some(&config) {
            return Err("团队连接已切换，请重试".into());
        }
        let identity = ConnectionIdentity::new(&snapshot.team, &snapshot.member);
        let identity_changed = data.cache.as_ref().is_none_or(|cached| cached.identity() != identity);
        let mut persist = false;
        if snapshot.catalog.is_some() {
            // Concurrent polling can finish out of order.
            if identity_changed || data.cache.as_ref().is_none_or(|cached| cached.revision <= snapshot.revision) {
                data.cache = Some(cache_from(snapshot)?);
                persist = true;
            }
        } else if let Some(cached) = data.cache.as_mut() {
            if !identity_changed && cached.revision == snapshot.revision {
                let folder_visibility = folder_visibility_allowed(&snapshot);
                persist = cached.folder_visibility != folder_visibility
                    || cached.member.name != snapshot.member.name
                    || cached.member.role != snapshot.member.role
                    || cached.team.name != snapshot.team.name;
                cached.folder_visibility = folder_visibility;
                cached.member = snapshot.member;
                cached.team = snapshot.team;
            }
        }
        if let Some(cached) = data.cache.as_ref() {
            let identity = cached.identity();
            if data.prefs.connection_identity.as_ref() != Some(&identity) {
                let mut prefs = data.prefs.clone();
                prefs.connection_identity = Some(identity);
                // Legacy configurations can still browse when their settings cannot be saved.
                if self.save(&prefs).is_ok() {
                    data.prefs = prefs;
                    persist = true;
                }
            }
        }
        if persist {
            let _ = self.persist_local_catalog(&data);
        }
        let include = identity_changed || since.is_none() || data.cache.as_ref()
            .is_some_and(|cached| Some(cached.revision) != since);
        view(&data, include)
    }

    fn authenticated_request(
        &self,
        connection: &Connection,
        method: Method,
        route: &str,
        body: Option<Vec<u8>>,
    ) -> RequestBuilder {
        let url = format!("{}{route}", connection.url);
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&connection.token);
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        request
    }

    async fn decode_response<T: serde::de::DeserializeOwned>(
        response: Response,
    ) -> Result<T, String> {
        let status = response.status();
        if !status.is_success() {
            let message = response
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v["error"].as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("团队服务返回错误 {status}"));
            return Err(message);
        }
        response
            .json()
            .await
            .map_err(|_| "团队服务返回了无法读取的数据".into())
    }

    async fn send(request: RequestBuilder) -> Result<Response, String> {
        request.send().await.map_err(|e| {
            if e.is_timeout() {
                "连接团队服务超时，请检查网络和服务器地址"
            } else {
                "无法连接团队服务，请检查服务地址、证书和网络"
            }
            .into()
        })
    }

    async fn join(
        &self,
        url: String,
        name: Option<String>,
        allow_lan_http: bool,
    ) -> Result<Value, String> {
        let previous = {
            let data = self.data.lock().unwrap();
            data.prefs
                .connection
                .as_ref()
                .filter(|config| config.url == url)
                .or_else(|| {
                    data.pending_join
                        .as_ref()
                        .filter(|config| config.url == url)
                })
                .cloned()
        };
        if let Some(mut config) = previous {
            config.allow_lan_http = allow_lan_http;
            return self.connect(config).await;
        }

        let name = enrollment_name(name.as_deref())?;
        let response = Self::send(
            self.client
                .post(format!("{url}/v1/join"))
                .json(&json!({"name":name})),
        )
        .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status {
                StatusCode::NOT_FOUND
                | StatusCode::METHOD_NOT_ALLOWED
                | StatusCode::NOT_IMPLEMENTED => {
                    "团队服务暂不支持地址加入，请更新服务端或使用访问密钥连接".into()
                }
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    "团队服务未允许此连接通过地址加入，请联系管理员或使用访问密钥连接".into()
                }
                StatusCode::TOO_MANY_REQUESTS => "地址加入请求过多，请稍后重试".into(),
                _ => format!("团队服务无法完成地址加入（{status}）"),
            });
        }
        #[derive(Deserialize)]
        struct Enrollment {
            token: String,
        }
        let enrollment: Enrollment = response
            .json()
            .await
            .map_err(|_| "团队服务返回的加入凭据无效")?;
        if !valid_access_token(&enrollment.token) {
            return Err("团队服务返回的加入凭据无效".into());
        }
        let config = Connection {
            url,
            token: enrollment.token,
            allow_lan_http,
        };
        // Reuse a newly-issued identity if catalog synchronization needs to be retried.
        self.data.lock().unwrap().pending_join = Some(config.clone());
        self.connect(config).await
    }

    async fn connect(&self, config: Connection) -> Result<Value, String> {
        let snapshot = self
            .request(&config, Method::GET, "/v1/catalog/full", None)
            .await?;
        let cache = cache_from(snapshot)?;
        self.save_connection(config, cache)
    }

    fn save_connection(&self, config: Connection, cache: Cached) -> Result<Value, String> {
        let mut data = self.data.lock().unwrap();
        let mut prefs = data.prefs.clone();
        prefs.connection = Some(config);
        prefs.connection_identity = Some(cache.identity());
        self.save(&prefs)?;
        data.prefs = prefs;
        data.cache = Some(cache);
        data.pending_join = None;
        data.connection_generation = data.connection_generation.wrapping_add(1);
        let _ = self.persist_local_catalog(&data);
        view(&data, true)
    }

    async fn reconnect_nas(&self, url: String, allow_lan_http: bool) -> Result<Value, String> {
        let (previous, identity) = {
            let data = self.data.lock().unwrap();
            let previous = data.prefs.connection.clone().ok_or("请先连接原团队")?;
            let identity = data.prefs.connection_identity.clone().or_else(|| {
                data.cache
                    .as_ref()
                    .map(|cache| ConnectionIdentity::new(&cache.team, &cache.member))
            });
            (previous, identity)
        };
        if !valid_access_token(&previous.token) {
            return Err("原团队的访问凭据无效，请先重新连接原团队".into());
        }
        let expected = match identity.or_else(|| hosted_identity(&self.db_dir, &previous)) {
            Some(identity) => identity,
            None => self
                .request::<ConnectionIdentity>(&previous, Method::GET, "/v1/info", None)
                .await
                .map_err(|_| "请先同步原团队一次，或用原访问密钥连接 NAS 团队服务")?,
        };
        // The address is entered by the member. The normal endpoint policy and
        // no-redirect HTTP client also apply to this saved credential.
        let next = Connection {
            url,
            token: previous.token,
            allow_lan_http,
        };
        let snapshot: Snapshot = self
            .request(&next, Method::GET, "/v1/catalog/full", None)
            .await
            .map_err(|error| error.replace(&next.token, "[访问密钥]"))?;
        if ConnectionIdentity::new(&snapshot.team, &snapshot.member) != expected {
            return Err("该地址返回的团队或成员与原团队不一致，连接未切换".into());
        }
        self.save_connection(next, cache_from(snapshot)?)
    }

    pub(crate) fn begin_storage_operation(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        self.connecting
            .try_lock()
            .map_err(|_| "团队库正在处理其他操作，请稍候".into())
    }

    async fn checked_watched_target(
        &self,
        team_id: &str,
        library_id: &str,
        folder: Option<&str>,
    ) -> Result<(Connection, String, Option<PathBuf>), String> {
        let library_id = Uuid::parse_str(library_id)
            .map_err(|_| "团队库编号无效")?
            .to_string();
        if folder.is_some_and(|folder| {
            !folder.is_empty()
                && (relative_path(folder).is_none()
                    || folder.split('/').any(|part| part.starts_with('.')))
        }) {
            return Err("团队库目标文件夹无效".into());
        }
        let target = || {
            let data = self.data.lock().unwrap();
            watched_target(&data, team_id, &library_id, folder)
        };
        let (connection, identity, mount) = target()?;
        let active: ConnectionIdentity = self
            .request(&connection, Method::GET, "/v1/info", None)
            .await?;
        if active != identity || target()? != (connection.clone(), identity, mount.clone()) {
            return Err("团队连接或挂载目录已切换，请重新选择目标位置".into());
        }
        Ok((connection, library_id, mount))
    }

    async fn checked_write_target(
        &self,
        team_id: &str,
        library_id: &str,
        folder: &str,
    ) -> Result<(Connection, String, PathBuf), String> {
        let (connection, library_id, mount) = self
            .checked_watched_target(team_id, library_id, Some(folder))
            .await?;
        Ok((
            connection,
            library_id,
            mount.ok_or("请先为团队库设置本机挂载目录")?,
        ))
    }

    async fn refresh_watched_library(
        &self,
        connection: &Connection,
        library_id: &str,
    ) -> Result<Value, String> {
        self.request::<Value>(
            connection,
            Method::POST,
            &format!("/v1/libraries/{library_id}/refresh"),
            None,
        )
        .await
        .map_err(|error| {
            if error == format!("团队服务返回错误 {}", StatusCode::NOT_FOUND) {
                "当前 NAS 服务未开放立即重扫，目录会随下一次自动扫描同步".into()
            } else {
                error
            }
        })
    }

    async fn import_paths(
        &self,
        team_id: String,
        library_id: String,
        folder: String,
        paths: Vec<String>,
        progress: impl FnMut(usize) + Send + 'static,
    ) -> Result<Value, String> {
        if paths.is_empty() || paths.len() > MAX_FILES {
            return Err(format!("请选择 1 到 {MAX_FILES} 个文件或文件夹"));
        }
        let _operation = self.begin_storage_operation()?;
        let (connection, library_id, mount) = self
            .checked_write_target(&team_id, &library_id, &folder)
            .await?;
        if network_paths::folder_unc(&mount).is_none() {
            return Err("目标必须位于团队 NAS。团队成员看不到写入本地磁盘的素材。".into());
        }
        let indexed = {
            let data = self.data.lock().unwrap();
            let cached = data
                .cache
                .as_ref()
                .filter(|cache| cache.team.id == team_id)
                .ok_or("团队已切换，请重新选择目标位置")?;
            cached
                .catalog
                .assets
                .iter()
                .filter(|asset| asset.library_id == library_id)
                .map(|asset| (asset.relative_path.clone(), asset.size))
                .collect::<Vec<_>>()
        };
        let report = tauri::async_runtime::spawn_blocking(move || {
            crate::team_import::import_team_paths(&mount, &folder, paths, indexed, progress)
        })
        .await
        .map_err(|error| error.to_string())??;
        let index_error = if report.files.is_empty() && report.folders.is_empty() {
            None
        } else {
            self.refresh_watched_library(&connection, &library_id)
                .await
                .err()
        };
        let mut result = serde_json::to_value(report).map_err(|error| error.to_string())?;
        result["indexPending"] = json!(index_error.is_some());
        result["indexError"] = json!(index_error);
        Ok(result)
    }

    async fn refresh_library(&self, team_id: String, library_id: String) -> Result<Value, String> {
        let _operation = self.begin_storage_operation()?;
        let (connection, library_id, _) = self
            .checked_watched_target(&team_id, &library_id, None)
            .await?;
        self.refresh_watched_library(&connection, &library_id).await
    }

    async fn rescan_folder(
        &self,
        team_id: String,
        library_id: String,
        folder: String,
    ) -> Result<Value, String> {
        if !folder.is_empty()
            && (relative_path(&folder).is_none() || folder.split('/').any(|part| part.starts_with('.')))
        {
            return Err("团队库目标文件夹无效".into());
        }
        let _operation = self.begin_storage_operation()?;
        // Only the server reads NAS paths. The client needs no local mapping for a rescan.
        let (connection, library_id, _) =
            self.checked_watched_target(&team_id, &library_id, None).await?;
        let is_root = folder.is_empty();
        let body = serde_json::to_vec(&json!({ "folder": folder }))
            .map_err(|error| error.to_string())?;
        match self
            .request::<Value>(
                &connection,
                Method::POST,
                &format!("/v1/libraries/{library_id}/rescan-folder"),
                Some(body),
            )
            .await
        {
            Err(error) if error == format!("团队服务返回错误 {}", StatusCode::NOT_FOUND) => {
                if !is_root {
                    return Err("NAS 团队服务暂不支持按文件夹重新扫描，请更新服务版本".into());
                }
                // Older services can still rescan the single selected watched root.
                let report = self.refresh_watched_library(&connection, &library_id).await?;
                Ok(json!({ "revision": report["revision"], "errors": [] }))
            }
            result => result,
        }
    }

    pub(crate) async fn delete_workspace_folder(
        &self,
        state: crate::AppState,
        team_id: String,
        library_id: String,
        folder: String,
    ) -> Result<Value, String> {
        use crate::folder_deletion::{
            delete_indexed_directory, deletion_result, protected_data_roots,
        };

        let _operation = self.begin_storage_operation()?;
        let (connection, library_id, mount) = self
            .checked_write_target(&team_id, &library_id, &folder)
            .await?;
        let other_roots = {
            let data = self.data.lock().unwrap();
            let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
            if folder.is_empty() {
                if !cached.folder_visibility {
                    return Err("当前团队服务不能同步移除根目录，请保留磁盘目录".into());
                }
            } else if !cached.has_indexed_folder(&library_id, &folder) {
                return Err("只能删除当前团队资产库中已索引的文件夹".into());
            }
            data.effective_mounts(cached)
                .into_iter()
                .filter(|(id, _)| id != &library_id)
                .map(|(_, path)| PathBuf::from(path))
                .collect::<Vec<_>>()
        };
        let retirement = folder
            .is_empty()
            .then(|| {
                serde_json::to_vec(&SetFolderVisibility {
                    library_id: library_id.clone(),
                    folder: String::new(),
                    hidden: true,
                })
                .map_err(|error| error.to_string())
            })
            .transpose()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _workspace = crate::workspaces::lock_io(&state)?;
            delete_indexed_directory(
                &mount,
                &folder,
                &protected_data_roots(&state)?,
                &other_roots,
            )
        })
        .await
        .map_err(|error| error.to_string())??;
        let index_error = if let Some(body) = retirement {
            self.request::<Value>(
                &connection,
                Method::PATCH,
                "/v1/folder-visibility",
                Some(body),
            )
            .await
            .err()
            .map(|error| format!("磁盘目录已删除，请在团队库重试从资产库移除：{error}"))
        } else {
            self.refresh_watched_library(&connection, &library_id)
                .await
                .err()
        };
        Ok(deletion_result(index_error))
    }

    async fn move_workspace_folder(
        &self,
        state: crate::AppState,
        team_id: String,
        library_id: String,
        folder: String,
        target_folder: String,
        new_name: Option<String>,
    ) -> Result<Value, String> {
        use crate::folder_deletion::{inside_folder, protected_data_roots};

        let destination = crate::workspace_folder_move::folder_move_destination(
            &folder, &target_folder, new_name.as_deref(),
        )?;
        if inside_folder(&folder, &target_folder) {
            return Err("文件夹不能移动到自身或子目录".into());
        }
        let _operation = self.begin_storage_operation()?;
        let (connection, library_id, mount) = self
            .checked_write_target(&team_id, &library_id, &folder)
            .await?;
        let (target_connection, _, target_mount) = self
            .checked_write_target(&team_id, &library_id, &target_folder)
            .await?;
        if target_connection != connection || target_mount != mount {
            return Err("团队连接或挂载目录已切换，请重新选择".into());
        }
        let mut protected_roots =
            {
                let data = self.data.lock().unwrap();
                let (_, _, destination_mount) =
                    watched_target(&data, &team_id, &library_id, Some(&destination))?;
                if destination_mount.as_ref() != Some(&mount) {
                    return Err("团队库挂载目录已切换，请重新选择".into());
                }
                let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
                if !cached.has_indexed_folder(&library_id, &folder)
                    || !cached.has_indexed_folder(&library_id, &target_folder)
                {
                    return Err("只能在当前团队资产库中移动已索引的文件夹".into());
                }
                if cached.catalog.linked_folders.iter().any(|link| {
                    link.library_id == library_id && inside_folder(&folder, &link.folder)
                }) {
                    return Err("请先取消此文件夹或其子文件夹的独立链接，再移动原目录".into());
                }
                if cached.catalog.hidden_folders.iter().any(|hidden| {
                    hidden.library_id == library_id && inside_folder(&folder, &hidden.folder)
                }) {
                    return Err("此目录包含已从团队库移除的子文件夹，请恢复后再移动".into());
                }
                data.effective_mounts(cached)
                    .into_iter()
                    .filter(|(id, _)| id != &library_id)
                    .map(|(_, path)| PathBuf::from(path))
                    .collect::<Vec<_>>()
            };
        let old_folder = folder.clone();
        let folder = tauri::async_runtime::spawn_blocking(move || {
            let _workspace = crate::workspaces::lock_io(&state)?;
            protected_roots.extend(protected_data_roots(&state)?);
            crate::workspace_folder_move::move_shared_folder(
                &mount,
                &folder,
                &target_folder,
                new_name.as_deref(),
                &protected_roots,
            )
        })
        .await
        .map_err(|error| error.to_string())??;
        let index_error = self
            .refresh_watched_library(&connection, &library_id)
            .await
            .err();
        let quick_access_error = quick_access::relocate(self, &connection, &library_id, &old_folder, &folder)
            .await
            .err();
        Ok(json!({"folder":folder,"indexPending":index_error.is_some(),"indexError":index_error,
            "quickAccessError":quick_access_error}))
    }

    async fn online_members(&self) -> Result<Value, String> {
        let active = self.active_connection()?;
        let request =
            self.authenticated_request(&active.config, Method::POST, "/v1/presence", None);
        let response = Self::send(request).await?;
        let members = if response.status() == StatusCode::NOT_FOUND {
            Value::Null
        } else {
            Self::decode_response(response).await?
        };
        if self.active_connection()? != active {
            return Err("团队连接已切换，请重新获取在线成员".into());
        }
        Ok(members)
    }

    fn active_connection(&self) -> Result<ActiveConnection, String> {
        self.data.lock().unwrap().active_connection()
    }

    async fn profile_request<T: serde::de::DeserializeOwned>(
        &self,
        active: &ActiveConnection,
        method: Method,
        route: &str,
        body: Option<Vec<u8>>,
    ) -> Result<T, String> {
        let request = self.authenticated_request(&active.config, method, route, body);
        let mut response = Self::send(request).await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND && route == "/v1/profile" {
            return Err("团队服务暂不支持个人资料，请更新团队服务".into());
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_PROFILE_RESPONSE_BYTES as u64)
        {
            return Err("团队个人资料响应过大".into());
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "无法读取团队个人资料")?
        {
            if chunk.len() > MAX_PROFILE_RESPONSE_BYTES - data.len() {
                return Err("团队个人资料响应过大".into());
            }
            data.extend_from_slice(&chunk);
        }
        if self.active_connection()? != *active {
            return Err("团队连接已切换，请重新打开个人资料".into());
        }
        if !status.is_success() {
            let message = serde_json::from_slice::<Value>(&data)
                .ok()
                .and_then(|value| value["error"].as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("团队服务返回错误 {status}"));
            return Err(message);
        }
        serde_json::from_slice(&data).map_err(|_| "团队服务返回了无法读取的个人资料".into())
    }

    async fn profile(&self) -> Result<TeamProfile, String> {
        let active = self.active_connection()?;
        let profile: TeamProfile = self
            .profile_request(&active, Method::GET, "/v1/profile", None)
            .await?;
        profile.validate()?;
        Ok(profile)
    }

    async fn save_profile(
        &self,
        name: String,
        avatar_action: AvatarAction,
        avatar_url: Option<String>,
    ) -> Result<TeamProfile, String> {
        let name = name.trim();
        validate_profile_name(name)?;
        let avatar_url = match avatar_action {
            AvatarAction::Replace => {
                let avatar = avatar_url.ok_or("请选择新的头像图片")?;
                validate_profile_avatar(&avatar)?;
                Some(avatar)
            }
            AvatarAction::Keep | AvatarAction::Remove => None,
        };
        let payload = serde_json::to_vec(
            &json!({"name":name,"avatarAction":avatar_action,"avatarUrl":avatar_url}),
        )
        .map_err(|error| error.to_string())?;
        let _operation = self.begin_storage_operation()?;
        let active = self.active_connection()?;
        let identity: ConnectionIdentity = self
            .request(&active.config, Method::GET, "/v1/info", None)
            .await?;
        if identity != active.identity || self.active_connection()? != active {
            return Err("团队连接已切换，请重新打开个人资料".into());
        }
        let profile: TeamProfile = self
            .profile_request(&active, Method::PATCH, "/v1/profile", Some(payload))
            .await?;
        profile.validate()?;
        let mut data = self.data.lock().unwrap();
        if data.active_connection()? != active {
            return Err("团队连接已切换，请重新打开个人资料".into());
        }
        if let Some(cached) = &mut data.cache {
            cached.member.name.clone_from(&profile.name);
        }
        Ok(profile)
    }

    async fn member_avatar(&self, member_id: &str) -> Result<TeamMemberAvatar, String> {
        let member = Uuid::parse_str(member_id).map_err(|_| "团队成员编号无效")?;
        let active = self.active_connection()?;
        let route = format!("/v1/members/{member}/avatar");
        let avatar: TeamMemberAvatar = self
            .profile_request(&active, Method::GET, &route, None)
            .await?;
        if let Some(url) = &avatar.avatar_url {
            validate_profile_avatar(url)?;
        }
        Ok(avatar)
    }

    async fn create_folder(
        &self,
        team_id: String,
        library_id: String,
        folder: String,
        name: String,
    ) -> Result<Value, String> {
        let _operation = self.begin_storage_operation()?;
        let child = if folder.is_empty() {
            name.clone()
        } else {
            format!("{folder}/{name}")
        };
        let (connection, library_id, mount) = self
            .checked_write_target(&team_id, &library_id, &child)
            .await?;
        let created = tauri::async_runtime::spawn_blocking(move || {
            create_team_folder(&mount, &folder, &name)
        })
        .await
        .map_err(|error| error.to_string())??;
        let index_error = self
            .refresh_watched_library(&connection, &library_id)
            .await
            .err();
        Ok(json!({
            "folder": created,
            "indexPending": index_error.is_some(),
            "indexError": index_error,
        }))
    }

    pub fn local_asset(&self, id: &str) -> Result<Asset, String> {
        Ok(self.preview_asset(id)?.asset)
    }

    pub(crate) fn indexed_preview_asset(&self, id: &str) -> Result<IndexedTeamPreview, String> {
        let workspace = self.data.lock().unwrap();
        let cached = workspace.cache.as_ref().ok_or("没有本地团队索引")?;
        let asset = cached.asset(id).ok_or("团队资产不存在")?;
        let mut local = as_asset(asset, Some(&asset.relative_path), false);
        local.id = format!("team-{}", asset.id);
        let library = asset.storage_library_id.as_deref().unwrap_or(&asset.library_id);
        Ok(IndexedTeamPreview {
            asset: local,
            namespace: crate::team_covers::library_namespace(&cached.team.id, library),
            thumbnail_cache_root: workspace
                .prefs
                .thumbnail_cache_roots
                .get(&cached.team.id)
                .map(PathBuf::from),
        })
    }

    pub(crate) fn mounted_asset(&self, id: &str) -> Result<(SharedAsset, PathBuf, String), String> {
        let workspace = self.data.lock().unwrap();
        let cached = workspace.cache.as_ref().ok_or("请先连接团队并同步目录")?;
        let asset = cached.asset(id).ok_or("团队资产不存在")?;
        let root = workspace
            .resolved_mount(cached, &asset.library_id)
            .map(PathBuf::from)
            .filter(|root| root.is_absolute())
            .ok_or("请先为团队库设置本机挂载目录")?;
        Ok((asset.clone(), root, cached.team.id.clone()))
    }

    pub(crate) fn preview_asset(&self, id: &str) -> Result<TeamPreviewAsset, String> {
        let (asset, root, team_id) = self.mounted_asset(id)?;
        let source = mapped_file(&root, &asset.relative_path)?;
        let mut local = as_asset(&asset, Some(&clean_path(&source)), false);
        let canonical_root = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
        if asset.kind != "texture" {
            local.thumbnail = nexus_core::asset_thumbnail_candidates(&source)
                .into_iter()
                .filter_map(|p| std::fs::canonicalize(p).ok())
                .find(|p| p.starts_with(&canonical_root) && p.is_file())
                .map(|p| clean_path(&p));
        }
        // Keep the established cache file naming and DCC job IDs portable.
        local.id = format!("team-{}", asset.id);
        let thumbnail_cache_root = self
            .data
            .lock()
            .unwrap()
            .prefs
            .thumbnail_cache_roots
            .get(&team_id)
            .map(PathBuf::from);
        Ok(TeamPreviewAsset {
            asset: local,
            team_id,
            storage: TeamAssetStorage::for_asset(canonical_root, &asset),
            thumbnail_cache_root,
            relative_path: asset.relative_path,
        })
    }

    pub(crate) fn cover_mounts(&self) -> (String, Vec<TeamAssetStorage>) {
        let workspace = self.data.lock().unwrap();
        let Some(cached) = &workspace.cache else {
            return (String::new(), Vec::new());
        };
        let mounts: HashMap<_, _> = cached
            .catalog
            .libraries
            .iter()
            .filter_map(|library| {
                let root = PathBuf::from(workspace.resolved_mount(cached, &library.id)?);
                root.is_absolute().then_some((library.id.as_str(), root))
            })
            .collect();
        let mut locations: HashSet<_> = mounts
            .iter()
            .map(|(&library, mount)| TeamAssetStorage {
                mount: mount.clone(),
                library_id: library.to_owned(),
                folder: None,
            })
            .collect();
        let mut seen = HashSet::new();
        for asset in &cached.catalog.assets {
            let (Some(library_id), Some(folder)) =
                (&asset.storage_library_id, &asset.storage_folder)
            else {
                continue;
            };
            if !seen.insert((&asset.library_id, library_id, folder)) {
                continue;
            }
            if let Some(mount) = mounts.get(asset.library_id.as_str()) {
                if let Ok(location) = TeamAssetStorage::for_asset(mount.clone(), asset) {
                    locations.insert(location);
                }
            }
        }
        (cached.team.id.clone(), locations.into_iter().collect())
    }
}

fn hosted_identity(dir: &Path, connection: &Connection) -> Option<ConnectionIdentity> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HostedCredentials {
        team_id: Uuid,
        admin_id: Uuid,
        token: String,
    }
    #[derive(Deserialize)]
    struct HostedConfig {
        listen: std::net::SocketAddrV4,
        credentials: HostedCredentials,
    }
    let path = dir.join("hosted-team").join("host.json");
    let config: HostedConfig = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if connection.url != format!("http://{}", config.listen)
        || !valid_access_token(&config.credentials.token)
        || connection.token != config.credentials.token
    {
        return None;
    }
    Some(ConnectionIdentity {
        team_id: config.credentials.team_id.to_string(),
        member_id: config.credentials.admin_id.to_string(),
    })
}

fn endpoint(raw: &str, allow_lan_http: bool) -> Result<String, String> {
    let url = Url::parse(raw.trim())
        .map_err(|_| "请输入完整团队服务地址，例如 https://assets.example.com")?;
    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("团队地址只能包含协议、主机和端口".into());
    }
    if url.scheme() == "https" {
        return Ok(url.as_str().trim_end_matches('/').into());
    }
    if url.scheme() == "http" {
        let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
        if host == "localhost"
            || host.parse::<IpAddr>().is_ok_and(|ip| {
                ip.is_loopback()
                    || allow_lan_http
                        && match ip {
                            IpAddr::V4(v4) => v4.is_private(),
                            IpAddr::V6(v6) => v6.is_unique_local(),
                        }
            })
        {
            return Ok(url.as_str().trim_end_matches('/').into());
        }
    }
    Err("请使用 HTTPS。仅在受信任的私有网络中，才可勾选允许私网 HTTP 并填写私网 IP".into())
}

fn valid_access_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_profile_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err("昵称必须包含 1 至 200 个字符".into());
    }
    Ok(())
}

fn validate_profile_avatar(url: &str) -> Result<(), String> {
    let invalid = || "头像必须为 96×96 的 PNG 图片，且不超过 64 KiB".to_owned();
    let payload = url
        .strip_prefix(AVATAR_DATA_URL_PREFIX)
        .filter(|payload| payload.len() <= MAX_AVATAR_BYTES.div_ceil(3) * 4)
        .ok_or_else(invalid)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| invalid())?;
    const PNG_96_HEADER: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x60\0\0\0\x60";
    if bytes.len() < 33 || bytes.len() > MAX_AVATAR_BYTES || !bytes.starts_with(PNG_96_HEADER) {
        return Err(invalid());
    }
    Ok(())
}

fn enrollment_name(name: Option<&str>) -> Result<String, String> {
    match name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) if name.chars().count() > 200 || name.chars().any(char::is_control) => {
            Err("请输入 1 至 200 个字符的成员名称".into())
        }
        Some(name) => Ok(name.to_owned()),
        None => Ok(format!(
            "团队成员-{}",
            &Uuid::new_v4().simple().to_string()[..6]
        )),
    }
}

fn as_asset(shared: &SharedAsset, path: Option<&str>, favorite: bool) -> Asset {
    Asset {
        id: format!("team:{}", shared.id),
        name: shared.name.clone(),
        path: path.unwrap_or_default().to_owned(),
        ext: shared.ext.clone(),
        kind: shared.kind.clone(),
        size: shared.size,
        modified: json!(shared.modified),
        added: json!(shared.added),
        library_id: shared.library_id.clone(),
        tags: shared.tags.clone(),
        notes: shared.notes.clone(),
        rating: shared.rating,
        workflow: shared.workflow,
        favorite,
        favorite_at: None,
        thumbnail: None,
        demo: false,
        subtitle: None,
        color: None,
        vertices: None,
        faces: None,
    }
}

fn favorites_key(cached: &Cached) -> String {
    format!("{}:{}", cached.team.id, cached.member.id)
}

fn view(workspace: &Workspace, include_assets: bool) -> Result<Value, String> {
    let cached = workspace.cache.as_ref().ok_or("没有已同步的团队目录")?;
    let mounts = workspace.effective_mounts(cached);
    let manual_mounts = workspace.prefs.mounts.get(&cached.team.id);
    let favorites = workspace.prefs.favorites.get(&favorites_key(cached));
    let library_view = |lib: &Library| {
        let manual = manual_mounts.and_then(|m| m.get(&lib.id));
        let path = mounts.get(&lib.id).or(manual);
        let folders = cached.catalog.visible_folders.get(&lib.id);
        json!({"id":lib.id,"name":lib.name,"path":path,"source":"team","watching":lib.watching,"folders":folders,
            "autoMounted":workspace.automatic_mount(cached, &lib.id).is_some()})
    };
    let libraries: Vec<_> = cached.catalog.libraries.iter().map(&library_view).collect();
    let all_libraries: Vec<_> = cached.all_libraries().iter().map(library_view).collect();
    let assets = include_assets.then(|| {
        cached
            .catalog
            .assets
            .iter()
            .map(|asset| {
                let path = mounts
                    .get(&asset.library_id)
                    .zip(relative_path(&asset.relative_path))
                    .map(|(root, p)| clean_path(&Path::new(root).join(p)));
                let favorite = favorites.is_some_and(|f| f.contains(&asset.id));
                let mut value = json!(as_asset(asset, path.as_deref(), favorite));
                value["relativePath"] = json!(asset.relative_path);
                value["teamMounted"] = json!(path.is_some());
                value["revision"] = json!(asset.revision);
                value["editedBy"] = json!(asset.edited_by);
                value
            })
            .collect::<Vec<_>>()
    });
    Ok(json!({
        "team":cached.team,"member":cached.member,"revision":cached.revision,
        "libraries":libraries,"assets":assets,"allLibraries":all_libraries,
        "thumbnailCacheRoot":workspace.prefs.thumbnail_cache_roots.get(&cached.team.id),
        "folderVisibility":cached.folder_visibility,"hiddenFolders":cached.catalog.hidden_folders,
        "linkedFolders":cached.catalog.linked_folders,"definedTags":cached.catalog.defined_tags
    }))
}

fn folder_visibility_allowed(snapshot: &Snapshot) -> bool {
    snapshot.folder_visibility
        && (snapshot.member_folder_visibility || snapshot.member.role == "admin")
}

fn cache_from(snapshot: Snapshot) -> Result<Cached, String> {
    let folder_visibility = folder_visibility_allowed(&snapshot);
    let catalog = snapshot.catalog.ok_or("团队服务没有返回完整目录")?;
    let mut cached = Cached {
        team: snapshot.team,
        member: snapshot.member,
        revision: snapshot.revision,
        catalog,
        asset_indices: HashMap::new(),
        folder_visibility,
    };
    cached.build_asset_indices();
    Ok(cached)
}

fn watched_target(
    data: &Workspace,
    team_id: &str,
    library_id: &str,
    folder: Option<&str>,
) -> Result<(Connection, ConnectionIdentity, Option<PathBuf>), String> {
    let config = data.prefs.connection.clone().ok_or("请先连接团队")?;
    let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
    if cached.team.id != team_id {
        return Err("团队已切换，请重新选择目标位置".into());
    }
    let library = cached
        .catalog
        .libraries
        .iter()
        .find(|library| library.id == library_id)
        .ok_or("请选择可见的团队资产库")?;
    if !library.watching {
        return Err("此团队库尚未启用 NAS 自动索引，请先配置团队库扫描".into());
    }
    let has_hidden_ancestor = cached.catalog.hidden_folders.iter().any(|hidden| {
        if hidden.library_id != library_id {
            return false;
        }
        if hidden.folder.is_empty() {
            return true;
        }
        let Some(folder) = folder else {
            return false;
        };
        let matches = |path: &str, ancestor: &str| {
            path == ancestor
                || path
                    .strip_prefix(ancestor)
                    .is_some_and(|tail| tail.starts_with('/'))
        };
        if cfg!(windows) {
            matches(&folder.to_lowercase(), &hidden.folder.to_lowercase())
        } else {
            matches(folder, &hidden.folder)
        }
    });
    if has_hidden_ancestor {
        return Err("团队库目标文件夹已移除，请重新选择".into());
    }
    let mount = folder
        .map(|_| {
            data.resolved_mount(cached, library_id)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or("请先为团队库设置本机挂载目录")
        })
        .transpose()?;
    Ok((
        config,
        ConnectionIdentity::new(&cached.team, &cached.member),
        mount,
    ))
}

#[tauri::command]
pub fn team_status(state: tauri::State<'_, Desktop>) -> Value {
    let data = state.data.lock().unwrap();
    match &data.prefs.connection {
        Some(config) => {
            let thumbnail_cache_root = data
                .cache
                .as_ref()
                .and_then(|cached| data.prefs.thumbnail_cache_roots.get(&cached.team.id));
            json!({
                "configured":true, "url":config.url,"allowLanHttp":config.allow_lan_http,
                "thumbnailCacheRoot":thumbnail_cache_root
            })
        }
        None => json!({"configured":false}),
    }
}

#[tauri::command]
pub async fn team_service_info(
    state: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<Value, String> {
    let active = state.connection_for_team(&team_id)?;
    let info: TeamServiceInfo = state
        .request(&active.config, Method::GET, "/v1/info", None)
        .await?;
    if info.identity != active.identity || state.active_connection()? != active {
        return Err("团队连接已切换，请重新获取服务信息".into());
    }
    Ok(json!({"serverVersion": info.server_version}))
}

#[tauri::command]
pub async fn team_online_members(state: tauri::State<'_, Desktop>) -> Result<Value, String> {
    state.online_members().await
}

#[tauri::command]
pub async fn team_get_profile(state: tauri::State<'_, Desktop>) -> Result<TeamProfile, String> {
    state.profile().await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamNameUpdate {
    team: Team,
    previous_revision: u64,
    revision: u64,
}

#[tauri::command]
pub async fn team_rename_workspace(
    state: tauri::State<'_, Desktop>,
    team_id: String,
    name: String,
) -> Result<Team, String> {
    let active = state.connection_for_team(&team_id)?;
    let payload = serde_json::to_vec(&json!({"teamId":team_id,"name":name}))
        .map_err(|error| error.to_string())?;
    let request = state.authenticated_request(
        &active.config,
        Method::PATCH,
        "/v1/team/name",
        Some(payload),
    );
    let response = Desktop::send(request).await?;
    if matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED) {
        return Err("当前团队服务不支持重命名团队库，请先更新团队服务。".into());
    }
    let result: TeamNameUpdate = Desktop::decode_response(response).await?;
    if result.team.id != active.identity.team_id {
        return Err("团队已切换，请重新打开工作空间".into());
    }
    let mut data = state.data.lock().unwrap();
    if data.active_connection()? != active {
        return Err("团队已切换，请重新打开工作空间".into());
    }
    let cached = data.cache.as_mut().ok_or("请先同步团队目录")?;
    if cached.revision > result.revision {
        return Ok(cached.team.clone());
    }
    let changed = cached.team.name != result.team.name;
    cached.team = result.team;
    // A name-only change can advance the local catalog if no other update was missed.
    if cached.revision == result.previous_revision {
        cached.revision = result.revision;
    }
    let team = cached.team.clone();
    if changed {
        let _ = state.persist_local_catalog(&data);
    }
    Ok(team)
}

#[tauri::command]
pub async fn team_save_profile(
    state: tauri::State<'_, Desktop>,
    name: String,
    avatar_action: AvatarAction,
    avatar_url: Option<String>,
) -> Result<TeamProfile, String> {
    state.save_profile(name, avatar_action, avatar_url).await
}

#[tauri::command]
pub async fn team_member_avatar(
    state: tauri::State<'_, Desktop>,
    member_id: String,
) -> Result<TeamMemberAvatar, String> {
    state.member_avatar(&member_id).await
}

#[tauri::command]
pub async fn team_create_tag(
    state: tauri::State<'_, Desktop>,
    name: String,
) -> Result<Value, String> {
    let name = validated_tag_name(&name)?;
    mutate_team_tag(&state, Method::POST, json!({"name":name})).await
}

#[tauri::command]
pub async fn team_rename_tag(
    state: tauri::State<'_, Desktop>,
    name: String,
    new_name: String,
) -> Result<Value, String> {
    let name = validated_tag_name(&name)?;
    let new_name = validated_tag_name(&new_name)?;
    mutate_team_tag(
        &state,
        Method::PATCH,
        json!({"name":name,"newName":new_name}),
    )
    .await
}

#[tauri::command]
pub async fn team_delete_tag(
    state: tauri::State<'_, Desktop>,
    name: String,
) -> Result<Value, String> {
    let name = validated_tag_name(&name)?;
    mutate_team_tag(&state, Method::DELETE, json!({"name":name})).await
}

fn validated_tag_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 || name.chars().any(char::is_control) {
        return Err("标签名称需包含 1 至 40 个字符".into());
    }
    Ok(name)
}

async fn mutate_team_tag(state: &Desktop, method: Method, payload: Value) -> Result<Value, String> {
    let _operation = state.begin_storage_operation()?;
    let active = state.active_connection()?;
    let identity: ConnectionIdentity = state
        .request(&active.config, Method::GET, "/v1/info", None)
        .await?;
    if identity != active.identity || state.active_connection()? != active {
        return Err("团队连接已切换，请重新选择标签".into());
    }
    let body = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    state
        .request(&active.config, method, "/v1/tags", Some(body))
        .await
        .map_err(|error| {
            if error == format!("团队服务返回错误 {}", StatusCode::NOT_FOUND) {
                "当前团队服务暂不支持管理标签，请更新团队服务".into()
            } else {
                error
            }
        })
}

#[tauri::command]
pub async fn team_connect(
    state: tauri::State<'_, Desktop>,
    url: String,
    token: String,
    allow_lan_http: bool,
) -> Result<Value, String> {
    let _connection = state
        .connecting
        .try_lock()
        .map_err(|_| "正在连接团队，请稍候")?;
    let token = token.trim();
    if !valid_access_token(token) {
        return Err("请输入团队管理员提供的 64 位访问密钥".into());
    }
    let config = Connection {
        url: endpoint(&url, allow_lan_http)?,
        token: token.into(),
        allow_lan_http,
    };
    state.connect(config).await
}

#[tauri::command]
pub async fn team_join_by_address(
    state: tauri::State<'_, Desktop>,
    url: String,
    name: Option<String>,
    allow_lan_http: bool,
) -> Result<Value, String> {
    let _connection = state
        .connecting
        .try_lock()
        .map_err(|_| "正在连接团队，请稍候")?;
    let url = endpoint(&url, allow_lan_http)?;
    state.join(url, name, allow_lan_http).await
}

#[tauri::command]
pub async fn team_reconnect_nas(
    state: tauri::State<'_, Desktop>,
    url: String,
    allow_lan_http: bool,
) -> Result<Value, String> {
    let _connection = state
        .connecting
        .try_lock()
        .map_err(|_| "正在连接团队，请稍候")?;
    let url = endpoint(&url, allow_lan_http)?;
    state.reconnect_nas(url, allow_lan_http).await
}

#[tauri::command]
pub fn team_disconnect(state: tauri::State<'_, Desktop>) -> Result<(), String> {
    let _connection = state
        .connecting
        .try_lock()
        .map_err(|_| "正在连接团队，请稍候")?;
    let mut data = state.data.lock().unwrap();
    let mut prefs = data.prefs.clone();
    prefs.connection = None;
    prefs.connection_identity = None;
    state.save(&prefs)?;
    data.prefs = prefs;
    data.cache = None;
    data.pending_join = None;
    data.connection_generation = data.connection_generation.wrapping_add(1);
    let _ = std::fs::remove_file(state.local_catalog_path());
    Ok(())
}

#[tauri::command]
pub async fn team_cached_catalog(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Desktop>().cached_catalog())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn team_catalog(
    state: tauri::State<'_, Desktop>,
    since: Option<u64>,
) -> Result<Value, String> {
    state.synchronize_catalog(since).await
}

#[tauri::command]
pub async fn team_set_folder_visibility(
    state: tauri::State<'_, Desktop>,
    library_id: String,
    folder: String,
    hidden: bool,
) -> Result<Value, String> {
    let _connection = state
        .connecting
        .try_lock()
        .map_err(|_| "正在连接团队，请稍候")?;
    {
        let data = state.data.lock().unwrap();
        let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
        if !cached.folder_visibility {
            return Err("请更新团队服务以同步文件夹的移除和恢复".into());
        }
        if !cached
            .all_libraries()
            .iter()
            .any(|lib| lib.id == library_id)
        {
            return Err("团队库不存在".into());
        }
    }
    let config = state.connection()?;
    let body = serde_json::to_vec(&SetFolderVisibility {
        library_id,
        folder,
        hidden,
    })
    .map_err(|e| e.to_string())?;
    state
        .request(&config, Method::PATCH, "/v1/folder-visibility", Some(body))
        .await
}

#[tauri::command]
pub async fn team_set_mount(
    state: tauri::State<'_, Desktop>,
    library_id: String,
    path: String,
) -> Result<Value, String> {
    let state = state.inner();
    let _operation = state.begin_storage_operation()?;
    let root = tauri::async_runtime::spawn_blocking(move || mount_root(&path))
        .await
        .map_err(|e| e.to_string())??;
    let mut data = state.data.lock().unwrap();
    let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
    if !cached
        .all_libraries()
        .iter()
        .any(|lib| lib.id == library_id)
    {
        return Err("团队库不存在".into());
    }
    let mut prefs = data.prefs.clone();
    prefs
        .mounts
        .entry(cached.team.id.clone())
        .or_default()
        .insert(library_id, clean_path(&root));
    state.save(&prefs)?;
    data.prefs = prefs;
    view(&data, true)
}

#[tauri::command]
pub async fn team_set_thumbnail_cache_root(
    state: tauri::State<'_, Desktop>,
    team_id: String,
    path: Option<String>,
) -> Result<Value, String> {
    let state = state.inner();
    let _operation = state.begin_storage_operation()?;
    let active = state.connection_for_team(&team_id)?;
    let root = if let Some(path) = path {
        Some(
            tauri::async_runtime::spawn_blocking(move || mount_root(&path))
                .await
                .map_err(|error| error.to_string())??,
        )
    } else {
        None
    };
    let mut data = state.data.lock().unwrap();
    if data.active_connection()? != active {
        return Err("团队工作空间已切换，请重新选择缩略图缓存目录".into());
    }
    let mut prefs = data.prefs.clone();
    if let Some(root) = root {
        prefs.thumbnail_cache_roots.insert(team_id, clean_path(&root));
    } else {
        prefs.thumbnail_cache_roots.remove(&team_id);
    }
    state.save(&prefs)?;
    data.prefs = prefs;
    view(&data, false)
}

#[tauri::command]
pub async fn team_link_folders(
    state: tauri::State<'_, Desktop>,
    paths: Vec<String>,
) -> Result<Value, String> {
    serde_json::to_value(state.link_folders(paths).await?).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn classify_team_drop(paths: Vec<String>) -> Result<Value, String> {
    if paths.len() > MAX_FILES {
        return Err(format!("单次最多处理 {MAX_FILES} 个文件或文件夹"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut selection = crate::team_import::classify_team_drop_paths(paths);
        selection.local_paths = selection.files.iter().chain(&selection.folders)
            .filter(|path| network_paths::folder_unc(Path::new(path)).is_none())
            .cloned()
            .collect();
        serde_json::to_value(selection).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn team_import_paths(
    app: tauri::AppHandle,
    state: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: String,
    folder: String,
    paths: Vec<String>,
) -> Result<Value, String> {
    state
        .import_paths(team_id, library_id, folder, paths, move |count| {
            let _ = app.emit("team-import-progress", count);
        })
        .await
}

#[tauri::command]
pub async fn team_unlink_folder(
    state: tauri::State<'_, Desktop>,
    library_id: String,
    folder: String,
) -> Result<Value, String> {
    state.unlink_folder(library_id, folder).await
}

#[tauri::command]
pub async fn team_create_folder(
    state: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: String,
    folder: String,
    name: String,
) -> Result<Value, String> {
    state.create_folder(team_id, library_id, folder, name).await
}

#[tauri::command]
pub async fn team_move_folder(
    app_state: tauri::State<'_, crate::AppState>,
    state: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: String,
    folder: String,
    target_folder: String,
    new_name: Option<String>,
) -> Result<Value, String> {
    state
        .move_workspace_folder(
            app_state.inner().clone(),
            team_id,
            library_id,
            folder,
            target_folder,
            new_name,
        )
        .await
}

#[tauri::command]
pub async fn team_refresh_library(
    state: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: String,
) -> Result<Value, String> {
    state.refresh_library(team_id, library_id).await
}

#[tauri::command]
pub async fn team_rescan_folder(
    state: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: String,
    folder: String,
) -> Result<Value, String> {
    state.rescan_folder(team_id, library_id, folder).await
}

fn mount_root(path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if !input.is_absolute() {
        return Err("请输入本机可访问的完整文件夹路径".into());
    }
    let root = std::fs::canonicalize(input).map_err(|_| "无法访问此文件夹，请检查盘符和挂载")?;
    if !root.is_dir() {
        return Err("请选择文件夹".into());
    }
    Ok(root)
}

fn collect_files(
    db_dir: &Path,
    root: &Path,
    progress: impl FnMut(usize),
) -> Result<(Vec<PublishedFile>, usize), String> {
    let local = Catalog::open(db_dir)?;
    let original: HashMap<String, Asset> = local
        .assets()?
        .into_iter()
        .filter(|asset| !asset.demo)
        .map(|asset| (asset.path.clone(), asset))
        .collect();
    let (mut files, skipped) = scan_team_files(root, progress)?;
    for file in &mut files {
        if let Some(relative) = relative_path(&file.relative_path) {
            if let Some(asset) = original.get(&clean_path(&root.join(relative))) {
                file.name = asset.name.clone();
                file.tags = asset.tags.clone();
                file.notes = asset.notes.clone();
            }
        }
    }
    Ok((files, skipped))
}
#[tauri::command]
pub async fn team_publish(
    app: tauri::AppHandle,
    state: tauri::State<'_, Desktop>,
    library_id: String,
    name: String,
    path: String,
) -> Result<Value, String> {
    let _operation = state.begin_storage_operation()?;
    let config = state.connection()?;
    let team_id = {
        let data = state.data.lock().unwrap();
        let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
        if cached.member.role != "admin" {
            return Err("只有管理员可以发布团队库".into());
        }
        cached.team.id.clone()
    };
    let db_dir = state.db_dir.clone();
    let id = Uuid::parse_str(&library_id)
        .map_err(|_| "团队库编号无效")?
        .to_string();
    let publish_id = id.clone();
    let (body, root, skipped) = tauri::async_runtime::spawn_blocking(move || {
        let root = mount_root(&path)?;
        let (files, skipped) = collect_files(&db_dir, &root, |count| {
            let _ = app.emit("team-scan-progress", count);
        })?;
        let payload = Publish {
            library: Library {
                id: publish_id,
                name,
                watching: false,
            },
            files,
            complete: skipped == 0,
        };
        let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        if body.len() > MAX_PUBLISH_BYTES {
            return Err("资产索引大于单次发布上限，请把大目录分成多个团队库".into());
        }
        Ok::<_, String>((body, root, skipped))
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut result: Value = state
        .request(&config, Method::POST, "/v1/publish", Some(body))
        .await?;
    let mut data = state.data.lock().unwrap();
    if data.prefs.connection.as_ref() != Some(&config) {
        return Err("团队连接已切换，请刷新团队目录".into());
    }
    let mut prefs = data.prefs.clone();
    prefs
        .mounts
        .entry(team_id)
        .or_default()
        .insert(id, clean_path(&root));
    state.save(&prefs)?;
    data.prefs = prefs;
    result["skipped"] = json!(skipped);
    Ok(result)
}

#[tauri::command]
pub async fn team_edit(
    state: tauri::State<'_, Desktop>,
    id: String,
    patch: MetadataPatch,
) -> Result<SharedAsset, String> {
    let config = state.connection()?;
    let id = id
        .strip_prefix("team:")
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or("团队资产编号无效")?;
    let body = serde_json::to_vec(&patch).map_err(|e| e.to_string())?;
    let asset: SharedAsset = state
        .request(
            &config,
            Method::PATCH,
            &format!("/v1/assets/{id}"),
            Some(body),
        )
        .await?;
    let mut data = state.data.lock().unwrap();
    if data.prefs.connection.as_ref() == Some(&config) {
        if let Some(current) = data
            .cache
            .as_mut()
            .and_then(|cached| cached.catalog.assets.iter_mut().find(|a| a.id == asset.id))
        {
            if current.revision <= asset.revision {
                *current = asset.clone();
            }
        }
    }
    Ok(asset)
}

#[tauri::command]
pub fn team_favorite(
    state: tauri::State<'_, Desktop>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    let mut data = state.data.lock().unwrap();
    let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
    let id = id.strip_prefix("team:").ok_or("团队资产编号无效")?;
    if !cached.catalog.assets.iter().any(|a| a.id == id) {
        return Err("团队资产不存在".into());
    }
    let mut prefs = data.prefs.clone();
    let set = prefs.favorites.entry(favorites_key(cached)).or_default();
    if favorite {
        set.insert(id.to_owned());
    } else {
        set.remove(id);
    }
    state.save(&prefs)?;
    data.prefs = prefs;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::HeaderMap,
        routing::{get, patch, post},
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    fn index_snapshot(team: &str, complete: bool) -> Snapshot {
        serde_json::from_value(json!({
            "team":{"id":team,"name":"共享团队"},"member":{"id":"member","name":"成员","role":"member"},"revision":7,
            "catalog":complete.then(|| json!({
                "libraries":[{"id":"lib","name":"素材","watching":true}],
                "assets":[{"id":"asset","libraryId":"lib","relativePath":"Scenes/example.obj","name":"example",
                    "ext":"obj","kind":"model","size":1,"modified":2,"added":3,"tags":[],"notes":"","revision":4,"editedBy":"成员"}],
                "visibleFolders":{"lib":["Scenes","Empty"]}
            }))
        })).unwrap()
    }

    #[test]
    fn thumbnail_desktop_mounted_scene_resolves_its_sibling_jpg() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("index")).unwrap();
        let desktop = Desktop::new(&catalog).unwrap();
        let mount = scratch.path().join("mounted");
        std::fs::create_dir_all(mount.join("Scenes")).unwrap();
        let scene = mount.join("Scenes/现代别墅C-TX.max");
        let cover = scene.with_extension("jpg");
        std::fs::write(&scene, b"fixture scene").unwrap();
        std::fs::write(&cover, b"fixture cover").unwrap();

        let mut snapshot = index_snapshot("team", true);
        let asset = &mut snapshot.catalog.as_mut().unwrap().assets[0];
        asset.relative_path = "Scenes/现代别墅C-TX.max".into();
        asset.ext = "max".into();
        asset.kind = "scene".into();
        desktop.save_connection(
            Connection {url:"http://127.0.0.1:1".into(),token:"ab".repeat(32),allow_lan_http:false},
            cache_from(snapshot).unwrap(),
        ).unwrap();
        desktop.data.lock().unwrap().prefs.mounts.insert(
            "team".into(), HashMap::from([("lib".into(), clean_path(&mount))]),
        );

        let preview = desktop.preview_asset("asset").unwrap();
        assert_eq!(preview.asset.path, clean_path(&std::fs::canonicalize(&scene).unwrap()));
        assert_eq!(preview.asset.thumbnail, Some(clean_path(&std::fs::canonicalize(&cover).unwrap())));
        assert!(!mount.join(".nexus").exists());
    }

    #[test]
    fn local_team_index_is_reused_offline_for_the_same_connection_only() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(scratch.path()).unwrap();
        let desktop = Desktop::new(&catalog).unwrap();
        let token = "ab".repeat(32);
        let config = Connection {url:"http://127.0.0.1:1".into(),token:token.clone(),allow_lan_http:false};
        assert!(desktop.cached_catalog().unwrap().is_none());
        desktop.save_connection(config, cache_from(index_snapshot("original", true)).unwrap()).unwrap();
        let stored = std::fs::read_to_string(desktop.local_catalog_path()).unwrap();
        assert!(!stored.contains(&token));

        let reopened = Desktop::new(&catalog).unwrap();
        assert!(reopened.data.lock().unwrap().cache.is_none());
        let view = reopened.cached_catalog().unwrap().unwrap();
        assert_eq!(view["revision"], 7);
        assert_eq!(view["libraries"][0]["folders"], json!(["Scenes", "Empty"]));
        assert_eq!(view["assets"][0]["relativePath"], "Scenes/example.obj");
        assert!(reopened.data.lock().unwrap().cache.as_ref().unwrap().asset("asset").is_some());

        let mut settings = reopened.data.lock().unwrap().prefs.clone();
        settings.connection.as_mut().unwrap().token = "cd".repeat(32);
        reopened.save(&settings).unwrap();
        assert!(Desktop::new(&catalog).unwrap().cached_catalog().unwrap().is_none());
        settings.connection.as_mut().unwrap().token = token;
        reopened.save(&settings).unwrap();
        std::fs::write(desktop.local_catalog_path(), "incomplete").unwrap();
        assert!(Desktop::new(&catalog).unwrap().cached_catalog().unwrap().is_none());
    }

    #[test]
    fn local_team_index_is_replaced_even_when_the_new_team_has_the_same_revision() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let scratch = tempfile::tempdir().unwrap();
            let catalog = Catalog::open(scratch.path()).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let app = Router::new()
                .route("/v1/catalog/7", get(|| async { Json(index_snapshot("replacement", false)) }))
                .route("/v1/catalog/full", get(|| async { Json(index_snapshot("replacement", true)) }));
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let desktop = Desktop::new(&catalog).unwrap();
            desktop.save_connection(Connection {url,token:"ab".repeat(32),allow_lan_http:false},
                cache_from(index_snapshot("original", true)).unwrap()).unwrap();

            let reopened = Desktop::new(&catalog).unwrap();
            assert_eq!(reopened.cached_catalog().unwrap().unwrap()["team"]["id"], "original");
            let result = reopened.synchronize_catalog(Some(7)).await.unwrap();
            assert_eq!(result["team"]["id"], "replacement");
            assert_eq!(result["assets"][0]["id"], "team:asset");
            assert_eq!(Desktop::new(&catalog).unwrap().cached_catalog().unwrap().unwrap()["team"]["id"], "replacement");
        });
    }

    #[test]
    fn team_folder_move_uses_existing_watch_and_preserves_a_completed_move_when_index_is_pending() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("app");
            let catalog = Catalog::open(&root).unwrap();
            let desktop = Desktop::new(&catalog).unwrap();
            let state = crate::AppState {
                db: Arc::new(Mutex::new(catalog)), root, workspace_io: Arc::new(Mutex::new(())),
                placement: Default::default(), sessions: Default::default(), token: String::new(), port: 0,
            };
            let library = Uuid::new_v4().to_string();
            let mount = temp.path().join("share");
            for folder in ["模型", "项目", "独立链接", "隐含/子文件夹", "未索引"] {
                std::fs::create_dir_all(mount.join(folder)).unwrap();
            }
            let asset = mount.join("模型/asset.obj");
            let moved = mount.join("项目/模型/asset.obj");
            std::fs::write(&asset, "v 0 0 0").unwrap();
            let refresh_count = Arc::new(AtomicUsize::new(0));
            let app = Router::new()
                .route("/v1/info", get(|| async { Json(json!({"teamId":"team","memberId":"member"})) }))
                .route(&format!("/v1/libraries/{library}/refresh"), post({
                    let refresh_count = Arc::clone(&refresh_count);
                    let expected = moved.clone();
                    move || {
                        assert!(expected.is_file());
                        refresh_count.fetch_add(1, Ordering::SeqCst);
                        async { StatusCode::NOT_FOUND }
                    }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let snapshot = serde_json::from_value(json!({
                "team":{"id":"team","name":"团队"},"member":{"id":"member","name":"成员","role":"member"},"revision":1,
                "catalog":{"libraries":[{"id":library,"name":"共享","watching":true}],"assets":[],
                    "visibleFolders":{(library.clone()):["模型","项目","独立链接","隐含"]},
                    "linkedFolders":[{"libraryId":library,"folder":"独立链接"}],
                    "hiddenFolders":[{"libraryId":library,"folder":"隐含/子文件夹"}]}
            })).unwrap();
            desktop.save_connection(Connection {url, token:"ab".repeat(32), allow_lan_http:false},cache_from(snapshot).unwrap()).unwrap();
            desktop.data.lock().unwrap().prefs.mounts.insert("team".into(), HashMap::from([(library.clone(),clean_path(&mount))]));
            let move_folder = |source: &str, target: &str| desktop.move_workspace_folder(state.clone(),"team".into(),library.clone(),source.into(),target.into(),None);
            assert!(move_folder("", "项目").await.is_err());
            assert!(move_folder("模型", "模型").await.is_err());
            assert!(move_folder("模型", "未索引").await.is_err());
            assert!(move_folder("独立链接", "项目").await.is_err());
            assert!(move_folder("隐含", "项目").await.is_err());
            assert!(asset.is_file());
            assert!(!moved.exists());
            assert_eq!(refresh_count.load(Ordering::SeqCst), 0);
            let result = move_folder("模型", "项目").await.unwrap();
            assert_eq!(result["folder"], "项目/模型");
            assert_eq!(result["indexPending"], true);
            assert!(result["indexError"].is_string());
            assert!(!asset.exists());
            assert_eq!(std::fs::read_to_string(moved).unwrap(), "v 0 0 0");
            assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn profiles_share_a_valid_avatar_and_reject_writes_to_a_different_team() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let catalog = Catalog::open(temp.path()).unwrap();
            let desktop = Desktop::new(&catalog).unwrap();
            let member = Uuid::new_v4().to_string();
            let token = "ab".repeat(32);
            let bearer = format!("Bearer {token}");
            let same_team = Arc::new(AtomicBool::new(true));
            let server_profile = Arc::new(Mutex::new(json!({"name":"成员","avatarUrl":null})));
            let mut image = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgba8(96, 96)
                .write_to(&mut image, image::ImageFormat::Png)
                .unwrap();
            let avatar_url = format!(
                "{AVATAR_DATA_URL_PREFIX}{}",
                base64::engine::general_purpose::STANDARD.encode(image.into_inner())
            );
            let app = Router::new()
                .route(
                    "/v1/info",
                    get({
                        let same_team = Arc::clone(&same_team);
                        let member = member.clone();
                        move || {
                            let team = if same_team.load(Ordering::Acquire) {
                                "team"
                            } else {
                                "other"
                            };
                            let member = member.clone();
                            async move { Json(json!({"teamId":team,"memberId":member})) }
                        }
                    }),
                )
                .route(
                    "/v1/profile",
                    get({
                        let server_profile = Arc::clone(&server_profile);
                        move || {
                            let profile = server_profile.lock().unwrap().clone();
                            async move { Json(profile) }
                        }
                    })
                    .patch({
                        let server_profile = Arc::clone(&server_profile);
                        move |headers: HeaderMap, Json(body): Json<Value>| {
                            assert_eq!(headers["authorization"].to_str().unwrap(), bearer);
                            let profile = {
                                let mut profile = server_profile.lock().unwrap();
                                profile["name"] = body["name"].clone();
                                if body["avatarAction"] != "keep" {
                                    profile["avatarUrl"] = body["avatarUrl"].clone();
                                }
                                profile.clone()
                            };
                            async move { Json(profile) }
                        }
                    }),
                )
                .route(
                    &format!("/v1/members/{member}/avatar"),
                    get({
                        let server_profile = Arc::clone(&server_profile);
                        move || {
                            let value = server_profile.lock().unwrap()["avatarUrl"].clone();
                            async move { Json(json!({"avatarUrl":value})) }
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let snapshot = serde_json::from_value(json!({
                "team":{"id":"team","name":"团队"},
                "member":{"id":member,"name":"成员","role":"member"},
                "revision":1,"catalog":{"libraries":[],"assets":[]}
            }))
            .unwrap();
            desktop
                .save_connection(
                    Connection {
                        url,
                        token,
                        allow_lan_http: false,
                    },
                    cache_from(snapshot).unwrap(),
                )
                .unwrap();
            assert_eq!(desktop.profile().await.unwrap().name, "成员");
            assert!(desktop.member_avatar("../profile").await.is_err());
            assert!(desktop
                .save_profile(
                    "成员".into(),
                    AvatarAction::Replace,
                    Some("data:image/svg+xml;base64,cG5n".into())
                )
                .await
                .is_err());
            let saved = desktop
                .save_profile(
                    "  新昵称  ".into(),
                    AvatarAction::Replace,
                    Some(avatar_url.clone()),
                )
                .await
                .unwrap();
            assert_eq!(saved.name, "新昵称");
            assert_eq!(
                desktop.member_avatar(&member).await.unwrap().avatar_url,
                Some(avatar_url)
            );
            assert_eq!(
                desktop
                    .data
                    .lock()
                    .unwrap()
                    .cache
                    .as_ref()
                    .unwrap()
                    .member
                    .name,
                "新昵称"
            );
            same_team.store(false, Ordering::Release);
            assert!(desktop
                .save_profile("错误团队".into(), AvatarAction::Remove, None)
                .await
                .is_err());
            assert_eq!(server_profile.lock().unwrap()["name"], "新昵称");
            same_team.store(true, Ordering::Release);
            assert!(desktop
                .save_profile("新昵称".into(), AvatarAction::Remove, None)
                .await
                .unwrap()
                .avatar_url
                .is_none());
        });
    }

    #[test]
    fn team_folder_deletion_refreshes_subfolders_and_retires_a_safe_root() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let data_root = temp.path().join("app");
            let catalog = Catalog::open(&data_root).unwrap();
            let desktop = Desktop::new(&catalog).unwrap();
            let state = crate::AppState {
                db: Arc::new(Mutex::new(catalog)),
                root: data_root.clone(),
                workspace_io: Arc::new(Mutex::new(())),
                placement: Default::default(),
                sessions: Default::default(),
                token: String::new(),
                port: 0,
            };
            let library = Uuid::new_v4().to_string();
            let mount = temp.path().join("share").join("团队素材");
            let indexed = mount.join("项目");
            let unknown = mount.join("未索引");
            std::fs::create_dir_all(&indexed).unwrap();
            std::fs::create_dir(&unknown).unwrap();
            std::fs::write(indexed.join("mesh.obj"), b"v 0 0 0").unwrap();
            let token = "ab".repeat(32);
            let expected_header = format!("Bearer {token}");
            let app = Router::new()
                .route(
                    "/v1/info",
                    get(|| async { Json(json!({"teamId":"team","memberId":"member"})) }),
                )
                .route(
                    &format!("/v1/libraries/{library}/refresh"),
                    post({
                        let indexed = indexed.clone();
                        move || {
                            assert!(!indexed.exists());
                            async { Json(json!({"revision":2})) }
                        }
                    }),
                )
                .route(
                    "/v1/folder-visibility",
                    patch({
                        let mount = mount.clone();
                        let library = library.clone();
                        move |headers: HeaderMap, Json(body): Json<Value>| {
                            assert_eq!(headers["authorization"].to_str().unwrap(), expected_header);
                            assert_eq!(
                                body,
                                json!({"libraryId":library,"folder":"","hidden":true})
                            );
                            assert!(!mount.exists());
                            async { Json(json!({"revision":3})) }
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let snapshot = serde_json::from_value(json!({
                "team":{"id":"team","name":"团队"},
                "member":{"id":"member","name":"成员","role":"member"},
                "revision":1,"folderVisibility":true,"memberFolderVisibility":true,
                "catalog":{
                    "libraries":[{"id":library,"name":"共享库","watching":true}],
                    "assets":[],"visibleFolders":{(library.clone()):["项目"]}
                }
            }))
            .unwrap();
            desktop
                .save_connection(
                    Connection {
                        url,
                        token,
                        allow_lan_http: false,
                    },
                    cache_from(snapshot).unwrap(),
                )
                .unwrap();
            desktop.data.lock().unwrap().prefs.mounts.insert(
                "team".into(),
                HashMap::from([(library.clone(), clean_path(&mount))]),
            );
            let delete = |folder: &str| {
                desktop.delete_workspace_folder(
                    state.clone(),
                    "team".into(),
                    library.clone(),
                    folder.into(),
                )
            };
            assert!(delete("未索引").await.is_err());
            assert!(unknown.is_dir());
            assert_eq!(delete("项目").await.unwrap()["indexPending"], false);

            let protected = mount.join(".nexus");
            std::fs::create_dir(&protected).unwrap();
            assert!(delete("").await.is_err());
            assert!(unknown.is_dir());
            std::fs::remove_dir(protected).unwrap();
            assert_eq!(delete("").await.unwrap()["indexPending"], false);
            assert!(!mount.exists());
            assert!(data_root.join("nexus.sqlite3").is_file());
        });
    }

    #[test]
    fn watched_folder_links_send_only_paths_and_preserve_assets_when_refresh_is_pending() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let catalog = Catalog::open(&temp.path().join("catalog")).unwrap();
            let desktop = Desktop::new(&catalog).unwrap();
            let library_id = Uuid::new_v4().to_string();
            let mount = temp.path().join("mount");
            std::fs::create_dir(&mount).unwrap();
            let token = "ab".repeat(32);
            let expected_header = format!("Bearer {token}");
            let same_team = Arc::new(AtomicBool::new(true));
            let can_refresh = Arc::new(AtomicBool::new(false));
            let refresh_count = Arc::new(AtomicUsize::new(0));
            let snapshot = json!({
                "team":{"id":"team","name":"团队"},
                "member":{"id":"member","name":"成员","role":"member"},
                "revision":1,
                "catalog":{
                    "libraries":[{"id":library_id,"name":"共享库","watching":true}],
                    "assets":[],
                    "hiddenFolders":[{"libraryId":library_id,"folder":"隐藏"},
                        {"libraryId":library_id,"folder":"排除"}],
                    "linkedFolders":[{"libraryId":library_id,"folder":"原有"}]
                }
            });
            let app = Router::new()
                .route(
                    "/v1/info",
                    get({
                        let same_team = Arc::clone(&same_team);
                        let expected_header = expected_header.clone();
                        move |headers: HeaderMap| {
                            assert_eq!(headers["authorization"].to_str().unwrap(), expected_header);
                            let team_id = if same_team.load(Ordering::SeqCst) {
                                "team"
                            } else {
                                "another-team"
                            };
                            async move { Json(json!({"teamId":team_id,"memberId":"member"})) }
                        }
                    }),
                )
                .route(
                    "/v1/presence",
                    post({
                        let supported = Arc::clone(&can_refresh);
                        let expected_header = expected_header.clone();
                        move |headers: HeaderMap| {
                            assert_eq!(headers["authorization"].to_str().unwrap(), expected_header);
                            let supported = supported.load(Ordering::SeqCst);
                            async move {
                                if supported {
                                    Ok(Json(json!({"members":[{"id":"member","name":"成员",
                                        "onlineSince":5,"lastSeen":9,"self":true}]})))
                                } else {
                                    Err(StatusCode::NOT_FOUND)
                                }
                            }
                        }
                    }),
                )
                .route(
                    &format!("/v1/libraries/{library_id}/links"),
                    post({
                        let expected_header = expected_header.clone();
                        move |headers: HeaderMap, Json(body): Json<Value>| {
                            assert_eq!(headers["authorization"].to_str().unwrap(), expected_header);
                            let folders = body["folders"].as_array().unwrap();
                            assert!(folders == &[json!("原有")] || folders == &[json!("原有"), json!("排除")]);
                            let result = json!({"linked":folders.len(),"existing":0,"failed":0,
                                "errors":[],"folders":folders,"revision":2});
                            async move {
                                Json(result)
                            }
                        }
                    })
                    .delete(move |Json(body): Json<Value>| {
                        assert_eq!(body, json!({"folders":["原有"]}));
                        async { Json(json!({"removed":1,"revision":3})) }
                    }),
                )
                .route(
                    &format!("/v1/libraries/{library_id}/refresh"),
                    post({
                        let can_refresh = Arc::clone(&can_refresh);
                        let refresh_count = Arc::clone(&refresh_count);
                        move |headers: HeaderMap| {
                            assert_eq!(headers["authorization"].to_str().unwrap(), expected_header);
                            refresh_count.fetch_add(1, Ordering::SeqCst);
                            let available = can_refresh.load(Ordering::SeqCst);
                            async move {
                                if available {
                                    Ok(Json(json!({"revision":2})))
                                } else {
                                    Err(StatusCode::NOT_FOUND)
                                }
                            }
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            desktop
                .save_connection(
                    Connection {
                        url,
                        token,
                        allow_lan_http: false,
                    },
                    cache_from(serde_json::from_value(snapshot).unwrap()).unwrap(),
                )
                .unwrap();
            assert_eq!(desktop.online_members().await.unwrap(), Value::Null);
            desktop.data.lock().unwrap().prefs.mounts.insert(
                "team".into(),
                HashMap::from([(library_id.clone(), clean_path(&mount))]),
            );

            let selected = mount.join("原有");
            let hidden = mount.join("排除");
            let dot_folder = mount.join(".nexus");
            let outside = temp.path().join("外部");
            for path in [&selected, &hidden, &dot_folder, &outside] {
                std::fs::create_dir(path).unwrap();
            }
            let asset = selected.join("first.obj");
            std::fs::write(&asset, b"v 0 0 0").unwrap();
            let link = |paths: &[&Path]| {
                let fixture = mount.clone();
                desktop.link_folders_with_unc(
                    paths.iter().map(|path| clean_path(path)).collect(),
                    move |source, _| {
                        source
                            .starts_with(&fixture)
                            .then(|| network_paths::UncDirectory::parse(r"\\127.0.0.1\Fixture"))
                            .flatten()
                    },
                )
            };
            let first_result = serde_json::to_value(
                link(&[&selected, &hidden, &dot_folder, &outside, &asset])
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(first_result["linked"], 2);
            assert_eq!(first_result["failed"], 3);
            assert_eq!(
                first_result["folders"],
                json!([{"libraryId":library_id,"folder":"原有"}, {"libraryId":library_id,"folder":"排除"}])
            );
            assert_eq!(first_result["indexPending"], true);
            assert_eq!(std::fs::read(&asset).unwrap(), b"v 0 0 0");
            assert!(!mount.join("first.obj").exists());
            assert_eq!(
                view(&desktop.data.lock().unwrap(), false).unwrap()["linkedFolders"],
                json!([{"libraryId":library_id,"folder":"原有"}])
            );
            assert_eq!(
                desktop
                    .unlink_folder(library_id.clone(), "原有".into())
                    .await
                    .unwrap()["removed"],
                1
            );
            assert_eq!(std::fs::read(&asset).unwrap(), b"v 0 0 0");

            let create = |folder: &str, name: &str| {
                desktop.create_folder(
                    "team".into(),
                    library_id.clone(),
                    folder.into(),
                    name.into(),
                )
            };
            let project = create("", "项目").await.unwrap();
            assert_eq!(project["folder"], "项目");
            assert_eq!(project["indexPending"], true);
            assert!(project["indexError"].is_string());
            assert!(mount.join("项目").is_dir());
            assert!(create("", "项目").await.is_err());
            assert!(create("", "隐藏").await.is_err());
            assert!(create("", "项目/嵌套").await.is_err());
            assert!(!mount.join("隐藏").exists());
            assert!(!mount.join("项目").join("嵌套").exists());

            same_team.store(false, Ordering::SeqCst);
            let switched = serde_json::to_value(link(&[&selected]).await.unwrap()).unwrap();
            assert_eq!(switched["failed"], 1);
            assert_eq!(switched["linked"], 0);
            assert!(create("项目", "未创建").await.is_err());
            assert!(!mount.join("项目").join("未创建").exists());
            same_team.store(true, Ordering::SeqCst);
            can_refresh.store(true, Ordering::SeqCst);
            let second_result = serde_json::to_value(link(&[&selected]).await.unwrap()).unwrap();
            assert_eq!(second_result["indexPending"], false);
            let nested = create("项目", "嵌套").await.unwrap();
            assert_eq!(nested["folder"], "项目/嵌套");
            assert_eq!(nested["indexPending"], false);
            assert!(nested["indexError"].is_null());
            assert!(mount.join("项目").join("嵌套").is_dir());
            assert_eq!(
                desktop.online_members().await.unwrap()["members"][0]["self"],
                true
            );
            desktop.data.lock().unwrap().prefs.mounts.clear();
            assert_eq!(
                desktop
                    .refresh_library("team".into(), library_id.clone())
                    .await
                    .unwrap()["revision"],
                2
            );
            assert_eq!(refresh_count.load(Ordering::SeqCst), 5);
        });
    }

    async fn fixture_team(token: String, team_id: &str, member_id: &str) -> String {
        let expected_header = format!("Bearer {token}");
        let body = json!({
            "team":{"id":team_id,"name":"共用团队"},
            "member":{"id":member_id,"name":"测试成员","role":"member"},
            "revision":8,
            "catalog":{"libraries":[{"id":"models","name":"模型","watching":false}],"assets":[]},
        });
        let app = Router::new().route(
            "/v1/catalog/full",
            get(move |headers: HeaderMap| {
                let authorized = headers
                    .get("authorization")
                    .and_then(|header| header.to_str().ok())
                    .is_some_and(|header| header == expected_header);
                let body = body.clone();
                async move {
                    if authorized {
                        Ok(Json(body))
                    } else {
                        Err(axum::http::StatusCode::UNAUTHORIZED)
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url
    }

    #[test]
    fn nas_switch_uses_saved_identity_and_retains_local_preferences() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let catalog = Catalog::open(temp.path()).unwrap();
            let desktop = Desktop::new(&catalog).unwrap();
            let token = "ab".repeat(32);
            let old_url = fixture_team(token.clone(), "original", "colleague").await;
            let old = Connection {
                url: old_url.clone(),
                token: token.clone(),
                allow_lan_http: false,
            };
            desktop.connect(old).await.unwrap();
            let (mounts, favorites) = {
                let mut data = desktop.data.lock().unwrap();
                let prefs = &mut data.prefs;
                prefs.mounts.insert(
                    "original".into(),
                    HashMap::from([("models".into(), "挂载目录".into())]),
                );
                prefs.favorites.insert(
                    "original:colleague".into(),
                    HashSet::from(["example".into()]),
                );
                desktop.save(prefs).unwrap();
                (prefs.mounts.clone(), prefs.favorites.clone())
            };
            // A restarted client has a persisted identity but no in-memory catalog.
            let desktop = Desktop::new(&catalog).unwrap();
            let different_member = fixture_team(token.clone(), "original", "another").await;
            let error = desktop
                .reconnect_nas(different_member, false)
                .await
                .unwrap_err();
            assert!(error.contains("与原团队不一致"));
            assert_eq!(desktop.connection().unwrap().url, old_url);
            assert!(desktop.data.lock().unwrap().cache.is_none());

            let new_url = fixture_team(token.clone(), "original", "colleague").await;
            let view = desktop.reconnect_nas(new_url.clone(), false).await.unwrap();
            assert_eq!(view["member"]["id"], "colleague");
            assert_eq!(view["libraries"][0]["path"], "挂载目录");
            assert_eq!(view["allLibraries"], view["libraries"]);
            assert_eq!(view["folderVisibility"], false);
            assert_eq!(view["hiddenFolders"], json!([]));
            assert!(!view.to_string().contains(&token));
            let reopened = Desktop::new(&catalog).unwrap();
            assert_eq!(reopened.connection().unwrap().url, new_url);
            let data = reopened.data.lock().unwrap();
            assert_eq!(data.prefs.mounts, mounts);
            assert_eq!(data.prefs.favorites, favorites);
        });
    }

    #[test]
    fn shared_hidden_root_remains_available_for_management_with_its_local_mount() {
        let snapshot = serde_json::from_value(json!({
            "team":{"id":"team","name":"团队"},
            "member":{"id":"admin","name":"管理员","role":"admin"},
            "revision":2,
            "folderVisibility":true,
            "catalog":{
                "libraries":[{"id":"visible","name":"公开目录"}],"assets":[],
                "allLibraries":[{"id":"root","name":"根目录","watching":true},{"id":"visible","name":"公开目录"}],
                "hiddenFolders":[{"libraryId":"root","folder":""},{"libraryId":"visible","folder":"模型/草稿"}],
                "visibleFolders":{"visible":["模型"]},
            },
        }))
        .unwrap();
        let workspace = Workspace {
            cache: Some(cache_from(snapshot).unwrap()),
            prefs: Preferences {
                mounts: HashMap::from([(
                    "team".into(),
                    HashMap::from([("root".into(), "挂载目录".into())]),
                )]),
                ..Preferences::default()
            },
            ..Workspace::default()
        };
        let result = view(&workspace, false).unwrap();
        assert_eq!(result["assets"], Value::Null);
        assert_eq!(result["folderVisibility"], true);
        assert_eq!(result["libraries"].as_array().unwrap().len(), 1);
        assert_eq!(result["libraries"][0]["folders"], json!(["模型"]));
        assert_eq!(result["allLibraries"][0]["path"], "挂载目录");
        assert_eq!(
            result["hiddenFolders"][0],
            json!({"libraryId":"root","folder":""})
        );
    }

    #[test]
    fn shared_thumbnail_root_is_local_to_the_active_team_workspace() {
        let snapshot = serde_json::from_value(json!({
            "team":{"id":"team-one","name":"团队"},
            "member":{"id":"member","name":"成员","role":"member"},
            "revision":1,
            "catalog":{"libraries":[],"assets":[]}
        }))
        .unwrap();
        let old_prefs: Preferences = serde_json::from_value(json!({"mounts":{}})).unwrap();
        assert!(old_prefs.thumbnail_cache_roots.is_empty());
        let mut workspace = Workspace {
            cache: Some(cache_from(snapshot).unwrap()),
            prefs: old_prefs,
            ..Workspace::default()
        };

        let roots = &mut workspace.prefs.thumbnail_cache_roots;
        roots.insert("team-two".into(), "other-cache".into());
        assert!(view(&workspace, false).unwrap()["thumbnailCacheRoot"].is_null());
        workspace.prefs.thumbnail_cache_roots.insert("team-one".into(), "current-cache".into());
        assert_eq!(view(&workspace, false).unwrap()["thumbnailCacheRoot"], "current-cache");
        workspace.prefs.thumbnail_cache_roots.remove("team-one");
        assert!(view(&workspace, false).unwrap()["thumbnailCacheRoot"].is_null());
    }

    #[test]
    fn shared_folder_visibility_uses_the_server_capability_for_regular_members() {
        let mut data = json!({
            "team":{"id":"team","name":"团队"},
            "member":{"id":"user","name":"成员","role":"member"},
            "revision":1,
            "catalog":{"libraries":[],"assets":[]},
        });
        let can_share = |data: &Value| {
            let snapshot = serde_json::from_value(data.clone()).unwrap();
            cache_from(snapshot).unwrap().folder_visibility
        };
        assert!(!can_share(&data));
        data["folderVisibility"] = json!(true);
        assert!(!can_share(&data));
        data["memberFolderVisibility"] = json!(true);
        assert!(can_share(&data));
        data["memberFolderVisibility"] = json!(false);
        data["member"]["role"] = json!("admin");
        assert!(can_share(&data));
        data["folderVisibility"] = json!(false);
        assert!(!can_share(&data));
    }

    #[test]
    fn legacy_host_identity_requires_the_matching_saved_address_and_credential() {
        let temp = tempfile::tempdir().unwrap();
        let hosted = temp.path().join("hosted-team");
        std::fs::create_dir(&hosted).unwrap();
        let team_id = Uuid::new_v4().to_string();
        let member_id = Uuid::new_v4().to_string();
        let token = "ab".repeat(32);
        let info = json!({
            "listen": "127.0.0.1:47822",
            "credentials": {"teamId":team_id,"adminId":member_id,"token":token}
        });
        std::fs::write(hosted.join("host.json"), info.to_string()).unwrap();
        let mut previous = Connection {
            url: "http://127.0.0.1:47822".into(),
            token,
            allow_lan_http: false,
        };
        let identity = hosted_identity(temp.path(), &previous).unwrap();
        assert_eq!(identity.team_id, team_id);
        assert_eq!(identity.member_id, member_id);
        previous.token = "cd".repeat(32);
        assert!(hosted_identity(temp.path(), &previous).is_none());
    }
}
