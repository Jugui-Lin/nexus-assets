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
const storageKey = 'nexus-browser-sites-v1';
const bookmarkKey = 'nexus-browser-bookmarks-v1';
const defaultScope = 'personal:personal';
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

function siteMark(mark, name, iconData) {
  const letter = element('span', '', [...name][0]?.toLocaleUpperCase() || '•');
  mark.replaceChildren(letter);
  if (!iconData) return;
  const image = element('img');
  image.alt = '';
  letter.hidden = true;
  image.addEventListener('error', () => {
    image.remove();
    letter.hidden = false;
  }, {once:true});
  image.src = iconData;
  mark.append(image);
}

function baseSites() {
  return defaultGroups.flatMap(([category, sites]) => sites.map(([name, url]) => ({
    id:new URL(url).hostname, name, url, category,
  })));
}

const scopedStorage = scope => storageKey + ':' + scope;

function loadSites(scope) {
  try {
    const stored = localStorage.getItem(scopedStorage(scope));
    const saved = JSON.parse(stored ?? (scope === defaultScope ? localStorage.getItem(storageKey) : null));
    if (!Array.isArray(saved)) return baseSites();
    const ids = new Set();
    const addresses = new Set();
    return saved.flatMap(site => {
      const id = cleanLabel(site?.id, 200);
      const name = cleanLabel(site?.name, 120);
      const category = cleanLabel(site?.category, 40);
      const address = safeAddress(site?.url);
      if (!id || !name || !category || !address || ids.has(id) || addresses.has(address.href)) return [];
      ids.add(id);
      addresses.add(address.href);
      const iconData = siteIcon(site.iconData);
      return [{id, name, url:address.href, category, ...(iconData && {iconData})}];
    });
  } catch { return baseSites(); }
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
      return [{id:'bookmark:' + address.href, name:cleanLabel(record.title, 120) || address.hostname, url:address.href}];
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

export function initBrowserSites({navigate, onSubscribe, readMetadata, scope = defaultScope, log = () => {}}) {
  const get = id => document.getElementById(id);
  const filter = get('browser-site-filter');
  const list = get('browser-sites');
  const empty = get('browser-empty');
  const add = get('browser-add-site');
  let sites = loadSites(scope);
  let bookmarks = loadBookmarks(scope);
  let editing = null;
  let itemIcon = '';
  let automaticName = true;
  let lookupTimer;
  let lookup = null;
  let submitToken = null;

  const dialog = element('dialog', 'browser-site-dialog');
  dialog.id = 'browser-site-dialog';
  dialog.setAttribute('aria-labelledby', 'browser-site-dialog-title');
  dialog.innerHTML = `<form id="browser-site-form">
    <header><h2 id="browser-site-dialog-title">添加网站</h2><button id="browser-site-close" type="button" aria-label="关闭">×</button></header>
    <label for="browser-site-url">网站地址</label><input id="browser-site-url" type="text" required inputmode="url" maxlength="2048" placeholder="粘贴网站地址" autocomplete="off" spellcheck="false">
    <label for="browser-site-name">网站名称</label>
    <div class="browser-site-name-row"><span id="browser-site-icon" class="browser-site-mark" aria-hidden="true"></span><input id="browser-site-name" type="text" maxlength="120" placeholder="自动识别，也可手动填写" autocomplete="off"></div>
    <p id="browser-site-lookup-status" role="status"></p>
    <label for="browser-site-category">分类</label><input id="browser-site-category" type="text" required list="browser-site-category-list" maxlength="40" autocomplete="off">
    <datalist id="browser-site-category-list"></datalist>
    <p id="browser-site-form-status" role="alert"></p>
    <div id="browser-site-confirm" class="browser-site-confirm" hidden><p id="browser-site-confirm-text"></p><button id="browser-site-confirm-remove" type="button">确认移除</button><button id="browser-site-confirm-cancel" type="button">返回</button></div>
    <footer><button id="browser-site-remove" type="button" hidden>移除网站</button><button id="browser-site-cancel" type="button">取消</button><button id="browser-site-save" type="submit">添加网站</button></footer>
  </form>`;
  document.body.append(dialog);
  const nameField = get('browser-site-name');
  const urlField = get('browser-site-url');
  const categoryField = get('browser-site-category');
  const feedback = get('browser-site-form-status');
  const confirmation = get('browser-site-confirm');
  const siteIconPreview = get('browser-site-icon');
  const lookupStatus = get('browser-site-lookup-status');
  const saveButton = get('browser-site-save');

  function clearLookup() {
    clearTimeout(lookupTimer);
    lookup = null;
    lookupStatus.textContent = '';
  }

  function renderIconPreview() {
    siteMark(siteIconPreview, nameField.value.trim(), itemIcon);
  }

  function inspectAddress(address) {
    clearTimeout(lookupTimer);
    if (!address || !readMetadata) return;
    if (lookup?.url === address.href) return lookup.promise;
    const request = {url:address.href};
    lookup = request;
    lookupStatus.textContent = '正在识别网站…';
    request.promise = Promise.resolve().then(() => readMetadata(request.url)).catch(() => null).then(metadata => {
      if (lookup !== request || !dialog.open || safeAddress(urlField.value, true)?.href !== request.url) return;
      const recognised = cleanLabel(metadata?.name, 120);
      if (automaticName && recognised) nameField.value = recognised;
      itemIcon = siteIcon(metadata?.iconData);
      lookupStatus.textContent = '';
      renderIconPreview();
    });
    return request.promise;
  }

  function addressChanged() {
    feedback.textContent = '';
    submitToken = null;
    saveButton.disabled = false;
    clearLookup();
    const address = safeAddress(urlField.value, true);
    const existing = sites.find(site => site.id === editing);
    itemIcon = address?.href === existing?.url ? existing?.iconData || '' : '';
    if (automaticName) nameField.value = address?.hostname.replace(/^www\./i, '') || '';
    renderIconPreview();
    if (address && address.href !== existing?.url) lookupTimer = setTimeout(() => inspectAddress(address), 350);
  }

  function showEditor(site = null, preset = null) {
    if (dialog.open) return;
    clearLookup();
    submitToken = null;
    saveButton.disabled = false;
    editing = site?.id || null;
    get('browser-site-dialog-title').textContent = editing ? '编辑网站' : '添加网站';
    saveButton.textContent = editing ? '保存' : '添加网站';
    get('browser-site-remove').hidden = !editing;
    confirmation.hidden = true;
    feedback.textContent = '';
    nameField.value = site?.name || preset?.name || '';
    automaticName = !nameField.value;
    itemIcon = site?.iconData || '';
    urlField.value = site?.url || preset?.url || '';
    categoryField.value = site?.category || '其他';
    const categories = [...new Set([...defaultGroups.map(([title]) => title), ...sites.map(item => item.category), '其他'])];
    get('browser-site-category-list').replaceChildren(...categories.map(title => new Option(title, title)));
    dialog.showModal();
    renderIconPreview();
    if (editing) nameField.focus();
    else {
      urlField.focus();
      if (urlField.value) addressChanged();
    }
  }

  function renderCard(item, starred) {
    const card = element('article', 'browser-site-card');
    card.dataset.siteId = item.id;
    const button = element('button', 'browser-site');
    button.type = 'button';
    button.title = '在默认浏览器打开 ' + item.url;
    button.addEventListener('click', () => navigate(item.url));
    const tile = element('span', 'browser-site-mark');
    tile.setAttribute('aria-hidden', 'true');
    siteMark(tile, item.name, item.iconData);
    const label = element('span', 'browser-site-text');
    const domain = new URL(item.url).hostname.replace(/^www\./i, '');
    label.append(element('strong', '', item.name), element('small', '', domain));
    button.append(tile, label);
    const actions = element('div', 'browser-site-actions');
    actions.append(actionButton('edit', `编辑 ${item.name} 的导航`, () => {
      const configured = starred ? sites.find(site => site.url === item.url) : item;
      showEditor(configured, item);
    }));
    if (onSubscribe) actions.append(actionButton('rss', `订阅 ${item.name}`, () => onSubscribe({url:item.url, name:item.name})));
    card.append(button, actions);
    return card;
  }

  function render() {
    const query = filter.value.trim().toLocaleLowerCase();
    const grouped = new Map(defaultGroups.map(([title]) => [title, []]));
    for (const site of sites) {
      if (!grouped.has(site.category)) grouped.set(site.category, []);
      grouped.get(site.category).push(site);
    }
    const sections = [];
    function appendGroup(title, group, starred = false) {
      const shown = group.filter(item => `${title} ${item.name} ${item.url}`.toLocaleLowerCase().includes(query));
      if (!shown.length) return;
      const section = element('section');
      const grid = element('div', 'browser-site-grid');
      grid.append(...shown.map(item => renderCard(item, starred)));
      section.append(element('h2', '', title), grid);
      sections.push(section);
    }
    const siteByUrl = new Map(sites.map(site => [site.url, site]));
    appendGroup('收藏的网站', bookmarks.map(bookmark => {
      const site = siteByUrl.get(bookmark.url);
      return site ? {...bookmark, name:site.name, iconData:site.iconData} : bookmark;
    }), true);
    for (const [title, group] of grouped) appendGroup(title, group);
    list.replaceChildren(...sections);
    empty.textContent = query ? '没有匹配的站点。' : '还没有站点。';
    empty.hidden = Boolean(sections.length);
  }

  function save(next) {
    try { localStorage.setItem(scopedStorage(scope), JSON.stringify(next)); }
    catch { feedback.textContent = '无法保存网站导航，请检查本机存储空间。'; return false; }
    sites = next;
    return true;
  }

  urlField.addEventListener('input', addressChanged);
  nameField.addEventListener('input', () => {
    automaticName = !nameField.value.trim();
    renderIconPreview();
  });
  get('browser-site-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (submitToken) return;
    const address = safeAddress(urlField.value, true);
    const category = cleanLabel(categoryField.value, 40);
    if (!category || !address) {
      feedback.textContent = '请填写分类和有效的 HTTP 或 HTTPS 网站地址。';
      (!address ? urlField : categoryField).focus();
      return;
    }
    if (sites.some(site => site.id !== editing && site.url === address.href)) {
      feedback.textContent = '导航里已有这个网址。';
      urlField.focus();
      return;
    }
    const existing = sites.find(site => site.id === editing);
    if (address.href !== existing?.url) {
      const token = {};
      submitToken = token;
      saveButton.disabled = true;
      await inspectAddress(address);
      if (submitToken !== token) return;
      submitToken = null;
      saveButton.disabled = false;
      if (!dialog.open || safeAddress(urlField.value, true)?.href !== address.href) return;
    }
    const currentCategory = cleanLabel(categoryField.value, 40);
    if (!currentCategory) {
      feedback.textContent = '请填写分类。';
      categoryField.focus();
      return;
    }
    if (sites.some(site => site.id !== editing && site.url === address.href)) {
      feedback.textContent = '导航里已有这个网址。';
      urlField.focus();
      return;
    }
    const name = cleanLabel(nameField.value, 120) || address.hostname.replace(/^www\./i, '');
    const site = {id:editing || crypto.randomUUID(), name, url:address.href, category:currentCategory, ...(itemIcon && {iconData:itemIcon})};
    if (!save(editing ? sites.map(item => item.id === editing ? site : item) : [...sites, site])) return;
    log(`${editing ? '更新' : '添加'}导航站点 · ${address.hostname}`);
    if (!editing) filter.value = '';
    dialog.close();
    render();
    (list.querySelector(`[data-site-id="${CSS.escape(site.id)}"] .browser-site`) || filter).focus({preventScroll:true});
  });
  get('browser-site-remove').addEventListener('click', () => {
    const site = sites.find(item => item.id === editing);
    if (!site) return;
    get('browser-site-confirm-text').textContent = `从站点导航移除「${site.name}」？`;
    confirmation.hidden = false;
    get('browser-site-confirm-cancel').focus();
  });
  get('browser-site-confirm-cancel').addEventListener('click', () => {
    confirmation.hidden = true;
    get('browser-site-remove').focus();
  });
  get('browser-site-confirm-remove').addEventListener('click', () => {
    const removed = sites.find(site => site.id === editing);
    if (!editing || !save(sites.filter(item => item.id !== editing))) return;
    if (removed) log(`移除导航站点 · ${new URL(removed.url).hostname}`);
    dialog.close();
    render();
    add.focus({preventScroll:true});
  });
  for (const id of ['browser-site-cancel', 'browser-site-close']) get(id).addEventListener('click', () => dialog.close());
  filter.addEventListener('input', render);
  add.addEventListener('click', () => showEditor());
  window.addEventListener('storage', event => {
    if (event.key === scopedStorage(scope) || event.key === bookmarkKey + ':' + scope ||
        event.key === null || (scope === defaultScope && [storageKey, bookmarkKey].includes(event.key))) {
      sites = loadSites(scope);
      bookmarks = loadBookmarks(scope);
      render();
    }
  });

  render();
  return {
    render,
    setScope(next) {
      if (next === scope) return;
      scope = next;
      clearLookup();
      submitToken = null;
      if (dialog.open) dialog.close();
      editing = null;
      filter.value = '';
      sites = loadSites(scope);
      bookmarks = loadBookmarks(scope);
      render();
    },
  };
}
