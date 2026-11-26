use crate::AppState;
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use serde::Serialize;
use std::{
    fs,
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const DOCKERFILE: &str = include_str!("../../nas/Dockerfile");
const COMPOSE: &str = include_str!("../../nas/compose.yaml");
const GUIDE: &str = include_str!("../../nas/README.md");
const DOCKERIGNORE: &str = include_str!("../../nas/dockerignore");
const DEMO: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../resources/demo");

macro_rules! source_file {
    ($path:literal) => {
        (concat!("src-tauri/src/", $path), include_bytes!($path))
    };
}

const BUILD_FILES: &[(&str, &[u8])] = &[
    ("src-tauri/Cargo.toml", include_bytes!("../Cargo.toml")),
    ("src-tauri/Cargo.lock", include_bytes!("../Cargo.lock")),
    ("src-tauri/build.rs", include_bytes!("../build.rs")),
    source_file!("lib.rs"),
    source_file!("asset_recycle.rs"),
    source_file!("baidu_cloud.rs"),
    source_file!("c4d_preview.rs"),
    source_file!("collections.rs"),
    source_file!("creative_subscriptions.rs"),
    source_file!("ies_preview.rs"),
    source_file!("linear_preview.rs"),
    source_file!("max_preview.rs"),
    source_file!("team.rs"),
    source_file!("team_organization.rs"),
    source_file!("thumbnail_cache.rs"),
    source_file!("whiteboard.rs"),
    source_file!("bin/nexus-team.rs"),
    source_file!("bin/nexus-team/asset_messages.rs"),
    source_file!("bin/nexus-team/asset_recycle.rs"),
    source_file!("bin/nexus-team/baidu_cloud.rs"),
    source_file!("bin/nexus-team/creative_subscriptions.rs"),
    source_file!("bin/nexus-team/organization.rs"),
    source_file!("bin/nexus-team/quick_access.rs"),
    source_file!("bin/nexus-team/sources.rs"),
    source_file!("bin/nexus-team/whiteboard.rs"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NasExport {
    directory: PathBuf,
    url: String,
}

fn nas_address(address: &str) -> Result<SocketAddrV4, String> {
    let invalid =
        "导出时请填写 NAS 的私网 IPv4 地址，端口需在 1024 至 65535。例如 http://192.168.1.20:47822";
    let authority = address.trim().strip_prefix("http://").ok_or(invalid)?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    let endpoint = authority
        .parse::<SocketAddrV4>()
        .or_else(|_| {
            authority
                .parse::<Ipv4Addr>()
                .map(|ip| SocketAddrV4::new(ip, 47822))
        })
        .map_err(|_| invalid)?;
    if endpoint.ip().is_private() && endpoint.port() >= 1024 {
        Ok(endpoint)
    } else {
        Err(invalid.into())
    }
}

fn backup_team(source: &Path, destination: &Path, team_id: uuid::Uuid) -> Result<(), String> {
    let open = |error: rusqlite::Error| format!("无法导出团队数据库：{error}");
    let source =
        Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(open)?;
    source.busy_timeout(Duration::from_secs(2)).map_err(open)?;
    let mut copy = Connection::open(destination).map_err(open)?;
    {
        let backup = Backup::new(&source, &mut copy).map_err(open)?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if matches!(backup.step(128).map_err(open)?, StepResult::Done) {
                break;
            }
            if Instant::now() >= deadline {
                return Err("团队数据库持续有写入，请在暂停编辑后重新导出".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let id: String = copy
        .query_row("SELECT id FROM team WHERE singleton=1", [], |row| {
            row.get(0)
        })
        .map_err(open)?;
    if uuid::Uuid::parse_str(&id).ok() != Some(team_id) {
        return Err("数据库与选择的本机团队不一致".into());
    }
    copy.pragma_update(None, "journal_mode", "DELETE")
        .map_err(open)?;
    // Watch roots are local to the old server and must be configured on the NAS.
    copy.execute("DELETE FROM watched_libraries", [])
        .map_err(open)?;
    let has_source_paths: bool = copy.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_source_paths')", [], |row| row.get(0)
    ).map_err(open)?;
    if has_source_paths {
        copy.execute("DELETE FROM library_source_paths", [])
            .map_err(open)?;
    }
    copy.close().map_err(|(_, error)| open(error))?;
    Ok(())
}

fn write_bundle(
    root: &Path,
    target: &Path,
    team_id: uuid::Uuid,
    address: SocketAddrV4,
    address_join: bool,
) -> Result<NasExport, String> {
    let files = |error: std::io::Error| format!("无法写入 NAS 部署包：{error}");
    let local_copy = tempfile::tempdir_in(root).map_err(files)?;
    let snapshot = local_copy.path().join("team.sqlite3");
    backup_team(&root.join("hosted-team/team.sqlite3"), &snapshot, team_id)?;
    let staging = tempfile::Builder::new()
        .prefix(".nexus-nas-")
        .tempdir_in(target)
        .map_err(files)?;
    let base = staging.path();
    for folder in [
        "data",
        "nas",
        "resources/demo",
        "src-tauri/src/bin/nexus-team",
    ] {
        fs::create_dir_all(base.join(folder)).map_err(files)?;
    }
    for (path, data) in BUILD_FILES {
        fs::write(base.join(path), data).map_err(files)?;
    }
    DEMO.extract(base.join("resources/demo")).map_err(files)?;
    fs::copy(&snapshot, base.join("data/team.sqlite3")).map_err(files)?;
    fs::write(base.join("nas/Dockerfile"), DOCKERFILE).map_err(files)?;
    fs::write(base.join(".dockerignore"), DOCKERIGNORE).map_err(files)?;
    let yaml = COMPOSE.replace(
        "${NEXUS_TEAM_LISTEN:?填写 NAS 的私网 IPv4 和团队端口}",
        &address.to_string(),
    );
    let yaml = if address_join {
        yaml.replace(
            "      # NEXUS_ADDRESS_JOIN_FLAG",
            "      - --allow-address-join",
        )
    } else {
        yaml
    };
    fs::write(base.join("compose.yaml"), yaml).map_err(files)?;
    fs::write(base.join("部署说明.md"), GUIDE).map_err(files)?;
    let directory = target.join(format!("NexusTeam-NAS-{}", uuid::Uuid::new_v4().simple()));
    fs::rename(base, &directory).map_err(files)?;
    Ok(NasExport {
        directory,
        url: format!("http://{address}"),
    })
}

#[tauri::command]
pub(crate) async fn export_team_for_nas(
    state: tauri::State<'_, AppState>,
    team_id: uuid::Uuid,
    url: String,
    address_join: bool,
) -> Result<Option<NasExport>, String> {
    let root = state.root.clone();
    let address = nas_address(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !root.join("hosted-team/team.sqlite3").is_file() {
            return Err("这台电脑没有可导出的本机团队数据库".into());
        }
        let target = rfd::FileDialog::new()
            .set_title("选择管理员专用的部署包导出位置")
            .pick_folder();
        target
            .map(|folder| write_bundle(&root, &folder, team_id, address, address_join))
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_keeps_live_wal_rows_and_leaves_old_watch_settings_intact() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("hosted-team")).unwrap();
        let source = Connection::open(root.path().join("hosted-team/team.sqlite3")).unwrap();
        source
            .execute_batch(
                "PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE team(singleton INTEGER PRIMARY KEY, id TEXT NOT NULL);
             CREATE TABLE watched_libraries(root TEXT);
             CREATE TABLE library_source_paths(unc TEXT);
             CREATE TABLE members(digest BLOB);
             INSERT INTO watched_libraries VALUES ('Z:/资产');
             INSERT INTO library_source_paths VALUES ('\\nas\\share');
             INSERT INTO members VALUES (X'010203');",
            )
            .unwrap();
        let team_id = uuid::Uuid::new_v4();
        source
            .execute("INSERT INTO team VALUES (1,?1)", [team_id.to_string()])
            .unwrap();
        let address = nas_address("http://192.168.1.24:47822").unwrap();
        let export = write_bundle(root.path(), target.path(), team_id, address, true).unwrap();
        let copy = Connection::open(export.directory.join("data/team.sqlite3")).unwrap();
        let digest: Vec<u8> = copy
            .query_row("SELECT digest FROM members", [], |row| row.get(0))
            .unwrap();
        assert_eq!(digest, [1, 2, 3]);
        for (db, expected) in [(&source, 1), (&copy, 0)] {
            let count: i64 = db
                .query_row("SELECT count(*) FROM watched_libraries", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, expected);
            let source_paths: i64 = db
                .query_row("SELECT count(*) FROM library_source_paths", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(source_paths, expected);
        }
        let compose = fs::read_to_string(export.directory.join("compose.yaml")).unwrap();
        assert!(compose.contains("192.168.1.24:47822"));
        assert!(compose.contains("      - --allow-address-join"));
        assert!(export.directory.join(".dockerignore").is_file());
        assert_eq!(
            fs::read(export.directory.join("src-tauri/src/thumbnail_cache.rs")).unwrap(),
            include_bytes!("thumbnail_cache.rs")
        );
        assert_eq!(
            fs::read(
                export
                    .directory
                    .join("src-tauri/src/bin/nexus-team/sources.rs")
            )
            .unwrap(),
            include_bytes!("bin/nexus-team/sources.rs")
        );
        for path in ["whiteboard.rs", "bin/nexus-team/whiteboard.rs"] {
            assert!(export.directory.join("src-tauri/src").join(path).is_file());
        }
        assert!(!export.directory.join("data/host.json").exists());
        assert!(nas_address("http://127.0.0.1:47822").is_err());
        assert!(nas_address("http://192.168.1.24:80").is_err());
    }
}
