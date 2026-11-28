use crate::{folder_browser, launch_folder_location, reveal_path};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;

mod places;

#[tauri::command]
pub(crate) async fn local_explorer_places(app: tauri::AppHandle) -> Result<places::Places, String> {
    places::list(&app)
}

#[tauri::command]
pub(crate) async fn local_explorer_drive_details(
    path: String,
) -> Result<places::DriveDetails, String> {
    places::drive_details(path).await
}

const PAGE_SIZE: usize = 250;
const TREE_COMPLETION_LIMIT: usize = 12;
pub(super) const MAX_ENTRIES: usize = 20_000;
const READ_TIMEOUT: Duration = Duration::from_secs(8);
const DIRECTORY_TTL: Duration = Duration::from_secs(5);
const MAX_CACHED_DIRECTORIES: usize = 8;
const MAX_CACHED_ENTRIES: usize = 60_000;
static DIRECTORIES: LazyLock<DirectoryCache> = LazyLock::new(DirectoryCache::default);
const TREE_READ_TIMEOUT: Duration = Duration::from_secs(5);
static TREE_READ_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

enum Address {
    Path(PathBuf),
    #[cfg(windows)]
    Host(String),
}

pub(crate) fn shell_folder_address(value: &str) -> Option<String> {
    // The shell command appends a dot segment so a drive root's backslash
    // cannot escape the closing command-line quote.
    let value = value.strip_suffix(r"\.").unwrap_or(value);
    match parse_address(value).ok()? {
        Address::Path(path) => path.into_os_string().into_string().ok(),
        #[cfg(windows)]
        Address::Host(host) => Some(host),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalFileListing {
    directory: Option<String>,
    parent: Option<String>,
    selected_path: Option<String>,
    entries: Vec<LocalFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    matched_entries: Option<Vec<LocalFile>>,
    total: usize,
    offset: usize,
    previous_offset: Option<usize>,
    next_offset: Option<usize>,
    truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFile {
    name: String,
    path: String,
    is_directory: bool,
    size: Option<u64>,
    modified: Option<u64>,
    created: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalFileSelection {
    entries: Vec<SelectionEntry>,
    total: usize,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionEntry {
    name: String,
    path: String,
    is_directory: bool,
    size: Option<u64>,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListingOrder {
    #[serde(default)]
    sort_by: SortBy,
    #[serde(default)]
    descending: bool,
    date_groups: Option<[u64; 4]>,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum SortBy {
    #[default]
    Name,
    Date,
    Created,
    Type,
    Size,
}

#[derive(Clone, Copy, Default)]
struct ListingPage<'a> {
    offset: Option<usize>,
    order: ListingOrder,
    query: Option<&'a str>,
    project_filter: Option<&'a ProjectFileFilter>,
    remembered_path: Option<&'a str>,
    locate_paths: Option<&'a [String]>,
    show_hidden: bool,
}

#[derive(serde::Deserialize)]
pub(crate) struct ProjectFileFilter {
    #[serde(default)]
    name: String,
    #[serde(default)]
    extensions: Vec<String>,
}

impl ProjectFileFilter {
    fn validated(mut self) -> Result<Option<Self>, String> {
        self.name = self.name.trim().to_lowercase();
        if self.name.chars().count() > 96
            || self.name.chars().any(char::is_control)
            || self.extensions.len() > 12
        {
            return Err("项目筛选内容超过限制".into());
        }
        for value in &mut self.extensions {
            *value = value.trim().trim_start_matches('.').to_ascii_lowercase();
            if value.is_empty()
                || value.len() > 16
                || !value.bytes().all(|unit| unit.is_ascii_alphanumeric())
            {
                return Err("文件扩展名格式无效".into());
            }
        }
        Ok((!self.name.is_empty() || !self.extensions.is_empty()).then_some(self))
    }

    fn matches(&self, file: &LocalFile) -> bool {
        file.is_directory
            || ((self.name.is_empty() || matches_query(file, &self.name))
                && (self.extensions.is_empty()
                    || Path::new(&file.name)
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| {
                            self.extensions
                                .iter()
                                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
                        })))
    }
}

impl LocalFile {
    fn folder(name: String, path: String) -> Self {
        Self {
            name,
            path,
            is_directory: true,
            size: None,
            modified: None,
            created: None,
        }
    }

    fn set_details(&mut self, metadata: fs::Metadata) {
        self.size = (!self.is_directory && metadata.is_file()).then(|| metadata.len());
        self.modified = metadata.modified().ok().and_then(epoch_millis);
        self.created = metadata.created().ok().and_then(epoch_millis);
    }
}

fn epoch_millis(time: SystemTime) -> Option<u64> {
    u64::try_from(time.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
}

#[cfg(windows)]
pub(crate) fn visible_windows_entry(metadata: &fs::Metadata, show_hidden: bool) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM};

    let attributes = metadata.file_attributes();
    attributes & FILE_ATTRIBUTE_SYSTEM.0 == 0
        && (show_hidden || attributes & FILE_ATTRIBUTE_HIDDEN.0 == 0)
}

struct DirectorySnapshot {
    entries: Vec<LocalFile>,
    truncated: bool,
    modified: Option<SystemTime>,
    created: Instant,
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct DirectoryKey {
    path: PathBuf,
    show_hidden: bool,
}

#[derive(Default)]
struct DirectoryCacheState {
    directories: VecDeque<(DirectoryKey, Arc<DirectorySnapshot>)>,
    scanning: HashMap<DirectoryKey, u64>,
    revision: u64,
}

#[derive(Default)]
struct DirectoryCache(Mutex<DirectoryCacheState>);

impl DirectoryCache {
    fn get(&self, path: &Path, show_hidden: bool) -> Option<Arc<DirectorySnapshot>> {
        let mut state = self.0.lock().ok()?;
        state
            .directories
            .retain(|(_, snapshot)| snapshot.created.elapsed() < DIRECTORY_TTL);
        let index = state
            .directories
            .iter()
            .position(|(key, _)| key.path == path && key.show_hidden == show_hidden)?;
        let stored = state.directories.remove(index)?;
        let snapshot = Arc::clone(&stored.1);
        state.directories.push_back(stored);
        Some(snapshot)
    }

    fn invalidate(&self, path: &Path) {
        if let Ok(mut state) = self.0.lock() {
            state.directories.retain(|(key, _)| key.path != path);
            state.scanning.retain(|key, _| key.path != path);
        }
    }

    fn begin(&self, path: &Path, show_hidden: bool) -> DirectoryScan<'_> {
        let key = DirectoryKey {
            path: path.to_owned(),
            show_hidden,
        };
        let revision = self.0.lock().ok().map(|mut state| {
            state.revision += 1;
            let revision = state.revision;
            state.scanning.insert(key.clone(), revision);
            revision
        });
        DirectoryScan {
            cache: self,
            key,
            revision,
        }
    }
}

struct DirectoryScan<'a> {
    cache: &'a DirectoryCache,
    key: DirectoryKey,
    revision: Option<u64>,
}

impl DirectoryScan<'_> {
    fn store(&self, snapshot: Arc<DirectorySnapshot>, cancelled: &AtomicBool) {
        let Ok(mut state) = self.cache.0.lock() else {
            return;
        };
        if self.revision.is_none()
            || state.scanning.get(&self.key).copied() != self.revision
            || cancelled.load(Ordering::Acquire)
        {
            return;
        }
        state
            .directories
            .retain(|(key, cached)| *key != self.key && cached.created.elapsed() < DIRECTORY_TTL);
        let mut entries = snapshot.entries.len()
            + state
                .directories
                .iter()
                .map(|(_, cached)| cached.entries.len())
                .sum::<usize>();
        while state.directories.len() >= MAX_CACHED_DIRECTORIES || entries > MAX_CACHED_ENTRIES {
            let Some((_, evicted)) = state.directories.pop_front() else {
                break;
            };
            entries -= evicted.entries.len();
        }
        state.directories.push_back((self.key.clone(), snapshot));
    }
}

impl Drop for DirectoryScan<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.cache.0.lock() {
            if state.scanning.get(&self.key).copied() == self.revision {
                state.scanning.remove(&self.key);
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn list_local_files(
    app: tauri::AppHandle,
    address: Option<String>,
    offset: Option<usize>,
    refresh: Option<bool>,
    order: Option<ListingOrder>,
    query: Option<String>,
    project_filter: Option<ProjectFileFilter>,
    remembered_path: Option<String>,
    show_hidden: Option<bool>,
    locate_paths: Option<Vec<String>>,
) -> Result<LocalFileListing, String> {
    let order = order.unwrap_or_default();
    let query = normalized_query(query);
    let project_filter = project_filter
        .map(ProjectFileFilter::validated)
        .transpose()?
        .flatten();
    let remembered_path = remembered_path.filter(|path| path.len() <= 32_768);
    let locate_paths = locate_paths.map(validated_locate_paths).transpose()?;
    let show_hidden = cfg!(windows) && show_hidden.unwrap_or_default();
    let Some(address) = address.filter(|value| !value.trim().is_empty()) else {
        let drives = folder_browser::root_listing(&app)?;
        return finish_listing(
            None,
            None,
            None,
            drives
                .folders
                .into_iter()
                .map(|folder| LocalFile::folder(folder.name, folder.path))
                .collect(),
            false,
            &AtomicBool::new(false),
            ListingPage {
                offset,
                order,
                query: query.as_deref(),
                locate_paths: locate_paths.as_deref(),
                show_hidden,
                ..ListingPage::default()
            },
        );
    };
    let address = parse_address(&address)?;
    let refresh = refresh.unwrap_or(false);
    match &address {
        Address::Path(path) => {
            if refresh {
                DIRECTORIES.invalidate(path);
            }
            // Windows directory enumeration already supplied the row metadata.
            // A cached page does not need to wait for a filesystem worker slot.
            #[cfg(windows)]
            if !refresh && offset.is_some() {
                if let Some(snapshot) = DIRECTORIES.get(path, show_hidden) {
                    return directory_page(
                        path,
                        &snapshot,
                        None,
                        &AtomicBool::new(false),
                        ListingPage {
                            offset,
                            order,
                            query: query.as_deref(),
                            project_filter: project_filter.as_ref(),
                            remembered_path: remembered_path.as_deref(),
                            locate_paths: locate_paths.as_deref(),
                            show_hidden,
                        },
                    );
                }
            }
        }
        #[cfg(windows)]
        Address::Host(_) => {}
    }
    folder_browser::read_location(READ_TIMEOUT, move |cancelled| {
        let page = ListingPage {
            offset,
            order,
            query: query.as_deref(),
            project_filter: project_filter.as_ref(),
            remembered_path: remembered_path.as_deref(),
            locate_paths: locate_paths.as_deref(),
            show_hidden,
        };
        match address {
            Address::Path(path) => list_path(&path, refresh, &DIRECTORIES, cancelled, page),
            #[cfg(windows)]
            Address::Host(host) => list_shares(&host, cancelled, page),
        }
    })
    .await
}

fn normalized_query(query: Option<String>) -> Option<String> {
    query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

fn matches_query(entry: &LocalFile, query: &str) -> bool {
    entry.name.to_lowercase().contains(query)
}

#[tauri::command]
pub(crate) async fn local_explorer_tree_children(
    path: String,
    show_hidden: Option<bool>,
    active_child: Option<String>,
    prefix: Option<String>,
) -> Result<Vec<folder_browser::FolderEntry>, String> {
    let address = parse_address(&path)?;
    if prefix.as_ref().is_some_and(|value| {
        value.chars().count() > 255
            || value.contains(['\\', '/'])
            || value.chars().any(char::is_control)
    }) {
        return Err("请输入有效的文件夹名称".into());
    }
    let prefix = prefix.map(|value| value.to_lowercase());
    let active_child = active_child.and_then(|path| match parse_address(&path).ok()? {
        Address::Path(path) => Some(path),
        #[cfg(windows)]
        Address::Host(_) => None,
    });
    let show_hidden = cfg!(windows) && show_hidden.unwrap_or_default();
    folder_browser::read_with_slots(&TREE_READ_SLOTS, TREE_READ_TIMEOUT, move |cancelled| {
        match address {
            Address::Path(path) => read_tree_children(
                &path,
                show_hidden,
                active_child.as_deref(),
                prefix.as_deref(),
                &DIRECTORIES,
                cancelled,
            ),
            #[cfg(windows)]
            Address::Host(host) => {
                let (mut shares, _) = read_shares(&host, cancelled)?;
                sort_entries(&mut shares);
                Ok(tree_entries(
                    &shares,
                    active_child.as_deref(),
                    prefix.as_deref(),
                    || None,
                ))
            }
        }
    })
    .await
}

fn read_tree_children(
    directory: &Path,
    show_hidden: bool,
    active_child: Option<&Path>,
    prefix: Option<&str>,
    cache: &DirectoryCache,
    cancelled: &AtomicBool,
) -> Result<Vec<folder_browser::FolderEntry>, String> {
    let metadata = fs::metadata(directory).map_err(location_error)?;
    if !metadata.is_dir() {
        return Err("请选择文件夹".into());
    }
    let snapshot = directory_snapshot(
        directory,
        metadata.modified().ok(),
        false,
        show_hidden,
        cache,
        cancelled,
    )?;
    check_cancelled(cancelled)?;
    Ok(tree_entries(
        &snapshot.entries,
        active_child,
        prefix,
        || {
            if !snapshot.truncated || cancelled.load(Ordering::Acquire) {
                return None;
            }
            direct_tree_child(directory, active_child?, show_hidden)
        },
    ))
}

fn tree_entries(
    entries: &[LocalFile],
    active_child: Option<&Path>,
    prefix: Option<&str>,
    include_beyond_snapshot: impl FnOnce() -> Option<folder_browser::FolderEntry>,
) -> Vec<folder_browser::FolderEntry> {
    let folder_from_entry = |entry: &LocalFile| folder_browser::FolderEntry {
        name: entry.name.clone(),
        path: entry.path.clone(),
    };
    let directories = || entries.iter().filter(|entry| entry.is_directory);
    if let Some(prefix) = prefix {
        return directories()
            .filter(|entry| entry.name.to_lowercase().starts_with(prefix))
            .take(TREE_COMPLETION_LIMIT)
            .map(folder_from_entry)
            .collect();
    }
    let mut folders: Vec<_> = directories()
        .take(PAGE_SIZE)
        .map(folder_from_entry)
        .collect();
    let Some(active_child) = active_child else {
        return folders;
    };
    let active_path = nexus_core::clean_path(active_child);
    let matches_active = |path: &str| {
        same_entry(
            nexus_core::clean_path(Path::new(path)).trim_end_matches(['\\', '/']),
            active_path.trim_end_matches(['\\', '/']),
        )
    };
    if folders.iter().any(|folder| matches_active(&folder.path)) {
        return folders;
    }
    let selected = directories()
        .skip(PAGE_SIZE)
        .find(|entry| matches_active(&entry.path))
        .map(folder_from_entry)
        .or_else(include_beyond_snapshot);
    if let Some(selected) = selected {
        if folders.len() == PAGE_SIZE {
            folders.pop();
        }
        folders.push(selected);
        folders.sort_by_cached_key(|folder| (folder.name.to_lowercase(), folder.name.clone()));
    }
    folders
}

fn direct_tree_child(
    directory: &Path,
    active_child: &Path,
    _show_hidden: bool,
) -> Option<folder_browser::FolderEntry> {
    let parent = nexus_core::clean_path(active_child.parent()?);
    let directory_name = nexus_core::clean_path(directory);
    if !same_entry(
        parent.trim_end_matches(['\\', '/']),
        directory_name.trim_end_matches(['\\', '/']),
    ) {
        return None;
    }
    let name = active_child.file_name()?.to_str()?;
    let candidate = directory.join(name);
    validate_file_path(&candidate).ok()?;
    let metadata = fs::symlink_metadata(&candidate).ok()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;
        if !visible_windows_entry(&metadata, _show_hidden)
            || metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY.0 == 0
        {
            return None;
        }
    }
    #[cfg(not(windows))]
    if !metadata.is_dir() && !(metadata.is_symlink() && candidate.is_dir()) {
        return None;
    }
    Some(folder_browser::FolderEntry {
        name: name.to_owned(),
        path: candidate.to_str()?.to_owned(),
    })
}

#[tauri::command]
pub(crate) async fn local_explorer_selection(
    address: String,
    query: Option<String>,
    project_filter: Option<ProjectFileFilter>,
    show_hidden: Option<bool>,
) -> Result<LocalFileSelection, String> {
    let address = parse_address(&address)?;
    let query = normalized_query(query);
    let project_filter = project_filter
        .map(ProjectFileFilter::validated)
        .transpose()?
        .flatten();
    let show_hidden = cfg!(windows) && show_hidden.unwrap_or_default();
    folder_browser::read_location(READ_TIMEOUT, move |cancelled| match address {
        Address::Path(path) => {
            let metadata = fs::metadata(&path).map_err(location_error)?;
            if !metadata.is_dir() {
                return Err("请选择文件夹".into());
            }
            let snapshot = directory_snapshot(
                &path,
                metadata.modified().ok(),
                false,
                show_hidden,
                &DIRECTORIES,
                cancelled,
            )?;
            collect_selection(
                &snapshot.entries,
                snapshot.truncated,
                query.as_deref(),
                project_filter.as_ref(),
                true,
                cancelled,
            )
        }
        #[cfg(windows)]
        Address::Host(host) => {
            let (entries, truncated) = read_shares(&host, cancelled)?;
            collect_selection(
                &entries,
                truncated,
                query.as_deref(),
                None,
                false,
                cancelled,
            )
        }
    })
    .await
}

fn collect_selection(
    entries: &[LocalFile],
    truncated: bool,
    query: Option<&str>,
    project_filter: Option<&ProjectFileFilter>,
    physical: bool,
    cancelled: &AtomicBool,
) -> Result<LocalFileSelection, String> {
    let mut selected = Vec::new();
    for entry in entries {
        check_cancelled(cancelled)?;
        if query.is_some_and(|query| !matches_query(entry, query))
            || project_filter.is_some_and(|filter| !filter.matches(entry))
        {
            continue;
        }
        let size = if cfg!(not(windows)) && physical && !entry.is_directory {
            fs::symlink_metadata(&entry.path)
                .ok()
                .filter(fs::Metadata::is_file)
                .map(|metadata| metadata.len())
        } else {
            entry.size
        };
        selected.push(SelectionEntry {
            name: entry.name.clone(),
            path: entry.path.clone(),
            is_directory: entry.is_directory,
            size,
        });
    }
    Ok(LocalFileSelection {
        total: selected.len(),
        entries: selected,
        truncated,
    })
}

#[tauri::command]
pub(crate) async fn open_local_file(path: String) -> Result<(), String> {
    let Address::Path(path) = parse_address(&path)? else {
        return Err("请在文件列表中选择要打开的文件".into());
    };
    folder_browser::read_location(READ_TIMEOUT, move |cancelled| {
        let target = fs::canonicalize(path).map_err(location_error)?;
        validate_file_path(&target)?;
        if !target.is_file() {
            return Err("请在文件列表中选择要打开的文件".into());
        }
        if launches_program(&target) {
            return Err("程序、脚本和快捷方式请在系统文件管理器中定位后打开".into());
        }
        check_cancelled(cancelled)?;
        open_in_default_app(&target)
    })
    .await
}

#[tauri::command]
pub(crate) async fn reveal_local_file(path: String) -> Result<(), String> {
    let address = parse_address(&path)?;
    folder_browser::read_location(READ_TIMEOUT, move |cancelled| match address {
        #[cfg(windows)]
        Address::Host(host) => launch_folder_location(Path::new(&host)),
        Address::Path(path) => {
            let metadata = fs::metadata(&path).map_err(location_error)?;
            check_cancelled(cancelled)?;
            if metadata.is_dir() {
                launch_folder_location(&path)
            } else if metadata.is_file() {
                reveal_path(path.to_str().ok_or("文件路径无效")?)
            } else {
                Err("请选择普通文件或文件夹".into())
            }
        }
    })
    .await
}

fn parse_address(address: &str) -> Result<Address, String> {
    let address = address.trim();
    let address = address
        .strip_prefix('"')
        .and_then(|text| text.strip_suffix('"'))
        .unwrap_or(address);
    if address.is_empty() || address.len() > 32_768 || address.chars().any(char::is_control) {
        return Err("请输入完整的文件夹路径、文件路径或共享地址".into());
    }

    let path = if let Some((scheme, _)) = address.split_once("://") {
        if !["file", "smb"]
            .iter()
            .any(|value| scheme.eq_ignore_ascii_case(value))
        {
            return Err("请输入磁盘路径、共享路径、file:// 或 smb:// 地址".into());
        }
        let url = Url::parse(address).map_err(|_| "文件链接格式有误")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("文件链接需使用系统的共享访问权限及完整路径".into());
        }
        let url = if url.scheme() == "smb" {
            #[cfg(not(windows))]
            return Err("请先在系统中挂载 SMB 共享，再输入其本机路径".into());
            #[cfg(windows)]
            {
                let host = url.host_str().ok_or("请输入 SMB 服务器地址")?;
                let host = valid_host(host).ok_or("请输入有效的 SMB 服务器地址")?;
                if url.path().trim_matches('/').is_empty() {
                    return Ok(Address::Host(format!(r"\\{host}")));
                }
                Url::parse(&format!("file://{host}{}", url.path()))
                    .map_err(|_| "共享文件链接格式有误")?
            }
        } else {
            url
        };
        #[cfg(windows)]
        if url.path().trim_matches('/').is_empty() {
            if let Some(host) = url.host_str().and_then(valid_host) {
                return Ok(Address::Host(format!(r"\\{host}")));
            }
        }
        url.to_file_path().map_err(|_| "请输入完整的文件链接")?
    } else {
        #[cfg(windows)]
        {
            let mut path = address.replace('/', "\\");
            if path.len() == 2 && path.as_bytes()[0].is_ascii_alphabetic() && path.ends_with(':') {
                path.push('\\');
            }
            if let Some(host) = path
                .strip_prefix(r"\\")
                .and_then(|address| valid_host(address.trim_end_matches('\\')))
            {
                return Ok(Address::Host(format!(r"\\{host}")));
            }
            PathBuf::from(path)
        }
        #[cfg(not(windows))]
        PathBuf::from(address)
    };
    validate_file_path(&path)?;
    Ok(Address::Path(path))
}

#[cfg(windows)]
fn valid_host(host: &str) -> Option<&str> {
    (!host.is_empty()
        && host.len() <= 253
        && host.bytes().any(|c| c.is_ascii_alphanumeric())
        && host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_')))
    .then_some(host)
}

pub(super) fn validate_file_path(path: &Path) -> Result<(), String> {
    folder_browser::validate_directory(path)
        .map_err(|_| "请输入磁盘或共享位置的完整路径".to_owned())?;
    if path.to_string_lossy().chars().any(char::is_control) {
        return Err("路径含有无效字符".into());
    }
    #[cfg(windows)]
    for component in path.components() {
        use std::path::{Component, Prefix};
        match component {
            Component::Prefix(prefix) => {
                if let Prefix::UNC(host, share) | Prefix::VerbatimUNC(host, share) = prefix.kind() {
                    let share = share.to_str().ok_or("共享名称无效")?;
                    if host.to_str().and_then(valid_host).is_none()
                        || invalid_windows_name(share)
                        || ["IPC$", "PIPE", "MAILSLOT"]
                            .iter()
                            .any(|name| share.eq_ignore_ascii_case(name))
                    {
                        return Err("请输入磁盘共享文件夹地址".into());
                    }
                }
            }
            Component::Normal(name) if name.to_str().is_none_or(invalid_windows_name) => {
                return Err("路径包含系统设备名或无效字符".into());
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(windows)]
fn invalid_windows_name(name: &str) -> bool {
    if name.contains(['<', '>', ':', '"', '|', '?', '*', '/', '\\']) {
        return true;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("已结束目录读取".into());
    }
    Ok(())
}

fn location_error(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "找不到此位置。请检查路径或共享服务器是否在线。".into(),
        std::io::ErrorKind::PermissionDenied => "没有访问此位置的权限。".into(),
        _ => format!("无法访问此位置：{error}"),
    }
}

fn parent_location(path: &Path) -> Option<String> {
    if let Some(parent) = path.parent().filter(|parent| parent.is_absolute()) {
        return parent.to_str().map(str::to_owned);
    }
    #[cfg(windows)]
    if let Some(std::path::Component::Prefix(prefix)) = path.components().next() {
        use std::path::Prefix;
        if let Prefix::UNC(host, _) | Prefix::VerbatimUNC(host, _) = prefix.kind() {
            return host.to_str().map(|host| format!(r"\\{host}"));
        }
    }
    None
}

fn same_entry(path: &str, selected: &str) -> bool {
    path == selected || (cfg!(windows) && path.to_lowercase() == selected.to_lowercase())
}

fn locate_path_key(path: &Path) -> String {
    #[cfg(windows)]
    return nexus_core::clean_path(path)
        .replace('/', "\\")
        .to_lowercase();
    #[cfg(not(windows))]
    path.to_string_lossy().into_owned()
}

fn locate_path_input(value: &str) -> Option<String> {
    let path = match parse_address(value).ok()? {
        Address::Path(path) => path,
        #[cfg(windows)]
        Address::Host(_) => return None,
    };
    if path.file_name().is_none()
        || path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return None;
    }
    Some(locate_path_key(&path))
}

fn validated_locate_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.len() > PAGE_SIZE {
        return Err(format!("一次最多定位 {PAGE_SIZE} 个原件"));
    }
    Ok(paths
        .iter()
        .filter_map(|path| locate_path_input(path))
        .collect())
}

fn list_path(
    path: &Path,
    refresh: bool,
    cache: &DirectoryCache,
    cancelled: &AtomicBool,
    page: ListingPage<'_>,
) -> Result<LocalFileListing, String> {
    let metadata = fs::metadata(path).map_err(location_error)?;
    let (directory, modified, selected) = if metadata.is_dir() {
        (path, metadata.modified().ok(), None)
    } else if metadata.is_file() {
        if page.locate_paths.is_some() {
            return Err("定位多个原件时需要提供所在文件夹".into());
        }
        let parent = path.parent().ok_or("找不到文件所在的文件夹")?;
        let modified = fs::metadata(parent)
            .map_err(location_error)?
            .modified()
            .ok();
        (parent, modified, Some((path, metadata)))
    } else {
        return Err("请选择普通文件或文件夹".into());
    };

    let snapshot = directory_snapshot(
        directory,
        modified,
        refresh,
        page.show_hidden,
        cache,
        cancelled,
    )?;
    directory_page(directory, &snapshot, selected, cancelled, page)
}

fn directory_snapshot(
    directory: &Path,
    modified: Option<SystemTime>,
    refresh: bool,
    show_hidden: bool,
    cache: &DirectoryCache,
    cancelled: &AtomicBool,
) -> Result<Arc<DirectorySnapshot>, String> {
    if refresh {
        cache.invalidate(directory);
    } else if let Some(snapshot) = cache.get(directory, show_hidden) {
        if snapshot.modified == modified {
            return Ok(snapshot);
        }
        cache.invalidate(directory);
    }

    let scan = cache.begin(directory, show_hidden);
    let snapshot = Arc::new(scan_directory(directory, modified, show_hidden, cancelled)?);
    scan.store(snapshot.clone(), cancelled);
    Ok(snapshot)
}

fn scan_directory(
    directory: &Path,
    modified: Option<SystemTime>,
    _show_hidden: bool,
    cancelled: &AtomicBool,
) -> Result<DirectorySnapshot, String> {
    #[cfg(windows)]
    use std::os::windows::fs::MetadataExt;
    #[cfg(windows)]
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;

    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(directory).map_err(location_error)? {
        check_cancelled(cancelled)?;
        let entry = entry.map_err(location_error)?;
        // Windows DirEntry metadata comes from the directory enumeration, so
        // reading attributes here never opens the child or follows a junction.
        #[cfg(windows)]
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        #[cfg(windows)]
        if !visible_windows_entry(&metadata, _show_hidden) {
            continue;
        }
        let candidate = entry.path();
        let Some(path) = candidate.to_str() else {
            continue;
        };
        let Some(name) = candidate.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        #[cfg(windows)]
        let is_directory = metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
        #[cfg(not(windows))]
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        #[cfg(not(windows))]
        let is_directory = kind.is_dir() || (kind.is_symlink() && candidate.is_dir());
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut file = LocalFile {
            name: name.into(),
            path: path.into(),
            is_directory,
            size: None,
            modified: None,
            created: None,
        };
        // Unix reads metadata for entries on the visible page only.
        #[cfg(windows)]
        file.set_details(metadata);
        entries.push(file);
    }
    sort_entries(&mut entries);
    check_cancelled(cancelled)?;
    Ok(DirectorySnapshot {
        entries,
        truncated,
        modified,
        created: Instant::now(),
    })
}

fn directory_page(
    directory: &Path,
    snapshot: &DirectorySnapshot,
    selected: Option<(&Path, fs::Metadata)>,
    cancelled: &AtomicBool,
    page: ListingPage<'_>,
) -> Result<LocalFileListing, String> {
    let parent = parent_location(directory);
    let directory = directory.to_str().map(str::to_owned);
    let mut selected_path = None;
    if let Some((path, metadata)) = selected {
        selected_path = path.to_str();
        if let Some(selected) = selected_path.filter(|selected| {
            !snapshot
                .entries
                .iter()
                .any(|entry| same_entry(&entry.path, selected))
        }) {
            // A direct file path remains selectable beyond the directory limit.
            // Keep that additional row local to this request.
            let mut entry = LocalFile {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("文件名无效")?
                    .into(),
                path: selected.into(),
                is_directory: false,
                size: None,
                modified: None,
                created: None,
            };
            entry.set_details(metadata);
            let mut entries = snapshot.entries.clone();
            entries.push(entry);
            return finish_listing(
                directory,
                parent,
                selected_path,
                entries,
                snapshot.truncated,
                cancelled,
                page,
            );
        }
    }
    page_listing(
        directory,
        parent,
        selected_path,
        &snapshot.entries,
        snapshot.truncated,
        cancelled,
        page,
    )
}

fn sort_entries(entries: &mut [LocalFile]) {
    entries.sort_by_cached_key(|entry| {
        (
            !entry.is_directory,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
}

fn finish_listing(
    directory: Option<String>,
    parent: Option<String>,
    selected_path: Option<&str>,
    mut entries: Vec<LocalFile>,
    truncated: bool,
    cancelled: &AtomicBool,
    page: ListingPage<'_>,
) -> Result<LocalFileListing, String> {
    sort_entries(&mut entries);
    page_listing(
        directory,
        parent,
        selected_path,
        &entries,
        truncated,
        cancelled,
        page,
    )
}

fn locate_rows<'a>(
    paths: &[String],
    rows: impl Iterator<Item = (usize, &'a LocalFile)>,
    cancelled: &AtomicBool,
) -> Result<Vec<usize>, String> {
    let mut matches: HashMap<&str, (usize, usize)> =
        paths.iter().map(|path| (path.as_str(), (0, 0))).collect();
    if matches.is_empty() {
        return Ok(Vec::new());
    }
    for (index, row) in rows {
        check_cancelled(cancelled)?;
        if row.is_directory {
            continue;
        }
        let key = locate_path_key(Path::new(&row.path));
        if let Some((count, match_index)) = matches.get_mut(key.as_str()) {
            *count += 1;
            *match_index = index;
        }
    }
    // Remove duplicates from the request and ignore ambiguous matches.
    Ok(paths
        .iter()
        .filter_map(|path| match matches.remove(path.as_str()) {
            Some((1, index)) => Some(index),
            _ => None,
        })
        .collect())
}

fn page_listing(
    directory: Option<String>,
    parent: Option<String>,
    selected_path: Option<&str>,
    entries: &[LocalFile],
    truncated: bool,
    cancelled: &AtomicBool,
    page: ListingPage<'_>,
) -> Result<LocalFileListing, String> {
    let ListingPage {
        offset,
        order,
        query,
        project_filter,
        remembered_path,
        locate_paths,
        ..
    } = page;
    let sort = order != ListingOrder::default();
    let mut indices = (sort || query.is_some() || project_filter.is_some())
        .then(|| (0..entries.len()).collect::<Vec<_>>());
    if let Some(indices) = indices.as_mut() {
        indices.retain(|&index| {
            let entry = &entries[index];
            query.is_none_or(|query| matches_query(entry, query))
                && (project_filter.is_none_or(|filter| filter.matches(entry))
                    || selected_path.is_some_and(|path| same_entry(&entry.path, path)))
        });
    }
    if let Some(ordered) = indices.as_mut().filter(|_| sort) {
        ordered.sort_by_cached_key(|&index| {
            let entry = &entries[index];
            let group = order
                .date_groups
                .map_or(0, |bounds| date_group(entry.modified, bounds));
            let date = match order.sort_by {
                SortBy::Date => entry.modified,
                SortBy::Created => entry.created,
                _ => None,
            };
            let size = match order.sort_by {
                SortBy::Size => entry.size,
                _ => None,
            };
            let extension = if matches!(order.sort_by, SortBy::Type) && !entry.is_directory {
                Path::new(&entry.name)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_lowercase()
            } else {
                String::new()
            };
            let key = (date, size, extension);
            let (ascending, descending) = if order.descending {
                (None, Some(std::cmp::Reverse(key)))
            } else {
                (Some(key), None)
            };
            let reverse_name = (order.descending && order.sort_by == SortBy::Name)
                .then_some(std::cmp::Reverse(index));
            (
                group,
                !entry.is_directory,
                ascending,
                descending,
                reverse_name,
            )
        });
    }
    let entry_at =
        |index: usize| &entries[indices.as_ref().map_or(index, |indices| indices[index])];
    let total = indices.as_ref().map_or(entries.len(), Vec::len);
    let located = locate_paths
        .map(|paths| {
            locate_rows(
                paths,
                (0..total).map(|index| (index, entry_at(index))),
                cancelled,
            )
        })
        .transpose()?;
    let selected = if let Some(located) = &located {
        remembered_path
            .and_then(locate_path_input)
            .and_then(|key| {
                located
                    .iter()
                    .copied()
                    .find(|&index| locate_path_key(Path::new(&entry_at(index).path)) == key)
            })
            .or_else(|| located.first().copied())
    } else {
        selected_path.or(remembered_path).and_then(|selected| {
            (0..total).position(|index| same_entry(&entry_at(index).path, selected))
        })
    };
    let selected_path = selected.map(|index| entry_at(index).path.clone());
    let offset = offset
        .unwrap_or_else(|| selected.unwrap_or(0))
        .min(total.saturating_sub(1))
        / PAGE_SIZE
        * PAGE_SIZE;
    let mut listed = Vec::new();
    for index in offset..total.min(offset + PAGE_SIZE) {
        check_cancelled(cancelled)?;
        let mut entry = entry_at(index).clone();
        if cfg!(not(windows)) && directory.is_some() {
            if let Ok(metadata) = fs::symlink_metadata(&entry.path) {
                entry.set_details(metadata);
            }
        }
        listed.push(entry);
    }
    Ok(LocalFileListing {
        directory,
        parent,
        selected_path,
        entries: listed,
        matched_entries: located.map(|indices| {
            indices
                .into_iter()
                .map(|index| entry_at(index).clone())
                .collect()
        }),
        total,
        offset,
        previous_offset: offset.checked_sub(PAGE_SIZE),
        next_offset: (offset + PAGE_SIZE < total).then_some(offset + PAGE_SIZE),
        truncated,
    })
}

fn date_group(date: Option<u64>, boundaries: [u64; 4]) -> usize {
    date.map_or(5, |date| {
        boundaries.iter().take_while(|&&start| date < start).count()
    })
}

#[cfg(windows)]
fn list_shares(
    host: &str,
    cancelled: &AtomicBool,
    page: ListingPage<'_>,
) -> Result<LocalFileListing, String> {
    let (entries, truncated) = read_shares(host, cancelled)?;
    finish_listing(
        Some(host.into()),
        None,
        None,
        entries,
        truncated,
        cancelled,
        page,
    )
}

#[cfg(windows)]
fn read_shares(host: &str, cancelled: &AtomicBool) -> Result<(Vec<LocalFile>, bool), String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::ERROR_MORE_DATA,
            NetworkManagement::NetManagement::NetApiBufferFree,
            Storage::FileSystem::{NetShareEnum, SHARE_INFO_1, STYPE_DISKTREE, STYPE_MASK},
        },
    };

    struct ShareBuffer(*mut u8);
    impl Drop for ShareBuffer {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // NetShareEnum owns this allocation until it is freed here.
                unsafe { NetApiBufferFree(Some(self.0.cast())) };
            }
        }
    }

    let network_name: Vec<u16> = host.encode_utf16().chain([0]).collect();
    let mut entries = Vec::new();
    let mut resume = 0;
    let mut truncated = false;
    loop {
        check_cancelled(cancelled)?;
        let mut buffer = ShareBuffer(std::ptr::null_mut());
        let (mut count, mut total) = (0, 0);
        // Level 1 provides the name and type of shares for this exact host.
        let status = unsafe {
            NetShareEnum(
                PCWSTR(network_name.as_ptr()),
                1,
                &mut buffer.0,
                64 * 1024,
                &mut count,
                &mut total,
                Some(&mut resume),
            )
        };
        if status != 0 && status != ERROR_MORE_DATA.0 {
            return Err(format!(
                "无法列出该服务器的共享文件夹（{status}）。可以直接输入完整的共享路径。"
            ));
        }
        if count > 0 {
            if buffer.0.is_null() {
                return Err("服务器未返回有效的共享清单".into());
            }
            // The successful level-1 call supplies count SHARE_INFO_1 records.
            let shares = unsafe {
                std::slice::from_raw_parts(buffer.0.cast::<SHARE_INFO_1>(), count as usize)
            };
            for share in shares {
                if share.shi1_type.0 & STYPE_MASK.0 != STYPE_DISKTREE.0
                    || share.shi1_netname.is_null()
                {
                    continue;
                }
                let Ok(name) = (unsafe { share.shi1_netname.to_string() }) else {
                    continue;
                };
                if !name.ends_with('$') && !invalid_windows_name(&name) {
                    if entries.len() >= MAX_ENTRIES {
                        truncated = true;
                        break;
                    }
                    entries.push(LocalFile::folder(name.clone(), format!(r"{host}\{name}")));
                }
            }
        }
        if status == 0 || truncated || count == 0 {
            truncated |= status == ERROR_MORE_DATA.0;
            break;
        }
    }
    Ok((entries, truncated))
}

fn launches_program(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    nexus_core::kind(&extension) == Some("script")
        || matches!(
            extension.as_str(),
            "exe"
                | "com"
                | "bat"
                | "cmd"
                | "ps1"
                | "psm1"
                | "vbs"
                | "vbe"
                | "js"
                | "jse"
                | "wsf"
                | "wsh"
                | "scr"
                | "cpl"
                | "msi"
                | "msix"
                | "msp"
                | "mst"
                | "msc"
                | "hta"
                | "lnk"
                | "url"
                | "pif"
                | "reg"
                | "dll"
                | "sys"
                | "sh"
                | "desktop"
                | "appimage"
                | "command"
                | "app"
                | "application"
                | "search-ms"
                | "gadget"
                | "jar"
                | "pyw"
        )
}

#[cfg(windows)]
fn open_in_default_app(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        },
    };
    let path = PathBuf::from(nexus_core::clean_path(path));
    let path: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    // ShellExecute receives a filesystem path, with no command-line parameters.
    let result = unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
            .ok()
            .map_err(|error| format!("无法启动默认应用：{error}"))?;
        let result = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        CoUninitialize();
        result.0 as isize
    };
    if result <= 32 {
        return Err("无法通过系统默认应用打开此文件".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_in_default_app(path: &Path) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法通过系统默认应用打开此文件：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_at(offset: usize) -> ListingPage<'static> {
        ListingPage {
            offset: Some(offset),
            ..ListingPage::default()
        }
    }

    fn path_at(address: &str) -> PathBuf {
        match parse_address(address).unwrap() {
            Address::Path(path) => path,
            #[cfg(windows)]
            Address::Host(_) => panic!("expected a file path"),
        }
    }

    #[test]
    fn resolves_files_and_sorts_direct_children() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fs::create_dir_all(root.join("资料").join("不递归")).unwrap();
        fs::write(root.join("a 文件.txt"), b"first").unwrap();
        fs::write(root.join("B 文件.txt"), b"second").unwrap();
        let path = root.join("B 文件.txt");
        let url = Url::from_file_path(&path).unwrap();
        assert_eq!(path_at(url.as_str()), path);

        let listing = list_path(
            &path,
            false,
            &DirectoryCache::default(),
            &AtomicBool::new(false),
            ListingPage::default(),
        )
        .unwrap();
        assert_eq!(listing.selected_path.as_deref(), path.to_str());
        assert_eq!(listing.directory.as_deref(), root.to_str());
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.is_directory, entry.size))
                .collect::<Vec<_>>(),
            [
                ("资料", true, None),
                ("a 文件.txt", false, Some(5)),
                ("B 文件.txt", false, Some(6))
            ]
        );
        assert!(listing.entries[2].modified.is_some());
    }

    #[test]
    fn completes_folder_prefixes_after_the_sidebar_limit() {
        let mut entries: Vec<_> = (0..PAGE_SIZE)
            .map(|index| LocalFile::folder(format!("Archive {index:03}"), String::new()))
            .collect();
        let mut file = LocalFile::folder("Render file.txt".into(), String::new());
        file.is_directory = false;
        entries.push(file);
        entries.extend((0..20).map(|index| {
            LocalFile::folder(format!("Render {index:02}"), format!("Render {index:02}"))
        }));

        let matches = tree_entries(&entries, None, Some("render"), || None);
        assert_eq!(matches.len(), TREE_COMPLETION_LIMIT);
        assert_eq!(matches.first().unwrap().name, "Render 00");
        assert_eq!(matches.last().unwrap().name, "Render 11");
    }

    #[test]
    fn file_selection_chooses_the_page_containing_the_file() {
        let listing = finish_listing(
            None,
            None,
            Some("asset-275"),
            (0..300)
                .map(|n| LocalFile::folder(format!("asset-{n:03}"), format!("asset-{n:03}")))
                .collect(),
            false,
            &AtomicBool::new(false),
            ListingPage::default(),
        )
        .unwrap();
        assert_eq!(listing.offset, 250);
        assert_eq!(listing.previous_offset, Some(0));
        assert_eq!(listing.selected_path.as_deref(), Some("asset-275"));
        assert_eq!(listing.entries.len(), 50);
        assert_eq!(listing.next_offset, None);
    }

    #[test]
    fn multi_locate_verifies_filtered_siblings_across_pages() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let early = root.join("Shot_000.EXR");
        let recent = root.join(format!("Shot_{:03}.EXR", PAGE_SIZE + 2));
        let wrong_type = root.join("Shot_notes.txt");
        let wrong_query = root.join("Shot-other.exr");
        let directory = root.join("Shot_folder.EXR");
        let outside = directory.join("Shot_000.EXR");
        let missing = root.join("Shot_missing.EXR");
        for index in 0..PAGE_SIZE + 3 {
            fs::write(root.join(format!("Shot_{index:03}.EXR")), b"asset").unwrap();
        }
        fs::create_dir(&directory).unwrap();
        for path in [&wrong_type, &wrong_query, &outside] {
            fs::write(path, b"asset").unwrap();
        }
        let paths = validated_locate_paths(
            [
                &wrong_type,
                &recent,
                &early,
                &early,
                &wrong_query,
                &outside,
                &missing,
                &directory,
            ]
            .map(|path| path.to_str().unwrap().to_owned())
            .to_vec(),
        )
        .unwrap();
        let filter = ProjectFileFilter {
            name: "shot".into(),
            extensions: vec!["exr".into()],
        };
        let page = ListingPage {
            order: ListingOrder {
                descending: true,
                ..ListingOrder::default()
            },
            query: Some("shot_"),
            project_filter: Some(&filter),
            remembered_path: early.to_str(),
            locate_paths: Some(&paths),
            ..ListingPage::default()
        };
        let cache = DirectoryCache::default();
        let cancelled = AtomicBool::new(false);
        let result = list_path(root, false, &cache, &cancelled, page).unwrap();
        let matches = result
            .matched_entries
            .as_deref()
            .unwrap()
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(matches, [recent.to_str().unwrap(), early.to_str().unwrap()]);
        assert_eq!(result.total, PAGE_SIZE + 4);
        assert_eq!(result.offset, PAGE_SIZE);
        assert_eq!(result.selected_path.as_deref(), early.to_str());
        assert!(result
            .entries
            .iter()
            .all(|entry| Some(entry.path.as_str()) != recent.to_str()));

        let snapshot = cache.get(root, false).unwrap();
        let fallback = list_path(
            root,
            false,
            &cache,
            &cancelled,
            ListingPage {
                remembered_path: wrong_type.to_str(),
                ..page
            },
        )
        .unwrap();
        assert!(Arc::ptr_eq(&snapshot, &cache.get(root, false).unwrap()));
        assert_eq!(fallback.offset, 0);
        assert_eq!(fallback.selected_path.as_deref(), recent.to_str());

        let direct = list_path(
            &wrong_type,
            false,
            &cache,
            &cancelled,
            ListingPage {
                locate_paths: None,
                ..page
            },
        )
        .unwrap();
        assert_eq!(direct.selected_path.as_deref(), wrong_type.to_str());
        assert!(direct.matched_entries.is_none());
        assert!(serde_json::to_value(direct)
            .unwrap()
            .get("matchedEntries")
            .is_none());
        assert!(list_path(&wrong_type, false, &cache, &cancelled, page).is_err());
    }

    #[test]
    fn multi_locate_bounds_requests_and_distinguishes_no_match() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let real = root.join("Shot_001.EXR");
        fs::write(&real, b"asset").unwrap();
        let absolute = real.to_str().unwrap();
        assert!(validated_locate_paths(vec![absolute.into(); PAGE_SIZE + 1]).is_err());
        let paths = validated_locate_paths(vec!["Shot_001.EXR".into(), "\0".into()]).unwrap();
        assert!(paths.is_empty());

        let result = list_path(
            root,
            false,
            &DirectoryCache::default(),
            &AtomicBool::new(false),
            ListingPage {
                locate_paths: Some(&paths),
                remembered_path: Some(absolute),
                ..ListingPage::default()
            },
        )
        .unwrap();
        assert!(result.matched_entries.as_deref().unwrap().is_empty());
        assert!(result.selected_path.is_none());
        assert_eq!(result.total, 1);
        assert_eq!(
            serde_json::to_value(result).unwrap()["matchedEntries"],
            serde_json::json!([])
        );
    }

    #[test]
    fn selection_collects_matches_beyond_the_first_page() {
        let rows = (0..PAGE_SIZE + 3)
            .map(|index| LocalFile {
                name: if index < PAGE_SIZE {
                    format!("sample-{index}.txt")
                } else {
                    format!("素材-{index}.png")
                },
                path: format!("entry-{index}"),
                is_directory: false,
                size: Some(512),
                modified: None,
                created: None,
            })
            .collect::<Vec<_>>();
        let selected = collect_selection(
            &rows,
            false,
            Some("素材"),
            None,
            false,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(selected.total, 3);
        assert_eq!(
            selected
                .entries
                .iter()
                .filter_map(|entry| entry.size)
                .sum::<u64>(),
            1_536
        );
        assert_eq!(selected.entries[0].path, format!("entry-{PAGE_SIZE}"));
    }

    #[test]
    fn date_group_and_sort_apply_before_pagination() {
        let rows = (0..260)
            .map(|index| LocalFile {
                name: format!("{index:03}.png"),
                path: format!("{index:03}"),
                is_directory: false,
                size: Some(index),
                modified: Some(if index > 4 { 100 } else { 1 }),
                created: None,
            })
            .collect();
        let order = ListingOrder {
            sort_by: SortBy::Size,
            descending: true,
            date_groups: Some([50, 30, 20, 10]),
        };
        let cancelled = AtomicBool::new(false);
        let page = ListingPage {
            order,
            ..ListingPage::default()
        };
        let listing =
            finish_listing(None, None, Some("004"), rows, false, &cancelled, page).unwrap();
        assert_eq!(listing.offset, 250);
        assert_eq!(listing.entries[0].name, "009.png");
        assert_eq!(listing.entries[5].name, "004.png");
        assert_eq!(listing.selected_path.as_deref(), Some("004"));
    }

    #[test]
    fn searches_all_directory_entries_before_pagination() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        for index in 0..300 {
            fs::write(root.join(format!("asset-{index:03}.txt")), b"").unwrap();
        }
        fs::write(root.join("Z_最终 Render.PNG"), b"").unwrap();
        let cache = DirectoryCache::default();
        let cancelled = AtomicBool::new(false);
        let browse = list_path(root, false, &cache, &cancelled, page_at(0)).unwrap();
        assert_eq!(browse.total, 301);
        assert!(browse
            .entries
            .iter()
            .all(|entry| !entry.name.contains("Render")));
        let previous = cache.get(root, false).unwrap();

        let page = ListingPage {
            query: Some("最终 render.png"),
            ..ListingPage::default()
        };
        let result = list_path(root, false, &cache, &cancelled, page).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.entries[0].name, "Z_最终 Render.PNG");
        assert_eq!(result.next_offset, None);
        assert!(Arc::ptr_eq(&previous, &cache.get(root, false).unwrap()));
    }

    #[cfg(windows)]
    #[test]
    fn filters_windows_hidden_and_system_entries_before_paging_and_selection() {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
            },
        };

        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fs::create_dir(root.join("Recovery")).unwrap();
        let hidden = root.join("隐藏文件夹");
        fs::create_dir(&hidden).unwrap();
        fs::write(hidden.join("可访问.txt"), b"data").unwrap();
        let system = root.join("System Volume Information");
        fs::create_dir(&system).unwrap();
        let protected = root.join("desktop.ini");
        fs::write(&protected, b"data").unwrap();
        for (path, attributes) in [
            (&hidden, FILE_ATTRIBUTE_HIDDEN),
            (&system, FILE_ATTRIBUTE_SYSTEM),
            (&protected, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM),
        ] {
            let path = path
                .as_os_str()
                .encode_wide()
                .chain([0])
                .collect::<Vec<_>>();
            unsafe { SetFileAttributesW(PCWSTR(path.as_ptr()), attributes) }.unwrap();
        }

        let cache = DirectoryCache::default();
        let cancelled = AtomicBool::new(false);
        let ordinary = list_path(root, false, &cache, &cancelled, page_at(0)).unwrap();
        assert_eq!(ordinary.total, 1);
        assert_eq!(ordinary.entries[0].name, "Recovery");

        let enabled = ListingPage {
            show_hidden: true,
            ..page_at(0)
        };
        let with_hidden = list_path(root, false, &cache, &cancelled, enabled).unwrap();
        assert_eq!(with_hidden.total, 2);
        assert_eq!(with_hidden.entries[1].name, "隐藏文件夹");

        let locate_paths =
            validated_locate_paths(vec![protected.to_str().unwrap().into()]).unwrap();
        let located = list_path(
            root,
            false,
            &cache,
            &cancelled,
            ListingPage {
                locate_paths: Some(&locate_paths),
                remembered_path: protected.to_str(),
                ..enabled
            },
        )
        .unwrap();
        assert!(located.matched_entries.as_deref().unwrap().is_empty());
        assert!(located.selected_path.is_none());
        for (show_hidden, total) in [(false, 1), (true, 2)] {
            let snapshot = cache.get(root, show_hidden).unwrap();
            let select =
                collect_selection(&snapshot.entries, false, None, None, true, &cancelled).unwrap();
            assert_eq!(select.total, total);
            let search = ListingPage {
                query: Some("隐藏"),
                show_hidden,
                ..page_at(0)
            };
            let matched = list_path(root, false, &cache, &cancelled, search).unwrap();
            assert_eq!(matched.total, usize::from(show_hidden));
        }
        let explicit = list_path(&hidden, false, &cache, &cancelled, page_at(0)).unwrap();
        assert_eq!(explicit.entries[0].name, "可访问.txt");
    }

    #[test]
    fn filters_project_entries_before_paging_and_remembers_only_visible_rows() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        fs::create_dir(root.join("Subfolder")).unwrap();
        for index in 0..PAGE_SIZE + 3 {
            fs::write(root.join(format!("Shot_{index:03}.EXR")), b"").unwrap();
        }
        let excluded = root.join("Shot_notes.txt");
        fs::write(&excluded, b"").unwrap();
        fs::write(root.join("Other.c4d"), b"").unwrap();
        let remembered = root.join(format!("Shot_{:03}.EXR", PAGE_SIZE));
        let filter = ProjectFileFilter {
            name: "shot".into(),
            extensions: vec![".EXR".into(), "C4D".into()],
        }
        .validated()
        .unwrap()
        .unwrap();
        let page = ListingPage {
            project_filter: Some(&filter),
            remembered_path: remembered.to_str(),
            ..ListingPage::default()
        };
        let cache = DirectoryCache::default();
        let cancelled = AtomicBool::new(false);
        let result = list_path(root, false, &cache, &cancelled, page).unwrap();
        assert_eq!(result.total, PAGE_SIZE + 4);
        assert_eq!(result.offset, PAGE_SIZE);
        assert_eq!(result.selected_path.as_deref(), remembered.to_str());
        let snapshot = cache.get(root, false).unwrap();
        let selected = collect_selection(
            &snapshot.entries,
            false,
            None,
            Some(&filter),
            true,
            &cancelled,
        )
        .unwrap();
        assert_eq!(selected.total, result.total);
        let removed = list_path(
            root,
            false,
            &cache,
            &cancelled,
            ListingPage {
                remembered_path: excluded.to_str(),
                ..page
            },
        )
        .unwrap();
        assert_eq!(removed.offset, 0);
        assert_eq!(removed.selected_path, None);
        let direct = list_path(&excluded, false, &cache, &cancelled, page).unwrap();
        assert_eq!(direct.selected_path.as_deref(), excluded.to_str());
        assert_eq!(direct.total, result.total + 1);
    }

    #[test]
    fn shares_directory_snapshot_across_requests_and_refreshes_on_demand() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        for index in 0..300 {
            fs::write(root.join(format!("asset-{index:03}.txt")), b"").unwrap();
        }
        let cache = DirectoryCache::default();
        let cancelled = AtomicBool::new(false);
        list_path(root, false, &cache, &cancelled, page_at(0)).unwrap();
        let first = cache.get(root, false).unwrap();
        let second = list_path(root, false, &cache, &cancelled, page_at(250)).unwrap();
        assert_eq!(second.entries.len(), 50);
        assert!(Arc::ptr_eq(&first, &cache.get(root, false).unwrap()));

        let selected = root.join("asset-275.txt");
        let direct =
            list_path(&selected, false, &cache, &cancelled, ListingPage::default()).unwrap();
        assert_eq!(direct.offset, 250);
        assert_eq!(direct.selected_path.as_deref(), selected.to_str());

        let older_scan = cache.begin(root, false);
        fs::write(root.join("new.txt"), b"after first scan").unwrap();
        let refreshed = list_path(root, true, &cache, &cancelled, page_at(250)).unwrap();
        assert_eq!(refreshed.total, 301);
        assert_eq!(refreshed.entries.last().unwrap().name, "new.txt");
        older_scan.store(first.clone(), &cancelled);
        let recent = cache.get(root, false).unwrap();
        assert!(!Arc::ptr_eq(&first, &recent));
        assert_eq!(recent.entries.len(), 301);
    }

    #[test]
    #[ignore = "creates 10,000 files for a repeatable local performance measurement"]
    fn benchmark_directory_revisit_and_pages() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        for index in 0..10_000 {
            fs::write(root.join(format!("asset-{index:05}.txt")), b"").unwrap();
        }
        let cache = DirectoryCache::default();
        let cancelled = AtomicBool::new(false);
        list_path(root, true, &cache, &cancelled, page_at(0)).unwrap();
        let mut rescans = Vec::new();
        let mut revisits = Vec::new();
        let mut cached_pages = Vec::new();
        for run in 0..30 {
            let page = page_at(run * PAGE_SIZE);
            let start = Instant::now();
            let fresh = list_path(root, true, &cache, &cancelled, page).unwrap();
            rescans.push(start.elapsed());

            let start = Instant::now();
            let revisit = list_path(root, false, &cache, &cancelled, page).unwrap();
            revisits.push(start.elapsed());

            let start = Instant::now();
            let snapshot = cache.get(root, false).unwrap();
            let paged = directory_page(root, &snapshot, None, &cancelled, page).unwrap();
            cached_pages.push(start.elapsed());
            assert_eq!(fresh.entries[0].name, revisit.entries[0].name);
            assert_eq!(fresh.entries[0].name, paged.entries[0].name);
        }
        for (label, mut samples) in [
            ("rescan", rescans),
            ("revisit", revisits),
            ("cached page", cached_pages),
        ] {
            samples.sort_unstable();
            let ms = |duration: Duration| duration.as_secs_f64() * 1000.0;
            println!(
                "{label}: median {:.3} ms, p95 {:.3} ms",
                ms(samples[samples.len() / 2]),
                ms(samples[(samples.len() * 95).div_ceil(100) - 1])
            );
        }
    }

    #[test]
    fn rejects_non_file_addresses_and_marks_executable_types() {
        for address in [
            "relative/folder",
            "https://example.org",
            "file:///tmp/%00name",
            "file:///foo#bar",
        ] {
            assert!(parse_address(address).is_err(), "{address}");
        }
        for filename in ["app.EXE", "script.ps1", "share.url", "plugin.py"] {
            assert!(launches_program(Path::new(filename)));
        }
        assert!(!launches_program(Path::new("motion.c4d")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_and_network_addresses_round_trip() {
        for (address, expected) in [
            ("D:", r"D:\"),
            (r#""D:\设计 1\项目.c4d""#, r"D:\设计 1\项目.c4d"),
            ("file:///D:/Design%20files", r"D:\Design files"),
            (
                "smb://nas/share/Design%20files",
                r"\\nas\share\Design files",
            ),
            (
                "file://nas/share/Design%20files",
                r"\\nas\share\Design files",
            ),
        ] {
            assert_eq!(path_at(address), PathBuf::from(expected));
        }
        for address in [r"\\NAS", "smb://NAS", "file://NAS/"] {
            assert!(matches!(parse_address(address), Ok(Address::Host(_))));
        }
        assert_eq!(
            parent_location(Path::new(r"\\NAS\share")).as_deref(),
            Some(r"\\NAS")
        );
        for address in [
            r"C:relative",
            r"\\.\C:\",
            r"C:\aux.txt",
            r"\\nas\IPC$\any",
            "smb://user:password@nas/share",
        ] {
            assert!(parse_address(address).is_err(), "{address}");
        }
    }
}
