use nexus_core::thumbnail_cache::{
    mesh_source_limit, MAX_MESH_SOURCE_BYTES, MAX_NATIVE_MESH_SOURCE_BYTES,
};
use std::{
    collections::HashMap,
    fmt::Write as _,
    fs::File,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};
use ufbx::{
    AllocatorOpts, ErrorType, FileFormat, LoadOpts, Mesh, Node, ProgressCb, ProgressResult, Vec3,
};

const MAX_DIRECT_PREVIEW_BYTES: u64 = 30_000_000;
const MAX_THUMBNAIL_TRIANGLES: usize = 16_000;
const MAX_PREVIEW_TRIANGLES: usize = 48_000;
const MAX_MESH_INSTANCES: usize = 8192;
const MAX_INSTANCE_TRIANGLES: usize = 20_000_000;
const MAX_FACE_POINTS: u32 = 1024;
const MAX_POSITION: f64 = 1.0e20;
const MAX_DECODE_TIME: Duration = Duration::from_secs(8);
static MESH_PREVIEWS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

pub(super) async fn slot() -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    MESH_PREVIEWS
        .acquire()
        .await
        .map_err(|error| error.to_string())
}

pub(super) enum Preview {
    Obj(String),
    Binary(Vec<u8>),
}

pub(super) fn source_byte_limit(extension: &str, thumbnail: bool) -> Option<u64> {
    match extension {
        "obj" | "fbx" => Some(MAX_NATIVE_MESH_SOURCE_BYTES),
        ext if thumbnail => mesh_source_limit(ext),
        ext => mesh_source_limit(ext).map(|_| MAX_DIRECT_PREVIEW_BYTES),
    }
}

pub(super) fn read(path: &Path, extension: &str, thumbnail: bool) -> Result<Preview, String> {
    let limit = source_byte_limit(extension,thumbnail)
        .ok_or("交互预览支持 OBJ、FBX、STL、PLY、GLB 和内嵌几何的 glTF")?;
    let file = File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() > limit {
        return Err("网格文件超过此预览模式的文件大小限制".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("网格文件超过此预览模式的文件大小限制".into());
    }

    let format = match extension {
        "obj" => FileFormat::Obj,
        "fbx" => FileFormat::Fbx,
        _ => return Ok(Preview::Binary(bytes)),
    };
    if format == FileFormat::Obj && bytes.len() as u64 <= MAX_MESH_SOURCE_BYTES {
        bytes = match String::from_utf8(bytes) {
            Ok(text) => return Ok(Preview::Obj(text)),
            Err(error) => error.into_bytes(),
        };
    }
    let triangles = if thumbnail {
        MAX_THUMBNAIL_TRIANGLES
    } else {
        MAX_PREVIEW_TRIANGLES
    };
    convert(&bytes, format, triangles).map(Preview::Obj)
}

fn convert(bytes: &[u8], format: FileFormat, budget: usize) -> Result<String, String> {
    let deadline = Instant::now() + MAX_DECODE_TIME;
    let check_progress = |_: &ufbx::Progress| {
        if Instant::now() < deadline {
            ProgressResult::Continue
        } else {
            ProgressResult::Cancel
        }
    };
    let scene = ufbx::load_memory(
        bytes,
        LoadOpts {
            file_format: format,
            temp_allocator: AllocatorOpts {
                memory_limit: 128 * 1024 * 1024,
                ..Default::default()
            },
            result_allocator: AllocatorOpts {
                memory_limit: 192 * 1024 * 1024,
                ..Default::default()
            },
            progress_cb: ProgressCb::Ref(&check_progress),
            progress_interval_hint: 128 * 1024,
            load_external_files: false,
            ignore_animation: true,
            ignore_embedded: true,
            skip_skin_vertices: true,
            skip_mesh_parts: true,
            node_depth_limit: 128,
            target_axes: ufbx::CoordinateAxes::right_handed_y_up(),
            ..Default::default()
        },
    )
    .map_err(|error| match error.type_ {
        ErrorType::MemoryLimit | ErrorType::AllocationLimit => "网格预览超过内存限制".to_owned(),
        ErrorType::Cancelled => "网格解码超时".to_owned(),
        _ => format!("无法解析网格：{}", error.description),
    })?;

    let mut nodes = Vec::new();
    let mut total = 0usize;
    for node in &scene.nodes {
        let Some(mesh) = node.mesh.as_deref().filter(|mesh| mesh.num_triangles > 0) else {
            continue;
        };
        total = total.saturating_add(mesh.num_triangles);
        if nodes.len() == MAX_MESH_INSTANCES || total > MAX_INSTANCE_TRIANGLES {
            return Err("网格实例过多，请使用简化模型或设置封面".into());
        }
        nodes.push((node, mesh));
    }

    // Divide the surface budget across the ordered scene rather than truncating
    // the last objects in a multi-mesh file.
    let stride = total.div_ceil(budget).max(1);
    let mut preview = ObjPreview::default();
    let mut relative_offset = 0;
    let mut face_corners = Vec::new();
    for (node, mesh) in nodes {
        let mut shared_vertices = HashMap::new();
        let flipped = ufbx::matrix_determinant(&node.geometry_to_world) < 0.0;
        for face in &mesh.faces {
            let count = face.num_indices.saturating_sub(2) as usize;
            if count == 0 {
                continue;
            }
            let first = (stride - relative_offset) % stride;
            relative_offset = (relative_offset + count) % stride;
            if first >= count || face.num_indices > MAX_FACE_POINTS {
                continue;
            }
            if Instant::now() >= deadline {
                return Err("网格解码超时".into());
            }
            face_corners.resize(count * 3, 0);
            let count = ufbx::triangulate_face(&mut face_corners, mesh, *face) as usize;
            for sample in (first..count).step_by(stride) {
                let start = sample * 3;
                let mut corners = [
                    face_corners[start],
                    face_corners[start + 1],
                    face_corners[start + 2],
                ];
                if flipped {
                    corners.swap(1, 2);
                }
                preview.add_triangle(node, mesh, corners, &mut shared_vertices);
                if preview.faces == budget {
                    return Ok(preview.text);
                }
            }
        }
    }
    if preview.faces == 0 {
        return Err("文件中未找到可预览的网格".into());
    }
    Ok(preview.text)
}

#[derive(Default)]
struct ObjPreview {
    text: String,
    vertices: usize,
    faces: usize,
}

impl ObjPreview {
    fn add_triangle(
        &mut self,
        node: &Node,
        mesh: &Mesh,
        corners: [u32; 3],
        shared: &mut HashMap<u32, usize>,
    ) {
        let mut source = [0u32; 3];
        let mut points = [Vec3::default(); 3];
        for (position, corner) in corners.into_iter().enumerate() {
            let Some(&index) = mesh.vertex_indices.get(corner as usize) else {
                return;
            };
            let Some(&point) = mesh.vertices.get(index as usize) else {
                return;
            };
            let point = ufbx::transform_position(&node.geometry_to_world, point);
            if [point.x, point.y, point.z]
                .into_iter()
                .any(|value| !value.is_finite() || value.abs() > MAX_POSITION)
            {
                return;
            }
            source[position] = index;
            points[position] = point;
        }
        if source[0] == source[1] || source[0] == source[2] || source[1] == source[2] {
            return;
        }
        let [a, b, c] = std::array::from_fn(|position| {
            *shared.entry(source[position]).or_insert_with(|| {
                let Vec3 { x, y, z } = points[position];
                writeln!(self.text, "v {x:.11e} {y:.11e} {z:.11e}").expect("writing to String");
                self.vertices += 1;
                self.vertices
            })
        });
        writeln!(self.text, "f {a} {b} {c}").expect("writing to String");
        self.faces += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIANGLE: &str = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";

    #[test]
    fn keeps_small_obj_text_and_compacts_larger_obj() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("wire.obj");
        std::fs::write(&path, TRIANGLE).unwrap();
        let Preview::Obj(text) = read(&path, "obj", true).unwrap() else {
            panic!("expected OBJ")
        };
        assert_eq!(text, TRIANGLE);

        let large = format!(
            "{}{}",
            "# ignored material metadata\n".repeat(30_000),
            TRIANGLE
        );
        assert!(large.len() as u64 > MAX_MESH_SOURCE_BYTES);
        std::fs::write(&path, large).unwrap();
        let Preview::Obj(text) = read(&path, "obj", true).unwrap() else {
            panic!("expected OBJ")
        };
        assert_eq!(
            text.lines().filter(|line| line.starts_with("v ")).count(),
            3
        );
        assert_eq!(
            text.lines().filter(|line| line.starts_with("f ")).count(),
            1
        );
        assert!(text.len() < 200);
    }

    #[test]
    fn applies_fbx_parent_and_geometry_transforms() {
        let input = br#"; FBX 7.4.0 project file
FBXHeaderExtension: {
    FBXHeaderVersion: 1003
    FBXVersion: 7400
}
Objects: {
    Geometry: 101, "Geometry::Triangle", "Mesh" {
        Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
        PolygonVertexIndex: *3 { a: 0,1,-3 }
    }
    Model: 102, "Model::Child", "Mesh" {
        Version: 232
        Properties70: {
            P: "Lcl Translation", "Lcl Translation", "", "A", 2,0,0
            P: "GeometricTranslation", "Vector3D", "Vector", "", 3,0,0
        }
    }
    Model: 103, "Model::Group", "Null" {
        Version: 232
        Properties70: {
            P: "Lcl Translation", "Lcl Translation", "", "A", 20,0,0
        }
    }
}
Connections: {
    C: "OO",101,102
    C: "OO",102,103
    C: "OO",103,0
}
"#;
        let text = convert(input, FileFormat::Fbx, 4).unwrap();
        let points: Vec<f64> = text
            .lines()
            .filter_map(|line| {
                line.strip_prefix("v ")?
                    .split_ascii_whitespace()
                    .next()?
                    .parse()
                    .ok()
            })
            .collect();
        assert_eq!(points, vec![25.0, 26.0, 25.0]);
        assert!(text.lines().any(|line| line == "f 1 2 3"));
    }

    #[test]
    fn rejects_empty_surfaces_and_invalid_fbx() {
        assert!(convert(b"v 0 0 0\nv 1 0 0\nl 1 2\n", FileFormat::Obj, 4).is_err());
        assert!(convert(b"not an FBX file", FileFormat::Fbx, 4).is_err());
    }
}
