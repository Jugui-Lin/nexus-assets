use dom_query::Document;
use reqwest::Url;
use serde::Deserialize;

pub(super) fn author_metadata(bytes: &[u8], page: &Url) -> (Option<String>, Option<Url>) {
    let document = Document::from(String::from_utf8_lossy(bytes).as_ref());
    let name = [
        "head > meta[property='og:title'][content]",
        "head > meta[name='twitter:title'][content]",
    ]
    .into_iter()
    .find_map(|selector| {
        let label = document.select(selector).first().attr("content")?;
        author_name(&label, page)
    })
    .or_else(|| author_name(&document.select("head > title").first().text(), page))
    .or_else(|| {
        let label = document
            .select("head > meta[name='author'][content]")
            .first()
            .attr("content")?;
        author_name(&label, page)
    });
    (name, declared_feed(&document, page))
}

pub(super) fn title_name(value: &str) -> Option<String> {
    compact_text(value, 120)
}

pub(super) fn compact_text(value: &str, maximum: usize) -> Option<String> {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = compact
        .chars()
        .filter(|c| !c.is_control())
        .take(maximum)
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

pub(super) fn public_image_url(page: &Url, value: &str) -> Option<String> {
    let mut url = page.join(value.trim()).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.as_str().len() > 2048
        || !url.domain().is_some_and(|domain| {
            domain.ends_with(".hdslb.com")
                || matches!(
                    domain,
                    "i.ytimg.com" | "i1.ytimg.com" | "i2.ytimg.com" | "i3.ytimg.com" | "i4.ytimg.com"
                        | "yt3.googleusercontent.com" | "yt3.ggpht.com"
                )
        })
    {
        return None;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_scheme("https").ok()?;
    url.set_fragment(None);
    Some(url.into())
}

pub(super) fn profile_details(bytes: &[u8], page: &Url) -> (Option<String>, Option<String>) {
    let document = Document::from(String::from_utf8_lossy(bytes).as_ref());
    let avatar_url = document
        .select("head > meta[property='og:image'][content]")
        .first()
        .attr("content")
        .and_then(|value| public_image_url(page, &value));
    let bio = document
        .select("head > meta[property='og:description'][content], head > meta[name='description'][content]")
        .first()
        .attr("content")
        .and_then(|value| {
            if page.domain() == Some("space.bilibili.com") {
                // Space pages prepend a site description before the creator's signature.
                let (_, signature) = value.split_once("第一时间了解UP主动态。")?;
                return compact_text(signature, 400);
            }
            compact_text(&value, 400)
        });
    (avatar_url, bio)
}

#[derive(Deserialize)]
struct YoutubePageData {
    metadata: YoutubeChannelMetadata,
}

#[derive(Deserialize)]
struct YoutubeChannelMetadata {
    #[serde(rename = "channelMetadataRenderer")]
    channel: YoutubeChannel,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeChannel {
    external_id: String,
    title: Option<String>,
    description: Option<String>,
}

fn youtube_channel_data(script: &str) -> Option<YoutubeChannel> {
    let script = script.trim_start();
    let json = ["var ytInitialData", "window[\"ytInitialData\"]"]
        .into_iter()
        .find_map(|prefix| script.strip_prefix(prefix))?
        .trim_start()
        .strip_prefix('=')?;
    let data = serde_json::Deserializer::from_str(json)
        .into_iter::<YoutubePageData>()
        .next()?
        .ok()?;
    super::youtube_channel_id(&data.metadata.channel.external_id).then_some(data.metadata.channel)
}

pub(super) struct YoutubeProfile {
    pub(super) name: Option<String>,
    pub(super) feed: Option<Url>,
    pub(super) avatar_url: Option<String>,
    pub(super) bio: Option<String>,
}

pub(super) fn youtube_profile(bytes: &[u8], page: &Url) -> YoutubeProfile {
    let document = Document::from(String::from_utf8_lossy(bytes).as_ref());
    let data = document
        .select("head > script:not([src]), body > script:not([src])")
        .iter()
        .find_map(|script| youtube_channel_data(&script.text()));
    let feed = data
        .as_ref()
        .and_then(|channel| {
            let mut url = Url::parse("https://www.youtube.com/feeds/videos.xml").ok()?;
            url.query_pairs_mut().append_pair("channel_id", &channel.external_id);
            Some(url)
        })
        .or_else(|| declared_feed(&document, page).filter(official_youtube_feed))
        .or_else(|| {
            // The current YouTube profile document emits metadata directly in the body.
            document
                .select("head > link[rel='canonical'][href], head > link[itemprop='url'][href], body > link[rel='canonical'][href], body > link[itemprop='url'][href]")
                .iter()
                .find_map(|link| {
                    let channel = page.join(&link.attr("href")?).ok()?;
                    if !matches!(
                        channel.domain(),
                        Some("youtube.com" | "www.youtube.com" | "m.youtube.com")
                    ) || channel.scheme() != "https"
                        || channel.port_or_known_default() != Some(443)
                        || !channel.username().is_empty()
                        || channel.password().is_some()
                    {
                        return None;
                    }
                    super::source_feed_url(&channel)
                })
        });
    let name = data.as_ref().and_then(|data| title_name(data.title.as_deref()?))
        .or_else(|| {
            let element = document.select("head > meta[property='og:title'][content], body > meta[property='og:title'][content]").first();
            author_name(&element.attr("content")?, page)
        })
        .or_else(|| author_name(&document.select("head > title, body > title").first().text(), page));
    let avatar_url = document
        .select(
            "head > meta[property='og:image'][content], body > meta[property='og:image'][content]",
        )
        .first()
        .attr("content")
        .and_then(|value| public_image_url(page, &value));
    let bio = data.as_ref().and_then(|data| compact_text(data.description.as_deref()?, 400))
        .or_else(|| {
            let element = document.select("head > meta[property='og:description'][content], body > meta[property='og:description'][content]").first();
            compact_text(&element.attr("content")?, 400)
        });
    YoutubeProfile {
        name,
        feed,
        avatar_url,
        bio,
    }
}

fn official_youtube_feed(feed: &Url) -> bool {
    feed.domain() == Some("www.youtube.com") && super::official_feed_endpoint(feed)
}

fn author_name(value: &str, page: &Url) -> Option<String> {
    let trimmed = value.trim();
    let name = if page.domain() == Some("space.bilibili.com") {
        trimmed
            .split_once("的个人空间-")
            .map(|(name, _)| name)
            .or_else(|| trimmed.strip_suffix("的个人空间"))
            .unwrap_or(trimmed)
    } else {
        [
            " - YouTube",
            " on Behance",
            " - ArtStation",
            " on Vimeo",
            " • Instagram",
        ]
        .into_iter()
        .find_map(|suffix| trimmed.strip_suffix(suffix))
        .unwrap_or(trimmed)
    };
    let name = title_name(name)?;
    if [
        "Bilibili",
        "Behance",
        "YouTube",
        "Instagram",
        "Vimeo",
        "ArtStation",
        "Facebook",
        "Log in",
        "Login",
        "Sign in",
        "Access Denied",
        "Just a moment...",
        "哔哩哔哩",
        "安全验证",
    ]
    .iter()
    .any(|generic| name.eq_ignore_ascii_case(generic))
    {
        return None;
    }
    Some(name)
}

fn declared_feed(document: &Document, page: &Url) -> Option<Url> {
    document
        .select("head > link[href][type][rel]")
        .iter()
        .find_map(|link| {
            let rel = link.attr("rel")?;
            if !rel
                .split_ascii_whitespace()
                .any(|token| token.eq_ignore_ascii_case("alternate"))
                || rel
                    .split_ascii_whitespace()
                    .any(|token| token.eq_ignore_ascii_case("stylesheet"))
            {
                return None;
            }
            let media_type = link.attr("type")?;
            let media_type = media_type.split(';').next()?.trim();
            if !["application/rss+xml", "application/atom+xml"]
                .iter()
                .any(|kind| media_type.eq_ignore_ascii_case(kind))
            {
                return None;
            }
            let href = link.attr("href")?;
            let href = href.trim();
            if href.is_empty() {
                return None;
            }
            page.join(href).ok().filter(|url| url.scheme() == "https")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Url {
        Url::parse("https://example.com/author/profile").unwrap()
    }

    fn alternate_feed(bytes: &[u8], page: &Url) -> Option<Url> {
        author_metadata(bytes, page).1
    }

    #[test]
    fn joins_and_decodes_the_first_feed_declared_in_the_head() {
        let html = br#"
            <!doctype html><html><head>
            <link rel="alternate stylesheet" type="application/rss+xml" href="/bad-css">
            <link rel="alternate" type="text/html" href="/translation">
            <link rel="alternate" type="application/rss+xml" href="javascript:alert(0)">
            <link rel="alternate" type="application/rss+xml" href="">
            <LINK TYPE="Application/Atom+XML; charset=utf-8" REL="ALTERNATE" HREF="posts?one=1&amp;two=2">
            <link rel="alternate" type="application/rss+xml" href="/later.xml">
            </head><body></body></html>
        "#;
        assert_eq!(
            alternate_feed(html, &page()).unwrap().as_str(),
            "https://example.com/author/posts?one=1&two=2"
        );
    }

    #[test]
    fn ignores_comments_raw_script_templates_and_body_links() {
        let html = br#"
            <html><head>
            <!-- <link rel="alternate" type="application/rss+xml" href="/comment"> -->
            <script>const html = '<link rel="alternate" type="application/rss+xml" href="/script">';</script>
            <template><link rel="alternate" type="application/rss+xml" href="/template"></template>
            <noscript><link rel="alternate" type="application/rss+xml" href="/nested"></noscript>
            </head><body>
            <link rel="alternate" type="application/rss+xml" href="/body">
            </body></html>
        "#;
        assert!(alternate_feed(html, &page()).is_none());
    }

    #[test]
    fn recognizes_an_implicit_head() {
        let html = r#"<!doctype html><title>作品</title><link href=/feed.xml type=application/rss+xml rel=alternate><main>正文</main>"#;
        assert_eq!(
            alternate_feed(html.as_bytes(), &page()).unwrap().as_str(),
            "https://example.com/feed.xml"
        );
    }

    #[test]
    fn author_metadata_prefers_visible_public_head_names() {
        let html = br#"<title>Generic page</title>
            <meta property="og:title" content="K &amp; Co on Behance">
            <meta name="author" content="Alternative">
            <link type="application/atom+xml" rel="alternate" href="/feed.xml">"#;
        let (name, feed) = author_metadata(html, &page());
        assert_eq!(name.as_deref(), Some("K & Co"));
        assert_eq!(feed.unwrap().as_str(), "https://example.com/feed.xml");
    }

    #[test]
    fn youtube_reads_profile_metadata_emitted_after_the_head() {
        let url = Url::parse("https://www.youtube.com/@MaxonVFX").unwrap();
        let html = br#"<!doctype html><html><head><title>YouTube</title></head><body>
            <link rel="canonical" href="https://www.youtube.com/channel/UCWhRfxKSqHU8hjx7mbmKVxA">
            <meta property="og:title" content="Maxon">
            <meta property="og:description" content="Public profile">
            <meta property="og:image" content="https://yt3.googleusercontent.com/public-avatar">
            </body></html>"#;
        let profile = youtube_profile(html, &url);
        assert_eq!(profile.name.as_deref(), Some("Maxon"));
        assert_eq!(profile.bio.as_deref(), Some("Public profile"));
        assert_eq!(profile.avatar_url.as_deref(), Some("https://yt3.googleusercontent.com/public-avatar"));
        assert_eq!(
            profile.feed.unwrap().as_str(),
            "https://www.youtube.com/feeds/videos.xml?channel_id=UCWhRfxKSqHU8hjx7mbmKVxA"
        );
    }

    #[test]
    fn youtube_images_are_limited_to_exact_media_hosts() {
        for host in ["i.ytimg.com", "i1.ytimg.com", "i2.ytimg.com", "i3.ytimg.com", "i4.ytimg.com",
            "yt3.googleusercontent.com", "yt3.ggpht.com"] {
            let image = format!("https://{host}/public.jpg");
            assert_eq!(public_image_url(&page(), &image), Some(image));
        }
        for host in ["yt3.googleusercontent.com.example.com", "i5.ytimg.com", "other.googleusercontent.com"] {
            assert!(public_image_url(&page(), &format!("https://{host}/public.jpg")).is_none());
        }
    }

    #[test]
    fn youtube_uses_primary_channel_metadata_instead_of_featured_channel_ids() {
        let url = Url::parse("https://www.youtube.com/@MaxonVFX").unwrap();
        let html = br#"<html><head></head><body>
            <script>var ytInitialData = {
                "contents":{"channelId":"UCaaaaaaaaaaaaaaaaaaaaaa","externalId":"UCbbbbbbbbbbbbbbbbbbbbbb"},
                "metadata":{"channelMetadataRenderer":{"externalId":"UCWhRfxKSqHU8hjx7mbmKVxA",
                    "title":"Maxon","description":"The recorded public description"}}
            };</script>
            </body></html>"#;
        let profile = youtube_profile(html, &url);
        assert_eq!(profile.name.as_deref(), Some("Maxon"));
        assert_eq!(
            profile.bio.as_deref(),
            Some("The recorded public description")
        );
        assert_eq!(
            profile.feed.unwrap().as_str(),
            "https://www.youtube.com/feeds/videos.xml?channel_id=UCWhRfxKSqHU8hjx7mbmKVxA"
        );
        let unrelated = br#"<html><head></head><body>
            <script>var ytInitialData = {"contents":{"channelId":"UCaaaaaaaaaaaaaaaaaaaaaa"}};</script>
            <link rel="canonical" href="https://www.youtube.com.example.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa">
            </body></html>"#;
        assert!(youtube_profile(unrelated, &url).feed.is_none());
    }
}
