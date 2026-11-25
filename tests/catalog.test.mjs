// Development adapter regression tests; production core is covered by Rust tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Catalog,COMPAT} from '../lib/catalog.mjs';
import {seedDemo} from '../lib/demo.mjs';
test('directory rescan preserves edits and avoids duplicate records',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-catalog-'));
  try{
    const root=path.join(dir,'资产');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'椅子.obj'),'v 0 0 0\n');
    const c=new Catalog(path.join(dir,'db'));assert.equal(c.scan(root).found,1);const a=c.db.assets[0];
    c.patch(a.id,{name:'新名称',favorite:true,notes:'来源信息',tags:['家具','家具','']});
    c.scan(root);assert.equal(c.db.assets.length,1);assert.equal(c.db.assets[0].name,'新名称');assert.equal(c.db.assets[0].favorite,true);assert.deepEqual(c.db.assets[0].tags,['家具']);
    const reloaded=new Catalog(path.join(dir,'db'));assert.equal(reloaded.asset(a.id).notes,'来源信息');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('demo assets contain valid geometry and thumbnails',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-demo-'));
  try{const c=new Catalog(dir);seedDemo(c);assert.equal(c.db.assets.length,10);for(const a of c.db.assets){assert.match(fs.readFileSync(a.path,'utf8'),/\nf \d/);assert.match(fs.readFileSync(a.thumbnail,'utf8'),/<polygon/);}assert(!COMPAT.c4d.includes('max'));assert(!COMPAT.blender.includes('max'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
