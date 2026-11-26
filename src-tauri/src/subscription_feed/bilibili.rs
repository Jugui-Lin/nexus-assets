use super::{fetch, fetch_with_redirect_check, html, Discovery, FeedItem, PROFILE_TYPES};
use dom_query::Document;
use flate2::read::GzDecoder;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, io::Read};

const MAX_PLAYLIST_BYTES: usize = 1024 * 1024;
const MAX_VIDEO_METADATA_BYTES: usize = 64 * 1024;
const VIDEO_METADATA_ENDPOINT: &str = "https://api.bilibili.com/x/web-interface/view";
const MAX_WORKS: usize = 40;
const STATE_MARKER: &str = "window.__INITIAL_STATE__";

enum VideoId {
    Bvid(String),
    Aid(u64),
}

impl VideoId {
    fn from_page(page: &Url) -> Option<Self> {
        if page.scheme() != "https"
            || !matches!(
                page.domain(),
                Some("bilibili.com" | "www.bilibili.com" | "m.bilibili.com")
            )
            || page.port().is_some()
        {
            return None;
        }
        let path = page.path().strip_prefix("/video/")?;
        let id = path.strip_suffix('/').unwrap_or(path);
        let prefix = id.get(..2)?;
        let rest = id.get(2..)?;
        if prefix.eq_ignore_ascii_case("bv")
            && rest.len() == 10
            && rest.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Some(Self::Bvid(format!("BV{rest}")));
        }
        if prefix.eq_ignore_ascii_case("av") {
            return parse_aid(rest).map(Self::Aid);
        }
        None
    }

    fn endpoint(&self) -> Option<Url> {
        let mut url = Url::parse(VIDEO_METADATA_ENDPOINT).ok()?;
        match self {
            Self::Bvid(id) => {
                url.query_pairs_mut().append_pair("bvid", id);
            }
            Self::Aid(id) => {
                url.query_pairs_mut().append_pair("aid", &id.to_string());
            }
        }
        Some(url)
    }
}

fn parse_aid(id: &str) -> Option<u64> {
    if id.starts_with('0') || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    id.parse().ok()
}

pub(super) fn official_video_metadata_route(url: &Url) -> bool {
    let Some((key, value)) = url.query().and_then(|query| query.split_once('=')) else {
        return false;
    };
    let valid_id = match key {
        "bvid" => {
            value.len() == 12
                && value.starts_with("BV")
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        }
        "aid" => parse_aid(value).is_some(),
        _ => false,
    };
    valid_id && url.as_str() == format!("{VIDEO_METADATA_ENDPOINT}?{key}={value}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoReferenceMetadata {
    title: Option<String>,
    cover_url: Option<String>,
}

#[derive(Deserialize)]
struct VideoMetadataResponse {
    code: i64,
    data: Option<VideoMetadataData>,
}

#[derive(Deserialize)]
struct VideoMetadataData {
    bvid: String,
    aid: u64,
    title: Option<String>,
    pic: Option<String>,
}

fn video_cover_url(origin: &Url, image: &str) -> Option<String> {
    let mut url = Url::parse(&html::public_image_url(origin, image)?).ok()?;
    if !url.domain()?.ends_with(".hdslb.com") {
        return None;
    }
    let archive = url.path().strip_prefix("/bfs/archive/");
    if url.query().is_none()
        && archive
            .and_then(|file| file.split_once('.'))
            .is_some_and(|(name, extension)| {
                !name.is_empty()
                    && name.bytes().all(|byte| byte.is_ascii_alphanumeric())
                    && matches!(extension, "jpg" | "jpeg" | "png" | "webp")
            })
    {
        url.set_path(&format!("{}@480w.webp", url.path()));
    }
    Some(url.into())
}

fn parse_video_metadata(
    bytes: &[u8],
    id: &VideoId,
    origin: &Url,
) -> Option<VideoReferenceMetadata> {
    let response: VideoMetadataResponse = serde_json::from_slice(bytes).ok()?;
    if response.code != 0 {
        return None;
    }
    let data = response.data?;
    let matches = match id {
        VideoId::Bvid(id) => data.bvid == *id,
        VideoId::Aid(id) => data.aid == *id,
    };
    if !matches {
        return None;
    }
    let title = data
        .title
        .as_deref()
        .and_then(|value| html::compact_text(value, 160));
    let cover_url = data
        .pic
        .as_deref()
        .and_then(|value| video_cover_url(origin, value));
    (title.is_some() || cover_url.is_some()).then_some(VideoReferenceMetadata { title, cover_url })
}

pub(super) async fn video_reference_metadata(page: &Url) -> Option<VideoReferenceMetadata> {
    let id = VideoId::from_page(page)?;
    let endpoint = id.endpoint()?;
    let (source, bytes) = fetch_with_redirect_check(
        endpoint,
        "application/json",
        MAX_VIDEO_METADATA_BYTES,
        |_| false,
    )
    .await
    .ok()?;
    parse_video_metadata(&bytes, &id, &source)
}

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

    #[test]
    fn builds_only_the_canonical_video_metadata_routes() {
        let page = Url::parse("https://m.bilibili.com/video/bv1cXVz67EaF/?p=2#fragment").unwrap();
        let endpoint = VideoId::from_page(&page).unwrap().endpoint().unwrap();
        assert_eq!(
            endpoint.as_str(),
            "https://api.bilibili.com/x/web-interface/view?bvid=BV1cXVz67EaF"
        );
        assert!(official_video_metadata_route(&endpoint));
        let av = Url::parse("https://www.bilibili.com/video/av123").unwrap();
        assert!(official_video_metadata_route(
            &VideoId::from_page(&av).unwrap().endpoint().unwrap()
        ));
        for bad in [
            "https://www.bilibili.com/video/BV1cXVz67EaF/extra",
            "https://www.bilibili.com.example/video/BV1cXVz67EaF",
            "https://www.bilibili.com:444/video/BV1cXVz67EaF",
            "https://www.bilibili.com/video/av0",
        ] {
            assert!(
                VideoId::from_page(&Url::parse(bad).unwrap()).is_none(),
                "{bad}"
            );
        }
        for bad in [
            "https://api.bilibili.com/x/web-interface/view?bvid=BV1cXVz67EaF&foo=1",
            "https://api.bilibili.com/x/web-interface/view?bvid=BV1cXVz67EaF#extra",
            "https://api.bilibili.com.example/x/web-interface/view?bvid=BV1cXVz67EaF",
        ] {
            assert!(
                !official_video_metadata_route(&Url::parse(bad).unwrap()),
                "{bad}"
            );
        }
    }

    #[test]
    fn checks_video_identity_and_filters_cover_urls() {
        let expected = VideoId::Bvid("BV1cXVz67EaF".into());
        let origin = expected.endpoint().unwrap();
        let mut response = json!({
            "code": 0,
            "data": {
                "aid": 123,
                "bvid": "BV1cXVz67EaF",
                "title": " 实际视频   标题 ",
                "pic": "http://i2.hdslb.com/bfs/archive/ABC123.png"
            }
        });
        let parse = |response: &Value| {
            parse_video_metadata(response.to_string().as_bytes(), &expected, &origin)
        };
        let video = parse(&response).unwrap();
        assert_eq!(video.title.as_deref(), Some("实际视频 标题"));
        assert_eq!(
            video.cover_url.as_deref(),
            Some("https://i2.hdslb.com/bfs/archive/ABC123.png@480w.webp")
        );
        response["data"]["pic"] = json!("https://i2.hdslb.com.example/bfs/archive/ABC123.png");
        assert!(parse(&response).unwrap().cover_url.is_none());
        response["data"]["bvid"] = json!("BV1AAAAAABBB");
        assert!(parse(&response).is_none());
        response["code"] = json!(-412);
        assert!(parse(&response).is_none());
    }

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
