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
