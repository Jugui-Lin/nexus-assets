use super::{article_url, checked_url, html::public_image_url, Feed, FeedItem};
use quick_xml::{
    escape::resolve_predefined_entity,
    events::{BytesStart, Event},
    name::{Namespace, ResolveResult},
    NsReader, XmlVersion,
};
use reqwest::Url;
use std::collections::HashSet;

const INVALID_FEED: &str = "订阅内容不是有效的 UTF-8 RSS 或 Atom";
const MAX_DEPTH: usize = 48;
const MAX_ITEMS: usize = 40;
const MAX_FIELD_BYTES: usize = 4096;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Rss,
    Rdf,
    Atom,
    Channel,
    Item,
    Entry,
    Title,
    Link,
    Alternate,
    Guid,
    Published,
    Updated,
    MediaGroup,
    MediaThumbnail,
    Other,
}

impl Role {
    fn classify(parent: Option<Self>, name: &str, media: bool) -> Result<Self, &'static str> {
        use Role::*;
        if media && parent.is_some() {
            return Ok(match (parent, name) {
                (Some(Item | Entry), "group") => MediaGroup,
                (Some(Item | Entry | MediaGroup), "thumbnail") => MediaThumbnail,
                _ => Other,
            });
        }
        Ok(match (parent, name) {
            (None, "rss") => Rss,
            (None, "RDF") => Rdf,
            (None, "feed") => Atom,
            (None, _) => return Err(INVALID_FEED),
            (Some(Rss | Rdf), "channel") => Channel,
            (Some(Channel | Rdf), "item") => Item,
            (Some(Atom), "entry") => Entry,
            (Some(Channel | Atom | Item | Entry), "title") => Title,
            (Some(Item), "link") => Link,
            (Some(Item), "guid") => Guid,
            (Some(Entry), "link") => Alternate,
            (Some(Item | Entry), "pubDate" | "published") => Published,
            (Some(Item | Entry), "date" | "updated") => Updated,
            _ => Other,
        })
    }

    fn has_text(self) -> bool {
        matches!(
            self,
            Self::Title | Self::Link | Self::Guid | Self::Published | Self::Updated
        )
    }
}

struct Element {
    role: Role,
    base: Url,
    text: Option<String>,
}

#[derive(Default)]
struct Entry {
    title: Option<String>,
    link: Option<Url>,
    guid: Option<Url>,
    published: Option<String>,
    updated: Option<String>,
    cover: Option<String>,
}

impl Entry {
    fn finish(self) -> Option<FeedItem> {
        Some(FeedItem {
            title: self.title?,
            url: self.link.or(self.guid)?.into(),
            published_at: self.published.or(self.updated),
            cover_url: self.cover,
            ..Default::default()
        })
    }
}

fn attribute(element: &BytesStart<'_>, name: &str) -> Result<Option<String>, &'static str> {
    let Some(value) = element.try_get_attribute(name).map_err(|_| INVALID_FEED)? else {
        return Ok(None);
    };
    if value.value.len() > MAX_FIELD_BYTES {
        return Ok(None);
    }
    value
        .normalized_value(XmlVersion::Explicit1_0)
        .map(|value| Some(value.into_owned()))
        .map_err(|_| INVALID_FEED)
}

fn append_text(stack: &mut [Element], value: &str) -> Result<(), &'static str> {
    if stack.is_empty() && !value.trim().is_empty() {
        return Err(INVALID_FEED);
    }
    if let Some(field) = stack
        .iter_mut()
        .rev()
        .find_map(|element| element.text.as_mut())
    {
        let mut end = value.len().min(MAX_FIELD_BYTES - field.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        field.push_str(&value[..end]);
    }
    Ok(())
}

fn label(value: &str, max: usize) -> Option<String> {
    let label: String = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect();
    (!label.is_empty()).then_some(label)
}

pub(super) fn parse(bytes: &[u8], feed_url: &Url) -> Result<Feed, String> {
    let xml = std::str::from_utf8(bytes).map_err(|_| INVALID_FEED)?;
    let mut reader = NsReader::from_str(xml);
    reader.config_mut().expand_empty_elements = true;
    let mut stack: Vec<Element> = Vec::new();
    let mut entry: Option<Entry> = None;
    let mut title = None;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut has_root = false;

    loop {
        match reader.read_resolved_event().map_err(|_| INVALID_FEED)? {
            (namespace, Event::Start(start)) => {
                let parent = stack.last();
                if stack.len() >= MAX_DEPTH || (parent.is_none() && has_root) {
                    return Err(INVALID_FEED.into());
                }
                let mut role = Role::classify(
                    parent.map(|element| element.role),
                    start.local_name().as_ref(),
                    matches!(
                        namespace,
                        ResolveResult::Bound(Namespace("http://search.yahoo.com/mrss/"))
                    ),
                )?;
                has_root = true;
                let inherited_base = parent.map_or(feed_url, |element| &element.base);
                let base = attribute(&start, "xml:base")?
                    .and_then(|base| inherited_base.join(&base).ok())
                    .unwrap_or_else(|| inherited_base.clone());
                if matches!(role, Role::Item | Role::Entry) && items.len() < MAX_ITEMS {
                    entry = Some(Entry::default());
                } else if role == Role::MediaThumbnail {
                    if let Some(current) = entry.as_mut().filter(|entry| entry.cover.is_none()) {
                        current.cover =
                            attribute(&start, "url")?.and_then(|url| public_image_url(&base, &url));
                    }
                } else if role == Role::Alternate {
                    if let Some(current) = entry.as_mut().filter(|entry| entry.link.is_none()) {
                        let rel = attribute(&start, "rel")?;
                        if rel.as_deref().is_none_or(|rel| rel == "alternate") {
                            current.link = attribute(&start, "href")?
                                .and_then(|href| article_url(&base, &href));
                        }
                    }
                } else if role == Role::Guid
                    && attribute(&start, "isPermaLink")?
                        .is_some_and(|flag| !flag.eq_ignore_ascii_case("true"))
                {
                    role = Role::Other;
                }
                stack.push(Element {
                    role,
                    base,
                    text: role.has_text().then(String::new),
                });
            }
            (_, Event::Text(text)) => append_text(&mut stack, &text.xml10_content())?,
            (_, Event::CData(text)) => append_text(&mut stack, &text.xml10_content())?,
            (_, Event::GeneralRef(reference)) => {
                if let Some(character) = reference.resolve_char_ref().map_err(|_| INVALID_FEED)? {
                    append_text(&mut stack, character.encode_utf8(&mut [0; 4]))?;
                } else {
                    append_text(
                        &mut stack,
                        resolve_predefined_entity(&reference).ok_or(INVALID_FEED)?,
                    )?;
                }
            }
            (_, Event::End(_)) => {
                let element = stack.pop().ok_or(INVALID_FEED)?;
                if matches!(element.role, Role::Item | Role::Entry) {
                    if let Some(item) = entry.take().and_then(Entry::finish) {
                        if seen.insert(item.url.clone()) {
                            items.push(item);
                        }
                    }
                }
                let Some(text) = element.text else {
                    continue;
                };
                match (element.role, &mut entry) {
                    (Role::Title, Some(entry)) if entry.title.is_none() => {
                        entry.title = label(&text, 300)
                    }
                    (Role::Title, None)
                        if title.is_none()
                            && stack.last().is_some_and(|parent| {
                                matches!(parent.role, Role::Channel | Role::Atom)
                            }) =>
                    {
                        title = label(&text, 300)
                    }
                    (Role::Link, Some(entry)) if entry.link.is_none() => {
                        entry.link = article_url(&element.base, &text)
                    }
                    (Role::Guid, Some(entry)) if entry.guid.is_none() => {
                        entry.guid = Url::parse(text.trim())
                            .ok()
                            .and_then(|url| checked_url(url, false).ok())
                    }
                    (Role::Published, Some(entry)) if entry.published.is_none() => {
                        entry.published = label(&text, 128)
                    }
                    (Role::Updated, Some(entry)) if entry.updated.is_none() => {
                        entry.updated = label(&text, 128)
                    }
                    _ => {}
                }
            }
            (_, Event::DocType(_)) => return Err("订阅不支持 XML 文档类型声明".into()),
            (_, Event::Eof) if has_root && stack.is_empty() => break,
            (_, Event::Eof) => return Err(INVALID_FEED.into()),
            _ => {}
        }
    }

    Ok(Feed {
        title: title.unwrap_or_else(|| feed_url.host_str().unwrap_or("订阅来源").to_owned()),
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://example.org/author/feed.xml").unwrap()
    }

    #[test]
    fn rss_decodes_labels_and_uses_links_before_permalink_guids() {
        let content = br#"<?xml version="1.0"?><rss version="2.0"><channel>
          <title> A &amp; B </title>
          <item><title><![CDATA[  Art & layout  ]]></title><link>../project?one=a&amp;two=b#see</link>
            <pubDate>Wed, 01 Jan 2025 12:00:00 GMT</pubDate><guid>https://example.com/wrong</guid></item>
          <item><title>Artwork &#x1F3A8;</title><guid>https://example.org/other</guid></item>
          <item><title>Skip private address</title><link>https://127.0.0.1/private</link></item>
          <item><title>Skip duplicates</title><link>https://example.org/other</link></item>
          <item><title>Skip opaque ID</title><guid isPermaLink="false">opaque id</guid></item>
         </channel></rss>"#;
        let feed = parse(content, &base()).unwrap();
        assert_eq!(feed.title, "A & B");
        assert_eq!(feed.items.len(), 2);
        assert_eq!(feed.items[0].title, "Art & layout");
        assert_eq!(
            feed.items[0].url,
            "https://example.org/project?one=a&two=b#see"
        );
        assert_eq!(
            feed.items[0].published_at.as_deref(),
            Some("Wed, 01 Jan 2025 12:00:00 GMT")
        );
        assert_eq!(feed.items[1].title, "Artwork 🎨");
        assert!(feed.items[1].published_at.is_none());
    }

    #[test]
    fn atom_resolves_alternate_links_and_prefers_publication_date() {
        let content = r#"<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="https://example.com/art/">
         <a:title>作品</a:title><a:entry xml:base="series/">
          <a:title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">A <b>design</b></div></a:title>
          <a:link rel="self" href="bad"/><a:link href="photo.html?one=1&amp;two=2"/>
          <a:updated>2025-01-02T00:00:00Z</a:updated><a:published>2025-01-01T00:00:00Z</a:published>
         </a:entry></a:feed>"#;
        let feed = parse(content.as_bytes(), &base()).unwrap();
        assert_eq!(feed.title, "作品");
        assert_eq!(feed.items[0].title, "A design");
        assert_eq!(
            feed.items[0].url,
            "https://example.com/art/series/photo.html?one=1&two=2"
        );
        assert_eq!(
            feed.items[0].published_at.as_deref(),
            Some("2025-01-01T00:00:00Z")
        );
    }

    #[test]
    fn atom_uses_the_first_valid_media_rss_thumbnail_for_each_video() {
        let content = br#"<feed xmlns="http://www.w3.org/2005/Atom"
              xmlns:media="http://search.yahoo.com/mrss/" xmlns:other="urn:unrelated">
            <entry><title>Maxon Plus</title>
              <link rel="alternate" href="https://www.youtube.com/watch?v=b_26a6SvZKA"/>
              <other:thumbnail url="https://i.ytimg.com/wrong.jpg"/>
              <media:group>
                <media:thumbnail url="https://127.0.0.1/private.jpg"/>
                <media:thumbnail url="https://i1.ytimg.com/vi/b_26a6SvZKA/hqdefault.jpg"/>
              </media:group>
            </entry>
            <entry><title>Later work</title>
              <link rel="alternate" href="https://www.youtube.com/watch?v=abcdefghijk"/>
            </entry></feed>"#;
        let feed = parse(content, &base()).unwrap();
        assert_eq!(
            feed.items[0].cover_url.as_deref(),
            Some("https://i1.ytimg.com/vi/b_26a6SvZKA/hqdefault.jpg")
        );
        assert!(feed.items[1].cover_url.is_none());
    }

    #[test]
    fn malformed_html_dtd_and_unbounded_depth_are_rejected() {
        for content in [
            b"<html><body>login</body></html>".as_slice(),
            b"<!DOCTYPE rss><rss/>",
            b"<rss><channel>",
            b"<rss/><rss/>",
            b"<rss><channel/></feed>",
        ] {
            assert!(parse(content, &base()).is_err());
        }
        let nested = format!("<rss>{}</rss>", "<n>".repeat(49) + &"</n>".repeat(49));
        assert!(parse(nested.as_bytes(), &base()).is_err());
        let many = (0..60)
            .map(|i| format!("<item><title>{i}</title><link>/{i}</link></item>"))
            .collect::<String>();
        let feed = format!("<rss><channel>{many}</channel></rss>");
        assert_eq!(
            parse(feed.as_bytes(), &base()).unwrap().items.len(),
            MAX_ITEMS
        );
    }
}
