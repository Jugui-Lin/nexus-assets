import {batchKey, capture, captureScreenshot, isPaired, makeCapture, statusKey, website} from './capture.js';
import {beginBatch, refreshBatch} from './batch.js';

const actionTitle = 'Nexus 网页采集';
const colors = {pending:'#51696d', success:'#285e52', error:'#a14435'};
const menus = {
  media:{title:'采集图片或视频到 Nexus', contexts:['image', 'video']},
  link:{title:'保存链接到 Nexus', contexts:['link']},
  page:{title:'保存当前网页到 Nexus', contexts:['page']},
};
const allowedScreenshot = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const maxScreenshotChars = 4 * Math.ceil(8 * 1024 * 1024 / 3) + 'data:image/jpeg;base64,'.length;
const maxScreenshotPixels = 32_000_000;
const maxPageTiles = 8;
let activeCapture;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, menu] of Object.entries(menus)) {
      chrome.contextMenus.create({id, ...menu, documentUrlPatterns:['https://*/*']}, () => {
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
      });
    }
  });
  chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).catch(console.error);
});

async function publish(phase, message) {
  await Promise.allSettled([
    chrome.storage.session.set({[statusKey]:{phase, message, at:Date.now()}}),
    chrome.action.setBadgeBackgroundColor({color:colors[phase]}),
    chrome.action.setBadgeText({text:{pending:'…', success:'✓', error:'!'}[phase]}),
    chrome.action.setTitle({title:actionTitle + ' · ' + message}),
  ]);
}

async function submit(send) {
  if (activeCapture) return {ok:false, message:'已有一项采集正在提交。'};
  const task = (async () => {
    try {
      if (!send) throw Error('当前页面没有可以采集的公开网址。');
      await publish('pending', '正在提交到 Nexus…');
      const result = await send();
      await publish('success', result.message);
      return {ok:true, ...result};
    } catch (failure) {
      const message = failure.message || '提交采集时发生错误。';
      await publish('error', message);
      return {ok:false, message};
    }
  })();
  activeCapture = task;
  try { return await task; }
  finally { if (activeCapture === task) activeCapture = undefined; }
}

function submitCapture(payload) {
  return submit(payload && (() => capture(payload)));
}

function currentPage(tab, fallback) {
  return makeCapture({kind:'link', url:tab?.url || fallback, title:tab?.title});
}

async function checkedTab(tab) {
  const original = website(tab?.url);
  if (!original || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) throw Error('请先打开要采集的网页。');
  const [current] = await chrome.tabs.query({windowId:tab.windowId, active:true});
  if (current?.id !== tab.id || website(current.url)?.href !== original.href || current.pendingUrl) {
    throw Error('页面已切换，请在目标页面重试。');
  }
  return current;
}

async function setupPageMode(tab, mode) {
  if (!(await isPaired())) throw Error('请先打开 Nexus 网页采集扩展完成配对。');
  tab = await checkedTab(tab);
  const [entry] = await chrome.scripting.executeScript({target:{tabId:tab.id}, files:['page-tools.js']});
  if (!entry?.documentId) throw Error('当前网页无法启用采集工具。');
  await chrome.storage.session.set({['pageCapture:' + tab.id]:entry.documentId});
  const result = await chrome.tabs.sendMessage(tab.id, {type:'activate-page-tool', mode}, {documentId:entry.documentId});
  if (!result?.ok) throw Error('当前网页无法启用采集工具。');
  return result;
}

function openScreenshot(dataUrl) {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), byte => byte.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], {type:'image/jpeg'}));
}

async function saveCanvas(canvas) {
  for (const quality of [.91, .76, .61]) {
    const jpeg = await canvas.convertToBlob({type:'image/jpeg', quality});
    if (jpeg.size > 8 * 1024 * 1024) continue;
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error('无法读取截图。'));
      reader.readAsDataURL(jpeg);
    });
  }
  throw Error('截图超过 8 MB，请缩小截图范围。');
}

async function cropScreenshot(dataUrl, crop) {
  if (!crop) return dataUrl;
  const {x, y, width, height, viewportWidth, viewportHeight} = crop;
  if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) ||
      x < 0 || y < 0 || width < 3 || height < 3 || x + width > viewportWidth || y + height > viewportHeight) {
    throw Error('截图范围已失效，请重新框选。');
  }
  const bitmap = await openScreenshot(dataUrl);
  try {
    const scaleX = bitmap.width / viewportWidth;
    const scaleY = bitmap.height / viewportHeight;
    const left = Math.floor(x * scaleX);
    const top = Math.floor(y * scaleY);
    const right = Math.min(bitmap.width, Math.ceil((x + width) * scaleX));
    const bottom = Math.min(bitmap.height, Math.ceil((y + height) * scaleY));
    const canvas = new OffscreenCanvas(right - left, bottom - top);
    canvas.getContext('2d').drawImage(bitmap, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return await saveCanvas(canvas);
  } finally { bitmap.close(); }
}

function readScreenshotLayout(position) {
  if (position) window.scrollTo({left:position.x, top:position.y, behavior:'instant'});
  const layout = () => ({x:window.scrollX, y:window.scrollY, width:innerWidth, height:innerHeight,
    documentHeight:document.scrollingElement?.scrollHeight, documentWidth:document.scrollingElement?.scrollWidth});
  return position ? new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(layout())))) : layout();
}

async function fullScreenshot(tab, captureFrame, assertCurrent) {
  const target = {tabId:tab.id};
  const getLayout = async position => (await chrome.scripting.executeScript({target,
    func:readScreenshotLayout, args:[position]}))[0];
  const {documentId, result:page} = await getLayout(null);
  if (!documentId || !page?.height || !page.width || !page.documentHeight || page.documentWidth > page.width + 1) {
    throw Error('此网页需要横向滚动，请改用框选截图。');
  }
  const tiles = Math.ceil(page.documentHeight / page.height);
  if (tiles > maxPageTiles) throw Error('此网页超过 8 屏，请改用框选截图。');
  let canvas;
  let y = 0;
  try {
    for (let index = 0; index < tiles; index++) {
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 550));
      await assertCurrent();
      const position = {x:0, y:Math.min(y, Math.max(0, page.documentHeight - page.height))};
      const tile = await getLayout(position);
      const layout = tile.result;
      if (tile.documentId !== documentId || Math.abs(layout.y - position.y) > 1 ||
          page.width !== layout.width || page.height !== layout.height || page.documentHeight !== layout.documentHeight) {
        throw Error('截图期间页面布局已变化，请重试或使用框选。');
      }
      const bitmap = await openScreenshot(await captureFrame());
      try {
        const fullHeight = bitmap.height * page.documentHeight / page.height;
        const resize = Math.min(1, 8192 / bitmap.width, 8192 / fullHeight, Math.sqrt(maxScreenshotPixels / (bitmap.width * fullHeight)));
        canvas ||= new OffscreenCanvas(Math.max(1, Math.floor(bitmap.width * resize)), Math.max(1, Math.floor(fullHeight * resize)));
        const tileStart = Math.round((y - layout.y) * bitmap.height / page.height);
        const nextY = Math.min(page.documentHeight, layout.y + page.height);
        const destinationStart = Math.round(y * canvas.height / page.documentHeight);
        const destinationEnd = Math.round(nextY * canvas.height / page.documentHeight);
        if (destinationEnd <= destinationStart || tileStart >= bitmap.height) throw Error('网页截图拼接失败，请改用框选截图。');
        canvas.getContext('2d').drawImage(bitmap, 0, tileStart, bitmap.width, bitmap.height - tileStart,
          0, destinationStart, canvas.width, destinationEnd - destinationStart);
        y = nextY;
      } finally { bitmap.close(); }
    }
    if (y < page.documentHeight - 1) throw Error('未能截取完整页面，请改用框选截图。');
    return await saveCanvas(canvas);
  } finally {
    await chrome.scripting.executeScript({target:{tabId:tab.id, documentIds:[documentId]},
      func:position => window.scrollTo({left:position.x, top:position.y, behavior:'instant'}),
      args:[{x:page.x, y:page.y}]}).catch(() => {});
  }
}

function screenshot(tab, crop, full = false) {
  return submit(async () => {
    if (!(await isPaired())) throw Error('请先打开 Nexus 网页采集扩展完成配对。');
    const current = await checkedTab(tab);
    let switched = false;
    const activated = ({windowId, tabId}) => { if (windowId === current.windowId && tabId !== current.id) switched = true; };
    const updated = (tabId, change) => { if (tabId === current.id && (change.url || change.status === 'loading')) switched = true; };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    async function assertCurrent() {
      await checkedTab(current);
      if (switched) throw Error('页面已切换，请在目标页面重试。');
    }
    async function captureFrame() {
      await assertCurrent();
      const dataUrl = await chrome.tabs.captureVisibleTab(current.windowId, {format:'jpeg', quality:93});
      await assertCurrent();
      if (typeof dataUrl !== 'string' || dataUrl.length > maxScreenshotChars || !allowedScreenshot.test(dataUrl)) {
        throw Error('截图超过 8 MB，请缩小浏览器窗口后重试。');
      }
      return dataUrl;
    }
    let dataUrl;
    try {
      dataUrl = full ? await fullScreenshot(current, captureFrame, assertCurrent) : await cropScreenshot(await captureFrame(), crop);
      await assertCurrent();
    } finally {
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
    }
    return captureScreenshot({title:`截图 · ${current.title || website(current.url).hostname}`.slice(0, 120),
      pageUrl:website(current.url).href, dataUrl});
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const pageUrl = info.frameUrl || info.pageUrl || tab?.url;
  let payload;
  if (info.menuItemId === 'media') {
    payload = makeCapture({kind:info.mediaType, url:info.srcUrl, pageUrl, title:undefined});
    if (payload?.kind === 'link' && tab?.title) payload.title = tab.title.trim().slice(0, 120) || payload.title;
  } else if (info.menuItemId === 'link') {
    if (!website(info.linkUrl)) return;
    payload = makeCapture({kind:'link', url:info.linkUrl, pageUrl});
  } else if (info.menuItemId === 'page') {
    payload = currentPage(tab, info.pageUrl);
  } else return;
  submitCapture(payload).catch(console.error);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-page') submitCapture(currentPage(tab)).catch(console.error);
  if (command === 'capture-visible') screenshot(tab).catch(console.error);
});

chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove('pageCapture:' + tabId).catch(console.error));

async function handlePageMessage(message, sender) {
  const grantKey = 'pageCapture:' + sender.tab.id;
  const grant = (await chrome.storage.session.get(grantKey))[grantKey];
  if (!grant || grant !== sender.documentId) return {ok:false, message:'请重新启用当前页采集。'};
  const tab = await checkedTab(sender.tab);
  if (website(sender.url)?.href !== website(tab.url)?.href) return {ok:false, message:'页面已切换，请重试。'};
  if (message.type === 'capture-area') return screenshot(tab, message.crop);
  const payload = makeCapture({kind:'image', url:message.url, title:message.title, pageUrl:sender.url});
  return submitCapture(payload?.kind === 'image' ? payload : null);
}

async function handlePopupMessage(message) {
  if (message.type === 'capture') return submitCapture(makeCapture(message.payload || {}));
  if (message.type === 'capture-batch') return beginBatch(message.payloads);
  if (message.type === 'cancel-batch') {
    await chrome.storage.session.remove(batchKey);
    return {ok:true};
  }
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if (website(tab?.url)?.href !== message.pageUrl) return {ok:false, message:'页面已切换，请重新打开扩展。'};
  if (message.type === 'capture-visible' || message.type === 'capture-full') return screenshot(tab, null, message.type === 'capture-full');
  const mode = {'capture-area-mode':'area', 'capture-element-mode':'element', 'capture-gesture-mode':'gesture'}[message.type];
  return setupPageMode(tab, mode);
}

const popupTypes = new Set(['capture', 'capture-batch', 'cancel-batch', 'capture-visible', 'capture-full', 'capture-area-mode', 'capture-element-mode', 'capture-gesture-mode']);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  let task;
  if (sender.url === chrome.runtime.getURL('popup.html') && popupTypes.has(message?.type)) task = handlePopupMessage(message);
  else if (sender.tab?.id != null && sender.frameId === 0 && ['capture-gesture', 'capture-area'].includes(message?.type)) {
    task = handlePageMessage(message, sender);
  } else return false;
  task.then(respond, failure => respond({ok:false, message:failure.message || '提交采集时发生错误。'}));
  return true;
});

refreshBatch().catch(console.error);
