use super::{Connection, ConnectionIdentity, Desktop, Method, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

const ROUTE: &str = "/v1/quick-access";

#[tauri::command]
pub(crate) async fn team_quick_access(
    state: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<Value, String> {
    let active = state.active_connection()?;
    if active.identity.team_id != team_id {
        return Err("团队工作空间已切换".into());
    }
    let request = state.authenticated_request(&active.config, Method::GET, ROUTE, None);
    let response = Desktop::send(request).await?;
    if state.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(json!({"available":false,"pins":[],"revision":0}));
    }
    let mut snapshot: Value = Desktop::decode_response(response).await?;
    snapshot["available"] = json!(true);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn team_set_quick_access(
    state: tauri::State<'_, Desktop>,
    team_id: String,
    library_id: Uuid,
    folder: String,
    pinned: bool,
) -> Result<Value, String> {
    let _operation = state.begin_storage_operation()?;
    let active = state.active_connection()?;
    if active.identity.team_id != team_id {
        return Err("团队工作空间已切换".into());
    }
    let identity: ConnectionIdentity = state
        .request(&active.config, Method::GET, "/v1/info", None)
        .await?;
    if identity != active.identity || state.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    let body = serde_json::to_vec(&json!({"libraryId":library_id,"folder":folder,"pinned":pinned}))
        .map_err(|error| error.to_string())?;
    let mut snapshot: Value = state
        .request(&active.config, Method::PUT, ROUTE, Some(body))
        .await
        .map_err(|error| {
            if error == format!("团队服务返回错误 {}", StatusCode::NOT_FOUND) {
                "请先更新团队服务以同步快速访问".into()
            } else {
                error
            }
        })?;
    if state.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    snapshot["available"] = json!(true);
    Ok(snapshot)
}

pub(super) async fn relocate(
    state: &Desktop,
    connection: &Connection,
    library_id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let body = serde_json::to_vec(&json!({"libraryId":library_id,"from":from,"to":to}))
        .map_err(|error| error.to_string())?;
    let request = state.authenticated_request(
        connection,
        Method::POST,
        "/v1/quick-access/relocate",
        Some(body),
    );
    let response = Desktop::send(request).await?;
    if response.status() != StatusCode::NOT_FOUND {
        let _: Value = Desktop::decode_response(response).await?;
    }
    Ok(())
}
