use exr::{
    meta::{attribute::Text, BlockDescription, MetaData},
    prelude::{read, ReadChannels, ReadLayers, ReadSpecificChannel, Vec2},
};
use image::{
    codecs::hdr::HdrDecoder, DynamicImage, GrayImage, ImageBuffer, ImageDecoder, Luma, Rgb,
};
use std::{
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

const MAX_EDGE: usize = 32768;
const MAX_PLANE_PIXELS: usize = 128 * 1024 * 1024;
const METADATA_BUDGET: u64 = 4 * 1024 * 1024;
const EXR_LIMIT_ERROR: &str = "EXR 图像超过预览尺寸或解码内存限制。";
const HDR_HEADER_BUDGET: u64 = 64 * 1024;

mod exr_compare;
pub use exr_compare::read_exr_views;

struct PreviewPixels {
    source: Vec2<usize>,
    image: ImageBuffer<Luma<f32>, Vec<f32>>,
}

fn preview_dimensions(
    size: Vec2<usize>,
    max_alloc: u64,
    max_size: u32,
    bytes_per_pixel: u64,
) -> Option<(u32, u32)> {
    let extent = size.width().max(size.height());
    let short = size.width().min(size.height());
    let max_pixels = max_alloc / bytes_per_pixel;
    if extent > MAX_EDGE
        || short == 0
        || max_pixels == 0
        || max_size == 0
        || size.width().checked_mul(size.height())? > MAX_PLANE_PIXELS
    {
        return None;
    }
    let memory_extent = (max_pixels as f64 * extent as f64 / short as f64).sqrt() as u64;
    let output_extent = u64::from(max_size)
        .min(extent as u64)
        .min(max_pixels)
        .min(memory_extent) as usize;
    let width = (size.width() * output_extent / extent).max(1);
    let height = (size.height() * output_extent / extent).max(1);
    Some((width as u32, height as u32))
}

/// Decode one Radiance scanline at a time, then average cells in linear light.
pub(crate) fn decode_hdr(
    path: &Path,
    max_alloc: u64,
    max_size: u32,
) -> Result<DynamicImage, String> {
    let mut reader = BufReader::with_capacity(
        256 * 1024,
        File::open(path).map_err(|error| error.to_string())?,
    );
    let decode_error = |error| format!("无法解码 HDR 图片：{error}");
    let (source_width, source_height) = HdrDecoder::new((&mut reader).take(HDR_HEADER_BUDGET))
        .map_err(decode_error)?
        .dimensions();
    let source_width = source_width as usize;
    let source_height = source_height as usize;
    // Keep room for RGB32F, the display conversion and PNG encoding.
    let (width, height) =
        preview_dimensions(Vec2(source_width, source_height), max_alloc, max_size, 32)
            .ok_or("HDR 图像超过预览尺寸或解码内存限制。")?;
    let mut preview = ImageBuffer::new(width, height);
    let mut row = vec![[0; 4]; source_width];
    let mut sums = vec![[0.0; 3]; width as usize];
    let columns = (0..width as usize)
        .map(|x| {
            let scale = width as usize;
            (x * source_width / scale)..((x + 1) * source_width / scale)
        })
        .collect::<Vec<_>>();
    let mut exponent = std::array::from_fn::<_, 256, _>(|value| (value as f64 - 136.0).exp2());
    exponent[0] = 0.0;
    for y in 0..height as usize {
        let start = y * source_height / height as usize;
        let end = (y + 1) * source_height / height as usize;
        sums.fill([0.0; 3]);
        for _ in start..end {
            read_hdr_scanline(&mut reader, &mut row).map_err(|error| decode_error(error.into()))?;
            for (sum, columns) in sums.iter_mut().zip(&columns) {
                for &[r, g, b, e] in &row[columns.clone()] {
                    let scale = exponent[e as usize];
                    sum[0] += f64::from(r) * scale;
                    sum[1] += f64::from(g) * scale;
                    sum[2] += f64::from(b) * scale;
                }
            }
        }
        for (x, (sum, columns)) in sums.iter().zip(&columns).enumerate() {
            let count = ((end - start) * columns.len()) as f64;
            preview.put_pixel(
                x as u32,
                y as u32,
                Rgb(sum.map(|value| (value / count) as f32)),
            );
        }
    }
    Ok(DynamicImage::ImageRgb32F(preview))
}

fn read_hdr_scanline(reader: &mut impl Read, row: &mut [[u8; 4]]) -> io::Result<()> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "HDR 扫描线编码无效");
    let mut pixel = [0; 4];
    reader.read_exact(&mut pixel)?;
    if (8..=32767).contains(&row.len()) && pixel[0..2] == [2, 2] && pixel[2] < 128 {
        if usize::from(u16::from_be_bytes([pixel[2], pixel[3]])) != row.len() {
            return Err(invalid());
        }
        let mut literal = [0; 128];
        let mut control = [0];
        for channel in 0..4 {
            let mut rest = &mut row[..];
            while !rest.is_empty() {
                reader.read_exact(&mut control)?;
                let length = usize::from(control[0]);
                let repeated = length > 128;
                let count = if repeated { length - 128 } else { length };
                if count == 0 || count > rest.len() {
                    return Err(invalid());
                }
                let (packet, tail) = rest.split_at_mut(count);
                if repeated {
                    reader.read_exact(&mut control)?;
                    for pixel in packet {
                        pixel[channel] = control[0];
                    }
                } else {
                    reader.read_exact(&mut literal[..count])?;
                    for (pixel, &value) in packet.iter_mut().zip(&literal[..count]) {
                        pixel[channel] = value;
                    }
                }
                rest = tail;
            }
        }
        return Ok(());
    }
    // Older Radiance files store interleaved RGBE, optionally with run markers.
    let mut next = 0_usize;
    let mut shift = 0;
    loop {
        if pixel[..3] == [1, 1, 1] {
            let previous = *row
                .get(next.checked_sub(1).ok_or_else(invalid)?)
                .ok_or_else(invalid)?;
            let count = u32::from(pixel[3]).checked_shl(shift).ok_or_else(invalid)? as usize;
            if count > row.len() - next {
                return Err(invalid());
            }
            row[next..next + count].fill(previous);
            next += count;
            shift += 8;
        } else {
            row[next] = pixel;
            next += 1;
            shift = 0;
        }
        if next == row.len() {
            return Ok(());
        }
        reader.read_exact(&mut pixel)?;
    }
}

fn valid_metadata(metadata: &MetaData, max_alloc: u64, max_size: u32) -> bool {
    valid_metadata_with_limit(metadata, max_alloc, max_size, 32)
}

fn valid_metadata_with_limit(
    metadata: &MetaData,
    max_alloc: u64,
    max_size: u32,
    max_channels: usize,
) -> bool {
    if metadata.headers.is_empty() || metadata.headers.len() > 32 {
        return false;
    }
    let mut table_count: u64 = 0;
    for header in &metadata.headers {
        let size = header.layer_size;
        if header.deep
            || header.channels.list.len() > max_channels
            || preview_dimensions(size, max_alloc, max_size, 8).is_none()
        {
            return false;
        }
        table_count = table_count.saturating_add(header.chunk_count as u64);
        let (block_width, block_height) = match header.blocks {
            BlockDescription::ScanLines => {
                (size.width(), header.compression.scan_lines_per_block())
            }
            BlockDescription::Tiles(tiles) => (tiles.tile_size.width(), tiles.tile_size.height()),
        };
        if block_width > MAX_EDGE
            || block_height > MAX_EDGE
            || block_width == 0
            || block_height == 0
            || block_width as u64 * block_height as u64 * header.channels.bytes_per_pixel as u64
                > max_alloc / 8
        {
            return false;
        }
    }
    table_count.saturating_mul(8) <= max_alloc / 8
}

fn preview_channel(metadata: &MetaData) -> Option<Text> {
    let channels = || metadata.headers.iter().map(|header| &header.channels.list);
    if let Some(luma) = channels()
        .flatten()
        .find(|channel| channel.name.as_slice().eq_ignore_ascii_case(b"Y"))
    {
        return Some(luma.name.clone());
    }
    for layer in channels() {
        let mut data = layer
            .iter()
            .filter(|channel| channel.name.as_slice() != b"A");
        if let Some(channel) = data.next() {
            if data.next().is_none() {
                return Some(channel.name.clone());
            }
        } else if let [channel] = layer.as_slice() {
            return Some(channel.name.clone());
        }
    }
    None
}

fn gray_preview(pixels: PreviewPixels) -> GrayImage {
    let samples = pixels.image.as_raw();
    let (min, max) = samples
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), value| {
            (min.min(value), max.max(value))
        });
    let normalize = min < max && (min >= 1.0 || max <= 0.0);
    GrayImage::from_fn(pixels.image.width(), pixels.image.height(), |x, y| {
        let sample = pixels.image[(x, y)].0[0];
        let value = if !sample.is_finite() {
            0.0
        } else if normalize {
            (f64::from(sample) - f64::from(min)) / (f64::from(max) - f64::from(min))
        } else {
            f64::from(sample).clamp(0.0, 1.0)
        };
        Luma([(value * 255.0).round() as u8])
    })
}

/// Read a luminance or other single-channel EXR data window for display.
pub(crate) fn decode_exr(
    path: &Path,
    max_alloc: u64,
    max_size: u32,
) -> Result<DynamicImage, String> {
    let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let metadata = MetaData::read_from_buffered((&mut reader).take(METADATA_BUDGET), false)
        .map_err(|error| error.to_string())?;
    if !valid_metadata(&metadata, max_alloc, max_size) {
        return Err(EXR_LIMIT_ERROR.into());
    }
    let channel = preview_channel(&metadata).ok_or("EXR 中没有可预览的单通道图层。")?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;

    let result = read()
        .no_deep_data()
        .largest_resolution_level()
        .specific_channels()
        .required(channel)
        .collect_pixels(
            |size, _| {
                let (width, height) = preview_dimensions(size, max_alloc, max_size, 8)?;
                Some(PreviewPixels {
                    source: size,
                    image: ImageBuffer::new(width, height),
                })
            },
            |pixels, position, (luma,): (f32,)| {
                if let Some(pixels) = pixels {
                    let width = pixels.image.width() as usize;
                    let height = pixels.image.height() as usize;
                    let x = position.x() * width / pixels.source.width();
                    let y = position.y() * height / pixels.source.height();
                    if position.x() == (x * pixels.source.width()).div_ceil(width)
                        && position.y() == (y * pixels.source.height()).div_ceil(height)
                    {
                        if let Some(pixel) = pixels.image.get_pixel_mut_checked(x as u32, y as u32)
                        {
                            *pixel = Luma([luma]);
                        }
                    }
                }
            },
        )
        .first_valid_layer()
        .all_attributes()
        .non_parallel()
        .from_buffered(reader)
        .map_err(|error| error.to_string())?;
    result
        .layer_data
        .channel_data
        .pixels
        .map(|pixels| DynamicImage::ImageLuma8(gray_preview(pixels)))
        .ok_or_else(|| EXR_LIMIT_ERROR.into())
}

#[cfg(test)]
mod tests {
    use super::{decode_exr, preview_dimensions, read_hdr_scanline, Vec2};
    use crate::{scaled_preview_image, thumbnail_cache, Catalog};
    use exr::prelude::{Image, SpecificChannels, WritableImage};
    use std::{fs::File, io::Write};

    #[test]
    fn previews_and_caches_an_8k_radiance_image_without_full_decode() {
        let scratch = tempfile::tempdir().unwrap();
        let source = scratch.path().join("测试_8K.hdr");
        let mut file = File::create(&source).unwrap();
        file.write_all(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4096 +X 8192\n")
            .unwrap();
        let scanline = |channels: [u8; 4]| {
            let mut bytes = vec![2, 2, 32, 0];
            for value in channels {
                let mut left = 8192;
                while left > 0 {
                    let length = left.min(127);
                    bytes.extend_from_slice(&[(128 + length) as u8, value]);
                    left -= length;
                }
            }
            bytes
        };
        let red = scanline([200, 0, 0, 128]);
        let blue = scanline([0, 0, 200, 128]);
        for row in 0..4096 {
            file.write_all(if row < 2048 { &red } else { &blue })
                .unwrap();
        }
        drop(file);

        let catalog = Catalog::open(&scratch.path().join("catalog")).unwrap();
        catalog.add_file(&source, "test").unwrap();
        let asset = catalog.assets().unwrap().remove(0);
        let cache = scratch.path().join("cache");
        let check = |image: (String, Vec<u8>), width, height| {
            assert_eq!(image.0, "image/png");
            let image = image::load_from_memory(&image.1).unwrap().into_rgb8();
            assert_eq!(image.dimensions(), (width, height));
            let red = image.get_pixel(width / 2, height / 4).0;
            let blue = image.get_pixel(width / 2, 3 * height / 4).0;
            assert!(red[0] > 128 && red[1] == 0 && red[2] == 0);
            assert!(blue[2] > 128 && blue[0] == 0 && blue[1] == 0);
        };
        check(
            scaled_preview_image(&asset, &cache, 1600).unwrap().unwrap(),
            1600,
            800,
        );
        let thumbnail = thumbnail_cache::read_or_generate(&asset, &cache, 256)
            .unwrap()
            .unwrap();
        assert_eq!(
            thumbnail_cache::read(&asset, &cache, 256).unwrap(),
            Some(thumbnail.clone())
        );
        check(thumbnail, 256, 128);
    }

    #[test]
    fn hdr_scanlines_handle_legacy_runs_and_reject_invalid_packets() {
        let mut legacy = [[0; 4]; 3];
        read_hdr_scanline(&mut &[128, 64, 32, 128, 1, 1, 1, 2][..], &mut legacy).unwrap();
        assert_eq!(legacy, [[128, 64, 32, 128]; 3]);
        let mut modern = [[0; 4]; 8];
        assert!(read_hdr_scanline(&mut &[2, 2, 0, 8, 0][..], &mut modern).is_err());
        assert!(read_hdr_scanline(&mut &[2, 2, 0, 7, 136, 12][..], &mut modern).is_err());
        assert!(read_hdr_scanline(&mut &[2, 2, 0, 8, 137, 12][..], &mut modern).is_err());
        assert!(read_hdr_scanline(&mut &[2, 2, 0, 8, 8, 12][..], &mut modern).is_err());
    }

    #[test]
    fn decodes_luminance_from_an_exr_with_alpha() {
        let source = tempfile::NamedTempFile::new().unwrap();
        let channels = SpecificChannels::build()
            .with_channel("Y")
            .with_channel("A")
            .with_pixel_fn(|position| (0.25_f32 + position.x() as f32, 0.5_f32));
        Image::from_channels((2, 1), channels)
            .write()
            .to_file(source.path())
            .unwrap();
        let decoded = decode_exr(source.path(), 64 * 1024 * 1024, 512)
            .unwrap()
            .into_luma8();
        assert_eq!(decoded.dimensions(), (2, 1));
        assert_eq!(decoded.get_pixel(0, 0).0, [64]);
        assert_eq!(decoded.get_pixel(1, 0).0, [255]);
    }

    #[test]
    fn subsamples_a_large_aspect_ratio_to_a_bounded_preview() {
        assert_eq!(
            preview_dimensions(Vec2(8192, 4096), 256 * 1024 * 1024, 2048, 8),
            Some((2048, 1024))
        );
        assert!(preview_dimensions(Vec2(32768, 32768), 256 * 1024 * 1024, 512, 8).is_none());
        assert!(preview_dimensions(Vec2(1, 1), 7, 512, 8).is_none());
    }
}
