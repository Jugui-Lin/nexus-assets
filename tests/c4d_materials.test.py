import importlib.util
import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "bridges" / "install" / "c4d_materials.py"
SPEC = importlib.util.spec_from_file_location("c4d_materials_test", SCRIPT)
MATERIALS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATERIALS)


class Node:
    def __init__(self, kind, name="", **parameters):
        self.kind = kind
        self.name = name
        self.parameters = parameters
        self.shaders = []
        self.sibling = None
        self.removed = False

    def __getitem__(self, key):
        return self.parameters.get(key)

    def __setitem__(self, key, value):
        self.parameters[key] = value

    def CheckType(self, kind):
        return self.kind == kind

    def SetName(self, name):
        self.name = name

    def GetName(self):
        return self.name

    def InsertShader(self, shader):
        if self.shaders:
            self.shaders[-1].sibling = shader
        self.shaders.append(shader)

    def GetFirstShader(self):
        return self.shaders[0] if self.shaders else None

    def GetDown(self):
        return self.GetFirstShader()

    def GetNext(self):
        return self.sibling

    def Remove(self):
        self.removed = True


class TextureTag(Node):
    def __init__(self, material):
        super().__init__("Ttexture")
        self.material = material

    def GetMaterial(self):
        return self.material

    def SetMaterial(self, material):
        self.material = material


class TextureTests(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        self.export = self.root / "cache" / "scene.fbx"
        self.source = self.root / "source" / "scene.max"
        self.project = self.root / "project"
        for directory in (self.export.parent, self.source.parent, self.project):
            directory.mkdir()

    def image(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"bitmap path fixture only")
        return str(path.resolve())

    def test_embedded_then_source_fallback_and_exact_references(self):
        packaged = self.image(self.export.with_suffix(".fbm") / "中文.jpg")
        original = self.image(self.source.parent / "maps" / "木材" / "中文.jpg")
        project_media = self.image(self.project / "scene_fbm" / "nested" / "normal.png")
        resolve = MATERIALS._texture_resolver(self.export, self.source, str(self.project))
        self.assertEqual(resolve("中文.jpg"), packaged)
        self.assertEqual(resolve(r"maps\木材\中文.jpg"), original)
        self.assertEqual(resolve(r"scene_fbm\nested\normal.png"), project_media)
        self.assertIsNone(resolve("../source/maps/木材/中文.jpg"))

    def test_nested_unique_old_reference_and_ambiguous_basenames(self):
        original = self.image(self.source.parent / "maps_baked" / "子文件夹" / "albedo.jpg")
        self.image(self.source.parent / "maps" / "a" / "same.png")
        self.image(self.source.parent / "textures" / "b" / "same.png")
        resolve = MATERIALS._texture_resolver(self.export, self.source)
        self.assertEqual(resolve(r"Q:\Unknown\albedo.jpg"), original)
        self.assertIsNone(resolve("same.png"))
        self.assertIsNone(MATERIALS._texture_resolver(self.export, None)("albedo.jpg"))

    def test_legacy_standard_materials_keep_valid_slots_and_recover_nearby_maps(self):
        authored = self.image(self.export.parent / "native.png")
        recovered = self.image(self.export.parent / "tex" / "wood.png")
        new_color = self.image(self.export.parent / "tex" / "metal_color.png")
        normal = self.image(self.export.parent / "tex" / "wood_normal_dx.png")
        unrelated = self.image(self.export.parent / "tex" / "scene_color.png")
        emission = self.image(self.source.parent / "maps" / "wood_emission.png")
        baked_normal = self.image(self.source.parent / "maps_baked" / "mat_unmatched_normal.png")
        wood = Node("Mmaterial", "Wood", MATERIAL_USE_COLOR=True)
        wood_color = Node("Xbitmap", BITMAPSHADER_FILENAME="wood.png")
        wood["MATERIAL_COLOR_SHADER"] = wood_color
        wood.InsertShader(wood_color)
        metal = Node("Mmaterial", "Metal")
        metal_color = Node("Xbitmap", BITMAPSHADER_FILENAME=authored)
        metal["MATERIAL_COLOR_SHADER"] = metal_color
        metal.InsertShader(metal_color)
        unnamed = Node("Mmaterial", "Unmatched")
        for material in (wood, metal, unnamed):
            material.Message = lambda *_: None
        constants = ("Xbitmap BITMAPSHADER_FILENAME BITMAPSHADER_COLORPROFILE BITMAPSHADER_COLORPROFILE_LINEAR "
                     "BITMAPSHADER_COLORPROFILE_SRGB Mmaterial MSG_UPDATE MATERIAL_USE_COLOR MATERIAL_COLOR_SHADER "
                     "MATERIAL_USE_DIFFUSION MATERIAL_DIFFUSION_SHADER MATERIAL_USE_BUMP MATERIAL_BUMP_SHADER "
                     "MATERIAL_USE_NORMAL MATERIAL_NORMAL_SHADER MATERIAL_NORMAL_REVERSEY MATERIAL_USE_ALPHA "
                     "MATERIAL_ALPHA_SHADER MATERIAL_USE_LUMINANCE MATERIAL_LUMINANCE_SHADER "
                     "MATERIAL_USE_DISPLACEMENT MATERIAL_DISPLACEMENT_SHADER REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS "
                     "REFLECTION_LAYER_MAIN_SHADER_SPECULAR REFLECTION_LAYER_MAIN_SHADER_REFLECTION")
        c4d = SimpleNamespace(**{key: key for key in constants.split()}, BaseShader=Node)
        doc = SimpleNamespace(GetDocumentPath=lambda: str(self.project))
        report = MATERIALS.link_standard_scene_textures(
            c4d, doc, [wood, metal, unnamed], {
                "path": str(self.export),
                "source_path": str(self.source),
                "maps": {"base_color": unrelated},
                "named_material_maps": {("wood",): {"normal": normal}, ("metal",): {"base_color": new_color}},
                "scene_material_maps": {
                    "Wood": {"emission": emission, "normal": str(self.source.parent / "missing.png")},
                    "Metal": {"base_color": new_color},
                },
                "baked_material_maps": {"unmatched": {"normal": baked_normal}},
            }, lambda name: (name.casefold(),),
        )
        self.assertIn("关联 4 项贴图", report)
        self.assertEqual(wood_color["BITMAPSHADER_FILENAME"], recovered)
        self.assertEqual(wood["MATERIAL_NORMAL_SHADER"]["BITMAPSHADER_FILENAME"], normal)
        self.assertTrue(wood["MATERIAL_NORMAL_REVERSEY"])
        self.assertEqual(wood["MATERIAL_LUMINANCE_SHADER"]["BITMAPSHADER_FILENAME"], emission)
        self.assertEqual(metal_color["BITMAPSHADER_FILENAME"], authored)
        self.assertIsNone(unnamed["MATERIAL_COLOR_SHADER"])
        self.assertEqual(unnamed["MATERIAL_NORMAL_SHADER"]["BITMAPSHADER_FILENAME"], baked_normal)
        duplicate_wood = Node("Mmaterial", "Wood")
        duplicate_report = MATERIALS.link_standard_scene_textures(c4d, doc, [wood, duplicate_wood], {
            "path": str(self.export),
            "source_path": str(self.source),
            "scene_material_maps": {"Wood": {"emission": emission}},
        })
        self.assertEqual(duplicate_report, "")
        self.assertIsNone(duplicate_wood["MATERIAL_LUMINANCE_SHADER"])

    def test_baked_map_ids_are_unique_within_the_source_material_family(self):
        plan = {
            "source_path": "现代别墅C-TX.max",
            "baked_material_maps": {"c0001": {"base_color": "one.jpg"}, "c0002": {"bump": "two.png"}},
        }
        labels = ["现代别墅C0001", "现代别墅C0001.001", "现代别墅C0002", "其他C0002", "现代别墅C0002_other"]
        self.assertEqual(MATERIALS._baked_material_channels(plan, labels), {"现代别墅C0002": {"bump": "two.png"}})

    def test_unresolved_and_unsupported_textures_keep_material_assignments(self):
        tree = self.export.with_suffix(".fbm")
        base = self.image(tree / "base.png")
        normal = self.image(tree / "normal.png")
        supported = Node("Mmaterial", "现代别墅C0001", MATERIAL_USE_COLOR=True, MATERIAL_USE_NORMAL=True)
        supported["MATERIAL_COLOR_SHADER"] = Node("Xbitmap", BITMAPSHADER_FILENAME="scene.fbm/base.png")
        supported["MATERIAL_NORMAL_SHADER"] = Node("Xbitmap", BITMAPSHADER_FILENAME="normal.png")
        for key in ("MATERIAL_COLOR_SHADER", "MATERIAL_NORMAL_SHADER"):
            supported.InsertShader(supported[key])
        incomplete = Node("Mmaterial", "Unresolved", MATERIAL_USE_COLOR=True, MATERIAL_USE_NORMAL=True)
        incomplete["MATERIAL_COLOR_SHADER"] = Node("Xbitmap", BITMAPSHADER_FILENAME="base.png")
        incomplete["MATERIAL_NORMAL_SHADER"] = Node("Xbitmap", BITMAPSHADER_FILENAME="missing.png")
        unsupported = Node("Mmaterial", "Unsupported")
        unsupported.InsertShader(Node("Xbitmap", BITMAPSHADER_FILENAME="normal.png"))
        solid = Node("Mmaterial", "现代别墅C0002", MATERIAL_USE_COLOR=True, MATERIAL_COLOR_COLOR=(1, 0, 0))
        baked = self.image(self.source.parent / "maps_baked" / "mat_C0002_diffuse.png")
        originals = [supported, incomplete, unsupported, solid]
        tags = [TextureTag(material) for material in originals]
        obj = SimpleNamespace(GetTags=lambda: tags)
        inserted = []
        doc = SimpleNamespace(InsertMaterial=inserted.append, GetDocumentPath=lambda: str(self.project))
        constants = ("Xbitmap BITMAPSHADER_FILENAME Mmaterial Ttexture MATERIAL_USE_COLOR MATERIAL_COLOR_SHADER "
                     "MATERIAL_USE_DIFFUSION MATERIAL_DIFFUSION_SHADER MATERIAL_USE_BUMP MATERIAL_BUMP_SHADER "
                     "MATERIAL_USE_NORMAL MATERIAL_NORMAL_SHADER MATERIAL_USE_ALPHA MATERIAL_ALPHA_SHADER "
                     "MATERIAL_USE_LUMINANCE MATERIAL_LUMINANCE_SHADER MATERIAL_USE_DISPLACEMENT "
                     "MATERIAL_DISPLACEMENT_SHADER MATERIAL_USE_REFLECTION MATERIAL_COLOR_COLOR")
        c4d = SimpleNamespace(**{key: key for key in constants.split()}, BaseMaterial=Node, BaseShader=Node)
        with patch.object(MATERIALS, "wants_octane", return_value=True), patch.object(MATERIALS, "_renderer"):
            report = MATERIALS.convert_octane(
                c4d, doc, originals, [obj], {
                    "path": str(self.export), "renderer": "octane", "source_path": "现代别墅C-TX.max",
                    "baked_material_maps": {"c0001": {"base_color": baked, "bump": baked}, "c0002": {"base_color": baked}},
                }
            )
        self.assertIn("已转换 2 个 Octane 材质，连接 3 个实际贴图通道", report)
        self.assertIn("从目录补接 1 个烘焙贴图通道", report)
        self.assertIn("2 个材质保留原材质和对象绑定", report)
        self.assertEqual([tag.GetMaterial() for tag in tags], [inserted[0], incomplete, unsupported, inserted[1]])
        self.assertEqual([material.removed for material in originals], [True, False, False, True])
        file_id = MATERIALS._OCT_SYMBOLS["IMAGETEXTURE_FILE"]
        for slot, expected in (("OCT_MATERIAL_DIFFUSE_LINK", base), ("OCT_MATERIAL_NORMAL_LINK", normal)):
            self.assertEqual(inserted[0][MATERIALS._OCT_SYMBOLS[slot]][file_id], expected)
        self.assertEqual(inserted[1][MATERIALS._OCT_SYMBOLS["OCT_MATERIAL_DIFFUSE_LINK"]][file_id], baked)


class StandardBatchScalarTests(unittest.TestCase):
    def setUp(self):
        constants = (
            "Mmaterial Xbitmap MSG_UPDATE BITMAPSHADER_FILENAME MATERIAL_COLOR_COLOR MATERIAL_USE_COLOR "
            "MATERIAL_USE_REFLECTION MATERIAL_BUMP_SHADER MATERIAL_USE_BUMP "
            "MATERIAL_BUMP_STRENGTH MATERIAL_NORMAL_SHADER MATERIAL_USE_NORMAL MATERIAL_NORMAL_STRENGTH "
            "REFLECTION_DISTRIBUTION_GGX REFLECTION_FRESNEL_DIELECTRIC REFLECTION_FRESNEL_DIELECTRIC_CUSTOM "
            "REFLECTION_FRESNEL_CONDUCTOR"
        )
        layer_constants = (
            "REFLECTION_LAYER_MAIN_DISTRIBUTION REFLECTION_LAYER_MAIN_VALUE_SPECULAR "
            "REFLECTION_LAYER_MAIN_SHADER_SPECULAR REFLECTION_LAYER_MAIN_VALUE_ROUGHNESS "
            "REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS REFLECTION_LAYER_FRESNEL_MODE "
            "REFLECTION_LAYER_FRESNEL_SHADER_IOR REFLECTION_LAYER_FRESNEL_PRESET REFLECTION_LAYER_FRESNEL_VALUE_IOR"
        )
        self.c4d = SimpleNamespace(**{key: key for key in constants.split()},
                                   **{key: i for i, key in enumerate(layer_constants.split())},
                                   BaseShader=Node, Vector=lambda *values: values)
        self.layer_id = 5000

    def material(self, name, count=1):
        material = Node("Mmaterial", name)
        material.GetReflectionLayerCount = lambda: count
        layer = SimpleNamespace(GetDataID=lambda: self.layer_id)
        material.GetReflectionLayerIndex = lambda _: layer
        material.AddReflectionLayer = lambda: layer
        material.Message = lambda _: None
        return material

    def test_classic_batch_restores_validated_values_and_exact_map_strength(self):
        c4d = self.c4d
        material = self.material("Leaf")
        normal_path = str(Path.cwd() / "maps" / "leaf_normal.png")
        bump_path = str(Path.cwd() / "maps" / "leaf_bump.png")
        other_bump = str(Path.cwd() / "other" / "leaf_bump.png")
        material[c4d.MATERIAL_USE_NORMAL] = True
        material[c4d.MATERIAL_NORMAL_SHADER] = Node(c4d.Xbitmap, BITMAPSHADER_FILENAME=normal_path)
        material[c4d.MATERIAL_USE_BUMP] = True
        material[c4d.MATERIAL_BUMP_SHADER] = Node(c4d.Xbitmap, BITMAPSHADER_FILENAME=other_bump)
        plan = {"max_batch_material_settings": {"Leaf": {
            "base_color": [0.24, 0.48, 0.13],
            "specular_strength": 0.55, "roughness": 0.35, "ior": 1.45,
            "normal_strength": 0.3, "normal_map": normal_path,
            "bump_strength": 0.2, "bump_map": bump_path,
        }}}
        text = MATERIALS.apply_max_batch_material_settings(c4d, [material], plan)
        self.assertIn("1 个", text)
        self.assertEqual(material[c4d.MATERIAL_COLOR_COLOR], (0.24, 0.48, 0.13))
        self.assertEqual(material[c4d.MATERIAL_NORMAL_STRENGTH], 0.3)
        self.assertIsNone(material[c4d.MATERIAL_BUMP_STRENGTH])
        self.assertEqual(material[self.layer_id + c4d.REFLECTION_LAYER_MAIN_VALUE_ROUGHNESS], 0.35)
        self.assertEqual(material[self.layer_id + c4d.REFLECTION_LAYER_MAIN_VALUE_SPECULAR], 0.55)
        self.assertEqual(material[self.layer_id + c4d.REFLECTION_LAYER_FRESNEL_VALUE_IOR], 1.45)

    def test_classic_batch_retains_connected_graphs_and_ambiguous_or_invalid_values(self):
        c4d = self.c4d
        material = self.material("Leaf")
        material[self.layer_id + c4d.REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS] = roughness = Node(c4d.Xbitmap)
        material[self.layer_id + c4d.REFLECTION_LAYER_FRESNEL_MODE] = c4d.REFLECTION_FRESNEL_CONDUCTOR
        repeated = [self.material("Duplicate"), self.material("Duplicate")]
        plan = {"max_batch_material_settings": {
            "Leaf": {"base_color": [-1.0, 0.2, 0.3], "roughness": 0.2, "ior": 1.5},
            "Duplicate": {"base_color": [0.2, 0.3, 0.4]},
        }}
        self.assertEqual(MATERIALS.apply_max_batch_material_settings(c4d, [material, *repeated], plan), "")
        self.assertIs(material[self.layer_id + c4d.REFLECTION_LAYER_MAIN_SHADER_ROUGHNESS], roughness)
        self.assertEqual(material[self.layer_id + c4d.REFLECTION_LAYER_FRESNEL_MODE], c4d.REFLECTION_FRESNEL_CONDUCTOR)
        for item in [material, *repeated]:
            self.assertIsNone(item[c4d.MATERIAL_COLOR_COLOR])


class OctaneScalarTests(unittest.TestCase):
    def setUp(self):
        self.c4d = SimpleNamespace(BaseMaterial=Node, BaseShader=Node, Vector=lambda *values: values)
        self.ids = MATERIALS._OCT_SYMBOLS

    def test_authored_scene_bindings_fill_only_missing_channels_of_the_exact_material(self):
        c4d = SimpleNamespace(Mmaterial="native", Ttexture="texture")
        material = Node("native", "Surface")
        unbound = Node("native", "Surface.C002")
        names = []
        doc = SimpleNamespace(InsertMaterial=lambda _mat: None, GetDocumentPath=lambda: "")
        plan = {"path":"scene.fbx", "renderer":"octane", "scene_material_maps": {
            "Surface": {"base_color":"original.png", "roughness":"roughness.png", "normal":"normal.png"}}}

        def build(_c4d, name, channels, **_kwargs):
            names.append((name, dict(channels)))
            return Node("octane"), []

        def imported(_c4d, node, _resolve):
            channels = {"base_color":"embedded.png"}
            if node == material:
                channels["bump"] = "normal.png"
            return channels, None, None, 0

        with patch.object(MATERIALS, "wants_octane", return_value=True), patch.object(MATERIALS, "_renderer"), \
                patch.object(MATERIALS, "_imported_octane_settings", return_value={}), \
                patch.object(MATERIALS, "_imported_standard_channels", side_effect=imported), \
                patch.object(MATERIALS, "_oct_material", side_effect=build):
            report = MATERIALS.convert_octane(c4d, doc, [material, unbound], [], plan)
            self.assertIn("从源材质补接 1 个贴图通道", report)
            self.assertEqual(names, [("Surface", {"base_color":"embedded.png", "roughness":"roughness.png",
                                                  "normal":"normal.png"}),
                                     ("Surface.C002", {"base_color":"embedded.png"})])
            names.clear()
            plan["scene_import"] = {"textures":False}
            MATERIALS.convert_octane(c4d, doc, [material], [], plan)
        self.assertEqual(names, [("Surface", {"base_color":"embedded.png", "bump":"normal.png"})])

    def value(self, node, name):
        return node[self.ids[name]]

    def test_corona_front_back_graph_keeps_color_and_cutout_separate(self):
        front = ("mix", ("image", "front.jpg", None), ("image", "tint.jpg", None), 0.35)
        back = ("image", "back.jpg", None)
        channels = {"base_color": ("side", front, back), "opacity": "cutout.png",
                    "glossiness": ("side", ("image", "gloss_front.png", None),
                                   ("image", "gloss_back.png", None))}
        mat, notes = MATERIALS._oct_material(self.c4d, "Leaves", channels)
        self.assertEqual(notes, [])
        albedo = self.value(mat, "OCT_MATERIAL_DIFFUSE_LINK")
        side = self.value(albedo, "MIXTEX_AMOUNT_LNK")
        self.assertEqual(side.kind, MATERIALS._OCT_SIDE)
        self.assertIs(self.value(side, "SIDE_INVERT"), False)
        self.assertEqual(self.value(self.value(albedo, "MIXTEX_TEXTURE1_LNK"), "IMAGETEXTURE_FILE"), "back.jpg")
        front_mix = self.value(albedo, "MIXTEX_TEXTURE2_LNK")
        self.assertAlmostEqual(self.value(front_mix, "MIXTEX_AMOUNT_FLOAT"), 0.35)
        front_image = self.value(front_mix, "MIXTEX_TEXTURE1_LNK")
        self.assertEqual(self.value(front_image, "IMAGETEXTURE_FILE"), "front.jpg")
        self.assertEqual(self.value(front_image, "IMAGETEX_COLOR_SPACE"), self.ids["IMAGETEX_CS_SRGB"])
        cutout = self.value(mat, "OCT_MATERIAL_OPACITY_LINK")
        self.assertEqual(self.value(cutout, "IMAGETEXTURE_FILE"), "cutout.png")
        self.assertEqual(self.value(cutout, "IMAGETEX_COLOR_SPACE"), self.ids["IMAGETEX_CS_NONE"])
        self.assertEqual(self.value(cutout, "IMAGETEXTURE_MODE"), self.ids["IMAGETEXTURE_MODE2"])
        roughness = self.value(mat, "OCT_MATERIAL_ROUGHNESS_LINK")
        for slot in ("MIXTEX_TEXTURE1_LNK", "MIXTEX_TEXTURE2_LNK"):
            self.assertIs(self.value(self.value(roughness, slot), "IMAGETEXTURE_INVERT"), True)

    def test_octane_without_polygon_side_uses_the_source_front_image(self):
        self.c4d.BaseShader = lambda kind: None if kind == MATERIALS._OCT_SIDE else Node(kind)
        graph = ("side", ("image", "front.jpg", None), ("image", "back.jpg", None))
        mat, notes = MATERIALS._oct_material(self.c4d, "Leaves", {"base_color": graph})
        self.assertIn("已使用正面贴图", notes[0])
        albedo = self.value(mat, "OCT_MATERIAL_DIFFUSE_LINK")
        self.assertEqual(self.value(albedo, "IMAGETEXTURE_FILE"), "front.jpg")

    def test_octane_applies_authored_graph_and_honors_texture_option(self):
        self.c4d.Mmaterial = "classic"
        self.c4d.Ttexture = "texture"
        material = Node("classic", "huahuatan0099.1")
        produced = []
        doc = SimpleNamespace(InsertMaterial=produced.append, GetDocumentPath=lambda: "")
        graph = ("side", ("image", "front.jpg", None), ("image", "back.jpg", None))
        plan = {"path": "plants.fbx", "renderer": "octane", "max_batch_material_settings": {
            "huahuatan0099.1": {"texture_graphs": {"base_color": graph},
                                 "approximate_texture_channels": ("base_color",)},
        }}
        with patch.object(MATERIALS, "wants_octane", return_value=True), patch.object(MATERIALS, "_renderer"), \
                patch.object(MATERIALS, "_imported_octane_settings", return_value={}), \
                patch.object(MATERIALS, "_imported_standard_channels", side_effect=lambda *_: (
                    {"opacity": "f7129.jpg"}, None, None, 0,
                )):
            report = MATERIALS.convert_octane(self.c4d, doc, [material], [], plan)
            self.assertIn("已使用可识别的原贴图近似", report)
            self.assertIsNotNone(self.value(produced[-1], "OCT_MATERIAL_DIFFUSE_LINK"))
            self.assertEqual(self.value(self.value(produced[-1], "OCT_MATERIAL_OPACITY_LINK"), "IMAGETEXTURE_FILE"),
                             "f7129.jpg")
            plan["scene_import"] = {"textures": False}
            report = MATERIALS.convert_octane(self.c4d, doc, [material], [], plan)
        self.assertNotIn("已使用可识别的原贴图近似", report)
        self.assertIsNone(self.value(produced[-1], "OCT_MATERIAL_DIFFUSE_LINK"))

    def test_octane_uses_authored_image_alpha_only_on_the_exact_opacity_file(self):
        self.c4d.Mmaterial = "classic"
        self.c4d.Ttexture = "texture"
        original = Node("classic", "Flower1")
        produced = []
        doc = SimpleNamespace(InsertMaterial=produced.append, GetDocumentPath=lambda: "")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            albedo = str(root / "albedo" / "f7186.png")
            alpha = str(root / "alpha" / "f7186.png")
            other = str(root / "other" / "f7186.png")
            plan = {"path": str(root / "plants.fbx"), "renderer": "octane", "max_batch_material_settings": {
                "Flower1": {"opacity_alpha_map": alpha},
            }}
            for chosen, mode in ((alpha, "IMAGETEXTURE_MODE3"), (other, "IMAGETEXTURE_MODE2")):
                with self.subTest(chosen=chosen), patch.object(MATERIALS, "wants_octane", return_value=True), \
                        patch.object(MATERIALS, "_renderer"), \
                        patch.object(MATERIALS, "_imported_octane_settings", side_effect=lambda *_: {}), \
                        patch.object(MATERIALS, "_imported_standard_channels", return_value=(
                            {"base_color": albedo, "opacity": chosen}, None, None, 0,
                        )):
                    MATERIALS.convert_octane(self.c4d, doc, [original], [], plan)
                    mat = produced[-1]
                    self.assertIsNone(self.value(self.value(mat, "OCT_MATERIAL_DIFFUSE_LINK"), "IMAGETEXTURE_MODE"))
                    self.assertEqual(self.value(self.value(mat, "OCT_MATERIAL_OPACITY_LINK"), "IMAGETEXTURE_MODE"),
                                     self.ids[mode])

    def test_octane_preserves_explicit_c4d_image_alpha_when_the_file_has_it(self):
        for key in ("Mmaterial", "Ttexture", "MATERIAL_USE_ALPHA", "MATERIAL_ALPHA_IMAGEALPHA",
                    "MATERIAL_ALPHA_SHADER", "BITMAPSHADER_FILENAME", "Xbitmap"):
            setattr(self.c4d, key, key)
        self.c4d.IMAGERESULT_OK = 0
        produced = []
        doc = SimpleNamespace(InsertMaterial=produced.append, GetDocumentPath=lambda: "")
        with tempfile.TemporaryDirectory() as directory:
            path = (Path(directory) / "cutout.png").resolve()
            path.touch()
            original = Node(self.c4d.Mmaterial, "Flower1", MATERIAL_USE_ALPHA=True, MATERIAL_ALPHA_IMAGEALPHA=True,
                            MATERIAL_ALPHA_SHADER=Node(self.c4d.Xbitmap, BITMAPSHADER_FILENAME=str(path)))
            image = SimpleNamespace(InitWith=lambda _path: (0, False))
            self.c4d.bitmaps = SimpleNamespace(BaseBitmap=lambda: image)
            plan = {"path": str(path.parent / "plants.fbx"), "renderer": "octane"}
            for alpha, mode in ((object(), "IMAGETEXTURE_MODE3"), (None, "IMAGETEXTURE_MODE2")):
                image.GetInternalChannel = lambda: alpha
                with patch.object(MATERIALS, "wants_octane", return_value=True), patch.object(MATERIALS, "_renderer"), \
                        patch.object(MATERIALS, "_imported_octane_settings", side_effect=lambda *_: {}), \
                        patch.object(MATERIALS, "_imported_standard_channels", return_value=(
                            {"opacity": str(path)}, None, None, 0,
                        )):
                    MATERIALS.convert_octane(self.c4d, doc, [original], [], plan)
                self.assertEqual(self.value(self.value(produced[-1], "OCT_MATERIAL_OPACITY_LINK"), "IMAGETEXTURE_MODE"),
                                 self.ids[mode])

    def test_scalar_and_image_inputs_preserve_albedo_bump_and_specular_levels(self):
        mat, _ = MATERIALS._oct_material(
            self.c4d, "room", {"base_color": "albedo.jpg", "bump": "bump.png", "normal": "normal.png"},
            settings={"diffuse_strength": 0.4, "bump_strength": 0.2, "specular_strength": 0.6,
                      "normal_strength": 0.3, "metallic": 0.15, "ior": 1.52},
        )
        self.assertEqual(self.value(mat, "OCT_MATERIAL_SPECULAR_FLOAT"), 0.6)
        self.assertEqual(self.value(mat, "OCT_MAT_SPECULAR_MAP_FLOAT"), 0.15)
        self.assertEqual(self.value(mat, "OCT_MATERIAL_INDEX"), 1.52)
        for slot, filename, power in (("OCT_MATERIAL_DIFFUSE_LINK", "albedo.jpg", 0.4),
                                      ("OCT_MATERIAL_BUMP_LINK", "bump.png", 0.2)):
            node = self.value(mat, slot)
            self.assertEqual(self.value(node, "IMAGETEXTURE_FILE"), filename)
            self.assertEqual(self.value(node, "IMAGETEXTURE_POWER_FLOAT"), power)
        mix = self.value(mat, "OCT_MATERIAL_NORMAL_LINK")
        self.assertEqual(mix.kind, MATERIALS._OCT_MIX)
        self.assertEqual(self.value(mix, "MIXTEX_AMOUNT_FLOAT"), 0.3)
        neutral = self.value(mix, "MIXTEX_TEXTURE1_LNK")
        data = self.value(mix, "MIXTEX_TEXTURE2_LNK")
        self.assertEqual(self.value(neutral, "RGBSPECTRUMSHADER_COLOR"), (0.5, 0.5, 1.0))
        self.assertEqual(self.value(data, "IMAGETEXTURE_FILE"), "normal.png")
        self.assertIsNone(self.value(data, "IMAGETEXTURE_POWER_FLOAT"))

    def test_normal_texture_stays_direct_at_full_strength_and_linked_maps_win(self):
        for strength in (1.0, 1.5):
            with self.subTest(strength=strength):
                mat, warnings = MATERIALS._oct_material(
                    self.c4d, "room", {"normal": "normal.png", "specular": "reflection.png",
                                       "metallic": "metal.png", "roughness": "rough.png"},
                    settings={"normal_strength": strength, "specular_strength": 0.7, "metallic": 0.3,
                              "roughness": 0.2},
                )
                self.assertEqual(self.value(self.value(mat, "OCT_MATERIAL_NORMAL_LINK"), "IMAGETEXTURE_FILE"), "normal.png")
                self.assertEqual(bool(warnings), strength > 1)
                self.assertIsNone(self.value(mat, "OCT_MATERIAL_SPECULAR_FLOAT"))
                self.assertIsNone(self.value(mat, "OCT_MAT_SPECULAR_MAP_FLOAT"))
                self.assertIsNone(self.value(mat, "OCT_MATERIAL_ROUGHNESS_FLOAT"))
                spec = self.value(mat, "OCT_MATERIAL_SPECULAR_LINK")
                self.assertEqual(self.value(spec, "IMAGETEXTURE_FILE"), "reflection.png")
                self.assertEqual(self.value(spec, "IMAGETEXTURE_POWER_FLOAT"), 0.7)

    def test_exact_source_matches_normal_basename_and_precedes_classic_layer_values(self):
        c4d = SimpleNamespace(MATERIAL_USE_COLOR="color", MATERIAL_USE_REFLECTION="reflection",
                              MATERIAL_COLOR_BRIGHTNESS="diffuse", MATERIAL_NORMAL_STRENGTH="normal",
                              MATERIAL_NORMAL_SPACE="space", MATERIAL_NORMAL_SPACE_TANGENT=0,
                              REFLECTION_LAYER_MAIN_VALUE_SPECULAR=10, REFLECTION_LAYER_FRESNEL_MODE=12,
                              REFLECTION_LAYER_FRESNEL_VALUE_IOR=13, REFLECTION_FRESNEL_DIELECTRIC=1)
        original = Node("classic", color=True, reflection=True, diffuse=0.5, normal=0.6, space=0)
        original.GetReflectionLayerCount = lambda: 1
        original.GetReflectionLayerIndex = lambda _index: SimpleNamespace(GetDataID=lambda: 5000)
        original[5010], original[5012], original[5013] = 0.45, 1, 1.4
        source = {"specular_strength": 0.2, "normal_strength": 0.3, "normal_map": "ORIGINAL.PNG",
                  "metallic": 0.1, "ior": 1.7}
        settings = MATERIALS._imported_octane_settings(c4d, original, {"normal": "other.png"}, source)
        self.assertEqual(settings, {"diffuse_strength": 0.5, "normal_strength": 0.6,
                                    "specular_strength": 0.2, "metallic": 0.1, "ior": 1.7})
        settings = MATERIALS._imported_octane_settings(c4d, original, {"normal": "maps/original.png"}, source)
        self.assertEqual(settings["normal_strength"], 0.3)
        native = MATERIALS._imported_octane_settings(c4d, original, {"normal": "other.png"}, {})
        self.assertEqual((native["specular_strength"], native["ior"]), (0.45, 1.4))

    def test_nonfunctional_octane_scalar_is_detected_on_readback(self):
        class RejectedNode(Node):
            def __setitem__(self, key, value):
                pass

        with self.assertRaisesRegex(RuntimeError, "OCT_MATERIAL_SPECULAR_FLOAT"):
            MATERIALS._oct_scalar(self.c4d, RejectedNode("octane"), "OCT_MATERIAL_SPECULAR_FLOAT", 0.25)

    def test_unique_verified_source_normal_is_recovered_from_imported_bump_slot(self):
        self.c4d.Mmaterial = "Mmaterial"
        self.c4d.Ttexture = "Ttexture"
        self.c4d.MATERIAL_USE_COLOR = "color"
        self.c4d.MATERIAL_USE_REFLECTION = "reflection"
        original = Node("Mmaterial", "room")
        tag = TextureTag(original)
        obj = SimpleNamespace(GetTags=lambda: [tag])
        replacements = []
        doc = SimpleNamespace(InsertMaterial=replacements.append, GetDocumentPath=lambda: "")
        plan = {"path": "scene.fbx", "renderer": "octane", "max_material_settings": {
            "room": {"normal_map": "NORMAL.PNG", "normal_strength": 0.65, "roughness": 0.38}
        }}
        with patch.object(MATERIALS, "wants_octane", return_value=True), patch.object(MATERIALS, "_renderer"), \
             patch.object(MATERIALS, "_imported_standard_channels", return_value=({"bump": "tex/normal.png"}, None, 0.1, 0)):
            MATERIALS.convert_octane(self.c4d, doc, [original], [obj], plan)
        mat = replacements[0]
        self.assertIs(tag.GetMaterial(), mat)
        self.assertIsNone(self.value(mat, "OCT_MATERIAL_BUMP_LINK"))
        self.assertEqual(self.value(mat, "OCT_MATERIAL_ROUGHNESS_FLOAT"), 0.38)
        mix = self.value(mat, "OCT_MATERIAL_NORMAL_LINK")
        self.assertEqual(self.value(mix, "MIXTEX_AMOUNT_FLOAT"), 0.65)
        self.assertEqual(self.value(self.value(mix, "MIXTEX_TEXTURE2_LNK"), "IMAGETEXTURE_FILE"), "tex/normal.png")

    def test_vray_batch_values_and_glossiness_are_mapped_to_octane(self):
        self.c4d.Mmaterial = "Mmaterial"
        self.c4d.MATERIAL_USE_COLOR = "color"
        self.c4d.MATERIAL_USE_REFLECTION = "reflection"
        self.c4d.Ttexture = "texture"
        textured = Node("Mmaterial", "textured")
        constant = Node("Mmaterial", "constant")
        normal = str(Path.cwd() / "reference" / "normal.png")
        bump = str(Path.cwd() / "reference" / "bump.png")
        other_bump = str(Path.cwd() / "unrelated" / "bump.png")
        replacements = []
        doc = SimpleNamespace(InsertMaterial=replacements.append, GetDocumentPath=lambda: "")
        plan = {"path": "scene.fbx", "renderer": "octane", "scene_material_maps": {
            "textured": {"glossiness": "gloss.png", "normal": normal, "bump": other_bump},
        }, "max_batch_material_settings": {
            "textured": {"normal_map": normal, "normal_strength": 0.35, "bump_map": bump,
                         "bump_strength": 0.2, "roughness": 0.55, "metallic": 0.25, "ior": 1.52},
            "constant": {"base_color": (0.1, 0.2, 0.3), "roughness": 0.2, "specular_strength": 0.5,
                         "opacity": 0.6},
        }}
        with patch.object(MATERIALS, "wants_octane", return_value=True), patch.object(MATERIALS, "_renderer"), \
             patch.object(MATERIALS, "_imported_standard_channels", side_effect=lambda *_: ({}, None, 0.8, 0)):
            MATERIALS.convert_octane(self.c4d, doc, [textured, constant], [], plan)

        leaf, solid = replacements
        roughness = self.value(leaf, "OCT_MATERIAL_ROUGHNESS_LINK")
        self.assertEqual(self.value(roughness, "IMAGETEXTURE_FILE"), "gloss.png")
        self.assertTrue(self.value(roughness, "IMAGETEXTURE_INVERT"))
        self.assertEqual(self.value(leaf, "OCT_MAT_SPECULAR_MAP_FLOAT"), 0.25)
        self.assertEqual(self.value(leaf, "OCT_MATERIAL_INDEX"), 1.52)
        self.assertEqual(self.value(self.value(leaf, "OCT_MATERIAL_NORMAL_LINK"), "MIXTEX_AMOUNT_FLOAT"), 0.35)
        self.assertIsNone(self.value(self.value(leaf, "OCT_MATERIAL_BUMP_LINK"), "IMAGETEXTURE_POWER_FLOAT"))
        self.assertEqual(self.value(solid, "OCT_MATERIAL_DIFFUSE_COLOR"), (0.1, 0.2, 0.3))
        self.assertEqual(self.value(solid, "OCT_MATERIAL_ROUGHNESS_FLOAT"), 0.2)
        self.assertEqual(self.value(solid, "OCT_MATERIAL_SPECULAR_FLOAT"), 0.5)
        self.assertEqual(self.value(solid, "OCT_MATERIAL_OPACITY_FLOAT"), 0.6)


class LightVector(tuple):
    def __new__(cls, *values):
        return super().__new__(cls, values)

    def GetLength(self):
        return math.hypot(*self)

    def Dot(self, other):
        return sum(left * right for left, right in zip(self, other))

    def __mul__(self, scalar):
        return LightVector(*(value * scalar for value in self))

    def __sub__(self, other):
        return LightVector(*(left - right for left, right in zip(self, other)))


class OctaneSceneLightTests(unittest.TestCase):
    class Light(Node):
        def __init__(self, scale, name="Corona Light"):
            super().__init__("light", name, type="omni", brightness=1.0, show_illumination=True,
                             show_visible=True, show_clipping=True, show_solid=True, falloff_distance=2500.0)
            axes = [LightVector(scale[0], 0, 0), LightVector(0, scale[1], 0), LightVector(0, 0, scale[2])]
            self.matrix = SimpleNamespace(off=LightVector(2, 4, 8), v1=axes[0], v2=axes[1], v3=axes[2])
            self.tags = {}
            self.children = []
            self.tracks = []
            self.world_sets = []

        def GetMg(self):
            return self.matrix

        def SetMg(self, matrix):
            self.matrix = matrix
            self.world_sets.append(matrix)

        def GetMl(self):
            return self.matrix

        def SetMl(self, matrix):
            self.matrix = matrix

        def GetChildren(self):
            return self.children

        def GetCTracks(self):
            return self.tracks

        def GetUp(self):
            return None

        def GetTag(self, kind):
            return self.tags.get(kind)

        def InsertTag(self, tag):
            self.tags[tag.kind] = tag

    def setUp(self):
        self.fields = MATERIALS._OCT_LIGHT_FIELDS

        def new_tag(kind):
            tag = Node(kind)
            tag[self.fields["LIGHTTAG_POWER"]] = 100.0
            tag[self.fields["LIGHTTAG_SURFACE_BRIGHTNESS"]] = True
            tag[self.fields["LIGHTTAG_KEEP_INSTANCE_POWER"]] = False
            return tag

        self.c4d = SimpleNamespace(
            Olight="light", LIGHT_TYPE="type", LIGHT_TYPE_OMNI="omni", LIGHT_TYPE_SPOT="spot",
            LIGHT_TYPE_AREA="area", LIGHT_TYPE_DISTANT="distant", LIGHT_TYPE_PARALLEL="parallel",
            LIGHT_BRIGHTNESS="brightness", LIGHT_AREADETAILS_SHAPE="shape", LIGHT_AREADETAILS_SHAPE_RECTANGLE="rect",
            LIGHT_AREADETAILS_SHAPE_DISC="disc", LIGHT_AREADETAILS_SHAPE_SPHERE="sphere",
            LIGHT_AREADETAILS_SIZEX="size_x", LIGHT_AREADETAILS_SIZEY="size_y", LIGHT_AREADETAILS_SIZEZ="size_z",
            LIGHT_SHOWILLUMINATION="show_illumination", LIGHT_SHOWVISIBLELIGHT="show_visible",
            LIGHT_SHOWCLIPPING="show_clipping", LIGHT_AREADETAILS_SHOWASSOLIDINVIEWPORT="show_solid",
            DOCUMENT_UNIT_M="metre", DOCUMENT_DOCUNIT="unit", BaseTag=new_tag,
            Matrix=lambda off, v1, v2, v3: SimpleNamespace(off=off, v1=v1, v2=v2, v3=v3),
            UnitScaleData=lambda: SimpleNamespace(SetUnitScale=lambda value, unit: (value, unit) == (1.0, "metre")),
            utils=SimpleNamespace(CalculateTranslationScale=lambda _source, target: target),
        )

    def convert(self, light, info=None, document_units=100.0):
        plan = {"path": "scene.fbx", "renderer": "octane"}
        if info is not None:
            plan["max_light_settings"] = {light.GetName(): info}
        with patch.object(MATERIALS, "wants_octane", return_value=True):
            report = MATERIALS.convert_octane_lights(self.c4d, {"unit": document_units}, [light], plan)
        self.assertIn("已设置 1 盏", report)
        return light.GetTag(MATERIALS._OCT_LIGHT)

    def test_viewport_size_uses_document_units_and_preserves_the_fbx_transform(self):
        settings = dict(source="corona_light", shape="rectangle", width=.32, height=.20, units=0, intensity=24)
        for frame, doc_scale in (((100.0, 100.0, 100.0), 100.0), ((.1, .1, .1), 100.0), ((10, 40, 50), 1.0)):
            with self.subTest(world_scale=frame, document_scale=doc_scale):
                light = self.Light(frame)
                matrix = light.GetMg()
                tag = self.convert(light, settings, doc_scale)
                world = light.GetMg()
                self.assertIs(world, matrix)
                self.assertEqual(light["type"], "area")
                self.assertAlmostEqual(light["size_x"], .32 * doc_scale)
                self.assertAlmostEqual(light["size_y"], .20 * doc_scale)
                self.assertAlmostEqual(tag[self.fields["LIGHTTAG_POWER"]], 24 * math.pi * .32 * .20)
                for guide in ("show_illumination", "show_visible", "show_clipping", "show_solid"):
                    self.assertIs(light[guide], False)
                self.assertEqual(light["falloff_distance"], 2500.0)
                self.assertIs(tag[self.fields["LIGHTTAG_SURFACE_BRIGHTNESS"]], False)
                self.assertIs(tag[self.fields["LIGHTTAG_KEEP_INSTANCE_POWER"]], True)

    def test_hundredfold_import_scale_leaves_light_and_child_transforms_intact(self):
        light = self.Light((200, 50, 100))
        light.matrix.v1 = LightVector(0, 200, 0)
        light.matrix.v2 = LightVector(-50, 0, 0)
        child = self.Light((6, 7, 8), "Child")
        child_world = child.GetMg()
        light.children.append(child)
        settings = dict(source="corona_light", shape="rectangle", width=.3, height=.12,
                        source_scale=[2, .5, 1], units=1, intensity=683)
        tag = self.convert(light, settings)
        world = light.GetMg()
        self.assertEqual(world.off, (2, 4, 8))
        self.assertEqual(world.v1, (0, 200, 0))
        self.assertEqual(world.v2, (-50, 0, 0))
        self.assertEqual(world.v3, (0, 0, 100))
        self.assertEqual(light.world_sets, [])
        self.assertEqual(child.world_sets, [])
        self.assertIs(child.GetMg(), child_world)
        self.assertAlmostEqual(light["size_x"], 30)
        self.assertAlmostEqual(light["size_y"], 12)
        self.assertAlmostEqual(tag[self.fields["LIGHTTAG_POWER"]], 1)

    def test_animation_and_shear_keep_imported_transform_and_viewport_size(self):
        animated = self.Light((100, 100, 100))
        animated.tracks.append("position")
        sheared = self.Light((100, 100, 100))
        sheared.matrix.v2 = LightVector(60, 80, 0)
        settings = dict(source="corona_light", shape="rectangle", width=.32, height=.20, units=0, intensity=24)
        for light in (animated, sheared):
            self.convert(light, settings)
            self.assertEqual(light.world_sets, [])
            self.assertAlmostEqual(light["size_x"], 32)
            self.assertAlmostEqual(light["size_y"], 20)

    def test_spherical_viewport_depth_uses_the_source_diameter(self):
        light = self.Light((20, 50, 70))
        self.convert(light, dict(source="corona_light", shape="sphere", width=.4,
                                 source_scale=[1.5, .5, .75], units=1, intensity=683.0))
        self.assertAlmostEqual(light["size_x"], 40)
        self.assertAlmostEqual(light["size_y"], 40)
        self.assertAlmostEqual(light["size_z"], 40)

    def test_corona_lux_and_radiance_use_the_same_physical_power_for_a_small_disc(self):
        diameter = .0325
        base = dict(source="corona_light", shape="disc", width=diameter)
        # The direct worker's actual Corona fixture changed the intensity by 683*pi when
        # the same source was switched from the default radiance mode to lux.
        radiance = 1234.5
        lux = radiance * 683 * math.pi
        for units, intensity in ((0, radiance), (3, lux)):
            tag = self.convert(self.Light((.1, .1, .1)), dict(base, units=units, intensity=intensity))
            watts = radiance * math.pi * (math.pi * diameter ** 2 / 4)
            self.assertAlmostEqual(tag[self.fields["LIGHTTAG_POWER"]], watts)
            self.assertLess(watts, 100.0)

    def test_regular_fbx_without_source_metadata_keeps_geometry_and_brightness_fallback(self):
        light = self.Light((100, 100, 100))
        light["brightness"] = 0.25
        light["size_x"] = 52.0
        tag = self.convert(light)
        self.assertEqual(light["type"], "omni")
        self.assertEqual(light["size_x"], 52.0)
        self.assertIs(light["show_illumination"], True)
        self.assertEqual(tag[self.fields["LIGHTTAG_POWER"]], 25.0)
        self.assertIs(tag[self.fields["LIGHTTAG_SURFACE_BRIGHTNESS"]], True)
        self.assertIs(tag[self.fields["LIGHTTAG_KEEP_INSTANCE_POWER"]], False)

    def test_rejected_octane_tag_restores_original_viewport_guides(self):
        light = self.Light((100, 100, 100))
        matrix = light.GetMg()
        light["size_x"] = light["size_y"] = 100.0
        light["shape"] = "disc"
        light.InsertTag = lambda _tag: None
        info = dict(source="corona_light", shape="rectangle", width=.32, height=.20, units=0, intensity=24)
        plan = {"path": "scene.fbx", "renderer": "octane", "max_light_settings": {light.GetName(): info}}
        with patch.object(MATERIALS, "wants_octane", return_value=True):
            report = MATERIALS.convert_octane_lights(self.c4d, {"unit": 100.0}, [light], plan)
        self.assertIn("无法挂接 Octane 灯光标签", report)
        self.assertEqual(light["type"], "omni")
        self.assertEqual(light["shape"], "disc")
        self.assertEqual(light["size_x"], 100.0)
        self.assertIs(light.GetMg(), matrix)
        for guide in ("show_illumination", "show_visible", "show_clipping", "show_solid"):
            self.assertIs(light[guide], True)


if __name__ == "__main__":
    unittest.main()
