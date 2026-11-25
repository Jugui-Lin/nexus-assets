use reqwest::{header, redirect::Policy, Client, StatusCode, Url};
use serde::Serialize;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

mod bilibili;
mod html;
pub(crate) mod site;
mod xinpianchang;
mod xml;

const MAX_URL_BYTES: usize = 2048;
const MAX_FEED_BYTES: usize = 2 * 1024 * 1024;
const MAX_AUTHOR_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const NETWORK_ERROR: &str = "无法读取订阅来源，请检查地址和网络后重试";
const FEED_TYPES: &str =
    "application/rss+xml, application/atom+xml, application/xml;q=0.8, text/xml;q=0.8";
const PROFILE_TYPES: &str = "text/html, application/xhtml+xml;q=0.9, application/rss+xml;q=0.9, application/atom+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8";
static NETWORK_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[derive(Debug, Serialize)]
pub(crate) struct Feed {
    title: String,
    items: Vec<FeedItem>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedItem {
    title: String,
    url: String,
    published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_timestamp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cover_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_count: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Discovery {
    feed_url: Option<String>,
    name: Option<String>,
    avatar_url: Option<String>,
    bio: Option<String>,
    source_status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    items: Option<Vec<FeedItem>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    name: Option<String>,
    avatar_url: Option<String>,
    bio: Option<String>,
    feed: Option<String>,
    source_status: Option<&'static str>,
}

fn public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => !matches!(
            address.octets(),
            [0 | 10 | 127 | 224..=255, ..]
                | [100, 64..=127, ..]
                | [169, 254, ..]
                | [172, 16..=31, ..]
                | [192, 0, 0 | 2, _]
                | [192, 88, 99, _]
                | [192, 168, ..]
                | [198, 18 | 19, ..]
                | [198, 51, 100, _]
                | [203, 0, 113, _]
        ),
        IpAddr::V6(address) => {
            let [first, second, ..] = address.segments();
            first & 0xe000 == 0x2000
                && !matches!(
                    (first, second),
                    (0x2001, 0..=0x1ff | 0xdb8) | (0x2002, _) | (0x3fff, 0..=0xfff)
                )
        }
    }
}

fn checked_url(url: Url, https_only: bool) -> Result<Url, String> {
    let host = url.host_str().ok_or("请输入有效的订阅地址")?;
    if url.as_str().len() > MAX_URL_BYTES || !url.username().is_empty() || url.password().is_some()
    {
        return Err("订阅地址不能包含登录凭据或超过长度限制".into());
    }
    if url.scheme() != "https" && (https_only || url.scheme() != "http") {
        return Err("请输入公开的 HTTPS 订阅地址".into());
    }
    if let Some(domain) = url.domain() {
        let domain = domain.trim_end_matches('.');
        if domain == "localhost" || domain.ends_with(".localhost") || domain.ends_with(".local") {
            return Err("订阅来源必须可以公开访问".into());
        }
    } else if !host
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(public_ip)
    {
        return Err("订阅来源必须可以公开访问".into());
    }
    Ok(url)
}

pub(crate) fn source_url(value: &str) -> Result<Url, String> {
    if value.len() > MAX_URL_BYTES {
        return Err("订阅地址超过长度限制".into());
    }
    checked_url(
        Url::parse(value.trim()).map_err(|_| "请输入有效的订阅地址")?,
        true,
    )
}

fn article_url(base: &Url, value: &str) -> Option<Url> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_URL_BYTES {
        return None;
    }
    checked_url(base.join(value).ok()?, false).ok()
}

pub(crate) async fn client_for(url: &Url) -> Result<Client, String> {
    public_web_client(url, false).await
}

async fn public_web_client(url: &Url, site_lookup: bool) -> Result<Client, String> {
    let mut builder = Client::builder()
        .https_only(!site_lookup || url.scheme() == "https")
        .redirect(Policy::none())
        .referer(false)
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(6))
        .timeout(REQUEST_TIMEOUT)
        .user_agent(if site_lookup { "Nexus Assets" } else { "Nexus Assets RSS Reader" });
    if let Some(domain) = url.domain() {
        let port = url.port_or_known_default().ok_or("请输入有效的订阅地址")?;
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((domain, port))
            .await
            .map_err(|_| "无法解析订阅来源的域名")?
            .take(65)
            .collect();
        let valid_address = |address: &SocketAddr| {
            if site_lookup {
                public_ip(address.ip())
            } else {
                usable_feed_address(url, address.ip())
            }
        };
        if addresses.is_empty()
            || addresses.len() > 64
            || !addresses.iter().all(valid_address)
        {
            return Err("订阅来源必须可以公开访问".into());
        }
        // Connect to the checked addresses while keeping this URL's TLS hostname.
        builder = builder.resolve_to_addrs(domain, &addresses);
    }
    builder.build().map_err(|_| NETWORK_ERROR.into())
}

async fn fetch(url: Url, accept: &'static str, max_bytes: usize) -> Result<(Url, Vec<u8>), String> {
    fetch_with_redirect_check(url, accept, max_bytes, |_| true).await
}

async fn fetch_with_redirect_check(
    url: Url,
    accept: &'static str,
    max_bytes: usize,
    redirect_allowed: impl Fn(&Url) -> bool,
) -> Result<(Url, Vec<u8>), String> {
    fetch_public_web(url, accept, max_bytes, redirect_allowed, false).await
}

async fn fetch_public_web(
    mut url: Url,
    accept: &'static str,
    max_bytes: usize,
    redirect_allowed: impl Fn(&Url) -> bool,
    site_lookup: bool,
) -> Result<(Url, Vec<u8>), String> {
    let fetch = async {
        let _slot = NETWORK_SLOTS.acquire().await.map_err(|_| NETWORK_ERROR)?;
        for redirects in 0..=MAX_REDIRECTS {
            let mut response = public_web_client(&url, site_lookup)
                .await?
                .get(url.clone())
                .header(header::ACCEPT, accept)
                .header(header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|_| NETWORK_ERROR)?;
            let status = response.status();
            if matches!(
                status,
                StatusCode::MOVED_PERMANENTLY
                    | StatusCode::FOUND
                    | StatusCode::SEE_OTHER
                    | StatusCode::TEMPORARY_REDIRECT
                    | StatusCode::PERMANENT_REDIRECT
            ) {
                if redirects == MAX_REDIRECTS {
                    return Err("订阅来源重定向次数过多".into());
                }
                let destination = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|header| header.to_str().ok())
                    .and_then(|location| url.join(location).ok())
                    .ok_or("订阅来源返回了无效的跳转地址")?;
                if !redirect_allowed(&destination) {
                    return Err("订阅来源返回了未允许的跳转地址".into());
                }
                if !site_lookup && official_youtube_profile(&url)
                    && matches!(
                        destination.domain(),
                        Some("consent.youtube.com" | "consent.google.com")
                    )
                {
                    return Err(
                        "YouTube 当前需要在网页上确认访问，可填写频道的 RSS 地址后重试".into(),
                    );
                }
                url = checked_url(destination, !site_lookup || url.scheme() == "https")?;
                continue;
            }
            if !status.is_success() {
                return Err(format!("订阅来源暂时无法访问（HTTP {}）", status.as_u16()));
            }
            if response
                .content_length()
                .is_some_and(|length| length > max_bytes as u64)
            {
                return Err("订阅来源超过大小限制".into());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| NETWORK_ERROR)? {
                if chunk.len() > max_bytes - bytes.len() {
                    return Err("订阅来源超过大小限制".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok((url, bytes));
        }
        Err(NETWORK_ERROR.into())
    };
    tokio::time::timeout(REQUEST_TIMEOUT, fetch)
        .await
        .map_err(|_| "读取订阅来源超时，请稍后重试")?
}

fn source_feed_url(author: &Url) -> Option<Url> {
    let host = author.domain()?.trim_end_matches('.');
    let mut path = author.path().trim_matches('/').split('/');
    let first = path.next()?;
    let second = path.next();
    if path.next().is_some() {
        return None;
    }
    let (endpoint, key, value) = match (host, first, second) {
        ("behance.net" | "www.behance.net", user, None)
            if behance_username(user)
                && !matches!(
                    user,
                    "feeds" | "gallery" | "galleries" | "search" | "discover" | "live"
                ) =>
        {
            ("https://www.behance.net/feeds/user", "username", user)
        }
        ("youtube.com" | "www.youtube.com" | "m.youtube.com", "channel", Some(id))
            if youtube_channel_id(id) =>
        {
            ("https://www.youtube.com/feeds/videos.xml", "channel_id", id)
        }
        _ => return None,
    };
    let mut url = Url::parse(endpoint).ok()?;
    url.query_pairs_mut().append_pair(key, value);
    Some(url)
}

fn slug_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn behance_username(value: &str) -> bool {
    (1..=64).contains(&value.len()) && value.bytes().all(slug_byte)
}

fn youtube_channel_id(value: &str) -> bool {
    value.starts_with("UC") && value.len() == 24 && value.bytes().all(slug_byte)
}

fn youtube_handle(url: &Url) -> Option<String> {
    if url.scheme() != "https"
        || !matches!(
            url.domain(),
            Some("youtube.com" | "www.youtube.com" | "m.youtube.com")
        )
        || url.port_or_known_default() != Some(443)
    {
        return None;
    }
    let mut segments = url.path().trim_matches('/').split('/');
    let encoded = segments.next()?;
    if !encoded
        .bytes()
        .all(|byte| slug_byte(byte) || matches!(byte, b'@' | b'.' | b'%'))
    {
        return None;
    }
    let (decoded, _) = url::form_urlencoded::parse(encoded.as_bytes()).next()?;
    let handle = decoded.strip_prefix('@')?;
    if !(1..=64).contains(&handle.chars().count())
        || !handle
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        || segments.next().is_some_and(|name| {
            !matches!(
                name,
                "featured" | "videos" | "shorts" | "streams" | "playlists" | "community" | "about"
            )
        })
        || segments.next().is_some()
    {
        return None;
    }
    Some(handle.to_owned())
}

fn public_youtube_profile(url: &Url) -> Option<Url> {
    let mut profile = Url::parse("https://www.youtube.com/").ok()?;
    if let Some(handle) = youtube_handle(url) {
        profile.set_path(&format!("/@{handle}"));
    } else {
        let feed = if official_feed_endpoint(url) {
            url.clone()
        } else {
            source_feed_url(url)?
        };
        if feed.domain() != Some("www.youtube.com") || feed.path() != "/feeds/videos.xml" {
            return None;
        }
        let (_, id) = feed.query_pairs().next()?;
        profile.set_path(&format!("/channel/{id}"));
    }
    Some(profile)
}

fn official_youtube_profile(url: &Url) -> bool {
    // YouTube can redirect between desktop and mobile URLs. Keep only the
    // normalized creator routes and YouTube's own device-redirect marker.
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && matches!(url.domain(), Some("www.youtube.com" | "m.youtube.com"))
        && matches!(url.query(), None | Some("app=desktop"))
        && url.fragment().is_none()
        && public_youtube_profile(url).is_some_and(|profile| profile.path() == url.path())
}

fn official_feed_endpoint(url: &Url) -> bool {
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
        return false;
    }
    let mut query = url.query_pairs();
    let Some((key, value)) = query.next().filter(|_| query.next().is_none()) else {
        return false;
    };
    match (url.domain(), url.path(), key.as_ref()) {
        (Some("www.behance.net"), "/feeds/user", "username") => behance_username(&value),
        (Some("www.youtube.com"), "/feeds/videos.xml", "channel_id") => youtube_channel_id(&value),
        _ => false,
    }
}

fn public_bilibili_profile(url: &Url) -> Option<Url> {
    if url.scheme() != "https"
        || url.domain() != Some("space.bilibili.com")
        || url.port_or_known_default() != Some(443)
    {
        return None;
    }
    let mut segments = url.path().trim_matches('/').split('/');
    let mid = segments.next()?;
    if mid.is_empty()
        || !mid.bytes().all(|byte| byte.is_ascii_digit())
        || !mid.parse::<u64>().is_ok_and(|id| id > 0)
        || segments
            .next()
            .is_some_and(|subpage| !matches!(subpage, "video" | "dynamic" | "article" | "lists"))
        || segments.next().is_some()
    {
        return None;
    }
    let mut profile = Url::parse("https://space.bilibili.com/").ok()?;
    profile.set_path(mid);
    Some(profile)
}

fn usable_feed_address(url: &Url, address: IpAddr) -> bool {
    // Some local transparent proxies use synthetic DNS addresses in 198.18/15.
    // Only fixed official HTTPS feed and validated creator routes can use them.
    // TLS certificates and every redirect are still checked.
    public_ip(address)
        || ((official_feed_endpoint(url)
            || official_youtube_profile(url)
            || public_bilibili_profile(url).as_ref() == Some(url)
            || xinpianchang::editor_source(url).as_ref() == Some(url)
            || xinpianchang::work_id(url).is_some()
            || bilibili::playlist_id(url).is_some())
            && matches!(address, IpAddr::V4(ip) if matches!(ip.octets(), [198, 18 | 19, ..])))
}

#[tauri::command]
pub(crate) async fn subscription_feed(url: String) -> Result<Feed, String> {
    let (url, bytes) = fetch(source_url(&url)?, FEED_TYPES, MAX_FEED_BYTES).await?;
    xml::parse(&bytes, &url)
}

#[tauri::command]
pub(crate) async fn xinpianchang_player(input: String) -> Result<Option<String>, String> {
    xinpianchang::player_for_work(&source_url(&input)?).await
}

#[tauri::command]
pub(crate) async fn subscription_discover(url: String) -> Result<Discovery, String> {
    let url = source_url(&url)?;
    if let Some(source) = xinpianchang::editor_source(&url) {
        return xinpianchang::public_works(source).await;
    }
    if let Some(feed) = known_feed(&url) {
        return Ok(Discovery {
            feed_url: Some(feed.into()),
            name: None,
            avatar_url: None,
            bio: None,
            source_status: None,
            items: None,
        });
    }
    if let Some(profile) = public_bilibili_profile(&url) {
        if let Some(archive) = bilibili::public_works(&profile).await {
            return Ok(archive);
        }
        let (resolved, bytes) = fetch(profile, PROFILE_TYPES, MAX_AUTHOR_PAGE_BYTES).await?;
        let mut discovery = discovered_content(resolved, &bytes);
        if discovery.feed_url.is_none() {
            discovery.source_status = Some("public-works-unavailable");
        }
        return Ok(discovery);
    }
    let profile = public_youtube_profile(&url).unwrap_or(url);
    let (url, bytes) = fetch(profile, PROFILE_TYPES, MAX_AUTHOR_PAGE_BYTES).await?;
    Ok(discovered_content(url, &bytes))
}

#[tauri::command]
pub(crate) async fn subscription_profile(url: String) -> Result<Profile, String> {
    let url = source_url(&url)?;
    if xinpianchang::editor_source(&url).is_some() {
        return Ok(Profile {
            name: Some(xinpianchang::TITLE.into()),
            avatar_url: None,
            bio: None,
            feed: None,
            source_status: Some("public-works"),
        });
    }
    let discovery = if let Some(feed) = known_feed(&url) {
        if let Some(profile) = public_youtube_profile(&feed) {
            if let Ok((resolved, bytes)) =
                fetch(profile, PROFILE_TYPES, MAX_AUTHOR_PAGE_BYTES).await
            {
                let found = discovered_content(resolved, &bytes);
                if found.feed_url.as_deref() == Some(feed.as_str())
                    && (found.name.is_some() || found.avatar_url.is_some())
                {
                    return Ok(Profile {
                        name: found.name,
                        avatar_url: found.avatar_url,
                        bio: found.bio,
                        feed: found.feed_url,
                        source_status: found.source_status,
                    });
                }
            }
        }
        let name = fetch(feed.clone(), FEED_TYPES, MAX_FEED_BYTES)
            .await
            .ok()
            .and_then(|(url, bytes)| xml::parse(&bytes, &url).ok())
            .and_then(|feed| html::title_name(&feed.title));
        Discovery {
            name,
            avatar_url: None,
            bio: None,
            feed_url: Some(feed.into()),
            source_status: None,
            items: None,
        }
    } else {
        subscription_discover(url.into()).await?
    };
    Ok(Profile {
        name: discovery.name,
        avatar_url: discovery.avatar_url,
        bio: discovery.bio,
        feed: discovery.feed_url,
        source_status: discovery.source_status,
    })
}

fn known_feed(url: &Url) -> Option<Url> {
    if official_feed_endpoint(url) {
        return Some(url.clone());
    }
    source_feed_url(url)
}

fn discovered_content(url: Url, bytes: &[u8]) -> Discovery {
    if bytes.len() <= MAX_FEED_BYTES {
        if let Ok(feed) = xml::parse(bytes, &url) {
            return Discovery {
                feed_url: Some(url.into()),
                name: html::title_name(&feed.title),
                avatar_url: None,
                bio: None,
                source_status: None,
                items: None,
            };
        }
    }
    let (name, feed, avatar_url, bio) = if official_youtube_profile(&url) {
        let metadata = html::youtube_profile(bytes, &url);
        (
            metadata.name,
            metadata.feed,
            metadata.avatar_url,
            metadata.bio,
        )
    } else {
        let (name, feed) = html::author_metadata(bytes, &url);
        let (avatar_url, bio) = html::profile_details(bytes, &url);
        (name, feed, avatar_url, bio)
    };
    let feed_url = feed
        .and_then(|feed| checked_url(feed, true).ok())
        .map(Into::into);
    let source_status =
        (feed_url.is_none() && public_bilibili_profile(&url).is_some() && name.is_some())
            .then_some("no-public-feed");
    Discovery {
        feed_url,
        name,
        avatar_url,
        bio,
        source_status,
        items: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rss_sources_require_https_public_destinations_without_userinfo() {
        for value in [
            "http://example.com/feed",
            "file:///test",
            "https://user@example.com/feed",
            "https://example.local./feed",
            "https://localhost./feed",
            "https://2130706433/feed",
            "https://127.0.0.1/feed",
            "https://169.254.169.254/feed",
            "https://[::ffff:127.0.0.1]/feed",
            "https://[fc00::1]/feed",
            "https://[fe80::1]/feed",
            "https://[2002:7f00:1::]/feed",
            "https://[2001:db8::1]/feed",
            "https://100.95.1.1/feed",
        ] {
            assert!(source_url(value).is_err(), "{value}");
        }
        for value in [
            "https://example.org/feed",
            "https://8.8.8.8/feed",
            "https://[2606:4700::1111]/feed",
        ] {
            assert!(source_url(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn source_inference_accepts_only_valid_author_routes_and_hosts() {
        let infer = |url| source_feed_url(&source_url(url).unwrap()).map(|feed| String::from(feed));
        assert_eq!(
            infer("https://www.behance.net/ashthorp/"),
            Some("https://www.behance.net/feeds/user?username=ashthorp".into())
        );
        assert_eq!(
            infer("https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"),
            Some(
                "https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa"
                    .into()
            )
        );
        for url in [
            "https://www.behance.net/feeds/user?username=ashthorp",
            "https://www.behance.net/gallery/123/artwork",
            "https://www.behance.net.invalid/ashthorp",
            "https://www.youtube.com/channel/not-valid",
        ] {
            assert_eq!(infer(url), None);
        }
    }

    #[test]
    fn synthetic_proxy_dns_is_allowed_only_for_exact_official_feed_routes() {
        let proxy_address = "198.18.1.249".parse().unwrap();
        let canonical = "https://www.behance.net/feeds/user?username=ashthorp";
        assert!(usable_feed_address(
            &source_url(canonical).unwrap(),
            proxy_address
        ));
        assert!(!usable_feed_address(
            &source_url(canonical).unwrap(),
            "127.0.0.1".parse().unwrap()
        ));
        for url in [
            "https://www.behance.net/redirect?username=ashthorp",
            "https://www.behance.net:444/feeds/user?username=ashthorp",
            "https://www.behance.net/feeds/user?username=ashthorp&url=https://example.org",
            "https://example.org/feeds/user?username=ashthorp",
        ] {
            assert!(!usable_feed_address(
                &source_url(url).unwrap(),
                proxy_address
            ));
        }
    }

    #[test]
    fn youtube_handles_use_only_official_profile_and_feed_routes() {
        let provided =
            source_url("https://www.youtube.com/@MaxonVFX/videos?feature=shared#other").unwrap();
        let canonical = public_youtube_profile(&provided).unwrap();
        assert_eq!(canonical.as_str(), "https://www.youtube.com/@MaxonVFX");
        let proxy = "198.18.0.167".parse().unwrap();
        assert!(usable_feed_address(&canonical, proxy));
        assert!(!usable_feed_address(
            &canonical,
            "127.0.0.1".parse().unwrap()
        ));
        assert!(usable_feed_address(
            &source_url("https://m.youtube.com/@MaxonVFX?app=desktop").unwrap(),
            proxy
        ));
        for rejected in [
            "https://www.youtube.com.example.org/@MaxonVFX",
            "https://www.youtube.com:444/@MaxonVFX",
            "https://www.youtube.com/@MaxonVFX?app=desktop&next=https://example.org",
            "https://www.youtube.com/@MaxonVFX%2Fredirect",
            "https://www.youtube.com/redirect?q=https://example.org",
        ] {
            assert!(
                !usable_feed_address(&source_url(rejected).unwrap(), proxy),
                "{rejected}"
            );
        }
        let feed = "https://www.youtube.com/feeds/videos.xml?channel_id=UCWhRfxKSqHU8hjx7mbmKVxA";
        let page = br#"<title>Maxon - YouTube</title>
          <link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCWhRfxKSqHU8hjx7mbmKVxA">"#;
        let metadata = discovered_content(canonical.clone(), page);
        assert_eq!(metadata.name.as_deref(), Some("Maxon"));
        assert_eq!(metadata.feed_url.as_deref(), Some(feed));
        let fallback = br#"<title>Maxon - YouTube</title>
          <link rel="alternate" type="application/rss+xml" href="https://example.org/unrelated.xml">
          <link itemprop="url" href="https://www.youtube.com/channel/UCWhRfxKSqHU8hjx7mbmKVxA">"#;
        assert_eq!(
            discovered_content(canonical, fallback).feed_url.as_deref(),
            Some(feed)
        );
        assert_eq!(
            public_youtube_profile(&source_url("https://youtube.com/@禄明").unwrap())
                .unwrap()
                .as_str(),
            "https://www.youtube.com/@%E7%A6%84%E6%98%8E"
        );
    }

    #[test]
    fn bilibili_metadata_fetch_is_canonical_and_does_not_infer_a_feed() {
        let original =
            source_url("https://space.bilibili.com/66482012/video?spm_id_from=fixture#more")
                .unwrap();
        let canonical = public_bilibili_profile(&original).unwrap();
        assert_eq!(canonical.as_str(), "https://space.bilibili.com/66482012");
        let proxy = "198.18.1.250".parse().unwrap();
        assert!(usable_feed_address(&canonical, proxy));
        assert!(!usable_feed_address(&original, proxy));
        assert!(!usable_feed_address(
            &canonical,
            "127.0.0.1".parse().unwrap()
        ));
        for invalid in [
            "https://space.bilibili.com:444/66482012",
            "https://space.bilibili.com.example.org/66482012",
            "https://space.bilibili.com/66482012/unrelated",
            "https://space.bilibili.com/redirect?next=66482012",
            "https://space.bilibili.com/0",
        ] {
            assert!(
                public_bilibili_profile(&source_url(invalid).unwrap()).is_none(),
                "{invalid}"
            );
        }
        let public_html = "<title>KKK_E的个人空间-KKK_E个人主页-哔哩哔哩视频</title>";
        let metadata = discovered_content(canonical, public_html.as_bytes());
        assert_eq!(metadata.name.as_deref(), Some("KKK_E"));
        assert_eq!(metadata.feed_url, None);
        assert_eq!(metadata.source_status, Some("no-public-feed"));
    }
}
