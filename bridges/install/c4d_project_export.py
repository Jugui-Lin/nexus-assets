"""Package a converted FBX as an independent Cinema 4D project."""

import ctypes
import os
import re
import sys
import tempfile
from pathlib import Path


_INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_DEVICE_NAME = re.compile(r"(?i)(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)")
_MAX_REPORTED_ASSETS = 32


def _scene_stem(value):
    stem = _INVALID_NAME.sub("_", str(value)).strip(" .")
    if stem.lower().endswith(".c4d"):
        stem = stem[:-4].rstrip(" .")
    stem = stem[:100].rstrip(" .") or "Cinema 4D Project"
    return "_" + stem if _DEVICE_NAME.match(stem) else stem


def _rename_without_replacing(source, target):
    if os.name == "nt":
        # Windows rename fails when the target exists.
        source.rename(target)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    source_path, target_path = os.fsencode(source), os.fsencode(target)
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
        result = rename(source_path, target_path, 4)  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        result = rename(-100, source_path, -100, target_path, 1)  # AT_FDCWD, RENAME_NOREPLACE
    else:
        raise RuntimeError("当前文件系统不支持无覆盖发布 Cinema 4D 工程。")
    if result:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def _publish(source, output_root, stem):
    for index in range(1, 501):
        target = output_root / (stem if index == 1 else f"{stem} ({index})")
        if os.path.lexists(target):
            continue
        try:
            _rename_without_replacing(source, target)
        except FileExistsError:
            continue
        return target
    raise RuntimeError("这个目录下已有太多同名 Cinema 4D 工程，请选择其他位置。")


def _asset_list(c4d, doc):
    flags = (c4d.ASSETDATA_FLAG_TEXTURESONLY | c4d.ASSETDATA_FLAG_NODOCUMENT
             | c4d.ASSETDATA_FLAG_COLLECT_NODES_ASSETS)
    assets = []
    result = c4d.documents.GetAllAssetsNew(doc, False, "", flags, assets)
    if result == c4d.GETALLASSETSRESULT_FAILED:
        raise RuntimeError("Cinema 4D 无法检查工程中的贴图引用。")
    return assets


def _basename(value):
    return str(value or "").replace("\\", "/").rsplit("/", 1)[-1].strip()[:180]


def _display_asset(asset):
    return _basename(asset.get("filename") or asset.get("assetname")) or "未命名贴图"


def _relink_known_bitmaps(c4d, assets, maps):
    candidates = {}
    for reference in (maps or {}).values():
        file = Path(reference)
        if file.is_absolute() and file.is_file():
            paths = candidates.setdefault(file.name.casefold(), set())
            paths.add(file.resolve())
    for item in assets:
        if item.get("exists"):
            continue
        matches = candidates.get(_display_asset(item).casefold(), ())
        owner = item.get("owner")
        if len(matches) == 1 and owner is not None and owner.CheckType(c4d.Xbitmap):
            owner[c4d.BITMAPSHADER_FILENAME] = str(next(iter(matches)))


def _inside_package(asset, stage):
    filename = asset.get("filename")
    if not filename or not asset.get("exists"):
        return False
    ref = Path(str(filename))
    candidates = (ref,) if ref.is_absolute() else (stage / ref, stage / "tex" / ref)
    return any(path.is_file() and path.resolve().is_relative_to(stage) for path in candidates)


def export_project(c4d, fbx_path, output_root, scene_name, *, maps=None):
    """Save an FBX and its reachable media as a portable .c4d package.

    Call on the Cinema 4D main thread with an already converted FBX in the
    import cache. No document is added to or activated in the editor.
    """
    if not c4d.threading.GeIsMainThreadAndNoDrawThread():
        raise RuntimeError("请在 Cinema 4D 的主线程执行工程导出。")
    source = Path(fbx_path)
    if source.suffix.lower() != ".fbx" or not source.is_file():
        raise RuntimeError("找不到转换后的 FBX 场景。")
    output_root = Path(output_root)
    if not output_root.is_absolute() or not output_root.is_dir():
        raise RuntimeError("请选择已有的 Cinema 4D 工程保存目录。")
    output_root = output_root.resolve()
    stem = _scene_stem(scene_name)
    scene_file = stem + ".c4d"
    load_flags = c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS
    doc = c4d.documents.LoadDocument(str(source.resolve()), load_flags, None)
    if doc is None or doc.GetFirstObject() is None:
        raise RuntimeError("Cinema 4D 没有从 FBX 读取到可保存的模型或场景对象。")

    with tempfile.TemporaryDirectory(prefix=".nexus-c4d-", dir=output_root) as work:
        stage = Path(work) / stem
        stage.mkdir()
        doc.SetDocumentName(scene_file)
        _relink_known_bitmaps(c4d, _asset_list(c4d, doc), maps)
        collected, missing = [], []
        flags = (c4d.SAVEPROJECT_ASSETS | c4d.SAVEPROJECT_SCENEFILE
                 | c4d.SAVEPROJECT_USEDOCUMENTNAMEASFILENAME
                 | c4d.SAVEPROJECT_DONTFAILONMISSINGASSETS
                 | c4d.SAVEPROJECT_ASSETLINKS_COPY_FILEASSETS)
        saved = c4d.documents.SaveProject(doc, flags, str(stage), collected, missing)
        project = stage / scene_file
        if not saved or not project.is_file():
            raise RuntimeError("Cinema 4D 未能保存工程文件和贴图。")
        missing_names = {_display_asset(item) for item in missing}
        del collected, missing, doc

        # Check the native file after moving it, so absolute staging paths cannot pass.
        verification_dir = Path(tempfile.mkdtemp(prefix="verify-", dir=work))
        stage = stage.rename(verification_dir / stem)
        project = stage / scene_file
        verify = c4d.documents.LoadDocument(str(project), load_flags, None)
        if verify is None or verify.GetFirstObject() is None:
            raise RuntimeError("已保存的 Cinema 4D 工程无法验证。")
        references = _asset_list(c4d, verify)
        missing_names.update(_display_asset(item) for item in references if not item.get("exists"))
        external = {_display_asset(item) for item in references
                    if item.get("exists") and not _inside_package(item, stage)}
        del references, verify
        tex = stage / "tex"
        texture_count = sum(file.is_file() for file in tex.rglob("*"))
        warnings = []
        if missing_names:
            warnings.append(f"{len(missing_names)} 项贴图缺失")
        if external:
            warnings.append(f"{len(external)} 项纹理仍依赖外部文件或资产")
        if not texture_count and not missing_names and not external:
            warnings.append("FBX 中没有可打包的贴图引用")
        target = _publish(stage, output_root, stem)
        return {
            "projectPath": str(target / scene_file),
            "textureCount": texture_count,
            "missingTextures": sorted(missing_names)[:_MAX_REPORTED_ASSETS],
            "unsupportedTextures": sorted(external)[:_MAX_REPORTED_ASSETS],
            "warnings": warnings,
        }
