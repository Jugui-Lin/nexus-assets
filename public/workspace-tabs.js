import {dockAxis, dockRect, initWorkspaceTabDrag} from './workspace-tab-drag.js';
import {captureWorkspacePane} from './workspace-pane-preview.js';

const dividerSize = 8;
const deckBottomInset = 4;
const minimumSplitSpan = 420;
const closedTabLimit = 16;

export function initWorkspaceTabs({
  getScope, capture, restore, beforeSwitch, goHome, icon, thumbnail, onReveal,
  onEmpty, onDetachTab, onRestoreReveal = onReveal, canDetachActive = () => true,
  doubleClickCloseEnabled = () => false, onPaneLayout = () => {}, onDuplicate = () => {}, onError = () => {},
}) {
  const heading = document.getElementById('page-title');
  const add = document.getElementById('workspace-tab-add');
  const join = document.getElementById('workspace-pane-join');
  const deck = document.getElementById('workspace-pane-deck');
  const divider = document.getElementById('workspace-pane-divider');
  const scroll = document.getElementById('browser-scroll');
  const controls = document.getElementById('workspace-asset-controls');
  const makePane = (id, listId) => ({
    id, list:document.getElementById(listId), element:document.getElementById('workspace-pane-' + id),
    tabs:[], active:null, preview:null,
  });
  const primary = makePane('primary', 'workspace-tab-list');
  const secondary = makePane('secondary', 'workspace-split-tabs');
  const panes = [primary, secondary];
  let scope;
  let sequence = 0;
  let focused = primary;
  let shown;
  let splitSide = 'right';
  let operation;
  const detaching = new Set();
  const closedTabs = [];
  let ratio = 50;

  function createTab(title, snapshot, initialView) {
    const group = document.createElement('div');
    group.className = 'workspace-tab';
    group.setAttribute('role', 'presentation');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'workspace-tab-trigger';
    trigger.setAttribute('role', 'tab');
    trigger.setAttribute('aria-keyshortcuts', 'Delete');
    if (onReveal) trigger.innerHTML = icon('stack');
    const label = document.createElement('span');
    trigger.append(label);
    const pin = document.createElement('span');
    pin.className = 'workspace-tab-pin';
    pin.hidden = true;
    pin.setAttribute('aria-hidden','true');
    pin.innerHTML = icon('pin');
    trigger.append(pin);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'workspace-tab-close';
    close.innerHTML = icon('close');
    const tab = {id:'workspace-tab-' + ++sequence, title, snapshot, initialView, group, trigger, label, close,pin,pinned:false};
    trigger.id = tab.id;
    group.dataset.tabId = tab.id;
    group.append(trigger, close);
    let opening;
    trigger.addEventListener('click', event => {
      if (event.detail > 1 && doubleClickCloseEnabled()) return;
      opening = openTab(tab);
    });
    trigger.addEventListener('dblclick', event => {
      if (event.button !== 0 || !doubleClickCloseEnabled()) return;
      event.preventDefault();
      event.stopPropagation();
      const clickedScope = scope;
      const pending = opening;
      opening = undefined;
      const closeClickedTab = () => {
        if (scope === clickedScope && scope === getScope() && paneFor(tab) && doubleClickCloseEnabled()) {
          remove(tab);
        }
      };
      // The first click may still be revealing or switching to this tab.
      // A declined switch or a different active tab must leave it in place.
      if (pending) void pending.then(result => {
        if (result !== false && shown === tab) closeClickedTab();
      });
      else closeClickedTab();
    });
    close.addEventListener('click', () => remove(tab));
    return tab;
  }

  function paneFor(tab) {
    return panes.find(pane => pane.tabs.includes(tab));
  }

  function paint() {
    const split = Boolean(secondary.active);
    const axis = dockAxis(splitSide);
    deck.toggleAttribute('data-workspace-split', split);
    deck.dataset.splitSide = splitSide;
    deck.dataset.splitAxis = axis;
    primary.list.parentElement.toggleAttribute('data-secondary-first', split && (splitSide === 'left' || splitSide === 'top'));
    primary.list.parentElement.toggleAttribute('data-stacked-split', split && axis === 'rows');
    divider.setAttribute('aria-orientation', axis === 'rows' ? 'horizontal' : 'vertical');
    divider.setAttribute('aria-label', axis === 'rows' ? '调整分屏高度' : '调整分屏宽度');
    divider.hidden = join.hidden = !split;
    for (const pane of panes) {
      pane.list.hidden = !pane.active;
      pane.element.hidden = pane !== primary && !pane.active;
      const isFocused = pane === focused;
      pane.element.toggleAttribute('data-pane-focused', isFocused);
      pane.element.tabIndex = !isFocused && pane.active ? 0 : -1;
      if (pane.active) pane.element.setAttribute('aria-labelledby', pane.active.id);
      else pane.element.removeAttribute('aria-labelledby');
      pane.list.dataset.paneId = pane.id;
      pane.list.dataset.single = String(pane.tabs.length === 1);
      pane.list.toggleAttribute('data-pane-focused', isFocused);
      const groups = new Set(pane.tabs.map(tab => tab.group));
      for (const child of [...pane.list.children]) {
        if (!groups.has(child)) child.remove();
      }
      pane.tabs.forEach((tab, index) => {
        const selected = tab === pane.active;
        if (pane.list.children[index] !== tab.group) pane.list.insertBefore(tab.group, pane.list.children[index] ?? null);
        if (tab.label.textContent !== tab.title) tab.label.textContent = tab.title;
        tab.trigger.title = tab.title + (tab.pinned ? ' · 已固定' : '');
        tab.trigger.setAttribute('aria-label',tab.trigger.title);
        tab.group.toggleAttribute('data-pinned',tab.pinned);
        tab.pin.hidden = !tab.pinned;
        tab.trigger.setAttribute('aria-controls', pane.element.id);
        tab.trigger.setAttribute('aria-selected', String(selected));
        tab.trigger.tabIndex = selected ? 0 : -1;
        const closeLabel = '关闭「' + tab.title + '」';
        tab.close.setAttribute('aria-label', closeLabel);
        tab.close.title = closeLabel;
        tab.close.tabIndex = selected ? 0 : -1;
        tab.group.toggleAttribute('data-active', selected);
      });
    }
  }

  function placeAssetControls() {
    const liveAssets = !controls.hidden;
    const local = panes.some(pane => pane !== focused && pane.active && Boolean(pane.preview?.header) !== liveAssets);
    deck.toggleAttribute('data-pane-local-controls', local);
    const anchor = local && liveAssets ? scroll : deck;
    if (controls.nextElementSibling !== anchor) anchor.before(controls);
    onPaneLayout({split:Boolean(secondary.active), pane:scroll.parentElement, assetView:liveAssets, tabId:shown?.id});
  }

  function resetScope(title = heading.textContent.trim() || '资产工作台') {
    drag.cancel();
    const nextScope = getScope();
    if (scope !== nextScope) closedTabs.length = 0;
    scope = nextScope;
    operation = undefined;
    deck.removeAttribute('aria-busy');
    focused = primary;
    shown = primary.active = createTab(title);
    primary.tabs = [shown];
    splitSide = 'right';
    for (const pane of panes) {
      if (pane !== primary) {
        pane.active = null;
        pane.tabs = [];
      }
      pane.preview?.dispose();
      pane.preview?.element.remove();
      pane.preview?.header?.remove();
      pane.preview = null;
    }
    if (scroll.parentElement !== primary.element) primary.element.append(scroll);
    paint();
    placeAssetControls();
    setRatio(50);
  }

  function ensureScope() {
    if (scope !== getScope()) resetScope();
  }

  function focusTab(tab) {
    tab.trigger.scrollIntoView({block:'nearest', inline:'nearest'});
    tab.trigger.focus({preventScroll:true});
  }

  function present(pane, tab) {
    if (scroll.parentElement !== pane.element) {
      const offset = scroll.scrollTop;
      pane.element.append(scroll);
      scroll.scrollTop = offset;
    }
    if (shown === tab) return;
    shown = tab;
    if (tab.snapshot) restore(tab.snapshot);
    else goHome(tab.initialView);
  }

  function collectPreviews() {
    const previews = new Map();
    for (const pane of panes) {
      if (!pane.preview) continue;
      const {element} = pane.preview;
      if (pane.active?.snapshot) pane.active.snapshot.scroll = element.scrollTop;
      previews.set(pane.active, pane.preview);
      element.remove();
      pane.preview.header?.remove();
      pane.preview = null;
    }
    return previews;
  }

  function disposeUnusedPreviews(previews) {
    for (const preview of previews.values()) {
      if (!panes.some(pane => pane.preview === preview)) preview.dispose();
    }
  }

  function showLayout(previews) {
    paint();
    for (const resting of panes.filter(pane => pane !== focused && pane.active)) {
      const tab = resting.active;
      let preview = previews.get(tab);
      if (!preview) {
        present(resting, tab);
        if (!tab.snapshot) tab.snapshot = capture();
        const previewScope = scope;
        preview = captureWorkspacePane(scroll, {
          controls: controls.hidden ? null : controls,
          thumbnail: id => previewScope === getScope() ? thumbnail?.(id) : null,
        });
      }
      resting.preview = preview;
      if (preview.header) resting.element.append(preview.header);
      resting.element.append(preview.element);
    }
    if (focused.active) present(focused, focused.active);
    else shown = undefined;
    placeAssetControls();
    for (const pane of panes) pane.preview?.restoreScroll(pane.active?.snapshot?.scroll);
  }

  async function transition(change, moveFocus = false) {
    ensureScope();
    if (operation) return false;
    const token = {};
    operation = token;
    deck.setAttribute('aria-busy', 'true');
    const current = () => operation === token && scope === getScope();
    try {
      if (await beforeSwitch() === false || !current()) return false;
      if (shown) shown.snapshot = capture();
      const previews = collectPreviews();
      const previousFocus = focused;
      const previousSide = splitSide;
      const previousRatio = ratio;
      const previousPanes = panes.map(pane => ({tabs:[...pane.tabs], active:pane.active}));
      try {
        change();
        showLayout(previews);
      } catch (failure) {
        const attemptedPreviews = collectPreviews();
        panes.forEach((pane, index) => Object.assign(pane, previousPanes[index]));
        focused = previousFocus;
        splitSide = previousSide;
        setRatio(previousRatio);
        shown = undefined;
        try { showLayout(previews); }
        finally { disposeUnusedPreviews(attemptedPreviews); }
        throw failure;
      } finally {
        disposeUnusedPreviews(previews);
      }
      if (moveFocus && focused.active) focusTab(focused.active);
      if (!focused.active) onEmpty?.();
      return true;
    } catch (failure) {
      if (current()) onError(failure);
      return false;
    } finally {
      if (operation === token) {
        operation = undefined;
        deck.removeAttribute('aria-busy');
      }
    }
  }

  function activate(pane, tab, keyboard = false) {
    ensureScope();
    if (!pane?.tabs.includes(tab) || (pane === focused && tab === shown)) return;
    return transition(() => {
      focused = pane;
      pane.active = tab;
    }, keyboard);
  }

  function openTab(tab, keyboard = false) {
    const shown = onReveal?.();
    if (shown) return shown.then(() => activate(paneFor(tab),tab,keyboard)).catch(failure => {
      onError(failure);
      return false;
    });
    return activate(paneFor(tab),tab,keyboard);
  }

  function removeFromPane(pane, tab) {
    const index = pane.tabs.indexOf(tab);
    pane.tabs.splice(index, 1);
    if (tab !== pane.active) return;
    pane.active = pane.tabs[index] || pane.tabs[index - 1] || null;
  }

  function compactPanes() {
    if (!primary.active && secondary.active) {
      primary.tabs = secondary.tabs;
      primary.active = secondary.active;
      secondary.tabs = [];
      secondary.active = null;
    }
    if (!secondary.active) focused = primary;
  }

  function rememberClosed(tab, pane, index) {
    closedTabs.push({
      title:tab.title,snapshot:tab.snapshot,initialView:tab.initialView,
      pinned:tab.pinned,paneId:pane.id,index,
    });
    if (closedTabs.length > closedTabLimit) closedTabs.shift();
  }

  function remove(tab, {skipFocus = false, remember = true} = {}) {
    ensureScope();
    const pane = paneFor(tab);
    if (!pane || operation) return;
    const index = pane.tabs.indexOf(tab);
    const originalScope = scope;
    if (tab !== pane.active) {
      removeFromPane(pane, tab);
      if (remember) rememberClosed(tab,pane,index);
      paint();
      if (!skipFocus) focusTab(pane.active);
      return;
    }
    return transition(() => {
      removeFromPane(pane, tab);
      compactPanes();
      if (!primary.active && !onEmpty) {
        primary.active = createTab('全部资产');
        primary.tabs = [primary.active];
      }
    }, !skipFocus).then(closed => {
      if (closed && remember && scope === originalScope) rememberClosed(tab,pane,index);
      return closed;
    });
  }

  function tabById(id) {
    return panes.flatMap(pane => pane.tabs).find(tab => tab.id === id);
  }

  function findManagedTab(element) {
    const tab = tabById(element.closest('.workspace-tab[data-tab-id]')?.dataset.tabId);
    return tab && {id:tab.id,title:tab.title,pinned:tab.pinned};
  }

  function setTabPinned(id,pinned) {
    ensureScope();
    const tab = tabById(id);
    if (!tab || operation) return false;
    tab.pinned = pinned;
    paint();
    return true;
  }

  function otherUnpinnedTabs(target) {
    return paneFor(target)?.tabs.filter(tab => tab !== target && !tab.pinned) ?? [];
  }

  async function closeOtherTabs(id) {
    ensureScope();
    const target = tabById(id);
    const pane = paneFor(target);
    const others = otherUnpinnedTabs(target);
    if (!pane || !others.length || operation) return false;
    const originalScope = scope;
    const removed = others.map(tab => ({tab,index:pane.tabs.indexOf(tab)}));
    const keep = () => { pane.tabs = pane.tabs.filter(tab => !others.includes(tab)); };
    if (target === shown) {
      keep();
      paint();
      focusTab(target);
    } else if (!await transition(() => {
      keep();
      pane.active = target;
      focused = pane;
    },true)) return false;
    if (scope === originalScope) {
      for (const {tab,index} of removed) rememberClosed(tab,pane,index);
    }
    return true;
  }

  async function restoreClosedTab() {
    const record = closedTabs.at(-1);
    const originalScope = scope;
    if (!record || operation || originalScope !== getScope()) return false;
    await onRestoreReveal?.();
    if (originalScope !== scope || originalScope !== getScope() || !closedTabs.includes(record)) return false;
    const restored = await transition(() => {
      focused = record.paneId === secondary.id && secondary.active ? secondary : primary;
      const tab = createTab(record.title,record.snapshot,record.initialView);
      tab.pinned = record.pinned;
      focused.tabs.splice(record.index,0,tab);
      focused.active = tab;
    },true);
    if (restored && originalScope === scope && closedTabs.includes(record)) closedTabs.splice(closedTabs.indexOf(record),1);
    return restored;
  }

  function paneAtEdge(edge) {
    return splitSide === edge ? secondary : primary;
  }

  function canSplit({paneId, edge}) {
    const axis = dockAxis(edge);
    const span = axis === 'rows' ? deck.clientHeight : deck.clientWidth;
    return span >= minimumSplitSpan && (!secondary.active || axis !== dockAxis(splitSide) || paneAtEdge(edge).id !== paneId);
  }

  function moveTab({tabId, paneId, targetPaneId, edge, index}) {
    ensureScope();
    if (operation) return;
    const source = panes.find(pane => pane.id === paneId);
    const tab = source?.tabs.find(candidate => candidate.id === tabId);
    if (!tab) return;
    const dockToNewAxis = Boolean(edge) && (!secondary.active || dockAxis(edge) !== dockAxis(splitSide));
    const target = edge ? (dockToNewAxis ? secondary : paneAtEdge(edge)) : panes.find(pane => pane.id === targetPaneId);
    if (!target) return;
    if (source === target && !dockToNewAxis) {
      const from = source.tabs.indexOf(tab);
      if (index == null || index === from) return;
      source.tabs.splice(from, 1);
      source.tabs.splice(index, 0, tab);
      paint();
      return;
    }
    transition(() => {
      if (dockToNewAxis) splitSide = edge;
      if (source !== target) {
        removeFromPane(source, tab);
        target.tabs.splice(index ?? target.tabs.length, 0, tab);
      }
      target.active = tab;
      focused = target;
      if (dockToNewAxis && !primary.active) {
        primary.active = createTab('全部资产');
        primary.tabs = [primary.active];
      }
      compactPanes();
    }, true);
  }

  async function detachTab({tabId, paneId}) {
    ensureScope();
    const tab = panes.find(pane => pane.id === paneId)?.tabs.find(tab => tab.id === tabId);
    if (!tab || operation || detaching.has(tab)) return;
    if (tab === shown && !canDetachActive()) {
      onError('请先保存当前页面的修改，再拖出标签页。');
      return;
    }
    const page = tab === shown ? capture() : tab.snapshot;
    if (!page) return;
    const sourceScope = scope;
    const original = JSON.stringify(page);
    detaching.add(tab);
    try {
      const restored = await onDetachTab({scope:sourceScope,page});
      if (!restored || sourceScope !== getScope() || !paneFor(tab)) return;
      const current = tab === shown ? capture() : tab.snapshot;
      if (JSON.stringify(current) === original && (tab !== shown || canDetachActive())) remove(tab,{skipFocus:true,remember:false});
    } catch (failure) { onError(failure); }
    finally { detaching.delete(tab); }
  }

  function insertTab(tab) {
    focused.tabs.splice(focused.tabs.indexOf(shown) + 1, 0, tab);
    focused.active = tab;
  }

  function duplicateActive() {
    ensureScope();
    if (operation || !shown) return;
    try {
      shown.snapshot = capture();
      const tab = createTab(shown.title, shown.snapshot);
      insertTab(tab);
      shown = tab;
      paint();
      onDuplicate();
      focusTab(tab);
    } catch (failure) { onError(failure); }
  }
  add.addEventListener('click', duplicateActive);

  join.addEventListener('click', () => {
    if (!secondary.active) return;
    transition(() => {
      const otherTabs = [...primary.tabs, ...secondary.tabs].filter(tab => tab !== shown);
      primary.tabs = [shown, ...otherTabs];
      primary.active = shown;
      secondary.tabs = [];
      secondary.active = null;
      focused = primary;
      splitSide = 'right';
      setRatio(50);
    }, true);
  });

  for (const pane of panes) {
    pane.list.addEventListener('keydown', event => {
      const tab = pane.tabs.find(item => item.trigger === event.target || item.close === event.target);
      if (!tab || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'Delete') {
        event.preventDefault();
        remove(tab);
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      const target = event.key === 'Home' ? pane.tabs[0] : event.key === 'End' ? pane.tabs.at(-1)
        : pane.tabs[(pane.tabs.indexOf(tab) + offset + pane.tabs.length) % pane.tabs.length];
      openTab(target, true);
    });
    pane.element.addEventListener('click', () => {
      if (pane !== focused && pane.active) activate(pane, pane.active);
    });
    pane.element.addEventListener('keydown', event => {
      if (event.target !== pane.element || pane === focused || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      activate(pane, pane.active, true);
    });
  }

  function setRatio(next) {
    ratio = Math.min(75, Math.max(25, next));
    deck.style.setProperty('--workspace-leading-pane-ratio', String(ratio / 100));
    divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
  }

  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    divider.setPointerCapture(event.pointerId);
    divider.setAttribute('data-resizing', '');
    event.preventDefault();
  });
  divider.addEventListener('pointermove', event => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    const {left, top, width, height} = deck.getBoundingClientRect();
    const rows = dockAxis(splitSide) === 'rows';
    const offset = rows ? event.clientY - top : event.clientX - left;
    const span = rows ? height - deckBottomInset : width;
    if (span > dividerSize) setRatio((offset - dividerSize / 2) / (span - dividerSize) * 100);
  });
  divider.addEventListener('lostpointercapture', () => divider.removeAttribute('data-resizing'));
  divider.addEventListener('keydown', event => {
    const rows = dockAxis(splitSide) === 'rows';
    const previous = rows ? 'ArrowUp' : 'ArrowLeft';
    const next = rows ? 'ArrowDown' : 'ArrowRight';
    if (![previous, next, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setRatio(event.key === 'Home' ? 25 : event.key === 'End' ? 75 : ratio + (event.key === previous ? -5 : 5));
  });
  divider.addEventListener('dblclick', () => setRatio(50));

  const drag = initWorkspaceTabDrag({
    root:deck,
    bounds:deck,
    getLists:() => panes.filter(pane => !pane.list.hidden).map(pane => pane.list),
    canDrag:({tabId}) => !operation && ![...detaching].some(tab => tab.id === tabId),
    canSplit,
    getDockRect: (edge, rect) => secondary.active && dockAxis(edge) === dockAxis(splitSide)
      ? paneAtEdge(edge).element.getBoundingClientRect()
      : dockRect(rect, edge, {ratio:ratio / 100, gap:dividerSize, bottomInset:deckBottomInset}),
    onDrop:moveTab,
    onDetach:onDetachTab ? detachTab : undefined,
  });
  resetScope();
  return {
    render(title) {
      ensureScope();
      placeAssetControls();
      if (!shown) return;
      const label = String(title || '').trim() || '资产工作台';
      if (shown.title === label) return;
      shown.title = label;
      paint();
    },
    activeId() {
      ensureScope();
      return shown?.id ?? null;
    },
    hasTab(id) {
      ensureScope();
      return Boolean(tabById(id));
    },
    getTabCount() {
      return panes.reduce((count,pane) => count + pane.tabs.length,0);
    },
    duplicateActive,
    findManagedTab,setTabPinned,closeOtherTabs,restoreClosedTab,
    closeManagedTab:id => remove(tabById(id)),
    canCloseOtherTabs:id => !operation && otherUnpinnedTabs(tabById(id)).length > 0,
    hasClosedTabs:() => scope === getScope() && closedTabs.length > 0,
    openView(title, view) {
      return transition(() => insertTab(createTab(title, undefined, view)), true);
    },
    async openLinkedView(title) {
      let tab;
      await transition(() => {
        tab = createTab(title, undefined, 'all');
        insertTab(tab);
      });
      return tab && shown === tab ? tab.id : null;
    },
    async activateLinkedView(id) {
      ensureScope();
      const pane = panes.find(pane => pane.tabs.some(tab => tab.id === id));
      const tab = pane?.tabs.find(tab => tab.id === id);
      if (!tab) return false;
      await activate(pane,tab);
      return shown === tab;
    },
    ensureOpen() {
      ensureScope();
      if (shown) return;
      resetScope('全部资产');
      goHome();
    },
    async restoreDetachedTab(payload, restoreProject) {
      ensureScope();
      if (!shown || !payload?.page?.criteria || payload.scope !== scope) return false;
      if (restore(payload.page) === false) return false;
      if (payload.page.whiteboardProject && !await restoreProject(payload.page.whiteboardProject)) return false;
      shown.snapshot = capture();
      return true;
    },
    async focusPane(element, tabId) {
      ensureScope();
      const pane = panes.find(item => item.element === element);
      const tab = pane?.active;
      if (!tab || tab.id !== tabId) return false;
      await activate(pane, tab);
      return focused === pane && shown === tab && pane.active === tab;
    },
    busy() {
      return Boolean(operation) || deck.hasAttribute('data-workspace-tab-dragging');
    },
    resetScope,
  };
}
