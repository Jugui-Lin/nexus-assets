use image::{DynamicImage, Rgb, RgbImage};
use std::{fs::File, io::Read, path::Path};

pub(super) const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ANGLES: usize = 4096;
const MAX_SAMPLES: usize = 524_288;
const ANGLE_TOLERANCE: f64 = 0.01;

struct Profile {
    photometric_type: usize,
    vertical: Vec<f64>,
    horizontal: Vec<f64>,
    intensities: Vec<f64>,
    peak: f64,
    peak_plane: usize,
}

pub(super) fn decode(path: &Path, size: u32) -> Result<Option<DynamicImage>, String> {
    let read_error = |error| format!("无法读取 IES 预览：{error}");
    let file = File::open(path).map_err(read_error)?;
    if file.metadata().map_err(read_error)?.len() > MAX_FILE_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Ok(None);
    }
    Ok(parse(&String::from_utf8_lossy(&bytes)).map(|profile| draw(&profile, size)))
}

fn count(
    numbers: &mut impl Iterator<Item = Option<f64>>,
    range: std::ops::RangeInclusive<usize>,
) -> Option<usize> {
    let value = numbers.next()??;
    let integer = value as usize;
    (value == integer as f64 && range.contains(&integer)).then_some(integer)
}

fn read_angles(
    numbers: &mut impl Iterator<Item = Option<f64>>,
    amount: usize,
    min: f64,
    max: f64,
) -> Option<Vec<f64>> {
    let mut angles = Vec::with_capacity(amount);
    for _ in 0..amount {
        let angle = numbers.next()??;
        if !(min - ANGLE_TOLERANCE..=max + ANGLE_TOLERANCE).contains(&angle)
            || angles.last().is_some_and(|previous| *previous >= angle)
        {
            return None;
        }
        angles.push(angle);
    }
    Some(angles)
}

fn parse(text: &str) -> Option<Profile> {
    let mut lines = text.split(['\r', '\n']);
    let tilt = lines.find_map(|line| {
        let (field, value) = line.trim_start_matches('\u{feff}').split_once('=')?;
        field
            .trim()
            .eq_ignore_ascii_case("TILT")
            .then_some(value.trim())
    })?;
    let (tilt_method, inline_tilt) = tilt.split_once(char::is_whitespace).unwrap_or((tilt, ""));
    if tilt_method.is_empty() {
        return None;
    }
    let included = tilt_method.eq_ignore_ascii_case("INCLUDE");
    let mut numbers = std::iter::once(if included { inline_tilt } else { "" })
        .chain(lines)
        .flat_map(|line| line.split(|ch: char| ch.is_ascii_whitespace() || ch == ','))
        .filter(|token| !token.is_empty())
        .map(|token| token.parse::<f64>().ok().filter(|value| value.is_finite()));

    // The photometric chart normalizes candela values. Lamp tilt and
    // calibration multipliers affect their common scale, not their shape.
    if included {
        numbers.next()??;
        let tilt_angles = count(&mut numbers, 1..=MAX_ANGLES)?;
        for _ in 0..2 * tilt_angles {
            numbers.next()??;
        }
    }
    for _ in 0..3 {
        numbers.next()??; // Lamps, rated lumens and candela multiplier.
    }
    let vertical_count = count(&mut numbers, 2..=MAX_ANGLES)?;
    let horizontal_count = count(&mut numbers, 1..=MAX_ANGLES)?;
    let photometric_type = count(&mut numbers, 1..=3)?;
    for _ in 0..7 {
        numbers.next()??; // Units, luminous dimensions, ballast and input wattage.
    }
    let samples = horizontal_count.checked_mul(vertical_count)?;
    if samples > MAX_SAMPLES {
        return None;
    }
    let (vertical, horizontal) = if photometric_type == 1 {
        (
            read_angles(&mut numbers, vertical_count, 0.0, 180.0)?,
            read_angles(&mut numbers, horizontal_count, 0.0, 360.0)?,
        )
    } else {
        (
            read_angles(&mut numbers, vertical_count, -90.0, 90.0)?,
            read_angles(&mut numbers, horizontal_count, -90.0, 90.0)?,
        )
    };
    let mut intensities = Vec::with_capacity(samples);
    let mut peak = 0.0f64;
    let mut peak_plane = 0;
    for index in 0..samples {
        let value = numbers.next()??.max(0.0);
        if value > peak {
            peak = value;
            peak_plane = index / vertical_count;
        }
        intensities.push(value);
    }
    (peak > 0.0).then_some(Profile {
        photometric_type,
        vertical,
        horizontal,
        intensities,
        peak,
        peak_plane,
    })
}

fn position(angles: &[f64], angle: f64) -> Option<(usize, usize, f64)> {
    let first = angles[0];
    let last = *angles.last()?;
    if !(first - ANGLE_TOLERANCE..=last + ANGLE_TOLERANCE).contains(&angle) {
        return None;
    }
    let next = angles.partition_point(|sample| *sample <= angle);
    if next == 0 {
        return Some((0, 0, 0.0));
    }
    if next == angles.len() {
        return Some((next - 1, next - 1, 0.0));
    }
    Some((
        next - 1,
        next,
        (angle - angles[next - 1]) / (angles[next] - angles[next - 1]),
    ))
}

fn mirrored(angle: f64, span: f64) -> f64 {
    let angle = angle.rem_euclid(span * 2.0);
    angle.min(span * 2.0 - angle)
}

impl Profile {
    fn horizontal_position(&self, angle: f64) -> Option<(usize, usize, f64)> {
        let last_index = self.horizontal.len() - 1;
        if last_index == 0 {
            return Some((0, 0, 0.0));
        }
        if self.photometric_type != 1 {
            let angle = if self.horizontal[0] >= -ANGLE_TOLERANCE {
                angle.abs()
            } else {
                angle
            };
            return position(&self.horizontal, angle);
        }
        let first = self.horizontal[0];
        let span = self.horizontal[last_index] - first;
        let mut delta = (angle - first).rem_euclid(360.0);
        if (span - 90.0).abs() <= ANGLE_TOLERANCE || (span - 180.0).abs() <= ANGLE_TOLERANCE {
            delta = mirrored(delta, span);
        }
        if delta > span + ANGLE_TOLERANCE {
            return Some((last_index, 0, (delta - span) / (360.0 - span)));
        }
        position(&self.horizontal, first + delta)
    }

    fn sample(&self, horizontal: f64, vertical: f64) -> f64 {
        let Some((low_h, high_h, h)) = self.horizontal_position(horizontal) else {
            return 0.0;
        };
        let vertical = if self.photometric_type != 1 && self.vertical[0] >= -ANGLE_TOLERANCE {
            vertical.abs()
        } else {
            vertical
        };
        let Some((low_v, high_v, v)) = position(&self.vertical, vertical) else {
            return 0.0;
        };
        let at = |row, col| self.intensities[row * self.vertical.len() + col] / self.peak;
        let low = at(low_h, low_v) * (1.0 - v) + at(low_h, high_v) * v;
        let high = at(high_h, low_v) * (1.0 - v) + at(high_h, high_v) * v;
        low * (1.0 - h) + high * h
    }

    fn cut(&self, plane: u32, angle: f64) -> f64 {
        if self.photometric_type == 1 {
            let horizontal = self.horizontal[self.peak_plane] + f64::from(plane) * 90.0;
            if angle <= 180.0 {
                self.sample(horizontal, angle)
            } else {
                self.sample(horizontal + 180.0, 360.0 - angle)
            }
        } else {
            // Type A/B angles are measured about a forward axis. Show the
            // orthogonal native cuts without presenting them as Type C angles.
            let signed = if angle > 180.0 { angle - 360.0 } else { angle };
            if signed.abs() > 90.0 {
                0.0
            } else if plane == 0 {
                self.sample(0.0, signed)
            } else {
                self.sample(signed, 0.0)
            }
        }
    }
}

type Point = (f64, f64);

fn stroke(image: &mut RgbImage, start: Point, end: Point, radius: f64, color: [u8; 3]) {
    let last = f64::from(image.width() - 1);
    let margin = radius + 0.5;
    let min_x = (start.0.min(end.0) - margin).floor().clamp(0.0, last) as u32;
    let max_x = (start.0.max(end.0) + margin).ceil().clamp(0.0, last) as u32;
    let min_y = (start.1.min(end.1) - margin).floor().clamp(0.0, last) as u32;
    let max_y = (start.1.max(end.1) + margin).ceil().clamp(0.0, last) as u32;
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    let denominator = dx * dx + dy * dy;
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let px = f64::from(x) + 0.5 - start.0;
            let py = f64::from(y) + 0.5 - start.1;
            let along = if denominator > 0.0 {
                ((px * dx + py * dy) / denominator).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let distance = (px - along * dx).hypot(py - along * dy);
            let opacity = (margin - distance).clamp(0.0, 1.0);
            let pixel = image.get_pixel_mut(x, y);
            for (value, next) in pixel.0.iter_mut().zip(color) {
                *value =
                    (f64::from(*value) * (1.0 - opacity) + f64::from(next) * opacity).round() as u8;
            }
        }
    }
}

fn draw(profile: &Profile, size: u32) -> DynamicImage {
    let size = size.clamp(1, 1024);
    let mut image = RgbImage::from_pixel(size, size, Rgb([21, 30, 34]));
    let middle = f64::from(size) / 2.0;
    let edge = middle * 0.84;
    let point = |angle: f64, radius: f64| {
        let (sine, cosine) = angle.to_radians().sin_cos();
        (middle + sine * radius, middle + cosine * radius)
    };
    let grid_weight = (f64::from(size) / 600.0).max(0.38);
    let grid_color = [47, 65, 70];
    for quarter in 1..=4 {
        let radius = edge * f64::from(quarter) / 4.0;
        for step in 0..120 {
            let angle = f64::from(step * 3);
            stroke(
                &mut image,
                point(angle, radius),
                point(angle + 3.0, radius),
                grid_weight,
                grid_color,
            );
        }
    }
    for axis in 0..4 {
        let angle = f64::from(axis * 45);
        stroke(
            &mut image,
            point(angle, edge),
            point(angle + 180.0, edge),
            grid_weight,
            grid_color,
        );
    }
    let profile_weight = (f64::from(size) / 235.0).max(0.9);
    for (plane, color) in [(1, [247, 177, 115]), (0, [139, 224, 210])] {
        if plane == 1 && profile.horizontal.len() == 1 {
            continue;
        }
        let mut previous = point(0.0, edge * profile.cut(plane, 0.0));
        for sample in 1..=720 {
            let angle = f64::from(sample) / 2.0;
            let current = point(angle, edge * profile.cut(plane, angle));
            if previous != current {
                stroke(&mut image, previous, current, profile_weight, color);
            }
            previous = current;
        }
    }
    DynamicImage::ImageRgb8(image)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{scaled_preview_image, thumbnail_cache, Catalog};

    fn profile(tilt: &str) -> String {
        format!(
            "\u{feff}IESNA:LM-63-2002\r\n[TEST] 代表配光\r\n {tilt}\r\n\
             1, -1, 1, 7, 3, 1, 1, 0, 0, 0\r\n1 1 8\r\n\
             0 30 60 90 120 150 180\r\n0 45 90\r\n\
             1000 650 280 0 0 0 0\r\n900 650 300 0 0 0 0\r\n\
             800 450 100 0 0 0 0\r\n"
        )
    }

    #[test]
    fn parses_tilt_profiles_and_uses_symmetry_and_relative_intensity() {
        for declaration in [
            "TILT = NONE",
            "tilt=include\r\n1 3\r\n0 45 90\r\n1 0.9 0.8",
            "TILT=missing.tlt",
        ] {
            let data = parse(&profile(declaration)).unwrap();
            assert_eq!(data.sample(0.0, 0.0), 1.0);
            assert_eq!(data.sample(180.0, 30.0), data.sample(0.0, 30.0));
            assert_eq!(data.sample(270.0, 30.0), data.sample(90.0, 30.0));
            assert!(data.sample(45.0, 15.0) > data.sample(45.0, 60.0));
        }
    }

    #[test]
    fn rejects_truncated_or_invalid_source_and_caps_oversized_counts() {
        assert!(parse("IESNA:LM-63-2002\nTILT=NONE\n1 -1 1 99999 1 1").is_none());
        let truncated = profile("TILT=NONE").replace("800 450 100 0 0 0 0", "800 NaN");
        assert!(parse(&truncated).is_none());
        assert!(parse(&profile("TILT=INCLUDE\n1 999999999")).is_none());
    }

    #[test]
    fn type_a_and_b_show_both_native_cuts() {
        for photometric_type in [2, 3] {
            let profile = format!(
                "TILT=NONE\n1 -1 1 3 3 {photometric_type} 1 0 0 0\n1 1 8\n\
                 -90 0 90\n-90 0 90\n0 30 0\n25 100 50\n0 45 0"
            );
            let data = parse(&profile).unwrap();
            assert_eq!(data.cut(0, 0.0), 1.0);
            assert_eq!(data.cut(0, 90.0), 0.5);
            assert_eq!(data.cut(1, 270.0), 0.3);
            assert_eq!(data.cut(1, 180.0), 0.0);
        }
    }

    #[test]
    fn ies_reaches_card_cache_and_large_preview_and_respects_cover() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("投射灯.IES");
        std::fs::write(&path, profile("TILT=NONE")).unwrap();
        let catalog = Catalog::open(&temp.path().join("catalog")).unwrap();
        catalog.add_file(&path, "test").unwrap();
        let mut asset = catalog.assets().unwrap().remove(0);
        let cache = temp.path().join("cache");
        let (mime, thumbnail) = thumbnail_cache::read_or_generate(&asset, &cache, 256)
            .unwrap()
            .unwrap();
        assert_eq!(mime, "image/png");
        let pixels = image::load_from_memory(&thumbnail).unwrap().into_rgb8();
        assert_eq!(pixels.dimensions(), (256, 256));
        assert!(pixels.pixels().any(|pixel| pixel.0 == [139, 224, 210]));
        assert_eq!(
            thumbnail_cache::read(&asset, &cache, 256)
                .unwrap()
                .unwrap()
                .1,
            thumbnail
        );
        asset.modified = serde_json::json!(path
            .metadata()
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64);
        let (_, large) = scaled_preview_image(&asset, &cache, 1600).unwrap().unwrap();
        assert_eq!(image::load_from_memory(&large).unwrap().width(), 1024);
        let cover = temp.path().join("cover.png");
        RgbImage::from_pixel(80, 50, Rgb([222, 0, 66]))
            .save(&cover)
            .unwrap();
        asset.thumbnail = Some(cover.to_string_lossy().into_owned());
        let (_, preview) = scaled_preview_image(&asset, &cache, 1600).unwrap().unwrap();
        assert_eq!(
            image::load_from_memory(&preview)
                .unwrap()
                .into_rgb8()
                .get_pixel(10, 10)
                .0,
            [222, 0, 66]
        );
        std::fs::rename(&path, temp.path().join("unmounted.ies")).unwrap();
        let (_, cached) = thumbnail_cache::read_team_original_from_index(&asset, &cache, 256)
            .unwrap()
            .unwrap();
        assert_eq!(cached, thumbnail);
    }
}
