use crate::{lock_db, workspaces, AppState};
use nexus_core::Catalog;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

const SETTINGS_KEY: &str = "defined_tags";

pub(crate) fn defined_tags(catalog: &Catalog) -> Result<Vec<String>, String> {
    definitions(&catalog.conn)
}

#[derive(Serialize)]
pub(crate) struct TagResult {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    created: Option<bool>,
}

fn definitions(connection: &Connection) -> Result<Vec<String>, String> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    stored.map_or_else(
        || Ok(Vec::new()),
        |value| serde_json::from_str(&value).map_err(|error| error.to_string()),
    )
}

fn save_definitions(connection: &Connection, tags: &[String]) -> Result<(), String> {
    let value = serde_json::to_string(tags).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![SETTINGS_KEY, value],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn valid_name(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 40 || value.chars().any(char::is_control) {
        return Err("标签名称须为 1 到 40 个字符，且不能包含控制字符".into());
    }
    Ok(value)
}

struct TaggedAsset {
    id: String,
    tags: Vec<String>,
}

fn tagged_assets(connection: &Connection) -> Result<Vec<TaggedAsset>, String> {
    let mut statement = connection.prepare(
        "SELECT id, json_extract(data,'$.tags') FROM assets WHERE json_array_length(data,'$.tags')>0 ORDER BY rowid",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (id, value) = row.map_err(|error| error.to_string())?;
        let tags = serde_json::from_str(&value).map_err(|error| error.to_string())?;
        Ok(TaggedAsset { id, tags })
    })
    .collect()
}

fn find_tag<'a>(
    definitions: &'a [String],
    assets: &'a [TaggedAsset],
    key: &str,
) -> Option<&'a str> {
    definitions
        .iter()
        .chain(assets.iter().flat_map(|asset| asset.tags.iter()))
        .find(|tag| tag.to_lowercase() == key)
        .map(String::as_str)
}

fn create_tag(connection: &Connection, name: &str) -> Result<TagResult, String> {
    let name = valid_name(name)?;
    let mut definitions = definitions(connection)?;
    let assets = tagged_assets(connection)?;
    if let Some(existing) = find_tag(&definitions, &assets, &name.to_lowercase()) {
        return Ok(TagResult {
            name: existing.to_owned(),
            created: Some(false),
        });
    }
    definitions.push(name.to_owned());
    save_definitions(connection, &definitions)?;
    Ok(TagResult {
        name: name.to_owned(),
        created: Some(true),
    })
}

fn change_tag(
    connection: &Connection,
    name: &str,
    replacement: Option<&str>,
) -> Result<TagResult, String> {
    let name = valid_name(name)?;
    let replacement = replacement.map(valid_name).transpose()?;
    let old_key = name.to_lowercase();
    let mut definitions = definitions(connection)?;
    let assets = tagged_assets(connection)?;
    let existing = find_tag(&definitions, &assets, &old_key)
        .ok_or("标签不存在")?
        .to_owned();
    if let Some(replacement) = replacement {
        let new_key = replacement.to_lowercase();
        if new_key != old_key && find_tag(&definitions, &assets, &new_key).is_some() {
            return Err("已存在同名标签".into());
        }
    }

    definitions.retain(|name| name.to_lowercase() != old_key);
    if let Some(replacement) = replacement {
        definitions.push(replacement.to_owned());
    }
    let mut update = connection
        .prepare("UPDATE assets SET data=json_set(data,'$.tags',json(?2)) WHERE id=?1")
        .map_err(|error| error.to_string())?;
    for asset in assets {
        let mut matched = false;
        let mut tags = Vec::with_capacity(asset.tags.len());
        for tag in asset.tags {
            if tag.to_lowercase() == old_key {
                if !matched {
                    tags.extend(replacement.map(str::to_owned));
                    matched = true;
                }
            } else {
                tags.push(tag);
            }
        }
        if matched {
            let tags = serde_json::to_string(&tags).map_err(|error| error.to_string())?;
            update
                .execute(params![asset.id, tags])
                .map_err(|error| error.to_string())?;
        }
    }
    save_definitions(connection, &definitions)?;
    Ok(TagResult {
        name: replacement.map_or(existing, str::to_owned),
        created: None,
    })
}

async fn mutate(
    state: tauri::State<'_, AppState>,
    update: impl FnOnce(&Connection) -> Result<TagResult, String> + Send + 'static,
) -> Result<TagResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = workspaces::lock_io(&state)?;
        let catalog = lock_db(&state)?;
        let tx = Transaction::new_unchecked(&catalog.conn, TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let updated = update(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(updated)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn create_local_tag(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<TagResult, String> {
    mutate(state, move |tx| create_tag(tx, &name)).await
}

#[tauri::command]
pub(crate) async fn rename_local_tag(
    state: tauri::State<'_, AppState>,
    name: String,
    new_name: String,
) -> Result<TagResult, String> {
    mutate(state, move |tx| change_tag(tx, &name, Some(&new_name))).await
}

#[tauri::command]
pub(crate) async fn delete_local_tag(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<TagResult, String> {
    mutate(state, move |tx| change_tag(tx, &name, None)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manages_unassigned_and_legacy_tags_without_changing_other_asset_metadata() {
        let scratch = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&scratch.path().join("catalog")).unwrap();
        let source = scratch.path().join("模型.obj");
        std::fs::write(&source, b"v 0 0 0").unwrap();
        catalog.add_file(&source, "loose").unwrap();
        let id = catalog.assets().unwrap().remove(0).id;
        catalog
            .patch(
                &id,
                json!({"tags":["Oak","oak","Stone"],"notes":"原备注","rating":3,"favorite":true}),
            )
            .unwrap();
        assert!(defined_tags(&catalog).unwrap().is_empty());
        assert_eq!(
            create_tag(&catalog.conn, "  OAK  ").unwrap().created,
            Some(false)
        );
        assert_eq!(
            create_tag(&catalog.conn, "  新建  ").unwrap().created,
            Some(true)
        );
        assert_eq!(defined_tags(&catalog).unwrap(), ["新建"]);
        assert!(create_tag(&catalog.conn, "坏\0标签").is_err());
        assert!(change_tag(&catalog.conn, "oak", Some("stone")).is_err());

        assert_eq!(
            change_tag(&catalog.conn, "oAk", Some("OAK")).unwrap().name,
            "OAK"
        );
        assert_eq!(catalog.asset(&id).unwrap().tags, ["OAK", "Stone"]);
        assert_eq!(defined_tags(&catalog).unwrap(), ["新建", "OAK"]);
        change_tag(&catalog.conn, "oak", None).unwrap();
        let asset = catalog.asset(&id).unwrap();
        assert_eq!(asset.tags, ["Stone"]);
        assert_eq!(
            (asset.notes.as_str(), asset.rating, asset.favorite),
            ("原备注", 3, true)
        );
        let reopened = Catalog::open(&scratch.path().join("catalog")).unwrap();
        assert_eq!(defined_tags(&reopened).unwrap(), ["新建"]);
    }
}
