use super::{bump_revision, db_error, error, with_member, ApiError, ApiResult, Store};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use nexus_core::now;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

const MAX_BATCH: usize = 500;
pub(super) const ASSET_NOT_RECYCLED: &str =
    "NOT EXISTS (SELECT 1 FROM recycled_assets r WHERE r.asset=a.id)";
const ASSET_NOT_FOLDER_HIDDEN: &str = "NOT EXISTS (
    SELECT 1 FROM hidden_folders h WHERE h.library=a.library
    AND (h.folder='' OR substr(a.relative,1,length(h.folder)+1)=h.folder||'/')
)";

pub(super) fn visible_asset_sql() -> String {
    format!("a.available=1 AND {ASSET_NOT_FOLDER_HIDDEN} AND {ASSET_NOT_RECYCLED}")
}

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recycled_assets (
            asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
            recycled_at INTEGER NOT NULL,
            recycled_by TEXT REFERENCES members(id) ON DELETE SET NULL
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS recycled_assets_latest
            ON recycled_assets(recycled_at DESC,asset);",
    )
}

pub(super) fn routes() -> Router<Store> {
    Router::new()
        .route(
            "/v1/recycle/assets",
            get(list)
                .post(recycle)
                .layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/v1/recycle/assets/restore",
            post(restore).layer(DefaultBodyLimit::max(32 * 1024)),
        )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    ids: Vec<String>,
}

#[derive(Serialize)]
struct Changed {
    changed: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecycledAsset {
    id: String,
    name: String,
    path: String,
    recycled_at: u64,
}

fn list_entries(conn: &Connection) -> Result<Vec<RecycledAsset>, ApiError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT a.id,coalesce(json_extract(a.data,'$.name'),a.relative),a.relative,r.recycled_at
             FROM recycled_assets r JOIN assets a ON a.id=r.asset
             WHERE {ASSET_NOT_FOLDER_HIDDEN}
             ORDER BY r.recycled_at DESC,r.asset"
        ))
        .map_err(db_error)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RecycledAsset {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                recycled_at: row.get(3)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

async fn list(State(store): State<Store>, headers: HeaderMap) -> ApiResult<Vec<RecycledAsset>> {
    with_member(store, headers, |conn, _| list_entries(conn)).await
}

async fn recycle(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(selection): Json<Selection>,
) -> ApiResult<Changed> {
    with_member(store, headers, move |conn, member| {
        update(conn, &member.id, selection.ids, true)
    })
    .await
}

async fn restore(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(selection): Json<Selection>,
) -> ApiResult<Changed> {
    with_member(store, headers, move |conn, member| {
        update(conn, &member.id, selection.ids, false)
    })
    .await
}

fn update(
    conn: &mut Connection,
    member: &str,
    ids: Vec<String>,
    recycle: bool,
) -> Result<Changed, ApiError> {
    if ids.is_empty() || ids.len() > MAX_BATCH {
        return Err(error(StatusCode::BAD_REQUEST, "请选择 1 至 500 项团队资产"));
    }
    let ids = ids
        .iter()
        .map(|id| {
            Uuid::parse_str(id).map_err(|_| error(StatusCode::BAD_REQUEST, "团队资产编号无效"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let time = now();
    let mut seen = HashSet::new();
    let mut changed = 0;
    {
        let mut current = tx
            .prepare(&format!(
                "SELECT a.available,r.asset IS NOT NULL FROM assets a
                 LEFT JOIN recycled_assets r ON r.asset=a.id
                 WHERE a.id=?1 AND {ASSET_NOT_FOLDER_HIDDEN}"
            ))
            .map_err(db_error)?;
        for id in ids.into_iter().filter(|id| seen.insert(*id)) {
            let id = id.to_string();
            let (available, recycled) = current
                .query_row([&id], |row| {
                    Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?))
                })
                .optional()
                .map_err(db_error)?
                .ok_or_else(|| error(StatusCode::CONFLICT, "有选中的资产已移除或位于隐藏文件夹"))?;
            if recycled == recycle {
                continue;
            }
            if !available {
                return Err(error(
                    StatusCode::CONFLICT,
                    "有选中的原始文件暂不可用，请同步团队库后重试",
                ));
            }
            changed += if recycle {
                tx.execute(
                    "INSERT INTO recycled_assets(asset,recycled_at,recycled_by) VALUES(?1,?2,?3)",
                    params![id, time, member],
                )
            } else {
                tx.execute("DELETE FROM recycled_assets WHERE asset=?1", [&id])
            }
            .map_err(db_error)?;
        }
    }
    if changed > 0 {
        bump_revision(&tx)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(Changed { changed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{create_member, open_store, snapshot, sync_files, team_revision};
    use axum::{extract::Path, http::header};
    use nexus_core::team::PublishedFile;
    use std::sync::{Arc, Mutex};

    #[test]
    fn shared_batches_are_authenticated_atomic_and_survive_watcher_refresh() {
        let fixture = tempfile::tempdir().unwrap();
        let db = open_store(fixture.path()).unwrap();
        db.execute("INSERT INTO team VALUES(1,'test','Team',1)", [])
            .unwrap();
        db.execute("INSERT INTO libraries VALUES('lib','Fixture')", [])
            .unwrap();
        let (_, first_token) = create_member(&db, "First", "member").unwrap();
        let (_, second_token) = create_member(&db, "Second", "member").unwrap();
        let files = [
            "Included/first.jpg",
            "Included/second.jpg",
            "Hidden/nested/third.jpg",
        ]
        .map(|path| PublishedFile {
            relative_path: path.to_owned(),
            name: "Fixture".into(),
            size: 40,
            modified: 1,
            tags: vec!["Reviewed".into()],
            notes: "Retain metadata".into(),
            file_identity: None,
        });
        sync_files(&db, "lib", &files, "Watcher", true, "").unwrap();
        let id = |path: &str| {
            let value: String = db
                .query_row("SELECT id FROM assets WHERE relative=?1", [path], |row| {
                    row.get(0)
                })
                .unwrap();
            Uuid::parse_str(&value).unwrap()
        };
        let [first, second, hidden] = files.each_ref().map(|file| id(&file.relative_path));
        db.execute("INSERT INTO hidden_folders VALUES('lib','Hidden')", [])
            .unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        let auth = |token: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
            headers
        };
        let status = |ids: Vec<Uuid>| {
            Json(Selection {
                ids: ids.into_iter().map(|id| id.to_string()).collect(),
            })
        };
        let catalog =
            |token: &str| snapshot(State(store.clone()), auth(token), Path("full".into()));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert!(matches!(
                list(State(store.clone()), HeaderMap::new()).await,
                Err((StatusCode::UNAUTHORIZED, _))
            ));
            assert!(matches!(
                recycle(
                    State(store.clone()),
                    auth(&first_token),
                    status(vec![first, hidden])
                )
                .await,
                Err((StatusCode::CONFLICT, _))
            ));
            assert_eq!(team_revision(&store.0.lock().unwrap()).unwrap(), 1);
            assert_eq!(
                catalog(&first_token)
                    .await
                    .unwrap()
                    .0
                    .catalog
                    .unwrap()
                    .assets
                    .len(),
                2
            );
            let batch = vec![first, second, first];
            let changed = recycle(
                State(store.clone()),
                auth(&first_token),
                status(batch.clone()),
            )
            .await
            .unwrap()
            .0
            .changed;
            assert_eq!(changed, 2);
            let repeated = recycle(
                State(store.clone()),
                auth(&second_token),
                status(batch.clone()),
            )
            .await
            .unwrap()
            .0
            .changed;
            assert_eq!(repeated, 0);
            let listing = list(State(store.clone()), auth(&second_token))
                .await
                .unwrap()
                .0;
            assert_eq!(listing.len(), 2);
            assert!(listing
                .iter()
                .all(|asset| asset.recycled_at > 0 && asset.path.starts_with("Included/")));
            {
                let db = store.0.lock().unwrap();
                assert_eq!(team_revision(&db).unwrap(), 2);
                db.execute(
                    "UPDATE assets SET available=0 WHERE id=?1",
                    [second.to_string()],
                )
                .unwrap();
            }
            assert!(matches!(
                restore(
                    State(store.clone()),
                    auth(&second_token),
                    status(batch.clone())
                )
                .await,
                Err((StatusCode::CONFLICT, _))
            ));
            assert_eq!(
                list(State(store.clone()), auth(&first_token))
                    .await
                    .unwrap()
                    .0
                    .len(),
                2
            );
            sync_files(&store.0.lock().unwrap(), "lib", &files, "Watcher", true, "").unwrap();
            assert!(catalog(&first_token)
                .await
                .unwrap()
                .0
                .catalog
                .unwrap()
                .assets
                .is_empty());
            let restored = restore(State(store.clone()), auth(&second_token), status(batch))
                .await
                .unwrap()
                .0
                .changed;
            assert_eq!(restored, 2);
            assert_eq!(team_revision(&store.0.lock().unwrap()).unwrap(), 3);
            let assets = catalog(&second_token)
                .await
                .unwrap()
                .0
                .catalog
                .unwrap()
                .assets;
            assert_eq!(assets.len(), 2);
            assert!(assets.iter().any(|asset| asset.id == first.to_string()));
            assert!(assets
                .iter()
                .all(|asset| asset.tags == ["Reviewed"] && asset.notes == "Retain metadata"));
        });
    }
}
