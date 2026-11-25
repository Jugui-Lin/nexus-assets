use reqwest::Url;

pub(crate) fn open_web_page(address: &Url) -> Result<(), ()> {
    #[cfg(windows)]
    {
        use windows::{
            core::{w, PCWSTR},
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };
        let address: Vec<u16> = address.as_str().encode_utf16().chain([0]).collect();
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(address.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err(());
        }
    }
    #[cfg(not(windows))]
    {
        let browser = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(browser)
            .arg(address.as_str())
            .spawn()
            .map_err(|_| ())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn subscription_open(url: String) -> Result<(), String> {
    let address = Url::parse(&url).map_err(|_| "网页地址无效")?;
    let public_domain = address.domain().is_some_and(|host| {
        let host = host.trim_end_matches('.');
        host.contains('.')
            && !["localhost", "local", "internal", "home.arpa"]
                .iter()
                .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    });
    if !matches!(address.scheme(), "https" | "http")
        || !public_domain
        || !address.username().is_empty()
        || address.password().is_some()
    {
        return Err("请输入公开的网页地址".into());
    }
    open_web_page(&address).map_err(|_| "无法打开浏览器".into())
}
