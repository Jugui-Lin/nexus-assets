const storageKey = 'nexus-temporary-asset-basket-v1';
const limit = 160;

function reference(item) {
  if (typeof item?.name !== 'string' || !item.name.trim()) return null;
  const name = item.name.slice(0,500);
  if (item.kind === 'asset' && typeof item.id === 'string' && item.id && typeof item.scope === 'string' && item.scope)
    return {kind:'asset',scope:item.scope,id:item.id,name};
  if (item.kind === 'file' && typeof item.path === 'string' && item.path && item.path.length <= 8192)
    return {kind:'file',path:item.path,name,isDirectory:Boolean(item.isDirectory)};
  return null;
}

function storedKey(item) {
  return JSON.stringify(item.kind === 'asset' ? ['asset',item.scope,item.id] : ['file',item.path]);
}

export function initTemporaryAssetBasket({scope,pathKey,mount,resolve,targets,send,preview,locate,report,triggers = []}) {
  const storage = window.localStorage;
  const subscribers = new Set();
  const badgeTriggers = triggers.map(button => ({button,label:button.textContent.trim()}));
  let items = read();
  let displayedCount;

  function read() {
    try {
      const stored = JSON.parse(storage.getItem(storageKey));
      if (!Array.isArray(stored)) return [];
      return [...new Map(stored.map(reference).filter(Boolean).slice(0,limit).map(item => [storedKey(item),item])).values()];
    } catch {
      return [];
    }
  }

  function visible() {
    const activeScope = scope();
    return items.filter(item => item.kind === 'file' || item.scope === activeScope);
  }

  function identity(item) {
    const path = pathKey(item);
    return path ? JSON.stringify(['path',path]) : storedKey(item);
  }

  function entries() {
    const grouped = new Map();
    for (const item of visible()) {
      const key = identity(item);
      const existing = grouped.get(key);
      if (!existing) grouped.set(key,{key:storedKey(item),item,members:[item]});
      else {
        existing.members.push(item);
        if (item.kind === 'asset') existing.item = item;
      }
    }
    return [...grouped.values()];
  }

  function refreshCount() {
    const count = entries().length;
    if (count === displayedCount) return;
    displayedCount = count;
    for (const {button,label} of badgeTriggers) {
      if (count) button.dataset.basketCount = String(count);
      else delete button.dataset.basketCount;
      button.setAttribute('aria-label',count ? `${label} · ${count} 项已暂存` : label);
    }
  }

  function changed() {
    refreshCount();
    for (const subscriber of subscribers) subscriber();
  }

  function save() {
    try { storage.setItem(storageKey,JSON.stringify(items)); } catch {}
    changed();
  }

  async function prepare() {
    await mount(visible());
    changed();
  }

  function add(references) {
    const count = entries().length;
    const exact = new Set(items.map(storedKey));
    const equivalent = new Map(visible().map(item => [identity(item),item]));
    let saved = false;
    for (const source of references) {
      const item = reference(source);
      if (!item || exact.has(storedKey(item)) || items.length >= limit) continue;
      const key = identity(item);
      const previous = equivalent.get(key);
      // Keep a file reference available across workspaces if it was explicitly staged from Files.
      if (previous && (item.kind === 'asset' || previous.kind === 'file')) continue;
      exact.add(storedKey(item));
      equivalent.set(key,item);
      items.push(item);
      saved = true;
    }
    if (saved) save();
    const added = entries().length - count;
    report(added ? `已暂存 ${added} 项` : items.length >= limit ? '暂存已满' : '素材已暂存');
    return added;
  }

  function remove(removeEntries) {
    const remove = new Set(removeEntries.flatMap(entry => entry.members));
    if (!remove.size) return;
    items = items.filter(item => !remove.has(item));
    save();
  }

  function move(from,to) {
    if (!from || !to || from.key === to.key) return;
    const fromIndex = items.indexOf(from.members[0]);
    const toIndex = items.indexOf(to.members[0]);
    if (fromIndex < 0 || toIndex < 0) return;
    const moving = new Set(from.members);
    items = items.filter(item => !moving.has(item));
    const anchor = items.indexOf(to.members[0]);
    items.splice(anchor + Number(fromIndex < toIndex),0,...from.members);
    save();
  }

  window.addEventListener('storage',event => {
    if (event.storageArea !== storage || (event.key !== null && event.key !== storageKey)) return;
    items = read();
    changed();
  });

  return {
    add,clear:() => remove(entries()),entries,move,prepare,refreshCount,remove,resolve,
    subscribe(listener) { subscribers.add(listener); },
    preview:(items,lead) => preview(items,lead,scope()),
    locate,
    targets:(action,items) => targets(action,items,scope()),
    send:(action,items,destination) => send(action,items,destination,scope()),
    scope,
  };
}
