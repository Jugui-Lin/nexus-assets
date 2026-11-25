import { Catalog } from '../lib/catalog.mjs';
import { seedDemo } from '../lib/demo.mjs';
import fs from 'node:fs';
import path from 'node:path';
const catalog = new Catalog('resources');
seedDemo(catalog);
fs.writeFileSync('resources/demo/manifest.json',JSON.stringify(catalog.db.assets.map(a=>({...a,path:path.basename(a.path),thumbnail:path.basename(a.thumbnail)})),null,2));
fs.unlinkSync('resources/catalog.json');
