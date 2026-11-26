use crate::{
    folder_deletion::{canonical_directory, path_key, protected_data_roots, protected_name},
    workspace_folder_move::rename_no_replace,
    AppState,
};
use nexus_core::{clean_path, team::relative_path};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeliveryTemplate {
    destination: String,
    project: String,
    date: String,
    root_pattern: String,
    folders: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeliveryPlan {
    root: String,
    folders: Vec<String>,
    exists: bool,
}

fn valid_date(value: &str) -> bool {
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() != 3
        || parts[0].len() != 4
        || parts[1].len() != 2
        || parts[2].len() != 2
        || !parts
            .iter()
            .all(|part| part.bytes().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        parts[0].parse::<u16>(),
        parts[1].parse::<usize>(),
        parts[2].parse::<usize>(),
    ) else {
        return false;
    };
    let days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let leap = month == 2 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    month > 0 && month <= 12 && day > 0 && day <= days[month - 1] + usize::from(leap)
}

fn expanded(pattern: &str, project: &str, date: &str) -> Result<String, String> {
    if pattern.len() > 2048 {
        return Err("目录模板行过长".into());
    }
    let path = pattern
        .trim()
        .replace("{项目}", project)
        .replace("{日期}", date);
    if path.contains(['{', '}']) {
        return Err("仅支持 {项目} 与 {日期} 两种占位符".into());
    }
    let count = path.split('/').count();
    if count > 8
        || relative_path(&path).is_none()
        || path
            .split('/')
            .any(|part| protected_name(part) || part.encode_utf16().count() > 120)
    {
        return Err(format!("目录模板包含无效的名称或层级：{path}"));
    }
    Ok(path)
}

fn plan_names(input: &DeliveryTemplate) -> Result<(String, Vec<String>), String> {
    let project = input.project.trim();
    if project.is_empty()
        || project.contains(['/', '{', '}'])
        || relative_path(project).is_none()
        || project.chars().count() > 80
    {
        return Err("请输入有效的项目名称，最多 80 个字符".into());
    }
    if !valid_date(&input.date) {
        return Err("请输入有效日期".into());
    }
    let root_name = expanded(&input.root_pattern, project, &input.date)?;
    if root_name.contains('/') {
        return Err("新建的最外层目录只允许一个名称".into());
    }
    if input.folders.is_empty() || input.folders.len() > 48 {
        return Err("一个模板需要 1–48 行子目录".into());
    }
    let mut paths = BTreeMap::<String, String>::new();
    for pattern in &input.folders {
        let path = expanded(pattern, project, &input.date)?;
        let mut part_path = String::new();
        for part in path.split('/') {
            if !part_path.is_empty() {
                part_path.push('/');
            }
            part_path.push_str(part);
            let known = paths
                .entry(part_path.to_lowercase())
                .or_insert_with(|| part_path.clone());
            if *known != part_path {
                return Err(format!("目录名称只有大小写不同：{known} 与 {part_path}"));
            }
        }
    }
    if paths.len() > 96 {
        return Err("包含上级目录在内，一次最多可建立 96 个子目录".into());
    }
    Ok((root_name, paths.into_values().collect()))
}

fn prepare(
    input: &DeliveryTemplate,
    protected: &[PathBuf],
) -> Result<(PathBuf, DeliveryPlan), String> {
    let (name, folders) = plan_names(input)?;
    let base = canonical_directory(Path::new(&input.destination))?;
    let target = base.join(name);
    let key = path_key(&target);
    if protected.iter().any(|path| {
        key.starts_with(path_key(path))
            || fs::canonicalize(path).is_ok_and(|canonical| key.starts_with(path_key(&canonical)))
    }) {
        return Err("请选择资料库数据目录之外的项目位置".into());
    }
    let exists = match fs::symlink_metadata(&target) {
        Ok(_) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(format!("无法核对目标目录：{error}")),
    };
    let plan = DeliveryPlan {
        root: clean_path(&target),
        folders,
        exists,
    };
    Ok((target, plan))
}

fn publish(input: &DeliveryTemplate, protected: &[PathBuf]) -> Result<DeliveryPlan, String> {
    let (target, plan) = prepare(input, protected)?;
    if plan.exists {
        return Err("目标位置已有同名文件或文件夹，请修改名称".into());
    }
    let destination = target.parent().ok_or("目标位置无效")?;
    let staging = tempfile::Builder::new()
        .prefix(".nexus-delivery-")
        .tempdir_in(destination)
        .map_err(|error| format!("无法建立临时目录：{error}"))?;
    let ready = staging.path().join("ready");
    for child in &plan.folders {
        fs::create_dir_all(ready.join(child))
            .map_err(|error| format!("无法创建「{child}」：{error}"))?;
    }
    rename_no_replace(&ready, &target).map_err(|error| format!("无法发布完整目录：{error}"))?;
    Ok(plan)
}

#[tauri::command]
pub(super) async fn preview_delivery_template(
    state: tauri::State<'_, AppState>,
    input: DeliveryTemplate,
) -> Result<DeliveryPlan, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        prepare(&input, &protected_data_roots(&state)?).map(|(_, plan)| plan)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) async fn create_delivery_template(
    state: tauri::State<'_, AppState>,
    input: DeliveryTemplate,
) -> Result<DeliveryPlan, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace = crate::workspaces::lock_io(&state)?;
        publish(&input, &protected_data_roots(&state)?)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_uses_real_nested_placeholders_and_publication_preserves_existing_targets() {
        let root = tempfile::tempdir().unwrap();
        let mut request = DeliveryTemplate {
            destination: clean_path(root.path()),
            project: "扫地机".into(),
            date: "2028-02-29".into(),
            root_pattern: "{项目}_{日期}".into(),
            folders: vec![
                "材质/贴图".into(),
                "交付/{日期}".into(),
                "工程/{项目}".into(),
            ],
        };
        let (target, expected) = prepare(&request, &[]).unwrap();
        assert_eq!(expected.folders.len(), 6);
        assert!(!target.exists());
        publish(&request, &[]).unwrap();
        assert!(target.join("交付/2028-02-29").is_dir());
        fs::write(target.join("existing.bin"), b"keep").unwrap();
        assert!(publish(&request, &[]).is_err());
        assert_eq!(fs::read(target.join("existing.bin")).unwrap(), b"keep");
        request.root_pattern = "{项目}_b".into();
        request.folders.push("工程/../外部".into());
        assert!(publish(&request, &[]).is_err());
        assert!(!root.path().join("扫地机_b").exists());
        request.folders.pop();
        request.date = "2027-02-29".into();
        assert!(prepare(&request, &[]).is_err());
    }
}
