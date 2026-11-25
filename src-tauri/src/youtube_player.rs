use webview2_com::{
    take_pwstr,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
    },
    WebResourceRequestedEventHandler,
};
use windows_core::{w, Interface, HSTRING, PWSTR};

pub(crate) fn install(window: &tauri::WebviewWindow, identifier: &str) -> tauri::Result<()> {
    let referrer = HSTRING::from(format!("https://{identifier}/"));
    window.with_webview(move |webview| {
        // Tauri provides the live WebView2 controller on its owning UI thread.
        let result = unsafe { webview.controller().CoreWebView2() }
            .and_then(|core| register(&core, referrer));
        if let Err(error) = result {
            eprintln!("Could not configure the YouTube player referrer: {error}");
        }
    })
}

fn register(core: &ICoreWebView2, referrer: HSTRING) -> windows_core::Result<()> {
    let frames = core.cast::<ICoreWebView2_22>()?;
    let mut event_token = 0;
    // YouTube requires desktop embeds to identify their app with the Referer header.
    // WebView2's document-source filter also observes requests made by an iframe.
    unsafe {
        frames.AddWebResourceRequestedFilterWithRequestSourceKinds(
            w!("https://www.youtube.com/embed/*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
        )?;
        core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, event| {
                let Some(event) = event else {
                    return Ok(());
                };
                let request = event.Request()?;
                let mut uri = PWSTR::null();
                request.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                if let Some(video) = uri.strip_prefix("https://www.youtube.com/embed/") {
                    let id = video.split('?').next().unwrap_or_default();
                    if id.len() == 11
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                    {
                        request.Headers()?.SetHeader(w!("Referer"), &referrer)?;
                    }
                }
                Ok(())
            })),
            &mut event_token,
        )
    }
}
