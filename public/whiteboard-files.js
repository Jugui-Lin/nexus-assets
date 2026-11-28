const marker = 'nexus:team-file:v1:';
const textLimit = 2048;
const idPattern = /^[a-z0-9_-]{1,128}$/i;
const invalidFilename = /[\x00-\x1f\x7f-\x9f:<>"/|?*\\]/;
const reservedDevice = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])$/i;
const modelExtensions = new Set(['c4d','blend','max','ma','mb','fbx','obj','abc','gltf','glb','stl','usd','usda','usdc','usdz','hip','hiplc','3ds','skp','step','stp']);
const imageExtensions = new Set(['jpg','jpeg','png','webp','gif','tif','tiff','exr','hdr','avif','heic','svg','bmp','psd','psb']);
const videoExtensions = new Set(['mp4','mov','webm','m4v','avi','mkv','wmv','mpeg','mpg']);

function goodFilename(part) {
  return part && !/[. ]$/.test(part) && !invalidFilename.test(part) &&
    !reservedDevice.test(part.split('.')[0].trimEnd());
}

function normalizeReference(value) {
  const {teamId,libraryId,path,unc,name,isFolder} = value || {};
  if (typeof teamId !== 'string' || !idPattern.test(teamId)) return null;
  if (isFolder !== undefined && typeof isFolder !== 'boolean') return null;
  const folderFlag = isFolder ? {isFolder:true} : {};
  if (unc != null) {
    if (libraryId != null || path != null || typeof unc !== 'string' || unc.length > textLimit) return null;
    const windows = unc.replaceAll('/','\\');
    const source = /^\\\\\?\\unc\\/i.test(windows) ? '\\\\' + windows.slice(8) : windows;
    if (!source.startsWith('\\\\')) return null;
    const parts = source.slice(2).split('\\');
    if (parts.length < (isFolder ? 2 : 3) || parts.some(part => !goodFilename(part))) return null;
    const filename = parts.at(-1);
    return name === undefined || name === filename ? {teamId,unc:source,name:filename,...folderFlag} : null;
  }
  if (typeof libraryId !== 'string' || !idPattern.test(libraryId) ||
      typeof path !== 'string' || path.length > textLimit) return null;
  if (!path) return isFolder && typeof name === 'string' && goodFilename(name)
    ? {teamId,libraryId,path,name,...folderFlag} : null;
  const relative = path.replaceAll('\\','/');
  const parts = relative.split('/');
  if (parts.some(part => !goodFilename(part))) return null;
  const filename = parts.at(-1);
  if (name !== undefined && name !== filename) return null;
  return {teamId,libraryId,path:relative,name:filename,...folderFlag};
}

export function writeWhiteboardFile(reference) {
  const file = normalizeReference(reference);
  if (!file) return null;
  const text = marker + JSON.stringify(file);
  return text.length <= textLimit ? text : null;
}

export function readWhiteboardFile(text) {
  if (typeof text !== 'string' || !text.startsWith(marker) || text.length > textLimit) return null;
  try {
    return normalizeReference(JSON.parse(text.slice(marker.length)));
  } catch {
    return null;
  }
}

export function whiteboardFileLocationLabel(file, inNexus) {
  if (inNexus) return file.isFolder ? '在 Nexus 打开文件夹' : '在 Nexus 文件夹中定位';
  return file.isFolder ? '打开共享文件夹' : '在共享文件夹中定位';
}

export function whiteboardFileCard(file, icon, reveal, inNexus = false) {
  const card = document.createElement('div');
  card.className = 'whiteboard-link-card whiteboard-file-card';
  const mark = document.createElement('span');
  mark.className = 'whiteboard-link-mark';
  mark.setAttribute('aria-hidden','true');
  if (file.isFolder) mark.classList.add('whiteboard-folder-mark');
  else {
    const extension = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1].toLowerCase();
    const glyph = modelExtensions.has(extension) ? 'box' : imageExtensions.has(extension) ? 'picture'
      : videoExtensions.has(extension) ? 'play' : 'notes';
    mark.classList.add('whiteboard-file-thumbnail');
    mark.innerHTML = icon(glyph);
    const image = document.createElement('img');
    image.className = 'whiteboard-file-preview';
    image.alt = '';
    image.decoding = 'async';
    image.hidden = true;
    image.addEventListener('load',() => { image.hidden = false; });
    image.addEventListener('error',() => { image.hidden = true; });
    const badge = document.createElement('span');
    badge.className = 'whiteboard-file-type';
    badge.innerHTML = icon(glyph);
    badge.append(extension ? extension.toUpperCase() : '文件');
    mark.append(image,badge);
  }
  const description = document.createElement('div');
  description.className = 'whiteboard-link-description';
  const name = document.createElement('strong');
  name.textContent = file.name;
  name.title = file.name;
  description.title = file.path || file.unc;
  description.append(name);
  if (file.isFolder) {
    const type = document.createElement('span');
    type.textContent = 'NAS 文件夹';
    description.append(type);
  }
  card.append(mark,description);
  if (reveal) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'icon-button whiteboard-link-open';
    action.dataset.boardRevealFile = '';
    action.title = whiteboardFileLocationLabel(file,inNexus);
    action.setAttribute('aria-label',action.title + ' ' + file.name);
    action.innerHTML = icon('folder');
    action.addEventListener('click',event => { if (event.detail < 2) void reveal(); });
    card.append(action);
  }
  return card;
}

export function createWhiteboardFilePreviews(stage, load) {
  if (!load) return null;
  const previews = new Map();
  const ready = new Set();
  let active = 0;
  let visible = false;
  const observer = new IntersectionObserver(entries => {
    for (const {target,isIntersecting} of entries) {
      const preview = previews.get(target);
      if (!preview) continue;
      if (isIntersecting) ready.add(preview);
      else {
        ready.delete(preview);
        preview.request?.abort();
      }
    }
    start();
  }, {root:stage});

  function start() {
    if (!visible) return;
    for (const preview of ready) {
      if (active >= 4) break;
      if (preview.request) continue;
      ready.delete(preview);
      const {node,image,file,available} = preview;
      if (!available()) continue;
      const controller = preview.request = new AbortController();
      const signal = controller.signal;
      active++;
      Promise.resolve().then(() => {
        if (!signal.aborted && available()) return load(file,{signal});
      }).then(result => {
        if (signal.aborted || !available()) return;
        const url = typeof result === 'string' ? result : result?.url;
        if (url) image.src = url;
        remove(node);
      }).catch(() => {
        if (!signal.aborted) remove(node);
      }).finally(() => {
        preview.request = null;
        active--;
        start();
      });
    }
  }

  function remove(node) {
    const preview = previews.get(node);
    if (!preview) return;
    preview.request?.abort();
    ready.delete(preview);
    observer.unobserve(node);
    previews.delete(node);
  }

  return {
    add(node,file,available) {
      const image = node.querySelector('.whiteboard-file-preview');
      if (!image) return;
      previews.set(node,{node,file,image,available});
      if (visible) observer.observe(node);
    },
    remove,
    setVisible(value) {
      visible = value;
      if (value) {
        for (const node of previews.keys()) observer.observe(node);
      } else {
        observer.disconnect();
        ready.clear();
        for (const preview of previews.values()) preview.request?.abort();
      }
    },
  };
}
