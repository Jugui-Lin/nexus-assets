use image::{DynamicImage, RgbaImage};
use png::{BitDepth, ColorType, Decoder, Limits, Transformations};
use std::{
    fs::File,
    io::{BufReader, Read},
    path::Path,
};

pub(super) const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
pub(super) const STREAMING_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SOURCE_EDGE: u32 = 32_768;
const MAX_SOURCE_PIXELS: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT_EDGE: u32 = 2_048;
const ROW_DECODER_BUDGET: usize = 16 * 1024 * 1024;
const SAMPLES_PER_AXIS: usize = 4;
const LIMIT_ERROR: &str = "PNG 图像超过当前预览尺寸或文件大小限制。";

fn preview_dimensions(width: u32, height: u32, max_size: u32) -> Result<(u32, u32), String> {
    let edge = width.max(height);
    if width.min(height) == 0
        || edge > MAX_SOURCE_EDGE
        || u64::from(width) * u64::from(height) > MAX_SOURCE_PIXELS
        || max_size == 0
    {
        return Err(LIMIT_ERROR.into());
    }
    let limit = max_size.min(MAX_OUTPUT_EDGE).min(edge);
    let fit = |extent: u32| ((extent * limit) / edge).max(1);
    Ok((fit(width), fit(height)))
}

fn sample_position(index: usize, sample_count: usize, source_extent: usize) -> usize {
    ((2 * index + 1) * source_extent) / (2 * sample_count)
}

fn rgba(row: &[u8], start: usize, color: ColorType, step: usize) -> [u32; 4] {
    let sample = |channel| u32::from(row[start + channel * step]);
    let first = sample(0);
    match color {
        ColorType::Grayscale => [first, first, first, 255],
        ColorType::GrayscaleAlpha => [first, first, first, sample(1)],
        ColorType::Rgb => [first, sample(1), sample(2), 255],
        ColorType::Rgba => [first, sample(1), sample(2), sample(3)],
        ColorType::Indexed => unreachable!("PNG palettes are expanded before sampling"),
    }
}

pub(super) fn decode(path: &Path, max_size: u32) -> Result<Option<DynamicImage>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_SOURCE_BYTES {
        return Err(LIMIT_ERROR.into());
    }
    let mut decoder = Decoder::new_with_limits(
        BufReader::with_capacity(128 * 1024, file.take(MAX_SOURCE_BYTES)),
        Limits {
            bytes: ROW_DECODER_BUDGET,
        },
    );
    decoder.set_transformations(Transformations::EXPAND);
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    let png_error = |error: png::DecodingError| format!("无法解码 PNG 图片：{error}");
    let header = decoder.read_header_info().map_err(png_error)?;
    let (width, height) = (header.width, header.height);
    let (target_width, target_height) = match preview_dimensions(width, height, max_size) {
        Ok(size) if !header.interlaced => size,
        _ => return Ok(None),
    };
    let mut reader = decoder.read_info().map_err(png_error)?;
    if reader.info().animation_control.is_some() {
        return Ok(None);
    }
    let (color, depth) = reader.output_color_type();
    let channel_bytes = match depth {
        BitDepth::Eight => 1,
        BitDepth::Sixteen => 2,
        _ => return Err("无法解码 PNG 图片：不支持的采样深度".into()),
    };
    if color == ColorType::Indexed {
        return Err("无法解码 PNG 图片：无法读取调色板".into());
    }
    let bytes_per_pixel = color.samples() * channel_bytes;
    let (width, height) = (width as usize, height as usize);
    let (target_columns, target_rows) = (target_width as usize, target_height as usize);
    let horizontal_samples = (width / target_columns).clamp(1, SAMPLES_PER_AXIS);
    let vertical_samples = (height / target_rows).clamp(1, SAMPLES_PER_AXIS);
    let sample_columns = horizontal_samples * target_columns;
    let sample_rows = vertical_samples * target_rows;
    let sample_count = (horizontal_samples * vertical_samples) as u32;
    let columns: Vec<_> = (0..sample_columns)
        .map(|index| sample_position(index, sample_columns, width) * bytes_per_pixel)
        .collect();
    let mut row = vec![0; width * bytes_per_pixel];
    let mut output = Vec::with_capacity(target_columns * target_rows * 4);
    let mut totals = vec![[0u32; 4]; target_columns];
    let mut next_sample = 0;

    // PNG needs sequential inflation, but only a bounded set of samples per
    // output pixel contributes to the thumbnail. No source-sized bitmap exists.
    for source_y in 0..height {
        if reader.read_row(&mut row).map_err(png_error)?.is_none() {
            return Err("无法解码 PNG 图片：图像像素数据不完整".into());
        }
        if next_sample == sample_rows
            || source_y != sample_position(next_sample, sample_rows, height)
        {
            continue;
        }
        for (total, samples) in totals
            .iter_mut()
            .zip(columns.chunks_exact(horizontal_samples))
        {
            for &offset in samples {
                let [r, g, b, alpha] = rgba(&row, offset, color, channel_bytes);
                total[0] += r * alpha;
                total[1] += g * alpha;
                total[2] += b * alpha;
                total[3] += alpha;
            }
        }
        next_sample += 1;
        if next_sample % vertical_samples == 0 {
            for &[r, g, b, alpha] in &totals {
                let unpremultiply = |sum| ((sum + alpha / 2) / alpha.max(1)) as u8;
                output.extend_from_slice(&[
                    unpremultiply(r),
                    unpremultiply(g),
                    unpremultiply(b),
                    ((alpha + sample_count / 2) / sample_count) as u8,
                ]);
            }
            totals.fill([0; 4]);
        }
    }
    if reader.read_row(&mut row).map_err(png_error)?.is_some() {
        return Err("无法解码 PNG 图片：图像行数不符".into());
    }
    reader.finish().map_err(png_error)?;
    let result =
        RgbaImage::from_raw(target_width, target_height, output).ok_or("无法生成 PNG 缩略图")?;
    Ok(Some(DynamicImage::ImageRgba8(result)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_16_bit_alpha_into_a_scaled_preview() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("sky.png");
        let file = File::create(&path).unwrap();
        let mut encoder = png::Encoder::new(file, 8, 4);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Sixteen);
        let transparent_red = [255, 255, 0, 0, 0, 0, 0, 0];
        let opaque_turquoise = [0, 0, 128, 0, 255, 255, 255, 255];
        let pixels = [transparent_red, opaque_turquoise].concat().repeat(16);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&pixels).unwrap();
        writer.finish().unwrap();

        let thumbnail = decode(&path, 2).unwrap().unwrap().into_rgba8();
        assert_eq!(thumbnail.dimensions(), (2, 1));
        assert_eq!(thumbnail.into_raw(), [0, 128, 255, 128].repeat(2));
        assert_eq!(preview_dimensions(16_815, 6_537, 256).unwrap(), (256, 99));
        assert!(preview_dimensions(32_768, 32_768, 256).is_err());
    }
}
