"""Nexus bridge runtime. Export a configured copy from Nexus > DCC connections.
Only the networking worker runs in a thread; all scene edits run on the DCC UI thread.
"""
import os
import sys
import json
import time
import queue
import threading
import urllib.request
import urllib.error
import builtins

LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
blender_max_import = None


def import_asset(dcc, file_path):
    if not os.path.isfile(file_path):
        raise RuntimeError("资产文件不可用，请检查磁盘或网盘挂载：" + file_path)
    ext = os.path.splitext(file_path)[1].lower()
    if dcc == "blender":
        import bpy
        if ext == ".max":
            if blender_max_import is None:
                raise RuntimeError("请在 DCC 连接中心更新 Blender 桥接并重启，以导入 MAX")
            blender_max_import(file_path)
        elif ext == ".blend":
            with bpy.data.libraries.load(file_path, link=False) as (source, target):
                target.objects = list(source.objects)
            for obj in target.objects:
                if obj is not None:
                    bpy.context.collection.objects.link(obj)
        else:
            ops = {
                ".obj": lambda: bpy.ops.wm.obj_import(filepath=file_path, forward_axis='NEGATIVE_Z', up_axis='Y'),
                ".fbx": lambda: bpy.ops.import_scene.fbx(filepath=file_path),
                ".glb": lambda: bpy.ops.import_scene.gltf(filepath=file_path),
                ".gltf": lambda: bpy.ops.import_scene.gltf(filepath=file_path),
                ".abc": lambda: bpy.ops.wm.alembic_import(filepath=file_path),
                ".usd": lambda: bpy.ops.wm.usd_import(filepath=file_path),
                ".usda": lambda: bpy.ops.wm.usd_import(filepath=file_path),
                ".usdc": lambda: bpy.ops.wm.usd_import(filepath=file_path),
                ".stl": lambda: bpy.ops.wm.stl_import(filepath=file_path),
                ".ply": lambda: bpy.ops.wm.ply_import(filepath=file_path),
            }
            if ext not in ops:
                raise RuntimeError("Blender 不支持此格式；请先转换为 FBX / OBJ / USD")
            result = ops[ext]()
            if 'FINISHED' not in result:
                raise RuntimeError("Blender 导入操作未完成: " + str(result))
    elif dcc == "c4d":
        import c4d
        if ext not in (".c4d", ".obj", ".fbx", ".abc", ".stl"):
            raise RuntimeError("此格式需要先转换为 C4D / FBX / OBJ / Alembic")
        doc = c4d.documents.GetActiveDocument()
        flags = c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS | c4d.SCENEFILTER_MERGESCENE
        if not c4d.documents.MergeDocument(doc, file_path, flags, None):
            raise RuntimeError("Cinema 4D MergeDocument 返回失败")
        c4d.EventAdd()
    elif dcc == "maya":
        import maya.cmds as cmds
        if ext in (".fbx", ".obj", ".abc"):
            plugin = {".fbx": "fbxmaya", ".obj": "objExport", ".abc": "AbcImport"}[ext]
            if not cmds.pluginInfo(plugin, query=True, loaded=True):
                cmds.loadPlugin(plugin)
        if ext == ".abc":
            cmds.AbcImport(file_path, mode="import")
        else:
            cmds.file(file_path, i=True, ignoreVersion=True, mergeNamespacesOnClash=False,
                      namespace="nexus_" + str(int(time.time() * 1000)), preserveReferences=True)
    elif dcc == "max":
        from pymxs import runtime as rt
        if ext == ".max":
            if not rt.mergeMAXFile(file_path, rt.Name("select"), rt.Name("autoRenameDups"), quiet=True):
                raise RuntimeError("3ds Max 合并失败")
        else:
            if not rt.importFile(file_path, rt.Name("noPrompt")):
                raise RuntimeError("3ds Max 导入失败")
    elif dcc == "houdini":
        import hou
        if ext in (".hip", ".hiplc", ".hipnc"):
            hou.hipFile.merge(file_path, node_pattern="*", overwrite_on_conflict=False)
        elif ext == ".fbx":
            hou.hipFile.importFBX(file_path, suppress_save_prompt=True, merge_into_scene=True)
        else:
            parent = hou.node("/obj").createNode("geo", "nexus_asset")
            node = parent.createNode("file")
            node.parm("file").set(file_path)
            node.setDisplayFlag(True)
            node.setRenderFlag(True)
            parent.layoutChildren()
            parent.moveToGoodPosition()
    else:
        raise RuntimeError("未知 DCC")


class Bridge:
    def __init__(self, config, smart_import=None):
        self.config = config
        self.running = True
        self.session = None
        self.pending = queue.Queue(maxsize=1)
        self.receipts = queue.Queue()
        self.placement_receipts = queue.Queue()
        self.in_flight = False
        self.smart_import = smart_import
        self.error = "正在连接"
        self.label = config["dcc"] + " · " + str(os.getpid())
        self.thread = threading.Thread(target=self.network_loop, name="NexusBridge", daemon=True)
        self.thread.start()

    def request(self, route, payload, timeout=3):
        req = urllib.request.Request(self.config["url"] + route,
            json.dumps(payload).encode("utf-8"),
            {"Content-Type": "application/json", "Authorization": "Bearer " + self.config["token"]})
        with LOCAL_HTTP.open(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def network_loop(self):
        receipt = None
        placement_receipt = None
        while self.running:
            try:
                if self.session is None:
                    result = self.request("/bridge/register", {
                        "dcc": self.config["dcc"], "pid": os.getpid(), "label": self.label,
                        "placement": self.config.get("placement", False),
                        "maxImport": self.config["dcc"] == "blender" and blender_max_import is not None,
                        "smartImport": self.smart_import is not None,
                        "projectExport": bool(getattr(self.smart_import, "project_export", None)),
                        "sceneImportOptions": bool(getattr(self.smart_import, "import_progress", None)),
                        "scopedC4dPreferences": bool(getattr(self.smart_import, "scoped_preferences", False)),
                        "maxTextureBindings": bool(getattr(self.smart_import, "max_texture_bindings", False)),
                        "archiveTextures": bool(getattr(self.smart_import, "archive_textures", False)),
                        "pbrMaterialSets": bool(getattr(self.smart_import, "pbr_material_sets", False)),
                    })
                    self.session = result["id"]
                self.request("/bridge/heartbeat", {"sessionId": self.session, "label": self.label})
                if self.smart_import is not None:
                    self.report_import_progress()
                if placement_receipt is None:
                    try:
                        placement_receipt = self.placement_receipts.get_nowait()
                    except queue.Empty:
                        pass
                if placement_receipt is not None:
                    details, release = placement_receipt
                    self.request("/bridge/placement/finish", dict(details, sessionId=self.session))
                    placement_receipt = None
                    if release:
                        self.in_flight = False
                if receipt is None:
                    try:
                        receipt = self.receipts.get_nowait()
                    except queue.Empty:
                        pass
                if receipt is not None:
                    self.request("/bridge/ack", dict(receipt, sessionId=self.session))
                    receipt = None
                    self.in_flight = False
                if not self.in_flight:
                    result = self.request("/bridge/claim", {"sessionId": self.session})
                    job = result.get("job")
                    if job:
                        self.in_flight = True
                        self.pending.put_nowait(job)
                self.error = "已连接"
            except Exception as exc:
                self.error = str(exc)
                # A server restart invalidates sessions. Do not replay an imported job.
                if isinstance(exc, urllib.error.HTTPError) and exc.code == 404:
                    self.session = None
                    if receipt is not None:
                        print("Nexus: server restarted; receipt not replayed", receipt)
                        receipt = None
                        self.in_flight = False
                    if placement_receipt is not None:
                        _, release = placement_receipt
                        placement_receipt = None
                        if release:
                            self.in_flight = False
            for _ in range(20):
                if not self.running:
                    return
                time.sleep(0.1)

    def tick(self):
        if not self.running:
            return None
        try:
            if self.config["dcc"] == "blender":
                import bpy
                scene = os.path.basename(bpy.data.filepath) or "未保存工程"
                self.label = "Blender · " + scene + " · " + str(os.getpid())
            elif self.config["dcc"] == "c4d":
                import c4d
                scene = c4d.documents.GetActiveDocument().GetDocumentName() or "未保存工程"
                self.label = "Cinema 4D · " + scene + " · " + str(os.getpid())
        except Exception:
            pass
        if self.smart_import is not None:
            receipt = self.smart_import.poll()
            if receipt is not None:
                self.receipts.put(receipt)
        try:
            job = self.pending.get_nowait()
        except queue.Empty:
            return 0.3
        if job.get("mode") == "place":
            def done(status, message=None):
                self.report_placement(job["id"], status, message, release=True)
            try:
                self.placement_handler(job["files"], done)
            except Exception as exc:
                done("failed", str(exc))
                print("Nexus placement failed:", exc)
            return 0.3
        try:
            if job.get("mode") == "smart":
                if self.smart_import is None:
                    raise RuntimeError("请从 Nexus 更新 Cinema 4D 插件并重启。")
                self.smart_import.submit(job)
                return 0.3
            import_asset(self.config["dcc"], job["path"])
            self.receipts.put({"jobId": job["id"], "ok": True})
            print("Nexus imported:", job["path"])
        except Exception as exc:
            self.receipts.put({"jobId": job["id"], "ok": False, "error": str(exc)})
            print("Nexus import failed:", exc)
        return 0.3

    def report_placement(self, ticket, status, message=None, release=False):
        self.placement_receipts.put((
            {"ticketId": ticket, "status": status, "message": (message or "")[:500]},
            release,
        ))

    def report_import_progress(self):
        events = getattr(self.smart_import, "import_progress", None)
        if events is None:
            return
        latest = None
        while True:
            try:
                latest = events.get_nowait()
            except queue.Empty:
                break
        if latest is not None:
            try:
                self.request("/bridge/progress", dict(latest, sessionId=self.session))
            except OSError:
                # Progress is advisory. Older Nexus versions still receive the final receipt.
                pass

    def stop(self):
        self.running = False
        if self.smart_import is not None:
            self.smart_import.cancel()
        # stop() is invoked from the DCC UI thread when the script is rerun.
        if hasattr(self, "script_job"):
            import maya.cmds as cmds
            if cmds.scriptJob(exists=self.script_job):
                cmds.scriptJob(kill=self.script_job, force=True)
        if self.config["dcc"] == "houdini":
            import hou
            try:
                hou.ui.removeEventLoopCallback(self.tick)
            except Exception:
                pass
        if hasattr(self, "timer"):
            self.timer.stop()


def start(config):
    key = "_nexus_bridge_" + config["dcc"]
    previous = getattr(builtins, key, None)
    if previous:
        previous.stop()
    bridge = Bridge(config)
    setattr(builtins, key, bridge)
    if config["dcc"] == "blender":
        import bpy
        bpy.app.timers.register(bridge.tick, first_interval=0.5, persistent=True)
    elif config["dcc"] == "c4d":
        import c4d
        class BridgeDialog(c4d.gui.GeDialog):
            def CreateLayout(self):
                self.SetTitle("Nexus Bridge")
                self.AddStaticText(1001, c4d.BFH_SCALEFIT, name="Nexus · 本地资产桥接")
                self.AddStaticText(1002, c4d.BFH_SCALEFIT, name="正在连接…")
                return True
            def InitValues(self):
                self.SetTimer(300)
                return True
            def Timer(self, msg):
                bridge.tick()
                self.SetString(1002, bridge.error[:70])
            def DestroyWindow(self):
                bridge.stop()
        bridge.dialog = BridgeDialog()
        bridge.dialog.Open(c4d.DLG_TYPE_ASYNC, defaultw=300, defaulth=90)
    elif config["dcc"] == "maya":
        import maya.cmds as cmds
        bridge.script_job = cmds.scriptJob(idleEvent=bridge.tick, protected=True)
    elif config["dcc"] == "houdini":
        import hou
        hou.ui.addEventLoopCallback(bridge.tick)
    elif config["dcc"] == "max":
        try:
            from PySide6.QtCore import QTimer
        except ImportError:
            from PySide2.QtCore import QTimer
        bridge.timer = QTimer()
        bridge.timer.timeout.connect(bridge.tick)
        bridge.timer.start(300)
    print("Nexus bridge started:", config["dcc"], config["url"])
    return bridge


if "CONFIG" in globals():
    start(CONFIG)
