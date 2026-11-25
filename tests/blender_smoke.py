import sys
import json
import importlib.util
from pathlib import Path
import bpy

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("nexus_bridge_test", root / "bridges/nexus_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
before = len(bpy.data.objects)
bridge.import_asset("blender", str(root / "resources/demo/arc_lounge_chair.obj"))
after = len(bpy.data.objects)
assert after > before, (before, after)
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name != 'Cube']
assert any(len(o.data.polygons) == 48 for o in meshes), "Expected chair mesh"
assert bpy.data.objects.get('Cube') is not None, "Existing scene must remain"
out = root / 'test-results'
out.mkdir(exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'bridge-source.blend'), copy=True)
before_append = len(bpy.data.objects)
bridge.import_asset("blender", str(out / 'bridge-source.blend'))
assert len(bpy.data.objects) > before_append
result = {"blender": bpy.app.version_string, "obj_import": True, "blend_append": True,
          "preserved_existing_scene": True, "chair_faces": 48}
(out / 'blender-smoke.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print('NEXUS_SMOKE_PASS', json.dumps(result))
