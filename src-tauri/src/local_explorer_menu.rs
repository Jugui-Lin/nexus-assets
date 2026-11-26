#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalExplorerMenuResult {
    shown: bool,
    action: Option<&'static str>,
    command_invoked: bool,
}

#[tauri::command]
pub(crate) async fn show_local_explorer_context_menu(
    window: tauri::Window,
    directory_path: String,
    selected_paths: Vec<String>,
    view: Option<String>,
    sort_by: Option<String>,
    descending: Option<bool>,
    group_by: Option<String>,
) -> Result<LocalExplorerMenuResult, String> {
    #[cfg(windows)]
    {
        use std::time::Duration;

        let Some(pointer) = windows_menu::MenuPointer::read() else {
            return Ok(LocalExplorerMenuResult::default());
        };
        let directory = directory_path.clone();
        let target =
            crate::folder_browser::read_location(Duration::from_secs(3), move |cancelled| {
                Ok(windows_menu::MenuTarget::prepare(
                    &directory,
                    &selected_paths,
                    cancelled,
                ))
            })
            .await?;
        let Some(target) = target else {
            return Ok(LocalExplorerMenuResult::default());
        };
        let layout = windows_menu::MenuLayout {
            view,
            sort_by,
            descending,
            group_by,
        };
        let (send, receive) = tokio::sync::oneshot::channel();
        let source = window.clone();
        window
            .run_on_main_thread(move || {
                let result = source
                    .hwnd()
                    .map_err(|error| error.to_string())
                    .and_then(|hwnd| {
                        windows_menu::show(hwnd, &directory_path, pointer, target, layout)
                    });
                let _ = send.send(result);
            })
            .map_err(|error| error.to_string())?;
        receive.await.map_err(|error| error.to_string())?
    }

    #[cfg(not(windows))]
    {
        let _ = (
            window,
            directory_path,
            selected_paths,
            view,
            sort_by,
            descending,
            group_by,
        );
        Ok(LocalExplorerMenuResult::default())
    }
}

#[cfg(windows)]
mod windows_menu {
    use super::LocalExplorerMenuResult;
    use std::{
        os::windows::ffi::OsStrExt,
        path::Path,
        ptr::{null_mut, NonNull},
        sync::atomic::{AtomicBool, Ordering},
    };
    use windows::{
        core::{w, Interface, PCSTR, PCWSTR},
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
            System::Com::{
                CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
            },
            UI::{
                Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SHIFT},
                Shell::{
                    Common::ITEMIDLIST, DefSubclassProc, IContextMenu, IContextMenu2,
                    IContextMenu3, ILClone, ILFindLastID, ILIsEqual, ILRemoveLastID, IShellFolder,
                    RemoveWindowSubclass, SHBindToParent, SHGetDesktopFolder, SHParseDisplayName,
                    SetWindowSubclass, CMF_EXTENDEDVERBS, CMF_ITEMMENU, CMF_NORMAL,
                    CMIC_MASK_CONTROL_DOWN, CMIC_MASK_PTINVOKE, CMIC_MASK_SHIFT_DOWN,
                    CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX, SEE_MASK_UNICODE,
                },
                WindowsAndMessaging::{
                    AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, GetMenuItemCount,
                    InsertMenuW, TrackPopupMenu, HMENU, MF_BYPOSITION, MF_CHECKED, MF_POPUP,
                    MF_SEPARATOR, MF_STRING, SW_SHOWNORMAL, TPM_RETURNCMD, TPM_RIGHTBUTTON,
                    WM_DRAWITEM, WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR,
                },
            },
        },
    };

    const FIRST_COMMAND: i32 = 1;
    const LAST_COMMAND: i32 = 0x7fff;

    pub(super) struct ShellId(NonNull<ITEMIDLIST>);

    // An item ID list contains serialized namespace identifiers in task memory.
    // It can be used and freed on another thread independently of the parsing COM apartment.
    unsafe impl Send for ShellId {}

    impl ShellId {
        fn from_path(path: &str) -> Option<Self> {
            let path = Path::new(path);
            crate::folder_browser::validate_directory(path).ok()?;
            let mut name: Vec<_> = path.as_os_str().encode_wide().collect();
            if name.contains(&0) {
                return None;
            }
            name.push(0);
            let mut id = null_mut();
            unsafe {
                SHParseDisplayName(PCWSTR(name.as_ptr()), None::<&IBindCtx>, &mut id, 0, None)
            }
            .ok()?;
            NonNull::new(id).map(Self)
        }

        fn parent(&self) -> Option<Self> {
            let parent = Self(NonNull::new(unsafe { ILClone(self.0.as_ptr()) })?);
            unsafe { ILRemoveLastID(Some(parent.0.as_ptr())) }
                .as_bool()
                .then_some(parent)
        }
    }

    impl Drop for ShellId {
        fn drop(&mut self) {
            unsafe { CoTaskMemFree(Some(self.0.as_ptr().cast())) };
        }
    }

    pub(super) enum MenuTarget {
        Background(ShellId),
        Selection(Vec<ShellId>),
    }

    impl MenuTarget {
        pub(super) fn prepare(
            directory: &str,
            selection: &[String],
            cancelled: &AtomicBool,
        ) -> Option<Self> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .ok()?;
            let result = if selection.is_empty() {
                ShellId::from_path(directory).map(Self::Background)
            } else {
                selection
                    .iter()
                    .map(|path| {
                        (!cancelled.load(Ordering::Acquire))
                            .then(|| ShellId::from_path(path))
                            .flatten()
                    })
                    .collect::<Option<Vec<_>>>()
                    .map(Self::Selection)
            };
            unsafe { CoUninitialize() };
            result
        }
    }

    pub(super) struct MenuPointer {
        at: POINT,
        shift: bool,
        control: bool,
    }

    impl MenuPointer {
        pub(super) fn read() -> Option<Self> {
            let mut at = POINT::default();
            unsafe { GetCursorPos(&mut at) }.ok()?;
            Some(Self {
                at,
                shift: unsafe { GetAsyncKeyState(i32::from(VK_SHIFT.0)) } < 0,
                control: unsafe { GetAsyncKeyState(i32::from(VK_CONTROL.0)) } < 0,
            })
        }
    }

    struct Popup(HMENU);

    impl Popup {
        fn new() -> windows::core::Result<Self> {
            unsafe { CreatePopupMenu() }.map(Self)
        }

        fn choice(
            &self,
            action: MenuAction,
            label: PCWSTR,
            checked: bool,
        ) -> windows::core::Result<()> {
            let flags = if checked {
                MF_STRING | MF_CHECKED
            } else {
                MF_STRING
            };
            unsafe { AppendMenuW(self.0, flags, action as usize, label) }
        }

        fn separator(&self) -> windows::core::Result<()> {
            unsafe { AppendMenuW(self.0, MF_SEPARATOR, 0, PCWSTR::null()) }
        }

        fn submenu(
            &self,
            position: u32,
            label: PCWSTR,
            choices: &[(MenuAction, PCWSTR, bool)],
        ) -> windows::core::Result<()> {
            let submenu = Popup::new()?;
            for &(action, label, checked) in choices {
                if matches!(action, MenuAction::SortAscending) {
                    submenu.separator()?;
                }
                submenu.choice(action, label, checked)?;
            }
            unsafe {
                InsertMenuW(
                    self.0,
                    position,
                    MF_BYPOSITION | MF_POPUP,
                    submenu.0 .0 as usize,
                    label,
                )
            }?;
            // The parent menu now owns and releases the submenu.
            std::mem::forget(submenu);
            Ok(())
        }
    }

    impl Drop for Popup {
        fn drop(&mut self) {
            let _ = unsafe { DestroyMenu(self.0) };
        }
    }

    #[derive(Clone, Copy)]
    #[repr(usize)]
    enum MenuAction {
        ViewDetails = 0x8001,
        ViewGrid,
        SortName,
        SortDate,
        SortType,
        SortSize,
        SortAscending,
        SortDescending,
        GroupNone,
        GroupDate,
        Refresh,
    }

    impl MenuAction {
        fn name(command: i32) -> Option<&'static str> {
            const NAMES: &[&str] = &[
                "view-details",
                "view-grid",
                "sort-name",
                "sort-date",
                "sort-type",
                "sort-size",
                "sort-asc",
                "sort-desc",
                "group-none",
                "group-date",
                "refresh",
            ];
            let index = command.checked_sub(Self::ViewDetails as i32)?;
            NAMES.get(usize::try_from(index).ok()?).copied()
        }
    }

    pub(super) struct MenuLayout {
        pub(super) view: Option<String>,
        pub(super) sort_by: Option<String>,
        pub(super) descending: Option<bool>,
        pub(super) group_by: Option<String>,
    }

    impl MenuLayout {
        fn populate(&self, popup: &Popup) -> windows::core::Result<()> {
            use MenuAction::*;

            let grid = self.view.as_deref() == Some("grid");
            popup.submenu(
                0,
                w!("查看"),
                &[
                    (ViewGrid, w!("图标"), grid),
                    (ViewDetails, w!("详细信息"), !grid),
                ],
            )?;
            let sort = self.sort_by.as_deref().unwrap_or("name");
            let descending = self.descending.unwrap_or_default();
            popup.submenu(
                1,
                w!("排序方式"),
                &[
                    (SortName, w!("名称"), sort == "name"),
                    (SortDate, w!("修改日期"), sort == "date"),
                    (SortType, w!("类型"), sort == "type"),
                    (SortSize, w!("大小"), sort == "size"),
                    (SortAscending, w!("升序"), !descending),
                    (SortDescending, w!("降序"), descending),
                ],
            )?;
            let group_date = self.group_by.as_deref() == Some("date");
            popup.submenu(
                2,
                w!("分组依据"),
                &[
                    (GroupNone, w!("无"), !group_date),
                    (GroupDate, w!("修改日期"), group_date),
                ],
            )?;
            unsafe {
                InsertMenuW(
                    popup.0,
                    3,
                    MF_BYPOSITION | MF_STRING,
                    Refresh as usize,
                    w!("刷新"),
                )?;
                InsertMenuW(popup.0, 4, MF_BYPOSITION | MF_SEPARATOR, 0, PCWSTR::null())
            }
        }
    }

    enum MenuMessages {
        WithResult(IContextMenu3),
        WithoutResult(IContextMenu2),
    }

    // The subclass holds a pointer to `MenuMessages` only while TrackPopupMenu runs.
    struct MenuSubclass<'a> {
        window: HWND,
        messages: &'a MenuMessages,
    }

    impl<'a> MenuSubclass<'a> {
        fn install(window: HWND, messages: &'a MenuMessages) -> Option<Self> {
            let address = messages as *const MenuMessages as usize;
            unsafe { SetWindowSubclass(window, Some(menu_message), address, address) }
                .as_bool()
                .then_some(Self { window, messages })
        }
    }

    impl Drop for MenuSubclass<'_> {
        fn drop(&mut self) {
            unsafe {
                let _ = RemoveWindowSubclass(
                    self.window,
                    Some(menu_message),
                    self.messages as *const MenuMessages as usize,
                );
            }
        }
    }

    unsafe extern "system" fn menu_message(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass: usize,
        data: usize,
    ) -> LRESULT {
        let is_menu_message = match message {
            WM_DRAWITEM | WM_MEASUREITEM => wparam.0 == 0,
            WM_INITMENUPOPUP | WM_MENUCHAR => true,
            _ => false,
        };
        if is_menu_message {
            let messages = &*(data as *const MenuMessages);
            match messages {
                MenuMessages::WithResult(menu) => {
                    let mut result = LRESULT(0);
                    if menu
                        .HandleMenuMsg2(message, wparam, lparam, Some(&mut result))
                        .is_ok()
                    {
                        return result;
                    }
                }
                MenuMessages::WithoutResult(menu) if message != WM_MENUCHAR => {
                    if menu.HandleMenuMsg(message, wparam, lparam).is_ok() {
                        return LRESULT((message != WM_INITMENUPOPUP) as isize);
                    }
                }
                MenuMessages::WithoutResult(_) => {}
            }
        }
        DefSubclassProc(window, message, wparam, lparam)
    }

    fn folder_menu(window: HWND, directory: &ShellId) -> Option<IContextMenu> {
        unsafe {
            let desktop = SHGetDesktopFolder().ok()?;
            let folder: IShellFolder = desktop
                .BindToObject(directory.0.as_ptr(), None::<&IBindCtx>)
                .ok()?;
            folder.CreateViewObject(window).ok()
        }
    }

    fn selection_menu(window: HWND, ids: &[ShellId]) -> Option<IContextMenu> {
        let first = ids.first()?;
        let mut children = Vec::with_capacity(ids.len());
        unsafe {
            let mut first_child = null_mut();
            let parent: IShellFolder =
                SHBindToParent(first.0.as_ptr(), Some(&mut first_child)).ok()?;
            children.push(first_child as *const ITEMIDLIST);
            if ids.len() > 1 {
                let parent_id = first.parent()?;
                for id in &ids[1..] {
                    let other_parent = id.parent()?;
                    if !ILIsEqual(parent_id.0.as_ptr(), other_parent.0.as_ptr()).as_bool() {
                        return None;
                    }
                    children.push(ILFindLastID(id.0.as_ptr()) as *const ITEMIDLIST);
                }
            }
            parent.GetUIObjectOf(window, &children, None).ok()
        }
    }

    pub(super) fn show(
        window: HWND,
        directory_path: &str,
        pointer: MenuPointer,
        target: MenuTarget,
        layout: MenuLayout,
    ) -> Result<LocalExplorerMenuResult, String> {
        let (context, mut flags) = match &target {
            MenuTarget::Background(directory) => (folder_menu(window, directory), CMF_NORMAL),
            MenuTarget::Selection(items) => (selection_menu(window, items), CMF_ITEMMENU),
        };
        let Some(context) = context else {
            return Ok(LocalExplorerMenuResult::default());
        };
        let Ok(popup) = Popup::new() else {
            return Ok(LocalExplorerMenuResult::default());
        };
        if pointer.shift {
            flags |= CMF_EXTENDEDVERBS;
        }
        let result = unsafe {
            context.QueryContextMenu(popup.0, 0, FIRST_COMMAND as u32, LAST_COMMAND as u32, flags)
        };
        if result.is_err() || unsafe { GetMenuItemCount(Some(popup.0)) } <= 0 {
            return Ok(LocalExplorerMenuResult::default());
        }
        if matches!(target, MenuTarget::Background(_)) {
            layout.populate(&popup).map_err(|error| error.to_string())?;
        }

        let messages = context
            .cast::<IContextMenu3>()
            .map(MenuMessages::WithResult)
            .or_else(|_| {
                context
                    .cast::<IContextMenu2>()
                    .map(MenuMessages::WithoutResult)
            })
            .ok();
        let subclass = messages
            .as_ref()
            .and_then(|messages| MenuSubclass::install(window, messages));
        if messages.is_some() && subclass.is_none() {
            return Ok(LocalExplorerMenuResult::default());
        }
        let command = unsafe {
            TrackPopupMenu(
                popup.0,
                TPM_RETURNCMD | TPM_RIGHTBUTTON,
                pointer.at.x,
                pointer.at.y,
                None,
                window,
                None,
            )
        }
        .0;
        drop(subclass);
        let command_invoked = (FIRST_COMMAND..=LAST_COMMAND).contains(&command);
        if command_invoked {
            let verb = (command - FIRST_COMMAND) as usize;
            let directory: Vec<_> = Path::new(directory_path)
                .as_os_str()
                .encode_wide()
                .chain([0])
                .collect();
            let mut mask = SEE_MASK_UNICODE | CMIC_MASK_PTINVOKE;
            if pointer.shift {
                mask |= CMIC_MASK_SHIFT_DOWN;
            }
            if pointer.control {
                mask |= CMIC_MASK_CONTROL_DOWN;
            }
            let invoke = CMINVOKECOMMANDINFOEX {
                cbSize: size_of::<CMINVOKECOMMANDINFOEX>() as u32,
                fMask: mask,
                hwnd: window,
                lpVerb: PCSTR(verb as *const u8),
                nShow: SW_SHOWNORMAL.0,
                lpVerbW: PCWSTR(verb as *const u16),
                lpDirectoryW: PCWSTR(directory.as_ptr()),
                ptInvoke: pointer.at,
                ..Default::default()
            };
            unsafe {
                context.InvokeCommand(
                    (&invoke as *const CMINVOKECOMMANDINFOEX).cast::<CMINVOKECOMMANDINFO>(),
                )
            }
            .map_err(|error| format!("Windows 无法执行该菜单命令：{error}"))?;
        }
        Ok(LocalExplorerMenuResult {
            shown: true,
            action: MenuAction::name(command),
            command_invoked,
        })
    }
}
