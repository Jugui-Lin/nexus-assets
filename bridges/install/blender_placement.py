"""Interactive placement for Nexus drop tickets in Blender's 3D viewport."""
import math

import bpy
from bpy_extras.view3d_utils import (
    region_2d_to_location_3d,
    region_2d_to_origin_3d,
    region_2d_to_vector_3d,
)
from mathutils import Matrix, Vector


_runtime = None
_active = None
_up = Vector((0.0, 0.0, 1.0))
_view_navigation = {
    "MIDDLEMOUSE", "TRACKPADPAN", "TRACKPADZOOM", "MOUSEROTATE", "MOUSESMARTZOOM", "NDOF_MOTION",
    "WHEELUPMOUSE", "WHEELDOWNMOUSE", "WHEELINMOUSE", "WHEELOUTMOUSE",
    "WHEELLEFTMOUSE", "WHEELRIGHTMOUSE",
    "NUMPAD1", "NUMPAD2", "NUMPAD3", "NUMPAD4", "NUMPAD5", "NUMPAD6", "NUMPAD7", "NUMPAD8", "NUMPAD9",
    "NUMPAD_PLUS", "NUMPAD_MINUS", "NUMPAD_PERIOD", "HOME",
}
_modal_navigation = {"VIEW3D_OT_rotate", "VIEW3D_OT_move", "VIEW3D_OT_zoom", "VIEW3D_OT_dolly"}
_modal_transforms = {
    "NEXUS_OT_scale_preview", "NEXUS_OT_rotate_preview",
    "TRANSFORM_OT_resize", "TRANSFORM_OT_rotate",
}
_geometry_types = {
    "MESH", "CURVE", "CURVES", "SURFACE", "FONT", "VOLUME",
    "POINTCLOUD", "META", "GREASEPENCIL",
}


def _object_view(context):
    return (
        context.mode == "OBJECT"
        and context.area is not None
        and context.area.type == "VIEW_3D"
        and context.region is not None
        and context.region.type == "WINDOW"
        and context.region_data is not None
    )


def _id_inventory():
    """Remember IDs so rollback can remove the data created by this import alone."""
    return {
        value.as_pointer(): value
        for prop in bpy.data.bl_rna.properties
        if prop.type == "COLLECTION"
        for value in getattr(bpy.data, prop.identifier)
        if isinstance(value, bpy.types.ID)
    }


def _bounds(objects):
    minimum = Vector((math.inf,) * 3)
    maximum = Vector((-math.inf,) * 3)
    for obj in objects:
        if obj.type not in _geometry_types:
            continue
        box = tuple(obj.bound_box)
        if not box or all(tuple(point) == (-1.0, -1.0, -1.0) for point in box):
            continue
        for point in box:
            world = obj.matrix_world @ Vector(point)
            for axis in range(3):
                minimum[axis] = min(minimum[axis], world[axis])
                maximum[axis] = max(maximum[axis], world[axis])
    if math.isfinite(minimum.x):
        return minimum, maximum
    points = [obj.matrix_world.translation for obj in objects]
    return (
        Vector(tuple(min(point[axis] for point in points) for axis in range(3))),
        Vector(tuple(max(point[axis] for point in points) for axis in range(3))),
    )


def _roots(objects):
    members = set(objects)
    return [obj for obj in objects if obj.parent not in members]


def _transform_keymap(context):
    keyconfig = context.window_manager.keyconfigs.user
    return keyconfig.keymaps.get("Object Mode") if keyconfig is not None else None


def _transform_kind(item):
    if item is None:
        return None
    if item.idname == "transform.resize":
        return "scale"
    if item.idname == "transform.rotate":
        return "rotate"
    if item.idname == "wm.tool_set_by_id":
        return {"builtin.scale": "scale", "builtin.rotate": "rotate"}.get(item.properties.name)
    return None


def _transform_labels(context):
    keymap = _transform_keymap(context)
    if keymap is None:
        return {"scale": "S", "rotate": "R"}
    labels = {}
    for item in keymap.keymap_items:
        if item.active and item.map_type == "KEYBOARD" and item.value == "PRESS":
            action = _transform_kind(item)
            if action:
                labels.setdefault(action, item.to_string(compact=True))
    return labels


class Placement:
    def __init__(self, context, runtime):
        self.context = context
        self.runtime = runtime
        self.scene = context.scene
        self.layer = context.view_layer
        self.selected = tuple(context.selected_objects)
        self.active = self.layer.objects.active
        self.active_collection = self.layer.active_layer_collection
        self.frame_start = self.scene.frame_start
        self.frame_end = self.scene.frame_end
        self.frame_current = self.scene.frame_current
        self.frame_subframe = self.scene.frame_subframe
        self.before = _id_inventory()
        self.added = []
        self.objects = []
        self.object_keys = set()
        self.align_to_surface = False

    def prepare(self, files):
        previous = {obj.as_pointer() for obj in self.layer.objects}
        next_x = None
        try:
            for file in files:
                self.runtime.import_asset("blender", file["path"])
                self.layer.update()
                group = [obj for obj in self.layer.objects if obj.as_pointer() not in previous]
                if not group:
                    raise RuntimeError("文件没有可放置的场景物体：" + file.get("name", file["path"]))
                low, high = _bounds(group)
                width = high.x - low.x
                if next_x is not None:
                    offset = Vector((next_x - low.x, 0.0, 0.0))
                    for obj in _roots(group):
                        transform = obj.matrix_world.copy()
                        transform.translation += offset
                        obj.matrix_world = transform
                    high.x += offset.x
                    self.layer.update()
                next_x = high.x + max(width * 0.1, 0.05)
                self.objects.extend(group)
                previous.update(obj.as_pointer() for obj in group)
        finally:
            self.added = [value for pointer, value in _id_inventory().items() if pointer not in self.before]
            self._restore_context()
        low, high = _bounds(self.objects)
        self.anchor = Vector(((low.x + high.x) * 0.5, (low.y + high.y) * 0.5, low.z))
        self.transforms = [(obj, obj.matrix_world.copy()) for obj in _roots(self.objects)]
        self.object_keys = {obj.as_pointer() for obj in self.added if isinstance(obj, bpy.types.Object)}
        self._select(self.objects, self.transforms[0][0])
        self.before.clear()

    def _restore_context(self):
        self.layer.active_layer_collection = self.active_collection
        self.scene.frame_start = self.frame_start
        self.scene.frame_end = self.frame_end
        if self.scene.frame_current != self.frame_current or self.scene.frame_subframe != self.frame_subframe:
            self.scene.frame_set(self.frame_current, subframe=self.frame_subframe)

    def _select(self, objects, active):
        target = set(objects)
        for obj in self.layer.objects:
            should_select = obj in target
            if obj.select_get(view_layer=self.layer) != should_select:
                obj.select_set(should_select, view_layer=self.layer)
        self.layer.objects.active = active

    def placement_frame(self, point, normal=_up):
        frame = Matrix.Translation(point)
        center = Matrix.Translation(-self.anchor)
        if self.align_to_surface and normal.length_squared > 1e-12:
            frame = frame @ _up.rotation_difference(normal).to_matrix().to_4x4()
        return frame @ center

    def move(self, point, normal=_up):
        frame = self.placement_frame(point, normal)
        for obj, original in self.transforms:
            obj.matrix_world = frame @ original

    def select_transform_roots(self):
        self._select([obj for obj, _ in self.transforms], self.transforms[0][0])

    def record_transform(self, frame):
        self.layer.update()
        to_asset_space = frame.inverted()
        self.transforms = [(obj, to_asset_space @ obj.matrix_world) for obj, _ in self.transforms]
        self._select(self.objects, self.transforms[0][0])

    def target(self, region, view, coords):
        direction = region_2d_to_vector_3d(region, view, coords)
        origin = region_2d_to_origin_3d(region, view, coords, clamp=10000.0)
        graph = self.context.evaluated_depsgraph_get()
        # Skip the preview's own intersections while keeping it visible.
        start = origin
        distance = 100000.0
        for _ in range(64):
            hit, location, normal, _, obj, _ = self.scene.ray_cast(graph, start, direction, distance=distance)
            if not hit:
                break
            if obj is not None and obj.original.as_pointer() not in self.object_keys:
                return location, normal
            step = max((location - start).length + 1e-4, 1e-4)
            start = start + direction * step
            distance -= step
            if distance <= 0.0:
                break
        if abs(direction.z) > 1e-6:
            depth = -origin.z / direction.z
            if 0.0 <= depth <= 100000.0:
                return origin + direction * depth, _up
        return region_2d_to_location_3d(region, view, coords, self.scene.cursor.location), _up

    def rollback(self):
        if self.added:
            bpy.data.batch_remove(ids=self.added)
            self.added.clear()
        self._restore_context()
        self._select(self.selected, self.active)


class NEXUS_OT_scale_preview(bpy.types.Macro):
    bl_idname = "nexus.scale_preview"
    bl_label = "缩放 Nexus 预览"
    # The child uses Blender's transform modal keymap. Only placement pushes undo.
    bl_options = {"INTERNAL"}


class NEXUS_OT_rotate_preview(bpy.types.Macro):
    bl_idname = "nexus.rotate_preview"
    bl_label = "旋转 Nexus 预览"
    bl_options = {"INTERNAL"}


class NEXUS_OT_place_asset_ticket(bpy.types.Operator):
    """Place assets from Nexus in the 3D viewport"""
    bl_idname = "nexus.place_asset_ticket"
    bl_label = "放置 Nexus 资产"
    bl_options = {"UNDO"}

    filepath: bpy.props.StringProperty(subtype="FILE_PATH", options={"SKIP_SAVE"})

    @classmethod
    def poll(cls, context):
        return _runtime is not None and _active is None and _object_view(context)

    def invoke(self, context, event):
        global _active
        if not self.filepath:
            return {"CANCELLED"}
        self._runtime = _runtime
        self._placement = None
        self._result = None
        self._area = context.area
        self._region = context.region
        self._view = context.region_data
        self._window_manager = context.window_manager
        self._navigation_timer = None
        self._navigation_view = None
        self._transform_timer = None
        self._transform_frame = None
        self._transform_autokey = None
        try:
            self._transform_labels = _transform_labels(context)
            files = self._runtime.resolve_drag_ticket(self.filepath, "blender")
            if not files:
                raise RuntimeError("拖放中没有可放置的资产")
            self._placement = Placement(context, self._runtime)
            self._placement.prepare(files)
            self._last_target = None
            self._follow(event)
            self._update_header()
            context.window_manager.modal_handler_add(self)
            _active = self
            return {"RUNNING_MODAL"}
        except Exception as error:
            return self._finish("failed", str(error))

    def _view_coords(self, event):
        coord = (event.mouse_x - self._region.x, event.mouse_y - self._region.y)
        if 0 <= coord[0] < self._region.width and 0 <= coord[1] < self._region.height:
            return coord
        return None

    def _follow(self, event):
        coord = self._view_coords(event)
        if coord is None:
            return False
        self._last_target = self._placement.target(self._region, self._view, coord)
        self._placement.move(*self._last_target)
        self._area.tag_redraw()
        return True

    def _update_header(self):
        labels = self._transform_labels
        shortcuts = [f"{labels[action]} {title}" for action, title in (
            ("scale", "缩放"), ("rotate", "旋转"),
        ) if action in labels]
        self._area.header_text_set(
            "  ·  ".join(["Nexus 放置", *shortcuts, "中键转视角", "A 对齐", "左键确认", "Esc 取消"])
        )

    def _update_transform(self, event):
        if not self._follow(event) and self._last_target is not None:
            self._placement.move(*self._last_target)
        self._update_header()

    def _follow_after_navigation(self, context):
        self._navigation_view = self._view.view_matrix.copy()
        if self._navigation_timer is None:
            self._navigation_timer = self._window_manager.event_timer_add(0.1, window=context.window)

    def _stop_navigation_timer(self):
        if self._navigation_timer is not None:
            self._window_manager.event_timer_remove(self._navigation_timer)
            self._navigation_timer = None

    def _start_transform(self, context, action):
        point, normal = self._last_target
        self._stop_navigation_timer()
        frame = self._placement.placement_frame(point, normal)
        self._placement.select_transform_roots()
        # Auto Keying applies to Blender's native operators, including temporary previews.
        settings = self._placement.scene.tool_settings
        if settings.use_keyframe_insert_auto:
            self._transform_autokey = settings
            settings.use_keyframe_insert_auto = False
        self._transform_timer = self._window_manager.event_timer_add(0.1, window=context.window)
        properties = {"center_override": point, "use_proportional_edit": False}
        if action == "scale":
            result = bpy.ops.nexus.scale_preview("INVOKE_DEFAULT", TRANSFORM_OT_resize=properties)
        else:
            result = bpy.ops.nexus.rotate_preview("INVOKE_DEFAULT", TRANSFORM_OT_rotate=properties)
        if "RUNNING_MODAL" in result:
            self._transform_frame = frame
        else:
            self._restore_transform_context()
            self._placement.record_transform(frame)
            self._update_header()

    def _restore_transform_context(self):
        if self._transform_autokey is not None:
            try:
                self._transform_autokey.use_keyframe_insert_auto = True
            except ReferenceError:
                pass
            self._transform_autokey = None
        if self._transform_timer is not None:
            self._window_manager.event_timer_remove(self._transform_timer)
            self._transform_timer = None

    def modal(self, context, event):
        try:
            running = {operator.bl_idname for operator in context.window.modal_operators}
            if self._transform_frame is not None:
                if running & _modal_transforms:
                    return {"PASS_THROUGH"}
                self._restore_transform_context()
                self._placement.record_transform(self._transform_frame)
                self._transform_frame = None
                self._update_header()
            if running & _modal_navigation:
                return {"PASS_THROUGH"}
            if event.type == "TIMER":
                if self._navigation_timer is not None:
                    view = self._view.view_matrix
                    if view == self._navigation_view:
                        self._stop_navigation_timer()
                        self._follow(event)
                    else:
                        self._navigation_view = view.copy()
                return {"PASS_THROUGH"}
            if event.type in _view_navigation:
                if self._view_coords(event) is not None:
                    self._follow_after_navigation(context)
                return {"PASS_THROUGH"}
            if event.type in {"ESC", "RIGHTMOUSE"} and event.value == "PRESS":
                return self._finish("cancelled")
            if event.type == "LEFTMOUSE" and event.value == "PRESS":
                return self._finish("placed") if self._follow(event) else {"RUNNING_MODAL"}
            if event.type in {"RET", "NUMPAD_ENTER"} and event.value == "PRESS" and self._last_target is not None:
                return self._finish("placed")
            if (
                event.value == "PRESS"
                and self._last_target is not None and self._view_coords(event) is not None
            ):
                keymap = _transform_keymap(context)
                if keymap is not None:
                    action = _transform_kind(keymap.keymap_items.match_event(event))
                elif not (event.shift or event.ctrl or event.alt or event.oskey):
                    action = {"S": "scale", "R": "rotate"}.get(event.type)
                else:
                    action = None
                if action:
                    self._start_transform(context, action)
                    return {"RUNNING_MODAL"}
            if event.type == "A" and event.value == "PRESS":
                self._placement.align_to_surface = not self._placement.align_to_surface
                self._update_transform(event)
            elif event.type in {"MOUSEMOVE", "INBETWEEN_MOUSEMOVE"}:
                self._follow(event)
            return {"RUNNING_MODAL"}
        except Exception as error:
            return self._finish("failed", str(error))

    def cancel(self, context):
        self._finish("cancelled")

    def _finish(self, result, message=None):
        global _active
        if getattr(self, "_result", None) is not None:
            return self._result
        self._stop_navigation_timer()
        self._restore_transform_context()
        placement = getattr(self, "_placement", None)
        self._placement = None
        if result != "placed" and placement is not None:
            try:
                placement.rollback()
            except Exception as error:
                message = "无法完全回退预览：" + str(error)
                result = "failed"
        if _active == self:
            _active = None
        area = getattr(self, "_area", None)
        if area is not None:
            try:
                area.header_text_set(None)
                area.tag_redraw()
            except ReferenceError:
                pass
        if message:
            self.report({"WARNING"}, message)
        runtime = getattr(self, "_runtime", None)
        if runtime is not None:
            try:
                runtime.finish_drag_ticket(self.filepath, "blender", result, message)
            except Exception as error:
                print("Nexus Assets 放置回执：", error)
        self._result = {"FINISHED"} if result == "placed" else {"CANCELLED"}
        return self._result


class NEXUS_FH_asset_ticket(bpy.types.FileHandler):
    bl_idname = "NEXUS_FH_asset_ticket"
    bl_label = "放置 Nexus 资产"
    bl_import_operator = "nexus.place_asset_ticket"
    bl_file_extensions = ".nexusdrop"

    @classmethod
    def poll_drop(cls, context):
        return _runtime is not None and _active is None and _object_view(context)


_classes = (
    NEXUS_OT_scale_preview,
    NEXUS_OT_rotate_preview,
    NEXUS_OT_place_asset_ticket,
    NEXUS_FH_asset_ticket,
)


def register(runtime):
    global _runtime
    registered = []
    try:
        for cls in _classes:
            bpy.utils.register_class(cls)
            registered.append(cls)
        NEXUS_OT_scale_preview.define("TRANSFORM_OT_resize")
        NEXUS_OT_rotate_preview.define("TRANSFORM_OT_rotate")
    except Exception:
        for cls in reversed(registered):
            bpy.utils.unregister_class(cls)
        raise
    _runtime = runtime


def unregister():
    global _runtime
    if _active is not None:
        _active.cancel(bpy.context)
    _runtime = None
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)
