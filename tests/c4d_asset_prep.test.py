"""Test worker-side Cinema 4D preparation using short-lived local assets."""

import importlib.util
from pathlib import Path
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile
import zlib


SCRIPT = Path(__file__).resolve().parents[1] / "bridges" / "install" / "c4d_asset_prep.py"
SPEC = importlib.util.spec_from_file_location("c4d_asset_prep", SCRIPT)
prep = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prep)


class AssetPrepTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.cache = self.root / "cache"
        self.source = self.root / "assets"
        self.source.mkdir()
        self.addCleanup(self.temp.cleanup)

    def files(self, *names):
        for name in names:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        return self.source

    def test_explicit_material_set_uses_only_selected_map_variants(self):
        self.files("Metal/tex/Metal_BaseColor.png", "Metal/tex/Metal_Normal_GL.png",
                   "Metal/tex/Metal_Normal_DX.png", "Metal/tex/Metal_Roughness.png",
                   "Metal/tex/Metal_Height.png", "Metal/tex/Metal2_BaseColor.png",
                   "Metal/materials/Metal_8K_Normal_GL.png")
        folder = self.source / "Metal" / "tex"
        selected = folder / "Metal_BaseColor.png"
        maps = {
            "base_color": [str(selected)],
            "normal": [str(folder / item) for item in ("Metal_Normal_DX.png", "Metal_Normal_GL.png")],
            "roughness": [str(folder / "Metal_Roughness.png")],
        }
        with mock.patch.object(prep, "_scan_related", side_effect=AssertionError("must not scan siblings")):
            plan = prep.prepare(None, selected, {"kind":"pbr","pbr_name":"Metal","pbr_maps":maps}, self.cache)
        self.assertEqual(plan["name"], "Metal")
        self.assertEqual(set(plan["maps"]), set(maps))
        self.assertEqual(Path(plan["maps"]["normal"]), folder / "Metal_Normal_GL.png")
        other = self.source / "Metal" / "materials" / "Metal_8K_Normal_GL.png"
        with self.assertRaises(ValueError):
            prep.prepare(None, selected, {"kind":"pbr","pbr_name":"Metal",
                "pbr_maps":dict(maps, normal=[str(other)])}, self.cache)
        with self.assertRaises(ValueError):
            prep.prepare(None, selected, {"kind":"pbr","pbr_name":"Metal",
                "pbr_maps":dict(maps, normal=[str(selected)])}, self.cache)

    def test_lod_and_same_asset_maps(self):
        self.files("Rock/Rock_LOD0.fbx", "Rock/Rock_LOD2.fbx", "Rock/Rock_LOD4.fbx",
                   "Rock/tex/Rock_1K_Albedo.png", "Rock/tex/Rock_2K_Albedo.png",
                   "Rock/tex/Rock_8K_Albedo.png", "Rock/tex/Rock_2K_Normal_LOD0.png",
                   "Rock/tex/Rock_2K_Normal_LOD2.png", "Rock/tex/Stone_2K_Roughness.png")
        selected = self.source / "Rock/Rock_LOD0.fbx"
        plan = prep.prepare(None, selected, {"lod": "LOD3", "texture_resolution": "2K"}, self.cache)
        self.assertEqual(plan["kind"], "scene")
        self.assertEqual(plan["lod"], 2)
        self.assertTrue(plan["path"].endswith("Rock_LOD2.fbx"))
        self.assertTrue(plan["maps"]["base_color"].endswith("Rock_2K_Albedo.png"))
        self.assertTrue(plan["maps"]["normal"].endswith("Rock_2K_Normal_LOD2.png"))
        self.assertNotIn("roughness", plan["maps"])

    def test_single_texture_ies_and_hdri(self):
        self.files("Lambert.png", "Photometry.ies", "Dome.exr")
        for name, expected in [("Lambert.png", "texture"), ("Photometry.ies", "ies"), ("Dome.exr", "hdri")]:
            with self.subTest(name=name):
                path = self.source / name
                plan = prep.prepare(None, path, {}, self.cache)
                self.assertEqual(plan["kind"], expected)
                self.assertEqual(plan["path"], str(path))

    def test_folder_and_selected_map_do_not_mix_materials(self):
        self.files("Oak/Oak_2k_Albedo.png", "Oak/Oak_2k_Roughness.png", "Oak/Ash_2k_Roughness.png")
        selected = self.source / "Oak/Oak_2k_Albedo.png"
        for path in (selected.parent, selected):
            plan = prep.prepare(None, path, {}, self.cache)
            self.assertEqual(plan["kind"], "pbr")
            self.assertTrue(plan["maps"]["roughness"].endswith("Oak_2k_Roughness.png"))

    def test_baked_scene_maps_keep_numbered_materials_and_channels_separate(self):
        self.files("别墅/别墅.max", "别墅/maps_baked/mat_C0001_diffuse.PNG",
                   "别墅/maps_baked/MAT_c0001_BUMP.png", "别墅/maps_baked/mat_C0002_reflection.png",
                   "别墅/maps_baked/mat_C0003_baked.png", "别墅/maps_baked/mat_C0004_refraction.png",
                   "别墅/maps_baked/archive/mat_C0005_diffuse.png", "别墅/maps/mat_C0006_bump.png",
                   "别墅/maps_baked/mat_C0007_diffuse.cgeo", "别墅/maps_baked/unrelated_diffuse.png")
        asset = self.source / "别墅" / "别墅.max"
        baked = asset.parent / "maps_baked"
        result = prep.collect_baked_scene_maps(asset, {"texture_resolution": "1K"}, self.cache)
        self.assertEqual(result, {
            "c0001": {"base_color": str(baked / "mat_C0001_diffuse.PNG"),
                      "bump": str(baked / "MAT_c0001_BUMP.png")},
            "c0002": {"specular": str(baked / "mat_C0002_reflection.png")},
        })
        self.assertFalse(self.cache.exists())

    def test_baked_scene_maps_leave_ambiguous_channels_unbound(self):
        self.files("Asset.max", "maps_baked/mat_C0001_diffuse.png", "maps_baked/MAT_c0001_ALBEDO.jpg",
                   "maps_baked/mat_C0001_base_color.tif", "maps_baked/mat_C0001_bump.png",
                   "maps_baked/mat_C0002_diffuse.png", "maps_baked/mat_C0002_diffuse.jpg")
        self.assertEqual(prep.collect_baked_scene_maps(self.source / "Asset.max", {}, self.cache), {
            "c0001": {"bump": str(self.source / "maps_baked" / "mat_C0001_bump.png")},
        })

    def test_cache_retains_working_extracted_textures_and_dependencies(self):
        source = self.source / "Plank.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("mesh/Plank.obj", "mtllib Plank.mtl")
            archive.writestr("mesh/Plank.mtl", "newmtl Plank")
            archive.writestr("mesh/tex/Plank_BaseColor.png", b"")
        first = prep.prepare(None, source, {}, self.cache)
        second = prep.prepare(None, source, {}, self.cache)
        self.assertEqual(first, second)
        self.assertEqual(first["kind"], "scene")
        self.assertTrue(Path(first["path"]).with_suffix(".mtl").is_file())
        self.assertTrue(Path(first["maps"]["base_color"]).is_relative_to(self.cache))

    def test_unsafe_zip_entries_do_not_publish_or_escape_cache(self):
        link = zipfile.ZipInfo("Textures")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for index, name in enumerate(("../escape", "/escape", "C:/escape", "normal.png:ads", "aux.obj", link)):
            with self.subTest(name=name):
                source = self.source / f"bad{index}.zip"
                with zipfile.ZipFile(source, "w") as archive:
                    archive.writestr(name, b"ignored")
                with self.assertRaises(ValueError):
                    prep.prepare(None, source, {}, self.cache)
        self.assertEqual(list(self.cache.iterdir()), [])
        self.assertFalse((self.root / "escape").exists())

    def test_selection_remains_available_when_related_scan_cannot_finish(self):
        self.files("Oak.fbx")
        with mock.patch.object(prep, "_scan", side_effect=ValueError):
            plan = prep.prepare(None, self.source / "Oak.fbx", {}, self.cache)
        self.assertEqual(plan["kind"], "scene")

    def test_sbsar_reports_required_renderer(self):
        self.files("Oak.sbsar")
        with mock.patch.object(prep, "_renderer", return_value=None):
            with self.assertRaisesRegex(ValueError, "sbsrender"):
                prep.prepare(None, self.source / "Oak.sbsar", {}, self.cache)

    @unittest.skipUnless(hasattr(subprocess, "CREATE_NO_WINDOW"), "uses Windows image codecs")
    def test_windows_resize_preserves_source_and_aspect(self):
        path = self.source / "贴图 & 地面.png"
        width, height = 256, 64

        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data
                    + struct.pack(">I", zlib.crc32(tag + data)))

        pixels = (b"\0" + bytes((255, 0, 40, 192)) * width) * height
        source = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
                  + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))
        path.write_bytes(source)
        scaled = prep._inbox_downscale(path, self.cache, 128)
        self.assertTrue(scaled.is_relative_to(self.cache))
        self.assertEqual(prep._inbox_dimensions(scaled), (128, 32))
        self.assertEqual(path.read_bytes(), source)
        self.assertEqual(prep._inbox_downscale(path, self.cache, 512), path)


if __name__ == "__main__":
    unittest.main()
