use image::{codecs::bmp::BmpDecoder, DynamicImage, ImageDecoder, Limits};
use std::{
    fs::File,
    io::{self, BufReader, Cursor, Read, Seek, SeekFrom},
    path::Path,
};

const COMPOUND_SIGNATURE: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SUMMARY_STREAM: &str = "/\u{0005}SummaryInformation";
const SUMMARY_FORMAT: [u8; 16] = [
    0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9,
];
const MAX_COMPOUND_READ_BYTES: usize = 64 * 1024 * 1024;
const MAX_SUMMARY_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE: u32 = 2048;
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;

struct BoundedRead<R> {
    inner: R,
    remaining: usize,
}

impl<R: Read> Read for BoundedRead<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 && !buffer.is_empty() {
            return Err(io::Error::other(
                "MAX thumbnail metadata read limit exceeded",
            ));
        }
        let count = buffer.len().min(self.remaining);
        let read = self.inner.read(&mut buffer[..count])?;
        self.remaining -= read;
        Ok(read)
    }
}

impl<R: Seek> Seek for BoundedRead<R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.inner.seek(position)
    }
}

pub(super) fn decode(path: &Path) -> Result<Option<DynamicImage>, String> {
    let read_error = |error| format!("无法读取 MAX 预览：{error}");
    let mut file = File::open(path).map_err(read_error)?;
    let mut header = [0; 32];
    match file.read_exact(&mut header) {
        Ok(()) if header[..8] == COMPOUND_SIGNATURE => (),
        Ok(()) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(read_error(error)),
    }
    let buffer_size = match le16(&header, 30) {
        Some(9) => 512,
        Some(12) => 4096,
        _ => return Ok(None),
    };
    let reader = BoundedRead {
        inner: file,
        remaining: MAX_COMPOUND_READ_BYTES,
    };
    let mut compound = cfb::CompoundFile::open(BufReader::with_capacity(buffer_size, reader))
        .map_err(read_error)?;
    let entry = match compound.entry(SUMMARY_STREAM) {
        Ok(entry)
            if entry.is_stream() && entry.len() > 0 && entry.len() <= MAX_SUMMARY_BYTES as u64 =>
        {
            entry
        }
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(read_error(error)),
    };
    // Only the small property stream is read. CFB navigates its metadata using
    // sector offsets without opening the proprietary MAX Scene stream.
    let mut summary = vec![0; entry.len() as usize];
    compound
        .open_stream(SUMMARY_STREAM)
        .and_then(|mut stream| stream.read_exact(&mut summary))
        .map_err(read_error)?;
    Ok(thumbnail_dib(&summary).and_then(decode_dib))
}

fn le16(bytes: &[u8], start: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(start..start + 2)?.try_into().ok()?,
    ))
}

fn le32(bytes: &[u8], start: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(start..start + 4)?.try_into().ok()?,
    ))
}

fn thumbnail_dib(summary: &[u8]) -> Option<&[u8]> {
    // MS-OLEPS SummaryInformation, PIDSI_THUMBNAIL (17), VT_CF (0x47).
    const THUMBNAIL: u32 = 17;
    if le16(summary, 0)? != 0xfffe {
        return None;
    }
    let sections = le32(summary, 24)? as usize;
    if !(1..=2).contains(&sections) {
        return None;
    }
    let header_end = 28 + sections * 20;
    let format = summary
        .get(28..header_end)?
        .chunks_exact(20)
        .find(|section| section[..16] == SUMMARY_FORMAT)?;
    let offset = le32(format, 16)? as usize;
    if offset < header_end {
        return None;
    }
    let section = summary.get(offset..)?;
    let section = section.get(..le32(section, 0)? as usize)?;
    let entries = le32(section, 4)? as usize;
    let table_end = entries.checked_mul(8)?.checked_add(8)?;
    let table = section.get(8..table_end)?;
    let mut start = None;
    for property in table.chunks_exact(8) {
        if le32(property, 0)? == THUMBNAIL && start.replace(le32(property, 4)? as usize).is_some() {
            return None;
        }
    }
    let start = start?;
    if start < table_end || start % 4 != 0 {
        return None;
    }
    let end = table
        .chunks_exact(8)
        .filter_map(|property| le32(property, 4).map(|offset| offset as usize))
        .filter(|&offset| offset > start)
        .min()
        .unwrap_or(section.len());
    let property = section.get(start..end)?;
    if le32(property, 0)? != 0x47 {
        return None;
    }
    let length = le32(property, 4)? as usize;
    let clipboard = property.get(8..8usize.checked_add(length)?)?;
    if le32(clipboard, 0)? != u32::MAX {
        return None;
    }
    match le32(clipboard, 4)? {
        3 => metafile_dib(clipboard.get(8..)?),
        8 | 17 => clipboard.get(8..), // CF_DIB and CF_DIBV5
        _ => None,
    }
}

fn metafile_dib(clipboard: &[u8]) -> Option<&[u8]> {
    // 3ds Max typically prefixes the standard WMF with an 8-byte packed
    // METAFILEPICT. Some clipboard serializers store the WMF on its own.
    [8, 0]
        .into_iter()
        .find_map(|start| clipboard.get(start..).and_then(stretch_dib))
}

fn stretch_dib(metafile: &[u8]) -> Option<&[u8]> {
    if !matches!(le16(metafile, 0)?, 1 | 2)
        || le16(metafile, 2)? != 9
        || !matches!(le16(metafile, 4)?, 0x0100 | 0x0300)
    {
        return None;
    }
    let size = (le32(metafile, 6)? as usize).checked_mul(2)?;
    let mut records = metafile.get(18..size)?;
    let mut dib = None;
    while !records.is_empty() {
        let length = (le32(records, 0)? as usize).checked_mul(2)?;
        let record = records.get(..length)?;
        match le16(record, 4)? {
            0 if length == 6 && records.len() == length => return dib,
            // MS-WMF META_STRETCHDIB with SRCCOPY and DIB_RGB_COLORS.
            0x0f43 if le32(record, 6)? == 0x00cc0020 && le16(record, 10)? == 0 => {
                if dib.replace(record.get(28..)?).is_some() {
                    return None;
                }
            }
            _ => (),
        }
        records = records.get(length..)?;
    }
    None
}

fn decode_dib(dib: &[u8]) -> Option<DynamicImage> {
    let mut decoder = BmpDecoder::new_without_file_header(Cursor::new(dib)).ok()?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || decoder.total_bytes() > MAX_IMAGE_BYTES {
        return None;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(MAX_IMAGE_BYTES);
    decoder.set_limits(limits).ok()?;
    DynamicImage::from_decoder(decoder).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn dib() -> Vec<u8> {
        let mut header = vec![0; 40];
        header[0..4].copy_from_slice(&40u32.to_le_bytes());
        header[4..8].copy_from_slice(&2i32.to_le_bytes());
        header[8..12].copy_from_slice(&1i32.to_le_bytes());
        header[12..14].copy_from_slice(&1u16.to_le_bytes());
        header[14..16].copy_from_slice(&24u16.to_le_bytes());
        header[20..24].copy_from_slice(&8u32.to_le_bytes());
        header.extend_from_slice(&[0, 0, 255, 0, 255, 0, 0, 0]);
        header
    }

    fn metafile(dib: &[u8]) -> Vec<u8> {
        let record_size = 28 + dib.len();
        let mut bytes = vec![0; 8 + 18 + 28];
        bytes[..8].copy_from_slice(&[1, 0, 2, 0, 1, 0, 0, 0]);
        bytes[8..14].copy_from_slice(&[1, 0, 9, 0, 0, 3]);
        bytes[14..18].copy_from_slice(&(((18 + record_size + 6) / 2) as u32).to_le_bytes());
        bytes[26..30].copy_from_slice(&((record_size / 2) as u32).to_le_bytes());
        bytes[30..32].copy_from_slice(&0x0f43u16.to_le_bytes());
        bytes[32..36].copy_from_slice(&0x00cc0020u32.to_le_bytes());
        bytes.extend_from_slice(dib);
        bytes.extend_from_slice(&[3, 0, 0, 0, 0, 0]);
        bytes
    }

    fn summary(format: u32, content: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0; 48 + 16 + 16];
        bytes[0..2].copy_from_slice(&0xfffeu16.to_le_bytes());
        bytes[24..28].copy_from_slice(&1u32.to_le_bytes());
        bytes[28..44].copy_from_slice(&SUMMARY_FORMAT);
        bytes[44..48].copy_from_slice(&48u32.to_le_bytes());
        bytes[48..52].copy_from_slice(&((32 + content.len()) as u32).to_le_bytes());
        bytes[52..56].copy_from_slice(&1u32.to_le_bytes());
        bytes[56..60].copy_from_slice(&17u32.to_le_bytes());
        bytes[60..64].copy_from_slice(&16u32.to_le_bytes());
        bytes[64..68].copy_from_slice(&0x47u32.to_le_bytes());
        bytes[68..72].copy_from_slice(&((8 + content.len()) as u32).to_le_bytes());
        bytes[72..76].copy_from_slice(&u32::MAX.to_le_bytes());
        bytes[76..80].copy_from_slice(&format.to_le_bytes());
        bytes.extend_from_slice(content);
        bytes
    }

    #[test]
    fn reads_the_embedded_wmf_preview_from_a_compound_file() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("户外场景.max");
        let raw = summary(3, &metafile(&dib()));
        {
            let mut compound = cfb::create(&path).unwrap();
            compound
                .create_stream("/Scene")
                .unwrap()
                .write_all(b"not a bitmap")
                .unwrap();
            compound
                .create_stream(SUMMARY_STREAM)
                .unwrap()
                .write_all(&raw)
                .unwrap();
        }
        let image = decode(&path).unwrap().unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (2, 1));
        assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0]);
        assert_eq!(image.get_pixel(1, 0).0, [0, 255, 0]);
    }

    #[test]
    fn decodes_the_standard_clipboard_dib_and_an_unwrapped_wmf() {
        let dib = dib();
        let wmf = metafile(&dib);
        for summary in [summary(8, &dib), summary(3, &wmf[8..])] {
            let image = thumbnail_dib(&summary).and_then(decode_dib).unwrap();
            assert_eq!((image.width(), image.height()), (2, 1));
        }
    }

    #[test]
    fn rejects_short_buffers_bad_sizes_and_oversized_dib_dimensions() {
        let valid = summary(3, &metafile(&dib()));
        for end in 0..valid.len() {
            assert!(thumbnail_dib(&valid[..end]).is_none());
        }
        let mut wrong_section = valid.clone();
        wrong_section[44..48].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(thumbnail_dib(&wrong_section).is_none());
        let mut wrong_record = valid;
        wrong_record[106..110].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(thumbnail_dib(&wrong_record).is_none());
        let mut huge = dib();
        huge[4..8].copy_from_slice(&i32::MAX.to_le_bytes());
        assert!(decode_dib(&huge).is_none());
    }

    #[test]
    fn reports_missing_properties_as_no_preview() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("without-preview.max");
        cfb::create(&path).unwrap();
        assert!(decode(&path).unwrap().is_none());
    }
}
