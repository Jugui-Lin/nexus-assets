const bridge = 'http://127.0.0.1:47821';
const tokenKey = 'captureToken';
export const statusKey = 'captureStatus';
export const batchKey = 'captureBatch';
export const maxBatch = 30;
const mediaMimes = /^(image|video)\/[\w.+-]{1,60}$/i;
const streamingPath = /\.(?:m3u8?|mpd|m4s|ts|ism(?:l)?)(?:\/|$)/i;
const streamingMime = /(?:mpegurl|dash\+xml|mp2t)/i;

export function website(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password ||
        parsed.href.length > 2048 || !parsed.hostname.includes('.') ||
        /(?:^|\.)(?:local|localhost)$|\.$/i.test(parsed.hostname)) return null;
    parsed.hash = '';
    return parsed;
  } catch { return null; }
}

function titleText(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 120) : '';
}

function mediaName(url) {
  const leaf = url.pathname.split('/').filter(Boolean).at(-1) || '';
  try { return titleText(decodeURIComponent(leaf)); }
  catch { return titleText(leaf); }
}

export function makeCapture({kind, url, title, pageUrl, mime}) {
  const page = website(pageUrl);
  const source = website(url);
  if (kind === 'link') {
    const link = source || page;
    return link ? {kind:'link', url:link.href, title:titleText(title) || link.hostname, pageUrl:(page || link).href} : null;
  }
  if (!['image', 'video'].includes(kind)) return null;
  if (!source || streamingPath.test(source.pathname) || (typeof mime === 'string' && streamingMime.test(mime))) {
    return page ? makeCapture({kind:'link', url:page.href, title, pageUrl:page.href}) : null;
  }
  return {
    kind,
    url:source.href,
    title:titleText(title) || mediaName(source) || source.hostname,
    pageUrl:(page || source).href,
    ...(typeof mime === 'string' && mediaMimes.test(mime) && mime.toLowerCase().startsWith(kind + '/') ? {mime} : {}),
  };
}

export async function isPaired() {
  return Boolean((await chrome.storage.local.get(tokenKey))[tokenKey]);
}

async function request(path, payload, timeout, token) {
  let response;
  let result;
  try {
    response = await fetch(bridge + path, {
      method:'POST',
      headers:{'Accept':'application/json', 'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token} : {})},
      body:JSON.stringify(payload),
      credentials:'omit',
      cache:'no-store',
      redirect:'error',
      signal:AbortSignal.timeout(timeout),
    });
    if ((response.headers.get('content-type') || '').includes('application/json')) result = await response.json();
  } catch (failure) {
    throw Error(failure.name === 'TimeoutError' ? 'Nexus 响应超时，请先查看采集箱。' : '无法连接 Nexus，请确认桌面版已打开。');
  }
  if (response.ok && result) return {...result, queued:response.status === 202};
  if (response.status === 404 || response.status === 405) throw Error('当前 Nexus 版本缺少网页采集功能，请更新桌面版。');
  const message = titleText(result?.message || result?.error);
  const failure = Error(message || `采集请求未完成（HTTP ${response.status}）。`);
  failure.status = response.status;
  throw failure;
}

export async function pair(code) {
  code = code.trim();
  if (!code || code.length > 128) throw Error('请填写 Nexus 提供的配对码。');
  const result = await request('/capture/pair', {code}, 8000);
  if (typeof result.token !== 'string' || !/^[A-Za-z0-9._~-]{16,256}$/.test(result.token)) {
    throw Error('Nexus 返回的配对信息无效。');
  }
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await chrome.storage.local.set({[tokenKey]:result.token});
}

export async function unpair() {
  await chrome.storage.local.remove(tokenKey);
}

async function authenticatedRequest(path, payload, timeout) {
  const token = (await chrome.storage.local.get(tokenKey))[tokenKey];
  if (!token) throw Object.assign(Error('请先打开 Nexus 网页采集扩展完成配对。'), {status:401});
  try {
    return await request(path, payload, timeout, token);
  } catch (failure) {
    if (failure.status === 401) {
      if ((await chrome.storage.local.get(tokenKey))[tokenKey] === token) await unpair();
      throw Object.assign(Error('配对已失效，请在 Nexus 重新生成配对码。'), {status:401});
    }
    throw failure;
  }
}

export async function capture(payload) {
  const result = await authenticatedRequest('/capture', payload, 12000);
  const message = titleText(result.message) || (result.queued ? '已排队，请在 Nexus 采集箱查看。' : '已采集到 Nexus。');
  return {message, kind:result.kind || payload.kind, queued:result.queued};
}

export async function captureScreenshot(payload) {
  const result = await authenticatedRequest('/capture/screenshot', payload, 25000);
  return {message:titleText(result.message) || '截图已发送到 Nexus 采集箱。', kind:'image', queued:result.queued};
}

export function readMedia() {
  const entries = [];
  const seen = new Set();
  function resolve(value) {
    if (!value || value.length > 2048) return '';
    try {
      const url = new URL(value, document.baseURI);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      url.hash = '';
      return url.href;
    } catch { return ''; }
  }
  function addImage(rawUrl, image, width, height, preview) {
    const url = resolve(rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    entries.push({kind:'image', url, preview:resolve(preview) || url,
      title:(image.alt || image.title || image.getAttribute('aria-label') || '').slice(0, 120), width, height});
  }
  for (const video of Array.from(document.querySelectorAll('video')).slice(0, 24)) {
    const sources = Array.from(video.querySelectorAll('source'));
    const url = video.currentSrc || video.src || sources[0]?.src;
    const source = sources.find(item => item.src === url);
    entries.push({kind:'video', url, preview:resolve(video.poster), title:(video.title || video.getAttribute('aria-label') || '').slice(0, 120),
      mime:source?.type, width:video.videoWidth, height:video.videoHeight});
  }
  for (let n = 0; n < Math.min(document.images.length, 350) && entries.length < 104; n++) {
    const image = document.images[n];
    const current = image.currentSrc || image.src;
    const candidates = image.srcset || image.getAttribute('data-srcset') || '';
    const widths = [...candidates.slice(0, 8192).matchAll(/(?:^|,\s*)(?!data:|blob:)([^\s,]+)\s+(\d+(?:\.\d+)?)(w|x)\s*(?=,|$)/gi)];
    const widest = widths.reduce((best, item) => Number(item[2]) > Number(best?.[2] || 0) ? item : best, null);
    const lazy = image.getAttribute('data-original') || image.getAttribute('data-src');
    const url = resolve(widest?.[1]) || resolve(lazy) || resolve(current);
    const width = widest?.[3] === 'w' && url !== resolve(current) ? Number(widest[2]) : image.naturalWidth;
    const height = width && image.naturalWidth ? Math.round(image.naturalHeight * width / image.naturalWidth) : image.naturalHeight;
    addImage(url, image, width, height, current);
  }
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let n = 0, node = walker.currentNode; node && n < 1000 && entries.length < 125; n++, node = walker.nextNode()) {
      const background = getComputedStyle(node).backgroundImage;
      if (!background || !background.includes('url(')) continue;
      const {width, height} = node.getBoundingClientRect();
      if (width < 24 || height < 24) continue;
      for (const match of background.slice(0, 8192).matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi)) {
        addImage(match[1] || match[2] || match[3], node);
        if (entries.length >= 125) break;
      }
    }
  }
  return {pageUrl:location.href, title:document.title, entries};
}
