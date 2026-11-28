"""Exercise scene options against a small in-memory Cinema 4D document."""
import importlib.util
from pathlib import Path
from queue import Queue
from tempfile import TemporaryDirectory
from threading import Event
from types import SimpleNamespace
from unittest import TestCase, main


SCRIPT = Path(__file__).resolve().parents[1] / "bridges" / "install" / "c4d_smart_import.py"
SPEC = importlib.util.spec_from_file_location("test_smart_import", SCRIPT)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class Node:
    def __init__(self, kind, owner, matrix=None):
        self.kind = kind
        self.owner = owner
        self.matrix = matrix
        self.children = []
        self.tags = []
        self.tracks = []
        owner.append(self)

    def GetGUID(self):
        return id(self)

    def CheckType(self, kind):
        return self.kind == kind

    def GetTag(self, kind):
        return next((tag for tag in self.tags if tag.CheckType(kind)), None)

    def GetChildren(self):
        return list(self.children)

    def GetTags(self):
        return list(self.tags)

    def GetCTracks(self):
        return list(self.tracks)

    def GetMg(self):
        return self.matrix

    def SetMg(self, matrix):
        self.matrix = matrix

    def Remove(self):
        self.owner.remove(self)

    def InsertBefore(self, node):
        self.owner = node.owner
        self.owner.insert(self.owner.index(node), self)
        self.matrix = "reparented"


class Document:
    def __init__(self):
        self.objects = []
        self.materials = []
        self.selection = [Node("camera", self.objects)]
        self.undo = []

    def GetObjects(self):
        return list(self.objects)

    def GetMaterials(self):
        return list(self.materials)

    def GetActiveObjects(self, _flags):
        return list(self.selection)

    def SetActiveObject(self, item, _mode=None):
        if item is None:
            self.selection.clear()
        else:
            self.selection.append(item)

    def StartUndo(self):
        return True

    def AddUndo(self, action, node):
        self.undo.append((action, node))

    def EndUndo(self):
        pass


class SmartImportTests(TestCase):
    def setUp(self):
        self.doc = Document()
        self.importer = BRIDGE.SmartImporter.__new__(BRIDGE.SmartImporter)
        self.importer.status_updates = Queue()
        self.importer.status_stage = None
        self.importer.active_job = None
        self.previous_settings = dict(geometry=False, cameras=False, lights=False, tracks=True, materials=True, normals=2)
        self.settings = self.previous_settings.copy()
        self.filter_arguments = []
        self.applied = []
        self.converted = []
        self.initial_material = True
        plugin = SimpleNamespace(Message=self.get_settings)
        self.importer.c4d = SimpleNamespace(
            FORMAT_FBX_IMPORT=1026369, PLUGINTYPE_SCENELOADER=1, MSG_RETRIEVEPRIVATEDATA=2,
            FBXIMPORT_GEOMETRY="geometry", FBXIMPORT_CAMERAS="cameras", FBXIMPORT_LIGHTS="lights",
            FBXIMPORT_TRACKS="tracks", FBXIMPORT_MATERIALS="materials",
            FBXIMPORT_NORMALS="normals", FBXIMPORT_NORMALS_NONE=0, FBXIMPORT_NORMALS_NORMALTAGS=1,
            SCENEFILTER_OBJECTS=1, SCENEFILTER_MATERIALS=2, SCENEFILTER_MERGESCENE=4,
            SCENEFILTER_NOUNDO=8, GETACTIVEOBJECTFLAGS_CHILDREN=1, SELECTION_ADD=1, UNDOTYPE_NEWOBJ=1,
            Ocamera="camera", Olight="light", Onull="null", Opolygon="mesh", Ttexture="texture",
            StopAllThreads=lambda: None, EventAdd=lambda: None,
            documents=SimpleNamespace(MergeDocument=self.merge_document),
            plugins=SimpleNamespace(FindPlugin=lambda *_: plugin),
        )
        self.importer.materials = SimpleNamespace(
            apply=lambda *args: self.applied.append(args),
            convert_octane=lambda *args: self.converted.append(args),
            convert_octane_lights=lambda *_: "",
            wants_octane=lambda _c4d, _doc, renderer: renderer == "octane",
            available_renderers=lambda _c4d: ["standard", "octane"],
        )

    def get_settings(self, _message, data):
        data["imexporter"] = self.settings
        return True

    def merge_document(self, doc, path, flags, _thread):
        self.filter_arguments.append((path, flags, self.settings.copy()))
        group = Node("null", doc.objects)
        camera = Node("camera", group.children)
        mesh = Node("mesh", camera.children, matrix="world-matrix")
        Node("animation", mesh.tracks)
        if self.initial_material:
            tag = Node("texture", mesh.tags)
            Node("animation", tag.tracks)
        Node("light", group.children)
        Node("null", doc.objects)
        Node("material", doc.materials)
        return True

    def apply(self, path="source.fbx", renderer="auto", maps=None, **settings):
        options = dict(objects=True, materials=True, textures=True, cameras=True,
                       lights=True, animation=True, emptyObjects=True)
        options.update(settings)
        return self.importer._apply(self.doc, {
            "path": path, "kind": "scene", "scene_import": options, "renderer": renderer,
            "maps": {"base_color": "Albedo.png"} if maps is None else maps,
        })

    def test_merges_geometry_and_restores_fbx_settings(self):
        existing = self.doc.objects[0]
        message = self.apply(materials=False, cameras=False, lights=False, animation=False, emptyObjects=False)
        _, flags, settings = self.filter_arguments[0]
        self.assertEqual(flags, 13)
        self.assertEqual(settings, dict(geometry=True, cameras=False, lights=False, tracks=False, materials=False, normals=1))
        self.assertEqual(self.settings, self.previous_settings)
        self.assertEqual(self.doc.objects[0], existing)
        self.assertEqual(len(self.doc.objects), 2)
        group = self.doc.objects[1]
        mesh, = group.children
        self.assertEqual(mesh.GetMg(), "world-matrix")
        self.assertTrue(mesh.CheckType("mesh"))
        self.assertEqual(mesh.tracks + mesh.tags + self.doc.materials, [])
        self.assertEqual(self.doc.undo, [(1, group)])
        self.assertEqual(self.applied, [])
        self.assertEqual(self.converted, [])
        self.assertIn("2 个对象、0 个材质", message)

    def test_native_material_only_leaves_existing_objects_intact(self):
        existing = self.doc.objects.copy()
        self.apply("project.c4d", objects=False)
        self.assertEqual(self.filter_arguments[0][1], 14)
        self.assertEqual(self.filter_arguments[0][2], self.previous_settings)
        self.assertEqual(self.doc.objects, existing)
        self.assertEqual(len(self.doc.materials), 1)

    def test_fbx_normal_tags_can_be_disabled(self):
        self.apply(normals=False)
        self.assertEqual(self.filter_arguments[0][2]["normals"], 0)
        self.assertEqual(self.settings, self.previous_settings)

    def test_fbx_without_scene_options_still_imports_normal_tags_cameras_and_lights(self):
        self.importer._apply(self.doc, {"path": "source.FBX", "kind": "scene"})
        self.assertEqual(self.filter_arguments[0][2], dict(self.previous_settings, normals=1, cameras=True, lights=True))
        self.assertEqual(self.settings, self.previous_settings)

    def test_legacy_importers_enable_classic_fbx_and_obj_materials_then_restore(self):
        c4d = self.importer.c4d
        del c4d.FBXIMPORT_MATERIALS
        c4d.FBXIMPORT_MATERIALMODE = "material_mode"
        c4d.FBXIMPORT_SUBSTANCES = "substances"
        c4d.DESCFLAGS_DESC_NONE = 0
        c4d.DESC_CYCLE = "cycle"
        c4d.FORMAT_OBJ2IMPORT = 2
        c4d.OBJIMPORTOPTIONS_MATERIAL = "material_mode"
        c4d.OBJIMPORTOPTIONS_MATERIAL_MTLFILE = 2

        class LegacyFbxImporter(dict):
            def GetDescription(self, _flags):
                return [({"cycle": [(10, "None"), (20, "Standard"), (30, "Nodes")]},
                         [SimpleNamespace(id="material_mode")], None)]

        fbx = LegacyFbxImporter(self.previous_settings, material_mode=30, substances=True)
        obj = {"material_mode": 0}
        adapters = {c4d.FORMAT_FBX_IMPORT: fbx, c4d.FORMAT_OBJ2IMPORT: obj}
        c4d.plugins.FindPlugin = lambda plugin_id, _: SimpleNamespace(
            Message=lambda _, values: values.update(imexporter=adapters[plugin_id]) or True,
        )
        previous = fbx.copy()
        with BRIDGE._fbx_import_settings(c4d, "Fixture.fbx", None, standard_scene=True):
            self.assertTrue(fbx["geometry"])
            self.assertEqual(fbx["material_mode"], 20)
            self.assertFalse(fbx["substances"])
        self.assertEqual(fbx, previous)
        with self.assertRaisesRegex(RuntimeError, "merge failure"):
            with BRIDGE._obj_material_settings(c4d):
                self.assertEqual(obj["material_mode"], 2)
                raise RuntimeError("merge failure")
        self.assertEqual(obj["material_mode"], 0)

    def test_legacy_input_uses_only_the_requested_scene_and_safe_options(self):
        self.importer.scene_formats = ("fbx", "obj")
        with TemporaryDirectory() as directory:
            for extension in ("FBX", "OBJ", "max"):
                path = Path(directory) / ("Asset." + extension)
                path.touch()
            job = {
                "id": "legacy-job", "path": str(Path(directory) / "Asset.FBX"),
                "options": {"renderer": "redshift", "lod": 2, "scene_import": {"storeTextures": True}},
                "c4dPreferences": {"maxMode": "direct"},
            }
            for extension in ("FBX", "OBJ"):
                source = str((Path(directory) / ("Asset." + extension)).resolve())
                self.assertEqual(self.importer._standard_scene_job(dict(job, path=source)), {
                    "id": "legacy-job", "path": source, "options": {"kind": "scene", "renderer": "standard"},
                })
            with self.assertRaises(ValueError):
                self.importer._standard_scene_job(dict(job, path=str(Path(directory) / "Asset.max")))
            with self.assertRaises(ValueError):
                self.importer._standard_scene_job(dict(job, projectExport={"destination": directory}))

    def test_legacy_scene_preparation_and_merge_keep_native_material_assignments(self):
        importer = self.importer
        importer.scene_formats = ("fbx", "obj")
        importer.results = Queue()
        importer.import_progress = Queue()
        spec = importlib.util.spec_from_file_location("test_legacy_asset_prep", SCRIPT.with_name("c4d_asset_prep.py"))
        importer.preparation = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(importer.preparation)
        linked = []
        importer.materials.link_standard_scene_textures = lambda *args: linked.append(args)
        existing_material = Node("material", self.doc.materials)
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            importer._job_runtime = lambda _job: (root / "cache", None, {})
            texture = root / "Fixture_BaseColor.png"
            texture.touch()
            for extension in ("fbx", "obj"):
                source = root / ("Fixture." + extension)
                source.touch()
                job = importer._standard_scene_job({"id": "legacy", "path": str(source)})
                importer._prepare(job, 1)
                _generation, _job_id, plan, error = importer.results.get_nowait()
                self.assertIsNone(error)
                self.assertEqual(plan["renderer"], "standard")
                self.assertEqual(plan["maps"], {"base_color": str(texture)})
                importer._apply(self.doc, plan)
                self.assertEqual(linked[-1][2], self.doc.materials[-1:])
                self.assertNotIn(existing_material, linked[-1][2])
        self.assertEqual(self.applied, [])
        self.assertEqual(self.converted, [])

    def test_legacy_max_converts_to_fbx_with_scoped_converter_and_standard_materials(self):
        importer = self.importer
        importer.scene_formats = ("fbx", "obj", "max")
        importer.results = Queue()
        importer.import_progress = Queue()
        converter_calls = []
        linked = []
        importer.materials.link_standard_scene_textures = lambda *args: linked.append(args)
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "Fixture.Max"
            source.touch()
            output = str(root / "converted" / "Fixture.fbx")
            bindings = {"Surface": {"base_color": str(root / "diffuse.png")}}
            baked = {"c0001": {"normal": str(root / "normal.png")}}
            importer.preparation = SimpleNamespace(
                prepare=lambda _c4d, path, _options, _cache, **_kwargs: {"kind": "scene", "path": path},
                collect_baked_scene_maps=lambda *_: baked,
                _family_tokens=lambda name: (name.casefold(),),
            )

            def convert(kind, filename, cache, executable, cancel):
                converter_calls.append((kind, filename, cache, executable, cancel))
                return output

            importer.max_decode = SimpleNamespace(
                convert=lambda filename, cache, blender_executable, cancel: convert(
                    "direct", filename, cache, blender_executable, cancel,
                ),
                texture_warning=lambda _output: "",
                scene_object_warning=lambda *_: "",
                render_settings=lambda _output: {},
                texture_bindings=lambda filename, original: bindings if (filename, original) == (output, str(source)) else {},
            )
            importer.conversion = SimpleNamespace(
                convert=lambda filename, cache, executable_path, cancel: convert(
                    "application", filename, cache, executable_path, cancel,
                ),
                max_export_warning=lambda _output: "",
            )
            preferences = {"maxMode": "application", "maxMaterialRenderer": "standard",
                           "blenderExecutable": "blender", "maxBatchExecutable": "3dsmaxbatch"}
            snapshot = {"workspaceKey": None, "settings": preferences}
            importer._job_runtime = lambda job: (root, None, job["c4dPreferences"]["settings"])
            keep = Node("material", self.doc.materials)
            for mode, expected, executable in ((None, "application", "3dsmaxbatch"), ("direct", "direct", "blender")):
                with self.subTest(mode=mode):
                    options = {"renderer": "octane", "lod": 3, "scene_import": {"storeTextures": True}}
                    if mode is not None:
                        options["max_mode"] = mode
                    job = importer._standard_scene_job({
                        "id": "legacy-max", "path": str(source), "options": options, "c4dPreferences": snapshot,
                    })
                    expected_options = {"kind": "scene", "renderer": "standard"}
                    if mode is not None:
                        expected_options["max_mode"] = mode
                    self.assertEqual(job["options"], expected_options)
                    cancel = Event()
                    importer._prepare(job, 1, cancel)
                    self.assertEqual(converter_calls[-1], (expected, str(source), root / "converted", executable, cancel))
                    self.assertEqual(importer.import_progress.get_nowait()["stage"], "preparing")
                    self.assertEqual(importer.import_progress.get_nowait()["stage"], expected + "-max")
                    _generation, _job_id, plan, error = importer.results.get_nowait()
                    self.assertIsNone(error)
                    self.assertTrue(plan["standard_scene"])
                    self.assertEqual(plan["renderer"], "standard")
                    self.assertEqual(plan["source_path"], str(source))
                    self.assertEqual(plan["path"], output)
                    if expected == "direct":
                        self.assertEqual(plan["scene_material_maps"], bindings)
                        self.assertEqual(plan["baked_material_maps"], baked)
                    importer._apply(self.doc, plan)
                    self.assertEqual(linked[-1][2], self.doc.materials[-1:])
                    self.assertNotIn(keep, linked[-1][2])
                    self.assertEqual(self.filter_arguments[-1][0], output)
            with self.assertRaisesRegex(ValueError, "MAX 转换模式无效"):
                importer._standard_scene_job({"id": "invalid", "path": str(source), "options": {"max_mode": "burn"}})
            self.assertEqual(self.converted, [])
            for explicit, saved, expected in ((None, None, "octane"), ("standard", "octane", "standard"),
                                              ("auto", "octane", "auto")):
                with self.subTest(explicit=explicit, saved=saved):
                    if saved is None:
                        preferences.pop("maxMaterialRenderer", None)
                    else:
                        preferences["maxMaterialRenderer"] = saved
                    options = {"max_material_renderer": explicit} if explicit else {}
                    job = importer._standard_scene_job({"id": "max", "path": str(source), "options": options,
                                                        "c4dPreferences": snapshot})
                    importer._prepare(job, 1)
                    _generation, _job_id, plan, error = importer.results.get_nowait()
                    self.assertIsNone(error)
                    self.assertEqual(plan["renderer"], expected)
                    importer._apply(self.doc, plan)
            self.assertEqual(len(self.converted), 1)
            self.assertEqual(self.converted[0][-1]["renderer"], "octane")

    def test_map_linking_is_limited_to_new_unassigned_geometry(self):
        self.initial_material = False
        self.apply("project.c4d", textures=False)
        self.assertEqual(self.applied, [])
        self.apply("project.c4d", textures=True)
        _, _, plan = self.applied[0]
        self.assertEqual(plan["objects"], self.doc.objects[-2].children[0].children)

    def test_octane_converts_tagged_fbx_materials_without_folder_maps(self):
        existing_material = Node("material", self.doc.materials)
        existing_object = self.doc.objects[0]
        replacements = []

        def convert(c4d, doc, materials, objects, plan):
            self.assertIs(c4d, self.importer.c4d)
            self.assertIs(doc, self.doc)
            self.assertNotIn(existing_material, materials)
            self.assertNotIn(existing_object, objects)
            mesh, = [obj for obj in objects if obj.CheckType("mesh")]
            self.assertIsNotNone(mesh.GetTag("texture"))
            self.assertEqual(plan["maps"], {})
            self.assertFalse(plan["scene_import"]["textures"])
            source, = materials
            source.Remove()
            replacements.append(Node("octane", doc.materials))
            return "已转换 1 个 Octane 材质"

        self.importer.materials.convert_octane = convert
        message = self.apply(renderer="octane", textures=False, maps={})
        self.assertEqual(self.doc.materials, [existing_material, replacements[0]])
        self.assertIn((1, replacements[0]), self.doc.undo)
        self.assertNotIn((1, existing_material), self.doc.undo)
        self.assertEqual(self.applied, [])
        self.assertIn("已转换 1 个 Octane 材质", message)

    def test_octane_failure_keeps_imported_fbx_and_reports_the_failure(self):
        def fail(*_):
            raise RuntimeError("Cinema 4D 当前未加载 Octane 插件。")

        self.importer.materials.convert_octane = fail
        message = self.apply(renderer="octane", maps={})
        self.assertIn("5 个对象、1 个材质", message)
        self.assertIn("Octane 材质转换失败：Cinema 4D 当前未加载 Octane 插件。", message)
        self.assertEqual([item.kind for item in self.doc.materials], ["material"])

    def test_inspector_octane_import_respects_remembered_fbx_settings(self):
        plan = {"path": "source.fbx", "kind": "scene", "renderer": "octane"}
        self.importer._apply(self.doc, plan)
        [(path, flags, settings)] = self.filter_arguments
        self.assertEqual(path, "source.fbx")
        self.assertEqual(flags, 15)
        self.assertEqual(settings, dict(self.previous_settings, normals=1, cameras=True, lights=True))
        self.assertEqual(self.settings, self.previous_settings)
        [(_c4d, _doc, materials, objects, supplied)] = self.converted
        self.assertEqual(materials, self.doc.materials)
        self.assertIn("mesh", [obj.kind for obj in objects])
        self.assertIs(supplied, plan)

    def test_auto_fbx_without_octane_keeps_native_merge_and_undo(self):
        message = self.importer._apply(self.doc, {"path": "source.fbx", "kind": "scene"})
        self.assertEqual(self.filter_arguments, [("source.fbx", 7, dict(self.previous_settings, normals=1, cameras=True, lights=True))])
        self.assertEqual(self.settings, self.previous_settings)
        self.assertEqual(self.doc.undo, [])
        self.assertEqual(self.converted, [])
        self.assertEqual(message, "已合并模型或工程")

    def test_direct_max_restores_textures_on_only_new_standard_materials_without_overrides(self):
        existing = Node("material", self.doc.materials)
        supplied = []

        def restore(c4d, doc, materials, plan):
            supplied.append(plan)
            self.assertIs(c4d, self.importer.c4d)
            self.assertIs(doc, self.doc)
            self.assertEqual(materials, self.doc.materials[1:])
            self.assertNotIn(existing, materials)
            return "标准材质已补接 1 个贴图通道"

        self.importer.materials.link_standard_scene_textures = restore
        plan = {"path": "scene.fbx", "kind": "scene", "source_path": "scene.max", "restore_scene_textures": True,
                "scene_material_maps": {"material": {"base_color": "map.png"}}}
        self.assertIn("标准材质已补接 1 个贴图通道", self.importer._apply(self.doc, plan))
        self.assertEqual(supplied, [plan])
        self.assertNotIn((1, existing), self.doc.undo)

    def test_native_c4d_materials_and_standard_fbx_bypass_octane(self):
        self.apply(path="source.c4d", renderer="octane", maps={})
        self.apply(renderer="standard", maps={})
        self.assertEqual(self.converted, [])

    def test_max_keeps_linked_standard_materials_without_octane(self):
        original = Node("standard", self.doc.materials)
        linked = []
        importer = self.importer
        importer.materials.available_renderers = lambda _c4d: ["standard"]
        importer.materials.link_standard_scene_textures = lambda *args: linked.append(args[2])
        plan = {"path": "converted.fbx", "kind": "scene", "max_material_import": True, "renderer": "octane",
                "source_path": "original.max", "restore_scene_textures": True}
        message = importer._apply(self.doc, plan)
        self.assertIn("未加载 Octane", message)
        self.assertEqual(linked, [self.doc.materials[1:]])
        self.assertNotIn(original, linked[0])
        self.assertEqual(self.converted, [])
        export_notes = importer._prepare_export_materials(self.doc, plan)
        self.assertIn("未加载 Octane", export_notes[-1])
        self.assertEqual(self.converted, [])
        importer.materials.available_renderers = lambda _c4d: ["standard", "octane"]
        self.assertEqual(importer._prepare_export_materials(self.doc, plan), [])
        self.assertEqual(self.converted[0][2], self.doc.materials)

    def test_empty_merge_reports_failure_and_restores_the_selection(self):
        original = self.doc.selection.copy()
        self.importer.c4d.documents.MergeDocument = lambda *_: True
        with self.assertRaisesRegex(RuntimeError, "没有载入"):
            self.apply()
        self.assertEqual(self.doc.objects, original)
        self.assertEqual(self.doc.selection, original)
        self.assertEqual(self.settings, self.previous_settings)

    def test_job_mode_overrides_preferences_and_reports_conversion_stage(self):
        importer = self.importer
        importer.results = Queue()
        importer.import_progress = Queue()
        importer.app_root = Path("fixtures")
        importer.cache = Path("fixtures/cache")
        importer.cache_warning = None
        baked = {"c0001": {"base_color": "maps_baked/mat_C0001_diffuse.png"}}
        importer.preparation = SimpleNamespace(
            prepare=lambda _host, path, *_options: {"kind": "scene", "path": path},
            collect_baked_scene_maps=lambda *_: baked,
        )
        importer.cache_settings = SimpleNamespace(read_preferences=lambda _: {"maxMode": "application"})
        bindings = {"Material": {"base_color": "texture.png"}}
        importer.max_decode = SimpleNamespace(
            texture_warning=lambda _: "MAX 转出贴图连接 0 项，有 1 项贴图未找到",
            scene_object_warning=lambda *_: "MAX 直接解析：2 盏灯使用通用光源",
            render_settings=lambda _: {"materials": {"Surface": {"normal_strength": 0.4}},
                                       "lights": {"Sun": {"intensity": 0.3}}},
            texture_bindings=lambda output, source: bindings if (output, source) == ("prepared.fbx", "source.MAX") else {},
        )
        requests = []

        def convert(source, mode, _preferences, _cache, _cancel):
            requests.append((source, mode))
            return "prepared.fbx"

        importer._convert = convert
        importer._prepare({"id": "drop", "path": "source.MAX", "options": {"max_mode": "direct"}}, 1)
        generation, job_id, plan, failure = importer.results.get_nowait()
        self.assertEqual((generation, job_id, failure), (1, "drop", None))
        self.assertEqual(plan["path"], "prepared.fbx")
        self.assertEqual(plan["source_path"], "source.MAX")
        self.assertEqual(plan["renderer"], "octane")
        self.assertTrue(plan["max_material_import"])
        self.assertEqual(plan["warnings"], [
            "MAX 转出贴图连接 0 项，有 1 项贴图未找到",
            "MAX 直接解析：2 盏灯使用通用光源",
        ])
        self.assertEqual(plan["baked_material_maps"], baked)
        self.assertEqual(plan["max_material_settings"], {"Surface": {"normal_strength": 0.4}})
        self.assertEqual(plan["max_light_settings"], {"Sun": {"intensity": 0.3}})
        self.assertTrue(plan["restore_scene_textures"])
        self.assertEqual(plan["scene_material_maps"], bindings)
        self.assertEqual(requests, [("source.MAX", "direct")])
        self.assertEqual(importer.import_progress.get_nowait(), {"jobId": "drop", "stage": "preparing"})
        self.assertEqual(importer.import_progress.get_nowait(), {"jobId": "drop", "stage": "direct-max"})

    def test_saved_max_project_applies_renderer_preference_before_packaging(self):
        importer = self.importer
        importer.results = Queue()
        importer.import_progress = Queue()
        importer.generation = 1
        importer.preparation = SimpleNamespace(
            prepare=lambda _host, source, *_: {"kind": "scene", "path": source},
            collect_baked_scene_maps=lambda *_: {},
        )
        importer.max_decode = SimpleNamespace(texture_warning=lambda _: "", scene_object_warning=lambda *_: "",
                                             render_settings=lambda _: {}, texture_bindings=lambda *_: {})
        importer.conversion = SimpleNamespace(max_export_warning=lambda _: "")
        importer.materials.link_standard_scene_textures = lambda *_: ""
        detached = Document()
        Node("material", detached.materials)
        conversions = []
        export_calls = []

        def convert(_source, mode, *_):
            conversions.append(mode)
            return "converted.fbx"

        def export(_c4d, _fbx, _destination, _name, *, maps, prepare_materials):
            export_calls.append(prepare_materials(detached))
            return {"textureCount": 0, "warnings": [], "missingTextures": [], "unsupportedTextures": [],
                    "projectPath": "project.c4d"}

        importer._convert = convert
        importer.project_export = SimpleNamespace(export_project=export)
        for mode, renderer in (("direct", "octane"), ("application", "standard")):
            with self.subTest(mode=mode, renderer=renderer):
                importer._job_runtime = lambda _: (Path("cache"), None, {"maxMaterialRenderer": renderer})
                importer._prepare({"id": "save", "path": "source.MAX", "options": {"renderer": "redshift"},
                                   "projectExport": {"destination": "output", "mode": mode}}, 1)
                result = importer.poll()
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["projectPath"], "project.c4d")
                self.assertEqual(conversions[-1], mode)
        self.assertEqual(export_calls, [[], []])
        self.assertEqual(len(self.converted), 1)
        self.assertIs(self.converted[0][1], detached)
        self.assertEqual(self.converted[0][-1]["renderer"], "octane")

    def test_status_feedback_tracks_only_the_active_job_and_clears_when_cancelled(self):
        importer = self.importer
        messages = []
        importer.c4d.gui = SimpleNamespace(
            StatusSetText=messages.append,
            StatusSetSpin=lambda: messages.append("spin"),
            StatusClear=lambda: messages.append("clear"),
        )
        importer.active_job = "drop"
        importer.document = self.doc
        importer.generation = 1
        importer.cancel_event = Event()
        worker_cancel = importer.cancel_event
        importer.status_updates.put(("previous", "importing"))
        importer.status_updates.put(("drop", "direct-max"))
        importer._display_worker_status()
        importer._display_worker_status()
        self.assertEqual(messages, ["Nexus · 正在使用 Blender 直接解析 MAX", "spin"])
        importer.cancel()
        self.assertTrue(worker_cancel.is_set())
        self.assertIsNone(importer.active_job)
        self.assertEqual(messages[-1], "clear")


if __name__ == "__main__":
    main()
