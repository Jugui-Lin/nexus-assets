use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ClipboardAction {
    Copy,
    Cut,
    Paste,
}

#[tauri::command]
pub(crate) async fn local_explorer_clipboard(
    window: tauri::Window,
    action: ClipboardAction,
    path: String,
    paths: Option<Vec<String>>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use crate::local_explorer_drop::{local_explorer_drop_files, DropEffect};
        let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        match action {
            ClipboardAction::Copy | ClipboardAction::Cut => {
                tauri::async_runtime::spawn_blocking(move || {
                    windows_clipboard::write(
                        owner,
                        paths.unwrap_or_else(|| vec![path]),
                        matches!(action, ClipboardAction::Cut),
                    )
                })
                .await
                .map_err(|error| error.to_string())?
            }
            ClipboardAction::Paste => {
                let (paths, moved, sequence) =
                    tauri::async_runtime::spawn_blocking(windows_clipboard::read)
                        .await
                        .map_err(|error| error.to_string())??;
                let effect = if moved {
                    DropEffect::Move
                } else {
                    DropEffect::Copy
                };
                local_explorer_drop_files(window, paths, path, effect).await?;
                if moved {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        windows_clipboard::clear_if_unchanged(owner, sequence);
                    })
                    .await;
                }
                Ok(())
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, action, path, paths);
        Err("当前平台暂不支持系统文件剪贴板".into())
    }
}

#[cfg(windows)]
mod windows_clipboard {
    use crate::local_explorer::{validate_file_path, MAX_ENTRIES};
    use std::path::{Path, PathBuf};
    use windows::{
        core::w,
        Win32::{
            Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
            System::{
                DataExchange::{
                    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
                    OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
                },
                Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
                Ole::{CF_HDROP, DROPEFFECT_COPY, DROPEFFECT_MOVE},
            },
            UI::Shell::{DragQueryFileW, HDROP},
        },
    };

    struct Clipboard;

    impl Clipboard {
        fn open(owner: Option<HWND>) -> Result<Self, String> {
            unsafe { OpenClipboard(owner) }.map_err(|_| "剪贴板正忙，请重试".to_owned())?;
            Ok(Self)
        }
    }

    impl Drop for Clipboard {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }

    struct ClipboardBuffer(HGLOBAL);

    impl ClipboardBuffer {
        fn effect(moved: bool) -> windows::core::Result<Self> {
            let effect = if moved {
                DROPEFFECT_MOVE.0
            } else {
                DROPEFFECT_COPY.0
            };
            unsafe {
                let memory = Self(GlobalAlloc(GMEM_MOVEABLE, size_of::<u32>())?);
                let pointer = GlobalLock(memory.0).cast::<u32>();
                if pointer.is_null() {
                    return Err(windows::core::Error::from_thread());
                }
                pointer.write(effect);
                let _ = GlobalUnlock(memory.0);
                Ok(memory)
            }
        }

        fn publish(self, format: u32) -> windows::core::Result<()> {
            unsafe { SetClipboardData(format, Some(HANDLE(self.0 .0))) }?;
            std::mem::forget(self);
            Ok(())
        }
    }

    impl Drop for ClipboardBuffer {
        fn drop(&mut self) {
            let _ = unsafe { GlobalFree(Some(self.0)) };
        }
    }

    fn effect_format() -> u32 {
        unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) }
    }

    pub(super) fn write(owner: isize, paths: Vec<String>, moved: bool) -> Result<(), String> {
        if !(1..=MAX_ENTRIES).contains(&paths.len()) {
            return Err("选中的文件数量超出可处理范围".into());
        }
        let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
        for path in &paths {
            validate_file_path(path)?;
            if path.file_name().is_none() {
                return Err("请选择文件或文件夹".into());
            }
        }
        if paths.len() == 1 && !Path::exists(&paths[0]) {
            return Err("文件或文件夹不存在".into());
        }
        let names = crate::native_drag::drop_files_memory(&paths)
            .map(ClipboardBuffer)
            .map_err(|error| error.to_string())?;
        let effect = ClipboardBuffer::effect(moved).map_err(|error| error.to_string())?;
        let format = effect_format();
        if format == 0 {
            return Err("无法设置剪贴板文件操作".into());
        }
        let _clipboard = Clipboard::open(Some(HWND(owner as _)))?;
        unsafe { EmptyClipboard() }.map_err(|error| error.to_string())?;
        names
            .publish(u32::from(CF_HDROP.0))
            .map_err(|error| error.to_string())?;
        effect.publish(format).map_err(|error| error.to_string())
    }

    pub(super) fn read() -> Result<(Vec<String>, bool, u32), String> {
        let _clipboard = Clipboard::open(None)?;
        let files = unsafe { GetClipboardData(u32::from(CF_HDROP.0)) }
            .map_err(|_| "剪贴板里没有可粘贴的文件")?;
        let drop = HDROP(files.0);
        let count = unsafe { DragQueryFileW(drop, u32::MAX, None) };
        if !(1..=MAX_ENTRIES as u32).contains(&count) {
            return Err("剪贴板中的文件数量超出可处理范围".into());
        }
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let length = unsafe { DragQueryFileW(drop, index, None) } as usize;
            if !(1..=32_767).contains(&length) {
                return Err("剪贴板中的文件路径无效".into());
            }
            let mut name = vec![0u16; length + 1];
            if unsafe { DragQueryFileW(drop, index, Some(&mut name)) } as usize != length {
                return Err("无法读取剪贴板中的文件路径".into());
            }
            paths.push(String::from_utf16(&name[..length]).map_err(|_| "剪贴板文件名无效")?);
        }
        let effect = unsafe { GetClipboardData(effect_format()) }
            .ok()
            .and_then(|handle| read_effect(HGLOBAL(handle.0)));
        let moved = effect.is_some_and(|effect| {
            effect & (DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0) == DROPEFFECT_MOVE.0
        });
        Ok((paths, moved, unsafe { GetClipboardSequenceNumber() }))
    }

    fn read_effect(memory: HGLOBAL) -> Option<u32> {
        unsafe {
            if GlobalSize(memory) < size_of::<u32>() {
                return None;
            }
            let pointer = GlobalLock(memory).cast::<u32>();
            if pointer.is_null() {
                return None;
            }
            let effect = pointer.read_unaligned();
            let _ = GlobalUnlock(memory);
            Some(effect)
        }
    }

    pub(super) fn clear_if_unchanged(owner: isize, sequence: u32) {
        let Ok(_clipboard) = Clipboard::open(Some(HWND(owner as _))) else {
            return;
        };
        if unsafe { GetClipboardSequenceNumber() } == sequence {
            let _ = unsafe { EmptyClipboard() };
        }
    }
}
