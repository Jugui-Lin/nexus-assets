"""Run in a factory-startup Blender process, then send one asset from Nexus UI.
Reads only this app's local bridge token; never prints or exports it.
"""
import os
import sys
import json
import time
import sqlite3
import importlib.util
import uuid
from pathlib import Path
import bpy

root = Path(__file__).resolve().parents[1]
if sys.platform == 'win32':
    db = Path(os.environ['APPDATA']) / 'studio.nexus.assets' / 'nexus.sqlite3'
elif sys.platform == 'darwin':
    db = Path.home() / 'Library/Application Support/studio.nexus.assets/nexus.sqlite3'
else:
    db = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'studio.nexus.assets/nexus.sqlite3'
conn = sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True)
token = conn.execute("SELECT value FROM settings WHERE key='bridge_token'").fetchone()[0]
conn.close()
spec = importlib.util.spec_from_file_location('nexus_e2e', root / 'bridges/nexus_bridge.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bridge = module.Bridge({'url': 'http://127.0.0.1:47821', 'token': token, 'dcc': 'blender'})
before = len(bpy.data.objects)
deadline = time.monotonic() + 180
print('NEXUS_E2E_READY: send an OBJ asset from Nexus UI', flush=True)
imported = False
submitted = False
try:
    while time.monotonic() < deadline:
        if '--self-queue' in sys.argv and bridge.session and not submitted:
            # Integration fixture: exercises Rust claim/ack + real Blender import.
            # UI command submission is intentionally separate from this headless test.
            fixture_db = sqlite3.connect(str(db), timeout=5)
            asset = json.loads(fixture_db.execute("SELECT data FROM assets WHERE library_id='demo' AND name='弧线休闲椅'").fetchone()[0])
            job = {'id': str(uuid.uuid4()), 'sessionId': bridge.session, 'dcc': 'blender',
                   'assetId': asset['id'], 'name': asset['name'], 'path': asset['path'],
                   'status': 'queued', 'created': int(time.time())}
            fixture_db.execute('INSERT INTO jobs VALUES(?,?,?,?)',
                               (job['id'], bridge.session, 'queued', json.dumps(job)))
            fixture_db.commit()
            fixture_db.close()
            submitted = True
            print('NEXUS_E2E_QUEUED: isolated integration fixture', flush=True)
        bridge.tick()
        if len(bpy.data.objects) > before:
            imported = True
            if not bridge.in_flight:
                break
        time.sleep(0.1)
    assert imported, 'No asset received before deadline'
    assert not bridge.in_flight, 'Rust service did not acknowledge completion receipt'
    assert bpy.data.objects.get('Cube') is not None, 'Existing scene was replaced'
    result = {'blender': bpy.app.version_string, 'rust_bridge_obj_import': True,
              'receipt_acknowledged': not bridge.in_flight, 'preserved_existing_scene': True}
    out = root / 'test-results'
    out.mkdir(exist_ok=True)
    (out / 'blender-bridge-e2e.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print('NEXUS_E2E_PASS', json.dumps(result), flush=True)
finally:
    bridge.stop()
