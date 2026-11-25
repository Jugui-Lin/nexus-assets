use crate::Catalog;
use rusqlite::{params, Connection, ErrorCode, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCollection {
    pub id: String,
    pub name: String,
    pub asset_ids: Vec<String>,
}

pub(crate) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS asset_collections (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            name TEXT NOT NULL COLLATE NOCASE,
            UNIQUE(scope, name)
        );
        CREATE TABLE IF NOT EXISTS asset_collection_members (
            collection_id TEXT NOT NULL REFERENCES asset_collections(id) ON DELETE CASCADE,
            asset_id TEXT NOT NULL,
            PRIMARY KEY(collection_id, asset_id)
        );",
    )
    .map_err(db_error)
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn name_error(error: rusqlite::Error) -> String {
    if error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
        "此工作空间已有同名集合".into()
    } else {
        db_error(error)
    }
}

fn scope_key(scope: &str) -> Result<String, String> {
    if scope == "personal" {
        return Ok(scope.to_owned());
    }
    let (team, member) = scope
        .strip_prefix("team:")
        .and_then(|ids| ids.split_once(':'))
        .ok_or("工作空间范围无效")?;
    let team = Uuid::parse_str(team).map_err(|_| "团队编号无效")?;
    let member = Uuid::parse_str(member).map_err(|_| "成员编号无效")?;
    Ok(format!("team:{team}:{member}"))
}

fn collection_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err("请输入 1 到 100 个字符的集合名称".into());
    }
    Ok(name)
}

fn collection(conn: &Connection, scope: &str, id: &str) -> Result<AssetCollection, String> {
    let name = conn
        .query_row(
            "SELECT name FROM asset_collections WHERE scope = ?1 AND id = ?2",
            params![scope, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or("集合不存在")?;
    let mut statement = conn
        .prepare(
            "SELECT asset_id FROM asset_collection_members WHERE collection_id = ?1 ORDER BY rowid",
        )
        .map_err(db_error)?;
    let asset_ids = statement
        .query_map([id], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(AssetCollection {
        id: id.into(),
        name,
        asset_ids,
    })
}

fn asset_id_for_scope(scope: &str, id: &str) -> Result<(), String> {
    if scope == "personal" {
        if id.is_empty()
            || id.len() > 128
            || id.starts_with("team:")
            || id.chars().any(char::is_control)
        {
            return Err("个人资产编号无效".into());
        }
    } else {
        let uuid = id.strip_prefix("team:").ok_or("团队资产编号无效")?;
        let parsed = Uuid::parse_str(uuid).map_err(|_| "团队资产编号无效")?;
        if parsed.to_string() != uuid {
            return Err("团队资产编号无效".into());
        }
    }
    Ok(())
}

impl Catalog {
    pub fn list_collections(&self, scope: &str) -> Result<Vec<AssetCollection>, String> {
        let scope = scope_key(scope)?;
        let mut statement = self
            .conn
            .prepare(
                "SELECT c.id, c.name, m.asset_id
             FROM asset_collections c
             LEFT JOIN asset_collection_members m ON m.collection_id = c.id
             WHERE c.scope = ?1
             ORDER BY c.rowid, m.rowid",
            )
            .map_err(db_error)?;
        let mut rows = statement.query([scope]).map_err(db_error)?;
        let mut result: Vec<AssetCollection> = Vec::new();
        while let Some(row) = rows.next().map_err(db_error)? {
            let id: String = row.get(0).map_err(db_error)?;
            if !result.last().is_some_and(|current| current.id == id) {
                result.push(AssetCollection {
                    id,
                    name: row.get(1).map_err(db_error)?,
                    asset_ids: Vec::new(),
                });
            }
            if let Some(asset_id) = row.get::<_, Option<String>>(2).map_err(db_error)? {
                result
                    .last_mut()
                    .expect("collection is present")
                    .asset_ids
                    .push(asset_id);
            }
        }
        Ok(result)
    }

    pub fn create_collection(&self, scope: &str, name: &str) -> Result<AssetCollection, String> {
        let scope = scope_key(scope)?;
        let name = collection_name(name)?;
        let id = Uuid::new_v4().to_string();
        self.conn
            .execute(
                "INSERT INTO asset_collections (id, scope, name) VALUES (?1, ?2, ?3)",
                params![id, scope, name],
            )
            .map_err(name_error)?;
        Ok(AssetCollection {
            id,
            name: name.into(),
            asset_ids: Vec::new(),
        })
    }

    pub fn rename_collection(
        &mut self,
        scope: &str,
        id: &str,
        name: &str,
    ) -> Result<AssetCollection, String> {
        let scope = scope_key(scope)?;
        let name = collection_name(name)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let affected = tx
            .execute(
                "UPDATE asset_collections SET name = ?3 WHERE scope = ?1 AND id = ?2",
                params![scope, id, name],
            )
            .map_err(name_error)?;
        if affected == 0 {
            return Err("集合不存在".into());
        }
        let updated = collection(&tx, &scope, id)?;
        tx.commit().map_err(db_error)?;
        Ok(updated)
    }

    pub fn delete_collection(&self, scope: &str, id: &str) -> Result<(), String> {
        let scope = scope_key(scope)?;
        let affected = self
            .conn
            .execute(
                "DELETE FROM asset_collections WHERE scope = ?1 AND id = ?2",
                params![scope, id],
            )
            .map_err(db_error)?;
        if affected == 0 {
            return Err("集合不存在".into());
        }
        Ok(())
    }

    pub fn set_collection_membership(
        &mut self,
        scope: &str,
        id: &str,
        asset_ids: &[String],
        include: bool,
    ) -> Result<AssetCollection, String> {
        let scope = scope_key(scope)?;
        for asset_id in asset_ids {
            asset_id_for_scope(&scope, asset_id)?;
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let found: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM asset_collections WHERE scope = ?1 AND id = ?2)",
                params![scope, id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !found {
            return Err("集合不存在".into());
        }

        if include {
            let mut insert = tx
                .prepare_cached(
                    "INSERT INTO asset_collection_members (collection_id, asset_id) VALUES (?1, ?2)
                 ON CONFLICT(collection_id, asset_id) DO NOTHING",
                )
                .map_err(db_error)?;
            let mut local_exists = tx
                .prepare_cached("SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)")
                .map_err(db_error)?;
            for asset_id in asset_ids {
                if scope == "personal"
                    && !local_exists
                        .query_row([asset_id], |row| row.get::<_, bool>(0))
                        .map_err(db_error)?
                {
                    return Err("个人资产不存在".into());
                }
                insert.execute(params![id, asset_id]).map_err(db_error)?;
            }
        } else {
            let mut remove = tx.prepare_cached(
                "DELETE FROM asset_collection_members WHERE collection_id = ?1 AND asset_id = ?2",
            ).map_err(db_error)?;
            for asset_id in asset_ids {
                remove.execute(params![id, asset_id]).map_err(db_error)?;
            }
        }

        let updated = collection(&tx, &scope, id)?;
        tx.commit().map_err(db_error)?;
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_collections_persist_without_moving_or_deleting_assets() {
        let db = tempfile::tempdir().unwrap();
        let source = db.path().join("chair.obj");
        std::fs::write(&source, "v 0 0 0").unwrap();
        let mut catalog = Catalog::open(db.path()).unwrap();
        catalog.add_file(&source, "loose").unwrap();
        let local_id = catalog.assets().unwrap()[0].id.clone();
        let collection = catalog
            .create_collection("personal", "   Chair studies  ")
            .unwrap();
        let team = Uuid::new_v4();
        let team_scope = format!("team:{team}:{}", Uuid::new_v4());
        let other_member = format!("team:{team}:{}", Uuid::new_v4());
        let shared = catalog
            .create_collection(&team_scope, "Chair studies")
            .unwrap();
        let shared_id = format!("team:{}", Uuid::new_v4());
        assert!(catalog
            .create_collection("personal", "chair studies")
            .is_err());
        assert!(catalog.list_collections(&other_member).unwrap().is_empty());
        assert!(catalog
            .delete_collection(&team_scope, &collection.id)
            .is_err());
        assert!(catalog
            .set_collection_membership("personal", &collection.id, &[shared_id.clone()], true)
            .is_err());
        assert!(catalog
            .set_collection_membership(
                "personal",
                &collection.id,
                &[local_id.clone(), "unknown".into()],
                true
            )
            .is_err());
        assert!(catalog.list_collections("personal").unwrap()[0]
            .asset_ids
            .is_empty());
        catalog
            .set_collection_membership(
                "personal",
                &collection.id,
                &[local_id.clone(), local_id.clone()],
                true,
            )
            .unwrap();
        catalog
            .set_collection_membership(&team_scope, &shared.id, &[shared_id.clone()], true)
            .unwrap();
        catalog
            .rename_collection("personal", &collection.id, "Selected chairs")
            .unwrap();

        let mut reopened = Catalog::open(db.path()).unwrap();
        let saved = reopened.list_collections("personal").unwrap().remove(0);
        assert_eq!(saved.name, "Selected chairs");
        assert_eq!(saved.asset_ids, vec![local_id.clone()]);
        assert_eq!(
            reopened.list_collections(&team_scope).unwrap()[0].asset_ids,
            vec![shared_id.clone()]
        );
        reopened
            .set_collection_membership(&team_scope, &shared.id, &[shared_id], false)
            .unwrap();
        assert!(reopened.list_collections(&team_scope).unwrap()[0]
            .asset_ids
            .is_empty());
        reopened
            .delete_collection("personal", &collection.id)
            .unwrap();
        assert!(reopened.list_collections("personal").unwrap().is_empty());
        assert!(reopened.asset(&local_id).is_ok());
        assert!(source.is_file());
        let rows: u32 = reopened
            .conn
            .query_row(
                "SELECT COUNT(*) FROM asset_collection_members WHERE collection_id = ?1",
                [collection.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }
}
