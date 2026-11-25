use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    imageops, DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Limits,
};
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};
use tauri::WebviewWindow;

const AVATAR_EDGE: u32 = 96;
const MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_INPUT_EDGE: u32 = 8192;
const MAX_DECODE_BYTES: u64 = 96 * 1024 * 1024;
const AVATAR_FORMATS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp"];
const INPUT_HELP: &str = "请选择不超过 10 MiB 的 PNG、JPEG、WebP 或 BMP 图片";

fn avatar_data_url(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("无法打开头像图片：{error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES {
        return Err(INPUT_HELP.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取头像图片：{error}"))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(INPUT_HELP.into());
    }
    let format = image::guess_format(&bytes).map_err(|_| INPUT_HELP)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Bmp
    ) {
        return Err(INPUT_HELP.into());
    }

    let decode_error = |error| format!("无法读取头像图片：{error}");
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_INPUT_EDGE);
    limits.max_image_height = Some(MAX_INPUT_EDGE);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(decode_error)?;
    let (width, height) = decoder.dimensions();
    limits
        .check_dimensions(width, height)
        .map_err(decode_error)?;
    limits
        .reserve(decoder.total_bytes())
        .map_err(decode_error)?;
    decoder.set_limits(limits).map_err(decode_error)?;
    let orientation = decoder.orientation().ok();
    let source = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    let edge = width.min(height);
    if edge == 0 {
        return Err("头像图片尺寸无效".into());
    }
    let crop = source.view((width - edge) / 2, (height - edge) / 2, edge, edge);
    let mut square = DynamicImage::ImageRgba8(imageops::resize(
        &*crop,
        AVATAR_EDGE,
        AVATAR_EDGE,
        imageops::FilterType::Lanczos3,
    ));
    if let Some(orientation) = orientation {
        square.apply_orientation(orientation);
    }
    let mut png = Cursor::new(Vec::new());
    square
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|error| format!("无法生成头像图片：{error}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
    ))
}

#[tauri::command]
pub(crate) async fn team_pick_avatar(window: WebviewWindow) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_parent(&window)
            .set_title("选择团队头像")
            .add_filter("图片", AVATAR_FORMATS)
            .pick_file()
            .as_deref()
            .map(avatar_data_url)
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    #[test]
    fn crops_to_center_square_and_keeps_source_file_intact() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("团队头像.png");
        let center = Rgba([12, 130, 220, 155]);
        RgbaImage::from_fn(384, 192, |x, _| {
            if (96..288).contains(&x) {
                center
            } else {
                Rgba([240, 50, 60, 255])
            }
        })
        .save(&path)
        .unwrap();
        let before = std::fs::read(&path).unwrap();
        let url = avatar_data_url(&path).unwrap();
        let png = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let avatar = image::load_from_memory_with_format(&png, ImageFormat::Png)
            .unwrap()
            .to_rgba8();
        assert_eq!(avatar.dimensions(), (96, 96));
        assert!(avatar.pixels().all(|pixel| *pixel == center));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn rejects_invalid_format_and_oversized_images() {
        let scratch = tempfile::tempdir().unwrap();
        let invalid = scratch.path().join("bad.png");
        std::fs::write(&invalid, b"<svg></svg>").unwrap();
        assert!(avatar_data_url(&invalid).is_err());
        let oversized = scratch.path().join("huge.png");
        RgbaImage::new(MAX_INPUT_EDGE + 1, 1)
            .save(&oversized)
            .unwrap();
        assert!(avatar_data_url(&oversized).is_err());
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_INPUT_BYTES + 1)
            .unwrap();
        assert!(avatar_data_url(&oversized).is_err());
    }
}
