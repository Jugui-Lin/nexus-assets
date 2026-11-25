use crate::{now, Catalog};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;

const MAX_RECYCLE_IDS: usize = 500;
const MAX_ASSET_ID_BYTES: usize = 128;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycledAsset {
    pub id: String,
    pub name: String,
    pub path: String,
    pub recycled_at: u64,
}

pub(crate) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recycled_assets (
            asset_id TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            recycled_at INTEGER NOT NULL
        );",
    )
    .map_err(db_error)
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

impl Catalog {
    pub fn list_recycled_assets(&self) -> Result<Vec<RecycledAsset>, String> {
        let mut query = self
            .conn
            .prepare(
                "SELECT a.id,a.name,a.path,r.recycled_at
                 FROM recycled_assets r JOIN assets a ON a.id=r.asset_id
                 ORDER BY r.recycled_at DESC,r.rowid DESC",
            )
            .map_err(db_error)?;
        let rows = query
            .query_map([], |row| {
                Ok(RecycledAsset {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    recycled_at: row.get(3)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)
    }

    pub fn set_assets_recycled(&mut self, ids: &[String], recycled: bool) -> Result<usize, String> {
        if ids.len() > MAX_RECYCLE_IDS {
            return Err(format!("一次最多处理 {MAX_RECYCLE_IDS} 项资产"));
        }
        if ids.iter().any(|id| {
            id.trim().is_empty()
                || id.len() > MAX_ASSET_ID_BYTES
                || id.starts_with("team:")
                || id.chars().any(char::is_control)
        }) {
            return Err("个人资产标识无效".into());
        }
        if ids.is_empty() {
            return Ok(0);
        }

        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now();
        let changed = {
            let mut exists = transaction
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)")
                .map_err(db_error)?;
            let mut update = transaction
                .prepare_cached(if recycled {
                    "INSERT INTO recycled_assets(asset_id,recycled_at) VALUES(?1,?2)
                     ON CONFLICT(asset_id) DO NOTHING"
                } else {
                    "DELETE FROM recycled_assets WHERE asset_id=?1"
                })
                .map_err(db_error)?;
            let mut changed = 0;
            for id in ids {
                if !exists
                    .query_row([id], |row| row.get::<_, bool>(0))
                    .map_err(db_error)?
                {
                    return Err("当前个人库中的部分资产已变化，请刷新后重试".into());
                }
                changed += if recycled {
                    update.execute(params![id, timestamp])
                } else {
                    update.execute([id])
                }
                .map_err(db_error)?;
            }
            changed
        };
        transaction.commit().map_err(db_error)?;
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn recycle_survives_scans_and_preserves_asset_identity_and_membership() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("素材");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("原模型.obj");
        fs::write(&file, "v 1 2 3").unwrap();
        let db = fixture.path().join("personal");
        let mut catalog = Catalog::open(&db).unwrap();
        catalog.scan(&root, None, "local", |_| {}).unwrap();
        let id = catalog.assets().unwrap()[0].id.clone();
        catalog
            .patch(
                &id,
                json!({"name":"编辑后的名称","favorite":true,"notes":"保留资料","rating":4}),
            )
            .unwrap();
        let collection = catalog.create_collection("personal", "制作中").unwrap();
        let ids = vec![id.clone(), id.clone()];
        catalog
            .set_collection_membership("personal", &collection.id, &ids, true)
            .unwrap();

        assert!(catalog
            .set_assets_recycled(&vec![id.clone(); MAX_RECYCLE_IDS + 1], true)
            .is_err());
        assert!(catalog
            .set_assets_recycled(&[id.clone(), "missing-asset".into()], true)
            .is_err());
        assert_eq!(catalog.assets().unwrap().len(), 1);
        assert!(catalog.list_recycled_assets().unwrap().is_empty());

        assert_eq!(catalog.set_assets_recycled(&ids, true).unwrap(), 1);
        assert_eq!(catalog.set_assets_recycled(&ids, true).unwrap(), 0);
        assert!(catalog.assets().unwrap().is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "v 1 2 3");
        fs::write(&file, "v 4 5 6\nv 7 8 9").unwrap();

        let mut reopened = Catalog::open(&db).unwrap();
        assert_eq!(
            reopened.scan(&root, None, "local", |_| {}).unwrap()["found"],
            1
        );
        assert!(reopened.assets().unwrap().is_empty());
        let recycled = reopened.list_recycled_assets().unwrap();
        assert_eq!(recycled.len(), 1);
        assert_eq!(recycled[0].id, id);
        assert_eq!(recycled[0].name, "编辑后的名称");
        assert_eq!(
            recycled[0].path,
            crate::clean_path(&fs::canonicalize(&file).unwrap())
        );
        assert!(recycled[0].recycled_at > 0);
        assert!(Catalog::open(&fixture.path().join("other-personal"))
            .unwrap()
            .list_recycled_assets()
            .unwrap()
            .is_empty());

        assert!(reopened
            .set_assets_recycled(&[id.clone(), "missing-asset".into()], false)
            .is_err());
        assert!(reopened.assets().unwrap().is_empty());
        assert_eq!(reopened.set_assets_recycled(&ids, false).unwrap(), 1);
        assert_eq!(reopened.set_assets_recycled(&ids, false).unwrap(), 0);
        assert!(reopened.list_recycled_assets().unwrap().is_empty());
        let visible = reopened.assets().unwrap().pop().unwrap();
        assert_eq!(visible.id, id);
        assert_eq!(visible.notes, "保留资料");
        assert_eq!(visible.rating, 4);
        assert_eq!(visible.size, 15);
        assert!(visible.favorite);
        assert_eq!(
            reopened.list_collections("personal").unwrap()[0].asset_ids,
            vec![id]
        );
    }
}
