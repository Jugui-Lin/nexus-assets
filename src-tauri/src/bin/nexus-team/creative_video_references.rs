use super::{
    creative_subscriptions::checked_url, db_error, error, with_member, ApiError, ApiResult, Store,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use nexus_core::creative_subscriptions::{
    RemoveVideoReference, SaveVideoReference, VideoReference, VideoReferenceInput, VideoReferences,
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use url::Url;

const MAX_REFERENCES: usize = 120;

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS creative_video_reference_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton=1),
            revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO creative_video_reference_state VALUES (1,0);
        CREATE TABLE IF NOT EXISTS creative_video_references (
            key TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            cover_url TEXT NOT NULL,
            revision INTEGER NOT NULL,
            created_revision INTEGER NOT NULL,
            removed INTEGER NOT NULL DEFAULT 0
        );",
    )
}

pub(super) fn routes() -> Router<Store> {
    Router::new().route(
        "/v1/creative-video-references",
        get(list)
            .put(save)
            .delete(remove)
            .layer(DefaultBodyLimit::max(16 * 1024)),
    )
}

fn video_url(value: &str) -> Result<Url, ApiError> {
    let invalid = || error(StatusCode::BAD_REQUEST, "请输入有效的公开视频网址");
    let url = checked_url(value, false).map_err(|_| invalid())?;
    let domain = url.domain().unwrap_or_default().trim_end_matches('.');
    if domain == "home.arpa" || domain.ends_with(".home.arpa") {
        return Err(invalid());
    }
    Ok(url)
}

fn number_id(value: &str, max_digits: usize) -> bool {
    !value.is_empty()
        && !value.starts_with('0')
        && value.len() <= max_digits
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn youtube_id(url: &Url, domain: &str) -> Option<String> {
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let id = match domain {
        "youtu.be" => path.strip_prefix('/')?.to_owned(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" if url.path() == "/watch" => url
            .query_pairs()
            .find(|(name, _)| name == "v")?
            .1
            .into_owned(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" => {
            let (kind, id) = path.strip_prefix('/')?.split_once('/')?;
            matches!(kind, "shorts" | "live" | "embed").then(|| id.to_owned())?
        }
        "youtube-nocookie.com" | "www.youtube-nocookie.com" => {
            path.strip_prefix("/embed/")?.to_owned()
        }
        _ => return None,
    };
    (id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    .then_some(id)
}

fn bilibili_key(url: &Url) -> Option<String> {
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let mut key = String::from("https://player.bilibili.com/player.html?");
    if let Some(episode) = path
        .strip_prefix("/bangumi/play/ep")
        .filter(|id| number_id(id, 20))
    {
        key.push_str("episodeId=");
        key.push_str(episode);
    } else {
        let (kind, video) = path.strip_prefix('/')?.split_once('/')?;
        if !kind.eq_ignore_ascii_case("video") {
            return None;
        }
        let prefix = video.get(..2)?;
        let id = video.get(2..)?;
        if prefix.eq_ignore_ascii_case("bv")
            && id.len() == 10
            && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            key.push_str("bvid=BV");
        } else if prefix.eq_ignore_ascii_case("av") && number_id(id, 20) {
            key.push_str("aid=");
        } else {
            return None;
        }
        key.push_str(id);
        if let Some((_, part)) = url.query_pairs().find(|(name, _)| name == "p") {
            if number_id(&part, 4) {
                key.push_str("&p=");
                key.push_str(&part);
            }
        }
    }
    key.push_str("&autoplay=1&danmaku=0");
    Some(key)
}

fn reference_key(url: &Url) -> String {
    if url.scheme() == "https" && url.port().is_none() {
        let domain = url.domain().unwrap_or_default();
        if let Some(id) = youtube_id(url, domain) {
            return format!("https://www.youtube.com/embed/{id}?autoplay=1&playsinline=1");
        }
        if matches!(
            domain,
            "bilibili.com" | "www.bilibili.com" | "m.bilibili.com"
        ) {
            if let Some(key) = bilibili_key(url) {
                return key;
            }
        }
        if matches!(domain, "xinpianchang.com" | "www.xinpianchang.com") {
            let path = url.path().strip_suffix('/').unwrap_or(url.path());
            if let Some(id) = path.strip_prefix("/a").filter(|id| number_id(id, 20)) {
                return format!("xinpianchang:{id}");
            }
        }
    }
    url.as_str().into()
}

fn cover_url(value: &str) -> String {
    checked_url(value, true)
        .ok()
        .filter(|url| {
            url.port().is_none()
                && url.domain().is_some_and(|domain| {
                    domain.ends_with(".hdslb.com")
                        || matches!(
                            domain,
                            "i.ytimg.com"
                                | "i1.ytimg.com"
                                | "i2.ytimg.com"
                                | "i3.ytimg.com"
                                | "i4.ytimg.com"
                                | "yt3.googleusercontent.com"
                                | "yt3.ggpht.com"
                                | "oss-xpc0.xpccdn.com"
                        )
                })
        })
        .map_or_else(String::new, String::from)
}

fn read(row: &Row<'_>) -> rusqlite::Result<VideoReference> {
    Ok(VideoReference {
        key: row.get(0)?,
        revision: row.get(1)?,
        reference: VideoReferenceInput {
            url: row.get(2)?,
            title: row.get(3)?,
            cover_url: row.get(4)?,
        },
    })
}

fn snapshot(conn: &Connection) -> Result<VideoReferences, ApiError> {
    let revision = conn
        .query_row(
            "SELECT revision FROM creative_video_reference_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let mut query = conn
        .prepare(
            "SELECT key,revision,url,title,cover_url FROM creative_video_references
         WHERE removed=0 ORDER BY created_revision DESC",
        )
        .map_err(db_error)?;
    let references = query
        .query_map([], read)
        .map_err(db_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db_error)?;
    Ok(VideoReferences {
        available: true,
        references,
        revision,
    })
}

fn current(conn: &Connection, key: &str) -> Result<Option<(VideoReference, bool)>, ApiError> {
    conn.query_row(
        "SELECT key,revision,url,title,cover_url,removed FROM creative_video_references WHERE key=?1",
        [key],
        |row| Ok((read(row)?, row.get(5)?)),
    ).optional().map_err(db_error)
}

fn next_revision(conn: &Connection) -> Result<u64, ApiError> {
    conn.query_row(
        "UPDATE creative_video_reference_state SET revision=revision+1 WHERE singleton=1
         RETURNING revision",
        [],
        |row| row.get(0),
    )
    .map_err(db_error)
}

fn stale() -> ApiError {
    error(
        StatusCode::CONFLICT,
        "团队成员已修改这条视频引用，请刷新后重试",
    )
}

async fn list(State(store): State<Store>, headers: HeaderMap) -> ApiResult<VideoReferences> {
    with_member(store, headers, |conn, _| {
        let tx = conn.transaction().map_err(db_error)?;
        let result = snapshot(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    })
    .await
}

async fn save(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(input): Json<SaveVideoReference>,
) -> ApiResult<VideoReferences> {
    with_member(store, headers, move |conn, _| {
        if input.migration && input.revision.is_some() {
            return Err(error(StatusCode::BAD_REQUEST, "迁移视频引用时无需提供版本号"));
        }
        let mut reference = input.reference;
        let url = video_url(&reference.url)?;
        let key = reference_key(&url);
        reference.url = url.into();
        reference.title = reference.title.trim().chars()
            .map(|ch| if ch.is_control() { ' ' } else { ch })
            .take(120)
            .collect();
        reference.cover_url = cover_url(&reference.cover_url);

        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        let record = current(&tx, &key)?;
        if let Some(expected) = input.revision {
            let Some((existing, false)) = record else {
                return Err(stale());
            };
            if existing.revision != expected {
                return Err(stale());
            }
            if existing.reference.title != reference.title
                || existing.reference.cover_url != reference.cover_url
            {
                let revision = next_revision(&tx)?;
                tx.execute(
                    "UPDATE creative_video_references SET title=?2,cover_url=?3,revision=?4 WHERE key=?1",
                    params![key, reference.title, reference.cover_url, revision],
                ).map_err(db_error)?;
            }
        } else if !matches!(record, Some((_, false))) && (!input.migration || record.is_none()) {
            // Keep removed keys so a teammate's older local copy cannot restore them.
            let count: usize = tx.query_row(
                "SELECT COUNT(*) FROM creative_video_references WHERE removed=0",
                [],
                |row| row.get(0),
            ).map_err(db_error)?;
            if count >= MAX_REFERENCES {
                return Err(error(StatusCode::CONFLICT, "团队视频引用已达到 120 条"));
            }
            let revision = next_revision(&tx)?;
            tx.execute(
                "INSERT INTO creative_video_references (key,url,title,cover_url,revision,created_revision)
                 VALUES (?1,?2,?3,?4,?5,?5)
                 ON CONFLICT(key) DO UPDATE SET url=excluded.url,title=excluded.title,
                 cover_url=excluded.cover_url,revision=excluded.revision,
                 created_revision=excluded.created_revision,removed=0",
                params![key, reference.url, reference.title, reference.cover_url, revision],
            ).map_err(db_error)?;
        }
        let result = snapshot(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }).await
}

async fn remove(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(input): Json<RemoveVideoReference>,
) -> ApiResult<VideoReferences> {
    with_member(store, headers, move |conn, _| {
        let key = reference_key(&video_url(&input.url)?);
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if let Some((existing, false)) = current(&tx, &key)? {
            if existing.revision != input.revision {
                return Err(stale());
            }
            let revision = next_revision(&tx)?;
            tx.execute(
                "UPDATE creative_video_references
                 SET url='',title='',cover_url='',revision=?2,removed=1 WHERE key=?1",
                params![key, revision],
            )
            .map_err(db_error)?;
        }
        let result = snapshot(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    })
    .await
}
