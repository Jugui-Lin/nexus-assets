const resultLimit = 36;

export function initFolderAssetsPane({
  pane,trigger,load,directory,canOpenFolder,openFolder,search,resolve,thumbnail,preview,locate,favorite,report,
}) {
  if (!pane || !trigger) return null;
  const input = pane.querySelector('[data-folder-assets-search]');
  const status = pane.querySelector('[data-folder-assets-status]');
  const feedback = pane.querySelector('[data-folder-assets-feedback]');
  const results = pane.querySelector('[data-folder-assets-results]');
  const scope = pane.querySelector('[data-folder-assets-scope]');
  const folderScope = scope.querySelector('[value="folder"]');
  const openView = pane.querySelector('[data-folder-assets-open-view]');
  const owner = pane.ownerDocument;
  let timer;
  let generation = 0;
  let visible = false;
  let ready = false;
  let shownDirectory = null;
  let preferredScope = scope.value;
  let displayedIds = [];
  let opening = 0;
  let locating = false;
  const savingFavorites = new Set();

  const observer = new IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      const version = generation;
      const asset = resolve(target.dataset.folderAssetId);
      if (!asset) continue;
      const image = target.querySelector('img');
      Promise.resolve(thumbnail(asset)).then(url => {
        if (url && generation === version && target.isConnected) {
          image.src = url;
          image.hidden = false;
          target.querySelector('.folder-asset-fallback').hidden = true;
        }
      }).catch(() => {});
    }
  }, {root:results, rootMargin:'60px'});

  function actionButton(action, asset, label, icon) {
    const button = owner.createElement('button');
    button.type = 'button';
    button.className = 'folder-asset-action';
    button.dataset.folderAssetAction = action;
    button.title = label;
    button.setAttribute('aria-label',label + '「' + asset.name + '」');
    const svg = owner.createElementNS('http://www.w3.org/2000/svg','svg');
    const use = owner.createElementNS(svg.namespaceURI,'use');
    svg.setAttribute('aria-hidden','true');
    use.setAttribute('href','#i-' + icon);
    svg.append(use);
    button.append(svg);
    if (action === 'favorite') {
      button.setAttribute('aria-pressed',String(Boolean(asset.favorite)));
      button.disabled = savingFavorites.has(asset.id);
    } else button.disabled = locating;
    return button;
  }

  function render(resetScroll = false) {
    if (!visible || !ready) return;
    const focus = owner.activeElement.closest?.('[data-folder-asset-row]');
    const focusedId = focus?.dataset.folderAssetRow;
    const focusedAction = focus && owner.activeElement.dataset.folderAssetAction;
    const previousScroll = results.scrollTop;
    generation++;
    observer.disconnect();
    shownDirectory = directory();
    folderScope.disabled = !shownDirectory;
    scope.value = preferredScope === 'folder' && !shownDirectory ? 'library' : preferredScope;
    const folder = scope.value === 'folder' ? shownDirectory : null;
    openView.disabled = !canOpenFolder(shownDirectory);
    const found = search(input.value,resultLimit + 1,folder);
    const matches = found.slice(0,resultLimit);
    displayedIds = matches.map(asset => asset.id);
    results.replaceChildren(...matches.map(asset => {
      const row = owner.createElement('div');
      row.className = 'folder-asset-row';
      row.dataset.folderAssetRow = asset.id;
      const card = owner.createElement('button');
      card.type = 'button';
      card.draggable = true;
      card.className = 'folder-asset-card';
      card.dataset.folderAssetId = asset.id;
      card.title = asset.name + ' · 单击预览 · 拖到目录可复制';
      card.setAttribute('aria-label','预览「' + asset.name + '」');
      const media = owner.createElement('span');
      media.className = 'folder-asset-thumbnail';
      const fallback = owner.createElement('span');
      fallback.className = 'folder-asset-fallback';
      fallback.textContent = String(asset.ext || '文件').toUpperCase();
      const image = owner.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.hidden = true;
      image.addEventListener('error', () => { image.hidden = true; fallback.hidden = false; }, {once:true});
      media.append(fallback,image);
      const label = owner.createElement('span');
      label.className = 'folder-asset-label';
      const name = owner.createElement('span');
      name.className = 'folder-asset-name';
      name.textContent = asset.name;
      const path = owner.createElement('small');
      path.className = 'folder-asset-path';
      path.title = asset.path;
      path.textContent = asset.path.split(/[/\\]/).filter(Boolean).slice(-2).join(' / ');
      label.append(name,path);
      card.append(media,label);
      row.append(card);
      if (locate) row.append(actionButton('locate',asset,'定位原文件','locate'));
      if (favorite) row.append(actionButton('favorite',asset,asset.favorite ? '取消收藏' : '收藏','star'));
      return row;
    }));
    for (const card of results.querySelectorAll('[data-folder-asset-id]')) observer.observe(card);
    if (focusedId) {
      const row = [...results.children].find(item => item.dataset.folderAssetRow === focusedId);
      const target = row?.querySelector(focusedAction
        ? '[data-folder-asset-action="' + focusedAction + '"]' : '[data-folder-asset-id]');
      if (target && !target.disabled) target.focus({preventScroll:true});
      else if (!row) input.focus({preventScroll:true});
    }
    results.scrollTop = resetScroll ? 0 : previousScroll;
    if (found.length > resultLimit) {
      status.textContent = '显示前 ' + resultLimit + ' 项，输入更多关键词可缩小范围';
    } else if (matches.length) {
      status.textContent = matches.length + ' 项入库素材';
    } else {
      status.textContent = folder ? '当前目录及子目录未找到可访问的素材' : '没有找到可访问的素材';
    }
  }

  function updateFeedback(message) {
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  async function runAction(action,id) {
    const asset = resolve(id);
    if (!asset) {
      if (visible) render();
      return;
    }
    const request = opening;
    let fallbackFocus;
    if (action === 'locate') {
      if (!locate || locating) return;
      locating = true;
      updateFeedback('正在定位原文件…');
    } else {
      if (!favorite || savingFavorites.has(id)) return;
      savingFavorites.add(id);
      fallbackFocus = owner.activeElement.closest('[data-folder-asset-action="favorite"]');
    }
    for (const button of results.querySelectorAll('[data-folder-asset-action="' + action + '"]')) {
      if (action === 'locate' || button.closest('[data-folder-asset-row]')?.dataset.folderAssetRow === id) button.disabled = true;
    }
    try {
      if (action === 'locate') {
        const opened = await locate(asset);
        if (visible && opening === request) updateFeedback(opened === false ? '未能选中原文件，请检查文件位置' : '已定位原文件');
      } else {
        await favorite({id,path:asset.path,favorite:!asset.favorite});
      }
    } catch (failure) {
      if (visible && opening === request) {
        if (action === 'locate') updateFeedback('');
        report(failure);
      }
    } finally {
      if (action === 'locate') locating = false;
      else savingFavorites.delete(id);
      if (visible) {
        render();
        if (fallbackFocus && opening === request && owner.activeElement === owner.body) {
          const row = [...results.children].find(item => item.dataset.folderAssetRow === id);
          row?.querySelector('[data-folder-asset-action="favorite"]')?.focus({preventScroll:true});
        }
      }
    }
  }

  function close({focus = true} = {}) {
    if (!visible) return;
    visible = false;
    opening++;
    generation++;
    clearTimeout(timer);
    observer.disconnect();
    displayedIds = [];
    results.replaceChildren();
    updateFeedback('');
    pane.hidden = true;
    trigger.setAttribute('aria-expanded','false');
    if (focus) trigger.focus({preventScroll:true});
  }

  async function toggle() {
    if (visible) { close(); return; }
    visible = true;
    ready = false;
    const request = ++opening;
    pane.hidden = false;
    openView.disabled = true;
    trigger.setAttribute('aria-expanded','true');
    input.focus({preventScroll:true});
    status.textContent = '正在加载资产库…';
    try {
      await load();
      if (!visible || opening !== request) return;
      ready = true;
      render(true);
    } catch (failure) {
      if (visible && opening === request) {
        status.textContent = '无法加载资产库';
        report(failure);
      }
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (!locating) updateFeedback('');
    timer = setTimeout(() => render(true),120);
  });
  input.addEventListener('keydown',event => {
    if (event.key !== 'Enter' || event.isComposing || event.repeat || !locate || !ready) return;
    event.preventDefault();
    clearTimeout(timer);
    render();
    if (displayedIds.length) void runAction('locate',displayedIds[0]);
  });
  scope.addEventListener('change',() => {
    preferredScope = scope.value;
    if (!locating) updateFeedback('');
    render(true);
  });
  openView.addEventListener('click', () => {
    const path = directory();
    if (canOpenFolder(path)) openFolder(path);
  });
  pane.querySelector('[data-folder-assets-close]').addEventListener('click',close);
  pane.addEventListener('keydown',event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });
  results.addEventListener('click',event => {
    const action = event.target.closest('[data-folder-asset-action]');
    if (action) {
      const id = action.closest('[data-folder-asset-row]')?.dataset.folderAssetRow;
      if (id) void runAction(action.dataset.folderAssetAction,id);
      return;
    }
    const card = event.target.closest('[data-folder-asset-id]');
    if (card && resolve(card.dataset.folderAssetId)) preview(card.dataset.folderAssetId,[...displayedIds]);
  });

  return {
    toggle,
    hide:close,
    refresh:render,
    updateLocation() {
      if (!visible || shownDirectory === directory()) return;
      const needsFilter = preferredScope === 'folder';
      shownDirectory = directory();
      openView.disabled = !canOpenFolder(shownDirectory);
      folderScope.disabled = !shownDirectory;
      if (needsFilter) render(true);
    },
    dragSource(target) {
      const card = target.closest('[data-folder-asset-id]');
      if (!visible || !card || !pane.contains(card)) return null;
      const asset = resolve(card.dataset.folderAssetId);
      if (!asset) return null;
      return {element:card, paths:[asset.path], forceCopy:true,
        valid:() => resolve(asset.id)?.path === asset.path};
    },
  };
}
