use super::{
    asset_recycle::visible_asset_sql, db_error, error, with_member, ApiError, ApiResult, Store,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
    Json, Router,
};
use nexus_core::{now_millis, team_organization::*, AssetCollection};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS organization_revision (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO organization_revision VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS shared_favorites (
            asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
            favorite_at INTEGER
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS shared_collections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE
        );
        CREATE TABLE IF NOT EXISTS shared_collection_members (
            collection TEXT NOT NULL REFERENCES shared_collections(id) ON DELETE CASCADE,
            asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            PRIMARY KEY(collection,asset)
        );
        CREATE INDEX IF NOT EXISTS shared_collection_asset ON shared_collection_members(asset);",
    )?;
    if !has_favorite_time_column(conn)? {
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        if !has_favorite_time_column(&tx)? {
            tx.execute("ALTER TABLE shared_favorites ADD COLUMN favorite_at INTEGER", [])?;
        }
        tx.commit()?;
    }
    Ok(())
}

fn has_favorite_time_column(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('shared_favorites') WHERE name='favorite_at')",
        [],
        |row| row.get(0),
    )
}

pub(super) fn routes() -> Router<Store> {
    Router::new()
        .route("/v1/organization", get(list))
        .route(
            "/v1/organization/favorites/{id}",
            patch(set_favorite).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/v1/organization/collections",
            post(create_collection).layer(DefaultBodyLimit::max(2048)),
        )
        .route(
            "/v1/organization/collections/{id}",
            patch(rename_collection)
                .delete(delete_collection)
                .layer(DefaultBodyLimit::max(2048)),
        )
        .route(
            "/v1/organization/collections/{id}/members",
            patch(set_membership).layer(DefaultBodyLimit::max(5 * 1024 * 1024)),
        )
}

#[cfg(test)]
#[test]
fn shared_favorite_migration_preserves_legacy_rows_without_a_time() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE assets (id TEXT PRIMARY KEY);
         CREATE TABLE shared_favorites (asset TEXT PRIMARY KEY REFERENCES assets(id)) WITHOUT ROWID;
         INSERT INTO assets VALUES ('existing');
         INSERT INTO shared_favorites VALUES ('existing');",
    )
    .unwrap();
    init_schema(&conn).unwrap();
    init_schema(&conn).unwrap();
    let timestamp: Option<u64> = conn
        .query_row(
            "SELECT favorite_at FROM shared_favorites WHERE asset='existing'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(timestamp, None);
}

fn revision(conn: &Connection) -> rusqlite::Result<u64> {
    conn.query_row(
        "SELECT revision FROM organization_revision WHERE singleton=1",
        [],
        |row| row.get(0),
    )
}

fn commit(tx: Transaction<'_>, changed: bool) -> Result<u64, ApiError> {
    if changed {
        tx.execute(
            "UPDATE organization_revision SET revision=revision+1 WHERE singleton=1",
            [],
        )
        .map_err(db_error)?;
    }
    let version = revision(&tx).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(version)
}

fn id(value: &str) -> Result<String, ApiError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "团队资产或合集编号无效"))
}

fn name(value: &str) -> Result<&str, ApiError> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        Err(error(
            StatusCode::BAD_REQUEST,
            "请输入 1 至 100 个字符的合集名称",
        ))
    } else {
        Ok(name)
    }
}

fn asset_scope_query() -> String {
    format!(
        "SELECT EXISTS (SELECT 1 FROM assets a WHERE a.id=?1 AND {})",
        visible_asset_sql()
    )
}

fn missing_asset() -> ApiError {
    error(StatusCode::NOT_FOUND, "团队资产不存在或当前不可用")
}

fn missing_collection() -> ApiError {
    error(StatusCode::NOT_FOUND, "团队合集不存在")
}

fn available_name(conn: &Connection, name: &str, id: &str) -> Result<(), ApiError> {
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM shared_collections WHERE name=?1 AND id<>?2)",
            params![name, id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_error)?;
    if exists {
        return Err(error(StatusCode::CONFLICT, "团队中已存在同名合集"));
    }
    Ok(())
}

fn collection(conn: &Connection, id: &str) -> Result<AssetCollection, ApiError> {
    let name = conn
        .query_row(
            "SELECT name FROM shared_collections WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(missing_collection)?;
    let mut statement = conn
        .prepare("SELECT asset FROM shared_collection_members WHERE collection=?1 ORDER BY rowid")
        .map_err(db_error)?;
    let asset_ids = statement
        .query_map([id], |row| row.get(0))
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    Ok(AssetCollection {
        id: id.into(),
        name,
        asset_ids,
    })
}

async fn list(State(store): State<Store>, headers: HeaderMap) -> ApiResult<Organization> {
    with_member(store, headers, |conn, _| {
        let tx = conn.transaction().map_err(db_error)?;
        let current_revision = revision(&tx).map_err(db_error)?;
        let mut favorites = tx
            .prepare("SELECT asset,favorite_at FROM shared_favorites ORDER BY asset")
            .map_err(db_error)?;
        let mut favorite_ids = Vec::new();
        let mut favorite_times = BTreeMap::new();
        let favorite_rows = favorites
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<u64>>(1)?)))
            .map_err(db_error)?;
        for entry in favorite_rows {
            let (id, time) = entry.map_err(db_error)?;
            if let Some(time) = time {
                favorite_times.insert(id.clone(), time);
            }
            favorite_ids.push(id);
        }
        let mut statement = tx
            .prepare(
                "SELECT c.id,c.name,m.asset FROM shared_collections c
             LEFT JOIN shared_collection_members m ON m.collection=c.id ORDER BY c.rowid,m.rowid",
            )
            .map_err(db_error)?;
        let mut rows = statement.query([]).map_err(db_error)?;
        let mut collections: Vec<AssetCollection> = Vec::new();
        while let Some(row) = rows.next().map_err(db_error)? {
            let id: String = row.get(0).map_err(db_error)?;
            if collections.last().is_none_or(|entry| entry.id != id) {
                collections.push(AssetCollection {
                    id,
                    name: row.get(1).map_err(db_error)?,
                    asset_ids: Vec::new(),
                });
            }
            if let Some(asset) = row.get::<_, Option<String>>(2).map_err(db_error)? {
                collections
                    .last_mut()
                    .expect("collection present")
                    .asset_ids
                    .push(asset);
            }
        }
        Ok(Organization {
            available: true,
            revision: current_revision,
            favorite_ids,
            favorite_times: Some(favorite_times),
            collections,
        })
    })
    .await
}

async fn set_favorite(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(asset): Path<String>,
    Json(input): Json<FavoriteRequest>,
) -> ApiResult<FavoriteChanged> {
    with_member(store, headers, move |conn, _| {
        let asset = id(&asset)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let updated = if input.favorite {
            if !tx
                .query_row(&asset_scope_query(), [&asset], |row| row.get::<_, bool>(0))
                .map_err(db_error)?
            {
                return Err(missing_asset());
            }
            tx.execute(
                "INSERT INTO shared_favorites (asset,favorite_at) VALUES (?1,?2) ON CONFLICT DO NOTHING",
                params![asset, now_millis()],
            )
        } else {
            tx.execute("DELETE FROM shared_favorites WHERE asset=?1", [&asset])
        }
        .map_err(db_error)?;
        let favorite_at = if input.favorite {
            tx.query_row(
                "SELECT favorite_at FROM shared_favorites WHERE asset=?1",
                [&asset],
                |row| row.get(0),
            )
            .map_err(db_error)?
        } else {
            None
        };
        let revision = commit(tx, updated != 0)?;
        Ok(FavoriteChanged {
            favorite: input.favorite,
            favorite_at,
            revision,
        })
    })
    .await
}

async fn create_collection(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(input): Json<CollectionName>,
) -> ApiResult<AssetCollection> {
    with_member(store, headers, move |conn, _| {
        let name = name(&input.name)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let id = Uuid::new_v4().to_string();
        available_name(&tx, name, &id)?;
        tx.execute(
            "INSERT INTO shared_collections (id,name) VALUES (?1,?2)",
            params![id, name],
        )
        .map_err(db_error)?;
        commit(tx, true)?;
        Ok(AssetCollection {
            id,
            name: name.into(),
            asset_ids: Vec::new(),
        })
    })
    .await
}

async fn rename_collection(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(input): Json<CollectionName>,
) -> ApiResult<AssetCollection> {
    with_member(store, headers, move |conn, _| {
        let id = id(&key)?;
        let name = name(&input.name)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut current = collection(&tx, &id)?;
        if current.name != name {
            available_name(&tx, name, &id)?;
            tx.execute(
                "UPDATE shared_collections SET name=?2 WHERE id=?1",
                params![id, name],
            )
            .map_err(db_error)?;
            current.name = name.into();
            commit(tx, true)?;
        }
        Ok(current)
    })
    .await
}

async fn delete_collection(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> ApiResult<CollectionRemoved> {
    with_member(store, headers, move |conn, _| {
        let id = id(&key)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let removed = tx
            .execute("DELETE FROM shared_collections WHERE id=?1", [&id])
            .map_err(db_error)?
            != 0;
        commit(tx, removed)?;
        Ok(CollectionRemoved { removed })
    })
    .await
}

async fn set_membership(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(input): Json<CollectionMembership>,
) -> ApiResult<AssetCollection> {
    with_member(store, headers, move |conn, _| {
        let collection_id = id(&key)?;
        let mut unique = HashSet::new();
        let mut asset_ids = Vec::new();
        for asset in &input.asset_ids {
            let asset = id(asset)?;
            if unique.insert(asset.clone()) {
                asset_ids.push(asset);
            }
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        let exists = tx.query_row("SELECT EXISTS(SELECT 1 FROM shared_collections WHERE id=?1)",
            [&collection_id], |row| row.get::<_, bool>(0)).map_err(db_error)?;
        if !exists {
            return Err(missing_collection());
        }
        let mut changed = false;
        if input.include {
            let mut visible = tx.prepare_cached(&asset_scope_query()).map_err(db_error)?;
            let mut insert = tx.prepare_cached(
                "INSERT INTO shared_collection_members (collection,asset) VALUES (?1,?2) ON CONFLICT DO NOTHING",
            ).map_err(db_error)?;
            for asset in &asset_ids {
                if !visible.query_row([asset], |row| row.get::<_, bool>(0)).map_err(db_error)? {
                    return Err(missing_asset());
                }
                changed |= insert.execute(params![collection_id,asset]).map_err(db_error)? > 0;
            }
        } else {
            let mut remove = tx.prepare_cached(
                "DELETE FROM shared_collection_members WHERE collection=?1 AND asset=?2",
            ).map_err(db_error)?;
            for asset in &asset_ids {
                changed |= remove.execute(params![collection_id,asset]).map_err(db_error)? > 0;
            }
        }
        let updated = collection(&tx, &collection_id)?;
        commit(tx, changed)?;
        Ok(updated)
    }).await
}
