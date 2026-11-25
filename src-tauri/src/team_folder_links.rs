use super::{
    network_paths::{folder_unc, UncDirectory},
    ActiveConnection, ConnectionIdentity, Desktop,
};
use crate::team_import::{mounted_folder, share_path, team_destination};
use nexus_core::{clean_path, team::MAX_FOLDERS_PER_LINK_REQUEST};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LinkReport {
    linked: usize,
    existing: usize,
    failed: usize,
    errors: Vec<String>,
    folders: Vec<FolderLink>,
    merged_libraries: Vec<MergedLibrary>,
    index_pending: bool,
    index_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderLink {
    library_id: String,
    folder: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MergedLibrary {
    library_id: String,
    target_library_id: String,
    folder: String,
}

#[derive(Deserialize)]
struct LinkResponse {
    linked: usize,
    existing: usize,
    failed: usize,
    errors: Vec<String>,
    folders: Vec<String>,
}

impl LinkReport {
    fn failure(&mut self, source: &Path, message: impl std::fmt::Display) {
        self.failed += 1;
        self.message(format!("{}：{message}", clean_path(source)));
    }

    fn message(&mut self, message: String) {
        if self.errors.len() < MAX_FOLDERS_PER_LINK_REQUEST {
            self.errors.push(message);
        }
    }
}

struct Candidate {
    library_id: String,
    mount: PathBuf,
    source: PathBuf,
    folder: String,
    source_route: Option<ExternalCandidate>,
}

struct ExternalCandidate {
    source: PathBuf,
    canonical: PathBuf,
    unc: UncDirectory,
}

#[derive(Deserialize)]
struct SourceRoots {
    roots: Vec<SourceRoot>,
}

#[derive(Deserialize)]
struct SourceRoot {
    id: String,
    unc: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceLinkResponse {
    library_id: String,
    folder: String,
    created: bool,
    index_pending: bool,
    #[serde(default)]
    consolidated: Vec<SourceConsolidation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceConsolidation {
    previous_library_id: String,
    library_id: String,
    folder: String,
}

#[derive(Clone)]
struct Mount {
    library_id: String,
    root: PathBuf,
    automatic: bool,
}

fn ordinary_directory(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    meta.is_dir() && !meta.file_type().is_symlink()
}

fn path_key(folder: &str) -> String {
    if cfg!(windows) {
        folder.to_lowercase()
    } else {
        folder.to_owned()
    }
}

fn select_folder(
    source: &Path,
    canonical: &Path,
    mounts: &[Mount],
) -> Result<Option<Candidate>, String> {
    // If several watched libraries overlap, associate the folder with its closest root.
    let Some((mount, relative)) = mounts
        .iter()
        .filter_map(|mount| {
            mounted_folder(&mount.root, canonical).map(|relative| (mount, relative))
        })
        .min_by_key(|(_, relative)| relative.components().count())
    else {
        return Ok(None);
    };
    let folder = share_path(&relative)?;
    let selected = if path_key(&clean_path(source)) == path_key(&clean_path(canonical)) {
        relative
    } else {
        mounted_folder(&mount.root, source).ok_or("请选择 NAS 中的实际文件夹路径")?
    };
    if path_key(&share_path(&selected)?) != path_key(&folder)
        || source
            .ancestors()
            .take(selected.components().count() + 1)
            .any(|ancestor| !ordinary_directory(ancestor))
    {
        return Err("文件夹路径包含链接，请选择 NAS 中的实际文件夹".into());
    }
    team_destination(&mount.root, &folder)?;
    let source_route = if mount.automatic {
        None
    } else {
        folder_unc(canonical)
            .or_else(|| folder_unc(source))
            .map(|unc| ExternalCandidate {
                source: source.to_path_buf(),
                canonical: canonical.to_path_buf(),
                unc,
            })
    };
    Ok(Some(Candidate {
        library_id: mount.library_id.clone(),
        mount: mount.root.clone(),
        folder,
        source: source.to_path_buf(),
        source_route,
    }))
}

fn select_folders(
    paths: Vec<String>,
    mounts: Vec<Mount>,
    resolve_unc: impl Fn(&Path, &Path) -> Option<UncDirectory>,
) -> (Vec<Candidate>, Vec<ExternalCandidate>, LinkReport) {
    let mut selected = HashSet::new();
    let mut report = LinkReport::default();
    let mut candidates = Vec::new();
    let mut external = Vec::new();
    for source in paths.into_iter().map(PathBuf::from) {
        if !source.is_absolute() || !ordinary_directory(&source) {
            report.failure(&source, "请选择实际文件夹");
            continue;
        }
        let canonical = match fs::canonicalize(&source) {
            Ok(canonical) => canonical,
            Err(error) => {
                report.failure(&source, format!("无法读取文件夹：{error}"));
                continue;
            }
        };
        let Some(unc) = resolve_unc(&source, &canonical) else {
            report.failure(&source, "团队成员看不到本地磁盘上的文件夹。请选择 NAS 共享文件夹，或将本地素材复制到团队库。");
            continue;
        };
        match select_folder(&source, &canonical, &mounts) {
            Ok(Some(candidate)) => {
                if selected.insert((candidate.library_id.clone(), path_key(&candidate.folder))) {
                    candidates.push(candidate);
                }
            }
            Ok(None) => {
                if source
                    .ancestors()
                    .filter(|path| path.is_absolute())
                    .any(|ancestor| !ordinary_directory(ancestor))
                {
                    report.failure(&source, "路径包含链接或连接点，请选择 NAS 中的实际文件夹");
                    continue;
                }
                external.push(ExternalCandidate {
                    source,
                    canonical,
                    unc,
                });
            }
            Err(error) => report.failure(&source, error),
        }
    }
    (candidates, external, report)
}

fn select_source_roots(
    external: Vec<ExternalCandidate>,
    roots: Vec<(String, UncDirectory)>,
) -> (Vec<(ExternalCandidate, String, String)>, LinkReport) {
    let mut assignments = Vec::new();
    let mut report = LinkReport::default();
    let mut selected = HashSet::new();
    for candidate in external {
        let nearest = roots
            .iter()
            .filter_map(|(root_id, root)| {
                let folder = candidate.unc.relative_to(root).or_else(|| {
                    let directory = root.text();
                    let relative = mounted_folder(Path::new(&directory), &candidate.canonical)?;
                    share_path(&relative).ok()
                })?;
                if !folder.is_empty() {
                    share_path(&nexus_core::team::relative_path(&folder)?).ok()?;
                }
                Some((root_id, folder))
            })
            .min_by_key(|(_, folder)| folder.split('/').filter(|part| !part.is_empty()).count());
        match nearest {
            Some((_, ref folder)) if folder.is_empty() => {
                report.failure(&candidate.source, "请选择 NAS 共享根目录下面的文件夹")
            }
            Some((root_id, folder)) => {
                if selected.insert((root_id.clone(), path_key(&folder))) {
                    assignments.push((candidate, root_id.clone(), folder));
                }
            }
            None => report.failure(&candidate.source, "文件夹不在此团队已配置的 NAS 共享范围内"),
        }
    }
    (assignments, report)
}

fn supported_link_error(error: String) -> String {
    if error == format!("团队服务返回错误 {}", StatusCode::NOT_FOUND) {
        "当前 NAS 团队服务版本暂不支持链接文件夹".into()
    } else {
        error
    }
}

impl Desktop {
    pub(super) async fn link_folders(&self, paths: Vec<String>) -> Result<LinkReport, String> {
        self.link_folders_with_unc(paths, |source, canonical| {
            folder_unc(canonical).or_else(|| folder_unc(source))
        })
        .await
    }

    pub(super) async fn link_folders_with_unc(
        &self,
        paths: Vec<String>,
        resolve_unc: impl Fn(&Path, &Path) -> Option<UncDirectory> + Send + 'static,
    ) -> Result<LinkReport, String> {
        if paths.is_empty() || paths.len() > MAX_FOLDERS_PER_LINK_REQUEST {
            return Err(format!(
                "请选择 1 到 {MAX_FOLDERS_PER_LINK_REQUEST} 个团队共享文件夹"
            ));
        }
        let _operation = self.begin_storage_operation()?;
        let active = self.active_connection()?;
        let (mounts, manual_mounts) = {
            let data = self.data.lock().unwrap();
            let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
            let mounts = cached
                .all_libraries()
                .iter()
                .filter(|library| library.watching)
                .filter_map(|library| {
                    let root = PathBuf::from(data.resolved_mount(cached, &library.id)?);
                    root.is_absolute().then(|| Mount {
                        library_id: library.id.clone(),
                        root,
                        automatic: data.automatic_mount(cached, &library.id).is_some(),
                    })
                })
                .collect::<Vec<_>>();
            (
                mounts,
                data.manual_mounts(cached)
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            )
        };
        let (candidates, external, mut report) =
            tauri::async_runtime::spawn_blocking(move || select_folders(paths, mounts, resolve_unc))
                .await
                .map_err(|error| error.to_string())?;
        let mut groups = BTreeMap::<String, Vec<Candidate>>::new();
        for candidate in candidates {
            groups
                .entry(candidate.library_id.clone())
                .or_default()
                .push(candidate);
        }
        for (library_id, mut candidates) in groups {
            // An explicit NAS selection can publish the shared UNC for a library
            // originally mapped on one PC. Older servers still use ordinary links.
            if let Some((index, source)) =
                candidates
                    .iter_mut()
                    .enumerate()
                    .find_map(|(index, candidate)| {
                        candidate.source_route.take().map(|source| (index, source))
                    })
            {
                let mut registered = LinkReport::default();
                self.link_external_folders(&active, vec![source], &manual_mounts, &mut registered)
                    .await?;
                if !registered.folders.is_empty() {
                    candidates.remove(index);
                    report.linked += registered.linked;
                    report.existing += registered.existing;
                    report.folders.extend(registered.folders);
                    report.merged_libraries.extend(registered.merged_libraries);
                    report.index_pending |= registered.index_pending;
                }
            }
            if candidates.is_empty() {
                continue;
            }
            match self
                .send_folder_links(&active, &library_id, &candidates)
                .await
            {
                Ok(response) => {
                    report.linked += response.linked;
                    report.existing += response.existing;
                    report.failed += response.failed;
                    for error in response.errors {
                        report.message(error);
                    }
                    if !response.folders.is_empty() {
                        report
                            .folders
                            .extend(response.folders.into_iter().map(|folder| FolderLink {
                                library_id: library_id.clone(),
                                folder,
                            }));
                        if let Err(error) = self
                            .refresh_watched_library(&active.config, &library_id)
                            .await
                        {
                            report.index_pending = true;
                            report.index_error.get_or_insert(error);
                        }
                    }
                }
                Err(error) => {
                    for candidate in candidates {
                        report.failure(&candidate.source, &error);
                    }
                }
            }
        }
        if !external.is_empty() {
            self.link_external_folders(&active, external, &manual_mounts, &mut report)
                .await?;
        }
        Ok(report)
    }

    async fn link_external_folders(
        &self,
        active: &ActiveConnection,
        external: Vec<ExternalCandidate>,
        manual_mounts: &[String],
        report: &mut LinkReport,
    ) -> Result<(), String> {
        let roots = match self
            .request::<SourceRoots>(&active.config, Method::GET, "/v1/source-roots", None)
            .await
        {
            Ok(reply) => reply.roots,
            Err(error) => {
                let error = if error == format!("团队服务返回错误 {}", StatusCode::NOT_FOUND)
                {
                    "当前团队服务只能链接已挂载且启用自动索引的团队共享目录".into()
                } else {
                    error
                };
                for candidate in external {
                    report.failure(&candidate.source, &error);
                }
                return Ok(());
            }
        };
        let configured = !roots.is_empty();
        let roots = roots
            .into_iter()
            .filter_map(|root| {
                let id_ok = !root.id.is_empty()
                    && root.id.len() <= 64
                    && root
                        .id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
                let unc = UncDirectory::parse(&root.unc)?;
                (id_ok && unc.trusted(&active.config.url, manual_mounts)).then_some((root.id, unc))
            })
            .collect::<Vec<_>>();
        if roots.is_empty() {
            let message = if configured {
                "NAS 共享地址与当前团队连接不匹配"
            } else {
                "团队服务尚未配置可链接的 NAS 共享来源"
            };
            for candidate in external {
                report.failure(&candidate.source, message);
            }
            return Ok(());
        }
        let (assignments, rejected) =
            tauri::async_runtime::spawn_blocking(move || select_source_roots(external, roots))
                .await
                .map_err(|error| error.to_string())?;
        report.failed += rejected.failed;
        for error in rejected.errors {
            report.message(error);
        }
        if assignments.is_empty() {
            return Ok(());
        }
        let identity = self
            .request::<ConnectionIdentity>(&active.config, Method::GET, "/v1/info", None)
            .await;
        let identity = match identity {
            Ok(identity) if identity == active.identity && self.active_connection()? == *active => {
                None
            }
            Ok(_) => Some("团队连接已切换，请重新选择文件夹".into()),
            Err(error) => Some(error),
        };
        for (candidate, root_id, folder) in assignments {
            if let Some(error) = &identity {
                report.failure(&candidate.source, error);
                continue;
            }
            let body =
                serde_json::to_vec(&json!({"folder":folder})).map_err(|error| error.to_string())?;
            match self
                .request::<SourceLinkResponse>(
                    &active.config,
                    Method::POST,
                    &format!("/v1/source-roots/{root_id}/libraries"),
                    Some(body),
                )
                .await
            {
                Ok(result) => {
                    let valid_folder = result.folder.is_empty()
                        || nexus_core::team::relative_path(&result.folder)
                            .is_some_and(|path| share_path(&path).is_ok());
                    let library_id = match uuid::Uuid::parse_str(&result.library_id) {
                        Ok(id) if valid_folder => id.to_string(),
                        _ => {
                            report.failure(&candidate.source, "团队服务返回了无法使用的共享目录");
                            continue;
                        }
                    };
                    if result.created {
                        report.linked += 1;
                    } else {
                        report.existing += 1;
                    }
                    report.merged_libraries.extend(result.consolidated.into_iter().filter_map(|item| {
                        let previous = uuid::Uuid::parse_str(&item.previous_library_id).ok()?.to_string();
                        let target = uuid::Uuid::parse_str(&item.library_id).ok()?.to_string();
                        let folder = share_path(&nexus_core::team::relative_path(&item.folder)?).ok()?;
                        (target == library_id && previous != target && !folder.is_empty()).then_some(MergedLibrary {
                            library_id: previous,
                            target_library_id: target,
                            folder,
                        })
                    }));
                    report.folders.push(FolderLink {
                        library_id,
                        folder: result.folder,
                    });
                    report.index_pending |= result.index_pending;
                }
                Err(error) => report.failure(&candidate.source, error),
            }
        }
        Ok(())
    }

    async fn send_folder_links(
        &self,
        active: &ActiveConnection,
        library_id: &str,
        candidates: &[Candidate],
    ) -> Result<LinkResponse, String> {
        let library_id = uuid::Uuid::parse_str(library_id)
            .map_err(|_| "团队库编号无效")?
            .to_string();
        // Linking can explicitly restore visibility. The server checks actual paths and
        // clears the applicable shared rules; filesystem writes still use the visible gate.
        let check_target = || {
            let data = self.data.lock().unwrap();
            if data.active_connection()? != *active {
                return Err("团队连接已切换，请重新选择文件夹".into());
            }
            let cached = data.cache.as_ref().ok_or("请先同步团队目录")?;
            if !cached
                .all_libraries()
                .iter()
                .any(|library| library.id == library_id && library.watching)
            {
                return Err("此团队库未启用 NAS 自动索引".into());
            }
            let mount = data
                .resolved_mount(cached, &library_id)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or("请先为团队库设置本机挂载目录")?;
            if candidates.iter().any(|candidate| candidate.mount != mount) {
                return Err("挂载目录已切换，请重新选择".into());
            }
            Ok::<(), String>(())
        };
        check_target()?;
        let actual: ConnectionIdentity = self
            .request(&active.config, Method::GET, "/v1/info", None)
            .await?;
        if actual != active.identity {
            return Err("团队连接已切换，请重新选择文件夹".into());
        }
        check_target()?;
        let folders = candidates
            .iter()
            .map(|candidate| &candidate.folder)
            .collect::<Vec<_>>();
        let body =
            serde_json::to_vec(&json!({"folders":folders})).map_err(|error| error.to_string())?;
        self.request(
            &active.config,
            Method::POST,
            &format!("/v1/libraries/{library_id}/links"),
            Some(body),
        )
        .await
        .map_err(supported_link_error)
    }

    pub(super) async fn unlink_folder(
        &self,
        library_id: String,
        folder: String,
    ) -> Result<Value, String> {
        let _operation = self.begin_storage_operation()?;
        let team_id = self
            .data
            .lock()
            .unwrap()
            .cache
            .as_ref()
            .ok_or("请先同步团队目录")?
            .team
            .id
            .clone();
        if !folder.is_empty() {
            let relative = nexus_core::team::relative_path(&folder).ok_or("团队文件夹链接无效")?;
            share_path(&relative)?;
        }
        let (connection, library_id, _) = self
            .checked_watched_target(&team_id, &library_id, None)
            .await?;
        let body =
            serde_json::to_vec(&json!({"folders":[folder]})).map_err(|error| error.to_string())?;
        self.request(
            &connection,
            Method::DELETE,
            &format!("/v1/libraries/{library_id}/links"),
            Some(body),
        )
        .await
        .map_err(supported_link_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_desktop::Connection;
    use axum::{
        http::HeaderMap,
        routing::{get, post},
        Json, Router,
    };
    use nexus_core::Catalog;

    #[test]
    fn local_disk_cannot_be_linked_even_with_a_legacy_team_mount() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let catalog = Catalog::open(&temp.path().join("catalog")).unwrap();
            let desktop = Desktop::new(&catalog).unwrap();
            let mount = temp.path().join("共享");
            fs::create_dir(&mount).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let app = Router::new()
                .route("/v1/info", get(|| async { Json(json!({"teamId":"team","memberId":"member"})) }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let snapshot = serde_json::from_value(json!({
                "team":{"id":"team","name":"团队"},"member":{"id":"member","name":"成员","role":"member"},"revision":1,
                "catalog":{"libraries":[],"assets":[],"allLibraries":[{"id":id,"name":"共享","watching":true}],
                    "hiddenFolders":[{"libraryId":id,"folder":""}]}
            })).unwrap();
            desktop.save_connection(Connection {url,token:"ab".repeat(32),allow_lan_http:false}, super::super::cache_from(snapshot).unwrap()).unwrap();
            desktop.data.lock().unwrap().prefs.mounts.insert("team".into(), [(id.clone(), clean_path(&mount))].into_iter().collect());
            assert!(desktop.checked_write_target("team", &id, "").await.is_err());
            let selected = fs::canonicalize(&mount).unwrap().to_str().unwrap().to_owned();
            let report = desktop.link_folders(vec![selected]).await.unwrap();
            assert_eq!(report.linked, 0);
            assert_eq!(report.failed, 1);
            assert!(report.folders.is_empty());
            assert!(report.errors[0].contains("团队成员看不到本地磁盘上的文件夹"));
            assert!(!report.index_pending);
            assert!(mount.is_dir());
        });
    }

    #[test]
    fn authorized_unc_selection_registers_source_and_returns_the_shared_library() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let catalog = Catalog::open(temp.path()).unwrap();
            let desktop = Desktop::new(&catalog).unwrap();
            let token = "ab".repeat(32);
            let bearer = format!("Bearer {token}");
            let library = uuid::Uuid::new_v4().to_string();
            let previous = uuid::Uuid::new_v4().to_string();
            let app = Router::new()
                .route("/v1/info", get(|| async { Json(json!({"teamId":"team","memberId":"member"})) }))
                .route("/v1/source-roots", get(|| async {
                    Json(json!({"roots":[{"id":"materials","unc":r"\\127.0.0.1\Public\Materials"}]}))
                }))
                .route("/v1/source-roots/materials/libraries", post({
                    let library = library.clone();
                    let previous = previous.clone();
                    move |headers: HeaderMap, Json(body): Json<Value>| {
                        assert_eq!(headers["authorization"].to_str().unwrap(), bearer);
                        assert_eq!(body, json!({"folder":"项目/模型"}));
                        let library = library.clone();
                        let previous = previous.clone();
                        async move { Json(json!({"libraryId":library,"folder":"","created":true,"indexPending":false,
                            "consolidated":[{"previousLibraryId":previous,"libraryId":library,"folder":"子库"}]})) }
                    }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let unc = r"\\127.0.0.1\Public\Materials\项目\模型";
            let snapshot = serde_json::from_value(json!({
                "team":{"id":"team","name":"团队"},"member":{"id":"member","name":"成员","role":"member"},"revision":1,
                "catalog":{"libraries":[{"id":library,"name":"模型","watching":true}],"assets":[],
                    "sourcePaths":{(library.clone()):unc}}
            })).unwrap();
            desktop.save_connection(Connection {url,token,allow_lan_http:false}, super::super::cache_from(snapshot).unwrap()).unwrap();

            let selected = ExternalCandidate {source:PathBuf::from(unc),canonical:PathBuf::from(unc),unc:UncDirectory::parse(unc).unwrap()};
            let mut report = LinkReport::default();
            desktop.link_external_folders(&desktop.active_connection().unwrap(), vec![selected], &[], &mut report).await.unwrap();
            assert_eq!(report.linked, 1);
            assert_eq!(report.failed, 0);
            assert_eq!(report.folders[0].library_id, library);
            assert_eq!(report.folders[0].folder, "");
            assert_eq!(report.merged_libraries[0].library_id, previous);
            assert_eq!(report.merged_libraries[0].target_library_id, library);
            assert_eq!(report.merged_libraries[0].folder, "子库");
            assert!(!report.index_pending);

            let mut data = desktop.data.lock().unwrap();
            #[cfg(windows)]
            assert_eq!(data.resolved_mount(data.cache.as_ref().unwrap(), &library).as_deref(), Some(unc));
            let override_path = clean_path(&temp.path().join("override"));
            data.prefs.mounts.insert("team".into(), [(library.clone(), override_path.clone())].into_iter().collect());
            #[cfg(windows)]
            assert_eq!(data.resolved_mount(data.cache.as_ref().unwrap(), &library).as_deref(), Some(unc));
            data.cache.as_mut().unwrap().catalog.source_paths.clear();
            assert_eq!(data.resolved_mount(data.cache.as_ref().unwrap(), &library), Some(override_path));
        });
    }
}
