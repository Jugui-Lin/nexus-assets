use super::{article_url, checked_url, fetch_public_web, html::compact_text, MAX_URL_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use dom_query::Document;
use image::{ImageFormat, ImageReader, Limits};
use reqwest::Url;
use serde::Serialize;
use std::{io::Cursor, time::Duration};

const PAGE_BYTES: usize = 1024 * 1024;
const ICON_BYTES: usize = 192 * 1024;
const ICON_ACCEPT: &str = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SiteMetadata {
    name: Option<String>,
    description: Option<String>,
    icon_data: Option<String>,
}

fn favicon_url(page: &Url, href: &str) -> Option<Url> {
    let mut icon = article_url(page, href)?;
    if page.scheme() == "https" && icon.scheme() != "https" {
        icon.set_scheme("https").ok()?;
    }
    icon.set_fragment(None);
    Some(icon)
}

fn page_metadata(bytes: &[u8], page: &Url) -> (SiteMetadata, Vec<Url>) {
    let document = Document::from(String::from_utf8_lossy(bytes).as_ref());
    let name = [
        "head > meta[property='og:site_name'][content]",
        "head > meta[name='application-name'][content]",
        "head > meta[property='og:title'][content]",
    ]
    .into_iter()
    .find_map(|selector| compact_text(&document.select(selector).first().attr("content")?, 120))
    .or_else(|| compact_text(&document.select("head > title").first().text(), 120));
    let description = [
        "head > meta[property='og:description' i][content]",
        "head > meta[name='description' i][content]",
        "head > meta[name='twitter:description' i][content]",
        "head > meta[property='twitter:description' i][content]",
    ]
    .into_iter()
    .find_map(|selector| compact_text(&document.select(selector).first().attr("content")?, 260));

    let base = document
        .select("head > base[href]")
        .first()
        .attr("href")
        .and_then(|href| article_url(page, &href));
    let mut icons = Vec::new();
    for selector in [
        "head > link[rel~='icon' i][href]",
        "head > link[rel~='apple-touch-icon' i][href]",
    ] {
        for link in document.select(selector).iter() {
            let Some(icon) = link
                .attr("href")
                .and_then(|href| favicon_url(base.as_ref().unwrap_or(page), &href))
            else {
                continue;
            };
            if !icons.contains(&icon) {
                icons.push(icon);
            }
            if icons.len() == 2 {
                break;
            }
        }
        if icons.len() == 2 {
            break;
        }
    }
    if let Some(icon) = favicon_url(page, "/favicon.ico").filter(|url| !icons.contains(url)) {
        icons.push(icon);
    }
    (
        SiteMetadata {
            name,
            description,
            icon_data: None,
        },
        icons,
    )
}

fn icon_data(bytes: &[u8]) -> Option<String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    if matches!(
        reader.format(),
        Some(
            ImageFormat::Png
                | ImageFormat::Ico
                | ImageFormat::Jpeg
                | ImageFormat::WebP
                | ImageFormat::Bmp
        )
    ) {
        let mut limits = Limits::default();
        limits.max_image_width = Some(1024);
        limits.max_image_height = Some(1024);
        limits.max_alloc = Some(12 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().ok()?.thumbnail(48, 48);
        let mut png = Cursor::new(Vec::new());
        image.write_to(&mut png, ImageFormat::Png).ok()?;
        return Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(png.into_inner())
        ));
    }
    if bytes.len() > 12 * 1024 {
        return None;
    }
    let mut xml = quick_xml::Reader::from_reader(bytes);
    xml.config_mut().trim_text(true);
    loop {
        use quick_xml::events::Event;
        match xml.read_event().ok()? {
            Event::Decl(_) | Event::Comment(_) => {}
            Event::Start(tag) | Event::Empty(tag) if tag.name().as_ref() == "svg" => {
                // The UI uses this only as an img source, which disables script and external loads.
                return Some(format!(
                    "data:image/svg+xml;base64,{}",
                    STANDARD.encode(bytes)
                ));
            }
            _ => return None,
        }
    }
}

#[tauri::command]
pub(crate) async fn browser_site_metadata(url: String) -> SiteMetadata {
    if url.len() > MAX_URL_BYTES {
        return SiteMetadata::default();
    }
    let Ok(page) = Url::parse(url.trim())
        .map_err(|e| e.to_string())
        .and_then(|mut url| {
            url.set_fragment(None);
            checked_url(url, false)
        })
    else {
        return SiteMetadata::default();
    };
    let (mut metadata, icons) = match tokio::time::timeout(
        Duration::from_secs(6),
        fetch_public_web(
            page.clone(),
            "text/html,application/xhtml+xml",
            PAGE_BYTES,
            |_| true,
            true,
        ),
    )
    .await
    {
        Ok(Ok((page, bytes))) => page_metadata(&bytes, &page),
        _ => (
            SiteMetadata::default(),
            favicon_url(&page, "/favicon.ico").into_iter().collect(),
        ),
    };
    metadata.icon_data = tokio::time::timeout(Duration::from_secs(4), async {
        for icon in icons {
            let fetched = fetch_public_web(icon, ICON_ACCEPT, ICON_BYTES, |_| true, true).await;
            if let Some(icon) = fetched.ok().and_then(|(_, bytes)| icon_data(&bytes)) {
                return Some(icon);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gets_site_name_and_resolves_declared_icons_against_the_final_page() {
        let page = Url::parse("https://example.com/guide/index.html").unwrap();
        let (metadata, icons) = page_metadata(
            br#"
            <title>Page | Site</title>
            <meta property="og:site_name" content="Site &amp; Co">
            <meta property="og:description" content="Animation   &amp; Design">
            <meta name="description" content="Secondary description">
            <link rel="shortcut ICON" href="icons/site.ico">
            <link rel="apple-touch-icon" href="//example.org/logo.png">
        "#,
            &page,
        );
        assert_eq!(metadata.name.as_deref(), Some("Site & Co"));
        assert_eq!(metadata.description.as_deref(), Some("Animation & Design"));
        assert_eq!(
            icons.iter().map(Url::as_str).collect::<Vec<_>>(),
            [
                "https://example.com/guide/icons/site.ico",
                "https://example.org/logo.png",
                "https://example.com/favicon.ico",
            ]
        );
    }

    #[test]
    fn ignores_private_and_non_web_icons_and_keeps_http_favicons() {
        let page = Url::parse("http://example.com/").unwrap();
        let (metadata, icons) = page_metadata(
            br#"
            <title>  Site   title </title>
            <link rel="icon" href="http://127.0.0.1/private">
            <link rel="icon" href="data:image/svg+xml,inline">
        "#,
            &page,
        );
        assert_eq!(metadata.name.as_deref(), Some("Site title"));
        assert!(metadata.description.is_none());
        assert_eq!(icons[0].as_str(), "http://example.com/favicon.ico");
        assert_eq!(icons.len(), 1);
    }

    #[test]
    fn uses_a_bounded_fallback_description_when_open_graph_is_empty() {
        let page = Url::parse("https://example.com/").unwrap();
        let html = format!(
            r#"<meta property="og:description" content="   "><meta name="description" content="{}"><meta name="twitter:description" content="backup">"#,
            "图".repeat(280),
        );
        let (metadata, _) = page_metadata(html.as_bytes(), &page);
        assert_eq!(metadata.description.unwrap().chars().count(), 260);
        let (metadata, _) = page_metadata(
            br#"<meta property="twitter:description" content="Motion design">"#,
            &page,
        );
        assert_eq!(metadata.description.as_deref(), Some("Motion design"));
    }

    #[test]
    fn accepts_images_and_discards_html_masquerading_as_an_icon() {
        assert!(
            icon_data(br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>"#)
                .unwrap()
                .starts_with("data:image/svg+xml;base64,")
        );
        assert!(icon_data(b"<html><svg/></html>").is_none());
        let mut ico = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(32, 32)
            .write_to(&mut ico, ImageFormat::Ico)
            .unwrap();
        assert!(icon_data(ico.get_ref())
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
}
