const filterKey = 'nexus-explorer-project-filters-v1';
const selectionsKey = 'nexus-explorer-directory-selections-v1';
const ruleLimit = 48;
const selectionLimit = 96;
const extensionsPattern = /^[a-z0-9]{1,16}$/;

function read(storage,key,limit) {
  try {
    const result = JSON.parse(storage.getItem(key));
    return Array.isArray(result) ? result.slice(-limit) : [];
  } catch { return []; }
}

function inside(path,root) {
  if (!path || !root) return false;
  const separator = /^(?:[a-z]:|\\\\)/i.test(root) ? '\\' : '/';
  return path === root || path.startsWith(root.endsWith(separator) ? root : root + separator);
}

function sanitize(name,extensions) {
  name = name.trim();
  const values = [...new Set(extensions.map(value => value.toLowerCase().replace(/^\./,'')))];
  if ([...name].length > 96 || /[\u0000-\u001f\u007f]/u.test(name))
    throw Error('名称关键字最多 96 个字，且不能包含换行。');
  if (values.length > 12 || values.some(value => !extensionsPattern.test(value)))
    throw Error('最多可填写 12 个扩展名，每项使用 1–16 个字母或数字，例如 C4D、EXR。');
  return {name,extensions:values};
}

export function createExplorerDirectorySelections(storage,key) {
  const entries = new Map(read(storage,selectionsKey,selectionLimit).flatMap(record => {
    if (typeof record?.directory !== 'string' || typeof record?.path !== 'string') return [];
    return [[key(record.directory),record]];
  }));
  return {
    get(directory) { return entries.get(key(directory))?.path; },
    remember(directory,path) {
      const index = key(directory);
      if (!index || !path || !inside(key(path),index) || key(path) === index || entries.get(index)?.path === path) return;
      entries.delete(index);
      entries.set(index,{directory,path});
      while (entries.size > selectionLimit) entries.delete(entries.keys().next().value);
      try { storage.setItem(selectionsKey,JSON.stringify([...entries.values()])); } catch {}
    },
  };
}

export function explorerShotCode(path) {
  for (const segment of String(path || '').split(/[\\/]+/).reverse()) {
    const matches = [...segment.matchAll(/(?<![a-z0-9])sh\d{2,8}(?![a-z0-9])/gi)];
    if (matches.length === 1) return matches[0][0].toUpperCase();
    if (matches.length > 1) return null;
  }
  return null;
}

export function initExplorerProjectFilters({panel,storage,key,onChange,onToggle,onOpen}) {
  const owner = panel.ownerDocument;
  const rules = new Map();
  for (const record of read(storage,filterKey,ruleLimit)) {
    if (typeof record?.root !== 'string' || typeof record?.filter?.name !== 'string' ||
        !Array.isArray(record.filter.extensions) || record.filter.extensions.some(value => typeof value !== 'string')) continue;
    try {
      const filter = sanitize(record.filter.name,record.filter.extensions);
      if (key(record.root) && (filter.name || filter.extensions.length))
        rules.set(key(record.root),{root:record.root,filter});
    } catch {}
  }
  const bar = owner.createElement('section');
  bar.className = 'local-explorer-project-filter';
  bar.hidden = true;
  bar.setAttribute('aria-label','项目文件筛选');
  bar.innerHTML = '<span data-rule></span><button type="button" data-toggle></button><button type="button" data-root>打开筛选根目录</button><button type="button" data-edit>编辑</button>';
  panel.querySelector('.local-explorer-listing').before(bar);
  const summary = bar.querySelector('[data-rule]');
  const toggle = bar.querySelector('[data-toggle]');
  const openRoot = bar.querySelector('[data-root]');
  let shown;
  toggle.addEventListener('click',() => { if (shown) onToggle(shown); });
  openRoot.addEventListener('click',() => { if (shown) onOpen(shown.root); });
  bar.querySelector('[data-edit]').addEventListener('click',() => { if (shown) configure(shown.root); });

  const dialog = owner.createElement('dialog');
  dialog.className = 'modal compact-dialog explorer-project-filter-dialog';
  dialog.setAttribute('aria-labelledby','explorer-project-filter-title');
  dialog.innerHTML = `
    <form>
      <h2 id="explorer-project-filter-title">项目文件筛选</h2>
      <p dir="ltr" data-root-path></p>
      <p class="muted">应用于此文件夹及其子目录。文件夹本身仍可浏览。</p>
      <label>名称包含<input type="text" class="text-field" name="name" maxlength="96" autofocus></label>
      <label>扩展名<input type="text" class="text-field" name="extensions" maxlength="230" placeholder="例如 C4D、EXR"></label>
      <p role="status"></p>
      <div class="modal-footer">
        <button type="button" class="button subtle" data-remove>移除筛选</button>
        <button type="button" class="button subtle" data-cancel>取消</button>
        <button type="submit" class="button primary">保存</button>
      </div>
    </form>`;
  owner.body.append(dialog);
  const form = dialog.querySelector('form');
  const nameInput = form.elements.namedItem('name');
  const extInput = form.elements.namedItem('extensions');
  const remove = dialog.querySelector('[data-remove]');
  const status = dialog.querySelector('[role="status"]');
  let rootPath;

  function configure(path) {
    if (!path || dialog.open) return;
    rootPath = path;
    const rule = rules.get(key(path));
    dialog.querySelector('[data-root-path]').textContent = path;
    nameInput.value = rule?.filter.name || '';
    extInput.value = rule?.filter.extensions.join('、') || '';
    status.textContent = '';
    remove.hidden = !rule;
    dialog.showModal();
  }

  function store(filter) {
    const root = rootPath;
    const next = new Map(rules);
    next.delete(key(root));
    if (filter) next.set(key(root),{root,filter});
    while (next.size > ruleLimit) next.delete(next.keys().next().value);
    try { storage.setItem(filterKey,JSON.stringify([...next.values()])); }
    catch { status.textContent = '无法在本机保存筛选。'; return; }
    rules.clear();
    for (const [id,rule] of next) rules.set(id,rule);
    dialog.close();
    onChange(root);
  }

  form.addEventListener('submit',event => {
    event.preventDefault();
    let filter;
    try { filter = sanitize(nameInput.value,extInput.value.trim().split(/[\s,，、;；]+/u).filter(Boolean)); }
    catch (error) { status.textContent = error.message; return; }
    if (!filter.name && !filter.extensions.length) {
      status.textContent = '请填写名称或扩展名，也可以移除现有筛选。';
      return;
    }
    store(filter);
  });
  remove.addEventListener('click',() => store(null));
  dialog.querySelector('[data-cancel]').addEventListener('click',() => dialog.close());

  function resolve(path) {
    const location = key(path);
    let best;
    for (const [id,rule] of rules) {
      if (inside(location,id) && (!best || id.length > best.id.length)) best = {id,...rule};
    }
    return best || null;
  }

  function render(path,bypassed,blocked) {
    shown = resolve(path);
    bar.hidden = !shown;
    if (!shown) return;
    const {name,extensions} = shown.filter;
    summary.textContent = '项目筛选 · ' + [name,extensions.map(value => value.toUpperCase()).join('、')].filter(Boolean).join(' · ');
    summary.title = shown.root;
    toggle.textContent = bypassed ? '恢复项目筛选' : '临时查看全部';
    toggle.disabled = blocked;
    openRoot.hidden = shown.id === key(path);
    openRoot.disabled = blocked;
  }

  return {configure,resolve,render,includes:(root,path) => inside(key(path),key(root))};
}
