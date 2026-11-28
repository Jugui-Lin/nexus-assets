const renderExtensions = new Set(['exr','png','jpg','jpeg','tiff','tif','webp','bmp','hdr']);
const windowsPath = /^(?:[a-z]:[\\/]|[\\/]{2})/i;

// Match the filename rules used by the native render-sequence viewer.
function renderFrame(name) {
  if (typeof name !== 'string') return null;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  if (!renderExtensions.has(extension)) return null;
  const stem = name.slice(0,dot);
  const digits = /[0-9]+$/.exec(stem);
  if (!digits || digits.index + digits[0].length !== stem.length || digits[0].length > 6) return null;
  return {prefix:stem.slice(0,digits.index),extension,padding:digits[0].length,number:Number(digits[0])};
}

export function isExplorerRenderFrame(name) {
  return renderFrame(name) !== null;
}

export function groupExplorerRenderSequences(entries,pathKey) {
  const groups = new Map();
  for (const [index,entry] of entries.entries()) {
    if (entry.isDirectory || !entry.path) continue;
    const frame = renderFrame(entry.name);
    if (!frame) continue;
    const windows = windowsPath.test(entry.path);
    const separator = windows
      ? Math.max(entry.path.lastIndexOf('\\'),entry.path.lastIndexOf('/'))
      : entry.path.lastIndexOf('/');
    if (separator < 0) continue;
    const directory = pathKey(entry.path.slice(0,separator + 1));
    const {prefix,extension,padding,number} = frame;
    const key = JSON.stringify([directory,windows ? prefix.toLowerCase() : prefix,extension,padding]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,label:`${prefix}${'#'.repeat(padding)}.${extension}`,
        extension,padding,representativeIndex:index,frames:[],
      };
      groups.set(key,group);
    }
    group.frames.push({index,number,entry});
  }
  const groupsByIndex = new Map();
  for (const group of groups.values()) {
    if (group.frames.length < 2) continue;
    group.frames.sort((a,b) => a.number - b.number || a.index - b.index);
    group.first = group.frames[0].number;
    group.last = group.frames.at(-1).number;
    for (const frame of group.frames) groupsByIndex.set(frame.index,group);
  }
  return groupsByIndex;
}
