use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::stream::try_unfold;
use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

const IDLE_LIFETIME: Duration = Duration::from_secs(20 * 60);
const MAX_OPEN_VIDEOS: usize = 24;
const THUMBNAIL_IDLE_LIFETIME: Duration = Duration::from_secs(30);
const MAX_THUMBNAIL_VIDEOS: usize = 4;
const CHUNK_BYTES: u64 = 256 * 1024;
// Chromium may ask for the entire rest of a movie for each new seek.
const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;
const WEBVIEW_ORIGINS: [&str; 2] = ["http://tauri.localhost", "https://tauri.localhost"];

struct Reader {
    file: File,
    offset: u64,
}

struct VideoFile {
    reader: Mutex<Reader>,
    length: u64,
    mime: &'static str,
}

impl VideoFile {
    fn read_at(&self, offset: u64, count: usize) -> io::Result<Vec<u8>> {
        let mut reader = self
            .reader
            .lock()
            .map_err(|_| io::Error::other("video reader unavailable"))?;
        if reader.offset != offset {
            reader.offset = reader.file.seek(SeekFrom::Start(offset))?;
        }
        let mut bytes = vec![0; count];
        if let Err(error) = reader.file.read_exact(&mut bytes) {
            // A short or failed read can change the operating system cursor.
            reader.offset = u64::MAX;
            return Err(error);
        }
        reader.offset += count as u64;
        Ok(bytes)
    }
}

struct Lease {
    video: Arc<VideoFile>,
    last_used: Instant,
    thumbnail: bool,
}

impl Lease {
    fn expired(&self) -> bool {
        let lifetime = if self.thumbnail {
            THUMBNAIL_IDLE_LIFETIME
        } else {
            IDLE_LIFETIME
        };
        self.last_used.elapsed() >= lifetime
    }
}

#[derive(Clone)]
pub(crate) struct VideoStreams {
    host: Arc<str>,
    entries: Arc<Mutex<HashMap<Uuid, Lease>>>,
}

impl VideoStreams {
    pub(crate) fn new(port: u16) -> Self {
        Self {
            host: format!("127.0.0.1:{port}").into(),
            entries: Default::default(),
        }
    }

    pub(crate) fn router(self) -> Router {
        Router::new()
            .route("/media/video/{id}", get(serve_video))
            .with_state(self)
    }

    pub(crate) fn issue(
        &self,
        file: File,
        length: u64,
        mime: &'static str,
        thumbnail: bool,
    ) -> Option<String> {
        let mut entries = self.entries.lock().ok()?;
        entries.retain(|_, lease| !lease.expired());
        let limit = if thumbnail {
            MAX_THUMBNAIL_VIDEOS
        } else {
            MAX_OPEN_VIDEOS
        };
        let same_use = entries
            .iter()
            .filter(|(_, lease)| lease.thumbnail == thumbnail);
        if same_use.clone().count() >= limit {
            let oldest = same_use
                .min_by_key(|(_, lease)| lease.last_used)
                .map(|(id, _)| *id)?;
            entries.remove(&oldest);
        }
        let id = Uuid::new_v4();
        entries.insert(
            id,
            Lease {
                video: Arc::new(VideoFile {
                    reader: Mutex::new(Reader { file, offset: 0 }),
                    length,
                    mime,
                }),
                last_used: Instant::now(),
                thumbnail,
            },
        );
        Some(format!("http://{}/media/video/{id}", self.host))
    }

    pub(crate) fn reap(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, lease| !lease.expired());
        }
    }

    fn open(&self, id: &Uuid) -> Option<Arc<VideoFile>> {
        let mut entries = self.entries.lock().ok()?;
        let lease = entries.get_mut(id)?;
        if lease.expired() {
            entries.remove(id);
            return None;
        }
        lease.last_used = Instant::now();
        Some(lease.video.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_streams_are_short_lived_and_do_not_evict_playback() {
        let streams = VideoStreams::new(47821);
        let fixture = tempfile::tempfile().unwrap();
        let issue = |thumbnail| {
            let url = streams
                .issue(fixture.try_clone().unwrap(), 0, "video/mp4", thumbnail)
                .unwrap();
            Uuid::parse_str(url.rsplit('/').next().unwrap()).unwrap()
        };
        let playback = issue(false);
        let oldest_thumbnail = issue(true);
        for _ in 0..MAX_OPEN_VIDEOS {
            issue(true);
        }
        let current_thumbnail = issue(true);
        assert!(streams.open(&oldest_thumbnail).is_none());
        assert!(streams.open(&current_thumbnail).is_some());
        let expired_at = Instant::now() - THUMBNAIL_IDLE_LIFETIME;
        {
            let mut entries = streams.entries.lock().unwrap();
            entries.get_mut(&current_thumbnail).unwrap().last_used = expired_at;
            entries.get_mut(&playback).unwrap().last_used = expired_at;
        }
        streams.reap();
        assert!(streams.open(&current_thumbnail).is_none());
        assert!(streams.open(&playback).is_some());
    }
}

fn webview_origin(headers: &HeaderMap, host: &str) -> Option<&'static str> {
    if headers.get(header::HOST)?.to_str().ok()? != host {
        return None;
    }
    if let Some(origin) = headers.get(header::ORIGIN) {
        return WEBVIEW_ORIGINS.into_iter().find(|value| origin == *value);
    }
    // Ordinary video elements make non-CORS requests and send a referrer.
    let referrer = headers.get(header::REFERER)?.to_str().ok()?;
    WEBVIEW_ORIGINS.into_iter().find(|value| {
        referrer
            .strip_prefix(value)
            .is_some_and(|location| location.starts_with('/'))
    })
}

fn single_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let number = |part: &str| {
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse::<u64>().ok())
            .flatten()
    };
    if length == 0 {
        return None;
    }
    if start.is_empty() {
        let count = number(end)?.min(length).min(MAX_RANGE_BYTES);
        return (count > 0).then_some((length - count, count));
    }
    let start = number(start)?;
    let end = if end.is_empty() {
        length - 1
    } else {
        number(end)?.min(length - 1)
    };
    (start <= end).then(|| (start, (end - start + 1).min(MAX_RANGE_BYTES)))
}

async fn serve_video(
    State(streams): State<VideoStreams>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let Some(origin) = webview_origin(&headers, &streams.host) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(video) = Uuid::parse_str(&id).ok().and_then(|id| streams.open(&id)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let length = video.length;
    let mut response = axum::http::Response::builder()
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Range",
        )
        .header(header::VARY, "Origin, Referer")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer");
    let mut ranges = headers.get_all(header::RANGE).iter();
    let (start, count) = if let Some(value) = ranges.next() {
        let requested = value
            .to_str()
            .ok()
            .and_then(|text| single_range(text, length));
        let Some((start, count)) = requested.filter(|_| ranges.next().is_none()) else {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                .body(Body::empty())
                .unwrap();
        };
        response = response.status(StatusCode::PARTIAL_CONTENT).header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{length}", start + count - 1),
        );
        (start, count)
    } else {
        (0, length)
    };
    let mime = video.mime;
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(try_unfold(
            (video, start, count),
            |(video, offset, remaining)| async move {
                if remaining == 0 {
                    return Ok::<_, io::Error>(None);
                }
                let count = remaining.min(CHUNK_BYTES);
                let source = video.clone();
                let data =
                    tokio::task::spawn_blocking(move || source.read_at(offset, count as usize))
                        .await
                        .map_err(io::Error::other)??;
                Ok(Some((data, (video, offset + count, remaining - count))))
            },
        ))
    };
    response
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, count)
        .body(body)
        .unwrap()
}
