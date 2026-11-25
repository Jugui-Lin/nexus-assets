use super::{
    check_rescan_visible, db_error, error, link_relative_path, with_member, ApiError, ApiResult,
    Store,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_PINS: u64 = 500;

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS shared_quick_access (
            library TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
            folder TEXT NOT NULL,
            PRIMARY KEY(library, folder)
        );
        CREATE TABLE IF NOT EXISTS shared_quick_access_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO shared_quick_access_state VALUES(1,0);
        CREATE TRIGGER IF NOT EXISTS shared_quick_access_insert AFTER INSERT ON shared_quick_access BEGIN
            UPDATE shared_quick_access_state SET revision=revision+1 WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS shared_quick_access_delete AFTER DELETE ON shared_quick_access BEGIN
            UPDATE shared_quick_access_state SET revision=revision+1 WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS shared_quick_access_update AFTER UPDATE ON shared_quick_access BEGIN
            UPDATE shared_quick_access_state SET revision=revision+1 WHERE singleton=1;
        END;",
    )
}

pub(super) fn routes() -> Router<Store> {
    Router::new()
        .route(
            "/v1/quick-access",
            get(list).put(set).layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/v1/quick-access/relocate",
            post(relocate).layer(DefaultBodyLimit::max(16384)),
        )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pin {
    library_id: String,
    folder: String,
}

#[derive(Serialize)]
struct Snapshot {
    pins: Vec<Pin>,
    revision: u64,
}

fn snapshot(conn: &Connection) -> Result<Snapshot, ApiError> {
    let revision = conn
        .query_row(
            "SELECT revision FROM shared_quick_access_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let mut query = conn
        .prepare(
            "SELECT pin.library, pin.folder FROM shared_quick_access pin
         WHERE NOT EXISTS (SELECT 1 FROM hidden_folders h WHERE h.library=pin.library
            AND (h.folder='' OR h.folder=pin.folder
                 OR substr(pin.folder,1,length(h.folder)+1)=h.folder||'/'))
         ORDER BY pin.rowid",
        )
        .map_err(db_error)?;
    let pins = query
        .query_map([], |row| {
            Ok(Pin {
                library_id: row.get(0)?,
                folder: row.get(1)?,
            })
        })
        .map_err(db_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(db_error)?;
    Ok(Snapshot { pins, revision })
}

async fn list(State(store): State<Store>, headers: HeaderMap) -> ApiResult<Snapshot> {
    with_member(store, headers, |conn, _| {
        let tx = conn.transaction().map_err(db_error)?;
        let result = snapshot(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    })
    .await
}

fn checked_folder(value: &str) -> Result<(), ApiError> {
    if value.len() > 4096
        || value.chars().any(char::is_control)
        || link_relative_path(value).is_none()
    {
        return Err(error(StatusCode::BAD_REQUEST, "团队文件夹路径无效"));
    }
    Ok(())
}

fn canonical_library(value: &str) -> Result<String, ApiError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "团队库编号无效"))
}

fn indexed_folder(conn: &Connection, library: &str, folder: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM libraries WHERE id=?1 AND (
            ?2='' OR EXISTS (SELECT 1 FROM watched_folders WHERE library=?1 AND folder=?2)
            OR EXISTS (SELECT 1 FROM assets WHERE library=?1 AND available=1
                AND substr(relative,1,length(?2)+1)=?2||'/')
        ))",
        [library, folder],
        |row| row.get(0),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetPin {
    library_id: String,
    folder: String,
    pinned: bool,
}

async fn set(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(request): Json<SetPin>,
) -> ApiResult<Snapshot> {
    with_member(store, headers, move |conn, _| {
        let library = canonical_library(&request.library_id)?;
        checked_folder(&request.folder)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if request.pinned {
            if !indexed_folder(&tx, &library, &request.folder).map_err(db_error)? {
                return Err(error(StatusCode::CONFLICT, "此文件夹尚未进入团队索引"));
            }
            check_rescan_visible(&tx, &library, &request.folder)?;
            let already = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM shared_quick_access WHERE library=?1 AND folder=?2)",
                params![library, request.folder],
                |row| row.get::<_, bool>(0),
            ).map_err(db_error)?;
            if !already {
                let count: u64 = tx
                    .query_row("SELECT COUNT(*) FROM shared_quick_access", [], |row| {
                        row.get(0)
                    })
                    .map_err(db_error)?;
                if count >= MAX_PINS {
                    return Err(error(StatusCode::CONFLICT, "团队快速访问已达到上限"));
                }
                tx.execute(
                    "INSERT INTO shared_quick_access(library,folder) VALUES(?1,?2)",
                    params![library, request.folder],
                )
                .map_err(db_error)?;
            }
        } else {
            tx.execute(
                "DELETE FROM shared_quick_access WHERE library=?1 AND folder=?2",
                params![library, request.folder],
            )
            .map_err(db_error)?;
        }
        let result = snapshot(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    })
    .await
}

pub(super) fn relocate_pins(
    conn: &Connection,
    library: &str,
    from: &str,
    target_library: &str,
    to: &str,
) -> Result<(), ApiError> {
    if library == target_library && from == to {
        return Ok(());
    }
    let mut query = conn
        .prepare(
            "SELECT folder FROM shared_quick_access WHERE library=?1
         AND (?2='' OR folder=?2 OR substr(folder,1,length(?2)+1)=?2||'/')",
        )
        .map_err(db_error)?;
    let folders = query
        .query_map([library, from], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    for old in folders {
        let suffix = old[from.len()..].trim_start_matches('/');
        let next = match (to.is_empty(), suffix.is_empty()) {
            (true, _) => suffix.to_owned(),
            (_, true) => to.to_owned(),
            _ => format!("{to}/{suffix}"),
        };
        let replaced = conn.execute(
            "UPDATE OR IGNORE shared_quick_access SET library=?3, folder=?4 WHERE library=?1 AND folder=?2",
            params![library, old, target_library, next],
        ).map_err(db_error)?;
        if replaced == 0 {
            conn.execute(
                "DELETE FROM shared_quick_access WHERE library=?1 AND folder=?2",
                params![library, old],
            )
            .map_err(db_error)?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Relocation {
    library_id: String,
    from: String,
    to: String,
}

async fn relocate(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(request): Json<Relocation>,
) -> ApiResult<Snapshot> {
    with_member(store, headers, move |conn, _| {
        for folder in [&request.from, &request.to] {
            if folder.is_empty() {
                return Err(error(
                    StatusCode::BAD_REQUEST,
                    "团队快速访问不能迁移库根目录",
                ));
            }
            checked_folder(folder)?;
        }
        if request
            .to
            .strip_prefix(&request.from)
            .is_some_and(|part| part.starts_with('/'))
        {
            return Err(error(StatusCode::BAD_REQUEST, "团队快速访问目标路径无效"));
        }
        let library = canonical_library(&request.library_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        check_rescan_visible(&tx, &library, &request.to)?;
        relocate_pins(&tx, &library, &request.from, &library, &request.to)?;
        let result = snapshot(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    })
    .await
}
