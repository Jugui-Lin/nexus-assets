// Dependency-free development preview. Production desktop runs Rust + SQLite.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Catalog} from './lib/catalog.mjs';
import {seedDemo} from './lib/demo.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const catalog=new Catalog(path.join(root,'data','preview'));seedDemo(catalog);
const token=crypto.randomBytes(32).toString('hex'),port=Number(process.env.PORT||47820);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  try{
    if(req.headers.host!==`127.0.0.1:${port}`&&req.headers.host!==`localhost:${port}`)return json(res,{error:'Invalid host'},403);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    const url=new URL(req.url,`http://127.0.0.1:${port}`);
    if(url.pathname.startsWith('/api/')){
      if(req.method!=='POST'||req.headers['x-nexus-token']!==token)return json(res,{error:'Unauthorized'},403);
      let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)return json(res,{error:'Request too large'},413);}
      const a=JSON.parse(body||'{}');
      switch(url.pathname.slice(5)){
        case 'get_state':return json(res,{...catalog.db,sessions:[],engine:'Development preview'});
        case 'get_activity':return json(res,{jobs:[],sessions:[]});
        case 'patch_asset':return json(res,catalog.patch(a.id,a.patch));
        case 'scan_library':return json(res,catalog.scan(a.path,{name:a.name,source:a.source}));
        case 'read_preview':{
          const asset=catalog.asset(a.id);
          if(['mesh','mesh_thumbnail'].includes(a.mode)){
            const limit=a.mode==='mesh_thumbnail'?750000:30000000;
            if(!['obj','stl','ply','glb','gltf'].includes(asset.ext)||fs.statSync(asset.path).size>limit)throw Error('文件格式或大小超出此预览模式的限制');
            if(asset.ext!=='obj')return json(res,{base64:fs.readFileSync(asset.path).toString('base64')});
            return json(res,{text:fs.readFileSync(asset.path,'utf8')});
          }
          const p=asset.kind==='texture'?asset.path:asset.thumbnail;if(!p||!fs.existsSync(p))return json(res,null);
          const mime=types[path.extname(p).toLowerCase()];if(!mime?.startsWith('image/')||fs.statSync(p).size>20000000)return json(res,null);
          return json(res,{url:`data:${mime};base64,${fs.readFileSync(p).toString('base64')}`});
        }
        case 'pick_folder':throw Error('开发预览请粘贴目录路径；原生文件选择器请使用 Tauri 桌面版');
        case 'import_files':case 'reveal_asset':case 'export_bridge':case 'queue_import':throw Error('此操作需要 Rust 桌面版，请运行编译后的 Nexus Assets');
        default:return json(res,{error:'Unknown command'},404);
      }
    }
    if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);
    const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
    const file=path.resolve(root,'public',relative),publicRoot=path.join(root,'public')+path.sep;
    if(!file.startsWith(publicRoot)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Not found'},404);
    let content=fs.readFileSync(file);if(relative==='index.html')content=Buffer.from(content.toString().replace('<head>','<head><meta name="nexus-token" content="'+token+'">'));
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(content);
  }catch(e){json(res,{error:e.message},400);}
});
server.listen(port,'127.0.0.1',()=>console.log(`Nexus UI preview: http://127.0.0.1:${port}`));
