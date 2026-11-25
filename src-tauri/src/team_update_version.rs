use reqwest::{header, Client, Response, StatusCode, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};

const REGISTRY_IMAGE: &str = "https://ghcr.io/v2/jugui-lin/nexus-team";
const RELEASE_SOURCE: &str = "https://github.com/Jugui-Lin/nexus-assets";
const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST: &str = "application/vnd.docker.distribution.manifest.v2+json";
const MAX_CHUNKED_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
struct AnonymousToken {
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    media_type: String,
    config: BlobDescriptor,
}

#[derive(Deserialize)]
struct BlobDescriptor {
    digest: String,
    size: usize,
}

#[derive(Deserialize)]
struct ContainerConfig {
    os: String,
    architecture: String,
    config: ImageConfig,
}

#[derive(Deserialize)]
struct ImageConfig {
    #[serde(rename = "Labels")]
    labels: HashMap<String, String>,
}

async fn read_response(mut response: Response) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("NAS 镜像仓库返回 {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_CHUNKED_BYTES as u64)
    {
        return Err("NAS 镜像版本信息过大".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "无法读取 NAS 镜像版本")?
    {
        if chunk.len() > MAX_CHUNKED_BYTES - body.len() {
            return Err("NAS 镜像版本信息过大".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn valid_stable_version(version: &str) -> bool {
    let mut portions = version.split('.');
    (0..3).all(|_| {
        portions.next().is_some_and(|portion| {
            portion.bytes().all(|byte| byte.is_ascii_digit())
                && (portion.len() == 1 || !portion.starts_with('0'))
                && portion.parse::<u64>().is_ok()
        })
    }) && portions.next().is_none()
}

async fn read_stable_version() -> Result<String, String> {
    // This registry client never carries credentials or URLs from the connected NAS.
    let client = Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法连接 NAS 镜像仓库")?;
    let token_response = client
        .get("https://ghcr.io/token?service=ghcr.io&scope=repository:jugui-lin/nexus-team:pull")
        .send()
        .await
        .map_err(|_| "无法连接 NAS 镜像仓库")?;
    let token: AnonymousToken = serde_json::from_slice(&read_response(token_response).await?)
        .map_err(|_| "无法读取 NAS 镜像仓库的访问响应")?;

    let manifest_response = client
        .get(format!("{REGISTRY_IMAGE}/manifests/stable"))
        .bearer_auth(&token.token)
        .header(header::ACCEPT, format!("{OCI_MANIFEST}, {DOCKER_MANIFEST}"))
        .header(header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|_| "无法获取 NAS 发布镜像")?;
    let manifest: Manifest = serde_json::from_slice(&read_response(manifest_response).await?)
        .map_err(|_| "NAS 发布镜像格式无效")?;
    if manifest.schema_version != 2
        || !matches!(manifest.media_type.as_str(), OCI_MANIFEST | DOCKER_MANIFEST)
        || !manifest
            .config
            .digest
            .strip_prefix("sha256:")
            .is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        || !(1..=MAX_CHUNKED_BYTES).contains(&manifest.config.size)
    {
        return Err("NAS 发布镜像格式无效".into());
    }

    let mut blob = client
        .get(format!("{REGISTRY_IMAGE}/blobs/{}", manifest.config.digest))
        .bearer_auth(&token.token)
        .send()
        .await
        .map_err(|_| "无法获取 NAS 发布镜像配置")?;
    if blob.status() == StatusCode::TEMPORARY_REDIRECT {
        let url = blob
            .headers()
            .get(header::LOCATION)
            .and_then(|location| location.to_str().ok())
            .and_then(|location| Url::parse(location).ok())
            .filter(|url| {
                url.scheme() == "https"
                    && url.host_str() == Some("pkg-containers.githubusercontent.com")
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.port().is_none()
            })
            .ok_or("NAS 镜像配置下载地址无效")?;
        // The CDN URL is already signed by the registry. Don't forward its bearer token.
        blob = client
            .get(url)
            .send()
            .await
            .map_err(|_| "无法下载 NAS 发布镜像配置")?;
    }
    let config_bytes = read_response(blob).await?;
    let digest: String = Sha256::digest(&config_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if config_bytes.len() != manifest.config.size || digest != manifest.config.digest[7..] {
        return Err("NAS 发布镜像配置校验失败".into());
    }

    let config: ContainerConfig =
        serde_json::from_slice(&config_bytes).map_err(|_| "NAS 发布镜像配置无效")?;
    if config.os != "linux"
        || config.architecture != "amd64"
        || !config
            .config
            .labels
            .get("org.opencontainers.image.source")
            .is_some_and(|source| source.eq_ignore_ascii_case(RELEASE_SOURCE))
    {
        return Err("NAS 镜像发布来源无效".into());
    }
    config
        .config
        .labels
        .get("org.opencontainers.image.version")
        .filter(|version| valid_stable_version(version))
        .cloned()
        .ok_or_else(|| "镜像仓库未提供 NAS 版本".into())
}

#[tauri::command]
pub(crate) async fn latest_team_service_version() -> Result<String, String> {
    tokio::time::timeout(Duration::from_secs(10), read_stable_version())
        .await
        .map_err(|_| "检查 NAS 最新版本超时".to_owned())?
}
