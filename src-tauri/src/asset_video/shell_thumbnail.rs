use image::{DynamicImage, RgbImage};
use std::path::Path;
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{RPC_E_CHANGED_MODE, SIZE},
        Graphics::{
            Gdi::{DeleteObject, GetObjectW, BITMAP, HBITMAP, HGDIOBJ, HPALETTE},
            Imaging::{
                CLSID_WICImagingFactory, GUID_WICPixelFormat24bppRGB, IWICImagingFactory,
                IWICPalette, WICBitmapDitherTypeNone, WICBitmapIgnoreAlpha,
                WICBitmapPaletteTypeCustom,
            },
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, IBindCtx, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_THUMBNAILONLY},
    },
};

const MAX_BITMAP_EDGE: u32 = 2048;

struct Apartment(bool);

impl Apartment {
    fn enter() -> windows::core::Result<Self> {
        // This runs on a blocking worker, not the workspace's UI thread.
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result == RPC_E_CHANGED_MODE {
            return Ok(Self(false));
        }
        result.ok()?;
        Ok(Self(true))
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

struct ShellBitmap(HBITMAP);

impl Drop for ShellBitmap {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { DeleteObject(HGDIOBJ(self.0 .0)) };
        }
    }
}

fn windows_error(error: windows::core::Error) -> String {
    format!("Windows 无法提取视频缩略图：{error}")
}

pub(super) fn read(path: &Path, size: u32) -> Result<DynamicImage, String> {
    if !path.is_absolute() || !(128..=1024).contains(&size) {
        return Err("视频缩略图路径或尺寸无效".into());
    }
    let _apartment = Apartment::enter().map_err(windows_error)?;
    let filename: Vec<u16> = nexus_core::clean_path(path)
        .encode_utf16()
        .chain([0])
        .collect();
    let edge = size as i32;
    let (pixels, width, height) = unsafe {
        let shell: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(filename.as_ptr()), None::<&IBindCtx>)
                .map_err(windows_error)?;
        let bitmap = ShellBitmap(
            shell
                .GetImage(SIZE { cx: edge, cy: edge }, SIIGBF_THUMBNAILONLY)
                .map_err(windows_error)?,
        );
        let mut details = BITMAP::default();
        if bitmap.0.is_invalid()
            || GetObjectW(
                HGDIOBJ(bitmap.0 .0),
                std::mem::size_of::<BITMAP>() as i32,
                Some((&mut details as *mut BITMAP).cast()),
            ) == 0
            || details.bmWidth <= 0
            || details.bmHeight == 0
            || details
                .bmWidth
                .unsigned_abs()
                .max(details.bmHeight.unsigned_abs())
                > MAX_BITMAP_EDGE
        {
            return Err("Windows 返回的视频缩略图尺寸无效".into());
        }

        let wic: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(windows_error)?;
        let source = wic
            .CreateBitmapFromHBITMAP(bitmap.0, HPALETTE::default(), WICBitmapIgnoreAlpha)
            .map_err(windows_error)?;
        let (mut width, mut height) = (0, 0);
        source
            .GetSize(&mut width, &mut height)
            .map_err(windows_error)?;
        if width.min(height) == 0 || width.max(height) > MAX_BITMAP_EDGE {
            return Err("Windows 返回的视频缩略图尺寸无效".into());
        }
        let converter = wic.CreateFormatConverter().map_err(windows_error)?;
        converter
            .Initialize(
                &source,
                &GUID_WICPixelFormat24bppRGB,
                WICBitmapDitherTypeNone,
                None::<&IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(windows_error)?;
        let stride = width * 3;
        let mut pixels = vec![0; (stride * height) as usize];
        converter
            .CopyPixels(std::ptr::null(), stride, &mut pixels)
            .map_err(windows_error)?;
        (pixels, width, height)
    };
    let image = DynamicImage::ImageRgb8(
        RgbImage::from_raw(width, height, pixels).ok_or("无法读取 Windows 视频缩略图像素")?,
    );
    Ok(if width.max(height) > size {
        image.thumbnail(size, size)
    } else {
        image
    })
}
