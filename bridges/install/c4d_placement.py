"""Interactive placement for the installed Cinema 4D bridge."""

import math
import os
import time

import c4d


_PREVIEW_EDGES = 2400
_HELP = "T 缩放 · R 旋转 · 左键放置 · Esc 取消"
_ADJUST_HELP = {
    "t": "缩放 · 按住左键左右拖动 · 松开确认 · Esc 取消调整",
    "r": "旋转 · 按住左键左右拖动 · 松开确认 · Esc 取消调整",
}
_FORMATS = {".abc", ".c4d", ".fbx", ".obj", ".stl"}


def _siblings(first):
    while first is not None:
        yield first
        first = first.GetNext()


def _geometry(first):
    pending = list(_siblings(first))
    while pending:
        obj = pending.pop()
        pending.extend(_siblings(obj.GetDown()))
        cache = obj.GetDeformCache() or obj.GetCache()
        if cache is not None:
            pending.extend(_siblings(cache))
        elif obj.CheckType(c4d.Opolygon):
            yield obj


def _corners(center, radius):
    return [
        center + c4d.Vector(i * radius.x, j * radius.y, k * radius.z)
        for i in (-1, 1) for j in (-1, 1) for k in (-1, 1)
    ]


def _box_edges(corners):
    return [
        (point, corners[i ^ axis])
        for i, point in enumerate(corners)
        for axis in (1, 2, 4) if i < i ^ axis
    ]


def _extent(points):
    iterator = iter(points)
    point = next(iterator)
    low = high = (point.x, point.y, point.z)
    for point in iterator:
        axes = (point.x, point.y, point.z)
        low = tuple(map(min, low, axes))
        high = tuple(map(max, high, axes))
    return c4d.Vector(*low), c4d.Vector(*high)


def _preview_source(path, budget):
    scratch = c4d.documents.LoadDocument(path, c4d.SCENEFILTER_OBJECTS, None)
    if scratch is None or scratch.GetFirstObject() is None:
        raise RuntimeError("无法读取模型或文件里没有对象：" + os.path.basename(path))
    roots = list(_siblings(scratch.GetFirstObject()))
    meshes = [(obj, obj.GetPolygonCount()) for obj in _geometry(roots[0])]
    bounds = (
        matrix * point for obj, _ in meshes or [(obj, 0) for obj in roots]
        for matrix in (obj.GetMg(),) for point in _corners(obj.GetMp(), obj.GetRad())
    )
    low, high = _extent(bounds)
    pivot = c4d.Vector((low.x + high.x) / 2, low.y, (low.z + high.z) / 2)
    width = max(high.x - low.x, 1.0)
    edges = []
    stride = max(1, math.ceil(sum(count for _, count in meshes) * 4 / budget))
    remainder = 0
    for obj, count in meshes:
        matrix = obj.GetMg()
        for index in range((-remainder) % stride, count, stride):
            face = obj.GetPolygon(index)
            indices = (face.a, face.b, face.c) if face.c == face.d else (face.a, face.b, face.c, face.d)
            points = [matrix * obj.GetPoint(i) - pivot for i in indices]
            edges.extend(zip(points, points[1:] + points[:1]))
        remainder += count
    if not edges:
        center = (low + high) * 0.5 - pivot
        radius = (high - low) * 0.5
        if radius.GetLength() < 0.01:
            radius = c4d.Vector(10)
        edges = _box_edges(_corners(center, radius))
    return pivot, width, edges


def _prepare(files):
    if not files:
        raise RuntimeError("没有可放置的资产。")
    budget = max(12, _PREVIEW_EDGES // len(files))
    sources = []
    for item in files:
        path = item["path"]
        if os.path.splitext(path)[1].lower() not in _FORMATS or not os.path.isfile(path):
            raise RuntimeError("文件不可读或格式不支持：" + os.path.basename(path))
        pivot, width, edges = _preview_source(path, budget)
        sources.append((path, pivot, width, edges))
    gap = max(width for _, _, width, _ in sources) * 0.15
    position = -(sum(width for _, _, width, _ in sources) + gap * (len(sources) - 1)) / 2
    matrices = []
    lines = []
    for path, pivot, width, edges in sources:
        offset = c4d.Vector(position + width / 2, 0, 0)
        matrices.append((path, c4d.Matrix(off=offset - pivot)))
        lines.extend((start + offset, end + offset) for start, end in edges)
        position += width + gap
    return matrices, tuple(lines)


def _surface(doc, viewport, x, y, state):
    flags = c4d.VIEWPORT_PICK_FLAGS_OGL_ONLY_TOPMOST_WITH_OBJ | c4d.VIEWPORT_PICK_FLAGS_ALLOW_OGL
    picks = c4d.utils.ViewportSelect.PickObject(viewport, doc, int(x), int(y), 0, flags) or []
    start = viewport.SW(c4d.Vector(x, y, 1.0))
    end = viewport.SW(c4d.Vector(x, y, 1000000.0))
    best = None
    for pick in picks[:1]:
        if not isinstance(pick, c4d.BaseObject):
            continue
        previous = state.get("colliders") or []
        cache = []
        for mesh in _geometry_single(pick):
            collider = next((item for old, item in previous if old == mesh), None)
            if collider is None:
                collider = c4d.utils.GeRayCollider()
            cache.append((mesh, collider))
            matrix = mesh.GetMg()
            inverse = ~matrix
            origin = inverse * start
            direction = inverse * end - origin
            length = direction.GetLength()
            if length < 0.001 or not collider.Init(mesh):
                continue
            if collider.Intersect(origin, direction / length, length):
                hit = collider.GetNearestIntersection()
                if hit:
                    point = matrix * hit["hitpos"]
                    distance = (point - start).GetLength()
                    if best is None or distance < best[0]:
                        normal = hit["f_normal"]
                        world_normal = c4d.Vector(inverse.v1.Dot(normal), inverse.v2.Dot(normal), inverse.v3.Dot(normal))
                        if world_normal.Dot(end - start) > 0:
                            world_normal = -world_normal
                        best = distance, point, world_normal
        state["colliders"] = cache
    if best is not None:
        return best[1], best[2]
    ground = c4d.Vector(0, 1, 0)
    point, error = viewport.ProjectPointOnPlane(c4d.Vector(), ground, x, y)
    if error:
        # Front/side orthographic cameras look along the ground plane.
        point = viewport.SW(c4d.Vector(x, y, max(1.0, viewport.WS(c4d.Vector()).z)))
    return point, ground


def _geometry_single(obj):
    cache = obj.GetDeformCache() or obj.GetCache()
    if cache is not None:
        yield from _geometry(cache)
    elif obj.CheckType(c4d.Opolygon):
        yield obj
    else:
        yield from _geometry(obj.GetDown())


def _pose(point, normal, heading, scale):
    up = normal.GetNormalized() if normal.GetLength() >= 0.001 else c4d.Vector(0, 1, 0)
    guide = c4d.Vector(0, 0, 1) if abs(up.z) < 0.95 else c4d.Vector(1, 0, 0)
    forward = (guide - up * up.Dot(guide)).GetNormalized()
    right = up.Cross(forward)
    basis = c4d.Matrix(off=point, v1=right * scale, v2=up * scale, v3=forward * scale)
    return basis * c4d.utils.HPBToMatrix(c4d.Vector(heading, 0, 0))


def _redraw():
    c4d.EventAdd(c4d.EVENT_ENQUEUE_REDRAW | c4d.EVENT_NOEXPRESSION)


def _merge(doc, sources, pose):
    old_objects = list(_siblings(doc.GetFirstObject()))
    old_materials = list(_siblings(doc.GetFirstMaterial()))
    old_selection = doc.GetActiveObjects(c4d.GETACTIVEOBJECTFLAGS_CHILDREN)
    previous_roots = old_objects
    inserted = []
    c4d.StopAllThreads()
    flags = c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS | c4d.SCENEFILTER_MERGESCENE | c4d.SCENEFILTER_NOUNDO
    try:
        for path, offset in sources:
            if not c4d.documents.MergeDocument(doc, path, flags, None):
                raise RuntimeError("无法合并：" + os.path.basename(path))
            current = list(_siblings(doc.GetFirstObject()))
            added = [obj for obj in current if obj not in previous_roots]
            if not added:
                raise RuntimeError("文件没有可放置的对象：" + os.path.basename(path))
            transform = pose * offset
            for obj in added:
                obj.SetMg(transform * obj.GetMg())
            inserted.extend(added)
            previous_roots = current
        materials = [item for item in _siblings(doc.GetFirstMaterial()) if item not in old_materials]
        if not doc.StartUndo():
            raise RuntimeError("无法开启 Cinema 4D 撤销记录。")
        try:
            for item in materials + inserted:
                doc.AddUndo(c4d.UNDOTYPE_NEWOBJ, item)
        finally:
            doc.EndUndo()
    except Exception:
        for obj in list(_siblings(doc.GetFirstObject())):
            if obj not in old_objects:
                obj.Remove()
        for material in list(_siblings(doc.GetFirstMaterial())):
            if material not in old_materials:
                material.Remove()
        doc.SetActiveObject(None)
        for obj in old_selection:
            doc.SetActiveObject(obj, c4d.SELECTION_ADD)
        doc.GetActiveObject()
        raise


class PlacementTool(c4d.plugins.ToolData):
    def __init__(self, plugin_id):
        super().__init__()
        self.plugin_id = plugin_id
        self.placement = None

    def start(self, files, done):
        if self.placement is not None:
            done("failed", "请先完成当前视口放置。")
            return
        doc = c4d.documents.GetActiveDocument()
        if doc is None or doc.IsEditMode():
            done("failed", "请在普通对象模式下放置资产。")
            return
        sources, lines = _prepare(files)
        self.placement = {
            "doc": doc, "sources": sources, "lines": lines,
            "action": doc.GetAction(), "done": done, "heading": 0.0,
            "scale": 1.0, "mode": None, "dragging": False,
            "target": None, "pose": None, "mouse": None, "updated": 0.0,
        }
        try:
            doc.SetAction(self.plugin_id)
            if doc.GetAction() != self.plugin_id:
                raise RuntimeError("Cinema 4D 未能启动视口放置工具。")
            _redraw()
        except Exception as exc:
            self.complete("failed", str(exc))

    def complete(self, status, message=None, restore=True):
        placement, self.placement = self.placement, None
        if placement is None:
            return
        doc = placement["doc"]
        try:
            if restore:
                try:
                    if doc.GetAction() == self.plugin_id:
                        doc.SetAction(placement["action"])
                except ReferenceError:
                    pass
            _redraw()
        finally:
            placement["done"](status, message)

    def check_document(self):
        if self.placement is not None and self.placement["doc"] != c4d.documents.GetActiveDocument():
            self.complete("cancelled", "活动项目已切换。")

    def GetState(self, doc):
        return c4d.CMD_ENABLED if self.placement is not None and self.placement["doc"] == doc else 0

    def InitTool(self, doc, data, thread):
        return self.placement is not None and self.placement["doc"] == doc

    def FreeTool(self, doc, data):
        if self.placement is not None and self.placement["doc"] == doc:
            self.complete("cancelled", restore=False)

    def update(self, doc, viewport, x, y):
        placement = self.placement
        placement["target"] = _surface(doc, viewport, x, y, placement)
        placement["mouse"] = (viewport, x, y)
        self._refresh_pose(placement)
        placement["updated"] = time.monotonic()
        _redraw()

    @staticmethod
    def _refresh_pose(placement):
        point, normal = placement["target"]
        placement["pose"] = _pose(point, normal, placement["heading"], placement["scale"])

    def _drag_adjustment(self, placement, win, x, y):
        # Use the editor's drag input while the preview still has no scene objects.
        mode = placement["mode"]
        initial_heading, initial_scale = placement["heading"], placement["scale"]
        displacement = 0.0
        placement["dragging"] = True
        try:
            win.MouseDragStart(c4d.KEY_MLEFT, x, y, c4d.MOUSEDRAGFLAGS_DONTHIDEMOUSE)
            try:
                while self.placement is placement and placement["mode"] == mode:
                    result, dx, _, _ = win.MouseDrag()
                    if result != c4d.MOUSEDRAGRESULT_CONTINUE:
                        break
                    if not dx:
                        continue
                    displacement += dx
                    if mode == "r":
                        placement["heading"] = (initial_heading + displacement * math.tau / 720.0) % math.tau
                    else:
                        exponent = math.log2(initial_scale) + displacement / 160.0
                        placement["scale"] = 2.0 ** min(10.0, max(-10.0, exponent))
                    self._refresh_pose(placement)
                    c4d.DrawViews(c4d.DRAWFLAGS_ONLY_ACTIVE_VIEW | c4d.DRAWFLAGS_NO_THREAD | c4d.DRAWFLAGS_NO_ANIMATION)
            finally:
                end = win.MouseDragEnd()
            if end != c4d.MOUSEDRAGRESULT_FINISHED or placement["mode"] != mode:
                placement["heading"], placement["scale"] = initial_heading, initial_scale
                self._refresh_pose(placement)
        finally:
            placement["dragging"] = False
            placement["mode"] = None
        if self.placement is placement:
            win.StatusSetText(_HELP)
            _redraw()

    def GetCursorInfo(self, doc, data, bd, x, y, result):
        placement = self.placement
        if placement is None or placement["doc"] != doc:
            return False
        result.SetString(c4d.RESULT_BUBBLEHELP, _ADJUST_HELP.get(placement["mode"], _HELP))
        if not placement["dragging"] and result.GetId() != c4d.BFM_CURSORINFO_REMOVE:
            try:
                if time.monotonic() - placement["updated"] >= 0.03 and placement["mouse"] != (bd, x, y):
                    self.update(doc, bd, x, y)
            except Exception as exc:
                self.complete("failed", str(exc))
        return True

    def Draw(self, doc, data, bd, bh, thread, flags):
        placement = self.placement
        if placement is None or placement["doc"] != doc or placement["pose"] is None:
            return c4d.TOOLDRAW_NONE
        if flags & c4d.TOOLDRAWFLAGS_HIGHLIGHT:
            return c4d.TOOLDRAW_NONE
        bd.SetMatrix_Matrix(None, placement["pose"])
        bd.SetPen(c4d.Vector(0.42, 0.83, 0.73))
        for start, end in placement["lines"]:
            bd.DrawLine(start, end, c4d.NOCLIP_D)
        return c4d.TOOLDRAW_NONE

    def MouseInput(self, doc, data, bd, win, msg):
        placement = self.placement
        if placement is None or placement["doc"] != doc:
            return False
        button = msg.GetInt32(c4d.BFM_INPUT_CHANNEL)
        if button not in (c4d.BFM_INPUT_MOUSELEFT, c4d.BFM_INPUT_MOUSERIGHT):
            return False
        if msg.GetInt32(c4d.BFM_INPUT_QUALIFIER) & c4d.QUALIFIER_ALT or any(
            win.IsHotkeyDown(hotkey)
            for hotkey in (c4d.HOTKEY_CAMERA_MOVE, c4d.HOTKEY_CAMERA_SCALE, c4d.HOTKEY_CAMERA_ROTATE, c4d.HOTKEY_ZOOM)
        ):
            return False
        if button == c4d.BFM_INPUT_MOUSERIGHT:
            self._cancel_adjustment_or_placement(placement, win)
            return True
        try:
            x, y = msg.GetInt32(c4d.BFM_INPUT_X), msg.GetInt32(c4d.BFM_INPUT_Y)
            self.update(doc, bd, x, y)
            if placement["mode"] is not None:
                self._drag_adjustment(placement, win, x, y)
                return True
            _merge(doc, placement["sources"], placement["pose"])
        except Exception as exc:
            self.complete("failed", str(exc))
        else:
            self.complete("placed")
        return True

    def _cancel_adjustment_or_placement(self, placement, win):
        if placement["mode"] is None:
            self.complete("cancelled")
            return
        placement["mode"] = None
        win.StatusSetText(_HELP)
        _redraw()

    def KeyboardInput(self, doc, data, bd, win, msg):
        placement = self.placement
        if placement is None or placement["doc"] != doc:
            return False
        if msg.GetInt32(c4d.BFM_INPUT_CHANNEL) == c4d.KEY_ESC:
            self._cancel_adjustment_or_placement(placement, win)
            return True
        if msg.GetInt32(c4d.BFM_INPUT_QUALIFIER) & (c4d.QUALIFIER_ALT | c4d.QUALIFIER_CTRL | c4d.QUALIFIER_SHIFT):
            return False
        mode = msg.GetString(c4d.BFM_INPUT_ASC).lower()
        if mode not in _ADJUST_HELP:
            return False
        placement["mode"] = mode
        win.StatusSetText(_ADJUST_HELP[mode])
        _redraw()
        return True


def register():
    # Choose a free local-development slot independently of the bridge timer.
    for plugin_id in range(1000009, 1000000, -1):
        if c4d.plugins.FindPlugin(plugin_id, c4d.PLUGINTYPE_ANY) is not None:
            continue
        tool = PlacementTool(plugin_id)
        if c4d.plugins.RegisterToolPlugin(
                id=plugin_id, str="Nexus 视口放置", info=c4d.PLUGINFLAG_HIDEPLUGINMENU,
                icon=None, help=_HELP, dat=tool):
            return tool
    return None
