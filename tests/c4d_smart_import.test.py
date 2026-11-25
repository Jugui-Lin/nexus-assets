"""Exercise scene options against a small in-memory Cinema 4D document."""
import importlib.util
from pathlib import Path
from queue import Queue
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

    def test_native_c4d_materials_and_standard_fbx_bypass_octane(self):
        self.apply(path="source.c4d", renderer="octane", maps={})
        self.apply(renderer="standard", maps={})
        self.assertEqual(self.converted, [])

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
        importer.max_decode = SimpleNamespace(
            texture_warning=lambda _: "MAX 转出贴图连接 0 项，有 1 项贴图未找到",
            scene_object_warning=lambda *_: "MAX 直接解析：2 盏灯使用通用光源",
            render_settings=lambda _: {"materials": {"Surface": {"normal_strength": 0.4}},
                                       "lights": {"Sun": {"intensity": 0.3}}},
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
        self.assertEqual(plan["warnings"], [
            "MAX 转出贴图连接 0 项，有 1 项贴图未找到",
            "MAX 直接解析：2 盏灯使用通用光源",
        ])
        self.assertEqual(plan["baked_material_maps"], baked)
        self.assertEqual(plan["max_material_settings"], {"Surface": {"normal_strength": 0.4}})
        self.assertEqual(plan["max_light_settings"], {"Sun": {"intensity": 0.3}})
        self.assertEqual(requests, [("source.MAX", "direct")])
        self.assertEqual(importer.import_progress.get_nowait(), {"jobId": "drop", "stage": "preparing"})
        self.assertEqual(importer.import_progress.get_nowait(), {"jobId": "drop", "stage": "direct-max"})

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
