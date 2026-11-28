const resultLimit = 36;

export function initFolderAssetsPane({
  pane,trigger,dialog,load,directory,canOpenFolder,openFolder,search,resolve,thumbnail,locate,favorite,basket,assetItem,assetPathKey,report,
}) {
  const input = pane.querySelector('[data-folder-assets-search]');
  const status = pane.querySelector('[data-folder-assets-status]');
  const feedback = pane.querySelector('[data-folder-assets-feedback]');
  const results = pane.querySelector('[data-folder-assets-results]');
  const scope = pane.querySelector('[data-folder-assets-scope]');
  const folderScope = scope.querySelector('[value="folder"]');
  const openView = pane.querySelector('[data-folder-assets-open-view]');
  const controls = pane.querySelector('[data-material-controls]');
  const count = pane.querySelector('[data-material-count]');
  const chooser = pane.querySelector('[data-material-targets]');
  const choices = chooser.querySelector('select');
  const submit = chooser.querySelector('button');
  const owner = pane.ownerDocument;
  const anchor = owner.createComment('folder-materials-pane');
  pane.before(anchor);
  const selected = new Set();
  let known = new Set();
  let rows = [];
  let timer;
  let generation = 0;
  let opening = 0;
  let targetRequest = 0;
  let targetSnapshot;
  let visible = false;
  let ready = false;
  let preferredScope = scope.value;
  let shownDirectory;
  let opener;
  let locating = false;
  let dragging;
  const savingFavorites = new Set();

  const observer = new IntersectionObserver(entries => {
    for (const {target,isIntersecting} of entries) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      const row = rows.find(item => item.key === target.dataset.materialRow);
      if (!row) continue;
      const version = generation;
      Promise.resolve(thumbnail(row.item,row.asset)).then(url => {
        if (!url || generation !== version || !target.isConnected) return;
        target.querySelector('img').src = url;
        target.querySelector('img').hidden = false;
        target.querySelector('.folder-asset-fallback').hidden = true;
      }).catch(() => {});
    }
  }, {root:results,rootMargin:'60px'});

  function actionButton(action, label, icon, pressed) {
    const button = owner.createElement('button');
    button.type = 'button';
    button.className = 'folder-asset-action';
    button.dataset.materialAction = action;
    button.title = label;
    button.setAttribute('aria-label',label);
    if (pressed !== undefined) button.setAttribute('aria-pressed',String(pressed));
    const svg = owner.createElementNS('http://www.w3.org/2000/svg','svg');
    const use = owner.createElementNS(svg.namespaceURI,'use');
    use.setAttribute('href','#i-' + icon);
    svg.setAttribute('aria-hidden','true');
    svg.append(use);
    button.append(svg);
    return button;
  }

  function createRow(row) {
    const item = row.item;
    const asset = row.asset;
    const label = row.info?.name || item.name;
    const path = asset?.path || item.path || row.info?.origin || '';
    const element = owner.createElement('div');
    element.className = 'folder-asset-row';
    element.dataset.materialRow = row.key;
    if (asset) element.dataset.folderAssetRow = asset.id;
    if (row.staged) {
      element.dataset.materialStaged = '';
      element.draggable = true;
      const check = owner.createElement('input');
      check.type = 'checkbox';
      check.checked = selected.has(row.key);
      check.setAttribute('aria-label','选择「' + label + '」');
      element.append(check);
    }
    const card = owner.createElement('button');
    card.type = 'button';
    card.draggable = Boolean(asset && !row.staged);
    card.className = 'folder-asset-card';
    if (asset) card.dataset.folderAssetId = asset.id;
    card.setAttribute('aria-label','预览「' + label + '」');
    card.disabled = !row.info?.preview;
    const media = owner.createElement('span');
    media.className = 'folder-asset-thumbnail';
    const fallback = owner.createElement('span');
    fallback.className = 'folder-asset-fallback';
    fallback.textContent = String(asset?.ext || (item.isDirectory ? '目录' : label.includes('.') && label.split('.').at(-1)) || '文件').toUpperCase();
    const image = owner.createElement('img');
    image.alt = '';
    image.draggable = false;
    image.hidden = true;
    image.addEventListener('error',() => { image.hidden = true; fallback.hidden = false; },{once:true});
    media.append(fallback,image);
    const description = owner.createElement('span');
    description.className = 'folder-asset-label';
    const title = owner.createElement('span');
    title.className = 'folder-asset-name';
    title.textContent = label;
    const location = owner.createElement('small');
    location.className = 'folder-asset-path';
    location.title = path;
    location.textContent = path.split(/[/\\]/).filter(Boolean).slice(-2).join(' / ');
    description.append(title,location);
    card.append(media,description);
    element.append(card);
    if (row.info?.locate) {
      const go = actionButton('locate','定位「' + label + '」','locate');
      go.disabled = locating;
      element.append(go);
    }
    if (asset && favorite) {
      const star = actionButton('favorite',asset.favorite ? '取消收藏' : '收藏','star',Boolean(asset.favorite));
      star.disabled = savingFavorites.has(asset.id);
      element.append(star);
    }
    element.append(actionButton('stage',row.staged ? '移出暂存' : '暂存「' + label + '」','stack',row.staged));
    return element;
  }

  const currentSelection = () => rows.filter(row => row.staged && selected.has(row.key));
  function updateControls() {
    const selection = currentSelection();
    controls.hidden = !known.size;
    count.textContent = `已选 ${selection.length} 项`;
    for (const action of ['preview','board','c4d']) {
      controls.querySelector(`[data-material-command="${action}"]`).disabled = !selection.some(row => row.info?.[action]);
    }
    const all = basket().entries();
    const position = selection.length === 1 ? all.findIndex(row => row.key === selection[0].key) : -1;
    controls.querySelector('[data-material-command="up"]').disabled = position <= 0;
    controls.querySelector('[data-material-command="down"]').disabled = position < 0 || position === all.length - 1;
  }

  function render(resetScroll = false) {
    if (!visible) return;
    if (targetSnapshot && targetSnapshot.scopeKey !== basket().scope()) hideChooser();
    const focused = owner.activeElement.closest?.('[data-material-row]');
    const focusKey = focused?.dataset.materialRow;
    const focusAction = focused && owner.activeElement.dataset.materialAction;
    const focusIsCheckbox = focused && owner.activeElement.matches('input[type="checkbox"]');
    const previousScroll = results.scrollTop;
    generation++;
    observer.disconnect();
    shownDirectory = dialog.open ? null : directory();
    folderScope.disabled = !shownDirectory;
    scope.value = preferredScope === 'folder' && !shownDirectory ? 'library' : preferredScope;
    openView.disabled = !shownDirectory || !canOpenFolder(shownDirectory);
    const folder = scope.value === 'folder' ? shownDirectory : null;
    const staged = basket().entries();
    const keys = new Set(staged.map(entry => entry.key));
    for (const key of keys) if (!known.has(key)) selected.add(key);
    for (const key of selected) if (!keys.has(key)) selected.delete(key);
    known = keys;
    const pinned = staged.map(entry => {
      const info = basket().resolve(entry.item);
      return {...entry,asset:info?.asset,info,staged:true};
    });
    const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = pinned.filter(({item,asset,info}) => terms.every(term =>
      [item.name,item.path,info?.name,asset?.ext,asset?.subtitle,asset?.path,...(asset?.tags || [])].join(' ').toLowerCase().includes(term)));
    const stagedIds = new Set(pinned.map(row => row.asset?.id).filter(Boolean));
    const stagedPaths = new Set(pinned.map(row => assetPathKey(row.asset?.path || row.item.path)).filter(Boolean));
    const found = ready ? search(input.value,resultLimit + staged.length + 1,folder).filter(asset =>
      !stagedIds.has(asset.id) && (!asset.path || !stagedPaths.has(assetPathKey(asset.path)))) : [];
    const available = found.slice(0,resultLimit).map(asset => {
      const item = assetItem(asset);
      return {key:'asset:' + asset.id,asset,item,info:basket().resolve(item),staged:false};
    });
    rows = [...shown,...available];
    results.replaceChildren(...rows.map(createRow));
    for (const node of results.children) observer.observe(node);
    if (focusKey) {
      const row = [...results.children].find(node => node.dataset.materialRow === focusKey);
      const target = row?.querySelector(focusAction ? `[data-material-action="${focusAction}"]`
        : focusIsCheckbox ? 'input[type="checkbox"]' : '.folder-asset-card');
      if (target && !target.disabled) target.focus({preventScroll:true});
      else if (!row) input.focus({preventScroll:true});
    }
    results.scrollTop = resetScroll ? 0 : previousScroll;
    const stagedCount = staged.length ? `${shown.length} 项已暂存` : '';
    const availableCount = !ready ? '正在加载资产库…' : found.length > resultLimit
      ? `显示前 ${resultLimit} 项入库素材` : available.length ? `${available.length} 项入库素材` : '';
    status.textContent = [stagedCount,availableCount].filter(Boolean).join(' · ') ||
      (input.value.trim() ? '没有匹配的素材' : '拖入文件或在素材旁点暂存');
    updateControls();
  }

  function updateFeedback(message) {
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function hideChooser() {
    const wasChoosing = !chooser.hidden;
    targetRequest++;
    targetSnapshot = null;
    chooser.hidden = true;
    choices.replaceChildren();
    submit.disabled = true;
    if (wasChoosing) updateFeedback('');
  }

  function close({focus = true} = {}) {
    if (!visible) return;
    visible = false;
    opening++;
    generation++;
    clearTimeout(timer);
    observer.disconnect();
    hideChooser();
    rows = [];
    results.replaceChildren();
    updateFeedback('');
    pane.hidden = true;
    trigger.setAttribute('aria-expanded','false');
    if (dialog.open) dialog.close();
    anchor.after(pane);
    if (focus && opener?.isConnected) opener.focus({preventScroll:true});
  }

  async function show(asDialog = false, from = trigger) {
    if (visible && pane.parentElement === (asDialog ? dialog : anchor.parentElement)) return;
    if (visible) close({focus:false});
    if (asDialog && owner.querySelector('dialog[open]')) return;
    opener = from;
    if (asDialog) {
      dialog.append(pane);
      dialog.showModal();
    }
    visible = true;
    ready = false;
    known = new Set();
    selected.clear();
    const request = ++opening;
    pane.hidden = false;
    trigger.setAttribute('aria-expanded',String(!asDialog));
    input.focus({preventScroll:true});
    render(true);
    try {
      await load();
      if (!visible || opening !== request) return;
      ready = true;
      render();
      await basket().prepare();
    } catch (failure) {
      if (visible && opening === request) {
        status.textContent = '无法加载素材';
        report(failure);
      }
    }
  }

  function previewRows(items,lead,trigger) {
    const version = opening;
    const player = basket().preview(items.map(row => row.item),lead?.item);
    if (player?.open) player.addEventListener('close',() => {
      if (visible && opening === version) (trigger.isConnected ? trigger : input).focus({preventScroll:true});
    },{once:true});
  }

  async function chooseTarget(action) {
    hideChooser();
    const items = currentSelection().filter(row => row.info?.[action]).map(row => row.item);
    const scopeKey = basket().scope();
    if (!items.length) return;
    const version = ++targetRequest;
    targetSnapshot = {action,items,scopeKey};
    chooser.hidden = false;
    updateFeedback('正在读取目标…');
    try {
      const targets = await basket().targets(action,items);
      if (!visible || version !== targetRequest) return;
      if (scopeKey !== basket().scope()) return hideChooser();
      choices.replaceChildren(...targets.map(({id,name}) => new Option(name,id)));
      submit.disabled = !targets.length;
      updateFeedback(targets.length ? '' : action === 'board' ? '当前工作空间没有可用白板' : '没有可接收所选素材的 Cinema 4D');
      if (targets.length) choices.focus({preventScroll:true});
    } catch (failure) {
      if (version !== targetRequest) return;
      hideChooser();
      if (scopeKey === basket().scope()) report(failure);
    }
  }

  async function runRow(action,row,control) {
    if (action === 'stage') {
      hideChooser();
      if (row.staged) basket().remove([row]);
      else basket().add([row.item]);
      return;
    }
    const request = opening;
    if (action === 'locate' && !locating) {
      locating = true;
      try {
        const modal = dialog.open;
        if (modal) close({focus:false});
        const found = row.staged || modal ? await basket().locate(row.item) : await locate(row.asset);
        if (visible && request === opening) updateFeedback(found === false ? '未能选中原文件，请检查位置' : '已定位原文件');
      } finally {
        locating = false;
        if (visible) render();
      }
    } else if (action === 'favorite' && row.asset && !savingFavorites.has(row.asset.id)) {
      const {id,path} = row.asset;
      savingFavorites.add(id);
      control.disabled = true;
      try { await favorite({id,path,favorite:!row.asset.favorite}); }
      finally { savingFavorites.delete(id); if (visible) render(); }
    }
  }

  input.addEventListener('input',() => {
    clearTimeout(timer);
    hideChooser();
    timer = setTimeout(() => render(true),120);
  });
  input.addEventListener('keydown',event => {
    if (event.key !== 'Enter' || event.isComposing || event.repeat) return;
    event.preventDefault();
    clearTimeout(timer);
    render();
    const row = rows.find(item => item.info?.locate);
    if (row) void runRow('locate',row,input).catch(report);
  });
  scope.addEventListener('change',() => {
    preferredScope = scope.value;
    hideChooser();
    render(true);
  });
  openView.addEventListener('click',() => {
    const path = directory();
    if (canOpenFolder(path)) openFolder(path);
  });
  pane.querySelector('[data-folder-assets-close]').addEventListener('click',() => close());
  pane.addEventListener('keydown',event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (chooser.hidden) close();
      else hideChooser();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' &&
      !event.target.closest('select,textarea,input:not([type="checkbox"]),[contenteditable]')) {
      event.preventDefault();
      for (const row of rows) if (row.staged) selected.add(row.key);
      hideChooser();
      render();
    }
  });
  dialog.addEventListener('close',() => { if (!dialog.open && pane.parentElement === dialog) close(); });
  results.addEventListener('click',event => {
    const node = event.target.closest('[data-material-row]');
    const row = node && rows.find(item => item.key === node.dataset.materialRow);
    if (!row) return;
    const action = event.target.closest('[data-material-action]');
    if (action && !action.disabled) void runRow(action.dataset.materialAction,row,action).catch(report);
    else if (event.target.closest('.folder-asset-card') && row.info?.preview) {
      previewRows(rows.filter(item => !row.staged || item.staged),row,event.target.closest('.folder-asset-card'));
    }
  });
  results.addEventListener('change',event => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    const key = event.target.closest('[data-material-row]')?.dataset.materialRow;
    if (event.target.checked) selected.add(key);
    else selected.delete(key);
    hideChooser();
    updateControls();
  });
  results.addEventListener('dragstart',event => {
    const handle = event.target.closest('[data-material-staged]');
    if (!handle || event.target.closest('button,input')) return;
    dragging = handle.dataset.materialRow;
    event.dataTransfer.setData('application/x-nexus-material-order','1');
    event.dataTransfer.effectAllowed = 'move';
  });
  results.addEventListener('dragover',event => {
    if (dragging && event.target.closest('[data-material-staged]')) event.preventDefault();
  });
  results.addEventListener('drop',event => {
    if (!dragging) return;
    event.preventDefault();
    const key = event.target.closest('[data-material-staged]')?.dataset.materialRow;
    basket().move(rows.find(row => row.key === dragging),rows.find(row => row.key === key));
    dragging = null;
  });
  results.addEventListener('dragend',() => { dragging = null; });
  controls.addEventListener('click',event => {
    const command = event.target.closest('[data-material-command]');
    if (!command || command.disabled) return;
    const action = command.dataset.materialCommand;
    if (action === 'board' || action === 'c4d') void chooseTarget(action);
    else if (action === 'preview') previewRows(currentSelection(),null,command);
    else if (action === 'clear') { hideChooser(); basket().clear(); }
    else {
      const [row] = currentSelection();
      const all = basket().entries();
      const index = all.findIndex(entry => entry.key === row?.key);
      hideChooser();
      basket().move(row,all[index + (action === 'up' ? -1 : 1)]);
    }
  });
  submit.addEventListener('click',() => {
    const destination = choices.value;
    const request = targetSnapshot;
    if (!destination || !request) return;
    if (request.scopeKey !== basket().scope()) return hideChooser();
    const current = currentSelection().filter(row => row.info?.[request.action]).map(row => row.item);
    if (current.length !== request.items.length || current.some((item,index) => item !== request.items[index])) {
      hideChooser();
      updateFeedback('暂存选择已变化，请重新选择发送目标');
      return;
    }
    hideChooser();
    if (request.action === 'c4d' && dialog.open) close({focus:false});
    void basket().send(request.action,request.items,destination).catch(report);
  });

  return {
    toggle:() => visible && !dialog.open ? close() : show(),
    show,
    hide:close,
    refresh:render,
    refreshBasket() { if (visible) { render(); void basket().prepare().catch(() => {}); } },
    updateLocation() { if (visible && !dialog.open && shownDirectory !== directory()) render(true); },
    dragSource(target) {
      const card = target.closest('[data-folder-asset-id]');
      if (!visible || dialog.open || !card || !pane.contains(card) || card.closest('[data-material-staged]')) return null;
      const asset = resolve(card.dataset.folderAssetId);
      if (!asset) return null;
      return {element:card,paths:[asset.path],forceCopy:true,valid:() => resolve(asset.id)?.path === asset.path};
    },
  };
}
