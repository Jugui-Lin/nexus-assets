import sys
import json
import importlib.util
from pathlib import Path
import c4d

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("nexus_bridge_test", root / "bridges/nexus_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
doc = c4d.documents.BaseDocument()
c4d.documents.InsertBaseDocument(doc)
c4d.documents.SetActiveDocument(doc)
sentinel = c4d.BaseObject(c4d.Ocube)
sentinel.SetName('ExistingSceneSentinel')
doc.InsertObject(sentinel)
bridge.import_asset('c4d', str(root / 'resources/demo/arc_lounge_chair.obj'))
assert doc.SearchObject('ExistingSceneSentinel') is not None
assert doc.GetFirstObject().GetNext() is not None, 'No imported object found'
out = root / 'test-results'
out.mkdir(exist_ok=True)
result = {'c4d': c4d.GetC4DVersion(), 'obj_merge': True, 'preserved_existing_scene': True}
(out / 'c4d-smoke.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print('NEXUS_SMOKE_PASS', json.dumps(result))
