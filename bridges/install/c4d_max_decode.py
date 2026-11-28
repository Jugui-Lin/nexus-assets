"""Decode supported MAX meshes with the pinned Blender extension, without 3ds Max."""

import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

_ARCHIVE = "nexus_io_scene_max_1_9_2.zip"
_ARCHIVE_SIZE = 92503
_ARCHIVE_SHA256 = "ae11b8903ca7fcab78cd1163305b80a268335894139f251a502da0476ef77b43"
_SOURCE = "NEXUS_MAX_DECODE_SOURCE"
_OUTPUT = "NEXUS_MAX_DECODE_OUTPUT"
_EXTENSION = "NEXUS_MAX_DECODE_EXTENSION"
_STATUS = "NEXUS_MAX_DECODE_STATUS"
_VERSION_MARKER = b"NEXUS_MAX_DECODE_BLENDER_VERSION"
_GEOMETRY_MARKER = b"NEXUS_MAX_DECODE_NO_GEOMETRY"
_UNITS_MARKER = b"NEXUS_MAX_DECODE_UNKNOWN_UNITS"
_LOG_TAIL_BYTES = 64 * 1024
_TEXTURE_MANIFEST_FILE = "texture-bindings.json"
_TEXTURE_MANIFEST_BYTES = 2 * 1024 * 1024
_TEXTURE_MANIFEST_MATERIALS = 8192
_TEXTURE_MANIFEST_UNIQUE_FILES = 4096
_TEXTURE_TYPES = frozenset((".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".webp",
                            ".psd", ".dds", ".hdr", ".exr"))
_TEXTURE_SLOTS = (
    ("base_color", ("base_color_texture",)),
    ("roughness", ("roughness_texture",)),
    ("specular", ("specular_texture", "specular_tint_texture")),
    ("metallic", ("metallic_texture",)),
    ("normal", ("normalmap_texture",)),
    ("opacity", ("alpha_texture",)),
    ("emission", ("emission_color_texture", "emission_strength_texture")),
)
_PHASES = {
    "starting": "启动 Blender",
    "reading": "读取和解码 MAX 场景",
    "building": "构建网格和材质",
    "exporting": "写出 FBX 和贴图",
    "exported": "检查 FBX 输出",
}

_IMPORTER = (f"TEXTURE_SLOTS = {_TEXTURE_SLOTS!r}\n"
           f"TEXTURE_TYPES = {tuple(sorted(_TEXTURE_TYPES))!r}\n"
           f"TEXTURE_MANIFEST_FILE = {_TEXTURE_MANIFEST_FILE!r}\n"
           f"TEXTURE_MANIFEST_BYTES = {_TEXTURE_MANIFEST_BYTES}\n"
           f"TEXTURE_MANIFEST_MATERIALS = {_TEXTURE_MANIFEST_MATERIALS}\n") + """
import importlib.util
import json
import math
import os
import stat
import struct
import sys
from pathlib import Path, PureWindowsPath

import bpy


phase_file = None


def mark_phase(phase):
    if phase_file is None:
        return
    temporary = phase_file.with_suffix(".tmp")
    temporary.write_text(phase, encoding="ascii")
    os.replace(temporary, phase_file)
    print("NEXUS_MAX_PHASE " + phase, flush=True)


def scene_meters_per_unit(reader):
    # The Scene object has a stable class identifier across MAX versions, while
    # its position in the file's class table varies. Its units chunk stores the
    # Autodesk UNITS_* enum and the user-defined system unit multiplier.
    roots = reader.SCENE_LIST
    if not roots:
        return None
    scenes = [entry for entry in roots[0].children
              if reader.get_guid(entry) == 0x2222 and reader.get_super_id(entry) == 0x100]
    if len(scenes) != 1:
        return None
    units = [entry.data for entry in scenes[0].children if entry.types == 0x8520]
    if len(units) != 1 or not isinstance(units[0], bytes) or len(units[0]) != 8:
        return None
    unit_type, multiplier = struct.unpack("<If", units[0])
    meters = (0.0254, 0.3048, 1609.344, 0.001, 0.01, 1.0, 1000.0)
    if unit_type >= len(meters) or not math.isfinite(multiplier) or multiplier <= 0:
        return None
    return meters[unit_type] * multiplier


def file_asset_metadata(data):
    # FileAssetMetaData3 contains consecutive GUIDs followed by the asset type,
    # original path and last saved path. Each UTF-16LE string has a uint32
    # code-unit count which excludes its two-byte terminator.
    if not data or len(data) > 32 * 1024 * 1024:
        return None
    paths = {}
    aliases = {}
    bitmap_guids = {}
    offset = 0
    try:
        while offset < len(data):
            first, short, key = struct.unpack_from("<IH6xI", data, offset)
            guid = data[offset:offset + 16]
            offset += 16
            fields = []
            for _ in range(3):
                count, = struct.unpack_from("<I", data, offset)
                start, end = offset + 4, offset + 4 + count * 2
                if count > 32767 or data[end:end + 2] != bytes(2):
                    return None
                field = data[start:end].decode("utf-16-le")
                if any(ord(character) < 32 for character in field):
                    return None
                fields.append(field)
                offset = end + 2
            asset_type, original, saved = fields
            if not asset_type or not asset_type.isascii():
                return None
            path = saved or original
            bitmap = path if asset_type == "Bitmap" and path else None
            if guid in bitmap_guids and bitmap_guids[guid] != bitmap:
                bitmap = None
            bitmap_guids[guid] = bitmap
            if path:
                paths[key] = path if key not in paths or paths[key] == path else None
                # Older bitmap chunks also use the GUID's first integer or
                # first short as their reference. Reject ambiguous aliases.
                for alias in (first, short):
                    aliases[alias] = path if alias not in aliases or aliases[alias] == path else None
    except (struct.error, UnicodeError):
        return None
    return paths, aliases, bitmap_guids


def bitmap_asset_path(reader, bitmap, bitmap_guids):
    if reader.get_guid(bitmap) not in (0x65484244ABBA5784, 0x02C1017D6769144B):  # CoronaBitmap, VRayBitmap.
        return None
    references = reader.get_references(bitmap)
    block = references[0] if references else None
    if reader.get_guid(block) != 0x82:  # ParamBlock2.
        return None
    asset = block.get_first(0x000F)
    identifier = asset.get_first(0x0002) if asset else None
    guid = identifier.data if identifier else None
    if not isinstance(guid, bytes) or len(guid) != 16:
        return None
    return bitmap_guids.get(guid)


def disabled_corona_channels(block):
    flags = {0xA3: "glossmap", 0xA7: "normalmap"}
    disabled = set()
    for child in getattr(block, "children", ()):
        data = child.data
        if child.types != 0x100E or not isinstance(data, bytes) or len(data) != 19:
            continue
        identifier, kind = struct.unpack_from("<HI", data)
        if kind == 4 and identifier in flags and data[15:] == bytes(4):
            disabled.add(flags[identifier])
    return disabled


class ProjectImages:
    def __init__(self, directory, load_image):
        self.directory = directory
        self.load_image = load_image
        self.files = None
        self.images = {}
        self.loaded_paths = {}

    def _index(self):
        files = {}
        pending = [(self.directory, 0)]
        remaining = 25000
        complete = True
        while pending and remaining:
            directory, depth = pending.pop()
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if not remaining:
                            break
                        remaining -= 1
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                attributes = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
                                if attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                                    continue
                                if depth == 8:
                                    complete = False
                                else:
                                    pending.append((entry.path, depth + 1))
                            elif entry.is_file(follow_symlinks=False):
                                key = entry.name.casefold()
                                # A direct sibling is already searched by the
                                # original loader before recursive candidates.
                                if key not in files:
                                    files[key] = (entry.path, depth == 0)
                                elif depth == 0 or not files[key][1]:
                                    files[key] = (None, depth == 0)
                        except OSError:
                            complete = False
            except OSError:
                complete = False
        if not complete or not remaining:
            return {key: value for key, value in files.items() if value[1]}
        return files

    def load(self, filename, *_args, **_kwargs):
        key = PureWindowsPath(filename).name.casefold()
        if key not in self.images:
            if self.files is None:
                self.files = self._index()
            path, _ = self.files.get(key, (None, False))
            self.images[key] = self.load_image(path, place_holder=False, recursive=False, check_existing=True) if path else None
            if self.images[key] is not None:
                self.loaded_paths[os.path.normcase(os.path.normpath(path))] = path
        return self.images[key]

    def path_for(self, image):
        if image is None or image.source != "FILE" or not image.filepath:
            return None
        # Blender duplicates datablocks for some linear/color uses. A copy can
        # retain the same original filename, so match the approved path itself.
        path = self.loaded_paths.get(os.path.normcase(os.path.normpath(image.filepath)))
        return path if path and Path(path).suffix.casefold() in TEXTURE_TYPES else None

    def report(self, materials):
        linked = sum(link.from_node.type == "TEX_IMAGE" and link.from_node.image is not None
                     for material in materials if material.use_nodes
                     for link in material.node_tree.links)
        missing = sum(image is None for image in self.images.values())
        print(f"NEXUS_MAX_TEXTURES {linked} {missing}", flush=True)


def material_texture_bindings(objects, images, wrap_material):
    materials = {slot.material.name: slot.material for obj in objects
                 for slot in obj.material_slots if slot.material and slot.material.use_nodes}
    if len(materials) > TEXTURE_MANIFEST_MATERIALS:
        return {}
    result = {}
    for name, material in materials.items():
        try:
            shader = wrap_material(material, is_readonly=True)
        except (AttributeError, RuntimeError, TypeError, ValueError):
            continue
        channels = {}
        for key, attributes in TEXTURE_SLOTS:
            for attribute in attributes:
                try:
                    texture = getattr(shader, attribute, None)
                    path = images.path_for(texture.image) if texture is not None else None
                except (AttributeError, RuntimeError, TypeError, ValueError):
                    continue
                if path:
                    channels[key] = path
                    break
        if channels:
            result[name] = channels
    return result


def save_texture_bindings(output, source, objects, images, wrap_material):
    try:
        materials = material_texture_bindings(objects, images, wrap_material)
        if not materials:
            return
        data = json.dumps({"version": 1, "source": str(source), "materials": materials},
                          ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > TEXTURE_MANIFEST_BYTES:
            return
        manifest = output.with_name(TEXTURE_MANIFEST_FILE)
        temporary = manifest.with_suffix(".tmp")
        with temporary.open("xb") as handle:
            handle.write(data)
        os.replace(temporary, manifest)
        print(f"NEXUS_MAX_TEXTURE_BINDINGS {len(materials)} {sum(map(len, materials.values()))}", flush=True)
    except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
        print("NEXUS_MAX_TEXTURE_BINDINGS unavailable", flush=True)


def preserve_legacy_corona_images(reader, material, references):
    if not references or references[0] is None:
        return
    block = references[0]
    if len(block.children) > 0x3F:
        return
    # Legacy Corona blocks can omit newer scalar fields, so the pinned reader
    # exits before committing its bitmap paths. Keep its known bitmap slots.
    try:
        textures = reader.get_reference(block)
    except (AttributeError, IndexError, TypeError, struct.error):
        return
    for channel, slot in (("bitmap", 0), ("shinmap", 1), ("glossmap", 2), ("transmap", 5)):
        if material.get(channel) is not None:
            continue
        try:
            path = reader.get_bitmap(textures.get(slot))
            if isinstance(path, str) and path:
                material.set(channel, PureWindowsPath(path).name)
        except (AttributeError, IndexError, TypeError, struct.error):
            continue


def configure_reader(module):
    global reader, make_scene, set_metadata, get_metadata, get_bitmap, build_corona
    reader = module
    make_scene = reader.make_scene
    set_metadata = reader.ByteArrayChunk.set_meta_data
    get_metadata = reader.get_metadata
    get_bitmap = reader.get_bitmap
    build_corona = reader.get_corona_material
    reader.make_scene = build_scene
    reader.ByteArrayChunk.set_meta_data = set_asset_metadata
    reader.get_metadata = find_asset_path
    reader.get_bitmap = find_bitmap_path
    reader.get_corona_material = build_corona_material
    reader.nexus_source_materials = {}


def set_asset_metadata(chunk, data):
    parsed = file_asset_metadata(data)
    if parsed is None:
        set_metadata(chunk, data)
    else:
        chunk.nexus_paths = parsed


def find_asset_path(index):
    paths = getattr(reader.META_DATA[0], "nexus_paths", None) if reader.META_DATA else None
    if paths is None:
        return get_metadata(index)
    primary, aliases, _bitmap_guids = paths
    return primary.get(index, aliases.get(index))


def find_bitmap_path(bitmap):
    if bitmap is None:
        return None
    paths = getattr(reader.META_DATA[0], "nexus_paths", None) if reader.META_DATA else None
    bitmap_guids = paths[2] if paths is not None else {}
    # These slots are the color inputs. Mask, bump and control inputs must
    # never become the diffuse map of the material.
    vray_dirt = 0x090D5EA42F567899
    inputs = {
        0x230: (1, 2),  # Mix.
        0x2D0: (1,),  # Color Correction.
        0x6EC3730C: (4, 5),  # Falloff.
        vray_dirt: (5, 6),
    }
    pending = [bitmap]
    seen = set()
    found = {}
    while pending:
        node = pending.pop()
        key = id(node)
        if key in seen:
            continue
        if len(seen) >= 32:
            return None
        seen.add(key)
        try:
            kind = reader.get_guid(node)
            slots = inputs.get(kind)
            if slots is not None:
                if kind == vray_dirt:
                    node = reference_slots(node, 1)[0]
                    if reader.get_guid(node) != 0x82:
                        continue
                references = reference_slots(node, slots[-1] + 1)
                pending.extend(references[slot] for slot in slots if references[slot] is not None)
                continue
            path = bitmap_asset_path(reader, node, bitmap_guids) or get_bitmap(node)
        except (AttributeError, IndexError, KeyError, TypeError, ValueError, struct.error):
            continue
        if isinstance(path, str) and path:
            found[str(PureWindowsPath(path)).casefold()] = path
            if len(found) > 1:
                return None
    return next(iter(found.values()), None)


def build_corona_material(references):
    material = build_corona(references)
    preserve_legacy_corona_images(reader, material, references)
    if references:
        for channel in disabled_corona_channels(references[0]):
            material.set(channel, None)
    return material


def reference_slots(chunk, count):
    keyed = reader.get_reference(chunk)
    values = reader.get_references(chunk) if not keyed else ()
    return [keyed.get(i) if keyed else values[i] if i < len(values) else None for i in range(count)]


def static_float(controller):
    if controller is None:
        return None
    container = controller.get_first(0x7127)
    value = (container or controller).get_first(0x2501)
    if value is not None and value.data:
        number = value.data[0]
        if isinstance(number, float) and math.isfinite(number):
            return number
    return None


def controller_xyz(controller):
    values = [static_float(ref) for ref in reference_slots(controller, 3)]
    if all(value is not None for value in values):
        return values
    values = reader.get_point_3d(controller)
    if len(values) >= 3 and all(math.isfinite(value) for value in values[:3]):
        return values[:3]
    raise ValueError("Unreadable MAX XYZ controller")


def static_position(controller):
    kind = reader.get_guid(controller)
    if kind == reader.MATRIX_POS:
        return reader.mathutils.Vector(controller_xyz(controller))
    if kind in (0x2008, 0x442312, 0x4B4B1002):
        return reader.get_position(controller)
    raise ValueError("Unsupported MAX position controller")


def static_world_matrix(node, cache, visiting):
    if node is None:
        return reader.mathutils.Matrix.Identity(4)
    key = id(node)
    if key in cache:
        return cache[key]
    if key in visiting:
        raise ValueError("Cyclic MAX scene transform")
    visiting.add(key)
    try:
        parent = reader.get_node_parent(node)
        parent_world = static_world_matrix(parent, cache, visiting)
        controller, _, _, _ = reader.get_matrix_mesh_material(node)
        kind = reader.get_guid(controller)
        if kind == 0x2006:  # 3ds Max Look At controller.
            target, position, roll, scale = reference_slots(controller, 4)
            if target is None or position is None:
                raise ValueError("Incomplete MAX Look At controller")
            origin = parent_world @ static_position(position)
            direction = static_world_matrix(target, cache, visiting).translation - origin
            if direction.length_squared <= 1.0e-12:
                raise ValueError("MAX Look At target coincides with the object")
            rotation = direction.to_track_quat("-Z", "Y")
            angle = static_float(roll)
            if angle:
                rotation @= reader.mathutils.Quaternion((0, 0, 1), angle)
            local_scale = reader.get_scale(scale)
            world = reader.mathutils.Matrix.LocRotScale(origin, rotation, local_scale)
        elif kind == 0x2005:
            position, rotation, scale = reference_slots(controller, 3)
            if reader.get_guid(rotation) == 0x2012:
                orientation = reader.mathutils.Euler(controller_xyz(rotation)).to_quaternion()
            else:
                orientation = reader.get_rotation(rotation)
            local = reader.mathutils.Matrix.LocRotScale(
                static_position(position), orientation, reader.get_scale(scale))
            world = parent_world @ local
        elif kind == 0x9154:
            world = parent_world @ reader.create_matrix(controller)
        elif controller is None and parent is None:
            world = parent_world
        else:
            raise ValueError("Unsupported MAX transform controller")
        cache[key] = world
        return world
    finally:
        visiting.remove(key)


def parameter_block(source):
    return reference_slots(source, 1)[0]


def legacy_parameters(source, kind):
    block = parameter_block(source)
    if reader.get_guid(block) != 8:
        return {}
    params = {}
    for slot in block.children:
        if slot.types != 0x0002:
            continue
        index = slot.get_first(0x0003)
        value = slot.get_first(kind)
        if index and value and isinstance(index.data, bytes) and len(index.data) == 4:
            params[struct.unpack("<I", index.data)[0]] = value.data
    return params


def corona_parameters(source):
    block = parameter_block(source)
    if reader.get_guid(block) != 0x82:
        return {}
    return {struct.unpack_from("<H", child.data)[0]: child.data[15:] for child in block.children
            if child.types == 0x100E and isinstance(child.data, bytes) and len(child.data) in (19, 27)}


def numeric_parameter(value, shape):
    if isinstance(value, bytes) and len(value) == struct.calcsize(shape):
        numbers = struct.unpack(shape, value)
    elif isinstance(value, tuple):
        numbers = value
    else:
        return ()
    return numbers if all(math.isfinite(number) for number in numbers) else ()


def configure_max_camera(data, source):
    kind = reader.get_guid(source)
    if kind in (0x1001, 0x1002):
        angle = numeric_parameter(legacy_parameters(source, 0x0100).get(0), "<f")
        if angle and 0.01 < angle[0] < math.pi - 0.01:
            data.sensor_fit = "HORIZONTAL"
            data.angle_x = angle[0]
            return False
        return True
    if kind == 0x654834CCA5843284:  # Corona Camera.
        fields = corona_parameters(source)
        angle, focal, sensor = (numeric_parameter(fields.get(key), "<f") for key in (11, 12, 13))
        if angle and focal and sensor and 1 <= focal[0] <= 10000 and 1 <= sensor[0] <= 200:
            if math.isclose(angle[0], 2 * math.atan(sensor[0] / (2 * focal[0])), rel_tol=1e-4):
                data.sensor_fit = "HORIZONTAL"
                data.sensor_width, data.lens = sensor[0], focal[0]
                return False
        return True
    raise ValueError("Unsupported MAX camera class")


def set_light_color(data, value):
    rgb = numeric_parameter(value, "<3f")
    if len(rgb) == 3 and all(0.0 <= channel <= 1.0 for channel in rgb):
        data.color = rgb


MAX_LIGHT_TYPES = {
    0x1011: "POINT", 0x1012: "SPOT", 0x1013: "SUN", 0x1014: "SPOT", 0x1015: "SUN",
    0x09CF576F7C3A3C80: "SUN", 0x294C5879423045E5: "POINT",  # Corona Sun and Corona Light.
}


def configure_max_light(data, source):
    kind = reader.get_guid(source)
    if kind in (0x1011, 0x1012, 0x1013, 0x1014, 0x1015):
        set_light_color(data, legacy_parameters(source, 0x0102).get(0))
        scalars = legacy_parameters(source, 0x0100)
        intensity = numeric_parameter(scalars.get(1), "<f")
        if intensity:
            data.energy = max(0.0, intensity[0])
        if data.type == "SPOT":
            inner = numeric_parameter(scalars.get(4), "<f")
            outer = numeric_parameter(scalars.get(5), "<f")
            if inner and outer and 0 <= inner[0] <= outer[0] <= 180 and outer[0] > 0:
                data.spot_size = math.radians(outer[0])
                data.spot_blend = 1 - inner[0] / outer[0]
        return not intensity, None
    if kind in (0x09CF576F7C3A3C80, 0x294C5879423045E5):  # Corona Sun and Corona Light.
        sun = kind == 0x09CF576F7C3A3C80
        fields = corona_parameters(source)
        def read(key, encoding="<f"):
            values = numeric_parameter(fields.get(key), encoding)
            return values[0] if len(values) == 1 else None

        color = numeric_parameter(fields.get(0x6C if sun else 0x82), "<3f")
        metadata = {"source": "corona_sun" if sun else "corona_light"}
        if len(color) == 3 and all(0.0 <= channel <= 1.0 for channel in color):
            data.color = color
            metadata["color"] = color
        enabled = read(0x64 if sun else 0x78, "<i") != 0
        intensity = read(0x65 if sun else 0x83)
        metadata.update(enabled=enabled, intensity=intensity)
        if sun:
            metadata["sun_size"] = read(0x68)
        else:
            shape = read(0x79, "<i")
            metadata.update(shape={0: "sphere", 1: "rectangle", 2: "disc", 3: "cylinder"}.get(shape),
                            width=read(0xA0), height=read(0xA1), units=read(0x88, "<i"))
            if shape in (0, 2, 3) and metadata["width"] is not None:
                metadata["width"] *= 2
            if read(0x84, "<i") == 1:
                metadata["kelvin"] = read(0x85)
        if not enabled or intensity == 0.0:
            data.energy = 0.0
        elif sun and intensity is not None:
            data.energy = max(0.0, intensity)
        else:
            # Corona surface-light units and shape do not map to a standard FBX point light.
            data.energy = 1.0
        return True, metadata
    raise ValueError("Unsupported MAX light class")


def render_object_source(chunk):
    visited = set()
    while reader.get_guid(chunk) in (0x2032, 0x2033):
        key = id(chunk)
        if key in visited:
            return None
        visited.add(key)
        references = reader.get_references(chunk)
        chunk = references[-1] if references else None
    return chunk


scene_object_counts = [0, 0, 0, 0]
max_light_settings = {}


def build_render_objects(context, collection, scene, mscale, previous_objects):
    matrices = {}
    for node in scene.children:
        if reader.get_guid(node) != 1 or reader.get_super_id(node) != 1:
            continue
        _, original_source, _, _ = reader.get_matrix_mesh_material(node)
        source = render_object_source(original_source)
        kind = reader.get_super_id(source)
        if kind not in (0x20, 0x30):
            continue
        is_camera = kind == 0x20
        offset = 0 if is_camera else 2
        namespace = bpy.data.cameras if is_camera else bpy.data.lights
        data = None
        obj = None
        name = reader.get_node_name(node)
        try:
            source_world = static_world_matrix(node, matrices, set())
            world = mscale @ source_world
            if not all(math.isfinite(value) for row in world for value in row):
                raise ValueError("Invalid MAX scene object transform")
            data = namespace.new(name) if is_camera else namespace.new(name, MAX_LIGHT_TYPES[reader.get_guid(source)])
            if is_camera:
                approximate, metadata = configure_max_camera(data, source), None
            else:
                approximate, metadata = configure_max_light(data, source)
            obj = bpy.data.objects.new(name, data)
            collection.objects.link(obj)
            source_parent = reader.get_node_parent(node)
            if source_parent is not None:
                parent = collection.objects.get(reader.get_node_name(source_parent))
                if parent is not None and parent.as_pointer() not in previous_objects:
                    obj.parent = parent
            obj.matrix_world = world
            if metadata is not None:
                if metadata["source"] == "corona_light":
                    # Keep the source node scale separate from the FBX unit conversion.
                    axes = [axis.length for axis in source_world.to_3x3().col]
                    if all(math.isfinite(scale) and scale > 0 for scale in axes):
                        metadata["source_scale"] = axes
                max_light_settings[obj.name] = metadata
            if is_camera and context.scene.camera is None:
                context.scene.camera = obj
            scene_object_counts[offset] += int(approximate or (is_camera and source is not original_source))
        except (AttributeError, IndexError, KeyError, RuntimeError, TypeError, ValueError, struct.error) as error:
            if obj is not None:
                bpy.data.objects.remove(obj, do_unlink=True)
            if data is not None:
                namespace.remove(data)
            print(f"NEXUS_MAX_SCENE_OBJECT_SKIPPED {name!r}: {error}", flush=True)
            scene_object_counts[offset + 1] += 1


def source_material_levels():
    levels = {}
    if not reader.SCENE_LIST:
        return levels
    for source in reader.SCENE_LIST[0].children:
        material = reader.nexus_source_materials.get(id(source))
        if material is None or reader.get_guid(source) != 0x448931DD70BE6506:  # Corona Legacy.
            continue
        fields = corona_parameters(source)
        values = {}
        for identifier, key in ((0x79, "diffuse_strength"), (0x7A, "specular_strength"), (0xB6, "ior")):
            value = numeric_parameter(fields.get(identifier), "<f")
            if len(value) == 1 and value[0] >= 0:
                values[key] = value[0]
        gloss = numeric_parameter(fields.get(0xB4), "<f")
        if len(gloss) == 1 and 0 <= gloss[0] <= 1:
            values["roughness"] = 1 - gloss[0]
        block = parameter_block(source)
        normal = None
        if fields and "normalmap" not in disabled_corona_channels(block):
            normal = reader.get_reference(block).get(6)
        if reader.get_guid(normal) == 0xCC18437C2870CEAA:  # CoronaNormal.
            strength = numeric_parameter(corona_parameters(normal).get(0x1F5), "<f")
            texture = reference_slots(parameter_block(normal), 1)[0]
            try:
                bitmap = reader.get_bitmap(texture)
            except (AttributeError, IndexError, KeyError, TypeError, ValueError, struct.error):
                bitmap = None
            if isinstance(bitmap, str) and bitmap and len(strength) == 1 and strength[0] >= 0:
                values.update(normal_map=PureWindowsPath(bitmap).name, normal_strength=strength[0])
        levels[material.name] = values
    return levels


def save_render_settings(output, meters_per_unit):
    materials = {}
    source_levels = source_material_levels()
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        try:
            shader = reader.PrincipledBSDFWrapper(material, is_readonly=True)
            if shader.node_principled_bsdf is None:
                continue
            values = {"specular_strength": shader.specular, "metallic": shader.metallic,
                      "roughness": shader.roughness, "ior": shader.ior}
            values = {key: float(value) for key, value in values.items() if math.isfinite(value)}
            normal = shader.normalmap_texture
            if normal is not None and normal.image is not None:
                path = normal.image.filepath.replace(chr(92), "/")
                strength = shader.normalmap_strength
                if path and math.isfinite(strength):
                    values.update(normal_strength=strength, normal_map=PureWindowsPath(path).name)
            values.update(source_levels.get(material.name, {}))
            materials[material.name] = values
        except (AttributeError, KeyError, RuntimeError, TypeError, ValueError):
            continue
    for light in max_light_settings.values():
        for key in ("width", "height"):
            if light.get(key) is not None:
                light[key] *= meters_per_unit
    if not materials and not max_light_settings:
        return
    target = output.with_name("render-settings.json")
    data = json.dumps({"materials": materials, "lights": max_light_settings}, allow_nan=False).encode("utf-8")
    if len(data) <= 8 * 1024 * 1024:
        temporary = target.with_suffix(".tmp")
        temporary.write_bytes(data)
        os.replace(temporary, target)


def build_scene(context, settings, mscale, transform, parent):
    mark_phase("building")
    collection = context.view_layer.active_layer_collection.collection
    previous_objects = {obj.as_pointer() for obj in collection.objects}
    make_scene(context, settings, mscale, transform, parent)
    build_render_objects(context, collection, parent, mscale, previous_objects)


def prepare_images(source):
    images = ProjectImages(source.parent, reader.load_image)
    reader.load_image = images.load
    return images


def has_renderable_objects(objects):
    return any(obj.type in {"CAMERA", "LIGHT"}
               or obj.type == "MESH" and len(obj.data.vertices) >= 3 and len(obj.data.polygons)
               for obj in objects)


def set_mesh_shading(meshes):
    for mesh in meshes:
        # MAX meshes without imported shading data need a geometric fallback.
        if not (mesh.has_custom_normals or mesh.attributes.get("sharp_edge") or mesh.attributes.get("sharp_face")):
            mesh.set_sharp_from_angle(angle=math.radians(60))
"""


_WORKER = _IMPORTER + """

if bpy.app.version < (4, 2, 0):
    raise RuntimeError("NEXUS_MAX_DECODE_BLENDER_VERSION")

phase_file = Path(os.environ["NEXUS_MAX_DECODE_STATUS"])
bpy.ops.wm.read_factory_settings(use_empty=True)
extension = Path(os.environ["NEXUS_MAX_DECODE_EXTENSION"])
spec = importlib.util.spec_from_file_location(
    "_nexus_pinned_io_scene_max", extension / "__init__.py",
    submodule_search_locations=[str(extension)],
)
decoder = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = decoder
spec.loader.exec_module(decoder)
decoder.register()

try:
    configure_reader(importlib.import_module(spec.name + ".import_max"))
    source = Path(os.environ["NEXUS_MAX_DECODE_SOURCE"])
    output = Path(os.environ["NEXUS_MAX_DECODE_OUTPUT"])
    images = prepare_images(source)
    mark_phase("reading")
    result = bpy.ops.import_scene.max(
        filepath=str(source), directory=str(source.parent), use_image_search=True,
    )
    if "FINISHED" not in result or not has_renderable_objects(bpy.context.scene.objects):
        raise RuntimeError("NEXUS_MAX_DECODE_NO_GEOMETRY")
    meters_per_unit = scene_meters_per_unit(reader)
    if meters_per_unit is None:
        raise RuntimeError("NEXUS_MAX_DECODE_UNKNOWN_UNITS")
    # Scale the FBX coordinate system, including translations, through the
    # exporter. Imported Blender object transforms and parenting stay intact.
    units = bpy.context.scene.unit_settings
    units.system = "METRIC"
    units.scale_length = meters_per_unit
    if not math.isclose(units.scale_length, meters_per_unit, rel_tol=1e-6):
        raise RuntimeError("NEXUS_MAX_DECODE_UNKNOWN_UNITS")
    mark_phase("exporting")
    set_mesh_shading(bpy.data.meshes)
    result = bpy.ops.export_scene.fbx(
        filepath=str(output), path_mode="COPY",
        embed_textures=True, use_selection=False,
        apply_unit_scale=True, apply_scale_options="FBX_SCALE_NONE",
    )
    if "FINISHED" not in result:
        raise RuntimeError("FBX export did not finish")
    save_texture_bindings(output, source, bpy.context.scene.objects, images, reader.PrincipledBSDFWrapper)
    images.report(bpy.data.materials)
    try:
        save_render_settings(output, meters_per_unit)
    except (OSError, ValueError, OverflowError):
        print("NEXUS_MAX_RENDER_SETTINGS unavailable", flush=True)
    print("NEXUS_MAX_SCENE_OBJECTS", *scene_object_counts, flush=True)
    mark_phase("exported")
finally:
    decoder.unregister()
"""


def _conversion_helpers():
    source = Path(__file__)
    path = source.with_name(source.name.replace("c4d_max_decode", "c4d_conversion"))
    spec = importlib.util.spec_from_file_location("_nexus_c4d_conversion_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 Nexus 场景转换组件")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_archive(host):
    archive = Path(__file__).with_name(_ARCHIVE)
    try:
        with archive.open("rb") as handle:
            package = handle.read(_ARCHIVE_SIZE + 1)
    except OSError as error:
        raise RuntimeError(f"缺少 Nexus 的 MAX 解析组件，请更新 {host} 桥接") from error
    if len(package) != _ARCHIVE_SIZE or hashlib.sha256(package).hexdigest() != _ARCHIVE_SHA256:
        raise RuntimeError(f"MAX 解析组件校验失败，请更新 {host} 桥接")
    return package


def _unpack_extension(directory, host="Cinema 4D"):
    package = _read_archive(host)
    extension = directory / "io_scene_max"
    extension.mkdir()
    with zipfile.ZipFile(io.BytesIO(package)) as source:
        for name in ("__init__.py", "import_max.py", "blender_manifest.toml"):
            (extension / name).write_bytes(source.read("io_scene_max/" + name))
    # Keep the original MAX material identity, including leaves of Multi/Sub materials.
    # The pinned importer matches Blender display names, which can collide or be truncated.
    importer = extension / "import_max.py"
    code = importer.read_text(encoding="utf-8")
    lookup = """            objMaterial = bpy.data.materials.get(matname)
            if objMaterial is None:
                objMaterial = bpy.data.materials.new(matname)
"""
    shared_lookup = """            source_key = id(mat)
            objMaterial = nexus_source_materials.get(source_key)
            if objMaterial is None:
                objMaterial = bpy.data.materials.new(matname)
                nexus_source_materials[source_key] = objMaterial
"""
    if code.count(lookup) != 1:
        raise RuntimeError(f"MAX 解析组件不兼容，请更新 {host} 桥接")
    importer.write_text(code.replace(lookup, shared_lookup, 1), encoding="utf-8")
    return extension


def check_blender_package():
    _read_archive("Blender")


def import_into_blender(path, id_inventory):
    """Apply the same pinned MAX decoder directly to Blender's current scene."""
    import bpy
    from mathutils import Matrix

    source = Path(path).resolve(strict=True)
    context = bpy.context
    if context.mode != "OBJECT":
        raise RuntimeError("请先切换至 Blender 的物体模式，再导入 MAX")
    slot = context.view_layer.objects
    camera = context.scene.camera
    selected = tuple(context.selected_objects)
    active = slot.active
    before = id_inventory()
    if context.window is not None:
        context.window.cursor_modal_set("WAIT")
    try:
        with tempfile.TemporaryDirectory(prefix="nexus-max-import-") as directory:
            extension = _unpack_extension(Path(directory), "Blender")
            spec = importlib.util.spec_from_file_location("_nexus_max_reader", extension / "import_max.py")
            reader = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(reader)
            # Evaluate the shared decoder functions without the standalone FBX worker.
            decoder = {"__name__": "_nexus_max_importer"}
            exec(compile(_IMPORTER, str(__file__), "exec"), decoder)
            decoder["configure_reader"](reader)
            decoder["prepare_images"](source)
            reader.read(context, str(source), Matrix.Identity(4),
                        {"MATERIAL", "UV", "PRIMITIVE", "EMPTY", "ARMATURE"}, True, True)
            objects = [obj for obj in slot if obj.as_pointer() not in before]
            if not decoder["has_renderable_objects"](objects):
                raise RuntimeError("此 MAX 文件没有可导入的网格、相机或灯光")
            meters = decoder["scene_meters_per_unit"](reader)
            if meters is None:
                raise RuntimeError("无法确定此 MAX 的场景单位，请从 3ds Max 导出 FBX 后再导入")
            scale = Matrix.Scale(meters / context.scene.unit_settings.scale_length, 4)
            members = set(objects)
            for obj in objects:
                if obj.parent not in members:
                    obj.matrix_world = scale @ obj.matrix_world
            meshes = [mesh for mesh in bpy.data.meshes if mesh.as_pointer() not in before]
            decoder["set_mesh_shading"](meshes)
            context.view_layer.update()
    except Exception as error:
        created = [value for pointer, value in id_inventory().items() if pointer not in before]
        if created:
            bpy.data.batch_remove(ids=created)
        for obj in context.selected_objects:
            obj.select_set(False)
        for obj in selected:
            obj.select_set(True)
        slot.active = active
        raise RuntimeError(f"MAX 导入失败：{error}") from error
    finally:
        context.scene.camera = camera
        if context.window is not None:
            context.window.cursor_modal_restore()


def _log_tail(log):
    with log.open("rb") as handle:
        handle.seek(max(0, handle.seek(0, os.SEEK_END) - _LOG_TAIL_BYTES))
        return handle.read(_LOG_TAIL_BYTES)


def texture_bindings(output, source):
    """Read original bitmap bindings produced for this direct MAX conversion."""
    try:
        with Path(output).with_name(_TEXTURE_MANIFEST_FILE).open("rb") as handle:
            raw = handle.read(_TEXTURE_MANIFEST_BYTES + 1)
        if len(raw) > _TEXTURE_MANIFEST_BYTES:
            return {}
        manifest = json.loads(raw)
        source = Path(source).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return {}
    if (not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1
            or not isinstance(manifest.get("source"), str) or source != Path(manifest["source"])):
        return {}
    materials = manifest.get("materials")
    if not isinstance(materials, dict) or len(materials) > _TEXTURE_MANIFEST_MATERIALS:
        return {}
    root = source.parent
    allowed = {key for key, _ in _TEXTURE_SLOTS}
    checked = {}
    result = {}
    for name, channels in materials.items():
        if not name or len(name) > 256 or any(ord(character) < 32 for character in name):
            continue
        if not isinstance(channels, dict) or len(channels) > len(allowed):
            continue
        approved = {}
        for key, path in channels.items():
            if key not in allowed or not isinstance(path, str) or not 0 < len(path) <= 4096 or "\0" in path:
                continue
            if path not in checked:
                if len(checked) == _TEXTURE_MANIFEST_UNIQUE_FILES:
                    return {}
                checked[path] = None
                candidate = Path(path)
                if (not candidate.is_absolute() or ".." in candidate.parts
                        or candidate.suffix.casefold() not in _TEXTURE_TYPES or not candidate.is_relative_to(root)):
                    continue
                try:
                    resolved = candidate.resolve(strict=True)
                    if resolved.is_relative_to(root) and resolved.is_file():
                        checked[path] = str(resolved)
                except (OSError, RuntimeError, ValueError):
                    continue
            if checked[path]:
                approved[key] = checked[path]
        if approved:
            result[name] = approved
    return result


def texture_warning(output):
    """Report referenced bitmap filenames the direct converter could not load."""
    try:
        matches = re.findall(rb"(?m)^NEXUS_MAX_TEXTURES (\d{1,8}) (\d{1,8})\r?$",
                             _log_tail(Path(output).with_name("converter.log")))
    except OSError:
        return ""
    if not matches:
        return ""
    linked, missing = map(int, matches[-1])
    if not missing:
        return ""
    details = f"{missing} 项引用贴图未找到或无法读取"
    return f"MAX 直接解析有 {details}" if linked else f"MAX 直接解析未找到可链接贴图（{details}）"


def render_settings(output):
    try:
        limit = 8 * 1024 * 1024
        with Path(output).with_name("render-settings.json").open("rb") as handle:
            data = handle.read(limit + 1)
        if len(data) <= limit:
            payload = json.loads(data)
            if isinstance(payload, dict):
                return {key: payload[key] for key in ("materials", "lights") if isinstance(payload.get(key), dict)}
    except (OSError, UnicodeError, ValueError):
        pass
    return {}


def scene_object_warning(output, options):
    try:
        matches = re.findall(rb"(?m)^NEXUS_MAX_SCENE_OBJECTS (\d{1,8}) (\d{1,8}) (\d{1,8}) (\d{1,8})\r?$",
                             _log_tail(Path(output).with_name("converter.log")))
    except OSError:
        return ""
    if not matches or options and not options.get("objects", True):
        return ""
    approximate_camera, skipped_camera, approximate_light, skipped_light = map(int, matches[-1])
    details = []
    if (options or {}).get("cameras", True):
        if approximate_camera:
            details.append(f"{approximate_camera} 台相机使用近似镜头设置")
        if skipped_camera:
            details.append(f"{skipped_camera} 台相机未能读取")
    if (options or {}).get("lights", True):
        if approximate_light:
            details.append(f"{approximate_light} 盏灯使用通用光源")
        if skipped_light:
            details.append(f"{skipped_light} 盏灯未能读取")
    return "MAX 直接解析：" + "、".join(details) if details else ""


def _failure(output):
    if _VERSION_MARKER in output:
        return "MAX 直接解析需要 Blender 4.2 或更新版本"
    if _GEOMETRY_MARKER in output:
        return "此 MAX 文件没有可直接解析的网格、相机或灯光，请切换到「调用源软件」"
    if _UNITS_MARKER in output:
        return "无法确定此 MAX 的场景单位，请切换到「调用源软件」以保留原始比例"
    return "MAX 直接解析未生成有效 FBX，请检查场景格式或切换到「调用源软件」"


def _last_phase(directory):
    try:
        phase = (directory / "phase").read_text(encoding="ascii")
        if phase in _PHASES:
            return phase
    except (OSError, UnicodeError):
        pass
    return "starting"


def _save_failure(directory, source, size, elapsed, budget, outcome):
    phase = _last_phase(directory)
    try:
        summary = directory / "failure.log"
        details = (f"Source: {source.name}\nSource bytes: {size}\nOutcome: {outcome}\n"
                   f"Phase: {phase}\nElapsed seconds: {elapsed:.1f}\nBudget seconds: {budget}\n\n")
        summary.write_bytes(details.encode("utf-8") + _log_tail(directory / "converter.log"))
        os.replace(summary, directory.parent / "max-decode-last-failure.log")
    except OSError:
        pass
    return phase


def convert(path, cache_root, blender_executable=None, cancel=None):
    """Return a Blender-generated FBX with the supported linked image textures embedded."""
    source = Path(path)
    if source.suffix.lower() != ".max":
        raise RuntimeError("MAX 直接解析只支持 .max 文件")
    helpers = _conversion_helpers()
    try:
        executable = helpers._find_executable(".blend", blender_executable)
    except RuntimeError as error:
        if blender_executable:
            raise
        raise RuntimeError("MAX 直接解析需要 Blender 4.2 或更新版本，请先安装 Blender") from error
    directory = None
    succeeded = False
    try:
        source = source.resolve(strict=True)
        if not source.is_file():
            raise RuntimeError("源 MAX 文件不可读取")
        size = source.stat().st_size
        budget = helpers._max_timeout(size)
        cache = Path(cache_root).expanduser().resolve()
        cache.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="max-decode-", dir=cache))
        output = directory / "scene.fbx"
        log = directory / "converter.log"
        with tempfile.TemporaryDirectory(prefix="worker-", dir=directory) as work:
            work = Path(work)
            extension = _unpack_extension(work)
            script = work / "decode_max.py"
            script.write_text(_WORKER, encoding="ascii")
            command = [*helpers._blender_command(executable),
                       "--python-exit-code", "10", "--python", str(script)]
            environment = {**os.environ, _SOURCE: str(source), _OUTPUT: str(output),
                           _EXTENSION: str(extension), _STATUS: str(directory / "phase")}
            started = time.monotonic()
            try:
                with log.open("wb") as stream:
                    returncode = helpers._run_converter(command, directory, environment, stream, cancel, timeout=budget)
            except subprocess.TimeoutExpired as error:
                phase = _save_failure(directory, source, size, time.monotonic() - started, budget, "timeout")
                raise RuntimeError(f"MAX 直接解析在{_PHASES[phase]}阶段超时（已等待 {budget // 60} 分钟）") from error
        if returncode or not helpers._is_fbx(output):
            _save_failure(directory, source, size, time.monotonic() - started, budget, f"exit {returncode}")
            raise RuntimeError(_failure(_log_tail(log)))
        succeeded = True
        return str(output)
    except OSError as error:
        raise RuntimeError("无法读取 MAX 文件、运行 Blender 或写入本地缓存") from error
    finally:
        if directory and not succeeded and directory.resolve().parent == cache:
            shutil.rmtree(directory, ignore_errors=True)
