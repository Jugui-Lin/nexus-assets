const organizePanels = ['collections', 'tags', 'shortcuts'];
export const panelNames = ['folder', ...organizePanels];
const legacyPanels = ['folder', 'organize'];
const clamp = value => Math.max(0.08, Math.min(0.92, value));
const tabGroup = (tabs, active = tabs[0]) => ({tabs, active});
const split = (axis, share, first, second) => ({axis, share, first, second});

function readPreference(preferences, key) {
  try { return JSON.parse(preferences.getItem(key)); }
  catch { return null; }
}

function readTree(value, panels, allowed, depth = 0) {
  if (!value || depth >= allowed.length) return null;
  if (Array.isArray(value.tabs)) {
    if (!value.tabs.length || !value.tabs.every(name => allowed.includes(name))) return null;
    for (const tab of value.tabs) {
      if (panels.has(tab)) return null;
      panels.add(tab);
    }
    return tabGroup([...value.tabs], value.tabs.includes(value.active) ? value.active : value.tabs[0]);
  }
  if (!['row', 'column'].includes(value.axis) || !Number.isFinite(value.share)) return null;
  const first = readTree(value.first, panels, allowed, depth + 1);
  const second = readTree(value.second, panels, allowed, depth + 1);
  return first && second ? split(value.axis, clamp(value.share), first, second) : null;
}

function legacyLayout(saved) {
  const legacyOrder = saved.first === 'organize' ? ['organize', 'folder'] : legacyPanels;
  const order = Array.isArray(saved.order)
    ? [...new Set([...saved.order.filter(name => legacyPanels.includes(name)), ...legacyPanels])] : legacyOrder;
  const [first, second] = order;
  if (saved.mode === 'tabs') {
    return tabGroup(order, order.includes(saved.activeTab) ? saved.activeTab : first);
  }
  const side = saved.mode === 'side';
  const axis = side ? 'row' : 'column';
  const oldFolder = side ? saved.sideShare : saved.share;
  const folderShare = Number.isFinite(oldFolder) ? clamp(oldFolder) : side ? 0.5 : 0.6;
  return split(axis, first === 'folder' ? folderShare : 1 - folderShare, tabGroup([first]), tabGroup([second]));
}

function migrateOrganizer(tree, activePanel) {
  return rewriteGroup(tree, 'organize', group =>
    tabGroup(group.tabs.flatMap(name => name === 'organize' ? organizePanels : [name]),
      group.active === 'organize' ? activePanel : group.active));
}

const storageKey = 'nexus-sidebar-zones-v3';
export function loadSidebarLayout(preferences = localStorage) {
  const saved = readPreference(preferences, storageKey);
  const seen = new Set();
  const tree = readTree(saved?.tree, seen, panelNames);
  if (tree && panelNames.every(name => seen.has(name))) {
    const collapsed = Object.fromEntries(panelNames.map(name => [name, saved.collapsed?.[name] === true]));
    return {tree, collapsed};
  }

  const previous = readPreference(preferences, 'nexus-sidebar-zones-v2');
  const previousPanels = new Set();
  const previousTree = readTree(previous?.tree, previousPanels, [...legacyPanels, 'linked']);
  const legacy = readPreference(preferences, 'nexus-sidebar-zones-v1') ?? {};
  const valid = previousTree && legacyPanels.every(name => previousPanels.has(name));
  const previousCollapsed = valid ? previous.collapsed : legacy;
  let tabId;
  try { tabId = preferences.getItem('nexus-organize-tab'); } catch { /* The default tab is quick access. */ }
  const selected = organizePanels.find(name => tabId === `organize-${name}-tab`) ?? 'shortcuts';
  return {
    tree:migrateOrganizer(valid ? removePanel(previousTree, 'linked') : legacyLayout(legacy), selected),
    collapsed:{folder:previousCollapsed?.folder === true, [selected]:previousCollapsed?.organize === true},
  };
}

export function saveSidebarLayout(tree, collapsed, preferences = localStorage) {
  try { preferences.setItem(storageKey, JSON.stringify({tree, collapsed})); }
  catch { /* Keep the current layout when preferences cannot be saved. */ }
}

export function findDockGroup(tree, panel) {
  if (tree.tabs) return tree.tabs.includes(panel) ? tree : null;
  return findDockGroup(tree.first, panel) ?? findDockGroup(tree.second, panel);
}

export function visibleDockLayout(tree, include) {
  if (tree.tabs) {
    const tabs = tree.tabs.filter(include);
    if (!tabs.length) return null;
    return {node:tree, tabs, active:tabs.includes(tree.active) ? tree.active : tabs[0]};
  }
  const first = visibleDockLayout(tree.first, include);
  const second = visibleDockLayout(tree.second, include);
  return first && second ? {node:tree, first, second} : first ?? second;
}

function rewriteGroup(tree, panel, update) {
  if (tree.tabs) return tree.tabs.includes(panel) ? update(tree) : tree;
  const first = rewriteGroup(tree.first, panel, update);
  const second = rewriteGroup(tree.second, panel, update);
  if (first === tree.first && second === tree.second) return tree;
  return first && second ? {...tree, first, second} : first ?? second;
}

function removePanel(tree, panel) {
  return rewriteGroup(tree, panel, group => {
    const tabs = group.tabs.filter(name => name !== panel);
    return tabs.length ? tabGroup(tabs, tabs.includes(group.active) ? group.active : tabs[0]) : null;
  });
}

export function dockPanel(tree, source, target, placement, before) {
  if (source === target) return tree;
  const remaining = removePanel(tree, source);
  if (!remaining || !findDockGroup(remaining, target)) return tree;
  return rewriteGroup(remaining, target, group => {
    if (placement === 'center' || placement === 'tab') {
      const tabs = [...group.tabs];
      const insertion = tabs.indexOf(before);
      tabs.splice(insertion === -1 ? tabs.length : insertion, 0, source);
      return tabGroup(tabs, source);
    }
    const axis = placement === 'left' || placement === 'right' ? 'row' : 'column';
    const first = placement === 'left' || placement === 'top';
    const incoming = tabGroup([source]);
    return first ? split(axis, 0.5, incoming, group) : split(axis, 0.5, group, incoming);
  });
}
