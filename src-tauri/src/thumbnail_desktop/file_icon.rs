use super::explorer::data_url;
use crate::{folder_browser, local_explorer::validate_file_path};
use image::{DynamicImage, RgbaImage};
use std::{
    collections::VecDeque,
    io::Cursor,
    path::PathBuf,
    sync::{atomic::Ordering, Mutex},
    time::{Duration, Instant},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Graphics::Imaging::{
            CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory, IWICPalette,
            WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom,
        },
        Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::{
            Controls::{IImageList, ILD_NORMAL},
            Shell::{
                SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_FLAGS, SHGFI_SYSICONINDEX,
                SHGFI_USEFILEATTRIBUTES, SHIL_EXTRALARGE, SHIL_JUMBO, SHIL_LARGE, SHIL_SMALL,
            },
            WindowsAndMessaging::{DestroyIcon, HICON},
        },
    },
};

const CACHE_LIMIT: usize = 128;
const CACHE_TTL: Duration = Duration::from_secs(300);
const IO_TIMEOUT: Duration = Duration::from_secs(6);
static CLASS_ICONS: Mutex<VecDeque<ClassIcon>> = Mutex::new(VecDeque::new());
static FILE_ICON_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

struct ClassIcon {
    extension: String,
    size: u32,
    data: String,
    read_at: Instant,
}

pub(super) async fn read(path: String, size: u32) -> Result<Option<String>, String> {
    if path.len() > 32_768 || !(16..=256).contains(&size) {
        return Ok(None);
    }
    let path = PathBuf::from(path);
    validate_file_path(&path)?;
    if path.file_name().is_none() {
        return Ok(None);
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let file_specific = matches!(
        extension.as_str(),
        "exe" | "lnk" | "ico" | "dll" | "icl" | "cpl" | "scr"
    );
    if !file_specific {
        if let Ok(cache) = CLASS_ICONS.lock() {
            if let Some(icon) = cache.iter().find(|icon| {
                icon.extension == extension
                    && icon.size == size
                    && icon.read_at.elapsed() < CACHE_TTL
            }) {
                return Ok(Some(icon.data.clone()));
            }
        }
    }

    folder_browser::read_with_slots(&FILE_ICON_READS, IO_TIMEOUT, move |cancelled| {
        let (name, association) = if file_specific {
            let Ok(canonical) = std::fs::canonicalize(path) else {
                return Ok(None);
            };
            validate_file_path(&canonical)?;
            if !canonical.is_file() {
                return Ok(None);
            }
            (nexus_core::clean_path(&canonical), false)
        } else {
            // The Shell uses the current association without reading the actual file.
            let name = if extension.is_empty() {
                "nexus-file".to_owned()
            } else {
                format!("nexus-file.{extension}")
            };
            (name, true)
        };
        if cancelled.load(Ordering::Acquire) {
            return Ok(None);
        }
        let icon =
            extract_png(&name, association, size).map(|png| data_url(("image/png".into(), png)));
        if let Some(data) = &icon {
            if association && !cancelled.load(Ordering::Acquire) {
                if let Ok(mut cache) = CLASS_ICONS.lock() {
                    cache.retain(|item| {
                        item.read_at.elapsed() < CACHE_TTL
                            && !(item.extension == extension && item.size == size)
                    });
                    if cache.len() >= CACHE_LIMIT {
                        cache.pop_front();
                    }
                    cache.push_back(ClassIcon {
                        extension,
                        size,
                        data: data.clone(),
                        read_at: Instant::now(),
                    });
                }
            }
        }
        Ok(icon)
    })
    .await
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct ShellIcon(HICON);

impl Drop for ShellIcon {
    fn drop(&mut self) {
        let _ = unsafe { DestroyIcon(self.0) };
    }
}

fn extract_png(name: &str, association: bool, size: u32) -> Option<Vec<u8>> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .ok()?;
    let _apartment = Apartment;
    let filename: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let mut info = SHFILEINFOW::default();
    let flags = SHGFI_SYSICONINDEX
        | if association {
            SHGFI_USEFILEATTRIBUTES
        } else {
            SHGFI_FLAGS(0)
        };
    let image_list = unsafe {
        SHGetFileInfoW(
            PCWSTR(filename.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    if image_list == 0 {
        return None;
    }
    let icon_size = match size {
        16 => SHIL_SMALL,
        17..=32 => SHIL_LARGE,
        33..=48 => SHIL_EXTRALARGE,
        _ => SHIL_JUMBO,
    };
    let images: IImageList = unsafe { SHGetImageList(icon_size as i32) }.ok()?;
    let icon = ShellIcon(unsafe { images.GetIcon(info.iIcon, ILD_NORMAL.0) }.ok()?);
    let rgba = pixels(&icon)?;
    let image = DynamicImage::ImageRgba8(rgba);
    let image = if image.width().max(image.height()) > size {
        image.thumbnail(size, size)
    } else {
        image
    };
    let mut png = Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(png.into_inner())
}

fn pixels(icon: &ShellIcon) -> Option<RgbaImage> {
    // WIC handles color icons and alpha/masks supplied by Shell and icon resources.
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let bitmap = factory.CreateBitmapFromHICON(icon.0).ok()?;
        let (mut width, mut height) = (0, 0);
        bitmap.GetSize(&mut width, &mut height).ok()?;
        if width.min(height) == 0 || width.max(height) > 1024 {
            return None;
        }
        let converter = factory.CreateFormatConverter().ok()?;
        converter
            .Initialize(
                &bitmap,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None::<&IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .ok()?;
        let stride = width * 4;
        let mut bytes = vec![0; (stride * height) as usize];
        converter
            .CopyPixels(std::ptr::null(), stride, &mut bytes)
            .ok()?;
        RgbaImage::from_raw(width, height, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_shell_class_png_without_opening_a_file() {
        let png = extract_png("nexus-test-association.txt", true, 128).unwrap();
        let icon = image::load_from_memory(&png).unwrap().to_rgba8();
        assert!((1..=128).contains(&icon.width()));
        assert!((1..=128).contains(&icon.height()));
        assert!(icon.pixels().any(|pixel| pixel[3] != 0));
    }
}
