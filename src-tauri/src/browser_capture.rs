use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{io::AsyncWriteExt, sync::Semaphore};
use uuid::Uuid;

const PAIR_SECONDS: u64 = 120;
const PAIR_ATTEMPTS: u8 = 8;
const MAX_GRANTS: usize = 16;
const MAX_HISTORY: usize = 24;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_IMAGE: u64 = 25 * 1024 * 1024;
const MAX_VIDEO: u64 = 200 * 1024 * 1024;
const MAX_SCREENSHOT: usize = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BASE64: usize = MAX_SCREENSHOT.div_ceil(3) * 4;

#[derive(Clone)]
pub(crate) struct BrowserCapture(Arc<Receiver>);

struct Receiver {
    root: PathBuf,
    host: HeaderValue,
    keys: Mutex<Keys>,
    captures: Mutex<VecDeque<CaptureSummary>>,
    slots: Arc<Semaphore>,
}

struct Keys {
    challenge: Option<Challenge>,
    grants: BTreeMap<String, [u8; 32]>,
}

struct Challenge {
    code: String,
    until: Instant,
    remaining: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairRequest {
    code: String,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Image,
    Video,
    Link,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureRequest {
    kind: Kind,
    url: String,
    title: Option<String>,
    page_url: Option<String>,
    mime: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScreenshotRequest {
    title: Option<String>,
    page_url: Option<String>,
    data_url: String,
}

struct CaptureInput {
    kind: Kind,
    media: Option<Url>,
    page: Option<Url>,
    title: String,
    screenshot: Option<(&'static str, String)>,
}

#[derive(Clone, Serialize)]
struct CaptureSummary {
    id: Uuid,
    kind: Kind,
    title: String,
    state: &'static str,
    message: &'static str,
    created: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
}

impl BrowserCapture {
    pub(crate) fn new(app_root: &Path, port: u16) -> Self {
        let root = app_root.join("browser-capture");
        let grants = fs::read(root.join("grants.json"))
            .ok()
            .filter(|bytes| bytes.len() <= 16 * 1024)
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self(Arc::new(Receiver {
            root,
            host: HeaderValue::from_str(&format!("127.0.0.1:{port}")).unwrap(),
            keys: Mutex::new(Keys {
                challenge: None,
                grants,
            }),
            captures: Mutex::new(VecDeque::new()),
            slots: Arc::new(Semaphore::new(2)),
        }))
    }

    pub(crate) fn router(self) -> Router {
        Router::new()
            .route("/capture/pair", post(pair).options(preflight))
            .route("/capture", post(capture).options(preflight))
            .layer(DefaultBodyLimit::max(16 * 1024))
            .route(
                "/capture/screenshot",
                post(capture_screenshot)
                    .options(preflight)
                    .layer(DefaultBodyLimit::max(MAX_SCREENSHOT_BASE64 + 16 * 1024)),
            )
            .with_state(self)
    }

    fn inbox(&self) -> PathBuf {
        self.0.root.join("inbox")
    }

    pub(crate) fn import_sources(&self, ids: Vec<Uuid>) -> Result<(Vec<PathBuf>, usize), String> {
        if ids.is_empty() || ids.len() > MAX_HISTORY {
            return Err(format!("请选择 1 至 {MAX_HISTORY} 条已保存的媒体采集记录"));
        }
        let ids: HashSet<_> = ids.into_iter().collect();
        let candidates: Vec<_> = self
            .0
            .captures
            .lock()
            .map_err(|_| "无法读取采集记录")?
            .iter()
            .filter(|record| {
                ids.contains(&record.id)
                    && record.state == "saved"
                    && matches!(record.kind, Kind::Image | Kind::Video)
            })
            .filter_map(|record| record.file.as_ref().map(PathBuf::from))
            .collect();
        if candidates.is_empty() {
            return Ok((Vec::new(), ids.len()));
        }
        private_directory(&self.0.root)
            .and_then(|()| private_directory(&self.inbox()))
            .map_err(|_| "无法打开浏览器采集箱")?;
        let inbox = fs::canonicalize(self.inbox()).map_err(|_| "无法打开浏览器采集箱")?;
        let paths: Vec<_> = candidates
            .into_iter()
            .filter_map(|candidate| {
                let metadata = fs::symlink_metadata(&candidate).ok()?;
                if !metadata.file_type().is_file() {
                    return None;
                }
                #[cfg(windows)]
                if std::os::windows::fs::MetadataExt::file_attributes(&metadata) & 0x400 != 0 {
                    return None;
                }
                let candidate = fs::canonicalize(candidate).ok()?;
                (candidate.parent() == Some(inbox.as_path())).then_some(candidate)
            })
            .collect();
        let missing = ids.len() - paths.len();
        Ok((paths, missing))
    }

    pub(crate) fn managed_import_directory(&self, workspace_id: &str) -> Result<PathBuf, String> {
        if workspace_id != "personal" && Uuid::parse_str(workspace_id).is_err() {
            return Err("个人库编号无效".into());
        }
        let imports = self.0.root.join("imports");
        let directory = imports.join(workspace_id);
        private_directory(&self.0.root)
            .and_then(|()| private_directory(&imports))
            .and_then(|()| private_directory(&directory))
            .and_then(|()| fs::canonicalize(directory))
            .map_err(|_| "无法打开该个人库的默认采集目录".into())
    }

    fn source<'a>(&self, headers: &'a HeaderMap) -> Option<&'a HeaderValue> {
        if single_header(headers, header::HOST)? != &self.0.host {
            return None;
        }
        let origin = single_header(headers, header::ORIGIN)?;
        valid_extension_origin(origin.to_str().ok()?).then_some(origin)
    }

    fn begin_pairing(&self) -> Result<String, &'static str> {
        let code = format!("{:08}", Uuid::new_v4().as_u128() % 100_000_000);
        self.0
            .keys
            .lock()
            .map_err(|_| "暂时无法生成配对码")?
            .challenge = Some(Challenge {
            code: code.clone(),
            until: Instant::now() + Duration::from_secs(PAIR_SECONDS),
            remaining: PAIR_ATTEMPTS,
        });
        Ok(code)
    }

    fn pair(&self, origin: &str, code: &str) -> Result<String, (StatusCode, &'static str)> {
        let denied = (
            StatusCode::UNAUTHORIZED,
            "配对码无效或已过期，请在 Nexus 中重新生成",
        );
        let unavailable = (StatusCode::INTERNAL_SERVER_ERROR, "无法保存扩展配对");
        let mut keys = self.0.keys.lock().map_err(|_| unavailable)?;
        let challenge = keys.challenge.as_mut().ok_or(denied)?;
        if challenge.until <= Instant::now() || challenge.remaining == 0 {
            return Err(denied);
        }
        if challenge.code != code {
            challenge.remaining -= 1;
            return Err(denied);
        }
        if keys.grants.len() >= MAX_GRANTS && !keys.grants.contains_key(origin) {
            return Err((StatusCode::CONFLICT, "浏览器扩展配对数量已达上限"));
        }
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut grants = keys.grants.clone();
        grants.insert(origin.to_owned(), Sha256::digest(token.as_bytes()).into());
        private_directory(&self.0.root).map_err(|_| unavailable)?;
        let file = tempfile::NamedTempFile::new_in(&self.0.root).map_err(|_| unavailable)?;
        serde_json::to_writer(file.as_file(), &grants).map_err(|_| unavailable)?;
        file.as_file().sync_all().map_err(|_| unavailable)?;
        file.persist(self.0.root.join("grants.json"))
            .map_err(|_| unavailable)?;
        keys.grants = grants;
        keys.challenge = None;
        Ok(token)
    }

    fn authorized(&self, origin: &str, headers: &HeaderMap) -> bool {
        let Some(token) = single_header(headers, header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|line| line.strip_prefix("Bearer "))
            .filter(|token| {
                token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        else {
            return false;
        };
        let digest = Sha256::digest(token.as_bytes());
        self.0.keys.lock().is_ok_and(|keys| {
            keys.grants.get(origin).is_some_and(|stored| {
                stored
                    .iter()
                    .zip(digest)
                    .fold(0, |difference, (left, right)| difference | (*left ^ right))
                    == 0
            })
        })
    }

    async fn save(self, id: Uuid, input: CaptureInput) {
        let saved = self.save_input(id, input).await;
        let Ok(mut captures) = self.0.captures.lock() else {
            return;
        };
        if let Some(row) = captures.iter_mut().find(|entry| entry.id == id) {
            match saved {
                Ok((kind, message, file)) => {
                    row.kind = kind;
                    row.state = "saved";
                    row.message = message;
                    row.file = file;
                }
                Err(message) => {
                    row.state = "failed";
                    row.message = message;
                }
            }
        }
    }

    async fn save_input(
        &self,
        id: Uuid,
        input: CaptureInput,
    ) -> Result<(Kind, &'static str, Option<String>), &'static str> {
        let inbox = self.inbox();
        private_directory(&self.0.root)
            .and_then(|()| private_directory(&inbox))
            .map_err(|_| "无法打开浏览器收集箱")?;
        let name = format!("{}-{}", filename(&input.title), id.simple());
        if let Some((format, encoded)) = input.screenshot {
            let path = inbox.join(format!("{name}.{format}"));
            return tokio::task::spawn_blocking(move || {
                save_screenshot(format, &encoded, &inbox, &path)?;
                Ok((
                    Kind::Image,
                    "已保存网页截图",
                    Some(nexus_core::clean_path(&path)),
                ))
            })
            .await
            .map_err(|_| "无法保存网页截图")?;
        }
        if let (Some(media), Kind::Image | Kind::Video) = (&input.media, input.kind) {
            if let Ok(Ok(path)) = tokio::time::timeout(
                DOWNLOAD_TIMEOUT,
                save_media(media.clone(), input.kind, &inbox, &name),
            )
            .await
            {
                return Ok((
                    input.kind,
                    "已保存到浏览器收集箱",
                    Some(nexus_core::clean_path(&path)),
                ));
            }
        }
        let target = if matches!(input.kind, Kind::Link) {
            input.media.as_ref().or(input.page.as_ref())
        } else {
            input.page.as_ref().or(input.media.as_ref())
        }
        .ok_or("没有可保存的公开网页地址")?;
        let text = format!("[InternetShortcut]\r\nURL={}\r\n", target.as_str());
        let mut file =
            tempfile::NamedTempFile::new_in(&inbox).map_err(|_| "无法写入浏览器收集箱")?;
        std::io::Write::write_all(file.as_file_mut(), text.as_bytes())
            .map_err(|_| "无法写入浏览器收集箱")?;
        file.persist_noclobber(inbox.join(format!("{name}.url")))
            .map_err(|_| "无法保存网页链接")?;
        Ok((
            Kind::Link,
            if matches!(input.kind, Kind::Link) {
                "已保存网页链接"
            } else {
                "无法直接保存媒体，已记录网页链接"
            },
            None,
        ))
    }
}

fn single_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&HeaderValue> {
    let mut found = headers.get_all(name).iter();
    found.next().filter(|_| found.next().is_none())
}

fn valid_extension_origin(value: &str) -> bool {
    value
        .strip_prefix("chrome-extension://")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
}

fn reply(origin: &HeaderValue, status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    apply_cors(&mut response, origin);
    response
}

fn apply_cors(response: &mut Response, origin: &HeaderValue) {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

async fn preflight(State(receiver): State<BrowserCapture>, headers: HeaderMap) -> Response {
    let Some(origin) = receiver.source(&headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    apply_cors(&mut response, origin);
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("POST"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type"),
    );
    headers.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    response
}

async fn pair(
    State(receiver): State<BrowserCapture>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Response {
    let Some(origin) = receiver.source(&headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    match receiver.pair(origin.to_str().unwrap_or_default(), &request.code) {
        Ok(token) => reply(origin, StatusCode::OK, json!({"token":token})),
        Err((status, message)) => reply(origin, status, json!({"message":message})),
    }
}

async fn capture(
    State(receiver): State<BrowserCapture>,
    headers: HeaderMap,
    Json(request): Json<CaptureRequest>,
) -> Response {
    let Some(origin) = receiver.source(&headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !receiver.authorized(origin.to_str().unwrap_or_default(), &headers) {
        return reply(
            origin,
            StatusCode::UNAUTHORIZED,
            json!({"message":"请先在 Nexus 中配对此浏览器扩展"}),
        );
    }
    let Some(input) = checked_capture(request) else {
        return reply(
            origin,
            StatusCode::BAD_REQUEST,
            json!({"message":"没有可收集的公开 HTTPS 地址"}),
        );
    };
    enqueue(receiver, origin, input)
}

async fn capture_screenshot(
    State(receiver): State<BrowserCapture>,
    headers: HeaderMap,
    request: axum::extract::Request,
) -> Response {
    let Some(origin) = receiver.source(&headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !receiver.authorized(origin.to_str().unwrap_or_default(), &headers) {
        return reply(
            origin,
            StatusCode::UNAUTHORIZED,
            json!({"message":"请先在 Nexus 中配对此浏览器扩展"}),
        );
    }
    let Json(request) =
        match <Json<ScreenshotRequest> as axum::extract::FromRequest<()>>::from_request(
            request,
            &(),
        )
        .await
        {
            Ok(payload) => payload,
            Err(error) => {
                return reply(
                    origin,
                    error.status(),
                    json!({"message":"截图太大或数据无效"}),
                )
            }
        };
    let Some((prefix, encoded)) = request.data_url.split_once(',') else {
        return reply(
            origin,
            StatusCode::BAD_REQUEST,
            json!({"message":"截图数据无效"}),
        );
    };
    let format = match prefix {
        "data:image/jpeg;base64" => "jpg",
        "data:image/png;base64" => "png",
        _ => {
            return reply(
                origin,
                StatusCode::BAD_REQUEST,
                json!({"message":"请使用 JPEG 或 PNG 截图"}),
            )
        }
    };
    if encoded.is_empty() || encoded.len() > MAX_SCREENSHOT_BASE64 {
        return reply(
            origin,
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"message":"截图太大或数据为空"}),
        );
    }
    let page = request.page_url.as_deref().and_then(public_address);
    let title = capture_title(request.title.as_deref(), page.as_ref(), "网页截图");
    enqueue(
        receiver,
        origin,
        CaptureInput {
            kind: Kind::Image,
            media: None,
            page,
            title,
            screenshot: Some((format, encoded.to_owned())),
        },
    )
}

fn enqueue(receiver: BrowserCapture, origin: &HeaderValue, input: CaptureInput) -> Response {
    let Ok(slot) = receiver.0.slots.clone().try_acquire_owned() else {
        return reply(
            origin,
            StatusCode::TOO_MANY_REQUESTS,
            json!({"message":"正在接收其他内容，请稍后重试"}),
        );
    };
    let id = Uuid::new_v4();
    let kind = input.kind;
    let message = "已发送到 Nexus 浏览器收集箱";
    if let Ok(mut rows) = receiver.0.captures.lock() {
        rows.push_front(CaptureSummary {
            id,
            kind,
            title: input.title.clone(),
            state: "queued",
            message,
            created: nexus_core::now(),
            file: None,
        });
        rows.truncate(MAX_HISTORY);
    }
    tokio::spawn(async move {
        let _slot = slot;
        receiver.save(id, input).await;
    });
    reply(
        origin,
        StatusCode::ACCEPTED,
        json!({"message":message,"kind":kind}),
    )
}

fn checked_capture(request: CaptureRequest) -> Option<CaptureInput> {
    if request.mime.as_ref().is_some_and(|mime| mime.len() > 128) {
        return None;
    }
    let media = public_address(&request.url);
    let page = request.page_url.as_deref().and_then(public_address);
    let source = media.as_ref().or(page.as_ref())?;
    let title = capture_title(request.title.as_deref(), Some(source), "浏览器收集");
    Some(CaptureInput {
        kind: request.kind,
        media,
        page,
        title,
        screenshot: None,
    })
}

fn capture_title(title: Option<&str>, source: Option<&Url>, fallback: &str) -> String {
    title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| source.and_then(Url::host_str).unwrap_or(fallback))
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect()
}

fn public_address(value: &str) -> Option<Url> {
    let url = crate::subscription_feed::source_url(value).ok()?;
    if url.port_or_known_default() != Some(443)
        || url
            .domain()
            .is_some_and(|domain| !domain.contains('.') || domain.ends_with('.'))
    {
        return None;
    }
    Some(url)
}

fn private_directory(directory: &Path) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    let attributes = directory.symlink_metadata()?;
    #[cfg(windows)]
    let reparse = std::os::windows::fs::MetadataExt::file_attributes(&attributes) & 0x400 != 0;
    #[cfg(not(windows))]
    let reparse = attributes.file_type().is_symlink();
    if !attributes.is_dir() || reparse {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid browser inbox directory",
        ));
    }
    Ok(())
}

fn filename(title: &str) -> String {
    let name: String = title
        .chars()
        .take(56)
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        "浏览器收集".into()
    } else {
        name.into()
    }
}

fn save_screenshot(
    format: &str,
    encoded: &str,
    inbox: &Path,
    path: &Path,
) -> Result<(), &'static str> {
    let invalid = "网页截图格式或大小无效";
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid)?;
    if bytes.len() > MAX_SCREENSHOT || !media_signature(format, &bytes) {
        return Err(invalid);
    }
    let image_format = if format == "png" {
        image::ImageFormat::Png
    } else {
        image::ImageFormat::Jpeg
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), image_format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(160 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| invalid)?;

    let write_error = "无法保存网页截图";
    let mut file = tempfile::NamedTempFile::new_in(inbox).map_err(|_| write_error)?;
    std::io::Write::write_all(file.as_file_mut(), &bytes).map_err(|_| write_error)?;
    file.persist_noclobber(path).map_err(|_| write_error)?;
    Ok(())
}

async fn save_media(mut url: Url, kind: Kind, inbox: &Path, name: &str) -> Result<PathBuf, ()> {
    let limit = if matches!(kind, Kind::Image) {
        MAX_IMAGE
    } else {
        MAX_VIDEO
    };
    for redirects in 0..=3 {
        let mut response = crate::subscription_feed::client_for(&url)
            .await
            .map_err(|_| ())?
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity")
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|_| ())?;
        if matches!(
            response.status(),
            StatusCode::MOVED_PERMANENTLY
                | StatusCode::FOUND
                | StatusCode::SEE_OTHER
                | StatusCode::TEMPORARY_REDIRECT
                | StatusCode::PERMANENT_REDIRECT
        ) {
            if redirects == 3 {
                return Err(());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(())?;
            url = public_address(url.join(location).map_err(|_| ())?.as_str()).ok_or(())?;
            continue;
        }
        if response.status() != StatusCode::OK
            || response.content_length().is_some_and(|bytes| bytes > limit)
        {
            return Err(());
        }
        let format = allowed_media(kind, response.headers()).ok_or(())?;
        let mut prefix = Vec::new();
        while prefix.len() < 16 {
            let Some(chunk) = response.chunk().await.map_err(|_| ())? else {
                break;
            };
            prefix.extend_from_slice(&chunk);
        }
        if prefix.len() as u64 > limit || !media_signature(format, &prefix) {
            return Err(());
        }
        let temporary = tempfile::NamedTempFile::new_in(inbox).map_err(|_| ())?;
        let mut file = tokio::fs::File::from_std(temporary.reopen().map_err(|_| ())?);
        file.write_all(&prefix).await.map_err(|_| ())?;
        let mut size = prefix.len() as u64;
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            size += chunk.len() as u64;
            if size > limit {
                return Err(());
            }
            file.write_all(&chunk).await.map_err(|_| ())?;
        }
        file.flush().await.map_err(|_| ())?;
        drop(file);
        let path = inbox.join(format!("{name}.{format}"));
        temporary.persist_noclobber(&path).map_err(|_| ())?;
        return Ok(path);
    }
    Err(())
}

fn allowed_media(kind: Kind, headers: &HeaderMap) -> Option<&'static str> {
    let value = headers.get(header::CONTENT_TYPE)?.to_str().ok()?;
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    match (kind, mime.as_str()) {
        (Kind::Image, "image/jpeg") => Some("jpg"),
        (Kind::Image, "image/png") => Some("png"),
        (Kind::Image, "image/webp") => Some("webp"),
        (Kind::Image, "image/gif") => Some("gif"),
        (Kind::Image, "image/avif") => Some("avif"),
        (Kind::Image, "image/bmp") => Some("bmp"),
        (Kind::Image, "image/tiff") => Some("tif"),
        (Kind::Video, "video/mp4") => Some("mp4"),
        (Kind::Video, "video/webm") => Some("webm"),
        (Kind::Video, "video/ogg") => Some("ogv"),
        (Kind::Video, "video/quicktime") => Some("mov"),
        _ => None,
    }
}

fn media_signature(format: &str, bytes: &[u8]) -> bool {
    match format {
        "jpg" => bytes.starts_with(b"\xff\xd8\xff"),
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "avif" => matches!(bytes.get(4..12), Some(b"ftypavif" | b"ftypavis")),
        "bmp" => bytes.starts_with(b"BM"),
        "tif" => bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*"),
        "mp4" | "mov" => bytes.get(4..8) == Some(b"ftyp"),
        "webm" => bytes.starts_with(b"\x1a\x45\xdf\xa3"),
        "ogv" => bytes.starts_with(b"OggS"),
        _ => false,
    }
}

#[tauri::command]
pub(crate) fn browser_capture_pairing(
    state: tauri::State<'_, BrowserCapture>,
) -> Result<Value, String> {
    let code = state.begin_pairing()?;
    Ok(json!({"code":code,"expiresInSeconds":PAIR_SECONDS}))
}

#[tauri::command]
pub(crate) fn browser_capture_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserCapture>,
) -> Result<Value, String> {
    let (paired, pairing_pending) = {
        let keys = state.0.keys.lock().map_err(|_| "无法读取配对")?;
        let pending = keys
            .challenge
            .as_ref()
            .is_some_and(|challenge| challenge.remaining > 0 && challenge.until > Instant::now());
        (!keys.grants.is_empty(), pending)
    };
    let captures: Vec<_> = state
        .0
        .captures
        .lock()
        .map_err(|_| "无法读取收集记录")?
        .iter()
        .cloned()
        .collect();
    let extension = app
        .path()
        .resource_dir()
        .ok()
        .map(|root| root.join("browser-extension"));
    Ok(
        json!({"paired":paired,"pairingPending":pairing_pending,"captures":captures,"inbox":nexus_core::clean_path(&state.inbox()),
        "extensionPath":extension.as_deref().map(nexus_core::clean_path)}),
    )
}

#[tauri::command]
pub(crate) async fn browser_capture_open_inbox(
    state: tauri::State<'_, BrowserCapture>,
) -> Result<bool, String> {
    private_directory(&state.0.root)
        .and_then(|()| private_directory(&state.inbox()))
        .map_err(|_| "无法打开浏览器收集箱")?;
    crate::open_folder_location(state.inbox()).await?;
    Ok(true)
}

#[tauri::command]
pub(crate) async fn browser_capture_open_extension(app: tauri::AppHandle) -> Result<bool, String> {
    let directory = app
        .path()
        .resource_dir()
        .map_err(|_| "无法找到浏览器扩展目录")?
        .join("browser-extension");
    if !directory.join("manifest.json").is_file() {
        return Err("这个安装包没有浏览器扩展文件".into());
    }
    crate::open_folder_location(directory).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXTENSION: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER_EXTENSION: &str = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn capture_requires_an_origin_bound_single_use_pairing_and_saves_a_local_shortcut() {
        tauri::async_runtime::block_on(async {
            let scratch = tempfile::tempdir().unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let receiver = BrowserCapture::new(scratch.path(), address.port());
            let router = receiver.clone().router();
            let server = tokio::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });
            let http = reqwest::Client::builder().no_proxy().build().unwrap();
            let pair_url = format!("http://{address}/capture/pair");
            let inbox_url = format!("http://{address}/capture");
            let code = receiver.begin_pairing().unwrap();
            for (host, origin) in [
                (address.to_string(), "https://example.com"),
                ("other.invalid".to_owned(), EXTENSION),
            ] {
                let response = http
                    .post(&pair_url)
                    .header(header::HOST, host)
                    .header(header::ORIGIN, origin)
                    .json(&json!({"code":code}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
                assert!(!response
                    .headers()
                    .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
            }
            let preflight = http
                .request(reqwest::Method::OPTIONS, &inbox_url)
                .header(header::ORIGIN, EXTENSION)
                .send()
                .await
                .unwrap();
            assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
            assert_eq!(
                preflight.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                EXTENSION
            );

            let response = http
                .post(&pair_url)
                .header(header::ORIGIN, EXTENSION)
                .json(&json!({"code":code}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let grant: Value = response.json().await.unwrap();
            let token = grant["token"].as_str().unwrap();
            let repeat = http
                .post(&pair_url)
                .header(header::ORIGIN, OTHER_EXTENSION)
                .json(&json!({"code":code}))
                .send()
                .await
                .unwrap();
            assert_eq!(repeat.status(), StatusCode::UNAUTHORIZED);
            let grants = fs::read_to_string(receiver.0.root.join("grants.json")).unwrap();
            assert!(!grants.contains(token));
            let restored = BrowserCapture::new(scratch.path(), address.port());
            let mut authorization = HeaderMap::new();
            authorization.insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
            assert!(restored.authorized(EXTENSION, &authorization));
            assert!(!restored.authorized(OTHER_EXTENSION, &authorization));

            let protected_mp4 = json!({"kind":"video","url":"blob:https://example.com/video","title":"Fixture / Video","pageUrl":"https://example.com/work"});
            let unauthorized = http
                .post(&inbox_url)
                .header(header::ORIGIN, OTHER_EXTENSION)
                .bearer_auth(token)
                .json(&protected_mp4)
                .send()
                .await
                .unwrap();
            assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
            let local = http
                .post(&inbox_url)
                .header(header::ORIGIN, EXTENSION)
                .bearer_auth(token)
                .json(&json!({"kind":"image","url":"https://127.0.0.1/no"}))
                .send()
                .await
                .unwrap();
            assert_eq!(local.status(), StatusCode::BAD_REQUEST);
            let accepted = http
                .post(&inbox_url)
                .header(header::ORIGIN, EXTENSION)
                .bearer_auth(token)
                .json(&protected_mp4)
                .send()
                .await
                .unwrap();
            assert_eq!(accepted.status(), StatusCode::ACCEPTED);
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if receiver
                        .0
                        .captures
                        .lock()
                        .unwrap()
                        .front()
                        .is_some_and(|capture| capture.state == "saved")
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let output = fs::read_dir(receiver.inbox())
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            assert_eq!(output.extension().unwrap(), "url");
            assert_eq!(
                fs::read_to_string(output).unwrap(),
                "[InternetShortcut]\r\nURL=https://example.com/work\r\n"
            );

            let screenshot_url = format!("{inbox_url}/screenshot");
            let mut png = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(320, 180)
                .write_to(&mut png, image::ImageFormat::Png)
                .unwrap();
            let png = png.into_inner();
            let screenshot = json!({
                "title": "网页截图",
                "pageUrl": "https://example.com/work",
                "dataUrl": format!("data:image/png;base64,{}", STANDARD.encode(&png)),
            });
            let screenshot_response = |origin: &str, body: &Value| {
                http.post(&screenshot_url)
                    .header(header::ORIGIN, origin)
                    .bearer_auth(token)
                    .json(body)
                    .send()
            };
            assert_eq!(
                screenshot_response(OTHER_EXTENSION, &screenshot)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                screenshot_response(
                    EXTENSION,
                    &json!({"dataUrl":"data:image/svg+xml;base64,AAAA"})
                )
                .await
                .unwrap()
                .status(),
                StatusCode::BAD_REQUEST
            );
            assert_eq!(
                screenshot_response(EXTENSION, &screenshot)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::ACCEPTED
            );
            let path = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let saved = receiver
                        .0
                        .captures
                        .lock()
                        .unwrap()
                        .front()
                        .and_then(|entry| entry.file.clone());
                    if let Some(path) = saved {
                        break path;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(fs::read(path).unwrap(), png);
            server.abort();
        });
    }

    #[test]
    fn unsupported_active_or_streaming_content_is_not_saved_as_a_media_file() {
        let mut headers = HeaderMap::new();
        for mime in [
            "image/svg+xml",
            "text/html",
            "application/vnd.apple.mpegurl",
        ] {
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            assert!(allowed_media(Kind::Image, &headers).is_none());
            assert!(allowed_media(Kind::Video, &headers).is_none());
        }
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
        assert_eq!(allowed_media(Kind::Video, &headers), Some("mp4"));
        assert!(!media_signature("mp4", b"<html>test</html>"));
        assert!(media_signature("mp4", b"\0\0\0\x18ftypmp42"));
    }
}
