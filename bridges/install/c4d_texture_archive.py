"""Collect file textures used by newly imported materials into the saved project."""
import hashlib
import os
import re
import stat
import tempfile
from pathlib import Path


_IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff",
                ".webp", ".psd", ".dds", ".hdr", ".exr", ".tx"}
_LIMIT = 512 * 1024 * 1024
_CHUNK = 1024 * 1024


def project_directory(doc, *, allow_unsaved=False):
    path = Path(doc.GetDocumentPath())
    name = Path(doc.GetDocumentName())
    if (not path.is_absolute() or name.name != str(name)
            or name.suffix.lower() != ".c4d" or not (path / name).is_file()):
        if allow_unsaved:
            return None
        raise RuntimeError("请先保存当前 Cinema 4D 工程，再归档贴图。")
    path = path.resolve(strict=True)
    tex = path / "tex"
    if os.path.lexists(tex):
        metadata = tex.lstat()
        if (not stat.S_ISDIR(metadata.st_mode)
                or getattr(metadata, "st_file_attributes", 0) & 0x400
                or tex.resolve(strict=True) != tex):
            raise RuntimeError("工程的 tex 位置需要是实际目录。")
    return path


def _digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _archive(source, tex, publish, budget):
    before = source.stat()
    if before.st_size > budget:
        raise RuntimeError("超出本次归档大小上限")
    file_suffix = source.suffix.lower()
    label = re.sub(r'[^\w.-]', '_', source.stem)[:64].strip(" .") or "texture"
    digest = hashlib.sha256()
    staged = None
    try:
        with source.open("rb") as stream, tempfile.NamedTemporaryFile(
                mode="wb", dir=tex, prefix=".nexus-texture-", delete=False) as out:
            staged = Path(out.name)
            length = 0
            while chunk := stream.read(_CHUNK):
                length += len(chunk)
                if length > before.st_size:
                    raise RuntimeError("复制期间贴图发生变化")
                digest.update(chunk)
                out.write(chunk)
        after = source.stat()
        if length != before.st_size or length != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
            raise RuntimeError("复制期间贴图发生变化")
        key = digest.hexdigest()
        name = "nexus-" + key[:20] + "-" + label
        for index in range(100):
            candidate = tex / (name + (f"-{index + 1}" if index else "") + file_suffix)
            if os.path.lexists(candidate):
                info = candidate.lstat()
                if (stat.S_ISREG(info.st_mode)
                        and not getattr(info, "st_file_attributes", 0) & 0x400
                        and info.st_size == length and _digest(candidate) == key):
                    return candidate, length
                continue
            try:
                publish(staged, candidate)
            except FileExistsError:
                continue
            return candidate, length
        raise RuntimeError("同名归档贴图过多")
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)


def _owned_elements(elements):
    owned = list(elements)
    for element in elements:
        pending = [element.GetFirstShader()]
        while pending:
            shader = pending.pop()
            if shader is not None:
                owned.append(shader)
                pending.extend((shader.GetDown(), shader.GetNext()))
    return owned


def collect(c4d, doc, added, resolve, publish):
    root = project_directory(doc)
    tex = root / "tex"
    nodes = _owned_elements(added)
    flags = (c4d.ASSETDATA_FLAG_TEXTURESONLY | c4d.ASSETDATA_FLAG_NODOCUMENT
             | c4d.ASSETDATA_FLAG_MULTIPLEUSE | c4d.ASSETDATA_FLAG_COLLECT_NODES_ASSETS)
    assets = []
    if c4d.documents.GetAllAssetsNew(doc, False, "", flags, assets) == c4d.GETALLASSETSRESULT_FAILED:
        raise RuntimeError("Cinema 4D 无法读出新材质的贴图引用。")
    files = {}
    failures = set()
    changes = []
    budget = _LIMIT
    for item in assets:
        owner = item.get("owner")
        if owner is None or owner not in nodes:
            continue
        filename = str(item.get("filename") or item.get("assetname") or "")
        if item.get("nodePath"):
            failures.add(Path(filename).name or "节点材质贴图")
            continue
        identifier = item.get("paramId")
        if not isinstance(identifier, int) or identifier <= 0:
            failures.add(Path(filename).name or "未命名贴图")
            continue
        try:
            parameter = c4d.DescID(c4d.DescLevel(identifier))
            reference = owner.GetParameter(parameter, c4d.DESCFLAGS_GET_0)
        except (ReferenceError, RuntimeError, TypeError):
            failures.add(Path(filename).name or "未命名贴图")
            continue
        if not isinstance(reference, str) or not reference.strip():
            failures.add(Path(filename).name or "未命名贴图")
            continue
        original = Path(reference.replace("\\", "/"))
        if original.suffix.lower() not in _IMAGE_TYPES or "://" in reference:
            failures.add(original.name or "未命名贴图")
            continue
        try:
            if original.is_absolute():
                source = original
            else:
                match = resolve(reference)
                source = Path(match) if match else Path(filename)
                if not source.is_absolute():
                    source = root / original
            source = source.resolve(strict=True)
            if not source.is_file():
                raise RuntimeError("贴图不可用")
            if source.is_relative_to(tex):
                archived = source
            elif source in files:
                archived = files[source]
            else:
                tex.mkdir(exist_ok=True)
                project_directory(doc)
                archived, size = _archive(source, tex, publish, budget)
                files[source] = archived
                budget -= size
            relative = archived.relative_to(root).as_posix()
            if reference != relative:
                changes.append((owner, parameter, relative, original.name))
        except (OSError, RuntimeError, ValueError):
            failures.add(original.name)

    changed = set()
    if changes:
        if not doc.StartUndo():
            raise RuntimeError("无法为贴图重定位建立撤销记录。")
        try:
            recorded = []
            for owner, parameter, relative, name in changes:
                if owner not in recorded:
                    doc.AddUndo(c4d.UNDOTYPE_CHANGE, owner)
                    recorded.append(owner)
                try:
                    if owner.SetParameter(parameter, relative, c4d.DESCFLAGS_SET_0):
                        changed.add(relative)
                    else:
                        failures.add(name)
                except (ReferenceError, RuntimeError, TypeError):
                    failures.add(name)
        finally:
            doc.EndUndo()
    return len(changed), sorted(failures)
