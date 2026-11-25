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
        names = {"file_asset_metadata", "corona_bitmap_asset_path", "disabled_corona_channels",
                 "ProjectImages", "preserve_legacy_corona_images"}
        definitions = [node for node in script.body
                       if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
        namespace = {"os": os, "stat": stat, "struct": struct, "PureWindowsPath": PureWindowsPath}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), str(DECODE_PATH), "exec"), namespace)
        cls.metadata = staticmethod(namespace["file_asset_metadata"])
        cls.corona_bitmap = staticmethod(namespace["corona_bitmap_asset_path"])
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

    def test_corona_bitmap_uses_exact_unambiguous_bitmap_guid(self):
        original = self.record(101, 8, 2, "Bitmap", "", "maps/normal.png")
        unrelated = self.record(101, 9, 2, "Bitmap", "", "maps/not-this.png")
        conflicting = self.record(101, 8, 2, "Bitmap", "", "maps/different.png")
        non_bitmap = self.record(101, 8, 2, "ExternalReference", "", "scene.max")
        identifier = SimpleNamespace(data=original[:16])
        asset = SimpleNamespace(get_first={0x0002: identifier}.get)
        parameters = SimpleNamespace(guid=0x82, get_first={0x000F: asset}.get)
        bitmap = SimpleNamespace(guid=0x65484244ABBA5784)
        reader = SimpleNamespace(get_guid=lambda chunk: getattr(chunk, "guid", None),
                                 get_references=lambda _chunk: [parameters])
        self.assertEqual(self.corona_bitmap(reader, bitmap, self.metadata(original + unrelated)[2]),
                         "maps/normal.png")
        self.assertIsNone(self.corona_bitmap(reader, bitmap, self.metadata(original + conflicting)[2]))
        self.assertIsNone(self.corona_bitmap(reader, bitmap, self.metadata(non_bitmap)[2]))
        self.assertIsNone(self.corona_bitmap(reader, SimpleNamespace(guid=0x240), self.metadata(original)[2]))
        identifier.data = original[:15]
        self.assertIsNone(self.corona_bitmap(reader, bitmap, self.metadata(original)[2]))

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
