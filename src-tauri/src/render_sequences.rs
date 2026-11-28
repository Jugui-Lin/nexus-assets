use crate::{
    folder_browser, local_explorer::validate_file_path, workspace_folder_move::link_or_reparse,
};
use nexus_core::clean_path;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const MAX_DIRECTORY_ENTRIES: usize = 20_000;
const MAX_FRAME_RECORDS: usize = 8_000;
const MAX_HEADER_BATCH: usize = 24;
const MAX_HEADER_BYTES: usize = 256 * 1024;
const SCAN_TIMEOUT: Duration = Duration::from_secs(6);
static SCANS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SequenceReport {
    directory: String,
    sequences: Vec<Sequence>,
    active_key: Option<String>,
    truncated: bool,
}

#[derive(Serialize)]
struct Sequence {
    key: String,
    label: String,
    extension: String,
    padding: usize,
    frames: Vec<Frame>,
}

#[derive(Serialize)]
struct Frame {
    number: u32,
    path: String,
}

#[derive(Serialize)]
pub(crate) struct FrameSize {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}

fn valid_month_day(digits: &str, leap_year: bool) -> bool {
    let (month, day) = digits.split_at(2);
    let month = month.parse::<usize>().unwrap_or_default();
    let day = day.parse::<u8>().unwrap_or_default();
    let days_in_month = [
        0,
        31,
        if leap_year { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    day > 0
        && days_in_month
            .get(month)
            .is_some_and(|&last_day| day <= last_day)
}

fn valid_calendar_date(digits: &str) -> bool {
    let (year, day) = digits.split_at(4);
    let year = year.parse::<u32>().unwrap_or_default();
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    (1900..=2099).contains(&year) && valid_month_day(day, leap_year)
}

fn sequence_name(path: &Path) -> Option<(&str, String, usize, u32)> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "exr" | "png" | "jpg" | "jpeg" | "tiff" | "tif" | "webp" | "bmp" | "hdr"
    ) {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let digits = stem.bytes().rev().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let (label, token) = stem.split_at(stem.len() - digits);
    let trimmed_label = label.trim_end_matches(['.', '_', ' ', '-']);
    let lowercase_label = trimmed_label.to_ascii_lowercase();
    if lowercase_label.ends_with("udim") || lowercase_label.ends_with("uvtile") {
        return None;
    }
    let padding = match digits {
        1..=6 => digits,
        // Renders can append frame digits directly to an MMDD or YYYYMMDD date.
        8 | 12 if !trimmed_label.is_empty() && trimmed_label != label => {
            let date = &token[..digits - 4];
            let dated_frame = if digits == 8 {
                !valid_calendar_date(token) && valid_month_day(date, true)
            } else {
                valid_calendar_date(date)
            };
            if !dated_frame {
                return None;
            }
            4
        }
        _ => return None,
    };
    let (prefix, number) = stem.split_at(stem.len() - padding);
    Some((prefix, extension, padding, number.parse().ok()?))
}

pub(crate) fn is_numbered_render_frame(path: &Path) -> bool {
    sequence_name(path).is_some()
}

fn same_path(left: &str, right: &str) -> bool {
    left == right || (cfg!(windows) && left.to_lowercase() == right.to_lowercase())
}

fn ordinary_frame(metadata: &fs::Metadata) -> bool {
    if !metadata.is_file() || link_or_reparse(metadata) {
        return false;
    }
    #[cfg(windows)]
    return crate::local_explorer::visible_windows_entry(metadata, false);
    #[cfg(not(windows))]
    true
}

fn normalized_directory(directory: &Path) -> Result<PathBuf, String> {
    validate_file_path(directory)?;
    let metadata =
        fs::metadata(directory).map_err(|error| format!("无法读取渲染目录（{error}）"))?;
    if !metadata.is_dir() {
        return Err("请选择渲染序列所在的目录".into());
    }
    fs::canonicalize(directory).map_err(|error| format!("无法定位渲染目录（{error}）"))
}

fn inspect(
    path: &Path,
    is_directory: bool,
    cancelled: &AtomicBool,
) -> Result<SequenceReport, String> {
    validate_file_path(path)?;
    let directory = normalized_directory(if is_directory {
        path
    } else {
        path.parent().ok_or("文件没有可读取的父目录")?
    })?;
    let selected = (!is_directory).then(|| directory.join(path.file_name().unwrap_or_default()));
    let selected = selected.as_deref().map(clean_path);
    let mut groups: BTreeMap<(String, String, usize), Sequence> = BTreeMap::new();
    let mut count = 0;
    let mut truncated = false;
    let entries =
        fs::read_dir(&directory).map_err(|error| format!("无法列出渲染目录（{error}）"))?;
    for (index, entry) in entries.enumerate() {
        if cancelled.load(Ordering::Acquire)
            || index >= MAX_DIRECTORY_ENTRIES
            || count >= MAX_FRAME_RECORDS
        {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Some((prefix, extension, padding, number)) = sequence_name(&path) else {
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !ordinary_frame(&metadata) {
            continue;
        }
        let group_prefix = if cfg!(windows) {
            prefix.to_lowercase()
        } else {
            prefix.to_owned()
        };
        let group_key = (group_prefix, extension.clone(), padding);
        let next_key = groups.len().to_string();
        let sequence = groups.entry(group_key).or_insert_with(|| Sequence {
            key: next_key,
            label: format!("{prefix}{}.{}", "#".repeat(padding), extension),
            extension,
            padding,
            frames: Vec::new(),
        });
        sequence.frames.push(Frame {
            number,
            path: clean_path(&path),
        });
        count += 1;
    }
    let mut active_key = None;
    let sequences = groups
        .into_values()
        .filter_map(|mut sequence| {
            if sequence.frames.len() < 2 {
                return None;
            }
            sequence
                .frames
                .sort_unstable_by(|a, b| a.number.cmp(&b.number).then_with(|| a.path.cmp(&b.path)));
            if selected.as_deref().is_some_and(|selected| {
                sequence
                    .frames
                    .iter()
                    .any(|frame| same_path(selected, &frame.path))
            }) {
                active_key = Some(sequence.key.clone());
            }
            Some(sequence)
        })
        .collect();
    Ok(SequenceReport {
        directory: clean_path(&directory),
        sequences,
        active_key,
        truncated,
    })
}

struct HeaderReader {
    file: File,
    remaining: usize,
}

impl Read for HeaderReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let limit = buffer.len().min(self.remaining);
        let read = self.file.read(&mut buffer[..limit])?;
        self.remaining -= read;
        Ok(read)
    }
}

impl Seek for HeaderReader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.file.seek(position)
    }
}

fn dimensions(path: &Path) -> Option<(u32, u32)> {
    if !ordinary_frame(&fs::symlink_metadata(path).ok()?) {
        return None;
    }
    let reader = HeaderReader {
        file: File::open(path).ok()?,
        remaining: MAX_HEADER_BYTES,
    };
    let (width, height) = image::ImageReader::new(BufReader::new(reader))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

fn frame_sizes(
    directory: &Path,
    paths: &[PathBuf],
    cancelled: &AtomicBool,
) -> Result<Vec<FrameSize>, String> {
    if paths.len() > MAX_HEADER_BATCH {
        return Err("每次最多检查 24 个帧头".into());
    }
    let directory = clean_path(&normalized_directory(directory)?);
    let mut sizes = Vec::new();
    for path in paths {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        validate_file_path(path)?;
        if path.components().any(|part| part == Component::ParentDir)
            || sequence_name(path).is_none()
            || !path
                .parent()
                .is_some_and(|parent| same_path(&directory, &clean_path(parent)))
        {
            return Err("只能检查当前渲染目录中的编号帧".into());
        }
        let size = dimensions(path);
        sizes.push(FrameSize {
            path: clean_path(path),
            width: size.map(|size| size.0),
            height: size.map(|size| size.1),
        });
    }
    Ok(sizes)
}

#[tauri::command]
pub(crate) async fn inspect_render_sequences(
    path: PathBuf,
    is_directory: bool,
) -> Result<SequenceReport, String> {
    folder_browser::read_with_slots(&SCANS, SCAN_TIMEOUT, move |cancelled| {
        inspect(&path, is_directory, cancelled)
    })
    .await
}

#[tauri::command]
pub(crate) async fn render_sequence_frame_sizes(
    directory: PathBuf,
    paths: Vec<PathBuf>,
) -> Result<Vec<FrameSize>, String> {
    folder_browser::read_with_slots(&SCANS, SCAN_TIMEOUT, move |cancelled| {
        frame_sizes(&directory, &paths, cancelled)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_date_prefixed_frames_and_keeps_dated_stills_and_udims_out() {
        let fixture = tempfile::tempdir().unwrap();
        for name in [
            "S04_11180000.exr",
            "S04_11180002.exr",
            "S04_11180031.exr",
            "S04_11190000.exr",
            "S04_11190001.exr",
            "S04_11180000.png",
            "S04_11180031.png",
            "S04_202611180003.exr",
            "S04_202611180004.exr",
            "S04_20261118.exr",
            "S04_20261119.exr",
            "S04_UDIM_1001.exr",
            "S04_UDIM_1002.exr",
        ] {
            fs::write(fixture.path().join(name), b"fixture").unwrap();
        }
        let report = inspect(
            &fixture.path().join("S04_11180031.exr"),
            false,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(report.sequences.len(), 4);
        let active = report
            .sequences
            .iter()
            .find(|sequence| Some(sequence.key.as_str()) == report.active_key.as_deref())
            .unwrap();
        assert_eq!(active.label, "S04_1118####.exr");
        assert_eq!(active.padding, 4);
        assert_eq!(
            active
                .frames
                .iter()
                .map(|frame| frame.number)
                .collect::<Vec<_>>(),
            [0, 2, 31]
        );
        assert!(is_numbered_render_frame(Path::new("S04_1001.exr")));
        assert!(!is_numbered_render_frame(Path::new("S04_13320001.exr")));
    }

    #[test]
    fn groups_one_level_preserves_padding_and_reads_exr_dimensions() {
        let fixture = tempfile::tempdir().unwrap();
        let frame = |number| fixture.path().join(format!("镜头_{number:03}.exr"));
        for (number, width, height) in [(36, 40, 16), (38, 40, 16), (52, 32, 16)] {
            image::Rgb32FImage::new(width, height)
                .save(frame(number))
                .unwrap();
        }
        fs::write(fixture.path().join("镜头_37.exr"), b"different padding").unwrap();
        fs::create_dir(fixture.path().join("nested")).unwrap();
        fs::write(
            fixture.path().join("nested").join("镜头_037.exr"),
            b"outside scope",
        )
        .unwrap();
        let cancelled = AtomicBool::new(false);
        let report = inspect(&frame(38), false, &cancelled).unwrap();
        assert_eq!(report.sequences.len(), 1);
        assert_eq!(
            report.active_key.as_deref(),
            Some(report.sequences[0].key.as_str())
        );
        assert_eq!(
            report.sequences[0]
                .frames
                .iter()
                .map(|frame| frame.number)
                .collect::<Vec<_>>(),
            [36, 38, 52]
        );
        let frames: Vec<_> = report.sequences[0]
            .frames
            .iter()
            .map(|frame| PathBuf::from(&frame.path))
            .collect();
        let sizes = frame_sizes(Path::new(&report.directory), &frames, &cancelled).unwrap();
        assert_eq!(
            sizes
                .iter()
                .map(|size| (size.width, size.height))
                .collect::<Vec<_>>(),
            [
                (Some(40), Some(16)),
                (Some(40), Some(16)),
                (Some(32), Some(16))
            ]
        );
        assert!(frame_sizes(
            fixture.path(),
            &[fixture.path().join("nested").join("镜头_037.exr")],
            &cancelled
        )
        .is_err());
    }
}
