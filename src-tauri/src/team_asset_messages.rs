use super::{Desktop, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inbox {
    messages: Vec<AssetMessage>,
    #[serde(default = "inbox_available")]
    available: bool,
    #[serde(default)]
    pokes_available: bool,
    #[serde(default)]
    video_references_available: bool,
}

fn inbox_available() -> bool { true }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetMessage {
    id: Uuid,
    sender_name: String,
    asset_ids: Vec<String>,
    created: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    video_reference: Option<VideoReferenceTarget>,
}

#[derive(Deserialize, Serialize)]
struct VideoReferenceTarget {
    key: String,
    title: String,
}

#[tauri::command]
pub(crate) async fn team_send_asset_message(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    recipient_id: Uuid,
    asset_ids: Vec<String>,
) -> Result<Value, String> {
    if asset_ids.is_empty() || asset_ids.len() > 20 {
        return Err("每条消息可发送 1 至 20 项团队资产".into());
    }
    let asset_ids = asset_ids
        .iter()
        .map(|id| {
            id.strip_prefix("team:")
                .and_then(|id| Uuid::parse_str(id).ok())
                .ok_or("只能发送当前团队库的资产位置")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let active = team.active_connection()?;
    if active.identity.team_id != team_id || active.identity.member_id == recipient_id.to_string() {
        return Err("请选择当前团队的其他成员".into());
    }
    let body = serde_json::to_vec(&json!({"recipientId":recipient_id,"assetIds":asset_ids}))
        .map_err(|e| e.to_string())?;
    let response = team
        .request(
            &active.config,
            Method::POST,
            "/v1/asset-messages",
            Some(body),
        )
        .await?;
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn team_send_video_reference_message(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    recipient_id: Uuid,
    reference_key: String,
) -> Result<Value, String> {
    let active = team.connection_for_team(&team_id)?;
    if active.identity.member_id == recipient_id.to_string() {
        return Err("请选择当前团队的其他成员".into());
    }
    let body = serde_json::to_vec(&json!({
        "recipientId": recipient_id,
        "referenceKey": reference_key,
    }))
    .map_err(|error| error.to_string())?;
    let response = team
        .request(
            &active.config,
            Method::POST,
            "/v1/creative-video-reference-messages",
            Some(body),
        )
        .await?;
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn team_asset_messages(
    team: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<Inbox, String> {
    let active = team.active_connection()?;
    if active.identity.team_id != team_id {
        return Err("团队工作空间已切换".into());
    }
    let request = team.authenticated_request(
        &active.config,
        Method::GET,
        "/v1/asset-messages?videoReferences=true",
        None,
    );
    let response = Desktop::send(request).await?;
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Inbox {
            messages: Vec::new(),
            available: false,
            pokes_available: false,
            video_references_available: false,
        });
    }
    let mut inbox: Inbox = Desktop::decode_response(response).await?;
    for message in &mut inbox.messages {
        message.asset_ids = message
            .asset_ids
            .iter()
            .filter_map(|id| Uuid::parse_str(id).ok().map(|id| format!("team:{id}")))
            .collect();
    }
    Ok(inbox)
}

#[tauri::command]
pub(crate) async fn team_send_poke(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    recipient_id: Uuid,
) -> Result<Value, String> {
    let active = team.active_connection()?;
    if active.identity.team_id != team_id || active.identity.member_id == recipient_id.to_string() {
        return Err("请选择当前团队的其他成员".into());
    }
    let body = serde_json::to_vec(&json!({"recipientId":recipient_id})).map_err(|error| error.to_string())?;
    let response = team.request(&active.config, Method::POST, "/v1/member-pokes", Some(body)).await?;
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn team_dismiss_asset_message(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    message_id: Uuid,
) -> Result<Value, String> {
    let active = team.active_connection()?;
    if active.identity.team_id != team_id {
        return Err("团队工作空间已切换".into());
    }
    let route = format!("/v1/asset-messages/{message_id}");
    let response = team
        .request(&active.config, Method::DELETE, &route, None)
        .await?;
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    Ok(response)
}
