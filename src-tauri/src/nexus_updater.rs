use serde::Serialize;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_updater::{Config, Update, UpdaterExt};
use tokio::sync::Mutex;
use url::Url;

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
#[cfg(windows)]
const IDLE_BEFORE_INSTALL_MS: u32 = 5 * 60 * 1000;

#[derive(Default)]
struct UpdateInstall(Mutex<Option<PreparedUpdate>>);

struct PreparedUpdate {
    release: Update,
    installer: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NexusUpdateStatus {
    configured: bool,
    automatic: bool,
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

async fn expected_update(app: &tauri::AppHandle, version: &str) -> Result<Update, String> {
    let update = find_update(app)
        .await?
        .ok_or("当前版本已是最新，请重新检查更新")?;
    if update.version != version {
        return Err("可用更新已变更，请重新检查版本".into());
    }
    Ok(update)
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
        automatic: configured && cfg!(windows),
        available: update.is_some(),
        current_version: app.package_info().version.to_string(),
        version: update.as_ref().map(|update| update.version.clone()),
        notes: update.and_then(|update| update.body),
    })
}

#[tauri::command]
pub(crate) async fn prepare_nexus_update(
    app: tauri::AppHandle,
    version: String,
) -> Result<(), String> {
    let installation = app
        .try_state::<UpdateInstall>()
        .ok_or("当前版本未配置 GitHub 更新")?;
    let mut prepared = installation
        .0
        .try_lock()
        .map_err(|_| "正在准备或安装更新")?;
    if prepared
        .as_ref()
        .is_some_and(|item| item.release.version == version)
    {
        return Ok(());
    }
    let release = expected_update(&app, &version).await?;
    let installer = release
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| format!("下载或验证更新失败（{error}）"))?;
    *prepared = Some(PreparedUpdate { release, installer });
    Ok(())
}

#[cfg(windows)]
fn passed_idle_threshold(now: u32, last_input: u32) -> bool {
    // The Windows input timestamp shares the wrapping 32-bit uptime clock.
    // A timestamp slightly ahead of that clock must not count as a long idle.
    let elapsed = now.wrapping_sub(last_input);
    (IDLE_BEFORE_INSTALL_MS..=i32::MAX as u32).contains(&elapsed)
}

#[cfg(windows)]
fn user_is_idle() -> bool {
    use windows::Win32::{
        System::SystemInformation::GetTickCount,
        UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
    };

    let mut input = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        GetLastInputInfo(&mut input).as_bool()
            && passed_idle_threshold(GetTickCount(), input.dwTime)
    }
}

#[cfg(windows)]
fn install_if_idle(app: &tauri::AppHandle, prepared: &PreparedUpdate) -> Result<bool, String> {
    use crate::{
        browser_capture::BrowserCapture, cloud_mounts::Mounts, team_desktop::Desktop, AppState,
    };

    if !user_is_idle() {
        return Ok(false);
    }
    let (Some(state), Some(team), Some(browser), Some(mounts)) = (
        app.try_state::<AppState>(),
        app.try_state::<Desktop>(),
        app.try_state::<BrowserCapture>(),
        app.try_state::<Mounts>(),
    ) else {
        return Ok(false);
    };
    let Ok(_workspace_io) = state.workspace_io.try_lock() else {
        return Ok(false);
    };
    let Ok(_team_io) = team.begin_storage_operation() else {
        return Ok(false);
    };
    let Some(_capture_slots) = browser.hold_if_idle() else {
        return Ok(false);
    };
    let Some(_mounts) = mounts.hold_if_idle() else {
        return Ok(false);
    };
    let Some(_placement) = state.placement.hold_if_idle() else {
        return Ok(false);
    };
    let Ok(catalog) = state.db.try_lock() else {
        return Ok(false);
    };
    let queued_cutoff = nexus_core::now().saturating_sub(crate::DCC_JOB_QUEUE_TIMEOUT);
    if catalog.has_pending_dcc_jobs(queued_cutoff)? || !user_is_idle() {
        return Ok(false);
    }
    // The last activity checks and launching the already verified installer
    // have no async gap. Keep file-operation leases until Tauri hands off.
    prepared
        .release
        .install(&prepared.installer)
        .map_err(|error| format!("安装更新失败（{error}）"))?;
    Ok(true)
}

#[cfg(not(windows))]
fn install_if_idle(_app: &tauri::AppHandle, _prepared: &PreparedUpdate) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub(crate) async fn apply_prepared_nexus_update(
    app: tauri::AppHandle,
    version: String,
) -> Result<bool, String> {
    let installation = app
        .try_state::<UpdateInstall>()
        .ok_or("当前版本未配置 GitHub 更新")?;
    let mut prepared = installation
        .0
        .try_lock()
        .map_err(|_| "正在准备或安装更新")?;
    let staged = prepared
        .as_ref()
        .filter(|item| item.release.version == version)
        .ok_or("待安装版本已变更，请重新准备更新")?;
    if !install_if_idle(&app, staged)? {
        return Ok(false);
    }
    *prepared = None;
    Ok(true)
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
    let update = expected_update(&app, &version).await?;

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

    #[cfg(windows)]
    #[test]
    fn idle_clock_tracks_recent_input_and_handles_tick_wrap() {
        assert!(!passed_idle_threshold(IDLE_BEFORE_INSTALL_MS - 1, 0));
        assert!(passed_idle_threshold(IDLE_BEFORE_INSTALL_MS, 0));
        assert!(!passed_idle_threshold(100, 101));
        assert!(passed_idle_threshold(IDLE_BEFORE_INSTALL_MS + 1, u32::MAX));
    }
}
