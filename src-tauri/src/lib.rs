use rusqlite::{params, Connection, OptionalExtension, Statement};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use walkdir::WalkDir;

mod asset_recycle;
pub mod baidu_cloud;
mod c4d_preview;
mod max_preview;
mod collections;
pub mod browser_sites;
pub mod creative_subscriptions;
mod file_import;
mod ies_preview;
mod linear_preview;
mod png_preview;
#[cfg(all(windows, feature = "desktop"))]
mod jpeg_preview;
pub mod team;
pub mod team_organization;
pub mod thumbnail_cache;
pub mod whiteboard;

pub use asset_recycle::RecycledAsset;
pub use collections::AssetCollection;
pub use file_import::{FileFingerprint, FileImport, FileImportOutcome};
pub use linear_preview::read_exr_views;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn now_millis() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}
pub fn kind(ext: &str) -> Option<&'static str> {
    match ext {
        "obj" | "fbx" | "gltf" | "glb" | "abc" | "usd" | "usda" | "usdc" | "stl" | "ply"
        | "3dm" | "3ds" | "3mf" | "aof" | "ass" | "atl" | "atlo" | "bvh" | "cgeo" | "cuap"
        | "dae" => Some("model"),
        "blend" | "c4d" | "max" | "ma" | "mb" | "hip" | "hiplc" | "hipnc" => Some("scene"),
        "mat" | "mdl" | "mtl" | "mtlx" | "rmtl" | "sbs" | "sbsar" | "sbsprs" | "skm" | "vrmat"
        | "xsh" | "zip" => Some("material"),
        "png" | "jpg" | "jpeg" | "webp" | "tif" | "tiff" | "exr" | "hdr" | "tga" | "bmp"
        | "ies" | "psd" | "dds" | "ai" | "arw" | "eps" | "gif" | "hdri" | "renv" | "svg" => {
            Some("texture")
        }
        "aac" | "aiff" | "alac" | "flac" | "m4a" | "mp3" | "wav" | "wma" => Some("audio"),
        "gsm" | "ifc" | "pla" | "pln" | "rfa" | "rft" | "rte" | "rvt" | "val" => Some("bim"),
        "dwg" | "dxf" | "iges" | "igs" | "sat" | "step" | "stp" => Some("cad"),
        "csc" | "csr" | "dyn" | "gh" | "ghuser" | "mcr" | "mel" | "ms" | "mse" | "mzp" | "py"
        | "rb" | "rbs" => Some("script"),
        "ini" | "pdf" => Some("other"),
        _ if video_mime(ext).is_some() => Some("video"),
        _ => None,
    }
}
pub fn video_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "mp4" | "m4v" | "f4p" | "f4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        "3gp" => Some("video/3gpp"),
        "amv" => Some("video/x-amv"),
        "avi" => Some("video/x-msvideo"),
        "flv" => Some("video/x-flv"),
        "m2v" | "mp2" | "mpe" | "mpeg" | "mpg" => Some("video/mpeg"),
        "wmv" => Some("video/x-ms-wmv"),
        _ => None,
    }
}
pub fn compatible(dcc: &str, ext: &str) -> bool {
    let formats: &[&str] = match dcc {
        "blender" => &[
            "obj", "fbx", "gltf", "glb", "abc", "usd", "usda", "usdc", "stl", "ply", "blend", "max",
        ],
        "c4d" => &["obj", "fbx", "abc", "stl", "c4d"],
        "maya" => &["obj", "fbx", "abc", "ma", "mb"],
        "max" => &["obj", "fbx", "3ds", "max"],
        "houdini" => &[
            "obj", "fbx", "abc", "usd", "usda", "usdc", "hip", "hiplc", "hipnc",
        ],
        _ => &[],
    };
    formats.contains(&ext)
}

pub fn c4d_smart_compatible(ext: &str) -> bool {
    compatible("c4d", ext)
        || matches!(
            ext,
            "blend"
                | "max"
                | "zip"
                | "sbsar"
                | "png"
                | "jpg"
                | "jpeg"
                | "webp"
                | "tif"
                | "tiff"
                | "exr"
                | "hdr"
                | "tga"
                | "bmp"
                | "ies"
                | "psd"
                | "dds"
                | "gif"
        )
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowStatus {
    #[default]
    Unset,
    Wip,
    Review,
    Approved,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub path: String,
    pub ext: String,
    pub kind: String,
    pub size: u64,
    pub modified: Value,
    pub added: Value,
    pub library_id: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite_at: Option<u64>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub workflow: WorkflowStatus,
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub demo: bool,
    pub subtitle: Option<String>,
    pub color: Option<String>,
    pub vertices: Option<u64>,
    pub faces: Option<u64>,
}
pub struct Catalog {
    pub conn: Connection,
    pub dir: PathBuf,
}

// Keep transactions short so scans do not hold the writer lock while reading a drive or NAS.
const SCAN_BATCH_SIZE: usize = 128;
const INDEX_ASSET: &str = "INSERT INTO assets VALUES(?1,?2,?3,?4,?5,?6,?7)
    ON CONFLICT(path) DO UPDATE SET
        library_id=CASE WHEN assets.library_id='loose' THEN excluded.library_id ELSE assets.library_id END,
        data=json_set(assets.data,
            '$.size',json_extract(excluded.data,'$.size'),
            '$.modified',json_extract(excluded.data,'$.modified'),
            '$.thumbnail',CASE WHEN json_extract(assets.data,'$.demo')=1
                THEN json_extract(assets.data,'$.thumbnail') ELSE json_extract(excluded.data,'$.thumbnail') END,
            '$.libraryId',CASE WHEN assets.library_id='loose' THEN excluded.library_id ELSE assets.library_id END)
    WHERE (assets.library_id='loose' AND excluded.library_id<>'loose')
        OR json_extract(assets.data,'$.libraryId') IS NOT assets.library_id
        OR json_extract(assets.data,'$.size') IS NOT json_extract(excluded.data,'$.size')
        OR json_extract(assets.data,'$.modified') IS NOT json_extract(excluded.data,'$.modified')
        OR (json_extract(assets.data,'$.demo') IS NOT 1
            AND json_extract(assets.data,'$.thumbnail') IS NOT json_extract(excluded.data,'$.thumbnail'))";

#[derive(Default)]
pub struct ScanResult {
    pub found: usize,
    pub skipped: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    pub directories: Vec<PathBuf>,
}

impl ScanResult {
    pub fn record_error(&mut self, message: String) {
        self.failed += 1;
        if self.errors.len() < 100 {
            self.errors.push(message);
        }
    }
}

impl Catalog {
    pub fn open(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let conn = Connection::open(dir.join("nexus.sqlite3")).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,kind TEXT NOT NULL,library_id TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS asset_kind ON assets(kind);
          CREATE INDEX IF NOT EXISTS asset_library ON assets(library_id);
          CREATE INDEX IF NOT EXISTS asset_favorite ON assets(favorite);
          CREATE INDEX IF NOT EXISTS asset_content_size ON assets(json_extract(data,'$.size'));
          CREATE TABLE IF NOT EXISTS asset_relink_fingerprints (
            asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
            path TEXT NOT NULL, size INTEGER NOT NULL, modified INTEGER NOT NULL,
            digest BLOB NOT NULL CHECK(length(digest)=32));
          CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,session TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS job_session_status ON jobs(session,status);").map_err(|e|e.to_string())?;
        collections::initialize(&conn)?;
        asset_recycle::initialize(&conn)?;
        Ok(Self {
            conn,
            dir: dir.to_path_buf(),
        })
    }
    pub fn recover_jobs(&self) -> Result<(), String> {
        self.conn.execute("UPDATE jobs SET status='interrupted',data=json_set(data,'$.status','interrupted','$.error','应用重启，任务未自动重试') WHERE status IN ('queued','running')",[]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn token(&self) -> Result<String, String> {
        if let Ok(v) = self.conn.query_row(
            "SELECT value FROM settings WHERE key='bridge_token'",
            [],
            |r| r.get::<_, String>(0),
        ) {
            return Ok(v);
        }
        let v = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.conn
            .execute("INSERT INTO settings VALUES('bridge_token',?1)", [&v])
            .map_err(|e| e.to_string())?;
        Ok(v)
    }
    pub fn upsert(&self, a: &Asset) -> Result<(), String> {
        self.conn.execute("INSERT INTO assets VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(path) DO UPDATE SET data=excluded.data,name=excluded.name,kind=excluded.kind,favorite=excluded.favorite",
          params![a.id,a.path,a.name,a.kind,a.library_id,a.favorite,serde_json::to_string(a).unwrap()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn asset(&self, id: &str) -> Result<Asset, String> {
        let data = self
            .conn
            .query_row("SELECT data FROM assets WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|_| "资产不存在".to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())
    }
    pub fn assets(&self) -> Result<Vec<Asset>, String> {
        let mut s = self
            .conn
            .prepare(
                "SELECT data FROM assets
                 WHERE NOT EXISTS(SELECT 1 FROM recycled_assets WHERE asset_id=assets.id)
                 ORDER BY rowid DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn libraries(&self) -> Result<Vec<Value>, String> {
        let mut s = self
            .conn
            .prepare("SELECT data FROM libraries ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn add_file(&self, p: &Path, library: &str) -> Result<bool, String> {
        let Some(asset) = Self::prepare_asset(p, library)? else {
            return Ok(false);
        };
        self.index_file_asset(&asset)?;
        Ok(true)
    }

    fn index_file_asset(&self, asset: &Asset) -> Result<bool, String> {
        let transaction = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let changed = {
            let mut statement = transaction
                .prepare_cached(INDEX_ASSET)
                .map_err(|e| e.to_string())?;
            Self::index_asset(&mut statement, asset).map_err(|e| e.to_string())? > 0
        };
        self.record_indexed_asset_directory(Path::new(&asset.path))?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    }

    // An isolated file import or relink can discover a directory between full scans.
    // Use the asset's persisted assignment because an upsert can retain an earlier library.
    pub fn record_indexed_asset_directory(&self, path: &Path) -> Result<(), String> {
        let Some(parent) = path.parent() else {
            return Ok(());
        };
        let registered = self
            .conn
            .query_row(
                "SELECT libraries.id, libraries.path FROM libraries
             JOIN assets ON assets.library_id=libraries.id
             WHERE assets.path=?1 AND json_extract(libraries.data,'$.foldersComplete')=1",
                [clean_path(path)],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((id, root)) = registered else {
            return Ok(());
        };
        let Some(folder) = relative_folder(Path::new(&root), parent) else {
            return Ok(());
        };
        self.conn
            .execute(
                "UPDATE libraries SET data=json_insert(data,'$.folders[#]',?2)
             WHERE id=?1 AND NOT EXISTS (
                 SELECT 1 FROM json_each(libraries.data,'$.folders') WHERE value=?2
             )",
                params![id, folder],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn prepare_asset(p: &Path, library: &str) -> Result<Option<Asset>, String> {
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let Some(k) = kind(&ext) else {
            return Ok(None);
        };
        let metadata = p.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Ok(None);
        }
        let canonical = fs::canonicalize(p).map_err(|e| e.to_string())?;
        let modified = metadata
            .modified()
            .unwrap_or_else(|_| SystemTime::now())
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Ok(Some(Asset {
            id: Uuid::new_v4().to_string(),
            name: p
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: clean_path(&canonical),
            ext,
            kind: k.into(),
            size: metadata.len(),
            modified: json!(modified),
            added: json!(now()),
            library_id: library.into(),
            tags: vec![],
            favorite: false,
            favorite_at: None,
            notes: String::new(),
            rating: 0,
            workflow: WorkflowStatus::Unset,
            thumbnail: if k == "texture" {
                None
            } else {
                asset_thumbnail(p)
            },
            demo: false,
            subtitle: None,
            color: None,
            vertices: None,
            faces: None,
        }))
    }

    fn index_asset(statement: &mut Statement<'_>, asset: &Asset) -> rusqlite::Result<usize> {
        statement.execute(params![
            asset.id,
            asset.path,
            asset.name,
            asset.kind,
            asset.library_id,
            asset.favorite,
            serde_json::to_string(asset).unwrap()
        ])
    }

    fn index_batch(&self, assets: &[Asset], result: &mut ScanResult) {
        if assets.is_empty() {
            return;
        }
        let mut errors = Vec::new();
        let transaction = (|| -> rusqlite::Result<()> {
            let transaction = self.conn.unchecked_transaction()?;
            {
                let mut statement = transaction.prepare_cached(INDEX_ASSET)?;
                for asset in assets {
                    if let Err(error) = Self::index_asset(&mut statement, asset) {
                        if transaction.is_autocommit() {
                            return Err(error);
                        }
                        errors.push(format!("{}: {error}", asset.path));
                    }
                }
            }
            transaction.commit()
        })();
        match transaction {
            Ok(()) => {
                result.found += assets.len() - errors.len();
                for error in errors {
                    result.record_error(error);
                }
            }
            Err(error) => {
                result.failed += assets.len();
                if result.errors.len() < 100 {
                    result.errors.push(format!("{}: {error}", assets[0].path));
                }
            }
        }
    }
    pub fn scan<F: FnMut(usize)>(
        &mut self,
        root: &Path,
        name: Option<String>,
        source: &str,
        progress: F,
    ) -> Result<Value, String> {
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        if !root.is_dir() {
            return Err("请选择文件夹".into());
        }
        let library = self.register_library(&root, name, source)?;
        let id = library["id"].as_str().ok_or("资产库 ID 不可用")?;
        self.scan_library_branch(id, &root, &root, None, progress)
    }

    pub fn scan_registered_folder<F: FnMut(usize)>(
        &self,
        library_id: &str,
        folder: &str,
        expected_path: Option<&Path>,
        progress: F,
    ) -> Result<Value, String> {
        use std::path::Component;

        let saved_root: String = self
            .conn
            .query_row(
                "SELECT path FROM libraries WHERE id=?1",
                [library_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or("资产库不存在")?;
        if !Path::new(&saved_root).is_absolute() {
            return Err("资产库路径无效".into());
        }
        let root =
            fs::canonicalize(saved_root).map_err(|error| format!("无法访问资产库：{error}"))?;
        if !root.is_dir() {
            return Err("资产库路径已不可用".into());
        }
        let (target, branch) = if folder.is_empty() {
            (root.clone(), None)
        } else {
            let relative = Path::new(folder);
            if !relative.components().all(|part| {
                matches!(part, Component::Normal(name) if !name.to_string_lossy().starts_with('.'))
            }) {
                return Err("文件夹路径无效".into());
            }
            let requested = root.join(relative);
            let target = fs::canonicalize(&requested)
                .map_err(|error| format!("无法访问所选文件夹：{error}"))?;
            let branch = relative_folder(&root, &target).ok_or("所选文件夹不在此资产库中")?;
            let expected = relative_folder(&root, &requested).ok_or("文件夹路径无效")?;
            let same_folder = if cfg!(windows) {
                branch.to_lowercase() == expected.to_lowercase()
            } else {
                branch == expected
            };
            if !target.is_dir() || !same_folder {
                return Err("无法扫描所选文件夹".into());
            }
            (target, Some(expected))
        };
        if let Some(path) = expected_path {
            if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(target.as_path()) {
                return Err("所选目录与资产库中的位置不一致，请重新定位。".into());
            }
        }
        self.scan_library_branch(library_id, &root, &target, branch.as_deref(), progress)
    }

    fn scan_library_branch<F: FnMut(usize)>(
        &self,
        id: &str,
        root: &Path,
        target: &Path,
        branch: Option<&str>,
        progress: F,
    ) -> Result<Value, String> {
        let summary = self.scan_files(target, |_| id, progress);
        let folders = summary
            .directories
            .iter()
            .filter_map(|path| relative_folder(root, path))
            .collect::<Vec<_>>();
        let refreshed = summary.failed == 0;
        let library = self.write_library_folders(
            id,
            &folders,
            refreshed && branch.is_none(),
            branch.filter(|_| refreshed),
        )?;
        Ok(json!({"found":summary.found,"errors":summary.errors,"library":library}))
    }

    // The root has already been canonicalized by the caller.
    pub fn register_library(
        &self,
        root: &Path,
        name: Option<String>,
        source: &str,
    ) -> Result<Value, String> {
        let root_path = clean_path(root);
        let id = Uuid::new_v4().to_string();
        let name = name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                root.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root_path.clone())
            });
        let library =
            json!({"id":id,"name":name,"path":root_path,"source":source,"scannedAt":now()});
        // Simultaneous scans of the same root must receive the same persisted ID.
        let saved: String = self
            .conn
            .query_row(
                "INSERT INTO libraries VALUES(?1,?2,?3)
             ON CONFLICT(path) DO UPDATE SET data=json_patch(libraries.data,json_set(excluded.data,'$.id',libraries.id))
             RETURNING data",
                params![id, root_path, library.to_string()],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&saved).map_err(|error| error.to_string())
    }

    pub fn store_library_folders(
        &self,
        id: &str,
        folders: &[String],
        complete: bool,
    ) -> Result<Value, String> {
        self.write_library_folders(id, folders, complete, None)
    }

    fn write_library_folders(
        &self,
        id: &str,
        folders: &[String],
        complete: bool,
        refreshed_branch: Option<&str>,
    ) -> Result<Value, String> {
        let saved: String = self
            .conn
            .query_row(
                "UPDATE libraries SET data=json_set(data,'$.folders',json((
                    SELECT json_group_array(value) FROM (
                        SELECT value FROM json_each(?2)
                        UNION
                        SELECT value FROM json_each(libraries.data,'$.folders')
                        WHERE NOT ?3 AND type='text' AND (?5 IS NULL OR
                            (value != ?5 AND substr(value,1,length(?5)+1) != (?5 || '/')))
                        ORDER BY value
                    )
                )),'$.foldersComplete',json(CASE WHEN ?3 OR json_extract(data,'$.foldersComplete')=1
                    THEN 'true' ELSE 'false' END),'$.scannedAt',?4) WHERE id=?1 RETURNING data",
                params![
                    id,
                    json!(folders).to_string(),
                    complete,
                    now(),
                    refreshed_branch
                ],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&saved).map_err(|error| error.to_string())
    }

    pub fn scan_files<'a, F: FnMut(usize), R: FnMut(&Path) -> &'a str>(
        &self,
        root: &Path,
        mut library_for_path: R,
        mut progress: F,
    ) -> ScanResult {
        let mut result = ScanResult::default();
        let mut batch = Vec::with_capacity(SCAN_BATCH_SIZE);
        for entry in WalkDir::new(root)
            .follow_links(false)
            .max_depth(32)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        {
            match entry {
                Ok(e) if e.file_type().is_dir() => result.directories.push(e.into_path()),
                Ok(e) if e.file_type().is_file() => {
                    match Self::prepare_asset(e.path(), library_for_path(e.path())) {
                        Ok(Some(asset)) => {
                            batch.push(asset);
                            if batch.len() == SCAN_BATCH_SIZE {
                                self.index_batch(&batch, &mut result);
                                batch.clear();
                                progress(result.found);
                            }
                        }
                        Ok(None) => result.skipped += 1,
                        Err(error) => {
                            result.record_error(format!("{}: {error}", clean_path(e.path())))
                        }
                    }
                }
                Err(e) => result.record_error(e.to_string()),
                _ => {}
            }
        }
        self.index_batch(&batch, &mut result);
        progress(result.found);
        result
    }
    pub fn patch(&self, id: &str, patch: Value) -> Result<Asset, String> {
        let mut a = self.asset(id)?;
        if let Some(s) = patch.get("name").and_then(Value::as_str) {
            if !s.trim().is_empty() {
                a.name = s.trim().chars().take(200).collect();
            }
        }
        if let Some(b) = patch.get("favorite").and_then(Value::as_bool) {
            if b != a.favorite {
                a.favorite_at = b.then(now_millis);
            }
            a.favorite = b;
        }
        if let Some(s) = patch.get("notes").and_then(Value::as_str) {
            a.notes = s.chars().take(10000).collect();
        }
        if let Some(rating) = patch.get("rating") {
            a.rating = rating
                .as_u64()
                .filter(|value| *value <= 5)
                .ok_or("评分必须为 0 至 5")? as u8;
        }
        if let Some(workflow) = patch.get("workflow") {
            a.workflow = serde_json::from_value(workflow.clone()).map_err(|_| "工作流状态无效")?;
        }
        if let Some(tags) = patch.get("tags").and_then(Value::as_array) {
            let mut out = vec![];
            for t in tags
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .take(30)
            {
                let t: String = t.chars().take(40).collect();
                if !out.contains(&t) {
                    out.push(t);
                }
            }
            a.tags = out;
        }
        self.upsert(&a)?;
        Ok(a)
    }
    pub fn seed(&self) -> Result<(), String> {
        static DEMO: include_dir::Dir<'_> =
            include_dir::include_dir!("$CARGO_MANIFEST_DIR/../resources/demo");
        let dest = self.dir.join("demo");
        fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        for f in DEMO.files() {
            let p = dest.join(f.path());
            if !p.exists() {
                fs::write(p, f.contents()).map_err(|e| e.to_string())?;
            }
        }
        let lib =
            json!({"id":"demo","name":"Nexus 示例资产","path":clean_path(&dest),"source":"demo"});
        self.conn
            .execute(
                "INSERT OR IGNORE INTO libraries VALUES('demo',?1,?2)",
                params![clean_path(&dest), lib.to_string()],
            )
            .map_err(|e| e.to_string())?;
        let items: Vec<Asset> =
            serde_json::from_slice(DEMO.get_file("manifest.json").unwrap().contents())
                .map_err(|e| e.to_string())?;
        for mut a in items {
            if self.asset(&a.id).is_ok() {
                continue;
            }
            a.path = clean_path(&dest.join(&a.path));
            a.thumbnail = a.thumbnail.map(|s| clean_path(&dest.join(s)));
            self.upsert(&a)?;
        }
        Ok(())
    }
    pub fn put_job(&self, j: &Value) -> Result<(), String> {
        self.conn.execute("INSERT INTO jobs VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",params![j["id"].as_str(),j["sessionId"].as_str(),j["status"].as_str(),j.to_string()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn next_queued_job(&self, session: &str) -> Result<Option<Value>, String> {
        self.query_job(
            "SELECT data FROM jobs WHERE session=?1 AND status='queued' ORDER BY rowid LIMIT 1",
            [session],
        )
    }
    pub fn has_pending_dcc_jobs(&self, queued_cutoff: u64) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM jobs WHERE status='running' OR
                    (status='queued' AND CAST(json_extract(data,'$.created') AS INTEGER) >= ?1)
                )",
                [queued_cutoff],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }
    pub fn session_job(&self, session: &str, id: &str) -> Result<Option<Value>, String> {
        self.query_job(
            "SELECT data FROM jobs WHERE session=?1 AND id=?2",
            [session, id],
        )
    }
    fn query_job(&self, query: &str, args: impl rusqlite::Params) -> Result<Option<Value>, String> {
        use rusqlite::OptionalExtension;

        let data = self
            .conn
            .query_row(query, args, |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?;
        data.map(|data| serde_json::from_str(&data).map_err(|e| e.to_string()))
            .transpose()
    }
    pub fn jobs(&self) -> Result<Vec<Value>, String> {
        let mut s = self
            .conn
            .prepare("SELECT data FROM jobs ORDER BY rowid DESC LIMIT 100")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
}
pub fn clean_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(unc) = s.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{unc}");
    }
    s.strip_prefix("\\\\?\\").unwrap_or(&s).to_string()
}

pub fn relative_folder(root: &Path, directory: &Path) -> Option<String> {
    let root = PathBuf::from(clean_path(root));
    let directory = PathBuf::from(clean_path(directory));
    if cfg!(windows) {
        let root_key = PathBuf::from(root.to_string_lossy().to_lowercase());
        let directory_key = PathBuf::from(directory.to_string_lossy().to_lowercase());
        if !directory_key.starts_with(root_key) {
            return None;
        }
    } else if !directory.starts_with(&root) {
        return None;
    }
    let parts: Vec<_> = directory
        .components()
        .skip(root.components().count())
        .map(|part| part.as_os_str().to_string_lossy())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

pub fn is_houdini_scene_extension(ext: &str) -> bool {
    ["hip", "hiplc", "hipnc"]
        .iter()
        .any(|format| ext.eq_ignore_ascii_case(format))
}

pub fn asset_thumbnail_candidates(path: &Path) -> Vec<PathBuf> {
    let Some(folder) = path.parent() else {
        return Vec::new();
    };
    let houdini = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(is_houdini_scene_extension);
    let mut candidates = Vec::with_capacity(if houdini { 11 } else { 4 });
    if houdini {
        if let Some(filename) = path.file_name() {
            for extension in [".png", ".jpg", ".jpeg"] {
                let mut name = filename.to_os_string();
                name.push(extension);
                candidates.push(folder.join(name));
            }
        }
    }
    candidates.extend([path.with_extension("jpg"), path.with_extension("png")]);
    if houdini {
        candidates.push(path.with_extension("jpeg"));
        if let Some(stem) = path.file_stem() {
            for suffix in ["_thumbnail.png", "_thumbnail.jpg", "_thumbnail.jpeg"] {
                let mut name = stem.to_os_string();
                name.push(suffix);
                candidates.push(folder.join(name));
            }
        }
    }
    candidates.extend([folder.join("preview.jpg"), folder.join("preview.png")]);
    candidates
}

pub fn asset_thumbnail(path: &Path) -> Option<String> {
    asset_thumbnail_candidates(path)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| clean_path(&candidate))
}

pub fn preview_image(a: &Asset, cache_dir: &Path) -> Result<Option<(String, Vec<u8>)>, String> {
    scaled_preview_image(a, cache_dir, 512)
}

pub fn scaled_preview_image(
    a: &Asset,
    cache_dir: &Path,
    max_size: u32,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let embedded_scene = a.kind == "scene" && matches!(a.ext.as_str(), "c4d" | "max") && a.thumbnail.is_none();
    let p = if a.ext == "ies" {
        a.thumbnail.as_deref().or(Some(a.path.as_str()))
    } else if a.kind == "texture" || embedded_scene {
        Some(a.path.as_str())
    } else {
        a.thumbnail.as_deref()
    };
    let Some(p) = p else {
        return Ok(None);
    };
    let ext = Path::new(p)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    if ext == "svg" && a.demo {
        return Ok(Some((
            "image/svg+xml".into(),
            fs::read(p).map_err(|e| e.to_string())?,
        )));
    }
    if !embedded_scene {
        let Some(limit) = asset_raster_preview_limit(&ext) else {
            return Ok(None);
        };
        if metadata.len() > limit {
            return Err(format!("图片源文件超过当前预览大小限制（{} MiB）", limit / (1024 * 1024)));
        }
    }
    let stamp = metadata
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let cache = if max_size == 512 {
        cache_dir.join(format!("{}-{}-{}.png", a.id, metadata.len(), stamp))
    } else {
        cache_dir.join(format!(
            "{}-{}-{}-{max_size}.png",
            a.id,
            metadata.len(),
            stamp
        ))
    };
    if let Ok(data) = fs::read(&cache) {
        return Ok(Some(("image/png".into(), data)));
    }
    let Some(bytes) = decode_scaled_preview(Path::new(p), &ext, max_size, metadata.len())? else {
        return Ok(None);
    };
    if max_size == 512 && fs::create_dir_all(cache_dir).is_ok() {
        let temp = cache_dir.join(format!("{}.tmp", Uuid::new_v4()));
        if fs::write(&temp, &bytes).is_ok() {
            if fs::rename(&temp, &cache).is_err() {
                let _ = fs::remove_file(&temp);
            }
        }
    }
    Ok(Some(("image/png".into(), bytes)))
}

const MAX_PREVIEW_SOURCE_BYTES: u64 = 192 * 1024 * 1024;

pub fn asset_raster_preview_limit(ext: &str) -> Option<u64> {
    if ext == "png" {
        Some(png_preview::MAX_SOURCE_BYTES)
    } else {
        (ext == "ies" || preview_image_format(ext)).then_some(MAX_PREVIEW_SOURCE_BYTES)
    }
}

fn attachment_extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub fn supports_attachment_preview(path: &Path) -> bool {
    let extension = attachment_extension(path);
    extension == "c4d" || preview_image_format(&extension)
}

pub fn attachment_preview_png(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let extension = attachment_extension(path);
    if extension != "c4d" && !preview_image_format(&extension) {
        return Ok(None);
    }
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let source_bytes = metadata.len();
    if extension != "c4d" && source_bytes > MAX_PREVIEW_SOURCE_BYTES {
        return Ok(None);
    }
    const MAX_ATTACHMENT_PREVIEW_BYTES: usize = 300 * 1024;
    Ok(thumbnail_cache::raster::read(path, &extension, 256, source_bytes, metadata.modified().ok())?
        .filter(|bytes| bytes.len() <= MAX_ATTACHMENT_PREVIEW_BYTES))
}

fn preview_image_format(ext: &str) -> bool {
    matches!(
        ext,
        "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "bmp"
            | "tif"
            | "tiff"
            | "exr"
            | "hdr"
            | "hdri"
            | "tga"
            | "dds"
    )
}

fn decode_raster_preview(
    path: &Path,
    ext: &str,
    max_size: u32,
    source_bytes: u64,
) -> Result<image::DynamicImage, String> {
    const MAX_DECODE: u64 = 256 * 1024 * 1024;
    let mut reader = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE);
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    reader.limits(limits);
    let format = reader.format();
    if format != Some(image::ImageFormat::Png) && source_bytes > MAX_PREVIEW_SOURCE_BYTES {
        return Err("图片源文件超过当前预览大小限制（192 MiB）".into());
    }
    let try_streaming_png = format == Some(image::ImageFormat::Png)
        && source_bytes >= png_preview::STREAMING_THRESHOLD_BYTES;
    if try_streaming_png {
        if let Some(image) = png_preview::decode(path, max_size)? {
            return Ok(image);
        }
        if source_bytes > MAX_PREVIEW_SOURCE_BYTES {
            return Err("此 PNG 图像超过常规预览限制，无法逐行缩放".into());
        }
    }
    #[cfg(all(windows, feature = "desktop"))]
    if format == Some(image::ImageFormat::Jpeg) && source_bytes >= 8 * 1024 * 1024 {
        if let Some(result) = jpeg_preview::decode_if_large(path, MAX_DECODE, max_size) {
            return result;
        }
    }
    match reader.decode() {
        Ok(image) => Ok(image),
        Err(error @ image::ImageError::Limits(_))
            if format == Some(image::ImageFormat::Png) && !try_streaming_png =>
        {
            png_preview::decode(path, max_size)?
                .ok_or_else(|| format!("无法解码 PNG 图片：{error}"))
        }
        Err(image::ImageError::Limits(_)) if format == Some(image::ImageFormat::Hdr) => {
            linear_preview::decode_hdr(path, MAX_DECODE, max_size)
        }
        #[cfg(all(windows, feature = "desktop"))]
        Err(error @ image::ImageError::Limits(_)) if format == Some(image::ImageFormat::Jpeg) => {
            jpeg_preview::decode_if_large(path, MAX_DECODE, max_size)
                .unwrap_or_else(|| Err(format!("无法解码 JPEG 图片：{error}")))
        }
        Err(_) if ext == "exr" => linear_preview::decode_exr(path, MAX_DECODE, max_size),
        Err(error) => Err(format!("无法解码 {} 图片：{error}", ext.to_uppercase())),
    }
}

fn decode_scaled_preview(path: &Path, ext: &str, max_size: u32, source_bytes: u64) -> Result<Option<Vec<u8>>, String> {
    let embedded = match ext {
        "c4d" => c4d_preview::decode(path)?,
        "ies" => ies_preview::decode(path, max_size)?,
        "max" => max_preview::decode(path)?,
        _ => Some(decode_raster_preview(path, ext, max_size, source_bytes)?),
    };
    let Some(decoded) = embedded else { return Ok(None) };
    let decoded = if decoded.width() > max_size || decoded.height() > max_size {
        decoded.thumbnail(max_size, max_size)
    } else {
        decoded
    };
    // Floating-point images need display conversion before PNG encoding.
    let decoded = match decoded {
        image::DynamicImage::ImageRgb32F(_) | image::DynamicImage::ImageRgba32F(_) => {
            let mut rgba = decoded.into_rgba32f();
            for pixel in rgba.pixels_mut() {
                let [r, g, b, _] = pixel.0;
                let exposure = if matches!(ext, "hdr" | "hdri" | "exr") {
                    1.0 + (0.2126 * r.max(0.0) + 0.7152 * g.max(0.0) + 0.0722 * b.max(0.0))
                } else {
                    1.0
                };
                for channel in &mut pixel.0[..3] {
                    let value = if channel.is_finite() {
                        channel.max(0.0) / exposure
                    } else {
                        0.0
                    };
                    *channel = if matches!(ext, "hdr" | "hdri" | "exr") {
                        if value <= 0.0031308 {
                            12.92 * value
                        } else {
                            1.055 * value.powf(1.0 / 2.4) - 0.055
                        }
                    } else {
                        value
                    };
                }
            }
            image::DynamicImage::ImageRgba8(image::DynamicImage::ImageRgba32F(rgba).into_rgba8())
        }
        // Use compact 8-bit previews for high-bit-depth TIFF data.
        image::DynamicImage::ImageLuma16(_)
        | image::DynamicImage::ImageLumaA16(_)
        | image::DynamicImage::ImageRgb16(_)
        | image::DynamicImage::ImageRgba16(_) => {
            image::DynamicImage::ImageRgba8(decoded.into_rgba8())
        }
        _ => decoded,
    };
    let mut data = std::io::Cursor::new(Vec::new());
    decoded
        .write_to(&mut data, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(Some(data.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thumbnails_are_resized_and_cached() {
        let d = tempfile::tempdir().unwrap();
        let c = Catalog::open(&d.path().join("db")).unwrap();
        let file = d.path().join("大图.png");
        image::RgbImage::new(1024, 512).save(&file).unwrap();
        c.add_file(&file, "test").unwrap();
        let a = c.assets().unwrap().remove(0);
        let cache = d.path().join("cache");
        let (mime, bytes) = preview_image(&a, &cache).unwrap().unwrap();
        assert_eq!(mime, "image/png");
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (512, 256));
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        assert_eq!(preview_image(&a, &cache).unwrap().unwrap().1, bytes);
    }

    #[test]
    fn houdini_scene_previews_use_the_matching_companion_image() {
        let scratch = tempfile::tempdir().unwrap();
        let scene = scratch.path().join("场景.hiplc");
        fs::write(&scene, b"fixture").unwrap();
        let folder_preview = scratch.path().join("preview.png");
        image::RgbImage::new(10, 10).save(&folder_preview).unwrap();
        let thumbnail = scratch.path().join("场景_thumbnail.png");
        image::RgbImage::new(320, 160).save(&thumbnail).unwrap();
        assert_eq!(asset_thumbnail(&scene), Some(clean_path(&thumbnail)));

        let explicit = scratch.path().join("场景.hiplc.png");
        image::RgbImage::new(640, 320).save(&explicit).unwrap();
        let catalog = Catalog::open(&scratch.path().join("db")).unwrap();
        catalog.add_file(&scene, "fixture").unwrap();
        let asset = catalog.assets().unwrap().remove(0);
        assert_eq!(asset.thumbnail.as_deref(), Some(clean_path(&explicit).as_str()));
        let (mime, bytes) = preview_image(&asset, &scratch.path().join("cache"))
            .unwrap()
            .unwrap();
        assert_eq!(mime, "image/png");
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (512, 256));
    }

    #[test]
    fn scanner_connection_does_not_interrupt_live_jobs() {
        let d = tempfile::tempdir().unwrap();
        let c = Catalog::open(d.path()).unwrap();
        c.put_job(&json!({"id":"live","sessionId":"dcc","status":"running"}))
            .unwrap();
        let other = Catalog::open(d.path()).unwrap();
        assert_eq!(other.jobs().unwrap()[0]["status"], "running");
        c.recover_jobs().unwrap();
        assert_eq!(other.jobs().unwrap()[0]["status"], "interrupted");
    }
    #[test]
    fn scan_is_idempotent_and_preserves_edits() {
        let d = tempfile::tempdir().unwrap();
        let assets = d.path().join("资产库");
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("椅子.obj"), "v 0 0 0").unwrap();
        fs::write(assets.join("ignore.txt"), "hello").unwrap();
        let mut c = Catalog::open(&d.path().join("db")).unwrap();
        let r = c.scan(&assets, None, "local", |_| {}).unwrap();
        assert_eq!(r["found"], 1);
        let a = c.assets().unwrap().remove(0);
        let favorite_time = c.patch(
            &a.id,
            json!({"favorite":true,"tags":["家具","家具",""],"notes":"检查材质","rating":4,"workflow":"review"}),
        )
        .unwrap()
        .favorite_at
        .unwrap();
        c.scan(&assets, None, "local", |_| {}).unwrap();
        let out = c.assets().unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].favorite);
        assert_eq!(out[0].favorite_at, Some(favorite_time));
        assert_eq!(out[0].tags, vec!["家具"]);
        assert_eq!(out[0].notes, "检查材质");
        assert_eq!(out[0].rating, 4);
        assert_eq!(out[0].workflow, WorkflowStatus::Review);
        assert!(c.patch(&a.id, json!({"rating": 6})).is_err());
        assert!(c.patch(&a.id, json!({"workflow": "unknown"})).is_err());
        assert_eq!(c.asset(&a.id).unwrap().rating, 4);
        assert_eq!(
            c.patch(&a.id, json!({"favorite":true})).unwrap().favorite_at,
            Some(favorite_time)
        );
        assert_eq!(
            c.patch(&a.id, json!({"favorite":false})).unwrap().favorite_at,
            None
        );
        let mut legacy = c.asset(&a.id).unwrap();
        legacy.favorite = true;
        c.upsert(&legacy).unwrap();
        assert_eq!(
            c.patch(&a.id, json!({"favorite":true})).unwrap().favorite_at,
            None
        );
    }
    #[test]
    fn scan_batches_report_committed_progress_and_keep_successful_rows() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("assets");
        fs::create_dir(&root).unwrap();
        for i in 0..SCAN_BATCH_SIZE + 2 {
            fs::write(root.join(format!("model-{i}.obj")), "v 0 0 0").unwrap();
        }
        fs::write(root.join("rejected.obj"), "v 0 0 0").unwrap();
        let db = scratch.path().join("db");
        let mut catalog = Catalog::open(&db).unwrap();
        let reader = Catalog::open(&db).unwrap();
        catalog.conn.execute_batch(
            "CREATE TRIGGER reject_test_asset BEFORE INSERT ON assets WHEN NEW.name = 'rejected'
             BEGIN SELECT RAISE(FAIL, 'rejected test file'); END;",
        ).unwrap();

        let mut seen = Vec::new();
        let scan = catalog
            .scan(&root, None, "local", |n| {
                let committed: usize = reader
                    .conn
                    .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(committed, n);
                seen.push(n);
            })
            .unwrap();
        assert_eq!(scan["found"], SCAN_BATCH_SIZE + 2);
        assert_eq!(scan["errors"].as_array().unwrap().len(), 1);
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1], SCAN_BATCH_SIZE + 2);
    }

    #[test]
    fn unchanged_assets_are_skipped_but_new_sidecars_and_loose_adoption_are_indexed() {
        let scratch = tempfile::tempdir().unwrap();
        let model = scratch.path().join("model.obj");
        let cover = scratch.path().join("model.png");
        fs::write(&model, "v 0 0 0").unwrap();
        let catalog = Catalog::open(&scratch.path().join("db")).unwrap();
        assert!(catalog.add_file(&model, "loose").unwrap());
        let original = catalog.assets().unwrap().remove(0);
        catalog
            .patch(&original.id, json!({"name":"Custom name","favorite":true}))
            .unwrap();
        let writes = catalog.conn.total_changes();
        assert!(catalog.add_file(&model, "loose").unwrap());
        assert_eq!(catalog.conn.total_changes(), writes);

        fs::write(&cover, "sidecar").unwrap();
        assert!(catalog.add_file(&model, "registered").unwrap());
        let updated = catalog.asset(&original.id).unwrap();
        assert_eq!(updated.name, "Custom name");
        assert!(updated.favorite);
        assert_eq!(updated.library_id, "registered");
        assert_eq!(updated.thumbnail.unwrap(), clean_path(&cover));
    }
    #[test]
    fn scan_records_real_nested_empty_folders_and_refreshes_their_paths() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("素材");
        fs::create_dir_all(root.join("未整理/草稿")).unwrap();
        fs::create_dir_all(root.join("模型")).unwrap();
        fs::create_dir_all(root.join(".ignored/cache")).unwrap();
        fs::write(root.join("模型/椅子.obj"), "v 0 0 0").unwrap();
        let mut catalog = Catalog::open(&scratch.path().join("db")).unwrap();

        let scan = catalog.scan(&root, None, "local", |_| {}).unwrap();
        assert_eq!(scan["found"], 1);
        assert_eq!(scan["library"]["foldersComplete"], true);
        assert_eq!(
            scan["library"]["folders"],
            json!(["未整理", "未整理/草稿", "模型"])
        );
        let library = scan["library"]["id"].as_str().unwrap();
        let updated = catalog
            .store_library_folders(library, &["部分结果".into()], false)
            .unwrap();
        assert_eq!(updated["foldersComplete"], true);
        assert_eq!(
            updated["folders"],
            json!(["未整理", "未整理/草稿", "模型", "部分结果"])
        );

        fs::remove_dir(root.join("未整理/草稿")).unwrap();
        let next = catalog.scan(&root, None, "local", |_| {}).unwrap();
        assert_eq!(next["library"]["id"], library);
        assert_eq!(next["library"]["folders"], json!(["未整理", "模型"]));
        assert_eq!(catalog.libraries().unwrap()[0], next["library"]);
    }

    #[test]
    fn registered_folder_scan_updates_only_the_selected_branch() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("素材");
        fs::create_dir_all(root.join("项目_一/旧草稿")).unwrap();
        fs::create_dir_all(root.join("项目_一备份/旧目录")).unwrap();
        fs::write(root.join("项目_一/素材.obj"), "v 0 0 0").unwrap();
        fs::write(root.join("项目_一备份/原文件.obj"), "v 0 0 0").unwrap();
        let mut catalog = Catalog::open(&scratch.path().join("db")).unwrap();
        let original = catalog
            .scan(&root, Some("显示名称".into()), "local", |_| {})
            .unwrap();
        let id = original["library"]["id"].as_str().unwrap();
        let assets = catalog.assets().unwrap();
        let selected = assets.iter().find(|asset| asset.name == "素材").unwrap();
        let sibling = assets.iter().find(|asset| asset.name == "原文件").unwrap();
        catalog
            .patch(&selected.id, json!({"favorite":true}))
            .unwrap();

        fs::rename(root.join("项目_一/旧草稿"), root.join("项目_一/新草稿")).unwrap();
        fs::rename(
            root.join("项目_一备份/旧目录"),
            root.join("项目_一备份/新目录"),
        )
        .unwrap();
        fs::write(root.join("项目_一/新草稿/新文件.obj"), "v 1 0 0").unwrap();
        fs::write(root.join("项目_一备份/另一个文件.obj"), "v 2 0 0").unwrap();
        fs::write(root.join("项目_一备份/原文件.obj"), "v 0 0 0\nv 1 1 1").unwrap();

        let mut progress = Vec::new();
        let wrong_source = root.join("项目_一备份");
        assert!(catalog
            .scan_registered_folder(id, "项目_一", Some(&wrong_source), |count| progress.push(count))
            .unwrap_err()
            .contains("位置不一致"));
        assert!(progress.is_empty());
        let refreshed = catalog
            .scan_registered_folder(id, "项目_一", Some(&root.join("项目_一")), |count| progress.push(count))
            .unwrap();
        assert_eq!(refreshed["found"], 2);
        assert_eq!(refreshed["errors"], json!([]));
        assert_eq!(progress.last(), Some(&2));
        assert_eq!(refreshed["library"]["id"], id);
        assert_eq!(refreshed["library"]["name"], "显示名称");
        assert_eq!(refreshed["library"]["foldersComplete"], true);
        assert_eq!(
            refreshed["library"]["folders"],
            json!([
                "项目_一",
                "项目_一/新草稿",
                "项目_一备份",
                "项目_一备份/旧目录"
            ])
        );
        let assets = catalog.assets().unwrap();
        let added = assets.iter().find(|asset| asset.name == "新文件").unwrap();
        assert_eq!(added.library_id, id);
        assert_eq!(assets.len(), 3);
        assert!(catalog.asset(&selected.id).unwrap().favorite);
        assert_eq!(catalog.asset(&sibling.id).unwrap().size, sibling.size);
        assert_eq!(catalog.libraries().unwrap().len(), 1);
        assert!(catalog
            .scan_registered_folder(id, "项目_一/../项目_一备份", None, |_| {})
            .is_err());
        assert!(catalog
            .scan_registered_folder(id, &clean_path(&root), None, |_| {})
            .is_err());
        assert!(catalog
            .scan_registered_folder("missing", "", None, |_| {})
            .is_err());

        let whole_root = catalog.scan_registered_folder(id, "", None, |_| {}).unwrap();
        assert_eq!(whole_root["found"], 4);
        assert_eq!(whole_root["library"]["id"], id);
        assert!(whole_root["library"]["folders"]
            .as_array()
            .unwrap()
            .contains(&json!("项目_一备份/新目录")));
    }

    #[test]
    fn full_folder_refresh_replaces_renamed_paths_but_keeps_assets_for_relink() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("素材");
        fs::create_dir_all(root.join("旧项目/旧草稿")).unwrap();
        fs::write(root.join("旧项目/旧草稿/椅子.obj"), "v 0 0 0").unwrap();
        let root = fs::canonicalize(root).unwrap();
        let mut catalog = Catalog::open(&scratch.path().join("db")).unwrap();
        let legacy = catalog.register_library(&root, None, "local").unwrap();
        assert!(legacy.get("foldersComplete").is_none());
        let scan = catalog.scan(&root, None, "local", |_| {}).unwrap();
        assert_eq!(scan["library"]["id"], legacy["id"]);
        let id = scan["library"]["id"].as_str().unwrap();
        let old = catalog.assets().unwrap().remove(0);
        catalog.patch(&old.id, json!({"notes":"保留备注"})).unwrap();

        fs::rename(root.join("旧项目"), root.join("新项目")).unwrap();
        fs::rename(root.join("新项目/旧草稿"), root.join("新项目/归档")).unwrap();
        let refresh = catalog.scan(&root, None, "local", |_| {}).unwrap();
        assert_eq!(
            refresh["library"]["folders"],
            json!(["新项目", "新项目/归档"])
        );
        assert_eq!(catalog.asset(&old.id).unwrap().notes, "保留备注");
        assert!(!Path::new(&old.path).exists());

        let added = root.join("新文件夹/子文件夹/灯.obj");
        fs::create_dir_all(added.parent().unwrap()).unwrap();
        fs::write(&added, "v 0 0 0").unwrap();
        assert!(catalog.add_file(&added, id).unwrap());
        let reopened = Catalog::open(&scratch.path().join("db")).unwrap();
        let library = reopened.libraries().unwrap().remove(0);
        assert_eq!(library["foldersComplete"], true);
        assert!(library["folders"]
            .as_array()
            .unwrap()
            .contains(&json!("新文件夹/子文件夹")));
        assert_eq!(reopened.assets().unwrap().len(), 3);
    }

    #[test]
    fn reference_extensions_are_indexed_with_consistent_categories() {
        for (group, extensions) in [
            (
                "model",
                "3dm 3ds 3mf abc aof ass atl atlo bvh cgeo cuap dae stl",
            ),
            ("scene", "blend c4d"),
            (
                "material",
                "mat mdl mtl mtlx rmtl sbs sbsar sbsprs skm vrmat xsh zip",
            ),
            (
                "texture",
                "ai arw bmp eps exr gif hdr hdri jpeg jpg png psd renv svg ies",
            ),
            (
                "video",
                "3gp amv avi f4p f4v flv m2v m4v mkv mov mp2 mp4 mpe mpeg mpg webm wmv",
            ),
            ("audio", "aac aiff alac flac m4a mp3 wav wma"),
            ("bim", "gsm ifc pla pln rfa rft rte rvt val"),
            ("cad", "dwg dxf iges igs sat step stp"),
            (
                "script",
                "csc csr dyn gh ghuser mcr mel ms mse mzp py rb rbs",
            ),
            ("other", "ini pdf"),
        ] {
            for extension in extensions.split_whitespace() {
                assert_eq!(kind(extension), Some(group), "{extension}");
                let catalog_path = format!("参考片/素材.{}", extension.to_ascii_uppercase());
                assert_eq!(
                    team::asset_format(&catalog_path),
                    Some((extension.to_owned(), group))
                );
            }
        }
        for extension in ["", "lnk", "crdownload", "part", "exe"] {
            assert_eq!(kind(extension), None);
        }
        assert!(!compatible("blender", "py"));
        assert!(!c4d_smart_compatible("py"));
    }

    #[test]
    fn native_formats_have_explicit_boundaries() {
        assert!(!compatible("c4d", "max"));
        assert!(compatible("blender", "max"));
        assert!(compatible("blender", "blend"));
        assert!(compatible("c4d", "obj"));
    }
    #[test]
    fn demo_is_real_geometry_and_not_reseeded_over_edits() {
        let d = tempfile::tempdir().unwrap();
        let c = Catalog::open(d.path()).unwrap();
        c.seed().unwrap();
        let a = c.assets().unwrap().remove(0);
        assert!(fs::read_to_string(&a.path).unwrap().contains("\nf "));
        c.patch(&a.id, json!({"name":"我的修改"})).unwrap();
        c.seed().unwrap();
        assert_eq!(c.asset(&a.id).unwrap().name, "我的修改");
    }
}
