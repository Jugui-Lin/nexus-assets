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

function referenceKey(item) {
  return JSON.stringify(item.kind === 'asset' ? ['asset',item.scope,item.id] : ['file',item.path]);
}

export function initTemporaryAssetBasket({dialog,scope,mount,resolve,targets,send,open,report}) {
  const owner = dialog.ownerDocument;
  const storage = owner.defaultView.localStorage;
  const list = dialog.querySelector('[data-basket-list]');
  const status = dialog.querySelector('[data-basket-status]');
  const chooser = dialog.querySelector('[data-basket-targets]');
  const choices = chooser.querySelector('select');
  const chooserSubmit = chooser.querySelector('[data-basket-send]');
  const selected = new Set();
  function read() {
    try {
      const stored = JSON.parse(storage.getItem(storageKey));
      if (Array.isArray(stored)) {
        const distinct = new Map();
        for (const item of stored.map(reference).filter(Boolean).slice(0,limit)) distinct.set(referenceKey(item),item);
        return [...distinct.values()];
      }
    } catch {}
    return [];
  }
  let items = read();
  let opener;
  let selectedTarget;
  let chooserVersion = 0;
  let dragging;
  let externalAction = false;

  const visibleItems = () => items.filter(item => item.kind === 'file' || item.scope === scope());
  const selection = () => visibleItems().filter(item => selected.has(referenceKey(item)));
  const labelFor = item => resolve(item)?.name || item.name;

  function save() {
    try { storage.setItem(storageKey,JSON.stringify(items)); } catch {}
  }

  function hideChooser() {
    chooserVersion++;
    selectedTarget = null;
    chooser.hidden = true;
    choices.replaceChildren();
    chooserSubmit.disabled = true;
  }

  function rowButton(action,label,disabled = false) {
    const button = owner.createElement('button');
    button.type = 'button';
    button.dataset.basketAction = action;
    button.textContent = label;
    button.disabled = disabled;
    return button;
  }

  function updateButtons() {
    const rows = selection();
    for (const action of ['board','c4d']) dialog.querySelector(`[data-basket-action="${action}"]`).disabled =
      !rows.some(item => resolve(item)?.[action]);
    dialog.querySelector('[data-basket-action="clear"]').disabled = !visibleItems().length;
  }

  function paint() {
    const visible = visibleItems();
    list.replaceChildren(...visible.map((item,index) => {
      const key = referenceKey(item);
      const result = resolve(item);
      const row = owner.createElement('li');
      row.dataset.basketItem = key;
      row.draggable = true;
      const check = owner.createElement('input');
      check.type = 'checkbox';
      check.checked = selected.has(key);
      check.setAttribute('aria-label','选中 ' + labelFor(item));
      const description = owner.createElement('div');
      const title = owner.createElement('strong');
      title.textContent = labelFor(item);
      const origin = owner.createElement('small');
      origin.textContent = item.kind === 'file' ? item.path : result?.origin || '当前目录库中的资产引用';
      origin.dir = item.kind === 'file' ? 'ltr' : 'auto';
      description.append(title,origin);
      const controls = owner.createElement('div');
      controls.className = 'temporary-basket-row-actions';
      controls.append(rowButton('preview','预览',!result?.preview),rowButton('locate','定位',!result?.locate),
        rowButton('up','上移',index === 0),rowButton('down','下移',index === visible.length - 1),rowButton('remove','移除'));
      row.append(check,description,controls);
      return row;
    }));
    if (!visible.length) status.textContent = '素材篮为空。可从文件夹或资产卡片的右键菜单加入引用。';
    else status.textContent = visible.length + ' 项引用';
    updateButtons();
  }

  function add(references) {
    const used = new Set(items.map(referenceKey));
    let added = 0;
    for (const source of references) {
      const item = reference(source);
      if (!item || used.has(referenceKey(item)) || items.length === limit) continue;
      used.add(referenceKey(item));
      items.push(item);
      added++;
    }
    if (added) save();
    if (dialog.open) paint();
    report(added ? '已加入素材篮 ' + added + ' 项' : items.length >= limit ? '素材篮已满' : '素材已在篮中');
    return added;
  }

  owner.defaultView.addEventListener('storage',event => {
    if (event.storageArea !== storage || event.key !== storageKey) return;
    items = read();
    if (dialog.open) { hideChooser(); paint(); }
  });

  function move(from,to) {
    const a = items.indexOf(from);
    const b = items.indexOf(to);
    if (a < 0 || b < 0 || a === b) return;
    items.splice(b,0,items.splice(a,1)[0]);
    save();
    hideChooser();
    paint();
  }

  function closeForAction() {
    externalAction = true;
    dialog.close();
  }

  async function chooseTarget(action) {
    hideChooser();
    const rows = selection().filter(item => resolve(item)?.[action]);
    if (!rows.length) return;
    const collection = scope();
    const version = ++chooserVersion;
    chooser.hidden = false;
    status.textContent = '正在读取目标…';
    try {
      const result = await targets(action,rows,collection);
      if (version !== chooserVersion || !dialog.open || collection !== scope()) return;
      selectedTarget = {action,rows,collection};
      choices.replaceChildren(...result.map(({id,name}) => new Option(name,id)));
      chooserSubmit.disabled = !result.length;
      if (result.length) { status.textContent = '选择目标'; choices.focus({preventScroll:true}); }
      else status.textContent = action === 'board' ? '当前工作区没有可用的白板项目。' : '当前没有能接收所选素材的 Cinema 4D。';
    } catch (failure) {
      if (version === chooserVersion) status.textContent = String(failure?.message || failure);
    }
  }

  dialog.addEventListener('click',event => {
    const button = event.target.closest('[data-basket-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.basketAction;
    if (action === 'close') { dialog.close(); return; }
    if (action === 'board' || action === 'c4d') { void chooseTarget(action); return; }
    const visible = visibleItems();
    if (action === 'clear') {
      const remove = new Set(visible);
      items = items.filter(item => !remove.has(item));
      selected.clear();
      save();
      hideChooser();
      paint();
      return;
    }
    const key = button.closest('[data-basket-item]')?.dataset.basketItem;
    const index = visible.findIndex(item => referenceKey(item) === key);
    const item = visible[index];
    if (!item) return;
    if (action === 'up' || action === 'down') {
      move(item,visible[index + (action === 'up' ? -1 : 1)]);
      [...list.children].find(row => row.dataset.basketItem === key)?.querySelector(`[data-basket-action="${action}"]:not(:disabled)`)?.focus();
    } else if (action === 'remove') {
      items.splice(items.indexOf(item),1);
      selected.delete(key);
      save();
      hideChooser();
      paint();
    } else if (action === 'preview' || action === 'locate') {
      closeForAction();
      void Promise.resolve().then(() => open(action,item)).catch(failure => report(String(failure?.message || failure),true));
    }
  });
  list.addEventListener('change',event => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    const key = event.target.closest('[data-basket-item]')?.dataset.basketItem;
    if (event.target.checked) selected.add(key);
    else selected.delete(key);
    hideChooser();
    updateButtons();
  });
  list.addEventListener('dragstart',event => {
    dragging = event.target.closest('[data-basket-item]')?.dataset.basketItem;
    if (dragging) { event.dataTransfer.setData('application/x-nexus-basket-reorder','1'); event.dataTransfer.effectAllowed = 'move'; }
  });
  list.addEventListener('dragover',event => { if (dragging && event.target.closest('[data-basket-item]')) event.preventDefault(); });
  list.addEventListener('drop',event => {
    if (!dragging) return;
    event.preventDefault();
    const target = event.target.closest('[data-basket-item]')?.dataset.basketItem;
    const visible = visibleItems();
    move(visible.find(item => referenceKey(item) === dragging),visible.find(item => referenceKey(item) === target));
    dragging = null;
  });
  list.addEventListener('dragend',() => { dragging = null; });
  chooserSubmit.addEventListener('click',() => {
    const destination = choices.value;
    const snapshot = selectedTarget;
    if (!destination || !snapshot || snapshot.collection !== scope()) return;
    closeForAction();
    void Promise.resolve().then(() => send(snapshot.action,snapshot.rows,destination,snapshot.collection))
      .catch(failure => report(String(failure?.message || failure),true));
  });
  dialog.addEventListener('close',() => {
    hideChooser();
    if (!externalAction && opener?.isConnected) opener.focus({preventScroll:true});
    externalAction = false;
  });

  return {
    add,
    show(trigger) {
      if (dialog.open || owner.querySelector('dialog[open]')) return;
      opener = trigger || owner.activeElement;
      selected.clear();
      for (const item of visibleItems()) selected.add(referenceKey(item));
      const openingScope = scope();
      paint();
      dialog.showModal();
      void Promise.resolve().then(mount).then(() => {
        if (!dialog.open) return;
        if (openingScope !== scope()) {
          selected.clear();
          for (const item of visibleItems()) selected.add(referenceKey(item));
        }
        paint();
      }).catch(() => {});
    },
  };
}
