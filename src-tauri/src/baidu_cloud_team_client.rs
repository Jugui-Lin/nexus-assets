use super::{Desktop, Method, StatusCode, Url, Value};
use crate::baidu_cloud_desktop::{
    download_name, linked_path, save_destination, CloudAction, DOWNLOAD_LIMIT,
};
use serde_json::json;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

impl Desktop {
    pub(crate) async fn baidu_cloud_request(
        &self,
        team_id: &str,
        action: CloudAction,
    ) -> Result<Value, String> {
        let active = self.active_connection()?;
        if active.identity.team_id != team_id {
            return Err("团队工作空间已切换".into());
        }
        let mut body = None;
        let mut query = None;
        let mut download = None;
        let status_only = matches!(action, CloudAction::Status);
        let needs_new_endpoint =
            matches!(action, CloudAction::CreateAppFolder | CloudAction::Logout);
        let (method, path) = match action {
            CloudAction::Links => (Method::GET, "/v1/baidu/shares".into()),
            CloudAction::Status => (Method::GET, "/v1/baidu/status".into()),
            CloudAction::Start => (Method::POST, "/v1/baidu/login".into()),
            CloudAction::Poll => (Method::GET, "/v1/baidu/login".into()),
            CloudAction::Cancel => (Method::POST, "/v1/baidu/login/cancel".into()),
            CloudAction::CreateAppFolder => (Method::POST, "/v1/baidu/app-folder".into()),
            CloudAction::Logout => (Method::POST, "/v1/baidu/logout".into()),
            CloudAction::Browse { path, offset } => {
                nexus_core::baidu_cloud::normalize_path(&path)?;
                query = Some((path, Some(offset)));
                (Method::GET, "/v1/baidu/folders".into())
            }
            CloudAction::Add { path } => {
                nexus_core::baidu_cloud::normalize_path(&path)?;
                body = Some(serde_json::to_vec(&json!({"path":path})).map_err(|e| e.to_string())?);
                (Method::POST, "/v1/baidu/shares".into())
            }
            CloudAction::Remove { id } => (Method::DELETE, format!("/v1/baidu/shares/{id}")),
            CloudAction::List { id, path, offset } => {
                linked_path("/apps/bdpan", &path)?;
                query = Some((path, Some(offset)));
                (Method::GET, format!("/v1/baidu/shares/{id}/files"))
            }
            CloudAction::Download { id, path } => {
                let name = download_name(&path)?.to_owned();
                let destination =
                    tauri::async_runtime::spawn_blocking(move || save_destination(&name))
                        .await
                        .map_err(|_| "无法打开保存窗口")?;
                let Some(destination) = destination else {
                    return Ok(json!({"saved":false}));
                };
                if self.active_connection()? != active {
                    return Err("团队工作空间已切换".into());
                }
                download = Some(destination);
                query = Some((path, None));
                (Method::GET, format!("/v1/baidu/shares/{id}/download"))
            }
        };
        let route = if let Some((path_value, offset)) = query {
            let mut url = Url::parse("https://nexus.invalid").map_err(|_| "团队网盘请求无效")?;
            url.set_path(&path);
            {
                let mut fields = url.query_pairs_mut();
                fields.append_pair("path", &path_value);
                if let Some(offset) = offset {
                    fields.append_pair("offset", &offset.to_string());
                }
            }
            format!("{path}?{}", url.query().unwrap_or_default())
        } else {
            path
        };
        let request = self.authenticated_request(&active.config, method, &route, body);
        let mut response =
            Self::send(request.timeout(Duration::from_secs(if download.is_some() {
                900
            } else {
                90
            })))
            .await?;
        if response.status() == StatusCode::NOT_FOUND && status_only {
            return Ok(json!({"available":false,"connected":false,"upgradeRequired":true}));
        }
        if self.active_connection()? != active {
            return Err("团队工作空间已切换".into());
        }
        if response.status() == StatusCode::NOT_FOUND && needs_new_endpoint {
            return Err("当前团队服务暂不支持此操作，请更新 NAS 团队服务".into());
        }
        match download {
            Some(destination) if response.status().is_success() => {
                let length = response
                    .content_length()
                    .filter(|size| *size <= DOWNLOAD_LIMIT)
                    .ok_or("团队服务未提供可用的文件长度")?;
                let parent = destination.parent().ok_or("保存位置无效")?;
                let temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
                let mut output =
                    tokio::fs::File::from_std(temp.reopen().map_err(|e| e.to_string())?);
                let mut received = 0;
                while let Some(chunk) = response.chunk().await.map_err(|_| "网盘文件下载中断")?
                {
                    received += chunk.len() as u64;
                    if received > length {
                        return Err("网盘文件长度不匹配".into());
                    }
                    output.write_all(&chunk).await.map_err(|e| e.to_string())?;
                }
                if received != length {
                    return Err("网盘文件下载不完整".into());
                }
                output.flush().await.map_err(|e| e.to_string())?;
                drop(output);
                if self.active_connection()? != active {
                    return Err("团队工作空间已切换".into());
                }
                temp.persist(destination).map_err(|e| e.to_string())?;
                Ok(json!({"saved":true}))
            }
            _ => Self::decode_response(response).await,
        }
    }
}
