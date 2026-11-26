use super::{db_error, error, with_member, ApiError, ApiResult, Store};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use nexus_core::browser_sites::{
    BrowserNavigation, BrowserNavigationSnapshot, BrowserNavigationUpdate,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::HashSet;
use url::Url;

const MAX_SITES: usize = 500;
const MAX_CATEGORIES: usize = 512;
const MAX_ICON_LENGTH: usize = 18_000;
const MAX_URL_LENGTH: usize = 2048;
const MAX_BODY_BYTES: usize = 12 * 1024 * 1024;

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS shared_browser_navigation (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            revision INTEGER NOT NULL CHECK(revision > 0),
            navigation TEXT NOT NULL
        );",
    )
}

pub(super) fn routes() -> Router<Store> {
    Router::new().route(
        "/v1/browser-sites",
        get(list)
            .put(save)
            .layer(DefaultBodyLimit::max(MAX_BODY_BYTES)),
    )
}

fn snapshot(conn: &Connection) -> Result<BrowserNavigationSnapshot, ApiError> {
    let row = conn
        .query_row(
            "SELECT revision, navigation FROM shared_browser_navigation WHERE singleton=1",
            [],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let (revision, navigation) = match row {
        Some((revision, data)) => {
            let navigation = serde_json::from_str(&data).map_err(|_| storage_error())?;
            (revision, Some(navigation))
        }
        None => (0, None),
    };
    Ok(BrowserNavigationSnapshot {
        available: true,
        revision,
        navigation,
    })
}

fn storage_error() -> ApiError {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "团队站点导航数据无法读取",
    )
}

fn clean_label(value: &mut String, maximum: usize, required: bool) -> Result<(), ApiError> {
    let trimmed = value.trim();
    if (required && trimmed.is_empty())
        || trimmed.encode_utf16().count() > maximum
        || trimmed.chars().any(char::is_control)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "站点导航的名称、分类或简介格式无效",
        ));
    }
    if trimmed.len() != value.len() {
        *value = trimmed.to_owned();
    }
    Ok(())
}

fn web_url(value: &str) -> Result<String, ApiError> {
    let invalid = || error(StatusCode::BAD_REQUEST, "请输入有效的 HTTP 或 HTTPS 网址");
    if value.encode_utf16().count() > MAX_URL_LENGTH || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = Url::parse(value.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > MAX_URL_LENGTH
    {
        return Err(invalid());
    }
    Ok(url.into())
}

fn valid_icon(value: &str) -> bool {
    if value.len() > MAX_ICON_LENGTH {
        return false;
    }
    // The desktop renders these only as image sources in the site card.
    value
        .strip_prefix("data:image/png;base64,")
        .or_else(|| value.strip_prefix("data:image/svg+xml;base64,"))
        .is_some_and(|data| !data.is_empty() && STANDARD.decode(data).is_ok())
}

fn clean_navigation(navigation: &mut BrowserNavigation) -> Result<(), ApiError> {
    if navigation.sites.len() > MAX_SITES || navigation.categories.len() > MAX_CATEGORIES {
        return Err(error(StatusCode::BAD_REQUEST, "团队站点或分类数量已达上限"));
    }
    clean_label(&mut navigation.new_site_category, 40, true)?;
    let mut categories = HashSet::new();
    for category in &mut navigation.categories {
        clean_label(category, 40, true)?;
        if !categories.insert(category.clone()) {
            return Err(error(StatusCode::BAD_REQUEST, "团队站点分类重复"));
        }
    }
    let mut ids = HashSet::new();
    let mut addresses = HashSet::new();
    for site in &mut navigation.sites {
        clean_label(&mut site.id, 200, true)?;
        clean_label(&mut site.name, 120, false)?;
        clean_label(&mut site.category, 40, true)?;
        if let Some(description) = &mut site.description {
            clean_label(description, 260, false)?;
        }
        site.url = web_url(&site.url)?;
        if !ids.insert(site.id.as_str()) || !addresses.insert(site.url.as_str()) {
            return Err(error(StatusCode::BAD_REQUEST, "团队站点编号或网址重复"));
        }
        if site
            .icon_data
            .as_deref()
            .is_some_and(|data| !valid_icon(data))
        {
            site.icon_data = None;
        }
        if categories.insert(site.category.clone()) {
            navigation.categories.push(site.category.clone());
        }
    }
    if categories.insert(navigation.new_site_category.clone()) {
        navigation
            .categories
            .push(navigation.new_site_category.clone());
    }
    if navigation.categories.len() > MAX_CATEGORIES {
        return Err(error(StatusCode::BAD_REQUEST, "团队站点分类数量已达上限"));
    }
    Ok(())
}

async fn list(
    State(store): State<Store>,
    headers: HeaderMap,
) -> ApiResult<BrowserNavigationSnapshot> {
    with_member(store, headers, |conn, _| snapshot(conn)).await
}

async fn save(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(mut input): Json<BrowserNavigationUpdate>,
) -> ApiResult<BrowserNavigationSnapshot> {
    with_member(store, headers, move |conn, _| {
        clean_navigation(&mut input.navigation)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let result = snapshot(&tx)?;
        if result.revision != input.revision {
            return Err(error(
                StatusCode::CONFLICT,
                "团队成员已修改站点导航，请刷新后重试",
            ));
        }
        if result.navigation.as_ref() == Some(&input.navigation) {
            return Ok(result);
        }
        let revision = result.revision + 1;
        let data = serde_json::to_string(&input.navigation).map_err(|_| storage_error())?;
        tx.execute(
            "INSERT INTO shared_browser_navigation (singleton, revision, navigation)
             VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision, navigation=excluded.navigation",
            params![revision, data],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(BrowserNavigationSnapshot {
            available: true,
            revision,
            navigation: Some(input.navigation),
        })
    })
    .await
}
