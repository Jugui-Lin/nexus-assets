const prefix = 'nexus-favorite-expiry-v1:';
const day = 24 * 60 * 60 * 1000;

export function initFavoriteExpiry({scope,ensureFavorite,refresh}) {
  const dialog = document.getElementById('favorite-expiry-dialog');
  const form = dialog.querySelector('form');
  const duration = form.elements.duration;
  const project = form.elements.project;
  const status = dialog.querySelector('[data-favorite-expiry-status]');
  const filterToggle = document.getElementById('asset-favorites-toggle');
  const filterLabel = filterToggle.querySelector('span');
  const toolbar = document.getElementById('favorite-expiry-tools');
  const projectFilter = toolbar.querySelector('select');
  const historyFilter = toolbar.querySelector('button');
  let activeScope, records = new Map(), selectedProject = '', history = false;
  let timer = 0;
  let draft, working = false;

  function load() {
    const next = new Map();
    try {
      const rows = JSON.parse(localStorage.getItem(prefix + activeScope));
      if (Array.isArray(rows)) for (const row of rows.slice(0,10000)) {
        const [id,data] = Array.isArray(row) ? row : [];
        if (typeof id !== 'string' || id.length > 256 || !data || typeof data.project !== 'string' ||
            data.project.length > 80 || !Number.isSafeInteger(data.expires) || data.expires < 0) continue;
        next.set(id,data);
      }
    } catch {}
    records = next;
  }

  function schedule() {
    clearTimeout(timer);
    const now = Date.now();
    let nearest = Infinity;
    for (const item of records.values()) if (item.expires > now) nearest = Math.min(nearest,item.expires);
    if (nearest === Infinity) return;
    timer = setTimeout(() => { refresh(); schedule(); },Math.min(2 ** 31 - 1,Math.max(50,nearest - now + 15)));
  }

  function sync() {
    const next = scope();
    if (next === activeScope) return;
    activeScope = next;
    history = false;
    try { selectedProject = (localStorage.getItem(prefix + activeScope + ':project') || '').slice(0,80); }
    catch { selectedProject = ''; }
    load();
    schedule();
  }

  function save(id,record) {
    sync();
    const next = new Map(records);
    if (record?.expires || record?.project) next.set(id,record);
    else next.delete(id);
    if (next.size > 10000) throw Error('临时收藏设置已达到上限。');
    localStorage.setItem(prefix + activeScope,JSON.stringify([...next]));
    records = next;
    schedule();
  }

  function record(id) {
    sync();
    return records.get(id);
  }

  const isExpired = (item,now) => Boolean(item?.expires && item.expires <= now);
  function matches(asset,now = Date.now()) {
    if (!asset.favorite) return false;
    const item = record(asset.id);
    return isExpired(item,now) === history && (!selectedProject || item?.project === selectedProject);
  }

  function render(visible,assets) {
    sync();
    filterToggle.hidden = !visible;
    toolbar.hidden = !visible;
    if (!visible) return;
    const label = history ? '到期历史' : selectedProject || '收藏筛选';
    filterLabel.textContent = label;
    filterToggle.title = label === '收藏筛选' ? label : '收藏筛选 · ' + label;
    filterToggle.setAttribute('aria-label',filterToggle.title);
    filterToggle.classList.toggle('is-active',history || Boolean(selectedProject));
    const projects = new Set();
    let expired = 0;
    const now = Date.now();
    for (const asset of assets) {
      if (!asset.favorite) continue;
      const item = records.get(asset.id);
      if (item?.project) projects.add(item.project);
      if (isExpired(item,now) && (!selectedProject || item.project === selectedProject)) expired++;
    }
    if (selectedProject) projects.add(selectedProject);
    const projectNames = [...projects].sort((a,b) => a.localeCompare(b,'zh-CN'));
    const expected = ['',...projectNames];
    if (projectFilter.options.length !== expected.length ||
        expected.some((name,index) => name !== projectFilter.options[index]?.value)) {
      projectFilter.replaceChildren(new Option('全部项目',''),...projectNames.map(name => new Option(name,name)));
    }
    projectFilter.value = selectedProject;
    historyFilter.textContent = history ? '返回当前收藏' : '到期历史' + (expired ? ' ' + expired : '');
    historyFilter.setAttribute('aria-pressed',String(history));
  }

  function show(asset) {
    if (!asset || dialog.open || working) return;
    const existing = record(asset.id);
    draft = {id:asset.id, scope:activeScope};
    dialog.querySelector('[data-favorite-expiry-asset]').textContent = asset.name;
    project.value = existing?.project || selectedProject;
    duration.querySelector('[value="keep"]').disabled = !existing?.expires || isExpired(existing,Date.now());
    duration.value = existing?.expires
      ? duration.querySelector('[value="keep"]').disabled ? '7' : 'keep'
      : asset.favorite ? '0' : '7';
    status.textContent = existing?.expires ? '原到期时间 ' + new Date(existing.expires).toLocaleString() : '';
    dialog.showModal();
  }

  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (!draft || working || draft.scope !== scope()) return;
    const before = record(draft.id);
    const name = project.value.trim();
    const days = duration.value;
    const expires = days === 'keep' ? before?.expires || 0 : days === '0' ? 0 : Date.now() + Number(days) * day;
    const update = {project:name,expires};
    if (!Number.isSafeInteger(expires) || name.length > 80) return;
    working = true;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      save(draft.id,update);
      try { await ensureFavorite(draft.id,draft.scope); }
      catch (error) {
        if (draft.scope === scope()) save(draft.id,before);
        throw error;
      }
      if (draft.scope !== scope()) return;
      dialog.close();
      refresh();
    } catch (error) { status.textContent = error.message || String(error); }
    finally { working = false; button.disabled = false; }
  });
  dialog.addEventListener('cancel',event => { if (working) event.preventDefault(); });
  form.querySelector('[data-favorite-expiry-close]').addEventListener('click',() => { if (!working) dialog.close(); });
  projectFilter.addEventListener('change',() => {
    selectedProject = projectFilter.value;
    try { localStorage.setItem(prefix + activeScope + ':project',selectedProject); } catch {}
    refresh();
  });
  historyFilter.addEventListener('click',() => { history = !history; refresh(); });
  window.addEventListener('storage',event => {
    if (event.key !== prefix + scope()) return;
    sync();
    load();
    schedule();
    refresh();
  });
  return {
    show,
    matches,
    record,
    render,
    expired(asset,now) { return isExpired(record(asset.id),now); },
    remove(id) { try { if (record(id)) save(id,null); } catch {} },
    get history() { return history; },
  };
}
