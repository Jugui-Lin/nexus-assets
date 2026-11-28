"""Check conversion units and responsive converter process handling."""
import ast
import importlib.util
import json
import math
import os
import stat
import struct
import subprocess
import sys
import tempfile
import threading
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from unittest import TestCase, main, skipUnless
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "bridges" / "install" / "c4d_conversion.py"
SPEC = importlib.util.spec_from_file_location("test_conversion", SCRIPT)
CONVERSION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONVERSION)
DECODE_PATH = SCRIPT.with_name("c4d_max_decode.py")
DECODE_SPEC = importlib.util.spec_from_file_location("test_max_decode", DECODE_PATH)
DECODER = importlib.util.module_from_spec(DECODE_SPEC)
DECODE_SPEC.loader.exec_module(DECODER)


class MaxSceneUnitsTests(TestCase):
    @classmethod
    def setUpClass(cls):
        script = ast.parse(DECODER._WORKER)
        parser = next(node for node in script.body
                      if isinstance(node, ast.FunctionDef) and node.name == "scene_meters_per_unit")
        namespace = {"math": math, "struct": struct}
        exec(compile(ast.Module(body=[parser], type_ignores=[]), str(DECODE_PATH), "exec"), namespace)
        cls.meters = staticmethod(namespace[parser.name])

    def reader(self, *data):
        unrelated = SimpleNamespace(guid=1, super_id=0x100,
                                    children=[SimpleNamespace(types=0x8520, data=struct.pack("<If", 4, 1))])
        scene = SimpleNamespace(guid=0x2222, super_id=0x100,
                                children=[SimpleNamespace(types=0x8520, data=blob) for blob in data])
        return SimpleNamespace(SCENE_LIST=[SimpleNamespace(children=[unrelated, scene])],
                               get_guid=lambda entry: entry.guid,
                               get_super_id=lambda entry: entry.super_id)

    def test_source_system_units_convert_each_native_coordinate_to_meters(self):
        for kind, multiplier, expected in (
            (0, 1, 0.0254), (1, 1, 0.3048), (2, 1, 1609.344),
            (3, 1, 0.001), (4, 2.5, 0.025), (5, 1, 1), (6, 1, 1000),
        ):
            with self.subTest(kind=kind, multiplier=multiplier):
                self.assertAlmostEqual(self.meters(self.reader(struct.pack("<If", kind, multiplier))), expected)

    def test_missing_or_corrupt_scene_units_do_not_guess_a_scale(self):
        valid = struct.pack("<If", 3, 1)
        for chunks in ((), (b"short",), (valid, valid),
                       (struct.pack("<If", 7, 1),), (struct.pack("<If", 3, 0),),
                       (struct.pack("<If", 3, float("nan")),)):
            with self.subTest(chunks=chunks):
                self.assertIsNone(self.meters(self.reader(*chunks)))


class MaxTextureTests(TestCase):
    @classmethod
    def setUpClass(cls):
        script = ast.parse(DECODER._WORKER)
        names = {"file_asset_metadata", "bitmap_asset_path", "disabled_corona_channels",
                 "find_bitmap_path", "reference_slots", "ProjectImages", "preserve_legacy_corona_images"}
        definitions = [node for node in script.body
                       if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
        namespace = {"os": os, "stat": stat, "struct": struct, "PureWindowsPath": PureWindowsPath}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), str(DECODE_PATH), "exec"), namespace)
        cls.metadata = staticmethod(namespace["file_asset_metadata"])
        cls.bitmap_asset = staticmethod(namespace["bitmap_asset_path"])
        cls.find_bitmap = staticmethod(namespace["find_bitmap_path"])
        cls.disabled_channels = staticmethod(namespace["disabled_corona_channels"])
        cls.project_images = namespace["ProjectImages"]
        cls.legacy_corona = staticmethod(namespace["preserve_legacy_corona_images"])

    @staticmethod
    def record(primary, old_long, old_short, asset_type, original, saved):
        data = struct.pack("<IH6xI", old_long, old_short, primary)
        for field in (asset_type, original, saved):
            encoded = field.encode("utf-16-le")
            data += struct.pack("<I", len(encoded) // 2) + encoded + bytes(2)
        return data

    def test_reads_unicode_asset_paths_and_unambiguous_legacy_ids(self):
        original = r"G:\失效目录\原始_树.png"
        saved = r"maps\贴图_树_😀.png"
        first = self.record(101, 8, 2, "Bitmap", original, saved)
        second = self.record(102, 9, 2, "Bitmap", original, "")
        self.assertEqual(self.metadata(first + second), ({101: saved, 102: original},
                                                         {8: saved, 9: original, 2: None},
                                                         {first[:16]: saved, second[:16]: original}))

    def test_renderer_bitmaps_use_exact_unambiguous_asset_guids(self):
        original = self.record(101, 8, 2, "Bitmap", "", "maps/normal.png")
        unrelated = self.record(101, 9, 2, "Bitmap", "", "maps/not-this.png")
        conflicting = self.record(101, 8, 2, "Bitmap", "", "maps/different.png")
        non_bitmap = self.record(101, 8, 2, "ExternalReference", "", "scene.max")
        identifier = SimpleNamespace(data=original[:16])
        asset = SimpleNamespace(get_first={0x0002: identifier}.get)
        parameters = SimpleNamespace(guid=0x82, get_first={0x000F: asset}.get)
        reader = SimpleNamespace(get_guid=lambda chunk: getattr(chunk, "guid", None),
                                 get_references=lambda _chunk: [parameters])
        for guid in (0x65484244ABBA5784, 0x02C1017D6769144B):
            bitmap = SimpleNamespace(guid=guid)
            self.assertEqual(self.bitmap_asset(reader, bitmap, self.metadata(original + unrelated)[2]),
                             "maps/normal.png")
            self.assertIsNone(self.bitmap_asset(reader, bitmap, self.metadata(original + conflicting)[2]))
            self.assertIsNone(self.bitmap_asset(reader, bitmap, self.metadata(non_bitmap)[2]))
        self.assertIsNone(self.bitmap_asset(reader, SimpleNamespace(guid=0x240), self.metadata(original)[2]))
        identifier.data = original[:15]
        self.assertIsNone(self.bitmap_asset(reader, bitmap, self.metadata(original)[2]))

    def test_color_wrappers_choose_only_an_unambiguous_bitmap_in_the_color_slots(self):
        texture = SimpleNamespace(guid=0x240, path="maps/leaf.png")
        mask = SimpleNamespace(guid=0x240, path="maps/mask.png")
        correction = SimpleNamespace(guid=0x2D0, positional=[None, texture])
        falloff = SimpleNamespace(guid=0x6EC3730C, keyed={3: mask, 4: correction})
        reader = SimpleNamespace(
            META_DATA=[],
            get_guid=lambda node: node.guid,
            get_reference=lambda node: getattr(node, "keyed", {}),
            get_references=lambda node: getattr(node, "positional", ()),
        )
        with patch.dict(self.find_bitmap.__globals__, reader=reader, get_bitmap=lambda node: getattr(node, "path", None)):
            self.assertEqual(self.find_bitmap(falloff), texture.path)
            falloff.keyed[5] = texture
            self.assertEqual(self.find_bitmap(falloff), texture.path)
            falloff.keyed[5] = mask
            self.assertIsNone(self.find_bitmap(falloff))
            correction.positional[1] = falloff
            del falloff.keyed[5]
            self.assertIsNone(self.find_bitmap(falloff))
            mix = SimpleNamespace(guid=0x230, positional=[None, texture, None, mask])
            dirt_inputs = SimpleNamespace(guid=0x82, keyed={5: mix, 6: texture})
            dirt = SimpleNamespace(guid=0x090D5EA42F567899, positional=[dirt_inputs])
            self.assertEqual(self.find_bitmap(dirt), texture.path)
            dirt_inputs.keyed[6] = mask
            self.assertIsNone(self.find_bitmap(dirt))

    def test_corona_map_filter_uses_only_known_explicit_disabled_flags(self):
        def flag(identifier, enabled, kind=4):
            return SimpleNamespace(types=0x100E,
                                   data=struct.pack("<HI9xi", identifier, kind, enabled))

        self.assertEqual(self.disabled_channels(SimpleNamespace(children=[flag(0xA3, 1), flag(0xA7, 0)])),
                         {"normalmap"})
        self.assertEqual(self.disabled_channels(SimpleNamespace(children=[flag(0xA3, 0), flag(0xA7, 1)])),
                         {"glossmap"})
        self.assertEqual(self.disabled_channels(SimpleNamespace(children=[flag(0xA7, 0, kind=0), flag(0xAE, 0)])),
                         set())
        self.assertEqual(self.disabled_channels(None), set())

    def test_metadata_with_truncated_or_invalid_utf16_is_left_to_pinned_parser(self):
        valid = self.record(101, 8, 2, "Bitmap", "", "texture.jpg")
        for data in (b"", valid[:-1], valid + b"extra", valid[:-4] + b"\x00\xd8\x00\x00"):
            with self.subTest(data=data):
                self.assertIsNone(self.metadata(data))

    def test_loads_case_insensitive_nested_project_textures_once_and_rejects_ambiguity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            maps = root / "maps" / "set"
            baked = root / "maps_baked"
            maps.mkdir(parents=True)
            baked.mkdir()
            texture = maps / "树叶.png"
            direct = root / "color.jpg"
            for file in (texture, direct, maps / "Color.jpg", maps / "duplicate.jpg", baked / "Duplicate.jpg"):
                file.touch()
            sources = []

            def load(file, **options):
                sources.append(Path(file))
                self.assertFalse(options["recursive"])
                return Path(file)

            images = self.project_images(root, load)
            self.assertEqual(images.load(r"G:\旧目录\树叶.PNG"), texture)
            self.assertEqual(images.load("树叶.png"), texture)
            self.assertEqual(images.load("Color.jpg"), direct)
            self.assertIsNone(images.load("duplicate.jpg"))
            self.assertIsNone(images.load("absent.tif"))
            self.assertEqual(sources, [texture, direct])

    def test_keeps_direct_siblings_when_subdirectories_cannot_be_fully_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hidden = root / "no-access"
            nested = root / "maps"
            hidden.mkdir()
            nested.mkdir()
            for file in (root / "direct.jpg", nested / "nested.jpg"):
                file.touch()
            scandir = os.scandir

            def scan(path):
                if Path(path) == hidden:
                    raise PermissionError(path)
                return scandir(path)

            images = self.project_images(root, lambda path, **_options: Path(path))
            with patch.object(os, "scandir", side_effect=scan):
                self.assertIsNone(images.load("nested.jpg"))
                self.assertEqual(images.load("direct.jpg"), root / "direct.jpg")

    def test_legacy_corona_keeps_known_bitmaps_when_scalar_block_is_short(self):
        reader = SimpleNamespace(get_reference=lambda _block: {0: r"G:\旧目录\新贴图.png",
                                                                1: r"maps\粗糙度.png", 2: None},
                                 get_bitmap=lambda path: path)
        values = {"bitmap": "existing.png"}
        material = SimpleNamespace(get=values.get, set=values.__setitem__)
        self.legacy_corona(reader, material, [SimpleNamespace(children=[None] * 8)])
        self.assertEqual(values, {"bitmap": "existing.png", "shinmap": "粗糙度.png"})

    def test_direct_converter_warning_distinguishes_partial_and_no_texture_links(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "scene.fbx"
            log = output.with_name("converter.log")
            self.assertEqual(DECODER.texture_warning(output), "")
            for links, absent, expected in ((8, 0, ""), (8, 3, "有 3 项引用贴图"),
                                              (0, 3, "未找到可链接贴图")):
                with self.subTest(links=links, absent=absent):
                    log.write_bytes(f"NEXUS_MAX_TEXTURES {links} {absent}\r\n".encode("ascii"))
                    report = DECODER.texture_warning(output)
                    if expected:
                        self.assertIn(expected, report)
                    else:
                        self.assertEqual(report, "")

    def test_texture_manifest_is_bound_to_the_scene_and_its_real_texture_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            assets = root / "assets"
            assets.mkdir()
            scene = assets / "scene.max"
            texture = assets / "source-normal.png"
            outside = root / "unrelated-rough.png"
            for file in (scene, texture, outside):
                file.touch()
            output = root / "converted.fbx"
            manifest = root / "texture-bindings.json"
            data = {"version": 1, "source": str(scene), "materials": {"Surface": {
                "normal": str(texture), "roughness": str(outside), "base_color": "not-an-absolute.png",
                "opacity": str(assets / "missing.png")}}}
            manifest.write_text(json.dumps(data), encoding="utf-8")
            self.assertEqual(DECODER.texture_bindings(output, scene), {"Surface": {"normal": str(texture)}})
            data["source"] = str(assets / "another.max")
            manifest.write_text(json.dumps(data), encoding="utf-8")
            self.assertEqual(DECODER.texture_bindings(output, scene), {})


class ConversionTests(TestCase):
    def test_blender_command_sets_a_small_thread_count_before_loading_a_file(self):
        command = CONVERSION._command(".blend", "blender", "input.blend", None)
        argument = command.index("--threads")
        self.assertIn(int(command[argument + 1]), range(1, 5))
        self.assertLess(argument, command.index("input.blend"))

    def test_max_batch_keeps_scene_script_safeguards_before_the_unattended_load(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            command = CONVERSION._command(".max", "3dsmaxbatch", "input.max", directory)
            self.assertEqual(command[2:6], ["-safescene", "ON", "-dm", "on"])
            script = (directory / "export-scene.ms").read_text()
            guard, load = script.split("loadMaxFile", maxsplit=1)
            for name in ("IsSafeSceneScriptExecutionEnabled", "#Python", "#DotNet",
                         "#MAXScriptSystemCommands", "IsSafeScriptAssetExecutionEnabled"):
                self.assertIn(name, guard)
            for option in ("missingExtFilesAction", "missingDLLsAction", "missingXRefsAction"):
                self.assertIn(option + ":#logmsg", load)
            self.assertIn("useFileUnits:true", load)

    def test_max_timeout_has_a_size_based_budget_and_cap(self):
        mib = 1024 * 1024
        for size, expected in ((1, 180), (128 * mib, 180), (128 * mib + 1, 300),
                               (433 * mib, 540), (4096 * mib, 720)):
            with self.subTest(size=size):
                self.assertEqual(CONVERSION._max_timeout(size), expected)

    def test_max_batch_timeout_retains_bounded_stage_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fixture.max"
            source.write_bytes(b"fixture")
            cache = root / "cache"

            def stalled(command, directory, _environment, log, _cancel, *, timeout):
                log.write(b"x" * 70000)
                (directory / "max.log").write_bytes("NEXUS_MAX_STAGE export-fbx\r\n".encode("utf-16-le"))
                (directory / "listener.log").write_bytes(b"NEXUS_MAX_MISSING 0 1 2\n")
                raise subprocess.TimeoutExpired(command, timeout)

            with patch.object(CONVERSION, "_find_executable", return_value="3dsmaxbatch"), \
                 patch.object(CONVERSION, "_run_converter", side_effect=stalled):
                with self.assertRaisesRegex(RuntimeError, "写入 FBX 和贴图.*180.*1 项插件.*2 项外部引用"):
                    CONVERSION.convert(source, cache)
            summary = cache / "max-batch-last-failure.log"
            self.assertEqual(list(cache.iterdir()), [summary])
            self.assertLess(summary.stat().st_size, 66000)
            self.assertIn(b"NEXUS_MAX_STAGE export-fbx", summary.read_bytes())

    def test_max_batch_reports_failed_safety_check_even_on_timeout(self):
        logs = b"NEXUS_MAX_STAGE security\r\nNEXUS_MAX_SAFE_SCENE_REQUIRED"
        self.assertEqual(CONVERSION._max_failure(logs, "超时"), CONVERSION._MAX_SAFETY_ERROR)

    def test_successful_max_export_carries_a_missing_resource_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "scene.fbx"
            listener = output.with_name("listener.log")
            listener.write_bytes(b"NEXUS_MAX_MISSING 0 0 0\n")
            self.assertEqual(CONVERSION.max_export_warning(output), "")
            listener.write_bytes(b"NEXUS_MAX_MISSING 2 1 0\n")
            self.assertEqual(CONVERSION.max_export_warning(output), "MAX 场景缺少 2 项外部文件、1 项插件")

    def test_completed_max_export_survives_only_the_expected_safe_scene_error(self):
        blocked = (b"2026/11/25 18:36:32 ERR: [12828] [57588] MAXScript Exception: -- Security Exception: "
                   b"MAXScript command embedded in the current scene could be unsafe and its execution "
                   b"has been blocked for the current 3ds Max session: blocked operation\n")
        completed = (b"NEXUS_MAX_SAFE_SCENE_VERIFIED\nNEXUS_MAX_MISSING 0 2 0\n"
                     b"NEXUS_MAX_STAGE finish\n" + blocked)
        version = struct.pack("<I", 7700)
        fbx = (CONVERSION._FBX_HEADER + version + struct.pack("<Q", 80) + bytes(176)
               + version + bytes(120) + CONVERSION._FBX_FINAL_MAGIC)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fixture.max"
            source.write_bytes(b"fixture")

            def simulate(logs, data):
                def finished(_command, location, environment, _log, _cancel, *, timeout):
                    self.assertEqual(timeout, 180)
                    Path(environment[CONVERSION._OUTPUT]).write_bytes(data)
                    (location / "max.log").write_bytes(logs)
                    return 4294967166
                return finished

            with patch.object(CONVERSION, "_find_executable", return_value="3dsmaxbatch"), \
                 patch.object(CONVERSION, "_run_converter", side_effect=simulate(completed, fbx)):
                output = Path(CONVERSION.convert(source, root / "completed"))
            self.assertEqual(output.read_bytes(), fbx)
            warning = CONVERSION.max_export_warning(output)
            self.assertIn("缺少 2 项插件", warning)
            self.assertIn("已拦截场景中的嵌入式脚本", warning)

            for logs, data in (
                (completed + b"2026/11/25 18:38:00 ERR: [12828] Failed writing a texture\n", fbx),
                (b"2026/11/25 18:38:00 ERR: [12828] Earlier failure\n" + bytes(70000) + completed, fbx),
                (bytes(CONVERSION._MAX_LOG_VALIDATION_BYTES) + completed, fbx),
                (completed.replace(CONVERSION._MAX_FINISH_MARKER, b""), fbx),
                (completed.replace(CONVERSION._MAX_SAFE_VERIFIED, b""), fbx),
                (completed.replace(blocked, b""), fbx),
                (completed, fbx[:-1]),
            ):
                with patch.object(CONVERSION, "_find_executable", return_value="3dsmaxbatch"), \
                     patch.object(CONVERSION, "_run_converter", side_effect=simulate(logs, data)):
                    with self.assertRaisesRegex(RuntimeError, "未生成有效 FBX"):
                        CONVERSION.convert(source, root / "failed")

    @skipUnless(os.name == "nt", "Windows process priority")
    def test_child_process_and_descendants_inherit_below_normal_priority(self):
        check_priority = ("from ctypes import c_void_p,windll; kernel=windll.kernel32; "
                          "kernel.GetPriorityClass.argtypes=[c_void_p]; "
                          "kernel.GetCurrentProcess.restype=c_void_p; print(kernel.GetPriorityClass(kernel.GetCurrentProcess()))")
        command = [sys.executable, "-c", f"{check_priority}; import subprocess,sys; "
                   f"print(subprocess.check_output([sys.executable, '-c', {check_priority!r}], text=True).strip())"]
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "priority.log"
            with log_path.open("wb") as log:
                self.assertEqual(CONVERSION._run_converter(command, directory, dict(os.environ), log), 0)
            self.assertEqual([int(value) for value in log_path.read_text().splitlines()], [0x4000, 0x4000])

    def test_cancellation_interrupts_a_running_converter(self):
        cancel = threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "started.json"
            command = [sys.executable, "-c", "import os,sys,time; "
                       "open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(60)", str(ready)]

            def request_cancel():
                for _ in range(100):
                    if ready.exists() and ready.stat().st_size:
                        break
                    cancel.wait(0.05)
                cancel.set()

            requester = threading.Thread(target=request_cancel)
            requester.start()
            try:
                with (Path(directory) / "converter.log").open("wb") as log:
                    with self.assertRaisesRegex(RuntimeError, "已取消"):
                        CONVERSION._run_converter(command, directory, dict(os.environ), log, cancel)
                self.assertGreater(json.loads(ready.read_text()), 0)
            finally:
                requester.join()

    def test_custom_budget_stops_child_without_cancellation_event(self):
        command = [sys.executable, "-c", "import time; time.sleep(60)"]
        with tempfile.TemporaryDirectory() as directory:
            with (Path(directory) / "timeout.log").open("wb") as log:
                with self.assertRaises(subprocess.TimeoutExpired) as result:
                    CONVERSION._run_converter(command, directory, dict(os.environ), log, timeout=.25)
        self.assertEqual(result.exception.timeout, .25)


class MaxBatchTextureTests(TestCase):
    def _fbx(self, path, objects, links, *, version=7700):
        header = struct.Struct("<QQQB" if version >= 7500 else "<IIIB")
        terminator = bytes(header.size)

        def encode(node, offset):
            name, properties, children = node
            label = name.encode("ascii")
            data = b""
            for value in properties:
                if isinstance(value, str):
                    value = value.encode("utf-8")
                    data += b"S" + struct.pack("<I", len(value)) + value
                elif isinstance(value, float):
                    data += b"D" + struct.pack("<d", value)
                else:
                    data += b"L" + struct.pack("<q", value)
            subtree = b""
            start = offset + header.size + len(label) + len(data)
            for child in children:
                subtree += encode(child, start + len(subtree))
            if children:
                subtree += terminator
            return header.pack(start + len(subtree), len(properties), len(data), len(label)) + label + data + subtree

        payload = CONVERSION._FBX_HEADER + struct.pack("<I", version)
        # Invalid property contents in an unrelated object must be skipped by offset.
        geometry_end = len(payload) + header.size + len("Geometry") + 1
        geometry = header.pack(geometry_end, 1, 1, len("Geometry")) + b"Geometry!"
        payload += geometry
        payload += encode(("Objects", (), objects), len(payload))
        payload += encode(("Connections", (), [("C", link, ()) for link in links]), len(payload))
        path.write_bytes(payload + terminator)

    @staticmethod
    def _object(kind, key, name, filename=None, **properties):
        children = []
        if filename:
            children.append(("Filename" if kind == "Video" else "FileName", (filename,), ()))
        if properties:
            values = [(key, value if isinstance(value, tuple) else (value,)) for key, value in properties.items()]
            children.append(("Properties70", (), [("P", (key, "", "", "", *value), ()) for key, value in values]))
        return kind, (key, name + "\x00\x01" + kind, ""), children

    def test_batch_resolves_native_slots_from_video_and_typed_bitmap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source" / "plants.max"
            source.parent.mkdir()
            source.touch()
            embedded = root / "scene.fbm"
            embedded.mkdir()
            base = embedded / "leaf.jpg"
            opacity = source.parent / "cutout.png"
            normal = source.parent / "leaf-normal.tif"
            for image in (base, opacity, normal):
                image.touch()
            fbx = root / "scene.fbx"
            objects = [
                self._object("Material", 1, "树叶"),
                self._object("Material", 9, "Disabled", **{"3dsMax|maps|texmap_diffuse_on": 0}),
                self._object("Texture", 2, "Leaf correction", **{"3dsMax|ClassIDa": 720, "3dsMax|ClassIDb": 0}),
                self._object("Texture", 3, "Leaf bitmap"),
                self._object("Video", 4, "Leaf media", r"D:\materials\leaf.jpg"),
                self._object("Texture", 5, "Opacity", **{"3dsMax|Params|HDRIMapName": str(opacity)}),
                self._object("Texture", 6, "Normal wrapper",
                             **{"3dsMax|ClassIDa": 1912237649, "3dsMax|ClassIDb": 1912962095}),
                self._object("Texture", 7, "Normal", normal.name),
                self._object("Texture", 8, "Leaf alias", base.name),
            ]
            self._fbx(fbx, objects, [
                ("OP", 2, 1, "3dsMax|basic|texmap_diffuse"),
                ("OP", 8, 1, "3dsMax|maps|texmap_diffuse"),
                ("OP", 3, 2, "3dsMax|parameters|map"),
                ("OO", 4, 3),
                ("OP", 5, 1, "3dsMax|maps|texmap_opacity"),
                ("OP", 6, 1, "3dsMax|maps|texmap_bump"),
                ("OP", 7, 6, "3dsMax|VRayNormalMap Parameters|normal_map"),
                ("OP", 7, 1, "3dsMax|maps|texmap_reflectionGlossiness"),
                ("OP", 8, 9, "3dsMax|basic|texmap_diffuse"),
            ])
            self.assertEqual(CONVERSION.max_texture_bindings(fbx, source), {
                "树叶": {"base_color": str(base.resolve()), "opacity": str(opacity.resolve()),
                         "normal": str(normal.resolve())},
            })

    def test_batch_rejects_ambiguous_materials_and_paths_outside_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source" / "plants.max"
            source.parent.mkdir()
            source.touch()
            for image in (source.parent / "a.png", source.parent / "b.png", root / "outside.png",
                          source.parent / "script.ms"):
                image.touch()
            fbx = root / "scene.fbx"
            objects = [
                self._object("Material", 1, "Same"), self._object("Material", 2, "Same"),
                self._object("Material", 3, "Conflicting"), self._object("Material", 4, "Outside"),
                self._object("Material", 5, "Traversal"), self._object("Material", 6, "Script"),
                self._object("Texture", 10, "A", "a.png"), self._object("Texture", 11, "B", "b.png"),
                self._object("Texture", 12, "Outside", str(root / "outside.png")),
                self._object("Texture", 13, "Traversal", r"..\outside.png"),
                self._object("Texture", 14, "Script", "script.ms"),
            ]
            self._fbx(fbx, objects, [
                ("OP", 10, 1, "DiffuseColor"), ("OP", 10, 3, "DiffuseColor"),
                ("OP", 11, 3, "3dsMax|maps|texmap_diffuse"), ("OP", 12, 4, "DiffuseColor"),
                ("OP", 13, 5, "DiffuseColor"), ("OP", 14, 6, "DiffuseColor"),
            ], version=7400)
            self.assertEqual(CONVERSION.max_texture_bindings(fbx, source), {})

    def test_batch_preserves_exact_original_paths_and_rejects_mixed_falloff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fbx = root / "scene.fbx"
            source = root / "source" / "plants.max"
            originals = [source.parent / "a" / "leaf.png", source.parent / "b" / "leaf.png"]
            for image in (*originals, root / "scene.fbm" / "leaf.png"):
                image.parent.mkdir(parents=True)
                image.touch()
            source.touch()
            falloff = {"3dsMax|ClassIDa": 1858302732, "3dsMax|ClassIDb": 0}
            self._fbx(fbx, [
                self._object("Material", 1, "Same branches"), self._object("Material", 2, "Color blend"),
                self._object("Material", 3, "Distinct origins"),
                self._object("Texture", 10, "First original", str(originals[0])),
                self._object("Texture", 11, "Second original", str(originals[1])),
                self._object("Texture", 12, "Same texture in both slots", **falloff),
                self._object("Texture", 13, "Different textures", **falloff),
                self._object("Video", 14, "Alternate unpacked location", r"C:\\elsewhere\\leaf.png"),
            ], [
                ("OO", 14, 10),
                ("OP", 10, 12, "3dsMax|parameters|map1"), ("OP", 10, 12, "3dsMax|parameters|map2"),
                ("OP", 10, 13, "3dsMax|parameters|map1"), ("OP", 11, 13, "3dsMax|parameters|map2"),
                ("OP", 12, 1, "DiffuseColor"), ("OP", 13, 2, "DiffuseColor"),
                ("OP", 10, 3, "3dsMax|basic|texmap_diffuse"), ("OP", 11, 3, "3dsMax|maps|texmap_diffuse"),
            ])
            self.assertEqual(CONVERSION.max_texture_bindings(fbx, source), {
                "Same branches": {"base_color": str(originals[0].resolve())},
            })

    def test_batch_maps_vray_values_and_preserves_material_only_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "scene.max"
            fbx = root / "scene.fbx"
            normal = root / "normal.tif"
            bump = root / "bump.png"
            surface = root / "surface.jpg"
            for asset in (source, normal, bump, surface):
                asset.touch()
            case = {"3dsMax|ClassIDa": 935280431, "3dsMax|ClassIDb": 1882483036,
                    "3dsMax|basic|diffuse": (0.1, 0.2, 0.3), "3dsMax|basic|reflection_metalness": 0.25,
                    "3dsMax|basic|reflection_glossiness": 0.75, "3dsMax|BRDF|brdf_useRoughness": 0,
                    "3dsMax|basic|reflection_fresnel": 1, "3dsMax|basic|reflection_lockIOR": 1,
                    "3dsMax|basic|reflection_ior": 2.0, "3dsMax|basic|refraction_ior": 1.52,
                    "3dsMax|basic|reflection": (0.5, 0.5, 0.5), "3dsMax|basic|reflection_weight": 0.75,
                    "3dsMax|maps|texmap_bump_multiplier": 30.0,
                    "3dsMax|maps|texmap_reflectionGlossiness_multiplier": 100.0}
            rough = dict(case, **{"3dsMax|BRDF|brdf_useRoughness": 1, "3dsMax|basic|reflection_lockIOR": 0,
                                  "3dsMax|basic|reflection": (0.6, 0.5, 0.4)})
            wrapper = {"3dsMax|ClassIDa": 1912237649, "3dsMax|ClassIDb": 1912962095,
                       "3dsMax|VRayNormalMap Parameters|normal_map_multiplier": 0.35,
                       "3dsMax|VRayNormalMap Parameters|normal_map_on": 1}
            self._fbx(fbx, [
                self._object("Material", 1, "Leaf", **case),
                self._object("Material", 2, "Soil", **rough),
                self._object("Material", 3, "Other renderer", **dict(case, **{"3dsMax|ClassIDb": 1})),
                self._object("Texture", 4, "V-Ray normal", **wrapper),
                self._object("Texture", 5, "Normal", normal.name),
                self._object("Texture", 6, "Bump", bump.name),
                self._object("Texture", 7, "Differing surface semantics", surface.name),
                self._object("Material", 8, "Disabled surface map",
                             **dict(case, **{"3dsMax|maps|texmap_reflectionGlossiness_on": 0})),
                self._object("Material", 9, "Partial surface map",
                             **dict(case, **{"3dsMax|maps|texmap_reflectionGlossiness_multiplier": 40.0})),
            ], [
                ("OP", 4, 1, "3dsMax|maps|texmap_bump"),
                ("OP", 5, 4, "3dsMax|VRayNormalMap Parameters|normal_map"),
                ("OP", 6, 2, "3dsMax|maps|texmap_bump"),
                ("OP", 7, 1, "3dsMax|basic|texmap_reflectionGlossiness"),
                ("OP", 7, 2, "3dsMax|maps|texmap_reflectionGlossiness"),
                ("OP", 7, 3, "3dsMax|maps|texmap_reflectionGlossiness"),
                ("OP", 7, 8, "3dsMax|maps|texmap_reflectionGlossiness"),
                ("OP", 7, 9, "3dsMax|maps|texmap_reflectionGlossiness"),
            ])
            leaf = {"base_color": (0.1, 0.2, 0.3), "metallic": 0.25, "roughness": 0.25,
                    "ior": 1.52, "specular_strength": 0.375}
            soil = {"base_color": (0.1, 0.2, 0.3), "metallic": 0.25, "roughness": 0.75, "ior": 2.0}
            self.assertEqual(CONVERSION.max_material_data(fbx, source), ({
                "Leaf": {"normal": str(normal.resolve()), "glossiness": str(surface.resolve())},
                "Soil": {"bump": str(bump.resolve()), "roughness": str(surface.resolve())},
            }, {
                "Leaf": dict(leaf, normal_map=str(normal.resolve()), normal_strength=0.35),
                "Soil": dict(soil, bump_map=str(bump.resolve()), bump_strength=0.30),
                "Disabled surface map": leaf, "Partial surface map": leaf,
            }))
            with patch.object(CONVERSION, "_fbx_texture_path", side_effect=AssertionError("should not resolve textures")):
                self.assertEqual(CONVERSION.max_material_data(fbx, source, include_textures=False),
                                 ({}, {"Leaf": leaf, "Soil": soil, "Disabled surface map": leaf,
                                       "Partial surface map": leaf}))

    def test_batch_reads_native_corona_legacy_material_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "scene.max"
            fbx = root / "scene.fbx"
            source.touch()
            legacy = {"3dsMax|ClassIDa": 1891525894, "3dsMax|ClassIDb": 1149841885,
                      "3dsMax|CoronaMtlPb|colorDiffuse": (0.25, 0.50, 0.75),
                      "3dsMax|CoronaMtlPb|levelDiffuse": 0.375,
                      "3dsMax|CoronaMtlPb|colorReflect": (0.5, 0.5, 0.5),
                      "3dsMax|CoronaMtlPb|levelReflect": 0.75,
                      "3dsMax|CoronaMtlPb|reflectGlossiness": 0.625,
                      "3dsMax|CoronaMtlPb|fresnelIor": 2.125,
                      "3dsMax|CoronaMtlPb|colorOpacity": (0.25, 0.25, 0.25),
                      "3dsMax|CoronaMtlPb|levelOpacity": 0.5}
            tinted = dict(legacy, **{"3dsMax|CoronaMtlPb|colorReflect": (0.5, 0.25, 0.125),
                                     "3dsMax|CoronaMtlPb|fresnelIor": 999.0,
                                     "3dsMax|CoronaMtlPb|colorOpacity": (0.3, 0.5, 1.0)})
            self._fbx(fbx, [
                self._object("Material", 1, "Legacy", **legacy),
                self._object("Material", 2, "Tinted", **tinted),
                self._object("Material", 3, "Other class", **dict(legacy, **{"3dsMax|ClassIDb": 1})),
            ], [])
            self.assertEqual(CONVERSION.max_material_data(fbx, source, include_textures=False), ({}, {
                "Legacy": {"base_color": (0.25, 0.50, 0.75), "diffuse_strength": 0.375, "roughness": 0.375,
                           "ior": 2.125, "specular_strength": 0.375, "opacity": 0.125},
                "Tinted": {"base_color": (0.25, 0.50, 0.75), "diffuse_strength": 0.375, "roughness": 0.375},
            }))

    def test_batch_reads_corona_physical_values_and_fully_applied_bitmap_slots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "scene.max"
            fbx = root / "scene.fbx"
            bitmap = root / "surface.png"
            source.touch()
            bitmap.touch()
            prefix = "3dsMax|CoronaPhysicalMtlPb|"
            physical = {"3dsMax|ClassIDa": 1762831241, "3dsMax|ClassIDb": -2028660960}
            physical.update({prefix + key: value for key, value in {
                "baseColor": (0.25, 0.50, 0.75), "baseLevel": 0.625, "baseRoughness": 0.25,
                "roughnessMode": 0, "baseIor": 1.5, "iorMode": 0, "metalnessMode": 0,
                "opacityColor": (1.0, 1.0, 1.0), "opacityLevel": 0.5, "baseTexmapOn": 1,
                "baseMapAmount": 1.0, "baseRoughnessTexmapOn": 1, "baseRoughnessMapAmount": 1.0,
                "baseBumpTexmapOn": 1,
            }.items()})
            glossy = dict(physical, **{prefix + "roughnessMode": 1, prefix + "metalnessMode": 1,
                                       prefix + "iorMode": 1, prefix + "baseMapAmount": 0.25})
            self._fbx(fbx, [
                self._object("Material", 1, "Dielectric", **physical),
                self._object("Material", 2, "Metal", **glossy),
                self._object("Texture", 3, "Corona Bitmap", **{"3dsMax|BitmapTex|filename": bitmap.name}),
                self._object("Texture", 4, "Corona Normal", **{
                    "3dsMax|ClassIDa": 678481578, "3dsMax|ClassIDb": -870825092,
                    "3dsMax|CoronaNormalPb|multiplier": 0.375,
                }),
            ], [
                ("OP", 3, 1, prefix + "baseTexmap"), ("OP", 3, 1, prefix + "baseRoughnessTexmap"),
                ("OP", 3, 2, prefix + "baseTexmap"), ("OP", 3, 2, prefix + "baseRoughnessTexmap"),
                ("OP", 4, 1, prefix + "baseBumpTexmap"), ("OP", 3, 4, "3dsMax|CoronaNormalPb|normalMap"),
            ])
            maps, values = CONVERSION.max_material_data(fbx, source)
            self.assertEqual(maps, {"Dielectric": {"base_color": str(bitmap.resolve()), "roughness": str(bitmap.resolve()),
                                                   "normal": str(bitmap.resolve())},
                                    "Metal": {"glossiness": str(bitmap.resolve())}})
            common = {"base_color": (0.25, 0.50, 0.75), "diffuse_strength": 0.625, "opacity": 0.5}
            self.assertEqual(values, {"Dielectric": dict(common, roughness=0.25, metallic=0.0, ior=1.5,
                                                        normal_map=str(bitmap.resolve()), normal_strength=0.375),
                                      "Metal": dict(common, roughness=0.75, metallic=1.0)})

    def test_batch_ignores_out_of_bounds_fbx_and_unsupported_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fbx = root / "scene.fbx"
            source = root / "plants.max"
            source.touch()
            for version, length in ((7700, 40), (7700, 1_000_000), (7800, 60)):
                with self.subTest(version=version, length=length):
                    fbx.write_bytes(CONVERSION._FBX_HEADER + struct.pack("<IQQQB", version, length, 0, 0, 7)
                                    + b"Objects")
                    self.assertEqual(CONVERSION.max_texture_bindings(fbx, source), {})

    def test_native_batch_capture_fills_missing_fbx_data_and_rejects_duplicate_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source" / "plants.max"
            source.parent.mkdir()
            normal = source.parent / "normal.png"
            diffuse = source.parent / "leaf.jpg"
            outside = root / "other.png"
            for item in (source, normal, diffuse, outside):
                item.touch()
            fbx = root / "scene.fbx"
            self._fbx(fbx, [self._object("Material", 1, "树叶")], [])
            capture = fbx.with_name("max-material-data.tsv")
            rows = [
                "NEXUS_MAX_MATERIALS_V1", "M\t树叶\tcorona_physical",
                "C\tbase_color\t0.2\t0.3\t0.4", "N\troughness\t0.32", "N\tior\t1.55",
                "N\tmetallic\tnan", "N\tunknown\t0.5", "T\tbase_color\tleaf.jpg",
                "T\tnormal\tnormal.png\t0.35", f"T\topacity\t{outside}",
                "M\tAmbiguous\tcorona_legacy", "N\topacity\t0.25",
                "M\tAmbiguous\tvray", "N\troughness\t0.3", "END",
            ]
            capture.write_text("\r\n".join(rows), encoding="utf-8-sig")
            values = {"base_color": (0.2, 0.3, 0.4), "roughness": 0.32, "ior": 1.55}
            self.assertEqual(CONVERSION.max_material_data(fbx, source), ({
                "树叶": {"base_color": str(diffuse.resolve()), "normal": str(normal.resolve())},
            }, {"树叶": dict(values, normal_map=str(normal.resolve()), normal_strength=0.35)}))
            self.assertEqual(CONVERSION.max_material_data(fbx, source, include_textures=False), ({}, {"树叶": values}))
            capture.write_text("\n".join(rows[:-1]), encoding="utf-8")
            self.assertEqual(CONVERSION.max_material_data(fbx, source), ({}, {}))


class DirectMaxBudgetTests(TestCase):
    def test_small_large_and_very_large_scene_budgets(self):
        for size, seconds in ((0, 180), (128 * 1024 * 1024, 180), (128 * 1024 * 1024 + 1, 300),
                              (454497168, 540), (5 * 1024 * 1024 * 1024, 720)):
            with self.subTest(size=size):
                self.assertEqual(CONVERSION._max_timeout(size), seconds)

    def test_timeout_reports_last_phase_and_retains_only_a_bounded_log(self):
        def run(command, directory, environment, stream, cancel, *, timeout):
            self.assertEqual(timeout, 180)
            Path(environment[DECODER._STATUS]).write_text("exporting", encoding="ascii")
            Path(environment[DECODER._OUTPUT]).write_bytes(b"incomplete geometry")
            stream.write(b"a" * (DECODER._LOG_TAIL_BYTES + 500) + b"tail")
            raise subprocess.TimeoutExpired(command, timeout)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "sample.max"
            source.write_bytes(b"asset fixture")
            cache = root / "cache"
            with patch.object(DECODER, "_conversion_helpers", return_value=CONVERSION), \
                    patch.object(CONVERSION, "_find_executable", return_value=sys.executable), \
                    patch.object(CONVERSION, "_run_converter", side_effect=run):
                with self.assertRaisesRegex(RuntimeError, "写出 FBX 和贴图阶段超时"):
                    DECODER.convert(source, cache)
            diagnostic = cache / "max-decode-last-failure.log"
            self.assertEqual(list(cache.iterdir()), [diagnostic])
            details = diagnostic.read_bytes()
            self.assertIn(b"Phase: exporting", details)
            self.assertIn(b"Source: sample.max", details)
            self.assertTrue(details.endswith(b"tail"))
            self.assertLess(len(details), DECODER._LOG_TAIL_BYTES + 512)


if __name__ == "__main__":
    main()
