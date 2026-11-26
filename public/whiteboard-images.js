const maxBytes = 8 * 1024 * 1024;
const maxEdge = 8192;
const maxPixels = 4096 * 4096;
const maxBase64Length = Math.ceil(maxBytes / 3) * 4;
const imageIdPattern = /^[0-9a-f]{64}$/;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isWhiteboardImage(blob) {
  const type = blob?.type?.toLowerCase();
  return imageTypes.has(type) || (
    (!type || type === 'application/octet-stream') && /\.(?:png|jpe?g|gif|webp)$/i.test(blob?.name || '')
  );
}

function matches(bytes, offset, signature) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function jpegSize(bytes, view) {
  // JPEG stores its dimensions in a Start of Frame segment, after optional metadata.
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset++] === 0xff) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
      return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    }
    offset += length;
  }
  return [];
}

function webpSize(bytes, view) {
  const header = String.fromCharCode(...bytes.subarray(12, 16));
  if (header === 'VP8X' && bytes.length >= 30) {
    const uint24 = offset => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    return [uint24(24) + 1, uint24(27) + 1];
  }
  if (header === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const size = view.getUint32(21, true);
    return [(size & 0x3fff) + 1, ((size >>> 14) & 0x3fff) + 1];
  }
  if (header === 'VP8 ' && bytes.length >= 30 && matches(bytes, 23, [0x9d, 0x01, 0x2a])) {
    return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  }
  return [];
}

function imageHeader(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length >= 33 && matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
      matches(bytes, 12, [73, 72, 68, 82])) {
    return ['image/png', view.getUint32(16), view.getUint32(20)];
  }
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)))) {
    return ['image/gif', view.getUint16(6, true), view.getUint16(8, true)];
  }
  if (matches(bytes, 0, [0xff, 0xd8])) return ['image/jpeg', ...jpegSize(bytes, view)];
  if (matches(bytes, 0, [82, 73, 70, 70]) && matches(bytes, 8, [87, 69, 66, 80])) {
    return ['image/webp', ...webpSize(bytes, view)];
  }
  return [];
}

function checkDimensions(width, height) {
  if (!(width > 0 && height > 0)) throw Error('无法读取图片尺寸。');
  if (width > maxEdge || height > maxEdge || width * height > maxPixels) {
    throw Error('图片尺寸过大。每边最多 8192 像素，总计最多 1677 万像素。');
  }
}

function encodedBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',', 2)[1]);
    reader.onerror = () => reject(Error('无法读取要上传的图片。'));
    reader.readAsDataURL(blob);
  });
}

async function imageDigest(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

let database;

function openDatabase() {
  if (database) return database;
  const opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('nexus-whiteboard-images', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (database === opening) database = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(Error('无法打开白板图片存储。'));
  });
  database = opening;
  opening.catch(() => { if (database === opening) database = null; });
  return opening;
}

function teamCachePrefix(teamId) {
  if (typeof teamId !== 'string' || !teamId) throw Error('请先打开团队白板。');
  // Cache keys start with the JSON-encoded team ID, independent of the board project.
  return JSON.stringify([teamId]).slice(0,-1) + ',';
}

function cacheImageId(key) {
  try {
    const id = JSON.parse(key)?.[2];
    return typeof id === 'string' && imageIdPattern.test(id) ? id : null;
  } catch { return null; }
}

export async function listWhiteboardImageCache(teamId) {
  const prefix = teamCachePrefix(teamId);
  const db = await openDatabase();
  const range = IDBKeyRange.bound(prefix,prefix + '\uffff',false,true);
  return new Promise((resolve,reject) => {
    const transaction = db.transaction('images','readonly');
    const request = transaction.objectStore('images').openCursor(range);
    const entries = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const blob = cursor.value;
      const id = cacheImageId(cursor.key);
      if (id && blob instanceof Blob && imageTypes.has(blob.type)) {
        entries.push({key:cursor.key,id,bytes:blob.size,mime:blob.type});
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(entries);
    transaction.onabort = () => reject(Error('无法读取本机白板图片缓存。'));
  });
}

async function imagesTransaction(mode, start) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('images', mode);
    const request = start(transaction.objectStore('images'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(Error('无法读写本机白板图片，请检查存储空间。'));
  });
}

export async function readWhiteboardImageCache(teamId, keys) {
  const prefix = teamCachePrefix(teamId);
  const allowed = [...new Set(keys)].filter(key => typeof key === 'string' && key.startsWith(prefix))
    .map(key => ({key,id:cacheImageId(key)})).filter(({id}) => id);
  if (!allowed.length) return [];
  const db = await openDatabase();
  return new Promise((resolve,reject) => {
    const transaction = db.transaction('images','readonly');
    const store = transaction.objectStore('images');
    const requests = allowed.map(entry => ({...entry,request:store.get(entry.key)}));
    transaction.oncomplete = () => resolve(requests.map(({key,id,request}) => ({key,id,blob:request.result}))
      .filter(({blob}) => blob instanceof Blob && imageTypes.has(blob.type)));
    transaction.onabort = () => reject(Error('无法读取选中的白板图片缓存。'));
  });
}

async function decodeTeamImage(data, id) {
  if (!imageTypes.has(data?.mime) || typeof data.base64 !== 'string' ||
      !data.base64.length || data.base64.length > maxBase64Length) throw Error('团队图片数据无效。');
  const bytes = Uint8Array.from(atob(data.base64), value => value.charCodeAt(0));
  const [mime, width, height] = imageHeader(bytes.buffer);
  if (bytes.length > maxBytes || mime !== data.mime || await imageDigest(bytes.buffer) !== id) {
    throw Error('团队图片数据无效。');
  }
  checkDimensions(width, height);
  return new Blob([bytes], {type:mime});
}

export async function clearSyncedWhiteboardImageCache({teamId,keys,api,available}) {
  const entries = await readWhiteboardImageCache(teamId,keys);
  const synced = new Map();
  let cleared = 0;
  for (const {key,id} of entries) {
    if (!available()) break;
    if (!synced.has(id)) {
      const found = await Promise.resolve().then(() => api('team_whiteboard_get_image', {teamId,imageId:id}))
        .then(data => decodeTeamImage(data,id)).then(() => true, () => false);
      synced.set(id,found);
    }
    if (!available()) break;
    if (synced.get(id)) {
      await imagesTransaction('readwrite',store => store.delete(key));
      cleared++;
    }
  }
  return {cleared,skipped:entries.length - cleared};
}

export function createWhiteboardImages({api}) {
  const uploads = new Map();
  const downloads = new Map();
  const uploaded = new Set();
  const cacheKey = (scope, id) => JSON.stringify([scope.teamId || null, scope.workspaceKey || scope.key || '', id]);

  function storeBlob(key, blob) {
    return imagesTransaction('readwrite', store => store.put(blob, key));
  }

  function cachedBlob(key) {
    return imagesTransaction('readonly', store => store.get(key));
  }

  async function fetchBlob(teamId, id, key) {
    const data = await api('team_whiteboard_get_image', {teamId, imageId:id});
    const blob = await decodeTeamImage(data,id);
    await storeBlob(key, blob);
    uploaded.add(key);
    return blob;
  }

  async function loadBlob(teamId, id, key) {
    const local = await cachedBlob(key);
    if (local) return local;
    if (!teamId) throw Error('本机找不到这张白板图片。');
    if (!downloads.has(key)) {
      downloads.set(key, fetchBlob(teamId, id, key).finally(() => downloads.delete(key)));
    }
    return downloads.get(key);
  }

  return {
    async prepare(scope, blob) {
      if (!blob?.size) throw Error('无法读取这张图片。');
      if (blob.size > maxBytes) throw Error('白板图片大小最多为 8 MB。');
      const buffer = await blob.arrayBuffer();
      const [mime, width, height] = imageHeader(buffer);
      if (!mime) throw Error('白板支持 PNG、JPEG、GIF 和 WebP 图片。');
      checkDimensions(width, height);
      const image = new Blob([buffer], {type:mime});
      const bitmap = await createImageBitmap(image).catch(() => { throw Error('图片损坏或无法读取。'); });
      const dimensions = {width:bitmap.width, height:bitmap.height};
      bitmap.close();
      checkDimensions(dimensions.width, dimensions.height);
      const id = await imageDigest(buffer);
      await storeBlob(cacheKey(scope, id), image);
      return {id, ...dimensions};
    },
    async ensureUploaded(scope, id) {
      if (!scope.teamId) return;
      if (!imageIdPattern.test(id)) throw Error('白板图片编号无效。');
      const {teamId} = scope;
      const key = cacheKey(scope, id);
      if (uploaded.has(key)) return;
      if (!uploads.has(key)) {
        const upload = async () => {
          const image = await loadBlob(teamId, id, key);
          if (uploaded.has(key)) return;
          await api('team_whiteboard_put_image', {teamId, imageId:id, mime:image.type, base64:await encodedBlob(image)});
          uploaded.add(key);
        };
        uploads.set(key, upload().finally(() => uploads.delete(key)));
      }
      await uploads.get(key);
    },
    async url(scope, id) {
      if (!imageIdPattern.test(id)) throw Error('白板图片编号无效。');
      const image = await loadBlob(scope.teamId, id, cacheKey(scope, id));
      return URL.createObjectURL(image);
    },
  };
}
