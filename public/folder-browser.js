const pageSize = 120;

function absoluteDirectory(value) {
  const path = value.trim();
  return /^[a-z]:$/i.test(path) ? path + '\\' : path;
}

export function initFolderBrowser({api, onSelect}) {
  const dialog = document.querySelector('#folder-browser-dialog');
  const path = dialog.querySelector('#folder-browser-path');
  const status = dialog.querySelector('#folder-browser-status');
  const summary = dialog.querySelector('#folder-browser-summary');
  const clear = dialog.querySelector('#folder-browser-clear');
  const rows = dialog.querySelector('#folder-browser-rows');
  const up = dialog.querySelector('#folder-browser-up');
  const roots = dialog.querySelector('#folder-browser-roots');
  const filter = dialog.querySelector('#folder-browser-filter');
  const nextPage = dialog.querySelector('#folder-browser-more');
  const use = dialog.querySelector('#folder-browser-use');
  const system = dialog.querySelector('#folder-browser-system');
  let current;
  let selected = new Set();
  let requestId = 0;
  let dialogId = 0;
  let loading = false;
  let systemBusy = false;
  let limit = pageSize;

  function updateButtons() {
    up.disabled = systemBusy || !current?.directory;
    roots.disabled = systemBusy || (!current?.directory && !loading);
    use.disabled = systemBusy || (!selected.size && (loading || !current?.directory));
    use.textContent = selected.size ? '使用所选文件夹' : '使用当前文件夹';
    summary.textContent = selected.size ? '已选 ' + selected.size + ' 个文件夹' : '';
    summary.title = selected.size ? [...selected].join('\n') : '';
    clear.classList.toggle('hidden', !selected.size);
    system.disabled = systemBusy;
  }

  function renderRows() {
    const search = filter.value.trim().toLocaleLowerCase();
    const folders = (current?.folders || []).filter(folder => folder.name.toLocaleLowerCase().includes(search));
    const fragment = document.createDocumentFragment();
    for (const item of folders.slice(0, limit)) {
      const row = document.createElement('div');
      row.className = 'folder-browser-row';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = selected.has(item.path);
      check.setAttribute('aria-label', '选择 ' + item.name);
      check.addEventListener('change', () => {
        if (check.checked) selected.add(item.path);
        else selected.delete(item.path);
        updateButtons();
      });
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'folder-browser-entry';
      open.textContent = item.name;
      open.title = item.path;
      open.addEventListener('click', () => browse(item.path));
      row.append(check, open);
      fragment.append(row);
    }
    rows.replaceChildren(fragment);
    nextPage.classList.toggle('hidden', folders.length <= limit);
    if (!loading && !systemBusy && current) {
      status.textContent = folders.length ? '' : search ? '没有匹配的文件夹' : '此处没有子文件夹';
    }
  }

  async function browse(directory = null) {
    const request = ++requestId;
    const movingFromRow = rows.contains(document.activeElement);
    loading = true;
    status.textContent = directory ? '正在读取此位置…' : '正在列出位置…';
    updateButtons();
    try {
      const result = await api('list_import_folders', {directory});
      if (request !== requestId || !dialog.open) return;
      current = result;
      path.value = result.directory || '';
      filter.value = '';
      limit = pageSize;
      loading = false;
      renderRows();
      rows.scrollTop = 0;
      if (movingFromRow && !rows.contains(document.activeElement)) path.focus();
    } catch (e) {
      if (request !== requestId || !dialog.open) return;
      loading = false;
      status.textContent = String(e?.message || e);
    } finally {
      if (request === requestId && dialog.open) updateButtons();
    }
  }

  function finish(files) {
    if (!files.length) return;
    onSelect(files);
    dialog.close();
  }

  dialog.querySelector('#folder-browser-navigation').addEventListener('submit', event => {
    event.preventDefault();
    const directory = absoluteDirectory(path.value);
    if (directory) browse(directory);
  });
  dialog.querySelector('#folder-browser-close').addEventListener('click', () => dialog.close());
  up.addEventListener('click', () => browse(current?.parent || null));
  roots.addEventListener('click', () => browse());
  filter.addEventListener('input', () => {
    limit = pageSize;
    renderRows();
  });
  nextPage.addEventListener('click', () => {
    const scroll = rows.scrollTop;
    limit += pageSize;
    renderRows();
    rows.scrollTop = scroll;
  });
  clear.addEventListener('click', () => {
    selected.clear();
    updateButtons();
    renderRows();
  });
  use.addEventListener('click', () => finish(selected.size ? [...selected] : current?.directory ? [current.directory] : []));
  system.addEventListener('click', async () => {
    if (systemBusy) return;
    const owner = dialogId;
    ++requestId;
    loading = false;
    systemBusy = true;
    updateButtons();
    status.textContent = '正在打开系统选择器…';
    try {
      const selection = await api('pick_asset_folders');
      if (!dialog.open || owner !== dialogId) return;
      if (selection.length) finish(selection);
      else status.textContent = '';
    } catch (e) {
      if (dialog.open && owner === dialogId) status.textContent = String(e?.message || e);
    } finally {
      systemBusy = false;
      if (dialog.open) {
        updateButtons();
        if (owner === dialogId && !current) browse();
      }
    }
  });

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    ++requestId;
    loading = false;
  });

  return {
    show(paths, startDirectory = null) {
      if (dialog.open) return;
      ++dialogId;
      current = null;
      selected = new Set(paths);
      path.value = '';
      filter.value = '';
      rows.replaceChildren();
      nextPage.classList.add('hidden');
      dialog.showModal();
      browse(startDirectory);
    },
  };
}
