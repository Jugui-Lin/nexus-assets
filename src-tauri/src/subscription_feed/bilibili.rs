use super::{fetch, html, Discovery, FeedItem, PROFILE_TYPES};
use dom_query::Document;
use flate2::read::GzDecoder;
use reqwest::Url;
use serde::Deserialize;
use std::{collections::HashSet, io::Read};

const MAX_PLAYLIST_BYTES: usize = 1024 * 1024;
const MAX_WORKS: usize = 40;
const STATE_MARKER: &str = "window.__INITIAL_STATE__";

pub(super) fn playlist_id(url: &Url) -> Option<u64> {
    if url.scheme() != "https"
        || url.domain() != Some("www.bilibili.com")
        || url.port_or_known_default() != Some(443)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let value = url.path().strip_prefix("/list/")?;
    if value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

pub(super) async fn public_works(profile: &Url) -> Option<Discovery> {
    let expected: u64 = profile.path().strip_prefix('/')?.parse().ok()?;
    let mut playlist = Url::parse("https://www.bilibili.com/").ok()?;
    playlist.set_path(&format!("/list/{expected}"));
    let (resolved, bytes) = fetch(playlist, PROFILE_TYPES, MAX_PLAYLIST_BYTES)
        .await
        .ok()?;
    if playlist_id(&resolved)? != expected {
        return None;
    }
    let bytes = decoded_playlist(bytes)?;
    parse_playlist(&bytes, expected)
}

fn decoded_playlist(bytes: Vec<u8>) -> Option<Vec<u8>> {
    // The playlist can arrive as gzip even with Accept-Encoding: identity.
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return Some(bytes);
    }
    let mut html = Vec::new();
    GzDecoder::new(bytes.as_slice())
        .take(MAX_PLAYLIST_BYTES as u64 + 1)
        .read_to_end(&mut html)
        .ok()?;
    (html.len() <= MAX_PLAYLIST_BYTES).then_some(html)
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CreatorId {
    Number(u64),
    Text(String),
}

impl CreatorId {
    fn matches(&self, expected: u64) -> bool {
        match self {
            Self::Number(number) => *number == expected,
            Self::Text(text) => text.parse().ok() == Some(expected),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistPage {
    playlist: Playlist,
    list_error: PageStatus,
    info_error: PageStatus,
    list_total: u64,
    media_list_info: Archive,
    resource_list: Vec<serde_json::Value>,
    video_data: Option<SelectedVideo>,
    up_data: Option<Author>,
    up_info: Option<Author>,
}

#[derive(Deserialize)]
struct Playlist {
    id: CreatorId,
    #[serde(rename = "type")]
    kind: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageStatus {
    code: u16,
    true_code: i64,
    list_type: u8,
}

impl PageStatus {
    fn is_creator_archive(&self) -> bool {
        self.code == 200 && self.true_code == 0 && self.list_type == 1
    }
}

#[derive(Deserialize)]
struct Archive {
    mid: CreatorId,
    upper: Author,
}

#[derive(Deserialize)]
struct Author {
    mid: CreatorId,
    name: Option<String>,
    face: Option<String>,
    sign: Option<String>,
}

#[derive(Deserialize)]
struct SelectedVideo {
    owner: Option<Author>,
    bvid: Option<String>,
    pubdate: Option<u64>,
    desc: Option<String>,
    duration: Option<u64>,
}

#[derive(Deserialize)]
struct Work {
    #[serde(rename = "type")]
    kind: u8,
    bvid: String,
    title: String,
    owner: Option<Author>,
    cover: Option<String>,
    view: Option<u64>,
    pages: Option<Vec<WorkPage>>,
}

#[derive(Deserialize)]
struct WorkPage {
    duration: Option<u64>,
}

fn parse_playlist(bytes: &[u8], expected: u64) -> Option<Discovery> {
    let document = Document::from(std::str::from_utf8(bytes).ok()?);
    let page = document
        .select("script:not([src])")
        .iter()
        .find_map(|node| {
            let source = node.text();
            let state = source
                .trim_start()
                .strip_prefix(STATE_MARKER)?
                .trim_start()
                .strip_prefix('=')?;
            let mut stream = serde_json::Deserializer::from_str(state).into_iter::<PlaylistPage>();
            let page = stream.next()?.ok()?;
            (state
                .get(stream.byte_offset()..)?
                .trim_start()
                .starts_with(';'))
            .then_some(page)
        })?;
    let Archive { mid, upper } = page.media_list_info;
    // The unfiltered type 1 playlist belongs to the creator. Its rows can omit the
    // owner, so confirm the enclosing archive and reject any contradictory row owner.
    if page.playlist.kind != 1
        || !page.playlist.id.matches(expected)
        || !page.list_error.is_creator_archive()
        || !page.info_error.is_creator_archive()
        || !mid.matches(expected)
        || !upper.mid.matches(expected)
        || page
            .video_data
            .as_ref()
            .and_then(|video| video.owner.as_ref())
            .is_some_and(|owner| !owner.mid.matches(expected))
    {
        return None;
    }
    let data_empty = page.resource_list.is_empty();
    let origin = Url::parse("https://www.bilibili.com/").ok()?;
    let video = page.video_data.as_ref();
    let mut seen = HashSet::new();
    let works: Vec<FeedItem> = page
        .resource_list
        .into_iter()
        .filter_map(|value| serde_json::from_value::<Work>(value).ok())
        .filter_map(|work| {
            if work.kind != 2
                || work.bvid.len() != 12
                || !work.bvid.starts_with("BV")
                || !work.bvid.bytes().all(|byte| byte.is_ascii_alphanumeric())
                || work.owner.is_some_and(|owner| !owner.mid.matches(expected))
            {
                return None;
            }
            let title: String = work
                .title
                .trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(400)
                .collect();
            if title.is_empty() || !seen.insert(work.bvid.clone()) {
                return None;
            }
            let selected = video.filter(|video| video.bvid.as_deref() == Some(work.bvid.as_str()));
            let duration = work
                .pages
                .unwrap_or_default()
                .iter()
                .fold(0u64, |seconds, part| {
                    seconds.saturating_add(part.duration.unwrap_or(0))
                });
            Some(FeedItem {
                title,
                url: format!("https://www.bilibili.com/video/{}", work.bvid),
                published_timestamp: selected
                    .and_then(|video| video.pubdate)
                    .filter(|date| *date > 0),
                cover_url: work
                    .cover
                    .as_deref()
                    .and_then(|value| html::public_image_url(&origin, value)),
                description: selected
                    .and_then(|video| video.desc.as_deref())
                    .and_then(|value| html::compact_text(value, 500)),
                duration_seconds: if duration > 0 {
                    Some(duration)
                } else {
                    selected.and_then(|video| video.duration)
                },
                view_count: work.view,
                ..Default::default()
            })
        })
        .take(MAX_WORKS)
        .collect();
    if (page.list_total == 0 && !data_empty) || (page.list_total > 0 && works.is_empty()) {
        return None;
    }
    let name = upper.name.as_deref().and_then(html::title_name);
    let profile = [page.up_data.as_ref(), page.up_info.as_ref()]
        .into_iter()
        .flatten()
        .find(|owner| owner.mid.matches(expected));
    let avatar_url = profile
        .and_then(|owner| owner.face.as_deref())
        .and_then(|value| html::public_image_url(&origin, value))
        .or_else(|| {
            upper
                .face
                .as_deref()
                .and_then(|value| html::public_image_url(&origin, value))
        });
    let bio = profile
        .and_then(|owner| owner.sign.as_deref())
        .or(upper.sign.as_deref())
        .and_then(|value| html::compact_text(value, 400));
    Some(Discovery {
        name,
        avatar_url,
        bio,
        feed_url: None,
        source_status: Some("public-works"),
        items: Some(works),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const CREATOR: u64 = 66482012;

    fn page(rows: Vec<Value>, total: u64) -> Value {
        json!({
            "playlist": { "id": CREATOR.to_string(), "type": 1 },
            "listError": { "code": 200, "trueCode": 0, "listType": 1 },
            "infoError": { "code": 200, "trueCode": 0, "listType": 1 },
            "listTotal": total,
            "mediaListInfo": { "mid": CREATOR, "upper": { "mid": CREATOR, "name": "KKK_E" } },
            "resourceList": rows
        })
    }

    fn parse(page: &Value) -> Option<Discovery> {
        let html = format!(
            r"<html><body><script>window.__INITIAL_STATE__={page};(function(){{}}());</script></body></html>"
        );
        parse_playlist(html.as_bytes(), CREATOR)
    }

    #[test]
    fn only_uses_the_exact_official_unfiltered_archive_route() {
        let address = "198.18.1.234".parse().unwrap();
        let route = Url::parse("https://www.bilibili.com/list/66482012").unwrap();
        assert_eq!(playlist_id(&route), Some(CREATOR));
        assert!(super::super::usable_feed_address(&route, address));
        assert!(!super::super::usable_feed_address(
            &route,
            "127.0.0.1".parse().unwrap()
        ));
        for url in [
            "https://www.bilibili.com:444/list/66482012",
            "https://www.bilibili.com.invalid/list/66482012",
            "https://www.bilibili.com/list/66482012#more",
            "https://www.bilibili.com/list/66482012?bvid=BV1Aasq6VE6i",
            "https://www.bilibili.com/list/0",
            "https://www.bilibili.com/list/66482012/extra",
        ] {
            assert!(!super::super::usable_feed_address(
                &Url::parse(url).unwrap(),
                address
            ));
        }
    }

    #[test]
    fn takes_only_distinct_valid_video_rows_from_the_matching_creators_archive() {
        let discovery = parse(&page(
            vec![
                json!({ "type": 2, "bvid": "BV1Aasq6VE6i", "title": "FrameRate" }),
                json!({ "type": 2, "bvid": "BV1Aasq6VE6i", "title": "Duplicate" }),
                json!({ "type": 1, "bvid": "BV1wYsq6kEdt", "title": "Unrelated type" }),
                json!({ "type": 2, "bvid": "BV1wYsq6kEdt", "title": "Different owner", "owner": { "mid": 7 } }),
                json!({ "type": 2, "bvid": "../untrusted", "title": "Bad identifier" }),
                json!({ "type": 2, "bvid": "BV1wYsq6kEdt", "title": "  Orchestrated Blossom  ", "owner": { "mid": CREATOR.to_string() } }),
            ],
            4230,
        ))
        .unwrap();
        let items = discovery.items.unwrap();
        assert_eq!(discovery.name.as_deref(), Some("KKK_E"));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].url, "https://www.bilibili.com/video/BV1Aasq6VE6i");
        assert_eq!(items[1].title, "Orchestrated Blossom");
        assert_eq!(items[0].published_at, None);
    }

    #[test]
    fn distinguishes_a_confirmed_empty_archive_from_page_failure_or_wrong_owner() {
        assert!(parse(&page(vec![], 0)).unwrap().items.unwrap().is_empty());
        assert!(parse(&page(vec![], 1)).is_none());

        let mut unavailable = page(vec![], 0);
        unavailable["listError"]["trueCode"] = json!(-400);
        assert!(parse(&unavailable).is_none());

        let mut different = page(vec![], 0);
        different["mediaListInfo"]["upper"]["mid"] = json!(7);
        assert!(parse(&different).is_none());
        different["mediaListInfo"]["upper"]["mid"] = json!(CREATOR);
        different["playlist"]["type"] = json!(3);
        assert!(parse(&different).is_none());
    }

    #[test]
    fn attaches_only_matching_profile_and_work_metadata() {
        let mut source = page(
            vec![
                json!({"type":2,"bvid":"BV1Aasq6VE6i","title":"FrameRate",
                "cover":"//i2.hdslb.com/bfs/archive/frame.jpg","view":501,
                "pages":[{"duration":41}]}),
                json!({"type":2,"bvid":"BV1wYsq6kEdt","title":"A second work",
                "cover":"https://i2.hdslb.com.invalid/bad.jpg","view":0}),
            ],
            2,
        );
        source["upData"] = json!({"mid":CREATOR,"face":"http://i2.hdslb.com/bfs/face/avatar.jpg",
            "sign":"  关注我，你就关注了这个世界！  "});
        source["videoData"] = json!({"bvid":"BV1Aasq6VE6i","owner":{"mid":CREATOR},
            "pubdate":1795157915,"desc":"  作品简介   第二行","duration":41});
        let result = parse(&source).unwrap();
        assert_eq!(
            result.avatar_url.as_deref(),
            Some("https://i2.hdslb.com/bfs/face/avatar.jpg")
        );
        assert_eq!(result.bio.as_deref(), Some("关注我，你就关注了这个世界！"));
        let items = result.items.unwrap();
        assert_eq!(items[0].duration_seconds, Some(41));
        assert_eq!(items[0].published_timestamp, Some(1795157915));
        assert_eq!(items[0].view_count, Some(501));
        assert_eq!(items[0].description.as_deref(), Some("作品简介 第二行"));
        assert!(items[0].cover_url.is_some());
        assert!(items[1].cover_url.is_none());
        assert!(items[1].published_timestamp.is_none());
        assert!(items[1].description.is_none());
    }
}
