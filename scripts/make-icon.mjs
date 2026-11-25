import fs from 'node:fs';import zlib from 'node:zlib';
const n=128,raw=Buffer.alloc((n*4+1)*n);for(let y=0;y<n;y++){raw[y*(n*4+1)]=0;for(let x=0;x<n;x++){const i=y*(n*4+1)+1+x*4,inside=x>15&&x<112&&y>15&&y<112,letter=inside&&((x>30&&x<44)||(x>83&&x<97)||(x>38&&x<90&&Math.abs(y-(x*.94+5))<9));const rgb=letter?[29,38,24]:inside?[201,231,152]:[23,25,27];raw.set([...rgb,255],i);}}
function crc(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([t,data])),8+data.length);return b;}
const head=Buffer.alloc(13);head.writeUInt32BE(n);head.writeUInt32BE(n,4);head[8]=8;head[9]=6;
fs.mkdirSync('src-tauri/icons',{recursive:true});const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);fs.writeFileSync('src-tauri/icons/icon.png',png);
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=128;ico[7]=128;ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);fs.writeFileSync('src-tauri/icons/icon.ico',Buffer.concat([ico,png]));
const icns=Buffer.alloc(16);icns.write('icns');icns.writeUInt32BE(16+png.length,4);icns.write('ic07',8);icns.writeUInt32BE(8+png.length,12);fs.writeFileSync('src-tauri/icons/icon.icns',Buffer.concat([icns,png]));
