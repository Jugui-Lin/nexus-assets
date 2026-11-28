import {normalizeAssetKind, normalizeQuickFilters} from './quick-filters.js';
import {initFolderPinDrag} from './folder-pin-drag.js';
import {mergedTeamFolderMap, rebaseMergedTeamFolder} from './folders.js';

const storagePrefix = 'nexus-navigation-v1:';
const teamPinsPrefix = 'nexus-team-quick-access-v1:';
const views = ['all', 'favorites', 'recent'];
const sorts = ['added', 'modified', 'name', 'size', 'rating'];
const workflowStatuses = ['', 'unset', 'wip', 'review', 'approved', 'archived'];
const invalidLocation = '文件夹或合集目前不可用';

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function filterValues(values, legacy = '') {
  const entries = Array.isArray(values) ? values : [legacy];
  return [...new Set(entries.map(value => asString(value).trim().toLowerCase()).filter(Boolean))].sort();
}

export function normalizeAssetSearchScope(scope, library) {
  return scope === 'workspace' || scope === 'library' && library ? scope : 'location';
}

function captureQuery(state, searchText = state.search) {
  const library = asString(state.library) || null;
  const rating = Number(state.rating ?? 0);
  const formatExcludes = filterValues(state.formatExcludes);
  const tagExcludes = filterValues(state.tagExcludes);
  const search = asString(searchText).trim().toLowerCase().replaceAll('\\', '/');
  return {
    view: views.includes(state.view) ? state.view : 'all',
    library,
    folder: library ? asString(state.folder) : '',
    collection: asString(state.collection) || null,
    recursive: !library || state.recursive !== false,
    kind: normalizeAssetKind(state.kind),
    tag: asString(state.tag) || null,
    search,
    searchText: asString(searchText),
    searchScope: search ? normalizeAssetSearchScope(state.searchScope, library) : 'location',
    formatIncludes: filterValues(state.formatIncludes, asString(state.format)).filter(value => !formatExcludes.includes(value)),
    formatExcludes,
    tagIncludes: filterValues(state.tagIncludes).filter(value => !tagExcludes.includes(value)),
    tagExcludes,
    sort: sorts.includes(state.sort) ? state.sort : 'added',
    rating: Number.isInteger(rating) && rating >= 0 && rating <= 5 ? rating : 0,
    workflow: workflowStatuses.includes(state.workflow) ? state.workflow : '',
    quickFilters: normalizeQuickFilters(state.quickFilters),
    fileNameQuery: asString(state.fileNameQuery).slice(0, 255),
  };
}

function queryKey(query) {
  const {searchText, fileNameQuery, ...filters} = query;
  return JSON.stringify({...filters, fileNameQuery: fileNameQuery.trim().normalize('NFC').toLowerCase()});
}

function pinKey(library, folder) {
  return JSON.stringify([library, folder]);
}

function loadNavigation(scope) {
  try {
    const saved = JSON.parse(localStorage.getItem(storagePrefix + scope));
    const searches = Array.isArray(saved?.searches) ? saved.searches : [];
    const pins = Array.isArray(saved?.pins) ? saved.pins : [];
    return {
      searches: searches.filter(item => typeof item?.name === 'string' && item.query && typeof item.query === 'object')
        .map(item => ({name: item.name, query: captureQuery(item.query, item.query.searchText ?? item.query.search)})),
      pins: pins.filter(item => typeof item?.library === 'string' && typeof item.folder === 'string'),
      mergedRoots: Array.isArray(saved?.mergedRoots) ? saved.mergedRoots.filter(id => typeof id === 'string') : [],
    };
  } catch {
    return {searches: [], pins: [], mergedRoots: []};
  }
}

function sharedPinRecords(value) {
  if (!Array.isArray(value)) return [];
  const rows = new Map();
  for (const {libraryId, folder} of value.filter(item => item && typeof item === 'object')) {
    if (typeof libraryId !== 'string' || !libraryId || typeof folder !== 'string') continue;
    rows.set(pinKey(libraryId, folder), {libraryId, folder});
  }
  return [...rows.values()];
}

function cachedTeamPins(scope) {
  try { return sharedPinRecords(JSON.parse(localStorage.getItem(teamPinsPrefix + scope))); }
  catch { return []; }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function appendIcon(node, name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  node.append(svg);
}

function button(className, label, icon) {
  const control = element('button', className);
  control.type = 'button';
  control.title = label;
  control.setAttribute('aria-label', label);
  if (icon) appendIcon(control, icon);
  return control;
}

function shortcutSection(id, title, emptyMessage) {
  const section = element('section', 'workspace-shortcuts hidden');
  const label = element('div', 'nav-label', title);
  label.id = id;
  section.setAttribute('aria-labelledby', id);
  const list = element('div');
  section.append(label, list);
  const empty = emptyMessage && element('p', 'workspace-quick-access-empty', emptyMessage);
  if (empty) section.append(empty);
  return {section, label, list, empty, signature: null};
}

function markCurrentShortcut(control, active) {
  control.classList.toggle('active', active);
  if (active) control.setAttribute('aria-current', 'true');
  else control.removeAttribute('aria-current');
}

function renderShortcuts(group, entries, onOpen, onRemove, fallback, onLocate, onPublish) {
  const signature = JSON.stringify(entries.map(({active, ...entry}) => entry));
  if (group.signature === signature) {
    // Keep the clicked button in place while the first click makes it current.
    entries.forEach((entry, index) => markCurrentShortcut(group.list.children[index].firstElementChild, entry.active));
    return;
  }
  group.signature = signature;
  const focused = group.list.contains(document.activeElement);
  const focusedKey = focused ? document.activeElement.dataset.shortcutKey : null;
  const rows = entries.map(entry => {
    const row = element('div', 'workspace-shortcut-row');
    if (entry.library) {
      row.dataset.pinnedLibrary = entry.library;
      row.dataset.pinnedFolder = entry.folder;
    }
    const open = button('nav-item', entry.name, entry.icon);
    open.title = onLocate && !entry.unavailable
      ? `${entry.title || entry.name} · 单击打开 · 双击定位文件夹`
      : entry.title || entry.name;
    open.dataset.shortcutKey = entry.key;
    open.append(element('span', 'folder-label', entry.name));
    if (entry.localOnly) open.append(element('small', 'workspace-pin-local', '本机'));
    open.disabled = entry.unavailable;
    markCurrentShortcut(open, entry.active);
    open.addEventListener('click', event => {
      if (!onLocate || event.detail <= 1) onOpen(entry.key);
    });
    row.append(open);
    if (onLocate && !entry.unavailable) row.addEventListener('dblclick', event => {
      if (event.target.closest('.workspace-shortcut-remove, .workspace-shortcut-share')) return;
      event.preventDefault();
      onLocate(entry.library, entry.folder);
    });
    const remove = button('icon-button workspace-shortcut-remove', `${entry.removeLabel} ${entry.name}`, 'close');
    remove.dataset.shortcutKey = `${entry.key}:remove`;
    remove.classList.toggle('hidden', entry.showRemove === false);
    remove.disabled = entry.removeDisabled === true;
    remove.addEventListener('click', () => onRemove(entry.key, entry.name));
    if (entry.canPublish) {
      const share = button('text-button workspace-shortcut-share', `共享「${entry.name}」到团队`);
      share.textContent = '共享';
      share.dataset.shortcutKey = `${entry.key}:share`;
      share.addEventListener('click', () => onPublish(entry.library, entry.folder));
      row.append(share);
    }
    row.append(remove);
    return row;
  });
  group.list.replaceChildren(...rows);
  group.section.classList.toggle('hidden', !entries.length && !group.empty);
  group.empty?.classList.toggle('hidden', Boolean(entries.length));
  if (focused) {
    const buttons = [...group.list.querySelectorAll('button:not(:disabled, .hidden)')];
    const next = buttons.find(item => item.dataset.shortcutKey === focusedKey) || buttons[0] || fallback;
    next.focus({preventScroll: true});
  }
}

function createSaveDialog() {
  const dialog = element('dialog', 'modal workspace-search-dialog');
  dialog.setAttribute('aria-labelledby', 'workspace-save-search-title');
  const form = element('form');
  const header = element('div', 'modal-header');
  const title = element('h2', '', '保存搜索');
  title.id = 'workspace-save-search-title';
  const close = button('icon-button', '关闭', 'close');
  close.addEventListener('click', () => dialog.close());
  header.append(title, close);
  const label = element('label', 'field-label', '搜索名称');
  const name = element('input', 'text-field');
  name.id = 'workspace-search-name';
  name.type = 'text';
  name.required = true;
  name.maxLength = 80;
  label.htmlFor = name.id;
  const error = element('p', 'workspace-search-error hidden');
  error.id = 'workspace-search-error';
  error.setAttribute('role', 'status');
  name.setAttribute('aria-describedby', error.id);
  const footer = element('div', 'modal-footer');
  const cancel = button('button subtle', '取消');
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => dialog.close());
  const save = element('button', 'button primary', '保存');
  save.type = 'submit';
  footer.append(cancel, save);
  form.append(header, label, name, error, footer);
  dialog.append(form);
  return {dialog, form, name, error};
}

function createPinRemovalDialog() {
  const dialog = element('dialog', 'modal compact-dialog');
  dialog.id = 'quick-access-remove-dialog';
  const title = element('h2', '', '移除快速访问');
  title.id = 'quick-access-remove-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const header = element('div', 'modal-header');
  header.append(title);
  const description = element('p', 'modal-description');
  description.id = 'quick-access-remove-description';
  dialog.setAttribute('aria-describedby', description.id);
  const error = element('p', 'workspace-search-error hidden');
  error.setAttribute('role', 'status');
  const footer = element('div', 'modal-footer');
  const cancel = button('button subtle', '取消');
  cancel.textContent = '取消';
  cancel.autofocus = true;
  const confirm = button('button primary', '确认移除');
  confirm.textContent = '确认移除';
  footer.append(cancel, confirm);
  dialog.append(header, description, error, footer);
  return {dialog, description, error, cancel, confirm};
}

export function initWorkspaceNavigation({getScope, getState, findFolder, onOpenPinnedFolder, onLocatePinnedFolder, onApplySearch, onRefreshAssets, onNotify, canMoveFolder, moveFolder, teamQuickAccess}) {
  const mainNav = document.querySelector('#main-nav');
  const selectVisible = document.querySelector('#select-visible');
  const resultsToggle = document.querySelector('#asset-results-toggle');
  const searchInput = document.querySelector('#search');
  const searchToggle = document.querySelector('#asset-search-toggle');
  const title = document.querySelector('#page-title');
  if (!mainNav || !selectVisible || !searchInput || !title) return {render() {}};

  const savedSearches = shortcutSection('workspace-searches-title', '已保存搜索');
  const pinnedFolders = shortcutSection('workspace-pinned-title', '快速访问', '将文件夹拖到此处');
  pinnedFolders.section.classList.add('workspace-quick-access');
  const quickAccessHeading = element('div', 'workspace-quick-access-heading');
  const editPins = button('icon-button workspace-quick-access-edit', '编辑快速访问', 'lock');
  const editIcon = editPins.querySelector('use');
  editPins.id = 'edit-quick-access';
  pinnedFolders.list.id = 'workspace-quick-access-items';
  editPins.setAttribute('aria-controls', pinnedFolders.list.id);
  pinnedFolders.label.replaceWith(quickAccessHeading);
  quickAccessHeading.append(pinnedFolders.label, editPins);
  const teamPinsNotice = element('p', 'workspace-team-pins-status hidden');
  teamPinsNotice.setAttribute('role', 'status');
  pinnedFolders.list.before(teamPinsNotice);
  const quickAccessPane = document.querySelector('#organize-shortcuts');
  const dockHeading = quickAccessPane?.querySelector('.sidebar-pane-heading');
  if (dockHeading) {
    const placeEditButton = () => {
      const tabbed = quickAccessPane.hasAttribute('data-tabbed-panel');
      const destination = tabbed ? quickAccessHeading : dockHeading;
      const focused = editPins === document.activeElement;
      quickAccessHeading.classList.toggle('hidden', !tabbed);
      if (editPins.parentElement !== destination) {
        destination.insertBefore(editPins, destination.querySelector('.sidebar-dock-handle'));
        if (focused) editPins.focus({preventScroll:true});
      }
    };
    placeEditButton();
    const observer = new MutationObserver(placeEditButton);
    observer.observe(quickAccessPane, {attributes:true, attributeFilter:['data-tabbed-panel']});
  }
  const shortcuts = document.querySelector('#sidebar-shortcuts');
  if (shortcuts) shortcuts.append(pinnedFolders.section, savedSearches.section);
  else mainNav.after(savedSearches.section, pinnedFolders.section);

  const saveSearch = button('asset-toolbar-menu-item workspace-save-search', '保存当前搜索', 'search');
  saveSearch.append(element('span', '', '保存搜索'));
  selectVisible.before(saveSearch);

  const folderActions = document.querySelector('#asset-folder-actions');
  const pin = button('icon-button workspace-folder-button workspace-pin-folder', '固定当前文件夹', 'star');
  folderActions.prepend(pin);
  const refresh = onRefreshAssets && button('icon-button workspace-folder-button workspace-refresh-assets', '刷新当前目录', 'refresh');
  if (refresh) pin.after(refresh);

  const dialog = createSaveDialog();
  const pinRemoval = createPinRemovalDialog();
  document.body.append(dialog.dialog, pinRemoval.dialog);
  let pending = null;
  let pendingRemoval = null;
  let pinScope = getScope();
  let editingPins = false;
  let refreshing = false;
  let shared = {key:null, status:'idle', records:[], revision:null};
  let sharedRead;
  let sharedWrite;

  function change(scope, update) {
    const saved = loadNavigation(scope);
    if (update(saved) === false) return false;
    try {
      localStorage.setItem(storagePrefix + scope, JSON.stringify(saved));
    } catch {
      onNotify('无法在此设备保存快捷入口', true);
      return false;
    }
    render();
    return true;
  }

  function resolveFolder(library, folder) {
    const item = getState().libraries.find(item => item.id === library);
    const node = item && findFolder(library, folder);
    return node ? {path: node.path, name: node.name, trail: [item.name, node.path].filter(Boolean).join(' / ')} : null;
  }

  function teamContext() {
    const active = teamQuickAccess?.context();
    if (!active?.teamId) return null;
    const scope = getScope();
    return {...active, scope, key:JSON.stringify([scope, active.epoch])};
  }

  function syncTeamContext() {
    const context = teamContext();
    const key = context?.key || null;
    if (shared.key !== key) {
      shared = {key, status:'idle', records:context ? cachedTeamPins(context.scope) : [], revision:null};
    }
    return context;
  }

  function applyTeamPins(context, result) {
    if (context.key !== teamContext()?.key) return false;
    if (result?.available !== true || !Array.isArray(result.pins)) {
      shared.status = result?.available === false ? 'unsupported' : 'offline';
      return false;
    }
    shared.status = 'ready';
    const revision = Number.isSafeInteger(result.revision) ? result.revision : null;
    if (shared.revision !== null && (revision === null || revision < shared.revision)) return true;
    shared.records = sharedPinRecords(result.pins);
    shared.revision = revision;
    try { localStorage.setItem(teamPinsPrefix + context.scope, JSON.stringify(shared.records)); }
    catch { /* Online team pins still work when persistent storage is unavailable. */ }
    return true;
  }

  function refreshTeamQuickAccess() {
    const context = syncTeamContext();
    if (!context) return Promise.resolve();
    if (sharedRead?.key === context.key) return sharedRead.promise;
    if (shared.status === 'idle') shared.status = 'loading';
    const request = {key:context.key};
    request.promise = Promise.resolve().then(() => teamQuickAccess.list(context.teamId))
      .then(result => applyTeamPins(context, result))
      .catch(() => { if (context.key === teamContext()?.key) shared.status = 'offline'; })
      .finally(() => {
        if (sharedRead === request) sharedRead = null;
        if (context.key === teamContext()?.key) render();
      });
    sharedRead = request;
    return request.promise;
  }

  function pinEntries(local, context = syncTeamContext()) {
    if (!context) return local.map(item => ({...item, key:pinKey(item.library, item.folder)}));
    const merged = mergedTeamFolderMap(context.links);
    const remote = new Map();
    for (const {libraryId, folder} of shared.records) {
      const target = rebaseMergedTeamFolder(merged, libraryId, folder) || {libraryId, folder};
      const canonical = resolveFolder(target.libraryId, target.folder)?.path ?? target.folder;
      const key = pinKey(target.libraryId, canonical);
      if (!remote.has(key)) remote.set(key, {library:target.libraryId, folder:canonical,
        key:'team:' + pinKey(libraryId, folder), remote:true, sourceLibrary:libraryId, sourceFolder:folder});
    }
    const legacy = local.filter(item => !remote.has(pinKey(item.library, resolveFolder(item.library, item.folder)?.path ?? item.folder)))
      .map(item => ({...item, key:pinKey(item.library, item.folder), localOnly:true}));
    return [...remote.values(), ...legacy];
  }

  async function changeTeamPin(library, folder, pinned) {
    const context = syncTeamContext();
    if (!context || sharedWrite?.key === context.key) return false;
    if (shared.status !== 'ready') {
      onNotify(shared.status === 'unsupported' ? '请更新团队服务后使用共享快速访问' : '团队快捷项尚未同步，请连接团队服务后重试', true);
      return false;
    }
    const operation = {key:context.key};
    sharedWrite = operation;
    render();
    try {
      const result = await teamQuickAccess.set(context.teamId, library, folder, pinned);
      if (context.key !== teamContext()?.key) return false;
      if (!applyTeamPins(context, result)) throw Error('团队服务暂无法保存共享快捷项');
      onNotify(pinned ? '已添加到团队快速访问' : '已从团队快速访问移除');
      return true;
    } catch (failure) {
      if (context.key === teamContext()?.key) onNotify(failure?.message || String(failure), true);
      return false;
    } finally {
      if (sharedWrite === operation) sharedWrite = null;
      if (context.key === teamContext()?.key) render();
    }
  }

  function resolveQuery(query) {
    const folder = query.library ? resolveFolder(query.library, query.folder) : null;
    if (query.library && !folder) return null;
    if (query.collection && !getState().collections.some(item => item.id === query.collection)) return null;
    return folder ? {...query, folder: folder.path} : query;
  }

  function currentFolder() {
    const {library, folder} = getState();
    return library ? resolveFolder(library, folder) : null;
  }

  function searchFocusTarget() {
    return searchToggle?.getAttribute('aria-expanded') === 'false' ? searchToggle : searchInput;
  }

  function applySearch(key) {
    const item = loadNavigation(getScope()).searches.find(item => item.name === key);
    const query = item && resolveQuery(item.query);
    if (query) onApplySearch(query);
  }

  function openPin(key) {
    const item = pinEntries(loadNavigation(getScope()).pins).find(item => item.key === key);
    const folder = item && resolveFolder(item.library, item.folder);
    if (folder) onOpenPinnedFolder(item.library, folder.path);
  }

  function removeSearch(key) {
    change(getScope(), saved => {
      saved.searches = saved.searches.filter(item => item.name !== key);
    });
  }

  function requestPinRemoval(key, name) {
    const scope = getScope();
    if (!editingPins || pinScope !== scope || pinRemoval.dialog.open) return;
    const context = syncTeamContext();
    const entries = pinEntries(loadNavigation(scope).pins, context);
    const index = entries.findIndex(item => item.key === key);
    if (index < 0) return;
    const entry = entries[index];
    if (entry.remote && (shared.status !== 'ready' || sharedWrite?.key === context?.key)) return;
    pendingRemoval = {scope, key, index, entry, contextKey:context?.key};
    const folder = name ? `「${name}」` : '此文件夹';
    pinRemoval.description.textContent = entry.remote
      ? `从团队快速访问中移除${folder}？团队成员将不再看到这个快捷项，文件夹和文件会保留。`
      : `从快速访问中移除${folder}？原文件夹及其文件会保留。`;
    pinRemoval.error.classList.add('hidden');
    pinRemoval.dialog.showModal();
    pinRemoval.cancel.focus();
  }

  function closePinRemoval(removed = false) {
    const draft = pendingRemoval;
    pendingRemoval = null;
    pinRemoval.dialog.close();
    pinRemoval.cancel.disabled = false;
    pinRemoval.confirm.disabled = false;
    if (!draft || draft.scope !== getScope()) return;
    const rows = pinnedFolders.list.children;
    const previous = !removed && [...pinnedFolders.list.querySelectorAll('.workspace-shortcut-remove:not(.hidden)')]
      .find(control => control.dataset.shortcutKey === `${draft.key}:remove`);
    const nearest = rows[Math.min(draft.index, rows.length - 1)]?.querySelector('button:not(:disabled, .hidden)');
    const fallback = ['#organize-shortcuts-tab', '#sidebar-shortcuts-toggle']
      .map(selector => document.querySelector(selector))
      .find(control => control?.getClientRects().length) || searchFocusTarget();
    (previous || nearest || fallback).focus({preventScroll:true});
  }

  pinRemoval.cancel.addEventListener('click', () => closePinRemoval());
  pinRemoval.dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!pinRemoval.confirm.disabled) closePinRemoval();
  });
  pinRemoval.confirm.addEventListener('click', async () => {
    const draft = pendingRemoval;
    if (!draft || draft.scope !== getScope() || draft.contextKey !== teamContext()?.key || !editingPins) {
      closePinRemoval();
      return;
    }
    if (draft.entry.remote) {
      if (!pinEntries(loadNavigation(draft.scope).pins).some(item => item.key === draft.key)) {
        closePinRemoval();
        return;
      }
      pinRemoval.cancel.disabled = true;
      pinRemoval.confirm.disabled = true;
      pinRemoval.error.classList.add('hidden');
      const removed = await changeTeamPin(draft.entry.sourceLibrary, draft.entry.sourceFolder, false);
      if (pendingRemoval !== draft) return;
      if (removed) closePinRemoval(true);
      else {
        pinRemoval.cancel.disabled = false;
        pinRemoval.confirm.disabled = false;
        pinRemoval.error.textContent = '无法移除团队快捷项，请重试。';
        pinRemoval.error.classList.remove('hidden');
      }
      return;
    }
    const removed = change(draft.scope, saved => {
      const index = saved.pins.findIndex(item => pinKey(item.library, item.folder) === draft.key);
      const {library, folder, name} = draft.entry;
      if (index < 0 || saved.pins[index].library !== library || saved.pins[index].folder !== folder || saved.pins[index].name !== name) return false;
      saved.pins.splice(index, 1);
    });
    closePinRemoval(removed);
  });

  function relocateFolder(library, from, to) {
    change(getScope(), saved => {
      if (!saved.pins.length && !saved.searches.length) return false;
      const newPath = item => item.library === library && (item.folder === from || item.folder.startsWith(from + '/'))
        ? to + item.folder.slice(from.length) : item.folder;
      for (const item of saved.pins) item.folder = newPath(item);
      for (const item of saved.searches) item.query.folder = newPath(item.query);
    });
    if (teamContext()) refreshTeamQuickAccess();
  }

  function consolidateTeamFolders(scope, merged) {
    if (scope !== getScope() || !merged.size) return;
    change(scope, saved => {
      let changed = false;
      function rebase(item) {
        const target = rebaseMergedTeamFolder(merged, item.library, item.folder);
        if (!target) return;
        item.library = target.libraryId;
        item.folder = target.folder;
        changed = true;
      }
      const pins = new Map();
      for (const item of saved.pins) {
        rebase(item);
        const key = pinKey(item.library, item.folder);
        if (!pins.has(key)) pins.set(key, item);
      }
      for (const {query} of saved.searches) rebase(query);

      const mergedRoots = new Set(saved.mergedRoots);
      for (const library of merged.keys()) {
        if (mergedRoots.has(library)) continue;
        const target = rebaseMergedTeamFolder(merged, library, '');
        if (!target) continue;
        const {libraryId, folder} = target;
        const key = pinKey(libraryId, folder);
        if (!pins.has(key)) pins.set(key, {library:libraryId, folder, name:folder.split('/').at(-1)});
        mergedRoots.add(library);
        changed = true;
      }
      saved.pins = [...pins.values()];
      saved.mergedRoots = [...mergedRoots];
      return changed;
    });
  }

  function isPinned(library, folder) {
    const target = resolveFolder(library, folder);
    const context = syncTeamContext();
    return Boolean(target && pinEntries(loadNavigation(getScope()).pins, context).some(item =>
      (!context || item.remote) && item.library === library && resolveFolder(library, item.folder)?.path === target.path
    ));
  }

  function pinFolder(library, folder) {
    const target = resolveFolder(library, folder);
    if (!target) return;
    if (teamContext()) {
      if (isPinned(library, target.path)) onNotify('此文件夹已在团队快速访问中');
      else changeTeamPin(library, target.path, true);
      return;
    }
    if (change(getScope(), saved => {
      if (saved.pins.some(item => item.library === library && resolveFolder(library, item.folder)?.path === target.path)) {
        onNotify('此文件夹已在快速访问中');
        return false;
      }
      saved.pins.push({library, folder:target.path, name:target.name});
    })) onNotify(`已将 ${target.name} 添加到快速访问`);
  }

  function togglePin(library, folder) {
    const target = resolveFolder(library, folder);
    if (!target) return;
    if (teamContext()) {
      const match = pinEntries(loadNavigation(getScope()).pins).find(item =>
        item.remote && item.library === library && item.folder === target.path);
      if (!match) changeTeamPin(library, target.path, true);
      else if (!editingPins) onNotify('请先解锁快速访问，再移除团队快捷项');
      else requestPinRemoval(match.key, target.name);
      return;
    }
    change(getScope(), saved => {
      const existing = saved.pins.findIndex(item =>
        item.library === library && resolveFolder(library, item.folder)?.path === target.path
      );
      if (existing >= 0) saved.pins.splice(existing, 1);
      else saved.pins.push({library, folder:target.path, name:target.name});
    });
  }

  function render() {
    const scope = getScope();
    const context = syncTeamContext();
    if (context && shared.status === 'idle') refreshTeamQuickAccess();
    if (pinScope !== scope) {
      pinScope = scope;
      editingPins = false;
      if (pinRemoval.dialog.open) closePinRemoval();
    }
    if (pendingRemoval && pendingRemoval.contextKey !== context?.key) closePinRemoval();
    if (pending && pending.scope !== scope) {
      pending = null;
      dialog.dialog.close();
    }
    const state = getState();
    const current = state.view !== 'jobs' ? queryKey(captureQuery(state)) : null;
    const saved = loadNavigation(scope);
    const folder = currentFolder();
    const folderKey = folder ? pinKey(state.library, folder.path) : null;
    folderActions.classList.toggle('hidden', !folder);
    refresh?.classList.toggle('hidden', !folder || !views.includes(state.view));

    const searches = saved.searches.map(item => {
      const query = resolveQuery(item.query);
      return {
        key: item.name, name: item.name, icon: 'search', removeLabel: '删除已保存搜索',
        title: query ? item.name : `${item.name} · ${invalidLocation}`,
        active: Boolean(query) && queryKey(query) === current, unavailable: !query,
      };
    });
    const entries = pinEntries(saved.pins, context);
    const saving = Boolean(context && sharedWrite?.key === context.key);
    const canModifyShared = Boolean(context && shared.status === 'ready' && !saving);
    const hasRemovablePins = entries.some(item => !item.remote || canModifyShared);
    if (!entries.length) editingPins = false;
    editPins.disabled = !hasRemovablePins;
    editIcon.setAttribute('href', editingPins ? '#i-edit' : '#i-lock');
    const editLabel = editingPins ? '完成编辑快速访问' : '编辑快速访问';
    editPins.title = editLabel;
    editPins.setAttribute('aria-label', editLabel);
    editPins.setAttribute('aria-pressed', String(editingPins));
    pinnedFolders.label.textContent = context ? '团队快速访问' : '快速访问';
    const status = !context ? '' : shared.status === 'unsupported' ? '团队服务暂不支持共享快速访问'
      : shared.status === 'offline' ? '无法同步团队快速访问'
      : shared.status === 'loading' ? '正在同步团队快速访问…' : '';
    teamPinsNotice.textContent = status;
    teamPinsNotice.classList.toggle('hidden', !status);
    pinnedFolders.empty.textContent = context ? '将文件夹拖到此处，供团队快速访问' : '将文件夹拖到此处';
    const pins = entries.map(item => {
      const target = resolveFolder(item.library, item.folder);
      return {
        key: item.key, name: target?.name || item.name || item.folder.split('/').at(-1) || '资产库',
        library:item.library, folder:target?.path ?? item.folder,
        icon: 'folder', removeLabel: item.remote ? '移除团队快速访问' : '移除快速访问', showRemove: editingPins,
        removeDisabled:item.remote && !canModifyShared,
        localOnly:item.localOnly, canPublish:item.localOnly && Boolean(target) && canModifyShared,
        title: target?.trail || `${item.name || item.folder} · 文件夹目前不可用`,
        active: Boolean(target) && pinKey(item.library, target.path) === folderKey, unavailable: !target,
      };
    });
    const pinned = pins.some(item => item.active && (!context || !item.localOnly));
    pin.setAttribute('aria-pressed', String(pinned));
    const pinLabel = context ? (pinned ? '从团队快速访问中移除' : '固定到团队快速访问')
      : (pinned ? '取消固定当前文件夹' : '固定当前文件夹');
    pin.title = pinLabel;
    pin.setAttribute('aria-label', pinLabel);
    renderShortcuts(savedSearches, searches, applySearch, removeSearch, views.includes(state.view) ? resultsToggle : searchFocusTarget());
    renderShortcuts(pinnedFolders, pins, openPin, requestPinRemoval, folder ? pin : searchFocusTarget(), onLocatePinnedFolder, pinFolder);
  }

  editPins.addEventListener('click', () => {
    editingPins = !editingPins;
    render();
  });

  saveSearch.addEventListener('click', () => {
    const state = getState();
    const query = captureQuery(state, searchInput.value);
    pending = {scope: getScope(), query};
    dialog.name.value = (query.searchText.trim() || query.fileNameQuery.trim() || query.tag || title.textContent).slice(0, 80);
    dialog.error.classList.add('hidden');
    dialog.dialog.showModal();
    dialog.name.select();
  });
  dialog.dialog.addEventListener('close', () => {
    pending = null;
    if (resultsToggle.getClientRects().length) resultsToggle.focus({preventScroll:true});
  });
  dialog.name.addEventListener('input', () => dialog.error.classList.add('hidden'));
  dialog.form.addEventListener('submit', event => {
    event.preventDefault();
    if (!pending || pending.scope !== getScope()) return;
    const name = dialog.name.value.trim();
    const {scope, query} = pending;
    const exists = loadNavigation(scope).searches.some(item => item.name.toLowerCase() === name.toLowerCase());
    if (!name || exists) {
      dialog.error.textContent = exists ? '这个名称已被使用' : '请输入搜索名称';
      dialog.error.classList.remove('hidden');
      dialog.name.focus();
      return;
    }
    if (change(scope, saved => saved.searches.push({name, query}))) dialog.dialog.close();
  });
  pin.addEventListener('click', () => {
    const {library, folder} = getState();
    if (library) togglePin(library, folder);
  });
  refresh?.addEventListener('click', async () => {
    if (refreshing || !currentFolder() || !views.includes(getState().view)) return;
    const scope = getScope();
    refreshing = true;
    refresh.setAttribute('aria-disabled', 'true');
    refresh.title = '正在刷新当前目录';
    try {
      await onRefreshAssets();
    } catch (error) {
      if (scope === getScope()) onNotify(`刷新失败。${error?.message || error}`, true);
    } finally {
      refreshing = false;
      refresh.removeAttribute('aria-disabled');
      refresh.title = refresh.getAttribute('aria-label');
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === storagePrefix + getScope()) render();
  });

  initFolderPinDrag({
    tree: document.querySelector('#libraries'),
    zone: pinnedFolders.section,
    scroll: document.querySelector('#sidebar-organize-content'),
    getScope,
    pinFolder,
    canMoveFolder,
    moveFolder,
  });
  render();
  return {render, isPinned, togglePin, relocateFolder, consolidateTeamFolders, refreshTeamQuickAccess};
}
