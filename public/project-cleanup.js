const storageKey = 'nexus-project-cleanup-marks-v1';
const projectLimit = 24;
const pathLimit = 120;
const kinds = {cache:'缓存',proxy:'代理素材',render:'临时渲染'};
const number = new Intl.NumberFormat('zh-CN');
const decimal = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});
const date = new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'});

function sizeText(value) {
  if (value < 1024) return number.format(value) + ' B';
  const units = ['KB','MB','GB','TB','PB'];
  let position = -1;
  do { position++; value /= 1024; } while (value >= 1024 && position < units.length - 1);
  return decimal.format(value) + ' ' + units[position];
}

export function initProjectCleanup({api,reveal}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal project-cleanup-dialog';
  dialog.setAttribute('aria-labelledby','project-cleanup-title');
  dialog.innerHTML = `
    <div class="modal-header"><h2 id="project-cleanup-title">中间产物清理标记</h2><button type="button" class="icon-button" data-close aria-label="关闭"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <p class="project-cleanup-scope" dir="ltr" data-scope></p>
    <p class="modal-description">按文件夹名称查找缓存、代理素材与临时渲染。标记保存在本机，文件会留在原处。</p>
    <p data-status role="status"></p>
    <p class="muted" data-skipped hidden></p>
    <div class="project-cleanup-results" data-results aria-label="候选文件夹"></div>
    <div class="modal-footer"><button type="button" class="button subtle" data-refresh>重新检查</button><button type="button" class="button primary" data-done>完成</button></div>`;
  document.body.append(dialog);
  const scope = dialog.querySelector('[data-scope]');
  const status = dialog.querySelector('[data-status]');
  const skipped = dialog.querySelector('[data-skipped]');
  const results = dialog.querySelector('[data-results]');
  const refresh = dialog.querySelector('[data-refresh]');
  const stored = new Map();
  try {
    for (const [path,marks] of JSON.parse(localStorage.getItem(storageKey)) || []) {
      if (typeof path !== 'string' || !Array.isArray(marks)) continue;
      stored.set(path,marks.filter(mark => typeof mark === 'string').slice(0,pathLimit));
      if (stored.size >= projectLimit) break;
    }
  } catch {}
  let current;

  function summary(draft,didStore = true) {
    const marked = draft.candidates.filter(item => draft.marks.has(item.path));
    status.textContent = draft.candidates.length
      ? `${number.format(draft.candidates.length)} 个候选文件夹，已标记 ${number.format(marked.length)} 项${didStore ? '。' : '，无法在本机保存标记。'}`
      : '在检查范围内没有找到符合名称规则的文件夹。';
  }

  function save(draft) {
    stored.delete(draft.path);
    if (draft.marks.size) stored.set(draft.path,[...draft.marks].slice(-pathLimit));
    while (stored.size > projectLimit) stored.delete(stored.keys().next().value);
    try {
      localStorage.setItem(storageKey,JSON.stringify([...stored]));
      return true;
    } catch { return false; }
  }

  function render(draft,inventory) {
    draft.candidates = inventory.candidates || [];
    const skippedItems = [
      ['protected','受保护或隐藏'],['linkedOrMounted','链接或挂载位置'],
      ['offline','离线或需下载'],['unreadable','无法读取'],['depthLimit','超出目录深度'],
    ];
    const limits = skippedItems.filter(([key]) => inventory.skipped?.[key] > 0)
      .map(([key,label]) => label + ' ' + number.format(inventory.skipped[key]) + ' 项');
    if (inventory.truncated) limits.push('已达到检查上限');
    skipped.textContent = limits.length ? '检查时跳过：' + limits.join('、') + '。' : '';
    skipped.hidden = !limits.length;
    results.replaceChildren(...draft.candidates.map(item => {
      const row = document.createElement('div');
      row.className = 'project-cleanup-row';
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = draft.marks.has(item.path);
      const path = document.createElement('strong');
      path.dir = 'ltr';
      path.textContent = item.relativePath;
      label.append(check,path);
      check.addEventListener('change',() => {
        if (check.checked) draft.marks.add(item.path);
        else draft.marks.delete(item.path);
        summary(draft,save(draft));
      });
      const description = document.createElement('span');
      description.className = 'muted';
      const time = item.lastModified ? ' · ' + date.format(item.lastModified) : '';
      description.textContent = kinds[item.kind] + ' · ' + number.format(item.files) + ' 个文件 · ' +
        sizeText(item.bytes) + time + (item.partial ? ' · 统计不完整' : '');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'button subtle';
      open.textContent = '打开位置';
      open.setAttribute('aria-label','打开位置 ' + item.relativePath);
      open.addEventListener('click',() => {
        dialog.close();
        reveal(item.path);
      });
      row.append(label,description,open);
      return row;
    }));
    summary(draft);
  }

  async function scan(draft) {
    if (draft.loading) return;
    draft.loading = refresh.disabled = true;
    status.textContent = '正在检查项目文件夹…';
    results.replaceChildren();
    skipped.hidden = true;
    try {
      const inventory = await api('inspect_project_cleanup',{directoryPath:draft.path});
      if (current === draft && dialog.open) render(draft,inventory);
    } catch (failure) {
      if (current === draft && dialog.open) status.textContent = String(failure?.message || failure);
    } finally {
      draft.loading = false;
      if (current === draft) refresh.disabled = false;
    }
  }

  function show(path) {
    if (!path || dialog.open) return;
    scope.textContent = path;
    current = {path,marks:new Set(stored.get(path)),candidates:[],loading:false};
    dialog.showModal();
    void scan(current);
  }

  refresh.addEventListener('click',() => { if (current) void scan(current); });
  for (const button of dialog.querySelectorAll('[data-close],[data-done]'))
    button.addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => { if (!dialog.open) current = null; });
  return {show};
}
