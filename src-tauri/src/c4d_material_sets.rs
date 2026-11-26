use nexus_core::Asset;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_MAP_FILES: usize = 48;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MaterialSetRequest {
    pub(crate) name: String,
    channels: BTreeMap<String, Vec<String>>,
}

impl MaterialSetRequest {
    pub(crate) fn resolve(
        &self,
        anchor_id: &str,
        anchor: &Asset,
        mut asset_by_id: impl FnMut(&str) -> Result<Asset, String>,
    ) -> Result<BTreeMap<String, Vec<String>>, String> {
        if self.name.trim().is_empty()
            || self.name.chars().count() > 255
            || self.name.chars().any(char::is_control)
            || self.channels.is_empty()
            || self.channels.len() > 12
            || self.channels.values().map(Vec::len).sum::<usize>() > MAX_MAP_FILES
        {
            return Err("材质套图的名称或贴图数量无效。".into());
        }
        let anchor_source = material_source(anchor)?;
        let directory = anchor_source.parent().ok_or("材质套图目录无效。")?;
        let anchor_team = anchor_id.starts_with("team:");
        let mut paths = HashSet::new();
        let mut resolved = BTreeMap::new();
        for (channel, ids) in &self.channels {
            if !matches!(
                channel.as_str(),
                "base_color"
                    | "ao"
                    | "metallic"
                    | "roughness"
                    | "specular"
                    | "glossiness"
                    | "bump"
                    | "normal"
                    | "opacity"
                    | "displacement"
                    | "emission"
                    | "translucency"
            ) || ids.is_empty()
            {
                return Err("材质套图包含无法识别的贴图通道。".into());
            }
            let mut variants = Vec::with_capacity(ids.len());
            for id in ids {
                if id.is_empty() || id.len() > 160 || id.starts_with("team:") != anchor_team {
                    return Err("材质套图中的贴图必须来自同一资产库。".into());
                }
                let asset;
                let asset = if id == anchor_id {
                    anchor
                } else {
                    asset = asset_by_id(id)?;
                    &asset
                };
                if asset.library_id != anchor.library_id {
                    return Err("材质套图中的贴图必须来自同一资产库。".into());
                }
                let path = material_source(asset)?;
                if path.parent() != Some(directory) || !paths.insert(path) {
                    return Err(
                        "材质套图中的贴图必须来自同一目录，且每个文件只对应一个通道。".into(),
                    );
                }
                variants.push(asset.path.clone());
            }
            resolved.insert(channel.clone(), variants);
        }
        if !paths.contains(&anchor_source) {
            return Err("材质套图缺少用于定位的贴图。".into());
        }
        Ok(resolved)
    }
}

fn material_source(asset: &Asset) -> Result<PathBuf, String> {
    let path = Path::new(&asset.path);
    if asset.demo || !path.is_absolute() {
        return Err("材质套图需要可访问的磁盘或共享目录文件。".into());
    }
    let unavailable = |_| "材质套图的源文件不可用，请检查磁盘或共享目录。".to_string();
    let info = fs::symlink_metadata(path).map_err(unavailable)?;
    if !info.file_type().is_file()
        || !path
            .extension()
            .and_then(|item| item.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "jpg"
                        | "jpeg"
                        | "png"
                        | "tif"
                        | "tiff"
                        | "bmp"
                        | "webp"
                        | "tga"
                        | "psd"
                        | "dds"
                        | "gif"
                        | "hdr"
                        | "exr"
                )
            })
    {
        return Err("材质套图包含不支持的文件。".into());
    }
    fs::canonicalize(path).map_err(unavailable)
}
