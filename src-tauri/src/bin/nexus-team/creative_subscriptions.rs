use super::{db_error, error, with_member, ApiError, ApiResult, Store};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch},
    Json, Router,
};
use nexus_core::creative_subscriptions::*;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use url::{Host, Url};
use uuid::Uuid;

const MAX_CREATORS: usize = 100;
const MAX_URL_BYTES: usize = 2048;
const COLUMNS: &str = "id,revision,url,name,detected_name,feed,avatar_url,bio";

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS creative_subscriptions (
            id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL CHECK (revision > 0),
            url TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            detected_name TEXT NOT NULL,
            feed TEXT NOT NULL,
            avatar_url TEXT NOT NULL,
            bio TEXT NOT NULL
        );",
    )
}

pub(super) fn routes() -> Router<Store> {
    Router::new()
        .route(
            "/v1/creative-subscriptions",
            get(list)
                .post(create)
                .layer(DefaultBodyLimit::max(12 * 1024)),
        )
        .route(
            "/v1/creative-subscriptions/{id}",
            patch(update)
                .delete(remove)
                .layer(DefaultBodyLimit::max(12 * 1024)),
        )
}

pub(super) fn checked_url(value: &str, https_only: bool) -> Result<Url, ApiError> {
    let invalid = || {
        error(
            StatusCode::BAD_REQUEST,
            "请输入可公开访问的创作者主页或 HTTPS 订阅源地址",
        )
    };
    let value = value.trim();
    if value.len() > MAX_URL_BYTES || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    if url.as_str().len() > MAX_URL_BYTES
        || (url.scheme() != "https" && (https_only || url.scheme() != "http"))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    // Sharing subscriptions should only publish URLs with a public hostname.
    let Some(Host::Domain(host)) = url.host() else {
        return Err(invalid());
    };
    let host = host.trim_end_matches('.');
    if !host.contains('.')
        || [".localhost", ".local", ".internal", ".lan", ".home"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return Err(invalid());
    }
    Ok(url)
}

fn creator_url(value: &str) -> Result<String, ApiError> {
    let mut url = checked_url(value, false)?;
    if url.domain() == Some("space.bilibili.com") {
        let id = url.path().trim_matches('/');
        if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()) {
            let path = format!("/{id}");
            url.set_path(&path);
            url.set_query(None);
            url.set_fragment(None);
        }
    }
    Ok(url.into())
}

fn text(value: &str, maximum: usize) -> Result<String, ApiError> {
    let value = value.trim();
    if value.chars().count() > maximum || value.chars().any(char::is_control) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "订阅名称或简介超出长度限制或包含控制字符",
        ));
    }
    Ok(value.to_owned())
}

fn clean(mut input: CreatorInput) -> Result<CreatorInput, ApiError> {
    input.url = creator_url(&input.url)?;
    input.name = text(&input.name, 120)?;
    input.detected_name = text(&input.detected_name, 120)?;
    input.bio = text(&input.bio, 400)?;
    if !input.feed.trim().is_empty() {
        input.feed = checked_url(&input.feed, true)?.into();
    } else {
        input.feed.clear();
    }
    // Avatar metadata is optional. Only the existing public media sources are rendered by desktop.
    input.avatar_url = checked_url(&input.avatar_url, true)
        .ok()
        .filter(|url| {
            url.port().is_none()
                && url.domain().is_some_and(|domain| {
                    domain.ends_with(".hdslb.com")
                        || matches!(
                            domain,
                            "i.ytimg.com" | "yt3.googleusercontent.com" | "yt3.ggpht.com"
                        )
                })
        })
        .map_or_else(String::new, String::from);
    Ok(input)
}

fn read(row: &Row<'_>) -> rusqlite::Result<CreatorSubscription> {
    Ok(CreatorSubscription {
        id: row.get(0)?,
        revision: row.get(1)?,
        creator: CreatorInput {
            url: row.get(2)?,
            name: row.get(3)?,
            detected_name: row.get(4)?,
            feed: row.get(5)?,
            avatar_url: row.get(6)?,
            bio: row.get(7)?,
        },
    })
}

fn by_id(conn: &Connection, id: &str) -> Result<Option<CreatorSubscription>, ApiError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM creative_subscriptions WHERE id=?1"),
        [id],
        read,
    )
    .optional()
    .map_err(db_error)
}

fn by_url(conn: &Connection, url: &str) -> Result<Option<CreatorSubscription>, ApiError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM creative_subscriptions WHERE url=?1"),
        [url],
        read,
    )
    .optional()
    .map_err(db_error)
}

fn creator_id(id: &str) -> Result<String, ApiError> {
    Uuid::parse_str(id)
        .map(|id| id.to_string())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "订阅编号无效"))
}

fn stale() -> ApiError {
    error(StatusCode::CONFLICT, "团队成员已修改这条订阅，请刷新后重试")
}

async fn list(State(store): State<Store>, headers: HeaderMap) -> ApiResult<CreatorSubscriptions> {
    with_member(store, headers, |conn, _| {
        let mut statement = conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM creative_subscriptions ORDER BY rowid"
            ))
            .map_err(db_error)?;
        let subscriptions = statement
            .query_map([], read)
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        Ok(CreatorSubscriptions {
            available: true,
            subscriptions,
        })
    })
    .await
}

async fn create(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(input): Json<CreatorInput>,
) -> ApiResult<CreatorCreated> {
    with_member(store, headers, |conn, _| {
        let creator = clean(input)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        if let Some(subscription) = by_url(&tx, &creator.url)? {
            return Ok(CreatorCreated { subscription, created: false });
        }
        let count: usize = tx.query_row("SELECT COUNT(*) FROM creative_subscriptions", [], |row| row.get(0))
            .map_err(db_error)?;
        if count >= MAX_CREATORS {
            return Err(error(StatusCode::CONFLICT, "团队订阅已达到 100 位创作者"));
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO creative_subscriptions
                (id,revision,url,name,detected_name,feed,avatar_url,bio) VALUES (?1,1,?2,?3,?4,?5,?6,?7)",
            params![id, creator.url, creator.name, creator.detected_name, creator.feed, creator.avatar_url, creator.bio],
        ).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(CreatorCreated { subscription: CreatorSubscription { id, revision: 1, creator }, created: true })
    }).await
}

async fn update(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<UpdateCreatorSubscription>,
) -> ApiResult<CreatorUpdated> {
    with_member(store, headers, move |conn, _| {
        let id = creator_id(&id)?;
        let creator = clean(input.subscription)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let current =
            by_id(&tx, &id)?.ok_or_else(|| error(StatusCode::NOT_FOUND, "团队订阅已移除"))?;
        if current.revision != input.revision {
            return Err(stale());
        }
        if current.creator == creator {
            return Ok(CreatorUpdated {
                subscription: current,
            });
        }
        if creator.url != current.creator.url && by_url(&tx, &creator.url)?.is_some() {
            return Err(error(StatusCode::CONFLICT, "团队已订阅该地址"));
        }
        let revision = current.revision + 1;
        tx.execute(
            "UPDATE creative_subscriptions SET revision=?2,url=?3,name=?4,detected_name=?5,
                feed=?6,avatar_url=?7,bio=?8 WHERE id=?1",
            params![
                id,
                revision,
                creator.url,
                creator.name,
                creator.detected_name,
                creator.feed,
                creator.avatar_url,
                creator.bio
            ],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(CreatorUpdated {
            subscription: CreatorSubscription {
                id,
                revision,
                creator,
            },
        })
    })
    .await
}

async fn remove(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<RemoveCreatorSubscription>,
) -> ApiResult<CreatorRemoved> {
    with_member(store, headers, move |conn, _| {
        let id = creator_id(&id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let Some(current) = by_id(&tx, &id)? else {
            return Ok(CreatorRemoved { removed: false });
        };
        if current.revision != input.revision {
            return Err(stale());
        }
        tx.execute("DELETE FROM creative_subscriptions WHERE id=?1", [&id])
            .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(CreatorRemoved { removed: true })
    })
    .await
}
