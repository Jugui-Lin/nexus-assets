"""Prepare asset files off the UI thread and apply them in the original scene."""
import importlib.util
import queue
import threading
from contextlib import contextmanager
from pathlib import Path


_STATUS = {
    "preparing": "检查模型与贴图",
    "direct-max": "正在使用 Blender 直接解析 MAX",
    "application-max": "正在调用 3ds Max Batch 转换 MAX",
    "blender": "正在转换 Blender 工程",
    "importing": "正在导入 Cinema 4D 工程",
    "exporting": "正在保存 Cinema 4D 工程和贴图",
}


def _scene_loader_settings(c4d, plugin_id):
    plugin = c4d.plugins.FindPlugin(plugin_id, c4d.PLUGINTYPE_SCENELOADER)
    data = {}
    if plugin is not None and plugin.Message(c4d.MSG_RETRIEVEPRIVATEDATA, data):
        return data.get("imexporter")
    return None


@contextmanager
def _temporary_import_settings(importer, settings):
    previous = {key: importer[key] for key in settings}
    try:
        for key, value in settings.items():
            importer[key] = value
        yield
    finally:
        for key, value in previous.items():
            importer[key] = value


def _fbx_standard_material_mode(c4d, importer, parameter):
    try:
        for properties, desc_id, _ in importer.GetDescription(c4d.DESCFLAGS_DESC_NONE):
            if desc_id[0].id == parameter:
                # In the 2023 importer the cycle is None, Standard, Node Material.
                values = list(properties[c4d.DESC_CYCLE])
                if len(values) == 3:
                    return values[1][0]
                break
    except (AttributeError, IndexError, KeyError, RuntimeError, TypeError):
        pass
    return None


@contextmanager
def _fbx_import_settings(c4d, path, options, *, standard_scene=False):
    if Path(path).suffix.lower() != ".fbx":
        yield
        return
    importer = _scene_loader_settings(c4d, c4d.FORMAT_FBX_IMPORT)
    if importer is None:
        yield
        return
    normals = options is None or (options["objects"] and options.get("normals", True))
    normal_mode = c4d.FBXIMPORT_NORMALS_NORMALTAGS if normals else c4d.FBXIMPORT_NORMALS_NONE
    settings = {
        c4d.FBXIMPORT_NORMALS: normal_mode,
        c4d.FBXIMPORT_CAMERAS: options is None or (options["objects"] and options["cameras"]),
        c4d.FBXIMPORT_LIGHTS: options is None or (options["objects"] and options["lights"]),
    }
    if options is not None:
        objects = options["objects"]
        settings.update({
            c4d.FBXIMPORT_GEOMETRY: objects,
            c4d.FBXIMPORT_TRACKS: objects and options["animation"],
            c4d.FBXIMPORT_MATERIALS: options["materials"],
        })
    if standard_scene:
        if options is None:
            settings[c4d.FBXIMPORT_GEOMETRY] = True
            materials = getattr(c4d, "FBXIMPORT_MATERIALS", None)
            if materials is not None:
                settings[materials] = True
        material_mode = getattr(c4d, "FBXIMPORT_MATERIALMODE", None)
        if material_mode is not None:
            standard = _fbx_standard_material_mode(c4d, importer, material_mode)
            if standard is not None:
                settings[material_mode] = standard
        substances = getattr(c4d, "FBXIMPORT_SUBSTANCES", None)
        if substances is not None:
            settings[substances] = False
    with _temporary_import_settings(importer, settings):
        yield


@contextmanager
def _obj_material_settings(c4d):
    plugin_id = getattr(c4d, "FORMAT_OBJ2IMPORT", None)
    parameter = getattr(c4d, "OBJIMPORTOPTIONS_MATERIAL", None)
    mtl_file = getattr(c4d, "OBJIMPORTOPTIONS_MATERIAL_MTLFILE", None)
    if None not in (plugin_id, parameter, mtl_file):
        importer = _scene_loader_settings(c4d, plugin_id)
        if importer is not None:
            with _temporary_import_settings(importer, {parameter: mtl_file}):
                yield
            return
    yield


def load_module(name):
    path = Path(__file__).with_name("nexus_" + name + ".py")
    spec = importlib.util.spec_from_file_location("_nexus_" + name, path)
    if spec is None or spec.loader is None:
        raise ImportError("无法载入 Nexus Cinema 4D 导入组件：" + name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SmartImporter:
    scene_formats = None
    scene_import_options = True
    scoped_preferences = True
    max_texture_bindings = True
    archive_textures = True
    pbr_material_sets = True

    def __init__(self, c4d, app_root, *, scene_formats=None):
        self.c4d = c4d
        self.app_root = Path(app_root)
        self.scene_formats = scene_formats
        self.cache_settings = load_module("c4d_cache")
        preferences = self.cache_settings.read_preferences(self.app_root)
        self.cache, self.cache_lease, self.cache_warning = self.cache_settings.open_cache(
            self.app_root, preferences=preferences,
        )
        self.caches = {(None, preferences.get("directory")): (self.cache, self.cache_lease, self.cache_warning)}
        self.cache_lock = threading.Lock()
        self.preparation = load_module("c4d_asset_prep")
        self.materials = load_module("c4d_materials")
        supports_max = scene_formats is None or "max" in scene_formats
        self.max_material_preferences = supports_max
        self.max_octane_materials = supports_max and "octane" in self.materials.available_renderers(c4d)
        if supports_max:
            self.conversion = load_module("c4d_conversion")
            self.max_decode = load_module("c4d_max_decode")
        if scene_formats is None:
            self.project_export = load_module("c4d_project_export")
            self.texture_archive = load_module("c4d_texture_archive")
        else:
            self.scene_import_options = False
            self.scoped_preferences = supports_max
            self.max_texture_bindings = supports_max
            self.archive_textures = False
            self.pbr_material_sets = False
            self.project_export = None
        self.archive_target = None
        self.document = None
        self.generation = 0
        self.results = queue.Queue()
        self.import_progress = queue.Queue()
        self.status_updates = queue.Queue()
        self.status_stage = None
        self.active_job = None
        self.cancel_event = None

    def submit(self, job):
        if self.scene_formats is not None:
            job = self._standard_scene_job(job)
        self.document = self.c4d.documents.GetActiveDocument()
        if self.document is None and not job.get("projectExport"):
            raise RuntimeError("请先打开一个 Cinema 4D 工程。")
        scene = (job.get("options") or {}).get("scene_import") or {}
        self.archive_target = (self.texture_archive.project_directory(self.document, allow_unsaved=True)
                               if scene.get("storeTextures") else None)
        self.generation += 1
        self.active_job = job["id"]
        self.cancel_event = threading.Event()
        self._show_status("preparing")
        worker = threading.Thread(
            target=self._prepare, args=(job, self.generation, self.cancel_event), name="Nexus C4D Asset", daemon=True,
        )
        try:
            worker.start()
        except RuntimeError:
            self.cancel()
            raise

    def _standard_scene_job(self, job):
        if job.get("projectExport"):
            raise ValueError("请将素材导入当前 Cinema 4D 场景。")
        original = Path(job["path"])
        source = original.resolve()
        if (not source.is_file() or original.suffix.lower()[1:] not in self.scene_formats
                or source.suffix.lower()[1:] not in self.scene_formats):
            formats = " / ".join(extension.upper() for extension in self.scene_formats)
            raise ValueError(f"请选择可读取的 {formats} 文件。")
        options = {"kind": "scene", "renderer": "standard"}
        scene_job = {"id": job["id"], "path": str(source), "options": options}
        if source.suffix.lower() == ".max":
            requested = job.get("options") or {}
            mode = requested.get("max_mode")
            if mode is not None:
                if mode not in ("direct", "application"):
                    raise ValueError("MAX 转换模式无效。")
                options["max_mode"] = mode
            renderer = requested.get("max_material_renderer")
            if renderer is not None:
                if renderer not in ("octane", "standard", "auto"):
                    raise ValueError("MAX 导入材质设置无效。")
                options["max_material_renderer"] = renderer
            if job.get("c4dPreferences") is not None:
                scene_job["c4dPreferences"] = job["c4dPreferences"]
        return scene_job

    def cancel(self):
        self.generation += 1
        if self.cancel_event is not None:
            self.cancel_event.set()
        self.cancel_event = None
        self.active_job = None
        self.document = None
        self.archive_target = None
        self._clear_status()

    def _prepare(self, job, generation, cancel=None):
        try:
            self._stage(job["id"], "preparing")
            options = job.get("options") or {}
            scene_import = options.get("scene_import")
            if scene_import is not None and not all(scene_import[key] for key in ("objects", "materials", "textures")):
                options = dict(options, texture_resolution=None)
            export = job.get("projectExport")
            if export:
                options = dict(options, kind="scene", lod=None)
            cache, cache_warning, preferences = self._job_runtime(job)
            if self.scene_formats is None:
                plan = self.preparation.prepare(None, job["path"], options, cache)
            else:
                plan = self.preparation.prepare(None, job["path"], options, cache, match_material_names=True)
                plan["standard_scene"] = True
            if cancel is not None and cancel.is_set():
                return
            plan["renderer"] = options.get("renderer", "auto")
            if cache_warning:
                plan["warnings"] = [*plan.get("warnings", []), cache_warning]
            if plan["kind"] == "scene":
                source = job["path"] if export else plan["path"]
                plan["source_path"] = str(source)
                mode = export.get("mode") if export else options.get("max_mode") or preferences.get("maxMode")
                extension = Path(source).suffix.lower()
                if extension == ".max":
                    self._stage(job["id"], "direct-max" if mode == "direct" else "application-max")
                elif extension == ".blend":
                    self._stage(job["id"], "blender")
                if self.scene_formats is None or extension == ".max":
                    plan["path"] = self._convert(source, mode, preferences, cache, cancel)
                if extension == ".max":
                    warning = (self.max_decode.texture_warning(plan["path"]) if mode == "direct"
                               else self.conversion.max_export_warning(plan["path"]))
                    if warning:
                        plan["warnings"] = [*plan.get("warnings", []), warning]
                    if mode == "direct":
                        scene_warning = self.max_decode.scene_object_warning(plan["path"], scene_import)
                        if scene_warning:
                            plan["warnings"] = [*plan.get("warnings", []), scene_warning]
                        scene_settings = self.max_decode.render_settings(plan["path"])
                        if scene_settings.get("materials"):
                            plan["max_material_settings"] = scene_settings["materials"]
                        if scene_settings.get("lights"):
                            plan["max_light_settings"] = scene_settings["lights"]
                    restore = scene_import is None or scene_import["materials"] and scene_import["textures"]
                    renderer = options.get("max_material_renderer") or preferences.get("maxMaterialRenderer", "octane")
                    if renderer not in ("octane", "standard", "auto"):
                        raise ValueError("MAX 导入材质设置无效。")
                    plan["renderer"] = renderer
                    plan["max_material_import"] = True
                    if restore:
                        plan["restore_scene_textures"] = True
                    if mode == "direct" and restore:
                        bindings = self.max_decode.texture_bindings(plan["path"], source)
                        if bindings:
                            plan["scene_material_maps"] = bindings
                        baked = self.preparation.collect_baked_scene_maps(source, options, cache)
                        if baked:
                            plan["baked_material_maps"] = baked
                if scene_import is not None:
                    plan["scene_import"] = scene_import
            if export:
                plan["projectExport"] = export
                plan["name"] = Path(job["path"]).stem
            self.results.put((generation, job["id"], plan, None))
        except Exception as error:
            self.results.put((generation, job["id"], None, str(error) or type(error).__name__))

    def _job_runtime(self, job):
        snapshot = job.get("c4dPreferences")
        if snapshot is None:
            return self.cache, self.cache_warning, self.cache_settings.read_preferences(self.app_root)
        workspace_key, preferences = self.cache_settings.job_preferences(snapshot)
        cache_key = (workspace_key, preferences.get("directory"))
        with self.cache_lock:
            if cache_key not in self.caches:
                self.caches[cache_key] = self.cache_settings.open_cache(self.app_root, workspace_key, preferences)
            cache, _lease, warning = self.caches[cache_key]
        return cache, warning, preferences

    def _stage(self, job_id, stage):
        self.import_progress.put({"jobId": job_id, "stage": stage})
        self.status_updates.put((job_id, stage))

    def _show_status(self, stage):
        gui = getattr(self.c4d, "gui", None)
        if gui is None or self.status_stage == stage:
            return
        try:
            gui.StatusSetText("Nexus · " + _STATUS[stage])
            self.status_stage = stage
            gui.StatusSetSpin()
        except (AttributeError, RuntimeError):
            pass

    def _clear_status(self):
        if self.status_stage is not None:
            self.status_stage = None
            try:
                self.c4d.gui.StatusClear()
            except (AttributeError, RuntimeError):
                pass

    def _display_worker_status(self):
        latest = None
        while True:
            try:
                job, stage = self.status_updates.get_nowait()
            except queue.Empty:
                break
            if job == self.active_job:
                latest = stage
        if latest is not None:
            self._show_status(latest)

    def _convert(self, source, mode, preferences, cache, cancel=None):
        ext = Path(source).suffix.lower()
        converted = cache / "converted"
        blender = preferences.get("blenderExecutable")
        if ext == ".max" and mode == "direct":
            return self.max_decode.convert(source, converted, blender_executable=blender, cancel=cancel)
        executable = preferences.get("maxBatchExecutable") if ext == ".max" else blender
        return self.conversion.convert(source, converted, executable_path=executable, cancel=cancel)

    def poll(self):
        self._display_worker_status()
        try:
            generation, job_id, plan, failure = self.results.get_nowait()
        except queue.Empty:
            return None
        if generation != self.generation:
            return None
        try:
            if failure is not None:
                raise RuntimeError(failure)
            c4d = self.c4d
            export = plan.get("projectExport")
            if export:
                self._stage(job_id, "exporting")
                self._show_status("exporting")
                export_options = {"maps": plan.get("maps")}
                if plan.get("max_material_import"):
                    export_options["prepare_materials"] = lambda doc: self._prepare_export_materials(doc, plan)
                with _fbx_import_settings(c4d, plan["path"], plan.get("scene_import"),
                                          standard_scene=bool(plan.get("max_material_import"))):
                    project = self.project_export.export_project(
                        c4d, plan["path"], export["destination"], plan["name"], **export_options,
                    )
                warnings = [*plan.get("warnings", []), *project["warnings"]]
                if project["missingTextures"]:
                    warnings.append("缺失：" + "、".join(project["missingTextures"][:4]))
                if project["unsupportedTextures"]:
                    warnings.append("外部依赖：" + "、".join(project["unsupportedTextures"][:4]))
                message = " · ".join([f"已保存工程并收集 {project['textureCount']} 项贴图", *warnings])
                return {"jobId": job_id, "ok": True, "message": message[:1000], "projectPath": project["projectPath"]}
            doc = c4d.documents.GetActiveDocument()
            if doc is None or doc != self.document:
                raise RuntimeError("准备期间切换了工程。请回到目标工程重新导入。")
            if self.archive_target is not None and self.texture_archive.project_directory(doc) != self.archive_target:
                raise RuntimeError("准备期间更改了工程保存目录，请重新导入。")
            self._stage(job_id, "importing")
            self._show_status("importing")
            message = self._apply(doc, plan)
            return {"jobId": job_id, "ok": True, "message": message[:1000]}
        except Exception as error:
            return {"jobId": job_id, "ok": False, "error": str(error)[:1000]}
        finally:
            self.document = None
            self.active_job = None
            self.cancel_event = None
            self.archive_target = None
            self._clear_status()

    def _max_octane(self, doc, plan):
        c4d = self.c4d
        if not self.materials.wants_octane(c4d, doc, plan["renderer"]):
            return False, None
        if "octane" not in self.materials.available_renderers(c4d):
            return False, "当前 Cinema 4D 未加载 Octane，已使用标准材质"
        return True, None

    def _prepare_export_materials(self, doc, plan):
        materials = doc.GetMaterials()
        if not materials:
            return []
        notes = []
        if plan.get("restore_scene_textures"):
            try:
                notes.append(self.materials.link_standard_scene_textures(self.c4d, doc, materials, plan))
            except Exception as error:
                notes.append("标准材质贴图未能关联：" + (str(error) or type(error).__name__))
        octane, warning = self._max_octane(doc, plan)
        if warning:
            notes.append(warning)
        if octane:
            try:
                notes.append(self.materials.convert_octane(self.c4d, doc, materials, list(self._objects(doc)), plan))
            except Exception as error:
                notes.append("Octane 材质转换失败：" + (str(error) or type(error).__name__))
        return [note for note in notes if note]

    def _apply(self, doc, plan):
        c4d = self.c4d
        warnings = list(plan.get("warnings", []))
        if plan["kind"] == "scene":
            path = plan["path"]
            options = plan.get("scene_import")
            archive_requested = bool(options and options.get("storeTextures"))
            store_textures = archive_requested and self.archive_target is not None
            if archive_requested and not store_textures:
                warnings.append("当前工程没有可用的保存位置，已跳过贴图归档并保留贴图引用")
            previous_materials = doc.GetMaterials() if store_textures else ()
            link_maps = bool(plan.get("maps"))
            is_fbx = Path(path).suffix.lower() == ".fbx"
            is_max = plan.get("max_material_import")
            convert_materials = (is_fbx and not is_max
                                 and self.materials.wants_octane(c4d, doc, plan.get("renderer", "auto")))
            if is_fbx and is_max and (options is None or options["materials"]):
                convert_materials, warning = self._max_octane(doc, plan)
                if warning:
                    plan = dict(plan, renderer="standard")
                    warnings.append(warning)
            if options is not None:
                link_maps = link_maps and options["materials"] and options["textures"] and options["objects"]
            if (options is not None or convert_materials or plan.get("restore_scene_textures")
                    or plan.get("standard_scene") or plan.get("max_material_import")):
                imported, details = self._merge_filtered(doc, path, options, plan, convert_materials)
            else:
                link_maps = link_maps and Path(path).suffix.lower() != ".c4d"
                units = {obj.GetGUID() for obj in self._objects(doc)} if link_maps else set()
                flags = c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS | c4d.SCENEFILTER_MERGESCENE
                c4d.StopAllThreads()
                self._merge_document(doc, path, flags)
                imported = (obj for obj in self._objects(doc) if obj.GetGUID() not in units)
                details = "已合并模型或工程"
            c4d.EventAdd()
            if plan.get("lod") is not None:
                details += " · LOD" + str(plan["lod"])
            if link_maps:
                try:
                    targets = [obj for obj in imported if obj.CheckType(c4d.Opolygon) and not obj.GetTag(c4d.Ttexture)]
                    if targets:
                        message = self.materials.apply(c4d, doc, dict(plan, kind="pbr", objects=targets))
                        if message:
                            details += " · " + message
                except Exception as error:
                    warnings.append("关联材质未生成：" + str(error))
            if store_textures:
                try:
                    materials = [material for material in doc.GetMaterials() if material not in previous_materials]
                    resolve = self.materials._texture_resolver(Path(path), plan.get("source_path"), doc.GetDocumentPath())
                    count, failures = self.texture_archive.collect(
                        c4d, doc, [*materials, *imported], resolve,
                        self.project_export._rename_without_replacing,
                    )
                    if count:
                        details += f" · 已将 {count} 项贴图改为工程内相对引用"
                    if failures:
                        warnings.append("未归档贴图：" + "、".join(failures[:4])
                                        + (f" 等 {len(failures)} 项" if len(failures) > 4 else ""))
                    if not count and not failures:
                        details += " · 无需归档贴图"
                    c4d.EventAdd()
                except Exception as error:
                    warnings.append("贴图归档失败：" + str(error))
        else:
            details = self.materials.apply(c4d, doc, plan) or "已导入"
        return " · ".join([details] + warnings)

    def _merge_document(self, doc, path, flags, options=None, *, standard_scene=False):
        flags |= getattr(self.c4d, "SCENEFILTER_PROGRESSALLOWED", 0)
        settings = (_obj_material_settings(self.c4d) if standard_scene and Path(path).suffix.lower() == ".obj"
                    else _fbx_import_settings(self.c4d, path, options, standard_scene=standard_scene))
        with settings:
            if not self.c4d.documents.MergeDocument(doc, path, flags, None):
                raise RuntimeError("Cinema 4D 无法读取这个模型或工程，请检查对应导入器。")

    def _merge_filtered(self, doc, path, options, plan, convert_materials):
        c4d = self.c4d
        c4d.StopAllThreads()
        previous_roots = {obj.GetGUID() for obj in doc.GetObjects()}
        previous_materials = doc.GetMaterials()
        previous_selection = doc.GetActiveObjects(c4d.GETACTIVEOBJECTFLAGS_CHILDREN)
        flags = c4d.SCENEFILTER_MERGESCENE | c4d.SCENEFILTER_NOUNDO
        if options is None or options["objects"]:
            flags |= c4d.SCENEFILTER_OBJECTS
        if options is None or options["materials"]:
            flags |= c4d.SCENEFILTER_MATERIALS

        def added():
            return ([obj for obj in doc.GetObjects() if obj.GetGUID() not in previous_roots],
                    [material for material in doc.GetMaterials() if material not in previous_materials])

        try:
            self._merge_document(doc, path, flags, options,
                                 standard_scene=bool(plan.get("standard_scene") or plan.get("max_material_import")))
            roots, materials = added()
            if options is not None:
                restrictive_objects = any(not options[key] for key in (
                    "materials", "cameras", "lights", "animation", "emptyObjects",
                ))
                if options["objects"] and restrictive_objects:
                    self._filter_objects(roots, options)
                elif not options["objects"]:
                    for obj in roots:
                        obj.Remove()
                if not options["materials"]:
                    for material in materials:
                        material.Remove()
                roots, materials = added()
            imported = list(self._walk(roots))
            if not imported and not materials:
                raise RuntimeError("导入器没有载入符合选项的对象或材质，请检查源文件和导入选项。")
            conversions = []
            if materials and (plan.get("standard_scene") or plan.get("restore_scene_textures")):
                family = (self.preparation._family_tokens,) if plan.get("standard_scene") else ()
                try:
                    conversions.append(self.materials.link_standard_scene_textures(c4d, doc, materials, plan, *family))
                except Exception as error:
                    conversions.append("标准材质贴图未能关联：" + (str(error) or type(error).__name__))
            if convert_materials:
                if materials:
                    try:
                        conversions.append(self.materials.convert_octane(c4d, doc, materials, imported, plan))
                    except Exception as error:
                        conversions.append("Octane 材质转换失败：" + (str(error) or type(error).__name__))
                    roots, materials = added()
                if imported and (options is None or options["lights"]) and not plan.get("standard_scene"):
                    try:
                        conversions.append(self.materials.convert_octane_lights(c4d, doc, imported, plan))
                    except Exception as error:
                        conversions.append("Octane 灯光转换失败：" + (str(error) or type(error).__name__))
            if not doc.StartUndo():
                raise RuntimeError("无法开启 Cinema 4D 撤销记录。")
            try:
                for node in materials + roots:
                    doc.AddUndo(c4d.UNDOTYPE_NEWOBJ, node)
            finally:
                doc.EndUndo()
        except Exception:
            roots, materials = added()
            for node in roots + materials:
                node.Remove()
            doc.SetActiveObject(None)
            for obj in previous_selection:
                doc.SetActiveObject(obj, c4d.SELECTION_ADD)
            c4d.EventAdd()
            raise
        details = f"已导入 {len(imported)} 个对象、{len(materials)} 个材质"
        return imported, " · ".join(filter(None, [details, *conversions]))

    def _filter_objects(self, roots, options):
        c4d = self.c4d
        for obj in reversed(list(self._walk(roots))):
            if ((not options["cameras"] and obj.CheckType(c4d.Ocamera))
                    or (not options["lights"] and obj.CheckType(c4d.Olight))):
                for child in obj.GetChildren():
                    transform = child.GetMg()
                    child.Remove()
                    child.InsertBefore(obj)
                    child.SetMg(transform)
                obj.Remove()
                continue
            tags = obj.GetTags()
            if not options["animation"]:
                for node in [obj, *tags]:
                    for track in node.GetCTracks():
                        track.Remove()
            if not options["materials"]:
                for tag in tags:
                    if tag.CheckType(c4d.Ttexture):
                        tag.Remove()
            if not options["emptyObjects"] and obj.CheckType(c4d.Onull) and not obj.GetChildren() and not obj.GetTags():
                obj.Remove()

    def _objects(self, doc):
        return self._walk(doc.GetObjects())

    @staticmethod
    def _walk(roots):
        pending = list(roots)
        while pending:
            obj = pending.pop()
            pending.extend(obj.GetChildren())
            yield obj
