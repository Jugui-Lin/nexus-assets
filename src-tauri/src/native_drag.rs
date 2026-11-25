use crate::AppState;

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn wait_asset_drag_exit() -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn start_asset_drag(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    asset_ids: Vec<String>,
) -> Result<(), String> {
    let _ = (window, state, asset_ids);
    Err("当前系统暂不支持将资产拖到其他应用".into())
}

#[cfg(target_os = "windows")]
pub use windows_drag::*;

#[cfg(target_os = "windows")]
mod windows_drag {
    use super::AppState;
    use crate::{placement::PlacementFile, resolve_asset, team_desktop::Desktop};
    use nexus_core::{clean_path, compatible, now, team::mapped_file};
    use serde::Serialize;
    use serde_json::Value;
    use std::{
        cell::RefCell,
        collections::HashSet,
        mem::{size_of, ManuallyDrop},
        os::windows::ffi::OsStrExt,
        path::{Path, PathBuf},
        ptr::{copy_nonoverlapping, null_mut},
        rc::Rc,
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };
    use tauri::Manager;
    use uuid::Uuid;
    use windows::core::{implement, BOOL, HRESULT, PWSTR};
    use windows::Win32::{
        Foundation::{
            CloseHandle, GlobalFree, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP,
            DRAGDROP_S_USEDEFAULTCURSORS, HGLOBAL, HWND, POINT, RECT, S_OK,
        },
        Graphics::Gdi::ScreenToClient,
        System::{
            Com::{
                IDataObject, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{
                IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, ReleaseStgMedium,
                CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, ReleaseCapture, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON,
            },
            Shell::{SHCreateDataObject, SHDoDragDrop, DROPFILES},
            WindowsAndMessaging::{
                GetClientRect, GetCursorPos, GetSystemMetrics, GetWindowThreadProcessId,
                WindowFromPoint, SM_SWAPBUTTON,
            },
        },
    };

    static DRAG_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DragResult {
        effect: DragEffect,
        released_before_start: bool,
        placement: bool,
        placement_host: Option<&'static str>,
        c4d_import: Option<C4dImport>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bridge_required: Option<&'static str>,
        skipped: Vec<SkippedAsset>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct C4dImport {
        session_id: String,
        asset_ids: Vec<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "lowercase")]
    enum DragEffect {
        Copy,
        Cancelled,
    }

    enum DropOutcome {
        Cancelled,
        ReleasedBeforeStart,
        Copy,
        Placement(&'static str),
        C4dImport(String),
        Blocked(&'static str),
    }

    #[derive(Serialize)]
    struct SkippedAsset {
        id: String,
        error: String,
    }

    #[tauri::command]
    pub async fn wait_asset_drag_exit(window: tauri::WebviewWindow) -> Result<bool, String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
        while drag_button_pressed() {
            let outside = cursor_outside_client(hwnd).map_err(|error| error.to_string())?;
            if outside {
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
        Ok(false)
    }

    fn cursor_outside_client(hwnd: usize) -> windows::core::Result<bool> {
        let hwnd = HWND(hwnd as *mut _);
        let mut client = RECT::default();
        let mut cursor = POINT::default();
        unsafe {
            GetClientRect(hwnd, &mut client)?;
            GetCursorPos(&mut cursor)?;
            ScreenToClient(hwnd, &mut cursor).ok()?;
        }
        Ok(point_outside_client(cursor, client))
    }

    fn point_outside_client(cursor: POINT, client: RECT) -> bool {
        cursor.x < client.left
            || cursor.x >= client.right
            || cursor.y < client.top
            || cursor.y >= client.bottom
    }

    #[tauri::command]
    pub async fn start_asset_drag(
        window: tauri::WebviewWindow,
        state: tauri::State<'_, AppState>,
        asset_ids: Vec<String>,
    ) -> Result<DragResult, String> {
        if !drag_button_pressed() {
            return drag_result(&window, DropOutcome::ReleasedBeforeStart, vec![], vec![]);
        }
        let app = window.app_handle().clone();
        let state = state.inner().clone();
        let reader = state.clone();
        let mut resolving =
            tauri::async_runtime::spawn_blocking(move || collect_paths(&reader, &app, asset_ids));
        let mut release_pid = None;
        let paths = loop {
            if escape_pressed() {
                return drag_result(&window, DropOutcome::Cancelled, vec![], vec![]);
            }
            if !drag_button_pressed() {
                // Record the target now, before a slow network check finishes
                // and the cursor may have moved away from the drop location.
                release_pid = Some(pointer_process());
                break resolving.await;
            }
            if let Ok(result) = tokio::time::timeout(Duration::from_millis(8), &mut resolving).await
            {
                if escape_pressed() {
                    return drag_result(&window, DropOutcome::Cancelled, vec![], vec![]);
                }
                if !drag_button_pressed() {
                    release_pid = Some(pointer_process());
                }
                break result;
            }
        };
        let (files, asset_ids, skipped) = paths.map_err(|error| error.to_string())?;

        let outcome = if files.is_empty() {
            DropOutcome::Cancelled
        } else if let Some(pid) = release_pid {
            released_drop(&state, pid, &files)
        } else {
            let (send, receive) = tokio::sync::oneshot::channel();
            let source = window.clone();
            window
                .run_on_main_thread(move || {
                    let result =
                        source
                            .hwnd()
                            .map_err(|error| error.to_string())
                            .and_then(|hwnd| {
                                drag_files(hwnd, state, files)
                                    .map_err(|error| format!("无法启动系统拖放：{error}"))
                            });
                    let _ = send.send(result);
                })
                .map_err(|error| error.to_string())?;
            receive.await.map_err(|error| error.to_string())??
        };
        drag_result(&window, outcome, asset_ids, skipped)
    }

    fn drag_result(
        window: &tauri::WebviewWindow,
        outcome: DropOutcome,
        asset_ids: Vec<String>,
        skipped: Vec<SkippedAsset>,
    ) -> Result<DragResult, String> {
        let released_before_start = matches!(outcome, DropOutcome::ReleasedBeforeStart);
        let (effect, placement_host, c4d_import, bridge_required) = match outcome {
            DropOutcome::Cancelled | DropOutcome::ReleasedBeforeStart => {
                (DragEffect::Cancelled, None, None, None)
            }
            DropOutcome::Copy => (DragEffect::Copy, None, None, None),
            DropOutcome::Placement(host) => (DragEffect::Copy, Some(host), None, None),
            DropOutcome::C4dImport(session_id) => {
                // The source window owns the import choices shown after the drop.
                let _ = window.set_focus();
                (
                    DragEffect::Copy,
                    None,
                    Some(C4dImport {
                        session_id,
                        asset_ids,
                    }),
                    None,
                )
            }
            DropOutcome::Blocked(message) => {
                let _ = window.set_focus();
                (DragEffect::Cancelled, None, None, Some(message))
            }
        };
        Ok(DragResult {
            effect,
            released_before_start,
            placement: placement_host.is_some(),
            placement_host,
            c4d_import,
            bridge_required,
            skipped,
        })
    }

    fn collect_paths(
        state: &AppState,
        app: &tauri::AppHandle,
        ids: Vec<String>,
    ) -> (Vec<PlacementFile>, Vec<String>, Vec<SkippedAsset>) {
        let mut paths = Vec::new();
        let mut asset_ids = Vec::new();
        let mut skipped = Vec::new();
        let mut seen_ids = HashSet::new();
        let mut seen_paths = HashSet::new();
        for id in ids {
            if !seen_ids.insert(id.clone()) {
                continue;
            }
            let path = drag_file(state, app, &id);
            match path {
                Ok(file) if seen_paths.insert(file.path.clone()) => {
                    paths.push(file);
                    asset_ids.push(id);
                }
                Ok(_) => {}
                Err(error) => skipped.push(SkippedAsset { id, error }),
            }
        }
        (paths, asset_ids, skipped)
    }

    fn drag_file(
        state: &AppState,
        app: &tauri::AppHandle,
        id: &str,
    ) -> Result<PlacementFile, String> {
        if let Some(id) = id.strip_prefix("team:") {
            // Resolve only the source file here. The preview resolver also
            // probes possible cover images, which are unrelated to drag-out.
            let (asset, root, _) = app.state::<Desktop>().mounted_asset(id)?;
            let source = mapped_file(&root, &asset.relative_path)?;
            return Ok(PlacementFile {
                path: PathBuf::from(clean_path(&source)),
                name: asset.name,
                ext: asset.ext,
            });
        }
        let asset = resolve_asset(state, app, id)?;
        let path = PathBuf::from(asset.path);
        if !path.is_absolute() || !path.is_file() {
            return Err("资产文件无法访问".into());
        }
        Ok(PlacementFile {
            path,
            name: asset.name,
            ext: asset.ext,
        })
    }

    struct ActiveDrag;

    impl Drop for ActiveDrag {
        fn drop(&mut self) {
            DRAG_IN_PROGRESS.store(false, Ordering::Release);
        }
    }

    struct OleApartment;

    impl OleApartment {
        fn initialize() -> windows::core::Result<Self> {
            unsafe { OleInitialize(None)? };
            Ok(Self)
        }
    }

    impl Drop for OleApartment {
        fn drop(&mut self) {
            unsafe { OleUninitialize() }
        }
    }

    enum Handoff {
        Placement { id: Uuid, host: &'static str },
        C4dImport(String),
        Blocked(&'static str),
    }

    impl Handoff {
        fn replaces_system_drop(&self) -> bool {
            !matches!(
                self,
                Self::Placement {
                    host: "blender",
                    ..
                }
            )
        }
    }

    #[implement(IDropSource)]
    struct PlacementDropSource {
        state: AppState,
        files: Vec<PlacementFile>,
        data: IDataObject,
        handoff: Rc<RefCell<Option<Handoff>>>,
    }

    impl PlacementDropSource {
        fn prepare_handoff(&self) -> Option<Handoff> {
            let pid = pointer_process();
            if let Some(handoff) = c4d_scene_handoff(&self.state, pid, &self.files) {
                return Some(handoff);
            }
            let (session, host) =
                eligible_target(&self.state, pid, |item| item["placement"] == true)?;
            let (id, marker) = self
                .state
                .placement
                .create(&self.state.root, &session, host, &self.files)
                .ok()?;
            if let Some(marker) = marker {
                if set_file_paths(&self.data, &[marker]).is_err() {
                    self.state.placement.revoke(id);
                    return None;
                }
            }
            Some(Handoff::Placement { id, host })
        }
    }

    impl IDropSource_Impl for PlacementDropSource_Impl {
        fn QueryContinueDrag(&self, escape: BOOL, _keys: MODIFIERKEYS_FLAGS) -> HRESULT {
            if escape.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if drag_button_pressed() {
                return S_OK;
            }
            let mut handoff = self.handoff.borrow_mut();
            if handoff.is_none() {
                *handoff = self.prepare_handoff();
            }
            // Cinema's bridge handles its own drops. Don't send it the original scene file.
            if handoff.as_ref().is_some_and(Handoff::replaces_system_drop) {
                DRAGDROP_S_CANCEL
            } else {
                DRAGDROP_S_DROP
            }
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    fn pointer_process() -> u32 {
        let mut point = POINT::default();
        let mut pid = 0;
        unsafe {
            if GetCursorPos(&mut point).is_ok() {
                GetWindowThreadProcessId(WindowFromPoint(point), Some(&mut pid));
            }
        }
        pid
    }

    fn eligible_target(
        state: &AppState,
        pid: u32,
        accepts: impl Fn(&Value) -> bool,
    ) -> Option<(String, &'static str)> {
        if pid == 0 {
            return None;
        }
        let sessions = state.sessions.lock().ok()?;
        let (id, session) = sessions
            .iter()
            .filter(|(_, item)| {
                item["pid"].as_u64() == Some(u64::from(pid))
                    && accepts(item)
                    && now().saturating_sub(item["lastSeen"].as_u64().unwrap_or(0)) < 10
            })
            .max_by_key(|(_, item)| item["lastSeen"].as_u64())?;
        let host = match session["dcc"].as_str()? {
            "blender" => "blender",
            "c4d" => "c4d",
            _ => return None,
        };
        Some((id.clone(), host))
    }

    fn c4d_scene_handoff(state: &AppState, pid: u32, files: &[PlacementFile]) -> Option<Handoff> {
        let direct = files
            .iter()
            .any(|file| compatible("c4d", &file.ext.to_ascii_lowercase()));
        let requires_conversion = files.iter().any(|file| {
            file.ext.eq_ignore_ascii_case("max") || file.ext.eq_ignore_ascii_case("blend")
        });
        if !direct && !requires_conversion {
            return None;
        }
        if let Some((session, _)) = eligible_target(state, pid, |item| {
            item["dcc"] == "c4d" && item["smartImport"] == true
        }) {
            return Some(Handoff::C4dImport(session));
        }
        let legacy = eligible_target(state, pid, |item| item["dcc"] == "c4d");
        if let (true, Some((session, _))) = (direct, &legacy) {
            return Some(Handoff::C4dImport(session.clone()));
        }
        if legacy.is_some() || is_cinema_4d_process(pid) {
            return Some(Handoff::Blocked(
                "拖入模型或工程需要 Cinema 4D 导入桥接。请在 DCC 连接中心安装或更新桥接并重启 Cinema 4D。",
            ));
        }
        None
    }

    fn released_drop(state: &AppState, pid: u32, files: &[PlacementFile]) -> DropOutcome {
        match c4d_scene_handoff(state, pid, files) {
            Some(Handoff::C4dImport(session)) => DropOutcome::C4dImport(session),
            Some(Handoff::Blocked(message)) => DropOutcome::Blocked(message),
            _ => DropOutcome::ReleasedBeforeStart,
        }
    }

    fn is_cinema_4d_process(pid: u32) -> bool {
        let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            return false;
        };
        let mut image = vec![0u16; 32768];
        let mut length = image.len() as u32;
        let result = unsafe {
            let result = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(image.as_mut_ptr()),
                &mut length,
            );
            let _ = CloseHandle(process);
            result
        };
        result.is_ok_and(|_| {
            let path = String::from_utf16_lossy(&image[..length as usize]);
            Path::new(&path)
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("Cinema 4D.exe"))
        })
    }

    fn drag_files(
        hwnd: HWND,
        state: AppState,
        files: Vec<PlacementFile>,
    ) -> windows::core::Result<DropOutcome> {
        if escape_pressed() {
            return Ok(DropOutcome::Cancelled);
        }
        if !drag_button_pressed() {
            return Ok(DropOutcome::ReleasedBeforeStart);
        }
        if DRAG_IN_PROGRESS.swap(true, Ordering::AcqRel) {
            return Ok(DropOutcome::Cancelled);
        }
        let _active = ActiveDrag;
        let _ole = OleApartment::initialize()?;
        let paths = files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        let data = file_data_object(&paths)?;
        if !drag_button_pressed() {
            return Ok(DropOutcome::ReleasedBeforeStart);
        }
        let placement = state.placement.clone();
        let handoff = Rc::new(RefCell::new(None));
        let source: IDropSource = PlacementDropSource {
            state,
            files,
            data: data.clone(),
            handoff: handoff.clone(),
        }
        .into();
        // Let the native drag loop own the pointer after the WebView started the gesture.
        let effect = unsafe {
            let _ = ReleaseCapture();
            SHDoDragDrop(Some(hwnd), &data, &source, DROPEFFECT_COPY)
        };
        let copy = effect
            .as_ref()
            .is_ok_and(|result| result.contains(DROPEFFECT_COPY));
        if let Some(sent) = handoff.take() {
            match sent {
                Handoff::C4dImport(session) => return Ok(DropOutcome::C4dImport(session)),
                Handoff::Blocked(message) => return Ok(DropOutcome::Blocked(message)),
                Handoff::Placement { host, .. } if copy || host == "c4d" => {
                    return Ok(DropOutcome::Placement(host));
                }
                Handoff::Placement { id, .. } => placement.revoke(id),
            }
        }
        effect?;
        Ok(if copy {
            DropOutcome::Copy
        } else {
            DropOutcome::Cancelled
        })
    }

    fn drag_button_pressed() -> bool {
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        let button = if swapped { VK_RBUTTON } else { VK_LBUTTON };
        (unsafe { GetAsyncKeyState(i32::from(button.0)) }) < 0
    }

    fn escape_pressed() -> bool {
        (unsafe { GetAsyncKeyState(i32::from(VK_ESCAPE.0)) }) < 0
    }

    fn drop_format() -> FORMATETC {
        FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: null_mut(),
            dwAspect: DVASPECT_CONTENT.0 as u32,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        }
    }

    fn file_data_object(paths: &[PathBuf]) -> windows::core::Result<IDataObject> {
        unsafe {
            let data: IDataObject = SHCreateDataObject(None, None, None::<&IDataObject>)?;
            set_file_paths(&data, paths)?;
            Ok(data)
        }
    }

    fn set_file_paths(data: &IDataObject, paths: &[PathBuf]) -> windows::core::Result<()> {
        unsafe {
            let mut medium = STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 {
                    hGlobal: drop_files_memory(paths)?,
                },
                pUnkForRelease: ManuallyDrop::new(None),
            };
            // The Shell data object owns the allocation after a successful SetData.
            if let Err(error) = data.SetData(&drop_format(), &medium, true) {
                ReleaseStgMedium(&mut medium);
                return Err(error);
            }
            Ok(())
        }
    }

    fn drop_files_memory(paths: &[PathBuf]) -> windows::core::Result<HGLOBAL> {
        let mut file_names = Vec::new();
        for path in paths {
            file_names.extend(path.as_os_str().encode_wide());
            file_names.push(0);
        }
        file_names.push(0);
        let header_size = size_of::<DROPFILES>();
        let bytes = header_size + size_of::<u16>() * file_names.len();
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes)?;
            let pointer = GlobalLock(memory).cast::<u8>();
            if pointer.is_null() {
                let error = windows::core::Error::from_thread();
                let _ = GlobalFree(Some(memory));
                return Err(error);
            }
            pointer.cast::<DROPFILES>().write(DROPFILES {
                pFiles: header_size as u32,
                fWide: true.into(),
                ..Default::default()
            });
            copy_nonoverlapping(
                file_names.as_ptr(),
                pointer.add(header_size).cast::<u16>(),
                file_names.len(),
            );
            let _ = GlobalUnlock(memory);
            Ok(memory)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};
        use windows::Win32::{
            System::Com::{CoTaskMemFree, DATADIR_GET},
            UI::Shell::{DragQueryFileW, HDROP},
        };

        #[test]
        fn client_bounds_include_top_left_and_exclude_bottom_right() {
            let client = RECT {
                left: 0,
                top: 0,
                right: 100,
                bottom: 80,
            };
            assert!(!point_outside_client(POINT { x: 0, y: 0 }, client));
            assert!(!point_outside_client(POINT { x: 99, y: 79 }, client));
            assert!(point_outside_client(POINT { x: -1, y: 50 }, client));
            assert!(point_outside_client(POINT { x: 50, y: -1 }, client));
            assert!(point_outside_client(POINT { x: 100, y: 50 }, client));
            assert!(point_outside_client(POINT { x: 50, y: 80 }, client));
        }

        #[test]
        fn scene_drop_uses_only_the_cinema_session_for_the_window_under_the_pointer() {
            let root = tempfile::tempdir().unwrap();
            let pid = std::process::id();
            let sessions = std::collections::HashMap::from([
                (
                    "other-instance".into(),
                    serde_json::json!({"dcc":"c4d", "pid":u64::from(pid) + 1, "smartImport":true, "lastSeen":now()}),
                ),
                (
                    "old-instance".into(),
                    serde_json::json!({"dcc":"c4d", "pid":pid, "smartImport":true, "lastSeen":now() - 60}),
                ),
                (
                    "legacy".into(),
                    serde_json::json!({"dcc":"c4d", "pid":pid, "placement":true, "lastSeen":now()}),
                ),
            ]);
            let state = AppState {
                db: std::sync::Arc::new(std::sync::Mutex::new(
                    nexus_core::Catalog::open(root.path()).unwrap(),
                )),
                root: root.path().to_path_buf(),
                workspace_io: Default::default(),
                placement: Default::default(),
                sessions: std::sync::Arc::new(std::sync::Mutex::new(sessions)),
                token: String::new(),
                port: 0,
            };
            let max = PlacementFile {
                path: PathBuf::from(r"\\nas\assets\scene.max"),
                name: "scene".into(),
                ext: "MAX".into(),
            };
            let fbx = PlacementFile {
                path: PathBuf::from(r"\\nas\assets\scene.fbx"),
                name: "scene".into(),
                ext: "fbx".into(),
            };
            let max_files = std::slice::from_ref(&max);
            let fbx_files = std::slice::from_ref(&fbx);
            let blocked = c4d_scene_handoff(&state, pid, max_files).unwrap();
            assert!(matches!(blocked, Handoff::Blocked(_)) && blocked.replaces_system_drop());
            assert!(matches!(c4d_scene_handoff(&state, pid, fbx_files),
                Some(Handoff::C4dImport(id)) if id == "legacy"));

            state.sessions.lock().unwrap().insert(
                "target-instance".into(),
                serde_json::json!({
                    "dcc":"c4d", "pid":pid, "smartImport":true, "lastSeen":now(),
                }),
            );
            let converted = c4d_scene_handoff(&state, pid, max_files).unwrap();
            assert!(matches!(&converted, Handoff::C4dImport(id) if id == "target-instance"));
            assert!(converted.replaces_system_drop());
            assert!(c4d_scene_handoff(&state, 0, max_files).is_none());

            for files in [max_files, fbx_files] {
                assert!(matches!(released_drop(&state, pid, files),
                    DropOutcome::C4dImport(id) if id == "target-instance"));
                assert!(matches!(
                    released_drop(&state, 0, files),
                    DropOutcome::ReleasedBeforeStart
                ));
            }
        }

        #[test]
        fn windows_shell_reads_all_file_paths_from_our_drag_data() {
            let _ole = OleApartment::initialize().unwrap();
            let paths = [
                PathBuf::from(r"C:\我的模型\样品一.blend"),
                PathBuf::from(r"\\nas\资产\模型 二.c4d"),
            ];
            let data = file_data_object(&paths).unwrap();
            let format = drop_format();
            unsafe {
                let formats = data.EnumFormatEtc(DATADIR_GET.0 as u32).unwrap();
                let mut found_file_format = false;
                loop {
                    let mut item = [FORMATETC::default()];
                    let mut fetched = 0;
                    formats.Next(&mut item, Some(&mut fetched)).ok().unwrap();
                    if fetched == 0 {
                        break;
                    }
                    CoTaskMemFree(Some(item[0].ptd.cast()));
                    if item[0].cfFormat == CF_HDROP.0 {
                        found_file_format = true;
                        break;
                    }
                }
                assert!(found_file_format);
                data.QueryGetData(&format).ok().unwrap();
                let mut medium = data.GetData(&format).unwrap();
                let drop = HDROP(medium.u.hGlobal.0);
                assert_eq!(DragQueryFileW(drop, u32::MAX, None), paths.len() as u32);
                for (index, path) in paths.iter().enumerate() {
                    let index = index as u32;
                    let length = DragQueryFileW(drop, index, None) as usize;
                    let mut name = vec![0; length + 1];
                    assert_eq!(DragQueryFileW(drop, index, Some(&mut name)), length as u32);
                    assert_eq!(OsString::from_wide(&name[..length]), path.as_os_str());
                }
                ReleaseStgMedium(&mut medium);
            }
        }

        #[test]
        fn shell_can_read_the_only_marker_after_release_switches_paths() {
            let _ole = OleApartment::initialize().unwrap();
            let asset = PathBuf::from(r"C:\素材\椅子.obj");
            let marker = PathBuf::from(r"C:\Nexus\viewport-drags\test.nexusdrop");
            let format = drop_format();
            let data = file_data_object(&[asset]).unwrap();
            unsafe { data.QueryGetData(&format) }.ok().unwrap();
            set_file_paths(&data, &[marker.clone()]).unwrap();
            unsafe {
                let mut medium = data.GetData(&format).unwrap();
                let drop = HDROP(medium.u.hGlobal.0);
                assert_eq!(DragQueryFileW(drop, u32::MAX, None), 1);
                let length = DragQueryFileW(drop, 0, None) as usize;
                let mut name = vec![0; length + 1];
                DragQueryFileW(drop, 0, Some(&mut name));
                ReleaseStgMedium(&mut medium);
                assert_eq!(OsString::from_wide(&name[..length]), marker.as_os_str());
            }
        }
    }
}
