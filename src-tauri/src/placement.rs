use crate::{api_error, auth, ApiResult, AppState};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use nexus_core::{compatible, now};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const TTL: u64 = 120;
const MAX_FILES: usize = 64;

#[derive(Clone, Serialize)]
pub(crate) struct PlacementFile {
    pub path: PathBuf,
    pub name: String,
    #[serde(skip_serializing)]
    pub ext: String,
}

#[derive(Clone, Default)]
pub(crate) struct PlacementTickets(Arc<Mutex<HashMap<Uuid, Ticket>>>);

struct Ticket {
    session: String,
    dcc: String,
    created: u64,
    files: Vec<PlacementFile>,
    marker: Option<PathBuf>,
    resolved: bool,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Some(marker) = &self.marker {
            let _ = fs::remove_file(marker);
        }
    }
}

impl PlacementTickets {
    pub fn create(
        &self,
        root: &Path,
        session: &str,
        dcc: &str,
        files: &[PlacementFile],
    ) -> Result<(Uuid, Option<PathBuf>), String> {
        if files.is_empty()
            || files.len() > MAX_FILES
            || !files
                .iter()
                .all(|file| compatible(dcc, &file.ext.to_ascii_lowercase()))
        {
            return Err("这批资产不支持交互放置".into());
        }
        let id = Uuid::new_v4();
        let marker = if dcc == "blender" {
            let directory = root.join("viewport-drags");
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let path = directory.join(format!("{id}.nexusdrop"));
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            Some(path)
        } else if dcc == "c4d" {
            None
        } else {
            return Err("宿主没有交互放置桥接".into());
        };
        let ticket = Ticket {
            session: session.to_owned(),
            dcc: dcc.to_owned(),
            created: now(),
            files: files.to_vec(),
            marker: marker.clone(),
            resolved: false,
        };
        let mut tickets = self.0.lock().map_err(|_| "放置服务暂不可用")?;
        Self::expire(&mut tickets);
        tickets.insert(id, ticket);
        Ok((id, marker))
    }

    pub fn revoke(&self, id: Uuid) {
        if let Ok(mut tickets) = self.0.lock() {
            tickets.remove(&id);
        }
    }

    fn expire(tickets: &mut HashMap<Uuid, Ticket>) {
        tickets.retain(|_, ticket| {
            now().saturating_sub(ticket.created) < if ticket.resolved { 3600 } else { TTL }
        });
    }

    pub fn reap(&self) {
        if let Ok(mut tickets) = self.0.lock() {
            Self::expire(&mut tickets);
        }
    }

    #[cfg(windows)]
    pub(crate) fn hold_if_idle(&self) -> Option<impl Sized + '_> {
        let mut tickets = self.0.try_lock().ok()?;
        Self::expire(&mut tickets);
        tickets.is_empty().then_some(tickets)
    }

    fn redeem(&self, id: Uuid, session: &str) -> Option<Vec<PlacementFile>> {
        let mut tickets = self.0.lock().ok()?;
        Self::expire(&mut tickets);
        let ticket = tickets.get_mut(&id)?;
        if ticket.session != session || ticket.dcc != "blender" || ticket.resolved {
            return None;
        }
        ticket.resolved = true;
        if let Some(marker) = ticket.marker.take() {
            let _ = fs::remove_file(marker);
        }
        Some(std::mem::take(&mut ticket.files))
    }

    pub fn claim(&self, session: &str) -> Option<Value> {
        let mut tickets = self.0.lock().ok()?;
        Self::expire(&mut tickets);
        let (id, ticket) = tickets
            .iter_mut()
            .filter(|(_, ticket)| {
                ticket.session == session && ticket.dcc == "c4d" && !ticket.resolved
            })
            .min_by_key(|(id, ticket)| (ticket.created, **id))?;
        ticket.resolved = true;
        Some(json!({"id":id, "mode":"place", "files":std::mem::take(&mut ticket.files)}))
    }

    fn finish(&self, id: Uuid, session: &str, status: &str) -> bool {
        if !matches!(status, "placed" | "cancelled" | "failed") {
            return false;
        }
        let Ok(mut tickets) = self.0.lock() else {
            return false;
        };
        if tickets
            .get(&id)
            .is_some_and(|ticket| ticket.session == session && ticket.resolved)
        {
            tickets.remove(&id);
            true
        } else {
            false
        }
    }
}

fn parameters(body: &Value) -> Option<(Uuid, &str)> {
    let ticket = Uuid::parse_str(body["ticketId"].as_str()?).ok()?;
    let session = body["sessionId"].as_str()?;
    Some((ticket, session))
}

pub(crate) async fn resolve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    auth(&state, &headers)?;
    let files = parameters(&body)
        .and_then(|(id, session)| state.placement.redeem(id, session))
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "放置请求已失效，请重新拖动"))?;
    Ok(Json(json!({"files":files})))
}

pub(crate) async fn finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    auth(&state, &headers)?;
    let status = body["status"].as_str().unwrap_or("");
    let completed =
        parameters(&body).is_some_and(|(id, session)| state.placement.finish(id, session, status));
    Ok(Json(json!({"ok":completed})))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(ext: &str) -> PlacementFile {
        PlacementFile {
            path: PathBuf::from(format!("example.{ext}")),
            name: "示例".into(),
            ext: ext.into(),
        }
    }

    #[test]
    fn marker_is_local_opaque_and_can_only_be_redeemed_by_its_target_once() {
        let temp = tempfile::tempdir().unwrap();
        let tickets = PlacementTickets::default();
        let (id, marker) = tickets
            .create(temp.path(), "blender-pid", "blender", &[file("obj"), file("MAX")])
            .unwrap();
        let marker = marker.unwrap();
        assert!(marker.is_file());
        assert!(fs::read(&marker).unwrap().is_empty());
        assert!(tickets.redeem(id, "another-pid").is_none());
        let files = tickets.redeem(id, "blender-pid").unwrap();
        assert_eq!(files[0].name, "示例");
        assert_eq!(files[1].ext, "MAX");
        assert!(!marker.exists());
        assert!(tickets.redeem(id, "blender-pid").is_none());
        assert!(tickets.finish(id, "blender-pid", "cancelled"));
        assert!(!tickets.finish(id, "blender-pid", "placed"));
    }

    #[test]
    fn cinema_delivery_does_not_publish_a_file_and_is_session_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let tickets = PlacementTickets::default();
        let (id, marker) = tickets
            .create(temp.path(), "c4d-pid", "c4d", &[file("obj")])
            .unwrap();
        assert!(marker.is_none());
        assert!(tickets.claim("blender-pid").is_none());
        assert!(tickets.redeem(id, "c4d-pid").is_none());
        let claim = tickets.claim("c4d-pid").unwrap();
        assert_eq!(claim["mode"], "place");
        assert_eq!(claim["files"].as_array().unwrap().len(), 1);
        assert!(tickets.claim("c4d-pid").is_none());
        assert!(tickets.finish(id, "c4d-pid", "placed"));
        assert!(tickets
            .create(temp.path(), "c4d-pid", "c4d", &[file("blend")])
            .is_err());
    }
}
