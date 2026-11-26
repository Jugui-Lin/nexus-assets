use super::{Desktop, Method, StatusCode};
use nexus_core::browser_sites::{
    BrowserNavigation, BrowserNavigationSnapshot, BrowserNavigationUpdate,
};

const ROUTE: &str = "/v1/browser-sites";

#[tauri::command]
pub(crate) async fn team_browser_sites(
    team: tauri::State<'_, Desktop>,
    team_id: String,
) -> Result<BrowserNavigationSnapshot, String> {
    let active = team.connection_for_team(&team_id)?;
    let request = team.authenticated_request(&active.config, Method::GET, ROUTE, None);
    let response = Desktop::send(request).await?;
    let snapshot = if response.status() == StatusCode::NOT_FOUND {
        BrowserNavigationSnapshot {
            available: false,
            revision: 0,
            navigation: None,
        }
    } else {
        Desktop::decode_response(response).await?
    };
    if team.active_connection()? != active {
        return Err("团队工作空间已切换".into());
    }
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn team_save_browser_sites(
    team: tauri::State<'_, Desktop>,
    team_id: String,
    revision: u64,
    navigation: BrowserNavigation,
) -> Result<BrowserNavigationSnapshot, String> {
    let body = serde_json::to_vec(&BrowserNavigationUpdate {
        revision,
        navigation,
    })
    .map_err(|error| error.to_string())?;
    team.scoped_request(&team_id, Method::PUT, ROUTE, Some(body))
        .await
}
