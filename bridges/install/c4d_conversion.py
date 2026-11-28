"""Export native Blender and 3ds Max scenes as FBX for Cinema 4D."""

import os
import re
import shutil
import struct
import subprocess
import tempfile
import time
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path, PureWindowsPath


_TIMEOUT_SECONDS = 180
_SOURCE = "NEXUS_C4D_CONVERSION_SOURCE"
_OUTPUT = "NEXUS_C4D_CONVERSION_OUTPUT"
_FBX_HEADER = b"Kaydara FBX Binary  \x00\x1a\x00"
_FBX_FINAL_MAGIC = bytes.fromhex("f85a8c6adef5d97eece90ce3758f290b")
_MAX_SAFE_MARKER = b"NEXUS_MAX_SAFE_SCENE_REQUIRED"
_MAX_SAFE_VERIFIED = b"NEXUS_MAX_SAFE_SCENE_VERIFIED"
_MAX_FINISH_MARKER = b"NEXUS_MAX_STAGE finish"
_MAX_MISSING = re.compile(rb"NEXUS_MAX_MISSING (\d{1,9}) (\d{1,9}) (\d{1,9})\b")
_MAX_LOG_ERRORS = re.compile(rb"(?m)^\d{4}/\d{2}/\d{2} [\d:]+ (?:ERR|FTL): [^\r\n]+")
_MAX_LOG_VALIDATION_BYTES = 1024 * 1024
_FBX_TEXTURE_EXTENSIONS = frozenset({
    ".bmp", ".dds", ".exr", ".gif", ".hdr", ".jpeg", ".jpg", ".png", ".psd", ".tga", ".tif", ".tiff", ".webp",
})
_FBX_MATERIAL_SLOTS = {
    "diffusecolor": "base_color", "basecolor": "base_color", "opacity": "opacity",
    "transparentcolor": "opacity",
    "bump": "bump", "normalmap": "normal", "roughness": "roughness", "metalness": "metallic",
    "specularcolor": "specular", "emissivecolor": "emission",
}
_MAX_FBX_MATERIAL_SLOTS = {
    "texmap_diffuse": "base_color", "texmap_opacity": "opacity", "texmap_bump": "bump",
    "texmap_reflectionroughness": "roughness", "texmap_reflectionglossiness": "glossiness",
    "texmap_metalness": "metallic",
}
_MAX_FBX_TEXTURE_FIELDS = {"3dsMax|Params|HDRIMapName", "3dsMax|Parameters|filename", "3dsMax|BitmapTex|filename"}
_MAX_FBX_VRAY_MATERIAL = (935280431, 1882483036)
_MAX_FBX_NORMAL_WRAPPER = (1912237649, 1912962095)
_MAX_FBX_CORONA_NORMAL = (678481578, -870825092)
_MAX_FBX_NORMAL_ON = "3dsMax|VRayNormalMap Parameters|normal_map_on"
_MAX_FBX_NORMAL_AMOUNT = "3dsMax|VRayNormalMap Parameters|normal_map_multiplier"
_MAX_FBX_CORONA_NORMAL_AMOUNT = "3dsMax|CoronaNormalPb|multiplier"
_MAX_FBX_VRAY_FIELDS = {
    "3dsMax|basic|diffuse", "3dsMax|basic|reflection", "3dsMax|basic|reflection_weight",
    "3dsMax|basic|reflection_glossiness", "3dsMax|BRDF|brdf_useRoughness",
    "3dsMax|basic|reflection_metalness", "3dsMax|basic|reflection_fresnel",
    "3dsMax|basic|reflection_lockIOR", "3dsMax|basic|reflection_ior", "3dsMax|basic|refraction_ior",
    "3dsMax|maps|texmap_reflectionGlossiness_multiplier",
    "3dsMax|maps|texmap_bump_multiplier", _MAX_FBX_NORMAL_ON, _MAX_FBX_NORMAL_AMOUNT,
}
_MAX_FBX_WRAPPERS = {
    (720, 0): {"3dsmax|parameters|map"},  # Color Correction
    (1858302732, 0): {"3dsmax|parameters|map1", "3dsmax|parameters|map2"},  # Falloff
    _MAX_FBX_NORMAL_WRAPPER: {"3dsmax|vraynormalmap parameters|normal_map"},
    _MAX_FBX_CORONA_NORMAL: {"3dsmax|coronanormalpb|normalmap"},
}
_MAX_FBX_CORONA_FRONT_BACK = (-1412620185, -2027727779)
_MAX_FBX_FRONT_BACK_PREFIX = "3dsMax|CoronaFrontBackPb|"
_MAX_FBX_PARAMETERS_PREFIX = "3dsMax|parameters|"
_MAX_FBX_MIX_TEXTURE = (560, 0)
_MAX_FBX_NOISE_TEXTURE = (564, 0)
_MAX_FBX_GRAPH_FIELDS = {
    *(_MAX_FBX_FRONT_BACK_PREFIX + field for field in ("frontTexmapOn", "backTexmapOn")),
    *(_MAX_FBX_PARAMETERS_PREFIX + field for field in (
        "map1Enabled", "map2Enabled", "maskEnabled", "mixAmount", "useCurve",
    )),
}
_MAX_FBX_CORONA_LEGACY = (1891525894, 1149841885)
_MAX_FBX_CORONA_LEGACY_PREFIX = "3dsMax|CoronaMtlPb|"
_MAX_FBX_CORONA_PHYSICAL = (1762831241, -2028660960)
_MAX_FBX_CORONA_PHYSICAL_PREFIX = "3dsMax|CoronaPhysicalMtlPb|"
_MAX_FBX_CORONA_SLOTS = {
    _MAX_FBX_CORONA_LEGACY: (_MAX_FBX_CORONA_LEGACY_PREFIX, {
        "texmapdiffuse": ("base_color", "texmapOnDiffuse", "mapamountDiffuse"),
        "texmapreflect": ("specular", "texmapOnReflect", "mapamountReflect"),
        "texmapreflectglossiness": ("glossiness", "texmapOnReflectGlossiness", "mapamountReflectGlossiness"),
        "texmapopacity": ("opacity", "texmapOnOpacity", "mapamountOpacity"),
        "texmapbump": ("bump", "texmapOnBump", None),
    }),
    _MAX_FBX_CORONA_PHYSICAL: (_MAX_FBX_CORONA_PHYSICAL_PREFIX, {
        "basetexmap": ("base_color", "baseTexmapOn", "baseMapAmount"),
        "baseroughnesstexmap": ("roughness", "baseRoughnessTexmapOn", "baseRoughnessMapAmount"),
        "opacitytexmap": ("opacity", "opacityTexmapOn", "opacityMapAmount"),
        "basebumptexmap": ("bump", "baseBumpTexmapOn", None),
        "metalnesstexmap": ("metallic", "metalnessTexmapOn", None),
    }),
}
_MAX_FBX_CORONA_FIELDS = {
    _MAX_FBX_CORONA_NORMAL_AMOUNT,
    *(_MAX_FBX_CORONA_LEGACY_PREFIX + field for field in (
        "colorDiffuse", "levelDiffuse", "colorReflect", "levelReflect", "reflectGlossiness", "fresnelIor",
        "colorOpacity", "levelOpacity",
    )),
    *(_MAX_FBX_CORONA_PHYSICAL_PREFIX + field for field in (
        "baseColor", "baseLevel", "baseRoughness", "roughnessMode", "baseIor", "iorMode", "useComplexIor",
        "metalnessMode", "opacityColor", "opacityLevel",
    )),
    *(prefix + field for prefix, slots in _MAX_FBX_CORONA_SLOTS.values()
      for _, enable, amount in slots.values() for field in (enable, amount) if field is not None),
}
_MAX_SAFETY_ERROR = "请在 3ds Max 的安全首选项中启用安全场景执行，阻止嵌入式 Python、.NET 和 MAXScript 系统命令，并取消排除脚本资源"
_MAX_STAGE_NAMES = (
    (b"NEXUS_MAX_STAGE security", "检查安全场景设置"),
    (b"NEXUS_MAX_STAGE load", "读取 MAX 场景"),
    (b"NEXUS_MAX_STAGE configure-fbx", "初始化 FBX 导出器"),
    (b"NEXUS_MAX_STAGE export-fbx", "写入 FBX 和贴图"),
    (_MAX_FINISH_MARKER, "结束 3ds Max Batch"),
)

_BLENDER_EXPORT = """
import os
import bpy

result = bpy.ops.export_scene.fbx(
    filepath=os.environ['NEXUS_C4D_CONVERSION_OUTPUT'],
    path_mode='COPY',
    embed_textures=True,
    use_selection=False,
)
if 'FINISHED' not in result:
    raise RuntimeError('FBX export did not finish')
"""

_MAX_MATERIAL_CAPTURE = r"""
    fn nexusProp item key = (
        try (if isProperty item key then getProperty item key else undefined) catch undefined
    )

    fn nexusNumber value low high = (
        (isKindOf value Number) and value >= low and value <= high
    )

    fn nexusSwitch value = (
        if value == true or value == 1 then true else (
            if value == false or value == 0 then false else undefined
        )
    )

    fn nexusDecimal value = (formattedPrint (value as float) format:".9g")

    fn nexusSafeText value limit = (
        (isKindOf value String) and value.count > 0 and value.count <= limit and
        (findString value "\t") == undefined and (findString value "\r") == undefined and
        (findString value "\n") == undefined
    )

    fn nexusScalar rows key value low high = (
        if nexusNumber value low high do append rows ("N\t" + key + "\t" + (nexusDecimal value))
    )

    fn nexusRGB rows key rgb = (
        if (isKindOf rgb Color) and (nexusNumber rgb.r 0 255) and
            (nexusNumber rgb.g 0 255) and (nexusNumber rgb.b 0 255) do (
            append rows ("C\t" + key + "\t" + (nexusDecimal (rgb.r / 255.0)) + "\t" +
                (nexusDecimal (rgb.g / 255.0)) + "\t" + (nexusDecimal (rgb.b / 255.0)))
        )
    )

    fn nexusBitmapPath bitmap = (
        local kind = classOf bitmap
        if kind == Bitmaptexture or kind == CoronaBitmap then nexusProp bitmap #filename
        else if kind == VRayBitmap or kind == VRayHDRI then nexusProp bitmap #HDRIMapName
        else undefined
    )

    fn nexusEnabledMap item key enabled = (
        if (nexusSwitch (nexusProp item enabled)) == true then nexusProp item key else undefined
    )

    fn nexusFullMap item key enabled amount = (
        if (nexusProp item amount) == 100 then nexusEnabledMap item key enabled else undefined
    )

    fn nexusImage rows channel bitmap amount = (
        local path = nexusBitmapPath bitmap
        if not (nexusSafeText path 4096) then return false
        local line = "T\t" + channel + "\t" + path
        if nexusNumber amount 0 100 do line += "\t" + (nexusDecimal amount)
        append rows line
        true
    )

    fn nexusBump rows bitmap amount = (
        local kind = classOf bitmap
        if kind == CoronaNormal then (
            nexusImage rows "normal" (nexusProp bitmap #normalMap) (nexusProp bitmap #multiplier)
        ) else if kind == VRayNormalMap then (
            nexusImage rows "normal" (nexusEnabledMap bitmap #normal_map #normal_map_on) (nexusProp bitmap #normal_map_multiplier)
        ) else (
            nexusImage rows "bump" bitmap amount
        )
    )

    fn nexusOpacity rows bitmap mapAmount level rgb = (
        if bitmap != undefined and mapAmount != 0 then (
            if mapAmount == 100 do nexusImage rows "opacity" bitmap undefined
        )
        else if (isKindOf rgb Color) and rgb.r == rgb.g and rgb.r == rgb.b and
            (nexusNumber rgb.r 0 255) and (nexusNumber level 0 1) do (
            nexusScalar rows "opacity" ((rgb.r / 255.0) * level) 0 1
        )
    )

    fn nexusSpecular rows bitmap mapAmount level rgb = (
        if bitmap == undefined then (
            if (isKindOf rgb Color) and rgb.r == rgb.g and rgb.r == rgb.b and
                (nexusNumber rgb.r 0 255) and (nexusNumber level 0 1) do (
                nexusScalar rows "specular_strength" ((rgb.r / 255.0) * level) 0 1
            )
        ) else if mapAmount == 100 and (nexusImage rows "specular" bitmap undefined) do (
            nexusScalar rows "specular_strength" level 0 1
        )
    )

    fn nexusRoughness rows value mode bitmap = (
        if mode == 0 or mode == 1 do (
            if nexusNumber value 0 1 do nexusScalar rows "roughness" (if mode == 0 then value else 1.0 - value) 0 1
            nexusImage rows (if mode == 0 then "roughness" else "glossiness") bitmap undefined
        )
    )

    fn nexusCaptureParams rows item family = (
        case family of (
            "corona_legacy": (
                nexusRGB rows "base_color" (nexusProp item #colorDiffuse)
                nexusScalar rows "diffuse_strength" (nexusProp item #levelDiffuse) 0 100
                nexusScalar rows "ior" (nexusProp item #fresnelIor) 1 8
                nexusRoughness rows (nexusProp item #reflectGlossiness) 1 (nexusFullMap item #texmapReflectGlossiness #texmapOnReflectGlossiness #mapamountReflectGlossiness)
                nexusImage rows "base_color" (nexusFullMap item #texmapDiffuse #texmapOnDiffuse #mapamountDiffuse) undefined
                nexusBump rows (nexusEnabledMap item #texmapBump #texmapOnBump) (nexusProp item #mapamountBump)
                nexusOpacity rows (nexusEnabledMap item #texmapOpacity #texmapOnOpacity) (nexusProp item #mapamountOpacity) (nexusProp item #levelOpacity) (nexusProp item #colorOpacity)
                nexusSpecular rows (nexusEnabledMap item #texmapReflect #texmapOnReflect) (nexusProp item #mapamountReflect) (nexusProp item #levelReflect) (nexusProp item #colorReflect)
            )
            "corona_physical": (
                nexusRGB rows "base_color" (nexusProp item #baseColor)
                nexusScalar rows "diffuse_strength" (nexusProp item #baseLevel) 0 100
                nexusScalar rows "metallic" (nexusProp item #metalnessMode) 0 1
                if (nexusProp item #iorMode) == 0 do nexusScalar rows "ior" (nexusProp item #baseIor) 1 8
                nexusRoughness rows (nexusProp item #baseRoughness) (nexusProp item #roughnessMode) (nexusFullMap item #baseRoughnessTexmap #baseRoughnessTexmapOn #baseRoughnessMapAmount)
                nexusImage rows "base_color" (nexusFullMap item #baseTexmap #baseTexmapOn #baseMapAmount) undefined
                nexusImage rows "metallic" (nexusEnabledMap item #metalnessTexmap #metalnessTexmapOn) undefined
                nexusBump rows (nexusEnabledMap item #baseBumpTexmap #baseBumpTexmapOn) (nexusProp item #baseBumpMapAmount)
                nexusOpacity rows (nexusEnabledMap item #opacityTexmap #opacityTexmapOn) (nexusProp item #opacityMapAmount) (nexusProp item #opacityLevel) (nexusProp item #opacityColor)
            )
            "vray": (
                nexusRGB rows "base_color" (nexusProp item #diffuse)
                nexusScalar rows "metallic" (nexusProp item #reflection_metalness) 0 1
                local fresnel = nexusSwitch (nexusProp item #reflection_fresnel)
                local locked = nexusSwitch (nexusProp item #reflection_lockIOR)
                if fresnel == true and (locked == true or locked == false) do (
                    nexusScalar rows "ior" (nexusProp item (if locked then #refraction_ior else #reflection_ior)) 1 8
                )
                local useRoughness = nexusSwitch (nexusProp item #brdf_useRoughness)
                if useRoughness == true or useRoughness == false do (
                    nexusRoughness rows (nexusProp item #reflection_glossiness) (if useRoughness then 0 else 1) (nexusFullMap item #texmap_reflectionGlossiness #texmap_reflectionGlossiness_on #texmap_reflectionGlossiness_multiplier)
                )
                nexusImage rows "base_color" (nexusFullMap item #texmap_diffuse #texmap_diffuse_on #texmap_diffuse_multiplier) undefined
                nexusImage rows "metallic" (nexusFullMap item #texmap_metalness #texmap_metalness_on #texmap_metalness_multiplier) undefined
                local bump = nexusProp item #texmap_bump_multiplier
                if nexusNumber bump 0 10000 do bump /= 100.0
                nexusBump rows (nexusEnabledMap item #texmap_bump #texmap_bump_on) bump
                nexusOpacity rows (nexusEnabledMap item #texmap_opacity #texmap_opacity_on) (nexusProp item #texmap_opacity_multiplier) 1.0 (nexusProp item #opacity)
                nexusSpecular rows (nexusEnabledMap item #texmap_reflection #texmap_reflection_on) (nexusProp item #texmap_reflection_multiplier) (nexusProp item #reflection_weight) (nexusProp item #reflection)
            )
        )
    )

    fn nexusCollectMaterials = (
        if sceneMaterials.count >= 8192 then return undefined
        local queue = #()
        for idx = 1 to sceneMaterials.count do appendIfUnique queue sceneMaterials[idx]
        local cursor = 1
        local examined = 0
        while cursor <= queue.count do (
            local item = queue[cursor]
            cursor += 1
            local count = try (getNumSubMtls item) catch 0
            examined += count
            if examined > 30000 then return undefined
            for idx = 1 to count do (
                local child = try (getSubMtl item idx) catch undefined
                if child != undefined do appendIfUnique queue child
                if queue.count >= 8192 then return undefined
            )
        )
        queue
    )

    fn nexusDisambiguateMaterialNames materials = (
        -- The same temporary names identify materials in the capture and the FBX.
        local reserved = Dictionary #string
        local nextSuffix = Dictionary #string
        for item in materials do (
            local label = nexusProp item #name
            if nexusSafeText label 256 do reserved[(toLower label)] = true
        )
        for item in materials do (
            local label = nexusProp item #name
            if nexusSafeText label 256 do (
                if nextSuffix[label] == undefined then nextSuffix[label] = 2
                else (
                    local number = nextSuffix[label]
                    local stem = (substring label 1 (amin label.count 230)) + "_Nexus_"
                    local candidate = stem + (number as string)
                    while reserved[(toLower candidate)] != undefined do (
                        number += 1
                        candidate = stem + (number as string)
                    )
                    try (setProperty item #name candidate) catch undefined
                    reserved[(toLower candidate)] = true
                    nextSuffix[label] = number + 1
                )
            )
        )
    )

    fn nexusWriteMaterials stream materials = (
        local names = Dictionary #string
        for item in materials do (
            local label = nexusProp item #name
            if nexusSafeText label 256 do names[label] = if names[label] == undefined then 1 else 2
        )
        local rowCount = 1
        local charCount = 0
        format "NEXUS_MAX_MATERIALS_V1\n" to:stream
        for item in materials do (
            local kind = classOf item
            local family = if kind == VRayMtl then "vray" else (
                if kind == CoronaLegacyMtl then "corona_legacy" else (
                    if kind == CoronaPhysicalMtl then "corona_physical" else undefined
                )
            )
            local label = if family != undefined then nexusProp item #name else undefined
            if (nexusSafeText label 256) and names[label] == 1 do (
                local rows = #("M\t" + label + "\t" + family)
                try (nexusCaptureParams rows item family) catch (rows = #())
                local size = 0
                for row in rows do size += row.count + 2
                if rowCount + rows.count >= 30000 or charCount + size > 1500000 then return false
                for row in rows do format "%\n" row to:stream
                rowCount += rows.count
                charCount += size
            )
        )
        format "END\n" to:stream
        true
    )

    fn nexusCaptureMaterials destination materials = (
        if materials == undefined then return false
        local temporary = destination + ".tmp"
        local stream = createFile temporary encoding:#utf8 writeBOM:false
        if stream == undefined then return false
        local complete = try (nexusWriteMaterials stream materials) catch false
        close stream
        if complete then renameFile temporary destination else false
    )
"""

_MAX_EXPORT = r"""
(
    fn requireSafeScene = (
        local security = SceneScriptSecurityManager
        if not ((security.IsSafeSceneScriptExecutionEnabled #Current) and
                (security.IsSceneScriptExecutionBlocked #Python #Current) and
                (security.IsSceneScriptExecutionBlocked #DotNet #Current) and
                (security.IsSceneScriptExecutionBlocked #MAXScriptSystemCommands #Current) and
                security.IsSafeScriptAssetExecutionEnabled()) do
            throw "NEXUS_MAX_SAFE_SCENE_REQUIRED"
    )
""" + _MAX_MATERIAL_CAPTURE + r"""
    logsystem.logEntry "NEXUS_MAX_STAGE security" broadcast:true
    requireSafeScene()

    local source = systemTools.getEnvVariable "NEXUS_C4D_CONVERSION_SOURCE"
    local output = systemTools.getEnvVariable "NEXUS_C4D_CONVERSION_OUTPUT"
    local missingFiles = #()
    local missingPlugins = #()
    local missingReferences = #()
    logsystem.logEntry "NEXUS_MAX_STAGE load" broadcast:true
    local loaded = loadMaxFile source useFileUnits:true quiet:true allowPrompts:false \
        missingExtFilesAction:#logmsg missingExtFilesList:&missingFiles \
        missingDLLsAction:#logmsg missingDLLsList:&missingPlugins \
        missingXRefsAction:#logmsg missingXRefsList:&missingReferences
    if not loaded do
        throw "Unable to load the 3ds Max scene"
    requireSafeScene()
    logsystem.logEntry "NEXUS_MAX_SAFE_SCENE_VERIFIED" broadcast:true
    format "NEXUS_MAX_MISSING % % %\n" missingFiles.count missingPlugins.count missingReferences.count
    local materials = try (nexusCollectMaterials()) catch undefined
    if materials != undefined do (try (nexusDisambiguateMaterialNames materials) catch undefined)
    if not (try (nexusCaptureMaterials ((getFilenamePath output) + "max-material-data.tsv") materials) catch false) do (
        format "NEXUS_MAX_MATERIAL_CAPTURE_FAILED\n"
    )
    logsystem.logEntry "NEXUS_MAX_STAGE configure-fbx" broadcast:true
    pluginManager.loadClass FbxExporter
    FBXExporterSetParam "ASCII" false
    FBXExporterSetParam "EmbedTextures" true
    FBXExporterSetParam "Cameras" true
    FBXExporterSetParam "Lights" true
    if (FBXExporterGetParam "ASCII") != false do throw "FBX binary export unavailable"
    if (FBXExporterGetParam "EmbedTextures") != true do throw "FBX texture export unavailable"
    if (FBXExporterGetParam "Cameras") != true do throw "FBX camera export unavailable"
    if (FBXExporterGetParam "Lights") != true do throw "FBX light export unavailable"
    logsystem.logEntry "NEXUS_MAX_STAGE export-fbx" broadcast:true
    if not (exportFile output #noPrompt selectedOnly:false using:FBXEXP) do
        throw "Unable to export the 3ds Max scene to FBX"
    logsystem.logEntry "NEXUS_MAX_STAGE finish" broadcast:true
)
"""


def _version(executable):
    return tuple(int(part) for part in re.findall(r"\d+", executable.parent.name))


def _find_executable(ext, executable_path=None):
    blender = ext == ".blend"
    label = "Blender" if blender else "3ds Max Batch"
    if not blender and os.name != "nt":
        raise RuntimeError("转换 .max 需要安装 3ds Max Batch 的 Windows 电脑")

    setting = "NEXUS_BLENDER_EXECUTABLE" if blender else "NEXUS_3DSMAX_BATCH_EXECUTABLE"
    configured = executable_path or os.environ.get(setting)
    if configured:
        executable = Path(configured).expanduser()
        if executable.is_absolute() and executable.is_file():
            return executable
        raise RuntimeError(f"{label} 的可执行文件路径无效")

    if os.name == "nt":
        program_files = {os.environ.get("ProgramW6432"), os.environ.get("ProgramFiles")}
        pattern = "Blender Foundation/Blender */blender.exe" if blender else "Autodesk/3ds Max */3dsmaxbatch.exe"
        installed = [file for root in program_files if root for file in Path(root).glob(pattern) if file.is_file()]
        if installed:
            return max(installed, key=_version)
    elif blender:
        for root in (Path("/Applications"), Path.home() / "Applications"):
            executable = root / "Blender.app/Contents/MacOS/Blender"
            if executable.is_file():
                return executable

    executable_name = "blender" if blender else "3dsmaxbatch"
    if os.name == "nt":
        executable_name += ".exe"
    for entry in os.get_exec_path():
        folder = Path(entry.strip('"'))
        executable = folder / executable_name
        if folder.is_absolute() and executable.is_file() and os.access(executable, os.X_OK):
            return executable
    raise RuntimeError(f"未找到 {label}。请安装 {label}，或先将源文件导出为 FBX")


def _command(ext, executable, source, directory):
    if ext == ".blend":
        return [*_blender_command(executable), str(source),
                "--python-exit-code", "10", "--python-expr", _BLENDER_EXPORT]

    script = directory / "export-scene.ms"
    script.write_text(_MAX_EXPORT, encoding="ascii")
    return [str(executable), str(script), "-safescene", "ON", "-dm", "on",
            "-listenerlog", str(directory / "listener.log"), "-log", str(directory / "max.log")]


def _worker_threads():
    return max(1, min(4, (os.cpu_count() or 2) // 2))


def _blender_command(executable):
    return [str(executable), "--background", "--factory-startup", "--disable-autoexec",
            "--threads", str(_worker_threads())]


def _max_log_tail(directory):
    parts = []
    for name in ("converter.log", "listener.log", "max.log"):
        try:
            with (directory / name).open("rb") as log:
                log.seek(max(0, log.seek(0, os.SEEK_END) - 65536))
                parts.append(log.read())
        except OSError:
            continue
    return b"\n".join(parts).replace(b"\0", b"")


def _missing_max_resources(logs):
    counts = _MAX_MISSING.findall(logs)
    if not counts:
        return ""
    labels = ("外部文件", "插件", "外部引用")
    return "、".join(f"{count} 项{label}" for label, count in zip(labels, map(int, counts[-1])) if count)


def max_export_warning(output):
    logs = _max_log_tail(Path(output).parent)
    missing = _missing_max_resources(logs)
    warnings = [f"MAX 场景缺少 {missing}"] if missing else []
    if any(_blocked_scene_error(line) for line in _MAX_LOG_ERRORS.findall(logs)):
        warnings.append("3ds Max 安全设置已拦截场景中的嵌入式脚本")
    if b"NEXUS_MAX_MATERIAL_CAPTURE_FAILED" in logs:
        warnings.append("未能记录 MAX 原生材质，已使用 FBX 材质数据")
    return " · ".join(warnings)


def _blocked_scene_error(line):
    return (b"Security Exception:" in line and b"embedded in the current scene" in line
            and b"has been blocked for the current 3ds Max session" in line)


def _max_export_with_blocked_scripts(returncode, output, logs):
    # Max Batch may report command failure even after export if Safe Scene blocked a scene script.
    if returncode not in {-130, 4294967166} or not _MAX_MISSING.search(logs):
        return False
    try:
        with output.with_name("max.log").open("rb") as log:
            full_log = log.read(_MAX_LOG_VALIDATION_BYTES + 1)
    except OSError:
        return False
    if len(full_log) > _MAX_LOG_VALIDATION_BYTES:
        return False
    full_log = full_log.replace(b"\0", b"")
    if _MAX_SAFE_MARKER in full_log or _MAX_SAFE_VERIFIED not in full_log or _MAX_FINISH_MARKER not in full_log:
        return False
    errors = _MAX_LOG_ERRORS.findall(full_log)
    return bool(errors and all(map(_blocked_scene_error, errors)) and _complete_binary_fbx(output))


def _max_failure(logs, reason):
    if _MAX_SAFE_MARKER in logs:
        return _MAX_SAFETY_ERROR
    stage = next((label for marker, label in reversed(_MAX_STAGE_NAMES) if marker in logs), "启动 3ds Max Batch")
    missing = _missing_max_resources(logs)
    return f"3ds Max Batch 在「{stage}」阶段{reason}" + (f"，缺少{missing}" if missing else "")


def _save_max_failure(directory, source, started, timeout, logs, message):
    try:
        summary = directory / "failure.log"
        details = (f"Source: {source.name}\nElapsed seconds: {time.monotonic() - started:.1f}\n"
                   f"Budget seconds: {timeout}\n{message}\n\n")
        summary.write_bytes(details.encode("utf-8") + logs)
        os.replace(summary, directory.parent / "max-batch-last-failure.log")
    except OSError:
        pass


def _max_timeout(size):
    chunk = 128 * 1024 * 1024
    return min(720, 180 + 120 * (max(0, size - 1) // chunk))


def _is_fbx(output):
    try:
        with output.open("rb") as file:
            return file.read(len(_FBX_HEADER)) == _FBX_HEADER and output.stat().st_size > 27
    except OSError:
        return False


def _complete_binary_fbx(output):
    try:
        with output.open("rb") as file:
            if file.read(len(_FBX_HEADER)) != _FBX_HEADER:
                return False
            version_bytes = file.read(4)
            version = int.from_bytes(version_bytes, "little")
            if version < 6000:
                return False
            offset_size = 8 if version >= 7500 else 4
            first_node_min_end = file.tell() + 3 * offset_size + 1
            first_node_end = int.from_bytes(file.read(offset_size), "little")
            footer = version_bytes + bytes(120) + _FBX_FINAL_MAGIC
            footer_start = file.seek(-len(footer), os.SEEK_END)
            return first_node_min_end < first_node_end < footer_start and file.read() == footer
    except OSError:
        return False


class _FbxTextureReader:
    """Read only relevant FBX metadata. Embedded media and geometry are skipped by offset."""

    def __init__(self, file):
        self.file = file
        self.end = file.seek(0, os.SEEK_END)
        file.seek(0)
        if file.read(len(_FBX_HEADER)) != _FBX_HEADER:
            raise ValueError("Missing binary FBX header")
        version, = struct.unpack("<I", file.read(4))
        if not 7000 <= version <= 7700:
            raise ValueError("Unsupported binary FBX version")
        self.header = struct.Struct("<QQQB" if version >= 7500 else "<IIIB")
        self.remaining_nodes = 250_000

    def nodes(self, parent_end):
        while self.file.tell() < parent_end:
            start = self.file.tell()
            if parent_end - start < self.header.size or self.remaining_nodes <= 0:
                raise ValueError("Invalid FBX node boundary")
            self.remaining_nodes -= 1
            end, count, size, name_size = self.header.unpack(self.file.read(self.header.size))
            if not end:
                if count or size or name_size or (parent_end != self.end and self.file.tell() != parent_end):
                    raise ValueError("Invalid FBX node terminator")
                return
            properties_end = self.file.tell() + name_size + size
            if not name_size or not start < properties_end <= end <= parent_end or count > size:
                raise ValueError("Invalid FBX node offset")
            name = self.file.read(name_size)
            yield name, count, properties_end, end
            self.file.seek(end)

    def properties(self, count, end):
        if count > 64 or not 0 <= end - self.file.tell() <= 32_768:
            return ()
        payload = self.file.read(end - self.file.tell())
        values = []
        offset = 0
        numeric = {b"Y": "<h", b"C": "<?", b"I": "<i", b"F": "<f", b"D": "<d", b"L": "<q"}
        for _ in range(count):
            kind = payload[offset:offset + 1]
            offset += 1
            if kind in numeric:
                shape = numeric[kind]
                value, = struct.unpack_from(shape, payload, offset)
                offset += struct.calcsize(shape)
            elif kind in {b"S", b"R"}:
                size, = struct.unpack_from("<I", payload, offset)
                offset += 4
                if size > len(payload) - offset:
                    raise ValueError("Invalid FBX property size")
                value = payload[offset:offset + size].decode("utf-8", "replace") if kind == b"S" else None
                offset += size
            else:
                return ()
            values.append(value)
        if offset != len(payload):
            raise ValueError("Invalid FBX property boundary")
        return values

    def material_fields(self, properties_end, end):
        paths = []
        class_ids = {}
        disabled = set()
        native = {}
        self.file.seek(properties_end)
        for name, count, prop_end, node_end in self.nodes(end):
            if name in {b"FileName", b"Filename", b"RelativeFilename"}:
                paths.extend(value for value in self.properties(count, prop_end) if isinstance(value, str) and value)
            elif name == b"Texture_Alpha_Source":
                if self.properties(count, prop_end) == ["Alpha_Black"]:
                    native["image_alpha"] = True
            elif name == b"Properties70":
                self.file.seek(prop_end)
                for field, count, field_end, _ in self.nodes(node_end):
                    if field != b"P":
                        continue
                    values = self.properties(count, field_end)
                    if len(values) < 5 or not isinstance(values[0], str):
                        continue
                    key, value = values[0], values[4]
                    if key in _MAX_FBX_VRAY_FIELDS or key in _MAX_FBX_CORONA_FIELDS or key in _MAX_FBX_GRAPH_FIELDS:
                        native[key] = value if len(values) == 5 else tuple(values[4:])
                    if len(values) != 5:
                        continue
                    if key in {"3dsMax|ClassIDa", "3dsMax|ClassIDb"} and type(value) is int:
                        class_ids[key] = value
                    elif key in _MAX_FBX_TEXTURE_FIELDS and isinstance(value, str) and value:
                        paths.append(value)
                    elif key.startswith("3dsMax|maps|") and key.endswith("_on") and value == 0:
                        channel = _MAX_FBX_MATERIAL_SLOTS.get(key.removeprefix("3dsMax|maps|").removesuffix("_on").lower())
                        if channel:
                            disabled.add(channel)
        return paths, (class_ids.get("3dsMax|ClassIDa"), class_ids.get("3dsMax|ClassIDb")), disabled, native

    def texture_graph(self):
        objects = {}
        connections = []
        seen = set()
        for name, _, prop_end, end in self.nodes(self.end):
            if name not in {b"Objects", b"Connections"}:
                continue
            if name in seen:
                raise ValueError("Duplicate FBX section")
            seen.add(name)
            self.file.seek(prop_end)
            for kind, count, node_prop_end, node_end in self.nodes(end):
                if name == b"Objects" and kind in {b"Material", b"Texture", b"Video", b"LayeredTexture"}:
                    values = self.properties(count, node_prop_end)
                    if len(values) < 2 or type(values[0]) is not int or not isinstance(values[1], str):
                        continue
                    node_id, label = values[:2]
                    if node_id <= 0 or node_id in objects:
                        raise ValueError("Duplicate or invalid FBX object identifier")
                    label = label.split("\x00\x01", 1)[0]
                    fields = self.material_fields(node_prop_end, node_end) if kind != b"LayeredTexture" else ((), None, (), {})
                    objects[node_id] = kind, label, fields
                elif name == b"Connections" and kind == b"C":
                    values = self.properties(count, node_prop_end)
                    if (len(values) in {3, 4} and values[0] in {"OO", "OP"}
                            and all(type(value) is int for value in values[1:3])):
                        slot = values[3].lower() if len(values) == 4 and isinstance(values[3], str) else ""
                        if (values[0] == "OP") == bool(slot):
                            connections.append((values[1], values[2], slot))
        return objects, connections


def _fbx_texture_path(reference, root, embedded):
    if (len(reference) > 4096 or any(ord(char) < 32 or char in '*?<>|"\ufffd' for char in reference)
            or ":" in reference[2:]):
        return None
    entry = PureWindowsPath(reference)
    if not entry.name or ".." in entry.parts or entry.suffix.lower() not in _FBX_TEXTURE_EXTENSIONS:
        return None
    if entry.parts[0].startswith(("\\\\?\\", "\\\\.\\")):
        return None

    def contained_file(candidate, folder):
        try:
            if not candidate.is_relative_to(folder):
                return None
            resolved = candidate.resolve(strict=True)
            if resolved.is_relative_to(folder) and resolved.is_file():
                return resolved
        except (OSError, RuntimeError, ValueError):
            pass
        return None

    native_path = Path(reference)
    if entry.anchor and not entry.is_absolute() and not native_path.is_absolute():
        return None
    if root:
        candidate = native_path if entry.is_absolute() or native_path.is_absolute() else root.joinpath(*entry.parts)
        if original := contained_file(candidate, root):
            return original
    return contained_file(embedded / entry.name, embedded) if embedded else None


def _fbx_number(value, minimum=0.0, maximum=1.0):
    if type(value) in (int, float) and minimum <= value <= maximum:
        return float(value)
    return None


def _png_has_alpha(path):
    if Path(path).suffix.lower() != ".png":
        return False
    try:
        with Path(path).open("rb") as image:
            header = image.read(26)
    except OSError:
        return False
    return (len(header) == 26 and header[:16] == b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
            and header[25] in (4, 6))


def _fbx_rgb(value):
    if isinstance(value, tuple) and len(value) == 3 and all(_fbx_number(component) is not None for component in value):
        return value
    return None


def _fbx_gray(value):
    color = _fbx_rgb(value)
    if color is not None and color[0] == color[1] == color[2]:
        return color[0]
    return None


def _vray_material_settings(native, maps):
    settings = {}
    if (color := _fbx_rgb(native.get("3dsMax|basic|diffuse"))) is not None:
        settings["base_color"] = color
    if (metallic := _fbx_number(native.get("3dsMax|basic|reflection_metalness"))) is not None:
        settings["metallic"] = metallic
    roughness_mode = native.get("3dsMax|BRDF|brdf_useRoughness")
    gloss = _fbx_number(native.get("3dsMax|basic|reflection_glossiness"))
    if roughness_mode in (0, 1) and gloss is not None:
        settings["roughness"] = gloss if roughness_mode else 1.0 - gloss
    if native.get("3dsMax|basic|reflection_fresnel") == 1:
        locked = native.get("3dsMax|basic|reflection_lockIOR")
        if locked in (0, 1):
            key = "refraction_ior" if locked else "reflection_ior"
            if (ior := _fbx_number(native.get("3dsMax|basic|" + key), 1.0, 8.0)) is not None:
                settings["ior"] = ior
    reflection = _fbx_gray(native.get("3dsMax|basic|reflection"))
    weight = _fbx_number(native.get("3dsMax|basic|reflection_weight"))
    if reflection is not None and weight is not None:
        settings["specular_strength"] = reflection * weight
    if "bump" in maps:
        bump = _fbx_number(native.get("3dsMax|maps|texmap_bump_multiplier"), maximum=10000.0)
        if bump is not None:
            settings.update(bump_map=str(maps["bump"]), bump_strength=bump / 100.0)
    return settings


def _corona_legacy_settings(native, maps):
    prefix = _MAX_FBX_CORONA_LEGACY_PREFIX
    settings = {}
    if (color := _fbx_rgb(native.get(prefix + "colorDiffuse"))) is not None:
        settings["base_color"] = color
    if (diffuse := _fbx_number(native.get(prefix + "levelDiffuse"), maximum=100.0)) is not None:
        settings["diffuse_strength"] = diffuse
    if (gloss := _fbx_number(native.get(prefix + "reflectGlossiness"))) is not None:
        settings["roughness"] = 1.0 - gloss
    if (ior := _fbx_number(native.get(prefix + "fresnelIor"), 1.0, 8.0)) is not None:
        settings["ior"] = ior
    reflection = 1.0 if "specular" in maps else _fbx_gray(native.get(prefix + "colorReflect"))
    reflection_level = _fbx_number(native.get(prefix + "levelReflect"))
    if reflection is not None and reflection_level is not None:
        settings["specular_strength"] = reflection * reflection_level
    opacity = _fbx_gray(native.get(prefix + "colorOpacity"))
    opacity_level = _fbx_number(native.get(prefix + "levelOpacity"))
    if opacity is not None and opacity_level is not None:
        settings["opacity"] = opacity * opacity_level
    return settings


def _corona_physical_settings(native, has_metalness_map):
    prefix = _MAX_FBX_CORONA_PHYSICAL_PREFIX
    settings = {}
    if (color := _fbx_rgb(native.get(prefix + "baseColor"))) is not None:
        settings["base_color"] = color
    if (diffuse := _fbx_number(native.get(prefix + "baseLevel"), maximum=100.0)) is not None:
        settings["diffuse_strength"] = diffuse
    mode = native.get(prefix + "roughnessMode")
    roughness = _fbx_number(native.get(prefix + "baseRoughness"))
    if mode in (0, 1) and roughness is not None:
        settings["roughness"] = 1.0 - roughness if mode else roughness
    metalness = native.get(prefix + "metalnessMode")
    if metalness in (0, 1) and not has_metalness_map:
        settings["metallic"] = float(metalness)
    if metalness == 0 and native.get(prefix + "iorMode") == 0 and native.get(prefix + "useComplexIor") != 1:
        if (ior := _fbx_number(native.get(prefix + "baseIor"), 1.0, 8.0)) is not None:
            settings["ior"] = ior
    opacity = _fbx_gray(native.get(prefix + "opacityColor"))
    opacity_level = _fbx_number(native.get(prefix + "opacityLevel"))
    if opacity is not None and opacity_level is not None:
        settings["opacity"] = opacity * opacity_level
    return settings


def _corona_map_channel(slot, native, class_id):
    prefix, slots = _MAX_FBX_CORONA_SLOTS[class_id]
    if not slot.startswith(prefix.lower()) or (binding := slots.get(slot[len(prefix):])) is None:
        return None
    channel, enable, amount = binding
    if native.get(prefix + enable) != 1 or (amount is not None and native.get(prefix + amount) != 1.0):
        return None
    if class_id == _MAX_FBX_CORONA_PHYSICAL and channel == "roughness":
        mode = native.get(prefix + "roughnessMode")
        if mode not in (0, 1):
            return None
        return "glossiness" if mode else "roughness"
    return channel


def _max_fbx_material_data(output, source, *, include_textures=True):
    """Read unambiguous image paths and known native material values from a 3ds Max Batch export."""
    try:
        output = Path(output).resolve(strict=True)
        media = output.with_suffix(".fbm")
        embedded = media if include_textures and media.is_dir() and media.resolve() == media else None
        with output.open("rb") as file:
            objects, connections = _FbxTextureReader(file).texture_graph()
    except (OSError, RuntimeError, ValueError, struct.error):
        return {}, {}
    root = None
    if include_textures:
        try:
            root = Path(source).absolute().parent.resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            pass

    incoming = defaultdict(set)
    if include_textures:
        for child, target, slot in connections:
            if child in objects and target in objects:
                incoming[target].add((child, slot))
    material_names = Counter(label for kind, label, _ in objects.values() if kind == b"Material")

    @lru_cache(maxsize=8192)
    def verified(reference, embedded_only=False):
        return _fbx_texture_path(reference, None if embedded_only else root, embedded if embedded_only else None)

    @lru_cache(maxsize=8192)
    def map_texture(node, channel, depth=0, normal_amount=None):
        kind, _, (paths, class_id, _, native) = objects[node]
        if kind != b"Texture" or depth >= 8:
            return None
        if class_id == _MAX_FBX_NORMAL_WRAPPER:
            if channel not in {"bump", "normal"} or native.get(_MAX_FBX_NORMAL_ON) == 0:
                return None
            channel = "normal"
            if native.get(_MAX_FBX_NORMAL_ON) == 1:
                normal_amount = _fbx_number(native.get(_MAX_FBX_NORMAL_AMOUNT), maximum=100.0)
        elif class_id == _MAX_FBX_CORONA_NORMAL:
            if channel not in {"bump", "normal"}:
                return None
            channel = "normal"
            normal_amount = _fbx_number(native.get(_MAX_FBX_CORONA_NORMAL_AMOUNT), maximum=100.0)
        links = incoming[node]
        references = set(paths)
        for child, slot in links:
            if not slot and objects[child][0] == b"Video":
                references.update(objects[child][2][0])
        files = {file for reference in references if (file := verified(reference))}
        if embedded:
            original_names = {file.name.casefold() for file in files}
            files.update(file for reference in references if PureWindowsPath(reference).name.casefold() not in original_names
                         and (file := verified(reference, embedded_only=True)))
        if len(files) == 1:
            return channel, ("image", str(files.pop()), normal_amount), False
        if files:
            return None
        slots = _MAX_FBX_WRAPPERS.get(class_id)
        upstream = {child for child, slot in links if slot}
        if slots and len(upstream) == 1 and {slot for _, slot in links if slot} == slots:
            result = map_texture(upstream.pop(), channel, depth + 1, normal_amount)
            # Color Correction forwards its original image, without reproducing the color adjustment.
            if class_id == (720, 0) and result:
                return result[0], result[1], True
            return result

        def child_texture(prefix, name, enable):
            if native.get(prefix + enable) != 1:
                return None
            children = {child for child, slot in links if slot == (prefix + name).lower()}
            if len(children) == 1:
                return map_texture(children.pop(), channel, depth + 1, normal_amount)
            return None

        if class_id == _MAX_FBX_CORONA_FRONT_BACK:
            prefix = _MAX_FBX_FRONT_BACK_PREFIX
            front = child_texture(prefix, "frontTexmap", "frontTexmapOn")
            back = child_texture(prefix, "backTexmap", "backTexmapOn")
            if front and back and front[0] == back[0]:
                graph = ("side", front[1], back[1]) if front[1] != back[1] else front[1]
                return front[0], graph, front[2] or back[2]
            if channel == "base_color" and (one_side := front or back):
                return one_side[0], one_side[1], True
        elif class_id in {_MAX_FBX_MIX_TEXTURE, _MAX_FBX_NOISE_TEXTURE}:
            prefix = _MAX_FBX_PARAMETERS_PREFIX
            first = child_texture(prefix, "map1", "map1Enabled")
            second = child_texture(prefix, "map2", "map2Enabled")
            if class_id == _MAX_FBX_MIX_TEXTURE:
                has_mask = native.get(prefix + "maskEnabled") != 0 and any(
                    slot == (prefix + "mask").lower() for _, slot in links
                )
                amount = _fbx_number(native.get(prefix + "mixAmount"))
                if not has_mask and native.get(prefix + "useCurve") == 0 and amount is not None:
                    if amount in (0.0, 1.0):
                        return first if amount == 0.0 else second
                    if first and second and first[0] == second[0]:
                        graph = ("mix", first[1], second[1], amount) if first[1] != second[1] else first[1]
                        return first[0], graph, first[2] or second[2]
            if channel == "base_color" and (fallback := first or second):
                return fallback[0], fallback[1], True
        return None

    texture_bindings = {}
    material_settings = {}
    for material, (kind, name, (_, class_id, disabled, native)) in objects.items():
        if (kind != b"Material" or material_names[name] != 1 or not 0 < len(name) <= 256
                or any(ord(char) < 32 or char == "\ufffd" for char in name)):
            continue
        slots = defaultdict(set)
        for child, slot in incoming[material]:
            if slot.startswith(("3dsmax|basic|", "3dsmax|maps|")):
                channel = _MAX_FBX_MATERIAL_SLOTS.get(slot.rsplit("|", 1)[-1])
            elif class_id in _MAX_FBX_CORONA_SLOTS and slot.startswith("3dsmax|corona"):
                channel = _corona_map_channel(slot, native, class_id)
            else:
                channel = _FBX_MATERIAL_SLOTS.get(slot)
            if not channel or channel in disabled or objects[child][0] not in {b"Texture", b"LayeredTexture"}:
                continue
            if channel == "glossiness" and class_id not in _MAX_FBX_CORONA_SLOTS:
                mode = native.get("3dsMax|BRDF|brdf_useRoughness")
                amount = native.get("3dsMax|maps|texmap_reflectionGlossiness_multiplier")
                if class_id != _MAX_FBX_VRAY_MATERIAL or mode not in (0, 1) or amount != 100:
                    continue
                channel = "roughness" if mode else "glossiness"
            slots[channel].add(child)

        channels = defaultdict(set)
        normal_amounts = defaultdict(set)
        graphs = defaultdict(set)
        approximated = set()
        for channel, textures in slots.items():
            bindings = {map_texture(texture, channel) for texture in textures}
            if None in bindings:
                continue
            if all(expr[0] == "image" for _, expr, _ in bindings):
                paths = {(mapped_channel, expr[1]) for mapped_channel, expr, _ in bindings}
                if len(paths) != 1:
                    continue
                mapped_channel, path = paths.pop()
                channels[mapped_channel].add(path)
                if mapped_channel == "normal":
                    normal_amounts[path].update(expr[2] for _, expr, _ in bindings if expr[2] is not None)
            else:
                candidates = {(mapped_channel, expr) for mapped_channel, expr, _ in bindings}
                if len(candidates) != 1:
                    continue
                mapped_channel, expression = candidates.pop()
                graphs[mapped_channel].add(expression)
            if any(approximate for _, _, approximate in bindings):
                approximated.add(mapped_channel)
        resolved = {channel: paths.pop() for channel, paths in channels.items() if len(paths) == 1}
        if resolved:
            texture_bindings[name] = resolved
        if class_id == _MAX_FBX_VRAY_MATERIAL:
            settings = _vray_material_settings(native, resolved)
        elif class_id == _MAX_FBX_CORONA_LEGACY:
            settings = _corona_legacy_settings(native, resolved)
        elif class_id == _MAX_FBX_CORONA_PHYSICAL:
            prefix = _MAX_FBX_CORONA_PHYSICAL_PREFIX
            has_metalness_map = native.get(prefix + "metalnessTexmapOn") == 1 and any(
                slot == prefix.lower() + "metalnesstexmap" for _, slot in incoming[material]
            )
            settings = _corona_physical_settings(native, has_metalness_map)
        else:
            settings = {}
        opacity = resolved.get("opacity")
        if (opacity and opacity == resolved.get("base_color")
                and any(objects[texture][2][3].get("image_alpha")
                        for texture in slots["base_color"] & slots["opacity"])
                and _png_has_alpha(opacity)):
            settings["opacity_alpha_map"] = str(opacity)
        if "normal" in resolved and len(normal_amounts[resolved["normal"]]) == 1:
            strength, = normal_amounts[resolved["normal"]]
            settings.update(normal_map=str(resolved["normal"]), normal_strength=strength)
        resolved_graphs = {channel: choices.pop() for channel, choices in graphs.items()
                           if len(choices) == 1 and channel not in resolved}
        if resolved_graphs:
            settings["texture_graphs"] = resolved_graphs
        approximated.intersection_update(resolved.keys() | resolved_graphs.keys())
        if approximated:
            settings["approximate_texture_channels"] = tuple(sorted(approximated))
        if settings:
            material_settings[name] = settings
    return texture_bindings, material_settings


_MAX_CAPTURE_FILE = "max-material-data.tsv"
_MAX_CAPTURE_LIMIT = 8 * 1024 * 1024
_MAX_CAPTURE_FAMILIES = {"vray", "corona_legacy", "corona_physical"}
_MAX_CAPTURE_SCALARS = {
    "diffuse_strength": (0.0, 100.0), "specular_strength": (0.0, 1.0),
    "roughness": (0.0, 1.0), "metallic": (0.0, 1.0), "ior": (1.0, 8.0), "opacity": (0.0, 1.0),
}
_MAX_CAPTURE_TEXTURES = {
    "base_color", "roughness", "glossiness", "metallic", "specular", "normal", "bump", "opacity",
}


def _max_capture_number(text, minimum, maximum):
    try:
        return _fbx_number(float(text), minimum, maximum)
    except ValueError:
        return None


def _max_capture_material_data(output, source, include_textures):
    try:
        output = Path(output).resolve(strict=True)
        capture = output.with_name(_MAX_CAPTURE_FILE)
        if capture.resolve(strict=True) != capture:
            return {}, {}
        with capture.open("rb") as file:
            raw = file.read(_MAX_CAPTURE_LIMIT + 1)
        if len(raw) > _MAX_CAPTURE_LIMIT:
            return {}, {}
        lines = raw.decode("utf-8-sig").rstrip("\r\n").split("\n")
    except (OSError, RuntimeError, ValueError):
        return {}, {}
    if lines[0].rstrip("\r") != "NEXUS_MAX_MATERIALS_V1" or lines[-1].rstrip("\r") != "END":
        return {}, {}

    root = embedded = None
    if include_textures:
        try:
            root = Path(source).absolute().parent.resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            pass
        media = output.with_suffix(".fbm")
        try:
            if media.resolve(strict=True) == media and media.is_dir():
                embedded = media
        except (OSError, RuntimeError, ValueError):
            pass

    @lru_cache(maxsize=8192)
    def resolve(path):
        return _fbx_texture_path(path, root, embedded)

    materials = {}
    names = Counter()
    record = None
    for line in lines[1:-1]:
        tag, *fields = line.rstrip("\r").split("\t")
        if tag == "M":
            record = None
            if len(fields) != 2 or fields[1] not in _MAX_CAPTURE_FAMILIES:
                continue
            name = fields[0]
            if not 0 < len(name) <= 256 or any(ord(char) < 32 or char == "\ufffd" for char in name):
                continue
            names[name] += 1
            record = materials.setdefault(name, ({}, {})) if names[name] == 1 else None
            continue
        if record is None or len(fields) < 2:
            continue
        maps, settings = record
        key = fields[0]
        if tag == "N" and len(fields) == 2 and key in _MAX_CAPTURE_SCALARS:
            if (number := _max_capture_number(fields[1], *_MAX_CAPTURE_SCALARS[key])) is not None:
                settings[key] = number
        elif tag == "C" and key == "base_color" and len(fields) == 4:
            rgb = tuple(_max_capture_number(value, 0.0, 1.0) for value in fields[1:])
            if None not in rgb:
                settings[key] = rgb
        elif tag == "T" and include_textures and key in _MAX_CAPTURE_TEXTURES and len(fields) in (2, 3):
            if path := resolve(fields[1]):
                maps[key] = str(path)
                if len(fields) == 3 and key in {"normal", "bump"}:
                    if (strength := _max_capture_number(fields[2], 0.0, 100.0)) is not None:
                        settings[key + "_map"] = str(path)
                        settings[key + "_strength"] = strength
    return ({name: maps for name, (maps, _) in materials.items() if names[name] == 1 and maps},
            {name: values for name, (_, values) in materials.items() if names[name] == 1 and values})


def max_material_data(output, source, *, include_textures=True):
    """Use verified native Batch capture first, with FBX metadata as a fallback."""
    maps, settings = _max_fbx_material_data(output, source, include_textures=include_textures)
    captured_maps, captured_settings = _max_capture_material_data(output, source, include_textures)
    for name, channels in captured_maps.items():
        target = maps.setdefault(name, {})
        if "normal" in channels and target.get("bump") == channels["normal"]:
            target.pop("bump")
        for channel, opposite in (("roughness", "glossiness"), ("glossiness", "roughness")):
            if channel in channels and opposite not in channels and target.get(opposite) == channels[channel]:
                target.pop(opposite)
        target.update(channels)
    for name, values in captured_settings.items():
        settings.setdefault(name, {}).update(values)
    return maps, settings


def max_texture_bindings(output, source):
    return max_material_data(output, source)[0]


def _terminate_converter(process):
    if os.name == "nt" and process.poll() is None:
        # 3dsmaxbatch owns a separate 3dsmax process, so stop its descendants too.
        system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/taskkill.exe"
        try:
            subprocess.run([str(system), "/PID", str(process.pid), "/T", "/F"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                           timeout=5, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if process.poll() is None:
        process.kill()


def _check_cancelled(cancel):
    if cancel is not None and cancel.is_set():
        raise RuntimeError("模型转换已取消。")


def _run_converter(command, directory, environment, log, cancel=None, *, timeout=None):
    _check_cancelled(cancel)
    timeout = _TIMEOUT_SECONDS if timeout is None else timeout
    flags = (subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if os.name == "nt" else 0
    environment.setdefault("OMP_NUM_THREADS", str(_worker_threads()))
    with subprocess.Popen(command, cwd=directory, env=environment, stdin=subprocess.DEVNULL,
                          stdout=log, stderr=subprocess.STDOUT, creationflags=flags) as process:
        deadline = time.monotonic() + timeout
        try:
            if cancel is None:
                return process.wait(timeout=timeout)
            while True:
                _check_cancelled(cancel)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    return process.wait(timeout=min(remaining, 0.25))
                except subprocess.TimeoutExpired:
                    continue
        except (RuntimeError, subprocess.TimeoutExpired):
            _terminate_converter(process)
            raise


def convert(path, cache_root, executable_path=None, cancel=None):
    """Return a local FBX path for a native scene; pass through other formats."""
    source = Path(path)
    ext = source.suffix.lower()
    if ext not in {".blend", ".max"}:
        return str(source)

    label = "Blender" if ext == ".blend" else "3ds Max Batch"
    executable = _find_executable(ext, executable_path)
    directory = None
    succeeded = False
    try:
        source = source.resolve(strict=True)
        if not source.is_file():
            raise RuntimeError("源场景文件不可读取")
        cache = Path(cache_root).expanduser().resolve()
        cache.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="scene-fbx-", dir=cache))
        output = directory / "scene.fbx"
        command = _command(ext, executable, source, directory)
        environment = {**os.environ, _SOURCE: str(source), _OUTPUT: str(output)}
        timeout = _max_timeout(source.stat().st_size) if ext == ".max" else None
        started = time.monotonic()
        with (directory / "converter.log").open("wb") as log:
            returncode = _run_converter(command, directory, environment, log, cancel, timeout=timeout)
        logs = _max_log_tail(directory) if ext == ".max" else b""
        valid = not returncode and _is_fbx(output)
        if ext == ".max" and returncode:
            valid = _max_export_with_blocked_scripts(returncode, output, logs)
        if _MAX_SAFE_MARKER in logs or not valid:
            if ext == ".max":
                message = _max_failure(logs, f"未生成有效 FBX（退出代码 {returncode}）")
                _save_max_failure(directory, source, started, timeout, logs, message)
                raise RuntimeError(message)
            raise RuntimeError(f"{label} 未生成有效 FBX（退出代码 {returncode}），请检查源文件、外部资源和导出组件")
        succeeded = True
        return str(output)
    except FileNotFoundError as error:
        raise RuntimeError("找不到源场景文件或转换程序") from error
    except subprocess.TimeoutExpired as error:
        if ext == ".max":
            logs = _max_log_tail(directory)
            message = _max_failure(logs, f"超时（{int(error.timeout)} 秒）")
            _save_max_failure(directory, source, started, timeout, logs, message)
            raise RuntimeError(message) from error
        raise RuntimeError(f"{label} 转换超时，请检查场景大小、缺失资源或许可状态") from error
    except OSError as error:
        raise RuntimeError(f"无法运行 {label} 转换或写入本地缓存") from error
    finally:
        if directory and not succeeded and directory.resolve().parent == cache:
            shutil.rmtree(directory, ignore_errors=True)
