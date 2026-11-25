import importlib.util
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


class OctaneScalarTests(unittest.TestCase):
    def setUp(self):
        self.c4d = SimpleNamespace(BaseMaterial=Node, BaseShader=Node, Vector=lambda *values: values)
        self.ids = MATERIALS._OCT_SYMBOLS

    def value(self, node, name):
        return node[self.ids[name]]

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


if __name__ == "__main__":
    unittest.main()
