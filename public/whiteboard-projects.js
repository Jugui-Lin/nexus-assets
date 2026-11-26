import {initWhiteboard} from './whiteboard.js';
import {listWhiteboardImageCache, readWhiteboardImageCache, clearSyncedWhiteboardImageCache} from './whiteboard-images.js';

const directoryKey = 'nexus-whiteboard-projects-v1:';
const fileFolderKey = 'nexus-whiteboard-file-folder-v1:';
const cacheLabel = '白板缓存';
const defaultProject = {id:'default', name:'默认项目'};
const projectLimit = 100;
const nameLimit = 80;
const projectIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const cacheNumber = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2});
const cachePageSize = 20;
const cacheCopyBytes = 16 * 1024 * 1024;
const imageExtensions = new Map([
  ['image/png','png'],['image/jpeg','jpg'],['image/webp','webp'],['image/gif','gif'],
  ['image/avif','avif'],['image/bmp','bmp'],['image/svg+xml','svg'],
]);

function formatCacheSize(bytes) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return cacheNumber.format(bytes) + ' ' + units[unit];
}

function cleanProjects(source) {
  const projects = new Map([[defaultProject.id, defaultProject]]);
  for (const project of source.slice(0, projectLimit)) {
    if (typeof project?.id === 'string' && projectIdPattern.test(project.id) &&
        typeof project.name === 'string' && project.name.trim()) {
      projects.set(project.id, {id:project.id, name:project.name.trim()});
    }
  }
  return [...projects.values()].slice(0, projectLimit);
}

function readProjects(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(directoryKey + key));
    if (Array.isArray(saved)) return cleanProjects(saved);
  } catch {}
  return [defaultProject];
}

function syncError(error) {
  const message = String(error?.message || error || '');
  return /^团队服务返回错误 (404|405|501)\b/.test(message)
    ? '更新团队服务后可使用白板项目。'
    : '暂时无法同步项目列表。';
}

function readFileFolder(teamId) {
  let saved;
  try {
    if (teamId) saved = JSON.parse(localStorage.getItem(fileFolderKey + teamId));
  } catch {}
  return typeof saved?.libraryId === 'string' && saved.libraryId && typeof saved.folder === 'string'
    ? {libraryId:saved.libraryId, folder:saved.folder} : null;
}

function hasFileFolder(libraries, {libraryId, folder}) {
  return libraries.some(library => library.id === libraryId && (folder === '' || library.folders.includes(folder)));
}

export function initWhiteboardProjects({panel, api, notify = () => {}, resolveAssetImage, openLink, locateAsset,
  loadPresenceAvatar, getFileFolders, importPastedFiles, revealPastedFile, loadFilePreview, handleDroppedFiles, copyCachedImages}) {
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  panel.innerHTML = `<section class="whiteboard-project-home" aria-labelledby="whiteboard-project-heading">
    <header class="whiteboard-project-bar">
      <div class="whiteboard-project-heading"><h2 id="whiteboard-project-heading">白板项目</h2><p>双击项目打开画布</p></div>
      <div class="whiteboard-project-actions">
        <button type="button" class="button subtle" data-project-cache aria-haspopup="dialog" aria-controls="whiteboard-cache-dialog" hidden>${icon('stack')}${cacheLabel}</button>
        <button type="button" class="button primary" data-project-create>${icon('plus')}新建项目</button>
      </div>
    </header>
    <div class="whiteboard-project-status" hidden>
      <span role="status"></span>
      <button type="button" class="text-button" data-project-retry hidden>重试</button>
    </div>
    <ul class="whiteboard-project-grid" aria-label="白板项目"></ul>
  </section>
  <section class="whiteboard-project-editor hidden" aria-labelledby="whiteboard-project-name">
    <header class="whiteboard-project-bar whiteboard-project-editor-bar">
      <button type="button" class="button subtle" data-project-back>${icon('arrow')}返回项目</button>
      <h2 id="whiteboard-project-name"></h2>
      <div class="whiteboard-project-actions whiteboard-project-editor-actions">
        <button type="button" class="button subtle" data-project-cache aria-haspopup="dialog" aria-controls="whiteboard-cache-dialog" hidden>${icon('stack')}${cacheLabel}</button>
      </div>
    </header>
    <div class="whiteboard-project-canvas"></div>
  </section>`;
  const $ = selector => panel.querySelector(selector);
  const home = $('.whiteboard-project-home');
  const editor = $('.whiteboard-project-editor');
  const editorName = $('#whiteboard-project-name');
  const canvas = $('.whiteboard-project-canvas');
  const grid = $('.whiteboard-project-grid');
  const create = $('[data-project-create]');
  const back = $('[data-project-back]');
  const retry = $('[data-project-retry]');
  const status = $('.whiteboard-project-status');
  const statusText = status.querySelector('span');
  const board = initWhiteboard({panel:canvas, api, notify, resolveAssetImage, openLink, locateAsset,
    loadPresenceAvatar, importPastedFiles, revealPastedFile, loadFilePreview, handleDroppedFiles});

  const dialog = document.createElement('dialog');
  dialog.className = 'modal whiteboard-project-dialog';
  dialog.setAttribute('aria-labelledby', 'whiteboard-project-dialog-title');
  dialog.innerHTML = `<form>
    <header class="modal-header">
      <h2 id="whiteboard-project-dialog-title"></h2>
      <button type="button" class="icon-button" aria-label="关闭" data-project-cancel>${icon('close')}</button>
    </header>
    <label class="field-label" for="whiteboard-project-field">项目名称</label>
    <input class="text-field" id="whiteboard-project-field" maxlength="${nameLimit * 2}" required>
    <p class="whiteboard-project-error" role="alert" hidden></p>
    <footer class="modal-footer">
      <button type="button" class="button subtle" data-project-cancel>取消</button>
      <button type="submit" class="button primary" data-project-save>保存</button>
    </footer>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const nameInput = dialog.querySelector('input');
  const save = dialog.querySelector('[data-project-save]');
  const formError = dialog.querySelector('[role="alert"]');

  const cacheDialog = document.createElement('dialog');
  cacheDialog.id = 'whiteboard-cache-dialog';
  cacheDialog.className = 'modal whiteboard-project-dialog';
  cacheDialog.setAttribute('aria-labelledby','whiteboard-cache-heading');
  cacheDialog.setAttribute('aria-describedby','whiteboard-cache-description');
  cacheDialog.innerHTML = `<form method="dialog">
    <header class="modal-header">
      <h2 id="whiteboard-cache-heading">${cacheLabel}</h2>
      <button type="button" class="icon-button" aria-label="关闭" data-cache-close>${icon('close')}</button>
    </header>
    <div class="whiteboard-cache-caption">
      <p id="whiteboard-cache-description" class="whiteboard-cache-description">统计当前团队缓存在这台电脑上的白板内嵌图片。</p>
      <button type="button" class="button subtle" data-cache-refresh>${icon('refresh')}刷新</button>
    </div>
    <dl class="whiteboard-cache-metrics">
      <div><dt>本机缓存占用</dt><dd data-cache-bytes>—</dd></div>
      <div><dt>缓存图片</dt><dd data-cache-images>—</dd></div>
    </dl>
    <p class="whiteboard-cache-status" role="status" hidden></p>
    <section class="whiteboard-cache-destination" aria-labelledby="whiteboard-file-folder-heading">
      <h3 id="whiteboard-file-folder-heading">白板文件存放</h3>
      <p class="whiteboard-cache-description">复制到团队资产库的白板文件会存放在这里。</p>
      <label class="field-label" for="whiteboard-file-library">团队资产库</label>
      <select class="text-field" id="whiteboard-file-library"></select>
      <label class="field-label" for="whiteboard-file-folder">文件夹</label>
      <select class="text-field" id="whiteboard-file-folder"></select>
      <p class="whiteboard-cache-status" role="status" data-file-folder-status hidden></p>
      <button type="submit" class="button subtle" data-file-folder-save>保存位置</button>
    </section>
    <section class="whiteboard-cache-destination" aria-labelledby="whiteboard-cache-images-heading">
      <h3 id="whiteboard-cache-images-heading">缓存图片</h3>
      <ul class="whiteboard-cache-list" aria-label="缓存图片" data-cache-list hidden></ul>
      <div class="whiteboard-cache-pages" data-cache-pages hidden>
        <button type="button" class="button subtle" data-cache-prev>上一页</button>
        <span data-cache-page></span>
        <button type="button" class="button subtle" data-cache-next>下一页</button>
      </div>
      <figure class="whiteboard-cache-preview" hidden><img alt="缓存图片预览"></figure>
      <div class="whiteboard-cache-actions">
        <span data-cache-count>已选 0 张</span>
        <button type="button" class="button subtle" data-cache-copy>复制到资产库</button>
        <button type="button" class="button subtle" data-cache-clear>清除本机缓存</button>
      </div>
      <div class="whiteboard-cache-confirm" data-cache-confirm hidden>
        <p data-cache-confirm-text></p>
        <button type="button" class="button subtle" data-cache-clear-cancel>取消</button>
        <button type="button" class="button primary" data-cache-clear-confirm>确认清除</button>
      </div>
      <p class="whiteboard-cache-status" role="status" data-cache-action-status hidden></p>
    </section>
    <footer class="modal-footer">
      <button type="button" class="button primary" data-cache-close>完成</button>
    </footer>
  </form>`;
  document.body.append(cacheDialog);
  const cacheButtons = panel.querySelectorAll('[data-project-cache]');
  const cacheBytes = cacheDialog.querySelector('[data-cache-bytes]');
  const cacheImages = cacheDialog.querySelector('[data-cache-images]');
  const cacheRefresh = cacheDialog.querySelector('[data-cache-refresh]');
  const cacheStatus = cacheDialog.querySelector('[role="status"]');
  const librarySelect = cacheDialog.querySelector('#whiteboard-file-library');
  const folderSelect = cacheDialog.querySelector('#whiteboard-file-folder');
  const folderStatus = cacheDialog.querySelector('[data-file-folder-status]');
  const folderSave = cacheDialog.querySelector('[data-file-folder-save]');
  const cacheList = cacheDialog.querySelector('[data-cache-list]');
  const cachePages = cacheDialog.querySelector('[data-cache-pages]');
  const cachePage = cacheDialog.querySelector('[data-cache-page]');
  const cachePrev = cacheDialog.querySelector('[data-cache-prev]');
  const cacheNext = cacheDialog.querySelector('[data-cache-next]');
  const cacheCount = cacheDialog.querySelector('[data-cache-count]');
  const cacheCopy = cacheDialog.querySelector('[data-cache-copy]');
  const cacheClear = cacheDialog.querySelector('[data-cache-clear]');
  const cacheConfirm = cacheDialog.querySelector('[data-cache-confirm]');
  const cacheConfirmText = cacheDialog.querySelector('[data-cache-confirm-text]');
  const cacheClearCancel = cacheDialog.querySelector('[data-cache-clear-cancel]');
  const cacheClearConfirm = cacheDialog.querySelector('[data-cache-clear-confirm]');
  const cacheActionStatus = cacheDialog.querySelector('[data-cache-action-status]');
  const cachePreview = cacheDialog.querySelector('.whiteboard-cache-preview');
  const cachePreviewImage = cachePreview.querySelector('img');

  let scope;
  let visible = false;
  let activeProject = null;
  let draft;
  let fileFolderDraft;
  let cacheSession;

  function setCacheStatus(element, message) {
    element.textContent = message;
    element.hidden = !message;
  }

  function activeCache(current) {
    return cacheDialog.open && visible && cacheSession === current && scope === current.target;
  }

  function updateCacheActions(current) {
    const disabled = current.busy || !current.selected.size;
    const saved = fileFolderDraft?.saved;
    const canCopy = saved && !fileFolderDraft.saving && hasFileFolder(fileFolderDraft.libraries,saved) &&
      typeof copyCachedImages === 'function';
    cacheCount.textContent = '已选 ' + cacheNumber.format(current.selected.size) + ' 张';
    cacheRefresh.disabled = Boolean(current.busy);
    cacheCopy.disabled = Boolean(disabled || !canCopy);
    cacheCopy.title = canCopy ? '' : '先保存白板文件存放位置';
    cacheClear.disabled = Boolean(disabled);
    for (const checkbox of cacheList.querySelectorAll('[data-cache-select]')) checkbox.disabled = Boolean(current.busy);
  }

  function closeCachePreview(current) {
    current.preview = null;
    cachePreview.hidden = true;
    cachePreviewImage.removeAttribute('src');
    if (current.previewUrl) URL.revokeObjectURL(current.previewUrl);
    current.previewUrl = '';
  }

  async function showCachePreview(current, row) {
    const previous = current.preview;
    closeCachePreview(current);
    if (previous?.key === row.key) return;
    const request = {key:row.key};
    current.preview = request;
    try {
      const [image] = await readWhiteboardImageCache(current.target.teamId,[row.key]);
      if (!activeCache(current) || current.preview !== request) return;
      if (!image) throw Error('这张缓存图片已不可用。');
      current.previewUrl = URL.createObjectURL(image.blob);
      cachePreviewImage.src = current.previewUrl;
      cachePreview.hidden = false;
    } catch {
      if (activeCache(current) && current.preview === request) setCacheStatus(cacheActionStatus,'暂时无法预览这张图片。');
    }
  }

  function renderCacheList(current) {
    closeCachePreview(current);
    const start = current.page * cachePageSize;
    const lastPage = Math.ceil(current.rows.length / cachePageSize) - 1;
    cacheList.replaceChildren(...current.rows.slice(start,start + cachePageSize).map((row,index) => {
      const entry = document.createElement('li');
      const label = document.createElement('label');
      const check = document.createElement('input');
      const title = document.createElement('span');
      const preview = document.createElement('button');
      const extension = imageExtensions.get(row.mime);
      check.type = 'checkbox';
      check.dataset.cacheSelect = '';
      check.checked = current.selected.has(row.key);
      title.textContent = ['图片 ' + (start + index + 1), extension?.toUpperCase(), formatCacheSize(row.bytes)].filter(Boolean).join(' · ');
      label.append(check,title);
      check.addEventListener('change', () => {
        if (check.checked) current.selected.add(row.key);
        else current.selected.delete(row.key);
        cacheConfirm.hidden = true;
        updateCacheActions(current);
      });
      preview.type = 'button';
      preview.className = 'text-button';
      preview.dataset.cachePreview = '';
      preview.textContent = '预览';
      preview.setAttribute('aria-label','预览图片 ' + (start + index + 1));
      preview.addEventListener('click', () => void showCachePreview(current,row));
      entry.append(label,preview);
      return entry;
    }));
    cacheList.hidden = !current.rows.length;
    cachePages.hidden = lastPage < 1;
    cachePage.textContent = (current.page + 1) + ' / ' + (lastPage + 1);
    cachePrev.disabled = current.page === 0;
    cacheNext.disabled = current.page >= lastPage;
    updateCacheActions(current);
  }

  async function refreshCache(current) {
    if (!activeCache(current) || current.busy) return;
    current.busy = true;
    cacheConfirm.hidden = true;
    updateCacheActions(current);
    cacheBytes.textContent = cacheImages.textContent = '—';
    cacheBytes.removeAttribute('title');
    setCacheStatus(cacheStatus,'正在统计缓存…');
    try {
      const rows = await listWhiteboardImageCache(current.target.teamId);
      if (!activeCache(current)) return;
      const bytes = rows.reduce((total,row) => total + row.bytes, 0);
      current.rows = rows;
      current.selected = new Set(rows.filter(row => current.selected.has(row.key)).map(row => row.key));
      current.page = Math.min(current.page,Math.max(0,Math.ceil(rows.length / cachePageSize) - 1));
      cacheBytes.textContent = formatCacheSize(bytes);
      cacheBytes.title = cacheNumber.format(bytes) + ' B';
      cacheImages.textContent = cacheNumber.format(rows.length) + ' 张';
      renderCacheList(current);
      setCacheStatus(cacheStatus,rows.length ? '' : '暂无缓存图片。');
    } catch {
      if (activeCache(current)) setCacheStatus(cacheStatus,'暂时无法读取白板缓存。');
    } finally {
      if (activeCache(current)) {
        current.busy = false;
        updateCacheActions(current);
      }
    }
  }

  async function copyCacheSelection(current) {
    const {teamId,key:workspaceKey} = current.target;
    const available = () => activeCache(current);
    const selected = current.rows.filter(row => current.selected.has(row.key) && row.bytes <= cacheCopyBytes);
    let copied = 0;
    let index = 0;
    while (available() && index < selected.length) {
      const keys = [];
      let bytes = 0;
      while (keys.length < cachePageSize && selected[index] && bytes + selected[index].bytes <= cacheCopyBytes) {
        keys.push(selected[index].key);
        bytes += selected[index++].bytes;
      }
      const images = await readWhiteboardImageCache(teamId,keys);
      if (!available()) break;
      const files = images.map(({id,blob}) => new File([blob],
        '白板图片-' + id.slice(0,12) + '.' + (imageExtensions.get(blob.type) || 'img'),{type:blob.type}));
      if (!files.length) continue;
      try {
        const result = await copyCachedImages({teamId,workspaceKey,files,paths:[],available,limit:cachePageSize});
        copied += result.copied;
      } catch (error) {
        if (!copied) throw error;
        break;
      }
    }
    return copied;
  }

  async function runCacheAction(current, clear) {
    if (!activeCache(current) || current.busy || !current.selected.size) return;
    current.busy = true;
    current.writing = true;
    cacheConfirm.hidden = true;
    updateCacheActions(current);
    if (fileFolderDraft) updateFileFolderControls(fileFolderDraft);
    setCacheStatus(cacheActionStatus,clear ? '正在清除缓存…' : '正在复制图片…');
    try {
      if (clear) {
        const result = await clearSyncedWhiteboardImageCache({
          teamId:current.target.teamId,keys:[...current.selected],api,available:() => activeCache(current),
        });
        if (activeCache(current)) setCacheStatus(cacheActionStatus,
          '已清除 ' + result.cleared + ' 张。' + (result.skipped ? '有 ' + result.skipped + ' 张暂无法清除。' : ''));
      } else {
        const copied = await copyCacheSelection(current);
        if (activeCache(current)) {
          const skipped = current.selected.size - copied;
          setCacheStatus(cacheActionStatus,'已复制 ' + copied + ' 张。' + (skipped ? '有 ' + skipped + ' 张暂未复制。' : ''));
        }
      }
    } catch (error) {
      if (activeCache(current)) setCacheStatus(cacheActionStatus,
        String(error?.message || (clear ? '暂时无法清除缓存。' : '暂时无法复制图片。')));
    } finally {
      if (activeCache(current)) {
        current.busy = false;
        current.writing = false;
        if (fileFolderDraft) updateFileFolderControls(fileFolderDraft);
        if (clear) void refreshCache(current);
        else updateCacheActions(current);
      }
    }
  }

  function openCache() {
    if (!visible || !scope?.teamId || cacheDialog.open) return;
    if (cacheSession) closeCachePreview(cacheSession);
    const current = cacheSession = {target:scope,rows:[],selected:new Set(),page:0,busy:false};
    cacheDialog.showModal();
    prepareFileFolder();
    cacheConfirm.hidden = true;
    setCacheStatus(cacheActionStatus,'');
    renderCacheList(current);
    void refreshCache(current);
  }

  for (const button of cacheButtons) button.addEventListener('click',openCache);
  cacheRefresh.addEventListener('click',() => {
    if (cacheSession) void refreshCache(cacheSession);
  });
  for (const [button, delta] of [[cachePrev,-1],[cacheNext,1]]) {
    button.addEventListener('click', () => {
      cacheSession.page += delta;
      renderCacheList(cacheSession);
    });
  }
  cacheCopy.addEventListener('click', () => void runCacheAction(cacheSession,false));
  cacheClear.addEventListener('click', () => {
    cacheConfirmText.textContent = '清除所选 ' + cacheNumber.format(cacheSession.selected.size) + ' 张图片的本机缓存？已同步的图片可重新加载。';
    cacheConfirm.hidden = false;
    cacheClearCancel.focus();
  });
  cacheClearCancel.addEventListener('click', () => {
    cacheConfirm.hidden = true;
    cacheClear.focus();
  });
  cacheClearConfirm.addEventListener('click', () => {
    if (!cacheConfirm.hidden) void runCacheAction(cacheSession,true);
  });
  for (const close of cacheDialog.querySelectorAll('[data-cache-close]')) {
    close.addEventListener('click', () => cacheDialog.close());
  }
  cacheDialog.addEventListener('close', () => {
    if (cacheDialog.open) return;
    if (cacheSession) closeCachePreview(cacheSession);
    cacheSession = null;
    fileFolderDraft = null;
  });

  function validFileFolderDraft(current) {
    return cacheDialog.open && fileFolderDraft === current && visible && scope === current.target;
  }

  function showFileFolderStatus(message = '') {
    folderStatus.textContent = message;
    folderStatus.hidden = !message;
  }

  async function availableFileFolders(target) {
    const rows = await getFileFolders({key:target.key,teamId:target.teamId});
    return (Array.isArray(rows) ? rows : []).filter(row => typeof row?.id === 'string' && row.id &&
      typeof row.name === 'string' && row.name)
      .map(row => ({id:row.id,name:row.name,folders:[...new Set((Array.isArray(row.folders) ? row.folders : [])
        .filter(folder => typeof folder === 'string' && folder))]}));
  }

  function renderFileFolders(preferred = '') {
    const library = fileFolderDraft?.libraries.find(row => row.id === librarySelect.value);
    folderSelect.replaceChildren(new Option(library ? '根目录' : '请选择团队资产库', ''),
      ...(library?.folders || []).map(folder => new Option(folder, folder)));
    folderSelect.value = library?.folders.includes(preferred) ? preferred : '';
    folderSelect.disabled = folderSelect.options.length < 2;
  }

  function prepareFileFolder() {
    const current = {target:scope,libraries:[],saved:readFileFolder(scope.teamId),ready:false,saving:false};
    fileFolderDraft = current;
    librarySelect.replaceChildren(new Option('正在读取团队资产库…', ''));
    librarySelect.disabled = folderSave.disabled = true;
    renderFileFolders();
    showFileFolderStatus();
    void loadFileFolderChoices(current);
  }

  function updateFileFolderControls(current) {
    const disabled = !current.ready || current.saving || cacheSession?.writing;
    librarySelect.disabled = Boolean(disabled || !current.libraries.length);
    folderSelect.disabled = Boolean(disabled || folderSelect.options.length < 2);
    folderSave.disabled = Boolean(disabled ||
      (librarySelect.value === (current.saved?.libraryId ?? '') && folderSelect.value === (current.saved?.folder ?? '')));
    if (cacheSession) updateCacheActions(cacheSession);
  }

  async function loadFileFolderChoices(current) {
    try {
      if (typeof getFileFolders !== 'function') throw Error('暂时无法读取团队资产库。');
      const libraries = await availableFileFolders(current.target);
      if (!validFileFolderDraft(current)) return;
      const saved = current.saved;
      current.libraries = libraries;
      current.ready = true;
      const available = saved && hasFileFolder(libraries,saved);
      librarySelect.replaceChildren(new Option('未设置', ''), ...libraries.map(row => new Option(row.name,row.id)));
      librarySelect.value = available ? saved.libraryId : '';
      renderFileFolders(available ? saved.folder : '');
      updateFileFolderControls(current);
      if (!libraries.length) showFileFolderStatus('当前没有可写入的团队资产库。');
      else if (saved && !available) showFileFolderStatus('之前设置的文件夹已不可用。');
    } catch (error) {
      if (!validFileFolderDraft(current)) return;
      librarySelect.replaceChildren(new Option('无法读取团队资产库', ''));
      showFileFolderStatus(String(error?.message || error || '无法读取团队资产库。'));
    }
  }

  async function saveFileFolder(event) {
    event.preventDefault();
    const current = fileFolderDraft;
    if (!current || !validFileFolderDraft(current) || folderSave.disabled) return;
    const location = librarySelect.value ? {libraryId:librarySelect.value,folder:folderSelect.value} : null;
    current.saving = true;
    updateFileFolderControls(current);
    showFileFolderStatus();
    try {
      if (location) {
        const libraries = await availableFileFolders(current.target);
        if (!validFileFolderDraft(current)) return;
        if (!hasFileFolder(libraries,location)) throw Error('文件夹已不可用，请重新选择。');
      }
      const key = fileFolderKey + current.target.teamId;
      if (location) localStorage.setItem(key, JSON.stringify(location));
      else localStorage.removeItem(key);
      current.saved = location;
      showFileFolderStatus(location ? '已保存文件存放位置。' : '已取消设置文件存放位置。');
    } catch (error) {
      if (!validFileFolderDraft(current)) return;
      showFileFolderStatus(String(error?.message || error || '无法保存文件存放位置。'));
    } finally {
      if (validFileFolderDraft(current)) {
        current.saving = false;
        updateFileFolderControls(current);
      }
    }
  }

  cacheDialog.querySelector('form').addEventListener('submit', saveFileFolder);
  librarySelect.addEventListener('change', () => {
    renderFileFolders();
    showFileFolderStatus();
    if (fileFolderDraft) updateFileFolderControls(fileFolderDraft);
  });
  folderSelect.addEventListener('change', () => {
    showFileFolderStatus();
    if (fileFolderDraft) updateFileFolderControls(fileFolderDraft);
  });

  function persist(target) {
    try {
      localStorage.setItem(directoryKey + target.key, JSON.stringify(target.projects));
      return true;
    } catch { return false; }
  }

  function setBoardScope(id) {
    board.setScope({
      key:id === defaultProject.id ? scope.key : JSON.stringify([scope.key, id]),
      workspaceKey:scope.key,
      teamId:scope.teamId,
      projectId:id,
    });
  }

  function renderStatus() {
    statusText.textContent = scope.error || (scope.teamId && !scope.ready ? '正在同步项目…' : '');
    status.hidden = !statusText.textContent;
    retry.hidden = !scope.error;
    create.disabled = scope.projects.length >= projectLimit;
  }

  function focusCard(id) {
    [...grid.querySelectorAll('[data-project-open]')].find(button => button.dataset.projectOpen === id)?.focus();
  }

  function renderCards() {
    const focus = grid.contains(document.activeElement) ? document.activeElement : null;
    grid.replaceChildren(...scope.projects.map(project => {
      const card = document.createElement('li');
      card.className = 'whiteboard-project-card';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'whiteboard-project-open';
      open.dataset.projectOpen = project.id;
      open.title = '双击打开项目';
      open.innerHTML = `<span class="whiteboard-project-cover">${icon('whiteboard')}</span><span class="whiteboard-project-title"></span>`;
      open.querySelector('.whiteboard-project-title').textContent = project.name;
      open.addEventListener('dblclick', () => openProject(project.id));
      open.addEventListener('click', event => { if (event.detail === 0) openProject(project.id); });
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'icon-button whiteboard-project-rename';
      rename.dataset.projectRename = project.id;
      rename.title = '重命名';
      rename.setAttribute('aria-label', `重命名 ${project.name}`);
      rename.innerHTML = icon('edit');
      rename.addEventListener('click', () => startDraft(project));
      card.append(open, rename);
      return card;
    }));
    if (focus?.dataset.projectOpen) focusCard(focus.dataset.projectOpen);
    if (focus?.dataset.projectRename) {
      [...grid.querySelectorAll('[data-project-rename]')]
        .find(button => button.dataset.projectRename === focus.dataset.projectRename)?.focus();
    }
    renderStatus();
  }

  async function refreshProjects() {
    const target = scope;
    if (!visible || activeProject || !target?.teamId || target.request || target.saving) return;
    const request = {};
    target.request = request;
    try {
      const snapshot = await api('team_whiteboard_projects', {teamId:target.teamId});
      if (scope !== target || target.request !== request) return;
      if (!Array.isArray(snapshot?.projects)) throw Error('项目列表不可用');
      const projects = cleanProjects(snapshot.projects);
      const changed = JSON.stringify(projects) !== JSON.stringify(target.projects);
      target.ready = true;
      target.error = '';
      if (changed) {
        target.projects = projects;
        persist(target);
        renderCards();
      } else renderStatus();
    } catch (error) {
      if (scope === target && target.request === request) {
        target.error = syncError(error);
        renderStatus();
      }
    } finally {
      if (target.request === request) target.request = null;
    }
  }

  function openProject(id, focus = true) {
    const project = scope?.projects.find(item => item.id === id);
    if (!visible || !project) return;
    board.setVisible(false);
    activeProject = project.id;
    editor.dataset.whiteboardProject = project.id;
    editorName.textContent = project.name;
    home.classList.add('hidden');
    editor.classList.remove('hidden');
    setBoardScope(project.id);
    board.setVisible(true);
    if (focus) canvas.querySelector('.whiteboard-stage')?.focus({preventScroll:true});
  }

  function showProjects(focus = false) {
    const previous = activeProject;
    board.setVisible(false);
    activeProject = null;
    delete editor.dataset.whiteboardProject;
    editor.classList.add('hidden');
    home.classList.remove('hidden');
    if (focus && previous) focusCard(previous);
    refreshProjects();
  }

  function displayFormError(message = '') {
    formError.textContent = message;
    formError.hidden = !message;
  }

  function startDraft(project) {
    if (dialog.open || scope.saving) return;
    draft = {target:scope, id:project?.id || crypto.randomUUID(), rename:Boolean(project)};
    dialog.querySelector('h2').textContent = project ? '重命名项目' : '新建白板项目';
    nameInput.value = project?.name || '';
    save.textContent = project ? '保存' : '创建项目';
    save.disabled = false;
    displayFormError();
    dialog.showModal();
    nameInput.focus();
    nameInput.select();
  }

  async function saveProject(event) {
    event.preventDefault();
    if (!draft || scope !== draft.target || scope.saving) return;
    const name = nameInput.value.trim();
    if (!name || [...name].length > nameLimit || /\p{Cc}/u.test(name)) {
      displayFormError(`请输入 1–${nameLimit} 个字符的项目名称。`);
      nameInput.focus();
      return;
    }
    const current = draft;
    const {target, id, rename} = current;
    if (!rename && target.projects.length >= projectLimit) {
      displayFormError(`最多可以保存 ${projectLimit} 个白板项目。`);
      return;
    }
    target.saving = true;
    target.request = null;
    save.disabled = true;
    try {
      const previous = target.projects;
      if (target.teamId) {
        const command = rename ? 'team_whiteboard_rename_project' : 'team_whiteboard_create_project';
        const snapshot = await api(command, {teamId:target.teamId, projectId:id, name});
        if (!Array.isArray(snapshot?.projects)) throw Error('团队服务返回了无效的项目列表。');
        if (scope !== target) return;
        target.projects = cleanProjects(snapshot.projects);
        target.ready = true;
        target.error = '';
      } else {
        const project = {id, name};
        target.projects = rename ? previous.map(item => item.id === id ? project : item) : [...previous, project];
      }
      if (!persist(target) && !target.teamId) {
        target.projects = previous;
        throw Error('无法在本机保存白板项目。');
      }
      if (draft === current) dialog.close();
      renderCards();
      if (visible && !activeProject) focusCard(id);
    } catch (error) {
      if (draft === current) displayFormError(String(error?.message || error || '无法保存项目。'));
    } finally {
      target.saving = false;
      if (draft === current) save.disabled = false;
    }
  }

  form.addEventListener('submit', saveProject);
  nameInput.addEventListener('input', () => displayFormError());
  dialog.addEventListener('close', () => { draft = null; });
  for (const cancel of dialog.querySelectorAll('[data-project-cancel]')) {
    cancel.addEventListener('click', () => dialog.close());
  }
  create.addEventListener('click', () => startDraft());
  back.addEventListener('click', () => showProjects(true));
  retry.addEventListener('click', refreshProjects);
  window.setInterval(() => { if (!document.hidden) refreshProjects(); }, 5000);

  return {
    setContext({key, teamId, visible:show}) {
      if (scope?.key === key && visible === show) return;
      board.setVisible(false);
      if (dialog.open) dialog.close();
      if (cacheDialog.open) {
        cacheDialog.close();
      }
      fileFolderDraft = null;
      if (scope?.key !== key) {
        scope = {key, teamId, projects:readProjects(key), ready:!teamId, error:''};
        setBoardScope(defaultProject.id);
        renderCards();
      }
      for (const button of cacheButtons) button.hidden = !teamId;
      visible = show;
      showProjects();
    },
    showProjects,
    openProject,
    captureProject() { return activeProject; },
    fileFolder() { return readFileFolder(scope?.teamId); },
    busyForUpdate() { return board.busyForUpdate(); },
    dropNativeImages(paths, position) { return Boolean(activeProject) && board.dropNativeImages(paths, position); },
    dropAssetReferences(projectId, references, offset) {
      return visible && activeProject === projectId && board.dropAssetReferences(references, offset);
    },
    dropLink(projectId, text, offset) {
      return visible && activeProject === projectId && board.dropLink(text, offset);
    },
    contextMenu(event) {
      if (!visible) return null;
      if (activeProject) return board.contextMenu(event);
      const card = event.target.closest('.whiteboard-project-card');
      const anchor = card?.querySelector('[data-project-open]') || create;
      const project = scope.projects.find(item => item.id === anchor.dataset.projectOpen);
      const actions = project ? [
        ['whiteboard', '打开项目', () => openProject(project.id)],
        ['edit', '重命名项目…', () => startDraft(project)],
      ] : [];
      if (!create.disabled) actions.push(['plus', '新建项目…', () => startDraft()]);
      actions.push(['refresh', '刷新', refreshProjects]);
      return {anchor,actions,label:'白板项目操作'};
    },
    refresh() {
      if (activeProject) board.refresh();
      else refreshProjects();
    },
  };
}
