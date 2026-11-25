use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

pub const MAX_WHITEBOARD_BATCH_BYTES: usize = 512 * 1024;
pub const MAX_WHITEBOARD_OPERATIONS: usize = 64;
pub const DEFAULT_WHITEBOARD_PROJECT: &str = "default";
pub const MAX_WHITEBOARD_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_WHITEBOARD_IMAGE_BASE64: usize = MAX_WHITEBOARD_IMAGE_BYTES.div_ceil(3) * 4;

pub fn valid_whiteboard_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn valid_whiteboard_image_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Deserialize, Serialize)]
pub struct WhiteboardProject {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Serialize)]
pub struct WhiteboardProjectsSnapshot {
    pub projects: Vec<WhiteboardProject>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WhiteboardProjectCreate {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WhiteboardProjectRename {
    pub name: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WhiteboardKind {
    Note,
    Text,
    Rect,
    Ellipse,
    Stroke,
    Image,
    Arrow,
    Frame,
}

impl WhiteboardKind {
    pub fn is_extended(self) -> bool {
        matches!(self, Self::Image | Self::Arrow | Self::Frame)
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WhiteboardColor {
    Yellow,
    Mint,
    Sky,
    Rose,
    Violet,
    #[default]
    Slate,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteboardImageTransform {
    pub rotation: f64,
    pub flip_x: bool,
    pub flip_y: bool,
    pub crop: [f64; 4],
    pub opacity: f64,
}

impl WhiteboardImageTransform {
    pub fn is_valid(&self) -> bool {
        let [left, top, right, bottom] = self.crop;
        (-360.0..=360.0).contains(&self.rotation)
            && (0.0..=1.0).contains(&self.opacity)
            && self.crop.iter().all(|edge| (0.0..=1.0).contains(edge))
            && left < right
            && top < bottom
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WhiteboardConnectionSide {
    Top,
    Right,
    Bottom,
    Left,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WhiteboardConnectionEndpoint {
    pub id: String,
    pub side: WhiteboardConnectionSide,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WhiteboardConnection {
    pub from: WhiteboardConnectionEndpoint,
    pub to: WhiteboardConnectionEndpoint,
}

#[derive(Deserialize, Serialize)]
pub struct WhiteboardItem {
    pub id: String,
    pub kind: WhiteboardKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub color: WhiteboardColor,
    pub points: Vec<[f64; 2]>,
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<WhiteboardConnection>,
    #[serde(rename = "imageId", skip_serializing_if = "Option::is_none")]
    pub image_id: Option<String>,
    #[serde(rename = "assetId", skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(rename = "imageTransform", skip_serializing_if = "Option::is_none")]
    pub image_transform: Option<WhiteboardImageTransform>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WhiteboardPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<WhiteboardKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<WhiteboardColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<[f64; 2]>>,
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<WhiteboardConnection>,
    #[serde(rename = "imageId", skip_serializing_if = "Option::is_none")]
    pub image_id: Option<String>,
    #[serde(rename = "assetId", skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(rename = "imageTransform", skip_serializing_if = "Option::is_none")]
    pub image_transform: Option<WhiteboardImageTransform>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WhiteboardImage {
    pub mime: String,
    pub base64: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardImageReceipt {
    pub image_id: String,
}

pub fn whiteboard_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.is_empty() || bytes.len() > MAX_WHITEBOARD_IMAGE_BYTES {
        return None;
    }
    let format = image::guess_format(bytes).ok()?;
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        _ => return None,
    };
    const MAX_EDGE: u32 = 8192;
    const MAX_PIXELS: u64 = 16_777_216;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader.into_decoder().ok()?;
    let (width, height) = image::ImageDecoder::dimensions(&decoder);
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return None;
    }
    image::DynamicImage::from_decoder(decoder).ok()?;
    Some(mime)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WhiteboardOperation {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<WhiteboardPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhiteboardBatch {
    pub operations: Vec<WhiteboardOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct WhiteboardSnapshot {
    pub revision: u64,
    pub items: Vec<WhiteboardItem>,
    #[serde(rename = "imageTransforms", skip_serializing_if = "Option::is_none")]
    pub image_transforms: Option<bool>,
    #[serde(rename = "assetReferences", skip_serializing_if = "Option::is_none")]
    pub asset_references: Option<bool>,
    #[serde(rename = "restoreItems", skip_serializing_if = "Option::is_none")]
    pub restore_items: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections: Option<bool>,
}
