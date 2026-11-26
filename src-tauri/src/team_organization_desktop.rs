use super::{Desktop, Method, StatusCode};
use nexus_core::{team_organization::*, AssetCollection, Catalog};
use serde::Serialize;
use uuid::Uuid;

const ROUTE: &str = "/v1/organization";

fn team_asset(id: &str) -> Result<Uuid, String> {
    id.strip_prefix("team:")
        .and_then(|uuid| Uuid::parse_str(uuid).ok())
        .ok_or_else(|| "团队资产编号无效".into())
}

fn desktop_ids(ids: &mut [String]) {
    for id in ids {
        *id = format!("team:{id}");
    }
}

fn body(value: &impl Serialize) -> Result<Option<Vec<u8>>, String> {
    serde_json::to_vec(value)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn team_organization(
    team: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<Organization, String> {
    let active = team.connection_for_team(&team_id)?;
    let request = team.authenticated_request(&active.config, Method::GET, ROUTE, None);
    let response = Desktop::send(request).await?;
    let mut result: Organization = if response.status() == StatusCode::NOT_FOUND {
        Organization {
            available: false,
            revision: 0,
            favorite_ids: Vec::new(),
            favorite_times: None,
            collections: Vec::new(),
        }
    } else {
        Desktop::decode_response(response).await?
    };
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    desktop_ids(&mut result.favorite_ids);
    result.favorite_times = result.favorite_times.map(|times| {
        times
            .into_iter()
            .map(|(id, time)| (format!("team:{id}"), time))
            .collect()
    });
    for collection in &mut result.collections {
        desktop_ids(&mut collection.asset_ids);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn team_local_organization(
    team: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<LocalOrganization, String> {
    let active = team.connection_for_team(&team_id)?;
    let key = format!("{}:{}", active.identity.team_id, active.identity.member_id);
    let mut favorite_ids: Vec<String> = team
        .data
        .lock()
        .map_err(|_| "团队目录不可用")?
        .prefs
        .favorites
        .get(&key)
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    favorite_ids.sort_unstable();
    desktop_ids(&mut favorite_ids);
    let directory = team.db_dir.clone();
    let collections = tauri::async_runtime::spawn_blocking(move || {
        Catalog::open(&directory)?.list_collections(&format!("team:{key}"))
    })
    .await
    .map_err(|error| error.to_string())??;
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    Ok(LocalOrganization {
        favorite_ids,
        collections,
    })
}

#[tauri::command]
pub(crate) async fn team_set_favorite(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    id: String,
    favorite: bool,
) -> Result<FavoriteChanged, String> {
    let asset = team_asset(&id)?;
    team.scoped_request(
        &team_id,
        Method::PATCH,
        &format!("{ROUTE}/favorites/{asset}"),
        body(&FavoriteRequest { favorite })?,
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_create_collection(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    name: String,
) -> Result<AssetCollection, String> {
    team.scoped_request(
        &team_id,
        Method::POST,
        &format!("{ROUTE}/collections"),
        body(&CollectionName { name })?,
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_rename_collection(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    id: Uuid,
    name: String,
) -> Result<AssetCollection, String> {
    let mut result: AssetCollection = team
        .scoped_request(
            &team_id,
            Method::PATCH,
            &format!("{ROUTE}/collections/{id}"),
            body(&CollectionName { name })?,
        )
        .await?;
    desktop_ids(&mut result.asset_ids);
    Ok(result)
}

#[tauri::command]
pub(crate) async fn team_delete_collection(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    id: Uuid,
) -> Result<CollectionRemoved, String> {
    team.scoped_request(
        &team_id,
        Method::DELETE,
        &format!("{ROUTE}/collections/{id}"),
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_set_collection_membership(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    id: Uuid,
    asset_ids: Vec<String>,
    include: bool,
) -> Result<AssetCollection, String> {
    let asset_ids = asset_ids
        .iter()
        .map(|id| team_asset(id).map(|id| id.to_string()))
        .collect::<Result<_, _>>()?;
    let mut result: AssetCollection = team
        .scoped_request(
            &team_id,
            Method::PATCH,
            &format!("{ROUTE}/collections/{id}/members"),
            body(&CollectionMembership { asset_ids, include })?,
        )
        .await?;
    desktop_ids(&mut result.asset_ids);
    Ok(result)
}
