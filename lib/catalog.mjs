import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FORMATS = {
  model: ['obj','fbx','gltf','glb','abc','usd','usda','usdc','stl','ply','3dm','3ds','3mf','aof','ass','atl','atlo','bvh','cgeo','cuap','dae'],
  scene: ['blend','c4d','max','ma','mb','hip','hiplc','hipnc'],
  material: ['sbsar','sbs','mtl','zip','mat','mdl','mtlx','rmtl','sbsprs','skm','vrmat','xsh'],
  texture: ['png','jpg','jpeg','webp','tif','tiff','exr','hdr','tga','bmp','ies','psd','dds','ai','arw','eps','gif','hdri','renv','svg'],
  video: ['3gp','amv','avi','f4p','f4v','flv','m2v','m4v','mkv','mov','mp2','mp4','mpe','mpeg','mpg','webm','wmv'],
  audio: ['aac','aiff','alac','flac','m4a','mp3','wav','wma'],
  bim: ['gsm','ifc','pla','pln','rfa','rft','rte','rvt','val'],
  cad: ['dwg','dxf','iges','igs','sat','step','stp'],
  script: ['csc','csr','dyn','gh','ghuser','mcr','mel','ms','mse','mzp','py','rb','rbs'],
  other: ['ini','pdf'],
};
export const COMPAT = {
  blender: ['obj','fbx','gltf','glb','abc','usd','usda','usdc','stl','ply','blend'],
  c4d: ['obj','fbx','abc','stl','c4d'],
  maya: ['obj','fbx','abc','ma','mb'],
  max: ['obj','fbx','3ds','max'],
  houdini: ['obj','fbx','abc','usd','usda','usdc','hip','hiplc','hipnc']
};
export const kindOf = ext => Object.keys(FORMATS).find(k => FORMATS[k].includes(ext));
export const idFor = p => crypto.createHash('sha256').update(path.resolve(p).toLowerCase()).digest('hex').slice(0,20);
export class Catalog {
  constructor(dir) {
    this.dir = path.resolve(dir); fs.mkdirSync(this.dir, {recursive:true});
    this.file = path.join(this.dir, 'catalog.json');
    this.db = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file,'utf8')) : {assets:[],libraries:[],jobs:[]};
    this.db.bridgeToken ||= crypto.randomBytes(32).toString('hex');
    this.save();
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.db,null,2)); fs.renameSync(temp,this.file);
  }
  addFile(file, libraryId, extra={}) {
    const ext = path.extname(file).slice(1).toLowerCase(), kind = kindOf(ext);
    if (!kind) return null;
    const stat = fs.statSync(file); if(!stat.isFile()) return null;
    const id = idFor(file), existing = this.db.assets.find(a=>a.id===id);
    if(existing) { existing.size=stat.size; existing.modified=stat.mtime.toISOString(); return existing; }
    const asset = {id,name:path.basename(file,path.extname(file)),path:path.resolve(file),ext,kind,size:stat.size,
      modified:stat.mtime.toISOString(),added:new Date().toISOString(),libraryId,tags:[],favorite:false,notes:'',...extra};
    if(!asset.thumbnail && kind!=='texture') {
      const stem=file.slice(0,-path.extname(file).length);
      asset.thumbnail = [stem+'.jpg',stem+'.png',path.join(path.dirname(file),'preview.jpg'),path.join(path.dirname(file),'preview.png')].find(p=>fs.existsSync(p)) || null;
    }
    this.db.assets.push(asset); return asset;
  }
  scan(root, {name,source='local'}={}) {
    root=path.resolve(root);
    if(!fs.statSync(root).isDirectory()) throw new Error('请选择文件夹');
    const id=idFor(root); let lib=this.db.libraries.find(l=>l.id===id);
    if(!lib) {lib={id,path:root,name:name||path.basename(root),source};this.db.libraries.push(lib);}
    let found=0, skipped=0; const errors=[], folders=[];
    const walk=(dir,depth=0)=>{
      if(depth>32) return;
      let entries; try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch(e){errors.push(dir+': '+e.message);return;}
      for(const ent of entries) {
        if(ent.isSymbolicLink() || ent.name.startsWith('.')) {skipped++;continue;}
        const p=path.join(dir,ent.name);
        if(ent.isDirectory()) {
          if (depth < 32) folders.push(path.relative(root, p).split(path.sep).join('/'));
          walk(p,depth+1);
        }
        else if(kindOf(path.extname(p).slice(1).toLowerCase())) {
          try {this.addFile(p,id);found++;}catch(e){errors.push(p+': '+e.message);}
        }
      }
    }; walk(root);
    lib.folders = errors.length ? [...new Set([...(lib.folders || []), ...folders])] : folders;
    lib.scannedAt=new Date().toISOString(); this.save();
    return {found,skipped,errors,library:lib};
  }
  asset(id) {const a=this.db.assets.find(a=>a.id===id);if(!a) throw new Error('资产不存在');return a;}
  patch(id, patch) {
    const a=this.asset(id);
    if(typeof patch.name==='string' && patch.name.trim()) a.name=patch.name.trim().slice(0,200);
    if(typeof patch.favorite==='boolean') a.favorite=patch.favorite;
    if(typeof patch.notes==='string') a.notes=patch.notes.slice(0,10000);
    if(Number.isInteger(patch.rating) && patch.rating >= 0 && patch.rating <= 5) a.rating=patch.rating;
    if(['unset','wip','review','approved','archived'].includes(patch.workflow)) a.workflow=patch.workflow;
    if(Array.isArray(patch.tags)) a.tags=[...new Set(patch.tags.filter(t=>typeof t==='string').map(t=>t.trim().slice(0,40)).filter(Boolean))].slice(0,30);
    this.save();return a;
  }
}
