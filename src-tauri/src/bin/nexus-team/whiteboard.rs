use super::{db_error, error, with_member, ApiError, ApiResult, Store};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use nexus_core::whiteboard::{
    valid_whiteboard_id, valid_whiteboard_image_id, whiteboard_image_mime, WhiteboardBatch,
    WhiteboardImage, WhiteboardImageReceipt, WhiteboardItem, WhiteboardKind, WhiteboardOperation,
    WhiteboardPatch, WhiteboardProject, WhiteboardProjectCreate, WhiteboardProjectRename,
    WhiteboardProjectsSnapshot, WhiteboardSnapshot, DEFAULT_WHITEBOARD_PROJECT,
    MAX_WHITEBOARD_BATCH_BYTES, MAX_WHITEBOARD_IMAGE_BASE64, MAX_WHITEBOARD_OPERATIONS,
};
use rusqlite::{params, types::Value, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_POSITION: f64 = 1_000_000.0;
const MAX_DIMENSION: f64 = 100_000.0;
const MAX_POINT_POSITION: f64 = 100_000.0;
const MAX_POINTS: usize = 1_024;
const MAX_TEXT_BYTES: usize = 8_192;
const MAX_ITEMS: i64 = 500;
const MAX_ITEM_DATA_BYTES: i64 = 2 * 1024 * 1024;
const RETAINED_BATCHES: i64 = 2_048;
const MAX_PROJECTS: i64 = 100;
const MAX_PROJECT_NAME: usize = 80;
const DEFAULT_PROJECT_NAME: &str = "默认项目";
static IMAGE_CHECKS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardQuery {
    extended: Option<u8>,
    asset_references: Option<u8>,
    groups: Option<u8>,
    connections: Option<u8>,
}

impl BoardQuery {
    fn supports_extended(self) -> bool {
        self.extended == Some(1)
    }

    fn supports_asset_references(self) -> bool {
        self.supports_extended() && self.asset_references == Some(1)
    }

    fn supports_groups(self) -> bool {
        self.supports_extended() && self.groups == Some(1)
    }

    fn supports_connections(self) -> bool {
        self.supports_extended() && self.connections == Some(1)
    }
}

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS whiteboard_state (
             singleton INTEGER PRIMARY KEY CHECK(singleton=1)
                 REFERENCES team(singleton) ON DELETE CASCADE,
             revision INTEGER NOT NULL CHECK(revision>=0)
         );
         CREATE TABLE IF NOT EXISTS whiteboard_items (
             insertion_order INTEGER PRIMARY KEY,
             id TEXT NOT NULL UNIQUE,
             board INTEGER NOT NULL DEFAULT 1 REFERENCES whiteboard_state(singleton) ON DELETE CASCADE,
             item_json TEXT
         );
         CREATE INDEX IF NOT EXISTS whiteboard_live_items
             ON whiteboard_items(insertion_order) WHERE item_json IS NOT NULL;
         CREATE TABLE IF NOT EXISTS whiteboard_batches (
             receipt_order INTEGER PRIMARY KEY,
             member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
             batch_id TEXT NOT NULL,
             digest BLOB NOT NULL,
             UNIQUE(member, batch_id)
         );
         CREATE TABLE IF NOT EXISTS whiteboard_projects (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
             team INTEGER NOT NULL DEFAULT 1 REFERENCES team(singleton) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS whiteboard_project_items (
             insertion_order INTEGER PRIMARY KEY,
             id TEXT NOT NULL,
             board TEXT NOT NULL REFERENCES whiteboard_projects(id) ON DELETE CASCADE,
             item_json TEXT,
             UNIQUE(board,id)
         );
         CREATE INDEX IF NOT EXISTS whiteboard_project_live_items
             ON whiteboard_project_items(board,insertion_order) WHERE item_json IS NOT NULL;
         CREATE TABLE IF NOT EXISTS whiteboard_project_batches (
             receipt_order INTEGER PRIMARY KEY,
             board TEXT NOT NULL REFERENCES whiteboard_projects(id) ON DELETE CASCADE,
             member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
             batch_id TEXT NOT NULL,
             digest BLOB NOT NULL,
             UNIQUE(board,member,batch_id)
         );
         CREATE INDEX IF NOT EXISTS whiteboard_project_batch_order
             ON whiteboard_project_batches(board,receipt_order);
         CREATE TABLE IF NOT EXISTS whiteboard_images (
             id TEXT PRIMARY KEY,
             team INTEGER NOT NULL DEFAULT 1 REFERENCES team(singleton) ON DELETE CASCADE,
             mime TEXT NOT NULL,
             data BLOB NOT NULL
         );",
    )
}

pub(super) fn routes() -> Router<Store> {
    Router::new()
        .route(
            "/v1/whiteboard",
            get(snapshot)
                .post(apply)
                .layer(DefaultBodyLimit::max(MAX_WHITEBOARD_BATCH_BYTES)),
        )
        .route(
            "/v1/whiteboard/{id}",
            get(project_snapshot)
                .post(apply_to_project)
                .layer(DefaultBodyLimit::max(MAX_WHITEBOARD_BATCH_BYTES)),
        )
        .route(
            "/v1/whiteboard-projects",
            get(projects)
                .post(create_project)
                .layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/v1/whiteboard-projects/{id}",
            patch(rename_project).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/v1/whiteboard-images/{id}",
            get(get_image)
                .put(put_image)
                .layer(DefaultBodyLimit::max(MAX_WHITEBOARD_IMAGE_BASE64 + 1024)),
        )
}

async fn snapshot(
    State(store): State<Store>,
    headers: HeaderMap,
    Query(query): Query<BoardQuery>,
) -> ApiResult<WhiteboardSnapshot> {
    read_board(store, headers, DEFAULT_WHITEBOARD_PROJECT.into(), query).await
}

async fn project_snapshot(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<BoardQuery>,
) -> ApiResult<WhiteboardSnapshot> {
    read_board(store, headers, id, query).await
}

async fn read_board(
    store: Store,
    headers: HeaderMap,
    id: String,
    query: BoardQuery,
) -> ApiResult<WhiteboardSnapshot> {
    with_member(store, headers, move |conn, _| {
        let board = Board::from_id(&id)?;
        let tx = conn.transaction().map_err(db_error)?;
        read_snapshot(&tx, board, query)
    })
    .await
}

async fn apply(
    State(store): State<Store>,
    headers: HeaderMap,
    Query(query): Query<BoardQuery>,
    body: Result<Json<WhiteboardBatch>, JsonRejection>,
) -> ApiResult<WhiteboardSnapshot> {
    apply_board(
        store,
        headers,
        DEFAULT_WHITEBOARD_PROJECT.into(),
        query,
        body,
    )
    .await
}

async fn apply_to_project(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<BoardQuery>,
    body: Result<Json<WhiteboardBatch>, JsonRejection>,
) -> ApiResult<WhiteboardSnapshot> {
    apply_board(store, headers, id, query, body).await
}

async fn apply_board(
    store: Store,
    headers: HeaderMap,
    id: String,
    query: BoardQuery,
    body: Result<Json<WhiteboardBatch>, JsonRejection>,
) -> ApiResult<WhiteboardSnapshot> {
    with_member(store, headers, move |conn, member| {
        let board = Board::from_id(&id)?;
        let Json(batch) = body.map_err(|rejection| match rejection.status() {
            StatusCode::PAYLOAD_TOO_LARGE => error(rejection.status(), "本次白板修改数据过大"),
            status => error(status, "白板修改数据格式无效"),
        })?;
        if batch.operations.len() > MAX_WHITEBOARD_OPERATIONS {
            return Err(invalid("白板一次最多保存 64 项修改"));
        }
        if let Some(id) = &batch.batch_id {
            validate_id(id)?;
        }

        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        board.prepare_write(&tx)?;
        // Keep the receipt in the same transaction as the changes so dropped responses can be retried.
        let receipt = if let Some(id) = batch.batch_id {
            let digest = Sha256::digest(
                serde_json::to_vec(&batch.operations)
                    .map_err(|_| invalid("白板修改数据格式无效"))?,
            );
            let saved = board.batch_digest(&tx, &member.id, &id)?;
            if let Some(saved) = saved {
                if saved.as_slice() == &digest[..] {
                    return read_snapshot(&tx, board, query);
                }
                return Err(error(StatusCode::CONFLICT, "白板批次编号已经用于其他修改"));
            }
            Some((id, digest))
        } else {
            None
        };

        let mut changed = false;
        for operation in batch.operations {
            validate_id(&operation.id)?;
            changed |= apply_operation(&tx, board, operation, query)?;
        }
        if changed {
            let (count, size): (i64, i64) = tx
                .query_row(
                    &format!(
                        "SELECT count(*), coalesce(sum(length(CAST(item_json AS BLOB))), 0)
                         FROM {} WHERE board=?1 AND item_json IS NOT NULL",
                        board.items_table()
                    ),
                    [board.key()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(db_error)?;
            if count > MAX_ITEMS || size > MAX_ITEM_DATA_BYTES {
                return Err(error(
                    StatusCode::CONFLICT,
                    "白板已达到容量上限，请移除部分内容后重试",
                ));
            }
            board.advance_revision(&tx)?;
        }
        if let Some((id, digest)) = receipt {
            board.remember_batch(&tx, &member.id, &id, &digest)?;
        }
        let snapshot = read_snapshot(&tx, board, query)?;
        tx.commit().map_err(db_error)?;
        Ok(snapshot)
    })
    .await
}

fn validate_image_id(id: &str) -> Result<(), ApiError> {
    if !valid_whiteboard_image_id(id) {
        return Err(invalid("白板图片编号无效"));
    }
    Ok(())
}

fn image_not_found() -> ApiError {
    error(StatusCode::NOT_FOUND, "白板图片不存在或尚未同步")
}

async fn get_image(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<WhiteboardImage> {
    let Json((mime, data)) = with_member(store, headers, move |conn, _| {
        validate_image_id(&id)?;
        conn.query_row(
            "SELECT mime,data FROM whiteboard_images WHERE id=?1",
            [&id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(image_not_found)
    })
    .await?;
    Ok(Json(WhiteboardImage {
        mime,
        base64: STANDARD.encode(data),
    }))
}

async fn put_image(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<WhiteboardImage>, JsonRejection>,
) -> ApiResult<WhiteboardImageReceipt> {
    let Json(()) = with_member(store.clone(), headers.clone(), |_, _| Ok(())).await?;
    validate_image_id(&id)?;
    let Json(image) = body.map_err(|failure| error(failure.status(), "白板图片数据无效"))?;
    if image.base64.len() > MAX_WHITEBOARD_IMAGE_BASE64 {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "白板图片须小于或等于 8 MB",
        ));
    }
    // Decode outside the database lock so large uploads do not block board edits.
    let permit = IMAGE_CHECKS
        .acquire()
        .await
        .map_err(|_| image_check_failed())?;
    let (id, mime, data) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let data = STANDARD
            .decode(&image.base64)
            .map_err(|_| invalid("白板图片数据无效"))?;
        let digest: String = Sha256::digest(&data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if digest != id {
            return Err(invalid("白板图片内容与编号不匹配"));
        }
        let mime = whiteboard_image_mime(&data)
            .filter(|mime| *mime == image.mime)
            .ok_or_else(|| invalid("请选择不超过 8 MB 的有效 PNG、JPEG、GIF 或 WebP 图片"))?;
        Ok((id, mime, data))
    })
    .await
    .map_err(|_| image_check_failed())??;
    with_member(store, headers, move |conn, _| {
        conn.execute(
            "INSERT INTO whiteboard_images(id,mime,data) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING",
            params![id, mime, data],
        )
        .map_err(db_error)?;
        Ok(WhiteboardImageReceipt { image_id: id })
    })
    .await
}

fn image_check_failed() -> ApiError {
    error(StatusCode::INTERNAL_SERVER_ERROR, "白板图片校验失败")
}

fn invalid(message: &str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

fn validate_id(id: &str) -> Result<(), ApiError> {
    if !valid_whiteboard_id(id) {
        return Err(invalid("白板编号无效"));
    }
    Ok(())
}

async fn projects(
    State(store): State<Store>,
    headers: HeaderMap,
) -> ApiResult<WhiteboardProjectsSnapshot> {
    with_member(store, headers, |conn, _| read_projects(conn)).await
}

async fn create_project(
    State(store): State<Store>,
    headers: HeaderMap,
    body: Result<Json<WhiteboardProjectCreate>, JsonRejection>,
) -> ApiResult<WhiteboardProjectsSnapshot> {
    with_member(store, headers, move |conn, _| {
        let Json(input) = body.map_err(|failure| error(failure.status(), "白板项目数据无效"))?;
        validate_id(&input.id)?;
        if input.id == DEFAULT_WHITEBOARD_PROJECT {
            return Err(invalid("此编号保留给默认项目"));
        }
        let name = project_name(&input.name)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        // Retrying a lost create response leaves the existing name and canvas intact.
        if !project_exists(&tx, &input.id)? {
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM whiteboard_projects WHERE id<>?1",
                    [DEFAULT_WHITEBOARD_PROJECT],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if count >= MAX_PROJECTS - 1 {
                return Err(error(StatusCode::CONFLICT, "白板项目已达 100 个"));
            }
            tx.execute(
                "INSERT INTO whiteboard_projects(id,name) VALUES(?1,?2)",
                params![input.id, name],
            )
            .map_err(db_error)?;
        }
        let snapshot = read_projects(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(snapshot)
    })
    .await
}

async fn rename_project(
    State(store): State<Store>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<WhiteboardProjectRename>, JsonRejection>,
) -> ApiResult<WhiteboardProjectsSnapshot> {
    with_member(store, headers, move |conn, _| {
        let Json(input) = body.map_err(|failure| error(failure.status(), "白板项目数据无效"))?;
        validate_id(&id)?;
        let name = project_name(&input.name)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if id == DEFAULT_WHITEBOARD_PROJECT {
            tx.execute(
                "INSERT INTO whiteboard_projects(id,name) VALUES(?1,?2)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                params![id, name],
            )
            .map_err(db_error)?;
        } else if tx
            .execute(
                "UPDATE whiteboard_projects SET name=?2 WHERE id=?1",
                params![id, name],
            )
            .map_err(db_error)?
            == 0
        {
            return Err(project_not_found());
        }
        let snapshot = read_projects(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(snapshot)
    })
    .await
}

fn project_name(name: &str) -> Result<&str, ApiError> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_PROJECT_NAME
        || name.chars().any(char::is_control)
    {
        return Err(invalid("白板项目名称须为 1 至 80 个字符"));
    }
    Ok(name)
}

fn project_exists(conn: &Connection, id: &str) -> Result<bool, ApiError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM whiteboard_projects WHERE id=?1)",
        [id],
        |row| row.get(0),
    )
    .map_err(db_error)
}

fn project_not_found() -> ApiError {
    error(StatusCode::NOT_FOUND, "找不到白板项目")
}

fn read_projects(conn: &Connection) -> Result<WhiteboardProjectsSnapshot, ApiError> {
    let mut query = conn
        .prepare("SELECT id,name FROM whiteboard_projects ORDER BY id=?1 DESC, rowid")
        .map_err(db_error)?;
    let mut projects: Vec<WhiteboardProject> = query
        .query_map([DEFAULT_WHITEBOARD_PROJECT], |row| {
            Ok(WhiteboardProject {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<_, _>>()
        .map_err(db_error)?;
    if projects
        .first()
        .is_none_or(|project| project.id != DEFAULT_WHITEBOARD_PROJECT)
    {
        projects.insert(
            0,
            WhiteboardProject {
                id: DEFAULT_WHITEBOARD_PROJECT.into(),
                name: DEFAULT_PROJECT_NAME.into(),
            },
        );
    }
    Ok(WhiteboardProjectsSnapshot { projects })
}

#[derive(Clone, Copy)]
enum Board<'a> {
    Default,
    Project(&'a str),
}

impl<'a> Board<'a> {
    fn from_id(id: &'a str) -> Result<Self, ApiError> {
        validate_id(id)?;
        Ok(if id == DEFAULT_WHITEBOARD_PROJECT {
            Self::Default
        } else {
            Self::Project(id)
        })
    }

    // Preserve the original board tables and their receipts for legacy clients.
    fn items_table(self) -> &'static str {
        match self {
            Self::Default => "whiteboard_items",
            Self::Project(_) => "whiteboard_project_items",
        }
    }

    fn key(self) -> Value {
        match self {
            Self::Default => Value::Integer(1),
            Self::Project(id) => Value::Text(id.into()),
        }
    }

    fn prepare_write(self, conn: &Connection) -> Result<(), ApiError> {
        match self {
            Self::Default => {
                conn.execute("INSERT OR IGNORE INTO whiteboard_state VALUES(1, 0)", [])
                    .map_err(db_error)?;
            }
            Self::Project(id) if !project_exists(conn, id)? => return Err(project_not_found()),
            Self::Project(_) => {}
        }
        Ok(())
    }

    fn revision(self, conn: &Connection) -> Result<u64, ApiError> {
        match self {
            Self::Default => Ok(conn
                .query_row(
                    "SELECT revision FROM whiteboard_state WHERE singleton=1",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?
                .unwrap_or(0)),
            Self::Project(id) => conn
                .query_row(
                    "SELECT revision FROM whiteboard_projects WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?
                .ok_or_else(project_not_found),
        }
    }

    fn advance_revision(self, conn: &Connection) -> Result<(), ApiError> {
        match self {
            Self::Default => conn.execute("UPDATE whiteboard_state SET revision=revision+1", []),
            Self::Project(id) => conn.execute(
                "UPDATE whiteboard_projects SET revision=revision+1 WHERE id=?1",
                [id],
            ),
        }
        .map(|_| ())
        .map_err(db_error)
    }

    fn batch_digest(
        self,
        conn: &Connection,
        member: &str,
        batch: &str,
    ) -> Result<Option<Vec<u8>>, ApiError> {
        match self {
            Self::Default => conn.query_row(
                "SELECT digest FROM whiteboard_batches WHERE member=?1 AND batch_id=?2",
                params![member, batch],
                |row| row.get(0),
            ),
            Self::Project(id) => conn.query_row(
                "SELECT digest FROM whiteboard_project_batches WHERE board=?1 AND member=?2 AND batch_id=?3",
                params![id, member, batch],
                |row| row.get(0),
            ),
        }
        .optional()
        .map_err(db_error)
    }

    fn remember_batch(
        self,
        conn: &Connection,
        member: &str,
        batch: &str,
        digest: &[u8],
    ) -> Result<(), ApiError> {
        match self {
            Self::Default => {
                conn.execute(
                    "INSERT INTO whiteboard_batches(member,batch_id,digest) VALUES(?1,?2,?3)",
                    params![member, batch, digest],
                )
                .map_err(db_error)?;
                conn.execute(
                    "DELETE FROM whiteboard_batches WHERE receipt_order<=?1",
                    [conn.last_insert_rowid() - RETAINED_BATCHES],
                )
            }
            Self::Project(id) => {
                conn.execute(
                    "INSERT INTO whiteboard_project_batches(board,member,batch_id,digest) VALUES(?1,?2,?3,?4)",
                    params![id, member, batch, digest],
                )
                .map_err(db_error)?;
                conn.execute(
                    "DELETE FROM whiteboard_project_batches WHERE board=?1 AND receipt_order<=(
                       SELECT receipt_order FROM whiteboard_project_batches WHERE board=?1
                       ORDER BY receipt_order DESC LIMIT 1 OFFSET ?2
                     )",
                    params![id, RETAINED_BATCHES],
                )
            }
        }
        .map(|_| ())
        .map_err(db_error)
    }
}

fn validate_patch(patch: &WhiteboardPatch) -> Result<(), ApiError> {
    if [patch.x, patch.y]
        .into_iter()
        .flatten()
        .any(|value| !(-MAX_POSITION..=MAX_POSITION).contains(&value))
        || [patch.width, patch.height]
            .into_iter()
            .flatten()
            .any(|value| !(1.0..=MAX_DIMENSION).contains(&value))
    {
        return Err(invalid("白板元素位置或尺寸超出范围"));
    }
    if patch
        .text
        .as_ref()
        .is_some_and(|text| text.len() > MAX_TEXT_BYTES)
    {
        return Err(invalid("白板元素的文字过长"));
    }
    if patch.points.as_ref().is_some_and(|points| {
        points.len() > MAX_POINTS
            || points
                .iter()
                .flatten()
                .any(|value| !(-MAX_POINT_POSITION..=MAX_POINT_POSITION).contains(value))
    }) {
        return Err(invalid("白板画线的点数或坐标超出范围"));
    }
    if patch
        .group_id
        .as_ref()
        .is_some_and(|id| !id.is_empty() && !valid_whiteboard_id(id))
    {
        return Err(invalid("白板组合编号无效"));
    }
    if let Some(id) = &patch.image_id {
        validate_image_id(id)?;
    }
    if let Some(id) = &patch.asset_id {
        let valid_id = id.strip_prefix("team:").is_some_and(|uuid| {
            Uuid::parse_str(uuid).is_ok_and(|parsed| parsed.to_string() == uuid)
        });
        if !valid_id {
            return Err(invalid("白板团队资产编号无效"));
        }
        if patch.image_id.is_some() {
            return Err(invalid("白板图片只能选择一个来源"));
        }
    }
    if patch
        .image_transform
        .as_ref()
        .is_some_and(|transform| !transform.is_valid())
    {
        return Err(invalid("白板图片的旋转、裁剪或不透明度超出范围"));
    }
    Ok(())
}

fn apply_operation(
    conn: &Connection,
    board: Board<'_>,
    op: WhiteboardOperation,
    query: BoardQuery,
) -> Result<bool, ApiError> {
    let id = op.id;
    let table = board.items_table();
    let asset_references = query.supports_asset_references();
    let restore = op.restore == Some(true);
    if restore && !asset_references {
        return Err(invalid("请更新客户端后恢复已删除的白板元素"));
    }
    let patch = match (op.delete, op.patch, restore) {
        (None, Some(patch), _) => patch,
        (Some(true), None, false) => {
            // Retain the ID so a retried creation cannot bring the deleted item back.
            return conn
                .execute(
                    &format!(
                        "UPDATE {table} SET item_json=NULL WHERE board=?1 AND id=?2 AND item_json IS NOT NULL
                         AND (?3 OR json_extract(item_json, '$.assetId') IS NULL)"
                    ),
                    params![board.key(), id, asset_references],
                )
                .map(|count| count != 0)
                .map_err(db_error);
        }
        _ => return Err(invalid("白板修改必须选择更新或删除")),
    };
    validate_patch(&patch)?;
    if patch.asset_id.is_some() && !asset_references {
        return Err(invalid("请更新客户端后编辑白板资产引用"));
    }
    if patch.group_id.is_some() && !query.supports_groups() {
        return Err(invalid("请更新客户端后编辑白板组合"));
    }
    if let Some(connection) = &patch.connection {
        if !query.supports_connections() {
            return Err(invalid("请更新客户端后编辑白板连接线"));
        }
        if !valid_whiteboard_id(&connection.from.id)
            || !valid_whiteboard_id(&connection.to.id)
            || connection.from.id == connection.to.id
            || connection.from.id == id
            || connection.to.id == id
        {
            return Err(invalid("白板连接线端点无效"));
        }
    }
    let dimensions = (patch.kind, patch.x, patch.y, patch.width, patch.height);
    if restore && !matches!(dimensions, (Some(_), Some(_), Some(_), Some(_), Some(_))) {
        return Err(invalid("恢复白板元素需要提供完整的元素数据"));
    }
    let previous: Option<Option<String>> = conn
        .query_row(
            &format!("SELECT item_json FROM {table} WHERE board=?1 AND id=?2"),
            params![board.key(), id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let (item, previous_json) = match previous {
        None | Some(Some(_)) if restore => return Ok(false),
        Some(None) if !restore => return Ok(false),
        Some(Some(data)) => {
            let mut item = decode_item(&data)?;
            if item.asset_id.is_some() && !asset_references {
                return Ok(false);
            }
            item.kind = patch.kind.unwrap_or(item.kind);
            item.x = patch.x.unwrap_or(item.x);
            item.y = patch.y.unwrap_or(item.y);
            item.width = patch.width.unwrap_or(item.width);
            item.height = patch.height.unwrap_or(item.height);
            item.text = patch.text.unwrap_or(item.text);
            item.color = patch.color.unwrap_or(item.color);
            item.points = patch.points.unwrap_or(item.points);
            if let Some(group_id) = patch.group_id {
                item.group_id = (!group_id.is_empty()).then_some(group_id);
            }
            item.connection = patch.connection.or(item.connection);
            if patch.image_id.is_some() || patch.asset_id.is_some() {
                item.image_id = patch.image_id;
                item.asset_id = patch.asset_id;
            }
            item.image_transform = patch.image_transform.or(item.image_transform);
            (item, Some(data))
        }
        None | Some(None) => {
            let (Some(kind), Some(x), Some(y), Some(width), Some(height)) = dimensions else {
                // Remote edits can arrive after another member deleted the item.
                return Ok(false);
            };
            (
                WhiteboardItem {
                    id,
                    kind,
                    x,
                    y,
                    width,
                    height,
                    text: patch.text.unwrap_or_default(),
                    color: patch.color.unwrap_or_default(),
                    points: patch.points.unwrap_or_default(),
                    group_id: patch.group_id.filter(|id| !id.is_empty()),
                    connection: patch.connection,
                    image_id: patch.image_id,
                    asset_id: patch.asset_id,
                    image_transform: patch.image_transform,
                },
                None,
            )
        }
    };
    if !query.supports_extended() && item.kind.is_extended() {
        return Err(invalid("请更新客户端后编辑此白板元素"));
    }
    if item.kind != WhiteboardKind::Image && item.image_transform.is_some() {
        return Err(invalid("只有图片元素可以设置图片变换"));
    }
    if item.kind != WhiteboardKind::Arrow && item.connection.is_some() {
        return Err(invalid("只有白板箭头可以绑定端点"));
    }
    match item.kind {
        WhiteboardKind::Stroke if item.points.is_empty() => {
            return Err(invalid("白板画线必须提供绘制点"));
        }
        WhiteboardKind::Arrow if item.points.len() != 2 => {
            return Err(invalid("白板箭头必须提供起点与终点"));
        }
        WhiteboardKind::Stroke | WhiteboardKind::Arrow => {}
        _ if !item.points.is_empty() => return Err(invalid("此白板元素不支持绘制点")),
        _ => {}
    }
    match (item.kind, item.image_id.as_ref(), item.asset_id.as_ref()) {
        (WhiteboardKind::Image, Some(id), None) => {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM whiteboard_images WHERE id=?1)",
                    [id],
                    |row| row.get(0),
                )
                .map_err(db_error)?;
            if !exists {
                return Err(image_not_found());
            }
        }
        // An asset may be renamed, unlinked, or temporarily unavailable after saving its reference.
        (WhiteboardKind::Image, None, Some(_)) => {}
        (WhiteboardKind::Image, None, None) => return Err(invalid("白板图片缺少来源")),
        (WhiteboardKind::Image, Some(_), Some(_)) => {
            return Err(invalid("白板图片只能选择一个来源"));
        }
        (_, None, None) => {}
        _ => return Err(invalid("只有图片元素可以引用白板图片或团队资产")),
    }
    let json = serde_json::to_string(&item).map_err(|_| invalid("白板元素数据格式无效"))?;
    if previous_json.as_deref() == Some(&json) {
        return Ok(false);
    }
    conn.execute(
        &format!(
            "INSERT INTO {table}(board,id,item_json) VALUES(?1,?2,?3)
             ON CONFLICT DO UPDATE SET item_json=excluded.item_json"
        ),
        params![board.key(), item.id, json],
    )
    .map_err(db_error)?;
    Ok(true)
}

fn decode_item(data: &str) -> Result<WhiteboardItem, ApiError> {
    serde_json::from_str(data)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "白板元素数据无法读取"))
}

fn read_snapshot(
    conn: &Connection,
    board: Board<'_>,
    query: BoardQuery,
) -> Result<WhiteboardSnapshot, ApiError> {
    let revision = board.revision(conn)?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT item_json FROM {} WHERE board=?1 AND item_json IS NOT NULL ORDER BY insertion_order",
            board.items_table()
        ))
        .map_err(db_error)?;
    let rows = statement
        .query_map([board.key()], |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    let mut items: Vec<WhiteboardItem> = rows
        .map(|row| decode_item(&row.map_err(db_error)?))
        .collect::<Result<_, _>>()?;
    // Older clients cannot deserialize newly introduced item kinds.
    if !query.supports_extended() {
        items.retain(|item| !item.kind.is_extended());
    } else if !query.supports_asset_references() {
        items.retain(|item| item.asset_id.is_none());
    }
    let groups = query.supports_groups();
    let connections = query.supports_connections();
    for item in &mut items {
        if !groups {
            item.group_id = None;
        }
        if !connections {
            item.connection = None;
        }
    }
    Ok(WhiteboardSnapshot {
        revision,
        items,
        image_transforms: query.supports_extended().then_some(true),
        asset_references: query.supports_asset_references().then_some(true),
        restore_items: query.supports_asset_references().then_some(true),
        groups: groups.then_some(true),
        connections: connections.then_some(true),
    })
}
