use crate::asset_files::stage_copy;
use base64::{engine::general_purpose::STANDARD, Engine};
use nexus_core::{
    clean_path,
    team::{asset_format, relative_path, MAX_FILES},
    FileFingerprint,
};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, Metadata},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use walkdir::WalkDir;

pub(crate) const MAX_WHITEBOARD_FILES: usize = 64;
pub(crate) const MAX_WHITEBOARD_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WhiteboardFileBytes {
    pub(crate) name: String,
    pub(crate) base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WhiteboardFileReference {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) is_folder: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) library_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) unc: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WhiteboardFileReport {
    pub(crate) files: Vec<WhiteboardFileReference>,
    pub(crate) failed: usize,
    pub(crate) errors: Vec<String>,
    pub(crate) index_pending: bool,
}

impl WhiteboardFileReport {
    pub(crate) fn add(&mut self, source: &Path, result: Result<WhiteboardFileReference, String>) {
        match result {
            Ok(file) => self.files.push(file),
            Err(error) => {
                self.failed += 1;
                record_issue(&mut self.errors, source, error);
            }
        }
    }
}

fn path_key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

fn relative_to(path: &Path, root: &Path, root_handle: Option<&Handle>) -> Option<PathBuf> {
    let key = path_key(path);
    let root_key = path_key(root);
    if key.starts_with(root_key) {
        return Some(path.components().skip(root.components().count()).collect());
    }
    let root_handle = root_handle?;
    // A mounted drive and UNC path may refer to the same NAS directory.
    for ancestor in path.ancestors() {
        if Handle::from_path(ancestor).is_ok_and(|handle| &handle == root_handle) {
            return path.strip_prefix(ancestor).ok().map(Path::to_path_buf);
        }
    }
    None
}

pub(crate) fn share_path(path: &Path) -> Result<String, String> {
    let components = path
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()
        .ok_or("文件名无法在团队库中使用")?;
    if components.is_empty() {
        return Ok(String::new());
    }
    let relative = components.join("/");
    if components.len() > 32
        || components.iter().any(|part| part.starts_with('.'))
        || relative_path(&relative).is_none()
    {
        return Err("路径包含 NAS 索引无法使用的文件名或目录层级".into());
    }
    Ok(relative)
}

fn check_directory(path: &Path) -> Result<(), String> {
    let entry = fs::symlink_metadata(path).map_err(|error| format!("无法访问目标目录：{error}"))?;
    let actual = fs::canonicalize(path).map_err(|error| format!("无法打开目标目录：{error}"))?;
    if !entry.is_dir() || !ordinary_entry(&entry) || path_key(&actual) != path_key(path) {
        return Err("目标必须是团队共享目录中的实际文件夹".into());
    }
    Ok(())
}

pub(crate) fn team_destination(mount: &Path, folder: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = fs::canonicalize(mount).map_err(|_| "团队库挂载目录无法访问，请检查目录映射")?;
    let relative = if folder.is_empty() {
        PathBuf::new()
    } else {
        relative_path(folder).ok_or("目标文件夹路径无效")?
    };
    share_path(&relative)?;
    check_directory(&root.join(&relative))?;
    Ok((root, relative))
}

pub(crate) fn team_attachment_path(mount: &Path, path: &str) -> Result<(PathBuf, bool), String> {
    let relative = if path.is_empty() {
        PathBuf::new()
    } else {
        relative_path(path).ok_or("附件路径无效")?
    };
    share_path(&relative)?;
    let mut full = fs::canonicalize(mount).map_err(|_| "无法访问附件所在 NAS 目录")?;
    if !full.is_dir() {
        return Err("无法访问附件所在 NAS 目录".into());
    }
    let mut is_folder = true;
    let mut parts = relative.iter().peekable();
    while let Some(part) = parts.next() {
        full.push(part);
        let metadata =
            fs::symlink_metadata(&full).map_err(|_| "找不到附件，请检查 NAS 挂载或文件位置")?;
        is_folder = metadata.is_dir();
        if !ordinary_entry(&metadata) || (parts.peek().is_some() && !is_folder) {
            return Err("附件必须是 NAS 目录内的实际文件或文件夹".into());
        }
    }
    let actual = fs::canonicalize(&full).map_err(|_| "找不到附件，请检查 NAS 挂载或文件位置")?;
    if path_key(&actual) != path_key(&full) {
        return Err("附件必须是 NAS 目录内的实际文件或文件夹".into());
    }
    Ok((actual, is_folder))
}

pub(crate) fn mounted_folder(mount: &Path, canonical_folder: &Path) -> Option<PathBuf> {
    let root = fs::canonicalize(mount).ok()?;
    relative_to(
        canonical_folder,
        &root,
        Handle::from_path(&root).ok().as_ref(),
    )
}

pub(crate) fn create_team_folder(mount: &Path, parent: &str, name: &str) -> Result<String, String> {
    let component = relative_path(name)
        .filter(|path| path.components().count() == 1)
        .ok_or("文件夹名称无效")?;
    let (root, parent) = team_destination(mount, parent)?;
    let relative = parent.join(component);
    let logical = share_path(&relative)?;
    let target = root.join(relative);
    match fs::create_dir(&target) {
        Ok(()) => check_directory(&target)?,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err("已有同名文件或文件夹".into());
        }
        Err(error) => return Err(format!("无法在 NAS 新建文件夹：{error}")),
    }
    Ok(logical)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClassifiedTeamDrop {
    pub(crate) files: Vec<String>,
    pub(crate) folders: Vec<String>,
    pub(crate) local_paths: Vec<String>,
    pub(crate) errors: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamImportReport {
    pub(crate) copied: usize,
    pub(crate) existing: usize,
    pub(crate) directories_created: usize,
    pub(crate) skipped: usize,
    pub(crate) duplicates: usize,
    pub(crate) conflicts: usize,
    pub(crate) failed: usize,
    pub(crate) errors: Vec<String>,
    pub(crate) files: Vec<String>,
    pub(crate) folders: Vec<String>,
}

impl TeamImportReport {
    fn fail(&mut self, path: &Path, issue: impl std::fmt::Display) {
        self.failed += 1;
        record_issue(&mut self.errors, path, issue);
    }

    fn conflict(&mut self, path: &Path) {
        self.conflicts += 1;
        self.skipped += 1;
        record_issue(&mut self.errors, path, "目标位置已有同名文件或文件夹");
    }

    fn duplicate(&mut self) {
        self.duplicates += 1;
        self.skipped += 1;
    }
}

fn record_issue(issues: &mut Vec<String>, path: &Path, issue: impl std::fmt::Display) {
    if issues.len() < 100 {
        issues.push(format!("{}：{issue}", clean_path(path)));
    }
}

struct SelectedPath {
    path: PathBuf,
    directory: bool,
}

fn ordinary_entry(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    metadata.is_dir() || metadata.is_file()
}

fn selected_path(path: &Path) -> Result<SelectedPath, String> {
    if !path.is_absolute() {
        return Err("请选择绝对路径中的文件或文件夹".into());
    }
    let entry = fs::symlink_metadata(path).map_err(|error| format!("无法访问所选路径：{error}"))?;
    if !ordinary_entry(&entry) {
        return Err("请选择实际文件或文件夹".into());
    }
    Ok(SelectedPath {
        path: fs::canonicalize(path).map_err(|error| format!("无法读取所选路径：{error}"))?,
        directory: entry.is_dir(),
    })
}

pub(crate) fn classify_team_drop_paths(paths: Vec<String>) -> ClassifiedTeamDrop {
    let mut report = ClassifiedTeamDrop::default();
    let mut seen = HashSet::new();
    if paths.len() > MAX_FILES {
        report
            .errors
            .push(format!("单次最多处理 {MAX_FILES} 个拖入路径"));
        return report;
    }
    for source in paths.iter().map(Path::new) {
        match selected_path(source) {
            Ok(entry) if seen.insert(path_key(&entry.path)) => {
                let group = if entry.directory {
                    &mut report.folders
                } else {
                    &mut report.files
                };
                group.push(clean_path(&entry.path));
            }
            Ok(_) => {}
            Err(error) => record_issue(&mut report.errors, source, error),
        }
    }
    report
}

fn ensure_copy_directory(path: &Path, report: &mut TeamImportReport) -> Result<bool, String> {
    check_directory(path.parent().ok_or("无效的目标父目录")?)?;
    match fs::create_dir(path) {
        Ok(()) => report.directories_created += 1,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let entry = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if !entry.is_dir() || !ordinary_entry(&entry) {
                report.conflict(path);
                return Ok(false);
            }
        }
        Err(error) => return Err(format!("无法在 NAS 创建文件夹：{error}")),
    }
    check_directory(path)?;
    Ok(true)
}

fn same_file(source: &Path, target: &Path) -> bool {
    path_key(source) == path_key(target) || same_file::is_same_file(source, target).unwrap_or(false)
}

struct ContentCandidate {
    path: PathBuf,
    fingerprint: Option<FileFingerprint>,
}

#[derive(Default)]
struct ContentCandidates(HashMap<u64, Vec<ContentCandidate>>);

impl ContentCandidates {
    fn add(&mut self, path: PathBuf, size: u64) {
        self.0.entry(size).or_default().push(ContentCandidate {
            path,
            fingerprint: None,
        });
    }

    fn matches(&mut self, source: &Path, size: u64) -> Result<bool, String> {
        let Some(candidates) = self.0.get_mut(&size) else {
            return Ok(false);
        };
        let source_fingerprint = FileFingerprint::read(source, size)
            .map_err(|error| format!("无法验证源文件内容：{error}"))?;
        for candidate in candidates {
            // Keep indexed paths inside their original mount even if a directory was replaced.
            if !candidate
                .path
                .parent()
                .is_some_and(|parent| check_directory(parent).is_ok())
            {
                continue;
            }
            if !candidate
                .fingerprint
                .as_ref()
                .is_some_and(|saved| saved.still_matches(&candidate.path))
            {
                candidate.fingerprint = FileFingerprint::read(&candidate.path, size).ok();
            }
            if candidate.fingerprint.as_ref().is_some_and(|saved| {
                saved.digest == source_fingerprint.digest && saved.still_matches(&candidate.path)
            }) && source_fingerprint.still_matches(source)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

pub(crate) fn same_content(source: &Path, target: &Path, size: u64) -> Result<bool, String> {
    let Ok(target_fingerprint) = FileFingerprint::read(target, size) else {
        return Ok(false);
    };
    let source_fingerprint = FileFingerprint::read(source, size)
        .map_err(|error| format!("无法验证源文件内容：{error}"))?;
    Ok(source_fingerprint.digest == target_fingerprint.digest
        && source_fingerprint.still_matches(source)
        && target_fingerprint.still_matches(target))
}

struct CopyTarget<'a> {
    destination: &'a Path,
    staging: Option<TempDir>,
    candidates: ContentCandidates,
}

impl CopyTarget<'_> {
    fn publish_file(
        &mut self,
        source: &Path,
        target: &Path,
        check_library_duplicates: bool,
        report: &mut TeamImportReport,
    ) -> Result<bool, String> {
        let parent = target.parent().ok_or("无效的目标文件路径")?;
        check_directory(parent)?;
        let before = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
        if !before.is_file() || !ordinary_entry(&before) {
            return Err("源资产已更改，请重新选择文件".into());
        }
        match fs::symlink_metadata(target) {
            Ok(entry) if entry.is_file() && ordinary_entry(&entry) && same_file(source, target) => {
                report.existing += 1;
                return Ok(true);
            }
            Ok(entry) => {
                if entry.is_file()
                    && ordinary_entry(&entry)
                    && entry.len() == before.len()
                    && same_content(source, target, before.len())?
                {
                    report.duplicate();
                } else {
                    report.conflict(target);
                }
                return Ok(false);
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法检查 NAS 目标文件：{error}")),
        }
        if check_library_duplicates && self.candidates.matches(source, before.len())? {
            report.duplicate();
            return Ok(false);
        }
        let identity = Handle::from_path(source).ok();
        if self.staging.is_none() {
            check_directory(self.destination)?;
            self.staging = Some(
                tempfile::Builder::new()
                    .prefix(".nexus-import-")
                    .tempdir_in(self.destination)
                    .map_err(|error| format!("无法在 NAS 暂存文件：{error}"))?,
            );
        }
        let staging = self.staging.as_ref().unwrap().path();
        check_directory(staging)?;
        let staged = stage_copy(source, staging)?;
        let after = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
        if !ordinary_entry(&after)
            || !after.is_file()
            || before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
            || staged
                .as_file()
                .metadata()
                .map_err(|error| error.to_string())?
                .len()
                != before.len()
            || identity
                .is_some_and(|id| Handle::from_path(source).map_or(true, |current| current != id))
        {
            return Err("资产在复制时发生更改，请保存文件后重试".into());
        }
        check_directory(parent)?;
        check_directory(staging)?;
        match staged.persist_noclobber(target) {
            Ok(file) => {
                drop(file);
                report.copied += 1;
                Ok(true)
            }
            Err(error) if fs::symlink_metadata(target).is_ok() => {
                let staged_path = error.file.into_temp_path();
                if same_content(&staged_path, target, before.len())? {
                    report.duplicate();
                } else {
                    report.conflict(target);
                }
                Ok(false)
            }
            Err(error) => Err(format!("无法写入 NAS 目标文件：{}", error.error)),
        }
    }
}

pub(crate) fn whiteboard_file_batch_size(count: usize) -> Result<(), String> {
    if !(1..=MAX_WHITEBOARD_FILES).contains(&count) {
        return Err(format!("每次请选择 1 到 {MAX_WHITEBOARD_FILES} 个附件文件"));
    }
    Ok(())
}

fn publish_whiteboard_file(
    target: &mut CopyTarget<'_>,
    folder: &Path,
    source: &Path,
    name: &str,
) -> Result<WhiteboardFileReference, String> {
    let valid_name = relative_path(name).filter(|path| path.components().count() == 1);
    if valid_name.is_none() || name.starts_with('.') || name.encode_utf16().count() > 240 {
        return Err("附件名称无效或过长".into());
    }
    let filename = Path::new(name);
    let stem = filename
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let extension = filename.extension().and_then(|value| value.to_str());
    for number in 1..=1000 {
        let candidate = if number == 1 {
            name.to_owned()
        } else if let Some(extension) = extension {
            format!("{stem} ({number}).{extension}")
        } else {
            format!("{stem} ({number})")
        };
        let relative = share_path(&folder.join(&candidate))?;
        let destination = target.destination.join(&candidate);
        let mut result = TeamImportReport::default();
        let published = target.publish_file(source, &destination, false, &mut result)?;
        if published || result.duplicates != 0 {
            return Ok(WhiteboardFileReference {
                name: candidate,
                is_folder: None,
                library_id: None,
                path: Some(relative),
                unc: None,
            });
        }
    }
    Err("目标位置存在过多同名附件".into())
}

pub(crate) fn import_whiteboard_files(
    mount: &Path,
    folder: &str,
    paths: Vec<String>,
    files: Vec<WhiteboardFileBytes>,
) -> Result<WhiteboardFileReport, String> {
    whiteboard_file_batch_size(paths.len() + files.len())?;
    let (root, relative) = team_destination(mount, folder)?;
    let destination = root.join(&relative);
    let mut target = CopyTarget {
        destination: &destination,
        staging: None,
        candidates: ContentCandidates::default(),
    };
    let mut report = WhiteboardFileReport::default();
    for path in paths {
        let source = Path::new(&path);
        let result = selected_path(source).and_then(|selected| {
            if selected.directory {
                return Err("请选择文件作为白板附件".into());
            }
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or("无法识别附件名称")?;
            publish_whiteboard_file(&mut target, &relative, &selected.path, name)
        });
        report.add(source, result);
    }
    let mut remaining = MAX_WHITEBOARD_FILE_BYTES;
    for file in files {
        let result = (|| {
            if file.base64.len() > remaining.div_ceil(3) * 4 {
                return Err("浏览器附件单次最多 16 MB".into());
            }
            let decoded = STANDARD
                .decode(&file.base64)
                .map_err(|_| "无法读取浏览器附件")?;
            remaining = remaining
                .checked_sub(decoded.len())
                .ok_or("浏览器附件单次最多 16 MB")?;
            let mut source = tempfile::NamedTempFile::new().map_err(|error| error.to_string())?;
            source
                .write_all(&decoded)
                .map_err(|error| error.to_string())?;
            let source = source.into_temp_path();
            publish_whiteboard_file(&mut target, &relative, &source, &file.name)
        })();
        report.add(Path::new(&file.name), result);
    }
    Ok(report)
}

pub(crate) fn import_team_paths(
    mount: &Path,
    destination: &str,
    paths: Vec<String>,
    indexed: impl IntoIterator<Item = (String, u64)>,
    mut progress: impl FnMut(usize),
) -> Result<TeamImportReport, String> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(format!("请选择 1 到 {MAX_FILES} 个文件或文件夹"));
    }
    let (root, relative_destination) = team_destination(mount, destination)?;
    let folder = root.join(&relative_destination);
    let mut target = CopyTarget {
        destination: &folder,
        staging: None,
        candidates: ContentCandidates::default(),
    };
    for (path, size) in indexed {
        if let Some(path) = relative_path(&path).filter(|path| share_path(path).is_ok()) {
            target.candidates.add(root.join(path), size);
        }
    }
    let mut report = TeamImportReport::default();
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for source in paths.iter().map(Path::new) {
        match selected_path(source) {
            Ok(entry) if seen.insert(path_key(&entry.path)) => sources.push(entry),
            Ok(_) => report.skipped += 1,
            Err(error) => report.fail(source, error),
        }
    }
    sources.sort_by_key(|entry| entry.path.components().count());
    let mut parents = Vec::<PathBuf>::new();
    let mut processed = 0;
    for selected in sources {
        let source = &selected.path;
        let source_key = path_key(source);
        if parents.iter().any(|parent| source_key.starts_with(parent)) {
            report.skipped += 1;
            continue;
        }
        let Some(name) = source.file_name() else {
            report.fail(source, "无法识别拖入项目的名称");
            continue;
        };
        let source_is_destination = selected.directory && same_file(source, &folder);
        let base = if source_is_destination {
            relative_destination.clone()
        } else {
            relative_destination.join(name)
        };
        let in_place = source_is_destination || same_file(source, &root.join(&base));
        if selected.directory
            && !in_place
            && relative_to(&folder, source, Handle::from_path(source).ok().as_ref()).is_some()
        {
            report.fail(source, "无法将文件夹导入到自己的子目录");
            continue;
        }
        if let Err(error) = share_path(&base) {
            report.fail(source, error);
            continue;
        }
        if selected.directory {
            parents.push(source_key);
        }

        let mut tree = WalkDir::new(source)
            .follow_links(false)
            .follow_root_links(false)
            .into_iter();
        while let Some(entry) = tree.next() {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    report.fail(error.path().unwrap_or(source), &error);
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    report.fail(path, error);
                    if entry.file_type().is_dir() {
                        tree.skip_current_dir();
                    }
                    continue;
                }
            };
            if !ordinary_entry(&metadata) || entry.file_name().to_string_lossy().starts_with('.') {
                report.skipped += 1;
                if entry.file_type().is_dir() {
                    tree.skip_current_dir();
                }
                continue;
            }
            if entry.depth() == 0 && metadata.is_dir() != selected.directory {
                report.fail(path, "源路径类型已更改，请重新选择");
                if metadata.is_dir() {
                    tree.skip_current_dir();
                }
                continue;
            }
            let child = path
                .strip_prefix(source)
                .map_err(|error| error.to_string())?;
            let relative = if child.as_os_str().is_empty() {
                base.clone()
            } else {
                base.join(child)
            };
            let shared = match share_path(&relative) {
                Ok(shared) => shared,
                Err(error) => {
                    report.fail(path, error);
                    if metadata.is_dir() {
                        tree.skip_current_dir();
                    }
                    continue;
                }
            };
            let destination = root.join(relative);
            if metadata.is_dir() {
                let ready = if in_place {
                    check_directory(&destination).map(|()| true)
                } else {
                    ensure_copy_directory(&destination, &mut report)
                };
                match ready {
                    Ok(true) if !shared.is_empty() => report.folders.push(shared),
                    Ok(true) => {}
                    Ok(false) => tree.skip_current_dir(),
                    Err(error) => {
                        report.fail(&destination, error);
                        tree.skip_current_dir();
                    }
                }
                continue;
            }
            let indexable = asset_format(&shared).is_some();
            let extension = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_ascii_lowercase);
            let sidecar = matches!(extension.as_deref(), Some("bin" | "xmp"));
            if !selected.directory && !indexable && !sidecar {
                report.skipped += 1;
                let reason = match extension.as_deref() {
                    Some("crdownload" | "download" | "part" | "aria2") => {
                        "文件仍为下载临时文件，请下载完成后再拖入".to_owned()
                    }
                    Some(extension) => format!("当前支持的资产格式不包含 .{extension}"),
                    None => "缺少可识别的文件扩展名".to_owned(),
                };
                record_issue(&mut report.errors, path, reason);
                continue;
            }
            match target.publish_file(
                path,
                &destination,
                indexable && !selected.directory,
                &mut report,
            ) {
                Ok(true) if indexable => {
                    target.candidates.add(destination, metadata.len());
                    report.files.push(shared);
                }
                Ok(_) => {}
                Err(error) => report.fail(path, error),
            }
            processed += 1;
            if processed % 100 == 0 {
                progress(processed);
            }
        }
    }
    report.files.sort_unstable();
    report.files.dedup();
    report.folders.sort_unstable();
    report.folders.dedup();
    progress(processed);
    Ok(report)
}

#[cfg(test)]
mod tests {
    #[test]
    fn whiteboard_import_keeps_unindexed_files_and_avoids_name_conflicts() {
        let root = tempfile::tempdir().unwrap();
        let mount = root.path().join("nas");
        let inbox = mount.join("白板附件");
        fs::create_dir_all(&inbox).unwrap();
        let input = root.path().join("报告.docx");
        fs::write(&input, b"Explorer file").unwrap();
        let browser_file = |name: &str, content: &[u8]| WhiteboardFileBytes {
            name: name.into(),
            base64: STANDARD.encode(content),
        };
        let report = import_whiteboard_files(
            &mount,
            "白板附件",
            vec![clean_path(&input)],
            vec![
                browser_file("报告.docx", b"Browser file"),
                browser_file("报告.docx", b"Explorer file"),
                browser_file("../outside.txt", b"outside"),
            ],
        )
        .unwrap();
        assert_eq!(report.failed, 1, "{:?}", report.errors);
        assert_eq!(report.files.len(), 3);
        assert_eq!(report.files[0].path.as_deref(), Some("白板附件/报告.docx"));
        assert_eq!(
            report.files[1].path.as_deref(),
            Some("白板附件/报告 (2).docx")
        );
        assert_eq!(report.files[2].path, report.files[0].path);
        assert_eq!(fs::read(inbox.join("报告.docx")).unwrap(), b"Explorer file");
        assert_eq!(
            fs::read(inbox.join("报告 (2).docx")).unwrap(),
            b"Browser file"
        );
        assert_eq!(fs::read(&input).unwrap(), b"Explorer file");
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 2);
        let (file, is_folder) = team_attachment_path(&mount, "白板附件/报告 (2).docx").unwrap();
        assert!(!is_folder);
        assert!(same_file::is_same_file(file, inbox.join("报告 (2).docx")).unwrap());
        assert!(team_attachment_path(&mount, "../报告.docx").is_err());
        assert!(team_attachment_path(&mount, "白板附件/报告.docx/child").is_err());
        let (selected, is_folder) = team_attachment_path(&mount, "白板附件").unwrap();
        assert!(is_folder);
        assert!(same_file::is_same_file(selected, inbox).unwrap());
        let (root, is_folder) = team_attachment_path(&mount, "").unwrap();
        assert!(is_folder);
        assert!(same_file::is_same_file(root, mount).unwrap());
    }

    use super::*;

    fn paths(items: &[&Path]) -> Vec<String> {
        items.iter().map(|path| clean_path(path)).collect()
    }

    #[test]
    fn video_downloads_copy_and_skips_name_file_and_reason() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("共享");
        fs::create_dir(&mount).unwrap();
        let video = temp.path().join("完整.WEBM");
        let partial = temp.path().join("尚未完成.webm.crdownload");
        let shortcut = temp.path().join("浏览器链接.url");
        let no_extension = temp.path().join("无扩展名");
        for file in [&video, &partial, &shortcut, &no_extension] {
            fs::write(file, b"test file").unwrap();
        }
        let report = import_team_paths(
            &mount,
            "",
            paths(&[&video, &partial, &shortcut, &no_extension]),
            [],
            |_| {},
        )
        .unwrap();
        assert_eq!((report.copied, report.skipped, report.failed), (1, 3, 0));
        assert_eq!(report.files, ["完整.WEBM"]);
        assert_eq!(report.errors.len(), 3);
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("尚未完成.webm.crdownload")
                && error.contains("下载临时文件")));
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("浏览器链接.url") && error.contains(".url")));
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("无扩展名") && error.contains("缺少可识别")));
        assert!(mount.join("完整.WEBM").is_file());
        assert_eq!(fs::read_dir(&mount).unwrap().count(), 1);
    }

    #[test]
    fn mixed_drop_copies_media_and_complete_folder_hierarchy_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("共享");
        let destination = mount.join("选中的目录");
        let source = temp.path().join("包");
        let media = temp.path().join("片段.MP4");
        let existing = temp.path().join("保留.png");
        let missing = temp.path().join("不存在");
        fs::create_dir_all(&destination).unwrap();
        fs::create_dir_all(source.join("嵌套/空目录")).unwrap();
        fs::create_dir(source.join(".nexus")).unwrap();
        fs::write(source.join("嵌套/模型.obj"), b"mesh").unwrap();
        fs::write(source.join("嵌套/模型.bin"), b"companion").unwrap();
        fs::write(source.join(".nexus/private.obj"), b"metadata").unwrap();
        fs::write(&media, b"video").unwrap();
        fs::write(&existing, b"would overwrite").unwrap();
        fs::write(destination.join("保留.png"), b"original").unwrap();
        let selected = paths(&[&source, &media, &existing, &missing, &media]);
        let classified = classify_team_drop_paths(selected.clone());
        assert_eq!(classified.files, paths(&[&media, &existing]));
        assert_eq!(classified.folders, paths(&[&source]));
        assert_eq!(classified.errors.len(), 1);

        let imported = import_team_paths(&mount, "选中的目录", selected, [], |_| {}).unwrap();
        assert_eq!(
            (
                imported.copied,
                imported.directories_created,
                imported.conflicts,
                imported.failed
            ),
            (3, 3, 1, 1)
        );
        assert_eq!(
            imported.files,
            ["选中的目录/包/嵌套/模型.obj", "选中的目录/片段.MP4"]
        );
        assert!(imported
            .folders
            .contains(&"选中的目录/包/嵌套/空目录".to_owned()));
        assert!(destination.join("包/嵌套/空目录").is_dir());
        assert_eq!(
            fs::read(destination.join("包/嵌套/模型.bin")).unwrap(),
            b"companion"
        );
        assert_eq!(fs::read(destination.join("保留.png")).unwrap(), b"original");
        assert_eq!(fs::read(destination.join("片段.MP4")).unwrap(), b"video");
        assert_eq!(fs::read(&media).unwrap(), b"video");
        assert!(!destination.join("包/.nexus").exists());
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 3);
    }

    #[test]
    fn import_within_same_mount_uses_the_selected_destination_and_skips_the_same_file() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("share");
        let src = mount.join("来源/片段.mp4");
        let dest = mount.join("目标/片段.mp4");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&src, b"video").unwrap();

        let initial = import_team_paths(&mount, "目标", paths(&[&src]), [], |_| {}).unwrap();
        assert_eq!(initial.copied, 1);
        assert_eq!(fs::read(&dest).unwrap(), b"video");
        let same = import_team_paths(&mount, "目标", paths(&[&dest]), [], |_| {}).unwrap();
        assert_eq!((same.copied, same.existing), (0, 1));
        assert_eq!(same.files, ["目标/片段.mp4"]);
        let repeated = import_team_paths(&mount, "目标", paths(&[&src]), [], |_| {}).unwrap();
        assert_eq!(
            (repeated.copied, repeated.duplicates, repeated.conflicts),
            (0, 1, 0)
        );

        let in_place =
            import_team_paths(&mount, "目标", paths(&[dest.parent().unwrap()]), [], |_| {})
                .unwrap();
        assert_eq!((in_place.copied, in_place.existing), (0, 1));
        assert!(!mount.join("目标/目标").exists());
        let recursive = import_team_paths(&mount, "目标", paths(&[&mount]), [], |_| {}).unwrap();
        assert_eq!((recursive.copied, recursive.failed), (0, 1));
        assert!(!mount.join("目标/share").exists());
    }

    #[test]
    fn compares_indexed_library_content_and_new_copies_in_the_same_batch() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("share");
        let destination = mount.join("destination");
        fs::create_dir_all(mount.join("other-folder")).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(mount.join("other-folder/original.png"), b"duplicate").unwrap();
        let renamed = temp.path().join("renamed.png");
        let first = temp.path().join("first.png");
        let repeated = temp.path().join("repeated.png");
        fs::write(&renamed, b"duplicate").unwrap();
        fs::write(&first, b"different").unwrap();
        fs::write(&repeated, b"different").unwrap();

        let report = import_team_paths(
            &mount,
            "destination",
            paths(&[&renamed, &first, &repeated]),
            [
                ("missing.png".into(), 9),
                ("other-folder/original.png".into(), 9),
            ],
            |_| {},
        )
        .unwrap();

        assert_eq!((report.copied, report.duplicates, report.failed), (1, 2, 0));
        assert_eq!(report.files, ["destination/first.png"]);
        assert_eq!(
            fs::read(destination.join("first.png")).unwrap(),
            b"different"
        );
        assert!(!destination.join("renamed.png").exists());
        assert!(!destination.join("repeated.png").exists());
    }

    #[test]
    fn keeps_folder_dependencies_at_their_relative_paths() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("share");
        let bundle = temp.path().join("bundle");
        fs::create_dir_all(&mount).unwrap();
        fs::create_dir_all(&bundle).unwrap();
        fs::write(mount.join("existing.png"), b"texture").unwrap();
        for name in ["base-color.png", "detail.png"] {
            fs::write(bundle.join(name), b"texture").unwrap();
        }

        let report = import_team_paths(
            &mount,
            "",
            paths(&[&bundle]),
            [("existing.png".into(), 7)],
            |_| {},
        )
        .unwrap();

        assert_eq!((report.copied, report.duplicates), (2, 0));
        for name in ["base-color.png", "detail.png"] {
            assert_eq!(
                fs::read(mount.join("bundle").join(name)).unwrap(),
                b"texture"
            );
        }
    }

    #[test]
    fn concurrent_same_name_imports_preserve_the_first_published_file() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("share");
        fs::create_dir_all(&mount).unwrap();
        let import = |directory, contents| {
            let source = temp.path().join(directory).join("asset.png");
            fs::create_dir_all(source.parent().unwrap()).unwrap();
            fs::write(&source, contents).unwrap();
            source
        };
        let first = import("first", b"1111");
        let identical = import("identical", b"1111");
        let conflict = import("conflict", b"2222");
        let gate = std::sync::Barrier::new(2);
        let import = |path: &Path| {
            gate.wait();
            import_team_paths(&mount, "", paths(&[path]), [], |_| {}).unwrap()
        };
        let results = std::thread::scope(|scope| {
            let one = scope.spawn(|| import(&first));
            let two = import(&identical);
            (one.join().unwrap(), two)
        });
        assert_eq!(results.0.copied + results.1.copied, 1);
        assert_eq!(results.0.duplicates + results.1.duplicates, 1);
        let conflicting = import_team_paths(&mount, "", paths(&[&conflict]), [], |_| {}).unwrap();
        assert_eq!(
            (
                conflicting.copied,
                conflicting.duplicates,
                conflicting.conflicts
            ),
            (0, 0, 1)
        );
        assert_eq!(fs::read(mount.join("asset.png")).unwrap(), b"1111");
    }

    #[test]
    fn creates_nested_team_folders_without_overwriting_or_escaping() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("share");
        fs::create_dir(&mount).unwrap();

        assert_eq!(create_team_folder(&mount, "", "模型").unwrap(), "模型");
        assert_eq!(
            create_team_folder(&mount, "模型", "草稿").unwrap(),
            "模型/草稿"
        );
        assert!(mount.join("模型/草稿").is_dir());
        fs::write(mount.join("occupied"), b"existing").unwrap();
        assert!(create_team_folder(&mount, "", "occupied").is_err());
        assert!(create_team_folder(&mount, "模型", "草稿").is_err());
        assert!(create_team_folder(&mount, "模型", "nested/new").is_err());
        assert!(create_team_folder(&mount, "模型", ".hidden").is_err());
        assert!(create_team_folder(&mount, "..", "escape").is_err());
        assert!(!temp.path().join("escape").exists());
        assert_eq!(fs::read(mount.join("occupied")).unwrap(), b"existing");
    }

    #[test]
    fn resolves_only_directories_within_the_mount() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("share");
        let child = mount.join("models/empty");
        fs::create_dir_all(&child).unwrap();
        let canonical = fs::canonicalize(&child).unwrap();
        assert_eq!(
            mounted_folder(&mount, &canonical),
            Some(PathBuf::from("models/empty"))
        );
        assert!(mounted_folder(&mount, &fs::canonicalize(temp.path()).unwrap()).is_none());
        assert!(team_destination(&mount, "models/empty").is_ok());
        assert!(team_destination(&mount, "../escape").is_err());
        assert!(team_destination(&mount, ".nexus").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_destination_links() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("share");
        let outside = temp.path().join("external");
        fs::create_dir(&mount).unwrap();
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, mount.join("escape")).unwrap();
        assert!(team_destination(&mount, "escape").is_err());
    }
}
