use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use std::{
    fs::File,
    io::{Cursor, ErrorKind, Read},
    path::Path,
};

const HEADER_SIZE: usize = 45;
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn decode(path: &Path) -> Result<Option<DynamicImage>, String> {
    let read_error = |error| format!("无法读取 C4D 预览：{error}");
    let mut file = File::open(path).map_err(read_error)?;
    let mut header = [0; HEADER_SIZE];
    match file.read_exact(&mut header) {
        Ok(()) => (),
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(read_error(error)),
    }

    // This Cinema 4D header variant stores a length-prefixed JPEG preview at
    // the start of the document. The 4-byte authoring version precedes its tag.
    if &header[..8] != b"QC4DC4D6" || header[36..41] != [0x15, 0, 0x15, 1, 0x81] {
        return Ok(None);
    }
    let size = u32::from_be_bytes([header[41], header[42], header[43], header[44]]) as usize;
    let file_size = file.metadata().map_err(read_error)?.len();
    if !(5..=MAX_PREVIEW_BYTES).contains(&size) || (HEADER_SIZE + size) as u64 > file_size {
        return Err("C4D 预览的数据长度无效".into());
    }
    let mut jpeg = vec![0; size];
    file.read_exact(&mut jpeg).map_err(read_error)?;
    if !jpeg.starts_with(&[0xff, 0xd8, 0xff]) || !jpeg.ends_with(&[0xff, 0xd9]) {
        return Err("C4D 预览不是完整的 JPEG 图片".into());
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(jpeg), ImageFormat::Jpeg);
    reader.limits(limits);
    reader
        .decode()
        .map(Some)
        .map_err(|error| format!("无法解码 C4D 预览：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{scaled_preview_image, thumbnail_cache, Catalog};
    use std::fs;

    fn document(jpeg: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0; HEADER_SIZE];
        bytes[..8].copy_from_slice(b"QC4DC4D6");
        bytes[36..41].copy_from_slice(&[0x15, 0, 0x15, 1, 0x81]);
        bytes[41..45].copy_from_slice(&(jpeg.len() as u32).to_be_bytes());
        bytes.extend(jpeg);
        bytes
    }

    #[test]
    fn c4d_saved_preview_reaches_the_card_and_quick_preview_and_yields_to_a_cover() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("场景.C4D");
        let mut jpeg = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(400, 500)
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        fs::write(&source, document(jpeg.get_ref())).unwrap();
        // Only the document header and thumbnail should be read, even for a large scene.
        File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(200 * 1024 * 1024)
            .unwrap();
        let catalog = Catalog::open(&temp.path().join("catalog")).unwrap();
        catalog.add_file(&source, "test").unwrap();
        let mut asset = catalog.assets().unwrap().remove(0);
        let cache = temp.path().join("cache");
        let (mime, thumbnail) = thumbnail_cache::read_or_generate(&asset, &cache, 256)
            .unwrap()
            .unwrap();
        let image = image::load_from_memory(&thumbnail).unwrap();
        assert_eq!(
            (mime.as_str(), image.width(), image.height()),
            ("image/png", 205, 256)
        );
        assert_eq!(
            thumbnail_cache::read(&asset, &cache, 256)
                .unwrap()
                .unwrap()
                .1,
            thumbnail
        );
        let image = image::load_from_memory(
            &scaled_preview_image(&asset, &cache, 1600)
                .unwrap()
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!((image.width(), image.height()), (400, 500));

        let cover = temp.path().join("封面.png");
        DynamicImage::new_rgb8(42, 23).save(&cover).unwrap();
        asset.thumbnail = Some(cover.to_string_lossy().into_owned());
        let image = image::load_from_memory(
            &thumbnail_cache::read_or_generate(&asset, &cache, 256)
                .unwrap()
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!((image.width(), image.height()), (42, 23));
    }

    #[test]
    fn c4d_preview_accepts_only_the_declared_bounded_jpeg() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("scene.c4d");
        let mut invalid = document(&[0xff, 0xd8, 0xff, 0xff, 0xd9]);
        invalid[36..41].copy_from_slice(&[0x15, 0, 0x15, 0, 2]);
        fs::write(&source, &invalid).unwrap();
        assert!(decode(&source).unwrap().is_none());

        let mut invalid = document(&[0xff, 0xd8, 0xff, 0xff, 0xd9]);
        invalid[41..45].copy_from_slice(&u32::MAX.to_be_bytes());
        fs::write(&source, invalid).unwrap();
        assert!(decode(&source).unwrap_err().contains("数据长度"));

        fs::write(&source, document(&[0xff, 0xd8, 0xff, 0, 0])).unwrap();
        assert!(decode(&source).unwrap_err().contains("完整的 JPEG"));
    }
}
