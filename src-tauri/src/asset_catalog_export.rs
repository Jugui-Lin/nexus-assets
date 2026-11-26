use crate::{thumbnail_desktop, workspaces, AppState};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Component, Path, PathBuf},
};

const COVER_EDGE: u32 = 256;
const MAX_COVER_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineCatalog {
    html_path: String,
    assets: usize,
    covers: usize,
}

struct CatalogRow {
    name: String,
    format: String,
    tags: Vec<String>,
    href: String,
}

fn encoded_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn relative_link(relative: &Path) -> Option<String> {
    let mut link = String::from("..");
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return None;
        };
        link.push('/');
        link.push_str(&encoded_segment(segment.to_str()?));
    }
    (link != "..").then_some(link)
}

fn source_link(root: &Path, asset_path: &str) -> Option<String> {
    let source = fs::canonicalize(asset_path).ok()?;
    if !source.is_file() {
        return None;
    }
    relative_link(source.strip_prefix(root).ok()?)
}

fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn cover_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > MAX_COVER_BYTES {
        return None;
    }
    match image::guess_format(bytes).ok()? {
        image::ImageFormat::Jpeg => Some("jpg"),
        image::ImageFormat::Png => Some("png"),
        image::ImageFormat::WebP => Some("webp"),
        image::ImageFormat::Gif => Some("gif"),
        _ => None,
    }
}

fn write_page_header(writer: &mut impl Write, rows: usize) -> std::io::Result<()> {
    writer.write_all(br#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
:root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
body{margin:28px auto;padding:0 16px;max-width:1220px}h1{margin:0;font-size:24px}p{margin:8px 0}
.assets{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:12px;list-style:none;margin:16px 0;padding:0}
.asset{overflow:hidden;min-width:0;border:1px solid color-mix(in srgb,CanvasText 23%,Canvas);border-radius:8px;background:Canvas}
.cover{display:grid;place-items:center;aspect-ratio:16/10;background:color-mix(in srgb,CanvasText 6%,Canvas);overflow:hidden}
.cover img{width:100%;height:100%;object-fit:contain}.cover span{font-size:.8em}
.info{padding:8px 11px}h2{margin:0;font-size:1em;overflow-wrap:anywhere}p,small{overflow-wrap:anywhere}small{display:block;margin:5px 0}
</style><title>"#)?;
    write!(writer, "项目资产目录</title></head><body><h1>项目资产目录</h1><p>{rows} 项资产</p><ul class=\"assets\">\n")
}

fn write_row(writer: &mut impl Write, row: CatalogRow, cover: Option<&str>) -> std::io::Result<()> {
    write!(writer, "<li class=\"asset\"><div class=\"cover\">")?;
    if let Some(cover) = cover {
        write!(
            writer,
            "<img alt=\"\" src=\"covers/{cover}\" loading=\"lazy\">"
        )?;
    } else {
        write!(writer, "<span>暂无封面</span>")?;
    }
    write!(
        writer,
        "</div><div class=\"info\"><h2>{}</h2>",
        escape(&row.name)
    )?;
    let mut details = row.tags;
    if !row.format.is_empty() {
        details.insert(0, row.format);
    }
    if !details.is_empty() {
        write!(writer, "<small>{}</small>", escape(&details.join(" · ")))?;
    }
    writeln!(
        writer,
        "<a href=\"{}\">打开原文件</a></div></li>",
        escape(&row.href)
    )
}

fn save_catalog(
    root: &Path,
    rows: impl ExactSizeIterator<Item = (CatalogRow, Option<Vec<u8>>)>,
) -> Result<OfflineCatalog, String> {
    let count = rows.len();
    let staged = tempfile::Builder::new()
        .prefix(".nexus-catalog-")
        .tempdir_in(root)
        .map_err(|error| format!("无法在项目根目录创建导出：{error}"))?;
    let path = staged.path().join("index.html");
    let covers_dir = staged.path().join("covers");
    let mut file = BufWriter::new(File::create(&path).map_err(|error| error.to_string())?);
    let mut covers = 0;
    write_page_header(&mut file, count).map_err(|error| error.to_string())?;
    for (index, (row, cover)) in rows.enumerate() {
        let cover_file = cover
            .as_deref()
            .and_then(cover_extension)
            .map(|extension| format!("{:06}.{extension}", index + 1));
        if let Some((name, bytes)) = cover_file.as_deref().zip(cover.as_deref()) {
            if covers == 0 {
                fs::create_dir(&covers_dir).map_err(|error| error.to_string())?;
            }
            fs::write(covers_dir.join(name), bytes).map_err(|error| error.to_string())?;
            covers += 1;
        }
        write_row(&mut file, row, cover_file.as_deref()).map_err(|error| error.to_string())?;
    }
    file.write_all(b"</ul></body></html>\n")
        .map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
    drop(file);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let destination = root.join(format!("Nexus 资产目录-{}", &id[..12]));
    fs::rename(staged.path(), &destination).map_err(|error| format!("无法保存目录：{error}"))?;
    Ok(OfflineCatalog {
        html_path: nexus_core::clean_path(&destination.join("index.html")),
        assets: count,
        covers,
    })
}

fn project_directory(root: &str) -> Result<PathBuf, String> {
    let root = Path::new(root);
    if !root.is_absolute() {
        return Err("请选择完整的项目根目录".into());
    }
    let directory =
        fs::canonicalize(root).map_err(|error| format!("无法访问项目根目录：{error}"))?;
    if !directory.is_dir() {
        return Err("请选择可访问的项目根目录".into());
    }
    Ok(directory)
}

#[tauri::command]
pub(crate) async fn export_offline_asset_catalog(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    root: String,
    ids: Vec<String>,
) -> Result<OfflineCatalog, String> {
    if ids.is_empty() {
        return Err("请选择要导出的资产".into());
    }
    let _preview = thumbnail_desktop::image_slot().await?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = project_directory(&root)?;
        let mut seen = HashSet::new();
        let mut sources = Vec::new();
        {
            let _workspace = workspaces::lock_io(&state)?;
            for id in ids.iter().filter(|id| seen.insert(*id)) {
                let source = thumbnail_desktop::PreviewSource::resolve(&state, &app, id)?;
                let asset = &source.asset;
                let href = source_link(&root, &asset.path).ok_or_else(|| {
                    format!(
                        "资产「{}」不可访问或位于项目根目录之外，请核对导出范围",
                        asset.name
                    )
                })?;
                let row = CatalogRow {
                    name: asset.name.clone(),
                    format: asset.ext.to_uppercase(),
                    tags: asset.tags.clone(),
                    href,
                };
                sources.push((row, source));
            }
        }
        save_catalog(
            &root,
            sources.into_iter().map(|(row, source)| {
                let cover = source
                    .thumbnail(COVER_EDGE)
                    .ok()
                    .flatten()
                    .map(|(_, bytes)| bytes);
                (row, cover)
            }),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn relative_source_has_encoded_segments_and_stays_in_canonical_project() {
        let project = tempfile::tempdir().unwrap();
        let root = project_directory(project.path().to_str().unwrap()).unwrap();
        let folder = root.join("镜头 01");
        fs::create_dir(&folder).unwrap();
        let inside = folder.join("A #& 100%.txt");
        fs::write(&inside, b"source").unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(
            source_link(&root, inside.to_str().unwrap()).as_deref(),
            Some("../%E9%95%9C%E5%A4%B4%2001/A%20%23%26%20100%25.txt")
        );
        assert_eq!(source_link(&root, outside.path().to_str().unwrap()), None);
        assert_eq!(source_link(&root, folder.to_str().unwrap()), None);
        assert_eq!(relative_link(Path::new("../external")), None);
    }

    #[test]
    fn render_portable_catalog_with_raster_cover_and_safe_text() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path();
        let original = root.join("real source.png");
        let mut image = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(6, 5)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        let image = image.into_inner();
        fs::write(&original, &image).unwrap();
        let row = || CatalogRow {
            name: "<script>alert(1)</script> & 原图".to_owned(),
            format: "PNG".to_owned(),
            tags: vec!["\"组\"".to_owned()],
            href: "../real%20source.png".to_owned(),
        };
        let result = save_catalog(
            root,
            [
                (row(), Some(image.clone())),
                (row(), Some(b"<svg/>".to_vec())),
            ]
            .into_iter(),
        )
        .unwrap();
        assert_eq!(result.assets, 2);
        assert_eq!(result.covers, 1);
        let path = PathBuf::from(&result.html_path);
        let html = fs::read_to_string(&path).unwrap();
        assert!(html.contains("src=\"covers/000001.png\""));
        assert!(html.contains("href=\"../real%20source.png\""));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; 原图"));
        assert!(html.contains("&quot;组&quot;"));
        assert!(html.contains("暂无封面"));
        assert!(!html.contains("<script>"));
        assert_eq!(fs::read(original).unwrap(), image);
        assert_eq!(
            fs::read(path.parent().unwrap().join("covers/000001.png")).unwrap(),
            image
        );
        assert!(fs::read_dir(root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".nexus-catalog-")));
    }
}
