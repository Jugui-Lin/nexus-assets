"""Inspect a Cinema 4D import on the worker without touching its live scene."""

import base64
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import time
import zipfile
from re import _parser as _regex_parser


_SCENE_TYPES = (".c4d", ".fbx", ".obj", ".abc", ".usd", ".usdc", ".usda", ".usdz",
                ".stl", ".blend", ".max")
_IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".tga", ".psd", ".dds", ".gif"}
_HDR_TYPES = {".hdr", ".exr"}
_MAP_TYPES = {
    "base_color": ("base color", "base colour", "basecolor", "basecolour", "albedo", "diffuse", "diff", "color", "colour", "col"),
    "roughness": ("roughness", "rough"),
    "metallic": ("metallic", "metalness", "metal"),
    "normal": ("normalgl", "normaldx", "normal", "norm", "nrm", "nor"),
    "ao": ("ambient occlusion", "ambientocclusion", "occlusion", "ao"),
    "displacement": ("displacement", "displace", "height", "disp"),
    "opacity": ("opacity", "transparency", "alpha", "cutout"),
    "emission": ("emission", "emissive", "emit"),
    "bump": ("bump",),
    "specular": ("specular", "spec", "reflection", "reflect"),
    "glossiness": ("glossiness", "gloss"),
    "translucency": ("translucency", "translucent", "transmission", "trans"),
}
_BAKED_SCENE_NAME = re.compile(r"mat_([a-z0-9]{1,32})_([a-z _]+)", re.I | re.ASCII)
_BAKED_SCENE_CHANNELS = {
    alias.replace(" ", "_"): channel for channel, aliases in _MAP_TYPES.items() for alias in aliases
}
_IMAGE_SUFFIXES = {"dx", "gl", "directx", "opengl"}
_MAP_LOCATIONS = {"maps", "textures", "texture", "tex", "materials", "material", "pbr"}
_IGNORE_DIRS = {"__macosx", ".git", "previews", "preview", "thumbnails"}
_SUPPORTED_KINDS = {"auto", "scene", "pbr", "hdri", "ies", "texture"}
_MAX_ENTRIES = 4096
_MAX_ARCHIVE_BYTES = 2 * 1024**3
_MAX_ARCHIVE_DIRECTORY = 8 * 1024**2
_MAX_REGEX_STEM = 255
_MAX_REGEX_CHOICES = 256
_REGEX_MATCH_SECONDS = 3
_TOKEN = re.compile(r"[^\W_]+")
_RESOLUTION_TAG = re.compile(r"(?<!\w)(\d{2,5})[x×](\d{2,5})(?!\w)", re.I)
_LOD_PART = re.compile(r"(?<![^\W_])lod[ _-]*(\d{1,2})(?![^\W_])", re.I)
_RESERVED = re.compile(r"^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$", re.I)
_BAD_SEGMENT = re.compile(r'[<>:"|?*\x00-\x1f]')
_JPEG_FRAMES = {0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf}
_DRAW_IMAGE = """
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = $bitmap = $graphics = $edge = $null
try {
    $source = [System.Drawing.Image]::FromFile($env:NEXUS_TEXTURE_INPUT, $false)
    if ($source.Width -ne [int]$env:NEXUS_TEXTURE_SOURCE_WIDTH -or
        $source.Height -ne [int]$env:NEXUS_TEXTURE_SOURCE_HEIGHT -or
        $source.PropertyIdList -contains 34675) { exit 2 }
    $width = [int]$env:NEXUS_TEXTURE_WIDTH
    $height = [int]$env:NEXUS_TEXTURE_HEIGHT
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $edge = [System.Drawing.Imaging.ImageAttributes]::new()
    $edge.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $rect = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
    $graphics.DrawImage($source, $rect, 0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel, $edge)
    $bitmap.Save($env:NEXUS_TEXTURE_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    foreach ($item in @($edge, $graphics, $bitmap, $source)) {
        if ($null -ne $item) { $item.Dispose() }
    }
}
"""


def _tokens(text):
    return tuple(_TOKEN.findall(text.casefold()))


def _lod(text):
    match = _LOD_PART.search(text)
    return int(match[1]) if match else None


def _resolution(value):
    if value is None or str(value).strip().casefold() in ("", "auto", "original"):
        return None
    match = re.fullmatch(r"(\d{1,5})(k?)", str(value).strip().casefold())
    limit = int(match[1]) * (1024 if match[2] else 1) if match else 0
    if not 128 <= limit <= 16384:
        raise ValueError("贴图分辨率请输入 128–16384，或使用 1K、2K、4K 等规格。")
    return limit


def _lod_option(value):
    if value is None or str(value).strip().casefold() in ("", "auto"):
        return None
    match = re.fullmatch(r"(?:lod[ _-]*)?(\d{1,2})", str(value).strip(), re.I)
    if not match:
        raise ValueError("LOD 请输入 0–99 的整数。")
    return int(match[1])


def _name_resolution(text):
    match = _RESOLUTION_TAG.search(text.replace("_", " "))
    if match:
        return max(int(match[1]), int(match[2]))
    for token in _tokens(text):
        if re.fullmatch(r"(?:[1-9]|1[0-6])k", token):
            return int(token[:-1]) * 1024
        if token in ("128", "256", "512", "1024", "2048", "4096", "8192", "16384"):
            return int(token)
    return None


def _family_tokens(text):
    text = _LOD_PART.sub(" ", text)
    text = _RESOLUTION_TAG.sub(" ", text.replace("_", " "))
    return tuple(token for token in _tokens(text) if not _name_resolution(token))


_REGEX_ATOMS = {_regex_parser.LITERAL, _regex_parser.NOT_LITERAL, _regex_parser.ANY,
                _regex_parser.IN, _regex_parser.CATEGORY}
_REGEX_REPEATS = {_regex_parser.MAX_REPEAT, _regex_parser.MIN_REPEAT, _regex_parser.POSSESSIVE_REPEAT}


def _regex_choices(expression, repeated=False):
    """Count backtracking alternatives under a bounded, non-recursive repeat grammar."""
    count = 1
    for operation, value in expression:
        if operation in _REGEX_ATOMS or operation is _regex_parser.AT:
            choices = 1
        elif operation is _regex_parser.SUBPATTERN and not (value[1] or value[2]):
            choices = _regex_choices(value[3], repeated)
        elif operation is _regex_parser.BRANCH:
            choices = sum(_regex_choices(branch, repeated) for branch in value[1])
        elif operation in _REGEX_REPEATS and not repeated:
            lower, upper, body = value
            if upper == _regex_parser.MAXREPEAT:
                if lower > _MAX_REGEX_STEM or len(body) != 1 or body[0][0] not in _REGEX_ATOMS:
                    raise ValueError()
                upper = _MAX_REGEX_STEM
            elif upper > 32:
                raise ValueError()
            choices = (upper - lower + 1) * _regex_choices(body, True) ** upper
        else:
            raise ValueError()
        count *= choices
        if count > _MAX_REGEX_CHOICES:
            raise ValueError()
    return count


def _compile_map_keywords(options):
    if options is None:
        options = {}
    if not isinstance(options, dict) or any(channel not in _MAP_TYPES for channel in options):
        raise ValueError("贴图通道关键词设置无效。")
    literals, patterns = [], []
    for channel, defaults in _MAP_TYPES.items():
        aliases = options.get(channel, defaults)
        if not isinstance(aliases, (list, tuple)) or len(aliases) > 16:
            raise ValueError(f"{channel} 通道最多可填写 16 个关键词。")
        for alias in aliases:
            if (not isinstance(alias, str) or not alias.strip()
                    or len(alias.encode("utf-8")) > 120 or any(ord(c) < 32 or ord(c) == 127 for c in alias)):
                raise ValueError(f"{channel} 通道的关键词必须为一行且不超过 120 字节。")
            alias = alias.strip()
            if not alias.startswith("/"):
                tokens = _tokens(alias)
                if not tokens:
                    raise ValueError(f"{channel} 通道的关键词必须包含文字、数字或有效正则表达式。")
                literals.append((channel, tokens))
                continue
            if len(alias) < 3 or not alias.endswith("/"):
                raise ValueError(f"{channel} 通道的正则表达式需要用 /…/ 包住。")
            value = alias[1:-1]
            try:
                parsed = _regex_parser.parse(value, re.I)
                if parsed.state.flags != (re.I | re.U) or parsed.getwidth()[1] == 0:
                    raise ValueError()
                _regex_choices(parsed)
            except re.error as error:
                raise ValueError(f"{channel} 通道的正则表达式无效：{alias}") from error
            except ValueError as error:
                raise ValueError(
                    f"{channel} 通道的正则表达式过于复杂或无法匹配文字：{alias}。"
                    "请使用简单分组、分支、字符类或有限重复。"
                ) from error
            patterns.append((channel, re.compile(value, re.I)))
    return literals, patterns


_DEFAULT_MAP_RULES = _compile_map_keywords(None)


def _map_info(path, rules=_DEFAULT_MAP_RULES, deadline=None):
    stem = path.stem
    # Mask LOD and dimensions for literal aliases, preserving indices into the raw stem.
    mask = lambda match: " " * (match.end() - match.start())
    candidate = _RESOLUTION_TAG.sub(mask, _LOD_PART.sub(mask, stem).replace("_", " "))
    spans = [match for match in _TOKEN.finditer(candidate) if not _name_resolution(match[0])]
    parts = tuple(match[0].casefold() for match in spans)
    best = None
    literals, patterns = rules
    for channel, alias in literals:
        for index in range(len(parts) - len(alias) + 1):
            if parts[index:index + len(alias)] == alias:
                start, end = spans[index].start(), spans[index + len(alias) - 1].end()
                rank = (end, end - start)
                if best is None or rank > best[0]:
                    best = (rank, start, channel)
    if len(stem) <= _MAX_REGEX_STEM:
        for channel, pattern in patterns:
            if deadline is not None and time.monotonic() > deadline:
                raise ValueError("贴图正则关键词匹配耗时过长，请简化表达式或选择较小的文件夹。")
            for match in pattern.finditer(stem):
                start, end = match.span()
                rank = (end, end - start)
                if start != end and (best is None or rank > best[0]):
                    best = (rank, start, channel)
    if best is None:
        return None
    (end, _), start, channel = best
    family = _family_tokens(stem[:start]) + tuple(
        token for token in _family_tokens(stem[end:]) if token not in _IMAGE_SUFFIXES)
    return channel, family


def _lod_in_path(path):
    value = _lod(path.stem)
    return _lod(path.parent.name) if value is None else value


def _resolution_in_path(path):
    return _name_resolution(path.stem) or _name_resolution(path.parent.name)


def _lod_rank(value, target):
    if target is None:
        return (0, value or 0)
    if value is None:
        return (2, 0)
    if value <= target:
        return (0, target - value)
    return (1, value - target)


def _texture_rank(path, target):
    value = _resolution_in_path(path)
    if value is None:
        return (1, 0)
    if target is None or value <= target:
        return (0, -value)
    return (2, value)


def _scan(root, max_depth=8):
    paths, stack, count = [], [(root, 0)], 0
    while stack:
        folder, depth = stack.pop()
        with os.scandir(folder) as entries:
            for entry in entries:
                count += 1
                if count > _MAX_ENTRIES:
                    raise ValueError("目录包含过多文件，请选择一个具体资产文件或资产子目录。")
                if entry.name.startswith(".") or entry.name.casefold() in _IGNORE_DIRS:
                    continue
                if entry.is_dir(follow_symlinks=False) and depth < max_depth:
                    if os.name != "nt" or not entry.stat(follow_symlinks=False).st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                        stack.append((Path(entry.path), depth + 1))
                elif entry.is_file(follow_symlinks=False):
                    paths.append(Path(entry.path))
    return sorted(paths, key=lambda path: (path.as_posix().casefold(), path.as_posix()))


def _scan_related(path):
    try:
        paths = _scan(_asset_folder(path), max_depth=3)
    except (OSError, ValueError):
        # Opening a selected file must still work when a neighboring library is offline or huge.
        return [path]
    if path not in paths:
        paths.append(path)
    return paths


def collect_baked_scene_maps(source, options, cache):
    """Index generated scene maps on the worker at their original resolution."""
    folder = Path(source).absolute().parent / "maps_baked"
    reparse_point = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    matches = {}
    try:
        info = folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse_point:
            return {}
        with os.scandir(folder) as entries:
            for count, entry in enumerate(entries, 1):
                if count > _MAX_ENTRIES:
                    return {}
                path = Path(entry.path)
                suffix = path.suffix.casefold()
                if suffix not in _IMAGE_TYPES and suffix not in _HDR_TYPES:
                    continue
                name = _BAKED_SCENE_NAME.fullmatch(path.stem)
                if not name:
                    continue
                token, alias = (part.casefold() for part in name.groups())
                channel = _BAKED_SCENE_CHANNELS.get(alias.replace(" ", "_"))
                if not channel:
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse_point:
                    continue
                key = token, channel
                matches[key] = None if key in matches else str(path)
    except OSError:
        return {}

    materials = {}
    for (token, channel), path in matches.items():
        if path is not None:
            materials.setdefault(token, {})[channel] = path
    return materials


def _cache_id(path, *options):
    info = path.stat()
    value = repr((str(path), info.st_size, info.st_mtime_ns, options)).encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def _archive_name(entry):
    original = entry.orig_filename.replace("\\", "/")
    parts = original.rstrip("/").split("/")
    if any(not part or part in (".", "..") or part.endswith((".", " "))
           or _BAD_SEGMENT.search(part) or _RESERVED.fullmatch(part.split(".", 1)[0])
           for part in parts):
        raise ValueError("ZIP 包含不安全的文件路径。")
    mode = stat.S_IFMT(entry.external_attr >> 16)
    if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.flag_bits & 1:
        raise ValueError("ZIP 中含有加密文件、链接或其他不支持的条目。")
    return parts, original.endswith("/") or mode == stat.S_IFDIR


def _check_archive_directory(stream):
    size = stream.seek(0, os.SEEK_END)
    if size > _MAX_ARCHIVE_BYTES:
        raise ValueError("ZIP 大于 2 GB，请先解压后选择单个资产。")
    offset = max(0, size - 65557)
    stream.seek(offset)
    tail = stream.read(65557)
    position = tail.rfind(b"PK\x05\x06")
    if position < 0 or position + 22 > len(tail):
        raise ValueError("无法读取 ZIP 目录。")
    _, disk, start_disk, local_count, count, length, directory_offset, comment = struct.unpack_from(
        "<4s4H2LH", tail, position)
    if position + 22 + comment != len(tail) or directory_offset + length > position + offset:
        raise ValueError("ZIP 目录结构无效。")
    if disk or start_disk or local_count != count or count > _MAX_ENTRIES or length > _MAX_ARCHIVE_DIRECTORY:
        raise ValueError("ZIP 目录过大或分卷，请先解压后选择单个资产。")
    if position + offset >= 20:
        stream.seek(position + offset - 20)
        if stream.read(4) == b"PK\x06\x07":
            raise ValueError("请先解压 ZIP64 压缩包，再选择具体资产文件。")


def _cache_complete(target, populate):
    marker = ".nexus-ready"
    if (target / marker).is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=".nexus-import-", dir=target.parent))
    try:
        populate(temp)
        (temp / marker).touch(exist_ok=False)
        try:
            temp.rename(target)
        except OSError:
            if not (target / marker).is_file():
                raise
        return target
    finally:
        if temp.exists():
            shutil.rmtree(temp)


def _extract(path, cache):
    target = cache / ("zip-" + _cache_id(path, 1))

    def populate(output):
        with path.open("rb") as stream:
            _check_archive_directory(stream)
            with zipfile.ZipFile(stream) as archive:
                entries = archive.infolist()
                if len(entries) > _MAX_ENTRIES or sum(entry.file_size for entry in entries) > _MAX_ARCHIVE_BYTES:
                    raise ValueError("ZIP 解压后超过 2 GB 或文件数量超出限制。")
                seen = set()
                for entry in entries:
                    parts, directory = _archive_name(entry)
                    identity = tuple(part.casefold() for part in parts)
                    if identity in seen:
                        raise ValueError("ZIP 中有重复的文件路径。")
                    seen.add(identity)
                    if parts[0] in ("__MACOSX", ".nexus-ready"):
                        continue
                    destination = output.joinpath(*parts)
                    if directory:
                        destination.mkdir(parents=True, exist_ok=True)
                    else:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with archive.open(entry) as source, destination.open("xb") as file:
                            shutil.copyfileobj(source, file, 256 * 1024)

    try:
        return _cache_complete(target, populate)
    except (zipfile.BadZipFile, OSError, NotImplementedError) as error:
        raise ValueError("无法解压该 ZIP，请检查压缩包完整性和本地缓存空间。") from error


def _renderer():
    filename = "sbsrender.exe" if os.name == "nt" else "sbsrender"
    candidates = [Path(folder) / filename for folder in os.get_exec_path() if Path(folder).is_absolute()]
    if os.name == "nt":
        for key in ("ProgramFiles", "ProgramFiles(x86)"):
            folder = Path(os.environ.get(key, ""))
            if folder.is_absolute():
                adobe = folder / "Adobe"
                candidates.extend(adobe / product / filename for product in
                                  ("Adobe Substance 3D Designer", "Substance Automation Toolkit"))
    return next((path for path in candidates if path.is_file()), None)


def _bake(path, cache, resolution):
    executable = _renderer()
    if executable is None:
        raise ValueError("导入 SBSAR 需要 Adobe Substance 3D 的 sbsrender。可安装包含该工具的版本，或先导出 PBR 贴图。")
    exponent = min(12, (resolution or 2048).bit_length() - 1)
    target = cache / ("sbsar-" + _cache_id(path, 1, exponent))

    def populate(output):
        command = [str(executable), "render", "--input", str(path), "--output-path", str(output),
                   "--output-name", "{outputUsages}_{outputIndex}", "--output-format", "png",
                   "--set-value", "$outputsize@" + f"{exponent},{exponent}"]
        try:
            result = subprocess.run(command, cwd=executable.parent, timeout=90,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired as error:
            raise ValueError("SBSAR 烘焙超时，请尝试更低的输出分辨率。") from error
        except OSError as error:
            raise ValueError("无法启动 Adobe sbsrender，请检查安装和授权。") from error
        if result.returncode or not any(_map_info(file) for file in output.glob("*.png")):
            raise ValueError("SBSAR 未生成可识别的 PBR 贴图，请检查 Substance 文件的输出通道。")

    return _cache_complete(target, populate)


def _prefer_scene(paths, source, target, label):
    if not paths:
        return None
    if source in paths and target is None:
        return source
    family = _family_tokens(source.stem if source else label)
    matching = [path for path in paths if _family_tokens(path.stem) == family]
    if matching:
        paths = matching
    elif len({_family_tokens(path.stem) for path in paths}) > 1:
        raise ValueError("目录中有多个不同模型，请选择具体模型文件。")
    return min(paths, key=lambda path: (_lod_rank(_lod_in_path(path), target),
                                        _SCENE_TYPES.index(path.suffix.lower())))


def _asset_folder(path):
    parent = path.parent
    while parent != parent.parent:
        if (parent.name.casefold() not in _MAP_LOCATIONS and _lod(parent.name) is None
                and _name_resolution(parent.name) is None):
            return parent
        parent = parent.parent
    return parent


def _map_groups(paths, baked=False, rules=_DEFAULT_MAP_RULES):
    groups = {}
    deadline = time.monotonic() + _REGEX_MATCH_SECONDS if rules[1] else None
    for file in paths:
        if file.suffix.lower() not in _IMAGE_TYPES | _HDR_TYPES:
            continue
        info = _map_info(file, rules, deadline)
        if info:
            channel, family = info
            key = (_asset_folder(file), () if baked else family)
            groups.setdefault(key, {}).setdefault(channel, []).append(file)
    return groups


def _prefer_maps(groups, selection, label):
    if not groups:
        return {}
    if selection is not None and selection.suffix.lower() in _IMAGE_TYPES | _HDR_TYPES:
        return next((maps for maps in groups.values()
                     if any(selection in paths for paths in maps.values())), {})
    family = _family_tokens(selection.stem if selection else label)
    exact = [maps for (_, key), maps in groups.items() if key == family]
    if len(exact) == 1:
        return exact[0]
    if len(groups) == 1:
        (folder, key), maps = next(iter(groups.items()))
        if selection is None or not key and folder == _asset_folder(selection):
            return maps
    return {}


def _jpeg_dimensions(stream):
    if stream.read(2) != b"\xff\xd8":
        return None
    while stream.tell() < 1024**2:
        prefix = stream.read(1)
        marker = stream.read(1)
        while marker == b"\xff" and stream.tell() < 1024**2:
            marker = stream.read(1)
        if prefix != b"\xff" or not marker or marker in (b"\xda", b"\xd9"):
            return None
        data = stream.read(2)
        if len(data) != 2:
            return None
        length = int.from_bytes(data, "big")
        if length < 2:
            return None
        if marker[0] in _JPEG_FRAMES:
            frame = stream.read(6)
            if length >= 8 and len(frame) == 6 and frame[0] == 8 and frame[5] in (1, 3):
                height, width = struct.unpack_from(">HH", frame, 1)
                return width, height
            return None
        stream.seek(length - 2, os.SEEK_CUR)
    return None


def _inbox_dimensions(path):
    with path.open("rb") as file:
        ext = path.suffix.lower()
        if ext == ".png":
            data = file.read(29)
            if (len(data) == 29 and data[:16] == b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"
                    and data[24] == 8 and data[25] in (0, 2, 4, 6)):
                return struct.unpack_from(">II", data, 16)
        elif ext in (".jpg", ".jpeg"):
            return _jpeg_dimensions(file)
        elif ext == ".gif":
            data = file.read(10)
            if len(data) == 10 and data[:6] in (b"GIF87a", b"GIF89a"):
                return struct.unpack_from("<HH", data, 6)
        elif ext == ".bmp":
            data = file.read(34)
            if (len(data) == 34 and data.startswith(b"BM") and int.from_bytes(data[14:18], "little") >= 40
                    and data[26:28] == b"\x01\x00" and data[28:30] in (b"\x18\x00", b"\x20\x00")
                    and data[30:34] == b"\0\0\0\0"):
                width, height = struct.unpack_from("<ii", data, 18)
                return width, abs(height)
    return None


def _inbox_downscale(path, cache, resolution, force_png=False):
    root = Path(os.environ.get("SystemRoot", ""))
    powershell = root / "System32/WindowsPowerShell/v1.0/powershell.exe"
    if os.name != "nt" or not root.is_absolute() or not powershell.is_file():
        return None
    dimensions = _inbox_dimensions(path)
    if dimensions is None:
        return None
    width, height = dimensions
    longest = max(dimensions)
    if min(dimensions) <= 0 or longest > 16384 or width * height > 64 * 1024**2:
        return None
    target = min(resolution, longest) if resolution is not None else longest
    if longest <= target and not force_png:
        return path
    destination = cache / ("texture-" + _cache_id(path, "gdiplus-1", target))

    def populate(output):
        image = output / "texture.png"
        environment = os.environ.copy()
        environment.update(NEXUS_TEXTURE_INPUT=str(path), NEXUS_TEXTURE_OUTPUT=str(image),
                           NEXUS_TEXTURE_SOURCE_WIDTH=str(width), NEXUS_TEXTURE_SOURCE_HEIGHT=str(height),
                           NEXUS_TEXTURE_WIDTH=str(max(1, round(width * target / longest))),
                           NEXUS_TEXTURE_HEIGHT=str(max(1, round(height * target / longest))))
        encoded = base64.b64encode(_DRAW_IMAGE.encode("utf-16-le")).decode("ascii")
        result = subprocess.run(
            [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            env=environment, cwd=powershell.parent, timeout=30, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode or _inbox_dimensions(image) != (
                int(environment["NEXUS_TEXTURE_WIDTH"]), int(environment["NEXUS_TEXTURE_HEIGHT"])):
            raise ValueError("Windows 未生成有效的缩小贴图。")

    return _cache_complete(destination, populate) / "texture.png"


def _downscale(path, cache, resolution, warnings):
    ext = path.suffix.lower()
    gif = ext == ".gif"
    if resolution is None and not gif:
        return path
    if ext not in {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"}:
        if (_resolution_in_path(path) or 0) > resolution:
            warnings.add("部分贴图的文件格式需保留，已引用原始文件。")
        return path
    try:
        from PIL import Image
    except ImportError:
        try:
            resized = _inbox_downscale(path, cache, resolution, force_png=gif)
            if resized is not None:
                if gif:
                    warnings.add("GIF 已使用首帧转换为 PNG 贴图。")
                return resized
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            if gif:
                raise ValueError("无法将此 GIF 的首帧转换为 PNG 贴图。") from error
            warnings.add("部分贴图无法生成缩小副本，已引用原始文件。")
            return path
        if gif:
            raise ValueError("无法读取此 GIF，或系统缺少 GIF 解码器。")
        if (_resolution_in_path(path) or 0) > resolution:
            warnings.add("找不到可用的缩小贴图，已引用原始文件。")
        return path
    try:
        with Image.open(path) as image:
            longest = max(image.size)
            target = min(resolution, longest) if resolution is not None else longest
            if longest <= target and not gif:
                return path
            if longest > 16384 or image.width * image.height > 64 * 1024**2:
                if gif:
                    raise ValueError("GIF 首帧尺寸超过贴图转换范围。")
                warnings.add("部分贴图超过缩小处理尺寸，已引用原始文件。")
                return path
            # Keep data formats that Pillow cannot round-trip safely as original files.
            if not gif and (image.mode not in ("RGB", "RGBA", "L") or getattr(image, "n_frames", 1) > 1):
                warnings.add("部分贴图的像素格式需保留，已引用原始文件。")
                return path
            if ext == ".png":
                with path.open("rb") as file:
                    if file.read(25)[24:25] != b"\x08":
                        warnings.add("高位深贴图已保留原始文件。")
                        return path
            destination = cache / ("texture-" + _cache_id(path, 1, target))

            def populate(output):
                dimensions = tuple(max(1, round(edge * target / longest)) for edge in image.size)
                method = getattr(Image, "Resampling", Image).LANCZOS
                pixels = image.convert("RGBA") if gif else image
                result = pixels.resize(dimensions, method)
                options = {"icc_profile": image.info["icc_profile"]} if image.info.get("icc_profile") else {}
                result.save(output / "texture.png", **options)

            result = _cache_complete(destination, populate) / "texture.png"
            if gif:
                warnings.add("GIF 已使用首帧转换为 PNG 贴图。")
            return result
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        if gif:
            raise ValueError("无法将此 GIF 的首帧转换为 PNG 贴图。") from error
        warnings.add("部分贴图无法生成缩小副本，已引用原始文件。")
        return path


def _exact_material_maps(path, maps, name):
    if (path.suffix.lower() not in _IMAGE_TYPES | _HDR_TYPES
            or not isinstance(name, str) or not name.strip() or len(name) > 255
            or not isinstance(maps, dict) or not maps or len(maps) > len(_MAP_TYPES)):
        raise ValueError("材质套图的名称或通道无效。")
    sources = set()
    resolved = {}
    for channel, variants in maps.items():
        if channel not in _MAP_TYPES or not isinstance(variants, list) or not variants or len(variants) > 48:
            raise ValueError("材质套图的通道或贴图数量无效。")
        resolved[channel] = []
        for value in variants:
            if not isinstance(value, str):
                raise ValueError("材质套图包含无法识别的贴图路径。")
            source = Path(value)
            if not source.is_absolute() or source.is_symlink():
                raise ValueError("材质套图需要可访问的原始文件。")
            source = source.resolve(strict=True)
            if (source.parent != path.parent or source in sources or not source.is_file()
                    or source.suffix.lower() not in _IMAGE_TYPES | _HDR_TYPES or len(sources) >= 48):
                raise ValueError("材质套图中的贴图需要来自同一目录，并且每个文件只对应一个通道。")
            sources.add(source)
            resolved[channel].append(source)
    if path not in sources:
        raise ValueError("材质套图缺少用于定位的贴图。")
    return resolved


def prepare(c4d, path, options, cache_root):
    """Return a resolved import plan with permanent operative file paths."""
    options = options or {}
    requested = options.get("kind") or "auto"
    if not isinstance(requested, str) or requested not in _SUPPORTED_KINDS:
        raise ValueError("未知的 Cinema 4D 资产导入类型。")
    resolution = _resolution(options.get("texture_resolution"))
    target_lod = _lod_option(options.get("lod"))
    exact_set = "pbr_maps" in options
    if exact_set and requested != "pbr":
        raise ValueError("材质套图需要 PBR 导入模式。")
    rules = None if exact_set else _compile_map_keywords(options.get("map_keywords"))
    path = Path(path).resolve()
    cache = Path(cache_root).resolve()
    if not path.is_file() and not path.is_dir():
        raise ValueError("资产路径不可用，请检查磁盘或网盘是否已挂载。")
    name = path.name if path.is_dir() else path.stem
    extension = path.suffix.lower()
    file = path if path.is_file() else None
    baked = False
    if exact_set:
        name = options.get("pbr_name")
        maps = _exact_material_maps(path, options["pbr_maps"], name)
        paths = []
    elif file is None:
        paths = _scan(path)
    elif extension == ".zip":
        paths, file = _scan(_extract(path, cache)), None
    elif extension == ".sbsar" and requested in ("auto", "pbr"):
        paths, file, baked = _scan(_bake(path, cache, resolution)), None, True
    elif extension in _SCENE_TYPES or extension in _IMAGE_TYPES and requested in ("auto", "pbr"):
        paths = _scan_related(path)
    else:
        paths = [path]

    scene_paths = [item for item in paths if item.suffix.lower() in _SCENE_TYPES]
    if file is not None and extension in _SCENE_TYPES:
        # A selected file can pick a sibling LOD, but cannot switch model families.
        family = _family_tokens(file.stem)
        scene_paths = [item for item in scene_paths if _family_tokens(item.stem) == family]
    scene = None
    if requested == "scene" or requested == "auto" and (file is None or extension in _SCENE_TYPES):
        scene = _prefer_scene(scene_paths, file, target_lod, name)

    groups = {}
    if not exact_set:
        groups = _map_groups(paths, baked, rules)
        maps = _prefer_maps(groups, scene or file, name)
    warnings = set()
    if scene is not None:
        kind, selected = "scene", scene
    elif requested == "pbr" or requested == "auto" and (file is None and maps or file is not None and len(maps) > 1):
        if not maps:
            if groups:
                raise ValueError("目录中有多个 PBR 材质，请选择某一套材质中的贴图。")
            raise ValueError("未找到可识别的 PBR 贴图，例如 Albedo、Roughness 或 Normal。")
        kind, selected = "pbr", file
    else:
        candidates = {"hdri": _HDR_TYPES, "ies": {".ies"}, "texture": _IMAGE_TYPES}
        permitted = set().union(*candidates.values()) if requested == "auto" else candidates.get(requested, set())
        available = [item for item in paths if item.suffix.lower() in permitted and (file is None or item == file)]
        if not available:
            if requested == "auto" and groups:
                raise ValueError("目录中有多个 PBR 材质，请选择某一套材质中的贴图。")
            raise ValueError("没有找到此导入类型支持的资产文件。")
        if requested == "auto" and file is None and len(groups) > 1:
            raise ValueError("目录中有多个 PBR 材质，请选择某一套材质中的贴图。")
        selected = min(available, key=lambda item: _texture_rank(item, resolution))
        kind = next(kind for kind, suffixes in candidates.items() if selected.suffix.lower() in suffixes)

    actual_lod = _lod_in_path(scene) if scene else None
    if target_lod is not None and scene is not None and actual_lod != target_lod:
        warnings.add(f"未找到 LOD{target_lod}，已选择 " +
                     (f"LOD{actual_lod}。" if actual_lod is not None else "原始模型。"))
    resolved = {}
    if kind in ("pbr", "scene"):
        for channel, variants in maps.items():
            def rank(item):
                lod = _lod_in_path(item)
                mesh_match = 0 if lod == actual_lod else 1 if lod is None else 2
                is_directx = bool({"dx", "directx", "normaldx"} & set(_tokens(item.stem)))
                return mesh_match, _texture_rank(item, resolution), is_directx

            best = min(variants, key=rank)
            lod = _lod_in_path(best)
            if channel == "normal" and actual_lod is not None and lod not in (None, actual_lod):
                warnings.add("没有与模型 LOD 匹配的法线贴图。")
                continue
            resolved[channel] = str(_downscale(best, cache, resolution, warnings))
    if kind == "pbr" and selected is None:
        selected = Path(resolved.get("base_color") or next(iter(resolved.values())))
    if kind == "texture":
        selected = _downscale(selected, cache, resolution, warnings)
    return {"kind": kind, "path": str(selected), "maps": resolved, "name": name,
            "lod": actual_lod, "warnings": sorted(warnings)}
