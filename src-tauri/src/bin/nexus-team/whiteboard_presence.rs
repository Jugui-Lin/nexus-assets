use super::{
    db_error, error, whiteboard::require_project, with_member, ApiError, ApiResult, Store,
};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Extension, Json, Router,
};
use nexus_core::whiteboard::{
    WhiteboardCursor, WhiteboardPresenceMember, WhiteboardPresenceRequest,
    WhiteboardPresenceSnapshot,
};
use rusqlite::Connection;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

const TTL: Duration = Duration::from_secs(5);
const MAX_SESSIONS: usize = 512;
const MAX_MEMBER_SESSIONS: usize = 16;
const MAX_COORDINATE: f64 = 1_000_000.0;

type SessionKey = (String, Uuid);
type Peers = HashMap<String, Option<WhiteboardCursor>>;

struct Session {
    project_id: String,
    heartbeat: Instant,
    cursor: Option<WhiteboardCursor>,
}

#[derive(Clone, Default)]
struct Presence(Arc<Mutex<HashMap<SessionKey, Session>>>);

impl Presence {
    fn update(
        &self,
        member_id: String,
        session_id: Uuid,
        request: WhiteboardPresenceRequest,
        now: Instant,
    ) -> Result<Peers, ApiError> {
        let mut sessions = self.0.lock().map_err(|_| unavailable())?;
        sessions.retain(|_, session| now.saturating_duration_since(session.heartbeat) < TTL);

        let key = (member_id, session_id);
        if !request.active {
            // A delayed leave from the previous project must preserve the current project.
            if sessions
                .get(&key)
                .is_some_and(|session| session.project_id == request.project_id)
            {
                sessions.remove(&key);
            }
            return Ok(Peers::new());
        }

        if !sessions.contains_key(&key) {
            let own = sessions.iter().filter(|((member, _), _)| member == &key.0);
            let oldest = if own.clone().count() >= MAX_MEMBER_SESSIONS {
                own.min_by_key(|(_, session)| session.heartbeat)
                    .map(|(key, _)| key.clone())
            } else {
                None
            };
            if let Some(oldest) = oldest {
                sessions.remove(&oldest);
            } else if sessions.len() >= MAX_SESSIONS {
                return Err(unavailable());
            }
        }

        let project_id = request.project_id;
        let mut peers: HashMap<&String, &Session> = HashMap::new();
        for ((member, _), session) in sessions.iter() {
            if member == &key.0 || session.project_id != project_id {
                continue;
            }
            let latest = peers.entry(member).or_insert(session);
            if session.heartbeat > latest.heartbeat {
                *latest = session;
            }
        }
        let result = peers
            .into_iter()
            .map(|(id, session)| (id.clone(), session.cursor))
            .collect();
        sessions.insert(
            key,
            Session {
                project_id,
                heartbeat: now,
                cursor: request.cursor,
            },
        );
        Ok(result)
    }
}

fn unavailable() -> ApiError {
    error(StatusCode::SERVICE_UNAVAILABLE, "白板在线成员暂时不可用")
}

fn validate_request(input: &WhiteboardPresenceRequest) -> Result<Uuid, ApiError> {
    if input.cursor.is_some_and(|cursor| {
        [cursor.x, cursor.y]
            .into_iter()
            .any(|value| !(-MAX_COORDINATE..=MAX_COORDINATE).contains(&value))
    }) {
        return Err(error(StatusCode::BAD_REQUEST, "白板光标坐标无效"));
    }
    Uuid::parse_str(&input.session_id)
        .ok()
        .filter(|id| !id.is_nil() && input.session_id.len() == 36)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "白板会话编号无效"))
}

fn read_peers(conn: &Connection, peers: Peers) -> Result<Vec<WhiteboardPresenceMember>, ApiError> {
    if peers.is_empty() {
        return Ok(Vec::new());
    }
    let mut profiles = conn
        .prepare_cached(
            "SELECT members.id, members.name, member_avatars.revision
         FROM json_each(?1) AS online JOIN members ON members.id=online.value
         LEFT JOIN member_avatars ON member_avatars.member=members.id WHERE members.enabled=1",
        )
        .map_err(db_error)?;
    let ids = json!(peers.keys().collect::<Vec<_>>()).to_string();
    let mut members: Vec<WhiteboardPresenceMember> = profiles
        .query_map([ids], |row| {
            let member_id = row.get::<_, String>(0)?;
            Ok(WhiteboardPresenceMember {
                cursor: peers.get(&member_id).copied().flatten(),
                member_id,
                name: row.get(1)?,
                avatar_revision: row.get(2)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<_, _>>()
        .map_err(db_error)?;
    members.sort_unstable_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.member_id.cmp(&b.member_id))
    });
    Ok(members)
}

pub(super) fn routes() -> Router<Store> {
    Router::new().route(
        "/v1/whiteboard-presence",
        post(heartbeat)
            .layer::<_, std::convert::Infallible>(DefaultBodyLimit::max(2 * 1024))
            .layer(Extension(Presence::default())),
    )
}

async fn heartbeat(
    State(store): State<Store>,
    Extension(presence): Extension<Presence>,
    headers: HeaderMap,
    input: Result<Json<WhiteboardPresenceRequest>, JsonRejection>,
) -> ApiResult<WhiteboardPresenceSnapshot> {
    let Json(input) = input.map_err(|failure| error(failure.status(), "白板在线状态请求无效"))?;
    with_member(store, headers, move |conn, member| {
        let session_id = validate_request(&input)?;
        require_project(conn, &input.project_id)?;
        let peers = presence.update(member.id, session_id, input, Instant::now())?;
        Ok(WhiteboardPresenceSnapshot {
            members: read_peers(conn, peers)?,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(project: &str, session: Uuid, active: bool, x: f64) -> WhiteboardPresenceRequest {
        WhiteboardPresenceRequest {
            project_id: project.into(),
            session_id: session.to_string(),
            active,
            cursor: active.then_some(WhiteboardCursor { x, y: -x }),
        }
    }

    #[test]
    fn peers_are_project_scoped_deduplicated_and_removed_on_leave_or_expiry() {
        let presence = Presence::default();
        let start = Instant::now();
        let alice = Uuid::from_u128(1);
        let bob = Uuid::from_u128(2);
        let second_bob = Uuid::from_u128(3);
        let send = |member: &str, session, project, active, x, milliseconds| {
            presence
                .update(
                    member.into(),
                    session,
                    request(project, session, active, x),
                    start + Duration::from_millis(milliseconds),
                )
                .unwrap()
        };

        assert!(send("alice", alice, "default", true, 1.0, 0).is_empty());
        send("bob", bob, "default", true, 2.0, 1);
        send("bob", second_bob, "default", true, 3.0, 2);
        send("charlie", bob, "another", true, 4.0, 3);
        assert_eq!(
            send("alice", alice, "default", true, 1.0, 4),
            HashMap::from([("bob".into(), Some(WhiteboardCursor { x: 3.0, y: -3.0 }))])
        );

        send("bob", second_bob, "another", true, 5.0, 5);
        send("bob", second_bob, "default", false, 0.0, 6);
        assert_eq!(
            send("charlie", bob, "another", true, 4.0, 7),
            HashMap::from([("bob".into(), Some(WhiteboardCursor { x: 5.0, y: -5.0 }))])
        );
        assert!(send("bob", bob, "default", false, 0.0, 8).is_empty());
        assert!(send("alice", alice, "default", true, 1.0, 9).is_empty());
        assert!(send("charlie", bob, "another", true, 4.0, 5005).is_empty());
    }

    #[test]
    fn session_caps_preserve_capacity_for_other_members() {
        let presence = Presence::default();
        let start = Instant::now();
        for index in 1..=(MAX_MEMBER_SESSIONS + 1) {
            let session = Uuid::from_u128(index as u128);
            let now = start + Duration::from_millis(index as u64);
            presence
                .update(
                    "busy".into(),
                    session,
                    request("default", session, true, 0.0),
                    now,
                )
                .unwrap();
        }
        {
            let active = presence.0.lock().unwrap();
            assert_eq!(active.len(), MAX_MEMBER_SESSIONS);
            assert!(!active.contains_key(&("busy".into(), Uuid::from_u128(1))));
        }
        let now = start + Duration::from_millis(100);
        let session = Uuid::from_u128(1);
        for index in 0..(MAX_SESSIONS - MAX_MEMBER_SESSIONS) {
            presence
                .update(
                    format!("member-{index}"),
                    session,
                    request("default", session, true, 0.0),
                    now,
                )
                .unwrap();
        }
        let input = request("default", session, true, 0.0);
        assert_eq!(
            presence
                .update("other".into(), session, input, now)
                .unwrap_err()
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let input = request("default", session, true, 0.0);
        assert!(presence
            .update("other".into(), session, input, now + TTL)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn boundary_coordinates_and_uuid_validation() {
        let session = Uuid::from_u128(1);
        assert_eq!(
            validate_request(&request("default", session, true, MAX_COORDINATE)).unwrap(),
            session
        );
        for x in [MAX_COORDINATE + 1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                validate_request(&request("default", session, true, x))
                    .unwrap_err()
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            validate_request(&request("default", Uuid::nil(), true, 0.0))
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
    }
}
