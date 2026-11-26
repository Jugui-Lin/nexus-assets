const prefix = '\n[nexus-video-review:v1:';
const maximumText = 2048;
const maximumNotes = 20;

export function reviewShotCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z0-9][A-Z0-9_-]{0,47}$/.test(code) ? code : '';
}

function normalizeNote(value) {
  const {id,time,x,y,message,resolved,shot,ownerId,ownerName} = value || {};
  if (typeof id !== 'string' || !/^[a-z0-9-]{8,45}$/i.test(id) || !Number.isSafeInteger(time) || time < 0 ||
      !Number.isInteger(x) || x < 0 || x > 10000 || !Number.isInteger(y) || y < 0 || y > 10000 ||
      typeof message !== 'string' || !message.trim() || message.length > 180) return null;
  const normalized = {id,time,x,y,message:message.trim(),resolved:resolved === true};
  const shotCode = reviewShotCode(shot);
  if (shotCode) normalized.shot = shotCode;
  if (typeof ownerId === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(ownerId) && typeof ownerName === 'string' && ownerName.trim()) {
    normalized.ownerId = ownerId;
    normalized.ownerName = ownerName.trim().slice(0,80);
  }
  return normalized;
}

export function readReviewNotes(value = '') {
  const text = typeof value === 'string' ? value : '';
  const index = text.lastIndexOf(prefix);
  if (index < 0 || !text.endsWith(']')) return {text,notes:[]};
  try {
    const raw = JSON.parse(text.slice(index+prefix.length,-1));
    if (!Array.isArray(raw) || raw.length > maximumNotes) return {text,notes:[]};
    const notes = raw.map(entry => Array.isArray(entry) && normalizeNote({id:entry[0],time:entry[1],x:entry[2],y:entry[3],
      message:entry[4],resolved:entry[5] === 1,shot:entry[6],ownerId:entry[7],ownerName:entry[8]}));
    if (notes.some(note => !note) || new Set(notes.map(note => note.id)).size !== notes.length) return {text,notes:[]};
    return {text:text.slice(0,index),notes};
  } catch { return {text,notes:[]}; }
}

export function writeReviewNotes(text,notes) {
  const base = readReviewNotes(text).text;
  if (!notes.length) return base;
  if (notes.length > maximumNotes) throw Error('此素材的审片标注已达到容量上限');
  const normalized = notes.map(normalizeNote);
  if (normalized.some(note => !note)) throw Error('请检查审片标注的时间、位置或文字');
  const value = base + prefix + JSON.stringify(normalized.map(({id,time,x,y,message,resolved,shot,ownerId,ownerName}) => {
    const entry = [id,time,x,y,message,resolved ? 1 : 0];
    if (shot || ownerId) entry.push(shot || '',ownerId || '',ownerName || '');
    return entry;
  })) + ']';
  if (value.length > maximumText) throw Error('此素材的审片标注太长，请缩短说明');
  return value;
}

export function reviewTime(milliseconds) {
  const wholeSeconds = Math.floor(milliseconds/1000);
  const hours = Math.floor(wholeSeconds/3600);
  const minutes = String(Math.floor(wholeSeconds/60) % 60).padStart(2,'0');
  const seconds = String(wholeSeconds % 60).padStart(2,'0');
  const fraction = String(milliseconds % 1000).padStart(3,'0');
  return (hours ? hours + ':' : '') + minutes + ':' + seconds + '.' + fraction;
}

const escape = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);

export function repairListHtml(project,notes) {
  const ordered = notes.filter(note => !note.resolved).sort((a,b) => (a.shot || '').localeCompare(b.shot || '') ||
    a.title.localeCompare(b.title,'zh-CN') || a.time-b.time);
  const rows = ordered.map((note,index) => {
    const image = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(note.frame || '')
      ? `<figure><img alt="标注对应的画面" src="${escape(note.frame)}"><span style="left:${note.x/100}%;top:${note.y/100}%"></span></figure>` : '';
    return `<tr><td>${index+1}</td><td>${escape(note.shot || '未分配')}</td><td>${escape(note.ownerName || '未分配')}</td>` +
      `<td>${escape(note.title)}<small>${escape(note.source || '')}</small></td>` +
      `<td>${reviewTime(note.time)}</td><td>${escape(note.message)}<small>画面位置 ${note.x/100}%, ${note.y/100}%</small>${image}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(project)} · 返修单</title><style>
body{font:14px/1.5 system-ui,sans-serif;color:#262a30;margin:2em auto;padding:0 1em;max-width:1060px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-block-end:1px solid #a9aeb4;padding:.65em;overflow-wrap:anywhere}
small{display:block;color:#555;margin-top:.25em}figure{position:relative;width:min(100%,350px);margin:.5em 0 0}img{display:block;width:100%;height:auto}
figure span{position:absolute;translate:-50% -50%;width:20px;aspect-ratio:1;border:2px solid #f33937;border-radius:50%;box-shadow:0 0 0 1px #fafafa}
@media print{body{margin:0}tr{break-inside:avoid}}
</style><h1>${escape(project)} · 返修单</h1><p>未解决标注 ${ordered.length} 项</p>
<table><thead><tr><th>序号</th><th>镜头</th><th>负责人</th><th>素材</th><th>时间点</th><th>返修说明</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}
