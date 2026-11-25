use crate::{lock_db, AppState};
use nexus_core::{clean_path, Asset, Catalog};
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};
use tauri::State;

const SETTINGS_KEY: &str = "hidden_library_folders_v1";
type Exclusions = BTreeMap<String, Vec<String>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HiddenFolder {
    library_id: String,
    folder: String,
    name: String,
    path: String,
}

fn read_exclusions(catalog: &Catalog) -> Result<Exclusions, String> {
    let entry = catalog
        .conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    entry
        .map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn save_exclusions(catalog: &Catalog, exclusions: &Exclusions) -> Result<(), String> {
    let json = serde_json::to_string(exclusions).map_err(|e| e.to_string())?;
    catalog
        .conn
        .execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (SETTINGS_KEY, json),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn remap_folder_exclusions(
    catalog: &Catalog,
    library_id: &str,
    map_folder: impl Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let mut exclusions = read_exclusions(catalog)?;
    let Some(rules) = exclusions.get_mut(library_id) else {
        return Ok(());
    };
    let mut changed = false;
    for folder in rules.iter_mut() {
        if let Some(next) = map_folder(folder) {
            *folder = next;
            changed = true;
        }
    }
    if changed {
        let mut seen = HashSet::new();
        rules.retain(|folder| seen.insert(comparison_key(folder)));
        save_exclusions(catalog, &exclusions)?;
    }
    Ok(())
}

fn normalized_folder(folder: &str) -> Option<String> {
    let folder = if cfg!(windows) {
        folder.replace('\\', "/")
    } else {
        folder.to_owned()
    };
    if folder.starts_with('/') || folder.contains('\0') {
        return None;
    }
    let mut components = Vec::new();
    for component in folder.split('/').filter(|part| !part.is_empty()) {
        if component == ".." || (cfg!(windows) && component.contains(':')) {
            return None;
        }
        if component != "." {
            components.push(component);
        }
    }
    if components.is_empty() && !folder.is_empty() {
        return None;
    }
    Some(components.join("/"))
}

fn comparison_key(value: &str) -> String {
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.to_owned()
    }
}

fn matches_rule(directory: &str, folder: &str) -> bool {
    folder.is_empty()
        || directory == folder
        || directory
            .strip_prefix(folder)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub(crate) fn folder_is_hidden(
    catalog: &Catalog,
    library_id: &str,
    folder: &str,
) -> Result<bool, String> {
    let folder = comparison_key(folder);
    Ok(read_exclusions(catalog)?
        .get(library_id)
        .is_some_and(|rules| {
            rules
                .iter()
                .any(|rule| matches_rule(&folder, &comparison_key(rule)))
        }))
}

struct RuleSet {
    root: PathBuf,
    folders: Vec<String>,
}

impl RuleSet {
    fn all_hidden(&self) -> bool {
        self.folders.iter().any(String::is_empty)
    }

    fn hides_directory(&self, directory: &str) -> bool {
        self.folders
            .iter()
            .any(|rule| matches_rule(directory, rule))
    }

    fn hides_file_from_path(&self, file: &Path) -> bool {
        let Some(directory) = file
            .parent()
            .and_then(|directory| directory.strip_prefix(&self.root).ok())
        else {
            return false;
        };
        let directory = directory
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        self.hides_directory(&directory)
    }
}

fn hidden_folder(library_id: &str, row: &Value, root: &str, folder: &str) -> HiddenFolder {
    let mut path = PathBuf::from(root);
    if !folder.is_empty() {
        path.extend(folder.split('/'));
    }
    let name = if folder.is_empty() {
        row["name"].as_str().unwrap_or(library_id)
    } else {
        folder.rsplit('/').next().unwrap_or(folder)
    };
    HiddenFolder {
        library_id: library_id.into(),
        folder: folder.into(),
        name: name.into(),
        path: clean_path(&path),
    }
}

pub(crate) fn visible_catalog(
    catalog: &Catalog,
) -> Result<(Vec<Asset>, Vec<Value>, Vec<HiddenFolder>), String> {
    let mut assets = catalog.assets()?;
    let mut libraries = catalog.libraries()?;
    let exclusions = read_exclusions(catalog)?;
    if exclusions.is_empty() {
        return Ok((assets, libraries, Vec::new()));
    }

    let known_libraries: HashSet<_> = libraries
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let mut hidden = Vec::new();
    let mut rules = BTreeMap::new();
    for row in &mut libraries {
        let (Some(library_id), Some(root)) = (row["id"].as_str(), row["path"].as_str()) else {
            continue;
        };
        let Some(choices) = exclusions.get(library_id) else {
            continue;
        };
        let rule = RuleSet {
            root: PathBuf::from(comparison_key(&clean_path(Path::new(root)))),
            folders: choices
                .iter()
                .map(|choice| comparison_key(choice))
                .collect(),
        };
        hidden.extend(
            choices
                .iter()
                .map(|folder| hidden_folder(library_id, row, root, folder)),
        );
        let id = library_id.to_owned();
        if let Some(folders) = row.get_mut("folders").and_then(Value::as_array_mut) {
            folders.retain(|directory| {
                let Some(directory) = directory.as_str().and_then(normalized_folder) else {
                    return true;
                };
                !rule.hides_directory(&comparison_key(&directory))
            });
        }
        rules.insert(id, rule);
    }

    libraries.retain(|row| {
        !row["id"]
            .as_str()
            .and_then(|id| rules.get(id))
            .is_some_and(RuleSet::all_hidden)
    });
    assets.retain(|asset| {
        if let Some(rule) = rules.get(&asset.library_id) {
            if rule.all_hidden() {
                return false;
            }
            let key = comparison_key(&clean_path(Path::new(&asset.path)));
            return !rule.hides_file_from_path(Path::new(&key));
        }
        if known_libraries.contains(&asset.library_id) {
            return true;
        }
        let key = comparison_key(&clean_path(Path::new(&asset.path)));
        !rules
            .values()
            .any(|rule| rule.hides_file_from_path(Path::new(&key)))
    });
    Ok((assets, libraries, hidden))
}

fn set_hidden(
    catalog: &Catalog,
    library_id: &str,
    folder: &str,
    hidden: bool,
) -> Result<(), String> {
    let exists: bool = catalog
        .conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1)",
            [library_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("当前个人库没有此资产目录".into());
    }
    let folder = normalized_folder(folder).ok_or("文件夹路径无效")?;
    let key = comparison_key(&folder);
    let mut exclusions = read_exclusions(catalog)?;
    let choices = exclusions.entry(library_id.into()).or_default();
    if hidden {
        if choices.iter().any(|item| comparison_key(item) == key) {
            return Ok(());
        }
        choices.push(folder);
    } else {
        choices.retain(|item| comparison_key(item) != key);
    }
    if choices.is_empty() {
        exclusions.remove(library_id);
    }
    save_exclusions(catalog, &exclusions)
}

#[tauri::command]
pub(crate) async fn set_library_folder_hidden(
    state: State<'_, AppState>,
    library_id: String,
    folder: String,
    hidden: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let catalog = lock_db(&state)?;
        set_hidden(&catalog, &library_id, &folder, hidden)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn exclusions_preserve_assets_and_keep_nested_rules_on_restore() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("资产");
        fs::create_dir_all(root.join("家具/椅子")).unwrap();
        fs::create_dir(root.join("家具与其他")).unwrap();
        fs::create_dir(root.join("家具/空目录")).unwrap();
        let chair = root.join("家具/椅子/chair.obj");
        let table = root.join("家具/table.obj");
        let other = root.join("家具与其他/other.obj");
        for path in [&chair, &table, &other] {
            fs::write(path, "v 0 0 0").unwrap();
        }

        let dir = temporary.path().join("catalog");
        let mut catalog = Catalog::open(&dir).unwrap();
        let report = catalog.scan(&root, None, "local", |_| {}).unwrap();
        let id = report["library"]["id"].as_str().unwrap();
        let chair_id = catalog
            .assets()
            .unwrap()
            .into_iter()
            .find(|asset| asset.name == "chair")
            .unwrap()
            .id;
        catalog
            .patch(&chair_id, json!({"notes":"测试备注"}))
            .unwrap();
        set_hidden(&catalog, id, "家具/椅子", true).unwrap();
        set_hidden(&catalog, id, "家具", true).unwrap();
        drop(catalog);
        let catalog = Catalog::open(&dir).unwrap();

        let (assets, libraries, hidden) = visible_catalog(&catalog).unwrap();
        assert_eq!(hidden.len(), 2);
        assert_eq!(assets[0].name, "other");
        assert_eq!(assets.len(), 1);
        assert_eq!(libraries[0]["folders"], json!(["家具与其他"]));

        set_hidden(&catalog, id, "家具", false).unwrap();
        let (assets, _, hidden) = visible_catalog(&catalog).unwrap();
        assert_eq!(assets.len(), 2);
        assert_eq!(hidden[0].folder, "家具/椅子");
        set_hidden(&catalog, id, "家具/椅子", false).unwrap();
        let (assets, _, hidden) = visible_catalog(&catalog).unwrap();
        assert_eq!(assets.len(), 3);
        assert!(hidden.is_empty());
        assert_eq!(catalog.asset(&chair_id).unwrap().notes, "测试备注");
        assert!(chair.exists() && table.exists() && other.exists());
    }

    #[test]
    fn root_exclusion_covers_legacy_loose_files_and_is_reversible() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("旧目录");
        let dir = temporary.path().join("catalog");
        fs::create_dir(&root).unwrap();
        let legacy = root.join("legacy.obj");
        fs::write(&legacy, "v 0 0 0").unwrap();
        let catalog = Catalog::open(&dir).unwrap();
        catalog.add_file(&legacy, "loose").unwrap();
        let library = catalog.register_library(&root, None, "local").unwrap();
        let id = library["id"].as_str().unwrap();
        assert!(set_hidden(&catalog, "unknown", "", true).is_err());
        assert!(set_hidden(&catalog, id, "../escape", true).is_err());
        set_hidden(&catalog, id, "", true).unwrap();
        let (assets, libraries, hidden) = visible_catalog(&catalog).unwrap();
        assert!(assets.is_empty() && libraries.is_empty());
        assert_eq!(hidden.len(), 1);
        assert!(legacy.exists());
        set_hidden(&catalog, id, "", false).unwrap();
        assert_eq!(visible_catalog(&catalog).unwrap().0.len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_folder_rules_match_case_and_separator_without_hiding_sibling_prefixes() {
        let temporary = tempfile::tempdir().unwrap();
        let mut catalog = Catalog::open(&temporary.path().join("catalog")).unwrap();
        let root = temporary.path().join("素材");
        fs::create_dir_all(root.join("Folder/Sub")).unwrap();
        fs::create_dir_all(root.join("FolderSuffix/Sub")).unwrap();
        fs::write(root.join("Folder/Sub/hide.obj"), "v 0 0 0").unwrap();
        fs::write(root.join("FolderSuffix/Sub/show.obj"), "v 0 0 0").unwrap();
        let result = catalog.scan(&root, None, "local", |_| {}).unwrap();
        let id = result["library"]["id"].as_str().unwrap();
        set_hidden(&catalog, id, r"folder\SUB", true).unwrap();
        set_hidden(&catalog, id, "FOLDER/sub", true).unwrap();
        let (assets, _, hidden) = visible_catalog(&catalog).unwrap();
        assert_eq!(assets[0].name, "show");
        assert_eq!(assets.len(), 1);
        assert_eq!(hidden.len(), 1);
        set_hidden(&catalog, id, "Folder/Sub", false).unwrap();
        assert_eq!(visible_catalog(&catalog).unwrap().0.len(), 2);
    }
}
