use serde::Serialize;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_updater::{Config, Update, UpdaterExt};
use tokio::sync::Mutex;
use url::Url;

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
struct UpdateInstall(Mutex<()>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NexusUpdateStatus {
    configured: bool,
    available: bool,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
}

fn github_release_feed(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Some(parts) = url.path_segments() else {
        return false;
    };
    matches!(parts.collect::<Vec<_>>().as_slice(),
        [owner, repo, "releases", "latest", "download", "latest.json"]
        if !owner.is_empty() && !repo.is_empty())
}

pub(crate) fn register(app: &mut tauri::App) -> tauri::Result<()> {
    let Some(settings) = app.config().plugins.0.get("updater") else {
        return Ok(());
    };
    let Ok(config) = serde_json::from_value::<Config>(settings.clone()) else {
        eprintln!("Nexus Updater configuration could not be read.");
        return Ok(());
    };
    if config.pubkey.trim().is_empty()
        || config.endpoints.is_empty()
        || !config.endpoints.iter().all(github_release_feed)
        || !config.require_signed_version
        || config.allow_downgrades
        || config.dangerous_insecure_transport_protocol
        || config.dangerous_accept_invalid_certs
        || config.dangerous_accept_invalid_hostnames
    {
        eprintln!("Nexus Updater requires a GitHub Release feed and versioned signatures.");
        return Ok(());
    }
    app.handle()
        .plugin(tauri_plugin_updater::Builder::new().build())?;
    app.manage(UpdateInstall::default());
    Ok(())
}

async fn find_update(app: &tauri::AppHandle) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .configure_client(|client| client.https_only(true))
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| format!("无法初始化更新检查（{error}）"))?;
    tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| "检查更新超时，请稍后重试".to_owned())?
        .map_err(|error| format!("检查更新失败（{error}）"))
}

#[tauri::command]
pub(crate) async fn check_nexus_update(app: tauri::AppHandle) -> Result<NexusUpdateStatus, String> {
    let configured = app.try_state::<UpdateInstall>().is_some();
    let update = if configured {
        find_update(&app).await?
    } else {
        None
    };
    Ok(NexusUpdateStatus {
        configured,
        available: update.is_some(),
        current_version: app.package_info().version.to_string(),
        version: update.as_ref().map(|update| update.version.clone()),
        notes: update.and_then(|update| update.body),
    })
}

#[tauri::command]
pub(crate) async fn install_nexus_update(
    app: tauri::AppHandle,
    version: String,
) -> Result<(), String> {
    let installation = app
        .try_state::<UpdateInstall>()
        .ok_or("当前版本未配置 GitHub 更新")?;
    let _installing = installation.0.try_lock().map_err(|_| "正在安装更新")?;
    let update = find_update(&app)
        .await?
        .ok_or("当前版本已是最新，请重新检查更新")?;
    if update.version != version {
        return Err("可用更新已变更，请重新检查并确认版本".to_owned());
    }

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("下载、验证或安装更新失败（{error}）"))?;
    // On Windows the updater exits after starting NSIS, which restarts the app.
    #[cfg(not(target_os = "windows"))]
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_only_accepts_github_latest_release_feeds() {
        let accepted =
            Url::parse("https://github.com/example/nexus/releases/latest/download/latest.json")
                .unwrap();
        assert!(github_release_feed(&accepted));
        for rejected in [
            "http://github.com/example/nexus/releases/latest/download/latest.json",
            "https://github.com.example.com/example/nexus/releases/latest/download/latest.json",
            "https://user@github.com/example/nexus/releases/latest/download/latest.json",
            "https://github.com/example/nexus/releases/download/v0.1.0/latest.json",
        ] {
            assert!(!github_release_feed(&Url::parse(rejected).unwrap()));
        }
    }
}
