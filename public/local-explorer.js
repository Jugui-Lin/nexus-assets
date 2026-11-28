import {createFrequentFolders,frequentFolderDwell} from './local-explorer-frequent-folders.js';
import {initExplorerAssets,initExplorerCatalogSearch} from './local-explorer-assets.js';
import {initExplorerAddressCompletion} from './local-explorer-address-completion.js';
import {showExplorerBatchRename} from './local-explorer-batch-rename.js';
import {initExplorerCommandSearch} from './local-explorer-command-search.js';
import {createExplorerDirectorySelections,explorerShotCode,initExplorerProjectFilters} from './local-explorer-project-filters.js';
import {showExplorerPasteConflicts} from './local-explorer-paste.js';
import {showExplorerBatchTabs} from './local-explorer-batch-tabs.js';
import {explorerPathFormats,formatExplorerPaths} from './local-explorer-path-format.js';
import {explorerShortcutAction,normalizeExplorerShortcuts} from './local-explorer-shortcuts.js';
import {distinguishTabLabels} from './workspace-tab-labels.js';
import {simplifyAssetQuery} from './asset-empty-search.js';
import {groupExplorerRenderSequences,isExplorerRenderFrame} from './local-explorer-render-sequences.js';

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
});
const displayNumber = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:1});
const dateGroupNames = ['今天', '昨天', '本周早些时候', '本月早些时候', '更早'];
const defaultDownloadsOrder = {sortBy:'date',descending:true,groupBy:'date'};
const historyLimit = 60;
const tabLimit = 24;
const sourceSelectionLimit = 250;
const closedTabLimit = 12;
const pinLimit = 32;
const pinKey = 'nexus-file-workspace-pins-v1';
const sidebarPinKey = 'nexus-file-workspace-sidebar-pins-v1';
const tabSessionKey = 'nexus-file-workspace-tab-session-v1';
const pendingShellPathKey = 'nexus-file-shell-pending-v1';
const networkLocation = 'nexus:network';
const treeWorkers = 3;
const treeCacheLimit = 96;
const initialPlaceWait = 120;
const iconSizes = ['small','medium','large','extra-large'];
const thumbnailSizes = {medium:128,large:192,'extra-large':256};
const listViews = ['details','grid','list','tiles','content'];
const sortFields = ['name','date','type','size','created'];
const searchScopes = ['folder','library','both'];
let tabSequence = 0;
const defaultPreferences = {startLocation:'computer',showFrequent:true,showHidden:false,showThumbnails:true,
  showStatus:true,showExtensions:true,showNavigation:true,openMode:'double',compact:false,
  startMode:'new',startupPaths:[],showToolbar:true,showBookmarks:true,openBookmarkInNewTab:false,
  doubleClickUp:true,ctrlDoubleClickTab:true,doubleClickCloseTab:true,wheelSwitchTabs:false,quickPreview:true,
  stackSequences:true,showUnindexed:false};

const placeIcons = {
  home:'home', desktop:'explorer-computer', downloads:'download', documents:'notes',
  pictures:'picture', music:'explorer-music', videos:'explorer-video',
};

function dateGroupBoundaries() {
  const today = new Date();
  today.setHours(0,0,0,0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const week = new Date(today);
  week.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const month = new Date(today);
  month.setDate(1);
  return [today.getTime(),yesterday.getTime(),Math.min(week.getTime(),yesterday.getTime()),
    Math.min(month.getTime(),week.getTime())];
}

function dateGroup(entry,boundaries) {
  if (!Number.isFinite(entry.modified)) return 'unknown';
  const index = boundaries.findIndex(start => entry.modified >= start);
  return String(index < 0 ? dateGroupNames.length - 1 : index);
}

function fileType(entry) {
  if (entry.isDirectory) return '文件夹';
  const extension = /[^.][.]([^.]+)$/.exec(entry.name)?.[1];
  return extension ? extension.toUpperCase() + ' 文件' : '文件';
}

function sizeText(size) {
  if (!Number.isFinite(size)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return displayNumber.format(size) + ' ' + units[unit];
}

function dateText(milliseconds) {
  const date = new Date(milliseconds);
  return Number.isFinite(milliseconds) && Number.isFinite(date.getTime()) ? dateFormat.format(date) : '—';
}

function pathKey(path) {
  const value = path || '';
  return /^(?:[a-z]:|[\\/]{2})/i.test(value)
    ? value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    : value === '/' ? value : value.replace(/\/+$/, '');
}

function treePathKey(path) {
  return pathKey(path?.replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\(?=[a-z]:)/i,''));
}

function pathLocations(directory) {
  const result = [{label:'此电脑',path:''}];
  if (!directory) return result;
  if (directory === networkLocation) return [...result,{label:'网络',path:networkLocation}];
  const drive = /^(?:\\\\\?\\)?([a-z]:)[\\/]/i.exec(directory);
  const unc = drive ? null : /^(?:\\\\\?\\UNC\\|[\\/]{2})/i.exec(directory);
  const root = drive?.[0] || unc?.[0] || '/';
  if (!unc) result.push({label:drive?.[1] || '/',path:root});
  const split = drive || unc ? /[\\/]/ : /\//;
  const names = directory.slice(root.length).split(split).filter(Boolean);
  const separator = root.endsWith('\\') ? '\\' : '/';
  let path = root;
  for (const label of names) {
    path += (path.endsWith(separator) ? '' : separator) + label;
    result.push({label,path});
  }
  return result;
}

function readSavedLocations(storage,key,limit) {
  try {
    const saved = JSON.parse(storage.getItem(key) || '[]');
    return Array.isArray(saved) ? saved.filter(item => typeof item?.path === 'string' && item.path &&
      typeof item.name === 'string').slice(0,limit) : [];
  } catch {
    return [];
  }
}

function startupPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.trim().replace(/^"(.*)"$/,'$1');
  if (!path || path === '此电脑') return '';
  if (path === '网络' || path === networkLocation) return networkLocation;
  if (path.length > 32768 || /[\u0000-\u001f]/.test(path)) return null;
  return /^(?:[a-z]:(?:[\\/]|$)|[\\/]|(?:file|smb):\/\/)/i.test(path) ? path : null;
}

function cleanAddressText(value) {
  let path = value.trim();
  const close = {'"':'"',"'":"'",'“':'”','‘':'’'}[path[0]];
  if (path.length > 1 && close && path.endsWith(close)) path = path.slice(1,-1).trim();
  return /[\u0000-\u001f\u0085\u2028\u2029]/.test(path) ? null : path;
}

function initialTabs(values,active,pinned) {
  if (!Array.isArray(values)) return {paths:[],active:0};
  const paths = values.slice(0,tabLimit).map(startupPath);
  return {paths:paths.filter(path => path !== null),
    pinned:paths.flatMap((path,index) => path === null ? [] : [pinned?.[index] === true]),
    active:paths[active] == null ? 0 : paths.slice(0,active).filter(path => path !== null).length};
}

function detachedTabOrder(order) {
  return {sortBy:sortFields.includes(order.sortBy) ? order.sortBy : 'name',
    descending:order.descending === true,groupBy:order.groupBy === 'date' ? 'date' : 'none'};
}

function createTab() {
  return {
    identity:'file:' + ++tabSequence,searchScope:'folder',catalogQuery:'',pinned:false,
    history:[],index:-1,snapshot:null,request:null,selected:null,query:'',scrollTop:0,status:'',
    error:false,view:'details',driveView:'grid',iconSize:'medium',driveIconSize:'medium',
    sortBy:'name',descending:false,groupBy:'none',stalePaths:new Map(),collapsedDateGroups:new Set(),
    expandedSequences:new Set(),
    selection:new Map(),selectionAnchor:null,selectionRevision:0,
  };
}

function gridThumbnails(scroller,tbody,{thumbnail,folderThumbnail,sequenceThumbnail,fileIcon},isActive) {
  const owner = tbody.ownerDocument;
  const Observer = owner.defaultView.IntersectionObserver;
  if (!(thumbnail || folderThumbnail || sequenceThumbnail || fileIcon) || !Observer) return () => {};

  const candidates = new Map();
  const queued = new Map();
  const cache = new Map();
  const inFlight = new Map();
  let cacheBytes = 0;
  let revision = 0;
  let currentSize = 0;
  let currentFolderSize = 0;
  let currentSequenceSize = 0;
  let currentPreviews = true;
  let currentFirstRow;

  function imageSource(value) {
    return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
  }

  async function filePreview({path,size,showPreviews}) {
    let source = null;
    let icon = null;
    let cacheable = true;
    if (showPreviews && thumbnail) {
      try { source = imageSource(await thumbnail({path,size:Math.max(size,128)})); }
      catch { cacheable = false; }
    }
    if (fileIcon) {
      try { icon = imageSource(await fileIcon({path,size:source ? 24 : size})); }
      catch { cacheable = false; }
    }
    return {source:source || icon,badge:source ? icon : null,cacheable};
  }

  async function folderPreview({path,size}) {
    return {source:imageSource(await folderThumbnail({path,size}))};
  }

  async function sequencePreview({path,size}) {
    return {source:imageSource(await sequenceThumbnail({path,size:Math.max(size,128)}))};
  }

  function previewBytes(preview) {
    return (preview.source?.length || 0) + (preview.badge?.length || 0);
  }

  function cachePreview(key,preview) {
    cache.set(key,preview);
    cacheBytes += previewBytes(preview);
    while (cache.size > 96 || cacheBytes > 16 * 1024 * 1024) {
      const oldest = cache.keys().next().value;
      cacheBytes -= previewBytes(cache.get(oldest));
      cache.delete(oldest);
    }
  }

  function requestPreview({path,key,size,load,showPreviews,revision:requestedRevision}) {
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const pending = inFlight.get(key);
    if (pending) return pending;
    const work = Promise.resolve().then(() => load({path,size,showPreviews})).then(preview => {
      if (requestedRevision === revision && preview.cacheable !== false) cachePreview(key,preview);
      return preview;
    }).catch(() => undefined).finally(() => {
      inFlight.delete(key);
      pump();
    });
    inFlight.set(key,work);
    return work;
  }

  async function decodeImage(source) {
    if (!source) return null;
    const image = owner.createElement('img');
    image.alt = '';
    image.draggable = false;
    image.src = source;
    try { await image.decode(); return image; } catch { return null; }
  }

  function clearPreview(row) {
    row.querySelector('.local-explorer-file-thumbnail, .local-explorer-folder-thumbnail, .local-explorer-sequence-thumbnail')?.remove();
    row.removeAttribute('data-has-thumbnail');
  }

  async function putPreview(row,job) {
    const preview = await requestPreview(job);
    if (candidates.get(row) !== job || !isActive() || !preview) return;
    const [main,badge] = await Promise.all([decodeImage(preview.source),decodeImage(preview.badge)]);
    if (candidates.get(row) !== job || !isActive()) return;
    clearPreview(row);
    const image = main || badge;
    if (!image) return;
    if (job.isSequence) {
      image.className = 'local-explorer-sequence-thumbnail';
      row.querySelector('.local-explorer-sequence-toggle').append(image);
      row.setAttribute('data-has-thumbnail','');
      return;
    }
    image.className = 'local-explorer-entry-thumbnail';
    image.classList.toggle('local-explorer-folder-thumbnail',job.isDirectory);
    const button = row.querySelector('.local-explorer-entry');
    if (job.isDirectory) {
      button.querySelector('.local-explorer-folder-preview').append(image);
    } else {
      const visual = owner.createElement('span');
      visual.className = 'local-explorer-file-thumbnail';
      visual.append(image);
      if (main && badge) {
        badge.className = 'local-explorer-file-badge';
        visual.append(badge);
      }
      button.insertBefore(visual,button.querySelector('.local-explorer-entry-name'));
    }
    row.setAttribute('data-has-thumbnail','');
  }

  function pump() {
    if (!isActive()) return;
    for (const [row,job] of queued) {
      if (!cache.has(job.key) && !inFlight.has(job.key) && inFlight.size >= 2) continue;
      queued.delete(row);
      job.started = true;
      void putPreview(row,job);
    }
  }

  const observer = new Observer(entries => {
    for (const {target,isIntersecting} of entries) {
      const job = candidates.get(target);
      if (!job || job.started) continue;
      if (isIntersecting) queued.set(target,job);
      else queued.delete(target);
    }
    pump();
  },{root:scroller,rootMargin:'64px 0px'});

  return (entries,size = 0,refresh = false,folderSize = 0,showPreviews = true,sequenceSize = 0) => {
    const firstRow = tbody.firstElementChild;
    if (!refresh && currentSize === size && currentFolderSize === folderSize && currentFirstRow === firstRow &&
        currentPreviews === showPreviews && currentSequenceSize === sequenceSize) return;
    const removePreviews = currentPreviews && !showPreviews;
    currentSize = size;
    currentFolderSize = folderSize;
    currentSequenceSize = sequenceSize;
    currentFirstRow = firstRow;
    currentPreviews = showPreviews;
    observer.disconnect();
    queued.clear();
    candidates.clear();
    if (refresh) {
      revision++;
      cache.clear();
      cacheBytes = 0;
      return;
    }
    if (!size || !folderSize || !sequenceSize || removePreviews) {
      for (const row of tbody.querySelectorAll('[data-has-thumbnail]')) {
        const entry = entries[Number(row.dataset.entryIndex)];
        const hasSize = row.dataset.sequenceCoverIndex !== undefined ? sequenceSize : entry?.isDirectory ? folderSize : size;
        if (removePreviews || !hasSize) clearPreview(row);
      }
      if (!size && !folderSize && !sequenceSize) return;
    }
    for (const row of tbody.querySelectorAll('[data-entry-index], [data-sequence-cover-index]')) {
      const isSequence = row.dataset.sequenceCoverIndex !== undefined;
      const entry = entries[Number(row.dataset.sequenceCoverIndex ?? row.dataset.entryIndex)];
      if (!entry) continue;
      const load = isSequence ? sequenceThumbnail && sequencePreview : entry.isDirectory ? folderThumbnail && folderPreview : filePreview;
      const previewSize = isSequence ? sequenceSize : entry.isDirectory ? folderSize : size;
      if (!load || !previewSize) continue;
      candidates.set(row,{path:entry.path,isDirectory:entry.isDirectory,isSequence,size:previewSize,load,showPreviews,revision,
        key:JSON.stringify([revision,pathKey(entry.path),entry.isDirectory,isSequence,entry.modified,entry.size,previewSize,showPreviews])});
      observer.observe(row);
    }
  };
}

function visibleEntryDetails(scroller,tbody,entryDetails,isActive,applyDetails) {
  const Observer = tbody.ownerDocument.defaultView.IntersectionObserver;
  if (!entryDetails || !Observer) return () => {};
  const rows = new Map();
  const queued = new Map();
  const cache = new Map();
  let busy = false;
  let revision = 0;
  let previousFirstRow;
  let previousColumns;

  async function pump() {
    if (busy || !isActive()) return;
    const batch = [];
    for (const [row,job] of queued) {
      if (cache.has(job.key)) {
        queued.delete(row);
        job.started = true;
        applyDetails(row,cache.get(job.key));
      } else if (batch.length < 50 && (!batch.length || job.fields === batch[0].fields)) {
        queued.delete(row);
        job.started = true;
        batch.push(job);
      }
    }
    if (!batch.length) return;
    busy = true;
    const requestRevision = revision;
    try {
      const result = await entryDetails({paths:batch.map(job => job.path),columns:batch[0].columns});
      if (requestRevision !== revision || !Array.isArray(result)) return;
      const found = new Map(result.map(item => [pathKey(item?.path),item?.values]));
      for (const job of batch) {
        const values = found.get(pathKey(job.path));
        const details = values && typeof values === 'object' ? values : {};
        cache.set(job.key,details);
        if (rows.get(job.row) === job && isActive()) applyDetails(job.row,details);
      }
      while (cache.size > 512) cache.delete(cache.keys().next().value);
    } catch {
      // Unavailable properties retain their placeholder. F5 retries them.
    } finally {
      busy = false;
      void pump();
    }
  }

  const observer = new Observer(entries => {
    for (const {target,isIntersecting} of entries) {
      const job = rows.get(target);
      if (!job || job.started) continue;
      if (isIntersecting) queued.set(target,job);
      else queued.delete(target);
    }
    void pump();
  },{root:scroller});

  return (entries = [],columns = [],refresh = false) => {
    const firstRow = tbody.firstElementChild;
    const enabled = columns.join(',');
    if (!refresh && previousFirstRow === firstRow && previousColumns === enabled) return;
    previousFirstRow = firstRow;
    previousColumns = enabled;
    observer.disconnect();
    queued.clear();
    rows.clear();
    if (refresh) {
      revision++;
      cache.clear();
    }
    if (!columns.length) return;
    for (const row of tbody.querySelectorAll('tr[data-entry-index]')) {
      const entry = entries[Number(row.dataset.entryIndex)];
      if (!entry) continue;
      const needed = columns.filter(id => id !== 'created' || !Number.isFinite(entry.created));
      if (!needed.length) continue;
      const fields = needed.join(',');
      const key = JSON.stringify([pathKey(entry.path),entry.modified,entry.size,fields]);
      rows.set(row,{row,path:entry.path,columns:needed,fields,key});
      observer.observe(row);
    }
  };
}

export function initLocalExplorer({
  root,tabBar,browse,open,reveal,contextMenu,computer,driveDetails,thumbnail,columns,
  folderThumbnail,sequenceThumbnail,fileIcon,entryDetails,selectAllEntries,clipboard,pasteConflicts,fileAction,onOpenAssetLibrary,onOpenFiles,treeChildren,
  onBrowseAssets,onAddToAssets,onOpenAssetPane,onOpenAssetDetails,onSelectionChange,onQuickPreview,onDetachTab,onInspectRenderSequence,onCompareExrChannels,
  canCloseLastTab,
  lookupAssets,onLoadAssets,onToggleFavorite,assetRating,onAddToCollection,onAddToBasket,onSendToC4d,onAddToWhiteboard,
  canMoveIndexedFiles,onMoveIndexedFiles,onProjectDependencies,onCreateFolderShortcut,onInspectCleanup,onOpenShotBoard,searchAssets,assetSearchKey,
  projectFiltersEnabled = false,
  checkFolderPaths,detachedWindow = false,deferInitialTab = false,preferences,
  copy = text => navigator.clipboard.writeText(text),
}) {
  const panel = root?.querySelector('#local-explorer');
  if (!panel || !browse) {
    return {refresh:() => false,focusAddress:() => false,exit:() => false,openPath:() => false,openShellPath:() => false,
      revealSource:() => false,revealSources:() => false,show:() => false,
      restoreDetachedTab:() => false,
      getCurrentDirectory:() => null,getDirectorySearch:() => '',getFileActionDirectory:() => null,getSelectedPath:() => null,getSelectedEntry:() => null,
      getSelectedEntries:() => [],getTabCount:() => 0,applyPreferences:() => {},clearRecentFolders:() => {},refreshAssetDetails:() => {},
      getTabIdentity:() => null,showTabIdentity:() => false,canDuplicateActive:() => false,duplicateActive:() => false,
      findManagedTab:() => null,setTabPinned:() => false,closeOtherTabs:() => false,canCloseOtherTabs:() => false,
      closeManagedTab:() => false,restoreClosedTab:() => false,hasClosedTabs:() => false,
      openBatchPaths:() => false,
      getDropTarget:() => null,getSidebarPinTarget:() => null,getDragSource:() => null,
      refreshAfterTransfer:() => false,pinFolders:() => 0,pinSidebarFolders:() => 0};
  }

  const owner = panel.ownerDocument;
  const storage = owner.defaultView.localStorage;
  const form = panel.querySelector('.local-explorer-form');
  const address = form.querySelector('input');
  const search = panel.querySelector('[data-explorer-search]');
  const searchScope = panel.querySelector('[data-explorer-search-scope]');
  const status = panel.querySelector('.local-explorer-status');
  const recoveryButton = panel.querySelector('[data-explorer-recover-parent]');
  const shellPending = panel.querySelector('[data-explorer-shell-pending]');
  const shellPendingStatus = shellPending?.querySelector('[role="status"]');
  const shellRetry = shellPending?.querySelector('[data-explorer-shell-retry]');
  const shellClear = shellPending?.querySelector('[data-explorer-shell-clear]');
  const pendingShellPaths = new Map();
  let retryingShellPaths = false;
  try {
    const saved = JSON.parse(storage.getItem(pendingShellPathKey));
    if (Array.isArray(saved)) for (const value of saved.slice(-tabLimit)) {
      const path = startupPath(value);
      if (path && path !== networkLocation) pendingShellPaths.set(treePathKey(path),path);
    }
  } catch {}
  const listing = panel.querySelector('.local-explorer-listing');
  const locations = panel.querySelector('.local-explorer-current');
  const scroller = panel.querySelector('.local-explorer-table-scroll');
  const catalogPane = scroller.querySelector('[data-explorer-catalog-search]');
  const table = scroller.querySelector('table');
  const tbody = table.tBodies[0];
  const empty = panel.querySelector('.local-explorer-empty');
  const emptyHelp = panel.querySelector('[data-explorer-empty-help]');
  const emptyShortcuts = emptyHelp?.querySelector('[data-explorer-empty-shortcuts]');
  const emptyQuery = emptyHelp?.querySelector('[data-explorer-empty-query]');
  const simplifiedQuery = emptyHelp?.querySelector('[data-explorer-simplify-query]');
  simplifiedQuery?.addEventListener('click',() => {
    search.value = simplifiedQuery.dataset.query;
    search.dispatchEvent(new Event('input',{bubbles:true}));
    search.focus({preventScroll:true});
  });
  const count = panel.querySelector('.local-explorer-count');
  const footer = panel.querySelector('.local-explorer-list-footer');
  const sidebar = panel.querySelector('.local-explorer-sidebar');
  const sidebarDivider = panel.querySelector('.local-explorer-sidebar-divider');
  const pages = panel.querySelector('.local-explorer-pages');
  const navigation = tabBar || panel;
  const tabsHost = navigation.querySelector('[data-explorer-tabs]');
  const addTabButton = navigation.querySelector('[data-explorer-add-tab]');
  const pinHost = panel.querySelector('[data-explorer-pins]');
  const pinRail = pinHost.closest('.local-explorer-pin-bar');
  const pinButton = panel.querySelector('[data-explorer-pin]');
  const placesHost = panel.querySelector('[data-explorer-places]');
  const drivesHost = panel.querySelector('[data-explorer-drives]');
  const viewButtons = [...panel.querySelectorAll('[data-explorer-view]')];
  const buttons = new Map([...panel.querySelectorAll('[data-explorer-action]')]
    .map(button => [button.dataset.explorerAction,button]));
  const assetButton = navigation.querySelector('[data-explorer-assets]');
  if (assetButton) buttons.set('close',assetButton);
  const browseAssetsButton = panel.querySelector('[data-explorer-asset-action="locate"]');
  const openAssetPaneButton = panel.querySelector('[data-explorer-asset-action="pane"]');
  const favoriteAssetButton = panel.querySelector('[data-explorer-asset-action="favorite"]');
  const collectAssetsButton = panel.querySelector('[data-explorer-asset-action="collect"]');
  const loadAssetsButton = panel.querySelector('[data-explorer-asset-action="load"]');
  const detailCache = new Map();
  let tab = createTab();
  const tabs = deferInitialTab ? [] : [tab];
  const closedTabs = [];
  let pins = readSavedLocations(storage,pinKey,pinLimit);
  let sidebarPins = readSavedLocations(storage,sidebarPinKey,pinLimit)
    .filter(item => !pins.some(pin => pathKey(pin.path) === pathKey(item.path)));
  const frequent = createFrequentFolders(storage,pathKey);
  let frequentShown = [];
  let frequentVisit = null;
  let frequentClearRevision = 0;
  let prefs = {...defaultPreferences,...preferences};
  let startupPending = true;
  let startupRequest;
  let lastTabSession;
  let lastTabClick;
  let lastTabWheelTime = -Infinity;
  let tabDrag;
  let suppressTabDragClick = false;
  const detachingTabs = new Set();
  let places;
  let placesRequest;
  let drivesExpanded = true;
  let networkExpanded = false;
  let activeTreeKey;
  let treeRevealKey = null;
  let treeRepaintQueued = false;
  let treeRunning = 0;
  let treeNodeId = 0;
  let activeTreeLoading = false;
  const treeListings = new Map();
  const openTreeBranches = new Set();
  const closedTreeBranches = new Set();
  const temporaryTreeBranches = new Set();
  const knownServers = new Map();
  let listedDrives = [];
  let detailRunning = 0;
  let renderedBoundaries;
  let sequenceGroups = new Map();
  let lastSelection;
  let loadingAssets = false;
  let assetDataRequested = false;
  const favoriteRequests = new Set();
  let searchTimer;
  let menuOpen = false;
  let wheelDelta = 0;
  let lastWheelTime = 0;
  let marqueeGesture;
  let marqueeFrame = 0;
  let suppressMarqueeClick = false;
  let transferRevision = 0;

  const isActive = () => !root.hidden && !root.classList.contains('hidden');
  const addressCompletion = initExplorerAddressCompletion({input:address,popup:form.querySelector('[data-address-completions]'),
    read:treeChildren && (params => treeChildren({...params,...(prefs.showHidden && {showHidden:true})})),
    isActive:() => isActive() && !tab.request && !tab.fileAction,
  });
  const showThumbnails = gridThumbnails(scroller,tbody,{thumbnail,folderThumbnail,sequenceThumbnail,fileIcon},isActive);
  const tabPath = item => item.history[item.index] ?? item.initialPath ?? '';
  const tabLocation = item => item.request?.destination ?? item.snapshot?.directory ?? tabPath(item);
  const getTabCount = () => tabs.length;
  const getTabIdentity = () => tabs.includes(tab) ? tab.identity : null;
  const canDuplicateActive = () => isActive() && Boolean(tab.snapshot) && tabs.includes(tab) && tabs.length < tabLimit;
  const catalogOnly = () => tab.searchScope === 'library' && Boolean(tab.catalogQuery);
  const searchText = () => tab.searchScope === 'folder' ? tab.query : tab.catalogQuery;
  const isDriveView = snapshot => snapshot && (!snapshot.directory || snapshot.directory === networkLocation);
  const getCurrentDirectory = () => !isDriveView(tab.snapshot) && tab.snapshot?.directory || null;
  const getDirectorySearch = () => getCurrentDirectory() && tab.searchScope !== 'library' ? search.value.trim() : '';
  const getFileActionDirectory = () => isActive() && !catalogOnly() && !tab.request && !tab.fileAction ? getCurrentDirectory() : null;
  const directorySelections = createExplorerDirectorySelections(storage,treePathKey);
  const projectFilters = projectFiltersEnabled && initExplorerProjectFilters({
    panel,storage,key:treePathKey,
    onChange(root) {
      const directory = getCurrentDirectory();
      if (projectFilters.includes(root,directory))
        void navigate(directory,{index:tab.index,offset:0,projectFilterBypass:null});
    },
    onToggle(rule) {
      const directory = getFileActionDirectory();
      if (directory) void navigate(directory,{index:tab.index,offset:0,
        projectFilterBypass:tab.projectFilterBypass === rule.id ? null : rule.id});
    },
    onOpen(root) { void navigate(root,{focusList:true,clearCatalog:true}); },
  });

  function activeProjectFilter(path,bypass) {
    const rule = projectFilters && projectFilters.resolve(path);
    return rule && rule.id !== bypass ? rule.filter : null;
  }
  const getSelectedEntry = () => tab.selection.size === 1 ? tab.selected || null : null;
  const getSelectedEntries = () => [...tab.selection.values()];
  const getSelectedPath = () => getSelectedEntry()?.path || null;
  function hasSelectedFiles() {
    for (const entry of tab.selection.values()) {
      if (!entry.isDirectory) return true;
    }
    return false;
  }
  const assetTarget = (entry,snapshot) => {
    if (!snapshot?.directory || isDriveView(snapshot)) return null;
    return {path:entry?.path || snapshot.directory,isDirectory:entry?.isDirectory ?? true};
  };
  const isDownloads = directory => Boolean(directory && (places?.folders || []).some(folder =>
    folder.id === 'downloads' && pathKey(folder.path) === pathKey(directory)));
  const orderFor = (item,directory) => isDownloads(directory) ? item.downloadsOrder || defaultDownloadsOrder : item;
  function setOrder(changes) {
    tab.emptyFallback = false;
    const directory = getCurrentDirectory();
    if (isDownloads(directory)) tab.downloadsOrder = {...orderFor(tab,directory),...changes};
    else Object.assign(tab,changes);
  }
  const svg = name => {
    const node = owner.createElementNS('http://www.w3.org/2000/svg','svg');
    node.setAttribute('aria-hidden','true');
    const use = owner.createElementNS(node.namespaceURI,'use');
    use.setAttribute('href','#i-' + name);
    node.append(use);
    return node;
  };
  const element = (tag,className,text) => {
    const node = owner.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    if (tag === 'button') node.type = 'button';
    return node;
  };
  const totalCount = owner.createTextNode('');
  const selectionCount = element('span','local-explorer-selection-count');
  selectionCount.tabIndex = -1;
  const marqueeAnnouncement = element('span','local-explorer-speaking-status');
  marqueeAnnouncement.setAttribute('role','status');
  const marquee = element('div','local-explorer-marquee');
  marquee.setAttribute('aria-hidden','true');
  marquee.hidden = true;
  const marqueeCount = element('div','local-explorer-marquee-count');
  marqueeCount.setAttribute('aria-hidden','true');
  marqueeCount.hidden = true;
  root.append(marquee,marqueeCount,marqueeAnnouncement);
  const sidebarSystem = element('div','local-explorer-places-group local-explorer-sidebar-system');
  count.replaceChildren(totalCount,selectionCount);
  const columnLayout = columns?.({
    table,
    showProperties:Boolean(entryDetails),
    showAssets:Boolean(lookupAssets),
    formatters:{dateText,sizeText,fileType},
    onSort({sortBy,descending}) {
      setOrder({sortBy,descending});
      void navigate(tabPath(tab),{index:tab.index,offset:0});
    },
    onChange(addedAssetColumn) {
      if (!tab.snapshot || isDriveView(tab.snapshot)) return;
      tbody.replaceChildren(entryRows(tab.snapshot.entries,tab.snapshot.dateGroups));
      drawSelection();
      updateView();
      if (addedAssetColumn) void loadAssetDetails();
    },
  });
  const showEntryDetails = visibleEntryDetails(scroller,tbody,entryDetails,isActive,
    (row,details) => columnLayout?.updateDetails(row,details));
  const assetDetails = initExplorerAssets({scroller,tbody,lookup:lookupAssets,pathKey:treePathKey,isActive,
    paint:paintAssetDetails,onChange:updateAssetControls});
  const catalogSearch = initExplorerCatalogSearch({pane:catalogPane,search:searchAssets,pathKey:assetSearchKey || treePathKey,
    openFile:asset => openPath(asset.path),icon:svg,
    openAsset:onBrowseAssets && (asset => onBrowseAssets({path:asset.path,isDirectory:false}))});
  if (searchScope) searchScope.hidden = !searchAssets || !catalogPane;

  function refreshAssetDetails() {
    assetDetails.refresh();
    if (isActive()) catalogSearch.refresh();
    else catalogSearch.set(null);
  }

  function paintAssetDetails(row,entry,asset) {
    const button = row.querySelector('.local-explorer-entry');
    let controls = row.querySelector('.local-explorer-row-asset-actions');
    let badge = button.querySelector('.local-explorer-asset-state');
    const text = asset ? (asset.favorite ? '已收藏' : '已入库') : asset === null && prefs.showUnindexed ? '未入库' : '';
    const state = asset ? (asset.favorite ? 'favorite' : 'indexed') : 'unindexed';
    if (asset && (onOpenAssetDetails || onToggleFavorite) && !controls) {
      controls = element('span','local-explorer-row-asset-actions');
      if (onOpenAssetDetails) {
        const details = element('button','local-explorer-asset-state');
        details.dataset.explorerRowAsset = 'details';
        details.setAttribute('aria-controls','file-explorer-inspector');
        controls.append(details);
      }
      if (onToggleFavorite) {
        const favorite = element('button','explorer-icon-button local-explorer-row-asset-favorite');
        favorite.dataset.explorerRowAsset = 'favorite';
        favorite.append(svg('star'));
        controls.append(favorite);
      }
      button.after(controls);
    }
    const action = controls?.querySelector('[data-explorer-row-asset="details"]');
    if (text && !(asset && action)) {
      if (!badge) {
        badge = element('span','local-explorer-asset-state');
        button.append(badge);
      }
      badge.textContent = text;
      badge.dataset.assetState = state;
    } else badge?.remove();
    if (controls && asset === null) {
      if (controls.contains(owner.activeElement)) button.focus({preventScroll:true});
      controls.remove();
    } else if (controls) {
      for (const control of controls.children) {
        control.tabIndex = button.tabIndex;
        control.setAttribute('aria-disabled',String(!asset));
      }
      if (action) {
        action.textContent = text || '…';
        action.dataset.assetState = asset ? state : 'unindexed';
        action.title = '查看资产详情';
        action.setAttribute('aria-label','查看 ' + displayEntryName(entry) + ' 的资产详情' + (text ? '，' + text : ''));
      }
      const favorite = controls.querySelector('[data-explorer-row-asset="favorite"]');
      if (favorite) {
        favorite.title = asset?.favorite ? '移出资产收藏' : '添加到资产收藏';
        favorite.setAttribute('aria-label',favorite.title + '，' + displayEntryName(entry));
        favorite.setAttribute('aria-pressed',String(Boolean(asset?.favorite)));
      }
    }
    button.setAttribute('aria-label',displayEntryName(entry) + (text ? '，' + text : ''));
    columnLayout?.updateAssetDetails(row,asset);
  }

  function updateAssetControls() {
    if (loadAssetsButton) {
      loadAssetsButton.hidden = !onLoadAssets || !lookupAssets || assetDataRequested || assetDetails.available;
      loadAssetsButton.disabled = loadingAssets;
    }
    if (collectAssetsButton) {
      collectAssetsButton.hidden = !onAddToCollection || !getCurrentDirectory() || catalogOnly() || !hasSelectedFiles();
      collectAssetsButton.disabled = Boolean(tab.request || tab.fileAction);
    }
    if (!favoriteAssetButton) return;
    const entry = getSelectedEntry();
    const asset = entry && !entry.isDirectory ? assetDetails.get(entry.path) : null;
    favoriteAssetButton.hidden = !asset || !onToggleFavorite;
    favoriteAssetButton.disabled = Boolean(tab.request || tab.fileAction || favoriteRequests.has(asset?.id));
    favoriteAssetButton.setAttribute('aria-pressed',String(Boolean(asset?.favorite)));
    favoriteAssetButton.title = asset?.favorite ? '移出资产收藏' : '添加到资产收藏';
    favoriteAssetButton.setAttribute('aria-label',favoriteAssetButton.title);
  }

  async function loadAssetDetails() {
    if (!onLoadAssets || loadingAssets || assetDataRequested || assetDetails.available) return;
    const item = tab;
    loadingAssets = true;
    updateAssetControls();
    try {
      await onLoadAssets();
      assetDataRequested = true;
      assetDetails.refresh();
    } catch (failure) {
      report(item,String(failure?.message || failure),true);
    } finally {
      loadingAssets = false;
      updateAssetControls();
    }
  }

  async function toggleAssetFavorite(entry) {
    const asset = entry && !entry.isDirectory ? assetDetails.get(entry.path) : null;
    if (!asset || !onToggleFavorite || favoriteRequests.has(asset.id)) return;
    const revision = assetDetails.revision;
    const favorite = !asset.favorite;
    const item = tab;
    favoriteRequests.add(asset.id);
    updateAssetControls();
    try {
      const applied = await onToggleFavorite({id:asset.id,path:entry.path,favorite});
      assetDetails.update(entry.path,{...asset,favorite:typeof applied === 'boolean' ? applied : favorite},revision);
    } catch (failure) {
      report(item,String(failure?.message || failure),true);
    } finally {
      favoriteRequests.delete(asset.id);
      updateAssetControls();
    }
  }

  function syncLocations() {
    return places?.syncRoots || [];
  }

  function syncLocation(path) {
    const key = treePathKey(path);
    return syncLocations().find(item => treePathKey(item.path) === key);
  }

  function nameForPath(path) {
    const key = pathKey(path);
    if (!key) return '此电脑';
    if (key === networkLocation) return '网络';
    const folder = syncLocation(path) || places?.folders.find(item => pathKey(item.path) === key);
    if (folder) return folder.name;
    const drive = (places?.drives || listedDrives).find(item => treePathKey(item.path) === treePathKey(path));
    if (drive) return driveLabel(drive,detailCache.get(pathKey(drive.path))?.value);
    const letter = /^[a-z]:$/i.test(treePathKey(path)) ? treePathKey(path).toUpperCase() : null;
    return letter ? '本地磁盘 (' + letter + ')' : pathLocations(path).at(-1).label;
  }

  function addressText(path) {
    return !path || path === networkLocation ? nameForPath(path) : path;
  }

  function displayStatus() {
    status.setAttribute('aria-live',tab.status === '正在读取文件列表…' ? 'off' : 'polite');
    status.textContent = tab.status;
    status.hidden = !tab.status;
    status.toggleAttribute('data-error',tab.error);
    if (recoveryButton) {
      const parent = tab.recovery?.parent;
      recoveryButton.hidden = !parent;
      recoveryButton.textContent = parent ? '打开最近可访问的上级文件夹' : '';
      recoveryButton.title = parent || '';
    }
  }

  function report(item, message = '', error = false) {
    item.status = message;
    item.error = error;
    if (item === tab) displayStatus();
  }

  function setDisabled(action, disabled) {
    const button = buttons.get(action);
    if (button) button.disabled = Boolean(disabled);
  }

  function updateControls() {
    const {snapshot,selected,index,history,request,fileAction} = tab;
    const blocked = request || fileAction;
    const multiple = tab.selection.size > 1;
    const driveView = isDriveView(snapshot);
    const physical = driveView || catalogOnly() ? '' : snapshot?.directory;
    projectFilters?.render?.(physical,Boolean(tab.projectFilterBypass),Boolean(blocked));
    listing.setAttribute('aria-busy',String(Boolean(request)));
    setDisabled('back',blocked || index <= 0);
    setDisabled('forward',blocked || index >= history.length - 1);
    setDisabled('history',blocked || !contextMenu || (history.length < 2 && !physical));
    setDisabled('up',blocked || !snapshot?.directory);
    setDisabled('refresh',blocked || !snapshot);
    setDisabled('drives',blocked || snapshot?.directory === null);
    setDisabled('open',blocked || multiple || !selected || (!selected.isDirectory && !open));
    setDisabled('copy',blocked || !(tab.selection.size || physical));
    setDisabled('reveal',blocked || multiple || !reveal || !(selected?.path || physical));
    setDisabled('previous-page',blocked || snapshot?.previousOffset == null);
    setDisabled('next-page',blocked || snapshot?.nextOffset == null);
    if (browseAssetsButton) browseAssetsButton.disabled = !onBrowseAssets || blocked || !physical || multiple && !hasSelectedFiles();
    if (openAssetPaneButton) openAssetPaneButton.disabled = !onOpenAssetPane;
    updateAssetControls();
    addTabButton.disabled = tabs.length >= tabLimit;
    const pinned = physical && pins.some(item => pathKey(item.path) === pathKey(physical));
    const pinnedInSidebar = physical && sidebarPins.some(item => pathKey(item.path) === pathKey(physical));
    pinButton.disabled = !physical || blocked || pinnedInSidebar || (!pinned && pins.length >= pinLimit);
    pinButton.setAttribute('aria-pressed',String(Boolean(pinned)));
    pinButton.title = pinnedInSidebar ? '已固定在侧栏' : pinned ? '取消固定当前文件夹' : '固定当前文件夹';
    pinButton.setAttribute('aria-label',pinButton.title);
    search.disabled = !snapshot;
    if (searchScope) {
      searchScope.disabled = !snapshot;
      searchScope.value = tab.searchScope;
    }
    search.placeholder = tab.searchScope === 'library' ? '搜索当前资产库' : tab.searchScope === 'both' ? '搜索目录和资产库'
      : '在' + nameForPath(tabPath(tab)) + '中搜索';
    search.setAttribute('aria-label',search.placeholder);
    const view = driveView ? tab.driveView : tab.view;
    const iconSize = driveView ? tab.driveIconSize : tab.iconSize;
    for (const button of viewButtons) {
      const size = button.dataset.explorerIconSize;
      button.disabled = !snapshot;
      button.setAttribute('aria-pressed',String(button.dataset.explorerView === view && (!size || size === iconSize)));
    }
    if (onSelectionChange) {
      const selection = [tab,snapshot,tab.selection,tab.selectionRevision,tab.selection.size,catalogOnly()];
      if (!lastSelection || selection.some((value,index) => value !== lastSelection[index])) {
        lastSelection = selection;
        queueMicrotask(() => { if (lastSelection === selection) onSelectionChange(); });
      }
    }
  }

  function renderTabs() {
    const restoreFocus = tabsHost.contains(owner.activeElement);
    const labels = distinguishTabLabels(tabs.map(item => ({id:item.identity,title:nameForPath(tabPath(item)),location:tabPath(item)})));
    tabsHost.replaceChildren(...tabs.map(item => {
      const path = tabPath(item);
      const name = nameForPath(path);
      const label = labels.get(item.identity);
      const wrapper = element('div','local-explorer-tab');
      wrapper.dataset.explorerTabId = item.identity;
      wrapper.toggleAttribute('data-active',item === tab);
      wrapper.toggleAttribute('data-pinned',item.pinned);
      markDropTarget(wrapper,path,name);
      const select = element('button','local-explorer-tab-select');
      select.dataset.tabTitle = name;
      select.append(svg(!path ? 'explorer-computer' : path === networkLocation ? 'explorer-network' :
        syncLocation(path) ? 'explorer-sync' : 'folder'),
        element('span','',label));
      select.title = addressText(path);
      select.setAttribute('aria-label',label + (item.pinned ? '，已固定' : ''));
      if (item.pinned) {
        const marker = svg('pin');
        marker.classList.add('local-explorer-tab-pin');
        select.prepend(marker);
      }
      if (item === tab) select.setAttribute('aria-current','page');
      if (onDetachTab) select.addEventListener('pointerdown',event => prepareTabDetach(item,select,event));
      select.addEventListener('click',event => {
        if (prefs.doubleClickCloseTab && event.detail === 2 && lastTabClick === item) {
          closeTab(item);
          return;
        }
        lastTabClick = item;
        onOpenFiles?.();
        void activateTab(item,true);
      });
      select.addEventListener('dblclick',() => {
        if (prefs.doubleClickCloseTab) closeTab(item);
      });
      const close = element('button','local-explorer-tab-close');
      close.append(svg('close'));
      close.setAttribute('aria-label','关闭 ' + label + ' 标签页');
      close.title = close.getAttribute('aria-label');
      close.addEventListener('click',() => closeTab(item));
      wrapper.append(select,close);
      return wrapper;
    }));
    if (restoreFocus) tabsHost.querySelector('[aria-current="page"]')?.focus({preventScroll:true});
  }

  function prepareTabDetach(item,button,event) {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch' || tabDrag ||
        item.request || item.fileAction || detachingTabs.has(item) || owner.querySelector('dialog[open]')) return;
    const bounds = button.closest('.local-explorer-tab').getBoundingClientRect();
    tabDrag = {item,pointer:event.pointerId,startX:event.clientX,startY:event.clientY,
      offsetX:event.clientX - bounds.left,offsetY:event.clientY - bounds.top,
      width:bounds.width,height:bounds.height,label:button.textContent.trim(),ghost:null};
  }

  function stopTabDrag() {
    const gesture = tabDrag;
    tabDrag = null;
    if (gesture?.ghost) {
      gesture.ghost.remove();
      if (tabsHost.hasPointerCapture(gesture.pointer)) tabsHost.releasePointerCapture(gesture.pointer);
    }
  }

  function moveTabDrag(event) {
    const gesture = tabDrag;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (!(event.buttons & 1) || !tabs.includes(gesture.item) || gesture.item.request || gesture.item.fileAction) {
      stopTabDrag();
      return;
    }
    if (!gesture.ghost) {
      if (Math.hypot(event.clientX - gesture.startX,event.clientY - gesture.startY) < 7) return;
      suppressTabDragClick = true;
      gesture.ghost = element('div','workspace-tab-drag-ghost',gesture.label);
      gesture.ghost.setAttribute('aria-hidden','true');
      gesture.ghost.style.width = gesture.width + 'px';
      gesture.ghost.style.height = gesture.height + 'px';
      owner.body.append(gesture.ghost);
      try { tabsHost.setPointerCapture(gesture.pointer); } catch {}
    }
    event.preventDefault();
    gesture.ghost.style.transform = 'translate3d(' + (event.clientX - gesture.offsetX) + 'px,' +
      (event.clientY - gesture.offsetY) + 'px,0)';
  }

  async function detachFileTab(item,point) {
    if (!tabs.includes(item) || item.request || item.fileAction || detachingTabs.has(item)) return;
    const snapshot = item.snapshot;
    const selectionRevision = item.selectionRevision;
    const path = tabPath(item);
    const selectionPaths = snapshot?.entries.filter(entry => item.selection.has(pathKey(entry.path)))
      .map(entry => entry.path) || [];
    const {query,view,driveView,iconSize,driveIconSize,sortBy,descending,groupBy,downloadsOrder} = item;
    const payload = {path,query,view,driveView,iconSize,driveIconSize,sortBy,descending,groupBy,downloadsOrder,
      offset:snapshot?.offset ?? 0,scrollTop:item === tab && isActive() ? scroller.scrollTop : item.scrollTop,
      selectedPath:item.selected?.path || null,selectionPaths};
    detachingTabs.add(item);
    try {
      if (await onDetachTab(payload,point) === true && tabs.includes(item) && !item.request && !item.fileAction &&
          item.snapshot === snapshot && item.selectionRevision === selectionRevision && tabPath(item) === path)
        closeTab(item,{record:false});
    } catch (failure) {
      report(item,String(failure?.message || failure),true);
    } finally {
      detachingTabs.delete(item);
    }
  }

  if (onDetachTab) {
    const window = owner.defaultView;
    tabsHost.addEventListener('pointerdown',() => { suppressTabDragClick = false; },true);
    for (const type of ['click','dblclick']) tabsHost.addEventListener(type,event => {
      if (!suppressTabDragClick || !event.detail) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },true);
    window.addEventListener('pointermove',moveTabDrag,{capture:true,passive:false});
    window.addEventListener('pointerup',event => {
      const gesture = tabDrag;
      if (!gesture || gesture.pointer !== event.pointerId) return;
      const active = Boolean(gesture.ghost);
      stopTabDrag();
      if (!active) return;
      event.preventDefault();
      const outside = event.clientX < 0 || event.clientY < 0 || event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight;
      if (outside) void detachFileTab(gesture.item,{x:event.screenX,y:event.screenY});
    },true);
    for (const type of ['pointercancel','lostpointercapture']) window.addEventListener(type,event => {
      if (tabDrag?.pointer === event.pointerId) stopTabDrag();
    },true);
    window.addEventListener('blur',stopTabDrag);
    window.addEventListener('keydown',event => {
      if (event.key !== 'Escape' || !tabDrag?.ghost) return;
      event.preventDefault();
      event.stopPropagation();
      stopTabDrag();
    },true);
  }

  function markDropTarget(node,path,label) {
    if (!path || path === networkLocation) return;
    node.dataset.explorerDropPath = path;
    node.dataset.explorerDropLabel = label;
  }

  function locationButton(item,className,icon,rail,onOpen) {
    const button = element('button',className);
    button.append(svg(icon),element('span','',item.name));
    button.title = addressText(item.path);
    markDropTarget(button,item.path,item.name);
    if (rail) {
      button.dataset.explorerPinPath = item.path;
      button.dataset.explorerPinRail = rail;
      if (rail === 'sidebar') {
        const marker = svg('pin');
        marker.classList.add('local-explorer-side-pin-marker');
        button.append(marker);
      }
    }
    button.addEventListener('click',onOpen || (() => {
      const revealTree = !sidebar?.contains(button);
      if (rail && prefs.openBookmarkInNewTab) {
        addTab(item.path,revealTree ? undefined : {navigation:{revealTree}});
      } else void navigate(item.path,{focusList:true,revealTree});
    }));
    if (pathKey(item.path) === pathKey(tabPath(tab))) button.setAttribute('aria-current','page');
    return button;
  }

  function driveLabel(entry,details) {
    const letter = /^[a-z]:/i.exec(entry.path)?.[0];
    if (!letter) return entry.name;
    if (details?.label) return details.label + ' (' + letter + ')';
    if (/^[a-z]:$/i.test(entry.name)) return (entry.kind === 'network' ? '网络驱动器' : '本地磁盘') + ' (' + letter + ')';
    return entry.name;
  }

  function scheduleSystemTree() {
    if (treeRepaintQueued) return;
    treeRepaintQueued = true;
    owner.defaultView.requestAnimationFrame(() => {
      treeRepaintQueued = false;
      if (isActive() && prefs.showNavigation) renderSystemTree();
    });
  }

  function treeListing(path,known) {
    if (!treeChildren || !isActive()) return null;
    const key = treePathKey(path);
    if (treeListings.has(key)) return treeListings.get(key);
    if (treeRunning >= treeWorkers) return null;
    const job = {items:null,failed:false};
    treeListings.set(key,job);
    treeRunning++;
    const showHidden = prefs.showHidden;
    void Promise.resolve().then(() => treeChildren({path,...(showHidden && {showHidden:true}),
      ...(known && {activeChild:known.path})})).then(items => {
      if (!Array.isArray(items)) throw Error('无法读取子文件夹');
      const seen = new Set();
      job.items = items.filter(item => {
        if (typeof item?.path !== 'string' || typeof item.name !== 'string' || !item.path || !item.name) return false;
        const childKey = treePathKey(item.path);
        if (seen.has(childKey) || childKey === key || treePathKey(pathLocations(item.path).at(-2)?.path) !== key)
          return false;
        seen.add(childKey);
        return true;
      });
    }).catch(() => { job.failed = true; }).finally(() => {
      treeRunning--;
      scheduleSystemTree();
    });
    return job;
  }

  function treeNode(item,kind,activeChildren,fixedChildren,level = 1) {
    const key = treePathKey(item.path);
    const known = activeChildren.get(key);
    const normallyOpen = kind === 'computer' ? drivesExpanded : kind === 'network' ? networkExpanded :
      !closedTreeBranches.has(key) && (openTreeBranches.has(key) || Boolean(known));
    const open = normallyOpen || temporaryTreeBranches.has(key);
    const tree = element('div','local-explorer-tree');
    tree.dataset.treeKind = kind;
    const row = element('div','local-explorer-tree-row');
    const toggle = element('button','local-explorer-tree-toggle');
    const children = element('div','local-explorer-tree-children');
    children.id = 'local-explorer-tree-' + ++treeNodeId;
    toggle.append(svg('chevron'));
    toggle.setAttribute('aria-controls',children.id);
    const current = treeListings.get(key);
    toggle.disabled = fixedChildren ? !fixedChildren.length : !known &&
      (!treeChildren || Boolean(current?.items && !current.items.length));
    const expanded = open && !toggle.disabled;
    children.hidden = !expanded;
    toggle.setAttribute('aria-expanded',String(expanded));
    const actionLabel = (expanded ? '折叠 ' : '展开 ') + item.name;
    toggle.setAttribute('aria-label',actionLabel + '，导航第 ' + level + ' 层');
    toggle.title = actionLabel;
    toggle.dataset.treeKey = key;
    toggle.dataset.treeControl = 'toggle';
    function toggleBranch() {
      if (toggle.disabled) return;
      if (kind === 'computer') drivesExpanded = !expanded;
      else if (kind === 'network') networkExpanded = !expanded;
      else if (expanded) {
        openTreeBranches.delete(key);
        closedTreeBranches.add(key);
      } else {
        openTreeBranches.add(key);
        closedTreeBranches.delete(key);
        if (current?.failed) treeListings.delete(key);
      }
      treeRevealKey = null;
      renderSystemTree();
    }
    toggle.addEventListener('click',toggleBranch);
    const icon = kind === 'computer' ? 'explorer-computer' : kind === 'network' || kind === 'server' || item.kind === 'network'
      ? 'explorer-network' : kind === 'drive' ? 'explorer-drive' : kind === 'sync' ? 'explorer-sync' : 'folder';
    const className = 'local-explorer-place' + (kind === 'drive' || kind === 'folder' ? ' local-explorer-tree-' + kind : '');
    const button = locationButton(item,className,icon,undefined,kind === 'server' ? toggleBranch : undefined);
    button.setAttribute('aria-label',item.name + '，导航第 ' + level + ' 层' +
      (toggle.disabled ? '' : expanded ? '，已展开' : '，已折叠'));
    button.dataset.treeKey = key;
    button.dataset.treeControl = 'location';
    if (key === activeTreeKey) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
    if (kind === 'drive') {
      button.dataset.treeDrive = pathKey(item.path);
      button.toggleAttribute('data-network',item.kind === 'network');
    }
    if (kind === 'server') {
      button.removeAttribute('data-explorer-drop-path');
      button.removeAttribute('data-explorer-drop-label');
    } else markDropTarget(row,item.path,item.name);
    if (expanded) {
      if (fixedChildren) {
        const childKind = kind === 'computer' ? 'drive' : 'server';
        children.append(...fixedChildren.map(entry => treeNode(entry,childKind,activeChildren,undefined,level + 1)));
      } else {
        const listing = treeListing(item.path,known);
        const entries = listing?.items || [];
        const available = known && !entries.some(entry => treePathKey(entry.path) === treePathKey(known.path))
          ? [...entries,known] : entries;
        children.append(...available.map(entry => treeNode(entry,'folder',activeChildren,undefined,level + 1)));
        if (treeChildren && !listing?.items) {
          if (known && !listing?.failed) activeTreeLoading = true;
          const note = element('span','local-explorer-tree-note',listing?.failed ? '无法读取子文件夹' : '正在读取…');
          note.setAttribute('role','status');
          children.append(note);
        }
      }
    }
    row.append(toggle,button);
    tree.append(row,children);
    return tree;
  }

  function renderSystemTree(revealTree = true) {
    if (!prefs.showNavigation || !sidebarSystem.isConnected) return;
    if (!tab.snapshot && tab.request?.revealTree === false) return;
    const current = getCurrentDirectory() || tab.snapshot?.directory || '';
    const next = treePathKey(current);
    const unc = next.startsWith('\\\\');
    const parts = pathLocations(current).slice(1);
    const rootEntry = parts[0];
    const syncIndex = parts.findLastIndex(({path}) => syncLocation(path));
    if (next !== activeTreeKey) {
      closedTreeBranches.clear();
      activeTreeKey = next;
      treeRevealKey = revealTree ? next : null;
      if (unc || current === networkLocation) networkExpanded = true;
      else if (current && syncIndex === -1) drivesExpanded = true;
    }
    if (unc && rootEntry) knownServers.set(treePathKey(rootEntry.path),{name:rootEntry.label,path:rootEntry.path});
    const activeParts = syncIndex < 0 ? parts : parts.slice(syncIndex);
    const activeChildren = new Map(activeParts.slice(0,-1).map(({path},index) => [treePathKey(path),{
      name:activeParts[index + 1].label,path:activeParts[index + 1].path,
    }]));
    if (treeListings.size > treeCacheLimit) {
      for (const [key,job] of treeListings) {
        if (treeListings.size <= treeCacheLimit) break;
        if ((job.items || job.failed) && !openTreeBranches.has(key) && !activeChildren.has(key)) treeListings.delete(key);
      }
    }
    const drives = (places?.drives || listedDrives).map(drive => ({...drive,
      name:driveLabel(drive,detailCache.get(pathKey(drive.path))?.value),
    }));
    if (!unc && current && current !== networkLocation && rootEntry &&
        !drives.some(drive => treePathKey(drive.path) === treePathKey(rootEntry.path)))
      drives.push({name:nameForPath(rootEntry.path),path:rootEntry.path});
    const focused = sidebarSystem.contains(owner.activeElement) ? owner.activeElement.dataset : null;
    const scrollTop = sidebar?.scrollTop;
    activeTreeLoading = false;
    sidebarSystem.replaceChildren(...syncLocations().map(item => treeNode(item,'sync',activeChildren)),
      treeNode({name:'此电脑',path:''},'computer',activeChildren,drives),
      treeNode({name:'网络',path:networkLocation},'network',activeChildren,[...knownServers.values()]));
    if (sidebar) sidebar.scrollTop = scrollTop;
    const controls = [...sidebarSystem.querySelectorAll('[data-tree-control]')];
    if (focused) controls.find(control => control.dataset.treeKey === focused.treeKey &&
      control.dataset.treeControl === focused.treeControl)?.focus({preventScroll:true});
    if (treeRevealKey === null || !sidebar || !isActive()) return;
    const target = controls.find(control => control.dataset.treeKey === treeRevealKey &&
      control.dataset.treeControl === 'location' && !control.closest('[hidden]'));
    if (target) {
      const container = sidebar.getBoundingClientRect();
      const row = target.getBoundingClientRect();
      sidebar.scrollTop += (row.top + row.bottom - container.top - container.bottom) / 2;
      if (!activeTreeLoading) treeRevealKey = null;
    }
  }

  function renderLinks(frequentItems = prefs.showFrequent ? frequent.list(isFrequentLocation) : [],revealTree = true) {
    pinHost.replaceChildren(...pins.map(pin => locationButton(pin,'local-explorer-pin','folder','top')));
    const folders = places?.folders || [];
    frequentShown = frequentItems.map(item => pathKey(item.path));
    const groups = [
      {items:folders.filter(folder => folder.id === 'home')},
      {items:folders.filter(folder => folder.id !== 'home')},
      {items:sidebarPins,kind:'pin'},
      {items:frequentItems,kind:'frequent',title:'常用文件夹'},
    ];
    const personal = element('div','local-explorer-sidebar-personal');
    personal.append(...groups.flatMap(({items,kind,title}) => {
      if (!items.length) return [];
      const section = element('div','local-explorer-places-group');
      if (title) section.append(element('div','local-explorer-places-heading',title));
      const className = kind ? 'local-explorer-place local-explorer-place-' + kind : 'local-explorer-place';
      section.append(...items.map(item => locationButton(item,className,placeIcons[item.id] || 'folder',
        kind === 'pin' ? 'sidebar' : undefined)));
      return [section];
    }));
    const previous = placesHost.querySelector('.local-explorer-sidebar-personal');
    if (previous) previous.replaceWith(personal);
    else placesHost.append(personal,sidebarSystem);
    renderSystemTree(revealTree);
  }

  function isFrequentLocation(path) {
    const key = pathKey(path);
    return Boolean(prefs.showFrequent && key && key !== '/' && key !== networkLocation && !/^[a-z]:$/i.test(key) &&
      !pins.some(item => pathKey(item.path) === key) &&
      !sidebarPins.some(item => pathKey(item.path) === key) &&
      !syncLocation(path) &&
      !places?.folders.some(item => pathKey(item.path) === key) &&
      !(places?.drives || listedDrives).some(item => pathKey(item.path) === key));
  }

  function creditFrequentVisit(path) {
    if (!isFrequentLocation(path) || !frequent.record(path,nameForPath(path))) return;
    syncFrequentLinks();
  }

  function syncFrequentLinks() {
    const items = prefs.showFrequent ? frequent.list(isFrequentLocation) : [];
    if (isActive() && (items.length !== frequentShown.length ||
        items.some((item,index) => pathKey(item.path) !== frequentShown[index]))) renderLinks(items);
  }

  function cancelFrequentVisit() {
    if (frequentVisit) clearTimeout(frequentVisit.timer);
    frequentVisit = null;
  }

  function beginFrequentVisit() {
    const directory = getCurrentDirectory();
    if (!isActive() || owner.hidden || !owner.hasFocus() || !isFrequentLocation(directory) ||
        (tab.request && pathKey(tab.request.destination) !== pathKey(directory))) {
      cancelFrequentVisit();
      return;
    }
    const key = pathKey(directory);
    if (frequentVisit?.item === tab && frequentVisit.key === key) return;
    cancelFrequentVisit();
    const visit = {item:tab,key};
    visit.timer = setTimeout(() => {
      if (frequentVisit === visit && tab === visit.item && isActive() && !owner.hidden && owner.hasFocus() &&
          pathKey(getCurrentDirectory()) === key) creditFrequentVisit(directory);
    },frequentFolderDwell);
    frequentVisit = visit;
  }

  const overflowLocation = contextMenu && element('button','local-explorer-location local-explorer-location-overflow','…');
  const overflowDivider = contextMenu && svg('chevron');
  let locationParts = [];
  let hiddenLocations = [];

  function fitLocations() {
    if (!locations.clientWidth || !locationParts.length) return;
    const focused = owner.activeElement;
    locations.removeAttribute('data-explorer-breadcrumb-compact');
    if (overflowLocation) {
      overflowLocation.hidden = true;
      overflowDivider.setAttribute('hidden','');
    }
    for (const {location,divider} of hiddenLocations) {
      location.hidden = false;
      divider.removeAttribute('hidden');
    }
    const overflowing = locations.scrollWidth > locations.clientWidth;
    hiddenLocations = overflowing && overflowLocation ? locationParts.slice(1,-1) : [];
    if (hiddenLocations.length) {
      overflowLocation.hidden = false;
      overflowDivider.removeAttribute('hidden');
      for (const {location,divider} of hiddenLocations) {
        location.hidden = true;
        divider.setAttribute('hidden','');
      }
      if (focused === overflowLocation || hiddenLocations.some(({location}) => location === focused))
        overflowLocation.focus({preventScroll:true});
    } else if (overflowLocation && focused === overflowLocation) {
      locationParts.at(-1).location.focus({preventScroll:true});
    }
    locations.toggleAttribute('data-explorer-breadcrumb-compact',overflowing);
    locations.scrollLeft = overflowing && !overflowLocation ? locations.scrollWidth : 0;
  }

  if (overflowLocation) {
    overflowLocation.title = '显示中间的路径层级';
    overflowLocation.setAttribute('aria-label',overflowLocation.title);
    overflowLocation.setAttribute('aria-haspopup','menu');
    overflowLocation.setAttribute('aria-expanded','false');
    overflowLocation.addEventListener('click',async () => {
      if (!hiddenLocations.length || !isActive() || menuOpen || tab.request || tab.fileAction) return;
      const current = tab;
      const parts = locationParts;
      const folded = hiddenLocations;
      const {left,bottom} = overflowLocation.getBoundingClientRect();
      const names = new Map();
      for (const {name} of folded) names.set(name,(names.get(name) || 0) + 1);
      const items = folded.map(({path,name},index) => ({id:String(index),label:names.get(name) > 1 ? addressText(path) : name}));
      menuOpen = true;
      overflowLocation.setAttribute('aria-expanded','true');
      try {
        const result = await contextMenu({x:left,y:bottom,items});
        const selected = result != null && folded[Number(result)];
        if (selected && isActive() && tab === current && locationParts === parts && !tab.request && !tab.fileAction)
          void navigate(selected.path,{focusList:true});
      } catch (failure) {
        report(current,String(failure?.message || failure),true);
      } finally {
        overflowLocation.setAttribute('aria-expanded','false');
        menuOpen = false;
      }
    });
  }
  if (owner.defaultView.ResizeObserver) new owner.defaultView.ResizeObserver(fitLocations).observe(locations);

  function renderLocations(path) {
    const pathEntries = pathLocations(path);
    const syncIndex = pathEntries.findLastIndex(entry => syncLocation(entry.path));
    const entries = syncIndex < 0 ? pathEntries : pathEntries.slice(syncIndex);
    const focused = locationParts.find(({location}) => location === owner.activeElement)?.path;
    hiddenLocations = [];
    locationParts = entries.map((entry,index) => {
      const current = index === entries.length - 1;
      const name = nameForPath(entry.path);
      const location = element(current ? 'span' : 'button','local-explorer-location',name);
      location.title = addressText(entry.path);
      markDropTarget(location,entry.path,name);
      if (current) {
        location.setAttribute('aria-current','page');
        location.tabIndex = -1;
      } else location.addEventListener('click',() => navigate(entry.path,{focusList:true}));
      return {path:entry.path,name,location,divider:index ? svg('chevron') : null};
    });
    const fragments = locationParts.flatMap(({location,divider}) => divider ? [divider,location] : [location]);
    if (overflowLocation) {
      overflowLocation.hidden = true;
      overflowDivider.setAttribute('hidden','');
      if (locationParts.length > 2) fragments.splice(1,0,overflowDivider,overflowLocation);
    }
    locations.replaceChildren(...fragments);
    if (focused != null) locationParts.find(entry => entry.path === focused)?.location.focus({preventScroll:true});
    fitLocations();
  }

  function loadPlaces(force = false) {
    if (!computer) return Promise.resolve(null);
    if (!force && places) return Promise.resolve(places);
    if (placesRequest) return placesRequest;
    placesRequest = Promise.resolve().then(computer).then(result => {
      if (!Array.isArray(result?.drives) || !Array.isArray(result?.folders)) return null;
      const syncRoots = Array.isArray(result.syncRoots) ? result.syncRoots.filter(item =>
        typeof item?.name === 'string' && item.name && typeof item.path === 'string' && item.path) : [];
      places = {...result,syncRoots};
      renderLinks();
      renderTabs();
      renderLocations(tabPath(tab));
      updateControls();
      reconcilePlaceListing(tab);
      return places;
    }).catch(() => null).finally(() => { placesRequest = null; });
    return placesRequest;
  }

  function refreshDriveCard(card,entry,details) {
    const body = card.querySelector('.local-explorer-drive-body');
    const label = driveLabel(entry,details);
    markDropTarget(card,entry.path,label);
    const children = [element('span','local-explorer-drive-name',label)];
    const {freeBytes,totalBytes} = details || {};
    card.removeAttribute('data-low');
    if (Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
      const free = Math.min(totalBytes,Math.max(0,freeBytes));
      const progress = element('progress');
      progress.max = 100;
      progress.value = (1 - free / totalBytes) * 100;
      progress.setAttribute('aria-label',label + '已用容量');
      card.toggleAttribute('data-low',free / totalBytes <= .1);
      children.push(progress,element('span','local-explorer-drive-capacity',sizeText(free) + ' 可用 / ' + sizeText(totalBytes)));
    }
    body.replaceChildren(...children);
  }

  function loadDriveDetails() {
    if (!isActive() || !isDriveView(tab.snapshot) || !driveDetails) return;
    for (const entry of tab.snapshot.entries) {
      if (detailRunning >= 4) break;
      const key = pathKey(entry.path);
      if (detailCache.has(key)) continue;
      const job = {value:null};
      detailCache.set(key,job);
      detailRunning++;
      void Promise.resolve().then(() => driveDetails(entry.path)).then(details => {
        if (detailCache.get(key) !== job) return;
        job.value = details;
        for (const card of drivesHost.querySelectorAll('[data-drive-path]')) {
          if (pathKey(card.dataset.drivePath) === key) refreshDriveCard(card,entry,details);
        }
        for (const button of placesHost.querySelectorAll('[data-tree-drive]')) {
          if (button.dataset.treeDrive !== key) continue;
          const label = driveLabel(entry,details);
          button.querySelector('span').textContent = label;
          markDropTarget(button,entry.path,label);
        }
      }).catch(() => {}).finally(() => {
        detailRunning--;
        loadDriveDetails();
      });
    }
  }

  function renderDrives(entries) {
    const rows = entries.map((entry,index) => {
      const button = element('button','local-explorer-drive');
      button.dataset.entryIndex = index;
      button.dataset.drivePath = entry.path;
      button.title = entry.path;
      button.tabIndex = -1;
      const network = entry.kind === 'network';
      button.toggleAttribute('data-network',network);
      button.setAttribute('aria-pressed','false');
      const icon = element('span','local-explorer-drive-icon');
      icon.append(svg(network ? 'explorer-network' : 'explorer-drive'));
      button.append(icon,element('span','local-explorer-drive-body'));
      refreshDriveCard(button,entry,detailCache.get(pathKey(entry.path))?.value);
      return {network,button};
    });
    const groups = [
      {title:'设备和驱动器',rows:rows.filter(row => !row.network)},
      {title:'网络位置',rows:rows.filter(row => row.network)},
    ];
    drivesHost.replaceChildren(...groups.filter(group => group.rows.length).map(group => {
      const section = element('section','local-explorer-drive-group');
      const title = element('h3','',group.title);
      const grid = element('div','local-explorer-drive-grid');
      grid.append(...group.rows.map(row => row.button));
      section.append(title,grid);
      return section;
    }));
    owner.defaultView.requestAnimationFrame(loadDriveDetails);
  }

  function displayEntryName(entry) {
    if (prefs.showExtensions || entry.isDirectory) return entry.name;
    const dot = entry.name.lastIndexOf('.');
    return dot > 0 && dot < entry.name.length - 1 ? entry.name.slice(0,dot) : entry.name;
  }

  function entryRows(entries,boundaries) {
    const fragment = owner.createDocumentFragment();
    sequenceGroups = prefs.stackSequences ? groupExplorerRenderSequences(entries,treePathKey) : new Map();
    const expanded = new Set();
    let currentGroup;
    for (const [index,entry] of entries.entries()) {
      const sequence = sequenceGroups.get(index);
      if (sequence && sequence.representativeIndex !== index) continue;
      const group = boundaries ? dateGroup(entry,boundaries) : null;
      const collapsed = group !== null && tab.collapsedDateGroups.has(group);
      if (group !== null && group !== currentGroup) {
        currentGroup = group;
        const heading = element('tr','local-explorer-group');
        const cell = heading.insertCell();
        cell.colSpan = columnLayout?.columnCount || 4;
        const toggle = element('button','local-explorer-group-toggle');
        toggle.dataset.explorerGroupToggle = group;
        toggle.setAttribute('aria-expanded',String(!collapsed));
        toggle.append(svg('chevron'),element('span','',dateGroupNames[Number(group)] || '无修改日期'));
        cell.append(toggle);
        fragment.append(heading);
      }
      if (!sequence) {
        fragment.append(entryRow(entry,index,group,collapsed));
        continue;
      }
      const open = tab.expandedSequences.has(sequence.key) ||
        sequence.frames.some(frame => tab.selection.has(pathKey(frame.entry.path)));
      fragment.append(sequenceRow(sequence,group,collapsed,open));
      if (open) {
        expanded.add(sequence.key);
        const frames = [...sequence.frames].sort((a,b) => a.index - b.index);
        for (const frame of frames) fragment.append(entryRow(frame.entry,frame.index,group,collapsed,true));
      }
    }
    tab.expandedSequences = expanded;
    return fragment;
  }

  function entryRow(entry,index,group,collapsed,inSequence = false) {
    const row = element('tr',inSequence ? 'local-explorer-sequence-frame' : '');
    row.dataset.entryIndex = index;
    if (group !== null) row.dataset.explorerDateGroup = group;
    row.hidden = collapsed;
    if (entry.isDirectory) markDropTarget(row,entry.path,entry.name);
    const button = element('button','local-explorer-entry');
    button.tabIndex = -1;
    button.title = entry.name;
    const name = displayEntryName(entry);
    button.setAttribute('aria-label',name + (entry.isDirectory ? '，文件夹' : ''));
    button.toggleAttribute('data-directory',entry.isDirectory);
    button.append(svg(entry.isDirectory ? 'folder' : 'notes'));
    if (entry.isDirectory) {
      const preview = element('span','local-explorer-folder-preview');
      preview.setAttribute('aria-hidden','true');
      button.append(preview);
    }
    button.append(element('span','local-explorer-entry-name',name));
    const nameCell = element('td');
    nameCell.append(button);
    if (columnLayout) columnLayout.appendCells(row,entry,nameCell);
    else {
      row.append(nameCell);
      row.insertCell().textContent = dateText(entry.modified);
      row.insertCell().textContent = fileType(entry);
      row.insertCell().textContent = sizeText(entry.size);
    }
    return row;
  }

  function sequenceRow(sequence,group,collapsed,open) {
    const row = element('tr','local-explorer-sequence-stack');
    row.dataset.sequenceCoverIndex = sequence.frames[0].index;
    if (group !== null) row.dataset.explorerDateGroup = group;
    row.hidden = collapsed;
    const cell = row.insertCell();
    cell.colSpan = columnLayout?.columnCount || 4;
    const button = element('button','local-explorer-sequence-toggle');
    button.type = 'button';
    button.dataset.explorerSequenceToggle = sequence.representativeIndex;
    button.setAttribute('aria-expanded',String(open));
    const number = frame => String(frame).padStart(sequence.padding,'0');
    button.title = `${sequence.label} · ${number(sequence.first)}–${number(sequence.last)}`;
    button.append(svg('chevron'),svg('stack'),element('span','',sequence.label),
      element('span','local-explorer-sequence-count',displayNumber.format(sequence.frames.length) + ' 帧'));
    cell.append(button);
    return row;
  }

  function entryHost() {
    return isDriveView(tab.snapshot) ? drivesHost : tbody;
  }

  function entryItem(index) {
    return entryHost().querySelector('[data-entry-index="' + index + '"]:not([hidden])');
  }

  function visibleEntries() {
    return [...entryHost().querySelectorAll('[data-entry-index]:not([hidden])')]
      .map(row => tab.snapshot.entries[Number(row.dataset.entryIndex)]);
  }

  function toggleSequence(button) {
    if (!tab.snapshot || tab.request || tab.fileAction) return;
    const index = button.dataset.explorerSequenceToggle;
    const sequence = sequenceGroups.get(Number(index));
    if (!sequence) return;
    if (tab.expandedSequences.delete(sequence.key)) {
      for (const frame of sequence.frames) tab.selection.delete(pathKey(frame.entry.path));
      tab.selected = tab.selection.get(pathKey(tab.selected?.path)) || tab.selection.values().next().value || null;
      if (!tab.selection.has(tab.selectionAnchor)) tab.selectionAnchor = tab.selected ? pathKey(tab.selected.path) : null;
      tab.selectionRevision++;
    } else tab.expandedSequences.add(sequence.key);
    const previousTop = button.getBoundingClientRect().top;
    tbody.replaceChildren(entryRows(tab.snapshot.entries,tab.snapshot.dateGroups));
    const next = tbody.querySelector('[data-explorer-sequence-toggle="' + index + '"]');
    if (next) {
      scroller.scrollTop += next.getBoundingClientRect().top - previousTop;
      next.focus({preventScroll:true});
    }
    drawSelection();
    updateView();
  }

  function showDateGroup(group,expanded) {
    if (expanded) tab.collapsedDateGroups.delete(group);
    else tab.collapsedDateGroups.add(group);
    for (const row of tbody.querySelectorAll('[data-explorer-date-group="' + group + '"]')) row.hidden = !expanded;
    for (const button of tbody.querySelectorAll('[data-explorer-group-toggle="' + group + '"]'))
      button.setAttribute('aria-expanded',String(expanded));
    drawSelection();
  }

  function itemButton(item) {
    return item?.matches('button') ? item : item?.querySelector('button');
  }

  function setEntryTabStop(button,index) {
    button.tabIndex = index;
    const actions = button.nextElementSibling;
    if (actions?.classList.contains('local-explorer-row-asset-actions')) {
      for (const action of actions.children) action.tabIndex = index;
    }
  }

  function drawSelection() {
    const host = entryHost();
    let lead;
    const leadKey = pathKey(tab.selected?.path);
    for (const item of host.querySelectorAll('[data-entry-index]')) {
      const entry = tab.snapshot?.entries[Number(item.dataset.entryIndex)];
      if (!entry) continue;
      const key = pathKey(entry.path);
      const selected = tab.selection.has(key);
      const control = itemButton(item);
      item.toggleAttribute('data-selected',selected);
      if (control.classList.contains('local-explorer-drive')) {
        control.setAttribute('aria-pressed',String(selected));
      } else if (selected && key === leadKey) control.setAttribute('aria-current','true');
      else control.removeAttribute('aria-current');
      setEntryTabStop(control,-1);
      if (selected && key === leadKey && !item.hidden) lead = control;
    }
    const nextTabStop = lead || itemButton(host.querySelector('[data-entry-index]:not([hidden])'));
    if (nextTabStop) setEntryTabStop(nextTabStop,0);
    let selectedBytes = 0;
    let haveFiles = false;
    let complete = true;
    for (const entry of tab.selection.values()) {
      if (entry.isDirectory) continue;
      haveFiles = true;
      if (Number.isFinite(entry.size)) selectedBytes += entry.size;
      else complete = false;
    }
    const text = tab.selection.size ? ' ｜ 选中 ' + displayNumber.format(tab.selection.size) + ' 个项目' +
      (haveFiles && complete ? ' ｜ ' + sizeText(selectedBytes) : '') : '';
    if (selectionCount.textContent !== text) selectionCount.textContent = text;
    selectionCount.hidden = !text;
    updateControls();
  }

  function selectEntry(entry,{toggle = false,range = false} = {}) {
    const {selection} = tab;
    tab.selectionRevision++;
    if (!entry) {
      if (!toggle) {
        selection.clear();
        tab.selectionAnchor = tab.selected = null;
      }
    } else {
      const key = pathKey(entry.path);
      const entries = range ? visibleEntries() : [];
      const anchor = range ? entries.findIndex(item => pathKey(item.path) === tab.selectionAnchor) : -1;
      const end = range ? entries.indexOf(entry) : -1;
      if (anchor >= 0 && end >= 0) {
        if (!toggle) selection.clear();
        for (let index = Math.min(anchor,end); index <= Math.max(anchor,end); index++) {
          const item = entries[index];
          selection.set(pathKey(item.path),item);
        }
      } else {
        if (!toggle) selection.clear();
        if (toggle && selection.has(key)) selection.delete(key);
        else selection.set(key,entry);
        tab.selectionAnchor = key;
      }
      tab.selected = selection.get(key) || selection.values().next().value;
    }
    if (tab.selected && !catalogOnly()) directorySelections.remember(getCurrentDirectory(),tab.selected.path);
    drawSelection();
  }

  async function selectAll() {
    const item = tab;
    const current = item.snapshot;
    const revision = ++item.selectionRevision;
    const stacked = sequenceGroups.size > 0 && !isDriveView(current);
    let entries = stacked ? visibleEntries() : current.entries;
    try {
      if (!stacked && selectAllEntries && current.directory && !isDriveView(current) && current.total > entries.length) {
        const listing = await selectAllEntries({address:current.directory,...(item.query && {query:item.query}),
          ...(current.projectFilter && {projectFilter:current.projectFilter}),
          ...(prefs.showHidden && {showHidden:true})});
        if (!Array.isArray(listing?.entries)) throw Error('无法选择此目录的项目。');
        entries = listing.entries;
      }
    } catch (failure) {
      if (item === tab && item.selectionRevision === revision) report(item,String(failure?.message || failure),true);
      return;
    }
    if (item.selectionRevision !== revision || !tabs.includes(item)) return;
    item.selection = new Map(entries.map(entry => [pathKey(entry.path),entry]));
    item.selected = item.selection.get(pathKey(item.selected?.path)) ||
      item.snapshot.entries.find(entry => item.selection.has(pathKey(entry.path)));
    item.selectionAnchor = item.selected ? pathKey(item.selected.path) : null;
    if (item === tab) drawSelection();
  }

  function updateView() {
    const iconView = tab.view === 'grid';
    const driveGrid = tab.driveView === 'grid';
    table.classList.toggle('local-explorer-grid',iconView);
    if (iconView || tab.view === 'details') table.removeAttribute('data-explorer-display');
    else table.dataset.explorerDisplay = tab.view;
    drivesHost.dataset.explorerDisplay = tab.driveView;
    drivesHost.toggleAttribute('data-list',!driveGrid);
    if (iconView) table.dataset.explorerZoom = tab.iconSize;
    else table.removeAttribute('data-explorer-zoom');
    if (driveGrid) drivesHost.dataset.explorerZoom = tab.driveIconSize;
    else drivesHost.removeAttribute('data-explorer-zoom');
    columnLayout?.setDirectory?.(getCurrentDirectory());
    if (tab.snapshot) columnLayout?.setSort(orderFor(tab,tab.snapshot.directory));
    const assetOnly = catalogOnly();
    scroller.toggleAttribute('data-explorer-catalog-only',assetOnly);
    const fileRowsVisible = isActive() && !table.hidden && !assetOnly;
    const iconPixels = iconView ? thumbnailSizes[tab.iconSize] || 0 : tab.view === 'tiles' ? 128 : 0;
    const folderSize = fileRowsVisible && iconView && prefs.showThumbnails ? iconPixels : 0;
    const size = fileRowsVisible && (fileIcon || (prefs.showThumbnails && iconPixels)) ? iconPixels || 24 : 0;
    const sequenceSize = fileRowsVisible && prefs.showThumbnails && sequenceThumbnail
      ? iconView ? iconPixels || 24 : tab.view === 'tiles' ? 128 : 0
      : 0;
    showThumbnails(tab.snapshot?.entries,size,false,folderSize,prefs.showThumbnails,sequenceSize);
    showEntryDetails(tab.snapshot?.entries,fileRowsVisible && tab.view === 'details' ? columnLayout?.detailColumns : []);
    assetDetails.observe(tab.snapshot?.entries,fileRowsVisible);
    catalogSearch.set(isActive() && tab.searchScope !== 'folder' && tab.catalogQuery
      ? {tab,query:tab.catalogQuery,directoryEntries:tab.searchScope === 'both' ? tab.snapshot?.entries : undefined}
      : null);
    count.hidden = !prefs.showStatus;
    if (footer) footer.hidden = assetOnly || !prefs.showStatus && pages.hidden;
    updateControls();
  }

  function render(previous = null,{revealTree = true} = {}) {
    const {snapshot} = tab;
    const directory = tabPath(tab);
    const sameLocation = previous && previous.directory === snapshot?.directory;
    const samePage = sameLocation && previous.offset === snapshot?.offset;
    const driveView = isDriveView(snapshot);
    table.hidden = !snapshot || driveView;
    drivesHost.hidden = !driveView;
    if (!sameLocation) {
      addressCompletion.clear();
      renderLocations(directory);
      renderTabs();
    }
    if (!revealTree) treeRevealKey = null;
    if ((revealTree || snapshot) && (!sameLocation || (driveView && !directory && !places))) renderLinks(undefined,revealTree);
    if (!sameLocation || owner.activeElement !== address) address.value = addressText(directory);
    const term = searchText();
    if (search.value !== term && (!sameLocation || owner.activeElement !== search)) search.value = term;
    if (!snapshot) {
      sequenceGroups.clear();
      tbody.replaceChildren();
      drivesHost.replaceChildren();
      pages.hidden = empty.hidden = true;
      if (emptyHelp) emptyHelp.hidden = true;
      totalCount.data = '';
      drawSelection();
      displayStatus();
      updateView();
      return;
    }
    const boundaries = snapshot.dateGroups;
    const revealedGroup = boundaries && snapshot.selectedPath && tab.selected
      ? dateGroup(tab.selected,boundaries) : null;
    const revealGroup = revealedGroup !== null && tab.collapsedDateGroups.delete(revealedGroup);
    const sameRows = samePage && previous.entries.length === snapshot.entries.length &&
      previous.entries.every(({path,name,isDirectory,size,modified,created},index) => {
        const entry = snapshot.entries[index];
        return path === entry.path && name === entry.name && isDirectory === entry.isDirectory &&
          size === entry.size && modified === entry.modified && created === entry.created;
      });
    const revealSequence = sameRows && tab.selection.size &&
      [...sequenceGroups].some(([index,sequence]) => !tab.expandedSequences.has(sequence.key) &&
        tab.selection.has(pathKey(snapshot.entries[index].path)));
    if (driveView) {
      sequenceGroups.clear();
      renderDrives(snapshot.entries);
    } else if (!sameRows || revealGroup || revealSequence || String(boundaries) !== String(renderedBoundaries)) {
      const anchor = samePage && !snapshot.selectedPath ? visibleRowAnchor(previous.entries) : null;
      tbody.replaceChildren(entryRows(snapshot.entries,boundaries));
      if (anchor) restoreRowAnchor(anchor,snapshot.entries);
    }
    renderedBoundaries = boundaries;
    const showPage = snapshot.previousOffset != null || snapshot.nextOffset != null;
    pages.hidden = !showPage;
    empty.hidden = Boolean(snapshot.entries.length);
    empty.textContent = tab.query ? '没有匹配的项目。' : directory === networkLocation
      ? '在地址栏输入共享路径，即可前往网络位置。' : directory ? '此文件夹为空。' : '没有可浏览的位置。';
    if (emptyHelp) {
      emptyHelp.hidden = empty.hidden || directory === networkLocation || (!directory && !tab.query);
      if (!emptyHelp.hidden) {
        const query = tab.query || '';
        const suggestion = simplifyAssetQuery(query);
        emptyShortcuts.hidden = Boolean(query);
        emptyQuery.hidden = !query;
        emptyQuery.textContent = query ? `关键词「${query}」` : '';
        simplifiedQuery.hidden = !suggestion;
        simplifiedQuery.dataset.query = suggestion;
        simplifiedQuery.textContent = suggestion ? `试试「${suggestion}」` : '';
      }
    }
    totalCount.data = (showPage ? displayNumber.format(snapshot.offset + 1) + '–' +
      displayNumber.format(snapshot.offset + snapshot.entries.length) + ' / ' : '') +
      displayNumber.format(snapshot.total) + ' 个项目' + (snapshot.truncated ? '（目录条目过多，已部分显示）' : '');
    if (!samePage) scroller.scrollTop = tab.scrollTop;
    drawSelection();
    if (snapshot.selectedPath) entryItem(snapshot.entries.indexOf(tab.selected))?.scrollIntoView({block:'nearest',inline:'nearest'});
    displayStatus();
    updateView();
  }

  function visibleRowAnchor(entries) {
    if (!scroller.scrollTop || table.hidden) return null;
    const {top,bottom} = marqueeViewport();
    const selected = pathKey(tab.selected?.path);
    let first;
    for (const row of tbody.querySelectorAll('[data-entry-index]:not([hidden])')) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom <= top) continue;
      if (bounds.top >= bottom) break;
      const key = pathKey(entries[Number(row.dataset.entryIndex)]?.path);
      if (!key) continue;
      const anchor = {key,top:bounds.top,offset:bounds.top - top,height:bounds.height};
      if (key === selected) return anchor;
      first ??= anchor;
    }
    return first;
  }

  function restoreRowAnchor(anchor,entries,newView = false) {
    const index = entries.findIndex(entry => pathKey(entry.path) === anchor.key);
    const row = index >= 0 && entryItem(index);
    if (!row) return;
    const bounds = row.getBoundingClientRect();
    const offset = anchor.offset < 0 && anchor.height ? anchor.offset * bounds.height / anchor.height : anchor.offset;
    const target = newView ? marqueeViewport().top + offset : anchor.top;
    scroller.scrollTop += bounds.top - target;
  }

  function remember(item,path,index) {
    if (index != null) { item.index = index; return; }
    if (tabPath(item) === path && item.index !== -1) return;
    item.history = [...item.history.slice(0,item.index + 1),path].slice(-historyLimit);
    item.index = item.history.length - 1;
  }

  function persistTabSession() {
    if (detachedWindow) return;
    const open = tabs.filter(item => item.sessionPath !== undefined);
    if (!open.length && tabs.length) return;
    const session = JSON.stringify({paths:open.map(item => item.sessionPath),active:Math.max(0,open.indexOf(tab)),
      ...(open.some(item => item.pinned) && {pinned:open.map(item => item.pinned)})});
    if (session === lastTabSession) return;
    try {
      storage.setItem(tabSessionKey,session);
      lastTabSession = session;
    } catch {}
  }

  function startupTabs() {
    if (detachedWindow) return {paths:[],active:0};
    if (prefs.startMode === 'paths') return initialTabs((Array.isArray(prefs.startupPaths) ? prefs.startupPaths : [])
      .filter(path => typeof path === 'string' && path.trim()),0);
    if (prefs.startMode === 'restore') {
      try {
        const saved = JSON.parse(storage.getItem(tabSessionKey));
        return initialTabs(saved?.paths,saved?.active,Array.isArray(saved?.pinned) ? saved.pinned : undefined);
      } catch {}
    }
    return {paths:[],active:0};
  }

  function driveListing(local,destination,query) {
    const entries = (local?.drives || []).filter(entry => destination !== networkLocation || entry.kind === 'network')
      .filter(entry => !query || (entry.name + ' ' + entry.path).toLowerCase().includes(query.toLowerCase()))
      .map(entry => ({...entry,isDirectory:true}));
    return {directory:destination || null,parent:'',entries,total:entries.length,offset:0};
  }

  async function waitForInitialPlaces(pending) {
    let timer;
    try {
      return await Promise.race([pending,new Promise(resolve => { timer = setTimeout(() => resolve(null),initialPlaceWait); })]);
    } finally { clearTimeout(timer); }
  }

  async function browseDrives(destination,query,force,isCurrent) {
    if (force) detailCache.clear();
    const pending = loadPlaces(force);
    const local = !destination && !places ? await waitForInitialPlaces(pending) : await pending;
    if (local || destination) return driveListing(local,destination,query);
    if (!isCurrent()) return null;
    const basic = await browse({address:'',...(force && {refresh:true}),...(query && {query})});
    return places ? driveListing(places,destination,query) : {...basic,basicDriveRoots:true};
  }

  function listingOrderKey({sortBy,descending,groupBy}) {
    return [sortBy,descending,groupBy].join(':');
  }

  function reconcilePlaceListing(item) {
    const previous = item.snapshot;
    if (!places || !previous || item !== tab || !isActive() || item.request || item.fileAction) return;
    if (previous.basicDriveRoots) {
      const current = driveListing(places,'',item.query);
      const byPath = new Map(current.entries.map(entry => [pathKey(entry.path),entry]));
      for (const key of item.selection.keys()) {
        if (byPath.has(key)) item.selection.set(key,byPath.get(key));
        else item.selection.delete(key);
      }
      item.selected = item.selection.get(pathKey(item.selected?.path)) || item.selection.values().next().value || null;
      if (!item.selection.has(item.selectionAnchor)) item.selectionAnchor = item.selected ? pathKey(item.selected.path) : null;
      item.snapshot = current;
      item.selectionRevision++;
      render(previous);
    } else if (previous.provisionalOrder) {
      previous.provisionalOrder = false;
      if (isDownloads(previous.directory) && previous.listingOrderKey !== listingOrderKey(orderFor(item,previous.directory))) {
        const path = previous.selectedPath || tabPath(item);
        void navigate(path,{index:item.index,offset:previous.selectedPath ? undefined : previous.offset,query:item.query});
      }
    }
  }

  async function navigate(destination, {index,offset,force = false,focusList = false,query,restored,locate,clearCatalog = false,
    revealTree = true,projectFilterBypass = tab.projectFilterBypass} = {}) {
    finishMarquee(true);
    clearTimeout(searchTimer);
    startupPending = false;
    startupRequest = null;
    const item = tab;
    if (!tabs.length) {
      item.initialPath = destination;
      tabs.push(item);
      renderTabs();
    }
    const destinationKey = pathKey(destination);
    const staleRevision = item.stalePaths.get(destinationKey);
    let checkedRevision = transferRevision;
    const previousPath = tabPath(item);
    query ??= destinationKey === pathKey(previousPath) ? item.query : '';
    let projectFilter = activeProjectFilter(destination,projectFilterBypass);
    const canRemember = path => !restored && !locate && !query && offset == null &&
      treePathKey(path) !== treePathKey(item.snapshot?.directory);
    let rememberedPath = locate?.lead || (canRemember(destination) ? directorySelections.get(destination) : undefined);
    force ||= Boolean(staleRevision);
    const {sortBy,descending,groupBy} = orderFor(item,destination);
    const request = {destination,offset,force,query,staleRevision,sortBy,descending,groupBy,restored,locate,clearCatalog,revealTree,
      projectFilter,projectFilterBypass,rememberedPath};
    if (item.request && Object.keys(request).every(key => item.request[key] === request[key])) return;
    if (destinationKey !== pathKey(item.snapshot?.directory)) cancelFrequentVisit();
    if (!revealTree) treeRevealKey = null;
    item.request = request;
    item.recovery = null;
    let committed = false;
    report(item,item.snapshot ? '' : '正在读取文件列表…');
    const loading = item.snapshot && setTimeout(() => {
      if (item.request === request) report(item,'正在读取文件列表…');
    },120);
    updateControls();
    const selectionRevision = item.selectionRevision;
    const isCurrent = () => item.request === request && tabs.includes(item) &&
      (!locate || item === tab && isActive() && item.selectionRevision === selectionRevision);
    try {
      let dateGroups;
      let result;
      let appliedOrder;
      if (!destination || destination === networkLocation) result = await browseDrives(destination,query,force,isCurrent);
      else {
        const listDirectory = ({sortBy,descending,groupBy}) => {
          appliedOrder = listingOrderKey({sortBy,descending,groupBy});
          dateGroups = groupBy === 'date' ? dateGroupBoundaries() : undefined;
          const order = sortBy !== 'name' || descending || dateGroups ? {sortBy,descending,dateGroups} : undefined;
          return browse({address:destination,...(offset != null && {offset}),...(force && {refresh:true}),
            ...(order && {order}),...(query && {query}),...(prefs.showHidden && {showHidden:true}),
            ...(projectFilter && {projectFilter}),...(rememberedPath && {rememberedPath}),
            ...(locate && {locatePaths:locate.paths})});
        };
        const requestedOrder = orderFor(item,destination);
        result = await listDirectory(requestedOrder);
        if (!isCurrent()) return false;
        const actualOrder = orderFor(item,result?.directory);
        const resolvedFilter = activeProjectFilter(result?.directory,projectFilterBypass);
        const actualRemembered = !result?.selectedPath && canRemember(result?.directory) &&
          directorySelections.get(result?.directory);
        if (listingOrderKey(actualOrder) !== appliedOrder || projectFilter !== resolvedFilter ||
            actualRemembered && actualRemembered !== rememberedPath) {
          projectFilter = resolvedFilter;
          rememberedPath = actualRemembered || rememberedPath;
          result = await listDirectory(actualOrder);
        }
      }
      if (!isCurrent()) return false;
      if (!Array.isArray(result?.entries)) throw Error('无法读取这个位置。');
      const {matchedEntries,...page} = result;
      if (locate && !Array.isArray(matchedEntries)) throw Error('无法确认所选原件。');
      if (pathKey(result.directory) !== destinationKey) checkedRevision = 0;
      else if (item.stalePaths.get(destinationKey) === staleRevision) item.stalePaths.delete(destinationKey);
      const previous = item.snapshot;
      const newDirectory = pathKey(result.directory) !== pathKey(previous?.directory);
      if (newDirectory && item.selected && !isDriveView(previous))
        directorySelections.remember(previous?.directory,item.selected.path);
      const filterChanged = previous?.projectFilter !== projectFilter;
      if (newDirectory) item.collapsedDateGroups.clear();
      if (newDirectory || clearCatalog) item.catalogQuery = '';
      const newScope = newDirectory || item.query !== query;
      const preserveSelection = locate?.preserveSelection && !newScope && !filterChanged;
      if (newScope || result.selectedPath && !preserveSelection) {
        item.selectionRevision++;
        item.selection.clear();
        item.selected = item.selectionAnchor = null;
      }
      const entriesOnPage = new Map(result.entries.map(entry => [pathKey(entry.path),entry]));
      if (locate && !preserveSelection) {
        const requested = new Set(locate.paths.map(treePathKey));
        item.selectionRevision++;
        item.selection = new Map(matchedEntries.flatMap(entry => {
          const key = pathKey(entry.path);
          return !entry.isDirectory && requested.has(treePathKey(entry.path)) ? [[key,entriesOnPage.get(key) || entry]] : [];
        }));
        item.selected = item.selection.get(pathKey(result.selectedPath)) || item.selection.values().next().value || null;
        item.selectionAnchor = item.selected ? pathKey(item.selected.path) : null;
        if (item.selected) {
          directorySelections.remember(result.directory,item.selected.path);
          if (dateGroups) item.collapsedDateGroups.delete(dateGroup(item.selected,dateGroups));
        }
      } else if (restored) {
        item.selectionRevision++;
        item.selection = new Map(restored.selectionPaths.flatMap(path => {
          const key = pathKey(path);
          const entry = entriesOnPage.get(key);
          return entry ? [[key,entry]] : [];
        }));
        item.selected = item.selection.get(pathKey(restored.selectedPath)) || item.selection.values().next().value || null;
        item.selectionAnchor = item.selected ? pathKey(item.selected.path) : null;
      } else if (result.selectedPath && !preserveSelection) {
        const key = pathKey(result.selectedPath);
        const selected = entriesOnPage.get(key);
        if (selected) {
          item.selection.set(key,selected);
          item.selectionAnchor = key;
          item.selected = selected;
        }
      } else if (item.selection.size) {
        const completePage = filterChanged || !result.truncated && result.total === result.entries.length;
        for (const key of item.selection.keys()) {
          if (entriesOnPage.has(key)) item.selection.set(key,entriesOnPage.get(key));
          else if (completePage) item.selection.delete(key);
        }
        item.selected = item.selection.get(pathKey(item.selected?.path)) || item.selection.values().next().value;
      }
      const resultRule = projectFilters && projectFilters.resolve(result.directory);
      item.projectFilterBypass = resultRule?.id === projectFilterBypass ? projectFilterBypass : null;
      item.snapshot = {...page,projectFilter,dateGroups,listingOrderKey:appliedOrder,provisionalOrder:Boolean(appliedOrder && !places)};
      committed = true;
      item.query = query;
      if (!result.directory && !query && !places) listedDrives = result.entries;
      if (result.directory !== previous?.directory || result.offset !== previous?.offset) item.scrollTop = 0;
      if (restored) item.scrollTop = restored.scrollTop;
      remember(item,result.directory || '',index);
      item.initialPath = undefined;
      item.sessionPath = result.directory || '';
      persistTabSession();
      report(item);
      if (item === tab) {
        render(previous,{revealTree});
        if (restored) scroller.scrollTop = item.scrollTop;
        if (focusList && isActive()) {
          const primary = itemButton(entryItem(result.entries.indexOf(item.selected)));
          if (locate && primary) primary.scrollIntoView({block:'nearest',inline:'nearest'});
          (primary || entryHost().querySelector('button[tabindex="0"]') || scroller).focus({preventScroll:true});
        }
      }
      return true;
    } catch (failure) {
      if (isCurrent()) {
        locate?.onFailure?.();
        const message = String(failure?.message || failure || '无法读取这个位置。');
        report(item,message,true);
        if (entryDetails && recoveryButton && destinationKey && destinationKey === pathKey(item.snapshot?.directory) &&
            message.startsWith('找不到此位置')) {
          const recovery = item.recovery = {path:destination,parent:null};
          void Promise.resolve().then(() => entryDetails({paths:[destination],columns:['nearestParent']})).then(results => {
            const parent = results?.[0]?.values?.nearestParent;
            if (item.recovery !== recovery || typeof parent !== 'string' || !parent || !tabs.includes(item)) return;
            recovery.parent = parent;
            report(item,'原位置不可用：' + destination + '。最近可访问的上级文件夹：' + parent,true);
          }).catch(() => {});
        }
      }
      return false;
    } finally {
      if (loading) clearTimeout(loading);
      if (item.request === request) {
        item.request = null;
        if (item === tab) {
          updateControls();
          if (committed) beginFrequentVisit();
          refreshStaleTab(item,checkedRevision);
        }
      }
    }
  }

  function activateTab(item,focusTab = false,address = tabPath(item),navigation) {
    if (item === tab && (item.snapshot || item.request)) {
      if (navigation && isActive()) return navigate(address,navigation);
      if (isActive() && item.snapshot) {
        updateView();
        loadDriveDetails();
        refreshStaleTab(item);
      }
      return;
    }
    finishMarquee(true);
    clearTimeout(searchTimer);
    wheelDelta = 0;
    tab.scrollTop = scroller.scrollTop;
    tab = item;
    persistTabSession();
    render(null,navigation);
    beginFrequentVisit();
    if (focusTab) tabsHost.querySelector('[aria-current="page"]')?.focus({preventScroll:true});
    if (navigation && isActive()) return navigate(address,navigation);
    if (!item.snapshot && !item.request && isActive()) return navigate(address,{focusList:!focusTab});
    refreshStaleTab(item);
  }

  function addTab(path = '',{afterCurrent = false,emptyFallback = false,focusTab = true,navigation} = {}) {
    if (tabs.length >= tabLimit) return;
    const item = createTab();
    item.initialPath = path;
    item.emptyFallback = emptyFallback;
    if (!path) item.sessionPath = '';
    tabs.splice(afterCurrent ? tabs.indexOf(tab) + 1 : tabs.length,0,item);
    return activateTab(item,focusTab,path,navigation);
  }

  function copyTabPresentation(source,keepSelection = false) {
    return Object.assign(createTab(),{
      history:[...source.history],index:source.index,sessionPath:source.sessionPath,initialPath:source.initialPath,
      snapshot:source.snapshot && {...source.snapshot,selectedPath:null},
      searchScope:source.searchScope,catalogQuery:source.catalogQuery,query:source.query,
      view:source.view,driveView:source.driveView,iconSize:source.iconSize,driveIconSize:source.driveIconSize,
      sortBy:source.sortBy,descending:source.descending,groupBy:source.groupBy,
      downloadsOrder:source.downloadsOrder && {...source.downloadsOrder},
      collapsedDateGroups:new Set(source.collapsedDateGroups),stalePaths:new Map(source.stalePaths),
      ...(keepSelection && {selected:source.selected,selection:new Map(source.selection),selectionAnchor:source.selectionAnchor}),
      scrollTop:source === tab && isActive() ? scroller.scrollTop : source.scrollTop,
    });
  }

  function duplicateActive() {
    if (!canDuplicateActive()) return false;
    finishMarquee(true);
    const source = tab;
    const typedQuery = search.value.trim();
    if (typedQuery !== searchText()) submitSearch(typedQuery);
    const item = copyTabPresentation(source,true);
    tabs.splice(tabs.indexOf(source) + 1,0,item);
    activateTab(item,true);
    const directoryQuery = item.searchScope === 'library' ? '' : typedQuery;
    if (directoryQuery !== item.query) void navigate(tabPath(item),{index:item.index,offset:0,query:directoryQuery});
    return true;
  }

  function tabWithIdentity(identity,expectedPath) {
    const item = tabs.find(candidate => candidate.identity === identity);
    if (!item) return null;
    if (expectedPath) {
      const key = assetSearchKey || treePathKey;
      const expected = key(expectedPath);
      const actual = item.request?.destination ?? item.snapshot?.directory ?? tabPath(item);
      if (!expected || key(actual) !== expected) return null;
    }
    return item;
  }

  function showTabIdentity(identity,expectedPath) {
    const item = tabWithIdentity(identity,expectedPath);
    if (!item) return false;
    onOpenFiles?.();
    void activateTab(item,true);
    tabsHost.querySelector('[aria-current="page"]')?.focus({preventScroll:true});
    return true;
  }

  function unusedFallback(item) {
    return item.emptyFallback && !item.pinned && !tabPath(item) && item.history.length <= 1 &&
      !item.query && !item.catalogQuery && !item.selection.size && !item.scrollTop && !item.fileAction;
  }

  function rememberClosedTab(item,index) {
    if (unusedFallback(item)) return;
    const saved = copyTabPresentation(item);
    saved.pinned = item.pinned;
    closedTabs.push({item:saved,index});
    if (closedTabs.length > closedTabLimit) closedTabs.shift();
  }

  function finishClosingTabs(keep,{preserveWorkspace = false} = {}) {
    if (!tabs.includes(lastTabClick)) lastTabClick = null;
    if (!tabs.length) {
      if (preserveWorkspace || !canCloseLastTab?.()) return addTab('',{emptyFallback:true});
      exit();
      clearTimeout(searchTimer);
      startupPending = false;
      startupRequest = null;
      tab = createTab();
      persistTabSession();
      render();
      return;
    }
    if (!tabs.includes(tab)) return activateTab(keep,isActive());
    persistTabSession();
    renderTabs();
    updateControls();
  }

  function closeTab(item,{record = true,preserveWorkspace = false} = {}) {
    const index = tabs.indexOf(item);
    if (index < 0) return false;
    if (record) rememberClosedTab(item,index);
    tabs.splice(index,1);
    finishClosingTabs(tabs[Math.min(index,tabs.length - 1)],{preserveWorkspace});
    return true;
  }

  function findManagedTab(target) {
    const wrapper = target?.closest?.('[data-explorer-tab-id]');
    const item = wrapper && tabsHost.contains(wrapper) && tabs.find(candidate => candidate.identity === wrapper.dataset.explorerTabId);
    return item ? {id:item.identity,title:nameForPath(tabPath(item)),pinned:item.pinned} : null;
  }

  function setTabPinned(identity,pinned) {
    const item = tabs.find(candidate => candidate.identity === identity);
    if (!item || item.pinned === Boolean(pinned)) return false;
    item.pinned = Boolean(pinned);
    item.emptyFallback = false;
    persistTabSession();
    renderTabs();
    return true;
  }

  function closableOtherTabs(identity) {
    return tabs.some(item => item.identity === identity) ? tabs.filter(item =>
      item.identity !== identity && !item.pinned && !item.fileAction && !detachingTabs.has(item)) : [];
  }

  function canCloseOtherTabs(identity) { return Boolean(closableOtherTabs(identity).length); }

  function closeOtherTabs(identity) {
    const keep = tabs.find(item => item.identity === identity);
    const closing = closableOtherTabs(identity);
    if (!closing.length) return false;
    for (const item of closing) rememberClosedTab(item,tabs.indexOf(item));
    for (const item of closing) tabs.splice(tabs.indexOf(item),1);
    finishClosingTabs(keep);
    return true;
  }

  function closeManagedTab(identity) { return closeTab(tabs.find(item => item.identity === identity)); }

  function hasClosedTabs() { return Boolean(closedTabs.length); }

  function restoreClosedTab() {
    if (!closedTabs.length) return false;
    const fallback = tabs.length === 1 && unusedFallback(tab) ? tab : null;
    if (tabs.length >= tabLimit && !fallback) {
      report(tab,'文件夹标签页已达到上限，请先关闭一个标签页。',true);
      return false;
    }
    const {item,index} = closedTabs.pop();
    onOpenFiles?.();
    tabs.splice(Math.min(index,tabs.length),0,item);
    if (fallback) tabs.splice(tabs.indexOf(fallback),1);
    void activateTab(item,true);
    return true;
  }

  function seedStartupTabs() {
    if (!startupPending || tab.snapshot || tab.request) return null;
    const session = startupTabs();
    if (!session.paths.length) return null;
    const restored = prefs.startMode === 'restore';
    tabs.splice(0,tabs.length,...session.paths.map((path,index) => {
      const item = createTab();
      item.initialPath = path;
      item.pinned = Boolean(session.pinned?.[index]);
      if (restored) item.sessionPath = path;
      return item;
    }));
    tab = tabs[session.active];
    render();
    return tab;
  }

  function show() {
    if (startupRequest) return startupRequest;
    const localPlaces = loadPlaces();
    const initial = seedStartupTabs();
    if (initial) {
      const path = tabPath(initial);
      return navigate(path).then(opened => {
        if (opened || !path || tab !== initial || !tabs.includes(initial) || initial.request || initial.snapshot) return opened;
        initial.initialPath = initial.sessionPath = undefined;
        return navigate('');
      });
    }
    if (startupPending && !detachedWindow && prefs.startLocation === 'home' && !tab.snapshot && !tab.request) {
      startupPending = false;
      const opening = localPlaces.then(result => {
        if (startupRequest !== opening) return false;
        startupRequest = null;
        if (!isActive()) return false;
        const home = result?.folders.find(folder => folder.id === 'home')?.path;
        if (!home) return navigate('');
        return navigate(home).then(opened => opened || (isActive() && !tab.snapshot && !tab.request && navigate('')));
      });
      startupRequest = opening;
      return opening;
    }
    if (!tab.snapshot && !tab.request) return navigate(tabPath(tab));
    updateView();
    syncFrequentLinks();
    renderSystemTree();
    beginFrequentVisit();
    loadDriveDetails();
    refreshStaleTab(tab);
    return true;
  }

  function openPath(path,{force = false} = {}) {
    void loadPlaces();
    return navigate(path,{focusList:true,query:'',clearCatalog:true,force});
  }

  function renderShellPending() {
    if (!shellPending) return;
    const count = pendingShellPaths.size;
    shellPending.hidden = !count;
    shellPendingStatus.textContent = count ? count + ' 个系统打开请求待重试' : '';
    shellPendingStatus.title = pendingShellPaths.values().next().value || '';
    shellRetry.disabled = shellClear.disabled = retryingShellPaths;
  }

  function savePendingShellPaths() {
    try { storage.setItem(pendingShellPathKey,JSON.stringify([...pendingShellPaths.values()])); } catch {}
    renderShellPending();
  }

  async function openShellPath(path) {
    const opened = await openPath(path);
    const valid = startupPath(path);
    if (!valid || valid === networkLocation) return opened;
    const key = treePathKey(valid);
    if (opened) {
      if (pendingShellPaths.delete(key)) savePendingShellPaths();
    } else if (!pendingShellPaths.has(key)) {
      pendingShellPaths.set(key,valid);
      if (pendingShellPaths.size > tabLimit) pendingShellPaths.delete(pendingShellPaths.keys().next().value);
      savePendingShellPaths();
    }
    return opened;
  }

  shellRetry?.addEventListener('click',async () => {
    if (!isActive() || retryingShellPaths || tab.request || tab.fileAction) return;
    const path = pendingShellPaths.values().next().value;
    if (!path) return;
    retryingShellPaths = true;
    renderShellPending();
    try { await openShellPath(path); }
    finally { retryingShellPaths = false; renderShellPending(); }
  });
  shellClear?.addEventListener('click',() => {
    if (retryingShellPaths) return;
    pendingShellPaths.clear();
    savePendingShellPaths();
  });
  renderShellPending();

  function sourceTabFor(location,preferredTab,key) {
    const matches = tabs.filter(item => key(tabLocation(item)) === location);
    return matches.find(candidate => candidate.identity === preferredTab) ??
      (matches.includes(tab) ? tab : matches[0]);
  }

  function revealSource(path,{directory,preferredTab,keepDirectorySearch = false} = {}) {
    if (!isActive()) return false;
    const key = assetSearchKey || treePathKey;
    const target = key(path);
    const location = key(directory);
    if (!target || !location) return false;
    void loadPlaces();
    seedStartupTabs();
    const item = sourceTabFor(location,preferredTab,key);
    if (!item) {
      if (!tabs.length || unusedFallback(tab) || tabs.length >= tabLimit) return openPath(path);
      return addTab(path,{afterCurrent:true,focusTab:false});
    }
    if (!item.snapshot && !item.request) {
      return item === tab ? openPath(path) : activateTab(item,false,path);
    }
    if (item !== tab) activateTab(item);
    const stale = item.stalePaths.has(pathKey(item.snapshot?.directory));
    if (!item.request && !stale && !catalogOnly()) {
      if (target === location) return show();
      const index = item.snapshot?.entries.findIndex(entry => !entry.isDirectory && key(entry.path) === target) ?? -1;
      const control = index >= 0 && itemButton(entryItem(index));
      if (control) {
        if (key(item.selected?.path) !== target) selectEntry(item.snapshot.entries[index]);
        control.scrollIntoView({block:'nearest',inline:'nearest'});
        control.focus({preventScroll:true});
        return true;
      }
    }
    if (keepDirectorySearch && item.query && target !== location) {
      return revealSources([path],{directory,preferredTab:item.identity,lead:path});
    }
    return openPath(path,{force:stale});
  }

  async function revealSources(paths,{directory,lead,preferredTab,keepTabs = false,keepSelection = false} = {}) {
    const key = assetSearchKey || treePathKey;
    const location = key(directory);
    if (!isActive() || !location) return false;
    void loadPlaces();
    seedStartupTabs();
    const item = sourceTabFor(location,preferredTab,key);
    if (!item && keepTabs && tabs.length >= tabLimit && !unusedFallback(tab)) return {unavailable:'tab-limit'};
    const currentDirectory = item?.snapshot?.directory;
    const destination = key(currentDirectory) === location ? currentDirectory : directory;
    const windows = /^(?:[a-z]:|[\\/]{2})/i.test(destination);
    const prefix = windows ? destination.replace(/[\\/]+$/,'') + '\\' : destination.replace(/\/+$/,'') + '/';
    const originals = new Map();
    for (const path of paths) {
      const separator = Math.max(path.lastIndexOf('/'),windows ? path.lastIndexOf('\\') : -1) + 1;
      if (!separator || key(path.slice(0,separator)) !== location || separator === path.length) continue;
      originals.set(key(path),prefix + path.slice(separator));
    }
    const primary = originals.get(key(lead));
    if (primary) originals.delete(key(lead));
    const ordered = [...(primary ? [primary] : []),...originals.values()];
    const selected = ordered.slice(0,sourceSelectionLimit);
    let failed = false;
    const preserveSelection = keepSelection && !paths.length;
    const offset = preserveSelection && key(item?.snapshot?.directory) === location ? item.snapshot.offset : undefined;
    const navigation = {offset,locate:{paths:selected,lead:selected[0],preserveSelection,onFailure:() => { failed = true; }},
      focusList:!preserveSelection,clearCatalog:item?.searchScope === 'library'};
    let opening;
    let created = !tabs.length;
    if (item) opening = activateTab(item,false,destination,navigation);
    else if (!tabs.length || unusedFallback(tab) || tabs.length >= tabLimit) opening = navigate(destination,navigation);
    else {
      created = true;
      opening = addTab(destination,{afterCurrent:true,focusTab:false,navigation});
    }
    const target = tab;
    const opened = await opening;
    if (target !== tab || !isActive()) return false;
    if (!opened && keepTabs && failed) {
      if (created && !target.snapshot && !target.request) closeTab(target,{record:false,preserveWorkspace:true});
      return {unavailable:'directory'};
    }
    if (!opened || key(getCurrentDirectory()) !== location) return false;
    return {count:selected.length ? target.selection.size : 0,requested:selected.length,limited:ordered.length-selected.length};
  }

  function restoreDetachedTab(payload) {
    const path = startupPath(payload?.path);
    if (path === null || !isActive()) return false;
    void loadPlaces();
    const {view,driveView,iconSize,driveIconSize,downloadsOrder,offset,scrollTop,query,selectedPath,selectionPaths} = payload;
    Object.assign(tab,detachedTabOrder(payload),{
      view:listViews.includes(view) ? view : 'details',driveView:listViews.includes(driveView) ? driveView : 'grid',
      iconSize:iconSizes.includes(iconSize) ? iconSize : 'medium',driveIconSize:iconSizes.includes(driveIconSize) ? driveIconSize : 'medium',
      downloadsOrder:downloadsOrder && typeof downloadsOrder === 'object' ? detachedTabOrder(downloadsOrder) : undefined,
    });
    return navigate(path,{force:true,
      offset:Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined,
      query:typeof query === 'string' ? query : '',
      restored:{scrollTop:Number.isFinite(scrollTop) && scrollTop >= 0 ? scrollTop : 0,
        selectedPath:typeof selectedPath === 'string' ? selectedPath : null,
        selectionPaths:Array.isArray(selectionPaths) ? selectionPaths.slice(0,250).filter(p => typeof p === 'string') : []},
    });
  }

  function exit() {
    if (!isActive() || !onOpenAssetLibrary) return false;
    finishMarquee(true);
    cancelFrequentVisit();
    showThumbnails([],0);
    showEntryDetails();
    onOpenAssetLibrary();
    return true;
  }

  function focusAddress() {
    if (!isActive()) return false;
    address.focus({preventScroll:true});
    address.select();
    return true;
  }

  function selectedControl() {
    if (tab.selected && !catalogOnly()) {
      const index = tab.snapshot?.entries.findIndex(entry => pathKey(entry.path) === pathKey(tab.selected.path)) ?? -1;
      if (index >= 0) return itemButton(entryItem(index));
    }
  }

  function focusContent() {
    const target = selectedControl() || scroller;
    target.focus({preventScroll:true});
    if (target !== scroller) target.scrollIntoView({block:'nearest',inline:'nearest',container:'nearest'});
  }

  function cycleFocus(event) {
    const fileTab = tabsHost.querySelector('[aria-current="page"]');
    const sideTarget = placesHost.querySelector('[aria-current="page"]') || placesHost.querySelector('button');
    const header = table.tHead;
    const nameColumn = header.querySelector('.local-explorer-column-label');
    const zones = event.key === 'F6'
      ? [[navigation,fileTab],[form.parentElement,address],[sidebar,sideTarget],[scroller,selectedControl() || scroller]]
      : [[header,nameColumn],[scroller,selectedControl() || scroller],[footer,selectionCount],[footer,count]];
    const available = zones.filter(([,target]) => target?.getClientRects().length);
    if (!available.length) return false;
    const index = available.findIndex(([region,target]) => target === event.target ||
      region?.contains(event.target) && region !== footer);
    const offset = event.shiftKey ? -1 : 1;
    const next = index < 0 ? event.shiftKey ? available.at(-1) : available[0]
      : available[(index + offset + available.length) % available.length];
    if (next[0] === scroller) focusContent();
    else next[1].focus();
    return true;
  }

  function refresh() {
    if (!isActive()) return false;
    catalogSearch.refresh();
    if (catalogOnly()) return true;
    if (tab.snapshot && !tab.fileAction && !tab.request) {
      showThumbnails([],0,true);
      showEntryDetails([],[],true);
      if (treeListings.delete(treePathKey(tab.snapshot.directory))) scheduleSystemTree();
      void navigate(tabPath(tab),{index:tab.index,offset:tab.snapshot.offset,force:true});
    }
    return true;
  }

  function refreshStaleTab(item,checkedRevision = 0) {
    if (item === tab && item.snapshot?.directory && !item.request && !item.fileAction && !item.error &&
        item.snapshot.projectFilter !== activeProjectFilter(item.snapshot.directory,item.projectFilterBypass)) {
      void navigate(item.snapshot.directory,{index:item.index,offset:0});
      return;
    }
    const revision = item.stalePaths.get(pathKey(item.snapshot?.directory));
    if (item === tab && revision > checkedRevision) refresh();
    else reconcilePlaceListing(item);
  }

  function refreshAfterTransfer({paths = [],directoryPath,effect}) {
    const affected = new Set([pathKey(directoryPath)]);
    if (effect === 'move') {
      for (const path of paths) affected.add(pathKey(pathLocations(path).at(-2)?.path));
    }
    affected.delete('');
    let treeChanged = false;
    for (const path of affected) treeChanged = treeListings.delete(treePathKey(path)) || treeChanged;
    if (treeChanged) scheduleSystemTree();
    const revision = ++transferRevision;
    for (const item of tabs) {
      for (const path of [item.snapshot?.directory,item.request?.destination]) {
        const key = pathKey(path);
        if (!affected.has(key)) continue;
        item.stalePaths.delete(key);
        item.stalePaths.set(key,revision);
        if (item.stalePaths.size > historyLimit) item.stalePaths.delete(item.stalePaths.keys().next().value);
      }
    }
    refreshStaleTab(tab);
  }

  async function performFileAction(action,path,success = '',changed = false) {
    if (tab.request || tab.fileAction) return;
    const item = tab;
    item.fileAction = true;
    updateControls();
    report(item);
    try {
      await action(path);
      report(item,success);
    } catch (failure) {
      report(item,String(failure?.message || failure || '无法完成文件操作。'),true);
      return;
    } finally {
      item.fileAction = false;
      if (item === tab) {
        updateControls();
        refreshStaleTab(item);
      }
    }
    if (changed === 'remove' && item.selection.delete(pathKey(path))) {
      item.selectionRevision++;
      item.selected = item.selection.values().next().value;
      item.selectionAnchor = item.selected ? pathKey(item.selected.path) : null;
      if (item === tab) drawSelection();
    }
    if (changed && item === tab) refresh();
    return true;
  }

  function openEntry(entry) {
    if (!entry || tab.request || tab.fileAction) return;
    if (entry.isDirectory) void navigate(entry.path,{focusList:true});
    else if (open) {
      const directory = getCurrentDirectory();
      const revision = frequentClearRevision;
      void performFileAction(path => open({path}),entry.path).then(completed => {
        if (completed && revision === frequentClearRevision) creditFrequentVisit(directory);
      });
    }
  }

  function setView(view,size,{keepAnchor = true} = {}) {
    tab.emptyFallback = false;
    const drives = isDriveView(tab.snapshot);
    const entries = tab.snapshot?.entries;
    const anchor = keepAnchor && !drives && entries &&
      (tab.view !== view || view === 'grid' && iconSizes.includes(size) && tab.iconSize !== size)
      ? visibleRowAnchor(entries) : null;
    tab[drives ? 'driveView' : 'view'] = view;
    if (view === 'grid' && iconSizes.includes(size)) tab[drives ? 'driveIconSize' : 'iconSize'] = size;
    updateView();
    if (anchor) restoreRowAnchor(anchor,entries,true);
  }

  function updateNavigationPreference() {
    panel.toggleAttribute('data-explorer-hide-navigation',!prefs.showNavigation);
    if (sidebar) sidebar.hidden = !prefs.showNavigation;
    if (sidebarDivider) sidebarDivider.hidden = !prefs.showNavigation;
    if (prefs.showNavigation) renderSystemTree();
  }

  function updateChromePreferences() {
    panel.toggleAttribute('data-explorer-compact',prefs.compact);
    panel.toggleAttribute('data-explorer-hide-toolbar',!prefs.showToolbar);
    panel.toggleAttribute('data-explorer-hide-bookmarks',!prefs.showBookmarks);
    panel.style.setProperty('--explorer-control-text-scale',String((Number(prefs.controlTextScale) || 100) / 100));
  }

  function applyPreferences(next) {
    const previous = prefs;
    prefs = {...prefs,...next};
    if (previous.shortcutBindings !== prefs.shortcutBindings) updateShortcutLabels();
    if (previous.showHidden !== prefs.showHidden) treeListings.clear();
    updateChromePreferences();
    if (previous.showNavigation !== prefs.showNavigation) updateNavigationPreference();
    if (previous.showFrequent !== prefs.showFrequent) {
      beginFrequentVisit();
      renderLinks();
    }
    if (previous.showHidden !== prefs.showHidden) {
      for (const item of tabs) {
        item.request = item.snapshot = null;
        item.selection.clear();
        item.selectionRevision++;
        item.selected = item.selectionAnchor = null;
      }
      render();
      if (isActive() && !startupPending) return navigate(tabPath(tab),{index:tab.index,offset:0,force:true});
      return;
    }
    const snapshot = tab.snapshot;
    if (snapshot && !isDriveView(snapshot)) {
      if (previous.stackSequences !== prefs.stackSequences) {
        finishMarquee(true);
        const anchor = visibleRowAnchor(snapshot.entries);
        if (!prefs.stackSequences) for (const item of tabs) item.expandedSequences.clear();
        tbody.replaceChildren(entryRows(snapshot.entries,snapshot.dateGroups));
        if (anchor) restoreRowAnchor(anchor,snapshot.entries);
        drawSelection();
      } else if (previous.showExtensions !== prefs.showExtensions || previous.showUnindexed !== prefs.showUnindexed) {
        for (const row of tbody.querySelectorAll('[data-entry-index]')) {
          const entry = snapshot.entries[Number(row.dataset.entryIndex)];
          if (previous.showExtensions !== prefs.showExtensions) {
            const name = displayEntryName(entry);
            row.querySelector('.local-explorer-entry-name').textContent = name;
            const statusText = row.querySelector('.local-explorer-asset-state')?.textContent;
            itemButton(row).setAttribute('aria-label',name + (entry.isDirectory ? '，文件夹' : statusText ? '，' + statusText : ''));
          }
          if (previous.showUnindexed !== prefs.showUnindexed && assetDetails.get(entry.path) === null)
            paintAssetDetails(row,entry,null);
        }
      }
    }
    updateView();
  }

  function zoomView(direction,target,pointerY) {
    const drives = isDriveView(tab.snapshot);
    const view = drives ? 'driveView' : 'view';
    const size = drives ? 'driveIconSize' : 'iconSize';
    const current = tab[view] === 'grid' ? iconSizes.indexOf(tab[size]) + 1 : 0;
    const next = Math.min(iconSizes.length,Math.max(0,current + direction));
    if (next === current) return;
    finishMarquee(true);
    const item = target.closest('[data-entry-index]');
    const bounds = item?.getBoundingClientRect();
    const fraction = bounds?.height ? (pointerY - bounds.top) / bounds.height : 0;
    if (next) tab[size] = iconSizes[next - 1];
    setView(next ? 'grid' : 'details',undefined,{keepAnchor:false});
    if (bounds?.height && item.isConnected) {
      const updated = item.getBoundingClientRect();
      scroller.scrollTop += updated.top + updated.height * fraction - pointerY;
    }
  }

  function applyViewAction(action,current) {
    if (action === 'refresh') { refresh(); return; }
    if (action === 'view-details' || action === 'view-grid') { setView(action.slice(5)); return; }
    switch (action) {
      case 'sort-name': case 'sort-date': case 'sort-type': case 'sort-size': case 'sort-created':
        setOrder({sortBy:action.slice(5)});
        break;
      case 'sort-asc': case 'sort-desc':
        setOrder({descending:action === 'sort-desc'});
        break;
      case 'group-none': case 'group-date':
        setOrder({groupBy:action.slice(6)});
        break;
      default:
        return;
    }
    void navigate(current.directory,{index:tab.index,offset:0});
  }

  function validateNameInput(input,filesystem) {
    let composing = false;
    let confirmingCandidate = false;
    input.addEventListener('compositionstart',() => { composing = true; });
    input.addEventListener('compositionend',() => { composing = false; });
    input.addEventListener('keydown',event => {
      if (event.key === 'Enter' && (composing || event.isComposing || event.keyCode === 229)) {
        confirmingCandidate = true;
        setTimeout(() => { confirmingCandidate = false; },0);
      }
    });
    input.addEventListener('input',() => input.setCustomValidity(''));
    input.form.addEventListener('submit',event => {
      if (event.submitter?.value === 'cancel') return;
      if (composing || confirmingCandidate) { event.preventDefault(); return; }
      const name = input.value.trim();
      const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
      const invalid = filesystem && (/[/\\<>:"|?*\u0000-\u001f]|\.$/.test(name) || reservedName.test(name));
      const message = !name ? '请填写名称。' : invalid ? '名称含有 Windows 保留字符或保留名称。' : '';
      if (!message) return;
      event.preventDefault();
      input.setCustomValidity(message);
      input.focus({preventScroll:true});
      input.reportValidity();
    });
  }

  function renameEntry(entry) {
    if (!fileAction || !entry || owner.querySelector('dialog[open]')) return;
    const item = tab;
    const directory = tab.snapshot?.directory;
    const opener = owner.activeElement;
    const dialog = element('dialog','modal compact-dialog');
    dialog.setAttribute('aria-label','重命名');
    dialog.innerHTML = '<form method="dialog"><h2>重命名</h2><label class="field-label">名称' +
      '<input class="text-field" aria-label="名称" maxlength="255" required autofocus></label>' +
      '<div class="modal-footer"><button type="submit" class="button subtle" value="cancel" formnovalidate>取消</button>' +
      '<button type="submit" class="button primary" value="rename">重命名</button></div></form>';
    const input = dialog.querySelector('input');
    input.value = entry.name;
    validateNameInput(input,true);
    dialog.addEventListener('close',() => {
      const name = input.value.trim();
      dialog.remove();
      if (opener?.isConnected) opener.focus({preventScroll:true});
      if (dialog.returnValue !== 'rename' || !name || name === entry.name || tab !== item ||
          tab.snapshot?.directory !== directory) return;
      void performFileAction(path => fileAction({action:'rename',path,name}),entry.path,'','remove');
    },{once:true});
    panel.append(dialog);
    dialog.showModal();
    input.select();
  }

  function selectVisibleName(entry) {
    if (!entry || owner.querySelector('dialog[open]')) return;
    const opener = owner.activeElement;
    const dialog = element('dialog','modal compact-dialog');
    dialog.setAttribute('aria-label','选择文件名');
    dialog.innerHTML = '<form method="dialog"><h2>选择名称</h2><label class="field-label">当前显示名称' +
      '<input class="text-field" readonly autofocus></label><p role="status"></p>' +
      '<div class="modal-footer"><button type="submit" class="button subtle">关闭</button>' +
      '<button type="button" class="button primary">复制所选文字</button></div></form>';
    const input = dialog.querySelector('input');
    const message = dialog.querySelector('[role="status"]');
    input.value = displayEntryName(entry);
    dialog.querySelector('button[type="button"]').addEventListener('click',async () => {
      const text = input.value.slice(input.selectionStart,input.selectionEnd);
      if (!text) { message.textContent = '请选中要复制的文字。'; input.focus(); return; }
      try { await copy(text); message.textContent = '所选文字已复制。'; }
      catch (failure) { message.textContent = String(failure?.message || failure); }
    });
    dialog.addEventListener('close',() => {
      dialog.remove();
      if (opener?.isConnected) opener.focus({preventScroll:true});
    },{once:true});
    panel.append(dialog);
    dialog.showModal();
    input.select();
  }

  function batchRename() {
    if (!fileAction || tab.selection.size < 2 || !getCurrentDirectory()) return;
    const item = tab;
    const directory = getCurrentDirectory();
    const entries = getSelectedEntries();
    showExplorerBatchRename({panel,entries,apply:async changes => {
      if (item !== tab || getCurrentDirectory() !== directory || item.request || item.fileAction)
        throw Error('文件夹已切换，请重新选择要重命名的项目。');
      item.fileAction = true;
      updateControls();
      const outcomes = [];
      let changed = false;
      try {
        for (const change of changes) {
          if (item !== tab || getCurrentDirectory() !== directory) {
            outcomes.push('当前文件夹已切换');
            continue;
          }
          try {
            await fileAction({action:'rename',...change});
            changed = true;
            outcomes.push('');
          } catch (failure) { outcomes.push(String(failure?.message || failure)); }
        }
      } finally {
        item.fileAction = false;
        if (item === tab) updateControls();
        if (changed) refreshAfterTransfer({directoryPath:directory});
      }
      return outcomes;
    }});
  }

  async function paste(directoryPath) {
    if (!clipboard || !directoryPath) return;
    const item = tab;
    const snapshot = tab.snapshot;
    const current = () => isActive() && item === tab && item.snapshot === snapshot && !catalogOnly();
    let changed = false;
    await performFileAction(async path => {
      const preview = await pasteConflicts?.preview({path});
      if (!current()) return;
      if (!preview?.signature || !preview.conflicts.length) {
        await clipboard({action:'paste',path,...(preview?.sequence != null && {sequence:preview.sequence})});
        changed = true;
        return;
      }
      const result = await showExplorerPasteConflicts({panel,destination:path,preview,
        apply(decisions) {
          if (!current()) throw Error('文件夹已切换，请重新粘贴。');
          return pasteConflicts.apply({path,sequence:preview.sequence,signature:preview.signature,decisions});
        },
      });
      changed = Boolean(result?.copied);
    },directoryPath);
    if (changed) refreshAfterTransfer({directoryPath});
  }

  function applyAction(action,entry,current) {
    const directory = current.directory && !isDriveView(current) ? current.directory : null;
    const path = entry?.path || directory;
    const paths = entry && tab.selection.has(pathKey(entry.path))
      ? [...tab.selection.values()].map(item => item.path) : [path];
    if (action.startsWith('copy-path:') && path) {
      const format = action.slice('copy-path:'.length);
      return performFileAction(copy,formatExplorerPaths(paths,format),'路径已复制。');
    }
    switch (action) {
      case 'open': return openEntry(entry);
      case 'open-tab': return addTab(path);
      case 'copy-path': return performFileAction(copy,formatExplorerPaths(paths),'路径已复制。');
      case 'copy-names': {
        const remaining = new Map(paths.map(path => [pathKey(path),tab.selection.get(pathKey(path)) || entry]));
        const names = visibleEntries().filter(item => remaining.delete(pathKey(item.path))).map(item => item.name);
        for (const item of remaining.values()) if (item) names.push(item.name);
        if (names.length) return performFileAction(copy,names.join('\n'),`已复制 ${names.length} 个项目名称。`);
        break;
      }
      case 'copy-visible-names': {
        const names = [...tbody.querySelectorAll('[data-entry-index]:not([hidden])')]
          .map((item,index) => (index + 1) + '. ' + current.entries[Number(item.dataset.entryIndex)].name);
        if (names.length) return performFileAction(copy,names.join('\n'),'已复制本页项目名称。');
        break;
      }
      case 'reveal': return reveal && performFileAction(target => reveal({path:target}),path);
      case 'locate-asset':
      case 'add-to-assets': {
        const target = assetTarget(entry,current);
        const callback = action === 'locate-asset' ? onBrowseAssets : onAddToAssets;
        if (target && callback) return performFileAction(() => callback(target),target.path);
        break;
      }
      case 'favorite-asset': return toggleAssetFavorite(entry);
      case 'project-dependencies':
        return onProjectDependencies && performFileAction(target => onProjectDependencies(target),path);
      case 'add-to-collection': {
        const files = getSelectedEntries().filter(item => !item.isDirectory);
        if (directory && files.length && onAddToCollection)
          return performFileAction(() => onAddToCollection(files),directory);
        break;
      }
      case 'add-to-basket': {
        const items = getSelectedEntries();
        if (onAddToBasket && directory && items.length) onAddToBasket(items);
        break;
      }
      case 'send-to-c4d':
      case 'add-to-whiteboard':
      case 'move-indexed-files': {
        if (!directory) break;
        const entries = getSelectedEntries();
        const files = entries.filter(item => !item.isDirectory);
        if (!files.length) break;
        const item = tab;
        const revision = item.selectionRevision;
        const sameTab = () => item === tab && isActive() && getCurrentDirectory() === directory;
        const stillSelected = () => sameTab() && item.selectionRevision === revision;
        if (action === 'add-to-whiteboard')
          return onAddToWhiteboard && performFileAction(() => onAddToWhiteboard(files,stillSelected),directory);
        if (action === 'move-indexed-files') {
          if (!onMoveIndexedFiles || !canMoveIndexedFiles?.(entries)) break;
          const {scrollTop,scrollLeft} = scroller;
          let result;
          return performFileAction(async () => {
            try { result = await onMoveIndexedFiles({files,stillSelected}); }
            finally {
              if (sameTab()) {
                scroller.scrollTop = scrollTop;
                scroller.scrollLeft = scrollLeft;
              }
            }
            if (!result) return;
            const before = item.selection.size;
            for (const file of files) item.selection.delete(pathKey(file.path));
            if (item.selection.size === before) return;
            item.selectionRevision++;
            item.selected = item.selection.get(pathKey(item.selected?.path)) ?? item.selection.values().next().value;
            item.selectionAnchor = item.selected ? pathKey(item.selected.path) : null;
            if (item === tab) drawSelection();
          },directory)
            .then(async done => {
              const target = result?.target;
              if (!done || !target || !sameTab()) return;
              try {
                const {paths,directory:location} = target;
                const opened = paths.length === 1 ? await revealSource(paths[0],{directory:location}) :
                  await revealSources(paths,{directory:location,lead:paths[0]});
                if (!opened) report(item,'找不到移动后的文件。',true);
                else if (typeof opened === 'object' && opened.count !== paths.length)
                  report(tab,`已定位 ${opened.count} / ${paths.length} 个移动后的文件。`,true);
              }
              catch (failure) { report(item,String(failure?.message || failure),true); }
            });
        }
        if (!onSendToC4d) break;
        return performFileAction(() => onSendToC4d({files,stillSelected}),directory);
      }
      case 'pin': return togglePin(path,entry?.name);
      case 'create-folder-shortcut':
        if (onCreateFolderShortcut && path && (entry?.isDirectory || !entry && directory))
          return performFileAction(onCreateFolderShortcut,path);
        break;
      case 'inspect-cleanup':
        if (onInspectCleanup && directory && (!entry || entry.isDirectory)) onInspectCleanup(path);
        break;
      case 'configure-project-filter':
        if (projectFilters && (!entry || entry.isDirectory)) projectFilters.configure(path);
        break;
      case 'open-shot-board': {
        const code = (!entry || entry.isDirectory) && explorerShotCode(path);
        if (!code || !directory || !onOpenShotBoard) break;
        const item = tab;
        const stillRequested = () => isActive() && item === tab && item.snapshot === current;
        return performFileAction(() => onOpenShotBoard(code,{stillRequested}),path);
      }
      case 'copy': case 'cut':
        return clipboard && performFileAction(target => clipboard({action,path:target,
          ...(paths.length > 1 && {paths})}),path);
      case 'paste':
        return paste(entry?.isDirectory ? path : directory);
      case 'new-folder':
        return fileAction && performFileAction(target => fileAction({action,path:target}),directory,'',true);
      case 'rename': return renameEntry(entry);
      case 'batch-rename': return batchRename();
      case 'select-name': return selectVisibleName(entry);
      case 'inspect-render-sequence': {
        const target = assetTarget(entry,current);
        if (target && onInspectRenderSequence)
          return performFileAction(() => onInspectRenderSequence(target),target.path);
        break;
      }
      case 'compare-exr-channels':
        if (entry && !entry.isDirectory && /\.exr$/i.test(entry.name) && onCompareExrChannels)
          return performFileAction(target => onCompareExrChannels({path:target}),path);
        break;
      case 'trash':
        return fileAction && performFileAction(target => fileAction({action,path:target}),path,'','remove');
      case 'properties':
        return fileAction && performFileAction(target => fileAction({action,path:target}),path);
      default: return applyViewAction(action,current);
    }
  }

  function contextItems(entry,current,ratingTarget) {
    const driveView = isDriveView(current);
    const directory = !driveView && current.directory;
    const path = entry?.path || directory;
    const pinned = path && pins.some(pin => pathKey(pin.path) === pathKey(path));
    const pinnedInSidebar = path && sidebarPins.some(pin => pathKey(pin.path) === pathKey(path));
    const row = (id,label,shortcut,disabled = false,checked) => ({id,label,shortcut,disabled,checked});
    const separator = {separator:true};
    const tools = [];
    let ratingItem;
    if (ratingTarget) {
      const {assets} = ratingTarget;
      ratingItem = {id:'asset-rating',label:assets.length === 1 ? '资产评分' : '批量资产评分',children:
        [5,4,3,2,1,0].map(rating => row('asset-rating-' + rating,rating ? '★'.repeat(rating) + ' ' + rating + ' 星' : '清除评分',
          undefined,false,assets.every(asset => asset.rating === rating)))};
    }
    if (entry && tab.selection.size > 1) {
      const move = onMoveIndexedFiles && canMoveIndexedFiles?.(getSelectedEntries());
      if (directory && clipboard) tools.push(row('cut','剪切','Ctrl+X'),row('copy','复制','Ctrl+C'));
      tools.push(row('copy-path','复制路径','Ctrl+Shift+C'),copyPathFormats(row),row('copy-names','复制所选项目名称'));
      if (directory && fileAction) tools.push(row('batch-rename','批量重命名…','F2'));
      if (directory && onAddToBasket) tools.push(row('add-to-basket','加入临时素材篮'));
      if (directory && hasSelectedFiles() && (onAddToCollection || onSendToC4d || onAddToWhiteboard || move || ratingItem)) {
        tools.push(separator);
        if (ratingItem) tools.push(ratingItem);
        if (onAddToCollection) tools.push(row('add-to-collection','将所选文件加入合集…'));
        if (onAddToWhiteboard) tools.push(row('add-to-whiteboard','添加到白板…'));
        if (onSendToC4d) tools.push(row('send-to-c4d','发送到 Cinema 4D…'));
        if (move) tools.push(row('move-indexed-files','移动原件并保留资产记录…'));
      }
      return tools;
    }
    if (entry) {
      tools.push(row('open','打开','Enter',!entry.isDirectory && !open));
      if (entry.isDirectory) tools.push(row('open-tab','在新标签页打开',undefined,tabs.length >= tabLimit));
      tools.push(row('select-name',entry.isDirectory ? '选择文件夹名称' : '选择文件名'));
      if (path) tools.push(separator);
    } else {
      if (directory && fileAction) tools.push(row('new-folder','新建文件夹','Ctrl+Shift+N'));
      if (directory && clipboard) tools.push(row('paste','粘贴','Ctrl+V'));
      if (tools.length) tools.push(separator);
      const view = driveView ? tab.driveView : tab.view;
      const order = orderFor(tab,current.directory);
      tools.push({id:'menu-view',label:'查看',children:[
        row('view-details','详细信息',undefined,false,view === 'details'),
        row('view-grid','图标',undefined,false,view === 'grid'),
      ]});
      if (directory) {
        tools.push({id:'menu-sort',label:'排序方式',children:[
          ...[['name','名称'],['date','修改日期'],['created','创建日期'],['type','类型'],['size','大小']]
            .map(([sort,label]) => row('sort-' + sort,'按' + label + '排序',undefined,false,order.sortBy === sort)),
          separator,
          row('sort-asc','升序',undefined,false,!order.descending),
          row('sort-desc','降序',undefined,false,order.descending),
        ]},{id:'menu-group',label:'分组依据',children:[
          row('group-date','按修改日期分组',undefined,false,order.groupBy === 'date'),
          row('group-none','取消分组',undefined,false,order.groupBy === 'none'),
        ]});
      }
      tools.push(row('refresh','刷新','F5'));
      if (directory && tbody.querySelector('[data-entry-index]:not([hidden])'))
        tools.push(row('copy-visible-names','复制本页可见项目名称（带序号）'));
      if (path) tools.push(separator);
    }
    if (entry && directory && clipboard) {
      tools.push(row('cut','剪切','Ctrl+X'),row('copy','复制','Ctrl+C'));
    }
    if (entry?.isDirectory && clipboard) tools.push(row('paste','粘贴到此文件夹','Ctrl+V'));
    if ((entry?.isDirectory || !entry && directory) && path) {
      tools.push(row('pin',pinnedInSidebar ? '已固定在侧栏' : pinned ? '取消固定' : '固定到常用位置',undefined,
        pinnedInSidebar || (!pinned && pins.length >= pinLimit)));
      if (onCreateFolderShortcut) tools.push(row('create-folder-shortcut','创建 Nexus 桌面入口'));
      if (onInspectCleanup && directory) tools.push(row('inspect-cleanup','标记可清理的中间产物…'));
      if (projectFilters && directory) tools.push(row('configure-project-filter','为此文件夹设置项目筛选…'));
      const shot = onOpenShotBoard && directory && explorerShotCode(path);
      if (shot) tools.push(row('open-shot-board','跳到 ' + shot + ' 的白板书签…'));
    }
    if (path) {
      if (assetTarget(entry,current)) {
        if (onBrowseAssets) tools.push(row('locate-asset','在资产库中定位'));
        if (onAddToAssets) tools.push(row('add-to-assets','加入资产库…'));
        const file = entry && !entry.isDirectory;
        const asset = file ? assetDetails.get(path) : null;
        if (asset && onToggleFavorite) tools.push(row('favorite-asset',asset.favorite ? '移出资产收藏' : '添加到资产收藏',undefined,favoriteRequests.has(asset.id)));
        if (ratingItem) tools.push(ratingItem);
        if (file && onAddToCollection) tools.push(row('add-to-collection','加入合集…'));
        if (file && onAddToWhiteboard) tools.push(row('add-to-whiteboard','添加到白板…'));
        if (file && onSendToC4d) tools.push(row('send-to-c4d','发送到 Cinema 4D…'));
        if (file && onMoveIndexedFiles && canMoveIndexedFiles?.([entry]))
          tools.push(row('move-indexed-files','移动原件并保留资产记录…'));
        if (entry && onAddToBasket) tools.push(row('add-to-basket','加入临时素材篮'));
        if (file && onProjectDependencies && /\.gltf$/i.test(path)) tools.push(row('project-dependencies','检查与替换 glTF 依赖…'));
        if (onInspectRenderSequence && (!file || isExplorerRenderFrame(entry.name)))
          tools.push(row('inspect-render-sequence','检查渲染序列…'));
        if (file && onCompareExrChannels && /\.exr$/i.test(entry.name))
          tools.push(row('compare-exr-channels','对比 OpenEXR 通道…'));
        if (onBrowseAssets || onAddToAssets || asset && onToggleFavorite || file && onAddToCollection || ratingItem) tools.push(separator);
      }
      tools.push(row('copy-path','复制路径','Ctrl+Shift+C'),copyPathFormats(row));
      if (entry) tools.push(row('copy-names',entry.isDirectory ? '复制文件夹名称' : '复制原文件名'));
      if (reveal) tools.push(row('reveal','在资源管理器中显示'));
      if (entry && directory && fileAction) {
        tools.push(row('rename','重命名','F2'),row('trash','移到回收站','Delete'));
      }
      if (fileAction) tools.push(row('properties','属性','Alt+Enter'));
    }
    return tools;
  }

  function copyPathFormats(row) {
    return {id:'copy-path-formats',label:'复制路径为',children:
      explorerPathFormats.map(([format,label]) => row('copy-path:' + format,label))};
  }

  async function showContextMenu(entry,position = {}) {
    if (!contextMenu || !tab.snapshot || tab.request || tab.fileAction || menuOpen) return;
    const item = tab;
    const current = item.snapshot;
    if (!entry || !tab.selection.has(pathKey(entry.path))) selectEntry(entry);
    const revision = item.selectionRevision;
    const ratingTarget = entry && !entry.isDirectory && current.directory && assetRating?.lookup(getSelectedEntries());
    const items = contextItems(entry,current,ratingTarget);
    menuOpen = true;
    try {
      const action = await contextMenu({...position,items});
      if (!action || item !== tab || current !== tab.snapshot || !isActive()) return;
      const rating = /^asset-rating-([0-5])$/.exec(action);
      if (rating) {
        const stillSelected = () => item === tab && current === tab.snapshot && isActive() && item.selectionRevision === revision;
        if (ratingTarget && stillSelected()) void performFileAction(
          () => assetRating.save({...ratingTarget,rating:Number(rating[1]),stillSelected}),current.directory);
      } else void applyAction(action,entry,current);
    } catch (failure) {
      if (item.snapshot === current) report(item,String(failure?.message || failure),true);
    } finally {
      menuOpen = false;
    }
  }

  async function showGroupNamesMenu(group,position = {}) {
    if (!contextMenu || !tab.snapshot || tab.request || tab.fileAction || menuOpen) return;
    const item = tab;
    const current = item.snapshot;
    const files = [...tbody.querySelectorAll('[data-explorer-date-group]')]
      .filter(row => row.dataset.explorerDateGroup === group)
      .map(row => current.entries[Number(row.dataset.entryIndex)])
      .filter(entry => !entry.isDirectory);
    menuOpen = true;
    try {
      const action = await contextMenu({...position,items:[
        {id:'copy-group-names',label:'复制本页此组文件名',disabled:!files.length},
      ]});
      if (action === 'copy-group-names' && files.length && tab === item && tab.snapshot === current && isActive())
        void performFileAction(copy,files.map(entry => entry.name).join('\n'),'已复制本页此组文件名。');
    } catch (failure) {
      report(item,String(failure?.message || failure),true);
    } finally {
      menuOpen = false;
    }
  }

  const pinsFor = rail => rail === 'sidebar' ? sidebarPins : pins;
  const pinHostFor = rail => rail === 'sidebar' ? placesHost : pinHost;

  function savePins(updated,rail = 'top') {
    try {
      storage.setItem(rail === 'sidebar' ? sidebarPinKey : pinKey,JSON.stringify(updated));
    } catch {
      report(tab,'无法保存固定的文件夹。',true);
      return false;
    }
    if (rail === 'sidebar') sidebarPins = updated;
    else pins = updated;
    renderLinks();
    updateControls();
    return true;
  }

  function addPins(sources,rail) {
    const current = pinsFor(rail);
    const updated = [...current];
    const knownPlaces = rail === 'sidebar' ? [...(places?.folders || []),...(places?.drives || listedDrives)] : [];
    const seen = new Set([...pins,...sidebarPins,...knownPlaces].map(pin => pathKey(pin.path)));
    for (const {path,name,isDirectory} of sources) {
      if (updated.length >= pinLimit) break;
      const key = pathKey(path);
      if (isDirectory === false || !key || key === networkLocation || seen.has(key)) continue;
      seen.add(key);
      updated.push({path,name:name || nameForPath(path)});
    }
    const added = updated.length - current.length;
    return added && savePins(updated,rail) ? added : 0;
  }

  const pinFolders = sources => addPins(sources,'top');
  const pinSidebarFolders = sources => addPins(sources,'sidebar');

  function togglePin(path,name = nameForPath(path)) {
    if (!path || path === networkLocation) return;
    const key = pathKey(path);
    const pinned = pins.some(pin => pathKey(pin.path) === key);
    if (pinned) savePins(pins.filter(pin => pathKey(pin.path) !== key));
    else pinFolders([{path,name}]);
  }

  function renamePin(pin,rail) {
    if (owner.querySelector('dialog[open]')) return;
    const dialog = element('dialog','modal compact-dialog');
    dialog.setAttribute('aria-label','重命名书签');
    dialog.innerHTML = '<form method="dialog"><h2>重命名书签</h2><label class="field-label">名称' +
      '<input class="text-field" aria-label="名称" maxlength="128" required autofocus></label>' +
      '<div class="modal-footer"><button type="submit" class="button subtle" value="cancel" formnovalidate>取消</button>' +
      '<button type="submit" class="button primary" value="rename">保存</button></div></form>';
    const input = dialog.querySelector('input');
    input.value = pin.name;
    validateNameInput(input,false);
    const key = pathKey(pin.path);
    const host = pinHostFor(rail);
    dialog.addEventListener('close',() => {
      const name = input.value.trim();
      dialog.remove();
      if (dialog.returnValue === 'rename' && name && name !== pin.name)
        savePins(pinsFor(rail).map(item => pathKey(item.path) === key ? {...item,name} : item),rail);
      [...host.querySelectorAll('[data-explorer-pin-path]')].find(button =>
        pathKey(button.dataset.explorerPinPath) === key)?.focus({preventScroll:true});
    },{once:true});
    panel.append(dialog);
    dialog.showModal();
    input.select();
  }

  function pinParent(path) {
    const parent = pathLocations(path).at(-2)?.path || '';
    return /^(?:\\\\\?\\UNC\\|\\\\)[^\\/]+$/i.test(parent) ? networkLocation : parent;
  }

  async function showPinMenu(anchor,position) {
    if (!contextMenu || !isActive() || menuOpen) return;
    const key = pathKey(anchor.dataset.explorerPinPath);
    const rail = anchor.dataset.explorerPinRail;
    const host = pinHostFor(rail);
    const list = pinsFor(rail);
    const index = list.findIndex(pin => pathKey(pin.path) === key);
    if (index < 0) return;
    const pin = list[index];
    anchor.focus({preventScroll:true});
    menuOpen = true;
    try {
      const action = await contextMenu({...position,items:[
        {id:'pin-open',label:'打开'},
        {id:'pin-parent',label:'打开所在位置'},
        {separator:true},
        {id:'pin-first',label:'置顶',disabled:index === 0},
        {id:'pin-rename',label:'重命名书签'},
        {id:'pin-remove',label:rail === 'sidebar' ? '从侧栏取消固定' : '从快速访问取消固定'},
      ]});
      const current = pinsFor(rail);
      if (!isActive() || !current.includes(pin)) return;
      if (action === 'pin-open') void navigate(pin.path,{focusList:true});
      if (action === 'pin-parent') void navigate(pinParent(pin.path),{focusList:true});
      if (action === 'pin-first') {
        if (savePins([pin,...current.filter(item => item !== pin)],rail))
          host.querySelector('[data-explorer-pin-path]')?.focus({preventScroll:true});
      }
      if (action === 'pin-rename') renamePin(pin,rail);
      if (action === 'pin-remove' && savePins(current.filter(item => item !== pin),rail))
        (host.querySelector('[data-explorer-pin-path]') || (rail === 'sidebar' && host.querySelector('button')) ||
          pinButton).focus({preventScroll:true});
    } catch (failure) {
      report(tab,String(failure?.message || failure),true);
    } finally {
      menuOpen = false;
    }
  }

  async function showHistoryMenu() {
    if (!contextMenu || !isActive() || menuOpen || tab.request || tab.fileAction) return;
    const item = tab;
    const {history,index,snapshot} = item;
    const path = getCurrentDirectory();
    const button = buttons.get('history');
    const position = button?.getBoundingClientRect();
    const items = history.map((entry,number) => ({
      id:'history:' + number,label:addressText(entry),disabled:number === index,checked:number === index,
      shortcut:number < index ? '后退' : number === index ? '当前' : '前进',
    }));
    if (path) items.push({separator:true},{id:'copy-quoted-folder',label:'复制当前路径（带引号）'});
    if (!items.length) return;
    menuOpen = true;
    try {
      const action = await contextMenu({x:position?.left,y:position?.bottom,items});
      if (item !== tab || history !== tab.history || snapshot !== tab.snapshot || index !== tab.index || !isActive()) return;
      if (action === 'copy-quoted-folder' && path) {
        void performFileAction(copy,formatExplorerPaths([path],'windows'),'已复制带引号的路径。');
      } else if (action?.startsWith('history:')) {
        const target = Number(action.slice('history:'.length));
        if (Number.isInteger(target) && target !== index && target in history)
          void navigate(history[target],{index:target,focusList:true,clearCatalog:true});
      }
    } catch (failure) {
      report(item,String(failure?.message || failure),true);
    } finally {
      menuOpen = false;
    }
  }

  const actions = {
    back: () => navigate(tab.history[tab.index - 1],{index:tab.index - 1}),
    forward: () => navigate(tab.history[tab.index + 1],{index:tab.index + 1}),
    history: showHistoryMenu,
    up: () => navigate(tab.snapshot.parent || ''),
    refresh,
    drives: () => navigate(''),
    close: exit,
    open: () => openEntry(tab.selected),
    copy: () => applyAction('copy-path',tab.selected,tab.snapshot),
    reveal: () => performFileAction(path => reveal({path}),tab.selected?.path || tab.snapshot.directory),
    'previous-page': () => navigate(tabPath(tab),{index:tab.index,offset:tab.snapshot.previousOffset}),
    'next-page': () => navigate(tabPath(tab),{index:tab.index,offset:tab.snapshot.nextOffset}),
  };
  const canChangeView = () => Boolean(tab.snapshot && !tab.request && !tab.fileAction);
  const commandSearch = initExplorerCommandSearch(owner.getElementById('explorer-command-search'),{
    isActive,
    onError:failure => report(tab,String(failure?.message || failure),true),
    commands:[
      ...[
        ['back','后退',['back','返回','上一位置']],
        ['forward','前进',['forward','下一位置']],
        ['up','返回上一级',['up','parent','向上','上级目录']],
        ['refresh','刷新当前位置',['refresh','reload','重读','f5']],
        ['drives','打开此电脑',['computer','drives','this pc','盘符']],
        ['history','浏览历史',['history','访问历史','路径历史']],
        ['copy','复制路径',['copy path','复制地址','路径复制']],
      ].map(([id,label,aliases]) => ({id,label,aliases,available:() => !buttons.get(id)?.disabled,run:actions[id]})),
      {id:'address',label:'定位地址栏',aliases:['address','addr','location','path','跳路径'],
        available:() => !address.disabled,run:focusAddress},
      {id:'search',label:'搜索当前位置',aliases:['find','search','搜文件','目录搜索'],
        available:() => !search.disabled,run:() => search.focus()},
      {id:'new-tab',label:'新建文件夹标签页',aliases:['new tab','新标签'],
        available:() => !addTabButton.disabled,run:() => addTab()},
      {id:'batch-tabs',label:'从文本批量打开文件夹',aliases:['batch tabs','多目录','批量标签'],
        available:() => Boolean(checkFolderPaths),run:openBatchPaths},
      {id:'duplicate-tab',label:'复制当前标签页',aliases:['duplicate tab','duplicate','复制标签'],
        available:canDuplicateActive,run:duplicateActive},
      {id:'restore-tab',label:'重新打开已关闭的标签页',aliases:['reopen tab','undo close','恢复标签','重开标签'],
        available:hasClosedTabs,run:restoreClosedTab},
      {id:'new-folder',label:'新建文件夹',aliases:['new folder','mkdir','建目录','新建目录'],
        available:() => Boolean(fileAction && canChangeView() && getCurrentDirectory()),
        run:() => applyAction('new-folder',null,tab.snapshot)},
      ...[
        ['details','详细信息视图',['details','明细','详情']],
        ['grid','图标视图',['icons','grid','网格','缩略图']],
        ['list','列表视图',['list','列表']],
      ].map(([view,label,aliases]) => ({id:'view-' + view,label,aliases,available:canChangeView,run:() => setView(view)})),
    ],
  });
  panel.querySelector('[data-explorer-command-search]')?.addEventListener('click',commandSearch.show);
  function updateShortcutLabels() {
    const configured = normalizeExplorerShortcuts(prefs.shortcutBindings);
    for (const [name,keys] of Object.entries(configured)) {
      const node = name === 'address' ? address : name === 'search' ? search : buttons.get(name);
      if (!node) continue;
      const visible = keys.filter(Boolean);
      if (visible.length) node.setAttribute('aria-keyshortcuts',visible.map(key => key.replace(/^Ctrl\+/,'Control+')).join(' '));
      else node.removeAttribute('aria-keyshortcuts');
      if (buttons.get(name) === node)
        node.title = node.getAttribute('aria-label') + (visible.length ? '（' + visible.join(' / ') + '）' : '');
    }
  }
  updateShortcutLabels();
  for (const [name,button] of buttons) {
    if (actions[name]) button.addEventListener('click',actions[name]);
  }
  browseAssetsButton?.addEventListener('click',() => {
    if (!tab.snapshot || !onBrowseAssets) return;
    if (tab.selection.size <= 1) { void applyAction('locate-asset',tab.selected,tab.snapshot); return; }
    const path = getCurrentDirectory();
    const selectedPaths = getSelectedEntries().filter(entry => !entry.isDirectory).map(entry => entry.path);
    const selectedPath = tab.selected?.isDirectory ? null : tab.selected?.path || null;
    if (path && selectedPaths.length)
      void performFileAction(() => onBrowseAssets({path,isDirectory:true,selectedPath,selectedPaths}),path);
  });
  openAssetPaneButton?.addEventListener('click',() => onOpenAssetPane?.());
  favoriteAssetButton?.addEventListener('click',() => void toggleAssetFavorite(getSelectedEntry()));
  collectAssetsButton?.addEventListener('click',() => {
    if (tab.snapshot) void applyAction('add-to-collection',null,tab.snapshot);
  });
  loadAssetsButton?.addEventListener('click',() => {
    const menu = loadAssetsButton.closest('details');
    if (menu) menu.open = false;
    void loadAssetDetails();
  });
  owner.addEventListener('visibilitychange',beginFrequentVisit);
  owner.defaultView.addEventListener('focus',beginFrequentVisit);
  owner.defaultView.addEventListener('blur',cancelFrequentVisit);
  addTabButton.addEventListener('click',() => {
    onOpenFiles?.();
    void addTab();
  });
  tabsHost.addEventListener('wheel',event => {
    if (!prefs.wheelSwitchTabs || !isActive() || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const direction = Math.sign(event.deltaY || event.deltaX);
    if (!direction) return;
    const next = tabs[tabs.indexOf(tab) + direction];
    if (!next) return;
    event.preventDefault();
    if (event.timeStamp - lastTabWheelTime < 150) return;
    lastTabWheelTime = event.timeStamp;
    void activateTab(next);
  },{passive:false});
  pinButton.addEventListener('click',() => togglePin(tabPath(tab)));
  for (const host of [pinRail,placesHost]) host?.addEventListener('contextmenu',event => {
    const anchor = event.target.closest('[data-explorer-pin-path]');
    if (!anchor && host !== pinRail) return;
    event.preventDefault();
    event.stopPropagation();
    if (anchor) void showPinMenu(anchor,{x:event.clientX,y:event.clientY});
  });
  for (const button of viewButtons) button.addEventListener('click',() => {
    setView(button.dataset.explorerView,button.dataset.explorerIconSize);
    const menu = button.closest('#file-workspace-view-menu');
    if (menu) {
      menu.open = false;
      menu.querySelector('summary')?.focus({preventScroll:true});
    }
  });

  form.addEventListener('submit',event => {
    event.preventDefault();
    addressCompletion.clear();
    const item = tab;
    const input = address.value;
    const path = cleanAddressText(input);
    if (path === null) { report(tab,'地址栏一次接收一个完整路径。',true); return; }
    void navigate(path === '此电脑' ? '' : path === '网络' ? networkLocation : path,{query:'',focusList:true,clearCatalog:true})
      .then(opened => {
        if (opened && tab === item && address.value === input) address.value = addressText(tabPath(item));
      });
  });
  address.addEventListener('paste',event => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    const path = cleanAddressText(text);
    if (path === text) return;
    event.preventDefault();
    if (path === null) { report(tab,'地址栏一次接收一个完整路径。',true); return; }
    const start = address.selectionStart ?? address.value.length;
    const end = address.selectionEnd ?? start;
    address.setRangeText(path.slice(0,Math.max(0,address.maxLength - (address.value.length - end + start))),start,end,'end');
    address.dispatchEvent(new Event('input',{bubbles:true}));
  });
  address.addEventListener('keydown',event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    addressCompletion.clear();
    address.value = addressText(tabPath(tab));
    address.blur();
    locationParts.at(-1)?.location.focus({preventScroll:true});
  });
  panel.querySelector('[data-explorer-skip-content]')?.addEventListener('click',event => {
    event.preventDefault();
    focusContent();
  });
  recoveryButton?.addEventListener('click',() => {
    if (tab.recovery?.parent && !tab.request && !tab.fileAction) void navigate(tab.recovery.parent,{focusList:true,clearCatalog:true});
  });
  function submitSearch(query,scopeChanged = false) {
    clearTimeout(searchTimer);
    const path = tabPath(tab);
    const previousCatalog = tab.catalogQuery;
    tab.catalogQuery = tab.searchScope === 'folder' ? '' : query;
    if (catalogOnly() && tab.selection.size) selectEntry(null);
    if (scopeChanged || previousCatalog !== tab.catalogQuery) updateView();
    const directoryQuery = tab.searchScope === 'library' ? '' : query;
    if (tab.searchScope === 'library' && !tab.query && !tab.request?.query) return;
    if (!tab.request && tab.snapshot?.offset === 0 && directoryQuery === tab.query && !tab.stalePaths.has(pathKey(path))) return;
    void navigate(path,{index:tab.index,offset:0,query:directoryQuery});
  }
  searchScope?.addEventListener('change',() => {
    if (!searchAssets || !searchScopes.includes(searchScope.value)) return;
    const query = search.value.trim();
    tab.searchScope = searchScope.value;
    submitSearch(query,true);
  });
  let composingSearch = false;
  function queueSearch() {
    clearTimeout(searchTimer);
    const current = tab;
    const query = search.value.trim();
    searchTimer = setTimeout(() => {
      if (tab === current) submitSearch(query);
    },180);
  }
  search.addEventListener('compositionstart',() => {
    composingSearch = true;
    clearTimeout(searchTimer);
  });
  search.addEventListener('compositionend',() => { composingSearch = false; queueSearch(); });
  search.addEventListener('input',event => {
    if (!event.isComposing && !composingSearch) queueSearch();
  });
  search.addEventListener('keydown',event => {
    if (event.isComposing || composingSearch || event.keyCode === 229 || event.key !== 'Enter') return;
    event.preventDefault();
    submitSearch(search.value.trim());
    catalogSearch.retry();
  });
  scroller.addEventListener('scroll',() => {
    tab.scrollTop = scroller.scrollTop;
    if (marqueeGesture?.active) queueMarqueeFrame();
  },{passive:true});
  scroller.addEventListener('wheel',event => {
    if (!event.ctrlKey || !isActive()) { wheelDelta = 0; return; }
    if (catalogOnly() || catalogPane?.contains(event.target)) return;
    event.preventDefault();
    if (!tab.snapshot || !event.deltaY) return;
    const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 100 : 1;
    const delta = event.deltaY * unit;
    if (event.timeStamp - lastWheelTime > 180 || Math.sign(wheelDelta) !== Math.sign(delta)) wheelDelta = 0;
    lastWheelTime = event.timeStamp;
    wheelDelta += delta;
    if (Math.abs(wheelDelta) < 60) return;
    zoomView(-Math.sign(wheelDelta),event.target,event.clientY);
    wheelDelta = 0;
  },{passive:false});

  function clickedEntry(target) {
    const row = target.closest('[data-entry-index]');
    return row ? tab.snapshot?.entries[Number(row.dataset.entryIndex)] : undefined;
  }

  function marqueeViewport() {
    const bounds = scroller.getBoundingClientRect();
    const left = bounds.left + scroller.clientLeft;
    const scrollTop = bounds.top + scroller.clientTop;
    const right = left + scroller.clientWidth;
    const bottom = scrollTop + scroller.clientHeight;
    const header = !table.hidden && tab.view === 'details' && table.tHead?.rows[0]?.cells[0]?.getBoundingClientRect();
    const top = Math.min(bottom,Math.max(scrollTop,header?.bottom || scrollTop));
    return {left,top,right,bottom,scrollTop};
  }

  function marqueeEdgeScroll(position,start,end) {
    const edge = Math.min(28,(end - start) / 4);
    if (position < start + edge) return -Math.min(26,Math.ceil((start + edge - position) / 2));
    if (position > end - edge) return Math.min(26,Math.ceil((position - end + edge) / 2));
    return 0;
  }

  function drawMarquee(gesture,scroll) {
    const area = marqueeViewport();
    const beforeX = scroller.scrollLeft;
    const beforeY = scroller.scrollTop;
    if (scroll) {
      scroller.scrollLeft += marqueeEdgeScroll(gesture.x,area.left,area.right);
      scroller.scrollTop += marqueeEdgeScroll(gesture.y,area.top,area.bottom);
    }
    const anchorX = area.left + gesture.originX - scroller.scrollLeft;
    const anchorY = area.scrollTop + gesture.originY - scroller.scrollTop;
    const x = Math.min(area.right,Math.max(area.left,gesture.x));
    const y = Math.min(area.bottom,Math.max(area.top,gesture.y));
    const rectangle = {left:Math.min(x,anchorX),top:Math.min(y,anchorY),right:Math.max(x,anchorX),bottom:Math.max(y,anchorY)};
    const selected = gesture.mode === 'replace' ? new Map() : new Map(gesture.before);
    let files = 0;
    let folders = 0;
    for (const item of entryHost().querySelectorAll('[data-entry-index]:not([hidden])')) {
      const bounds = item.getBoundingClientRect();
      if (!bounds.width || !bounds.height || rectangle.left >= bounds.right || rectangle.right <= bounds.left ||
          rectangle.top >= bounds.bottom || rectangle.bottom <= bounds.top) continue;
      const entry = gesture.snapshot.entries[Number(item.dataset.entryIndex)];
      if (!entry) continue;
      if (entry.isDirectory) folders++;
      else files++;
      const key = pathKey(entry.path);
      if (gesture.mode === 'toggle' && gesture.before.has(key)) selected.delete(key);
      else selected.set(key,entry);
    }
    const left = Math.max(area.left,rectangle.left);
    const top = Math.max(area.top,rectangle.top);
    marquee.style.left = left + 'px';
    marquee.style.top = top + 'px';
    marquee.style.width = Math.max(0,Math.min(area.right,rectangle.right) - left) + 'px';
    marquee.style.height = Math.max(0,Math.min(area.bottom,rectangle.bottom) - top) + 'px';
    const summary = displayNumber.format(files) + ' 个文件 · ' + displayNumber.format(folders) + ' 个文件夹';
    if (marqueeCount.textContent !== summary) marqueeCount.textContent = summary;
    marqueeCount.hidden = false;
    marqueeCount.style.left = Math.max(area.left + 4,Math.min(x + 12,area.right - marqueeCount.offsetWidth - 4)) + 'px';
    marqueeCount.style.top = Math.max(area.top + 4,Math.min(y + 15,area.bottom - marqueeCount.offsetHeight - 4)) + 'px';
    if (selected.size !== tab.selection.size || [...selected.keys()].some(key => !tab.selection.has(key))) {
      tab.selection = selected;
      tab.selected = selected.get(pathKey(gesture.lead?.path)) || selected.values().next().value || null;
      tab.selectionAnchor = tab.selected ? pathKey(tab.selected.path) : null;
      tab.selectionRevision++;
      drawSelection();
    }
    return scroller.scrollLeft !== beforeX || scroller.scrollTop !== beforeY;
  }

  function marqueeIsCurrent(gesture) {
    return isActive() && tab === gesture.item && tab.snapshot === gesture.snapshot && !tab.request && !tab.fileAction;
  }

  function queueMarqueeFrame() {
    if (marqueeFrame) return;
    marqueeFrame = owner.defaultView.requestAnimationFrame(() => {
      marqueeFrame = 0;
      const gesture = marqueeGesture;
      if (!gesture?.active) return;
      if (!marqueeIsCurrent(gesture)) finishMarquee(true);
      else if (drawMarquee(gesture,true)) queueMarqueeFrame();
    });
  }

  function finishMarquee(restore) {
    const gesture = marqueeGesture;
    if (!gesture) return;
    marqueeGesture = null;
    owner.defaultView.cancelAnimationFrame(marqueeFrame);
    marqueeFrame = 0;
    if (!gesture.active) return;
    suppressMarqueeClick = true;
    marquee.hidden = true;
    marqueeCount.hidden = true;
    count.setAttribute('aria-live','polite');
    if (!restore) marqueeAnnouncement.textContent = '已选 ' + displayNumber.format(tab.selection.size) + ' 个项目';
    scroller.removeAttribute('data-explorer-marquee-selecting');
    if (scroller.hasPointerCapture(gesture.pointer)) scroller.releasePointerCapture(gesture.pointer);
    if (restore && tab === gesture.item && tab.snapshot === gesture.snapshot) {
      tab.selection = gesture.before;
      tab.selected = gesture.lead;
      tab.selectionAnchor = gesture.anchor;
      tab.selectionRevision++;
      drawSelection();
    }
  }

  scroller.addEventListener('pointerdown',event => {
    suppressMarqueeClick = false;
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch' || event.altKey || catalogOnly() ||
        catalogPane?.contains(event.target) ||
        marqueeGesture || !isActive() || !tab.snapshot || tab.request || tab.fileAction || menuOpen ||
        owner.querySelector('dialog[open]') || event.target.closest('thead,tr,[data-entry-index],button,a,input,textarea,select')) return;
    const area = marqueeViewport();
    const {clientX:x,clientY:y} = event;
    if (x < area.left || x >= area.right || y < area.top || y >= area.bottom) return;
    marqueeGesture = {pointer:event.pointerId,item:tab,snapshot:tab.snapshot,x,y,startX:x,startY:y,
      originX:x - area.left + scroller.scrollLeft,originY:y - area.scrollTop + scroller.scrollTop,
      before:new Map(tab.selection),lead:tab.selected,anchor:tab.selectionAnchor,
      mode:event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace',active:false};
  });
  owner.defaultView.addEventListener('pointermove',event => {
    const gesture = marqueeGesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (!(event.buttons & 1) || !marqueeIsCurrent(gesture)) { finishMarquee(true); return; }
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.startX,event.clientY - gesture.startY) < 5) return;
      gesture.active = true;
      tab.selectionRevision++;
      scroller.setAttribute('data-explorer-marquee-selecting','');
      count.setAttribute('aria-live','off');
      marqueeAnnouncement.textContent = '';
      marquee.hidden = false;
      scroller.focus({preventScroll:true});
      try { scroller.setPointerCapture(gesture.pointer); } catch {}
    }
    event.preventDefault();
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    queueMarqueeFrame();
  },{passive:false});
  owner.defaultView.addEventListener('pointerup',event => {
    const gesture = marqueeGesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (gesture.active && marqueeIsCurrent(gesture)) {
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      drawMarquee(gesture,false);
      event.preventDefault();
      finishMarquee(false);
    } else finishMarquee(true);
  });
  owner.defaultView.addEventListener('pointercancel',event => {
    if (marqueeGesture?.pointer === event.pointerId) finishMarquee(true);
  });
  scroller.addEventListener('lostpointercapture',event => {
    if (marqueeGesture?.pointer === event.pointerId) finishMarquee(true);
  });
  owner.defaultView.addEventListener('blur',() => finishMarquee(true));

  function getDropTarget(hit) {
    if (!isActive() || !hit || !(panel.contains(hit) || navigation.contains(hit)) ||
        hit.closest('.local-explorer-tab-close')) return null;
    const inListing = scroller.contains(hit);
    if (inListing && (catalogOnly() || catalogPane?.contains(hit))) return null;
    const zone = inListing ? scroller : hit.closest('.local-explorer-file-actions');
    if (zone && tab.request && pathKey(tab.request.destination) !== pathKey(tabPath(tab))) return null;
    const target = hit.closest('[data-explorer-drop-path]');
    if (target) return {path:target.dataset.explorerDropPath,label:target.dataset.explorerDropLabel,element:target};
    const path = tab.snapshot?.directory;
    return zone && path && !isDriveView(tab.snapshot) ? {path,label:nameForPath(path),element:zone} : null;
  }

  function useAlternateMenu(event) {
    return Boolean(prefs.altClickMenu && contextMenu && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
      scroller.contains(event.target) && !catalogOnly() && !catalogPane?.contains(event.target));
  }

  function getSidebarPinTarget(hit) {
    if (!isActive() || sidebar?.hidden || !hit) return null;
    const target = hit.closest('.local-explorer-sidebar-personal');
    return placesHost.contains(target) ? target : null;
  }

  function getFolderTabsDropTarget(hit) {
    if (!isActive() || !hit || !navigation.contains(hit) || hit.closest('[data-explorer-tab-id]')) return null;
    return hit.closest('[data-window-drag], #workspace-new-tab-controls, [data-explorer-add-tab]') ||
      (hit === tabsHost ? tabsHost : null);
  }

  async function classifyDroppedFolders(paths) {
    if (!entryDetails) return [];
    const candidates = [...new Set(paths.filter(path => typeof path === 'string' && path))];
    const folders = [];
    for (let offset = 0; offset < candidates.length; offset += 50) {
      if (!isActive()) return [];
      const batch = candidates.slice(offset,offset + 50);
      const details = await entryDetails({paths:batch,columns:['isDirectory']});
      const verified = new Set(details.filter(result => result?.values?.isDirectory === 'yes').map(result => result.path));
      folders.push(...batch.filter(path => verified.has(path)).map(path => ({path,isDirectory:true})));
    }
    return folders;
  }

  function openDroppedFolderTabs(entries) {
    if (!isActive()) return {opened:0,remaining:0};
    const seen = new Set(tabs.map(item => treePathKey(tabPath(item))));
    const opened = [];
    let remaining = 0;
    for (const {path,isDirectory} of entries) {
      const key = treePathKey(path);
      if (!isDirectory || !key || seen.has(key)) continue;
      seen.add(key);
      if (tabs.length >= tabLimit) { remaining++; continue; }
      const item = createTab();
      item.initialPath = path;
      item.sessionPath = path;
      tabs.push(item);
      opened.push(item);
    }
    if (opened.length) void activateTab(opened[0],true);
    return {opened:opened.length,remaining};
  }

  function openBatchPaths() {
    if (!checkFolderPaths) return false;
    return showExplorerBatchTabs({
      panel,active:isActive,probe:checkFolderPaths,key:treePathKey,
      tabs:() => ({capacity:tabLimit - tabs.length,paths:new Set(tabs.map(item => treePathKey(tabPath(item))))}),
      open:paths => openDroppedFolderTabs(paths.map(path => ({path,isDirectory:true}))),
    });
  }

  function expandDropFolder(hit) {
    const row = hit?.closest('.local-explorer-tree-row');
    if (!row || !sidebarSystem.contains(row)) return false;
    const toggle = row.querySelector('[data-tree-control="toggle"]');
    if (!toggle || toggle.disabled || toggle.getAttribute('aria-expanded') === 'true') return false;
    temporaryTreeBranches.add(toggle.dataset.treeKey);
    renderSystemTree();
    return true;
  }

  function clearDropFolders() {
    if (!temporaryTreeBranches.size) return;
    temporaryTreeBranches.clear();
    if (isActive()) renderSystemTree();
  }

  function getVolumeLabel(path) {
    const segments = pathLocations(path);
    const unc = treePathKey(path).startsWith('\\\\');
    const rootPath = segments[unc ? 2 : 1]?.path;
    return rootPath ? nameForPath(rootPath) : '';
  }

  function getDragSource(hit) {
    if (!isActive() || !hit || table.hidden || !tbody.contains(hit) || tab.request ||
        hit.closest('[data-explorer-row-asset]')) return null;
    const entry = clickedEntry(hit);
    if (!entry) return null;
    const entries = (tab.selection.has(pathKey(entry.path)) ? [...tab.selection.values()] : [entry])
      .map(({path,name,isDirectory,size}) => ({path,name,isDirectory,size}));
    return {path:entry.path,label:entry.name,element:hit.closest('[data-entry-index]'),isDirectory:entry.isDirectory,
      entries,paths:entries.map(item => item.path)};
  }

  scroller.addEventListener('click',event => {
    if (catalogOnly() || catalogPane?.contains(event.target)) return;
    if (suppressMarqueeClick && event.detail > 0) { event.preventDefault(); return; }
    if (event.target.closest('thead')) return;
    const sequence = event.target.closest('[data-explorer-sequence-toggle]');
    if (sequence) {
      if (event.detail < 2) toggleSequence(sequence);
      return;
    }
    if (event.target.closest('.local-explorer-sequence-stack')) return;
    const assetAction = event.target.closest('[data-explorer-row-asset]');
    if (assetAction) {
      const entry = clickedEntry(assetAction);
      if (!isActive() || !entry || tab.request || tab.fileAction || assetAction.getAttribute('aria-disabled') === 'true' ||
          !assetDetails.get(entry.path)) return;
      if (assetAction.dataset.explorerRowAsset === 'details') {
        if (getSelectedEntry() !== entry) selectEntry(entry);
        onOpenAssetDetails?.();
      } else if (assetAction.dataset.explorerRowAsset === 'favorite') void toggleAssetFavorite(entry);
      return;
    }
    const group = event.target.closest('[data-explorer-group-toggle]');
    if (group) {
      showDateGroup(group.dataset.explorerGroupToggle,group.getAttribute('aria-expanded') === 'false');
      return;
    }
    const entry = clickedEntry(event.target);
    if (useAlternateMenu(event)) {
      event.preventDefault();
      if (entry) itemButton(event.target.closest('[data-entry-index]'))?.focus({preventScroll:true});
      void showContextMenu(entry,{x:event.clientX,y:event.clientY});
      return;
    }
    const toggle = event.ctrlKey || event.metaKey;
    selectEntry(entry,{toggle,range:event.shiftKey});
    if (entry && !toggle && !event.shiftKey &&
        (event.detail > 0 && prefs.openMode === 'single' || event.detail === 0 && event.target.closest('button')))
      openEntry(entry);
  });
  scroller.addEventListener('dblclick',event => {
    if (catalogOnly() || catalogPane?.contains(event.target) || event.target.closest('[data-explorer-row-asset]')) return;
    if (suppressMarqueeClick || event.altKey || event.metaKey || event.shiftKey || tab.request || tab.fileAction) return;
    const entry = clickedEntry(event.target);
    if (event.ctrlKey) {
      if (prefs.ctrlDoubleClickTab && entry?.isDirectory) void addTab(entry.path,{afterCurrent:true});
      return;
    }
    if (entry) {
      if (prefs.openMode !== 'single') openEntry(entry);
      return;
    }
    if (prefs.doubleClickUp && getCurrentDirectory() &&
        !event.target.closest('thead,tr,button,a,input,select,textarea,[contenteditable="true"]')) void actions.up();
  });
  if (contextMenu) scroller.addEventListener('contextmenu',event => {
    event.preventDefault();
    event.stopPropagation();
    if (catalogOnly() || catalogPane?.contains(event.target) ||
        event.target.closest('.local-explorer-sequence-stack')) return;
    const position = {x:event.clientX,y:event.clientY};
    const group = event.target.closest('[data-explorer-group-toggle]');
    if (group) {
      group.focus({preventScroll:true});
      void showGroupNamesMenu(group.dataset.explorerGroupToggle,position);
    } else void showContextMenu(clickedEntry(event.target),position);
  });

  let typeahead;
  scroller.addEventListener('keydown',event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.defaultPrevented || !tab.snapshot) return;
    const row = event.target.closest('[data-entry-index]');
    if ((row || event.target === scroller) && !catalogOnly() && !tab.request && !tab.fileAction && !menuOpen &&
        !event.target.closest('input,textarea,select,[contenteditable="true"]') &&
        [...event.key].length === 1 && event.key.trim()) {
      const continuing = typeahead?.item === tab && typeahead.snapshot === tab.snapshot &&
        event.timeStamp - typeahead.time < 750;
      const prefix = ((continuing ? typeahead.prefix : '') + event.key).normalize('NFC').toLocaleLowerCase();
      typeahead = {item:tab,snapshot:tab.snapshot,prefix,time:event.timeStamp};
      const rows = [...entryHost().querySelectorAll('[data-entry-index]:not([hidden])')];
      const current = rows.indexOf(row);
      const start = Math.max(0,current + (continuing ? 0 : 1));
      for (let offset = 0; offset < rows.length; offset++) {
        const candidate = rows[(start + offset) % rows.length];
        const entry = tab.snapshot.entries[Number(candidate.dataset.entryIndex)];
        if (!(isDriveView(tab.snapshot) ? entry.name : displayEntryName(entry)).normalize('NFC').toLocaleLowerCase().startsWith(prefix)) continue;
        selectEntry(entry);
        itemButton(candidate).focus({preventScroll:true});
        candidate.scrollIntoView({block:'nearest',inline:'nearest'});
        break;
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
    typeahead = null;
    if (!row) return;
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const adjacent = direction > 0 ? 'nextElementSibling' : 'previousElementSibling';
    let next = isDriveView(tab.snapshot) ? entryItem(Number(row.dataset.entryIndex) + direction) : row[adjacent];
    while (next && !next.matches('[data-entry-index]:not([hidden])')) next = next[adjacent];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    selectEntry(tab.snapshot.entries[Number(next.dataset.entryIndex)],{range:event.shiftKey});
    itemButton(next).focus();
  });
  owner.addEventListener('keydown',event => {
    if (event.key === 'Escape' && marqueeGesture) {
      event.preventDefault();
      event.stopPropagation();
      finishMarquee(true);
      return;
    }
    if (!isActive() || event.defaultPrevented || event.isComposing || menuOpen || owner.querySelector('dialog[open]')) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
      if (commandSearch.show()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && ['F6','F8'].includes(event.key) && cycleFocus(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target.closest?.('.nexus-asset-tabs, #workspace-tab-add')) return;
    const key = event.key.toLowerCase();
    const modified = event.ctrlKey || event.metaKey;
    const editing = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
    const current = tab.snapshot;
    const sequence = event.target.closest?.('[data-explorer-sequence-toggle]');
    const focused = scroller.contains(event.target) ? clickedEntry(event.target) : undefined;
    const selected = focused || (sequence ? null : tab.selected);
    const multiple = tab.selection.size > 1;
    const physical = current && !isDriveView(current) && current.directory;
    const assetSearchResult = catalogOnly() || catalogPane?.contains(event.target);
    const space = key === ' ' || key === 'spacebar';
    if (!assetSearchResult && !editing && !event.altKey && space && (focused || event.target === scroller) &&
        !event.target.closest?.('[data-explorer-row-asset]')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || tab.request || tab.fileAction) return;
      if (focused && (modified || event.shiftKey || !prefs.quickPreview || tab.selection.size > 1)) {
        selectEntry(focused,{toggle:modified || !event.shiftKey,range:event.shiftKey});
        return;
      }
      const entry = getSelectedEntry();
      if (prefs.quickPreview && entry && physical && !modified && !event.shiftKey)
        onQuickPreview?.(entry);
      return;
    }
    if (!assetSearchResult && !editing && contextMenu && (key === 'contextmenu' || key === 'f10' && event.shiftKey)) {
      if (sequence || event.target.closest?.('[data-explorer-tab-id]')) return;
      event.preventDefault();
      event.stopPropagation();
      const pin = event.target.closest('[data-explorer-pin-path]');
      const group = event.target.closest('[data-explorer-group-toggle]');
      if (pin) void showPinMenu(pin);
      else if (group) void showGroupNamesMenu(group.dataset.explorerGroupToggle);
      else if (!columnLayout?.openHeaderMenu(event.target)) void showContextMenu(selected);
      return;
    }
    const binding = explorerShortcutAction(event,prefs.shortcutBindings);
    if (binding) {
      event.preventDefault();
      event.stopPropagation();
      if (binding === 'address') focusAddress();
      else if (binding === 'search') search.focus();
      else if (!buttons.get(binding)?.disabled) void actions[binding]();
      return;
    }
    let shortcut = modified && !(event.shiftKey && key === 't') && ({t:addTab,w:() => closeTab(tab)})[key];
    if (!shortcut && !assetSearchResult && !editing && !event.repeat && current && !tab.request && !tab.fileAction) {
      if (modified && !event.altKey && !event.shiftKey && key === 'a') {
        shortcut = selectAll;
      } else if (modified && event.shiftKey && !event.altKey && key === 'c' && !sequence && (tab.selected || physical) &&
          owner.getSelection()?.isCollapsed) {
        shortcut = () => applyAction('copy-path',tab.selected,current);
      } else if (event.altKey && key === 'enter' && !multiple && fileAction && (selected || physical)) {
        shortcut = () => applyAction('properties',selected,current);
      } else if (physical && fileAction && modified && event.shiftKey && key === 'n') {
        shortcut = () => applyAction('new-folder',null,current);
      } else if (physical && fileAction && selected && !modified && !event.altKey && (key === 'f2' || key === 'delete' && !multiple)) {
        shortcut = () => applyAction(key === 'f2' ? (multiple ? 'batch-rename' : 'rename') : 'trash',selected,current);
      } else if (physical && clipboard && modified && !event.shiftKey && ['c','x','v'].includes(key) &&
          (selected || key === 'v')) {
        shortcut = () => applyAction({c:'copy',x:'cut',v:'paste'}[key],key === 'v' ? null : selected,current);
      }
    }
    if (shortcut) {
      event.preventDefault();
      event.stopPropagation();
      void shortcut();
    }
  },{capture:true});

  panel.hidden = listing.hidden = false;
  updateNavigationPreference();
  updateChromePreferences();
  render();
  function clearRecentFolders() {
    frequentClearRevision++;
    cancelFrequentVisit();
    frequent.clear();
    renderLinks();
  }

  return {refresh,focusAddress,exit,openPath,openShellPath,revealSource,revealSources,restoreDetachedTab,show,addTab,getTabCount,getCurrentDirectory,getDirectorySearch,getFileActionDirectory,getSelectedPath,getSelectedEntry,getSelectedEntries,applyPreferences,
    getTabIdentity,showTabIdentity,hasTabIdentity:(identity,path) => Boolean(tabWithIdentity(identity,path)),
    canDuplicateActive,duplicateActive,refreshAssetDetails,
    findManagedTab,setTabPinned,canCloseOtherTabs,closeOtherTabs,closeManagedTab,restoreClosedTab,hasClosedTabs,openBatchPaths,
    getDropTarget,getSidebarPinTarget,getFolderTabsDropTarget,classifyDroppedFolders,openDroppedFolderTabs,
    expandDropFolder,clearDropFolders,getVolumeLabel,getDragSource,useAlternateMenu,
    refreshAfterTransfer,pinFolders,pinSidebarFolders,clearRecentFolders};
}
