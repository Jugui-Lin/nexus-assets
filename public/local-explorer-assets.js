const batchSize = 48;
const cacheLimit = 4096;
const searchResultLimit = 40;

export function initExplorerAssets({scroller,tbody,lookup,pathKey,isActive,paint,onChange}) {
  const view = scroller.ownerDocument.defaultView;
  const cache = new Map();
  const rows = new Map();
  const visible = new Set();
  const pending = new Map();
  let currentEntries;
  let firstRow;
  let revision = 0;
  let timer;
  let running = false;
  let available = false;

  if (!lookup || !view.IntersectionObserver) return {
    observe() {}, refresh() {}, get() {}, update() {},
  };

  function remember(key,value) {
    cache.delete(key);
    cache.set(key,value);
    if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  }

  function render(row,record,asset) {
    if (!row.isConnected || Object.is(record.asset,asset)) return;
    record.asset = asset;
    paint(row,record.entry,asset);
  }

  function schedule() {
    if (timer != null || running || !pending.size || !isActive()) return;
    timer = view.setTimeout(flush,32);
  }

  async function flush() {
    timer = undefined;
    if (!pending.size || !isActive()) return;
    const requestRevision = revision;
    const batch = [...pending.entries()].slice(0,batchSize);
    for (const [key] of batch) pending.delete(key);
    running = true;
    try {
      const result = await lookup(batch.map(([,path]) => path));
      if (revision !== requestRevision || !Array.isArray(result) || result.length !== batch.length) return;
      available = true;
      const applied = new Map();
      for (const [index,[key]] of batch.entries()) {
        const asset = result[index];
        if (asset !== null && (typeof asset?.id !== 'string' || !asset.id)) continue;
        applied.set(key,asset);
        remember(key,asset);
      }
      for (const row of visible) {
        const record = rows.get(row);
        if (record && applied.has(record.key)) render(row,record,applied.get(record.key));
      }
      onChange();
    } catch {
      // A catalog read failure leaves status unknown until the next refresh or visit.
    } finally {
      running = false;
      schedule();
    }
  }

  function request(row) {
    const record = rows.get(row);
    if (!record) return;
    if (cache.has(record.key)) render(row,record,cache.get(record.key));
    else pending.set(record.key,record.entry.path);
  }

  const observer = new view.IntersectionObserver(intersections => {
    for (const {target,isIntersecting} of intersections) {
      const record = rows.get(target);
      if (!record) continue;
      if (isIntersecting && !target.hidden) {
        visible.add(target);
        request(target);
      } else {
        visible.delete(target);
        pending.delete(record.key);
      }
    }
    schedule();
  },{root:scroller,rootMargin:'80px 0px'});

  function observe(entries,enabled) {
    const first = enabled ? tbody.firstElementChild : null;
    if (first === firstRow && entries === currentEntries) { schedule(); return; }
    currentEntries = entries;
    firstRow = first;
    observer.disconnect();
    visible.clear();
    pending.clear();
    rows.clear();
    if (!first || !entries) return;
    for (const row of tbody.querySelectorAll('[data-entry-index]')) {
      const entry = entries[Number(row.dataset.entryIndex)];
      if (!entry?.path || entry.isDirectory) continue;
      const key = pathKey(entry.path);
      if (!key) continue;
      const record = {entry,key,asset:undefined};
      rows.set(row,record);
      if (cache.has(key)) render(row,record,cache.get(key));
      observer.observe(row);
    }
  }

  function refresh() {
    revision++;
    cache.clear();
    pending.clear();
    for (const [row,record] of rows) render(row,record,undefined);
    for (const row of visible) request(row);
    onChange();
    schedule();
  }

  return {
    observe,refresh,
    get available() { return available; },
    get revision() { return revision; },
    get(path) { return cache.get(pathKey(path)); },
    update(path,asset,requestRevision) {
      if (requestRevision !== revision) return;
      const key = pathKey(path);
      remember(key,asset);
      for (const [row,record] of rows) {
        if (record.key === key) render(row,record,asset);
      }
      onChange();
    },
  };
}

export function initExplorerCatalogSearch({pane,search,pathKey,openFile,openAsset,icon}) {
  if (!pane || !search) return {set() {},refresh() {},retry() {}};
  const status = pane.querySelector('[data-explorer-catalog-status]');
  const list = pane.querySelector('[data-explorer-catalog-results]');
  const owner = pane.ownerDocument;
  let current;
  let result;
  let failure;
  let pending;
  let refreshAfterSearch = false;
  let displayed;

  function paint() {
    pane.hidden = !current;
    if (!current) {
      list.replaceChildren();
      status.textContent = '';
      displayed = undefined;
      return;
    }
    pane.setAttribute('aria-busy',String(Boolean(pending)));
    const {directoryEntries} = current;
    if (displayed && result === displayed.result && directoryEntries === displayed.directoryEntries && failure === displayed.failure &&
        pending === displayed.pending) return;
    displayed = {result,directoryEntries,failure,pending};
    if (!result || failure) {
      list.replaceChildren();
      status.textContent = failure || '正在搜索资产库…';
      return;
    }
    const paths = new Set(directoryEntries?.map(entry => pathKey(entry.path)).filter(Boolean));
    const rows = [];
    let duplicateCount = 0;
    for (const asset of result.results) {
      if (!asset || typeof asset.path !== 'string' || typeof asset.name !== 'string') continue;
      const key = pathKey(asset.path);
      if (!key) continue;
      if (paths.has(key)) { duplicateCount++; continue; }
      paths.add(key);
      rows.push(asset);
      if (rows.length >= searchResultLimit) break;
    }
    list.replaceChildren(...rows.map(asset => {
      const row = owner.createElement('li');
      const source = owner.createElement('button');
      source.type = 'button';
      source.className = 'local-explorer-catalog-source';
      source.title = asset.path;
      const name = owner.createElement('span');
      name.className = 'local-explorer-catalog-name';
      name.textContent = asset.name;
      const path = owner.createElement('span');
      path.className = 'local-explorer-catalog-path';
      path.textContent = asset.path;
      const text = owner.createElement('span');
      text.append(name,path);
      source.append(icon('notes'),text);
      source.addEventListener('click',() => openFile(asset));
      row.append(source);
      if (openAsset) {
        const locate = owner.createElement('button');
        locate.type = 'button';
        locate.className = 'explorer-icon-button local-explorer-catalog-locate';
        locate.title = '在资产库中查看';
        locate.setAttribute('aria-label','在资产库中查看 ' + asset.name);
        locate.append(icon('locate'));
        locate.addEventListener('click',() => openAsset(asset));
        row.append(locate);
      }
      return row;
    }));
    const summary = rows.length ? rows.length + ' 项' : duplicateCount ? '匹配项已在目录结果中显示' : '没有找到匹配的入库素材';
    status.textContent = summary + (result.truncated ? ' · 仅显示部分资产结果，缩小范围可继续查找' : '');
  }

  function start() {
    if (!current) return;
    const token = {};
    const query = current.query;
    pending = token;
    failure = '';
    paint();
    Promise.resolve().then(() => search({query,limit:searchResultLimit})).then(value => {
      if (pending !== token) return;
      if (!Array.isArray(value?.results)) throw Error('无法读取资产搜索结果');
      result = {results:value.results.slice(0,searchResultLimit),truncated:value.truncated || value.results.length > searchResultLimit};
    }).catch(error => {
      if (pending !== token) return;
      result = undefined;
      failure = String(error?.message || '无法搜索资产库');
    }).finally(() => {
      if (pending !== token) return;
      pending = undefined;
      paint();
      if (refreshAfterSearch) {
        refreshAfterSearch = false;
        start();
      }
    });
  }

  return {
    set(next) {
      if (!next) {
        if (!current) return;
        current = result = pending = undefined;
        failure = '';
        refreshAfterSearch = false;
        paint();
        return;
      }
      const changed = !current || current.tab !== next.tab || current.query !== next.query;
      current = next;
      if (changed) {
        result = undefined;
        refreshAfterSearch = false;
        start();
      } else paint();
    },
    refresh() {
      if (!current) return;
      if (pending) refreshAfterSearch = true;
      else start();
    },
    retry() { if (failure && !pending) start(); },
  };
}
