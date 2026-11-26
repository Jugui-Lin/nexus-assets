use super::{preview_dimensions, valid_metadata_with_limit, EXR_LIMIT_ERROR, METADATA_BUDGET};
use exr::{
    error::Error,
    image::read::layers::ReadChannels,
    meta::{attribute::Text, header::Header, MetaData},
    prelude::{read, ReadLayers, ReadSpecificChannel, Vec2},
};
use image::{DynamicImage, GrayImage, ImageBuffer, Luma, Pixel, Rgb};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};

const MAX_ALLOC: u64 = 96 * 1024 * 1024;
const MAX_VIEWS: usize = 512;
const MAX_SIZE: u32 = 960;

#[derive(Serialize)]
pub struct ExrView {
    key: String,
    label: String,
    channels: Vec<String>,
    width: usize,
    height: usize,
    #[serde(skip)]
    part: Option<Text>,
    #[serde(skip)]
    samples: Samples,
}

enum Samples {
    Single(Text),
    Rgb([Text; 3]),
}

struct PartChannels<C> {
    part: Option<Text>,
    channels: C,
}

impl<'a, C: ReadChannels<'a>> ReadChannels<'a> for PartChannels<C> {
    type Reader = C::Reader;

    fn create_channels_reader(&'a self, header: &Header) -> exr::error::Result<Self::Reader> {
        if self.part != header.own_attributes.layer_name {
            return Err(Error::Invalid("different EXR part".into()));
        }
        self.channels.create_channels_reader(header)
    }
}

struct SelectedPixels<P: Pixel<Subpixel = f32>> {
    source: Vec2<usize>,
    image: ImageBuffer<P, Vec<f32>>,
}

impl<P: Pixel<Subpixel = f32>> SelectedPixels<P> {
    fn new(size: Vec2<usize>) -> Option<Self> {
        let (width, height) = preview_dimensions(size, MAX_ALLOC, MAX_SIZE, 24)?;
        Some(Self {
            source: size,
            image: ImageBuffer::new(width, height),
        })
    }

    fn set(&mut self, at: Vec2<usize>, pixel: P) {
        let (width, height) = (self.image.width() as usize, self.image.height() as usize);
        let x = at.x() * width / self.source.width();
        let y = at.y() * height / self.source.height();
        if at.x() != (x * self.source.width()).div_ceil(width)
            || at.y() != (y * self.source.height()).div_ceil(height)
        {
            return;
        }
        if let Some(target) = self.image.get_pixel_mut_checked(x as u32, y as u32) {
            *target = pixel;
        }
    }
}

fn labels(metadata: &MetaData) -> Result<Vec<ExrView>, String> {
    let mut views = Vec::new();
    for (index, header) in metadata.headers.iter().enumerate() {
        let part = &header.own_attributes.layer_name;
        if metadata.headers[..index]
            .iter()
            .any(|other| other.own_attributes.layer_name == *part)
        {
            return Err("EXR 的部分名称重复，无法准确定位通道。".into());
        }
        let describe = |key, label, channels, samples| ExrView {
            key,
            label,
            channels,
            samples,
            part: part.clone(),
            width: header.layer_size.width(),
            height: header.layer_size.height(),
        };
        let mut color_groups: BTreeMap<String, [Option<&Text>; 3]> = BTreeMap::new();
        let mut scalar_views = Vec::new();
        for channel in &header.channels.list {
            if channel.sampling != Vec2(1, 1) {
                continue;
            }
            let name = channel.name.to_string();
            let (prefix, component) = name.rsplit_once('.').unwrap_or(("", &name));
            if let Some(component) = ["R", "G", "B"].iter().position(|part| *part == component) {
                color_groups.entry(prefix.into()).or_default()[component] = Some(&channel.name);
            }
            let label = part
                .as_ref()
                .map_or_else(|| name.clone(), |part| format!("{part} / {name}"));
            scalar_views.push(describe(
                format!("{index}:channel:{name}"),
                label,
                vec![name],
                Samples::Single(channel.name.clone()),
            ));
        }
        for (prefix, channels) in color_groups {
            let [Some(red), Some(green), Some(blue)] = channels else {
                continue;
            };
            let title = if prefix.is_empty() {
                part.as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "Beauty".into())
            } else {
                part.as_ref()
                    .map_or_else(|| prefix.clone(), |part| format!("{part} / {prefix}"))
            };
            views.push(describe(
                format!("{index}:rgb:{prefix}"),
                format!("{title} · RGB"),
                [red, green, blue].map(ToString::to_string).to_vec(),
                Samples::Rgb([red.clone(), green.clone(), blue.clone()]),
            ));
        }
        views.extend(scalar_views);
        if views.len() > MAX_VIEWS {
            return Err("EXR 的通道数量超过对照上限。".into());
        }
    }
    if views.is_empty() {
        return Err("EXR 没有可读取的普通通道。".into());
    }
    Ok(views)
}

fn display_gray(image: ImageBuffer<Luma<f32>, Vec<f32>>) -> GrayImage {
    let (min, max) = image
        .as_raw()
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), value| {
            (min.min(value), max.max(value))
        });
    let normalize = min < max && (min < 0.0 || max > 1.0);
    let (min, max) = (f64::from(min), f64::from(max));
    GrayImage::from_fn(image.width(), image.height(), |x, y| {
        let value = f64::from(image[(x, y)].0[0]);
        let display = if !value.is_finite() {
            0.0
        } else if normalize {
            (value - min) / (max - min)
        } else {
            value.clamp(0.0, 1.0)
        };
        Luma([(display * 255.0).round() as u8])
    })
}

fn display_rgb(sample: f32) -> u8 {
    let linear = if sample.is_finite() {
        sample.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let srgb = if linear <= 0.0031308 {
        linear * 12.92
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    };
    (srgb * 255.0).round() as u8
}

fn read_pixels(reader: BufReader<File>, view: &ExrView) -> Result<DynamicImage, String> {
    let channels = || {
        read()
            .no_deep_data()
            .largest_resolution_level()
            .specific_channels()
    };
    let image = match &view.samples {
        Samples::Single(name) => {
            let selected = channels().required(name.clone()).collect_pixels(
                |size, _| SelectedPixels::new(size),
                |pixels, at, (value,): (f32,)| {
                    if let Some(pixels) = pixels {
                        pixels.set(at, Luma([value]));
                    }
                },
            );
            let image = PartChannels {
                part: view.part.clone(),
                channels: selected,
            }
            .first_valid_layer()
            .all_attributes()
            .non_parallel()
            .from_buffered(reader)
            .map_err(|error| error.to_string())?
            .layer_data
            .channel_data
            .pixels
            .ok_or(EXR_LIMIT_ERROR)?
            .image;
            DynamicImage::ImageLuma8(display_gray(image))
        }
        Samples::Rgb([red, green, blue]) => {
            let selected = channels()
                .required(red.clone())
                .required(green.clone())
                .required(blue.clone())
                .collect_pixels(
                    |size, _| SelectedPixels::new(size),
                    |pixels, at, (r, g, b): (f32, f32, f32)| {
                        if let Some(pixels) = pixels {
                            pixels.set(at, Rgb([r, g, b]));
                        }
                    },
                );
            let image = PartChannels {
                part: view.part.clone(),
                channels: selected,
            }
            .first_valid_layer()
            .all_attributes()
            .non_parallel()
            .from_buffered(reader)
            .map_err(|error| error.to_string())?
            .layer_data
            .channel_data
            .pixels
            .ok_or(EXR_LIMIT_ERROR)?
            .image;
            DynamicImage::ImageRgb8(ImageBuffer::from_fn(
                image.width(),
                image.height(),
                |x, y| Rgb(image[(x, y)].0.map(display_rgb)),
            ))
        }
    };
    Ok(image)
}

pub fn read_exr_views(
    path: &Path,
    selection: Option<(&str, &str)>,
) -> Result<(String, Vec<ExrView>, Option<DynamicImage>), String> {
    let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let stat = reader
        .get_ref()
        .metadata()
        .map_err(|error| error.to_string())?;
    let modified = stat
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok());
    let revision = format!("{}:{modified:?}", stat.len());
    let metadata = MetaData::read_from_buffered((&mut reader).take(METADATA_BUDGET), false)
        .map_err(|error| error.to_string())?;
    if !valid_metadata_with_limit(&metadata, MAX_ALLOC, MAX_SIZE, 96) {
        return Err("仅支持在预览尺寸和内存限制内的普通 EXR；深度采样 EXR 暂不支持。".into());
    }
    let views = labels(&metadata)?;
    if let Some((key, expected_revision)) = selection {
        if revision != expected_revision {
            return Err("当前帧的源文件已变化，请重新打开通道对照。".into());
        }
        let view = views
            .iter()
            .find(|view| view.key == key)
            .ok_or("EXR 中找不到该通道。")?;
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let image = read_pixels(reader, view)?;
        return Ok((revision, Vec::new(), Some(image)));
    }
    Ok((revision, views, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use exr::prelude::{
        AnyChannel, AnyChannels, Encoding, FlatSamples, Image, ImageAttributes, IntegerBounds,
        Layer, LayerAttributes, WritableImage,
    };

    fn layer(name: &str, channels: &[(&str, [f32; 2])]) -> Layer<AnyChannels<FlatSamples>> {
        Layer::new(
            (2, 1),
            LayerAttributes::named(name),
            Encoding::FAST_LOSSLESS,
            AnyChannels::sort(
                channels
                    .iter()
                    .map(|(name, samples)| {
                        AnyChannel::new(*name, FlatSamples::F32(samples.to_vec()))
                    })
                    .collect(),
            ),
        )
    }

    #[test]
    fn compares_actual_multipart_rgb_and_scalar_channels() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("layered.exr");
        let beauty = layer(
            "Beauty",
            &[
                ("R", [1.0, 1.0]),
                ("G", [0.0, 0.0]),
                ("B", [0.0, 0.0]),
                ("Shadow.Y", [0.25, 0.75]),
                ("Z", [100.0, 500.0]),
            ],
        );
        let reflection = layer(
            "Reflection",
            &[("R", [0.0, 0.0]), ("G", [1.0, 1.0]), ("B", [0.0, 0.0])],
        );
        Image::empty(ImageAttributes::new(IntegerBounds::from_dimensions((2, 1))))
            .with_layer(beauty)
            .with_layer(reflection)
            .write()
            .to_file(&path)
            .unwrap();

        let (revision, views, output) = read_exr_views(&path, None).unwrap();
        assert!(output.is_none());
        let preview = |label| {
            let key = &views.iter().find(|view| view.label == label).unwrap().key;
            read_exr_views(&path, Some((key, &revision)))
                .unwrap()
                .2
                .unwrap()
        };
        assert_eq!(
            *preview("Beauty · RGB").to_rgb8().get_pixel(0, 0),
            Rgb([255, 0, 0])
        );
        assert_eq!(
            *preview("Reflection · RGB").to_rgb8().get_pixel(0, 0),
            Rgb([0, 255, 0])
        );
        assert_eq!(
            preview("Beauty / Shadow.Y").to_luma8().into_raw(),
            [64, 191]
        );
        assert_eq!(preview("Beauty / Z").to_luma8().into_raw(), [0, 255]);
        assert!(read_exr_views(&path, Some(("9:channel:R", &revision))).is_err());
        assert!(read_exr_views(&path, Some((&views[0].key, "stale-revision"))).is_err());
    }
}
