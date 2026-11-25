import fs from 'node:fs';
import path from 'node:path';

export function meshBuilder() {
  const v=[], f=[];
  return {v,f,
    box(x,y,z,w,h,d) {
      const i=v.length;
      for(const p of [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]) v.push([x+p[0]*w/2,y+p[1]*h/2,z+p[2]*d/2]);
      for(const face of [[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]]) f.push(face.map(n=>n+i));
    },
    lathe(profile,cx=0,cz=0,n=36) {
      const off=v.length;
      profile.forEach(([r,y])=>{for(let i=0;i<n;i++){const a=i/n*Math.PI*2;v.push([cx+r*Math.cos(a),y,cz+r*Math.sin(a)]);}});
      for(let k=0;k<profile.length-1;k++) for(let i=0;i<n;i++) f.push([off+k*n+i,off+k*n+(i+1)%n,off+(k+1)*n+(i+1)%n,off+(k+1)*n+i]);
    },
    obj(){return '# Nexus original procedural demo · meters · Y up\n'+v.map(p=>'v '+p.join(' ')).join('\n')+'\n'+f.map(p=>'f '+p.map(n=>n+1).join(' ')).join('\n');}
  };
}
export function thumbnail(mesh,color='#c3b397') {
  const angle=-0.65, elev=0.42;
  const pts=mesh.v.map(([x,y,z])=>{const X=x*Math.cos(angle)-z*Math.sin(angle), Z=x*Math.sin(angle)+z*Math.cos(angle);return [X,-y*Math.cos(elev)+Z*Math.sin(elev),y*Math.sin(elev)+Z*Math.cos(elev)];});
  const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]), minX=Math.min(...xs),maxX=Math.max(...xs), minY=Math.min(...ys),maxY=Math.max(...ys);
  const scale=Math.min(210/(maxX-minX||1),210/(maxY-minY||1));
  const polygons=mesh.f.map(face=>{
    const p=face.map(i=>pts[i]), a=mesh.v[face[0]],b=mesh.v[face[1]],c=mesh.v[face[2]];
    const u=b.map((n,i)=>n-a[i]),w=c.map((n,i)=>n-a[i]);
    const normal=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
    const len=Math.hypot(...normal)||1, light=0.6+0.3*Math.abs((normal[0]*-.4+normal[1]*.8+normal[2]*.5)/len);
    const rgb=color.match(/\w\w/g).map(c=>Math.round(parseInt(c,16)*light));
    return {z:p.reduce((s,p)=>s+p[2],0)/p.length,svg:`<polygon points="${p.map(([x,y])=>`${160+(x-(minX+maxX)/2)*scale},${143+(y-(minY+maxY)/2)*scale}`).join(' ')}" fill="rgb(${rgb})" stroke="rgb(${rgb})" stroke-width="0.6"/>`};
  }).sort((a,b)=>a.z-b.z);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="280" viewBox="0 0 320 280"><defs><radialGradient id="bg"><stop stop-color="#34383b"/><stop offset="1" stop-color="#24272a"/></radialGradient><filter id="s"><feGaussianBlur stdDeviation="9"/></filter></defs><rect width="320" height="280" fill="url(#bg)"/><ellipse cx="160" cy="246" rx="75" ry="11" fill="#080a0c" opacity=".6" filter="url(#s)"/>${polygons.map(p=>p.svg).join('')}</svg>`;
}
export function seedDemo(catalog) {
  const dir=path.join(catalog.dir,'demo');fs.mkdirSync(dir,{recursive:true});
  const demos=[
    ['弧线休闲椅','Arc lounge chair','家具','#bdaa88',m=>{m.box(0,.58,0,1.25,.22,1.12);m.box(0,1.1,-.48,1.25,.95,.2);for(const x of [-.45,.45])for(const z of [-.38,.38])m.box(x,.24,z,.08,.5,.08);for(const x of [-.65,.65])m.box(x,.83,0,.12,.15,1.1);}],
    ['雕塑感边几','Sculpt side table','家具','#9d7561',m=>{m.lathe([[0,0],[.3,0],[.18,.12],[.12,.6],[.45,.72],[.48,.79],[0,.79]]);}],
    ['褶皱陶瓷花器','Terra ceramic vase','装饰','#b3ae9c',m=>{m.lathe([[0,0],[.25,0],[.4,.18],[.42,.48],[.24,.85],[.22,1.1],[.25,1.14],[.19,1.14],[.17,1.05],[.19,.88],[.32,.48],[.3,.2],[0,.12]],0,0,24);}],
    ['蘑菇台灯','Mushroom table lamp','灯具','#9eac91',m=>{m.lathe([[0,0],[.35,0],[.35,.08],[.12,.12],[.1,.85],[.7,.87],[.68,1.0],[.5,1.2],[.22,1.35],[0,1.38]]);}],
    ['模块双人沙发','Forma modular sofa','家具','#a4aa9d',m=>{m.box(0,.32,0,2,.45,.9);m.box(0,.77,-.43,2,.7,.22);for(const x of [-.96,.96])m.box(x,.6,0,.25,.65,1.0);for(const x of [-.44,.44])m.box(x,.58,.08,.83,.18,.77);for(const x of [-.8,.8])for(const z of [-.3,.3])m.box(x,.06,z,.08,.15,.08);}],
    ['石柱展台组合','Monolith pedestals','建筑','#a9a49b',m=>{m.box(-.38,.6,0,.55,1.2,.55);m.box(.35,.38,.2,.6,.76,.6);}],
    ['侘寂落地灯','Linea floor lamp','灯具','#c1b895',m=>{m.lathe([[0,0],[.38,0],[.38,.06],[0,.06]]);m.box(0,.85,0,.045,1.7,.045);m.lathe([[.46,1.45],[.3,1.95],[0,1.95]]);}],
    ['圆形实木餐桌','Orbit dining table','家具','#987c61',m=>{m.lathe([[0,.9],[.95,.9],[.95,.98],[0,.98]]);for(const x of [-.5,.5])for(const z of [-.5,.5])m.box(x,.45,z,.1,.9,.1);}],
    ['拱门空间构件','Portal archway','建筑','#b6a997',m=>{for(const x of [-.75,.75])m.box(x,.7,0,.25,1.4,.4);for(let i=0;i<16;i++){let a=i/16*Math.PI,b=(i+1)/16*Math.PI,off=m.v.length;for(const z of [-.2,.2])for(const r of [.625,.875])for(const t of [a,b])m.v.push([r*Math.cos(t),1.4+r*Math.sin(t),z]);for(const f of [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]])m.f.push(f.map(n=>off+n));}}],
    ['托盘与器皿','Still life collection','装饰','#a5a99c',m=>{m.lathe([[0,0],[.7,0],[.7,.08],[0,.08]]);m.lathe([[0,.08],[.16,.08],[.19,.45],[0,.45]],-.25,0);m.lathe([[0,.08],[.22,.08],[.3,.23],[.29,.25],[0,.12]],.25,.1);}]
  ];
  const libId='demo';
  if(!catalog.db.libraries.some(l=>l.id===libId))catalog.db.libraries.push({id:libId,name:'Nexus 示例资产',path:dir,source:'demo'});
  demos.forEach(([name,en,tag,color,build],i)=>{
    const m=meshBuilder();build(m);const file=path.join(dir,en.toLowerCase().replaceAll(' ','_')+'.obj'),thumb=file+'.svg';
    if(!fs.existsSync(file))fs.writeFileSync(file,m.obj());
    if(!fs.existsSync(thumb))fs.writeFileSync(thumb,thumbnail(m,color));
    catalog.addFile(file,libId,{name,subtitle:en,tags:[tag,'原创示例'],thumbnail:thumb,demo:true,color,vertices:m.v.length,faces:m.f.length,favorite:i===0||i===3});
  });catalog.save();
}
