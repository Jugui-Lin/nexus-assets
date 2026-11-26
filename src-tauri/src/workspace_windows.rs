use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
#[cfg(windows)]
use tauri::Emitter;
use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::sync::oneshot;
use uuid::Uuid;

const MAIN_LABEL: &str = "main";
const DETACHED_PREFIX: &str = "nexus-tab-";
const RESTORE_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_TAB_BYTES: usize = 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum TabKind {
    Files,
    Assets,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct TabTransfer {
    kind: TabKind,
    tab: Map<String, Value>,
}

struct PendingTab {
    source: String,
    payload: Option<TabTransfer>,
    restored: Option<oneshot::Sender<bool>>,
}

pub(crate) struct WorkspaceWindows {
    pending: Mutex<HashMap<String, PendingTab>>,
    opening_main: AtomicBool,
}

impl Default for WorkspaceWindows {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            opening_main: AtomicBool::new(true),
        }
    }
}

fn detached_label(label: &str) -> bool {
    label
        .strip_prefix(DETACHED_PREFIX)
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

pub(crate) fn has_multiple_workspace_windows(app: &AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .filter(|label| label.as_str() == MAIN_LABEL || detached_label(label))
        .take(2)
        .count()
        == 2
}

impl WorkspaceWindows {
    fn pending(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, PendingTab>>, String> {
        self.pending
            .lock()
            .map_err(|_| "无法读取正在迁移的标签页".into())
    }

    fn begin(
        &self,
        source: &str,
        label: String,
        payload: TabTransfer,
    ) -> Result<oneshot::Receiver<bool>, String> {
        let mut pending = self.pending()?;
        if pending.contains_key(source) || pending.values().any(|tab| tab.source == source) {
            return Err("请等待当前标签页迁移完成".into());
        }
        let (restored, reply) = oneshot::channel();
        pending.insert(
            label,
            PendingTab {
                source: source.to_owned(),
                payload: Some(payload),
                restored: Some(restored),
            },
        );
        Ok(reply)
    }

    fn take(&self, label: &str) -> Result<Option<TabTransfer>, String> {
        if !detached_label(label) {
            return Ok(None);
        }
        Ok(self
            .pending()?
            .get_mut(label)
            .filter(|tab| tab.restored.is_some())
            .and_then(|tab| tab.payload.take()))
    }

    fn finish(&self, label: &str, restored: bool) -> Result<bool, String> {
        if !detached_label(label) {
            return Ok(false);
        }
        let accepted = self
            .pending()?
            .get_mut(label)
            .filter(|tab| !restored || tab.payload.is_none())
            .and_then(|tab| tab.restored.take())
            .is_some_and(|signal| signal.send(restored).is_ok());
        Ok(accepted && restored)
    }

    fn remove(&self, label: &str) -> bool {
        self.pending()
            .is_ok_and(|mut pending| pending.remove(label).is_some())
    }
}

fn main_config(app: &AppHandle) -> Option<&tauri::utils::config::WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|config| config.label == MAIN_LABEL)
}

fn build_workspace_window(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let mut config = main_config(app)
        .ok_or(tauri::Error::WindowNotFound)?
        .clone();
    config.label = label.to_owned();
    config.url = WebviewUrl::App("index.html".into());
    let builder = WebviewWindowBuilder::from_config(app, &config)?
        .visible(false)
        .focused(config.focus && label == MAIN_LABEL);
    #[cfg(windows)]
    let builder = builder.decorations(false).shadow(true);
    let window = builder.build()?;
    #[cfg(windows)]
    {
        super::configure_main_window_frame(&window);
        if let Err(error) = super::youtube_player::install(&window, &app.config().identifier) {
            eprintln!("Could not initialize the YouTube player: {error}");
        }
    }
    Ok(window)
}

fn place_detached_window(
    app: &AppHandle,
    window: &WebviewWindow,
    cursor: PhysicalPosition<f64>,
) -> tauri::Result<()> {
    let Some(monitor) = app.monitor_from_point(cursor.x, cursor.y)? else {
        return Ok(());
    };
    let area = monitor.work_area();
    let outer = window.outer_size()?;
    let scale = monitor.scale_factor();
    let scale_change = scale / window.scale_factor()?;
    let width = (f64::from(outer.width) * scale_change).ceil() as u32;
    let height = (f64::from(outer.height) * scale_change).ceil() as u32;
    let left = f64::from(area.position.x);
    let top = f64::from(area.position.y);
    let right = left + f64::from(area.size.width.saturating_sub(width));
    let bottom = top + f64::from(area.size.height.saturating_sub(height));
    window.set_position(PhysicalPosition::new(
        (cursor.x - 32.0 * scale).clamp(left, right).round() as i32,
        (cursor.y - 16.0 * scale).clamp(top, bottom).round() as i32,
    ))
}

pub(crate) fn initialize_main(app: &AppHandle) -> tauri::Result<()> {
    let Some(visible) = main_config(app).map(|config| config.visible) else {
        app.state::<WorkspaceWindows>()
            .opening_main
            .store(false, Ordering::Release);
        return Ok(());
    };
    let result = build_workspace_window(app, MAIN_LABEL).and_then(|window| {
        if visible {
            window.show()
        } else {
            Ok(())
        }
    });
    app.state::<WorkspaceWindows>()
        .opening_main
        .store(false, Ordering::Release);
    result
}

#[cfg(windows)]
fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(windows)]
pub(crate) fn focus_after_relaunch(app: &AppHandle, requested_folder: bool) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        if requested_folder {
            let _ = app.emit_to(MAIN_LABEL, "nexus-local-folder-request", ());
        }
        focus(&window);
        return;
    }
    let Some(state) = app.try_state::<WorkspaceWindows>() else {
        return;
    };
    if state.opening_main.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match build_workspace_window(&app, MAIN_LABEL) {
            Ok(window) => focus(&window),
            Err(error) => {
                eprintln!("Could not reopen the main workspace: {error}");
                if let Some(window) = app.webview_windows().into_values().find(|window| {
                    detached_label(window.label()) && window.is_visible().unwrap_or(false)
                }) {
                    focus(&window);
                }
            }
        }
        app.state::<WorkspaceWindows>()
            .opening_main
            .store(false, Ordering::Release);
    });
}

pub(crate) fn discard_window(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<WorkspaceWindows>() else {
        return;
    };
    let children = if let Ok(mut pending) = state.pending() {
        pending.remove(label);
        let children: Vec<_> = pending
            .iter()
            .filter(|(_, tab)| tab.source == label)
            .map(|(label, _)| label.clone())
            .collect();
        for child in &children {
            pending.remove(child);
        }
        children
    } else {
        return;
    };
    if children.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for child in children {
            if let Some(window) = app.get_webview_window(&child) {
                let _ = window.destroy();
            }
        }
    });
}

#[tauri::command]
pub(crate) async fn open_detached_workspace_tab(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, WorkspaceWindows>,
    payload: TabTransfer,
) -> Result<bool, String> {
    let source = window.label();
    if source != MAIN_LABEL && !detached_label(source) {
        return Err("当前窗口无法分离标签页".into());
    }
    if payload.tab.is_empty()
        || serde_json::to_vec(&payload)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_TAB_BYTES
    {
        return Err("标签页状态无效或过大".into());
    }
    let cursor = app.cursor_position().ok();
    let label = format!("{DETACHED_PREFIX}{}", Uuid::new_v4().simple());
    let reply = state.begin(source, label.clone(), payload)?;
    let child = match build_workspace_window(&app, &label) {
        Ok(child) => child,
        Err(error) => {
            state.remove(&label);
            return Err(format!("无法打开标签页窗口：{error}"));
        }
    };
    if let Some(cursor) = cursor {
        let _ = place_detached_window(&app, &child, cursor);
    }
    let restored = matches!(
        tokio::time::timeout(RESTORE_TIMEOUT, reply).await,
        Ok(Ok(true))
    );
    if restored
        && app.get_webview_window(source).is_some()
        && child.show().is_ok()
        && child.is_visible().unwrap_or(false)
        && state.remove(&label)
    {
        let _ = child.set_focus();
        return Ok(true);
    }
    state.remove(&label);
    let _ = child.destroy();
    Ok(false)
}

#[tauri::command]
pub(crate) fn take_detached_workspace_tab(
    window: WebviewWindow,
    state: tauri::State<'_, WorkspaceWindows>,
) -> Result<Option<TabTransfer>, String> {
    state.take(window.label())
}

#[tauri::command]
pub(crate) fn finish_detached_workspace_tab(
    window: WebviewWindow,
    state: tauri::State<'_, WorkspaceWindows>,
    restored: bool,
) -> Result<bool, String> {
    state.finish(window.label(), restored)
}
