# Nexus Assets Bridge for Cinema 4D. Managed by Nexus Assets.
import builtins
import importlib.util
import os
import time
from pathlib import Path

import c4d


_RUNTIME_PATH = __NEXUS_RUNTIME_PATH__
_BRIDGE_KEY = "_nexus_bridge_c4d"
_CONFIG_REFRESH_SECONDS = 2
_ADVANCED_MIN_C4D_VERSION = 2025000


def _load_runtime():
    spec = importlib.util.spec_from_file_location("_nexus_c4d_runtime", _RUNTIME_PATH)
    if spec is None or spec.loader is None:
        raise ImportError("Unable to locate the Nexus Assets bridge runtime.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_placement():
    path = os.path.join(os.path.dirname(__file__), "nexus_c4d_placement.py")
    spec = importlib.util.spec_from_file_location("_nexus_c4d_placement", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.register()


def _load_smart_import():
    path = Path(__file__).with_name("nexus_c4d_smart_import.py")
    spec = importlib.util.spec_from_file_location("_nexus_c4d_smart_import", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app_root = Path(_RUNTIME_PATH).parent.parent
    return module.SmartImporter(c4d, app_root)


class _BridgeMessages(c4d.plugins.MessageData):
    def __init__(self, placement, advanced):
        super().__init__()
        self.placement = placement
        self.advanced = advanced
        self.bridge = None
        self.runtime = None
        self.check_at = 0.0
        self.closing = False
        self.last_error = None
        self.smart_import = None
        self.smart_load_attempted = False

    def GetTimer(self):
        return 0 if self.closing else 300

    def _stop_bridge(self):
        bridge, self.bridge = self.bridge, None
        if bridge is None:
            return
        if self.placement is not None:
            self.placement.complete("cancelled")
        bridge.stop()
        if getattr(builtins, _BRIDGE_KEY, None) is bridge:
            delattr(builtins, _BRIDGE_KEY)

    def close(self):
        self.closing = True
        self._stop_bridge()

    def _refresh_connection(self):
        active = getattr(builtins, _BRIDGE_KEY, None)
        if self.bridge is not None and (active is not self.bridge or not self.bridge.running):
            self._stop_bridge()
        # The exported Script Manager bridge has its own UI timer.
        if active is not None and active is not self.bridge and active.running:
            return

        now = time.monotonic()
        if now < self.check_at:
            return
        self.check_at = now + _CONFIG_REFRESH_SECONDS
        try:
            if self.runtime is None:
                self.runtime = _load_runtime()
            config = self.runtime.read_config("c4d")
            if self.placement is not None:
                config["placement"] = True
            if self.advanced and not self.smart_load_attempted:
                self.smart_load_attempted = True
                try:
                    self.smart_import = _load_smart_import()
                except Exception as error:
                    print("Nexus Assets smart import:", error)
            if self.smart_import is not None:
                config["smartImport"] = True
        except FileNotFoundError:
            self._stop_bridge()
            return
        self.last_error = None
        if self.bridge is not None and self.bridge.config != config:
            self._stop_bridge()
        if self.bridge is None and config:
            self.bridge = self.runtime.Bridge(config, smart_import=self.smart_import)
            if self.placement is not None:
                self.bridge.placement_handler = self.placement.start
            setattr(builtins, _BRIDGE_KEY, self.bridge)

    def CoreMessage(self, message_id, data):
        if (message_id != c4d.MSG_TIMER or self.closing
                or not c4d.threading.GeIsMainThreadAndNoDrawThread()):
            return True
        try:
            self._refresh_connection()
            if self.bridge is not None:
                if self.placement is not None:
                    self.placement.check_document()
                self.bridge.tick()
        except Exception as error:
            error_message = str(error)
            if error_message != self.last_error:
                self.last_error = error_message
                print("Nexus Assets Bridge:", error_message)
        return True


def _register():
    if (c4d.GeGetVersionType() != c4d.VERSIONTYPE_CINEMA4D
            or c4d.GeGetCinemaInfo(c4d.CINEMAINFO_FORBID_GUI)):
        return None
    # Cinema 4D 2023 and 2024 use the basic bridge without the optional import and placement plug-ins.
    advanced = c4d.GetC4DVersion() >= _ADVANCED_MIN_C4D_VERSION
    placement = None
    if advanced:
        try:
            placement = _load_placement()
        except Exception as error:
            print("Nexus Assets viewport placement:", error)
    # Maxon's test-only ID range for local, non-distributed plug-ins.
    for plugin_id in range(1000010, 1000000, -1):
        if c4d.plugins.FindPlugin(plugin_id, c4d.PLUGINTYPE_ANY) is not None:
            continue
        messages = _BridgeMessages(placement, advanced)
        if c4d.plugins.RegisterMessagePlugin(
                id=plugin_id, str="Nexus Assets Bridge", info=0, dat=messages):
            return messages
    print("Nexus Assets Bridge: No Cinema 4D development plug-in ID is free.")
    return None


_messages = _register()


def PluginMessage(message_id, data):
    if (_messages is not None and message_id in (
            c4d.C4DPL_ENDACTIVITY, c4d.C4DPL_RELOADPYTHONPLUGINS)):
        _messages.close()
    return False
