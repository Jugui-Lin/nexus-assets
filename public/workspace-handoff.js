import {downloadWorkspaceFile} from './workspace-download.js';

const format = 'nexus-workspace-handoff';
const version = 1;
const maxSize = 8 * 1024 * 1024;
const pageSize = 40;
const viewNames = new Map([
  ['all','全部资产'],['folder','资产文件夹'],['collection','合集'],['favorites','收藏'],
  ['recent','最近入库'],['whiteboard','白板项目'],
]);

function metadataText(value, limit = 256) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Error('交接文件包含无效的名称或标识。');
  }
  return value.trim();
}

function localPath(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 32767 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Error('交接文件包含无效路径。');
  }
  if (/^\/(?!\/)/.test(value) && !value.split('/').some(part => part === '.' || part === '..')) return value;
  let path = value.replace(/\//g,'\\');
  if (path.toLowerCase().startsWith('\\\\?\\unc\\')) path = '\\\\' + path.slice(8);
  else if (path.startsWith('\\\\?\\') && /^[a-z]:\\/i.test(path.slice(4))) path = path.slice(4);
  const drive = /^[a-z]:\\/i.test(path);
  const network = /^\\\\[^\\:@]+\\[^\\]+(?:\\|$)/.test(path);
  const components = (drive ? path.slice(3) : path.slice(2)).split('\\');
  if ((!drive && !network) || components.some(part => part === '.' || part === '..' || /[:*?"<>|]/.test(part))) {
    throw Error('交接文件仅支持规范的本机或共享文件路径。');
  }
  return path;
}

function normalizeWorkspace(value) {
  if (!value || !['files','assets'].includes(value.kind)) throw Error('无法识别交接工作区。');
  const {kind} = value;
  const path = localPath(value.path);
  const name = metadataText(value.name);
  const workspace = {kind,...(name && {name}),...(path && {path})};
  if (kind === 'files') {
    if (!path) throw Error('请选择有实际路径的文件夹再进行交接。');
    return workspace;
  }
  const view = value.view || 'all';
  if (!viewNames.has(view)) throw Error('这个资产库视图暂不支持交接。');
  workspace.view = view;
  for (const key of ['catalogId','libraryId','collectionId','projectId']) {
    const text = metadataText(value[key]);
    if (text) workspace[key] = text;
  }
  if (view === 'folder') {
    const folder = metadataText(value.folder,32767).replace(/\\/g,'/');
    if (/^\/|:/.test(folder) || folder.split('/').some(part => part === '.' || part === '..')) {
      throw Error('交接文件包含无效的资产文件夹。');
    }
    if (!path && !workspace.libraryId) throw Error('交接文件没有可定位的资产文件夹。');
    workspace.folder = folder;
  }
  if (view === 'collection' && !workspace.collectionId) throw Error('交接文件缺少合集标识。');
  if (view === 'whiteboard' && !workspace.projectId) throw Error('交接文件缺少白板项目标识。');
  return workspace;
}

function normalizeAssets(values) {
  if (!Array.isArray(values)) throw Error('交接文件的资产引用无效。');
  const unique = new Set();
  return values.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('交接文件包含无效的资产引用。');
    const id = metadataText(value.id);
    const path = localPath(value.path);
    const name = metadataText(value.name);
    if (!id && !path) throw Error('一项资产引用缺少路径和标识。');
    const key = JSON.stringify([id,path]);
    if (unique.has(key)) return [];
    unique.add(key);
    return [{...(id && {id}),...(path && {path}),...(name && {name})}];
  });
}

function makeManifest(capture, createdAt) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) throw Error('当前没有可交接的工作区。');
  return {
    format,version,createdAt,
    workspace:normalizeWorkspace(capture.workspace),
    assets:normalizeAssets(capture.assets ?? []),
  };
}

function parseManifest(text) {
  let contents;
  try { contents = JSON.parse(text.replace(/^\ufeff/,'')); }
  catch { throw Error('无法读取 JSON 交接文件。'); }
  if (contents?.format !== format) throw Error('请选择 Nexus 工作交接文件。');
  if (contents.version !== version) throw Error('此版本的 Nexus 暂不支持该交接文件格式。');
  const date = new Date(metadataText(contents.createdAt,48));
  if (!Number.isFinite(date.getTime()) || !Array.isArray(contents.assets)) throw Error('交接文件的信息不完整。');
  return makeManifest(contents,date.toISOString());
}

export function initWorkspaceHandoff({capture,open,exportFile,notify}) {
  const doc = document;
  const dialog = doc.createElement('dialog');
  dialog.id = 'workspace-handoff-dialog';
  dialog.className = 'modal compact-dialog workspace-handoff-dialog';
  dialog.setAttribute('aria-labelledby','workspace-handoff-title');
  dialog.innerHTML = `
    <form>
      <div class="modal-header">
        <h2 id="workspace-handoff-title"></h2>
      </div>
      <div class="workspace-handoff-body">
        <p data-handoff-description></p>
        <div data-handoff-file-selection hidden>
          <button type="button" class="button subtle" data-handoff-choose>选择交接文件</button>
          <input type="file" accept=".json,application/json" hidden>
          <span data-handoff-filename></span>
        </div>
        <div data-handoff-preview hidden>
          <dl data-handoff-location></dl>
          <div class="workspace-handoff-list-heading">
            <strong data-handoff-count></strong>
            <div data-handoff-select-all hidden>
              <button class="text-button" type="button" data-handoff-all>全选</button>
              <button class="text-button" type="button" data-handoff-none>清空</button>
            </div>
          </div>
          <ol data-handoff-assets aria-label="交接资产引用"></ol>
          <button type="button" class="button subtle" data-handoff-more hidden>显示更多</button>
        </div>
      </div>
      <div class="modal-footer">
        <p role="status" data-handoff-status></p>
        <button type="button" class="button subtle" data-handoff-cancel>取消</button>
        <button type="submit" class="button primary" data-handoff-confirm disabled></button>
      </div>
    </form>`;
  doc.body.append(dialog);
  const query = selector => dialog.querySelector(selector);
  const title = query('h2');
  const description = query('[data-handoff-description]');
  const fileSelection = query('[data-handoff-file-selection]');
  const fileInput = query('input[type=file]');
  const filename = query('[data-handoff-filename]');
  const confirm = query('[data-handoff-confirm]');
  const cancel = query('[data-handoff-cancel]');
  const choose = query('[data-handoff-choose]');
  const preview = query('[data-handoff-preview]');
  const location = query('[data-handoff-location]');
  const count = query('[data-handoff-count]');
  const allActions = query('[data-handoff-select-all]');
  const list = query('[data-handoff-assets]');
  const more = query('[data-handoff-more]');
  const status = query('[data-handoff-status]');
  let mode, manifest, focusReturn, selected, shown = 0, generation = 0, committing = false;

  function message(text, error = false) {
    status.textContent = text;
    status.toggleAttribute('data-handoff-error',error);
  }

  function showError(failure) {
    message(String(failure?.message || failure).slice(0,360),true);
  }

  function updateCount() {
    const total = manifest.assets.length;
    count.textContent = mode === 'export' ? `资产引用 ${selected.size} / ${total}` : `${total} 项资产引用`;
  }

  function addRows() {
    const items = doc.createDocumentFragment();
    for (const [offset,asset] of manifest.assets.slice(shown,shown + pageSize).entries()) {
      const row = doc.createElement('li');
      const wrapper = doc.createElement(mode === 'export' ? 'label' : 'div');
      if (mode === 'export') {
        const index = shown + offset;
        const toggle = doc.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = selected.has(index);
        toggle.dataset.handoffIndex = String(index);
        wrapper.append(toggle);
      }
      const label = doc.createElement('span');
      const primary = doc.createElement('strong');
      primary.textContent = asset.name || asset.path || asset.id;
      label.append(primary);
      if (asset.name && (asset.path || asset.id)) {
        const secondary = doc.createElement('small');
        secondary.textContent = asset.path || asset.id;
        label.append(secondary);
      }
      wrapper.append(label);
      row.append(wrapper);
      items.append(row);
    }
    shown += items.childElementCount;
    list.append(items);
    more.hidden = shown >= manifest.assets.length;
  }

  function populate(next) {
    manifest = next;
    selected = new Set(next.assets.keys());
    shown = 0;
    list.replaceChildren();
    location.replaceChildren();
    const {workspace} = next;
    const formatDate = new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'});
    const entries = [
      ['工作区',workspace.kind === 'files' ? '文件夹' : viewNames.get(workspace.view)],
      ['名称',workspace.name],
      ['路径',workspace.path || workspace.folder],
      ['创建时间',formatDate.format(new Date(next.createdAt))],
    ];
    for (const [key,value] of entries) {
      if (!value) continue;
      const term = doc.createElement('dt');
      term.textContent = key;
      const detail = doc.createElement('dd');
      detail.textContent = value;
      location.append(term,detail);
    }
    allActions.hidden = mode !== 'export' || !next.assets.length;
    preview.hidden = false;
    confirm.disabled = false;
    message('');
    updateCount();
    addRows();
  }

  function show(nextMode) {
    if (dialog.open) return false;
    mode = nextMode;
    manifest = null;
    focusReturn = doc.activeElement;
    fileInput.value = '';
    filename.textContent = '';
    preview.hidden = confirm.disabled = true;
    fileSelection.hidden = mode !== 'import';
    title.textContent = mode === 'export' ? '导出工作交接' : '导入工作交接';
    description.textContent = mode === 'export'
      ? '确认下列工作位置和资产引用。保存后可将交接文件交给接手的人。'
      : '选择交接文件并核对其中的工作位置和资产引用，然后打开该位置。';
    confirm.textContent = mode === 'export' ? '保存交接文件' : '打开交接位置';
    message('');
    dialog.showModal();
    (mode === 'import' ? choose : cancel).focus({preventScroll:true});
    return true;
  }

  async function showExport() {
    if (!show('export')) return;
    const request = ++generation;
    message('正在准备当前工作位置…');
    try {
      const result = await capture();
      if (request === generation && dialog.open) populate(makeManifest(result,new Date().toISOString()));
    } catch (failure) {
      if (request === generation && dialog.open) showError(failure);
    }
  }

  function showImport() {
    show('import');
  }

  choose.addEventListener('click',() => fileInput.click());
  fileInput.addEventListener('change',async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || committing) return;
    manifest = null;
    preview.hidden = confirm.disabled = true;
    filename.textContent = file.name;
    const request = ++generation;
    message('正在读取交接文件…');
    try {
      if (file.size > maxSize) throw Error('交接文件超过 8 MB，无法读取。');
      const text = await file.text();
      if (request === generation && dialog.open) populate(parseManifest(text));
    } catch (failure) {
      if (request === generation && dialog.open) showError(failure);
    }
  });

  list.addEventListener('change',event => {
    const toggle = event.target.closest('[data-handoff-index]');
    if (!toggle || !manifest || mode !== 'export') return;
    const index = Number(toggle.dataset.handoffIndex);
    if (toggle.checked) selected.add(index);
    else selected.delete(index);
    updateCount();
  });
  function selectAll(include) {
    selected = include ? new Set(manifest.assets.keys()) : new Set();
    for (const checkbox of list.querySelectorAll('[data-handoff-index]')) checkbox.checked = include;
    updateCount();
  }
  query('[data-handoff-all]').addEventListener('click',() => selectAll(true));
  query('[data-handoff-none]').addEventListener('click',() => selectAll(false));
  more.addEventListener('click',() => {
    const start = shown;
    addRows();
    const row = list.children[start];
    row?.scrollIntoView({block:'nearest'});
    row?.querySelector('input')?.focus({preventScroll:true});
  });

  cancel.addEventListener('click',() => dialog.close());
  dialog.addEventListener('cancel',event => {
    if (committing) event.preventDefault();
  });
  dialog.addEventListener('close',() => {
    generation++;
    if (focusReturn?.isConnected && focusReturn.getClientRects().length) focusReturn.focus({preventScroll:true});
    focusReturn = null;
  });
  query('form').addEventListener('submit',async event => {
    event.preventDefault();
    if (!manifest || committing) return;
    committing = confirm.disabled = cancel.disabled = choose.disabled = true;
    message(mode === 'export' ? '正在保存交接文件…' : '正在打开交接位置…');
    try {
      if (mode === 'export') {
        const outcome = {...manifest,assets:manifest.assets.filter((_,index) => selected.has(index))};
        const text = JSON.stringify(outcome,null,2) + '\n';
        if (new Blob([text]).size > maxSize) throw Error('所选资产过多，请减少交接引用后重试。');
        const basename = 'nexus-handoff-' + manifest.createdAt.slice(0,19).replace(/[T:]/g,'-') + '.json';
        if (exportFile) {
          const saved = await exportFile({filename:basename,text});
          if (saved === false) { message(''); return; }
        } else downloadWorkspaceFile(doc,basename,text);
        notify?.(exportFile ? '已保存交接文件' : '已开始下载交接文件');
      } else {
        const result = await open(manifest);
        if (result === false) { message(''); return; }
        focusReturn = null;
        if (result?.message) notify?.(result.message);
      }
      dialog.close();
    } catch (failure) {
      showError(failure);
    } finally {
      committing = cancel.disabled = choose.disabled = false;
      confirm.disabled = !manifest;
    }
  });

  return {showExport,showImport};
}
