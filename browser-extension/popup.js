import {batchKey, isPaired, makeCapture, maxBatch, pair, readMedia, statusKey, unpair, website} from './capture.js';

const get = id => document.getElementById(id);
const pairing = get('pairing');
const code = get('pair-code');
const capturePanel = get('capture-panel');
const pageName = get('page-name');
const linkButton = get('capture-link');
const list = get('media-list');
const empty = get('media-empty');
const filters = [...document.querySelectorAll('[data-kind]')];
const tools = [...document.querySelectorAll('[data-tool]')];
const rescan = get('rescan');
const unpairButton = get('unpair');
const status = get('status');
const batchStatus = get('batch-status');
const batchControls = get('batch-controls');
const selectShown = get('select-shown');
const clearSelection = get('clear-selection');
const captureSelected = get('capture-selected');
const selected = new Set();
let candidates = [];
let pageLink;
let activeFilter = 'all';
let busy = false;
let scanning = false;
let batch;

function showStatus(phase, message) {
  status.hidden = !message;
  status.textContent = message || '';
  status.dataset.phase = phase || '';
}

function showBatch(value) {
  batch = value;
  batchStatus.hidden = !batch;
  if (batch) {
    const parts = [`已发送 ${batch.sent}/${batch.total} 项`];
    if (batch.items.length) parts.push(`待发送 ${batch.items.length} 项`);
    if (batch.failed) parts.push(`失败 ${batch.failed} 项`);
    if (batch.uncertain) parts.push(`${batch.uncertain} 项请在 Nexus 核对`);
    batchStatus.textContent = parts.join(' · ');
    if ((batch.failed || batch.uncertain) && batch.message) batchStatus.textContent += `。${batch.message}`;
    batchStatus.dataset.partial = String(Boolean(batch.failed || batch.uncertain));
  }
  updateSelection();
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function visibleMedia() {
  return candidates.filter(item => activeFilter === 'all' || item.mediaKind === activeFilter);
}

function updateSelection() {
  const active = busy || Boolean(batch?.items.length);
  batchControls.hidden = !candidates.length;
  selectShown.disabled = active || !visibleMedia().length || selected.size >= maxBatch;
  clearSelection.disabled = active || !selected.size;
  captureSelected.disabled = active || !selected.size;
  captureSelected.textContent = selected.size ? `采集所选（${selected.size}）` : '采集所选';
  for (const row of list.children) {
    const checked = selected.has(row.dataset.key);
    const checkbox = row.querySelector('input');
    checkbox.checked = checked;
    checkbox.disabled = active || (!checked && selected.size >= maxBatch);
    row.classList.toggle('selected', checked);
  }
}

function mediaRow({key, payload, mediaKind, width, height, preview}) {
  const button = element('button', 'media-action', payload.kind === 'link' ? '保存链接' : '采集');
  button.type = 'button';
  button.disabled = busy;
  button.setAttribute('aria-label', button.textContent + ' · ' + payload.title);
  button.addEventListener('click', () => submit({type:'capture', payload}));
  const label = element('label', 'media-label');
  label.title = payload.title;
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', () => {
    if (checkbox.checked && selected.size < maxBatch) selected.add(key);
    else selected.delete(key);
    updateSelection();
  });
  const thumbnail = element('span', 'media-kind');
  thumbnail.setAttribute('aria-hidden', 'true');
  thumbnail.append(element('span', '', mediaKind === 'video' ? '视频' : '图片'));
  if (preview) {
    const image = element('img');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.crossOrigin = 'anonymous';
    image.addEventListener('error', () => image.remove(), {once:true});
    image.src = preview;
    thumbnail.append(image);
  }
  const details = element('span', 'media-copy');
  details.append(element('span', '', payload.title));
  const resolution = width > 0 && height > 0 ? `${width} × ${height}` : '';
  const kind = mediaKind === 'video' ? '视频' : '图片';
  details.append(element('small', '', [kind, resolution, website(payload.url)?.hostname].filter(Boolean).join(' · ')));
  label.append(checkbox, thumbnail, details);
  const row = element('li', 'media-row');
  row.dataset.key = key;
  row.append(label, button);
  return row;
}

function renderMedia() {
  const shown = visibleMedia();
  empty.hidden = Boolean(shown.length);
  empty.textContent = scanning ? '正在查找网页媒体…' : !pageLink ? '请打开一个 HTTPS 网页。' : '没有找到可采集的媒体。';
  for (const button of [linkButton, ...tools]) button.disabled = busy || !pageLink;
  rescan.disabled = busy || scanning || !pageLink;
  for (const button of filters) {
    button.disabled = busy;
    button.setAttribute('aria-pressed', String(button.dataset.kind === activeFilter));
  }
  list.replaceChildren(...shown.map(mediaRow));
  updateSelection();
}

async function scanTab() {
  if (scanning) return;
  scanning = true;
  try {
    candidates = [];
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    const url = website(tab?.url);
    if (url?.href !== pageLink?.url) selected.clear();
    pageLink = makeCapture({kind:'link', url:url?.href, title:tab?.title});
    pageName.textContent = pageLink?.title || '当前网页';
    pageName.title = pageName.textContent;
    renderMedia();
    if (url && Number.isInteger(tab?.id)) {
      const [{result}] = await chrome.scripting.executeScript({target:{tabId:tab.id}, func:readMedia});
      const seen = new Set();
      for (const entry of (Array.isArray(result?.entries) ? result.entries : []).slice(0, 125)) {
        if (entry.kind === 'image' && !website(entry.url)) continue;
        const payload = makeCapture({...entry, pageUrl:url.href, title:entry.title || ''});
        if (!payload) continue;
        if (payload.kind === 'link' && !entry.title) payload.title = pageLink.title;
        const key = payload.kind + ':' + payload.url;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({key, payload, mediaKind:entry.kind, width:entry.width, height:entry.height,
          preview:website(entry.preview)?.href});
      }
    }
    const available = new Set(candidates.map(item => item.key));
    for (const key of selected) if (!available.has(key)) selected.delete(key);
  } catch { /* A valid page link remains available when browser scripting is restricted. */ }
  finally {
    scanning = false;
    renderMedia();
  }
}

async function updatePairing(scan = true) {
  const paired = await isPaired();
  capturePanel.hidden = !paired;
  pairing.hidden = paired;
  unpairButton.hidden = !paired;
  if (paired && scan) await scanTab();
}

async function submit(message) {
  if (busy || !message) return;
  busy = true;
  unpairButton.disabled = true;
  showStatus('pending', '正在提交到 Nexus…');
  renderMedia();
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (result?.ok && /-mode$/.test(message.type)) {
      window.close();
      return;
    }
    if (result?.ok && message.type === 'capture-batch') {
      selected.clear();
      showStatus('', '');
    } else {
      showStatus(result?.ok ? 'success' : 'error', result?.message || '采集结果未返回，请查看 Nexus 采集箱。');
    }
    if (!(await isPaired())) await updatePairing(false);
  } catch { showStatus('error', '采集结果未返回，请查看 Nexus 采集箱。'); }
  finally {
    busy = false;
    unpairButton.disabled = false;
    renderMedia();
  }
}

pairing.addEventListener('submit', async event => {
  event.preventDefault();
  const value = code.value;
  const button = pairing.querySelector('button');
  code.disabled = button.disabled = true;
  showStatus('pending', '正在配对…');
  try {
    await pair(value);
    code.value = '';
    showStatus('success', '已与 Nexus 配对。');
    await updatePairing();
  } catch (failure) { showStatus('error', failure.message); }
  finally { code.disabled = button.disabled = false; }
});

unpairButton.addEventListener('click', async () => {
  try {
    await unpair();
    await updatePairing(false);
    await chrome.runtime.sendMessage({type:'cancel-batch'});
    await Promise.allSettled([chrome.storage.session.remove(statusKey), chrome.action.setBadgeText({text:''})]);
    showStatus('', '已解除配对。');
    code.focus();
  } catch { showStatus('error', '解除配对失败，请重试。'); }
});

linkButton.addEventListener('click', () => { if (pageLink) submit({type:'capture', payload:pageLink}); });
rescan.addEventListener('click', scanTab);
for (const button of tools) button.addEventListener('click', () => submit({type:button.dataset.tool, pageUrl:pageLink?.url}));
for (const button of filters) button.addEventListener('click', () => {
  activeFilter = button.dataset.kind;
  renderMedia();
});
selectShown.addEventListener('click', () => {
  for (const {key} of visibleMedia()) {
    if (selected.size >= maxBatch) break;
    selected.add(key);
  }
  updateSelection();
});
clearSelection.addEventListener('click', () => { selected.clear(); updateSelection(); });
captureSelected.addEventListener('click', () => submit({type:'capture-batch',
  payloads:candidates.filter(item => selected.has(item.key)).map(item => item.payload)}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes[batchKey]) showBatch(changes[batchKey].newValue);
  if (changes[statusKey]?.newValue) {
    const {phase, message} = changes[statusKey].newValue;
    showStatus(phase, message);
  }
});

try {
  const stored = await chrome.storage.session.get([statusKey, batchKey]);
  const last = stored[statusKey];
  showBatch(stored[batchKey]);
  if (last && Date.now() - last.at <= 5 * 60_000) {
    const expired = last.phase === 'pending' && Date.now() - last.at > 30_000;
    showStatus(expired ? 'error' : last.phase, expired ? '请在 Nexus 采集箱查看提交结果。' : last.message);
  }
  await updatePairing();
} catch { showStatus('error', '扩展无法读取本机设置，请重新打开扩展。'); }
