"""Create renderer-native materials and lights in the active Cinema 4D document."""

import math
import os
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path


_ENGINES = {
    "standard": (0, "Standard / Physical"),
    "redshift": (1036219, "Redshift"),
    "octane": (1029525, "Octane"),
    "arnold": (1029988, "Arnold"),
    "vray": (1053272, "V-Ray"),
    "corona": (1030480, "Corona"),
}
_CHANNELS = {
    "base_color": "底色",
    "roughness": "粗糙度",
    "metallic": "金属度",
    "normal": "法线",
    "ao": "环境遮蔽",
    "displacement": "置换",
    "opacity": "不透明度",
    "emission": "自发光",
    "bump": "凹凸",
    "specular": "高光",
    "glossiness": "光泽度",
    "translucency": "半透明",
}
_COLOR_CHANNELS = {"base_color", "emission"}
_HDR_TYPES = {".hdr", ".exr"}
_IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".webp", ".psd", ".dds"} | _HDR_TYPES
_ALPHA_IMAGE_TYPES = {".png", ".tga", ".tif", ".tiff", ".webp", ".psd", ".dds", ".exr"}
_TEXTURE_FOLDERS = ("tex", "texture", "textures", "maps", "maps_baked")
_MAX_TEXTURE_SCAN_ENTRIES = 8192
_RS_CORE = "com.redshift3d.redshift4c4d.nodes.core."
_RS_GRAPH = "com.redshift3d.redshift4c4d.class.nodespace"
_RS_OUTPUT = "com.redshift3d.redshift4c4d.node.output"

# IDs come from the Octane for Cinema 4D plugin resource headers. Parameter
# names are resolved in the installed plugin so missing descriptions fail safely.
_OCT_MATERIAL = 1029501
_OCT_RGB = 1029504
_OCT_MIX = 1029505
_OCT_IMAGE = 1029508
_OCT_MULTIPLY = 1029516
_OCT_LIGHT = 1029526
_OCT_EMISSION = 1029642
_OCT_ENVIRONMENT = 1029643
_OCT_DISPLACEMENT = 1031901
_OCT_SIDE = 1034143
_OCT_GRAPH_CHANNELS = {"base_color", "roughness", "glossiness", "normal", "bump", "opacity", "specular", "metallic"}
# Plugin resources expose these IDs even when Cinema 4D's Python module does
# not publish the third-party symbols. See OctaneMaterial.h and ImageTexture.h.
_OCT_SYMBOLS = {
    "OCT_MATERIAL_TYPE": 2509, "OCT_MAT_TYPE_UNIVERSAL": 2516,
    "OCT_MATERIAL_DIFFUSE_COLOR": 2515, "OCT_MATERIAL_DIFFUSE_LINK": 2517,
    "OCT_MATERIAL_SPECULAR_FLOAT": 2523, "OCT_MATERIAL_SPECULAR_LINK": 2524,
    "OCT_MATERIAL_ROUGHNESS_FLOAT": 2532, "OCT_MATERIAL_INDEX": 2551,
    "OCT_MATERIAL_ROUGHNESS_LINK": 2533, "OCT_MATERIAL_BUMP_LINK": 2539,
    "OCT_MATERIAL_NORMAL_LINK": 2542, "OCT_MATERIAL_OPACITY_LINK": 2545,
    "OCT_MATERIAL_OPACITY_FLOAT": 2547,
    "OCT_MATERIAL_TRANSMISSION_COLOR": 2554, "OCT_MATERIAL_TRANSMISSION_LINK": 2555,
    "OCT_MATERIAL_TRANSMISSION_FLOAT": 2556, "OCT_MATERIAL_EMISSION": 2557,
    "OCT_MAT_USE_COLOR": 2563, "OCT_MAT_USE_SPECULAR": 2564, "OCT_MAT_USE_ROUGHNESS": 2565,
    "OCT_MAT_USE_BUMP": 2569, "OCT_MAT_USE_NORMAL": 2570, "OCT_MAT_USE_OPACITY": 2571,
    "OCT_MAT_USE_TRANSMISSION": 2574, "OCT_MAT_USE_EMISSION": 2575,
    "OCT_MAT_USE_INDEX": 2573, "OCT_MAT_USE_DISPLACEMENT": 2578, "OCT_MATERIAL_DISPLACEMENT_LINK": 2580,
    "OCT_MAT_USE_SPECULAR_MAP": 2586, "OCT_MAT_SPECULAR_MAP_LINK": 2587,
    "OCT_MAT_SPECULAR_MAP_FLOAT": 2613,
    "UNIVMAT_TRANSMISSION_TYPE": 2632, "UNIVMAT_TRANSMISSION_TYPE_THINWALL_DIF": 3,
    "IMAGETEXTURE_FILE": 1100, "IMAGETEXTURE_INVERT": 1104, "IMAGETEXTURE_POWER_FLOAT": 1109,
    "IMAGETEXTURE_MODE": 1105, "IMAGETEXTURE_MODE2": 1, "IMAGETEXTURE_MODE3": 2,
    "IMAGETEX_COLOR_SPACE": 1118, "IMAGETEX_CS_NONE": 0, "IMAGETEX_CS_SRGB": 1,
    "IMAGETEX_CS_LINEAR_SRGB": 2, "MULTIPLY_TEXTURE1": 1140, "MULTIPLY_TEXTURE2": 1141,
    "RGBSPECTRUMSHADER_COLOR": 1200, "MIXTEX_TEXTURE1_LNK": 1131,
    "MIXTEX_TEXTURE2_LNK": 1132, "MIXTEX_AMOUNT_FLOAT": 1133, "MIXTEX_AMOUNT_LNK": 1130,
    "SIDE_INVERT": 3020,
    "TEXEMISSION_EFFIC_OR_TEX": 2170, "DISPLACEMENT_TEXTURE": 2050,
}


def _current_renderer(c4d, doc):
    engine = doc.GetActiveRenderData()[c4d.RDATA_RENDERENGINE]
    if engine == c4d.RDATA_RENDERENGINE_PHYSICAL:
        return "standard", _ENGINES["standard"][1]
    for key, (plugin_id, label) in _ENGINES.items():
        if engine == plugin_id:
            return key, label
    plugin = c4d.plugins.FindPlugin(engine, c4d.PLUGINTYPE_VIDEOPOST)
    return None, plugin.GetName() if plugin else f"渲染器 ID {engine}"


def wants_octane(c4d, doc, requested):
    return requested == "octane" or requested == "auto" and _current_renderer(c4d, doc)[0] == "octane"


def available_renderers(c4d, kind="pbr"):
    """Return the adapters currently available inside this Cinema 4D process."""
    engines = ("redshift", "octane", "arnold") if kind in ("pbr", "texture") else ("redshift", "octane")
    return ["standard"] + [
        key for key in engines
        if c4d.plugins.FindPlugin(_ENGINES[key][0], c4d.PLUGINTYPE_VIDEOPOST)
    ]


def _renderer(c4d, doc, requested, kind):
    current, current_name = _current_renderer(c4d, doc)
    if requested == "auto":
        if current is None:
            raise RuntimeError(f"当前使用 {current_name}，没有对应的 Nexus 材质和灯光适配。")
        requested = current
    if requested not in _ENGINES:
        raise ValueError("未知的 Cinema 4D 渲染器。")
    engine_id, label = _ENGINES[requested]
    if requested != "standard" and not c4d.plugins.FindPlugin(engine_id, c4d.PLUGINTYPE_VIDEOPOST):
        raise RuntimeError(f"Cinema 4D 当前未加载 {label} 插件。")
    if requested == "arnold" and kind not in ("pbr", "texture"):
        raise RuntimeError("Arnold 适配支持材质和贴图。当前资产需要 Arnold 灯光适配。")
    if requested not in ("standard", "redshift", "octane", "arnold"):
        raise RuntimeError(f"已检测到 {label}，目前还没有为它接入原生材质和灯光。")
    return requested, label, current_name if current != requested else None


def _file(path, suffixes):
    if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
        raise ValueError("资产源文件已移动或无法读取。")
    if Path(path).suffix.lower() not in suffixes:
        raise ValueError("不支持此文件格式（" + os.path.basename(path) + "）。")
    return path


def _maps(plan):
    if plan["kind"] == "texture":
        return {"base_color": _file(plan["path"], _IMAGE_TYPES)}
    channels = plan.get("maps") or {}
    if not isinstance(channels, dict) or not channels or set(channels) - _CHANNELS.keys():
        raise ValueError("没有可用的 PBR 贴图通道。")
    return {key: _file(path, _IMAGE_TYPES) for key, path in channels.items()}


def _created(element, label):
    if element is None:
        raise RuntimeError(f"Cinema 4D 无法创建{label}。")
    return element


def _bitmap(c4d, owner, path, linear):
    shader = _created(c4d.BaseShader(c4d.Xbitmap), "位图着色器")
    shader[c4d.BITMAPSHADER_FILENAME] = path
    shader[c4d.BITMAPSHADER_COLORPROFILE] = (
        c4d.BITMAPSHADER_COLORPROFILE_LINEAR if linear else c4d.BITMAPSHADER_COLORPROFILE_SRGB
    )
    owner.InsertShader(shader)
    return shader


def _linear_texture(key, path):
    return key not in _COLOR_CHANNELS or Path(path).suffix.lower() in _HDR_TYPES


def _unconnected_name(key):
    return f"{_CHANNELS[key]}贴图（待连接）"


def _retain_classic_bitmap(c4d, owner, key, path):
    shader = _bitmap(c4d, owner, path, linear=_linear_texture(key, path))
    shader.SetName(_unconnected_name(key))


def _classic_texture_slots(c4d):
    return {
        "base_color": (c4d.MATERIAL_USE_COLOR, c4d.MATERIAL_COLOR_SHADER),
        "ao": (c4d.MATERIAL_USE_DIFFUSION, c4d.MATERIAL_DIFFUSION_SHADER),
        "bump": (c4d.MATERIAL_USE_BUMP, c4d.MATERIAL_BUMP_SHADER),
        "normal": (c4d.MATERIAL_USE_NORMAL, c4d.MATERIAL_NORMAL_SHADER),
        "displacement": (c4d.MATERIAL_USE_DISPLACEMENT, c4d.MATERIAL_DISPLACEMENT_SHADER),
        "opacity": (c4d.MATERIAL_USE_ALPHA, c4d.MATERIAL_ALPHA_SHADER),
        "emission": (c4d.MATERIAL_USE_LUMINANCE, c4d.MATERIAL_LUMINANCE_SHADER),
    }


def _classic_material(c4d, name, channels):
    mat = _created(c4d.Material(), "标准材质")
    mat.SetName(name)
    slots = _classic_texture_slots(c4d)
    for key in channels.keys() & slots.keys():
        enabled, parameter = slots[key]
        mat[enabled] = True
        path = channels[key]
        mat[parameter] = _bitmap(c4d, mat, path, _linear_texture(key, path))
    if "opacity" in channels:
        mat[c4d.MATERIAL_ALPHA_IMAGEALPHA] = False
    if "normal" in channels:
        mat[c4d.MATERIAL_NORMAL_REVERSEY] = _directx_normal(channels["normal"])

    roughness = channels.get("roughness")
    metallic = channels.get("metallic")
    specular = channels.get("specular")
    glossiness = channels.get("glossiness")
    notes = []
    if "translucency" in channels:
        _retain_classic_bitmap(c4d, mat, "translucency", channels["translucency"])
        notes.append("标准材质已保留半透明贴图，可手动用于背光着色")
    if roughness or metallic or specular or glossiness:
        mat[c4d.MATERIAL_USE_REFLECTION] = True
        mat.RemoveReflectionAllLayers()
        layer = _created(mat.AddReflectionLayer(), "GGX 反射层")
        layer.SetName("GGX")
        layer_id = layer.GetDataID()
        mat[layer_id + c4d.REFLECTION_LAYER_MAIN_DISTRIBUTION] = c4d.REFLECTION_DISTRIBUTION_GGX
        mat[layer_id + c4d.REFLECTION_LAYER_MAIN_VALUE_ROUGHNESS] = 0.4
        if roughness:
            mat[layer_id + c4d.REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS] = _bitmap(c4d, mat, roughness, True)
            if glossiness:
                _retain_classic_bitmap(c4d, mat, "glossiness", glossiness)
        elif glossiness:
            fusion_id = getattr(c4d, "Xfusion", getattr(c4d, "Xslafusion", None))
            fusion = c4d.BaseShader(fusion_id) if fusion_id else None
            if fusion is not None:
                fusion[c4d.SLA_FUSION_BASE_CHANNEL] = _bitmap(c4d, fusion, glossiness, True)
                fusion[c4d.SLA_FUSION_INVERT_OUTPUT] = True
                mat.InsertShader(fusion)
                mat[layer_id + c4d.REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS] = fusion
            else:
                _retain_classic_bitmap(c4d, mat, "glossiness", glossiness)
                notes.append("已保留光泽度贴图，需反相后接入粗糙度")
        if metallic:
            mat[layer_id + c4d.REFLECTION_LAYER_MAIN_SHADER_REFLECTION] = _bitmap(c4d, mat, metallic, True)
            notes.append("标准材质以 GGX 反射强度近似金属度贴图")
        if specular:
            mat[layer_id + c4d.REFLECTION_LAYER_MAIN_SHADER_SPECULAR] = _bitmap(c4d, mat, specular, True)
    return mat, notes


def _directx_normal(path):
    name = Path(path).stem.lower().replace(" ", "_").replace("-", "_")
    return any(part in name for part in ("directx", "normaldx", "normal_dx", "normdx", "nrm_dx"))


def _rs_port(node, prefix, name, output=False):
    ports = node.GetOutputs() if output else node.GetInputs()
    port = ports.FindChild(prefix + "." + name)
    if not port.IsValid():
        raise RuntimeError(f"当前 Redshift 版本缺少端口 {name}。")
    return port


def _rs_node(maxon, graph, asset):
    return graph.AddChild(maxon.Id(), maxon.Id(asset))


def _rs_image(maxon, graph, key, path, *, unconnected=False):
    asset = _RS_CORE + "texturesampler"
    node = _rs_node(maxon, graph, asset)
    if unconnected:
        node.SetValue(maxon.NODE.BASE.NAME, maxon.String(_unconnected_name(key)))
    file_bundle = _rs_port(node, asset, "tex0")
    path_port = file_bundle.FindChild("path")
    if not path_port.IsValid():
        raise RuntimeError("当前 Redshift 版本缺少纹理路径端口。")
    path_port.SetPortValue(maxon.Url(Path(path).as_uri()))
    if key not in _COLOR_CHANNELS:
        color_space = file_bundle.FindChild("colorspace")
        if not color_space.IsValid():
            raise RuntimeError("当前 Redshift 版本缺少数据贴图的色彩空间设置。")
        color_space.SetPortValue("RS_INPUT_COLORSPACE_RAW")
    return _rs_port(node, asset, "outcolor", output=True)


def _rs_material(c4d, name, channels, insert):
    import maxon

    mat = _created(c4d.BaseMaterial(c4d.Mmaterial), "Redshift 材质")
    mat.SetName(name)
    graph = mat.GetNodeMaterialReference().CreateEmptyGraph(maxon.Id(_RS_GRAPH))
    if graph.IsNullValue():
        raise RuntimeError("Redshift 材质节点空间无法初始化。")
    insert(mat, material=True)
    settings = maxon.DataDictionary()
    settings.Set(maxon.nodes.UndoMode, maxon.nodes.UNDO_MODE.NONE)
    notes = []
    with graph.BeginTransaction(settings) as transaction:
        terminal = _rs_node(maxon, graph, _RS_OUTPUT)
        standard = _RS_CORE + "standardmaterial"
        surface = _rs_node(maxon, graph, standard)
        _rs_port(surface, standard, "outcolor", output=True).Connect(_rs_port(terminal, _RS_OUTPUT, "surface"))
        field_map = {
            "base_color": "base_color",
            "roughness": "refl_roughness",
            "metallic": "metalness",
            "opacity": "opacity_color",
            "emission": "emission_color",
            "specular": "refl_weight",
        }
        for key in channels.keys() & field_map.keys():
            _rs_image(maxon, graph, key, channels[key]).Connect(_rs_port(surface, standard, field_map[key]))
        if "emission" in channels:
            _rs_port(surface, standard, "emission_weight").SetPortValue(1.0)
        if "normal" in channels or "bump" in channels:
            key = "normal" if "normal" in channels else "bump"
            bump_type = _RS_CORE + "bumpmap"
            bump_node = _rs_node(maxon, graph, bump_type)
            _rs_port(bump_node, bump_type, "inputtype").SetPortValue(1 if key == "normal" else 0)
            _rs_image(maxon, graph, key, channels[key]).Connect(_rs_port(bump_node, bump_type, "input"))
            _rs_port(bump_node, bump_type, "out", output=True).Connect(_rs_port(surface, standard, "bump_input"))
            if "normal" in channels and "bump" in channels:
                _rs_image(maxon, graph, "bump", channels["bump"], unconnected=True)
                notes.append("法线已接入，并保留凹凸贴图供手动连接")
            if key == "normal" and _directx_normal(channels[key]):
                notes.append("检测到 DirectX 法线，需在 Redshift 凹凸节点中检查 Y 轴方向")
        if "displacement" in channels:
            asset = _RS_CORE + "displacement"
            displacement = _rs_node(maxon, graph, asset)
            _rs_image(maxon, graph, "displacement", channels["displacement"]).Connect(
                _rs_port(displacement, asset, "texmap")
            )
            _rs_port(displacement, asset, "out", output=True).Connect(_rs_port(terminal, _RS_OUTPUT, "displacement"))
            notes.append("置换需要在模型的 Redshift 对象设置中启用")
        if "ao" in channels:
            notes.append("Redshift 材质保留独立的环境遮蔽贴图，需按场景需求混入底色")
            _rs_image(maxon, graph, "ao", channels["ao"], unconnected=True)
        if "glossiness" in channels:
            _rs_image(maxon, graph, "glossiness", channels["glossiness"], unconnected=True)
            if "roughness" not in channels:
                notes.append("光泽度贴图已加入节点图，需反相后接入粗糙度")
        if "translucency" in channels:
            _rs_image(maxon, graph, "translucency", channels["translucency"], unconnected=True)
            notes.append("Redshift 已保留半透明贴图，可手动连接薄壁材质的次表面权重")
        transaction.Commit()
    return mat, notes


def _arnold_material(name, channels):
    try:
        from arnold.material import ArnoldMaterialTransaction, ArnoldNodeMaterial
    except ImportError as error:
        raise RuntimeError("当前 C4DtoA 版本缺少 Arnold Node Material Python API。") from error

    material = ArnoldNodeMaterial.Create(name)
    if material is None or material.material is None:
        raise RuntimeError("Arnold 无法创建节点材质。")

    def node(node_type, node_name):
        shader = material.AddShader(node_type, node_name)
        if shader is None or not shader.IsValid():
            raise RuntimeError(f"当前 Arnold 版本无法创建 {node_type} 节点。")
        return shader

    def image(key, *, unconnected=False):
        shader = node("image", _unconnected_name(key) if unconnected else _CHANNELS[key] + "贴图")
        if material.SetShaderValue(shader, "filename", channels[key]) is False:
            raise RuntimeError(f"Arnold 无法设置{_CHANNELS[key]}贴图路径。")
        if key not in _COLOR_CHANNELS:
            material.SetShaderValue(shader, "color_space", "Raw")
        return shader

    def connect(source, target, parameter):
        if material.AddConnection(source, None, target, parameter) is False:
            raise RuntimeError(f"Arnold 无法连接 {parameter} 端口。")

    notes = []
    with ArnoldMaterialTransaction(material):
        surface = node("standard_surface", "Nexus Standard Surface")
        if material.AddRootConnection(surface, None, "shader") is False:
            raise RuntimeError("Arnold 无法连接材质输出。")
        slots = {
            "base_color": "base_color",
            "roughness": "specular_roughness",
            "metallic": "metalness",
            "opacity": "opacity",
            "emission": "emission_color",
            "specular": "specular_color",
        }
        for key in channels.keys() & slots.keys():
            connect(image(key), surface, slots[key])
        if "emission" in channels:
            material.SetShaderValue(surface, "emission", 1.0)
        if "translucency" in channels:
            translucency = image("translucency")
            if material.SetShaderValue(surface, "thin_walled", True) is False:
                notes.append("Arnold 已保留半透明贴图，当前版本无法启用薄壁透光")
            elif material.AddConnection(translucency, None, surface, "subsurface") is False:
                material.SetShaderValue(surface, "thin_walled", False)
                notes.append("Arnold 已保留半透明贴图，需手动连接次表面权重")
            else:
                notes.append("半透明贴图已连接到 Arnold 薄壁次表面权重")
        if "normal" in channels or "bump" in channels:
            if "normal" in channels:
                normal = node("normal_map", "Nexus Normal Map")
                connect(image("normal"), normal, "input")
                if _directx_normal(channels["normal"]):
                    material.SetShaderValue(normal, "invert_y", True)
                if "bump" in channels:
                    image("bump", unconnected=True)
                    notes.append("法线已接入，并保留凹凸贴图供手动连接")
            else:
                normal = node("bump2d", "Nexus Bump Map")
                connect(image("bump"), normal, "bump_map")
            connect(normal, surface, "normal")
        if "displacement" in channels:
            shader = node("displacement", "Nexus Displacement")
            connect(image("displacement"), shader, "normal_displacement_input")
            if material.AddRootConnection(shader, None, "displacement") is False:
                raise RuntimeError("Arnold 无法连接置换输出。")
        if "ao" in channels:
            image("ao", unconnected=True)
            notes.append("Arnold 保留独立的环境遮蔽贴图，需按场景需求混入底色")
        if "glossiness" in channels:
            image("glossiness", unconnected=True)
            if "roughness" not in channels:
                notes.append("光泽度贴图已加入节点图，需反相后接入粗糙度")
    return material.material, notes


def _oct_symbol(c4d, name):
    value = getattr(c4d, name, _OCT_SYMBOLS.get(name))
    if value is None:
        raise RuntimeError(f"当前 Octane 版本缺少参数 {name}。")
    return value


def _oct_param(c4d, element, name, value):
    element[_oct_symbol(c4d, name)] = value


def _oct_scalar(c4d, element, name, value):
    parameter = _oct_symbol(c4d, name)
    element[parameter] = value
    actual = element[parameter]
    if not isinstance(actual, (int, float)) or not math.isclose(actual, value, rel_tol=1e-6, abs_tol=1e-7):
        raise RuntimeError(f"Octane 无法设置参数 {name}。")


def _oct_image(c4d, owner, path, color_space, invert=False, *, power=None, mode=None):
    shader = _created(c4d.BaseShader(_OCT_IMAGE), "Octane 图像纹理")
    _oct_param(c4d, shader, "IMAGETEXTURE_FILE", path)
    _oct_param(c4d, shader, "IMAGETEX_COLOR_SPACE", _oct_symbol(c4d, color_space))
    if invert:
        _oct_param(c4d, shader, "IMAGETEXTURE_INVERT", True)
    if mode is not None:
        _oct_param(c4d, shader, "IMAGETEXTURE_MODE", _oct_symbol(c4d, mode))
    if power is not None and power != 1.0:
        _oct_scalar(c4d, shader, "IMAGETEXTURE_POWER_FLOAT", power)
    owner.InsertShader(shader)
    return shader


def _oct_color_space(key, path):
    if key not in _COLOR_CHANNELS:
        return "IMAGETEX_CS_NONE"
    return "IMAGETEX_CS_LINEAR_SRGB" if _linear_texture(key, path) else "IMAGETEX_CS_SRGB"


def _oct_translucency(c4d, mat, path):
    shader = _oct_image(c4d, mat, path, "IMAGETEX_CS_NONE")
    try:
        _oct_param(c4d, mat, "UNIVMAT_TRANSMISSION_TYPE", _oct_symbol(c4d, "UNIVMAT_TRANSMISSION_TYPE_THINWALL_DIF"))
        _oct_param(c4d, mat, "OCT_MATERIAL_TRANSMISSION_COLOR", c4d.Vector(1.0, 1.0, 1.0))
        _oct_param(c4d, mat, "OCT_MATERIAL_TRANSMISSION_FLOAT", 1.0)
        _oct_param(c4d, mat, "OCT_MATERIAL_TRANSMISSION_LINK", shader)
        _oct_param(c4d, mat, "OCT_MAT_USE_TRANSMISSION", True)
    except (AttributeError, RuntimeError, TypeError, ValueError):
        shader.SetName(_unconnected_name("translucency"))
        return "Octane 已保留半透明贴图，当前版本缺少薄壁漫透射接口"
    return "半透明贴图已连接到 Octane 薄壁漫透射"


def _oct_normal(c4d, mat, path, strength):
    if strength is None or not 0.0 <= strength < 1.0:
        return _oct_image(c4d, mat, path, "IMAGETEX_CS_NONE")
    # Blend the data texture with a neutral tangent-space normal. Multiplying
    # RGB by ImageTexture Power would move the zero point of its X and Y axes.
    mix = _created(c4d.BaseShader(_OCT_MIX), "Octane 法线强度混合")
    neutral = _created(c4d.BaseShader(_OCT_RGB), "Octane 中性法线")
    _oct_param(c4d, neutral, "RGBSPECTRUMSHADER_COLOR", c4d.Vector(0.5, 0.5, 1.0))
    mix.InsertShader(neutral)
    _oct_param(c4d, mix, "MIXTEX_TEXTURE1_LNK", neutral)
    _oct_param(c4d, mix, "MIXTEX_TEXTURE2_LNK", _oct_image(c4d, mix, path, "IMAGETEX_CS_NONE"))
    _oct_scalar(c4d, mix, "MIXTEX_AMOUNT_FLOAT", strength)
    mat.InsertShader(mix)
    return mix


def _oct_texture(c4d, owner, key, texture, notes, *, power=None, normal=None, invert=False, alpha=False):
    if isinstance(texture, str):
        if key == "normal":
            if normal is not None and normal > 1.0:
                notes.append("已连接法线贴图，超过 100% 的原始法线强度需在 Octane 中调整")
            if _directx_normal(texture):
                notes.append("检测到 DirectX 法线，需在 Octane 中检查 Y 轴方向")
            return _oct_normal(c4d, owner, texture, normal)
        mode = ("IMAGETEXTURE_MODE3" if alpha else "IMAGETEXTURE_MODE2") if key == "opacity" else None
        return _oct_image(c4d, owner, texture, _oct_color_space(key, texture), invert, power=power, mode=mode)
    kind, *inputs = texture

    def branch(parent, value):
        return _oct_texture(c4d, parent, key, value, notes, power=power, normal=normal, invert=invert, alpha=alpha)

    if kind == "image":
        path, strength = inputs
        value = _scalar(strength, maximum=100.0)
        return _oct_texture(c4d, owner, key, path, notes, power=power,
                            normal=normal if value is None else value, invert=invert, alpha=alpha)
    if kind == "side":
        front, back = inputs
        try:
            side = _created(c4d.BaseShader(_OCT_SIDE), "Octane 多边形正反面")
            if not side.CheckType(_OCT_SIDE):
                raise RuntimeError("Octane 多边形正反面节点不可用")
            _oct_param(c4d, side, "SIDE_INVERT", False)
            mix = _created(c4d.BaseShader(_OCT_MIX), "Octane 双面贴图混合")
            mix.InsertShader(side)
            _oct_param(c4d, mix, "MIXTEX_AMOUNT_LNK", side)
        except (AttributeError, RuntimeError, TypeError, ValueError):
            notes.append("当前 Octane 版本无法连接双面贴图，已使用正面贴图")
            return branch(owner, front)
        # The Side node outputs 1 on a front face and 0 on a back face.
        first, second = back, front
    elif kind == "mix":
        first, second, amount = inputs
        amount = _scalar(amount)
        if amount is None:
            notes.append("未能读取原始贴图混合比例，已使用第一张贴图")
            return branch(owner, first)
        mix = _created(c4d.BaseShader(_OCT_MIX), "Octane 贴图混合")
        _oct_scalar(c4d, mix, "MIXTEX_AMOUNT_FLOAT", amount)
    else:
        raise ValueError(f"Octane 不支持此贴图节点 {kind}")
    _oct_param(c4d, mix, "MIXTEX_TEXTURE1_LNK", branch(mix, first))
    _oct_param(c4d, mix, "MIXTEX_TEXTURE2_LNK", branch(mix, second))
    owner.InsertShader(mix)
    return mix


def _oct_material(c4d, name, channels, *, base_color=None, roughness=None, settings=None):
    mat = _created(c4d.BaseMaterial(_OCT_MATERIAL), "Octane 材质")
    mat.SetName(name)
    _oct_param(c4d, mat, "OCT_MATERIAL_TYPE", _oct_symbol(c4d, "OCT_MAT_TYPE_UNIVERSAL"))
    settings = settings or {}
    diffuse = settings.get("diffuse_strength")
    specular = settings.get("specular_strength")
    roughness = settings.get("roughness", roughness)
    normal = settings.get("normal_strength")
    metallic = settings.get("metallic")
    ior = settings.get("ior")
    opacity = settings.get("opacity")
    notes = []
    fields = {
        "roughness": ("ROUGHNESS", "OCT_MATERIAL_ROUGHNESS_LINK"),
        "metallic": ("SPECULAR_MAP", "OCT_MAT_SPECULAR_MAP_LINK"),
        "normal": ("NORMAL", "OCT_MATERIAL_NORMAL_LINK"),
        "bump": ("BUMP", "OCT_MATERIAL_BUMP_LINK"),
        "opacity": ("OPACITY", "OCT_MATERIAL_OPACITY_LINK"),
        "specular": ("SPECULAR", "OCT_MATERIAL_SPECULAR_LINK"),
    }
    for key in channels.keys() & fields.keys():
        enabled, slot = fields[key]
        _oct_param(c4d, mat, "OCT_MAT_USE_" + enabled, True)
        power = specular if key == "specular" else settings.get("bump_strength") if key == "bump" else None
        shader = _oct_texture(c4d, mat, key, channels[key], notes, power=power, normal=normal,
                              alpha=settings.get("opacity_alpha", False))
        _oct_param(c4d, mat, slot, shader)
    if "metallic" not in channels and (metallic is not None or specular is not None):
        _oct_param(c4d, mat, "OCT_MAT_USE_SPECULAR_MAP", True)
        _oct_scalar(c4d, mat, "OCT_MAT_SPECULAR_MAP_FLOAT", metallic if metallic is not None else 0.0)
    if specular is not None and "specular" not in channels:
        _oct_param(c4d, mat, "OCT_MAT_USE_SPECULAR", True)
        _oct_scalar(c4d, mat, "OCT_MATERIAL_SPECULAR_FLOAT", specular)
    if ior is not None:
        _oct_param(c4d, mat, "OCT_MAT_USE_INDEX", True)
        _oct_scalar(c4d, mat, "OCT_MATERIAL_INDEX", ior)
    if opacity is not None and opacity < 1.0 and "opacity" not in channels:
        _oct_param(c4d, mat, "OCT_MAT_USE_OPACITY", True)
        _oct_scalar(c4d, mat, "OCT_MATERIAL_OPACITY_FLOAT", opacity)
    if "glossiness" in channels:
        if "roughness" in channels:
            _oct_texture(c4d, mat, "glossiness", channels["glossiness"], notes).SetName(_unconnected_name("glossiness"))
        else:
            _oct_param(c4d, mat, "OCT_MAT_USE_ROUGHNESS", True)
            _oct_param(c4d, mat, "OCT_MATERIAL_ROUGHNESS_LINK", _oct_texture(
                c4d, mat, "glossiness", channels["glossiness"], notes, invert=True
            ))
    elif roughness is not None and "roughness" not in channels:
        _oct_param(c4d, mat, "OCT_MAT_USE_ROUGHNESS", True)
        _oct_param(c4d, mat, "OCT_MATERIAL_ROUGHNESS_FLOAT", roughness)
    if "translucency" in channels:
        notes.append(_oct_translucency(c4d, mat, channels["translucency"]))
    base, occlusion = channels.get("base_color"), channels.get("ao")
    if base and occlusion:
        combined = _created(c4d.BaseShader(_OCT_MULTIPLY), "Octane 纹理乘法节点")
        _oct_param(c4d, combined, "MULTIPLY_TEXTURE1", _oct_texture(
            c4d, combined, "base_color", base, notes, power=diffuse
        ))
        _oct_param(c4d, combined, "MULTIPLY_TEXTURE2", _oct_image(c4d, combined, occlusion, "IMAGETEX_CS_NONE"))
        mat.InsertShader(combined)
    elif base or occlusion:
        path = base or occlusion
        combined = _oct_texture(c4d, mat, "base_color" if base else "ao", path, notes,
                                power=diffuse if base else None)
    else:
        combined = None
    if combined is not None:
        _oct_param(c4d, mat, "OCT_MAT_USE_COLOR", True)
        _oct_param(c4d, mat, "OCT_MATERIAL_DIFFUSE_LINK", combined)
    elif base_color is not None:
        _oct_param(c4d, mat, "OCT_MAT_USE_COLOR", True)
        _oct_param(c4d, mat, "OCT_MATERIAL_DIFFUSE_COLOR", base_color * diffuse if diffuse is not None else base_color)
    if "emission" in channels:
        shader = _created(c4d.BaseShader(_OCT_EMISSION), "Octane 纹理自发光")
        path = channels["emission"]
        _oct_param(c4d, shader, "TEXEMISSION_EFFIC_OR_TEX", _oct_image(c4d, shader, path, _oct_color_space("emission", path)))
        mat.InsertShader(shader)
        _oct_param(c4d, mat, "OCT_MAT_USE_EMISSION", True)
        _oct_param(c4d, mat, "OCT_MATERIAL_EMISSION", shader)
    if "displacement" in channels:
        shader = _created(c4d.BaseShader(_OCT_DISPLACEMENT), "Octane 置换节点")
        _oct_param(c4d, shader, "DISPLACEMENT_TEXTURE", _oct_image(c4d, shader, channels["displacement"], "IMAGETEX_CS_NONE"))
        mat.InsertShader(shader)
        _oct_param(c4d, mat, "OCT_MAT_USE_DISPLACEMENT", True)
        _oct_param(c4d, mat, "OCT_MATERIAL_DISPLACEMENT_LINK", shader)
    return mat, notes


def _existing_texture(path, directory=None):
    try:
        resolved = path.resolve(strict=True)
        if (directory is None or resolved.is_relative_to(directory)) and resolved.is_file():
            return resolved
    except (OSError, ValueError, RuntimeError):
        pass
    return None


def _texture_name_index(directories):
    index = {}
    scanned = 0
    for root, nested in directories.items():
        pending = [root]
        visited = set()
        while pending:
            directory = pending.pop()
            if directory in visited:
                continue
            visited.add(directory)
            try:
                for item in directory.iterdir():
                    scanned += 1
                    if scanned > _MAX_TEXTURE_SCAN_ENTRIES:
                        # An incomplete listing cannot establish that a basename is unique.
                        return None
                    if item.suffix.lower() in _IMAGE_TYPES:
                        index.setdefault(item.name.casefold(), set()).add((root, item))
                    if nested and item.is_dir():
                        child = item.resolve()
                        if child.is_relative_to(root):
                            pending.append(child)
            except (OSError, ValueError, RuntimeError):
                return None
    return index


def _approved_texture_directories(candidates):
    directories = {}
    for directory, nested in candidates.items():
        try:
            root = directory.resolve(strict=True)
            if root.is_dir() and root.is_relative_to(directory.parent.resolve()):
                directories[root] = directories.get(root, False) or nested
        except (OSError, ValueError, RuntimeError):
            continue
    return directories


def _texture_resolver(fbx, source, project_directory="", *, allow_basename=True):
    embedded_names = (fbx.with_suffix(".fbm").name, fbx.stem + "_fbm")
    embedded_keys = {name.casefold() for name in embedded_names}
    local = {fbx.parent: False, fbx.parent / "tex": True}
    local.update({fbx.parent / name: True for name in embedded_names})
    if project_directory and Path(project_directory).is_absolute():
        project = Path(project_directory)
        local.update({project / name: True for name in embedded_names})
    external = {}
    if source:
        original = Path(source).parent
        external = {original: False}
        external.update({original / part: True for part in _TEXTURE_FOLDERS})
    tiers = (_approved_texture_directories(local), _approved_texture_directories(external))
    indexes = {}

    def exact_matches(reference, directories):
        matches = set()
        for root in directories:
            candidates = [root / reference]
            if root.name.casefold() in embedded_keys and reference.parts[0].casefold() in embedded_keys:
                candidates.append(root.joinpath(*reference.parts[1:]))
            for candidate in candidates:
                if match := _existing_texture(candidate, root):
                    matches.add(match)
        return matches

    @lru_cache(maxsize=_MAX_TEXTURE_SCAN_ENTRIES)
    def resolve(filename):
        reference = Path(filename.replace("\\", "/"))
        if reference.suffix.lower() not in _IMAGE_TYPES or "://" in filename or ".." in reference.parts:
            return None
        if reference.is_absolute():
            actual = _existing_texture(reference)
            if actual:
                return str(actual)
        elif len(reference.parts) > 1 or not allow_basename:
            for directories in tiers:
                exact = exact_matches(reference, directories)
                if exact:
                    return str(next(iter(exact))) if len(exact) == 1 else None
        if not allow_basename:
            return None
        for index, directories in enumerate(tiers):
            if index not in indexes:
                indexes[index] = _texture_name_index(directories)
            if indexes[index] is None:
                return None
            matches = {match for root, item in indexes[index].get(reference.name.casefold(), ())
                       if (match := _existing_texture(item, root))}
            if matches:
                return str(next(iter(matches))) if len(matches) == 1 else None
        return None

    return resolve


def _bitmap_references(c4d, shader):
    pending = [shader]
    references = set()
    while pending:
        node = pending.pop()
        if node.CheckType(c4d.Xbitmap):
            filename = node[c4d.BITMAPSHADER_FILENAME]
            if filename:
                references.add(str(filename))
        child = node.GetDown()
        while child is not None:
            pending.append(child)
            child = child.GetNext()
    return references


def _relink_bitmap_paths(c4d, material, resolve):
    linked = 0
    pending = [material.GetFirstShader()]
    while pending:
        shader = pending.pop()
        if shader is None:
            continue
        pending.extend((shader.GetNext(), shader.GetDown()))
        if shader.CheckType(c4d.Xbitmap):
            reference = shader[c4d.BITMAPSHADER_FILENAME]
            path = resolve(str(reference)) if reference else None
            if path and path != reference:
                shader[c4d.BITMAPSHADER_FILENAME] = path
                linked += 1
    return linked


def _fill_standard_map_channels(c4d, material, channels, resolve, *, opacity_alpha_map=None):
    linked = 0
    for key, (enabled, parameter) in _classic_texture_slots(c4d).items():
        path = channels.get(key)
        if not path:
            continue
        use_image_alpha = (key == "opacity"
                           and _matches_source_texture({"opacity_map": opacity_alpha_map}, key, path))
        shader = material[parameter]
        if shader is not None:
            if not shader.CheckType(c4d.Xbitmap):
                continue
            reference = str(shader[c4d.BITMAPSHADER_FILENAME] or "")
            if "://" in reference or (not use_image_alpha and resolve(reference)):
                continue
            shader[c4d.BITMAPSHADER_FILENAME] = path
        else:
            material[parameter] = _bitmap(c4d, material, path, _linear_texture(key, path))
        material[enabled] = True
        if key == "normal":
            material[c4d.MATERIAL_NORMAL_REVERSEY] = _directx_normal(path)
        elif key == "opacity":
            material[c4d.MATERIAL_ALPHA_IMAGEALPHA] = use_image_alpha
        linked += 1

    reflection_maps = [(channels[key], parameter) for key, parameter in (
        ("roughness", c4d.REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS),
        ("specular", c4d.REFLECTION_LAYER_MAIN_SHADER_SPECULAR),
        ("metallic", c4d.REFLECTION_LAYER_MAIN_SHADER_REFLECTION),
    ) if key in channels]
    if reflection_maps:
        layer = material.GetReflectionLayerIndex(0) if material.GetReflectionLayerCount() else None
        if layer is None:
            layer = _created(material.AddReflectionLayer(), "GGX 反射层")
            material[layer.GetDataID() + c4d.REFLECTION_LAYER_MAIN_DISTRIBUTION] = c4d.REFLECTION_DISTRIBUTION_GGX
        for path, parameter in reflection_maps:
            slot = layer.GetDataID() + parameter
            if material[slot] is None:
                material[slot] = _bitmap(c4d, material, path, True)
                material[c4d.MATERIAL_USE_REFLECTION] = True
                linked += 1
    return linked


def link_standard_scene_textures(c4d, doc, imported_materials, plan, family_key=None):
    """Relink imported classic materials and fill missing maps with unambiguous matches."""
    resolve = _texture_resolver(Path(plan["path"]), plan.get("source_path"), doc.GetDocumentPath())
    named_maps = plan.get("named_material_maps", {})
    source_maps = plan.get("scene_material_maps", {})
    source_settings = plan.get("max_batch_material_settings", {})
    names = Counter(material.GetName() for material in imported_materials)
    baked_maps = _baked_material_channels(plan, names.elements())
    linked = 0
    for material in imported_materials:
        if not material.CheckType(c4d.Mmaterial) or getattr(material, "IsNodeBased", lambda: False)():
            continue
        repaired = _relink_bitmap_paths(c4d, material, resolve)
        name = material.GetName()
        maps = dict(plan.get("maps", {})) if len(imported_materials) == 1 else {}
        if family_key is not None:
            maps.update(named_maps.get(family_key(name), {}))
        authored = source_maps.get(name, {}) if names[name] == 1 else {}
        for supplement in (baked_maps.get(name, {}), authored):
            for channel, path in supplement.items():
                candidate = Path(path)
                if candidate.is_absolute() and candidate.suffix.lower() in _IMAGE_TYPES:
                    existing = _existing_texture(candidate)
                    if existing is not None:
                        maps[channel] = str(existing)
        channels = {key: path for key, path in maps.items() if Path(path).suffix.lower() in _IMAGE_TYPES}
        if channels:
            source = source_settings.get(name, {}) if names[name] == 1 else {}
            repaired += _fill_standard_map_channels(c4d, material, channels, resolve,
                                                    opacity_alpha_map=source.get("opacity_alpha_map"))
        if repaired:
            material.Message(c4d.MSG_UPDATE)
            linked += repaired
    return f"标准材质已关联 {linked} 项贴图" if linked else ""


def _apply_max_batch_reflectance(c4d, material, source):
    specular = _scalar(source.get("specular_strength"))
    roughness = _scalar(source.get("roughness"))
    ior = _scalar(source.get("ior"), 1.0, 8.0)
    if all(value is None for value in (specular, roughness, ior)):
        return False
    layers = material.GetReflectionLayerCount()
    if layers > 1 or not layers and not specular:
        return False
    layer = material.GetReflectionLayerIndex(0) if layers else material.AddReflectionLayer()
    if layer is None:
        return False
    layer_id = layer.GetDataID()
    changed = False
    if not layers:
        material[layer_id + c4d.REFLECTION_LAYER_MAIN_DISTRIBUTION] = c4d.REFLECTION_DISTRIBUTION_GGX
        material[c4d.MATERIAL_USE_REFLECTION] = True
        changed = True
    for value, parameter, shader in (
        (specular, c4d.REFLECTION_LAYER_MAIN_VALUE_SPECULAR, c4d.REFLECTION_LAYER_MAIN_SHADER_SPECULAR),
        (roughness, c4d.REFLECTION_LAYER_MAIN_VALUE_ROUGHNESS, c4d.REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS),
    ):
        if value is not None and material[layer_id + shader] is None:
            material[layer_id + parameter] = value
            changed = True
    fresnel_mode = layer_id + c4d.REFLECTION_LAYER_FRESNEL_MODE
    if (ior is not None and material[fresnel_mode] != c4d.REFLECTION_FRESNEL_CONDUCTOR
            and material[layer_id + c4d.REFLECTION_LAYER_FRESNEL_SHADER_IOR] is None):
        material[fresnel_mode] = c4d.REFLECTION_FRESNEL_DIELECTRIC
        material[layer_id + c4d.REFLECTION_LAYER_FRESNEL_PRESET] = c4d.REFLECTION_FRESNEL_DIELECTRIC_CUSTOM
        material[layer_id + c4d.REFLECTION_LAYER_FRESNEL_VALUE_IOR] = ior
        changed = True
    return changed


def apply_max_batch_material_settings(c4d, imported_materials, plan):
    """Restore authored Batch scalars to exact matching classic materials."""
    source_settings = plan.get("max_batch_material_settings", {})
    if not source_settings:
        return ""
    names = Counter(material.GetName() for material in imported_materials)
    edited = 0
    for material in imported_materials:
        name = material.GetName()
        source = source_settings.get(name) if names[name] == 1 else None
        if not source or not material.CheckType(c4d.Mmaterial) or getattr(material, "IsNodeBased", lambda: False)():
            continue
        changed = False
        color = source.get("base_color")
        if (isinstance(color, (list, tuple)) and len(color) == 3
                and all(_scalar(component) is not None for component in color)):
            material[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(*color)
            material[c4d.MATERIAL_USE_COLOR] = True
            changed = True
        diffuse = _scalar(source.get("diffuse_strength"), maximum=100.0)
        if diffuse is not None and material[c4d.MATERIAL_USE_COLOR]:
            material[c4d.MATERIAL_COLOR_BRIGHTNESS] = diffuse
            changed = True
        for channel, slot, enabled, parameter in (
            ("bump", c4d.MATERIAL_BUMP_SHADER, c4d.MATERIAL_USE_BUMP, c4d.MATERIAL_BUMP_STRENGTH),
            ("normal", c4d.MATERIAL_NORMAL_SHADER, c4d.MATERIAL_USE_NORMAL, c4d.MATERIAL_NORMAL_STRENGTH),
        ):
            strength = _scalar(source.get(channel + "_strength"), maximum=100.0)
            shader = material[slot] if strength is not None and material[enabled] else None
            if (shader is not None and shader.CheckType(c4d.Xbitmap)
                    and _matches_source_texture(source, channel, shader[c4d.BITMAPSHADER_FILENAME])):
                material[parameter] = strength
                changed = True
        if _apply_max_batch_reflectance(c4d, material, source) or changed:
            material.Message(c4d.MSG_UPDATE)
            edited += 1
    return f"标准材质已恢复 {edited} 个 MAX 材质的数值" if edited else ""


def _imported_standard_channels(c4d, material, resolve_texture):
    channels = {}
    unlinked = 0
    checked = set()

    def resolve_channel(key, shader):
        nonlocal unlinked
        references = _bitmap_references(c4d, shader)
        checked.update(references)
        path = resolve_texture(next(iter(references))) if len(references) == 1 else None
        if path:
            channels[key] = path
        else:
            unlinked += 1

    for key, (enabled, parameter) in _classic_texture_slots(c4d).items():
        shader = material[parameter] if material[enabled] else None
        if shader is not None:
            resolve_channel(key, shader)

    roughness = None
    if material[c4d.MATERIAL_USE_REFLECTION]:
        for index in range(material.GetReflectionLayerCount()):
            layer = material.GetReflectionLayerIndex(index)
            if layer is None:
                continue
            offset = layer.GetDataID()
            value = material[offset + c4d.REFLECTION_LAYER_MAIN_VALUE_ROUGHNESS]
            if roughness is None and isinstance(value, (int, float)) and 0.0 <= value <= 1.0:
                roughness = value
            for key, parameter in (
                ("roughness", c4d.REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS),
                ("specular", c4d.REFLECTION_LAYER_MAIN_SHADER_SPECULAR),
                ("metallic", c4d.REFLECTION_LAYER_MAIN_SHADER_REFLECTION),
            ):
                shader = material[offset + parameter]
                if shader is not None and key not in channels:
                    resolve_channel(key, shader)
    shader = material.GetFirstShader()
    unhandled = set()
    while shader is not None:
        unhandled.update(_bitmap_references(c4d, shader) - checked)
        shader = shader.GetNext()
    color = material[c4d.MATERIAL_COLOR_COLOR] if material[c4d.MATERIAL_USE_COLOR] else None
    return channels, color, roughness, unlinked + len(unhandled)


def _baked_material_channels(plan, material_names):
    maps = plan.get("baked_material_maps")
    source = plan.get("source_path")
    if not maps or not source:
        return {}
    # Some texture packages pair a scene such as HouseC-TX.max with
    # HouseC0001 material labels and mat_C0001_diffuse.png.
    family = re.fullmatch(r"(.+?)([a-z])[-_](?:tx|tex|textures)", Path(source).stem.casefold())
    label_pattern = None
    if family:
        prefix, series = family.groups()
        label_pattern = re.compile(rf"{re.escape(prefix)}({series}[0-9]{{4,8}})(?:\.[0-9]{{3}})?")
    pairs = []
    for name in material_names:
        key = name.casefold()
        if key not in maps and label_pattern and (match := label_pattern.fullmatch(key)):
            key = match[1]
        if key in maps:
            pairs.append((name, key))
    counts = Counter(key for _, key in pairs)
    return {name: maps[key] for name, key in pairs if counts[key] == 1}


def _scalar(value, minimum=0.0, maximum=1.0):
    if type(value) in (int, float) and minimum <= value <= maximum:
        return float(value)
    return None


def _material_parameter(c4d, material, name, offset=None):
    parameter = getattr(c4d, name, None)
    if parameter is None:
        return None
    return material[parameter if offset is None else offset + parameter]


def _matches_source_texture(source, channel, path):
    filename = source.get(channel + "_map") if isinstance(source, dict) else None
    if not isinstance(filename, str) or not path:
        return False
    path = str(path)
    if Path(filename).is_absolute():
        return os.path.normcase(os.path.normpath(path)) == os.path.normcase(os.path.normpath(filename))
    return Path(path).name.casefold() == filename.casefold()


def _imported_opacity_alpha(c4d, original, selected, resolve_texture):
    if not (_material_parameter(c4d, original, "MATERIAL_USE_ALPHA")
            and _material_parameter(c4d, original, "MATERIAL_ALPHA_IMAGEALPHA")):
        return False
    shader = _material_parameter(c4d, original, "MATERIAL_ALPHA_SHADER")
    if shader is None or not shader.CheckType(c4d.Xbitmap):
        return False
    return resolve_texture(str(shader[c4d.BITMAPSHADER_FILENAME] or "")) == selected


def _imported_octane_settings(c4d, original, channels, source):
    settings = {}
    for channel, key, parameter, maximum in (
        ("base_color", "diffuse_strength", "MATERIAL_COLOR_BRIGHTNESS", 100.0),
        ("bump", "bump_strength", "MATERIAL_BUMP_STRENGTH", 100.0),
        ("normal", "normal_strength", "MATERIAL_NORMAL_STRENGTH", 100.0),
    ):
        if channel in channels or channel == "base_color" and original[c4d.MATERIAL_USE_COLOR]:
            value = _scalar(_material_parameter(c4d, original, parameter), maximum=maximum)
            if value is not None:
                settings[key] = value
    space = _material_parameter(c4d, original, "MATERIAL_NORMAL_SPACE")
    tangent = getattr(c4d, "MATERIAL_NORMAL_SPACE_TANGENT", None)
    if space is not None and tangent is not None and space != tangent:
        settings.pop("normal_strength", None)

    if original[c4d.MATERIAL_USE_REFLECTION]:
        for index in range(original.GetReflectionLayerCount()):
            layer = original.GetReflectionLayerIndex(index)
            if layer is None:
                continue
            offset = layer.GetDataID()
            for parameter in ("REFLECTION_LAYER_MAIN_VALUE_SPECULAR", "REFLECTION_LAYER_MAIN_VALUE_REFLECTION"):
                specular = _scalar(_material_parameter(c4d, original, parameter, offset))
                if specular is not None:
                    settings.setdefault("specular_strength", specular)
                    break
            mode = _material_parameter(c4d, original, "REFLECTION_LAYER_FRESNEL_MODE", offset)
            dielectric = getattr(c4d, "REFLECTION_FRESNEL_DIELECTRIC", None)
            if mode is not None and mode == dielectric:
                ior = _scalar(_material_parameter(c4d, original, "REFLECTION_LAYER_FRESNEL_VALUE_IOR", offset), 1.0, 8.0)
                if ior is not None:
                    settings.setdefault("ior", ior)
            if "specular_strength" in settings and "ior" in settings:
                break

    if isinstance(source, dict):
        for key, minimum, maximum in (
            ("diffuse_strength", 0.0, 100.0), ("specular_strength", 0.0, 1.0),
            ("roughness", 0.0, 1.0), ("metallic", 0.0, 1.0), ("ior", 1.0, 8.0),
            ("opacity", 0.0, 1.0),
        ):
            value = _scalar(source.get(key), minimum, maximum)
            if value is not None:
                settings[key] = value
        for channel in ("normal", "bump"):
            key = channel + "_strength"
            strength = _scalar(source.get(key), maximum=100.0)
            if strength is not None and _matches_source_texture(source, channel, channels.get(channel)):
                settings[key] = strength
    return settings


def convert_octane(c4d, doc, imported_materials, imported_objects, plan):
    """Replace materials brought in by this FBX merge and preserve its texture tags."""
    requested = plan.get("renderer", "auto")
    if not wants_octane(c4d, doc, requested):
        return ""
    _renderer(c4d, doc, requested, "pbr")
    include_source = (plan.get("scene_import") or {}).get("textures", True)
    resolve_texture = _texture_resolver(Path(plan["path"]), plan.get("source_path") if include_source else None,
                                        doc.GetDocumentPath())

    @lru_cache(maxsize=_MAX_TEXTURE_SCAN_ENTRIES)
    def bitmap_has_alpha(path):
        try:
            bitmap = c4d.bitmaps.BaseBitmap()
            result, is_movie = bitmap.InitWith(path)
            return result == c4d.IMAGERESULT_OK and not is_movie and bitmap.GetInternalChannel() is not None
        except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
            return False

    bindings = [(tag, tag.GetMaterial()) for obj in imported_objects
                for tag in obj.GetTags() if tag.CheckType(c4d.Ttexture)]
    originals = [material for material in imported_materials if material.CheckType(c4d.Mmaterial)]
    names = Counter(material.GetName() for material in originals)
    source_settings = plan.get("max_batch_material_settings") or plan.get("max_material_settings")
    if not isinstance(source_settings, dict):
        source_settings = {}
    source_maps = plan.get("scene_material_maps") if include_source else None
    if not isinstance(source_maps, dict):
        source_maps = {}
    baked = _baked_material_channels(plan, (material.GetName() for material in originals)) if include_source else {}
    converted = 0
    linked = 0
    source_links = 0
    restored = 0
    notes = []
    failed = []
    unlinked = 0
    kept = 0
    for original in originals:
        name = original.GetName()
        try:
            channels, color, roughness, unresolved = _imported_standard_channels(c4d, original, resolve_texture)
            if unresolved:
                unlinked += unresolved
                kept += 1
                continue
            source = source_settings.get(name) if names[name] == 1 else None
            authored = source_maps.get(name, {}) if names[name] == 1 else {}
            normal_path = authored.get("normal")
            bump_path = channels.get("bump")
            same_bitmap = normal_path and bump_path and os.path.normcase(normal_path) == os.path.normcase(bump_path)
            if "normal" not in channels and (same_bitmap or _matches_source_texture(source, "normal", bump_path)):
                channels["normal"] = channels.pop("bump")
            source_supplements = {key: path for key, path in authored.items() if key not in channels}
            graphs = source.get("texture_graphs") if include_source and isinstance(source, dict) else None
            if isinstance(graphs, dict):
                source_supplements.update({key: graph for key, graph in graphs.items()
                                           if key in _OCT_GRAPH_CHANNELS and isinstance(graph, (tuple, list)) and graph})
                if "glossiness" in graphs and "roughness" not in graphs and "roughness" not in authored:
                    channels.pop("roughness", None)
            channels.update(source_supplements)
            supplements = {key: path for key, path in baked.get(name, {}).items()
                           if key not in channels and not (key == "bump" and "normal" in channels)}
            channels.update(supplements)
            settings = _imported_octane_settings(c4d, original, channels, source)
            opacity = channels.get("opacity")
            if isinstance(opacity, str) and Path(opacity).suffix.lower() in _ALPHA_IMAGE_TYPES:
                authored_alpha = source.get("opacity_alpha_map") if include_source and isinstance(source, dict) else None
                if isinstance(authored_alpha, str) and Path(authored_alpha).is_absolute() and Path(authored_alpha) == Path(opacity):
                    settings["opacity_alpha"] = True
                elif _imported_opacity_alpha(c4d, original, opacity, resolve_texture) and bitmap_has_alpha(opacity):
                    settings["opacity_alpha"] = True
            rgb = source.get("base_color") if isinstance(source, dict) else None
            if ("base_color" not in channels and isinstance(rgb, (list, tuple)) and len(rgb) == 3
                    and all(_scalar(component) is not None for component in rgb)):
                color = c4d.Vector(*rgb)
            replacement, warnings = _oct_material(c4d, name, channels, base_color=color, roughness=roughness,
                                                 settings=settings)
            approximate = source.get("approximate_texture_channels", ()) if isinstance(source, dict) else ()
            if isinstance(approximate, (tuple, list)) and any(
                channel in source_supplements for channel in approximate if isinstance(channel, str)
            ):
                warnings.append("部分复杂贴图节点缺少可还原参数，已使用可识别的原贴图近似")
        except (AttributeError, RuntimeError, TypeError, ValueError) as error:
            failed.append(str(error) or name)
            continue
        affected = [tag for tag, old_material in bindings if old_material == original]
        doc.InsertMaterial(replacement)
        try:
            for tag in affected:
                tag.SetMaterial(replacement)
                if tag.GetMaterial() != replacement:
                    raise RuntimeError(f"无法更新材质标签「{name}」")
        except (AttributeError, RuntimeError, TypeError, ValueError) as error:
            for tag in affected:
                if tag.GetMaterial() == replacement:
                    tag.SetMaterial(original)
            replacement.Remove()
            failed.append(str(error) or name)
            continue
        original.Remove()
        converted += 1
        linked += len(channels)
        source_links += len(source_supplements)
        restored += len(supplements)
        notes.extend(warning for warning in warnings if warning not in notes)
    if failed and not converted and not kept:
        raise RuntimeError(failed[0])
    results = [f"已转换 {converted} 个 Octane 材质，连接 {linked} 个实际贴图通道"] if converted else []
    if source_links:
        results.append(f"从源材质补接 {source_links} 个贴图通道")
    if restored:
        results.append(f"从目录补接 {restored} 个烘焙贴图通道")
    if failed:
        results.append(f"{len(failed)} 个材质转换失败，已保留原材质（{failed[0]}）")
    if unlinked:
        results.append(f"{unlinked} 个贴图或着色器未能接入 Octane，{kept} 个材质保留原材质和对象绑定")
    return " · ".join(results + notes)


_OCT_LIGHT_FIELDS = {
    "LIGHTTAG_POWER": 1151,
    "LIGHTTAG_BB_TEMPERATURE": 1152,
    "OCT_LIGHTTAG_TYPE_SELECT": 1159,
    "LIGHTTAG_USELIGHT_PARAMS": 1160,
    "LIGHTTAG_ENABLE": 1161,
    "LIGHTTAG_SURFACE_BRIGHTNESS": 1166,
    "LIGHTTAG_KEEP_INSTANCE_POWER": 1175,
    "DAYLIGHTTAG_SUNCOLOR": 1235,
    "DAYLIGHTTAG_SUNSIZE": 1236,
    "DAYLIGHTTAG_USESKY": 1237,
    "DAYLIGHTTAG_SUNINTENSITY": 1261,
}
_OCT_DAYLIGHT = 1029754
_OCT_AREA_SHAPES = {
    "rectangle": "RECTANGLE",
    "disc": "DISC",
    "sphere": "SPHERE",
    "cylinder": "CYLINDER",
}


def _valid_light_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _set_oct_light_tag_value(c4d, tag, name, value):
    parameter = getattr(c4d, name, _OCT_LIGHT_FIELDS[name])
    tag[parameter] = value
    current = tag[parameter]
    if isinstance(value, float):
        if not _valid_light_number(current) or not math.isclose(current, value, rel_tol=1e-5, abs_tol=1e-7):
            raise RuntimeError(f"Octane 灯光标签未接受参数 {name}")
    elif current != value:
        raise RuntimeError(f"Octane 灯光标签未接受参数 {name}")


def _scene_light_source_scale(info):
    scale = info.get("source_scale")
    if (isinstance(scale, (tuple, list)) and len(scale) == 3
            and all(_valid_light_number(axis) and axis > 0 for axis in scale)):
        return scale
    return (1.0, 1.0, 1.0)


def _scene_area_light_dimensions(info):
    if info.get("source") != "corona_light":
        return ()
    shape = info.get("shape")
    if not isinstance(shape, str) or shape not in _OCT_AREA_SHAPES:
        return ()
    width, height = info.get("width"), info.get("height")
    if not _valid_light_number(width) or width <= 0:
        return ()
    if shape in ("rectangle", "cylinder") and (not _valid_light_number(height) or height <= 0):
        return ()
    sizes = (width, height if shape in ("rectangle", "cylinder") else width)
    if shape in ("sphere", "cylinder"):
        sizes += (width,)
    return tuple(size * axis for size, axis in zip(sizes, _scene_light_source_scale(info)))


def _scene_area_light_values(c4d, doc, light, info, dimensions):
    if not dimensions:
        return {}
    # The imported FBX transform continues to control the viewport size.
    one_metre = c4d.UnitScaleData()
    if one_metre.SetUnitScale(1.0, c4d.DOCUMENT_UNIT_M) is False:
        raise RuntimeError("无法读取面光源的项目长度单位")
    scale = c4d.utils.CalculateTranslationScale(one_metre, doc[c4d.DOCUMENT_DOCUNIT])
    if not _valid_light_number(scale) or scale <= 0:
        raise RuntimeError("无法换算面光源的项目长度单位")
    shape = info["shape"]
    width = info["width"] * scale
    height = info["height"] * scale if shape in ("rectangle", "cylinder") else width
    if not all(math.isfinite(size) for size in (width, height)):
        raise RuntimeError("面光源尺寸超出支持范围")
    shape_symbol = _OCT_AREA_SHAPES[shape]
    parameters = {
        c4d.LIGHT_TYPE: c4d.LIGHT_TYPE_AREA,
        c4d.LIGHT_AREADETAILS_SHAPE: getattr(c4d, f"LIGHT_AREADETAILS_SHAPE_{shape_symbol}"),
        c4d.LIGHT_AREADETAILS_SIZEX: width,
        c4d.LIGHT_AREADETAILS_SIZEY: height,
    }
    if len(dimensions) == 3:
        parameters[c4d.LIGHT_AREADETAILS_SIZEZ] = width
    # Keep the real emitter dimensions and omit only the auxiliary viewport range guides.
    for symbol in ("LIGHT_SHOWILLUMINATION", "LIGHT_SHOWVISIBLELIGHT", "LIGHT_SHOWCLIPPING",
                   "LIGHT_AREADETAILS_SHOWASSOLIDINVIEWPORT"):
        parameter = getattr(c4d, symbol, None)
        if parameter is not None and light[parameter] is True:
            parameters[parameter] = False
    return parameters


def _scene_emitting_area(shape, dimensions):
    if not dimensions:
        return 0.0
    width, height = dimensions[:2]
    if shape == "rectangle":
        return width * height
    if shape == "disc":
        return math.pi * width * height / 4.0
    depth = dimensions[2]
    if shape == "sphere":
        # Exact for a sphere and approximates a source scaled to an ellipsoid.
        return math.pi * (width * height + width * depth + height * depth) / 3.0
    # The side of a cylinder, with an approximate circumference if scaled unevenly.
    return math.pi * math.hypot(width, depth) * height / math.sqrt(2.0)


def _oct_scene_power(base, brightness, info, dimensions):
    scalar = info.get("intensity")
    units = info.get("units")
    if not _valid_light_number(scalar) or scalar <= 0:
        return base * max(0.0, brightness), False, False
    if units in ("w", "watts", "watt"):
        return scalar, True, True
    if units in ("relative", "multiplier") or info.get("source") == "corona_sun":
        return base * scalar, False, False
    if units in (1, "lm", "lumen", "lumens"):
        # 683 lm/W is the photopic reference at 555 nm, used here as an estimate.
        return scalar / 683.0, False, True
    shape = info.get("shape")
    if units in (2, "cd", "candela") and shape in ("sphere", "rectangle", "disc"):
        solid_angle = 4.0 * math.pi if shape == "sphere" else math.pi
        return scalar * solid_angle / 683.0, False, True
    area = _scene_emitting_area(shape, dimensions)
    if area > 0:
        if units == 0:
            # Integrate Corona's radiance over the emitting area and hemisphere.
            return scalar * math.pi * area, False, True
        if units in (3, "lx", "lux"):
            # Corona's lux mode converts to radiance by dividing by 683*pi.
            return scalar * area / 683.0, False, True
    return base * max(0.0, brightness), False, False


def _has_octane_environment(doc):
    pending = doc.GetObjects()
    while pending:
        node = pending.pop()
        if node.GetTag(_OCT_ENVIRONMENT) is not None or node.GetTag(_OCT_DAYLIGHT) is not None:
            return True
        pending.extend(node.GetChildren())
    return False


def _oct_scene_daylight(c4d, light, info, brightness):
    tag = c4d.BaseTag(_OCT_DAYLIGHT)
    if tag is None:
        raise RuntimeError("当前 Octane 缺少日光标签")
    intensity_id = getattr(c4d, "DAYLIGHTTAG_SUNINTENSITY", _OCT_LIGHT_FIELDS["DAYLIGHTTAG_SUNINTENSITY"])
    base = tag[intensity_id]
    if not _valid_light_number(base) or base <= 0:
        raise RuntimeError("当前 Octane 不支持独立日光强度")
    source = info.get("intensity")
    scalar = source if _valid_light_number(source) and source > 0 else brightness
    _set_oct_light_tag_value(c4d, tag, "DAYLIGHTTAG_USESKY", False)
    _set_oct_light_tag_value(c4d, tag, "DAYLIGHTTAG_SUNCOLOR", light[c4d.LIGHT_COLOR])
    _set_oct_light_tag_value(c4d, tag, "DAYLIGHTTAG_SUNINTENSITY", float(min(1000, base * scalar)))
    sun_size = info.get("sun_size")
    if _valid_light_number(sun_size) and sun_size > 0:
        size_id = getattr(c4d, "DAYLIGHTTAG_SUNSIZE", _OCT_LIGHT_FIELDS["DAYLIGHTTAG_SUNSIZE"])
        base = tag[size_id]
        if _valid_light_number(base) and base > 0:
            _set_oct_light_tag_value(c4d, tag, "DAYLIGHTTAG_SUNSIZE", float(min(30, max(0.1, base * sun_size))))
    return tag


def _oct_scene_regular_light(c4d, light, info, dimensions, brightness, enabled):
    tag = c4d.BaseTag(_OCT_LIGHT)
    if tag is None:
        raise RuntimeError("Cinema 4D 当前未加载 Octane 灯光标签")
    power_id = getattr(c4d, "LIGHTTAG_POWER", _OCT_LIGHT_FIELDS["LIGHTTAG_POWER"])
    base = tag[power_id]
    if not _valid_light_number(base) or base <= 0:
        raise RuntimeError("无法读取 Octane 灯光默认功率")
    power, precise, total_watts = _oct_scene_power(base, brightness, info, dimensions)
    kelvin = info.get("kelvin")
    use_temperature = _valid_light_number(kelvin) and 500 <= kelvin <= 12000
    _set_oct_light_tag_value(c4d, tag, "OCT_LIGHTTAG_TYPE_SELECT", 0)
    _set_oct_light_tag_value(c4d, tag, "LIGHTTAG_USELIGHT_PARAMS", not use_temperature)
    if use_temperature:
        _set_oct_light_tag_value(c4d, tag, "LIGHTTAG_BB_TEMPERATURE", float(kelvin))
    if total_watts:
        # Power was already integrated across the physical source. Do not apply area again.
        _set_oct_light_tag_value(c4d, tag, "LIGHTTAG_SURFACE_BRIGHTNESS", False)
        instance_power = getattr(c4d, "LIGHTTAG_KEEP_INSTANCE_POWER", _OCT_LIGHT_FIELDS["LIGHTTAG_KEEP_INSTANCE_POWER"])
        if isinstance(tag[instance_power], bool):
            _set_oct_light_tag_value(c4d, tag, "LIGHTTAG_KEEP_INSTANCE_POWER", True)
    # Enable is authoritative at zero since Octane's UI limits Power to 0.0001 W.
    enabled = enabled and power > 0
    _set_oct_light_tag_value(c4d, tag, "LIGHTTAG_ENABLE", enabled)
    if enabled:
        watts = float(min(100000.0, max(0.0001, power)))
        _set_oct_light_tag_value(c4d, tag, "LIGHTTAG_POWER", watts)
        return tag, not precise or watts != power
    return tag, False


def convert_octane_lights(c4d, doc, imported_objects, plan):
    """Apply color and initial Octane power to newly imported FBX scene lights."""
    if Path(plan["path"]).suffix.lower() != ".fbx" or not wants_octane(c4d, doc, plan.get("renderer", "auto")):
        return ""
    lights = [obj for obj in imported_objects if obj.CheckType(c4d.Olight)]
    names = Counter(light.GetName() for light in lights)
    settings = plan.get("max_light_settings") or {}
    converted = 0
    estimated = 0
    failed = []
    preserved_sky = 0
    daylight_available = None
    for light in lights:
        if light.GetTag(_OCT_LIGHT) is not None or light.GetTag(_OCT_DAYLIGHT) is not None:
            continue
        name = light.GetName()
        info = settings.get(name, {}) if names[name] == 1 else {}
        info = info if isinstance(info, dict) else {}
        tag = None
        changed = {}
        try:
            directional_types = (c4d.LIGHT_TYPE_DISTANT, c4d.LIGHT_TYPE_PARALLEL)
            allowed_types = (c4d.LIGHT_TYPE_OMNI, c4d.LIGHT_TYPE_SPOT, c4d.LIGHT_TYPE_AREA, *directional_types)
            light_type = light[c4d.LIGHT_TYPE]
            if light_type not in allowed_types:
                raise RuntimeError("此灯光类型需要手动配置渲染标签")
            brightness = light[c4d.LIGHT_BRIGHTNESS]
            if not _valid_light_number(brightness):
                raise RuntimeError("无法读取源灯光强度")
            dimensions = _scene_area_light_dimensions(info)
            area = _scene_area_light_values(c4d, doc, light, info, dimensions)
            enabled = brightness > 0 and info.get("enabled") is not False and info.get("intensity") != 0
            if hasattr(light, "GetRenderMode") and light.GetRenderMode() == getattr(c4d, "MODE_OFF", None):
                enabled = False
            daylight = enabled and info.get("source") == "corona_sun" and light_type in directional_types
            if daylight and daylight_available is None:
                daylight_available = not _has_octane_environment(doc)
            existing_sky = daylight and not daylight_available
            if daylight and daylight_available:
                tag = _oct_scene_daylight(c4d, light, info, brightness)
                tag_id, approximate = _OCT_DAYLIGHT, True
                if light_type == c4d.LIGHT_TYPE_PARALLEL:
                    area = {c4d.LIGHT_TYPE: c4d.LIGHT_TYPE_DISTANT}
            else:
                tag, approximate = _oct_scene_regular_light(c4d, light, info, dimensions, brightness, enabled)
                tag_id = _OCT_LIGHT
            for parameter, value in area.items():
                changed[parameter] = light[parameter]
                light[parameter] = value
                if light[parameter] != value:
                    raise RuntimeError("Cinema 4D 未接受源面光源尺寸或形状")
            light.InsertTag(tag)
            if light.GetTag(tag_id) != tag:
                raise RuntimeError("无法挂接 Octane 灯光标签")
            converted += 1
            estimated += approximate
            preserved_sky += existing_sky
            if tag_id == _OCT_DAYLIGHT:
                daylight_available = False
        except (AttributeError, IndexError, KeyError, RuntimeError, TypeError, ValueError, OverflowError) as error:
            if tag is not None and light.GetTag(tag_id) == tag:
                tag.Remove()
            for parameter, previous in reversed(list(changed.items())):
                if previous is not None:
                    light[parameter] = previous
            failed.append(f"{name}：{str(error) or type(error).__name__}")
    messages = [f"已设置 {converted} 盏 Octane 灯光的颜色和功率"] if converted else []
    if estimated:
        messages.append(f"{estimated} 盏灯采用近似功率")
    if preserved_sky:
        messages.append(f"{preserved_sky} 盏太阳按方向光导入，保留现有环境")
    if failed:
        messages.append(f"{len(failed)} 盏灯保留 C4D 原灯光（{failed[0]}）")
    return " · ".join(messages)


def _classic_ies(c4d, name, path):
    light = _created(c4d.BaseObject(c4d.Olight), "IES 灯光")
    light.SetName(name)
    light[c4d.LIGHT_TYPE] = c4d.LIGHT_TYPE_PHOTOMETRIC
    light[c4d.LIGHT_PHOTOMETRIC_DATA] = True
    light[c4d.LIGHT_PHOTOMETRIC_FILE] = path
    return light


def _classic_sky(c4d, name, path, insert):
    mat = _created(c4d.Material(), "天空材质")
    mat.SetName(name)
    mat[c4d.MATERIAL_USE_COLOR] = False
    mat[c4d.MATERIAL_USE_REFLECTION] = False
    mat[c4d.MATERIAL_USE_LUMINANCE] = True
    mat[c4d.MATERIAL_LUMINANCE_SHADER] = _bitmap(c4d, mat, path, linear=True)
    sky = _created(c4d.BaseObject(c4d.Osky), "HDRI 天空")
    sky.SetName(name)
    tag = _created(sky.MakeTag(c4d.Ttexture), "天空材质标签")
    tag[c4d.TEXTURETAG_PROJECTION] = c4d.TEXTURETAG_PROJECTION_SPHERICAL
    tag[c4d.TEXTURETAG_MATERIAL] = mat
    insert(mat, material=True)
    return sky


def _rs_light(c4d, name, kind, path):
    light = _created(c4d.BaseObject(c4d.Orslight), "Redshift 灯光")
    light.SetName(name)
    if kind == "hdri":
        light[c4d.REDSHIFT_LIGHT_TYPE] = c4d.REDSHIFT_LIGHT_TYPE_DOME
        # Redshift's File custom data contains a string subparameter for the path.
        texture_path = c4d.DescID(
            c4d.DescLevel(c4d.REDSHIFT_LIGHT_DOME_TEX0, 1036765, c4d.Orslight),
            c4d.DescLevel(c4d.REDSHIFT_FILE_PATH, c4d.DTYPE_STRING, 0),
        )
        if not light.SetParameter(texture_path, path, c4d.DESCFLAGS_SET_0):
            raise RuntimeError("当前 Redshift 域光无法设置 HDRI 路径。")
    else:
        light[c4d.REDSHIFT_LIGHT_TYPE] = c4d.REDSHIFT_LIGHT_TYPE_IES
        light[c4d.REDSHIFT_LIGHT_IES_PROFILE] = path
    return light


def _oct_light(c4d, name, kind, path):
    if kind == "hdri":
        light = _created(c4d.BaseObject(c4d.Osky), "Octane 环境")
        tag = _created(light.MakeTag(_OCT_ENVIRONMENT), "Octane 环境标签")
        image = _oct_image(c4d, tag, path, "IMAGETEX_CS_LINEAR_SRGB")
        _oct_param(c4d, tag, "ENVIRONMENTTAG_TEXTURE", image)
    else:
        light = _created(c4d.BaseObject(c4d.Olight), "Octane IES 灯光")
        light[c4d.LIGHT_TYPE] = c4d.LIGHT_TYPE_AREA
        tag = _created(light.MakeTag(_OCT_LIGHT), "Octane 灯光标签")
        image = _oct_image(c4d, tag, path, "IMAGETEX_CS_NONE")
        _oct_param(c4d, tag, "LIGHTTAG_DISTRIBUTION", image)
    light.SetName(name)
    return light


def apply(c4d, doc, plan):
    if doc is None:
        raise RuntimeError("请先打开 Cinema 4D 场景。")
    kind = plan["kind"]
    name = plan["name"]
    engine, label, current = _renderer(c4d, doc, plan.get("renderer", "auto"), kind)
    if kind in ("pbr", "texture"):
        channels = _maps(plan)
    elif kind in ("hdri", "ies"):
        path = _file(plan["path"], {".hdr", ".exr"} if kind == "hdri" else {".ies"})
    else:
        raise ValueError("此资产类型不能创建 Cinema 4D 材质或灯光。")

    c4d.StopAllThreads()
    if not doc.StartUndo():
        raise RuntimeError("无法开启 Cinema 4D 撤销记录。")
    added = []
    notes = []

    def insert(element, material=False):
        if material:
            doc.InsertMaterial(element)
        else:
            doc.InsertObject(element)
        added.append(element)

    try:
        if kind in ("pbr", "texture"):
            if engine == "redshift":
                mat, material_notes = _rs_material(c4d, name, channels, insert)
            elif engine == "arnold":
                mat, material_notes = _arnold_material(name, channels)
                insert(mat, material=True)
            else:
                build = _oct_material if engine == "octane" else _classic_material
                mat, material_notes = build(c4d, name, channels)
                insert(mat, material=True)
            notes.extend(material_notes)
            assigned = 0
            for obj in plan.get("objects") or ():
                if obj.GetDocument() != doc or not obj.CheckType(c4d.Opolygon) or obj.GetTag(c4d.Ttexture):
                    continue
                tag = _created(obj.MakeTag(c4d.Ttexture), "模型材质标签")
                added.append(tag)
                tag[c4d.TEXTURETAG_MATERIAL] = mat
                tag[c4d.TEXTURETAG_PROJECTION] = c4d.TEXTURETAG_PROJECTION_UVW
                assigned += 1
            if assigned:
                notes.append(f"已应用到 {assigned} 个模型对象")
            if "roughness" in channels and "glossiness" in channels:
                notes.append("粗糙度已接入，并保留光泽度贴图供手动连接")
            item = "材质"
        else:
            if engine == "redshift":
                light = _rs_light(c4d, name, kind, path)
            elif engine == "octane":
                light = _oct_light(c4d, name, kind, path)
            elif kind == "ies":
                light = _classic_ies(c4d, name, path)
            else:
                light = _classic_sky(c4d, name, path, insert)
                notes.append("Standard / Physical 需要启用全局光照以使用 HDRI 照亮场景")
            insert(light)
            item = "HDRI 环境" if kind == "hdri" else "IES 灯光"
        for element in added:
            if not doc.AddUndo(c4d.UNDOTYPE_NEWOBJ, element):
                raise RuntimeError("无法记录 Cinema 4D 撤销操作。")
    except Exception:
        for element in reversed(added):
            element.Remove()
        raise
    finally:
        doc.EndUndo()
    c4d.EventAdd()
    if current:
        notes.append(f"场景仍使用 {current}")
    return "。".join([f"已创建 {label} {item}「{name}」", *notes]) + "。"
