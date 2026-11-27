"""Verify legacy auto-bridge startup and import against the documented SDK surface."""

import ast
import builtins
import importlib.machinery
import importlib.util
from pathlib import Path
from queue import Queue
import runpy
import sys
import tempfile
import threading
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1] / "bridges"
BOOTSTRAP = ROOT / "install" / "c4d.pyp"
RUNTIME = ROOT / "nexus_bridge.py"
BRIDGE_KEY = "_nexus_bridge_c4d"


class BootstrapTests(TestCase):
    def test_base_sources_accept_the_cinema_4d_2023_python_grammar(self):
        for path in (BOOTSTRAP, RUNTIME, ROOT / "install" / "runtime_config.py"):
            ast.parse(path.read_text(encoding="utf8"), filename=str(path), feature_version=(3, 9))

    def check_host(self, version, advanced, headless=False):
        registered = []
        document = SimpleNamespace(GetDocumentName=lambda: "Fixture")
        merge = Mock(return_value=True)
        event_add = Mock()
        sdk = SimpleNamespace(
            GeGetVersionType=lambda: 1, VERSIONTYPE_CINEMA4D=1, GetC4DVersion=lambda: version,
            GeGetCinemaInfo=lambda flag: headless, CINEMAINFO_FORBID_GUI=2,
            C4DPL_ENDACTIVITY=3, C4DPL_RELOADPYTHONPLUGINS=4, MSG_TIMER=5, PLUGINTYPE_ANY=0,
            plugins=SimpleNamespace(MessageData=object, FindPlugin=lambda *args: None,
                                    RegisterMessagePlugin=lambda **args: registered.append(args["dat"]) or True),
            threading=SimpleNamespace(GeIsMainThreadAndNoDrawThread=lambda: True),
            documents=SimpleNamespace(GetActiveDocument=lambda: document, MergeDocument=merge),
            SCENEFILTER_OBJECTS=1, SCENEFILTER_MATERIALS=2, SCENEFILTER_MERGESCENE=4, EventAdd=event_add,
        )
        placement = Mock()
        smart = Mock()
        smart.poll.return_value = None
        smart.import_progress = Queue()
        runtime = runpy.run_path(str(RUNTIME))
        modules = {
            "_nexus_c4d_runtime": {"Bridge": runtime["Bridge"], "read_config": lambda dcc: {"dcc": dcc}},
            "_nexus_c4d_placement": {"register": lambda: placement},
            "_nexus_c4d_smart_import": {"SmartImporter": lambda *args: smart},
        }
        imports = []

        def module_spec(name, path):
            imports.append(name)
            loader = SimpleNamespace(create_module=lambda spec: None,
                                     exec_module=lambda target: vars(target).update(modules[name]))
            return importlib.machinery.ModuleSpec(name, loader)

        namespace = {"__file__": str(BOOTSTRAP), "__NEXUS_RUNTIME_PATH__": str(RUNTIME)}
        with patch.dict(sys.modules, {"c4d": sdk}), patch.dict(vars(builtins), {BRIDGE_KEY: None}), \
                patch.object(importlib.util, "spec_from_file_location", side_effect=module_spec), patch.object(threading, "Thread"):
            exec(compile(BOOTSTRAP.read_text(encoding="utf8"), str(BOOTSTRAP), "exec"), namespace)
            if headless:
                self.assertEqual(registered, [])
                self.assertEqual(imports, [])
                return
            self.assertEqual(len(registered), 1)
            messages = registered[0]
            messages.CoreMessage(sdk.MSG_TIMER, None)
            bridge = messages.bridge
            self.assertIs(getattr(builtins, BRIDGE_KEY), bridge)
            self.assertEqual(imports, (["_nexus_c4d_placement", "_nexus_c4d_runtime", "_nexus_c4d_smart_import"]
                                       if advanced else ["_nexus_c4d_runtime"]))
            self.assertIs(bridge.smart_import, smart if advanced else None)

            advertised = []

            def request(route, payload):
                if route == "/bridge/register":
                    advertised.append(payload)
                    return {"id": "fixture-session"}
                if route == "/bridge/claim":
                    bridge.running = False
                    return {"job": {"id": "fixture", "path": str(original)}}
                return {}

            with tempfile.TemporaryDirectory() as folder:
                original = Path(folder) / "model.fbx"
                original.touch()
                bridge.request = request
                bridge.network_loop()
                self.assertEqual(bridge.session, "fixture-session")
                for capability in ("placement", "smartImport", "projectExport", "sceneImportOptions", "pbrMaterialSets"):
                    self.assertEqual(advertised[0][capability], advanced)
                bridge.running = True
                messages.CoreMessage(sdk.MSG_TIMER, None)
                merge.assert_called_once_with(document, str(original), 7, None)
                event_add.assert_called_once_with()
                self.assertEqual(bridge.receipts.get_nowait(), {"jobId": "fixture", "ok": True})
            namespace["PluginMessage"](sdk.C4DPL_ENDACTIVITY, None)
            self.assertFalse(bridge.running)

    def test_legacy_gui_uses_base_bridge(self):
        for version in (2023000, 2023100, 2023200, 2024000, 2024500):
            with self.subTest(version=version):
                self.check_host(version, advanced=False)

    def test_2025_keeps_optional_advanced_plugins(self):
        self.check_host(2025000, advanced=True)

    def test_headless_legacy_host_does_not_register(self):
        self.check_host(2023200, advanced=False, headless=True)


if __name__ == "__main__":
    main()
