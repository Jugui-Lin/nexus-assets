use super::{
    asset_recycle::visible_asset_sql, db_error, error, with_member, ApiError, ApiResult, Store,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post},
    Json, Router,
};
use nexus_core::now;
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

const MAX_ASSETS: usize = 20;
const MAX_INBOX: usize = 64;
const POKE_COOLDOWN: u64 = 3;
const POKE_WINDOW: u64 = 60;
const MAX_POKES_PER_WINDOW: usize = 12;

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS asset_messages (
            id TEXT PRIMARY KEY,
            sender TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            recipient TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            created INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS asset_message_recipient
            ON asset_messages(recipient,created,id);
        CREATE TABLE IF NOT EXISTS asset_message_items (
            message TEXT NOT NULL REFERENCES asset_messages(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            PRIMARY KEY(message,position)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS member_pokes (
            id TEXT PRIMARY KEY,
            sender TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            recipient TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            created INTEGER NOT NULL,
            dismissed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS member_poke_recipient
            ON member_pokes(recipient,dismissed,created,id);
        CREATE INDEX IF NOT EXISTS member_poke_sender
            ON member_pokes(sender,created,recipient);
        CREATE INDEX IF NOT EXISTS member_poke_expired
            ON member_pokes(created) WHERE dismissed=1;",
    )
}

pub(super) fn routes() -> Router<Store> {
    Router::new()
        .route(
            "/v1/asset-messages",
            get(inbox).post(send).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/v1/asset-messages/{id}", delete(remove))
        .route(
            "/v1/member-pokes",
            post(poke).layer(DefaultBodyLimit::max(1024)),
        )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendRequest {
    recipient_id: String,
    asset_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PokeRequest {
    recipient_id: String,
}

#[derive(Serialize)]
struct Accepted {
    accepted: bool,
}

#[derive(Serialize)]
struct Removed {
    removed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    id: String,
    sender_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    asset_ids: Vec<String>,
    created: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Inbox {
    messages: Vec<Message>,
    pokes_available: bool,
}

fn canonical_id(value: &str) -> Result<String, ApiError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "团队成员或资产编号无效"))
}

fn check_recipient(conn: &Connection, recipient: &str) -> Result<(), ApiError> {
    let enabled = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM members WHERE id=?1 AND enabled=1)",
            [recipient],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_error)?;
    if !enabled {
        return Err(error(StatusCode::NOT_FOUND, "团队成员不可用"));
    }
    Ok(())
}

async fn send(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(request): Json<SendRequest>,
) -> ApiResult<Accepted> {
    with_member(store, headers, move |conn, member| {
        let recipient = canonical_id(&request.recipient_id)?;
        if recipient == member.id {
            return Err(error(StatusCode::BAD_REQUEST, "请选择其他团队成员"));
        }
        if request.asset_ids.is_empty() || request.asset_ids.len() > MAX_ASSETS {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "请一次发送 1 至 20 项团队资产",
            ));
        }
        let mut ids = Vec::with_capacity(request.asset_ids.len());
        let mut seen = HashSet::new();
        for value in request.asset_ids {
            let id = canonical_id(&value)?;
            if seen.insert(id.clone()) {
                ids.push(id);
            }
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        check_recipient(&tx, &recipient)?;
        let visible_asset = visible_asset_sql();
        let asset_exists =
            format!("SELECT EXISTS (SELECT 1 FROM assets a WHERE a.id=?1 AND {visible_asset})");
        {
            let mut visible = tx.prepare(&asset_exists).map_err(db_error)?;
            for id in &ids {
                if !visible
                    .query_row([id], |row| row.get::<_, bool>(0))
                    .map_err(db_error)?
                {
                    return Err(error(
                        StatusCode::NOT_FOUND,
                        "有资产已移除或无法在团队库中查看",
                    ));
                }
            }
        }
        tx.execute(
            &format!(
                "DELETE FROM asset_messages WHERE recipient=?1 AND NOT EXISTS (
                    SELECT 1 FROM asset_message_items i JOIN assets a ON a.id=i.asset
                    WHERE i.message=asset_messages.id AND {visible_asset}
                )"
            ),
            [&recipient],
        )
        .map_err(db_error)?;
        let pending = tx
            .query_row(
                "SELECT count(*) FROM asset_messages WHERE recipient=?1",
                [&recipient],
                |row| row.get::<_, usize>(0),
            )
            .map_err(db_error)?;
        if pending >= MAX_INBOX {
            return Err(error(StatusCode::CONFLICT, "该成员的待收资产消息已满"));
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO asset_messages(id,sender,recipient,created) VALUES(?1,?2,?3,?4)",
            params![id, member.id, recipient, now()],
        )
        .map_err(db_error)?;
        {
            let mut insert = tx
                .prepare("INSERT INTO asset_message_items VALUES(?1,?2,?3)")
                .map_err(db_error)?;
            for (position, asset_id) in ids.iter().enumerate() {
                insert
                    .execute(params![id, position, asset_id])
                    .map_err(db_error)?;
            }
        }
        tx.commit().map_err(db_error)?;
        Ok(Accepted { accepted: true })
    })
    .await
}

async fn poke(
    State(store): State<Store>,
    headers: HeaderMap,
    Json(request): Json<PokeRequest>,
) -> ApiResult<Accepted> {
    with_member(store, headers, move |conn, member| {
        let recipient = canonical_id(&request.recipient_id)?;
        if recipient == member.id {
            return Err(error(StatusCode::BAD_REQUEST, "请选择其他团队成员"));
        }
        let time = now();
        let window_start = time.saturating_sub(POKE_WINDOW);
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        check_recipient(&tx, &recipient)?;
        // Short-lived dismissed rows also count toward the cooldown after a recipient clears the notice.
        tx.execute(
            "DELETE FROM member_pokes WHERE dismissed=1 AND created<?1",
            [window_start],
        )
        .map_err(db_error)?;
        let repeated = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM member_pokes WHERE sender=?1 AND created>?2 AND recipient=?3)",
            params![member.id, time.saturating_sub(POKE_COOLDOWN), recipient],
            |row| row.get::<_, bool>(0),
        ).map_err(db_error)?;
        if repeated {
            tx.commit().map_err(db_error)?;
            return Ok(Accepted { accepted: true });
        }
        let recent = tx.query_row(
            "SELECT count(*) FROM member_pokes WHERE sender=?1 AND created>=?2",
            params![member.id, window_start],
            |row| row.get::<_, usize>(0),
        ).map_err(db_error)?;
        if recent >= MAX_POKES_PER_WINDOW {
            return Err(error(StatusCode::TOO_MANY_REQUESTS, "拍一拍过于频繁，请稍后再试"));
        }
        let pending = tx.query_row(
            "SELECT count(*) FROM member_pokes WHERE recipient=?1 AND dismissed=0",
            [&recipient],
            |row| row.get::<_, usize>(0),
        ).map_err(db_error)?;
        if pending >= MAX_INBOX {
            return Err(error(StatusCode::CONFLICT, "该成员的待收拍一拍已满"));
        }
        tx.execute(
            "INSERT INTO member_pokes(id,sender,recipient,created) VALUES(?1,?2,?3,?4)",
            params![Uuid::new_v4().to_string(), member.id, recipient, time],
        ).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(Accepted { accepted: true })
    }).await
}

async fn inbox(State(store): State<Store>, headers: HeaderMap) -> ApiResult<Inbox> {
    with_member(store, headers, move |conn, member| {
        let visible_asset = visible_asset_sql();
        let mut statement = conn
            .prepare(&format!(
                "SELECT m.id,s.name,i.asset,m.created FROM asset_messages m
            JOIN members s ON s.id=m.sender
            JOIN asset_message_items i ON i.message=m.id
            JOIN assets a ON a.id=i.asset
            WHERE m.recipient=?1 AND {visible_asset}
            ORDER BY m.created ASC,m.rowid ASC,i.position ASC"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map([&member.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            })
            .map_err(db_error)?;
        let mut messages: Vec<Message> = Vec::new();
        for row in rows {
            let (id, sender_name, asset_id, created) = row.map_err(db_error)?;
            if let Some(message) = messages.last_mut().filter(|message| message.id == id) {
                message.asset_ids.push(asset_id);
            } else {
                messages.push(Message {
                    id,
                    sender_name,
                    sender_id: None,
                    kind: None,
                    asset_ids: vec![asset_id],
                    created,
                });
            }
        }
        let mut pokes = conn.prepare(
            "SELECT p.id,s.id,s.name,p.created FROM member_pokes p JOIN members s ON s.id=p.sender
             WHERE p.recipient=?1 AND p.dismissed=0 ORDER BY p.created,p.rowid",
        ).map_err(db_error)?;
        let rows = pokes
            .query_map([&member.id], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    sender_id: Some(row.get(1)?),
                    sender_name: row.get(2)?,
                    created: row.get(3)?,
                    kind: Some("poke"),
                    asset_ids: Vec::new(),
                })
            })
            .map_err(db_error)?;
        for row in rows {
            messages.push(row.map_err(db_error)?);
        }
        messages.sort_by_key(|message| message.created);
        Ok(Inbox {
            messages,
            pokes_available: true,
        })
    })
    .await
}

async fn remove(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Removed> {
    with_member(store, headers, move |conn, member| {
        let id = canonical_id(&id)?;
        let removed = conn
            .execute(
                "DELETE FROM asset_messages WHERE id=?1 AND recipient=?2",
                params![id, member.id],
            )
            .map_err(db_error)?
            > 0;
        let dismissed = conn
            .execute(
                "UPDATE member_pokes SET dismissed=1 WHERE id=?1 AND recipient=?2 AND dismissed=0",
                params![id, member.id],
            )
            .map_err(db_error)?
            > 0;
        Ok(Removed {
            removed: removed || dismissed,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header;
    use std::sync::{Arc, Mutex};

    #[test]
    fn messages_are_recipient_scoped_and_include_only_visible_team_ids() {
        let fixture = tempfile::tempdir().unwrap();
        let conn = super::super::open_store(fixture.path()).unwrap();
        let (_, sender_token) = super::super::create_member(&conn, "共同作者", "member").unwrap();
        let (recipient, receiver_token) =
            super::super::create_member(&conn, "收件者", "member").unwrap();
        let (_, third_token) = super::super::create_member(&conn, "旁观者", "admin").unwrap();
        conn.execute("INSERT INTO libraries VALUES('lib','Fixture')", [])
            .unwrap();
        let visible_id = Uuid::new_v4().to_string();
        let hidden_id = Uuid::new_v4().to_string();
        for (id, path) in [
            (&visible_id, "可见/效果图.png"),
            (&hidden_id, "隐藏/子目录/效果图.png"),
        ] {
            conn.execute(
                "INSERT INTO assets VALUES(?1,'lib',?2,10,1,'{}',1)",
                params![id, path],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO hidden_folders VALUES('lib','隐藏')", [])
            .unwrap();
        let store = Store(Arc::new(Mutex::new(conn)));
        let auth = |token: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
            headers
        };
        let request = |ids: Vec<String>| {
            Json(SendRequest {
                recipient_id: recipient.clone(),
                asset_ids: ids,
            })
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let rejected = send(
                State(store.clone()),
                auth(&sender_token),
                request(vec![visible_id.clone(), hidden_id]),
            )
            .await;
            assert!(matches!(rejected, Err((StatusCode::NOT_FOUND, _))));
            assert!(inbox(State(store.clone()), auth(&receiver_token))
                .await
                .unwrap()
                .0
                .messages
                .is_empty());
            assert!(
                send(
                    State(store.clone()),
                    auth(&sender_token),
                    request(vec![visible_id.clone(), visible_id.clone()])
                )
                .await
                .unwrap()
                .0
                .accepted
            );
            let received = inbox(State(store.clone()), auth(&receiver_token))
                .await
                .unwrap()
                .0;
            let message = &received.messages[0];
            assert_eq!(message.sender_name, "共同作者");
            assert_eq!(message.asset_ids, vec![visible_id]);
            let id = message.id.clone();
            assert!(inbox(State(store.clone()), auth(&third_token))
                .await
                .unwrap()
                .0
                .messages
                .is_empty());
            assert!(
                !remove(State(store.clone()), auth(&third_token), Path(id.clone()))
                    .await
                    .unwrap()
                    .0
                    .removed
            );
            assert!(
                remove(State(store.clone()), auth(&receiver_token), Path(id))
                    .await
                    .unwrap()
                    .0
                    .removed
            );
            assert!(inbox(State(store), auth(&receiver_token))
                .await
                .unwrap()
                .0
                .messages
                .is_empty());
        });
    }

    #[test]
    fn pokes_are_recipient_scoped_deduplicated_and_rate_limited() {
        let fixture = tempfile::tempdir().unwrap();
        let conn = super::super::open_store(fixture.path()).unwrap();
        let (sender, sender_token) =
            super::super::create_member(&conn, "挥手者", "member").unwrap();
        let (recipient, recipient_token) =
            super::super::create_member(&conn, "接收者", "member").unwrap();
        let (_, other_token) = super::super::create_member(&conn, "另一成员", "member").unwrap();
        let (disabled, _) = super::super::create_member(&conn, "已停用成员", "member").unwrap();
        conn.execute("UPDATE members SET enabled=0 WHERE id=?1", [&disabled])
            .unwrap();
        let store = Store(Arc::new(Mutex::new(conn)));
        let auth = |token: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
            headers
        };
        let poke_member = |token: &str, recipient_id: &str| {
            poke(
                State(store.clone()),
                auth(token),
                Json(PokeRequest {
                    recipient_id: recipient_id.into(),
                }),
            )
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let own_poke = poke_member(&sender_token, &sender).await;
            assert!(matches!(own_poke, Err((StatusCode::BAD_REQUEST, _))));
            let unavailable = poke_member(&sender_token, &disabled).await;
            assert!(matches!(unavailable, Err((StatusCode::NOT_FOUND, _))));
            assert!(poke_member(&sender_token, &recipient).await.unwrap().0.accepted);
            assert!(poke_member(&sender_token, &recipient).await.unwrap().0.accepted);
            let received = inbox(State(store.clone()), auth(&recipient_token)).await.unwrap().0;
            assert!(received.pokes_available);
            assert_eq!(received.messages.len(), 1);
            let message = &received.messages[0];
            let serialized = serde_json::to_value(message).unwrap();
            assert_eq!(serialized["kind"], "poke");
            assert_eq!(serialized["senderId"], sender.as_str());
            assert_eq!(serialized["senderName"], "挥手者");
            assert!(message.asset_ids.is_empty());
            assert!(inbox(State(store.clone()), auth(&other_token)).await.unwrap().0.messages.is_empty());
            assert!(!remove(State(store.clone()), auth(&other_token), Path(message.id.clone())).await.unwrap().0.removed);
            assert!(remove(State(store.clone()), auth(&recipient_token), Path(message.id.clone())).await.unwrap().0.removed);
            assert!(poke_member(&sender_token, &recipient).await.unwrap().0.accepted);
            assert!(inbox(State(store.clone()), auth(&recipient_token)).await.unwrap().0.messages.is_empty());
            {
                let conn = store.0.lock().unwrap();
                conn.execute("DELETE FROM member_pokes", []).unwrap();
                for _ in 0..MAX_POKES_PER_WINDOW {
                    conn.execute(
                        "INSERT INTO member_pokes(id,sender,recipient,created,dismissed) VALUES(?1,?2,?3,?4,1)",
                        params![Uuid::new_v4().to_string(), sender, recipient, now()-POKE_COOLDOWN-1],
                    ).unwrap();
                }
            }
            let throttled = poke_member(&sender_token, &recipient).await;
            assert!(matches!(throttled, Err((StatusCode::TOO_MANY_REQUESTS, _))));
            assert!(poke_member(&recipient_token, &sender).await.unwrap().0.accepted);
        });
    }
}
