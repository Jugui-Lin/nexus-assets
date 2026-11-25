"""Mock Cinema 4D bindings to check the placement lifecycle outside the host."""

from pathlib import Path
import math
import runpy
import sys
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "bridges" / "install" / "c4d_placement.py"


class Document:
    def __init__(self):
        self.action = 100
        self.closed_undo = 0
        self.undo = []
        self.objects = []
        self.materials = []
        self.selection = []

    def GetAction(self):
        return self.action

    def SetAction(self, action):
        self.action = action

    def IsEditMode(self):
        return False

    def GetFirstObject(self):
        return next(iter(self.objects), None)

    def GetFirstMaterial(self):
        return next(iter(self.materials), None)

    def GetActiveObjects(self, flags):
        return list(self.selection)

    def GetActiveObject(self):
        return next(iter(self.selection), None)

    def SetActiveObject(self, item, mode=None):
        if item is None:
            self.selection.clear()
        else:
            self.selection.append(item)

    def StartUndo(self):
        return True

    def AddUndo(self, kind, item):
        self.undo.append(item)

    def EndUndo(self):
        self.closed_undo += 1


class Node:
    def __init__(self, owner):
        self.owner = owner
        self.matrix = 2
        owner.append(self)

    def GetNext(self):
        index = self.owner.index(self) + 1
        return self.owner[index] if index < len(self.owner) else None

    def Remove(self):
        self.owner.remove(self)

    def GetMg(self):
        return self.matrix

    def SetMg(self, matrix):
        self.matrix = matrix


class Editor:
    def __init__(self):
        self.camera_hotkey = None
        self.status = ""
        self.events = iter([])
        self.dragging = False
        self.drag_result = None

    def IsHotkeyDown(self, key):
        return key == self.camera_hotkey

    def StatusSetText(self, text):
        self.status = text

    def MouseDragStart(self, button, x, y, flags):
        assert not self.dragging
        self.dragging = True

    def MouseDrag(self):
        assert self.dragging
        return next(self.events)

    def MouseDragEnd(self):
        assert self.dragging
        self.dragging = False
        return self.drag_result


class ToolPlacementTests(TestCase):
    def setUp(self):
        self.doc = Document()
        self.original = Node(self.doc.objects)
        self.doc.selection = [self.original]
        self.result = []
        self.editor = Editor()
        self.c4d = SimpleNamespace(
            plugins=SimpleNamespace(ToolData=object), documents=SimpleNamespace(
                GetActiveDocument=lambda: self.doc, MergeDocument=self.merge_document),
            EVENT_ENQUEUE_REDRAW=1, EVENT_NOEXPRESSION=2, EventAdd=lambda _flags: None,
            StopAllThreads=lambda: None,
            SCENEFILTER_OBJECTS=1, SCENEFILTER_MATERIALS=2, SCENEFILTER_MERGESCENE=4, SCENEFILTER_NOUNDO=8,
            GETACTIVEOBJECTFLAGS_CHILDREN=1, SELECTION_ADD=1, UNDOTYPE_NEWOBJ=1,
            BFM_INPUT_CHANNEL=20, BFM_INPUT_MOUSELEFT=21, BFM_INPUT_MOUSERIGHT=22, KEY_ESC=23,
            BFM_INPUT_X=24, BFM_INPUT_Y=25, BFM_INPUT_QUALIFIER=26, BFM_INPUT_ASC=27,
            BFM_INPUT_MOUSEWHEEL=28, BFM_INPUT_MOUSEMIDDLE=29,
            QUALIFIER_ALT=1, QUALIFIER_CTRL=2, QUALIFIER_SHIFT=4,
            HOTKEY_CAMERA_MOVE=30, HOTKEY_CAMERA_SCALE=31, HOTKEY_CAMERA_ROTATE=32, HOTKEY_ZOOM=33,
            KEY_MLEFT=34, MOUSEDRAGFLAGS_DONTHIDEMOUSE=35,
            MOUSEDRAGRESULT_CONTINUE=36, MOUSEDRAGRESULT_FINISHED=37, MOUSEDRAGRESULT_ESCAPE=38,
            DRAWFLAGS_ONLY_ACTIVE_VIEW=1, DRAWFLAGS_NO_THREAD=2, DRAWFLAGS_NO_ANIMATION=4,
            DrawViews=lambda _flags: None,
        )
        with patch.dict(sys.modules, {"c4d": self.c4d}):
            self.module = runpy.run_path(str(SCRIPT))
        self.tool = self.module["PlacementTool"](101)
        bindings = self.tool.start.__globals__
        bindings["_prepare"] = lambda files: ([(item["path"], 3) for item in files], ())
        bindings["_surface"] = lambda *_args: (None, None)
        bindings["_pose"] = lambda *_args: 5

    @staticmethod
    def merge_document(doc, path, flags, thread):
        assert flags == 15
        Node(doc.materials)
        doc.selection = [Node(doc.objects)]
        return path != "failed.obj"

    def begin(self, *paths):
        self.tool.start([{"path": path} for path in paths],
                        lambda status, message: self.result.append((status, message)))

    def click(self, channel=None, qualifier=0):
        values = {
            self.c4d.BFM_INPUT_CHANNEL: channel or self.c4d.BFM_INPUT_MOUSELEFT,
            self.c4d.BFM_INPUT_X: 100, self.c4d.BFM_INPUT_Y: 200,
            self.c4d.BFM_INPUT_QUALIFIER: qualifier,
        }
        msg = SimpleNamespace(GetInt32=values.__getitem__)
        return self.tool.MouseInput(self.doc, None, object(), self.editor, msg)

    def key(self, key, qualifier=0, channel=0):
        values = {self.c4d.BFM_INPUT_CHANNEL: channel, self.c4d.BFM_INPUT_QUALIFIER: qualifier}
        msg = SimpleNamespace(GetInt32=values.__getitem__, GetString=lambda _: key)
        return self.tool.KeyboardInput(self.doc, None, object(), self.editor, msg)

    def drag(self, dx, finish=None):
        finish = finish or self.c4d.MOUSEDRAGRESULT_FINISHED
        self.editor.events = iter([
            (self.c4d.MOUSEDRAGRESULT_CONTINUE, dx, 0, None),
            (finish, 0, 0, None),
        ])
        self.editor.drag_result = finish
        self.assertTrue(self.click())

    def test_preview_does_not_write_before_click_and_groups_undo(self):
        self.begin("chair.obj", "cushion.obj")
        self.assertEqual(self.doc.objects, [self.original])
        self.assertEqual(self.doc.materials, [])
        self.assertTrue(self.click())
        self.assertEqual(self.result, [("placed", None)])
        self.assertEqual(self.doc.action, 100)
        self.assertEqual([obj.matrix for obj in self.doc.objects], [2, 30, 30])
        self.assertEqual(self.doc.closed_undo, 1)
        self.assertEqual(self.doc.undo, self.doc.materials + self.doc.objects[1:])

    def test_escape_and_project_switch_cancel_without_scene_edits(self):
        self.begin("chair.obj")
        self.assertTrue(self.key("", channel=self.c4d.KEY_ESC))
        self.assertEqual(self.result, [("cancelled", None)])
        previous = self.doc
        self.assertEqual(previous.action, 100)
        self.assertEqual(previous.selection, [self.original])
        self.begin("chair.obj")
        self.doc = Document()
        self.tool.check_document()
        self.assertEqual(self.result[-1][0], "cancelled")
        self.assertEqual(previous.objects, [self.original])
        self.assertEqual(previous.action, 100)

    def test_failed_merge_rolls_back_both_files_and_selection(self):
        self.begin("chair.obj", "failed.obj")
        self.assertTrue(self.click())
        self.assertEqual(self.result[0][0], "failed")
        self.assertIn("failed.obj", self.result[0][1])
        self.assertEqual(self.doc.objects, [self.original])
        self.assertEqual(self.doc.materials, [])
        self.assertEqual(self.doc.selection, [self.original])
        self.assertFalse(self.doc.undo)

    def test_rotation_and_scale_are_retained_for_the_final_merge(self):
        self.tool.start.__globals__["_pose"] = lambda point, normal, heading, scale: scale
        self.begin("chair.obj")
        self.assertTrue(self.key("r"))
        self.drag(180)
        self.assertAlmostEqual(self.tool.placement["heading"], math.pi / 2)
        self.assertTrue(self.key("t"))
        self.drag(160)
        self.assertEqual(self.result, [])
        self.assertEqual(self.doc.objects, [self.original])
        self.assertAlmostEqual(self.tool.placement["scale"], 2.0)
        self.assertTrue(self.click())
        self.assertEqual(self.result, [("placed", None)])
        self.assertEqual([item.matrix for item in self.doc.objects], [2, 12])
        self.assertEqual(self.doc.closed_undo, 1)

    def test_cancel_during_drag_and_before_drag_return_to_placement(self):
        self.begin("chair.obj")
        self.assertTrue(self.key("t"))
        self.drag(160, self.c4d.MOUSEDRAGRESULT_ESCAPE)
        self.assertEqual(self.tool.placement["scale"], 1.0)
        self.assertTrue(self.key("r"))
        self.assertTrue(self.key("", channel=self.c4d.KEY_ESC))
        self.assertEqual(self.result, [])
        self.assertIsNone(self.tool.placement["mode"])
        self.assertTrue(self.key("", channel=self.c4d.KEY_ESC))
        self.assertEqual(self.result, [("cancelled", None)])

    def test_wheel_camera_controls_and_modified_shortcuts_pass_through(self):
        self.begin("chair.obj")
        self.assertFalse(self.key("r", self.c4d.QUALIFIER_CTRL))
        self.assertFalse(self.key("t", self.c4d.QUALIFIER_SHIFT))
        for modifier in (0, self.c4d.QUALIFIER_SHIFT):
            self.assertFalse(self.click(self.c4d.BFM_INPUT_MOUSEWHEEL, modifier))
        for button in (self.c4d.BFM_INPUT_MOUSELEFT, self.c4d.BFM_INPUT_MOUSERIGHT):
            self.assertFalse(self.click(button, self.c4d.QUALIFIER_ALT))
        self.assertFalse(self.click(self.c4d.BFM_INPUT_MOUSEMIDDLE))
        self.editor.camera_hotkey = self.c4d.HOTKEY_CAMERA_ROTATE
        self.assertFalse(self.click())
        self.assertEqual(self.result, [])


if __name__ == "__main__":
    main()
