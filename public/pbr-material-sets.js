import {materialMapChannels} from './c4d-map-keywords.js';

const required = ['base_color', 'normal', 'roughness', 'displacement'];
const imageFormats = new Set('jpg jpeg png tif tiff bmp webp tga psd dds gif hdr exr'.split(' '));
const resolution = /^(?:(?:[1-9]|1[0-6])k|128|256|512|1024|2048|4096|8192|16384)$/i;
const normalVariant = /^(?:dx|gl|directx|opengl)$/i;
const nameOrder = new Intl.Collator('zh-CN', {numeric:true, sensitivity:'base'});
const pageSize = 40;
const maxVariants = 48;

const tokens = value => [...value.matchAll(/[\p{L}\p{N}]+/gu)];
const normalized = value => value.normalize('NFKC').toLowerCase();

function buildAliases(channels) {
  const aliases = new Map();
  for (const {key, aliases: entries} of channels) {
    for (const text of entries) {
      // The set index uses literal filename suffixes. Explicit import uses the mapped IDs.
      if (text.startsWith('/')) continue;
      const alias = tokens(normalized(text)).map(match => match[0]);
      if (!alias.length) continue;
      const suffix = alias.join(' ');
      const previous = aliases.get(suffix);
      aliases.set(suffix, previous === undefined || previous === key ? key : null);
    }
  }
  return {aliases, maxLength:Math.max(0, ...[...aliases.keys()].map(value => value.split(' ').length))};
}

function classify(stem, {aliases, maxLength}) {
  const masked = stem
    .replace(/(^|[^\p{L}\p{N}])(?:lod[ _-]*\d{1,2}|\d{2,5}[x×]\d{2,5})(?=$|[^\p{L}\p{N}])/giu,
      value => ' '.repeat(value.length));
  const parts = tokens(masked).filter(match => !resolution.test(match[0]));
  const partsKey = parts.map(match => normalized(match[0]));
  const variant = normalVariant.test(partsKey.at(-1)) ? partsKey.at(-1) : null;
  const end = parts.length - Number(Boolean(variant));
  for (let size = Math.min(maxLength, end - 1); size > 0; size--) {
    const suffix = partsKey.slice(end - size, end).join(' ');
    if (!aliases.has(suffix)) continue;
    const channel = aliases.get(suffix);
    if (!channel || variant && channel !== 'normal') return null;
    const familyParts = parts.slice(0,end - size);
    const family = partsKey.slice(0, end - size).join(' ');
    const label = masked.slice(0, parts[end - size].index).replace(/[\s_.-]+$/u, '').trim().replace(/\s{2,}/gu,' ');
    const name = tokens(label).some(match => resolution.test(match[0])) ? familyParts.map(match => match[0]).join(' ') : label;
    return name && {family, name, channel};
  }
  return null;
}

export function isMaterialSetImage(asset) {
  return imageFormats.has(asset?.ext?.toLowerCase());
}

export function groupMaterialSets(rows, {keywords, pathFor = asset => asset.relativePath || asset.path} = {}) {
  const channels = materialMapChannels(keywords);
  const index = buildAliases(channels);
  const groups = new Map();
  for (const asset of rows) {
    if (!asset.id || !asset.libraryId || !isMaterialSetImage(asset)) continue;
    const path = pathFor(asset)?.replaceAll('\\', '/');
    if (!path) continue;
    const separator = path.lastIndexOf('/');
    const file = path.slice(separator + 1);
    const dot = file.lastIndexOf('.');
    if (dot < 1 || !imageFormats.has(file.slice(dot + 1).toLowerCase())) continue;
    const match = classify(file.slice(0, dot), index);
    if (!match) continue;
    const folder = path.slice(0, Math.max(0, separator));
    const folderKey = /^(?:[a-z]:|\/\/)/i.test(folder) ? folder.toLowerCase() : folder;
    const id = JSON.stringify([asset.libraryId, folderKey, match.family]);
    if (!groups.has(id)) groups.set(id, {id, name:match.name, folder, libraryId:asset.libraryId, maps:new Map()});
    const group = groups.get(id);
    if (!group.maps.has(match.channel)) group.maps.set(match.channel, []);
    group.maps.get(match.channel).push({id:asset.id, file});
  }
  const channelKeys = [...required,...channels.map(({key}) => key).filter(key => !required.includes(key))];
  const labels = new Map(channels.map(({key,label}) => [key,label]));
  return [...groups.values()].sort((a,b) => nameOrder.compare(a.name,b.name) || nameOrder.compare(a.folder,b.folder))
    .map(group => {
      const maps = channelKeys.filter(key => required.includes(key) || group.maps.has(key))
        .map(key => ({key,label:labels.get(key),variants:(group.maps.get(key) || []).sort((a,b) => nameOrder.compare(a.file,b.file))}));
      const ids = maps.flatMap(map => map.variants.map(variant => variant.id));
      return {...group, maps, ids};
    });
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
}

export function initMaterialSets({button, current, targets, canSend, send, notify}) {
  const dialog = document.getElementById('pbr-material-sets-dialog');
  const list = dialog.querySelector('[data-material-cards]');
  const search = dialog.querySelector('[data-material-search]');
  const target = dialog.querySelector('[data-material-target]');
  const targetNote = dialog.querySelector('[data-material-target-note]');
  const more = dialog.querySelector('[data-material-more]');
  const count = dialog.querySelector('[data-material-count]');
  const status = dialog.querySelector('[data-material-status]');
  let snapshot;
  let busy = false;
  let limit = pageSize;

  function refreshTargets() {
    if (!dialog.open) return;
    const selected = target.value;
    const sessions = targets();
    const choices = sessions.length ? sessions.map(session => [session.label || 'Cinema 4D',session.id])
      : [['暂无可用实例','']];
    if (target.options.length !== choices.length ||
        choices.some(([label,id],i) => target.options[i].value !== id || target.options[i].text !== label)) {
      target.replaceChildren(...choices.map(([label,id]) => new Option(label,id)));
      if (sessions.some(session => session.id === selected)) target.value = selected;
    }
    target.disabled = busy || !sessions.length;
    targetNote.textContent = sessions.length
      ? '同通道有多个版本时，按导入设置选择其中一个。'
      : '发送需要已连接且支持材质套图的 Cinema 4D 桥接。';
    for (const sendButton of list.querySelectorAll('[data-material-send]')) {
      sendButton.disabled = busy || !target.value || Boolean(sendButton.dataset.unavailable);
    }
  }

  function makeCard(group) {
    const card = element('article','pbr-material-card');
    const header = element('div','pbr-material-card-header');
    const title = element('div');
    title.append(element('h3',null,group.name));
    const location = element('p','pbr-material-location',[snapshot.libraryName(group.libraryId),group.folder].filter(Boolean).join(' · '));
    location.title = location.textContent;
    title.append(location);
    const action = element('button','button subtle','发送到 C4D');
    action.type = 'button';
    action.dataset.materialSend = group.id;
    const unavailable = group.ids.length > maxVariants
      ? '单套最多可发送 48 张候选贴图，请缩小筛选范围。'
      : canSend(group) ? '' : '部分源文件不可用，请连接本机路径或挂载共享目录。';
    if (unavailable) {
      action.dataset.unavailable = unavailable;
      action.title = unavailable;
    }
    header.append(title,action);
    const maps = element('ul','pbr-material-maps');
    for (const {label, variants} of group.maps) {
      const row = element('li','pbr-material-map');
      row.append(element('span','pbr-material-channel',label));
      if (variants.length > 1) {
        const details = element('details');
        details.append(element('summary',null,`${variants.length} 个版本`));
        for (const variant of variants) details.append(element('div','pbr-material-filename',variant.file));
        row.append(details);
      } else {
        const value = element('span',variants.length ? 'pbr-material-filename' : 'pbr-material-missing',
          variants[0]?.file || '缺失');
        if (variants.length) value.title = variants[0].file;
        row.append(value);
      }
      maps.append(row);
    }
    card.append(header,maps);
    return card;
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const groups = query ? snapshot.groups.filter(group =>
      [group.name,group.folder,snapshot.libraryName(group.libraryId)].some(value => value?.toLowerCase().includes(query))) : snapshot.groups;
    count.textContent = `${groups.length} 套`;
    list.replaceChildren(...groups.slice(0,limit).map(makeCard));
    if (!groups.length) list.append(element('p','modal-description',query
      ? '没有匹配的材质套图。' : '当前结果中没有带已知通道后缀的贴图。'));
    more.hidden = groups.length <= limit;
    refreshTargets();
  }

  button.addEventListener('click', () => {
    if (dialog.open) return;
    const data = current();
    snapshot = {...data, groups:groupMaterialSets(data.rows,data)};
    search.value = '';
    status.textContent = '';
    limit = pageSize;
    dialog.showModal();
    render();
    search.focus();
  });
  dialog.querySelector('[data-material-close]').addEventListener('click',() => dialog.close());
  search.addEventListener('input',() => { limit = pageSize; render(); });
  target.addEventListener('change',refreshTargets);
  more.addEventListener('click',() => { limit += pageSize; render(); });
  list.addEventListener('click', async event => {
    const action = event.target.closest('[data-material-send]');
    if (!action || busy || action.disabled) return;
    const draft = snapshot;
    const group = draft.groups.find(item => item.id === action.dataset.materialSend);
    if (!group || !target.value) return;
    busy = true;
    refreshTargets();
    status.textContent = '正在提交导入任务…';
    try {
      await send(group,{scope:draft.scope, sessionId:target.value});
      if (dialog.open && snapshot === draft) status.textContent = `${group.name} 已进入 Cinema 4D 导入队列。`;
      else notify(`${group.name} 已进入 Cinema 4D 导入队列。`);
    } catch (failure) {
      const message = String(failure?.message || failure);
      if (dialog.open && snapshot === draft) status.textContent = message;
      else notify(message,true);
    } finally {
      busy = false;
      refreshTargets();
    }
  });
  return {refreshTargets};
}
