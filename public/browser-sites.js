import {initBrowserSiteMetadata} from './browser-site-metadata.js';
import {initBrowserSiteDrag} from './browser-site-drag.js';
import {initBrowserSiteTeamSync} from './browser-site-team-sync.js';

const defaultGroups = [
  ['视频', [
    ['哔哩哔哩', 'https://www.bilibili.com/'], ['YouTube', 'https://www.youtube.com/'],
    ['Vimeo', 'https://vimeo.com/'], ['FrameRate', 'https://framerate.tv/'],
  ]],
  ['作品与灵感', [
    ['Behance', 'https://www.behance.net/'], ['ArtStation', 'https://www.artstation.com/'],
    ['新片场 · 编辑精选', 'https://www.xinpianchang.com/recommend/editor'],
    ['STASH', 'https://www.stashmedia.tv/'], ['Motionographer', 'https://motionographer.com/'],
    ['Showreel', 'https://showreel.design/'], ['Pinterest', 'https://www.pinterest.com/'],
  ]],
  ['社交', [
    ['Instagram', 'https://www.instagram.com/'], ['小红书', 'https://www.xiaohongshu.com/'],
    ['Facebook', 'https://www.facebook.com/'], ['X', 'https://x.com/'], ['Reddit', 'https://www.reddit.com/'],
  ]],
];
const storageKey = 'nexus-browser-sites-v2';
const legacyStorageKey = 'nexus-browser-sites-v1';
const bookmarkKey = 'nexus-browser-bookmarks-v1';
const defaultScope = 'personal:personal';
const defaultCategory = '其他';
const bookmarkCategory = '收藏的网站';
const teamRefreshInterval = 20_000;
const siteNames = new Map([
  ['gfxcamp.com','龋齿一号 GFXCamp'],
  ['modown.cn','魔顿'],
  ['iiicg.com','画忆妙妙屋'],
  ['c4dsky.com','书生CG资源站'],
  ['talkae.com','韬客AE'],
  ['lookae.com','大众脸影视后期'],
]);
const countryDomainTypes = new Set(['ac','co','com','edu','gov','net','org']);
const bundledIconHosts = new Set([
  'bilibili.com', 'youtube.com', 'vimeo.com', 'framerate.tv', 'behance.net',
  'artstation.com', 'xinpianchang.com', 'stashmedia.tv', 'motionographer.com', 'showreel.design',
  'pinterest.com', 'instagram.com', 'xiaohongshu.com', 'facebook.com', 'x.com', 'reddit.com', 'gfxcamp.com',
]);
const svgNamespace = 'http://www.w3.org/2000/svg';
const iconPaths = {
  edit:'m14 6 4 4M4 20l4-.8L20 7.3 16.7 4 4.8 16z',
  rss:'M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14M6 18h.01',
};

function safeAddress(value, suggestHttps = false) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 2048 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  const hasHttpScheme = /^https?:\/\//i.test(text);
  const looksLikeHost = /^[^\s/:?#@\\]+\.[^\s/:?#@\\]+(?::\d+)?(?:[/?#]|$)/.test(text);
  if (!hasHttpScheme && !(suggestHttps && looksLikeHost)) return null;
  try {
    const address = new URL(hasHttpScheme ? text : 'https://' + text);
    return ['http:', 'https:'].includes(address.protocol) && !address.username && !address.password ? address : null;
  } catch { return null; }
}

function cleanLabel(value, maximum) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum) : '';
}

function siteIcon(value) {
  return typeof value === 'string' && value.length <= 18000 &&
    /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : '';
}

function cleanDescription(value) {
  return typeof value === 'string' ? value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 260) : '';
}

function normalizedMetadata(value) {
  const name = cleanLabel(value?.name, 120);
  const iconData = siteIcon(value?.iconData);
  const description = cleanDescription(value?.description);
  return {...(name && {name}), ...(iconData && {iconData}), ...(description && {description})};
}

function hostname(url) {
  return new URL(url).hostname.replace(/^www\./i, '');
}

function isAddressLabel(name, url) {
  if (!name || /\s/.test(name)) return false;
  const domain = hostname(url);
  if (name.toLowerCase() === domain) return true;
  const address = safeAddress(name,true);
  return Boolean(address && (/^https?:\/\//i.test(name) || hostname(address.href) === domain));
}

function automaticSiteName(url, detected, saved) {
  const domain = hostname(url);
  if (siteNames.has(domain)) return siteNames.get(domain);
  const name = [detected,saved].find(value => value && !isAddressLabel(value,url));
  if (name) return name;
  if (domain === 'localhost') return '本地网站';
  if (/^[\d.]+$/.test(domain) || domain.startsWith('[')) return '未命名网站';
  const parts = domain.split('.');
  const countryType = parts.length > 2 && parts.at(-1).length === 2 && countryDomainTypes.has(parts.at(-2));
  const stem = parts.at(countryType ? -3 : parts.length > 1 ? -2 : -1);
  if (!stem || stem.startsWith('xn--')) return '未命名网站';
  return stem.split(/[-_]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ') || '未命名网站';
}

function siteMark(mark, name, iconData, url) {
  const letter = element('span', '', [...name][0]?.toLocaleUpperCase() || '•');
  mark.replaceChildren(letter);
  const host = url && hostname(url);
  const bundled = bundledIconHosts.has(host) ? new URL('site-icons/' + host + '.png', import.meta.url).href : '';
  if (!iconData && !bundled) return;
  const image = element('img');
  image.alt = '';
  image.hidden = true;
  image.addEventListener('load', () => { letter.hidden = true; image.hidden = false; }, {once:true});
  image.addEventListener('error', () => {
    if (bundled && image.src !== bundled) image.src = bundled;
    else image.remove();
  });
  image.src = iconData || bundled;
  mark.append(image);
}

function baseSites() {
  return defaultGroups.flatMap(([category, sites]) => sites.map(([name, url]) => ({
    id:new URL(url).hostname, name, url, category,
  })));
}

const scopedStorage = scope => storageKey + ':' + scope;
const legacyScopedStorage = scope => legacyStorageKey + ':' + scope;

function navigationState(sites, order = defaultGroups.map(([title]) => title), newSiteCategory = defaultCategory) {
  return {sites, categories:[...new Set([...order, ...sites.map(site => site.category), newSiteCategory])], newSiteCategory};
}

function normalizeNavigation(saved) {
  const rows = Array.isArray(saved) ? saved : saved?.sites;
  if (!Array.isArray(rows)) return null;
  const ids = new Set();
  const addresses = new Set();
  const sites = rows.flatMap(site => {
    const id = cleanLabel(site?.id, 200);
    const name = cleanLabel(site?.name, 120);
    const category = cleanLabel(site?.category, 40);
    const address = safeAddress(site?.url);
    if (!id || !category || !address || ids.has(id) || addresses.has(address.href)) return [];
    ids.add(id);
    addresses.add(address.href);
    const iconData = siteIcon(site.iconData);
    const description = cleanDescription(site.description);
    const url = address.href;
    const autoName = site.autoName === true || !name || isAddressLabel(name,url);
    return [{id, name:autoName ? automaticSiteName(url,null,name) : name, url, category, ...(iconData && {iconData}),
      ...(description && {description}), ...(autoName && {autoName:true})}];
  });
  const order = Array.isArray(saved?.categories) ? saved.categories.map(title => cleanLabel(title,40)).filter(Boolean) : undefined;
  return navigationState(sites,order,cleanLabel(saved?.newSiteCategory,40) || defaultCategory);
}

const defaultNavigation = () => navigationState(baseSites());

function readNavigation(scope) {
  try {
    const stored = localStorage.getItem(scopedStorage(scope)) ?? localStorage.getItem(legacyScopedStorage(scope));
    return normalizeNavigation(JSON.parse(stored ?? (scope === defaultScope ? localStorage.getItem(legacyStorageKey) : null)));
  } catch { return null; }
}

function mergeLegacyNavigation(shared, local) {
  const existing = [...shared.sites,...baseSites()];
  const ids = new Set(existing.map(site => site.id));
  const addresses = new Set(existing.map(site => site.url));
  const added = local.sites.filter(site => !ids.has(site.id) && !addresses.has(site.url));
  if (!added.length) return shared;
  const categories = new Set(added.map(site => site.category));
  return navigationState([...shared.sites,...added],
    [...shared.categories,...local.categories.filter(category => categories.has(category))], shared.newSiteCategory);
}

function loadBookmarks(scope) {
  try {
    const stored = localStorage.getItem(bookmarkKey + ':' + scope);
    const saved = JSON.parse(stored ?? (scope === defaultScope ? localStorage.getItem(bookmarkKey) : null));
    if (!Array.isArray(saved)) return [];
    const urls = new Set();
    return saved.slice(0, 100).flatMap(record => {
      const address = safeAddress(record?.url);
      if (!address || urls.has(address.href)) return [];
      urls.add(address.href);
      const url = address.href;
      const title = cleanLabel(record.title, 120);
      const autoName = !title || isAddressLabel(title,url);
      return [{id:'bookmark:' + url, name:autoName ? automaticSiteName(url) : title, url, ...(autoName && {autoName:true})}];
    });
  } catch { return []; }
}

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

function actionButton(type, label, callback) {
  const button = element('button', 'browser-site-action');
  button.type = 'button';
  button.dataset.siteAction = type;
  button.title = label;
  button.setAttribute('aria-label', label);
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNamespace, 'path');
  path.setAttribute('d', iconPaths[type]);
  svg.append(path);
  button.append(svg);
  button.addEventListener('click', callback);
  return button;
}

export function initBrowserSites({navigate, onSubscribe, readMetadata, readTeam, writeTeam,
  scope = defaultScope, log = () => {}}) {
  const get = id => document.getElementById(id);
  const navigation = get('site-navigation');
  const filter = get('browser-site-filter');
  const list = get('browser-sites');
  const scroller = list.closest('.browser-scroll');
  const empty = get('browser-empty');
  const entry = get('browser-site-quick-url');
  const entryStatus = get('browser-site-quick-status');
  const teamStatus = get('browser-site-team-status');
  let {sites,categories,newSiteCategory} = readNavigation(scope) || defaultNavigation();
  let bookmarks = loadBookmarks(scope);
  let workspace = scope;
  let teamId;
  let wasVisible = false;
  let editing;
  let categoryDraft;
  let automaticName;
  let automaticDescription;
  let lookupTimer;
  let categoryDrag;
  let categoryDropTarget;

  const dialog = element('dialog', 'browser-site-dialog');
  dialog.id = 'browser-site-dialog';
  dialog.setAttribute('aria-labelledby', 'browser-site-dialog-title');
  dialog.innerHTML = `<form id="browser-site-form">
    <header><h2 id="browser-site-dialog-title">编辑网站</h2><button id="browser-site-close" type="button" aria-label="关闭">×</button></header>
    <label for="browser-site-url">入口地址</label>
    <div class="browser-site-entry-row"><input id="browser-site-url" type="text" required inputmode="url" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="首页、案例库或下载页的网址"><button id="browser-site-test-entry" type="button">试开入口</button></div>
    <label for="browser-site-name">网站名称</label>
    <div class="browser-site-name-row"><span id="browser-site-icon" class="browser-site-mark" aria-hidden="true"></span><input id="browser-site-name" type="text" maxlength="120" placeholder="留空使用网站名称" autocomplete="off"></div>
    <p id="browser-site-lookup-status" role="status"></p>
    <label for="browser-site-description">用途或简介</label><textarea id="browser-site-description" rows="2" maxlength="260" placeholder="例如产品案例、素材下载。留空时使用网站简介"></textarea>
    <label for="browser-site-category">分类</label><input id="browser-site-category" type="text" required list="browser-site-category-list" maxlength="40" autocomplete="off">
    <datalist id="browser-site-category-list"></datalist>
    <p id="browser-site-form-status" role="alert"></p>
    <div id="browser-site-confirm" class="browser-site-confirm" hidden><p id="browser-site-confirm-text"></p><button id="browser-site-confirm-remove" type="button">确认移除</button><button id="browser-site-confirm-cancel" type="button">返回</button></div>
    <footer><button id="browser-site-remove" type="button">移除网站</button><button id="browser-site-cancel" type="button">取消</button><button id="browser-site-save" type="submit">保存</button></footer>
  </form>`;
  document.body.append(dialog);
  const nameField = get('browser-site-name');
  const urlField = get('browser-site-url');
  const testEntry = get('browser-site-test-entry');
  const descriptionField = get('browser-site-description');
  const categoryField = get('browser-site-category');
  const feedback = get('browser-site-form-status');
  const confirmation = get('browser-site-confirm');
  const iconPreview = get('browser-site-icon');
  const lookupStatus = get('browser-site-lookup-status');
  const categoryDialog = element('dialog', 'browser-site-dialog');
  categoryDialog.id = 'browser-site-category-dialog';
  categoryDialog.setAttribute('aria-labelledby', 'browser-site-category-dialog-title');
  categoryDialog.innerHTML = `<form>
    <header><h2 id="browser-site-category-dialog-title">重命名分类</h2></header>
    <label for="browser-site-category-name">分类名称</label>
    <input id="browser-site-category-name" type="text" maxlength="40" autocomplete="off">
    <p id="browser-site-category-status" role="alert"></p>
    <footer><button type="button" data-category-cancel>取消</button><button type="submit" data-category-save>保存</button></footer>
  </form>`;
  document.body.append(categoryDialog);
  const categoryName = get('browser-site-category-name');
  const categoryFeedback = get('browser-site-category-status');

  const visible = () => !document.hidden && !navigation.classList.contains('hidden') && !navigation.hidden;
  const teamSync = readTeam && writeTeam ? initBrowserSiteTeamSync({
    read:readTeam, write:writeTeam, normalize:normalizeNavigation, defaults:defaultNavigation,
    legacy:readNavigation, mergeLegacy:mergeLegacyNavigation,
    busy:() => drag.busy() || Boolean(categoryDrag) || dialog.open || categoryDialog.open,
    apply(updated) {
      if (JSON.stringify(updated) === JSON.stringify({sites,categories,newSiteCategory})) return;
      ({sites,categories,newSiteCategory} = updated);
      if (!drag.busy() && !categoryDrag) render();
    },
    status(phase, error) {
      const message = {
        loading:'团队共享 · 正在同步',
        ready:'团队共享 · 已同步',
        saving:'团队共享 · 正在保存',
        unavailable:'团队服务需要更新',
        error:'团队站点同步失败',
        writeError:'团队站点更改未保存，请刷新后重试',
      }[phase] || '';
      teamStatus.hidden = !message;
      teamStatus.dataset.phase = phase || '';
      for (const heading of list.querySelectorAll('[data-site-category-heading]')) updateCategoryHandle(heading);
      if (teamStatus.textContent !== message) teamStatus.textContent = message;
      teamStatus.title = error ? String(error?.message || error).slice(0,200) : '';
    },
  }) : null;
  const metadata = initBrowserSiteMetadata({
    initialScope:scope, read:readMetadata, normalize:normalizedMetadata, visible,
    onChange() {
      if (dialog.open) renderEditorMetadata();
      if (!drag.busy() && !categoryDrag) paint();
    },
  });

  function display(item) {
    const info = metadata.get(item.url);
    return {...item,
      name:item.autoName ? automaticSiteName(item.url,info?.name,item.name) : item.name,
      iconData:info?.iconData || item.iconData || '',
      description:item.description || info?.description || ''};
  }

  function showEntryStatus(text = '', failed = false) {
    entryStatus.textContent = text;
    entryStatus.dataset.error = String(failed);
    entry.removeAttribute('aria-invalid');
    if (failed) entry.setAttribute('aria-invalid', 'true');
  }

  function requestMetadata() {
    metadata.request([...sites, ...bookmarks].map(site => site.url));
  }

  function canEditSites(status = entryStatus) {
    if (!teamId || !teamSync || teamSync.canWrite()) return true;
    const message = '团队站点同步完成后即可编辑。';
    if (status === entryStatus) showEntryStatus(message,true);
    else status.textContent = message;
    return false;
  }

  function save(next, status = feedback, order = categories, addTo = newSiteCategory) {
    if (!canEditSites(status)) return false;
    const updated = navigationState(next,order,addTo);
    if (teamId && teamSync) {
      if (!teamSync.save(updated)) return false;
      ({sites,categories,newSiteCategory} = updated);
      return true;
    }
    try { localStorage.setItem(scopedStorage(scope), JSON.stringify(updated)); }
    catch {
      const message = '无法保存网站导航，请检查本机存储空间。';
      if (status === entryStatus) showEntryStatus(message, true);
      else status.textContent = message;
      return false;
    }
    ({sites,categories,newSiteCategory} = updated);
    return true;
  }

  function createSite(value) {
    const address = safeAddress(value, true);
    if (!address) {
      showEntryStatus('请输入有效的 HTTP 或 HTTPS 网址。', true);
      return;
    }
    if (sites.some(item => item.url === address.href)) {
      showEntryStatus('导航里已有这个网址。', true);
      entry.select();
      return;
    }
    const site = {id:crypto.randomUUID(), name:automaticSiteName(address.href), url:address.href, category:newSiteCategory, autoName:true};
    if (!save([...sites, site], entryStatus)) return;
    filter.value = '';
    entry.value = '';
    showEntryStatus('已添加 ' + site.name);
    log('添加导航站点 · ' + address.hostname);
    metadata.request([site.url], true);
    render();
  }

  function renderEditorMetadata() {
    const address = safeAddress(urlField.value, true);
    testEntry.disabled = !address;
    testEntry.title = address?.href || '';
    const item = sites.find(item => item.id === editing);
    const info = address && metadata.get(address.href);
    const unchanged = address?.href === item?.url;
    if (automaticName) {
      nameField.value = address ? automaticSiteName(address.href,info?.name,unchanged ? item?.name : '') : '';
    }
    if (automaticDescription) descriptionField.value = info?.description || '';
    const iconData = info?.iconData || (unchanged ? item?.iconData : '');
    siteMark(iconPreview, nameField.value.trim(), iconData, address?.href);
    lookupStatus.textContent = address && metadata.pending(address.href) ? '正在识别网站…' : '';
  }

  function addressChanged() {
    clearTimeout(lookupTimer);
    feedback.textContent = '';
    const address = safeAddress(urlField.value, true);
    renderEditorMetadata();
    if (address) lookupTimer = setTimeout(() => {
      metadata.request([address.href], true);
      renderEditorMetadata();
    }, 350);
  }

  function showEditor(site) {
    if (!site || dialog.open || !canEditSites()) return;
    editing = site.id;
    automaticName = site.autoName === true;
    automaticDescription = !site.description;
    confirmation.hidden = true;
    feedback.textContent = '';
    nameField.value = site.name;
    descriptionField.value = site.description || '';
    urlField.value = site.url;
    categoryField.value = site.category;
    get('browser-site-category-list').replaceChildren(...categories.map(title => new Option(title, title)));
    metadata.request([site.url], true);
    renderEditorMetadata();
    dialog.showModal();
    nameField.focus();
  }

  function renderCard(item, configured, existing) {
    const previous = existing?.sitePresentation;
    const {name,url,iconData,description} = item;
    const editId = configured?.id;
    if (previous && previous.name === name && previous.url === url && previous.iconData === iconData &&
        previous.description === description && previous.editId === editId) return existing;
    const card = element('article', 'browser-site-card');
    card.dataset.siteId = item.id;
    card.sitePresentation = {name,url,iconData,description,editId};
    const button = element('button', 'browser-site');
    button.type = 'button';
    button.title = '在默认浏览器打开 ' + item.url;
    button.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown');
    button.addEventListener('click', () => navigate(item.url));
    const tile = element('span', 'browser-site-mark');
    tile.setAttribute('aria-hidden', 'true');
    siteMark(tile, item.name, item.iconData, item.url);
    const label = element('span', 'browser-site-text');
    const domain = hostname(item.url);
    const subtitle = element('small', item.description ? 'browser-site-description' : '', item.description || domain);
    subtitle.title = item.description || domain;
    label.append(element('strong', '', item.name), subtitle);
    button.append(tile, label);
    const actions = element('div', 'browser-site-actions');
    if (editId) actions.append(actionButton('edit', '编辑 ' + item.name + ' 的导航',
      () => showEditor(sites.find(site => site.id === editId))));
    if (onSubscribe) actions.append(actionButton('rss', '订阅 ' + item.name, () => onSubscribe({url:item.url, name:item.name})));
    card.append(button, actions);
    return card;
  }

  function paint(focusId) {
    const focused = document.activeElement;
    const focusedId = list.contains(focused) ? focused.closest('[data-site-id]')?.dataset.siteId : null;
    const focusedCategory = list.contains(focused) ? focused.dataset.siteCategoryEdit : null;
    const action = focused?.dataset.siteAction;
    const query = filter.value.trim().toLocaleLowerCase();
    const oldCards = new Map([...list.querySelectorAll('[data-site-id]')].map(card => [card.dataset.siteId,card]));
    const grouped = new Map(categories.map(title => [title, []]));
    for (const site of sites) {
      if (!grouped.has(site.category)) grouped.set(site.category, []);
      grouped.get(site.category).push(site);
    }
    const sections = [];
    function appendGroup(title, group, starred = false) {
      const shown = group.filter(({item}) =>
        (title + ' ' + item.name + ' ' + item.url + ' ' + item.description).toLocaleLowerCase().includes(query));
      if (!shown.length) return;
      const section = element('section');
      const grid = element('div', 'browser-site-grid');
      grid.dataset.siteCategory = title;
      grid.toggleAttribute('data-site-bookmarks', starred);
      grid.append(...shown.map(({item, configured}) => renderCard(item, configured, oldCards.get(item.id))));
      const heading = element('h2', '', title);
      if (starred) section.append(heading);
      else {
        const header = element('header', 'browser-site-category-heading');
        header.dataset.siteCategoryHeading = title;
        const edit = actionButton('edit', '重命名分类 ' + title, () => showCategoryEditor(title));
        edit.classList.add('browser-site-category-edit');
        edit.dataset.siteCategoryEdit = title;
        edit.setAttribute('aria-haspopup', 'dialog');
        section.dataset.navigationCategory = title;
        header.append(heading, edit);
        updateCategoryHandle(header);
        section.append(header);
      }
      section.append(grid);
      sections.push(section);
    }
    const siteByUrl = new Map(sites.map(site => [site.url, site]));
    appendGroup(bookmarkCategory, bookmarks.map(bookmark => {
      const configured = siteByUrl.get(bookmark.url);
      const item = display(configured || bookmark);
      return {item:{...item, id:bookmark.id}, configured};
    }), true);
    for (const [title, group] of grouped) appendGroup(title, group.map(site => ({item:display(site), configured:site})));
    list.replaceChildren(...sections);
    empty.textContent = query ? '没有匹配的站点。' : '还没有站点。';
    empty.hidden = Boolean(sections.length);
    const id = focusId || focusedId;
    if (id) {
      const card = list.querySelector('[data-site-id="' + CSS.escape(id) + '"]');
      card?.querySelector(action ? '[data-site-action="' + CSS.escape(action) + '"]' : '.browser-site')?.focus({preventScroll:true});
    } else if (focusedCategory) categoryButton(focusedCategory)?.focus({preventScroll:true});
  }

  function categoryButton(title) {
    return list.querySelector('[data-site-category-edit="' + CSS.escape(title) + '"]');
  }

  function showCategoryEditor(title) {
    if (categoryDialog.open || !categories.includes(title) || !canEditSites()) return;
    categoryDraft = {scope,title};
    categoryName.value = title;
    categoryFeedback.textContent = '';
    categoryDialog.showModal();
    categoryName.focus();
    categoryName.select();
  }

  categoryDialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    if (!categoryDraft || categoryDraft.scope !== scope) return;
    const {title:previous} = categoryDraft;
    const title = cleanLabel(categoryName.value,40);
    if (!categories.includes(previous)) {
      categoryFeedback.textContent = '此分类已变更，请重新选择。';
      return;
    }
    if (!title || (title !== previous && (title === bookmarkCategory || categories.some(category =>
      category !== previous && category.toLocaleLowerCase() === title.toLocaleLowerCase())))) {
      categoryFeedback.textContent = title ? '已经有同名分类。' : '请输入分类名称。';
      categoryName.focus();
      return;
    }
    if (title !== previous) {
      const next = sites.map(site => site.category === previous ? {...site,category:title} : site);
      const order = categories.map(category => category === previous ? title : category);
      const addTo = newSiteCategory === previous ? title : newSiteCategory;
      if (!save(next,categoryFeedback,order,addTo)) return;
      log('重命名导航分类 · ' + title);
    }
    categoryDialog.close();
    render();
    (categoryButton(title) || filter).focus({preventScroll:true});
  });
  categoryName.addEventListener('input', () => { categoryFeedback.textContent = ''; });
  categoryDialog.querySelector('[data-category-cancel]').addEventListener('click', () => categoryDialog.close());
  categoryDialog.addEventListener('close', () => { if (!categoryDialog.open) categoryDraft = null; });

  function render() {
    cancelCategoryDrag();
    drag.cancel();
    paint();
    requestMetadata();
  }

  function canReorderCategories() {
    return !filter.value.trim() && (!teamId || !teamSync || teamStatus.dataset.phase === 'ready');
  }

  function updateCategoryHandle(header) {
    const enabled = canReorderCategories();
    header.toggleAttribute('data-category-movable', enabled);
    const edit = header.querySelector('[data-site-category-edit]');
    if (enabled) edit.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    else edit.removeAttribute('aria-keyshortcuts');
  }

  function reorderedCategories(title, target, after) {
    if (title === target || !categories.includes(title) || !categories.includes(target)) return null;
    const order = categories.filter(category => category !== title);
    order.splice(order.indexOf(target) + Number(after), 0, title);
    return order.every((category,index) => category === categories[index]) ? null : order;
  }

  function moveCategory(title, target, after) {
    if (dialog.open || categoryDialog.open) return false;
    const order = canReorderCategories() && reorderedCategories(title,target,after);
    if (!order || !save(sites,entryStatus,order)) return false;
    render();
    categoryButton(title)?.focus({preventScroll:true});
    return true;
  }

  function showCategoryDrop(target) {
    if (categoryDropTarget?.section === target?.section && categoryDropTarget?.after === target?.after) return;
    categoryDropTarget?.section.removeAttribute('data-category-drop');
    categoryDropTarget = target;
    if (target) target.section.dataset.categoryDrop = target.after ? 'after' : 'before';
  }

  function cancelCategoryDrag() {
    const current = categoryDrag;
    if (!current) return;
    categoryDrag = null;
    cancelAnimationFrame(current.frame);
    current.heading.removeAttribute('data-category-dragging');
    showCategoryDrop(null);
    if (list.hasPointerCapture(current.pointer)) list.releasePointerCapture(current.pointer);
  }

  function updateCategoryDrag(autoscroll = true) {
    const current = categoryDrag;
    if (!current?.started) return;
    current.frame = 0;
    const {x,y,title} = current;
    const bounds = list.getBoundingClientRect();
    const viewport = scroller?.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || (viewport && (y < viewport.top || y > viewport.bottom))) {
      showCategoryDrop(null);
      return;
    }
    let target = null;
    for (const section of list.querySelectorAll('[data-navigation-category]')) {
      const {top,bottom,height} = section.getBoundingClientRect();
      if (y < top - 12 || y > bottom + 12) continue;
      const after = y > top + height / 2;
      if (reorderedCategories(title,section.dataset.navigationCategory,after)) target = {section,after};
      break;
    }
    showCategoryDrop(target);
    if (viewport && autoscroll) {
      const before = scroller.scrollTop;
      scroller.scrollTop += y < viewport.top + 36 ? -14 : y > viewport.bottom - 36 ? 14 : 0;
      if (scroller.scrollTop !== before) current.frame = requestAnimationFrame(() => updateCategoryDrag());
    }
  }

  function finishCategoryDrag(commit = false) {
    const current = categoryDrag;
    const target = categoryDropTarget;
    cancelCategoryDrag();
    if (current?.started && (!commit || !target ||
        !moveCategory(current.title,target.section.dataset.navigationCategory,target.after))) paint();
  }

  list.addEventListener('pointerdown', event => {
    const heading = event.target.closest('[data-site-category-heading][data-category-movable]');
    if (!heading || event.target.closest('button') || event.button !== 0 || !event.isPrimary ||
        categoryDrag || drag.busy() || dialog.open || categoryDialog.open) return;
    const {pointerId,clientX,clientY} = event;
    categoryDrag = {heading,title:heading.dataset.siteCategoryHeading,pointer:pointerId,startX:clientX,startY:clientY,frame:0};
  });
  window.addEventListener('pointermove', event => {
    const current = categoryDrag;
    if (!current || current.pointer !== event.pointerId) return;
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) return finishCategoryDrag();
    if (!current.started) {
      if (Math.hypot(event.clientX - current.startX,event.clientY - current.startY) < 6) return;
      current.started = true;
      current.heading.setAttribute('data-category-dragging','');
      list.setPointerCapture(current.pointer);
    }
    current.x = event.clientX;
    current.y = event.clientY;
    event.preventDefault();
    if (!current.frame) current.frame = requestAnimationFrame(() => updateCategoryDrag());
  },{capture:true,passive:false});
  window.addEventListener('pointerup', event => {
    if (categoryDrag?.pointer !== event.pointerId) return;
    if (categoryDrag.started) {
      categoryDrag.x = event.clientX;
      categoryDrag.y = event.clientY;
      cancelAnimationFrame(categoryDrag.frame);
      updateCategoryDrag(false);
    }
    finishCategoryDrag(true);
  },{capture:true});
  for (const type of ['pointercancel','lostpointercapture']) window.addEventListener(type,event => {
    if (categoryDrag?.pointer === event.pointerId) finishCategoryDrag();
  },{capture:true});
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !categoryDrag?.started) return;
    event.preventDefault();
    event.stopPropagation();
    finishCategoryDrag();
  },{capture:true});
  window.addEventListener('blur', () => finishCategoryDrag());
  list.addEventListener('dragstart', event => {
    if (event.target.closest('[data-site-category-heading]')) event.preventDefault();
  });
  list.addEventListener('keydown', event => {
    if (!canReorderCategories() || categoryDrag || drag.busy() || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !['ArrowUp','ArrowDown'].includes(event.key)) return;
    const heading = event.target.closest('[data-site-category-edit]');
    if (!heading) return;
    event.preventDefault();
    const after = event.key === 'ArrowDown';
    const section = heading.closest('[data-navigation-category]');
    const target = (after ? section.nextElementSibling : section.previousElementSibling)?.dataset.navigationCategory;
    if (target) moveCategory(heading.dataset.siteCategoryEdit,target,after);
  });

  function moveSite({id, category, before, bookmark}) {
    const current = bookmark ? bookmarks : sites;
    const item = current.find(site => site.id === id);
    if (!item) return false;
    const next = current.filter(site => site !== item);
    const target = next.findIndex(site => site.id === before && (bookmark || site.category === category));
    const moved = bookmark ? item : {...item, category};
    const last = bookmark ? next.length : next.findLastIndex(site => site.category === category) + 1;
    next.splice(target >= 0 ? target : last || next.length, 0, moved);
    if (!bookmark) {
      if (!save(next, entryStatus)) return false;
    } else {
      try {
        localStorage.setItem(bookmarkKey + ':' + scope, JSON.stringify(next.map(site => ({title:site.name, url:site.url}))));
        bookmarks = next;
      } catch {
        showEntryStatus('无法保存收藏站点顺序。', true);
        return false;
      }
    }
    return true;
  }

  const drag = initBrowserSiteDrag(list, {move:moveSite, repaint:paint});

  get('browser-site-quick-form').addEventListener('submit', event => {
    event.preventDefault();
    createSite(entry.value);
  });
  entry.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (!event.repeat) createSite(entry.value);
  });
  entry.addEventListener('paste', event => {
    const value = event.clipboardData?.getData('text/plain');
    if (!value) return;
    event.preventDefault();
    entry.value = value.trim();
    createSite(entry.value);
  });
  entry.addEventListener('input', () => showEntryStatus());
  urlField.addEventListener('input', addressChanged);
  testEntry.addEventListener('click', () => {
    const address = safeAddress(urlField.value, true);
    if (address) navigate(address.href);
  });
  nameField.addEventListener('input', () => {
    automaticName = !nameField.value.trim();
    if (automaticName) return;
    const address = safeAddress(urlField.value, true);
    const item = sites.find(site => site.id === editing);
    const iconData = address && (metadata.get(address.href)?.iconData || (address.href === item?.url ? item.iconData : ''));
    siteMark(iconPreview, nameField.value.trim(), iconData, address?.href);
  });
  descriptionField.addEventListener('input', () => { automaticDescription = !descriptionField.value.trim(); });
  get('browser-site-form').addEventListener('submit', event => {
    event.preventDefault();
    const existing = sites.find(site => site.id === editing);
    if (!existing) return;
    const address = safeAddress(urlField.value, true);
    const label = cleanLabel(categoryField.value, 40);
    const category = categories.find(title => title.toLocaleLowerCase() === label.toLocaleLowerCase()) || label;
    if (!category || !address) {
      feedback.textContent = '请填写分类和有效的 HTTP 或 HTTPS 网站地址。';
      (!address ? urlField : categoryField).focus();
      return;
    }
    if (sites.some(site => site.id !== existing.id && site.url === address.href)) {
      feedback.textContent = '导航里已有这个网址。';
      urlField.focus();
      return;
    }
    if (category === bookmarkCategory && !categories.includes(category)) {
      feedback.textContent = '请使用其他分类名称。';
      categoryField.focus();
      return;
    }
    const manualName = cleanLabel(nameField.value, 120);
    const autoName = automaticName || !manualName || isAddressLabel(manualName,address.href);
    const name = autoName ? automaticSiteName(address.href,metadata.get(address.href)?.name,
      address.href === existing.url && existing.autoName ? existing.name : '') : manualName;
    const description = automaticDescription ? '' : cleanDescription(descriptionField.value);
    const iconData = address.href === existing.url ? existing.iconData : '';
    const site = {id:existing.id, name, url:address.href, category,
      ...(autoName && {autoName:true}), ...(description && {description}), ...(iconData && {iconData})};
    if (!save(sites.map(item => item.id === existing.id ? site : item))) return;
    log('更新导航站点 · ' + address.hostname);
    metadata.request([site.url], true);
    dialog.close();
    render();
    list.querySelector('[data-site-id="' + CSS.escape(site.id) + '"] .browser-site')?.focus({preventScroll:true});
  });
  get('browser-site-remove').addEventListener('click', () => {
    const item = sites.find(site => site.id === editing);
    if (!item) return;
    get('browser-site-confirm-text').textContent = '从站点导航移除「' + display(item).name + '」？';
    confirmation.hidden = false;
    get('browser-site-confirm-cancel').focus();
  });
  get('browser-site-confirm-cancel').addEventListener('click', () => {
    confirmation.hidden = true;
    get('browser-site-remove').focus();
  });
  get('browser-site-confirm-remove').addEventListener('click', () => {
    const item = sites.find(site => site.id === editing);
    if (!item || !save(sites.filter(site => site !== item))) return;
    log('移除导航站点 · ' + new URL(item.url).hostname);
    dialog.close();
    render();
    entry.focus({preventScroll:true});
  });
  dialog.addEventListener('close', () => clearTimeout(lookupTimer));
  for (const id of ['browser-site-cancel', 'browser-site-close']) get(id).addEventListener('click', () => dialog.close());
  filter.addEventListener('input', render);
  window.addEventListener('storage', event => {
    if (event.key === scopedStorage(scope) || event.key === legacyScopedStorage(scope) || event.key === bookmarkKey + ':' + scope ||
        event.key === null || (scope === defaultScope && [legacyStorageKey, bookmarkKey].includes(event.key))) {
      if (!teamId || !teamSync) ({sites,categories,newSiteCategory} = readNavigation(scope) || defaultNavigation());
      bookmarks = loadBookmarks(scope);
      render();
    }
  });
  function refresh() {
    requestMetadata();
    if (visible()) teamSync?.refresh();
  }
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  if (teamSync) setInterval(() => { if (visible()) teamSync.refresh(); }, teamRefreshInterval);
  if (readMetadata) setInterval(requestMetadata, 30 * 60 * 1000);

  render();
  return {
    render,
    refresh,
    setScope(next, nextTeamId, nextWorkspace = next) {
      const showing = visible();
      const opened = showing && !wasVisible;
      wasVisible = showing;
      if (next === scope && workspace === nextWorkspace && teamId === nextTeamId) {
        if (!showing && (drag.busy() || categoryDrag)) render();
        else requestMetadata();
        if (opened) teamSync?.refresh();
        return;
      }
      scope = next;
      workspace = nextWorkspace;
      teamId = nextTeamId;
      metadata.setScope(next);
      clearTimeout(lookupTimer);
      if (dialog.open) dialog.close();
      if (categoryDialog.open) categoryDialog.close();
      editing = null;
      categoryDraft = null;
      cancelCategoryDrag();
      filter.value = entry.value = '';
      showEntryStatus();
      ({sites,categories,newSiteCategory} = teamSync?.setScope(scope,teamId) || readNavigation(scope) || defaultNavigation());
      bookmarks = loadBookmarks(scope);
      render();
      if (showing) teamSync?.refresh();
    },
  };
}
