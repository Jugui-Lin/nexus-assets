use super::{Desktop, Method, StatusCode};
use nexus_core::creative_subscriptions::*;
use serde::{de::DeserializeOwned, Serialize};
use uuid::Uuid;

const ROUTE: &str = "/v1/creative-subscriptions";
const VIDEO_ROUTE: &str = "/v1/creative-video-references";

async fn read<T: DeserializeOwned>(
    team: &Desktop,
    team_id: &str,
    route: &str,
    unavailable: T,
) -> Result<T, String> {
    let active = team.connection_for_team(team_id)?;
    let request = team.authenticated_request(&active.config, Method::GET, route, None);
    let response = Desktop::send(request).await?;
    let result = if response.status() == StatusCode::NOT_FOUND {
        unavailable
    } else {
        Desktop::decode_response(response).await?
    };
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    Ok(result)
}

async fn mutate<T: DeserializeOwned>(
    team: &Desktop,
    team_id: &str,
    method: Method,
    route: &str,
    body: &impl Serialize,
) -> Result<T, String> {
    let body = serde_json::to_vec(body).map_err(|error| error.to_string())?;
    team.scoped_request(team_id, method, route, Some(body))
        .await
}

#[tauri::command]
pub(crate) async fn team_creative_subscriptions(
    team: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<CreatorSubscriptions, String> {
    read(
        &team,
        &team_id,
        ROUTE,
        CreatorSubscriptions {
            available: false,
            subscriptions: Vec::new(),
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_create_creative_subscription(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    subscription: CreatorInput,
) -> Result<CreatorCreated, String> {
    mutate(&team, &team_id, Method::POST, ROUTE, &subscription).await
}

#[tauri::command]
pub(crate) async fn team_update_creative_subscription(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    id: Uuid,
    revision: u64,
    subscription: CreatorInput,
) -> Result<CreatorUpdated, String> {
    mutate(
        &team,
        &team_id,
        Method::PATCH,
        &format!("{ROUTE}/{id}"),
        &UpdateCreatorSubscription {
            revision,
            subscription,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_delete_creative_subscription(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    id: Uuid,
    revision: u64,
) -> Result<CreatorRemoved, String> {
    mutate(
        &team,
        &team_id,
        Method::DELETE,
        &format!("{ROUTE}/{id}"),
        &RemoveCreatorSubscription { revision },
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_creative_video_references(
    team: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<VideoReferences, String> {
    read(
        &team,
        &team_id,
        VIDEO_ROUTE,
        VideoReferences {
            available: false,
            references: Vec::new(),
            revision: 0,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_save_creative_video_reference(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    reference: VideoReferenceInput,
    migration: Option<bool>,
    revision: Option<u64>,
) -> Result<VideoReferences, String> {
    mutate(
        &team,
        &team_id,
        Method::PUT,
        VIDEO_ROUTE,
        &SaveVideoReference {
            reference,
            migration: migration.unwrap_or_default(),
            revision,
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn team_delete_creative_video_reference(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    url: String,
    revision: u64,
) -> Result<VideoReferences, String> {
    mutate(
        &team,
        &team_id,
        Method::DELETE,
        VIDEO_ROUTE,
        &RemoveVideoReference { url, revision },
    )
    .await
}
