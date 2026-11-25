use super::{
    fetch, fetch_with_redirect_check, html::compact_text, Discovery, FeedItem,
    MAX_AUTHOR_PAGE_BYTES, PROFILE_TYPES,
};
use dom_query::Document;
use reqwest::Url;
use serde_json::Value;
use std::collections::HashSet;

pub(super) const TITLE: &str = "新片场 · 编辑精选";
const EDITOR_URL: &str = "https://www.xinpianchang.com/recommend/editor";
const WORK_ORIGIN: &str = "https://www.xinpianchang.com";
const PLAYER_URL: &str = "https://player.xinpianchang.com/";
const SOURCE_ERROR: &str = "暂时无法读取新片场编辑精选，请稍后重试";
const SECTION_PATH: &str = "/props/pageProps/editorRecommendData/section";

pub(super) fn editor_source(url: &Url) -> Option<Url> {
    if url.scheme() == "https"
        && matches!(
            url.domain(),
            Some("www.xinpianchang.com" | "xinpianchang.com")
        )
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/recommend/editor" | "/recommend/editor/")
    {
        Url::parse(EDITOR_URL).ok()
    } else {
        None
    }
}

pub(super) async fn public_works(source: Url) -> Result<Discovery, String> {
    let (final_url, bytes) = fetch(source, PROFILE_TYPES, MAX_AUTHOR_PAGE_BYTES).await?;
    if editor_source(&final_url).is_none() {
        return Err(SOURCE_ERROR.into());
    }
    let items = works(&bytes).ok_or(SOURCE_ERROR)?;
    Ok(Discovery {
        feed_url: None,
        name: Some(TITLE.into()),
        avatar_url: None,
        bio: None,
        source_status: Some("public-works"),
        items: Some(items),
    })
}

pub(super) fn work_id(url: &Url) -> Option<u64> {
    if url.scheme() != "https"
        || !matches!(
            url.domain(),
            Some("www.xinpianchang.com" | "xinpianchang.com")
        )
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let id = url.path().strip_prefix("/a")?;
    if id.starts_with('0') || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    id.parse::<u64>().ok()
}

pub(super) async fn player_for_work(url: &Url) -> Result<Option<String>, String> {
    let Some(id) = work_id(url) else {
        return Ok(None);
    };
    let source = Url::parse(&format!("{WORK_ORIGIN}/a{id}")).map_err(|_| SOURCE_ERROR)?;
    let (_, bytes) =
        fetch_with_redirect_check(source, "text/html", MAX_AUTHOR_PAGE_BYTES, |_| false).await?;
    if let Some(data) = next_data(&bytes) {
        return Ok(public_player(&data, id));
    }
    // The public editor feed independently publishes each featured video's media ID.
    let editor = Url::parse(EDITOR_URL).map_err(|_| SOURCE_ERROR)?;
    let (_, bytes) =
        fetch_with_redirect_check(editor, PROFILE_TYPES, MAX_AUTHOR_PAGE_BYTES, |_| false).await?;
    Ok(next_data(&bytes).and_then(|data| editorial_player(&data, id)))
}

fn public_player(data: &Value, id: u64) -> Option<String> {
    let props = data.pointer("/props/pageProps")?;
    let detail = &props["detail"];
    let video = &detail["video"];
    if data["page"] != "/article/[article_id]"
        || props["type"] != "normal"
        || detail["id"].as_u64() != Some(id)
        || detail["is_private"].as_bool() != Some(false)
        || detail["status"].as_u64() != Some(0)
        || detail["public_status"].as_u64() != Some(0)
        || props["articleShareSwitch"]["switch"] != "on"
        || video["type"].as_u64() != Some(1)
        || video["status"].as_u64() != Some(3)
    {
        return None;
    }
    let mid = detail["media_id"].as_str()?;
    if video["vid"].as_str() != Some(mid) {
        return None;
    }
    player_url(id, mid)
}

fn editorial_player(data: &Value, id: u64) -> Option<String> {
    let article = editorial_articles(data)?
        .iter()
        .find(|article| public_article_id(article) == Some(id))?;
    player_url(id, article["media_id"].as_str()?)
}

fn player_url(id: u64, mid: &str) -> Option<String> {
    if !(1..=64).contains(&mid.len()) || !mid.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let mut player = Url::parse(PLAYER_URL).ok()?;
    player
        .query_pairs_mut()
        .append_pair("aid", &id.to_string())
        .append_pair("mid", mid);
    Some(player.into())
}

fn cover(value: &str) -> Option<String> {
    let mut url = Url::parse(value).ok()?;
    if value.len() > 2048
        || url.scheme() != "https"
        || url.domain() != Some("oss-xpc0.xpccdn.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with("/uploadfile/article/")
    {
        return None;
    }
    url.set_fragment(None);
    if url.query().is_none() {
        url.query_pairs_mut().append_pair(
            "x-oss-process",
            "image/resize,w_640/quality,Q_60/format,jpg",
        );
    }
    Some(url.into())
}

fn public_article_id(row: &Value) -> Option<u64> {
    if row["resource_type"].as_u64() != Some(1)
        || row["status"].as_u64() != Some(0)
        || row["public_status"].as_u64() != Some(0)
        || row["is_private"].as_bool() != Some(false)
    {
        return None;
    }
    row["id"].as_u64().filter(|id| *id > 0)
}

fn public_item(row: &Value) -> Option<(u64, FeedItem)> {
    let id = public_article_id(row)?;
    let title = compact_text(row["title"].as_str()?, 400)?;
    let item = FeedItem {
        title,
        url: format!("{WORK_ORIGIN}/a{id}"),
        published_timestamp: row["publish_time"]
            .as_u64()
            .filter(|n| (1..=253_402_300_799).contains(n)),
        cover_url: row["cover"].as_str().and_then(cover),
        description: row["content"]
            .as_str()
            .and_then(|content| compact_text(content, 500)),
        duration_seconds: row["duration"].as_u64().filter(|seconds| *seconds > 0),
        view_count: row["count"]["count_view"].as_u64(),
        ..FeedItem::default()
    };
    Some((id, item))
}

fn next_data(html: &[u8]) -> Option<Value> {
    let document = Document::from(String::from_utf8_lossy(html).as_ref());
    let script = document
        .select("script#__NEXT_DATA__[type='application/json']")
        .first();
    serde_json::from_str(&script.text()).ok()
}

fn editorial_articles(data: &Value) -> Option<&[Value]> {
    if data["page"] != "/recommend/editor" {
        return None;
    }
    Some(
        data.pointer(SECTION_PATH)?
            .as_array()?
            .iter()
            .find(|section| section["sectionCode"] == "editor_recommend")?
            .get("articles")?
            .as_array()?,
    )
}

fn works(html: &[u8]) -> Option<Vec<FeedItem>> {
    let data = next_data(html)?;
    let articles = editorial_articles(&data)?;
    let mut seen = HashSet::new();
    let items: Vec<_> = articles
        .iter()
        .filter_map(public_item)
        .filter(|(id, _)| seen.insert(*id))
        .take(100)
        .map(|(_, item)| item)
        .collect();
    (articles.is_empty() || !items.is_empty()).then_some(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn article(id: u64, title: &str) -> Value {
        json!({"id":id,"title":title,"resource_type":1,"status":0,"public_status":0,"is_private":false,
            "cover":"https://oss-xpc0.xpccdn.com/uploadfile/article/2026/01/01/cover.png",
            "web_url":"https://tracker.example/a1","publish_time":1_765_722_400,"duration":95,
            "count":{"count_view":4567},"content":" 合成说明\n第二行 "})
    }

    fn page(articles: Vec<Value>, route: &str) -> String {
        let state = json!({"page":route, "props":{"pageProps":{
            "bannerData":[{"article":article(99,"横幅")}],
            "editorRecommendData":{"section":[
                {"sectionCode":"ad_recommend","articles":[article(98,"广告")]},
                {"sectionCode":"editor_recommend","articles":articles},
            ]}
        }}});
        format!("<script id='__NEXT_DATA__' type='application/json'>{state}</script>")
    }

    #[test]
    fn only_the_editor_source_is_normalized() {
        let profile =
            Url::parse("https://xinpianchang.com/recommend/editor/?utm_source=share").unwrap();
        assert_eq!(editor_source(&profile).unwrap().as_str(), EDITOR_URL);
        for input in [
            "https://www.xinpianchang.com/recommend",
            "https://www.xinpianchang.com/a123",
            "https://example.com/recommend/editor",
            "https://www.xinpianchang.com:444/recommend/editor",
            "https://person@www.xinpianchang.com/recommend/editor",
        ] {
            assert!(editor_source(&Url::parse(input).unwrap()).is_none());
        }
    }

    #[test]
    fn player_work_url_only_accepts_official_numeric_articles() {
        let tracked = Url::parse("https://www.xinpianchang.com/a13883520?from=IndexPick").unwrap();
        assert_eq!(work_id(&tracked), Some(13883520));
        for input in [
            "https://www.xinpianchang.com/a0",
            "https://www.xinpianchang.com/a0123",
            "https://www.xinpianchang.com/a123/more",
            "https://www.xinpianchang.com:8443/a123",
            "https://user@www.xinpianchang.com/a123",
            "https://www.xinpianchang.com.example/a123",
            "http://www.xinpianchang.com/a123",
        ] {
            assert!(work_id(&Url::parse(input).unwrap()).is_none(), "{input}");
        }
    }

    #[test]
    fn only_matching_public_shareable_works_get_an_official_player_url() {
        let id = 13883520;
        let state = json!({"page":"/article/[article_id]","props":{"pageProps":{
            "type":"normal", "articleShareSwitch":{"switch":"on"},
            "detail":{"id":id,"is_private":false,"status":0,"public_status":0,
                "media_id":"2MmN45qzZoO4X0zL","video":{"type":1,"status":3,"vid":"2MmN45qzZoO4X0zL"}}
        }}});
        assert_eq!(
            public_player(&state, id).as_deref(),
            Some("https://player.xinpianchang.com/?aid=13883520&mid=2MmN45qzZoO4X0zL")
        );
        assert!(public_player(&state, id + 1).is_none());
        for (pointer, value) in [
            ("/props/pageProps/detail/is_private", json!(true)),
            ("/props/pageProps/detail/public_status", json!(1)),
            ("/props/pageProps/articleShareSwitch/switch", json!("off")),
            ("/props/pageProps/detail/video/type", json!(2)),
            ("/props/pageProps/detail/media_id", json!("id&mid=other")),
            ("/props/pageProps/detail/video/vid", json!("unrelated")),
        ] {
            let mut changed = state.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(public_player(&changed, id).is_none(), "{pointer}");
        }
    }

    #[test]
    fn editorial_player_uses_only_the_matching_public_featured_row() {
        let mut published = article(13883520, "公开作品");
        published["media_id"] = json!("2MmN45qzZoO4X0zL");
        let mut private = article(11, "私有");
        private["media_id"] = json!("PrivateVideo");
        private["is_private"] = json!(true);
        let page = page(vec![published, private], "/recommend/editor");
        let data = next_data(page.as_bytes()).unwrap();
        assert_eq!(
            editorial_player(&data, 13883520).as_deref(),
            Some("https://player.xinpianchang.com/?aid=13883520&mid=2MmN45qzZoO4X0zL")
        );
        assert!(editorial_player(&data, 11).is_none());
        assert!(editorial_player(&data, 99).is_none());
    }

    #[test]
    fn reads_only_ordered_public_editor_picks_with_bounded_media_urls() {
        let mut private = article(12, "私有");
        private["is_private"] = json!(true);
        let mut other_cover = article(2, "公开作品");
        other_cover["cover"] = json!("https://assets.example/uploadfile/article/cover.png");
        let sample = page(
            vec![
                article(8, "  示例 & 作品 "),
                private,
                article(8, "重复"),
                other_cover,
            ],
            "/recommend/editor",
        );
        let rows = works(sample.as_bytes()).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.url.as_str()).collect::<Vec<_>>(),
            [
                "https://www.xinpianchang.com/a8",
                "https://www.xinpianchang.com/a2",
            ]
        );
        let first = &rows[0];
        assert_eq!(first.title, "示例 & 作品");
        assert_eq!(first.published_timestamp, Some(1_765_722_400));
        assert_eq!(first.duration_seconds, Some(95));
        assert_eq!(first.view_count, Some(4567));
        assert_eq!(first.description.as_deref(), Some("合成说明 第二行"));
        let image = Url::parse(first.cover_url.as_ref().unwrap()).unwrap();
        assert_eq!(image.domain(), Some("oss-xpc0.xpccdn.com"));
        assert_eq!(
            image.query_pairs().next().unwrap().1,
            "image/resize,w_640/quality,Q_60/format,jpg"
        );
        assert!(rows[1].cover_url.is_none());
        assert!(works(page(vec![], "/recommend/home").as_bytes()).is_none());
    }
}
