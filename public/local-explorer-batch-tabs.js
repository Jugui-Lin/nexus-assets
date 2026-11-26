const maxPaths = 48;
const statuses = {
  directory:'可打开',duplicate:'重复路径',already:'已打开标签页',file:'不是文件夹',
  missing:'路径不存在',invalid:'无效路径',unavailable:'目前无法访问',
  network:'网络位置待核验',linked:'链接位置待核验',capacity:'超过当前标签页上限',
};

export function showExplorerBatchTabs({panel,active,probe,tabs,key,open}) {
  const owner = panel.ownerDocument;
  if (!active() || owner.querySelector('dialog[open]')) return false;
  const dialog = owner.createElement('dialog');
  dialog.className = 'modal explorer-batch-tabs';
  dialog.setAttribute('aria-labelledby','explorer-batch-tabs-title');
  dialog.innerHTML = `
    <form>
      <div class="modal-header"><h2 id="explorer-batch-tabs-title">从文本批量打开文件夹</h2><button type="button" class="icon-button" aria-label="关闭" data-close>×</button></div>
      <label>文件夹路径<textarea class="text-field" rows="4" maxlength="65536" placeholder="每行粘贴一个完整路径" dir="ltr" autofocus></textarea></label>
      <div class="explorer-batch-tabs-controls">
        <button type="button" class="button subtle" data-check>预览路径</button>
        <button type="button" class="button subtle" data-network hidden>核验网络和链接位置</button>
      </div>
      <p role="status"></p>
      <ul class="explorer-batch-tabs-list" data-results hidden></ul>
      <div class="modal-footer"><button type="button" class="button subtle" data-cancel>取消</button><button type="submit" class="button primary" disabled>打开标签页</button></div>
    </form>`;
  const find = selector => dialog.querySelector(selector);
  const field = find('textarea');
  const status = find('[role="status"]');
  const results = find('[data-results]');
  const submit = find('[type="submit"]');
  const check = find('[data-check]');
  const network = find('[data-network]');
  let revision = 0;
  let current = [];
  let extra = 0;
  let checking = false;

  function availability() {
    const available = tabs();
    const used = new Set();
    let slots = available.capacity;
    return current.map(row => {
      if (row.status !== 'directory') return row;
      const id = key(row.path);
      if (!id) return {...row,status:'invalid'};
      if (used.has(id)) return {...row,status:'duplicate'};
      used.add(id);
      if (available.paths.has(id) || available.paths.has(key(row.text))) return {...row,status:'already'};
      if (slots < 1) return {...row,status:'capacity'};
      slots--;
      return row;
    });
  }

  function render(message = '') {
    if (!dialog.open) return;
    const rows = availability();
    let ready = 0;
    let deferred = 0;
    results.replaceChildren(...rows.map(row => {
      if (row.status === 'directory') ready++;
      else if (row.status === 'network' || row.status === 'linked') deferred++;
      const item = owner.createElement('li');
      item.dataset.pathStatus = row.status;
      const value = owner.createElement('bdi');
      value.dir = 'ltr';
      value.textContent = row.text;
      if (row.path && row.path !== row.text) value.title = row.path;
      const feedback = owner.createElement('span');
      feedback.textContent = statuses[row.status] || statuses.invalid;
      item.append(value,feedback);
      return item;
    }));
    results.hidden = !rows.length;
    network.hidden = !deferred;
    network.disabled = checking;
    check.disabled = checking || !field.value.trim();
    submit.disabled = checking || !ready;
    submit.textContent = ready ? '打开 ' + ready + ' 个标签页' : '打开标签页';
    status.textContent = message || (rows.length ? ready + ' 项可打开' + (extra ? ' · 另有 ' + extra + ' 行超过核验上限' : '') : '');
  }

  async function verify(includeNetwork = false) {
    const serial = ++revision;
    const allPaths = field.value.split(/\r\n|\r|\n/u).map(line => line.trim()).filter(Boolean);
    if (!allPaths.length) return;
    extra = Math.max(0,allPaths.length - maxPaths);
    const candidates = includeNetwork ? current.filter(row => row.status === 'network' || row.status === 'linked') :
      allPaths.slice(0,maxPaths).map((text,index) => ({text,index,status:'unavailable'}));
    checking = true;
    render(includeNetwork ? '正在核验选中的网络或链接位置…' : '正在检查文件夹…');
    const valid = () => dialog.open && revision === serial && active();
    try {
      const checked = await probe({paths:candidates.map(row => row.text),allowNetwork:includeNetwork});
      if (!valid()) return;
      const updated = new Map(candidates.map(row => [row.index,row]));
      for (const result of checked || []) {
        const row = candidates[result.index];
        if (row) updated.set(row.index,{...row,status:result.status,path:result.path});
      }
      current = includeNetwork ? current.map(row => updated.get(row.index) || row) : [...updated.values()];
    } catch (failure) {
      if (!valid()) return;
      if (!includeNetwork) current = candidates;
      checking = false;
      render(String(failure?.message || failure));
      return;
    } finally {
      if (valid()) checking = false;
    }
    if (valid()) render();
  }

  field.addEventListener('input',() => {
    revision++;
    current = [];
    checking = false;
    render();
  });
  check.addEventListener('click',() => void verify());
  network.addEventListener('click',() => void verify(true));
  find('form').addEventListener('submit',event => {
    event.preventDefault();
    if (!active() || checking || submit.disabled) return;
    const paths = availability().filter(row => row.status === 'directory').map(row => row.path);
    if (!paths.length) { render(); return; }
    dialog.close();
    open(paths);
  });
  for (const button of [find('[data-cancel]'),find('[data-close]')])
    button.addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => { revision++; dialog.remove(); },{once:true});
  owner.body.append(dialog);
  dialog.showModal();
  render();
  return true;
}
