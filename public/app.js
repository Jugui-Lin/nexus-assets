import {MeshPreview} from './preview.js';
import {applyTeamFolderVisibility, buildFolderTree, createFolderMatcher, filterFolderTree, findFolder, folderAncestors, mergedTeamFolderMap, rebaseMergedTeamFolder, relativeAssetPath, restoreLinkedTeamFolders} from './folders.js';
import {initWorkspaceDrag} from './workspace-drag.js';
import {initWorkspaceLayout} from './workspace-layout.js';
import {initSidebarZones} from './sidebar-zones.js';
import {initWorkspaceNavigation} from './workspace-navigation.js';
import {initAssetCompare} from './asset-compare.js';
import {initAssetRecycle} from './asset-recycle.js';
import {initSmartMapKeywords, storedMapKeywords} from './c4d-map-keywords.js';
import {initC4dImportPreferences} from './c4d-import-preferences.js';
import {initC4dDropImport, isC4dSceneAsset} from './c4d-drop-import.js';
import {buildTagTree, matchesTag, suggestAssetTags} from './asset-tags.js';
import {initAssetAI} from './asset-ai.js';
import {initWorkspacePicker, workspaceOpeningView} from './workspace-picker.js';
import {initFolderBrowser} from './folder-browser.js';
import {initFolderAddress} from './folder-address.js';
import {initFolderContext} from './folder-context.js';
import {initFolderAppearance} from './folder-appearance.js';
import {initDccConnections} from './dcc-connections.js';
import {initCloudMounts} from './cloud-mounts.js';
import {initBaiduCloud} from './baidu-cloud.js';
import {initScreenshotCover} from './screenshot-cover.js';
import {assetKindLabels as kinds, initQuickFilters, isRecentlyAdded, summarizeQuickFilters} from './quick-filters.js';
import {initAssetTypePreferences} from './asset-type-preferences.js';
import {initAssetFilterToolbar} from './asset-filter-toolbar.js';
import {initRuntimeLog} from './runtime-log.js';
import {initVideoHoverPreview} from './video-hover-preview.js';
import {initVideoControls} from './video-controls.js';
import {initVideoCardDurations} from './video-card-durations.js';
import {initTeamAssetMessages} from './team-asset-messages.js';
import {initTeamOrganization} from './team-organization.js';
import {initCreativeSubscriptions} from './creative-subscriptions.js';
import {initBrowserSites} from './browser-sites.js';
import {initWhiteboardProjects} from './whiteboard-projects.js';
import {encodeWhiteboardAssetClipboard} from './whiteboard-asset-clipboard.js';
import {initNexusUpdater} from './nexus-updater.js';
import {initBrowserCapture} from './browser-capture.js';
import {initWorkspaceTabs} from './workspace-tabs.js';
import {initQuickImagePreview} from './quick-image-preview.js';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const native=Boolean(window.__TAURI__?.core),invoke=window.__TAURI__?.core.invoke;
const nativeDragOut = native && /Windows/i.test(navigator.userAgent);
const runtimeLog = initRuntimeLog({copy:copyWorkspaceText});
document.addEventListener('nexus-appearance-change', event => runtimeLog.add(`切换界面主题 · ${event.detail}`));
const api=async(command,args={})=>{
  try {
    runtimeLog.start(command, args);
    let data;
    if (native) data = await invoke(command, args);
    else {
      const response = await fetch('/api/' + command, {method:'POST', headers:{'Content-Type':'application/json', 'X-Nexus-Token':$('meta[name="nexus-token"]')?.content || ''}, body:JSON.stringify(args)});
      data = await response.json();
      if (!response.ok) throw Error(data.error || '操作失败');
    }
    runtimeLog.operation(command, args, data);
    return data;
  } catch (failure) {
    runtimeLog.operation(command, args, null, failure);
    throw failure;
  }
};
const gridZoomKey = 'nexus-grid-zoom-width';
const gridZoomLimits = {min: 88, max: 560};
const savedGridZoom = Number(localStorage.getItem(gridZoomKey));
const storedDensity = localStorage.getItem('nexus-grid-density');
const state = {
  assets: [], libraries: [], sessions: [], jobs: [], collections: [], hiddenFolders: [], definedTags: [],
  view: workspaceOpeningView(), library: null, folder: '', collection: null, recursive: true,
  kind: 'all', tag: null, search: '', sort: 'added', selected: null,
  formatIncludes: [], formatExcludes: [], tagIncludes: [], tagExcludes: [],
  rating: 0, workflow: '', quickFilters: [], fileNameQuery: '',
  assetWindowAnchor: null,
  limit: 60, list: localStorage.getItem('nexus-list-mode') === 'true',
  density: ['compact', 'normal', 'large'].includes(storedDensity) ? storedDensity : 'normal',
  gridZoom: savedGridZoom >= gridZoomLimits.min && savedGridZoom <= gridZoomLimits.max ? savedGridZoom : 0,
};
const expandedFolders = new Set();
const workspaceHomeButton = $('#open-workspace-home');
const workspaceHome = $('#workspace-home');
const assetSearchInput = $('#search');
const assetSearchToggle = $('#asset-search-toggle');
const assetSearchField = $('#asset-search-field');

function syncAssetSearchToggle() {
  const expanded = assetSearchToggle.getAttribute('aria-expanded') === 'true';
  const label = expanded ? '收起搜索' : state.search ? '搜索资产（已筛选）' : '搜索资产';
  const query = assetSearchInput.value.trim().slice(0, 100);
  assetSearchToggle.classList.toggle('has-query', Boolean(state.search));
  assetSearchToggle.setAttribute('aria-label', label);
  assetSearchToggle.title = expanded ? label : label + ' (/)' + (query ? ` · 「${query}」` : '');
}

function setAssetSearchExpanded(expanded) {
  assetSearchToggle.setAttribute('aria-expanded', String(expanded));
  assetSearchField.hidden = !expanded;
  syncAssetSearchToggle();
}

function focusAssetSearch({select = false} = {}) {
  setAssetSearchExpanded(true);
  assetSearchInput.focus();
  if (select) assetSearchInput.select();
}

assetSearchToggle.addEventListener('click', () => {
  if (assetSearchField.hidden) focusAssetSearch();
  else setAssetSearchExpanded(false);
});
assetSearchToggle.parentElement.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || assetSearchField.hidden) return;
  event.preventDefault();
  event.stopPropagation();
  setAssetSearchExpanded(false);
  assetSearchToggle.focus();
});

const markedAssets = new Set();
const fileStates = new Map();
const customCovers = new Set();
const coverRevisions = new Map();
const openTagGroups = new Map();
const assetNameOrder = new Intl.Collator('zh-CN', {numeric:true});
let assetsById = new Map();
let assetsByLibrary = new Map();
const preparedVideoSources = new WeakMap();

function prepareVideoSource(asset) {
  const now = performance.now();
  const prepared = preparedVideoSources.get(asset);
  if (prepared && prepared.path === asset.path && now - prepared.started < 15_000) return prepared.result;
  const result = api('asset_video_source', {id:asset.id}).catch(failure => {
    if (preparedVideoSources.get(asset)?.result === result) preparedVideoSources.delete(asset);
    throw failure;
  });
  preparedVideoSources.set(asset, {path:asset.path, started:now, result});
  return result;
}

const videoHover = native ? initVideoHoverPreview({
  grid: $('#asset-grid'),
  canPreview(id) {
    const asset = assetsById.get(id);
    return Boolean(state.library) && asset?.kind === 'video' && !fileStates.has(id) && (!isTeamAsset(asset) || asset.teamMounted);
  },
  async source(id) {
    const {path} = await prepareVideoSource(assetsById.get(id));
    return window.__TAURI__.core.convertFileSrc(path);
  },
  isBlocked: () => Boolean($('dialog[open], .asset-menu:not(.hidden), #files-drop-overlay:not(.hidden), .dragging-assets, .marquee-selecting')),
}) : null;
const videoCardDurations = native ? initVideoCardDurations({
  grid: $('#asset-grid'),
  scope: collectionScope,
  lookup(id) {
    const asset = assetsById.get(id);
    if (asset?.kind === 'video' && !fileStates.has(id) && (!isTeamAsset(asset) || asset.teamMounted)) return asset;
  },
  measure: loadVideoCardDuration,
}) : null;
let navSummary = null;
let displayedLibraryTree = null;
let displayedSubfolder = null;
let displayedAssetRows = [];
let assetModeHighlight;
let assetModeHighlightTimer;
let folderTrees = new Map();
let markedAnchor = null;
const team = { active: false, configured: false, info: null, revision: null, pending: null, epoch: 0,
  fromLocalIndex: false,
  catalog: null, allLibraries: [], removedFolders: [], sharedHiddenFolders: [], linkedFolders: [], folderVisibility: false,
  online: [], presencePending: null, presenceUnsupported: false, covers: new Map(), coversPending: null };
let personalWorkspace = {id:'personal', name:'个人工作空间'};
function libraryScope() {
  return team.active ? `team:${team.info.team.id}` : `personal:${personalWorkspace.id}`;
}
function libraryPreferenceKey(key) {
  const scope = libraryScope();
  return scope === 'personal:personal' ? key : `nexus-library-preference:${scope}:${key}`;
}
const libraryPreferences = {
  getItem: key => localStorage.getItem(libraryPreferenceKey(key)),
  setItem: (key, value) => localStorage.setItem(libraryPreferenceKey(key), value),
  removeItem: key => localStorage.removeItem(libraryPreferenceKey(key)),
};
const assetTypePreferences = initAssetTypePreferences({
  preferences:libraryPreferences,
  getAssets:() => state.assets,
  notify:toast,
  onChange() {
    renderAssets();
    renderInspector(false).catch(error);
  },
});
function displayAssetType(asset) {
  const kind = assetTypePreferences.effectiveKind(asset);
  return assetTypePreferences.label(kind, kinds[kind]);
}
const editor = { id: null, revision: null, dirty: false, saving: false };
const names={home:'主页',all:'全部资产',favorites:'我的收藏',recent:'最近入库',jobs:'导入任务',subscriptions:'创作订阅',sites:'站点导航',whiteboard:'白板'};
const viewLabel = view => team.active && view === 'favorites' ? '收藏' : names[view];
const isAssetView = () => ['all', 'favorites', 'recent'].includes(state.view);
const kindIcons = {video:'play', audio:'play', texture:'grid', scene:'folder', material:'stack', script:'notes', other:'notes'};
const workflowLabels = {wip:'制作中', review:'待审核', approved:'已审核', archived:'已归档'};
const dccs={blender:{name:'Blender',logo:'B',hint:'4.5+ · OBJ / FBX / BLEND / USD'},c4d:{name:'Cinema 4D',logo:'C4',hint:'2025+ · OBJ / FBX / C4D / Alembic'},maya:{name:'Maya',logo:'M',hint:'适配待验证 · OBJ / FBX / MA / MB'},max:{name:'3ds Max',logo:'3D',hint:'Windows · 适配待验证 · MAX / FBX / OBJ'},houdini:{name:'Houdini',logo:'H',hint:'适配待验证 · HIP / FBX / 几何文件'}};
const compat={blender:['obj','fbx','gltf','glb','abc','usd','usda','usdc','stl','ply','blend'],c4d:['obj','fbx','abc','stl','c4d'],maya:['obj','fbx','abc','ma','mb'],max:['obj','fbx','3ds','max'],houdini:['obj','fbx','abc','usd','usda','usdc','hip','hiplc','hipnc']};
const smartFormats = new Set([...compat.c4d, 'blend', 'max', 'zip', 'sbsar', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'exr', 'hdr', 'tga', 'bmp', 'ies', 'psd', 'dds', 'gif']);
const smartFields = {kind: '#smart-kind', renderer: '#smart-renderer', lod: '#smart-lod', texture_resolution: '#smart-resolution'};
const smartKey = 'nexus-smart-import-v1';

function canUseSmartImport(session, asset) {
  return session?.dcc === 'c4d' && session.smartImport === true && smartFormats.has(asset?.ext);
}

function usesC4dSceneDialog(session, asset) {
  return session?.dcc === 'c4d' && isC4dSceneAsset(asset) &&
    (canUseSmartImport(session, asset) || compat.c4d.includes(asset.ext));
}

function loadSmartSettings() {
  try { return JSON.parse(libraryPreferences.getItem(smartKey)) || {}; }
  catch { return {}; }
}

function smartOptions() {
  const saved = loadSmartSettings();
  const value = name => [...$(smartFields[name]).options].find(option => option.value === String(saved[name] ?? ''))?.value;
  const mapKeywords = storedMapKeywords(saved.map_keywords);
  return {kind: value('kind') || 'auto', renderer: value('renderer') || 'auto',
    lod: value('lod') ? Number(value('lod')) : null,
    texture_resolution: value('texture_resolution') ? Number(value('texture_resolution')) : null,
    ...(mapKeywords ? {map_keywords:mapKeywords} : {})};
}

function queueAsset(asset, session) {
  return api('queue_import', {assetId: asset.id, sessionId: session.id, workspace:libraryScope(),
    smartOptions: canUseSmartImport(session, asset) ? smartOptions() : null});
}

async function queueC4dProject(assetId, mode) {
  const scope = collectionScope();
  const asset = assetsById.get(assetId);
  const sessions = state.sessions.filter(session => session.dcc === 'c4d' && session.projectExport);
  const session = sessions.find(item => item.id === $('#target-session').value) || sessions[0];
  if (!session) throw Error('请在 DCC 连接中心更新 Cinema 4D 桥接，启动 Cinema 4D 后再转换');
  if (!asset || !['max', 'blend'].includes(asset.ext)) throw Error('源工程已不在当前资产库');
  const destination = await api('pick_folder', {purpose:'c4d-project'});
  if (!destination || scope !== collectionScope() || !assetsById.has(assetId)) return;
  const job = await api('queue_import', {assetId, sessionId:session.id, smartOptions:smartOptions(), workspace:libraryScope(),
    projectExport:{destination, mode}});
  if (scope !== collectionScope()) return;
  if (!state.jobs.some(item => item.id === job.id)) state.jobs.unshift(job);
  renderJobCount();
  if (state.view === 'jobs') renderJobs();
  toast('已加入转换队列，可在「导入任务」查看进度和输出目录');
}
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=(name,cls='')=>`<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const bytes=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':n<1073741824?(n/1048576).toFixed(1)+' MB':(n/1073741824).toFixed(2)+' GB';
const timestamp = v => typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || 0;
const date=v=>new Date(timestamp(v)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
let toastTimer,previewSerial=0;
const preview=new MeshPreview($('#preview-canvas'));
const quickRenderer=new MeshPreview($('#quick-preview-canvas'));
const thumbnailRenderer = new MeshPreview(document.createElement('canvas'), {width:320,height:234});
const thumbCache=new Map();
const thumbnailSizeKey = 'nexus-thumbnail-pixels';
let thumbnailSize = Number(localStorage.getItem(thumbnailSizeKey)) || 256;
if (!Number.isInteger(thumbnailSize) || thumbnailSize < 128 || thumbnailSize > 1024) thumbnailSize = 256;
function toast(message,error=false){const t=$('#toast');t.textContent=String(message);t.classList.remove('hidden');t.classList.toggle('error',error);clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.add('hidden'),error?6500:3500);}
function error(e){toast(e?.message||e,true);}
function openDialog(id){const d=$(id);if(!d.open)d.showModal();}
function confirmDiscardWorkspaceEdits(locateAsset = false, switchTab = false) {
  const dialog = $('#discard-workspace-dialog');
  $('#discard-workspace-description').textContent = locateAsset
    ? '定位另一项资产会丢弃当前资产的编辑草稿。'
    : switchTab ? '切换标签页会丢弃当前资产的编辑草稿。' : '切换工作空间会丢弃当前资产的编辑草稿。';
  $('#discard-workspace-confirm').textContent = locateAsset ? '放弃并定位' : '放弃并切换';
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), {once: true});
    dialog.showModal();
  });
}
function selected(){return assetsById.get(state.selected);}
function isTeamAsset(asset) { return Boolean(asset?.id.startsWith('team:')); }
function collectionScope() {
  if (team.active) return `team:${team.info.team.id}:${team.info.member.id}`;
  return personalWorkspace.id === 'personal' ? 'personal' : 'personal:' + personalWorkspace.id;
}
function currentCollection() {
  return state.collections.find(collection => collection.id === state.collection);
}
function currentLibrary() {
  return state.libraries.find(library => library.id === state.library);
}
function baseAssets() {
  const library = currentLibrary();
  const collection = currentCollection();
  const assets = library ? assetsByLibrary.get(library.id) || [] : state.assets;
  const inFolder = library && (state.folder || !state.recursive)
    ? createFolderMatcher(library, state.folder, state.recursive)
    : null;
  if (state.view !== 'favorites' && state.view !== 'recent' && !inFolder && !collection) return assets;
  const members = collection ? new Set(collection.assetIds) : null;
  const now = Date.now();
  return assets.filter(asset =>
    (state.view !== 'favorites' || asset.favorite) &&
    (state.view !== 'recent' || isRecentlyAdded(asset.added, now)) &&
    (!inFolder || inFolder(asset)) &&
    (!members || members.has(asset.id))
  );
}
function assetView(base, omit = null) {
  const terms = state.search.split(/\s+/).filter(Boolean);
  const filterFormat = omit !== 'format' && (state.formatIncludes.length || state.formatExcludes.length);
  const filterTags = omit !== 'tags' && (state.tag || state.tagIncludes.length || state.tagExcludes.length);
  const filterRating = omit !== 'rating' && state.rating;
  const filter = filterFormat || filterTags || filterRating || state.workflow || terms.length;
  const candidates = filter ? base.filter(asset => {
    if (filterFormat && ((state.formatIncludes.length && !state.formatIncludes.includes(asset.ext)) ||
        state.formatExcludes.includes(asset.ext))) return false;
    if (filterTags && (!matchesTag(asset.tags, state.tag) ||
        (state.tagIncludes.length && !state.tagIncludes.some(tag => matchesTag(asset.tags, tag))) ||
        state.tagExcludes.some(tag => matchesTag(asset.tags, tag)))) return false;
    if (filterRating && (asset.rating || 0) < state.rating) return false;
    if (state.workflow && (asset.workflow || 'unset') !== state.workflow) return false;
    if (!terms.length) return true;
    const fields = [asset.name, asset.subtitle, asset.path, asset.relativePath, asset.ext, asset.notes,
      workflowLabels[asset.workflow], ...asset.tags];
    const haystack = fields.join(' ').toLowerCase().replaceAll('\\', '/');
    return terms.every(term => haystack.includes(term));
  }) : base;
  const summary = summarizeQuickFilters(candidates, state, customCovers, Date.now(),
    assetTypePreferences.effectiveKind, assetTypePreferences.enabled);
  if (omit) return summary;
  const {rows} = summary;
  if (state.sort === 'name') rows.sort((a,b) => assetNameOrder.compare(a.name, b.name));
  else if (state.sort === 'size') rows.sort((a,b) => b.size - a.size);
  else if (state.sort === 'rating') rows.sort((a,b) => (b.rating || 0) - (a.rating || 0) || timestamp(b.added) - timestamp(a.added));
  else rows.sort((a,b) => timestamp(b[state.sort]) - timestamp(a[state.sort]));
  return summary;
}
function filtered(base = baseAssets()) {
  return assetView(base).rows;
}
function folderThumbnailRank(asset) {
  if (isTeamAsset(asset) && !asset.teamMounted) return 0;
  if (asset.thumbnail || customCovers.has(asset.id)) return 3;
  if (asset.kind === 'texture') return 2;
  return Number((native && (asset.kind === 'video' || asset.ext === 'c4d')) ||
    (meshCapable(asset) && asset.size <= 750_000));
}
function refreshFolderTrees() {
  assetsById = new Map();
  assetsByLibrary = new Map();
  navSummary = null;
  for (const asset of state.assets) {
    assetsById.set(asset.id, asset);
    if (!assetsByLibrary.has(asset.libraryId)) assetsByLibrary.set(asset.libraryId, []);
    assetsByLibrary.get(asset.libraryId).push(asset);
  }
  folderTrees = new Map(state.libraries.map(library => [library.id,
    buildFolderTree(assetsByLibrary.get(library.id) || [], library, folderThumbnailRank)]));
  const library = currentLibrary();
  if (!library) {
    state.library = null;
    state.folder = '';
  } else if (!findFolder(folderTrees.get(library.id), state.folder)) {
    while (state.folder && !findFolder(folderTrees.get(library.id), state.folder)) {
      state.folder = state.folder.split('/').slice(0, -1).join('/');
    }
  }
  for (const id of markedAssets) if (!assetsById.has(id)) markedAssets.delete(id);
}
async function refresh({render = true} = {}) {
  const {assets,libraries,sessions,jobs,coverIds=[],hiddenFolders=[],definedTags=[]} = await api('get_state');
  if (team.active) return;
  customCovers.clear();
  for (const id of coverIds) customCovers.add(id);
  Object.assign(state, {assets,libraries,sessions,jobs,hiddenFolders,definedTags});
  refreshFolderTrees();
  if (!render) return;
  $('#engine-label').textContent = native ? 'RUST CORE' : 'DEV PREVIEW';
  renderNav();
  renderAssets();
  renderConnections();
  c4dDropImport.renderActivity(jobs);
  if (selected()) renderInspector(false);
  $('#footer-status').textContent = native ? '本地索引已就绪' : '界面开发预览';
}
function folderKey(library, path) { return JSON.stringify([library, path]); }
const folderEditToggle = $('#toggle-folder-edit');
let folderEditScope = null;
const canEditFolderStructure = () => native && folderEditScope === collectionScope();

function updateFolderEditToggle() {
  if (folderEditScope !== collectionScope()) folderEditScope = null;
  const editing = canEditFolderStructure();
  folderEditToggle.disabled = !native;
  folderEditToggle.setAttribute('aria-pressed', String(editing));
  folderEditToggle.title = editing ? '关闭文件夹编辑' : '开启文件夹编辑';
  folderEditToggle.querySelector('use').setAttribute('href', editing ? '#i-edit' : '#i-lock');
}

folderEditToggle.addEventListener('click', () => {
  folderEditScope = canEditFolderStructure() ? null : collectionScope();
  updateFolderEditToggle();
  toast(canEditFolderStructure() ? '已开启文件夹编辑' : '已关闭文件夹编辑');
});

function treeRow(library, node, searching = false) {
  const expanded = searching || expandedFolders.has(folderKey(library.id, node.path));
  const active = state.library === library.id && state.folder === node.path && !state.collection;
  const toggle = node.children.length && !searching
    ? `<button class="folder-toggle" data-toggle-library="${escape(library.id)}" data-folder="${escape(node.path)}" aria-expanded="${expanded}" aria-label="${expanded ? '折叠' : '展开'} ${escape(node.name)}">${icon('chevron')}</button>`
    : '<span class="folder-gap" aria-hidden="true"></span>';
  return `<div class="folder-row">${toggle}<button class="nav-item ${active ? 'active' : ''}" data-library="${escape(library.id)}" data-folder="${escape(node.path)}" title="${escape(node.path || library.path || library.name)}">${folderAppearance.icon(library.id, node.path)}<span class="folder-label">${escape(node.name)}</span><span class="nav-count">${node.count}</span></button></div>
    ${expanded && node.children.length ? `<div class="folder-children">${node.children.map(child => treeRow(library, child, searching)).join('')}</div>` : ''}`;
}
function renderLibraryTree() {
  const query = $('#folder-search').value.trim();
  const key = JSON.stringify([query, state.library, state.folder, state.collection, [...expandedFolders]]);
  if (displayedLibraryTree?.data === folderTrees && displayedLibraryTree.key === key &&
      displayedLibraryTree.team === team.active) return;
  displayedLibraryTree = {data:folderTrees, key, team:team.active};
  $('#add-library-small').classList.toggle('hidden', team.active);
  const rows = [];
  for (const library of state.libraries) {
    const tree = filterFolderTree(folderTrees.get(library.id), query);
    if (tree) rows.push(treeRow(library, tree, Boolean(query)));
  }
  $('#libraries').innerHTML = rows.join('') || (query ? '<p class="folder-search-empty">没有匹配的文件夹</p>' : '');
}
function getNavSummary() {
  if (navSummary) return navSummary;
  let favorites = 0;
  const tagsByName = new Map(state.definedTags.map(tag => [tag.toLowerCase(), tag]));
  for (const asset of state.assets) {
    if (asset.favorite) favorites++;
    for (const tag of asset.tags) if (!tagsByName.has(tag.toLowerCase())) tagsByName.set(tag.toLowerCase(), tag);
  }
  navSummary = {favorites, tags:[...tagsByName.values()]};
  return navSummary;
}
function renderJobCount() {
  $('#job-count').textContent=state.jobs.filter(j=>['queued','running'].includes(j.status)).length||'';
}
function renderNav(){
  syncAssetSearchToggle();
  $('#all-count').textContent=state.assets.length;$('#fav-count').textContent=getNavSummary().favorites;
  const home = state.view === 'home';
  workspaceHomeButton.classList.toggle('active', home);
  if (home) workspaceHomeButton.setAttribute('aria-current', 'page');
  else workspaceHomeButton.removeAttribute('aria-current');
  renderJobCount();
  folderContext.render();
  $$(':is(#main-nav, #workspace-tools-nav) .nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view&&!state.library&&!state.collection));
  renderLibraryTree();
  $('#collections').innerHTML = state.collections.map(collection =>
    `<button class="nav-item ${state.collection === collection.id ? 'active' : ''}" data-collection="${escape(collection.id)}" title="${escape(collection.name)}">${icon('stack')}<span class="folder-label">${escape(collection.name)}</span><span class="nav-count">${collection.assetIds.filter(id => assetsById.has(id)).length}</span></button>`
  ).join('');
  renderTags();
}

function renderTags() {
  $('#new-tag').classList.toggle('hidden', !native);
  const parent = $('#sidebar-tags');
  const scope = collectionScope();
  if (!openTagGroups.has(scope)) openTagGroups.set(scope, new Set());
  const expanded = openTagGroups.get(scope);
  const search = $('#tag-search').value.trim();
  const tags = getNavSummary().tags;
  const tree = buildTagTree([{tags}], search);
  function renderBranches(branches) {
    return [...branches.values()].sort((a,b) => assetNameOrder.compare(a.name, b.name)).map(branch => {
      const tag = branch.tag
        ? '<button type="button" class="tag-filter' + (state.tag === branch.tag ? ' active' : '') + '" data-tag="' +
            escape(branch.tag) + '" title="' + escape(branch.tag) + '">' + escape(branch.name) + '</button>'
        : '';
      if (!branch.children.size) return tag;
      const path = branch.prefix + '/';
      const open = search || expanded.has(path) || state.tag?.startsWith(path);
      return '<details data-tag-group="' + escape(path) + '"' + (open ? ' open' : '') +
        '><summary>' + escape(branch.name) + '</summary><div class="tag-children">' +
        '<button type="button" data-tag-prefix="' + escape(path) + '" class="tag-filter' +
        (state.tag === path ? ' active' : '') + '">全部子标签</button>' + tag +
        renderBranches(branch.children) + '</div></details>';
    }).join('');
  }
  const markup = renderBranches(tree.children);
  if (parent.dataset.tagMarkup !== markup) {
    parent.dataset.tagMarkup = markup;
    parent.innerHTML = markup;
  }
  const suggestions = native ? suggestAssetTags(tags, search) : [];
  const groups = $('#tag-suggestion-groups');
  const suggestionMarkup = suggestions.map(([name, options]) =>
    '<div class="tag-suggestion-group"><p>' + escape(name) + '</p><div class="tag-suggestion-options">' +
    options.map(tag => '<button class="tag-filter" type="button" data-tag-suggestion="' + escape(tag) +
      '" title="添加标签 ' + escape(tag) + '">' + icon('plus') + escape(tag) + '</button>').join('') +
    '</div></div>'
  ).join('');
  if (groups.dataset.tagMarkup !== suggestionMarkup) {
    groups.dataset.tagMarkup = suggestionMarkup;
    groups.innerHTML = suggestionMarkup;
  }
  $('#tag-suggestions').hidden = !suggestions.length;
  $('#tag-search').classList.toggle('hidden', !tree.children.size && !search && !suggestions.length);
}
function renderLocation() {
  const lib = currentLibrary();
  const collection = currentCollection();
  const folders = folderAncestors(state.folder);
  const place = folders.at(-1)?.name || lib?.name || collection?.name || viewLabel(state.view);
  const root = team.active ? team.info.team.name : personalWorkspace.name;
  const parts = [`<button type="button" data-crumb-home title="返回主页">${escape(root)}</button>`];
  if (lib && folders.length) {
    parts.push(`<button type="button" data-crumb-folder="">${escape(lib.name)}</button>`);
    for (const folder of folders.slice(0, -1)) {
      parts.push(`<button type="button" data-crumb-folder="${escape(folder.path)}">${escape(folder.name)}</button>`);
    }
  }
  if (collection) parts.push('<span>合集</span>');
  parts.push(`<span aria-current="location">${escape(place)}</span>`);
  $('#breadcrumbs').innerHTML = parts.join(icon('chevron'));
  $('#page-title').textContent = place;
  workbenchTabs.render(place);
  const description = lib
    ? (lib.path ? '' : '尚未链接源文件夹')
    : collection ? team.active ? '团队共享合集' : '此合集保存在当前个人库'
    : state.view === 'recent' ? '过去 7 天新加入的资产'
    : '';
  const note = $('#page-description');
  note.textContent = description;
  note.title = description;
  $('#folder-options').classList.toggle('hidden', !lib);
  $('#edit-collection').classList.toggle('hidden', !collection);
  folderAddress.render();
}
function renderSubfolders() {
  const folder = state.library && !state.collection && isAssetView()
    ? findFolder(folderTrees.get(state.library), state.folder) : null;
  const grid = $('#subfolder-grid');
  const hasChildren = Boolean(folder?.children.length);
  $('#subfolder-section').classList.toggle('hidden', !hasChildren);
  $('#folder-assets-heading').classList.toggle('hidden', !hasChildren);
  grid.toggleAttribute('data-list', state.list);
  if (folder === displayedSubfolder) return;
  displayedSubfolder = folder;
  grid.innerHTML = (folder?.children || []).map(child => {
    const label = escape(child.name);
    const glyph = folderAppearance.icon(state.library, child.path);
    const previews = child.previews?.map(preview => preview.id);
    const image = previews?.length
      ? `<img data-thumb="${escape(previews[0])}" data-thumb-candidates="${escape(JSON.stringify(previews))}" class="hidden" alt="" draggable="false">`
      : '';
    return `<button class="subfolder-card" type="button" data-library="${escape(state.library)}" data-subfolder="${escape(child.path)}" title="${label}">
      <span class="subfolder-cover"><span class="subfolder-placeholder">${glyph}</span>${image}<span class="subfolder-cover-badge">${glyph}</span></span>
      <span class="subfolder-caption"><strong><span>${label}</span></strong><small>${child.count.toLocaleString('zh-CN')} 项资产</small></span>
    </button>`;
  }).join('');
}
let subfolderTitleScroll;
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
$('#subfolder-grid').addEventListener('pointerover', event => {
  const name = event.target.closest('.subfolder-caption strong');
  if (!name || (event.relatedTarget instanceof Node && name.contains(event.relatedTarget)) ||
      event.pointerType === 'touch' || motionPreference.matches) return;
  const distance = name.scrollWidth - name.clientWidth;
  if (distance <= 1) return;
  name.classList.add('scrolling-title');
  subfolderTitleScroll = name.firstElementChild.animate(
    [{transform:'translateX(0)'}, {transform:`translateX(-${distance}px)`}],
    {delay:350, duration: Math.max(650, distance * 26), fill:'forwards'},
  );
});
$('#subfolder-grid').addEventListener('pointerout', event => {
  const name = event.target.closest('.subfolder-caption strong.scrolling-title');
  if (!name || (event.relatedTarget instanceof Node && name.contains(event.relatedTarget))) return;
  subfolderTitleScroll?.cancel();
  name.classList.remove('scrolling-title');
});
$('#subfolder-grid').addEventListener('click', event => {
  const card = event.target.closest('[data-subfolder]');
  if (!card || !state.library) return;
  openFolder(state.library, card.dataset.subfolder);
  if (event.detail === 0) $('#page-title').focus({preventScroll:true});
});
function renderAssets(){
  videoHover?.stop();
  assetTypePreferences.reload(libraryScope());
  if (!assetTypePreferences.categoryEnabled(state.kind)) state.kind = 'all';
  const home = state.view === 'home';
  const jobs = state.view === 'jobs';
  const subscriptions = state.view === 'subscriptions';
  const sites = state.view === 'sites';
  const board = state.view === 'whiteboard';
  $('#jobs-view').classList.toggle('hidden', !jobs);
  $('#app').classList.toggle('workspace-home-active', home);
  workspaceHome.classList.toggle('hidden', !home);
  if (home) $('#home-asset-count').textContent = state.assets.length.toLocaleString('zh-CN') + ' 项资产';
  $('#app').classList.toggle('workspace-subscriptions', subscriptions);
  $('#app').classList.toggle('workspace-sites-active', sites);
  $('#site-navigation').classList.toggle('hidden', !sites);
  $('#app').classList.toggle('workspace-whiteboard-active', board);
  $('#workspace-whiteboard').classList.toggle('hidden', !board);
  creativeSubscriptions.setVisible(subscriptions);
  siteNavigation.setScope(libraryScope());
  whiteboard.setContext({key:collectionScope(), teamId:team.active ? team.info.team.id : null, visible:board});
  for (const selector of ['.library-toolbar','.asset-quick-filters','.filter-bar','.results-line','#asset-grid']) {
    $(selector).classList.toggle('hidden', !isAssetView());
  }
  renderLocation();
  renderSubfolders();
  workspaceNavigation?.render();
  if (!isAssetView()) {
    videoCardDurations?.refresh();
    assetFilterToolbar.close();
    displayedAssetRows = [];
    if (jobs) renderJobs();
    for (const selector of ['#empty-state','#load-more','#show-earlier-assets','#bulk-bar']) $(selector).classList.add('hidden');
    return [];
  }
  const base = baseAssets();
  const view = assetView(base);
  quickFilters.render(view);
  assetFilterToolbar.render();
  const {rows} = view;
  displayedAssetRows = rows;
  $('#result-count').textContent=rows.length;$('#active-filter').innerHTML=state.tag?`<button class="active-filter-chip">${escape(state.tag)} ×</button>`:'';
  $('#check-files').classList.toggle('hidden', !native || !rows.length);
  const grid=$('#asset-grid');grid.classList.toggle('list-mode',state.list);$('#grid-view').classList.toggle('active',!state.list);$('#list-view').classList.toggle('active',state.list);
  if (state.list) grid.setAttribute('role', 'table');
  else grid.removeAttribute('role');
  $('#grid-view').setAttribute('aria-pressed', String(!state.list));
  $('#list-view').setAttribute('aria-pressed', String(state.list));
  renderGridSize();
  $('#select-visible').disabled = !rows.length;
  const anchorIndex = state.assetWindowAnchor ? rows.findIndex(asset => asset.id === state.assetWindowAnchor) : -1;
  const offset = anchorIndex >= 60 ? Math.floor(anchorIndex / 60) * 60 : 0;
  const visible = rows.slice(offset, offset + state.limit);
  const libraries = state.list ? new Map(state.libraries.map(library => [library.id, library])) : null;
  const focusedCard = document.activeElement?.matches('#asset-grid .asset-card') ? document.activeElement.dataset.id : null;
  grid.innerHTML = (state.list && visible.length ? assetListHeadings : '') +
    visible.map(asset => renderAssetCard(asset, libraries?.get(asset.libraryId))).join('');
  videoCardDurations?.refresh();
  if (focusedCard) grid.querySelector(`.asset-card[data-id="${CSS.escape(focusedCard)}"]`)?.focus({preventScroll:true});
  const emptyCollection = currentCollection() && !base.length;
  const emptyFolder = currentLibrary() && !base.length;
  const emptyFavorites = state.view === 'favorites' && !base.length;
  const emptyTeam = team.active && state.view === 'all' && !emptyCollection && !base.length;
  const showRemoved = emptyTeam && !state.libraries.length && folderContext.hasRemoved();
  $('#empty-heading').textContent = emptyCollection ? '合集里还没有可用资产'
    : emptyFolder ? (state.recursive ? '此文件夹暂无资产' : '此文件夹暂无直接存放的资产')
    : emptyFavorites ? '还没有收藏的资产'
    : showRemoved ? '团队库的文件夹已移除' : emptyTeam ? '团队库暂无资产' : '还没有匹配的资产';
  const description = emptyCollection ? '从资产列表把卡片拖到左侧的合集名称。'
    : emptyFavorites ? '在资产卡片上点击星标即可收藏。'
    : emptyTeam ? (!showRemoved && team.allLibraries.some(library => library.watching)
      ? 'NAS 共享目录里的素材会自动同步。' : '') : emptyFolder ? '' : '可以更改搜索词或筛选条件。';
  $('#empty-description').textContent = description;
  $('#empty-description').classList.toggle('hidden', !description);
  $('#clear-filters').classList.toggle('hidden', Boolean(emptyCollection || emptyFolder || emptyFavorites || emptyTeam));
  $('#view-removed-folders').classList.toggle('hidden', !showRemoved);
  $('#show-earlier-assets').classList.toggle('hidden', offset === 0);
  $('#empty-state').classList.toggle('hidden',rows.length!==0);$('#load-more').classList.toggle('hidden',rows.length<=offset+state.limit);loadVisibleThumbs();
  renderBulkBar();
  return rows;
}
const assetListHeadings = `<div class="asset-list-header" role="row">
  <span class="asset-list-preview-heading" role="columnheader">预览</span>
  <div class="asset-list-columns" role="presentation">
    <span role="columnheader">名称</span><span role="columnheader">格式 / 类型</span><span role="columnheader">大小</span>
    <span role="columnheader" class="list-cell-modified">修改日期</span><span role="columnheader" class="list-cell-folder">文件夹</span>
    <span role="columnheader" class="list-cell-tags">标签</span><span role="columnheader" class="list-cell-added">入库日期</span>
    <span role="columnheader" class="list-cell-status">状态 / 评分</span><span role="columnheader" class="list-cell-notes">备注</span>
  </div>
</div>`;
const listDate = new Intl.DateTimeFormat('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit'});
const listDateDetails = new Intl.DateTimeFormat('zh-CN', {
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});

function listCell(key, markup, title) {
  const tooltip = title ? ` title="${escape(title)}"` : '';
  return `<span class="list-cell-${key}" role="cell"${tooltip}>${markup || '—'}</span>`;
}

function listDateCell(key, value) {
  const time = new Date(timestamp(value));
  if (!Number.isFinite(+time) || +time <= 0) return listCell(key, '');
  return listCell(key, `<time datetime="${time.toISOString()}">${listDate.format(time)}</time>`, listDateDetails.format(time));
}

function renderAssetListDetails(asset, library) {
  const format = [asset.ext.toUpperCase(), displayAssetType(asset)].filter(Boolean).join(' · ');
  const path = asset.path || '';
  const absoluteParent = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const relative = relativeAssetPath(asset, library);
  const relativeParent = relative?.split('/').slice(0, -1).join('/') || '';
  const folder = relativeParent || library?.name || absoluteParent;
  const tags = asset.tags.join(' · ');
  const status = workflowLabels[asset.workflow];
  const rating = asset.rating > 0 ? '★ ' + asset.rating : '';
  const notes = asset.notes?.trim() || '';
  return listCell('format', escape(format), format) +
    listCell('size', Number.isFinite(asset.size) && asset.size >= 0 ? bytes(asset.size) : '') +
    listDateCell('modified', asset.modified) +
    listCell('folder', escape(folder), absoluteParent || [library?.name, relativeParent].filter(Boolean).join(' / ')) +
    listCell('tags', escape(tags), tags) +
    listDateCell('added', asset.added) +
    listCell('status',
      (status ? `<span class="workflow-pill" data-status="${escape(asset.workflow)}">${escape(status)}</span>` : '') +
      (rating ? `<span class="rating-value">${escape(rating)}</span>` : ''),
      [status,rating].filter(Boolean).join(' · ')) +
    listCell('notes', escape(notes.replace(/\s+/g, ' ')), notes);
}

function renderAssetCard(asset, library) {
  const id = escape(asset.id);
  const title = escape(asset.name);
  const marked = markedAssets.has(asset.id);
  const focused = asset.id === state.selected;
  const fileState = fileStates.get(asset.id);
  const fileWarning = fileState ? (fileState === 'missing' ? '文件缺失' : '无法访问') : '';
  const nameHeading = `<h3 class="card-name" title="${title}">${title}</h3>`;
  const format = escape(asset.ext.toUpperCase());
  const placeholder = icon(kindIcons[assetTypePreferences.effectiveKind(asset)] || 'box', 'placeholder-icon');
  const thumbnailFallback = state.list ? placeholder : `<span class="card-thumb-placeholder" aria-hidden="true">
    ${placeholder}${format ? `<span class="card-thumb-format">${format}</span>` : ''}</span>`;
  return `<article class="asset-card ${focused ? 'selected' : ''} ${marked ? 'checked' : ''}" data-id="${id}" ${asset.kind === 'video' ? 'data-video-hover' : ''} tabindex="0" aria-label="${title}" aria-haspopup="menu" ${focused ? 'aria-current="true"' : ''}${state.list ? ' role="row"' : ''}>
    <div class="card-thumb"${state.list ? ' role="cell"' : ''}>
      ${thumbnailFallback}
      <img data-thumb="${id}" alt="" draggable="false" class="hidden">
      ${state.list ? '' : `<span class="format-badge">${format}</span>`}
      ${fileWarning && !state.list ? '<span class="file-state">' + fileWarning + '</span>' : ''}
      <button class="icon-button card-favorite ${asset.favorite ? 'is-favorite' : ''}" data-favorite="${id}" title="${asset.favorite ? '取消收藏' : '收藏资产'}">${icon('star')}</button>
      ${native && !state.list && asset.kind === 'video' && !fileWarning ? `<span class="card-video-duration hidden" data-video-duration="${id}"></span>` : ''}
      <button class="card-check" data-mark="${id}" aria-label="选择 ${title}" aria-pressed="${marked}">${icon('check')}</button>
      ${nativeDragOut ? '<button type="button" class="card-native-drag" data-native-drag title="拖到其他桌面软件" aria-label="拖到其他桌面软件">' + icon('drag-out') + '</button>' : ''}
    </div>
    <div class="card-info"${state.list ? ' role="presentation"' : ''}>
      ${state.list ? `<div class="asset-list-name" role="cell">${nameHeading}
        ${fileWarning || asset.subtitle ? `<small${fileWarning ? ' class="asset-list-file-warning"' : ''} title="${escape(fileWarning || asset.subtitle)}">${escape(fileWarning || asset.subtitle)}</small>` : ''}
      </div>${renderAssetListDetails(asset, library)}` : nameHeading}
    </div>
  </article>`;
}
function renderBulkBar() {
  $('#bulk-bar').classList.toggle('hidden', !markedAssets.size);
  $('#selection-count').textContent = `已选 ${markedAssets.size} 项`;
  $('#compare-assets').disabled = markedAssets.size < 2 || markedAssets.size > 4;
  $('#batch-asset-ai').classList.toggle('hidden', !native);
  $('#batch-thumbnails').classList.toggle('hidden', !native);
  $('#remove-from-collection').classList.toggle('hidden', !currentCollection());
}
const thumbObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){thumbObserver.unobserve(e.target);const img=e.target.querySelector('[data-thumb]');if(img)enqueueThumb(img);}},{rootMargin:'200px'});
let thumbActive=0,thumbCacheBytes=0,thumbGeneration=0;const thumbQueue=[];
const pendingThumbnails = new Map();
const videoThumbnailRetry = new Map();
function resetThumbnails() {
  thumbCache.clear();
  videoThumbnailRetry.clear();
  thumbCacheBytes = 0;
  thumbGeneration++;
}
function loadVisibleThumbs() {
  thumbObserver.disconnect();
  thumbQueue.length = 0;
  for (const img of $$('[data-thumb]')) observeThumbnail(img);
}
function videoThumbnailCoolingDown(asset) {
  const previous = videoThumbnailRetry.get(asset.id);
  if (!previous) return false;
  if (previewChanged(previous.asset, asset)) {
    videoThumbnailRetry.delete(asset.id);
    return false;
  }
  return previous.until > performance.now();
}
function observeThumbnail(img, after = null) {
  const ids = img.dataset.thumbCandidates ? JSON.parse(img.dataset.thumbCandidates) : [img.dataset.thumb];
  const start = after === null ? 0 : ids.indexOf(after) + 1;
  for (const id of ids.slice(start)) {
    const asset = assetsById.get(id);
    if (!asset || (team.active && !asset.teamMounted)) continue;
    const cached = thumbCache.get(id);
    if (cached === null || (cached === undefined && videoThumbnailCoolingDown(asset))) continue;
    img.dataset.thumb = id;
    setThumb(img, cached);
    if (cached === undefined) thumbObserver.observe(img.parentElement);
    return;
  }
  setThumb(img, null);
}
function setThumb(img, url) {
  if (url) img.src = url;
  else img.removeAttribute('src');
  img.classList.toggle('hidden', !url);
  img.previousElementSibling?.classList.toggle('hidden', Boolean(url));
}
$('#asset-grid').addEventListener('error', event => {
  const img = event.target;
  if (img.matches('.card-thumb img[data-thumb]') && img.hasAttribute('src')) setThumb(img, null);
}, true);
function enqueueThumb(img){thumbQueue.push(img);pumpThumbs();}
function cacheThumb(id,url){thumbCacheBytes-=thumbCache.get(id)?.length||0;thumbCache.set(id,url);thumbCacheBytes+=url?.length||0;while(thumbCache.size>180||thumbCacheBytes>32*1024*1024){const key=thumbCache.keys().next().value;thumbCacheBytes-=thumbCache.get(key)?.length||0;thumbCache.delete(key);}}
function cacheThumbnailResult(asset, url, cacheOnly) {
  const {id} = asset;
  if (asset.kind === 'video') {
    if (!url) {
      const now = performance.now();
      const previous = videoThumbnailRetry.get(id);
      if (previous && !previewChanged(previous.asset, asset)) {
        if (previous.until <= now) previous.until = now + 20_000;
        return;
      }
      const retry = {asset, until:now + 20_000};
      videoThumbnailRetry.set(id, retry);
      if (videoThumbnailRetry.size > 180) videoThumbnailRetry.delete(videoThumbnailRetry.keys().next().value);
      setTimeout(() => {
        if (videoThumbnailRetry.get(id) !== retry || previewChanged(asset, assetsById.get(id))) return;
        const thumbnail = $(`#asset-grid:not(.hidden) .asset-card[data-id="${CSS.escape(id)}"] [data-thumb]`);
        if (thumbnail) observeThumbnail(thumbnail);
      }, 20_000);
      return;
    }
    videoThumbnailRetry.delete(id);
  }
  if (url || !cacheOnly) cacheThumb(id, url);
}
async function renderModelThumbnail(asset, size, batch = false) {
  const payload = await api('read_preview', {id:asset.id,mode:'mesh_thumbnail',size});
  thumbnailRenderer.fixedSize = {width:size,height:Math.round(size * 234 / 320)};
  loadMesh(thumbnailRenderer, payload, asset);
  const dataUrl = thumbnailRenderer.canvas.toDataURL('image/webp', .84);
  if (native && payload.cacheKey) {
    const store = api('store_model_thumbnail', {id:asset.id,size,cacheKey:payload.cacheKey,dataUrl,batch});
    if (batch) await store;
    else store.catch(() => {});
  } else if (batch) {
    throw Error('模型已改变，未保存缩略图');
  }
  return dataUrl;
}

let videoThumbnails = Promise.resolve();
const pendingVideoThumbnails = new Map();

function waitForVideoFrame(video, event, deadline, change, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(event, ready);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', cancelled);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(Error('无法读取视频帧'));
    };
    const cancelled = () => {
      cleanup();
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(Error('读取视频帧超时'));
    }, Math.max(0, deadline - performance.now()));
    video.addEventListener(event, ready);
    video.addEventListener('error', failed);
    if (signal?.aborted) return cancelled();
    signal?.addEventListener('abort', cancelled, {once:true});
    try { change?.(); }
    catch (failure) { cleanup(); reject(failure); }
  });
}

async function loadVideoCardDuration(asset, signal) {
  const {path} = await api('asset_video_source', {id:asset.id, pathOnly:true});
  signal.throwIfAborted();
  const video = document.createElement('video');
  video.preload = 'metadata';
  try {
    await waitForVideoFrame(video, 'loadedmetadata', performance.now() + 8_000, () => {
      video.src = window.__TAURI__.core.convertFileSrc(path);
    }, signal);
    return video.duration;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

async function captureVideoThumbnail(url, size, deadline) {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  try {
    await waitForVideoFrame(video, 'loadeddata', deadline, () => {
      video.src = url;
    });
    if (!video.videoWidth || !video.videoHeight) throw Error('视频没有可显示的画面');
    const scale = Math.min(1, size / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (Number.isFinite(video.duration) && video.duration > 0.1) {
      try {
        const sampleDeadline = Math.min(deadline, performance.now() + 1_200);
        const sample = Math.min(3, video.duration * 0.12);
        await waitForVideoFrame(video, 'seeked', sampleDeadline, () => { video.currentTime = sample; });
        if (video.readyState >= video.HAVE_CURRENT_DATA) context.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        // The initial frame stays available when a seek cannot finish.
      }
    }
    return canvas.toDataURL('image/webp', 0.82);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

async function loadVideoThumbnailFrame({url, path}, size) {
  const deadline = performance.now() + 12_000;
  if (url) {
    try {
      return await captureVideoThumbnail(url, size, deadline - 3_000);
    } catch {
      // The existing asset protocol is still available when the range stream fails.
    }
  }
  return captureVideoThumbnail(window.__TAURI__.core.convertFileSrc(path), size, deadline);
}

function renderVideoThumbnail(asset, size, batch = false) {
  const scope = collectionScope();
  const coverRevision = coverRevisions.get(asset.id);
  const key = JSON.stringify([scope, asset.id, asset.path, asset.modified, asset.size, coverRevision, size, batch]);
  const pending = pendingVideoThumbnails.get(key);
  if (pending) return pending;
  const stillCurrent = () => scope === collectionScope() && coverRevisions.get(asset.id) === coverRevision &&
    !previewChanged(asset, assetsById.get(asset.id));
  const task = videoThumbnails.then(async () => {
    if (!stillCurrent()) {
      throw Error('视频已从当前目录移除');
    }
    const source = await api('asset_video_source', {id:asset.id,size});
    const {cacheKey} = source;
    if (!cacheKey) throw Error('视频已改变，未保存缩略图');
    let dataUrl;
    try {
      dataUrl = await loadVideoThumbnailFrame(source, size);
    } catch (captureFailure) {
      if (!stillCurrent()) throw captureFailure;
      try {
        const result = await api('generate_system_video_thumbnail', {id:asset.id,size,cacheKey,batch});
        if (result?.url) return result;
      } catch (failure) {
        const message = String(failure?.message || failure);
        throw Error(`${captureFailure.message} · ${message}`);
      }
      throw captureFailure;
    }
    if (!stillCurrent()) throw Error('视频或封面已改变，未保存缩略图');
    const store = api('store_video_thumbnail', {id:asset.id,size,cacheKey,dataUrl,batch});
    const result = await (batch ? store : store.catch(() => null));
    return {url:dataUrl, state:result?.state};
  }).finally(() => pendingVideoThumbnails.delete(key));
  pendingVideoThumbnails.set(key, task);
  videoThumbnails = task.catch(() => {});
  return task;
}

async function readThumbnail(asset, size, cacheOnly) {
  const sharedOnly = cacheOnly && native && isTeamAsset(asset) && asset.teamMounted && asset.kind !== 'video';
  const customCover = customCovers.has(asset.id);
  const readImage = async mode => (await api('read_preview', {id:asset.id,mode,size}).catch(() => null))?.url;
  if (native && asset.ext === 'max') {
    const local = customCover ? null : await readImage('thumbnail_cached');
    return local || readImage('thumbnail');
  }
  if (sharedOnly && customCover) return readImage('thumbnail_shared');
  if (customCover) cacheOnly = false;
  const existing = await readImage(cacheOnly ? 'thumbnail_cached' : 'thumbnail');
  if (existing) return existing;
  if (native && asset.kind === 'video') {
    if (cacheOnly) {
      const located = await readImage('thumbnail');
      if (located) return located;
    }
    return (await renderVideoThumbnail(asset, size)).url;
  }
  if (sharedOnly) return readImage('thumbnail_shared');
  if (cacheOnly) return null;
  if (!meshCapable(asset) || asset.size > 750_000) return null;
  return renderModelThumbnail(asset, size);
}

function isWhiteboardReferenceMedia(asset) {
  return asset?.kind === 'texture' || asset?.kind === 'video';
}

async function resolveWhiteboardAssetMedia(id, workspaceKey) {
  const sameWorkspace = () => workspaceKey === collectionScope();
  if (!sameWorkspace()) throw Error('资产库已切换。');
  const asset = assetsById.get(id) || (team.active ? team.catalog?.assets.find(item => item.id === id) : null);
  if (!isWhiteboardReferenceMedia(asset)) throw Error('当前资产库找不到这项媒体。');
  const cacheOnly = native && isTeamAsset(asset) && !asset.teamMounted;
  if (asset.kind === 'video') {
    const mode = cacheOnly ? 'thumbnail_cached' : 'thumbnail';
    const poster = thumbCache.get(id) || (await api('read_preview', {id,mode,size:thumbnailSize}).catch(() => null))?.url;
    if (!sameWorkspace()) throw Error('资产库已切换。');
    const playback = async () => {
      if (!sameWorkspace()) throw Error('资产库已切换。');
      const source = await api('asset_video_source', {id});
      if (!sameWorkspace()) throw Error('资产库已切换。');
      const fallback = native && source?.path ? window.__TAURI__.core.convertFileSrc(source.path) : null;
      const url = source?.url || fallback;
      if (!url) throw Error('视频源文件暂不可用。');
      return {url, fallbackUrl:fallback && fallback !== url ? fallback : null};
    };
    return {kind:'video',name:asset.name,poster,playback};
  }
  const preview = cacheOnly ? null : await api('read_preview', {id,mode:'large'}).catch(() => null);
  const url = preview?.url || thumbCache.get(id) || await readThumbnail(asset, thumbnailSize, cacheOnly);
  if (!sameWorkspace()) throw Error('资产库已切换。');
  if (!url) throw Error('图片源文件暂不可用。');
  return {kind:'image',name:asset.name,url};
}

function pumpThumbs() {
  while (thumbActive < 4 && thumbQueue.length) {
    const img = thumbQueue.shift();
    if (!img.isConnected) continue;
    const id = img.dataset.thumb;
    const before = assetsById.get(id);
    if (!before) continue;
    const cached = thumbCache.get(id);
    if (cached !== undefined || videoThumbnailCoolingDown(before)) {
      if (cached) setThumb(img, cached);
      else observeThumbnail(img, id);
      continue;
    }
    const coverRevision = coverRevisions.get(id);
    const generation = thumbGeneration;
    const cacheOnly = native && !state.library;
    const key = JSON.stringify([id, generation, coverRevision, before.path, before.modified, before.size, cacheOnly]);
    let request = pendingThumbnails.get(key);
    if (!request) {
      request = readThumbnail(before, thumbnailSize, cacheOnly).catch(() => null).finally(() => pendingThumbnails.delete(key));
      pendingThumbnails.set(key, request);
    }
    thumbActive++;
    request.then(url => {
      const current = assetsById.get(id);
      if (generation !== thumbGeneration || cacheOnly !== (native && !state.library) ||
          previewChanged(before, current) || coverRevisions.get(id) !== coverRevision) return;
      cacheThumbnailResult(before, url, cacheOnly);
      if (!img.isConnected || img.dataset.thumb !== id) return;
      if (url) setThumb(img, url);
      else observeThumbnail(img, id);
    }).finally(() => {
      thumbActive--;
      pumpThumbs();
    });
  }
}

const thumbnailDialog = $('#thumbnail-dialog');
const thumbnailProgress = $('#thumbnail-progress');
let thumbnailTargets = new Map();
let thumbnailRun = null;

function showThumbnailSettings(ids = [], folder = null) {
  if (thumbnailRun) {
    openDialog('#thumbnail-dialog');
    return;
  }
  thumbnailTargets = new Map();
  if (folder) {
    const library = state.libraries.find(item => item.id === folder.libraryId);
    const matches = createFolderMatcher(library, folder.path);
    const folderIds = (assetsByLibrary.get(folder.libraryId) || []).filter(matches).map(asset => asset.id);
    if (folderIds.length) thumbnailTargets.set('folder', {label:`「${folder.name}」及子文件夹`, ids:folderIds});
  } else {
    const current = isAssetView() ? filtered().map(asset => asset.id) : [];
    if (ids.length) thumbnailTargets.set('selected', {label:'选中资产', ids});
    if (current.length) thumbnailTargets.set('view', {label:'当前筛选结果', ids:current});
  }
  const scope = $('#thumbnail-scope');
  scope.replaceChildren(...[...thumbnailTargets].map(([key,target]) =>
    new Option(`${target.label}（${target.ids.length.toLocaleString('zh-CN')} 项）`, key)));
  if (!scope.options.length) scope.add(new Option('当前没有可生成的资产'));
  scope.disabled = !thumbnailTargets.size;
  $('#generate-thumbnails').disabled = !thumbnailTargets.size;
  $('#thumbnail-size').value = thumbnailSize;
  $('#thumbnail-description').textContent = team.active
    ? '生成的缩略图保存在团队 NAS，其他电脑可复用。快速预览仍可查看大图。'
    : '生成的缩略图保存在当前工作空间的数据目录。快速预览仍可查看大图。';
  thumbnailProgress.classList.add('hidden');
  openDialog('#thumbnail-dialog');
}

function saveThumbnailSize() {
  const input = $('#thumbnail-size');
  if (!input.reportValidity()) return false;
  const next = input.valueAsNumber;
  if (next !== thumbnailSize) {
    thumbnailSize = next;
    libraryPreferences.setItem(thumbnailSizeKey, String(next));
    resetThumbnails();
    if (!thumbnailRun) loadVisibleThumbs();
  }
  return true;
}

$('#thumbnail-settings').classList.toggle('hidden', !native);
$('#thumbnail-settings').addEventListener('click', () => {
  closeTopTools(true);
  showThumbnailSettings([...markedAssets]);
});
$('#batch-thumbnails').addEventListener('click', () => showThumbnailSettings([...markedAssets]));
$('#save-thumbnail-size').addEventListener('click', () => {
  if (saveThumbnailSize()) thumbnailDialog.close();
});
$('#stop-thumbnails').addEventListener('click', () => { if (thumbnailRun) thumbnailRun.stop = true; });
thumbnailDialog.addEventListener('close', () => { if (thumbnailRun) thumbnailRun.stop = true; });
$('#thumbnail-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = thumbnailTargets.get($('#thumbnail-scope').value);
  if (thumbnailRun || !target?.ids.length) return;
  const run = {scope:collectionScope(),stop:false};
  thumbnailRun = run;
  if (!saveThumbnailSize()) {
    thumbnailRun = null;
    return;
  }
  const size = thumbnailSize;
  const stop = $('#stop-thumbnails');
  const controls = ['#thumbnail-size', '#thumbnail-scope', '#save-thumbnail-size', '#generate-thumbnails'].map($);
  controls.forEach(control => { control.disabled = true; });
  stop.classList.remove('hidden');
  thumbnailProgress.classList.remove('hidden');
  let processed = 0, generated = 0, cached = 0, unsupported = 0, failed = 0, firstError = '';
  const halted = () => run.stop || run.scope !== collectionScope();
  const showProgress = () => { thumbnailProgress.textContent = `正在处理 ${processed} / ${target.ids.length} 项…`; };
  try {
    showProgress();
    for (let offset = 0; offset < target.ids.length && !halted(); offset += 24) {
      const ids = target.ids.slice(offset, offset + 24);
      const result = await api('build_thumbnail_cache', {ids,size});
      generated += result.generated;
      cached += result.cached;
      unsupported += result.unsupported;
      failed += result.failed;
      firstError ||= result.errors?.[0] || '';
      const renderIds = [...result.models, ...(result.videos || [])];
      processed += ids.length - renderIds.length;
      for (const id of renderIds) {
        if (halted()) break;
        try {
          const asset = assetsById.get(id);
          if (!asset) throw Error('资产已从当前目录移除');
          if (asset.kind === 'video') {
            const saved = await renderVideoThumbnail(asset, size, true);
            if (saved.state === 'cached') cached++;
            else generated++;
          } else {
            await renderModelThumbnail(asset, size, true);
            generated++;
          }
        } catch (failure) {
          failed++;
          firstError ||= String(failure?.message || failure);
        }
        processed++;
        showProgress();
      }
      showProgress();
    }
    const summary = `${halted() ? '已停止 · ' : ''}已生成 ${generated} 项 · 已缓存 ${cached} 项` +
      (unsupported ? ` · 暂无预览 ${unsupported} 项` : '') + (failed ? ` · 失败 ${failed} 项` : '');
    thumbnailProgress.textContent = firstError ? summary + '。' + firstError : summary;
    runtimeLog.add(`生成缩略图 · ${thumbnailProgress.textContent}`, failed ? 'error' : 'info');
    if (!thumbnailDialog.open) toast(summary, failed > 0);
  } catch (failure) {
    thumbnailProgress.textContent = String(failure?.message || failure);
    runtimeLog.add(`生成缩略图失败 · ${thumbnailProgress.textContent}`, 'error');
    if (!thumbnailDialog.open) error(failure);
  } finally {
    thumbnailRun = null;
    stop.classList.add('hidden');
    controls.forEach(control => { control.disabled = false; });
    if (run.scope === collectionScope()) {
      resetThumbnails();
      loadVisibleThumbs();
    }
  }
});
async function selectAsset(id) {
  if (id !== state.selected) clearAssetModeHighlight();
  state.selected = id;
  for (const card of $$('#asset-grid .asset-card')) {
    const active = card.dataset.id === id;
    card.classList.toggle('selected', active);
    if (active) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');
  }
  await renderInspector(true);
}
function meshCapable(asset) { return ['obj', 'stl', 'ply', 'glb', 'gltf'].includes(asset.ext); }
function loadMesh(renderer, payload, asset) {
  return asset.ext !== 'obj'
    ? renderer.loadBinary(payload.base64, asset.ext, asset.color)
    : renderer.load(payload.text, asset.color);
}
async function renderInspector(loadPreview=true){
  const a=selected();$('#inspector-empty').classList.toggle('hidden',Boolean(a));$('#inspector-content').classList.toggle('hidden',!a);if(!a){previewSerial++;return;}
  const typeLabel = displayAssetType(a);
  $('#asset-title').textContent=a.name;$('#asset-subtitle').textContent=a.subtitle||a.ext.toUpperCase()+' / '+typeLabel;$('#detail-favorite').classList.toggle('is-favorite',a.favorite);
  $('#asset-tags').innerHTML=a.tags.map(t=>`<span>${escape(t)}</span>`).join('');
  const shared = isTeamAsset(a);
  $('#asset-metadata').innerHTML=`<dt>资产类型</dt><dd>${escape(typeLabel)}</dd><dt>文件格式</dt><dd>${escape(a.ext.toUpperCase())}</dd><dt>文件大小</dt><dd>${bytes(a.size)}</dd>${a.vertices?`<dt>网格统计</dt><dd>${a.vertices} 顶点 / ${a.faces} 面</dd>`:''}<dt>入库时间</dt><dd>${date(a.added)}</dd>${shared ? `<dt>更新者</dt><dd>${escape(a.editedBy)}</dd>` : ''}<dt>文件位置</dt><dd class="path-value">${escape(a.path || a.relativePath)}</dd>`;
  if (editor.id !== a.id || !editor.dirty) {
    $('#asset-name').value=a.name;
    $('#asset-tag-input').value=a.tags.join(', ');
    $('#asset-notes').value=a.notes||'';
    $('#asset-rating').value=String(a.rating||0);
    $('#asset-workflow').value=a.workflow||'unset';
    Object.assign(editor, { id: a.id, revision: a.revision, dirty: false });
  }
  setConflict(shared && editor.dirty && editor.revision !== a.revision
    ? '同事更新了这项资产。你可以先复制草稿，再载入最新资料。' : '');
  $('#save-metadata').disabled = editor.saving;
  $('#reveal-file').disabled = Boolean(fileStates.get(a.id) || (shared && !a.teamMounted));
  $('#show-asset-folder').disabled = !indexedAssetFolder(a);
  renderSessions();if(!loadPreview)return;
  const serial=++previewSerial;$('#preview-canvas').classList.add('hidden');$('#preview-image').classList.add('hidden');$('#preview-fallback').classList.add('hidden');$('#preview-help').textContent='正在加载预览…';
  if (shared && !a.teamMounted) {
    fallback(a, '请先链接团队共享文件夹');
    return;
  }
  try{
    let meshError;
    if (meshCapable(a)) {
      try {
        const payload = await api('read_preview',{id:a.id,mode:'mesh'});
        if (serial !== previewSerial) return;
        $('#preview-canvas').classList.remove('hidden');
        const stats = loadMesh(preview, payload, a);
        $('#preview-help').textContent = `拖动旋转 · 滚轮缩放 · ${stats.faces.toLocaleString()} 面`;
        $('#preview-badge').textContent = '3D / ' + a.ext.toUpperCase();
        return;
      } catch (e) { meshError = e; }
    }
    if (serial !== previewSerial) return;
    $('#preview-canvas').classList.add('hidden');
    const payload = await api('read_preview',{id:a.id,mode:'preview'});
    if (serial !== previewSerial) return;
    if (payload?.url) {
      $('#preview-image').src = payload.url;
      $('#preview-image').classList.remove('hidden');
      $('#preview-badge').textContent = '图像预览';
      $('#preview-help').textContent = '打开快速预览可查看大图';
    } else {
      fallback(a, meshError ? String(meshError.message || meshError) : '此资产暂无可显示的预览');
    }
  }catch(e){if(serial===previewSerial)fallback(a,String(e.message||e));}
}
function fallback(a,message){$('#preview-canvas').classList.add('hidden');$('#preview-fallback').classList.remove('hidden');$('#preview-fallback').innerHTML=icon('box')+`<span>${escape(a.ext.toUpperCase())}</span>`;$('#preview-badge').textContent='文件';$('#preview-help').textContent=message;}
function renderSessions(){const select=$('#target-session'),previous=select.value;select.innerHTML=state.sessions.length?state.sessions.map(s=>`<option value="${escape(s.id)}">${escape(s.label||dccs[s.dcc]?.name||s.dcc)}</option>`).join(''):'<option value="">暂无在线实例</option>';if(state.sessions.some(s=>s.id===previous))select.value=previous;updateSend();}
function updateSend() {
  const asset = selected();
  const session = state.sessions.find(item => item.id === $('#target-session').value);
  const unmapped = isTeamAsset(asset) && !asset.teamMounted;
  const fileState = fileStates.get(asset?.id);
  const smart = canUseSmartImport(session, asset);
  const ok = Boolean(asset && session && !unmapped && !fileState && (smart || compat[session.dcc]?.includes(asset.ext)));
  const connect = native && asset && !session && !unmapped && !fileState &&
    (smartFormats.has(asset.ext) || Object.values(compat).some(formats => formats.includes(asset.ext)));
  $('#send-asset').disabled = !ok && !connect;
  $('#send-asset-label').textContent = connect ? '打开 DCC 连接中心'
    : usesC4dSceneDialog(session, asset) ? '选择导入选项'
    : smart ? '智能导入到场景' : '导入到当前场景';
  $('#smart-import-settings').classList.toggle('hidden', !smart);
  $('#send-hint').textContent = fileState === 'missing' ? '右键卡片以重新关联文件'
    : fileState ? '请检查磁盘和 NAS 是否可用'
    : unmapped ? '请先链接团队共享文件夹'
    : connect ? '连接创作软件后即可导入'
    : !session ? '先在 DCC 中运行桥接脚本'
    : !ok && session.dcc === 'c4d' && smartFormats.has(asset?.ext) ? '更新 Cinema 4D 桥接后即可智能导入'
    : !ok ? (asset ? '.' + asset.ext + ' 需要先转换为目标软件支持的格式' : '先选择一项资产')
    : '导入 ' + dccs[session.dcc]?.name + ' 当前场景';
}
const teamAvatars = new Map();
const avatarPokes = new WeakMap();

function animateTeamAvatar(id) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const member = $('#online-members').querySelector(`[data-team-member-avatar="${CSS.escape(id || '')}"]`);
  const chip = member?.matches('.online-avatar-chip') ? member : member?.querySelector('.online-avatar-chip');
  if (!chip) return;
  avatarPokes.get(chip)?.cancel();
  avatarPokes.set(chip, chip.animate([
    {transform:'translateY(0)'},
    {transform:'translateY(-5px)', offset:0.32},
    {transform:'translateY(0)', offset:0.61},
    {transform:'translateY(-2px)', offset:0.78},
    {transform:'translateY(0)'},
  ], {duration:380, easing:'ease-in-out'}));
}

function isAvatarUrl(value) {
  return typeof value === 'string' && value.startsWith('data:image/png;base64,') && value.length <= 90_000;
}

function drawAvatar(container, url, fallback) {
  if (!isAvatarUrl(url)) {
    container.textContent = fallback;
    return;
  }
  const image = document.createElement('img');
  image.alt = '';
  image.src = url;
  image.addEventListener('error', () => { if (image.parentElement === container) container.textContent = fallback; }, {once:true});
  container.replaceChildren(image);
}

function loadTeamAvatar(member, chip) {
  if (!member.avatarRevision || chip.querySelector('img')) return;
  const epoch = team.epoch;
  let entry = teamAvatars.get(member.id);
  if (entry?.revision !== member.avatarRevision) {
    entry = {revision:member.avatarRevision, request:api('team_member_avatar', {memberId:member.id})
      .then(result => result.avatarUrl)
      .catch(() => {
        if (teamAvatars.get(member.id)?.revision === member.avatarRevision && team.epoch === epoch) teamAvatars.delete(member.id);
        return null;
      })};
    teamAvatars.set(member.id, entry);
  }
  entry.request.then(url => {
    if (team.epoch === epoch && chip.isConnected && isAvatarUrl(url)) drawAvatar(chip, url, member.letters);
  });
}

function renderTeamPresence() {
  const container = $('#online-members');
  const items = team.active ? team.online.map(member => ({
    id:member.id, name:member.name, letters:Array.from(member.name.trim())[0] || '?',
    self:member.self, avatarRevision:member.avatarRevision,
    detail:`${member.self ? '你 · ' : ''}在线 · ${date(member.onlineSince)} 上线`,
  })) : [];
  container.classList.toggle('hidden', !items.length);
  const canShare = teamAssetMessages.enabled();
  const canPoke = teamAssetMessages.pokesEnabled();
  const signature = JSON.stringify([items, canShare, canPoke]);
  const visible = items.slice(0, 3);
  if (container.dataset.signature !== signature) {
    container.dataset.signature = signature;
    const details = members => members.map(member => `<strong>${escape(member.name)}</strong><small>${escape(member.detail)}</small>`).join('');
    const recipient = member => canShare && member && !member.self ? ` data-team-message-recipient="${escape(member.id)}"` : '';
    const identity = member => member ? ` data-team-member-avatar="${escape(member.id)}"` : '';
    const avatar = (label, letters, content, tone, member, overflow = false) => `<div class="online-avatar"${overflow && canShare ? ' data-team-message-overflow' : ''}>
      <button type="button" class="online-avatar-chip" aria-label="${escape(label)}" data-tone="${tone}"${member ? ' data-dot' : ''}${member?.self ? ' data-team-profile aria-haspopup="dialog"' : member && canPoke ? ' aria-haspopup="menu"' : ''}${identity(member)}${recipient(member)}>${escape(letters)}</button>
      <div class="online-avatar-card"${overflow && (canShare || canPoke) ? '' : ' role="tooltip"'}><div class="online-avatar-details">${content}</div></div>
    </div>`;
    const extra = items.slice(3);
    const overflowDetails = canShare || canPoke ? extra.map(member => `<div class="online-avatar-overflow-member"${identity(member)}${recipient(member)}>
      <span class="online-avatar-chip" aria-hidden="true">${escape(member.letters)}</span>
      <div>${details([member])}</div>
    </div>`).join('') : details(extra);
    const more = extra.length ? avatar(`另外 ${extra.length} 位成员在线`, '+' + extra.length, overflowDetails, 0, null, true) : '';
    container.innerHTML = visible.map(member => avatar(`${member.name} · ${member.detail}`, member.letters, details([member]),
      [...member.id].reduce((sum, character) => sum + character.codePointAt(0), 0) % 4, member)).join('') + more;
  }
  const chips = container.querySelectorAll('.online-avatar > .online-avatar-chip');
  for (const id of teamAvatars.keys()) if (!visible.some(member => member.id === id)) teamAvatars.delete(id);
  visible.forEach((member, index) => loadTeamAvatar(member, chips[index]));
}

async function refreshTeamPresence() {
  if (!native || !team.active || team.presenceUnsupported || team.presencePending) return;
  const epoch = team.epoch;
  const task = api('team_online_members');
  team.presencePending = task;
  try {
    const result = await task;
    if (epoch !== team.epoch) return;
    team.presenceUnsupported = result === null;
    team.online = result?.members || [];
  } catch {
    if (epoch !== team.epoch) return;
    team.online = team.online.filter(member => Date.now() - member.lastSeen * 1000 < 30_000);
  } finally {
    if (team.presencePending === task) team.presencePending = null;
  }
  renderTeamPresence();
}

async function jumpToTeamNoticeAsset(id, stillOpen, closeInbox) {
  if (!assetsById.has(id)) await refreshTeam(true);
  if (!stillOpen()) return;
  if (!isTeamAsset(assetsById.get(id))) throw Error('当前团队库找不到这项资产，可能已被移除');
  await jumpToIndexedAsset(id, stillOpen, closeInbox);
}

function indexedAssetFolder(asset) {
  if (!asset) return null;
  const library = state.libraries.find(item => item.id === asset.libraryId);
  const relative = relativeAssetPath(asset, library);
  if (!relative) return null;
  const node = findFolder(folderTrees.get(library.id), relative.split('/').slice(0, -1).join('/'));
  return node ? {libraryId: library.id, folder: node.path} : null;
}

function showFolderTree(libraryId, path) {
  workspaceLayout?.showSidebar();
  sidebarZones.show('folder');
  const filter = folderSearch.value.trim();
  if (filter && !findFolder(filterFolderTree(folderTrees.get(libraryId), filter), path)) {
    folderSearch.value = '';
  }
}

function expandFolderPath(libraryId, path, {includeFolder = true} = {}) {
  const trail = ['', ...folderAncestors(path).map(folder => folder.path)];
  if (!includeFolder) trail.pop();
  for (const ancestor of trail) expandedFolders.add(folderKey(libraryId, ancestor));
}

function centerFolderInTree(libraryId, path) {
  const scroll = $('#libraries');
  const row = scroll.querySelector(`.nav-item[data-library="${CSS.escape(libraryId)}"][data-folder="${CSS.escape(path)}"]`);
  if (!row) return;
  const rowBox = row.getBoundingClientRect();
  scroll.scrollTop += rowBox.top - scroll.getBoundingClientRect().top - scroll.clientTop +
    (rowBox.height - scroll.clientHeight) / 2;
  return row;
}

function locatePinnedFolder(libraryId, path) {
  if (!findFolder(folderTrees.get(libraryId), path)) return;
  showFolderTree(libraryId, path);
  expandFolderPath(libraryId, path, {includeFolder:false});
  renderLibraryTree();
  const row = centerFolderInTree(libraryId, path);
  if (!row) return;
  row.classList.add('workspace-located-folder');
  row.addEventListener('blur', () => row.classList.remove('workspace-located-folder'), {once:true});
  row.focus({preventScroll: true});
}

async function jumpToIndexedAsset(id, stillOpen = () => true, beforeOpen = null) {
  const scope = collectionScope();
  if (editor.saving) throw Error('正在保存资产详情，请稍后再试');
  if (editor.dirty && state.selected !== id && !await confirmDiscardWorkspaceEdits(true)) return;
  if (scope !== collectionScope() || !stillOpen()) return;
  const location = indexedAssetFolder(assetsById.get(id));
  if (!location) throw Error('当前资产库找不到这项资产的文件夹');
  if (state.selected !== id) editor.dirty = false;
  beforeOpen?.();
  showFolderTree(location.libraryId, location.folder);
  openFolder(location.libraryId, location.folder, id);
  centerFolderInTree(location.libraryId, location.folder);
  const preview = selectAsset(id);
  const card = $$('#asset-grid .asset-card').find(item => item.dataset.id === id);
  card?.scrollIntoView({block:'nearest'});
  card?.focus({preventScroll:true});
  await preview;
}

const teamAssetMessages = initTeamAssetMessages({
  api,
  context() {
    if (!native || !team.active || !team.info?.team?.id) return null;
    return {teamId:team.info.team.id, key:team.epoch};
  },
  asset: id => assetsById.get(id),
  jump: jumpToTeamNoticeAsset,
  formatDate: date,
  notify: toast,
  onReceive: count => runtimeLog.add(`收到团队消息 · ${count} 条`),
  onPokeReceive: () => animateTeamAvatar(team.online.find(member => member.self)?.id),
  openDccUpdates: () => dccConnections.show(),
  onError: error,
  onAvailabilityChange: renderTeamPresence,
});

function renderConnections(){
  const connectionSummary = $('#connection-summary');
  const placementHosts = onlinePlacementHosts();
  const count = state.sessions.length;
  const connectionLabel = `DCC 连接中心，${count} 个创作工具实例在线`;
  connectionSummary.dataset.online = String(count > 0);
  $('#connection-count').textContent = count;
  connectionSummary.setAttribute('aria-label', connectionLabel);
  connectionSummary.title = placementHosts.length
    ? connectionLabel + ' · ' + placementHosts.join('、') + ' 视口放置已就绪'
    : connectionLabel;
  dccConnections.render();
  const dock = $('#dcc-drop-dock');
  dock.innerHTML = state.sessions.map(session => '<button type="button" tabindex="-1" class="button subtle" title="' +
    (session.dcc === 'c4d' ? '拖入模型或工程以选择导入选项' : '放在这里将直接导入当前场景') + '" data-drop-session="' +
    escape(session.id) + '">' + icon('link') + escape(session.label || dccs[session.dcc]?.name || session.dcc) + '</button>').join('');
  dock.classList.toggle('hidden', !state.sessions.length || !$('#app').classList.contains('dragging-assets'));
  renderSessions();if(state.view==='jobs')renderJobs();
}
const jobList = $('#job-list');
let displayedJobsMarkup = '';
function renderJobs() {
  const labels = {queued:'等待导入',running:'DCC 处理中',done:'导入完成',failed:'导入失败',interrupted:'已中断'};
  const projectLabels = {queued:'等待转换',running:'转换中',done:'转换完成',failed:'转换失败'};
  const markup = state.jobs.length ? state.jobs.map(job => {
    const status = (job.projectExport && projectLabels[job.status]) || labels[job.status] || job.status;
    const glyph = job.status === 'done' ? 'check' : job.status === 'failed' ? 'close' : 'download';
    const detail = job.error || job.progress || job.message;
    const project = job.status === 'done' && job.projectPath;
    const inProgress = job.dcc === 'c4d' && ['queued', 'running'].includes(job.status);
    return '<div class="job-row" tabindex="0" aria-haspopup="menu" data-job-id="' + escape(job.id) + '">' + icon(glyph) + '<div class="job-info"><h3>' + escape(job.name)
      + '</h3><p>' + escape(dccs[job.dcc]?.name || job.dcc) + ' · ' + date(job.created)
      + (detail ? '<br>' + escape(detail) : '') + (project ? '<br>' + escape(project) : '') + '</p>'
      + (inProgress ? '<progress class="c4d-job-meter" aria-label="Cinema 4D 导入进度"></progress>' : '') + '</div>'
      + (project ? '<button type="button" class="button subtle" data-project-job="' + escape(job.id) + '">打开输出目录</button>' : '')
      + '<span class="job-status ' + escape(job.status) + '">' + escape(status) + '</span></div>';
  }).join('') : '<div class="empty-state"><h3>还没有导入任务</h3><p>连接 DCC，在资产详情中将素材发送到当前场景。</p></div>';
  if (markup === displayedJobsMarkup) return;
  displayedJobsMarkup = markup;
  jobList.innerHTML = markup;
}
jobList.addEventListener('click', event => {
  const id = event.target.closest('[data-project-job]')?.dataset.projectJob;
  const path = state.jobs.find(job => job.id === id)?.projectPath;
  if (path) api('open_folder_location', {path:path.replace(/[\\/][^\\/]+$/, '')}).catch(error);
});

async function locateJobSource(jobId) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) throw Error('导入记录已更新，请重新选择');
  let asset = assetsById.get(job.assetId);
  if (!asset && typeof job.path === 'string' && job.path) {
    const matches = state.assets.filter(item => item.path === job.path);
    if (matches.length === 1) [asset] = matches;
  }
  if (!indexedAssetFolder(asset)) throw Error('当前资产库找不到这项任务的源素材');
  await jumpToIndexedAsset(asset.id, () => state.view === 'jobs');
}
async function favorite(id, value) {
  const a = assetsById.get(id);
  if (!a) return;
  await setFavorite(a, value ?? !a.favorite);
  renderNav();
  renderAssets();
  if (id === state.selected) renderInspector(false);
}
async function setFavorite(a, value) {
  if (isTeamAsset(a)) {
    await teamOrganization.setFavorite(a.id, value);
    const current = assetsById.get(a.id);
    if (current) current.favorite = value;
  } else {
    const result = await api('patch_asset', {id: a.id, patch: {favorite: value}});
    Object.assign(a, result);
  }
  navSummary = null;
}
function resetFilters(restoreFolder = false, assetWindowAnchor = null) {
  assetFilterToolbar.close();
  Object.assign(state, {kind:'all',tag:null,search:'',limit:60,rating:0,workflow:'',
    formatIncludes:[],formatExcludes:[],tagIncludes:[],tagExcludes:[],quickFilters:[],fileNameQuery:'',assetWindowAnchor});
  if (restoreFolder) Object.assign(state, quickFilters.remembered());
  else if (!assetWindowAnchor) quickFilters.saveIfRemembered();
  assetSearchInput.value = '';
  setAssetSearchExpanded(false);
  $('#rating-filter').value = '0';
  $('#workflow-filter').value = '';
  $('#browser-scroll').scrollTop = 0;
  renderNav();
  return renderAssets();
}
function enterLocation(view, library = null, folder = '', collection = null, assetId = null) {
  Object.assign(state, {view, library, folder, collection});
  markedAssets.clear();
  markedAnchor = null;
  return resetFilters(!assetId, assetId);
}
function setView(view) {
  if (view === 'whiteboard' && state.view === view) whiteboard.showProjects();
  const changed = state.view !== view || state.library || state.collection;
  enterLocation(view);
  if (changed) runtimeLog.add(`打开工作区页面 · ${viewLabel(view)}`);
}

function captureWorkbenchPage() {
  const {view, library, folder, collection, recursive, kind, tag, search, sort, selected, limit,
    formatIncludes, formatExcludes, tagIncludes, tagExcludes, rating, workflow, quickFilters,
    fileNameQuery, assetWindowAnchor} = state;
  return {
    criteria:structuredClone({view, library, folder, collection, recursive, kind, tag, search, sort, selected, limit,
      formatIncludes, formatExcludes, tagIncludes, tagExcludes, rating, workflow, quickFilters, fileNameQuery, assetWindowAnchor}),
    text:assetSearchInput.value,
    searchExpanded:assetSearchToggle.getAttribute('aria-expanded') === 'true',
    marked:[...markedAssets],
    markedAnchor,
    scroll:$('#browser-scroll').scrollTop,
    siteSearch:view === 'sites' ? $('#browser-site-filter').value : '',
    creator:view === 'subscriptions' ? creativeSubscriptions.captureLocation() : null,
    whiteboardProject:view === 'whiteboard' ? whiteboard.captureProject() : null,
  };
}

function restoreWorkbenchPage(page) {
  const {criteria, scroll} = page;
  if ((criteria.library && !findFolder(folderTrees.get(criteria.library), criteria.folder)) ||
      (criteria.collection && !state.collections.some(collection => collection.id === criteria.collection))) {
    setView(workspaceOpeningView(libraryPreferences));
    return;
  }
  editor.dirty = false;
  markedAssets.clear();
  for (const id of page.marked) if (assetsById.has(id)) markedAssets.add(id);
  markedAnchor = markedAssets.has(page.markedAnchor) ? page.markedAnchor : null;
  assetFilterToolbar.close();
  const needsPreview = state.selected !== criteria.selected;
  Object.assign(state, structuredClone(criteria));
  if (state.selected && !assetsById.has(state.selected)) state.selected = null;
  if (state.library) expandFolderPath(state.library, state.folder);
  assetSearchInput.value = page.text;
  setAssetSearchExpanded(page.searchExpanded);
  $('#sort').value = state.sort;
  $('#include-descendants').checked = state.recursive;
  $('#rating-filter').value = String(state.rating);
  $('#workflow-filter').value = state.workflow;
  renderNav();
  renderAssets();
  if (criteria.view === 'sites') {
    $('#browser-site-filter').value = page.siteSearch;
    siteNavigation.render();
  }
  if (criteria.view === 'subscriptions') creativeSubscriptions.restoreLocation(page.creator);
  if (criteria.view === 'whiteboard') {
    whiteboard.showProjects();
    if (page.whiteboardProject) whiteboard.openProject(page.whiteboardProject, false);
  }
  $('#browser-scroll').scrollTop = scroll;
  renderInspector(needsPreview).catch(error);
}
function openFolder(libraryId, path = '', assetId = null, {expandTree = true} = {}) {
  const node = findFolder(folderTrees.get(libraryId), path);
  if (!node) return;
  const firstFolder = !state.library;
  const changed = state.library !== libraryId || state.folder !== node.path;
  if (expandTree) expandFolderPath(libraryId, node.path);
  const rows = enterLocation('all', libraryId, node.path, null, assetId);
  if (!assetId && !rows.some(asset => asset.id === state.selected)) selectAsset(rows[0]?.id || null).catch(error);
  if (changed) runtimeLog.add(`打开文件夹 · ${node.name}`);
  if (team.active && firstFolder) refreshTeam().catch(() => {});
}
$('#show-earlier-assets').addEventListener('click', () => {
  state.assetWindowAnchor = null;
  state.limit = 60;
  $('#browser-scroll').scrollTop = 0;
  renderAssets();
});
function applySavedSearch({searchText, ...criteria}) {
  assetFilterToolbar.close();
  Object.assign(state, criteria, {limit: 60, assetWindowAnchor:null});
  if (state.library) expandFolderPath(state.library, state.folder);
  markedAssets.clear();
  markedAnchor = null;
  $('#search').value = searchText || state.search;
  $('#sort').value = state.sort;
  $('#include-descendants').checked = state.recursive;
  $('#rating-filter').value = String(state.rating);
  $('#workflow-filter').value = state.workflow;
  $('#browser-scroll').scrollTop = 0;
  renderNav();
  const results = renderAssets();
  if (!results.some(asset => asset.id === state.selected)) selectAsset(results[0]?.id || null).catch(error);
}
function updateMarks() {
  for (const card of $$('#asset-grid .asset-card')) {
    const marked = markedAssets.has(card.dataset.id);
    card.classList.toggle('checked', marked);
    card.querySelector('[data-mark]').setAttribute('aria-pressed', String(marked));
  }
  renderBulkBar();
}
function toggleMark(id, range = false) {
  if (range && markedAnchor) {
    const visible = $$('#asset-grid .asset-card').map(card => card.dataset.id);
    const start = visible.indexOf(markedAnchor);
    const end = visible.indexOf(id);
    if (start >= 0 && end >= 0) {
      for (const id of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) markedAssets.add(id);
      updateMarks();
      return;
    }
  }
  if (markedAssets.has(id)) markedAssets.delete(id);
  else markedAssets.add(id);
  markedAnchor = id;
  updateMarks();
}
for (const navigation of $$('#main-nav, #workspace-tools-nav')) {
  navigation.addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (button) setView(button.dataset.view);
  });
}
workspaceHomeButton.addEventListener('click', () => {
  if (state.view !== 'home') setView('home');
});
workspaceHome.addEventListener('click', event => {
  const destination = event.target.closest('[data-home-view]')?.dataset.homeView;
  if (!destination) return;
  setView(destination);
  if (event.detail === 0) $('#page-title').focus({preventScroll:true});
});
const folderSearch = $('#folder-search');
folderSearch.addEventListener('input', renderLibraryTree);
const unlinkDialog = $('#team-unlink-dialog');
const unlinkCancel = $('#team-unlink-cancel');
const unlinkSubmit = $('#team-unlink-submit');
const unlinkStatus = $('#team-unlink-status');
let unlinkDraft = null;

function showTeamUnlinkConfirmation({libraryId, folder, name, disconnect = false}) {
  if (!team.active || unlinkDialog.open || unlinkSubmit.disabled) return;
  unlinkDraft = {libraryId, folder, name, disconnect, epoch:team.epoch};
  $('#team-unlink-title').textContent = disconnect ? '从团队库移除文件夹' : '移除文件夹链接记录';
  $('#team-unlink-name').textContent = '「' + name + '」';
  $('#team-unlink-description').textContent = disconnect
    ? '此文件夹及其中的资产将从团队库中移除显示。原文件和索引记录会保留，手动重新链接可恢复。'
    : '此文件夹的链接记录会被移除。团队成员仍可从团队库访问其中的资产。';
  unlinkSubmit.textContent = disconnect ? '确认移出团队库' : '确认移除记录';
  unlinkStatus.textContent = '';
  openDialog('#team-unlink-dialog');
  unlinkCancel.focus();
}
unlinkDialog.addEventListener('cancel', event => { if (unlinkSubmit.disabled) event.preventDefault(); });
$('#team-unlink-form').addEventListener('submit', async event => {
  event.preventDefault();
  const draft = unlinkDraft;
  if (!draft || !team.active || draft.epoch !== team.epoch || unlinkSubmit.disabled) return;
  unlinkCancel.disabled = unlinkSubmit.disabled = true;
  unlinkStatus.textContent = draft.disconnect ? '正在移出团队库…' : '正在移除链接记录…';
  try {
    if (draft.disconnect) {
      await setSharedFolderVisibility({libraryId:draft.libraryId, path:draft.folder, name:draft.name}, true);
      unlinkDialog.close();
      return;
    }
    await api('team_unlink_folder', {libraryId:draft.libraryId, folder:draft.folder});
    unlinkDialog.close();
    if (team.active && draft.epoch === team.epoch) {
      await refreshTeam(true).then(() => toast('已移除文件夹链接记录'),
        () => toast('已移除链接记录，列表将在下次同步后更新'));
    }
  } catch (failure) {
    unlinkStatus.textContent = String(failure?.message || failure);
  } finally {
    unlinkCancel.disabled = unlinkSubmit.disabled = false;
  }
});
$('#libraries').addEventListener('click', event => {
  const disclosure = event.target.closest('[data-toggle-library]');
  if (disclosure) {
    const key = folderKey(disclosure.dataset.toggleLibrary, disclosure.dataset.folder);
    if (expandedFolders.has(key)) expandedFolders.delete(key);
    else expandedFolders.add(key);
    renderNav();
    const replacement = $$('#libraries [data-toggle-library]').find(item =>
      folderKey(item.dataset.toggleLibrary, item.dataset.folder) === key);
    replacement?.focus();
    return;
  }
  const folder = event.target.closest('[data-library]');
  if (folder) openFolder(folder.dataset.library, folder.dataset.folder);
});
$('#breadcrumbs').addEventListener('click', event => {
  if (event.target.closest('[data-crumb-home]')) return setView('home');
  const folder = event.target.closest('[data-crumb-folder]');
  if (folder) openFolder(state.library, folder.dataset.crumbFolder);
});
$('#include-descendants').addEventListener('change', event => {
  state.recursive = event.target.checked;
  libraryPreferences.setItem('nexus-include-descendants', String(state.recursive));
  markedAssets.clear();
  markedAnchor = null;
  const rows = renderAssets();
  if (!rows.some(asset => asset.id === state.selected)) selectAsset(rows[0]?.id || null).catch(error);
});
$('#show-asset-folder').addEventListener('click', () => {
  if (state.selected) jumpToIndexedAsset(state.selected).catch(error);
});
$('#sidebar-tags').addEventListener('click', event => {
  const button = event.target.closest('[data-tag], [data-tag-prefix]');
  if (!button) return;
  const tag = button.dataset.tag || button.dataset.tagPrefix;
  state.tag = state.tag === tag ? null : tag;
  state.tagIncludes = [];
  state.tagExcludes = [];
  state.limit = 60;
  renderNav();
  renderAssets();
});
$('#sidebar-tags').addEventListener('toggle', event => {
  const path = event.target.dataset?.tagGroup;
  if (!path || $('#tag-search').value.trim()) return;
  const expanded = openTagGroups.get(collectionScope());
  if (event.target.open) expanded?.add(path);
  else expanded?.delete(path);
}, true);
$('#tag-search').addEventListener('input', renderTags);
$('#active-filter').addEventListener('click',()=>{state.tag=null;renderNav();renderAssets();});
const quickFilters = initQuickFilters({
  getState: () => state,
  getScope: collectionScope,
  kindLabel: assetTypePreferences.label,
  categoryEnabled: assetTypePreferences.categoryEnabled,
  onError: error,
  onChange(change) {
    Object.assign(state, change, {limit: 60});
    $('#browser-scroll').scrollTop = 0;
    renderAssets();
  },
});
const assetFilterToolbar = initAssetFilterToolbar({
  preferences: libraryPreferences,
  getState: () => state,
  getFacetAssets: facet => assetView(baseAssets(), facet).rows,
  onChange(criteria) {
    Object.assign(state, criteria, {limit:60, assetWindowAnchor:null});
    $('#browser-scroll').scrollTop = 0;
    if ('tag' in criteria) renderNav();
    renderAssets();
  },
  onError: error,
});
$('#search').addEventListener('input',e=>{state.search=e.target.value.trim().toLowerCase().replaceAll('\\','/');state.limit=60;if(!isAssetView())state.view='all';renderNav();renderAssets();});
$('#sort').addEventListener('change', event => {
  state.sort = event.target.value;
  libraryPreferences.setItem('nexus-asset-sort', state.sort);
  renderAssets();
});
$('#rating-filter').addEventListener('change', event => {
  state.rating = Number(event.target.value);
  state.limit = 60;
  renderAssets();
});
$('#workflow-filter').addEventListener('change', event => {
  state.workflow = event.target.value;
  state.limit = 60;
  renderAssets();
});
function clearAssetModeHighlight() {
  clearTimeout(assetModeHighlightTimer);
  assetModeHighlight?.classList.remove('asset-view-located');
  assetModeHighlight = null;
}
function selectMode(list) {
  if (state.list === list || !isAssetView()) return;
  clearAssetModeHighlight();
  const id = state.selected;
  const grid = $('#asset-grid');
  const cardSelector = id ? `.asset-card[data-id="${CSS.escape(id)}"]` : null;
  if (cardSelector && !grid.querySelector(cardSelector) && displayedAssetRows.some(asset => asset.id === id)) {
    state.assetWindowAnchor = id;
  }
  state.list = list;
  libraryPreferences.setItem('nexus-list-mode', String(list));
  renderAssets();
  const card = cardSelector && grid.querySelector(cardSelector);
  if (!card) return;
  const scroll = $('#browser-scroll');
  const box = card.getBoundingClientRect();
  scroll.scrollTop += box.top - scroll.getBoundingClientRect().top - scroll.clientTop +
    (box.height - scroll.clientHeight) / 2;
  assetModeHighlight = card;
  card.classList.add('asset-view-located');
  assetModeHighlightTimer = setTimeout(clearAssetModeHighlight, 1600);
}
$('#grid-view').addEventListener('click', () => selectMode(false));
$('#list-view').addEventListener('click', () => selectMode(true));
function renderGridSize() {
  const grid = $('#asset-grid');
  const control = $('#view-density');
  const custom = control.querySelector('[value="custom"]');
  grid.dataset.density = state.density;
  grid.classList.toggle('custom-zoom', Boolean(state.gridZoom));
  grid.style.setProperty('--grid-zoom-width', state.gridZoom ? `${state.gridZoom}px` : '');
  custom.textContent = state.gridZoom ? `自定 · ${Math.round(state.gridZoom)} px` : '自定';
  control.value = state.gridZoom ? 'custom' : state.density;
  control.disabled = state.list;
}
$('#view-density').addEventListener('change', event => {
  if (event.target.value === 'custom') return;
  state.density = event.target.value;
  state.gridZoom = 0;
  libraryPreferences.setItem('nexus-grid-density', state.density);
  libraryPreferences.removeItem(gridZoomKey);
  renderGridSize();
});
$('#browser-scroll').addEventListener('wheel', event => {
  if ((!event.ctrlKey && !event.metaKey) || state.list || !isAssetView()) return;
  event.preventDefault();
  if (!event.deltaY) return;
  const scroll = event.currentTarget;
  const card = event.target.closest('.asset-card');
  const grid = $('#asset-grid');
  const previous = state.gridZoom || grid.firstElementChild?.getBoundingClientRect().width
    || parseFloat(getComputedStyle(grid).getPropertyValue('--card-min'));
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1);
  const scale = Math.exp(Math.min(.35, Math.max(-.35, -delta / 1100)));
  const width = Math.min(gridZoomLimits.max, Math.max(gridZoomLimits.min, previous * scale));
  if (width === state.gridZoom) return;
  const anchor = card?.getBoundingClientRect();
  state.gridZoom = width;
  renderGridSize();
  if (anchor) scroll.scrollTop += card.getBoundingClientRect().top - anchor.top;
  libraryPreferences.setItem(gridZoomKey, String(width));
}, {passive: false});
$('#asset-grid').addEventListener('click', event => {
  if (event.target.closest('[data-native-drag]')) {
    toast('按住这个手柄，把资产拖到其他桌面软件');
  }
});
$('#asset-grid').addEventListener('click', event => {
  const star = event.target.closest('[data-favorite]');
  if (star) return favorite(star.dataset.favorite).catch(error);
  const checkbox = event.target.closest('[data-mark]');
  if (checkbox) return toggleMark(checkbox.dataset.mark, event.shiftKey);
  const card = event.target.closest('[data-id]');
  if (!card) return;
  if (event.shiftKey || event.ctrlKey || event.metaKey) return toggleMark(card.dataset.id, event.shiftKey);
  selectAsset(card.dataset.id).catch(error);
});
$('#asset-grid').addEventListener('dblclick', event => {
  if (event.target.closest('button')) return;
  const card = event.target.closest('[data-id]');
  if (card) showQuickPreview(card.dataset.id);
});
$('#asset-grid').addEventListener('keydown', event => {
  if (event.target.closest('button') || !['Enter',' '].includes(event.key)) return;
  const card = event.target.closest('[data-id]');
  if (!card) return;
  event.preventDefault();
  selectAsset(card.dataset.id).catch(error);
  showQuickPreview(card.dataset.id);
});
$('#select-visible').addEventListener('click', () => {
  for (const card of $$('#asset-grid .asset-card')) markedAssets.add(card.dataset.id);
  updateMarks();
});
$('#clear-selection').addEventListener('click', () => {
  markedAssets.clear();
  markedAnchor = null;
  updateMarks();
});
$('#detail-favorite').addEventListener('click',()=>favorite(state.selected).catch(error));$('#clear-filters').addEventListener('click',()=>resetFilters());$('#load-more').addEventListener('click',()=>{state.limit+=60;renderAssets();});
for (const id of ['#asset-name', '#asset-tag-input', '#asset-notes', '#asset-rating', '#asset-workflow']) {
  $(id).addEventListener('input', () => { editor.dirty = true; });
}

function setConflict(message) {
  $('#team-edit-conflict-message').textContent = message;
  $('#team-edit-conflict').classList.toggle('hidden', !message);
}

async function writeMetadata(asset, patch, revision = asset.revision) {
  if (!isTeamAsset(asset)) {
    Object.assign(asset, await api('patch_asset', {id: asset.id, patch}));
    navSummary = null;
    return;
  }
  const result = await api('team_edit', {id: asset.id, patch: {...patch, revision}});
  const current = assetsById.get(asset.id);
  if (current && current.revision <= result.revision) {
    const {name, tags, notes, rating, workflow, revision: serverRevision, editedBy} = result;
    Object.assign(current, {name, tags, notes, rating, workflow, revision: serverRevision, editedBy});
    navSummary = null;
  }
  if ((patch.rating !== undefined && (result.rating || 0) !== patch.rating) ||
      (patch.workflow !== undefined && (result.workflow || 'unset') !== patch.workflow)) {
    if (editor.id === asset.id) editor.revision = result.revision;
    throw Error('团队服务需要更新到 0.5 才支持评分和工作流状态，其余填写项已同步');
  }
}

$('#save-metadata').addEventListener('click', async () => {
  const asset = selected();
  if (!asset) return;
  const button = $('#save-metadata');
  button.disabled = true;
  editor.saving = true;
  const fields = ['#asset-name', '#asset-tag-input', '#asset-notes'].map($);
  fields.forEach(field => { field.readOnly = true; });
  const choiceFields = ['#asset-rating', '#asset-workflow'].map($);
  choiceFields.forEach(field => { field.disabled = true; });
  const patch = {
    name: $('#asset-name').value,
    tags: $('#asset-tag-input').value.split(/[,，]/),
    notes: $('#asset-notes').value,
    rating: Number($('#asset-rating').value),
    workflow: $('#asset-workflow').value,
  };
  try {
    await writeMetadata(asset, patch, editor.revision);
    if (editor.id === asset.id) editor.dirty = false;
    renderNav();
    renderAssets();
    renderInspector(false);
    toast(isTeamAsset(asset) ? '已保存到团队资产库' : '资产信息已保存');
  } catch (e) {
    const message = String(e?.message || e);
    if (isTeamAsset(asset) && message.includes('同事已更新')) {
      setConflict('同事更新了这项资产。你可以先复制草稿，再载入最新资料。');
    }
    error(e);
  } finally {
    editor.saving = false;
    button.disabled = !selected();
    fields.forEach(field => { field.readOnly = false; });
    choiceFields.forEach(field => { field.disabled = false; });
  }
});
$('#wireframe').addEventListener('click',()=>{preview.wire=!preview.wire;$('#wireframe').classList.toggle('active',preview.wire);preview.draw();});$('#fit-preview').addEventListener('click',()=>preview.reset());
$('#target-session').addEventListener('change',updateSend);
$('#send-asset').addEventListener('click', async () => {
  const asset = selected();
  const session = state.sessions.find(item => item.id === $('#target-session').value);
  if (!asset) return;
  if (!session) {
    dccConnections.show();
    return;
  }
  if (usesC4dSceneDialog(session, asset)) {
    try { c4dDropImport.show([asset.id], session.id); }
    catch (failure) { error(failure); }
    return;
  }
  $('#send-asset').disabled = true;
  try {
    const job = await queueAsset(asset, session);
    if (!state.jobs.some(item => item.id === job.id)) state.jobs.unshift(job);
    renderNav();
    toast('已发送到 DCC，等待实际导入结果');
  } catch (failure) { error(failure); }
  finally { updateSend(); }
});
const smartMapKeywords = initSmartMapKeywords();
const c4dImportPreferences = initC4dImportPreferences({
  api, native, scope:libraryScope,
  openCacheSettings: () => {
    showSmartImportSettings();
    $('#c4d-import-clear-cache').scrollIntoView({block:'nearest'});
  },
});
const smartImportDialog = $('#smart-import-dialog');
const smartImportForm = $('#smart-import-form');
let savingSmartImport = false;

function showSmartImportSettings(section = 'general') {
  const options = smartOptions();
  for (const [name, selector] of Object.entries(smartFields)) $(selector).value = options[name] ?? '';
  smartMapKeywords.load(options.map_keywords);
  openDialog('#smart-import-dialog');
  c4dImportPreferences.open(section);
  return smartImportDialog;
}

$('#smart-import-settings').addEventListener('click', () => showSmartImportSettings());
smartImportDialog.addEventListener('cancel', event => {
  if (savingSmartImport) event.preventDefault();
});
smartImportForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (savingSmartImport) return;
  const {valid, keywords} = smartMapKeywords.read();
  if (!valid) {
    c4dImportPreferences.showSection('pbr');
    smartImportForm.querySelector('[aria-invalid="true"]')?.focus();
    return;
  }
  const options = Object.fromEntries(Object.entries(smartFields).map(([name, selector]) => [name, $(selector).value]));
  if (keywords) options.map_keywords = keywords;
  savingSmartImport = true;
  const controls = [...smartImportForm.querySelectorAll('button, input, select, textarea')].filter(control => !control.disabled);
  controls.forEach(control => { control.disabled = true; });
  try {
    await c4dImportPreferences.save();
    libraryPreferences.setItem(smartKey, JSON.stringify(options));
    smartImportDialog.close();
  } catch (failure) { c4dImportPreferences.showError(failure); }
  finally {
    savingSmartImport = false;
    controls.forEach(control => { control.disabled = false; });
    if (smartImportDialog.open) $('#smart-import-save').focus({preventScroll:true});
  }
});
$('#reveal-file').addEventListener('click',()=>api('reveal_asset',{id:state.selected}).catch(error));
const dccConnections = initDccConnections({
  hosts: dccs,
  native,
  viewportPlacement: nativeDragOut,
  api,
  getSessions: () => state.sessions,
  escape,
  icon,
  toast,
  open: () => openDialog('#connections-dialog'),
  openImportSettings: showSmartImportSettings,
  onUpdates: teamAssetMessages.setDccUpdates,
});
const topTools = $('#top-tools');
function closeTopTools(restoreFocus = false) {
  if (!topTools.open) return;
  topTools.open = false;
  if (restoreFocus) topTools.querySelector('summary').focus({preventScroll: true});
}
document.addEventListener('pointerdown', event => {
  if (!topTools.contains(event.target)) closeTopTools();
});
topTools.addEventListener('focusout', event => {
  if (event.relatedTarget && !topTools.contains(event.relatedTarget)) closeTopTools();
});
topTools.addEventListener('keydown', event => {
  if (event.key === 'Escape' && topTools.open) {
    event.stopPropagation();
    closeTopTools(true);
  }
});
$('#browser-capture-settings').addEventListener('click', () => closeTopTools(true));
$('#asset-type-preferences').addEventListener('click', () => {
  closeTopTools(true);
  assetTypePreferences.show();
});
for (const selector of ['#settings', '#connection-summary']) {
  $(selector).addEventListener('click', () => {
    closeTopTools(true);
    dccConnections.show();
  });
}
const nexusUpdater = initNexusUpdater({api,enabled:native,panel:$('#nexus-updater'),indicator:$('#about-button')});
let aboutTeamVersionRequest = 0;
for (const id of ['#about-button', '#sidebar-version']) {
  $(id).addEventListener('click', () => {
    closeTopTools(true);
    openDialog('#about-dialog');
    nexusUpdater.opened();
    showTeamServiceVersion();
  });
}
async function showTeamServiceVersion() {
  const request = ++aboutTeamVersionRequest;
  const teamId = native && team.active ? team.info?.team.id : null;
  const row = $('#about-team-version-row');
  const value = $('#about-team-version');
  row.hidden = !teamId;
  value.textContent = '';
  if (!teamId) return;
  const epoch = team.epoch;
  value.textContent = '正在读取…';
  let version;
  try {
    const result = await api('team_service_info', {teamId});
    version = result?.serverVersion || '版本未上报';
  } catch {
    version = '暂时无法读取';
  }
  if (request !== aboutTeamVersionRequest) return;
  if (!team.active || team.epoch !== epoch || team.info?.team.id !== teamId) {
    row.hidden = true;
    return;
  }
  value.textContent = version;
}
async function showClientVersion() {
  const version = $('#about-version');
  if (!native) {
    version.textContent = '开发预览';
    return;
  }
  try {
    const number = await window.__TAURI__.app.getVersion();
    version.textContent = number;
    $('#sidebar-version').textContent = '版本 ' + number;
  } catch {
    version.textContent = '无法读取版本号';
  }
}
showClientVersion();
for (const selector of ['#import-button', '#add-library-small']) {
  $(selector).addEventListener('click', () => showAssetImport());
}
$$('.close-modal').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
let pickedFolderPaths = null;
let folderScan = null;
let teamImportDraft = null;

function setTeamImportPaths(paths) {
  teamImportDraft.paths = paths;
  $('#team-import-path').value = paths.join('\n');
  updateImportSubmit();
}

function showAssetImport(paths = []) {
  const inTeam = team.active;
  $('#import-title').textContent = inTeam ? '导入或链接文件夹' : '导入资产';
  $('#team-import-source-fields').classList.toggle('hidden', !inTeam);
  $('#personal-import-fields').classList.toggle('hidden', inTeam);
  $('#import-cloud-mounts').classList.toggle('hidden', inTeam);
  $('#choose-files').classList.toggle('hidden', inTeam);
  $('#library-path').required = !inTeam;
  $('#team-import-path').required = inTeam;
  $('#scan-submit-label').textContent = inTeam ? '选择导入方式' : '添加文件夹';
  $('#import-description').textContent = inTeam
    ? '选择本地或 NAS 文件夹，然后选择复制素材或链接 NAS 目录。'
    : '将磁盘或已挂载 NAS 的文件夹加入资产库，保留原始文件位置和目录层级。';
  const status = $('#team-link-status');
  teamImportDraft = null;
  status.classList.add('hidden');
  if (inTeam) {
    teamImportDraft = {scope:collectionScope(), paths:[]};
    setTeamImportPaths(paths);
  }
  updateImportSubmit();
  openDialog('#import-dialog');
}

function updateImportSubmit() {
  $('#scan-submit').disabled = teamImportDraft
    ? ingestBusy || !$('#team-import-path').value.trim()
    : Boolean(folderScan);
}

$('#team-import-path').addEventListener('input', () => {
  if (teamImportDraft) teamImportDraft.paths = null;
  updateImportSubmit();
});
const folderBrowser = initFolderBrowser({
  api,
  onSelect(paths) {
    if (team.active) {
      if (teamImportDraft?.scope === collectionScope()) setTeamImportPaths(paths);
      return;
    }
    pickedFolderPaths = paths;
    $('#library-path').value = paths.join('\n');
  },
});
initBaiduCloud({
  api,
  native,
  copy: copyWorkspaceText,
  log: runtimeLog.add,
  workspace: () => ({scope:collectionScope(), teamId:team.active ? team.info.team.id : null}),
  icon,
});
const cloudMounts = initCloudMounts({
  api,
  enabled: native,
  onBrowse(directory) {
    cloudMounts.close();
    $('#library-source').value = 'mounted';
    showAssetImport();
    if (native) folderBrowser.show(team.active || directory ? [] : folderPaths(), directory);
    else $('#library-path').focus();
  },
});
$('#cloud-mounts').addEventListener('click', () => {
  closeTopTools(true);
  cloudMounts.show();
});
$('#import-cloud-mounts').addEventListener('click', cloudMounts.show);
function readImportLines(value) {
  return [...new Set(value.split('\n').map(path => path.trim()).filter(Boolean))];
}
function folderPaths() {
  return pickedFolderPaths || readImportLines($('#library-path').value);
}
function showFolderScan(message) {
  if (!folderScan) return;
  $('#import-progress').textContent = message;
  if (folderScan.scope === collectionScope()) $('#footer-status').textContent = message;
}
function importLocation(library = state.library, folder = state.folder) {
  return JSON.stringify([state.view, library, folder, state.collection, state.recursive,
    state.search, state.kind, state.formatIncludes, state.formatExcludes, state.sort, state.tag,
    state.tagIncludes, state.tagExcludes, state.rating, state.workflow,
    state.fileNameQuery, state.quickFilters]);
}

function duplicateImportMessage(result) {
  return result.duplicates ? `已跳过 ${result.duplicates} 个内容重复的文件` : '';
}

$('#library-path').addEventListener('input', () => { pickedFolderPaths = null; });
$('#choose-folder').addEventListener('click', () => {
  if (native) {
    const library = currentLibrary();
    const start = library?.path ? diskFolderPath(library, state.folder) : state.libraries.find(item => item.watching && item.path)?.path;
    folderBrowser.show(teamImportDraft ? teamImportDraft.paths ?? [] : folderPaths(), teamImportDraft ? start : null);
  }
  else $('#library-path').focus();
});
$('#choose-files').addEventListener('click', async () => {
  if (team.active) return;
  try {
    const result = await api('import_files');
    const duplicateMessage = duplicateImportMessage(result);
    if (result.found || duplicateMessage) $('#import-dialog').close();
    if (result.found) await refresh();
    const report = [result.found ? `已索引 ${result.found} 个资产文件` : '', duplicateMessage];
    if (result.failed) report.push(`${result.failed} 个文件无法读取`, result.errors?.[0]);
    const message = report.filter(Boolean).join(' · ');
    if (message) toast(message, Boolean(result.failed));
  } catch (e) { error(e); }
});
$('#import-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (team.active) {
    if (teamImportDraft?.scope !== collectionScope()) return;
    const paths = teamImportDraft.paths ?? readImportLines($('#team-import-path').value);
    if (paths.length) await handleTeamDrop(paths, {fromPicker:true}).catch(error);
    return;
  }
  const button = $('#scan-submit');
  const progress = $('#import-progress');
  const paths = folderPaths();
  if (folderScan || !paths.length) return;
  const name = paths.length === 1 ? $('#library-name').value.trim() || null : null;
  const source = $('#library-source').value;
  const scope = collectionScope();
  const location = importLocation();
  folderScan = {scope};
  const importControls = [button, $('#choose-folder'), $('#choose-files')];
  importControls.forEach(control => { control.disabled = true; });
  progress.classList.remove('hidden');
  showFolderScan('后台索引 · 正在读取 ' + paths.length + ' 个文件夹…');
  $('#import-dialog').close();
  try {
    let result;
    if (native) {
      result = await api('scan_selected_libraries', {paths, name, source});
    } else {
      result = {found:0, errors:[], libraries:[]};
      for (const path of paths) {
        try {
          const scanned = await api('scan_library', {path, name, source});
          result.found += scanned.found;
          result.errors.push(...scanned.errors);
          result.libraries.push(scanned.library);
        } catch (e) { result.errors.push(String(e?.message || e)); }
      }
    }
    if (!result.libraries.length) throw Error(result.errors[0] || '无法导入所选文件夹');
    if (scope === collectionScope()) {
      showFolderScan('后台索引 · 正在更新 ' + result.found.toLocaleString('zh-CN') + ' 项资产…');
      await refresh({render:false});
      if (scope === collectionScope()) {
        if (location === importLocation()) {
          for (const library of result.libraries) expandedFolders.add(folderKey(library.id, ''));
          openFolder(result.libraries[0].id);
        } else {
          renderNav();
          renderAssets();
          if (selected()) renderInspector(false);
        }
        renderConnections();
        if ($('#import-dialog').open) $('#import-dialog').close();
      }
    }
    toast('已加入 ' + result.libraries.length + ' 个文件夹 · ' + result.found + ' 项资产' +
      (result.errors.length ? ' · ' + result.errors[0] : ''), Boolean(result.errors.length));
  } catch (e) {
    progress.textContent = String(e?.message || e);
    error(e);
  } finally {
    folderScan = null;
    importControls.forEach(control => { control.disabled = false; });
    progress.classList.add('hidden');
    if (scope === collectionScope()) $('#footer-status').textContent = native ? '本地索引已就绪' : '界面开发预览';
  }
});

// The browser preview has a separate local store; the desktop uses SQLite.
async function collectionRequest(command, args = {}, scope = collectionScope()) {
  if (native && scope.startsWith('team:')) {
    if (scope !== collectionScope()) throw Error('团队工作空间已切换');
    return teamOrganization.request(command, args);
  }
  if (native) return api(command, {scope: scope.startsWith('personal:') ? 'personal' : scope, ...args});
  const key = 'nexus-preview-collections';
  const items = JSON.parse(localStorage.getItem(key) || '[]');
  const item = items.find(collection => collection.id === args.id);
  const name = args.name?.trim();
  let result;
  if (command === 'list_collections') return items;
  if (command === 'create_collection' || command === 'rename_collection') {
    if (!name || name.length > 100) throw Error('输入 1 至 100 个字符的合集名称');
    if (items.some(other => other.id !== args.id && other.name.toLowerCase() === name.toLowerCase())) throw Error('已存在同名合集');
  }
  if (command === 'create_collection') {
    result = {id:crypto.randomUUID(),name,assetIds:[]};
    items.push(result);
  } else {
    if (!item) throw Error('合集不存在');
    if (command === 'rename_collection') item.name = name;
    if (command === 'delete_collection') items.splice(items.indexOf(item), 1);
    if (command === 'set_collection_membership') {
      const ids = new Set(item.assetIds);
      for (const id of args.assetIds) {
        if (args.include) ids.add(id);
        else ids.delete(id);
      }
      item.assetIds = [...ids];
    }
    result = command === 'delete_collection' ? null : item;
  }
  localStorage.setItem(key, JSON.stringify(items));
  return result;
}
async function loadCollections() {
  const scope = collectionScope();
  if (native && team.active) return teamOrganization.refresh();
  const items = await collectionRequest('list_collections', {}, scope);
  if (scope !== collectionScope()) return;
  state.collections = items;
  if (!currentCollection()) state.collection = null;
  renderNav();
  renderAssets();
}
function openCollection(id) {
  if (!state.collections.some(item => item.id === id)) return;
  const rows = enterLocation('all', null, '', id);
  if (!rows.some(asset => asset.id === state.selected)) selectAsset(rows[0]?.id || null).catch(error);
}

let collectionDialog = null;
function updateCollectionForm() {
  const {mode} = collectionDialog;
  const choosing = mode === 'add' && state.collections.length > 0;
  const creating = mode === 'new' || mode === 'add' && (!choosing || !$('#collection-picker').value);
  $('#collection-picker-field').classList.toggle('hidden', !choosing);
  $('#collection-name-field').classList.toggle('hidden', !(creating || mode === 'edit'));
  $('#collection-name').required = creating || mode === 'edit';
  $('#collection-submit').textContent = mode === 'edit' ? '保存名称' : mode === 'new' ? '创建合集' : creating ? '创建并加入' : '加入合集';
}
function showCollectionDialog(mode, ids = [], collection = currentCollection()) {
  if (mode === 'edit' && !collection) return;
  collectionDialog = {mode, ids, scope:collectionScope(), id:collection?.id};
  $('#collection-dialog-title').textContent = mode === 'add' ? '加入合集' : mode === 'edit' ? '管理合集' : '新建合集';
  $('#collection-dialog-description').textContent = mode === 'add'
    ? `将 ${ids.length} 项资产的引用加入${team.active ? '团队' : ''}合集。`
    : team.active ? '团队成员可以一起整理和使用这些合集。' : '在本机整理来自不同文件夹的资产。';
  $('#collection-status').textContent = '';
  $('#collection-name').value = mode === 'edit' ? collection.name : '';
  $('#collection-picker').innerHTML = state.collections.map(item =>
    `<option value="${escape(item.id)}">${escape(item.name)}</option>`
  ).join('') + '<option value="">新建合集…</option>';
  $('#collection-delete-confirm').classList.add('hidden');
  $('#delete-collection').classList.toggle('hidden', mode !== 'edit');
  updateCollectionForm();
  openDialog('#collection-dialog');
  $('#collection-dialog').querySelector(mode === 'add' && state.collections.length ? '#collection-picker' : '#collection-name').focus();
}
$('#collections').addEventListener('click', event => {
  const item = event.target.closest('[data-collection]');
  if (item) openCollection(item.dataset.collection);
});
$('#new-collection').addEventListener('click', () => showCollectionDialog('new'));
$('#edit-collection').addEventListener('click', () => showCollectionDialog('edit'));
$('#add-to-collection').addEventListener('click', () => showCollectionDialog('add', [...markedAssets]));
$('#collect-asset').addEventListener('click', () => {
  if (selected()) showCollectionDialog('add', [state.selected]);
});
$('#collection-picker').addEventListener('change', updateCollectionForm);
$('#collection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const {mode, scope, id, ids} = collectionDialog;
  if (scope !== collectionScope()) return;
  const button = $('#collection-submit');
  button.disabled = true;
  try {
    const name = $('#collection-name').value.trim();
    if (mode === 'edit') {
      await collectionRequest('rename_collection', {id,name}, scope);
    } else {
      let target = mode === 'add' && state.collections.length ? $('#collection-picker').value : '';
      if (!target) {
        const created = await collectionRequest('create_collection', {name}, scope);
        target = created.id;
        if (mode === 'add') {
          await loadCollections();
          if (scope !== collectionScope()) return;
          const option = new Option(created.name, created.id);
          $('#collection-picker').prepend(option);
          $('#collection-picker').value = created.id;
          updateCollectionForm();
        }
      }
      if (mode === 'add') {
        await collectionRequest('set_collection_membership', {id:target,assetIds:ids,include:true}, scope);
        toast(`已加入 ${ids.length} 项资产`);
        markedAssets.clear();
      }
      if (mode === 'new') {
        await loadCollections();
        if (scope === collectionScope()) openCollection(target);
      }
    }
    await loadCollections();
    $('#collection-dialog').close();
  } catch (e) { $('#collection-status').textContent = String(e?.message || e); }
  finally { button.disabled = false; }
});
$('#delete-collection').addEventListener('click', () => $('#collection-delete-confirm').classList.remove('hidden'));
$('#confirm-delete-collection').addEventListener('click', async event => {
  const button = event.currentTarget;
  const {scope,id} = collectionDialog;
  if (scope !== collectionScope()) return;
  button.disabled = true;
  try {
    await collectionRequest('delete_collection', {id}, scope);
    if (scope !== collectionScope()) return;
    if (state.collection === id) setView('all');
    await loadCollections();
    $('#collection-dialog').close();
  } catch (e) { $('#collection-status').textContent = String(e?.message || e); }
  finally { button.disabled = false; }
});
const tagDialog = $('#tag-dialog');
let tagDraft = null;
function showTagDialog(mode, name = '') {
  const deleting = mode === 'delete';
  tagDraft = {mode, name, scope:collectionScope()};
  $('#tag-dialog-title').textContent = mode === 'create' ? '新建标签' : mode === 'rename' ? '重命名标签' : '删除标签';
  $('#tag-name-field').classList.toggle('hidden', deleting);
  $('#tag-name').required = !deleting;
  $('#tag-name').value = name;
  $('#tag-description').classList.toggle('hidden', !deleting);
  $('#tag-description').textContent = deleting ? `从资产库及使用此标签的资产上移除「${name}」。源文件会保留。` : '';
  $('#tag-status').textContent = '';
  $('#tag-submit').textContent = mode === 'create' ? '创建标签' : mode === 'rename' ? '保存名称' : '删除标签';
  $('#tag-submit').classList.toggle('primary', !deleting);
  $('#tag-submit').classList.toggle('danger', deleting);
  openDialog('#tag-dialog');
  if (deleting) tagDialog.querySelector('.modal-footer .close-modal').focus();
  else $('#tag-name').select();
}
$('#new-tag').addEventListener('click', () => showTagDialog('create'));
$('#tag-suggestion-groups').addEventListener('click', async event => {
  const button = event.target.closest('button[data-tag-suggestion]');
  const groups = event.currentTarget;
  if (!native || !button || groups.disabled) return;
  const name = button.dataset.tagSuggestion;
  const draft = {mode:'create', name:'', scope:collectionScope()};
  const restoreFocus = document.activeElement === button;
  groups.disabled = true;
  try {
    await saveTag(draft, name);
  } catch (failure) {
    error(failure);
  } finally {
    groups.disabled = false;
    if (restoreFocus && draft.scope === collectionScope() && document.activeElement === document.body) {
      const created = $$('#sidebar-tags [data-tag]').find(item => item.dataset.tag === name);
      (created || groups.querySelector('button') || $('#new-tag')).focus();
    }
  }
});

async function saveTag(draft, nextName) {
  const {mode, name, scope} = draft;
  const command = team.active ? `team_${mode}_tag` : `${mode}_local_tag`;
  const result = await api(command, mode === 'create' ? {name:nextName} : mode === 'rename' ? {name,newName:nextName} : {name});
  if (scope !== collectionScope()) return;
  if (state.tag === name) state.tag = mode === 'rename' ? result.name : null;
  if (mode !== 'create') {
    const previous = name.toLowerCase();
    for (const field of ['tagIncludes', 'tagExcludes']) {
      state[field] = [...new Set(state[field].flatMap(tag => tag !== previous ? [tag]
        : mode === 'rename' ? [result.name.toLowerCase()] : []))];
    }
  }
  if (mode !== 'delete' && result.name) {
    const parts = result.name.split('/');
    const expanded = openTagGroups.get(scope);
    if (expanded) for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/') + '/');
    if (!result.name.toLocaleLowerCase().includes($('#tag-search').value.trim().toLocaleLowerCase())) $('#tag-search').value = '';
  }
  if (tagDraft === draft) tagDialog.close();
  if (mode === 'create' && result.name) {
    const key = result.name.toLowerCase();
    state.definedTags = [...state.definedTags.filter(tag => tag.toLowerCase() !== key), result.name];
    navSummary = null;
    renderTags();
  } else {
    await (team.active ? refreshTeam(true) : refresh());
  }
  if (scope === collectionScope()) toast(mode === 'delete' ? '已删除标签' : mode === 'rename' ? '已重命名标签' : result.created === false ? '此标签已存在' : '已创建标签');
}

$('#tag-form').addEventListener('submit', async event => {
  event.preventDefault();
  const draft = tagDraft;
  const button = $('#tag-submit');
  if (!draft || draft.scope !== collectionScope() || button.disabled) return;
  const {mode} = draft;
  const nextName = $('#tag-name').value.trim();
  const status = $('#tag-status');
  status.textContent = '';
  if (mode !== 'delete' && (!nextName || Array.from(nextName).length > 40)) {
    status.textContent = '请输入 1–40 个字符的标签名称';
    return;
  }
  button.disabled = true;
  try {
    await saveTag(draft, nextName);
  } catch (failure) {
    if (tagDraft === draft && tagDialog.open) status.textContent = String(failure?.message || failure);
    else error(failure);
  } finally { button.disabled = false; }
});

$('#remove-from-collection').addEventListener('click', async event => {
  const collection = currentCollection();
  if (!collection || !markedAssets.size) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const scope = collectionScope();
    await collectionRequest('set_collection_membership', {id:collection.id,assetIds:[...markedAssets],include:false}, scope);
    if (scope !== collectionScope()) return;
    markedAssets.clear();
    await loadCollections();
    if (state.collection === collection.id && !filtered().some(asset => asset.id === state.selected)) {
      await selectAsset(filtered()[0]?.id || null);
    }
  } catch (e) { error(e); }
  finally { button.disabled = false; }
});

let quickSequence = 0;
let quickAssets = [];
let quickIndex = 0;
const quickVideo = $('#quick-preview-video');
const quickVideoPlayer = $('#quick-video-player');
const quickVideoControls = initVideoControls(quickVideoPlayer, quickVideo);
const quickPlayer = $('#quick-open-player');
const quickMessage = $('#quick-preview-message');
const quickDialog = $('#quick-preview-dialog');
const quickImagePreview = initQuickImagePreview({viewport:$('#quick-preview-image-viewport'), image:$('#quick-preview-image')});
let quickVideoFallback;
let quickBufferTimer;
function resetQuickVideo() {
  clearTimeout(quickBufferTimer);
  quickVideoFallback = null;
  quickVideoPlayer.classList.add('hidden');
  quickPlayer.classList.add('hidden');
  quickVideo.removeAttribute('poster');
  if (quickVideo.hasAttribute('src')) {
    quickVideo.pause();
    quickVideo.removeAttribute('src');
    quickVideo.load();
  }
  quickVideoControls.reset();
}
function playQuickVideo(url) {
  quickVideo.src = url;
  quickVideoPlayer.classList.remove('hidden');
  quickVideoControls.refresh();
  // The open action is user-initiated. Keep the controls usable if autoplay is blocked.
  quickVideo.play().catch(() => {});
}
function showQuickPreview(id) {
  const asset = assetsById.get(id);
  if (!asset) return;
  runtimeLog.add(`打开快速预览 · ${asset.name}`);
  videoHover?.stop();
  quickAssets = displayedAssetRows.map(item => item.id);
  quickIndex = quickAssets.indexOf(id);
  if (quickIndex < 0) {
    quickAssets = [id];
    quickIndex = 0;
  }
  openDialog('#quick-preview-dialog');
  renderQuickPreview();
}
async function renderQuickPreview() {
  const serial = ++quickSequence;
  const asset = assetsById.get(quickAssets[quickIndex]);
  const canvas = $('#quick-preview-canvas');
  const message = $('#quick-preview-message');
  canvas.classList.add('hidden');
  quickImagePreview.reset();
  resetQuickVideo();
  $('#quick-preview-tools').classList.add('hidden');
  $('#quick-position').textContent = `${quickIndex+1} / ${quickAssets.length}`;
  $('#quick-previous').disabled = quickIndex === 0;
  $('#quick-next').disabled = quickIndex === quickAssets.length - 1;
  $('#quick-preview-title').textContent = asset?.name || '资产已不在当前索引';
  $('#quick-preview-caption').textContent = asset ? `${asset.ext.toUpperCase()} · ${displayAssetType(asset)} · ${bytes(asset.size)}` : '';
  if (!asset || isTeamAsset(asset) && !asset.teamMounted) {
    message.textContent = asset ? '请先链接团队共享文件夹' : '可以预览其他资产';
    return;
  }
  message.textContent = '正在加载预览…';
  if (asset.kind === 'video' && native) {
    quickPlayer.classList.remove('hidden');
    quickVideoPlayer.classList.remove('hidden');
    const poster = thumbCache.get(asset.id);
    if (poster) quickVideo.poster = poster;
    try {
      const {path, url} = await prepareVideoSource(asset);
      if (serial !== quickSequence) return;
      const fallback = window.__TAURI__.core.convertFileSrc(path);
      quickVideoFallback = url && url !== fallback ? fallback : null;
      playQuickVideo(url || fallback);
    } catch (failure) {
      if (serial === quickSequence) message.textContent = String(failure?.message || failure);
    }
    return;
  }
  let meshError;
  if (meshCapable(asset)) {
    try {
      const payload = await api('read_preview', {id:asset.id,mode:'mesh'});
      if (serial !== quickSequence) return;
      canvas.classList.remove('hidden');
      const stats = loadMesh(quickRenderer, payload, asset);
      $('#quick-preview-caption').textContent += ` · ${stats.faces.toLocaleString()} 面 · 拖动旋转，滚轮缩放`;
      $('#quick-preview-tools').classList.remove('hidden');
      message.textContent = '';
      return;
    } catch (e) { meshError = e; }
  }
  if (serial !== quickSequence) return;
  canvas.classList.add('hidden');
  try {
    const payload = await api('read_preview', {id:asset.id,mode:'large'});
    if (serial !== quickSequence) return;
    if (payload?.url) {
      quickImagePreview.show(payload.url);
      $('#quick-preview-caption').textContent += ' · 滚轮缩放，按住中键平移';
      message.textContent = '';
    } else {
      message.textContent = meshError ? String(meshError?.message || meshError) : '此资产暂无可显示的预览';
    }
  } catch (e) {
    if (serial === quickSequence) message.textContent = String(e?.message || e);
  }
}
function nextQuick(step) {
  const next = quickIndex + step;
  if (next < 0 || next >= quickAssets.length) return;
  quickIndex = next;
  renderQuickPreview();
}
$('#open-preview').addEventListener('click', () => showQuickPreview(state.selected));
let quickBackdropPress = false;
function isQuickBackdrop(event) {
  if (event.target !== quickDialog || event.button !== 0) return false;
  const bounds = quickDialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX >= bounds.right ||
    event.clientY < bounds.top || event.clientY >= bounds.bottom;
}
quickDialog.addEventListener('pointerdown', event => { quickBackdropPress = isQuickBackdrop(event); });
quickDialog.addEventListener('pointercancel', () => { quickBackdropPress = false; });
quickDialog.addEventListener('click', event => {
  const close = quickBackdropPress && isQuickBackdrop(event);
  quickBackdropPress = false;
  if (close) quickDialog.close();
});
quickDialog.addEventListener('close', () => {
  quickSequence++;
  quickBackdropPress = false;
  quickImagePreview.reset();
  resetQuickVideo();
});
quickDialog.addEventListener('keydown', event => {
  if (quickVideoPlayer.contains(event.target)) return;
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  nextQuick(event.key === 'ArrowLeft' ? -1 : 1);
});
$('#quick-previous').addEventListener('click', () => nextQuick(-1));
$('#quick-next').addEventListener('click', () => nextQuick(1));
quickPlayer.addEventListener('click', () => {
  const id = quickAssets[quickIndex];
  if (assetsById.get(id)?.kind === 'video') api('open_asset_video', {id}).catch(error);
});
function clearQuickBuffer() {
  clearTimeout(quickBufferTimer);
  if (quickVideo.hasAttribute('src') && !quickVideo.error) quickMessage.textContent = '';
}
for (const event of ['loadeddata', 'canplay', 'playing', 'pause']) {
  quickVideo.addEventListener(event, clearQuickBuffer);
}
quickVideo.addEventListener('waiting', () => {
  clearTimeout(quickBufferTimer);
  if (!quickVideo.currentTime || quickVideo.paused) return;
  quickBufferTimer = setTimeout(() => { quickMessage.textContent = '正在缓冲视频…'; }, 280);
});
quickVideo.addEventListener('error', () => {
  if (!quickVideo.hasAttribute('src')) return;
  clearTimeout(quickBufferTimer);
  if (quickVideoFallback) {
    const fallback = quickVideoFallback;
    quickVideoFallback = null;
    playQuickVideo(fallback);
    return;
  }
  quickVideoPlayer.classList.add('hidden');
  quickVideoControls.reset();
  quickMessage.textContent = '无法在这里播放，请用系统播放器打开';
});
$('#quick-wireframe').addEventListener('click', event => {
  quickRenderer.wire = !quickRenderer.wire;
  event.currentTarget.setAttribute('aria-pressed', String(quickRenderer.wire));
  quickRenderer.draw();
});
$('#quick-reset').addEventListener('click', () => quickRenderer.reset());

let appliedLibraryScope;
function loadLibraryPreferences() {
  const scope = libraryScope();
  if (appliedLibraryScope === scope) return;
  appliedLibraryScope = scope;
  c4dImportPreferences.checkCacheSize();
  workbenchTabs.resetScope();
  const zoom = Number(libraryPreferences.getItem(gridZoomKey));
  const density = libraryPreferences.getItem('nexus-grid-density');
  const sort = libraryPreferences.getItem('nexus-asset-sort');
  const resolution = Number(libraryPreferences.getItem(thumbnailSizeKey));
  state.list = libraryPreferences.getItem('nexus-list-mode') === 'true';
  state.density = ['compact', 'normal', 'large'].includes(density) ? density : 'normal';
  state.gridZoom = zoom >= gridZoomLimits.min && zoom <= gridZoomLimits.max ? zoom : 0;
  state.sort = [...$('#sort').options].some(option => option.value === sort) ? sort : 'added';
  state.recursive = libraryPreferences.getItem('nexus-include-descendants') !== 'false';
  $('#sort').value = state.sort;
  $('#include-descendants').checked = state.recursive;
  folderSearch.value = '';
  $('#tag-search').value = '';
  expandedFolders.clear();
  thumbnailSize = Number.isInteger(resolution) && resolution >= 128 && resolution <= 1024 ? resolution : 256;
  resetThumbnails();
  workspaceLayout?.reload?.();
  sidebarZones?.reload?.();
  assetFilterToolbar.reload?.();
}

function updateWorkspaceLabel() {
  updateFolderEditToggle();
  const name = team.active ? team.info?.team.name : personalWorkspace.name;
  const scopeLabel = !team.active && personalWorkspace.id === 'personal' && name === '默认个人库' ? '个人库' : name;
  $('#workspace-badge').textContent = scopeLabel;
  $('#import-button-label').textContent = team.active ? '导入或链接' : '导入资产';
  $('#add-library-small').title = team.active ? '链接文件夹' : '添加资产目录';
  $('#add-library-small').setAttribute('aria-label', $('#add-library-small').title);
  $('#workspace-settings').title = name;
  for (const view of ['subscriptions', 'sites']) {
    const tab = $(`#workspace-tools-nav [data-view="${view}"]`);
    tab.title = `${names[view]} · ${scopeLabel}`;
    tab.setAttribute('aria-label', tab.title);
  }
  $('#team-sync-controls').classList.toggle('hidden', !team.active);
  $('#team-folder-settings').classList.toggle('hidden', !team.active);
  $('#team-profile-option').classList.toggle('hidden', !team.active);
  const favoriteTab = $('#main-nav [data-view="favorites"]');
  favoriteTab.title = viewLabel('favorites');
  favoriteTab.setAttribute('aria-label', favoriteTab.title);
  favoriteTab.querySelector('.folder-label').textContent = favoriteTab.title;
  $('#workspace-opening-view option[value="favorites"]').textContent = favoriteTab.title;
}

const profileDialog = $('#team-profile-dialog');
const profileName = $('#team-profile-name');
const profileStatus = $('#team-profile-status');
let profileDraft = null;

function currentProfile(draft) {
  return profileDialog.open && draft === profileDraft && team.active && draft.epoch === team.epoch;
}

function renderProfile() {
  const draft = profileDraft;
  if (!draft) return;
  const ready = draft.ready && !draft.busy;
  profileName.disabled = !ready;
  $('#team-profile-pick').disabled = !ready;
  $('#team-profile-clear').disabled = !ready;
  $('#team-profile-clear').classList.toggle('hidden', !draft.avatarUrl);
  $('#team-profile-save').disabled = !ready;
  drawAvatar($('#team-profile-avatar'), draft.avatarUrl, Array.from(profileName.value.trim())[0] || '?');
}

async function showTeamProfile() {
  if (!native || !team.active || profileDialog.open) return;
  closeTopTools(true);
  const draft = {epoch:team.epoch, avatarUrl:null, avatarAction:'keep', ready:false, busy:false};
  profileDraft = draft;
  profileName.value = team.info.member.name;
  profileStatus.textContent = '正在读取资料…';
  renderProfile();
  openDialog('#team-profile-dialog');
  try {
    const data = await api('team_get_profile');
    if (!currentProfile(draft)) return;
    profileName.value = data.name;
    draft.avatarUrl = data.avatarUrl;
    draft.ready = true;
    profileStatus.textContent = '';
    renderProfile();
    profileName.focus();
  } catch (failure) {
    if (currentProfile(draft)) profileStatus.textContent = String(failure?.message || failure);
  }
}

$('#team-profile-option').addEventListener('click', showTeamProfile);
$('#online-members').addEventListener('click', event => { if (event.target.closest('[data-team-profile]')) showTeamProfile(); });
profileDialog.addEventListener('close', () => { profileDraft = null; });
profileName.addEventListener('input', () => {
  if (profileDraft && !profileDraft.avatarUrl) renderProfile();
});
$('#team-profile-pick').addEventListener('click', async () => {
  const draft = profileDraft;
  if (!draft?.ready || draft.busy || !currentProfile(draft)) return;
  draft.busy = true;
  profileStatus.textContent = '';
  renderProfile();
  try {
    const avatarUrl = await api('team_pick_avatar');
    if (!currentProfile(draft) || !avatarUrl) return;
    if (!isAvatarUrl(avatarUrl)) throw Error('无法读取选中的头像');
    draft.avatarUrl = avatarUrl;
    draft.avatarAction = 'replace';
  } catch (failure) {
    if (currentProfile(draft)) profileStatus.textContent = String(failure?.message || failure);
  } finally {
    draft.busy = false;
    if (currentProfile(draft)) renderProfile();
  }
});
$('#team-profile-clear').addEventListener('click', () => {
  if (!profileDraft?.ready || profileDraft.busy) return;
  Object.assign(profileDraft, {avatarUrl:null, avatarAction:'remove'});
  renderProfile();
});
$('#team-profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const draft = profileDraft;
  if (!draft?.ready || draft.busy || !currentProfile(draft)) return;
  const name = profileName.value.trim();
  if (!name) { profileStatus.textContent = '请输入团队昵称'; profileName.focus(); return; }
  draft.busy = true;
  profileStatus.textContent = '正在保存资料…';
  renderProfile();
  try {
    const result = await api('team_save_profile', {name, avatarAction:draft.avatarAction,
      avatarUrl:draft.avatarAction === 'replace' ? draft.avatarUrl : null});
    if (!currentProfile(draft)) return;
    team.info.member.name = result.name;
    profileDialog.close();
    toast('团队资料已保存');
    if (team.presencePending) await team.presencePending.catch(() => {});
    if (team.epoch === draft.epoch) await refreshTeamPresence();
  } catch (failure) {
    if (currentProfile(draft)) profileStatus.textContent = String(failure?.message || failure);
  } finally {
    draft.busy = false;
    if (currentProfile(draft)) renderProfile();
  }
});

let teamSetupMode = 'join';
let hostedTeam;
let hostedTeamBusy = false;
let hostedStatusRequest = 0;
let nasTeamBusy = false;
let nasExportDirectory = null;

async function readHostedTeam() {
  const request = ++hostedStatusRequest;
  try {
    const status = await api('hosted_team_status');
    if (request === hostedStatusRequest) hostedTeam = status;
  } catch (e) {
    if (request === hostedStatusRequest && teamSetupMode !== 'join') {
      $('#team-dialog-status').textContent = String(e?.message || e);
    }
  }
  if (request === hostedStatusRequest && $('#team-dialog').open) renderTeamSettings();
}

function openTeamDialog() {
  if (!native) {
    toast('请使用 Nexus Windows 或 macOS 桌面端连接团队。');
    return;
  }
  $('#team-dialog-status').textContent = '';
  teamSetupMode = 'join';
  renderTeamSettings();
  openDialog('#team-dialog');
  readHostedTeam();
}
$('#team-folder-settings').addEventListener('click', () => {
  closeTopTools(true);
  openTeamDialog();
});

function linkedTeamFolderName(library, folder) {
  return folder.split('/').at(-1) || library.name;
}

function renderTeamFolderRow(library, folder, {linked, hidden, canDisconnect, canRescan}) {
  const name = linkedTeamFolderName(library, folder);
  const path = diskFolderPath(library, folder) || folder || '尚未链接源文件夹';
  const detail = hidden ? ' · 已移出团队库' : folder ? '' : library.watching ? ' · 服务端定期扫描' : ' · 手动重扫';
  const rowAttrs = `data-team-library="${escape(library.id)}" data-folder="${escape(folder)}"`;
  return `<div class="team-library-row ${folder ? 'team-library-child' : ''}">
    <div class="team-library-info"><strong>${escape(name)}</strong><small>${escape(path + detail)}</small></div>
    <div class="team-library-actions">
      ${findFolder(folderTrees.get(library.id), folder) ? `<button type="button" class="button subtle" ${rowAttrs} data-open-team-folder aria-label="打开 ${escape(name)}">打开</button>` : ''}
      ${canRescan ? `<button type="button" class="button subtle" data-rescan-library="${escape(library.id)}">重扫共享库</button>` : ''}
      ${linked ? `<button type="button" class="button subtle" ${rowAttrs} data-remove-team-link aria-label="移除链接记录 ${escape(name)}">移除记录</button>` : ''}
      ${canDisconnect ? `<button type="button" class="button subtle" data-disconnect-team-library="${escape(library.id)}" aria-label="移出团队库 ${escape(name)}">移出团队库</button>` : ''}
    </div>
  </div>`;
}

function renderTeamSettings() {
  const creating = teamSetupMode === 'create';
  const nas = teamSetupMode === 'nas';
  const joining = teamSetupMode === 'join';
  $('#team-join-mode').textContent = team.active ? '当前团队' : '加入已有团队';
  $('#team-join-mode').setAttribute('aria-pressed', String(joining));
  $('#team-create-mode').setAttribute('aria-pressed', String(creating));
  $('#team-nas-mode').setAttribute('aria-pressed', String(nas));
  for (const id of ['#team-join-mode', '#team-create-mode', '#team-nas-mode', '#team-host-create', '#team-host-start', '#team-host-share']) {
    $(id).disabled = hostedTeamBusy || nasTeamBusy;
  }
  $('#team-open-existing').classList.toggle('hidden', !joining || !team.configured || team.active);
  $('#team-go-personal').disabled = nasTeamBusy || hostedTeamBusy;
  $('#team-disconnect').classList.toggle('hidden', !team.configured);
  $('#team-disconnect').disabled = nasTeamBusy || hostedTeamBusy;
  $('#team-connect-form').classList.toggle('hidden', !joining || team.active);
  $('#team-manage').classList.toggle('hidden', !joining || !team.active);
  $('#team-nas-setup').classList.toggle('hidden', !nas);
  $('#team-nas-export').disabled = nasTeamBusy || !hostedTeam;
  $('#team-nas-join-option').classList.toggle('hidden', !hostedTeam);
  $('#team-nas-connect').disabled = nasTeamBusy || !team.configured;
  $('#team-nas-open-export').classList.toggle('hidden', !nasExportDirectory);
  $('#team-host-setup').classList.toggle('hidden', !creating);
  $('#team-host-form').classList.toggle('hidden', Boolean(hostedTeam));
  $('#team-host-existing').classList.toggle('hidden', !hostedTeam);
  if (hostedTeam) {
    $('#team-host-details').textContent = hostedTeam.teamName + ' · ' + hostedTeam.url +
      (hostedTeam.running ? ' · 运行中' : ' · 未启动');
    $('#team-host-start').textContent = hostedTeam.running ? '进入本机团队' : '启动并进入团队';
  }
  if (!joining || !team.active) return;
  const {member} = team.info;
  const canPublishSnapshot = member.role === 'admin' && !team.allLibraries.some(library => library.watching);
  const hiddenRoots = new Set(team.sharedHiddenFolders.filter(rule => !rule.folder).map(rule => rule.libraryId));
  const linkedByLibrary = new Map();
  for (const {libraryId, folder} of team.linkedFolders) {
    if (!linkedByLibrary.has(libraryId)) linkedByLibrary.set(libraryId, new Set());
    linkedByLibrary.get(libraryId).add(folder);
  }
  const canDisconnect = canManageSharedFolders();
  $('#team-member').textContent = member.name;
  $('#team-publish-form').classList.toggle('hidden', !canPublishSnapshot);
  $('#team-library-list').innerHTML = team.allLibraries.flatMap(library => {
    const hidden = hiddenRoots.has(library.id);
    const links = linkedByLibrary.get(library.id);
    const rows = [];
    if (!hidden || links?.size) {
      rows.push(renderTeamFolderRow(library, '', {linked:links?.has(''), hidden,
        canDisconnect:!hidden && canDisconnect, canRescan:!hidden && canPublishSnapshot && library.path}));
    }
    for (const folder of links || []) {
      if (folder) rows.push(renderTeamFolderRow(library, folder, {linked:true, hidden}));
    }
    return rows;
  }).join('') || '<p class="modal-description">还没有连接团队文件夹。</p>';
}

function setTeamSyncStatus(message) {
  if ($('#team-sync-status').textContent !== message) $('#team-sync-status').textContent = message;
  if (team.active) $('#footer-status').textContent = message;
}

function previewChanged(before, after) {
  return !before || !after || before.path !== after.path || before.modified !== after.modified ||
    before.size !== after.size || before.thumbnail !== after.thumbnail;
}

function invalidateCover(id) {
  coverRevisions.set(id, (coverRevisions.get(id) || 0) + 1);
  thumbCacheBytes -= thumbCache.get(id)?.length || 0;
  thumbCache.delete(id);
  videoThumbnailRetry.delete(id);
}

async function refreshTeamCovers() {
  if (!team.active || team.coversPending) return;
  const epoch = team.epoch;
  const task = api('team_cover_revisions');
  team.coversPending = task;
  try {
    const next = new Map(Object.entries(await task));
    if (epoch !== team.epoch) return;
    const affected = new Set([...next.keys(), ...team.covers.keys()]);
    let changed = false;
    let selectedChanged = false;
    for (const id of affected) {
      if (next.get(id) === team.covers.get(id) && next.has(id) === customCovers.has(id)) continue;
      if (next.has(id)) customCovers.add(id);
      else customCovers.delete(id);
      invalidateCover(id);
      changed = true;
      selectedChanged ||= state.selected === id;
    }
    team.covers = next;
    if (changed) renderAssets();
    if (selectedChanged) renderInspector().catch(error);
  } catch {
    // Preserve previously known covers while the shared volume is unavailable.
  } finally {
    if (team.coversPending === task) team.coversPending = null;
  }
}

function applyTeamCatalog(data, { force = false, entering = false } = {}) {
  const previousRevision = team.revision;
  const previousName = team.info?.team.name;
  const previousScope = collectionScope();
  const oldSelected = selected();
  team.info = { team: data.team, member: data.member };
  team.revision = data.revision;
  team.folderVisibility = data.folderVisibility === true;
  const scopeChanged = previousScope !== collectionScope();
  if (scopeChanged) {
    loadLibraryPreferences();
    team.removedFolders = readTeamFolderRemovals();
    creativeSubscriptions.setWorkspace();
    teamOrganization.refresh();
    workspaceNavigation.refreshTeamQuickAccess();
  }

  if (data.assets) {
    state.definedTags = data.definedTags || [];
    const previous = assetsById;
    for (const asset of data.assets) {
      if (force || previewChanged(previous.get(asset.id), asset)) {
        thumbCacheBytes -= thumbCache.get(asset.id)?.length || 0;
        thumbCache.delete(asset.id);
      }
    }
    team.catalog = {assets: data.assets, libraries: data.libraries};
    team.allLibraries = data.allLibraries || data.libraries;
    team.sharedHiddenFolders = data.hiddenFolders || [];
    team.linkedFolders = data.linkedFolders || [];
  }
  if (team.catalog && (data.assets || scopeChanged)) {
    refreshVisibleTeamCatalog();
    // Keep a removed asset's draft on screen until the member switches selection.
    const asset = selected();
    if (!asset && editor.dirty && editor.id === state.selected) {
      setConflict('这项资产已从团队目录移除。你可以复制草稿。');
      $('#save-metadata').disabled = true;
      $('#send-asset').disabled = true;
      $('#reveal-file').disabled = true;
    } else {
      if (!asset) state.selected = state.library ? filtered()[0]?.id || null : null;
      renderInspector(Boolean(state.library) && (force || previewChanged(oldSelected, selected()))).catch(error);
    }
    renderNav();
    renderAssets();
    teamAssetMessages.render();
    if ($('#team-dialog').open) renderTeamSettings();
  }
  updateWorkspaceLabel();
  if (previousName !== data.team.name) {
    localStorage.setItem('nexus-team-name', data.team.name);
    renderLocation();
  }
  if (!entering && previousRevision !== null && previousRevision !== data.revision) {
    setTeamSyncStatus('团队库已更新 · ' + new Date().toLocaleTimeString('zh-CN'));
  } else if (entering || force || team.fromLocalIndex || $('#team-sync-status').dataset.offline === 'yes') {
    setTeamSyncStatus('已同步 · ' + new Date().toLocaleTimeString('zh-CN'));
  }
  $('#team-sync-status').dataset.offline = 'no';
}

function enterTeam(data, {cached = false} = {}) {
  priorTeamOrganization = null;
  team.active = true;
  team.configured = true;
  team.epoch++;
  teamAssetMessages.reset();
  team.online = [];
  team.presencePending = null;
  team.presenceUnsupported = false;
  team.covers = new Map();
  team.coversPending = null;
  customCovers.clear();
  renderTeamPresence();
  team.revision = null;
  team.fromLocalIndex = cached;
  state.selected = null;
  state.collections = [];
  state.definedTags = [];
  team.info = {team:data.team,member:data.member};
  team.catalog = null;
  team.allLibraries = [];
  team.sharedHiddenFolders = [];
  team.linkedFolders = [];
  team.folderVisibility = false;
  team.removedFolders = readTeamFolderRemovals();
  editor.dirty = false;
  loadLibraryPreferences();
  setView(workspaceOpeningView(libraryPreferences));
  applyTeamCatalog(data, { force: true, entering: true });
  refreshTeamCovers();
  if (cached) {
    setTeamSyncStatus('已加载本地索引');
    runtimeLog.add(`加载团队本地索引完成 · ${data.assets?.length || 0} 项资产`);
  }
  refreshTeamPresence();
  teamAssetMessages.refresh();
  workspaceNavigation.refreshTeamQuickAccess();
  loadCollections().catch(error);
  localStorage.setItem('nexus-workspace', 'team');
  localStorage.setItem('nexus-team-name', data.team.name);
  $('#team-dialog').close();
}

async function readTeamWorkspace() {
  const cached = await api('team_cached_catalog').catch(() => null);
  return cached ? {catalog:cached, cached:true} : {catalog:await api('team_catalog', {since:null})};
}

async function openTeamWorkspace() {
  const saved = await readTeamWorkspace();
  enterTeam(saved.catalog, saved);
}

async function openPersonal() {
  team.active = false;
  team.epoch++;
  teamAssetMessages.reset();
  team.online = [];
  renderTeamPresence();
  team.catalog = null;
  team.allLibraries = [];
  team.sharedHiddenFolders = [];
  team.linkedFolders = [];
  team.folderVisibility = false;
  team.removedFolders = [];
  editor.dirty = false;
  state.selected = null;
  state.collections = [];
  state.definedTags = [];
  teamOrganization.refresh();
  loadLibraryPreferences();
  updateWorkspaceLabel();
  setView(workspaceOpeningView(libraryPreferences));
  localStorage.setItem('nexus-workspace', 'local');
  await refresh();
  await loadCollections();
  await renderInspector(false);
  $('#team-dialog').close();
}

async function refreshTeam(force = false) {
  if (!team.active) return;
  if (team.pending) {
    if (!force) return team.pending;
    await team.pending.catch(() => {});
    if (team.pending) return refreshTeam(force);
  }
  if (!team.active) return;
  const epoch = team.epoch;
  const task = (async () => {
    try {
      const data = await api('team_catalog', {since: force ? null : team.revision});
      if (team.active && team.epoch === epoch) {
        const revisionChanged = data.revision !== team.revision;
        applyTeamCatalog(data, {force});
        team.fromLocalIndex = false;
        if (revisionChanged && !force) refreshTeamCovers();
      }
    } catch (e) {
      if (team.active && team.epoch === epoch) {
        $('#team-sync-status').dataset.offline = 'yes';
        setTeamSyncStatus('同步失败 · 显示上次同步的资产');
        if (force) error(e);
      }
      throw e;
    }
  })();
  team.pending = task;
  try { await task; } finally {
    if (team.pending === task) team.pending = null;
  }
}

async function refreshCurrentWorkspace() {
  closeAssetMenu(true);
  if (team.active) {
    await refreshTeam(true).catch(() => {});
    await refreshTeamCovers();
    await Promise.all([workspaceNavigation.refreshTeamQuickAccess(), teamOrganization.refresh()]);
    if (team.presenceUnsupported) {
      team.presenceUnsupported = false;
      refreshTeamPresence();
    }
  } else await refresh().catch(error);
}

$('#team-link-directory').addEventListener('click', () => {
  $('#team-dialog').close();
  showAssetImport();
});
$('#team-refresh').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await Promise.all([refreshCurrentWorkspace(), teamAssetMessages.refresh()]); }
  finally { button.disabled = false; }
});
$('#team-go-personal').addEventListener('click', () => openPersonal().catch(error));
$('#team-open-existing').addEventListener('click', async () => {
  const button = $('#team-open-existing');
  button.disabled = true;
  try { await openTeamWorkspace(); }
  catch (e) { $('#team-dialog-status').textContent = String(e?.message || e); }
  finally { button.disabled = false; }
});
$('#team-disconnect').addEventListener('click', async () => {
  try {
    await api('team_disconnect');
    team.configured = false;
    team.info = null;
    localStorage.removeItem('nexus-team-name');
    await openPersonal();
  } catch (e) { error(e); }
});
$('#team-connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#team-connect-button');
  button.disabled = true;
  $('#team-dialog-status').textContent = '正在连接…';
  try {
    const url = $('#team-url').value.trim();
    const token = $('#team-token').value.trim();
    const allowLanHttp = $('#team-allow-lan').checked;
    const name = $('#team-join-name').value.trim() || null;
    const data = token
      ? await api('team_connect', {url, token, allowLanHttp})
      : await api('team_join_by_address', {url, name, allowLanHttp});
    $('#team-token').value = '';
    enterTeam(data);
    toast('已连接 ' + data.team.name);
  } catch (e) { $('#team-dialog-status').textContent = String(e?.message || e); }
  finally { button.disabled = false; }
});

$('#team-join-mode').addEventListener('click', () => {
  teamSetupMode = 'join';
  $('#team-dialog-status').textContent = '';
  renderTeamSettings();
});
$('#team-create-mode').addEventListener('click', () => {
  teamSetupMode = 'create';
  $('#team-dialog-status').textContent = '';
  renderTeamSettings();
  readHostedTeam();
});
$('#team-nas-mode').addEventListener('click', () => {
  teamSetupMode = 'nas';
  $('#team-dialog-status').textContent = '';
  $('#team-nas-details').textContent = nasExportDirectory || '';
  renderTeamSettings();
  readHostedTeam();
});

async function runNasTeam(operation) {
  if (nasTeamBusy) return;
  nasTeamBusy = true;
  const status = $('#team-dialog-status');
  status.textContent = '';
  renderTeamSettings();
  try { await operation(status); }
  catch (failure) { status.textContent = String(failure?.message || failure); }
  finally {
    nasTeamBusy = false;
    renderTeamSettings();
  }
}
$('#team-nas-export').addEventListener('click', () => {
  if (!$('#team-nas-form').reportValidity() || !hostedTeam) return;
  const url = $('#team-nas-url').value.trim();
  const addressJoin = $('#team-nas-address-join').checked;
  runNasTeam(async status => {
    status.textContent = '正在导出团队数据库和 NAS 部署文件…';
    const result = await api('export_team_for_nas', {teamId: hostedTeam.teamId, url, addressJoin});
    status.textContent = result ? '已导出。请在 NAS 的 Docker 中部署，再回来切换地址。' : '';
    if (result) {
      nasExportDirectory = result.directory;
      $('#team-nas-details').textContent = result.directory;
      $('#team-nas-url').value = result.url;
      $('#team-nas-allow-lan').checked = true;
    }
  });
});
$('#team-nas-open-export').addEventListener('click', () => {
  if (nasExportDirectory) api('open_folder_location', {path: nasExportDirectory}).catch(error);
});
$('#team-nas-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = $('#team-nas-url').value.trim();
  const allowLanHttp = $('#team-nas-allow-lan').checked;
  runNasTeam(async status => {
    status.textContent = '正在验证 NAS 上的团队和成员身份…';
    const data = await api('team_reconnect_nas', {url, allowLanHttp});
    $('#team-url').value = url;
    $('#team-allow-lan').checked = allowLanHttp;
    teamSetupMode = 'join';
    enterTeam(data);
    toast('已切换到 NAS 团队「' + data.team.name + '」');
  });
});

async function enterHostedTeam(command, args = {}) {
  if (hostedTeamBusy) return;
  hostedTeamBusy = true;
  ++hostedStatusRequest;
  renderTeamSettings();
  const status = $('#team-dialog-status');
  status.textContent = command === 'create_hosted_team' ? '正在创建团队并启动服务…' : '正在启动本机团队服务…';
  try {
    const local = await api(command, args);
    const catalog = await api('team_connect', {url:local.url, token:local.token, allowLanHttp:local.allowLanHttp});
    $('#team-url').value = local.url;
    $('#team-allow-lan').checked = local.allowLanHttp;
    $('#team-token').value = '';
    teamSetupMode = 'join';
    enterTeam(catalog);
    toast('已进入团队「' + catalog.team.name + '」');
  } catch (e) {
    status.textContent = String(e?.message || e);
  } finally {
    hostedTeamBusy = false;
    renderTeamSettings();
    readHostedTeam();
  }
}

$('#team-host-form').addEventListener('submit', event => {
  event.preventDefault();
  enterHostedTeam('create_hosted_team', {
    teamName: $('#team-host-name').value.trim(),
    adminName: $('#team-host-admin').value.trim(),
    listen: $('#team-host-listen').value.trim() || null,
  });
});
$('#team-host-start').addEventListener('click', () => enterHostedTeam('start_hosted_team'));
$('#team-host-share').addEventListener('click', () => {
  if (!hostedTeam) return;
  copyWorkspaceText(hostedTeam.url).then(() => toast('已复制团队地址')).catch(error);
});

let publishLibrary = null;
let publishing = false;
$('#team-library-list').addEventListener('click', event => {
  if (!team.active) return;
  const button = event.target.closest('[data-team-library]');
  if (button) {
    const {teamLibrary:libraryId, folder} = button.dataset;
    const library = team.allLibraries.find(item => item.id === libraryId);
    if (!library) return;
    if (button.hasAttribute('data-open-team-folder')) {
      if (!findFolder(folderTrees.get(libraryId), folder)) return;
      $('#team-dialog').close();
      openFolder(libraryId, folder);
    } else if (team.linkedFolders.some(link => link.libraryId === libraryId && link.folder === folder)) {
      showTeamUnlinkConfirmation({libraryId, folder, name:linkedTeamFolderName(library, folder)});
    }
    return;
  }
  const disconnect = event.target.closest('[data-disconnect-team-library]');
  if (disconnect && canManageSharedFolders()) {
    const library = team.allLibraries.find(item => item.id === disconnect.dataset.disconnectTeamLibrary);
    if (library) showTeamUnlinkConfirmation({libraryId:library.id, folder:'', name:library.name, disconnect:true});
    return;
  }
  const rescan = event.target.closest('[data-rescan-library]');
  if (rescan && !publishing) {
    const library = team.allLibraries.find(item => item.id === rescan.dataset.rescanLibrary);
    if (library?.path) publishTeamLibrary(library.id, library.name, library.path).catch(error);
  }
});
$('#team-pick-publish').addEventListener('click', async () => {
  try { const path = await api('pick_folder'); if (path) $('#team-publish-path').value = path; }
  catch (e) { error(e); }
});

async function publishTeamLibrary(id, name, path) {
  if (publishing) return;
  publishing = true;
  const button = $('#team-publish-save');
  button.disabled = true;
  $('#team-publish-progress').textContent = '正在扫描共享文件夹…';
  try {
    const result = await api('team_publish', {libraryId: id, name, path});
    await refreshTeam(true);
    const suffix = result.skipped ? `，跳过 ${result.skipped} 项` : '';
    $('#team-dialog-status').textContent = `已扫描 ${result.found} 项资产${suffix}`;
    $('#team-publish-progress').textContent = '发布相对路径和元数据，素材保留在共享目录。';
  } catch (e) {
    $('#team-publish-progress').textContent = String(e?.message || e);
    throw e;
  } finally {
    button.disabled = false;
    publishing = false;
  }
}
$('#team-publish-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (publishing) return;
  const name = $('#team-publish-name').value.trim();
  const path = $('#team-publish-path').value.trim();
  if (!name || !path) return;
  if (!publishLibrary || publishLibrary.path !== path) publishLibrary = { id: crypto.randomUUID(), path };
  try {
    await publishTeamLibrary(publishLibrary.id, name, path);
    publishLibrary = null;
    $('#team-publish-form').reset();
  } catch (e) { error(e); }
});
$('#team-reload-asset').addEventListener('click', async () => {
  if (!editor.dirty || !selected()) return;
  try {
    await refreshTeam(true);
    if (!selected()) return;
    editor.dirty = false;
    $('#save-metadata').disabled = false;
    await renderInspector(false);
  } catch { /* Keep the draft when the refresh fails. */ }
});
if (native) {
  window.__TAURI__.event.listen('team-scan-progress', event => {
    $('#team-publish-progress').textContent = `已扫描 ${event.payload} 项，正在建立共享索引…`;
  });
  setInterval(() => {
    if (team.active && !document.hidden) {
      refreshTeam().catch(() => {});
      teamAssetMessages.refresh();
      workspaceNavigation.refreshTeamQuickAccess();
      teamOrganization.refresh();
    }
  }, 8000);
  setInterval(refreshTeamPresence, 10_000);
  document.addEventListener('visibilitychange', () => {
    if (team.active && !document.hidden) {
      refreshTeam().catch(() => {});
      refreshTeamPresence();
      teamAssetMessages.refresh();
      workspaceNavigation.refreshTeamQuickAccess();
      teamOrganization.refresh();
    }
  });
}

function draggedIds(id) {
  return (markedAssets.has(id) ? [...markedAssets] : [id]).filter(assetId => assetsById.has(assetId));
}

function whiteboardMediaIds(ids) {
  return ids.filter(id => isWhiteboardReferenceMedia(assetsById.get(id)));
}

async function copyWhiteboardMediaReferences(assetIds) {
  await copyWorkspaceText(encodeWhiteboardAssetClipboard(collectionScope(), assetIds));
  toast(`已复制 ${assetIds.length} 项媒体引用，可在白板中粘贴`);
}

async function batchAssets(ids, operation, label) {
  const scope = collectionScope();
  let done = 0;
  const failures = [];
  const assets = assetsById;
  for (const id of ids) {
    if (scope !== collectionScope()) {
      failures.push('工作空间已切换');
      break;
    }
    const asset = assets.get(id);
    if (!asset) {
      failures.push('找不到资产');
      continue;
    }
    try {
      await operation(asset);
      done += 1;
    } catch (e) {
      failures.push(asset.name + ' · ' + (e?.message || e));
    }
  }
  const count = failures.length;
  toast(label + ' ' + done + ' 项' + (count ? '，' + count + ' 项未处理 · ' + failures[0] : ''), count > 0);
}

async function copyFiles(ids) {
  if (!native) return;
  const scope = collectionScope();
  const inTeam = team.active;
  const result = await api(inTeam ? 'copy_workspace_files' : 'copy_asset_files', {ids});
  if (!result) return;
  if (result.indexed && scope === collectionScope()) {
    if (inTeam) await refreshTeam(true).catch(() => {});
    else await refresh();
  }
  const warning = result.indexErrors?.[0];
  toast('已复制 ' + result.copied + ' 个文件到 ' + result.folder + (warning ? ' · 索引失败 ' + warning : ''), Boolean(warning));
}

async function checkFiles(ids) {
  if (!native || !ids.length) return;
  const scope = collectionScope();
  const command = team.active ? 'check_workspace_files' : 'check_asset_files';
  const button = $('#check-files');
  button.disabled = true;
  try {
    let missing = 0;
    let unavailable = 0;
    for (let offset = 0; offset < ids.length; offset += 250) {
      const assetIds = ids.slice(offset, offset + 250);
      const result = await api(command, {ids: assetIds});
      if (scope !== collectionScope()) return;
      for (const id of assetIds) fileStates.delete(id);
      for (const id of result.missing) fileStates.set(id, 'missing');
      for (const id of result.unavailable) fileStates.set(id, 'unavailable');
      missing += result.missing.length;
      unavailable += result.unavailable.length;
    }
    renderAssets();
    renderInspector(false);
    const summary = `检查了 ${ids.length} 项 · ${missing} 项缺失 · ${unavailable} 项无法访问`;
    runtimeLog.add(summary);
    toast(summary, Boolean(missing || unavailable));
  } finally {
    button.disabled = false;
  }
}

async function relinkFile(id) {
  if (!native || team.active) return;
  const result = await api('relink_asset_file', {id});
  if (!result) return;
  fileStates.delete(id);
  thumbCacheBytes -= thumbCache.get(id)?.length || 0;
  thumbCache.delete(id);
  if (!team.active) {
    await refresh();
    if (!team.active && state.selected === id) await renderInspector();
  }
  toast('已重新关联「' + result.name + '」');
}

async function changeCover(id, clear) {
  if (!native) return;
  const result = await api('change_asset_cover', {id, clear});
  if (result === null) return;
  await updateCover(id, result);
}

async function updateCover(id, result) {
  const asset = assetsById.get(id);
  if (!asset) return;
  if (result) customCovers.add(id);
  else customCovers.delete(id);
  invalidateCover(id);
  if (!state.library) {
    const revision = coverRevisions.get(id);
    const url = await readThumbnail(asset, thumbnailSize, false).catch(() => null);
    if (coverRevisions.get(id) !== revision || previewChanged(asset, assetsById.get(id))) return;
    cacheThumbnailResult(asset, url, false);
  }
  renderAssets();
  if (state.selected === id) await renderInspector();
  if (team.active) refreshTeamCovers();
  toast(result ? '资产封面已更新' : '已恢复自动封面');
}
const screenshotCover = initScreenshotCover({api, windows: nativeDragOut, onSaved: id => updateCover(id, true)});

const versionsDialog = $('#versions-dialog');
let versionAsset = null;

async function loadVersions(asset) {
  const versions = await api('list_asset_versions', {id: asset.id});
  if (asset !== versionAsset || !versionsDialog.open) return;
  $('#versions-list').innerHTML = versions.map(version => '<li><div class="version-description"><strong>版本 ' +
    escape(version.version) + (version.note ? ' · ' + escape(version.note) : '') + '</strong><span>' +
    date(version.created) + ' · ' + bytes(version.size) + '</span></div><button type="button" class="button subtle" data-export-version="' +
    escape(version.id) + '">另存副本</button></li>').join('');
  $('#version-status').textContent = versions.length ? '' : '暂无已保存的文件版本';
}

async function showVersions(id) {
  if (!native) return;
  const asset = assetsById.get(id);
  if (!asset || (isTeamAsset(asset) && !asset.teamMounted)) return;
  versionAsset = asset;
  $('#version-asset-name').textContent = asset.name;
  $('#versions-list').replaceChildren();
  $('#version-note').value = '';
  $('#version-status').textContent = '正在加载文件版本…';
  $('#create-version').disabled = Boolean(fileStates.get(id));
  openDialog('#versions-dialog');
  await loadVersions(asset);
}

versionsDialog.addEventListener('close', () => { versionAsset = null; });
$('#versions-form').addEventListener('submit', async event => {
  event.preventDefault();
  const asset = versionAsset;
  if (!asset) return;
  const button = $('#create-version');
  button.disabled = true;
  $('#version-status').textContent = '正在保存文件版本…';
  try {
    await api('create_asset_version', {id: asset.id, note: $('#version-note').value});
    if (asset === versionAsset) {
      $('#version-note').value = '';
      await loadVersions(asset);
    }
  } catch (e) {
    if (asset === versionAsset) $('#version-status').textContent = String(e?.message || e);
  } finally {
    if (asset === versionAsset) button.disabled = Boolean(fileStates.get(asset.id));
  }
});
$('#versions-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-export-version]');
  const asset = versionAsset;
  if (!button || !asset) return;
  button.disabled = true;
  try {
    const result = await api('export_asset_version', {id: asset.id, versionId: button.dataset.exportVersion});
    if (result) toast('已另存版本到 ' + result.path);
  } catch (e) {
    error(e);
  } finally {
    button.disabled = false;
  }
});

$('#check-files').addEventListener('click', () => checkFiles(
  markedAssets.size ? [...markedAssets] : filtered().map(asset => asset.id)
).catch(error));

function compareAssets(ids) {
  const set = new Set(ids);
  assetCompare.show(state.assets.filter(asset => set.has(asset.id)));
}

async function assetAIImage(asset) {
  if (isTeamAsset(asset) && !asset.teamMounted || fileStates.has(asset.id)) return;
  const url = thumbCache.get(asset.id) || await readThumbnail(asset, 512, false);
  if (typeof url !== 'string' || url.length > 2 * 1024 * 1024 || !/^data:image\/(jpeg|png|webp);base64,/.test(url)) return;
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', {alpha:false});
  if (!context) return;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .84);
}

const assetAI = initAssetAI({
  dialog:$('#asset-ai-dialog'), api,
  getAsset:id => assetsById.get(id),
  scope:collectionScope,
  getImage:assetAIImage,
  async apply(asset, patch) {
    if (editor.id === asset.id && (editor.dirty || editor.saving)) throw Error('请先保存详情中的编辑');
    await writeMetadata(asset, patch);
  },
  onApplied() {
    renderNav();
    renderAssets();
    if (!editor.dirty && !editor.saving) renderInspector(false).catch(error);
  },
  openDownload:() => api('subscription_open', {url:'https://ollama.com/download'}),
  log:runtimeLog.add,
});
$('#batch-asset-ai').addEventListener('click', () => assetAI.show([...markedAssets]));

let batchEdit;
function showBatchMetadata(ids) {
  if (!ids.length) return;
  batchEdit = {ids, scope: collectionScope()};
  $('#batch-metadata-count').textContent = '将更改应用到所选的 ' + ids.length + ' 项资产。新增标签会保留现有标签。';
  $('#batch-metadata-form').reset();
  openDialog('#batch-metadata-dialog');
}

$('#compare-assets').addEventListener('click', () => compareAssets([...markedAssets]));
$('#batch-metadata').addEventListener('click', () => showBatchMetadata([...markedAssets]));
$('#batch-metadata-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!batchEdit || batchEdit.scope !== collectionScope()) return;
  const {ids, scope} = batchEdit;
  const tags = $('#batch-tags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
  const rating = $('#batch-rating').value;
  const workflow = $('#batch-workflow').value;
  if (!tags.length && !rating && !workflow) return toast('填写一个标签、评分或工作流状态');
  const button = $('#batch-metadata-submit');
  button.disabled = true;
  try {
    await batchAssets(ids, async asset => {
      if (editor.id === asset.id && (editor.dirty || editor.saving)) throw Error('请先保存详情中的编辑');
      const patch = {};
      if (tags.length) patch.tags = [...new Set([...asset.tags, ...tags])];
      if (rating) patch.rating = Number(rating);
      if (workflow) patch.workflow = workflow;
      await writeMetadata(asset, patch);
    }, '已更新');
    if (collectionScope() === scope) {
      renderNav();
      renderAssets();
      renderInspector(false);
    }
    $('#batch-metadata-dialog').close();
  } finally {
    button.disabled = false;
  }
});

async function sendAssets(ids, sessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) throw Error('目标 DCC 实例已离线');
  if (ids.some(id => usesC4dSceneDialog(session, assetsById.get(id)))) {
    return c4dDropImport.show(ids, sessionId);
  }
  await batchAssets(ids, async asset => {
    if (!canUseSmartImport(session, asset) && !compat[session.dcc]?.includes(asset.ext)) throw Error('不支持 .' + asset.ext);
    const job = await queueAsset(asset, session);
    if (!state.jobs.some(item => item.id === job.id)) state.jobs.unshift(job);
  }, '已进入 ' + (dccs[session.dcc]?.name || session.dcc) + ' 导入队列');
  renderNav();
  if (state.view === 'jobs') renderJobs();
}

async function addAssetTag(asset, tag) {
  if (asset.tags.includes(tag)) return;
  if (editor.id === asset.id && (editor.dirty || editor.saving)) {
    throw Error('请先保存详情中的编辑');
  }
  await writeMetadata(asset, {tags: [...asset.tags, tag]});
}

async function dropAssets(target, ids, scope) {
  if (!ids.length) return;
  if (target.dataset.teamMessageRecipient || target.hasAttribute('data-team-message-overflow')) {
    const member = team.active && team.online.find(item => item.id === target.dataset.teamMessageRecipient && !item.self);
    if (member) await teamAssetMessages.send(member, ids);
    return;
  }
  if (target.id === 'new-collection') return showCollectionDialog('add', ids);
  if (target.dataset.collection) {
    const id = target.dataset.collection;
    const collection = state.collections.find(item => item.id === id);
    if (!collection) return;
    await collectionRequest('set_collection_membership', {id, assetIds: ids, include: true}, scope);
    if (scope === collectionScope()) await loadCollections();
    toast('已将 ' + ids.length + ' 项资产加入「' + collection.name + '」');
    return;
  }
  if (target.dataset.dropSession) return sendAssets(ids, target.dataset.dropSession);
  if (target.dataset.tag) {
    const tag = target.dataset.tag;
    await batchAssets(ids, asset => addAssetTag(asset, tag), '已归入标签「' + tag + '」');
  } else {
    await batchAssets(ids, asset => asset.favorite ? undefined : setFavorite(asset, true), '已收藏');
  }
  if (scope !== collectionScope()) return;
  renderNav();
  renderAssets();
  renderInspector(false);
}

function onlinePlacementHosts(assetIds = null) {
  if (!nativeDragOut) return [];
  const assets = assetIds?.map(id => assetsById.get(id));
  const names = new Set();
  for (const session of state.sessions) {
    if (session.placement !== true || !dccs[session.dcc]) continue;
    if (assets && !assets.every(asset => asset && !fileStates.has(asset.id) && compat[session.dcc]?.includes(asset.ext) &&
      (!isTeamAsset(asset) || asset.teamMounted))) continue;
    names.add(dccs[session.dcc].name);
  }
  return [...names];
}

const c4dDropImport = initC4dDropImport({
  asset: id => assetsById.get(id),
  assets: library => assetsByLibrary.get(library) || [],
  session: id => state.sessions.find(item => item.id === id),
  isUsable: asset => !fileStates.has(asset.id) && (!isTeamAsset(asset) || asset.teamMounted),
  supports: (asset, target) => canUseSmartImport(target, asset) || compat.c4d.includes(asset.ext),
  scope: collectionScope,
  defaultRenderer: () => smartOptions().renderer,
  async queue(asset, sessionId, scene, options) {
    const session = state.sessions.find(item => item.id === sessionId);
    if (!session) throw Error('目标 Cinema 4D 已离线');
    const saved = smartOptions();
    const job = await api('queue_import', {assetId:asset.id, sessionId, workspace:libraryScope(),
      smartOptions:canUseSmartImport(session, asset) ? (scene ? {...saved, kind:'scene', lod:null, ...options} : saved) : null});
    if (!state.jobs.some(item => item.id === job.id)) state.jobs.unshift(job);
    renderJobCount();
    if (state.view === 'jobs') renderJobs();
    return job;
  },
  notify: toast,
  showJobs: () => setView('jobs'),
  showConnections: () => dccConnections.show(),
  openWeb: openWebsite,
});

const workspaceDrag = initWorkspaceDrag({
  dropSelector: '#collections [data-collection], #new-collection, #main-nav [data-view="favorites"], #sidebar-tags [data-tag], [data-drop-session], [data-team-message-recipient], [data-team-message-overflow]',
  scope: collectionScope,
  allowExternalDrag: nativeDragOut,
  waitForExternalDrag: () => api('wait_asset_drag_exit'),
  draggedIds,
  outgoingHint(ids) {
    const c4dOptions = state.sessions.some(session => ids.some(id => usesC4dSceneDialog(session, assetsById.get(id))));
    const hosts = onlinePlacementHosts(ids).filter(host => !c4dOptions || host !== dccs.c4d.name);
    return [c4dOptions ? '拖到 Cinema 4D 后选择导入选项' : '',
      hosts.length ? '拖到 ' + hosts.join(' / ') + ' 视口放置' : ''].filter(Boolean).join(' · ');
  },
  marked: () => new Set(markedAssets),
  mark(ids) {
    if (ids.size === markedAssets.size && [...ids].every(id => markedAssets.has(id))) return;
    markedAssets.clear();
    for (const id of ids) markedAssets.add(id);
    markedAnchor = null;
    updateMarks();
  },
  async dragOut(assetIds) {
    closeAssetMenu();
    if (!nativeDragOut || !assetIds.length) return;
    const scope = collectionScope();
    const result = await api('start_asset_drag', {assetIds});
    if (result.bridgeRequired) {
      if (scope === collectionScope()) {
        runtimeLog.add(result.bridgeRequired, 'error');
        dccConnections.show();
      }
      return;
    }
    const messages = [];
    if (result.placement === true) {
      const host = dccs[result.placementHost]?.name || 'DCC';
      messages.push(host + ' 视口已接收。按视口提示调整资产，左键放置。');
    }
    if (result.skipped.length) {
      const first = result.skipped[0];
      const name = assetsById.get(first.id)?.name;
      messages.push('跳过 ' + result.skipped.length + ' 项 · ' + (name ? name + ' · ' : '') + first.error);
    }
    if (result.c4dImport) {
      if (scope !== collectionScope()) throw Error('工作空间已切换，请重新拖动资产');
      const {sessionId, assetIds: reachedIds} = result.c4dImport;
      c4dDropImport.show(reachedIds, sessionId);
      if (messages.length) runtimeLog.add(messages.join(' · '), 'error');
    } else if (messages.length) {
      toast(messages.join(' · '), Boolean(result.skipped.length));
    } else if (result.releasedBeforeStart && assetIds.some(id => assetsById.get(id)?.ext === 'max')) {
      error('文件刚准备好，拖放已结束。请重新拖动，或在资产详情点「选择导入选项」。');
    }
  },
  drop: dropAssets,
  onError: error,
});

const assetRecycle = initAssetRecycle({
  api,
  context() {
    if (!native) return null;
    const teamId = team.active ? team.info?.team?.id : null;
    if (team.active && !teamId) return null;
    return {
      scope: collectionScope(),
      epoch: team.epoch,
      workspace: teamId ?? personalWorkspace.id,
      teamId,
      name: teamId ? team.info.team.name : personalWorkspace.name,
    };
  },
  asset: id => assetsById.get(id),
  validateMove(ids) {
    if (ids.includes(editor.id) && (editor.dirty || editor.saving)) throw Error('请先保存资产详情中的编辑');
  },
  async refreshCatalog(context, ids) {
    if (!assetRecycle.current(context)) return;
    if (context.teamId) {
      await team.pending?.catch(() => {});
      if (assetRecycle.current(context)) await refreshTeam();
    } else {
      await refresh();
    }
    if (assetRecycle.current(context) && ids.includes(state.selected) && !selected()) await selectAsset(null);
  },
  notify: toast,
});
const recycleBinButton = $('#open-recycle-bin');
recycleBinButton.classList.toggle('hidden', !native);
recycleBinButton.addEventListener('click', () => {
  closeTopTools(true);
  assetRecycle.openBin();
});

const assetMenu = $('#asset-menu');
const pinterestLens = $('#pinterest-lens-dialog');
const pinterestLensImage = $('#pinterest-lens-image');
let pinterestLensRequest = 0;
let menuCard = null;
let workspaceMenuActions = null;
let creatorMenuLink = '';
let menuView = null;
function closeAssetMenu(restoreFocus = false) {
  assetMenu.classList.add('hidden');
  if (restoreFocus) {
    const anchor = menuCard?.isConnected ? menuCard : menuCard?.matches('.asset-card')
      ? $$('#asset-grid .asset-card').find(card => card.dataset.id === menuCard.dataset.id) : null;
    anchor?.focus({preventScroll:true});
  }
  menuCard = null;
  workspaceMenuActions = null;
  creatorMenuLink = '';
  menuView = null;
}

function renderAssetMenuRows() {
  const {sections, context, label, section, query, x, y} = menuView;
  const term = value => value.normalize('NFKC').toLowerCase();
  const terms = term(query.trim()).split(/\s+/).filter(Boolean);
  const submenus = context?.submenus || {};
  const active = terms.length ? [...sections, ...Object.values(submenus).map(group => group.section)]
    : section ? [submenus[section].section] : sections;
  const result = [];
  for (const [name, entries] of active) {
    const matching = terms.length ? entries.filter(([action, , text]) =>
      !action.startsWith('group:') && terms.every(part => term(name + ' ' + text).includes(part))) : entries;
    if (matching.length) result.push([name, matching]);
  }
  const itemCount = result.reduce((count, [, entries]) => count + entries.length, 0);
  // Reserve the header, search and paging rows, including the group dividers.
  const pageSize = Math.max(1, Math.min(12, Math.floor((innerHeight - 105) / 35)));
  const pageCount = Math.max(1, Math.ceil(itemCount / pageSize));
  menuView.page = Math.min(menuView.page, pageCount - 1);
  let offset = menuView.page * pageSize;
  let remaining = pageSize;
  const groups = [];
  for (const [name, entries] of result) {
    const visible = entries.slice(offset, offset + remaining);
    offset = Math.max(0, offset - entries.length);
    remaining -= visible.length;
    if (visible.length) groups.push([name, visible]);
    if (!remaining) break;
  }
  const rows = groups.map(([name, entries]) =>
    `<div class="asset-menu-group" role="group"${name ? ` aria-label="${escape(name)}"` : ''}>${
      entries.map(([action, glyph, text, shortcut]) =>
        `<button type="button" role="menuitem" tabindex="-1" data-action="${escape(action)}" title="${escape(text)}"${
          shortcut ? ` aria-keyshortcuts="${escape(shortcut)}"` : ''}>${
          icon(glyph)}<span class="asset-menu-label">${escape(text)}</span>${
          shortcut ? `<kbd aria-hidden="true">${escape(shortcut)}</kbd>`
            : action.startsWith('group:') ? icon('chevron', 'asset-menu-chevron') : ''}</button>`).join('')
    }</div>`).join('');
  const items = assetMenu.querySelector('.asset-menu-items');
  items.setAttribute('aria-label', section && !terms.length ? submenus[section].title : label);
  items.innerHTML = rows;
  const subtitle = assetMenu.querySelector('.asset-menu-context span');
  if (subtitle) {
    subtitle.textContent = section && !terms.length ? submenus[section].title : context.name;
    assetMenu.querySelector('[data-menu-back]').hidden = !section;
  }
  assetMenu.querySelector('.asset-menu-empty')?.classList.toggle('hidden', Boolean(rows));
  const pager = assetMenu.querySelector('.asset-menu-pager');
  pager.hidden = pageCount <= 1;
  pager.querySelector('span').textContent = `${menuView.page + 1} / ${pageCount}`;
  pager.querySelector('[data-menu-page="-1"]').disabled = menuView.page === 0;
  pager.querySelector('[data-menu-page="1"]').disabled = menuView.page === pageCount - 1;

  const margin = 6;
  assetMenu.style.left = Math.max(margin, Math.min(x, innerWidth - assetMenu.offsetWidth - margin)) + 'px';
  const top = menuView.top ?? (y + assetMenu.offsetHeight > innerHeight - margin
    && y - assetMenu.offsetHeight >= margin ? y - assetMenu.offsetHeight : y);
  menuView.top = Math.max(margin, Math.min(top, innerHeight - assetMenu.offsetHeight - margin));
  assetMenu.style.top = menuView.top + 'px';
}

function focusAssetMenuItem(action) {
  const items = [...assetMenu.querySelectorAll('[role="menuitem"]')];
  (items.find(item => item.dataset.action === action) || items[0])?.focus({preventScroll:true});
}

function showAssetMenu(sections, x, y, label, context) {
  if (!sections.some(([, entries]) => entries.length)) return;
  menuView = {sections, context, label, x, y, query:'', section:'', page:0};
  assetMenu.classList.toggle('has-context', Boolean(context));
  assetMenu.innerHTML = (context ? `<div class="asset-menu-context"><button type="button" data-menu-back hidden aria-label="返回上一级" title="返回上一级">${icon('chevron')}</button>${icon(context.glyph)}<span title="${escape(context.detail)}"></span></div>
    <label class="asset-menu-search">${icon('search')}<input id="asset-menu-search" type="search" placeholder="搜索操作…" aria-label="搜索右键操作" aria-keyshortcuts="/" autocomplete="off" spellcheck="false"></label>` : '') +
    '<div class="asset-menu-items" role="menu"></div>' +
    (context ? '<p class="asset-menu-empty hidden" role="status">没有匹配的操作</p>' : '') +
    '<div class="asset-menu-pager" hidden><button type="button" data-menu-page="-1" aria-label="上一页">上一页</button>' +
    '<span aria-live="polite"></span><button type="button" data-menu-page="1" aria-label="下一页">下一页</button></div>';
  assetMenu.classList.remove('hidden');
  renderAssetMenuRows();
  focusAssetMenuItem();
}

function showWorkspaceActions(actions, x, y, label) {
  const scope = collectionScope();
  workspaceMenuActions = actions.map(([, , run]) => () => { if (scope === collectionScope()) return run(); });
  showAssetMenu([['', actions.map(([glyph, name], index) => [`workspace-action:${index}`, glyph, name])]], x, y, label);
}

function showOrganizeMenu(event) {
  const collectionRow = event.target.closest('#collections [data-collection]');
  const tagRow = event.target.closest('#sidebar-tags [data-tag]');
  const shortcutRow = event.target.closest('#sidebar-shortcuts .workspace-shortcut-row');
  if (!collectionRow && !tagRow && !shortcutRow) return;
  const entries = [];
  let label;
  if (collectionRow) {
    const collection = state.collections.find(item => item.id === collectionRow.dataset.collection);
    if (!collection) return;
    label = '合集操作';
    entries.push(['stack', '打开合集', () => openCollection(collection.id)],
      ['sliders', '重命名合集…', () => showCollectionDialog('edit', [], collection)],
      ['close', '删除合集…', () => {
        showCollectionDialog('edit', [], collection);
        $('#delete-collection').click();
        $('#delete-collection').focus();
      }]);
  } else if (tagRow) {
    const {tag} = tagRow.dataset;
    label = '标签操作';
    entries.push(['tag', '按此标签筛选', () => { if (state.tag !== tag) tagRow.click(); }]);
    if (native) entries.push(['sliders', '重命名标签…', () => showTagDialog('rename', tag)],
      ['close', '删除标签…', () => showTagDialog('delete', tag)]);
  } else {
    const open = shortcutRow.querySelector('.nav-item');
    const remove = shortcutRow.querySelector('.workspace-shortcut-remove');
    const {pinnedLibrary, pinnedFolder} = shortcutRow.dataset;
    label = pinnedLibrary ? '快速访问操作' : '已保存搜索操作';
    if (!open.disabled) entries.push([pinnedLibrary ? 'folder' : 'search', pinnedLibrary ? '在资产库中打开' : '运行搜索', () => open.click()]);
    if (pinnedLibrary && !open.disabled) {
      entries.push(['locate', '在文件夹树中定位', () => locatePinnedFolder(pinnedLibrary, pinnedFolder)]);
      const library = state.libraries.find(item => item.id === pinnedLibrary);
      const diskPath = library && diskFolderPath(library, pinnedFolder);
      if (diskPath) {
        if (native) entries.push(['drag-out', '在文件管理器中显示', () => api('open_folder_location', {path:diskPath})]);
        entries.push(['link', '复制文件夹路径', () => copyFolderPath({diskPath})]);
      }
    }
    entries.push(['close', pinnedLibrary ? '取消固定' : '删除已保存搜索', () => remove.click()]);
  }
  event.preventDefault();
  closeAssetMenu();
  menuCard = collectionRow || tagRow || shortcutRow.querySelector('button:not(:disabled)');
  const rect = menuCard.getBoundingClientRect();
  showWorkspaceActions(entries,
    event.clientX || rect.left + 8, event.clientY || rect.bottom, label);
}

for (const organizePane of $$('.sidebar-organize-content')) {
  organizePane.addEventListener('contextmenu', showOrganizeMenu);
  organizePane.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showOrganizeMenu(event);
  });
}

function showJobMenu(event) {
  const row = event.target.closest('.job-row[data-job-id]');
  if (!row || $('dialog[open]')) return;
  event.preventDefault();
  closeAssetMenu();
  menuCard = row;
  const rect = row.getBoundingClientRect();
  showAssetMenu([['', [['locate-job-source', 'locate', '定位素材']]]],
    event.clientX || rect.left + 8, event.clientY || rect.top + 8, '导入任务操作');
}

function showTeamAvatarMenu(event) {
  if (!teamAssetMessages.pokesEnabled() || $('dialog[open]')) return;
  const avatar = event.target.closest('[data-team-member-avatar]');
  const member = team.online.find(item => item.id === avatar?.dataset.teamMemberAvatar && !item.self);
  if (!member) return;
  event.preventDefault();
  closeAssetMenu();
  menuCard = avatar;
  const epoch = team.epoch;
  const rect = avatar.getBoundingClientRect();
  showWorkspaceActions([['mail', '拍一拍', async () => {
    if (epoch === team.epoch && await teamAssetMessages.poke(member)) animateTeamAvatar(member.id);
  }]], event.clientX || rect.left + 6, event.clientY || rect.bottom, '团队成员操作');
}

function supportsPinterestLens(asset) {
  return native && asset?.path && !asset.demo && (!isTeamAsset(asset) || asset.teamMounted)
    && !fileStates.has(asset.id) && ['jpg', 'jpeg', 'png', 'webp'].includes(asset.ext.toLowerCase());
}

function showPinterestLens(asset) {
  if (!supportsPinterestLens(asset)) return;
  const current = ++pinterestLensRequest;
  const path = $('#pinterest-lens-path');
  path.value = asset.path;
  path.title = asset.path;
  $('#pinterest-lens-status').textContent = '';
  pinterestLensImage.classList.add('hidden');
  pinterestLensImage.removeAttribute('src');
  openDialog('#pinterest-lens-dialog');
  Promise.resolve(thumbCache.get(asset.id) || readThumbnail(asset, 512, false)).then(url => {
    if (url && current === pinterestLensRequest && pinterestLens.open) {
      pinterestLensImage.src = url;
      pinterestLensImage.classList.remove('hidden');
    }
  }).catch(() => {});
}

pinterestLens.addEventListener('close', () => {
  pinterestLensRequest++;
  pinterestLensImage.removeAttribute('src');
});
$('#pinterest-lens-open').addEventListener('click', async event => {
  const button = event.currentTarget;
  const current = pinterestLensRequest;
  const status = $('#pinterest-lens-status');
  button.disabled = true;
  try {
    await copyWorkspaceText($('#pinterest-lens-path').value);
    if (current !== pinterestLensRequest || !pinterestLens.open) return;
    await api('subscription_open', {url:'https://www.pinterest.com/'});
    if (current === pinterestLensRequest && pinterestLens.open) status.textContent = '路径已复制。请在 Pinterest 的图片上传窗口粘贴。';
  } catch (failure) {
    if (current === pinterestLensRequest && pinterestLens.open) status.textContent = String(failure?.message || failure);
  } finally { button.disabled = false; }
});

$('#online-members').addEventListener('contextmenu', showTeamAvatarMenu);
$('#online-members').addEventListener('keydown', event => {
  if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showTeamAvatarMenu(event);
});

jobList.addEventListener('contextmenu', showJobMenu);
jobList.addEventListener('keydown', event => {
  if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showJobMenu(event);
});

function showAssetCardMenu(event) {
  const card = event.target.closest('.asset-card');
  if (!card || $('dialog[open]')) return;
  const asset = assetsById.get(card.dataset.id);
  if (!asset) return;
  event.preventDefault();
  closeAssetMenu();
  menuCard = card;
  const ids = draggedIds(asset.id);
  const local = native && (!isTeamAsset(asset) || asset.teamMounted);
  const preview = [['preview', asset.kind === 'video' ? 'play' : 'eye', '快速预览', 'Space']];
  const organize = [
    ['collect', 'stack', '加入合集'],
    ['favorite', 'star', asset.favorite ? '取消收藏' : '收藏资产'],
  ];
  const files = [];
  const covers = [];
  const send = [];
  const remove = [];

  if (ids.length >= 2 && ids.length <= 4) preview.push(['compare', 'compare', '并排对比']);
  if (indexedAssetFolder(asset)) preview.push(['jump-folder', 'locate', '跳转到文件夹']);
  if (local && !fileStates.has(asset.id)) preview.push(['reveal', 'folder', '在文件夹中显示']);
  if (ids.length === 1 && supportsPinterestLens(asset)) preview.push(['pinterest-lens', 'search', 'Pinterest 以图找图…']);
  if (whiteboardMediaIds(ids).length) files.push(['copy-whiteboard-reference', 'copy', '复制白板引用', 'Ctrl+C']);
  if (ids.length > 1) organize.push(['batch', 'sliders', '批量整理']);
  if (native) {
    organize.push(['asset-ai', 'sparkles', 'AI 自动整理…']);
    files.push(['copy', 'copy', '复制到文件夹…'], ['check', 'check', '检查文件']);
    covers.push(['thumbnails', 'picture', '生成缩略图…']);
  }
  if (local) {
    covers.push(['cover', 'picture', '选择封面…'], ['cover-screenshot', 'camera', '截图作为封面…']);
    if (customCovers.has(asset.id)) covers.push(['cover-reset', 'refresh', '恢复自动封面']);
    covers.push(['versions', 'clock', '文件版本…']);
    if (fileStates.has(asset.id) && !isTeamAsset(asset)) files.push(['relink', 'link', '重新关联文件…']);
  }
  if (local && !fileStates.has(asset.id)) {
    if (asset.ext === 'max') {
      send.push(['c4d-project:direct', 'download', '直接解析 MAX 并保存 C4D…']);
      if (nativeDragOut) send.push(['c4d-project:application', 'download', '调用 3ds Max 保存 C4D…']);
    } else if (asset.ext === 'blend') {
      send.push(['c4d-project:application', 'download', '调用 Blender 保存 C4D…']);
    }
  }
  for (const session of state.sessions) {
    const smart = canUseSmartImport(session, asset);
    if (smart || compat[session.dcc]?.includes(asset.ext)) {
      send.push(['send:' + session.id, 'drag-out', (smart ? '智能导入到 ' : '导入到 ') + (session.label || dccs[session.dcc]?.name || session.dcc)]);
    }
  }
  if (native) {
    remove.push(['recycle', 'trash', '移到回收站']);
    if (ids.every(id => {
      const item = assetsById.get(id);
      return item?.path && !item.demo && (!isTeamAsset(item) ||
        (item.teamMounted && state.libraries.some(library => library.id === item.libraryId && library.watching)));
    })) remove.push(['delete-source', 'trash', '永久删除源文件…']);
  }
  const rect = card.getBoundingClientRect();
  const x = event.clientX || rect.left + 8;
  const y = event.clientY || rect.top + 8;
  const other = [['group:files', 'notes', '文件与封面']];
  if (send.length) other.push(['group:dcc', 'drag-out', 'DCC 导入']);
  if (!files.length && !covers.length) other.shift();
  showAssetMenu([['预览与定位', preview], ['整理', organize], ['更多操作', other], ['删除', remove]], x, y, '资产操作', {
    name:ids.length > 1 ? `已选 ${ids.length} 项资产` : asset.name,
    detail:ids.length > 1 ? '' : [asset.name, asset.path || asset.relativePath].filter(Boolean).join('\n'),
    glyph:ids.length > 1 ? 'stack' : kindIcons[assetTypePreferences.effectiveKind(asset)] || 'box',
    submenus:{
      files:{title:'文件与封面', section:['文件与封面', [...files, ...covers]]},
      dcc:{title:'DCC 导入', section:['DCC 导入', send]},
    },
  });
}
$('#asset-grid').addEventListener('contextmenu', showAssetCardMenu);
$('#asset-grid').addEventListener('keydown', event => {
  if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showAssetCardMenu(event);
});
function showWorkspaceMenu(event) {
  if (event.defaultPrevented || event.target.closest('input, textarea, [contenteditable="true"]')) return;
  event.preventDefault();
  if (!event.target.closest('.main-content') || $('dialog[open]')) return;
  closeAssetMenu();
  if (state.view === 'whiteboard' && event.target.closest('#workspace-whiteboard')) {
    const menu = whiteboard.contextMenu(event);
    if (menu) {
      menuCard = menu.anchor;
      const rect = menu.anchor.getBoundingClientRect();
      showWorkspaceActions(menu.actions, event.clientX || rect.left + 8, event.clientY || rect.top + 8, menu.label);
      return;
    }
  }
  const entries = [['refresh-workspace', 'refresh', '刷新']];
  if (state.view === 'subscriptions') {
    creatorMenuLink = creativeSubscriptions.workLink(event.target);
    if (creatorMenuLink) {
      menuCard = event.target.closest('.creator-work').querySelector('[data-work-index]');
      entries.unshift(['copy-creator-work-link', 'link', '复制视频链接']);
    }
  }
  if (native && isAssetView()) entries.push(['thumbnails-workspace', 'picture', '生成缩略图…']);
  const rect = menuCard?.getBoundingClientRect();
  showAssetMenu([['', entries]], event.clientX || (rect ? rect.left + 8 : 0), event.clientY || (rect ? rect.top + 8 : 0),
    creatorMenuLink ? '作品操作' : '工作台操作');
}
document.addEventListener('contextmenu', showWorkspaceMenu);
$('#creator-works').addEventListener('keydown', event => {
  if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showWorkspaceMenu(event);
});
$('#workspace-whiteboard').addEventListener('keydown', event => {
  if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showWorkspaceMenu(event);
});
assetMenu.addEventListener('click', event => {
  if (event.target.closest('[data-menu-back]')) return showAssetMenuSection('');
  const pager = event.target.closest('[data-menu-page]');
  if (pager) {
    menuView.page += Number(pager.dataset.menuPage);
    renderAssetMenuRows();
    focusAssetMenuItem();
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action?.startsWith('group:')) return showAssetMenuSection(action.slice(6));
  if (action === 'locate-job-source') {
    const jobId = menuCard?.dataset.jobId;
    closeAssetMenu(true);
    if (jobId) locateJobSource(jobId).catch(error);
    return;
  }
  if (action?.startsWith('workspace-action:')) {
    const run = workspaceMenuActions?.[Number(action.slice('workspace-action:'.length))];
    closeAssetMenu(true);
    if (run) Promise.resolve().then(run).catch(error);
    return;
  }
  if (action === 'copy-creator-work-link') {
    const link = creatorMenuLink;
    closeAssetMenu(true);
    if (link) copyWorkspaceText(link).then(() => toast('视频链接已复制')).catch(error);
    return;
  }
  if (action === 'refresh-workspace') {
    closeAssetMenu(true);
    if (state.view === 'subscriptions') creativeSubscriptions.refresh();
    else if (state.view === 'sites') siteNavigation.render();
    else if (state.view === 'whiteboard') whiteboard.refresh();
    else refreshCurrentWorkspace();
    return;
  }
  if (action === 'thumbnails-workspace') {
    closeAssetMenu(true);
    showThumbnailSettings([...markedAssets]);
    return;
  }
  const id = menuCard?.dataset.id;
  if (!action || !id) return;
  closeAssetMenu(true);
  if (action === 'preview') showQuickPreview(id);
  else if (action === 'pinterest-lens') showPinterestLens(assetsById.get(id));
  else if (action === 'jump-folder') jumpToIndexedAsset(id).catch(error);
  else if (action === 'collect') showCollectionDialog('add', draggedIds(id));
  else if (action === 'compare') compareAssets(draggedIds(id));
  else if (action === 'batch') showBatchMetadata(draggedIds(id));
  else if (action === 'asset-ai') assetAI.show(draggedIds(id));
  else if (action === 'thumbnails') showThumbnailSettings(draggedIds(id));
  else if (action === 'copy-whiteboard-reference') copyWhiteboardMediaReferences(whiteboardMediaIds(draggedIds(id))).catch(error);
  else if (action === 'copy') copyFiles(draggedIds(id)).catch(error);
  else if (action === 'recycle') assetRecycle.confirm(draggedIds(id));
  else if (action === 'delete-source') assetRecycle.confirm(draggedIds(id), 'delete');
  else if (action === 'check') checkFiles(draggedIds(id)).catch(error);
  else if (action === 'relink') relinkFile(id).catch(error);
  else if (action === 'cover') changeCover(id, false).catch(error);
  else if (action === 'cover-screenshot' && assetsById.has(id)) screenshotCover.show(assetsById.get(id));
  else if (action === 'cover-reset') changeCover(id, true).catch(error);
  else if (action === 'versions') showVersions(id).catch(error);
  else if (action === 'favorite') favorite(id).catch(error);
  else if (action === 'reveal') api('reveal_asset', {id}).catch(error);
  else if (action.startsWith('c4d-project:')) queueC4dProject(id, action.slice('c4d-project:'.length)).catch(error);
  else if (action.startsWith('send:')) sendAssets(draggedIds(id), action.slice(5)).catch(error);
});
function showAssetMenuSection(section) {
  const prior = menuView.section;
  Object.assign(menuView, {section, query:'', page:0});
  assetMenu.querySelector('#asset-menu-search').value = '';
  renderAssetMenuRows();
  focusAssetMenuItem(section ? undefined : 'group:' + prior);
}
function filterAssetMenu(value) {
  Object.assign(menuView, {query:value, page:0});
  renderAssetMenuRows();
}
assetMenu.addEventListener('input', event => {
  if (event.target.id === 'asset-menu-search') filterAssetMenu(event.target.value);
});
assetMenu.addEventListener('keydown', event => {
  if (event.isComposing || !menuView) return;
  const search = assetMenu.querySelector('#asset-menu-search');
  const isSearch = event.target === search;
  if (event.key === 'Escape' && menuView.section && !menuView.query ||
      event.key === 'ArrowLeft' && menuView.section && !isSearch) {
    event.preventDefault();
    showAssetMenuSection('');
    return;
  }
  if (search && event.key === 'Tab' && event.shiftKey && !isSearch) {
    event.preventDefault();
    search.focus();
    return;
  }
  if (isSearch && event.key === 'Tab' && !event.shiftKey && assetMenu.querySelector('[role="menuitem"]')) {
    event.preventDefault();
    focusAssetMenuItem();
    return;
  }
  if (['Escape', 'Tab'].includes(event.key)) {
    if (event.key === 'Escape') event.preventDefault();
    closeAssetMenu(true);
    return;
  }
  const choice = event.target.dataset.action;
  if (event.key === 'ArrowRight' && choice?.startsWith('group:')) {
    event.preventDefault();
    showAssetMenuSection(choice.slice(6));
    return;
  }
  if (event.key === 'PageUp' || event.key === 'PageDown') {
    event.preventDefault();
    assetMenu.querySelector(`[data-menu-page="${event.key === 'PageDown' ? 1 : -1}"]:not(:disabled)`)?.click();
    return;
  }
  if (search && !isSearch && !event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1 && event.key !== ' ') {
    event.preventDefault();
    search.focus();
    if (event.key !== '/') {
      search.value += event.key;
      filterAssetMenu(search.value);
    }
    return;
  }
  const steps = ['ArrowUp', 'ArrowDown'];
  if (!steps.includes(event.key) && (isSearch || !['Home', 'End'].includes(event.key))) return;
  event.preventDefault();
  const entries = [...assetMenu.querySelectorAll('[role="menuitem"]:not([hidden]):not(:disabled)')];
  if (!entries.length) return;
  const index = entries.indexOf(document.activeElement);
  const next = event.key === 'Home' || index < 0 && event.key === 'ArrowDown' ? 0
    : event.key === 'End' || index < 0 ? entries.length - 1
    : (index + (event.key === 'ArrowUp' ? -1 : 1) + entries.length) % entries.length;
  entries[next].focus({preventScroll:true});
});
document.addEventListener('pointerdown', event => {
  if (!assetMenu.contains(event.target)) closeAssetMenu();
});
window.addEventListener('blur', () => closeAssetMenu());
window.addEventListener('resize', () => {
  if (menuView) closeAssetMenu(true);
});

let ingestBusy = false;
const filesOverlay = $('#files-drop-overlay');
const filesLabel = $('#files-drop-label');
const teamDropDialog = $('#team-drop-dialog');
let teamDropDraft = null;

async function linkTeamFolders(paths, navigate = true) {
  if (!team.active || ingestBusy || !paths.length) return;
  const scope = collectionScope();
  const epoch = team.epoch;
  const sameWorkspace = () => team.active && team.epoch === epoch && scope === collectionScope();
  const previousLibrary = state.library;
  const location = importLocation();
  const clearedLocation = importLocation(null, '');
  const dialog = $('#import-dialog');
  const status = $('#team-link-status');
  ingestBusy = true;
  updateImportSubmit();
  if (dialog.open) {
    status.textContent = '正在链接共享文件夹…';
    status.classList.remove('hidden');
  } else {
    filesLabel.textContent = '正在链接共享文件夹…';
    filesOverlay.classList.remove('hidden');
  }
  try {
    const result = await api('team_link_folders', {paths});
    const linked = result.linked + result.existing;
    const merged = mergedTeamFolderMap(result.mergedLibraries);
    let pending = Boolean(result.indexPending);
    if (!sameWorkspace()) return;
    if (linked) {
      const wasAtOriginalLocation = location === importLocation();
      const removals = team.removedFolders;
      const rebasedRemovals = removals.some(rule => merged.has(rule.libraryId)) ? removals.map(rule => {
        const target = rebaseMergedTeamFolder(merged, rule.libraryId, rule.path);
        return target ? {libraryId:target.libraryId, path:target.folder} : rule;
      }) : removals;
      const rules = restoreLinkedTeamFolders(rebasedRemovals, result.folders, team.allLibraries);
      const restoredLocally = rules !== team.removedFolders;
      if (restoredLocally) setLocalTeamFolderRules(rules);
      workspaceNavigation.consolidateTeamFolders(scope, merged);
      await refreshTeam(true).catch(() => {
        pending = true;
        if (restoredLocally && sameWorkspace() && team.catalog) {
          refreshVisibleTeamCatalog();
          renderNav();
          renderAssets();
        }
      });
      if (!sameWorkspace()) return;
      const refreshedLocation = importLocation();
      const locationWasCleared = wasAtOriginalLocation && merged.has(previousLibrary) && clearedLocation === refreshedLocation;
      if (navigate && (location === refreshedLocation || locationWasCleared) && result.folders.length === 1) {
        const {libraryId, folder} = result.folders[0];
        openFolder(libraryId, folder);
      }
    }
    const report = [];
    if (result.linked) report.push(`已链接 ${result.linked} 个文件夹`);
    if (result.existing) report.push(`${result.existing} 个文件夹已链接`);
    if (merged.size) report.push(`已合并 ${merged.size} 个原有入口`);
    if (result.failed) report.push(`${result.failed} 个路径无法链接`);
    if (pending && linked) report.push('等待 NAS 索引同步');
    const message = (report.join(' · ') || '没有可链接的文件夹') + (result.errors?.length ? ' · ' + result.errors[0] : '');
    if (dialog.open) {
      if (linked && !result.failed) dialog.close();
      else status.textContent = message;
    }
    toast(message, Boolean(result.failed || !linked));
    return merged;
  } catch (failure) {
    if (sameWorkspace()) {
      if (dialog.open) status.textContent = String(failure?.message || failure);
      else error(failure);
    }
  } finally {
    ingestBusy = false;
    updateImportSubmit();
    filesOverlay.classList.add('hidden');
  }
}

function teamDropTarget() {
  return teamDropDraft?.targets[Number($('#team-drop-target').value)];
}

function updateTeamDropActions() {
  if (!teamDropDraft) return;
  const target = teamDropTarget();
  const {files, folders} = teamDropDraft;
  $('#team-drop-import').disabled = !target;
  $('#team-drop-link').disabled = Boolean(files.length && !target);
  const copy = target ? `复制到「${target.label}」` : '复制到选定的团队目录';
  $('#team-drop-import-detail').textContent =
    `${copy}，会占用 NAS 空间。团队成员可以访问副本。${folders.length ? '保留子目录结构。' : ''}`;
}

function showTeamDropChoice(draft) {
  teamDropDraft = draft;
  const {files, folders, targets, preferred} = draft;
  const target = $('#team-drop-target');
  target.replaceChildren(new Option('请选择团队文件夹', '-1'), ...targets.map((item, index) => new Option(item.label, index)));
  target.value = String(preferred);
  $('#team-drop-target-field').classList.toggle('hidden', !targets.length || targets.length === 1 && preferred === 0);
  $('#team-drop-link').classList.toggle('hidden', !folders.length);
  $('#team-drop-title').textContent = folders.length ? '选择文件夹的导入方式' : '确认导入团队素材';
  $('#team-drop-summary').textContent = folders.length
    ? `已选 ${folders.length} 个文件夹。${files.length ? `另有 ${files.length} 个文件会复制到所选团队目录。` : ''}`
    : `已选 ${files.length} 个文件。`;
  $('#team-drop-status').textContent = targets.length ? '' : '导入前，请先链接一个可写入的 NAS 文件夹。';
  updateTeamDropActions();
  teamDropDialog.showModal();
  (preferred < 0 && targets.length ? target : teamDropDialog.querySelector('.modal-footer .close-modal'))?.focus();
}

async function importTeamDrop(paths, target, scope) {
  if (!target || !paths.length || scope !== collectionScope() || ingestBusy) return;
  ingestBusy = true;
  filesLabel.textContent = '正在导入团队素材…';
  filesOverlay.classList.remove('hidden');
  try {
    const result = await api('team_import_paths', {
      teamId:team.info.team.id, libraryId:target.libraryId, folder:target.folder, paths,
    });
    if (scope !== collectionScope()) return;
    const report = [];
    if (result.copied) report.push(`已导入 ${result.copied} 个文件`);
    if (result.directoriesCreated) report.push(`已添加 ${result.directoriesCreated} 个文件夹`);
    if (result.existing) report.push(`${result.existing} 个文件已在目标位置`);
    if (result.duplicates) report.push(duplicateImportMessage(result));
    const skipped = result.skipped - (result.duplicates || 0);
    if (skipped > 0) report.push(`跳过 ${skipped} 项`);
    if (result.conflicts) report.push(`${result.conflicts} 项同名冲突`);
    if (result.failed) report.push(`${result.failed} 项导入失败`);
    if (result.indexPending) report.push('等待 NAS 索引同步');
    toast((report.join(' · ') || '没有可导入的素材') + (result.errors?.length ? ' · ' + result.errors[0] : ''), Boolean(result.failed || result.conflicts));
    if (result.copied || result.existing || result.directoriesCreated) await refreshTeam(true).catch(() => {});
  } finally {
    ingestBusy = false;
    filesOverlay.classList.add('hidden');
  }
}

async function handleTeamDrop(paths, {fromPicker = false} = {}) {
  if (!team.active || ingestBusy) return;
  const scope = collectionScope();
  ingestBusy = true;
  updateImportSubmit();
  if (fromPicker) $('#team-link-status').classList.add('hidden');
  let result;
  try { result = await api('classify_team_drop', {paths}); }
  finally {
    ingestBusy = false;
    updateImportSubmit();
  }
  if (scope !== collectionScope() || fromPicker && !$('#import-dialog').open) return;
  const {files, folders, errors, localPaths} = result;
  if (errors.length) {
    if (fromPicker) {
      const status = $('#team-link-status');
      status.textContent = errors[0];
      status.classList.remove('hidden');
    } else toast(errors[0], true);
  }
  if (!files.length && !folders.length) return;
  const library = currentLibrary();
  const targets = state.libraries.filter(item => item.watching && item.path).map(item => ({libraryId:item.id, folder:'', label:item.name}));
  let preferred = -1;
  if (library?.watching && library.path) {
    preferred = targets.findIndex(target => target.libraryId === library.id);
    if (state.folder) {
      targets.unshift({libraryId:library.id, folder:state.folder, label:`${library.name} / ${state.folder}`});
      preferred = 0;
    }
  } else if (!library && targets.length === 1) preferred = 0;
  if (!folders.length && !fromPicker && preferred >= 0 && localPaths?.length === 0) {
    return importTeamDrop(files, targets[preferred], scope);
  }
  if (!folders.length && !targets.length) return toast('请先打开可写入的团队文件夹，再拖入素材', true);
  showTeamDropChoice({scope, files, folders, targets, preferred, fromPicker, localPaths});
}

$('#team-drop-target').addEventListener('change', updateTeamDropActions);
teamDropDialog.addEventListener('close', () => { if (!teamDropDialog.open) teamDropDraft = null; });
$('#team-drop-import').addEventListener('click', () => {
  if (!teamDropDraft) return;
  const {files, folders, scope, fromPicker} = teamDropDraft;
  const target = teamDropTarget();
  teamDropDialog.close();
  if (fromPicker) $('#import-dialog').close();
  importTeamDrop([...folders, ...files], target, scope).catch(error);
});
$('#team-drop-link').addEventListener('click', async () => {
  if (!teamDropDraft) return;
  const {files, folders, scope, localPaths} = teamDropDraft;
  if (folders.length && folders.every(folder => localPaths?.includes(folder))) {
    $('#team-drop-status').textContent = '团队成员看不到本地磁盘上的文件夹。可以选择「导入素材」，将副本保存到团队 NAS。';
    return;
  }
  const target = teamDropTarget();
  teamDropDialog.close();
  if (scope !== collectionScope()) return;
  const merged = await linkTeamFolders(folders, !files.length);
  const rebased = merged && target && rebaseMergedTeamFolder(merged, target.libraryId, target.folder);
  if (files.length) await importTeamDrop(files, rebased ? {...target, ...rebased} : target, scope).catch(error);
});

async function onFileDrop({payload}) {
  if (workspaceDrag.isDraggingOut() || $('dialog[open]:not(#import-dialog)')) return;
  const {type, paths} = payload;
  if (state.view === 'whiteboard') {
    filesOverlay.classList.add('hidden');
    if (type === 'drop' && paths?.length && !whiteboard.dropNativeImages(paths, payload.position)) {
      toast('双击打开一个白板项目后，再拖入图片。');
    }
    return;
  }
  if (type === 'leave' && !ingestBusy) filesOverlay.classList.add('hidden');
  if (type === 'enter' && !ingestBusy && paths?.length) {
    videoHover?.stop();
    filesLabel.textContent = team.active ? '放下以导入素材或链接文件夹' : '放下文件或文件夹，添加到本地资产库';
    filesOverlay.classList.remove('hidden');
  }
  if (type !== 'drop' || !paths?.length || ingestBusy) return;
  filesOverlay.classList.add('hidden');
  if (team.active) return handleTeamDrop(paths);
  return ingestLocalPaths(paths);
}

async function ingestLocalPaths(paths) {
  if (ingestBusy) return;
  const scope = collectionScope();
  const libraryId = state.library;
  ingestBusy = true;
  filesLabel.textContent = '正在索引拖入的资产…';
  filesOverlay.classList.remove('hidden');
  try {
    const result = await api('ingest_drop', {paths, libraryId});
    if (scope === collectionScope() && (result.found || result.libraries.length)) {
      await refresh();
      if (scope === collectionScope() && !libraryId && result.libraries.length === 1 && !state.library && !state.collection) {
        openFolder(result.libraries[0].id);
      }
    }
    const skipped = result.skipped ? ' · 跳过 ' + result.skipped + ' 个不支持或重复的路径' : '';
    const duplicateMessage = duplicateImportMessage(result);
    const failed = result.failed ? ' · ' + result.failed + ' 个路径读取失败' : '';
    const folders = result.libraries.length ? ' · ' + result.libraries.length + ' 个文件夹' : '';
    toast('已索引 ' + result.found + ' 项' + folders + (duplicateMessage ? ' · ' + duplicateMessage : '') + skipped + failed +
      (result.errors?.length ? ' · ' + result.errors[0] : ''), Boolean(result.failed));
  } finally {
    ingestBusy = false;
    filesOverlay.classList.add('hidden');
  }
}

if (native) {
  window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(event => onFileDrop(event).catch(error)).catch(error);
  window.__TAURI__.event.listen('drop-ingest-progress', ({payload}) => {
    if (ingestBusy) filesLabel.textContent = '正在索引 · 已处理 ' + payload + ' 项资产';
  }).catch(error);
  window.__TAURI__.event.listen('team-import-progress', ({payload}) => {
    if (ingestBusy) filesLabel.textContent = '正在导入团队素材 · 已处理 ' + payload + ' 个文件';
  }).catch(error);
}

const workspaceLayout = initWorkspaceLayout(libraryPreferences);
const sidebarZones = initSidebarZones(libraryPreferences);
let priorTeamOrganization = null;
const teamOrganization = initTeamOrganization({
  api,
  notify: toast,
  context: () => team.active ? {teamId:team.info.team.id, key:collectionScope()} : null,
  onChange(snapshot) {
    if (!team.active) return;
    const key = collectionScope();
    const favorites = JSON.stringify(snapshot.favoriteIds);
    const collections = JSON.stringify(snapshot.collections);
    const favoritesChanged = priorTeamOrganization?.key !== key || priorTeamOrganization.favorites !== favorites;
    const collectionsChanged = priorTeamOrganization?.key !== key || priorTeamOrganization.collections !== collections;
    if (!favoritesChanged && !collectionsChanged) return;
    priorTeamOrganization = {key, favorites, collections};
    if (favoritesChanged) teamOrganization.applyFavorites(state.assets);
    if (collectionsChanged) state.collections = snapshot.collections;
    navSummary = null;
    if (state.collection && !currentCollection()) setView('all');
    else {
      renderNav();
      if ((favoritesChanged && isAssetView()) || (collectionsChanged && state.collection)) renderAssets();
    }
    if (favoritesChanged && selected() && !editor.dirty) renderInspector(false).catch(error);
  },
});
function openWebsite(url) {
  if (native) return api('subscription_open', {url}).catch(error);
  window.open(url, '_blank', 'noopener,noreferrer');
}
const creativeSubscriptions = initCreativeSubscriptions({
  api, native, icon, escape, log:runtimeLog.add, notify:toast,
  subscriptionScope: () => team.active ? {teamId:team.info?.team?.id, cacheKey:collectionScope()} : null,
  personalScope: () => personalWorkspace.id,
  preferences: libraryPreferences,
  openWeb: openWebsite,
});
const siteNavigation = initBrowserSites({
  navigate: openWebsite,
  readMetadata: native ? url => api('browser_site_metadata', {url}) : undefined,
  log: runtimeLog.add,
  scope: libraryScope(),
  onSubscribe(source) {
    setView('subscriptions');
    creativeSubscriptions.addFromLink(source);
  },
});
initBrowserCapture({
  native, api, copyText:copyWorkspaceText, log:runtimeLog.add,
  async workspaces() {
    const [personal, shared] = await Promise.all([
      api('personal_workspaces'),
      team.configured ? readTeamWorkspace().catch(() => null) : null,
    ]);
    const workspaces = new Map();
    for (const item of [personal?.current, ...(personal?.workspaces || [])]) {
      if (item?.id) workspaces.set('personal:' + item.id, {key:'personal:' + item.id, kind:'personal', id:item.id, name:item.name});
    }
    const catalog = shared?.catalog;
    if (catalog?.team?.id) {
      const {id, name} = catalog.team;
      const entries = team.active && team.info?.team.id === id ? state.libraries : catalog.libraries;
      workspaces.set('team:' + id, {
        key:'team:' + id, kind:'team', id, name:name + '（团队）',
        libraries:(entries || []).filter(library => library.watching && library.path),
      });
    }
    return [...workspaces.values()];
  },
  libraries: workspace => workspace.kind === 'team' ? workspace.libraries
    : api('browser_capture_personal_libraries', {workspaceId:workspace.id}),
  active:() => ({
    key:team.active ? 'team:' + team.info?.team.id : 'personal:' + personalWorkspace.id,
    libraryId:state.library || '', folder:state.folder || '',
  }),
  async onImported(target, result) {
    if (!(result.found || result.copied)) return;
    if (target.kind === 'team' && team.active && team.info?.team.id === target.teamId) await refreshTeam(true).catch(() => {});
    else if (target.kind === 'personal' && !team.active && personalWorkspace.id === target.workspaceId) await refresh().catch(error);
  },
});
const whiteboard = initWhiteboardProjects({panel:$('#workspace-whiteboard'), api, notify:toast, resolveAssetImage:resolveWhiteboardAssetMedia});
const workspacePicker = initWorkspacePicker({
  api,
  native,
  preferences: libraryPreferences,
  teamChoice: () => team.configured ? {
    name:team.info?.team.name || localStorage.getItem('nexus-team-name') || '已连接的团队库',
    active:team.active,
    teamId:team.info?.team.id,
    canRename:team.info?.member.role === 'admin',
  } : null,
  onEnterTeam: openTeamWorkspace,
  onTeam: openTeamDialog,
  onPersonalRenamed(current) {
    if (current?.id !== personalWorkspace.id) return;
    personalWorkspace = current;
    if (!team.active) {
      updateWorkspaceLabel();
      renderLocation();
    }
  },
  onTeamRenamed(updated) {
    if (!updated || updated.id !== team.info?.team.id) return;
    team.info.team = updated;
    localStorage.setItem('nexus-team-name', updated.name);
    if (team.active) {
      updateWorkspaceLabel();
      renderLocation();
      void refreshTeam(true).catch(error);
    }
  },
  canSwitch: () => {
    if (editor.saving) {
      toast('资产信息正在保存，请稍后切换');
      return false;
    }
    return !editor.dirty || confirmDiscardWorkspaceEdits();
  },
  async onWorkspace(workspace) {
    if (workspace) personalWorkspace = workspace;
    fileStates.clear();
    await openPersonal();
  },
  notify: toast,
});
async function scanWorkspaceLibrary(library) {
  const scope = collectionScope();
  if (team.active) {
    await api('team_refresh_library', {teamId:team.info.team.id,libraryId:library.id});
    if (scope === collectionScope()) await refreshTeam(true);
    return {found:assetsByLibrary.get(library.id)?.length || 0};
  }
  const result = await api('scan_library', {path:library.path,name:library.name,source:library.source || 'local'});
  if (scope === collectionScope()) await refresh();
  return result;
}

async function scanWorkspaceFolder(library, folder) {
  const scope = collectionScope();
  const shared = team.active;
  const args = {libraryId:library.id, folder};
  const result = shared
    ? await api('team_rescan_folder', {...args, teamId:team.info.team.id})
    : await api('scan_workspace_folder', args);
  if (shared && scope === collectionScope()) await team.pending?.catch(() => {});
  if (scope === collectionScope()) await (shared ? refreshTeam() : refresh());
  return result;
}

let folderMovePending = false;
const inFolderBranch = (path, root) => path === root || path.startsWith(root + '/');

function canMoveFolder(libraryId, folder, targetLibraryId, targetFolder) {
  if (!canEditFolderStructure() || folderMovePending || !folder || libraryId !== targetLibraryId || inFolderBranch(targetFolder, folder) ||
      folder.split('/').slice(0, -1).join('/') === targetFolder) return false;
  const library = state.libraries.find(item => item.id === libraryId);
  const tree = folderTrees.get(libraryId);
  return Boolean(library?.path && (!team.active || library.watching) && findFolder(tree, folder) && findFolder(tree, targetFolder));
}

async function updateFolderPath(libraryId, folder, targetFolder, newName = null) {
  if (folderMovePending) throw Error('另一项文件夹操作正在进行，请稍后重试');
  const scope = collectionScope();
  const wasTeam = team.active;
  const location = importLocation();
  const viewedFolder = state.library === libraryId && inFolderBranch(state.folder, folder) ? state.folder : null;
  folderMovePending = true;
  try {
    const result = await api(wasTeam ? 'team_move_folder' : 'move_library_folder', {
      ...(wasTeam ? {teamId:team.info.team.id} : {}), libraryId, folder, targetFolder,
      ...(newName === null ? {} : {newName}),
    });
    if (scope !== collectionScope()) return;
    workspaceNavigation.relocateFolder(libraryId, folder, result.folder);
    folderAppearance.move(libraryId, folder, result.folder);
    if (wasTeam) {
      team.removedFolders = team.removedFolders.map(rule => rule.libraryId === libraryId && inFolderBranch(rule.path, folder)
        ? {...rule, path:result.folder + rule.path.slice(folder.length)} : rule);
      try { localStorage.setItem(teamFolderRemovalsKey(), JSON.stringify(team.removedFolders)); }
      catch { /* The active view can still refresh. */ }
    }
    const followed = viewedFolder !== null && location === importLocation();
    expandedFolders.add(folderKey(libraryId, ''));
    for (const ancestor of folderAncestors(targetFolder)) expandedFolders.add(folderKey(libraryId, ancestor.path));
    for (const key of [...expandedFolders]) {
      const [library, path] = JSON.parse(key);
      if (library !== libraryId || !inFolderBranch(path, folder)) continue;
      expandedFolders.delete(key);
      expandedFolders.add(folderKey(libraryId, result.folder + path.slice(folder.length)));
    }
    await (wasTeam ? refreshTeam(true) : refresh()).catch(() => {});
    if (scope !== collectionScope()) return;
    const indexed = findFolder(folderTrees.get(libraryId), result.folder);
    if (followed && indexed) openFolder(libraryId, result.folder + viewedFolder.slice(folder.length));
    const message = newName === null ? '文件夹已移动' : '文件夹已重命名';
    toast(indexed ? message + (result.quickAccessError ? '，团队快速访问路径暂未更新' : '')
      : message + '，等待索引更新', Boolean(result.quickAccessError));
  } finally {
    folderMovePending = false;
  }
}

async function moveFolder(libraryId, folder, targetFolder) {
  if (!canMoveFolder(libraryId, folder, libraryId, targetFolder)) return;
  const scope = collectionScope();
  try { await updateFolderPath(libraryId, folder, targetFolder); }
  catch (failure) { if (scope === collectionScope()) error(failure); }
}

const workspaceNavigation = initWorkspaceNavigation({
  getScope: collectionScope,
  getState: () => state,
  teamQuickAccess: {
    context: () => team.active && team.info?.team?.id
      ? {teamId:team.info.team.id, epoch:team.epoch, links:team.linkedFolders} : null,
    list: teamId => api('team_quick_access', {teamId}),
    set: (teamId, libraryId, folder, pinned) => api('team_set_quick_access', {teamId, libraryId, folder, pinned}),
  },
  findFolder: (libraryId, path) => findFolder(folderTrees.get(libraryId), path),
  onOpenPinnedFolder(libraryId, path) {
    const scroll = $('#libraries');
    const {scrollTop} = scroll;
    openFolder(libraryId, path, null, {expandTree:false});
    scroll.scrollTop = scrollTop;
  },
  onLocatePinnedFolder: locatePinnedFolder,
  onApplySearch: applySavedSearch,
  onNotify: toast,
  onRescanFolder: native ? scanWorkspaceFolder : null,
  canMoveFolder,
  moveFolder,
});
const folderAddress = initFolderAddress({
  getLocation: () => ({scope:`${collectionScope()}:${workbenchTabs.activeId()}`, libraryId:state.library, folder:state.folder, hidden:!isAssetView()}),
  getLibraries: () => state.libraries,
  findFolder: (id, path) => findFolder(folderTrees.get(id), path),
  openFolder,
  goHome: () => setView('all'),
  browseFolder: native ? path => api('open_folder_location', {path}) : undefined,
  openAddressMenu(anchor, event, {browse, copy}) {
    closeAssetMenu();
    menuCard = anchor;
    const rect = anchor.getBoundingClientRect();
    const actions = [['link', '复制地址', copy]];
    if (browse) actions.unshift(['folder', '在资源管理器中打开', browse]);
    showWorkspaceActions(actions, event.clientX || rect.left, event.clientY || rect.bottom + 4, '文件夹地址操作');
  },
  copyAddress: path => copyFolderPath({diskPath:path}),
  async onUnknownPath(path, match) {
    if (team.active) {
      const library = state.libraries.find(item => item.id === match?.libraryId && item.watching);
      if (!library) {
        showAssetImport([path]);
        return;
      }
      const scope = collectionScope();
      await scanWorkspaceLibrary(library);
      if (scope !== collectionScope()) return;
      const node = findFolder(folderTrees.get(library.id), match.folder);
      if (node) openFolder(library.id, node.path);
      else toast('此文件夹未出现在团队索引里，请检查 NAS 路径', true);
      return;
    }
    if (folderScan) {
      toast('当前目录正在后台索引，请稍后再添加文件夹');
      return;
    }
    pickedFolderPaths = [path];
    $('#library-path').value = path;
    showAssetImport();
  },
  notify: toast,
});
const workbenchTabs = initWorkspaceTabs({
  getScope: collectionScope,
  capture: captureWorkbenchPage,
  restore: restoreWorkbenchPage,
  beforeSwitch() {
    if (editor.saving) {
      toast('资产信息正在保存，请稍后切换标签页');
      return false;
    }
    return !editor.dirty || confirmDiscardWorkspaceEdits(false, true);
  },
  onDuplicate: () => folderAddress.render(),
  goHome() {
    editor.dirty = false;
    state.selected = null;
    setView('home');
    renderInspector(false).catch(error);
  },
  icon,
  onError: error,
});

function diskFolderPath(library, path) {
  if (!library.path || !path) return library.path || null;
  const separator = /^[a-z]:|^\\/i.test(library.path) ? '\\' : '/';
  return library.path.replace(/[\\/]+$/, '') + separator + path.replaceAll('/', separator);
}

function teamFolderRemovalsKey() {
  return 'nexus-hidden-folders-v1:' + collectionScope();
}

function readTeamFolderRemovals() {
  try {
    const stored = JSON.parse(localStorage.getItem(teamFolderRemovalsKey()));
    return Array.isArray(stored) ? stored.filter(rule =>
      typeof rule?.libraryId === 'string' && typeof rule.path === 'string') : [];
  } catch {
    return [];
  }
}

function refreshVisibleTeamCatalog() {
  const {assets, libraries} = applyTeamFolderVisibility(team.catalog, team.removedFolders);
  teamOrganization.applyFavorites(assets);
  Object.assign(state, {assets, libraries});
  refreshFolderTrees();
}

function canManageSharedFolders() {
  return native && team.active && team.folderVisibility;
}

function updateLocalTeamFolderVisibility(folder, hidden) {
  const rules = team.removedFolders.filter(rule => rule.libraryId !== folder.libraryId || rule.path !== folder.path);
  if (hidden) rules.push({libraryId:folder.libraryId, path:folder.path});
    setLocalTeamFolderRules(rules);
}

function setLocalTeamFolderRules(rules) {
  localStorage.setItem(teamFolderRemovalsKey(), JSON.stringify(rules));
  team.removedFolders = rules;
}

function checkFolderCanBeHidden(folder, library, hidden) {
  const current = selected();
  if (hidden && current && (editor.dirty || editor.saving) && createFolderMatcher(library, folder.path)(current)) {
    throw Error('请先保存或取消当前资产的编辑，再移除文件夹');
  }
}

async function setSharedFolderVisibility(folder, hidden, promote = false) {
  if (!canManageSharedFolders()) throw Error('当前团队服务不支持同步移除或恢复文件夹');
  const library = team.allLibraries.find(item => item.id === folder.libraryId);
  if (!library) throw Error('团队目录目前不可用');
  checkFolderCanBeHidden(folder, library, hidden);
  const scope = collectionScope();
  const epoch = team.epoch;
  await api('team_set_folder_visibility', {libraryId:folder.libraryId, folder:folder.path, hidden});
  if (team.epoch !== epoch || scope !== collectionScope()) return;
  await refreshTeam(true);
  if (team.epoch !== epoch || scope !== collectionScope()) return;
  if (promote && team.sharedHiddenFolders.some(rule => rule.libraryId === folder.libraryId && rule.folder === folder.path)) {
    updateLocalTeamFolderVisibility(folder, false);
    refreshVisibleTeamCatalog();
    renderNav();
    renderAssets();
  }
  toast(hidden ? '已从团队资产库移除「' + folder.name + '」，原文件已保留'
    : '已恢复团队文件夹「' + folder.name + '」');
}

async function setFolderVisibility(folder, hidden) {
  if (!native) return;
  const inTeam = team.active;
  if (inTeam) {
    const library = team.allLibraries.find(item => item.id === folder.libraryId);
    if (!library) throw Error('团队目录目前不可用');
    checkFolderCanBeHidden(folder, library, hidden);
    updateLocalTeamFolderVisibility(folder, hidden);
    refreshVisibleTeamCatalog();
  } else {
    const scope = collectionScope();
    await api('set_library_folder_hidden', {libraryId:folder.libraryId, folder:folder.path, hidden});
    if (scope !== collectionScope()) return;
    await refresh({render:false});
    if (scope !== collectionScope()) return;
  }
  renderNav();
  const rows = renderAssets() || [];
  const removedSelection = state.selected && (inTeam
    ? !assetsById.has(state.selected)
    : !rows.some(asset => asset.id === state.selected));
  const keepDraft = inTeam && removedSelection && editor.dirty && editor.id === state.selected;
  if (!keepDraft) {
    if (removedSelection) await selectAsset(rows[0]?.id || null);
    else await renderInspector(false);
  }
  toast(hidden
    ? '已将「' + folder.name + '」从' + (inTeam ? '本机团队库视图' : '资产库') + '移除，原文件已保留'
    : '已恢复「' + folder.name + '」');
}

async function copyWorkspaceText(text) {
  try {
    if (!navigator.clipboard) throw Error('剪贴板不可用');
    await navigator.clipboard.writeText(text);
  } catch {
    const previousFocus = document.activeElement;
    const field = document.createElement('textarea');
    field.value = text;
    field.className = 'folder-clipboard';
    ($('dialog[open]') || document.body).append(field);
    try {
      field.select();
      if (!document.execCommand('copy')) throw Error('无法写入剪贴板');
    } finally {
      field.remove();
      previousFocus?.focus({preventScroll:true});
    }
  }
}

async function copyFolderPath(folder) {
  if (!folder.diskPath) return;
  await copyWorkspaceText(folder.diskPath);
  toast('文件夹路径已复制');
}

const removeFolderDialog = $('#remove-folder-dialog');
const removeFolderFiles = $('#remove-folder-files');
const removeFolderSubmit = $('#remove-folder-submit');
const removeFolderStatus = $('#remove-folder-status');
let folderToRemove = null;

function showRemoveFolder(folder) {
  if (!canEditFolderStructure()) return;
  folderToRemove = {...folder, scope:collectionScope()};
  $('#remove-folder-path').textContent = folder.diskPath || folder.name;
  $('#remove-folder-files-label').textContent = team.active ? '同时删除 NAS 上的文件夹和文件' : '同时删除磁盘上的文件夹和文件';
  removeFolderFiles.checked = false;
  removeFolderFiles.disabled = !folder.canDelete;
  removeFolderStatus.textContent = folder.canDelete ? '' : '这个位置仅能从资产库移除。';
  updateFolderRemoveAction();
  openDialog('#remove-folder-dialog');
}

function updateFolderRemoveAction() {
  const deleteFiles = removeFolderFiles.checked;
  removeFolderSubmit.textContent = deleteFiles ? '确认删除文件夹' : '仅从资产库移除';
  removeFolderSubmit.classList.toggle('danger', deleteFiles);
  removeFolderSubmit.classList.toggle('primary', !deleteFiles);
  $('#remove-folder-warning').classList.toggle('hidden', !deleteFiles);
}

removeFolderFiles.addEventListener('change', updateFolderRemoveAction);
removeFolderDialog.addEventListener('cancel', event => { if (removeFolderSubmit.disabled) event.preventDefault(); });
$('#remove-folder-form').addEventListener('submit', async event => {
  event.preventDefault();
  const folder = folderToRemove;
  if (!folder || !canEditFolderStructure() || folder.scope !== collectionScope() || removeFolderSubmit.disabled) return;
  const deleteFiles = folder.canDelete && removeFolderFiles.checked;
  const buttons = [...removeFolderDialog.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  removeFolderFiles.disabled = true;
  removeFolderStatus.textContent = deleteFiles ? '正在删除文件夹…' : '正在移除文件夹…';
  try {
    if (!deleteFiles) {
      if (folder.shared) await setSharedFolderVisibility(folder, true);
      else await setFolderVisibility(folder, true);
    } else {
      const library = state.libraries.find(item => item.id === folder.libraryId);
      if (!library || !findFolder(folderTrees.get(folder.libraryId), folder.path)) throw Error('文件夹已变更，请重新选择');
      checkFolderCanBeHidden(folder, library, true);
      const inTeam = team.active;
      const result = await api('delete_workspace_folder', {libraryId:folder.libraryId, folder:folder.path,
        ...(inTeam ? {teamId:team.info.team.id} : {}),
      });
      let pending = result.indexPending;
      if (folder.scope === collectionScope()) {
        if (inTeam) await refreshTeam(true).catch(() => { pending = true; });
        else await refresh().catch(() => { pending = true; });
      }
      toast(pending ? '文件夹已删除，正在等待索引更新' + (result.indexError ? ' · ' + result.indexError : '') : '已删除「' + folder.name + '」', Boolean(result.indexError));
    }
    removeFolderDialog.close();
  } catch (failure) {
    removeFolderStatus.textContent = String(failure?.message || failure);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
    removeFolderFiles.disabled = !folder.canDelete;
  }
});

let newFolderParent = null;
function showNewFolder(folder) {
  if (!canEditFolderStructure()) return;
  newFolderParent = {...folder, scope:collectionScope()};
  $('#new-team-folder-form').reset();
  $('#new-team-folder-parent').textContent = folder.diskPath;
  $('#new-team-folder-status').textContent = '';
  openDialog('#new-team-folder-dialog');
  $('#new-team-folder-name').focus();
}
$('#new-team-folder-form').addEventListener('submit', async event => {
  event.preventDefault();
  const parent = newFolderParent;
  const name = $('#new-team-folder-name').value.trim();
  const button = $('#new-team-folder-submit');
  if (!parent || !canEditFolderStructure() || parent.scope !== collectionScope() || !name || button.disabled) return;
  button.disabled = true;
  const status = $('#new-team-folder-status');
  status.textContent = '';
  try {
    const wasTeam = team.active;
    const result = await api(wasTeam ? 'team_create_folder' : 'create_library_folder', {
      ...(wasTeam ? {teamId:team.info.team.id} : {}), libraryId:parent.libraryId, folder:parent.path, name,
    });
    let pending = Boolean(result.indexPending);
    if (parent.scope === collectionScope()) {
      if (!wasTeam) await refresh();
      else if (!pending) await refreshTeam(true).catch(() => { pending = true; });
      if (parent.scope === collectionScope() && !pending) openFolder(parent.libraryId, result.folder);
    }
    if (parent === newFolderParent) $('#new-team-folder-dialog').close();
    toast(pending ? '已新建文件夹，等待 NAS 索引更新' : '已新建文件夹');
  } catch (failure) {
    if (parent === newFolderParent) status.textContent = String(failure?.message || failure);
  } finally {
    button.disabled = false;
  }
});

const renameFolderDialog = $('#rename-folder-dialog');
const renameFolderName = $('#rename-folder-name');
const renameFolderStatus = $('#rename-folder-status');
const renameFolderSubmit = $('#rename-folder-submit');
let folderToRename;

function showRenameFolder(folder) {
  if (!canEditFolderStructure()) {
    toast('请先解锁文件夹编辑，再重命名');
    return;
  }
  folderToRename = {...folder, scope:collectionScope()};
  $('#rename-folder-path').textContent = folder.diskPath;
  renameFolderName.value = folder.name;
  renameFolderStatus.textContent = '';
  openDialog('#rename-folder-dialog');
  renameFolderName.select();
}

renameFolderDialog.addEventListener('cancel', event => {
  if (renameFolderSubmit.disabled) event.preventDefault();
});
$('#rename-folder-form').addEventListener('submit', async event => {
  event.preventDefault();
  const folder = folderToRename;
  if (!folder || renameFolderSubmit.disabled) return;
  const library = state.libraries.find(item => item.id === folder.libraryId);
  if (!canEditFolderStructure() || folder.scope !== collectionScope() || !library?.path ||
      (team.active && !library.watching) || !findFolder(folderTrees.get(folder.libraryId), folder.path)) {
    renameFolderStatus.textContent = '文件夹已变更或已锁定，请重新选择';
    return;
  }
  const name = renameFolderName.value.trim();
  if (!name || name === folder.name) {
    renameFolderStatus.textContent = '请输入不同的文件夹名称';
    return;
  }
  const controls = [renameFolderName, ...renameFolderDialog.querySelectorAll('button')];
  controls.forEach(control => { control.disabled = true; });
  renameFolderStatus.textContent = '正在重命名文件夹…';
  try {
    const parent = folder.path.split('/').slice(0, -1).join('/');
    await updateFolderPath(folder.libraryId, folder.path, parent, name);
    renameFolderDialog.close();
  } catch (failure) {
    renameFolderStatus.textContent = String(failure?.message || failure);
  } finally {
    controls.forEach(control => { control.disabled = false; });
    if (renameFolderDialog.open) renameFolderName.focus();
  }
});

const folderAppearance = initFolderAppearance({
  scope:collectionScope, icon, notify:toast,
  change() {
    displayedLibraryTree = null;
    renderLibraryTree();
    for (const card of $$('#subfolder-grid .subfolder-card')) {
      const glyph = folderAppearance.icon(card.dataset.library, card.dataset.subfolder);
      for (const target of card.querySelectorAll('.subfolder-placeholder, .subfolder-cover-badge')) target.innerHTML = glyph;
    }
  },
});
const folderContext = initFolderContext({
  appearanceChoices:folderAppearance.choices,
  lookup(libraryId, path) {
    const library = state.libraries.find(item => item.id === libraryId);
    const node = library && findFolder(folderTrees.get(libraryId), path);
    const mounted = native && Boolean(library?.path && (!team.active || library.watching));
    return node && {libraryId, path:node.path, name:node.name, diskPath:diskFolderPath(library, node.path),
      canCreate:mounted && canEditFolderStructure(), canDelete:mounted && canEditFolderStructure(),
      canRename:mounted && Boolean(node.path),
      canRefresh:native && Boolean(team.active ? library.watching : library.path),
      canGenerateThumbnails:native && Boolean(library.path) && node.count > 0,
      shared:canManageSharedFolders()};
  },
  hiddenFolders() {
    if (!native) return [];
    if (team.active) {
      const describe = ({libraryId, path}, shared) => {
        const library = team.allLibraries.find(item => item.id === libraryId);
        if (!library) return [];
        const name = path.split('/').at(-1) || library.name;
        return [{libraryId, path, name, libraryName:library.name, diskPath:diskFolderPath(library, path),
          shared, scopeLabel:shared ? '团队移除' : '本机移除', canPromote:!shared && canManageSharedFolders()}];
      };
      return [
        ...(canManageSharedFolders() ? team.sharedHiddenFolders.flatMap(rule =>
          describe({libraryId:rule.libraryId, path:rule.folder}, true)) : []),
        ...team.removedFolders.flatMap(rule => describe(rule, false)),
      ];
    }
    return state.hiddenFolders.map(folder => ({
      libraryId:folder.libraryId, path:folder.folder, name:folder.name, diskPath:folder.path,
    }));
  },
  canManage: canEditFolderStructure,
  removeLabel: folder => folder.shared ? '从团队资产库中移除'
    : team.active ? '从本机资产库中移除' : '从资产库中移除',
  canOpen: folder => native && Boolean(folder.diskPath),
  isPinned: folder => workspaceNavigation.isPinned(folder.libraryId, folder.path),
  open: folder => openFolder(folder.libraryId, folder.path),
  togglePin: folder => workspaceNavigation.togglePin(folder.libraryId, folder.path),
  copyPath: copyFolderPath,
  browseInExplorer: folder => api('open_folder_location', {path:folder.diskPath}),
  async refreshStructure(folder) {
    const library = state.libraries.find(item => item.id === folder.libraryId);
    if (!library) return;
    const scope = collectionScope();
    toast('正在刷新「' + library.name + '」的文件夹结构…');
    const result = await scanWorkspaceLibrary(library);
    if (scope === collectionScope()) toast(result.errors?.length ? '已刷新，部分文件夹无法读取' : '文件夹结构已刷新', Boolean(result.errors?.length));
  },
  createFolder: showNewFolder,
  rename: showRenameFolder,
  generateThumbnails: folder => showThumbnailSettings([], folder),
  includeChildren(folder) {
    state.recursive = true;
    $('#include-descendants').checked = true;
    openFolder(folder.libraryId, folder.path);
  },
  remove: showRemoveFolder,
  restore: folder => folder.shared ? setSharedFolderVisibility(folder, false) : setFolderVisibility(folder, false),
  promote: folder => setSharedFolderVisibility(folder, true, true),
  notify: toast,
});
$('#view-removed-folders').addEventListener('click', folderContext.openRemoved);
const assetCompare = initAssetCompare({
  readPreview: (asset, mode) => api('read_preview', {id: asset.id, mode}),
  meshCapable,
  loadMesh,
  describeAsset: asset => [asset.ext.toUpperCase(), displayAssetType(asset), bytes(asset.size)].filter(Boolean).join(' · '),
});
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.altKey) return;
  if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) {
    event.preventDefault();
    if (!event.repeat && !$('dialog[open]')) {
      if (state.view === 'subscriptions') creativeSubscriptions.refresh();
      else if (state.view === 'sites') siteNavigation.render();
      else if (state.view === 'whiteboard') whiteboard.refresh();
      else refreshCurrentWorkspace();
    }
    return;
  }
  const active = document.activeElement;
  const editing = active?.matches('input, textarea, select, [contenteditable="true"]');
  if ($('dialog[open]')) return;
  if (state.view === 'whiteboard') return;
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (state.view === 'subscriptions') creativeSubscriptions.focusSearch();
      else if (state.view === 'sites') $('#browser-site-filter').focus();
      else focusAssetSearch({select:true});
    } else if (event.key.toLowerCase() === 'a' && active?.closest('#asset-grid')) {
      event.preventDefault();
      $('#select-visible').click();
    } else if (event.key.toLowerCase() === 'c' && !event.shiftKey && !editing && isAssetView() &&
        !active?.closest('button, a') && document.getSelection()?.isCollapsed) {
      const cardId = active?.closest('#asset-grid .asset-card')?.dataset.id;
      const assetIds = whiteboardMediaIds(cardId ? draggedIds(cardId) : []);
      if (assetIds.length) {
        event.preventDefault();
        if (!event.repeat) copyWhiteboardMediaReferences(assetIds).catch(error);
      }
    }
    return;
  }
  if (editing) return;
  if (event.key === '/') {
    event.preventDefault();
    if (state.view === 'subscriptions') creativeSubscriptions.focusSearch();
    else if (state.view === 'sites') $('#browser-site-filter').focus();
    else focusAssetSearch();
  }
  if (!isAssetView()) return;
  if (event.key === 'Escape') clearAssetModeHighlight();
  if (event.key === ' ' && !active?.matches('button, a') && selected()) {
    event.preventDefault();
    showQuickPreview(state.selected);
  }
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) && !active?.matches('button, a')) {
    const cards = $$('#asset-grid .asset-card');
    const index = cards.findIndex(card => card.dataset.id === state.selected);
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const rowSize = state.list || !cards.length ? 1
      : cards.filter(card => card.offsetTop === cards[0].offsetTop).length;
    const offset = (forward ? 1 : -1) * (vertical ? rowSize : 1);
    const next = cards[Math.max(0,Math.min(cards.length - 1, index + offset))];
    if (next && !active?.closest('.inspector, .sidebar, .workspace-divider')) {
      event.preventDefault();
      selectAsset(next.dataset.id).catch(error);
      next.focus();
    }
  }
});
if (native) window.__TAURI__.event.listen('scan-progress', ({payload}) => {
  if (folderScan && payload > 0) showFolderScan('后台索引 · 已处理 ' + payload.toLocaleString('zh-CN') + ' 项资产');
});
let activityBusy = false;
const connectionSnapshot = sessions => JSON.stringify(sessions.map(session =>
  [session.id, session.dcc, session.label, session.placement, session.smartImport, session.sceneImportOptions,
    session.projectExport]).sort((a, b) => a[0].localeCompare(b[0])));
const jobSnapshot = jobs => JSON.stringify(jobs.map(job =>
  [job.id, job.status, job.progress, job.progressStage, job.error, job.message, job.projectPath]));
setInterval(async () => {
  if (activityBusy || (document.hidden && !c4dDropImport.pending())) return;
  activityBusy = true;
  try {
    const data = await api('get_activity');
    const sessionsChanged = connectionSnapshot(data.sessions) !== connectionSnapshot(state.sessions);
    const jobsChanged = jobSnapshot(data.jobs) !== jobSnapshot(state.jobs);
    const previous = jobsChanged ? new Map(state.jobs.map(job => [job.id, job.status])) : null;
    state.sessions = data.sessions;
    state.jobs = data.jobs;
    c4dDropImport.renderActivity(data.jobs);
    if (sessionsChanged) renderConnections();
    else if (jobsChanged && state.view === 'jobs') renderJobs();
    if (!jobsChanged) return;
    renderJobCount();
    if (state.jobs.some(job => job.dcc === 'c4d' && previous.get(job.id) !== job.status &&
        ['done', 'failed'].includes(job.status))) c4dImportPreferences.checkCacheSize();
    for (const job of state.jobs) {
      if (previous.get(job.id) === job.status) continue;
      runtimeLog.jobResult(job);
      if (previous.has(job.id) && ['done', 'failed'].includes(job.status)) {
        toast(job.status === 'done'
          ? `${job.name} 已成功导入 ${dccs[job.dcc]?.name}`
          : `${job.name} 导入失败：${job.error}`, job.status === 'failed');
      }
    }
  } catch {
  } finally {
    activityBusy = false;
  }
}, 2500);
async function restoreWorkspace() {
  if (native) {
    const restoreTeam = localStorage.getItem('nexus-workspace') === 'team';
    const [workspace, saved] = await Promise.all([
      workspacePicker.read().catch(e => { error(e); return null; }),
      api('team_status').catch(e => { error(e); return null; }),
    ]);
    if (workspace) personalWorkspace = workspace;
    team.configured = Boolean(saved?.configured);
    if (team.configured) {
      $('#team-url').value = saved.url;
      $('#team-allow-lan').checked = saved.allowLanHttp;
      if (restoreTeam) {
        try {
          const [savedWorkspace, activity] = await Promise.all([
            readTeamWorkspace(), api('get_activity').catch(() => null),
          ]);
          if (activity) Object.assign(state, {sessions:activity.sessions, jobs:activity.jobs});
          enterTeam(savedWorkspace.catalog, savedWorkspace);
          renderConnections();
          c4dDropImport.renderActivity(state.jobs);
          return;
        } catch (e) {
          toast('无法打开上次使用的团队库，已切到个人库 · ' + (e?.message || e), true);
        }
      }
    }
  }
  loadLibraryPreferences();
  updateWorkspaceLabel();
  setView(workspaceOpeningView(libraryPreferences));
  await refresh();
  await loadCollections();
  await renderInspector(false);
}

try {
  await restoreWorkspace();
} catch (e) {
  $('#footer-status').textContent = '加载工作台失败';
  error(e);
} finally {
  $('#app').classList.remove('app-starting');
  $('#startup-status').classList.add('hidden');
}
void dccConnections.refresh();
