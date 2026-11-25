import {dockPanel, findDockGroup, loadSidebarLayout, panelNames, saveSidebarLayout, visibleDockLayout} from './sidebar-dock-layout.js';

const headingClickDelay = 450;
const dragThreshold = 7;
const splitGap = 8;
const options = {
  center:'合并标签页', top:'吸附到上方', bottom:'吸附到下方', left:'吸附到左侧', right:'吸附到右侧',
};

function inside(rect, x, y) {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

function edgeAt(rect, x, y) {
  const band = (span, limit) => Math.min(limit, span * 0.18);
  const horizontal = band(rect.width, 30);
  const vertical = band(rect.height, 28);
  const gaps = [
    ['left', (x - rect.left) / horizontal],
    ['right', (rect.right - x) / horizontal],
    ['top', (y - rect.top) / vertical],
    ['bottom', (rect.bottom - y) / vertical],
  ];
  return gaps.reduce((closest, edge) => edge[1] < closest[1] ? edge : closest, ['center', 1])[0];
}

function previewBounds(rect, placement) {
  const {left, right, top, bottom, width, height} = rect;
  const inset = Math.min(3, width / 6, height / 6);
  return {
    left:(placement === 'right' ? left + width / 2 : left) + inset,
    right:(placement === 'left' ? right - width / 2 : right) - inset,
    top:(placement === 'bottom' ? top + height / 2 : top) + inset,
    bottom:(placement === 'top' ? bottom - height / 2 : bottom) - inset,
  };
}

export function initSidebarZones(preferences = localStorage) {
  const panes = document.querySelector('#sidebar-panes');
  if (!panes) return;

  const layout = loadSidebarLayout(preferences);
  const groupViews = new Map();
  const splitViews = new Map();
  const scrollPositions = new Map();
  const zones = Object.fromEntries(panelNames.map(name => [name, {
    pane:document.getElementById(name === 'folder' ? 'sidebar-folder-pane' : `organize-${name}`),
    toggle:document.querySelector(`#sidebar-${name}-toggle`),
    content:document.getElementById(name === 'shortcuts' ? 'sidebar-organize-content' : `sidebar-${name}-content`),
  }]));
  let maximized = null;
  let gesture = null;
  let resizing = null;
  let suppressClick = false;
  let pendingClick;
  let menuTrigger = null;

  const dockTree = document.createElement('div');
  dockTree.className = 'sidebar-dock-tree';
  const preview = document.createElement('div');
  preview.className = 'sidebar-dock-preview';
  preview.setAttribute('aria-hidden', 'true');
  preview.hidden = true;
  const menu = document.createElement('div');
  menu.id = 'sidebar-dock-options';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', '侧栏分区布局');
  menu.hidden = true;

  const save = () => saveSidebarLayout(layout.tree, layout.collapsed, preferences);

  function renderGroup(view) {
    const {tabs, active} = view;
    const tabbed = tabs.length > 1;
    const group = document.createElement('div');
    group.className = 'sidebar-dock-group';
    group.dataset.dockGroup = active;
    group.toggleAttribute('data-tabbed', tabbed);
    groupViews.set(group, view);
    if (tabbed) {
      const bar = document.createElement('div');
      bar.className = 'sidebar-dock-tabs';
      const list = document.createElement('div');
      list.className = 'sidebar-dock-tablist';
      if (tabs.length === 3 && !tabs.includes('folder')) {
        group.id = 'sidebar-organize-pane';
        list.id = 'organize-tabs';
      }
      list.setAttribute('role', 'tablist');
      list.setAttribute('aria-label', '侧栏分区');
      list.append(...tabs.map(name => zones[name].tab));
      bar.append(list);
      group.append(bar);
    }
    for (const name of tabs) {
      const zone = zones[name];
      const selected = name === active;
      const collapsed = maximized !== name && Boolean(layout.collapsed[name]);
      zone.pane.hidden = !selected;
      zone.pane.toggleAttribute('data-tabbed-panel', tabbed);
      const labelledBy = tabbed ? zone.tab.id : zone.toggle?.id;
      if (labelledBy) zone.pane.setAttribute('aria-labelledby', labelledBy);
      else zone.pane.removeAttribute('aria-labelledby');
      if (tabbed) zone.pane.setAttribute('role', 'tabpanel');
      else zone.pane.removeAttribute('role');
      zone.toggle?.setAttribute('aria-expanded', String(!collapsed));
      zone.content.hidden = collapsed;
      zone.tab.setAttribute('aria-selected', String(selected));
      zone.tab.tabIndex = selected ? 0 : -1;
      group.append(zone.pane);
    }
    return group;
  }

  function paneIds(view) {
    return view.tabs ? view.tabs.map(name => zones[name].pane.id)
      : [...paneIds(view.first), ...paneIds(view.second)];
  }

  function renderTree(view) {
    if (view.tabs) return renderGroup(view);
    const branch = document.createElement('div');
    branch.className = 'sidebar-dock-split';
    branch.dataset.axis = view.node.axis;
    const separator = document.createElement('div');
    separator.className = 'sidebar-splitter';
    if (splitViews.size === 0) separator.id = 'sidebar-splitter';
    separator.tabIndex = 0;
    separator.setAttribute('role', 'separator');
    separator.setAttribute('aria-controls', paneIds(view).join(' '));
    const side = view.node.axis === 'row';
    separator.setAttribute('aria-orientation', side ? 'vertical' : 'horizontal');
    separator.setAttribute('aria-label', side ? '调整分区宽度' : '调整分区高度');
    separator.title = '拖动调整面板尺寸';
    splitViews.set(separator, {branch, node:view.node});
    branch.append(renderTree(view.first), separator, renderTree(view.second));
    return branch;
  }

  function splitSize(branch, node) {
    const side = node.axis === 'row';
    const span = (side ? branch.clientWidth : branch.clientHeight) - splitGap;
    const minimum = Math.min(0.45, Math.max(0.08, (side ? 65 : 34) / Math.max(1, span)));
    const share = Math.max(minimum, Math.min(1 - minimum, node.share));
    return {span, minimum, share};
  }

  function renderShares() {
    for (const [separator, {branch, node}] of splitViews) {
      const {share, minimum} = splitSize(branch, node);
      branch.style.setProperty('--dock-first', `${share}fr`);
      branch.style.setProperty('--dock-second', `${1 - share}fr`);
      separator.setAttribute('aria-valuemin', String(Math.round(minimum * 100)));
      separator.setAttribute('aria-valuemax', String(Math.round((1 - minimum) * 100)));
      separator.setAttribute('aria-valuenow', String(Math.round(share * 100)));
    }
  }

  function render() {
    const focused = panes.contains(document.activeElement) ? document.activeElement : null;
    for (const element of dockTree.querySelectorAll('.sidebar-pane-scroll')) {
      if (!element.closest('[hidden]')) scrollPositions.set(element, [element.scrollTop, element.scrollLeft]);
    }
    groupViews.clear();
    splitViews.clear();
    const group = maximized && findDockGroup(layout.tree, maximized);
    const include = name => !group || group.tabs.includes(name);
    dockTree.replaceChildren(renderTree(visibleDockLayout(layout.tree, include)));
    renderShares();
    for (const {active} of groupViews.values()) {
      const tab = zones[active].tab;
      if (!tab.isConnected) continue;
      const list = tab.parentElement;
      const {left, right} = tab.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      if (left < bounds.left) list.scrollLeft += left - bounds.left;
      else if (right > bounds.right) list.scrollLeft += right - bounds.right;
    }
    for (const [element, [top, left]] of scrollPositions) {
      if (!element.isConnected || element.closest('[hidden]')) continue;
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    if (focused?.isConnected && !focused.closest('[hidden]')) focused.focus({preventScroll:true});
  }

  function closeMenu(restoreFocus = false) {
    if (!menuTrigger) return;
    menu.hidden = true;
    if (restoreFocus) menuTrigger.focus({preventScroll:true});
    menuTrigger = null;
  }

  function focusHeader(name) {
    const zone = zones[name];
    (zone.tab.isConnected ? zone.tab : zone.toggle).focus({preventScroll:true});
  }

  function applyDock(source, target, placement, before) {
    clearTimeout(pendingClick);
    closeMenu();
    maximized = null;
    layout.tree = dockPanel(layout.tree, source, target, placement, before);
    delete layout.collapsed[source];
    render();
    save();
    focusHeader(source);
  }

  function openMenu(trigger) {
    if (trigger === menuTrigger) { closeMenu(true); return; }
    closeMenu();
    const source = trigger.dataset.dockZone;
    const group = findDockGroup(layout.tree, source);
    const others = panelNames.filter(name => name !== source);
    const destinations = [...new Set(others.map(name => findDockGroup(layout.tree, name)))];
    menu.replaceChildren();
    const addOption = (label, action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', action);
      menu.append(button);
    };
    if (group.tabs.length > 1) {
      const collapsed = layout.collapsed[source] && maximized !== source;
      addOption(collapsed ? '展开当前面板' : '折叠当前面板', () => {
        closeMenu();
        layout.collapsed[source] = !collapsed;
        maximized = null;
        render();
        save();
        focusHeader(source);
      });
      addOption(maximized === source ? '还原当前面板' : '最大化当前面板', () => {
        toggleMaximized(source);
        focusHeader(source);
      });
      const index = group.tabs.indexOf(source);
      const previous = group.tabs[index - 1];
      const next = group.tabs[index + 1];
      if (previous) addOption('向左移动标签', () => applyDock(source, previous, 'tab', previous));
      if (next) addOption('向右移动标签', () => applyDock(source, next, 'tab', group.tabs[index + 2]));
    }
    for (const targetGroup of destinations) {
      const target = targetGroup.tabs.find(name => name !== source);
      for (const [placement, label] of Object.entries(options)) {
        if (targetGroup === group && placement === 'center') continue;
        addOption(`${label} · ${zones[target].label}`, () => applyDock(source, target, placement));
      }
    }
    if (!menu.childElementCount) return;
    menuTrigger = trigger;
    menu.hidden = false;
    const anchor = trigger.getBoundingClientRect();
    const bounds = panes.getBoundingClientRect();
    menu.style.top = `${Math.max(0, Math.min(anchor.bottom - bounds.top, panes.clientHeight - menu.offsetHeight))}px`;
    menu.firstElementChild.focus({preventScroll:true});
  }

  function selectTab(name, focus = false) {
    const group = findDockGroup(layout.tree, name);
    if (group.active !== name || layout.collapsed[name]) {
      if (maximized && group.tabs.includes(maximized)) maximized = name;
      group.active = name;
      delete layout.collapsed[name];
      render();
      save();
    }
    if (focus) focusHeader(name);
  }

  function toggleMaximized(name) {
    closeMenu();
    const group = findDockGroup(layout.tree, name);
    maximized = group.tabs.includes(maximized) ? null : name;
    group.active = name;
    render();
  }

  for (const [name, zone] of Object.entries(zones)) {
    zone.label = zone.toggle.textContent.trim();
    zone.toggle.title = '单击展开或折叠，双击最大化，拖动或右键调整位置';
    zone.toggle.dataset.dockZone = name;

    zone.tab = document.createElement('button');
    zone.tab.type = 'button';
    zone.tab.className = 'sidebar-dock-tab';
    zone.tab.id = name === 'folder' ? 'sidebar-folder-tab' : `organize-${name}-tab`;
    zone.tab.textContent = zone.label;
    zone.tab.title = '拖动或右键调整标签位置';
    zone.tab.dataset.dockZone = name;
    zone.tab.setAttribute('role', 'tab');
    zone.tab.setAttribute('aria-controls', zone.pane.id);
    zone.tab.addEventListener('click', () => selectTab(name));
    zone.tab.addEventListener('dblclick', () => toggleMaximized(name));
    zone.tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = findDockGroup(layout.tree, name).tabs;
      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      const next = {Home:tabs[0], End:tabs.at(-1)}[event.key] ??
        tabs[(tabs.indexOf(name) + offset + tabs.length) % tabs.length];
      selectTab(next, true);
    });

    function collapse() {
      maximized = null;
      layout.collapsed[name] = !layout.collapsed[name];
      render();
      save();
    }
    zone.toggle.addEventListener('click', event => {
      clearTimeout(pendingClick);
      if (event.detail === 0) collapse();
      else if (event.detail === 1) pendingClick = setTimeout(collapse, headingClickDelay);
    });
    zone.toggle.addEventListener('dblclick', event => {
      event.preventDefault();
      clearTimeout(pendingClick);
      toggleMaximized(name);
    });
  }

  panes.replaceChildren(dockTree, preview, menu);
  function openDockMenu(event) {
    const trigger = event.target.closest('[data-dock-zone]');
    if (!trigger) return;
    event.preventDefault();
    openMenu(trigger);
  }
  panes.addEventListener('contextmenu', openDockMenu);
  panes.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openDockMenu(event);
  });
  document.addEventListener('pointerdown', event => {
    suppressClick = false;
    if (menuTrigger && !menu.contains(event.target) && !menuTrigger.contains(event.target)) closeMenu();
  }, true);
  menu.addEventListener('focusout', event => {
    if (event.relatedTarget && !menu.contains(event.relatedTarget) && event.relatedTarget !== menuTrigger) closeMenu();
  });

  function destination(source, x, y) {
    const hit = document.elementFromPoint(x, y);
    const group = hit?.closest('.sidebar-dock-group');
    const view = groupViews.get(group);
    if (!view) return null;
    const target = view.active === source ? view.tabs.find(name => name !== source) : view.active;
    if (!target) return null;
    const rect = group.getBoundingClientRect();
    if (!inside(rect, x, y)) return null;

    const tabs = hit.closest('.sidebar-dock-tabs');
    const onHeading = hit.closest('.sidebar-pane-heading');
    const atOutsideEdge = Math.min(x - rect.left, rect.right - x, y - rect.top) < 6;
    if (tabs && !atOutsideEdge) {
      const candidates = [...tabs.querySelectorAll('.sidebar-dock-tab')];
      const before = candidates.find(tab => {
        const box = tab.getBoundingClientRect();
        return tab.dataset.dockZone !== source && x < box.left + box.width / 2;
      });
      const box = (before ?? candidates.at(-1)).getBoundingClientRect();
      const line = before ? box.left : box.right;
      return {target, placement:'tab', before:before?.dataset.dockZone,
        bounds:{left:line - 1, right:line + 2, top:box.top, bottom:box.bottom}};
    }
    const placement = onHeading && !atOutsideEdge ? 'center' : edgeAt(rect, x, y);
    if (placement === 'center' && view.tabs.includes(source)) return null;
    return {target, placement, bounds:previewBounds(rect, placement)};
  }

  function showPreview(drop) {
    preview.hidden = !drop;
    panes.classList.toggle('is-docking', Boolean(gesture?.dragging && !gesture.cancelled));
    if (!drop) return;
    const origin = panes.getBoundingClientRect();
    const {left, top, right, bottom} = drop.bounds;
    preview.dataset.placement = drop.placement;
    preview.style.left = `${left - origin.left}px`;
    preview.style.top = `${top - origin.top}px`;
    preview.style.width = `${right - left}px`;
    preview.style.height = `${bottom - top}px`;
  }

  panes.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const control = event.target.closest('[data-dock-zone]');
    if (control) {
      gesture = {id:event.pointerId, x:event.clientX, y:event.clientY, source:control.dataset.dockZone};
      return;
    }
    const separator = event.target.closest('.sidebar-splitter');
    if (splitViews.has(separator)) {
      const {branch, node} = splitViews.get(separator);
      const side = node.axis === 'row';
      const {span, minimum, share} = splitSize(branch, node);
      if (span <= 0) return;
      event.preventDefault();
      separator.focus({preventScroll:true});
      separator.setPointerCapture(event.pointerId);
      resizing = {id:event.pointerId, node, side, span, minimum, share, original:node.share,
        start:side ? event.clientX : event.clientY};
    }
  });
  panes.addEventListener('dragstart', event => {
    if (event.target.closest('[data-dock-zone]')) event.preventDefault();
  });
  document.addEventListener('pointermove', event => {
    if (resizing?.id === event.pointerId) {
      if (!event.buttons) { endResize(false); return; }
      const {node, side, span, minimum, share, start} = resizing;
      const position = side ? event.clientX : event.clientY;
      node.share = Math.max(minimum, Math.min(1 - minimum, share + (position - start) / span));
      renderShares();
      return;
    }
    if (gesture?.id !== event.pointerId || gesture.cancelled) return;
    if (!event.buttons) { endDrag(null); return; }
    if (!gesture.dragging) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < dragThreshold) return;
      clearTimeout(pendingClick);
      closeMenu();
      gesture.dragging = true;
      if (maximized) { maximized = null; render(); }
    }
    showPreview(destination(gesture.source, event.clientX, event.clientY));
  });
  function endDrag(drop) {
    const previous = gesture;
    gesture = null;
    showPreview(null);
    if (!previous?.dragging) return;
    suppressClick = true;
    if (drop) applyDock(previous.source, drop.target, drop.placement, drop.before);
  }

  function endResize(commit) {
    if (!resizing) return;
    const {node, original} = resizing;
    resizing = null;
    if (commit) save();
    else { node.share = original; renderShares(); }
  }

  document.addEventListener('pointerup', event => {
    if (resizing?.id === event.pointerId) endResize(true);
    if (gesture?.id !== event.pointerId) return;
    const drop = gesture.dragging && !gesture.cancelled
      ? destination(gesture.source, event.clientX, event.clientY) : null;
    endDrag(drop);
  });
  document.addEventListener('pointercancel', event => {
    if (resizing?.id === event.pointerId) endResize(false);
    if (gesture?.id === event.pointerId) endDrag(null);
  });
  panes.addEventListener('lostpointercapture', event => {
    if (resizing?.id === event.pointerId) endResize(false);
  });
  window.addEventListener('blur', () => {
    endDrag(null);
    endResize(false);
    closeMenu();
  });
  for (const type of ['click', 'dblclick']) {
    panes.addEventListener(type, event => {
      if (!suppressClick || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (gesture?.dragging) {
      gesture.cancelled = true;
      showPreview(null);
    } else if (resizing) endResize(false);
    else if (menuTrigger) closeMenu(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  panes.addEventListener('keydown', event => {
    const splitView = splitViews.get(event.target);
    if (!splitView) return;
    const {branch, node} = splitView;
    const {minimum, share} = splitSize(branch, node);
    const side = node.axis === 'row';
    const changes = {Home:minimum, End:1 - minimum,
      [side ? 'ArrowLeft' : 'ArrowUp']:share - 0.04, [side ? 'ArrowRight' : 'ArrowDown']:share + 0.04};
    if (!Object.hasOwn(changes, event.key)) return;
    event.preventDefault();
    node.share = Math.max(minimum, Math.min(1 - minimum, changes[event.key]));
    renderShares();
    save();
  });
  panes.addEventListener('dblclick', event => {
    const splitView = splitViews.get(event.target);
    if (!splitView) return;
    splitView.node.share = 0.5;
    renderShares();
    save();
  });

  new ResizeObserver(renderShares).observe(panes);
  render();
  return {
    reload() {
      clearTimeout(pendingClick);
      closeMenu();
      endDrag(null);
      endResize(false);
      maximized = null;
      scrollPositions.clear();
      for (const element of dockTree.querySelectorAll('.sidebar-pane-scroll')) {
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
      Object.assign(layout, loadSidebarLayout(preferences));
      render();
    },
    show(name) {
      const group = findDockGroup(layout.tree, name);
      if (!group) return;
      const restore = maximized && !group.tabs.includes(maximized);
      const changed = group.active !== name || Boolean(layout.collapsed[name]);
      if (!restore && !changed) return;
      clearTimeout(pendingClick);
      closeMenu();
      if (restore) maximized = null;
      group.active = name;
      delete layout.collapsed[name];
      render();
      if (changed) save();
    },
  };
}
