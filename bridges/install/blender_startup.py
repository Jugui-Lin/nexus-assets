"""Nexus Assets startup module for Blender."""
import importlib.util
from pathlib import Path

import bpy


_runtime_file = __NEXUS_RUNTIME_PATH__
_bridge = None
_placement = None


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _connect():
    global _bridge, _placement
    try:
        runtime = _load("nexus_assets_bridge_runtime", _runtime_file)
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        print("Nexus Assets bridge:", error)
        return None
    try:
        placement_path = Path(__file__).resolve().parent.parent / "modules" / "nexus_assets_placement.py"
        placement = _load("nexus_assets_placement", placement_path)
        placement.register(runtime)
        _placement = placement
    except (OSError, RuntimeError, ImportError, ValueError) as error:
        print("Nexus Assets viewport placement:", error)
    try:
        _bridge = runtime.connect("blender", placement=_placement is not None)
    except (OSError, ValueError, RuntimeError) as error:
        print("Nexus Assets bridge:", error)
    return None


def register():
    if not bpy.app.background and _bridge is None and not bpy.app.timers.is_registered(_connect):
        bpy.app.timers.register(_connect, first_interval=0.5, persistent=True)


def unregister():
    global _bridge, _placement
    if bpy.app.timers.is_registered(_connect):
        bpy.app.timers.unregister(_connect)
    if _placement is not None:
        _placement.unregister()
        _placement = None
    if _bridge is not None:
        _bridge.stop()
        _bridge = None
