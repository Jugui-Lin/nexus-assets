use image::{DynamicImage, GrayImage, RgbImage};
use std::{os::windows::ffi::OsStrExt, path::Path, ptr::null};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::{GENERIC_READ, RPC_E_CHANGED_MODE},
        Graphics::Imaging::{
            CLSID_WICImagingFactory, CLSID_WICJpegDecoder, GUID_WICPixelFormat24bppBGR,
            GUID_WICPixelFormat24bppRGB, GUID_WICPixelFormat32bppCMYK, GUID_WICPixelFormat8bppGray,
            IWICBitmapDecoder, IWICBitmapFrameDecode, IWICBitmapSourceTransform,
            IWICImagingFactory, IWICPalette, WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom,
            WICBitmapTransformRotate0, WICDecodeMetadataCacheOnDemand,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
    },
};

const MAX_SOURCE_EDGE: u32 = 32_768;
const MAX_SOURCE_PIXELS: u64 = 128 * 1024 * 1024;
const MAX_SCALED_BYTES: u64 = 64 * 1024 * 1024;
const LIMIT_ERROR: &str = "JPEG 图像超过当前预览尺寸或内存限制。";

struct ComApartment(bool);

impl ComApartment {
    fn enter() -> windows::core::Result<Self> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == RPC_E_CHANGED_MODE {
            // The caller already owns a COM apartment on this thread.
            return Ok(Self(false));
        }
        result.ok()?;
        Ok(Self(true))
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

pub(super) fn decode_if_large(
    path: &Path,
    standard_budget: u64,
    max_size: u32,
) -> Option<Result<DynamicImage, String>> {
    let _apartment = ComApartment::enter().ok()?;
    let (factory, frame, size) = open(path).ok()?;
    let (width, height) = size;
    let pixels = u64::from(width) * u64::from(height);
    let grayscale = unsafe { frame.GetPixelFormat() }.ok()? == GUID_WICPixelFormat8bppGray;
    let color_channels = if grayscale { 1 } else { 3 };
    if width.max(height) <= MAX_SOURCE_EDGE && pixels * color_channels <= standard_budget {
        return None;
    }
    Some(decode(&factory, &frame, size, max_size))
}

fn open(
    path: &Path,
) -> windows::core::Result<(IWICImagingFactory, IWICBitmapFrameDecode, (u32, u32))> {
    let filename: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let stream = factory.CreateStream()?;
        stream.InitializeFromFilename(PCWSTR(filename.as_ptr()), GENERIC_READ.0)?;
        // Select the inbox JPEG decoder explicitly and defer loading unrelated metadata.
        let decoder: IWICBitmapDecoder =
            CoCreateInstance(&CLSID_WICJpegDecoder, None, CLSCTX_INPROC_SERVER)?;
        decoder.Initialize(&stream, WICDecodeMetadataCacheOnDemand)?;
        let frame = decoder.GetFrame(0)?;
        let (mut width, mut height) = (0, 0);
        frame.GetSize(&mut width, &mut height)?;
        Ok((factory, frame, (width, height)))
    }
}

fn preview_dimensions((width, height): (u32, u32), max_size: u32) -> Option<(u32, u32)> {
    let edge = width.max(height);
    if width.min(height) == 0
        || edge > MAX_SOURCE_EDGE
        || u64::from(width) * u64::from(height) > MAX_SOURCE_PIXELS
        || max_size == 0
    {
        return None;
    }
    let limit = u64::from(max_size.min(edge));
    let fit = |extent| ((u64::from(extent) * limit / u64::from(edge)) as u32).max(1);
    Some((fit(width), fit(height)))
}

fn decode(
    factory: &IWICImagingFactory,
    frame: &IWICBitmapFrameDecode,
    source: (u32, u32),
    max_size: u32,
) -> Result<DynamicImage, String> {
    let (mut width, mut height) = preview_dimensions(source, max_size).ok_or(LIMIT_ERROR)?;
    let wic_error = |error| format!("无法解码 JPEG 图片：{error}");
    let transform: IWICBitmapSourceTransform = frame.cast().map_err(wic_error)?;
    unsafe {
        // WIC JPEG performs this scale during decoding, without allocating the original bitmap.
        transform
            .GetClosestSize(&mut width, &mut height)
            .map_err(wic_error)?;
        if width == 0 || height == 0 || width > source.0 || height > source.1 {
            return Err(LIMIT_ERROR.into());
        }
        let mut format = GUID_WICPixelFormat24bppRGB;
        transform
            .GetClosestPixelFormat(&mut format)
            .map_err(wic_error)?;
        let bytes_per_pixel = if format == GUID_WICPixelFormat8bppGray {
            1
        } else if format == GUID_WICPixelFormat24bppBGR || format == GUID_WICPixelFormat24bppRGB {
            3
        } else if format == GUID_WICPixelFormat32bppCMYK {
            4
        } else {
            return Err("此 JPEG 颜色格式暂不支持大图预览".into());
        };
        let stride = width.checked_mul(bytes_per_pixel).ok_or(LIMIT_ERROR)?;
        let bytes = u64::from(stride) * u64::from(height);
        if bytes > MAX_SCALED_BYTES {
            return Err(LIMIT_ERROR.into());
        }
        let mut bitmap = vec![0; bytes as usize];
        transform
            .CopyPixels(
                null(),
                width,
                height,
                &format,
                WICBitmapTransformRotate0,
                stride,
                &mut bitmap,
            )
            .map_err(wic_error)?;
        if format == GUID_WICPixelFormat8bppGray {
            return GrayImage::from_raw(width, height, bitmap)
                .map(DynamicImage::ImageLuma8)
                .ok_or_else(|| LIMIT_ERROR.into());
        }
        if format == GUID_WICPixelFormat24bppBGR {
            for pixel in bitmap.chunks_exact_mut(3) {
                pixel.swap(0, 2);
            }
        }
        if format == GUID_WICPixelFormat32bppCMYK {
            let source = factory
                .CreateBitmapFromMemory(width, height, &format, stride, &bitmap)
                .map_err(wic_error)?;
            let converter = factory.CreateFormatConverter().map_err(wic_error)?;
            converter
                .Initialize(
                    &source,
                    &GUID_WICPixelFormat24bppRGB,
                    WICBitmapDitherTypeNone,
                    None::<&IWICPalette>,
                    0.0,
                    WICBitmapPaletteTypeCustom,
                )
                .map_err(wic_error)?;
            let rgb_stride = width * 3;
            let mut rgb = vec![0; (rgb_stride * height) as usize];
            converter
                .CopyPixels(null(), rgb_stride, &mut rgb)
                .map_err(wic_error)?;
            drop(converter);
            drop(source);
            bitmap = rgb;
        }
        RgbImage::from_raw(width, height, bitmap)
            .map(DynamicImage::ImageRgb8)
            .ok_or_else(|| LIMIT_ERROR.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{codecs::jpeg::JpegEncoder, ExtendedColorType};
    use std::fs;

    fn large_jpeg() -> Vec<u8> {
        let mut bytes = Vec::new();
        JpegEncoder::new(&mut bytes)
            .encode(&[128; 8 * 8 * 3], 8, 8, ExtendedColorType::Rgb8)
            .unwrap();
        let locate = |marker| {
            bytes
                .windows(2)
                .position(|window| window == [0xff, marker])
                .unwrap()
        };
        let frame = locate(0xc0);
        let scan = locate(0xda);
        let scan_length = u16::from_be_bytes([bytes[scan + 2], bytes[scan + 3]]) as usize;
        let width = 16_384u16;
        let height = 8_192u16;
        bytes[frame + 5..frame + 7].copy_from_slice(&height.to_be_bytes());
        bytes[frame + 7..frame + 9].copy_from_slice(&width.to_be_bytes());
        bytes.truncate(scan + 2 + scan_length);
        // An all-zero DCT MCU uses the standard DC zero and AC EOB codes for
        // one luma and two chroma blocks. Repeat four 14-bit MCUs per seven bytes.
        let mcu = 0b00101000000000u64;
        let chunk = ((mcu << 42) | (mcu << 28) | (mcu << 14) | mcu).to_be_bytes();
        let groups = (usize::from(width) / 8) * (usize::from(height) / 8) / 4;
        for _ in 0..groups {
            bytes.extend_from_slice(&chunk[1..]);
        }
        bytes.extend_from_slice(&[0xff, 0xd9]);
        bytes
    }

    #[test]
    fn valid_large_jpeg_uses_a_small_preview_instead_of_full_decode() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("超大预览.jpg");
        let bytes = large_jpeg();
        fs::write(&path, &bytes).unwrap();
        let native = decode_if_large(&path, 256 * 1024 * 1024, 1600)
            .unwrap()
            .unwrap();
        assert_eq!((native.width(), native.height()), (2048, 1024));
        let preview = crate::decode_scaled_preview(&path, "jpg", 1600, bytes.len() as u64)
            .unwrap()
            .unwrap();
        let decoded = image::load_from_memory(&preview).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (1600, 800));
        assert_eq!(decoded.get_pixel(300, 100).0, [128, 128, 128]);
    }

    #[test]
    fn malformed_files_and_excess_dimensions_do_not_bypass_limits() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("坏图.jpg");
        fs::write(&path, [0xff, 0xd8, 0xff, 0xc0]).unwrap();
        assert!(crate::decode_scaled_preview(&path, "jpg", 1600, 4).is_err());
        assert!(preview_dimensions((32_769, 2), 1600).is_none());
        assert!(preview_dimensions((16_384, 8_193), 1600).is_none());
        assert!(preview_dimensions((0, 500), 1600).is_none());
        assert_eq!(preview_dimensions((8_192, 16_384), 1600), Some((800, 1600)));
    }
}
