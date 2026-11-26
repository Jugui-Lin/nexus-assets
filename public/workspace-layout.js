const storageKey = 'nexus-workspace-layout-v1';
const inspectorBreakpoint = 950;
const limits = {
  sidebar: { max: 380, defaultWidth: 226 },
  inspector: { min: 224, max: 540, defaultWidth: 307 },
};
const panelNames = { sidebar: '左侧导航', inspector: '资产详情' };

function readLayout(preferences) {
  let saved;
  try {
    saved = JSON.parse(preferences.getItem(storageKey) || '{}');
  } catch {
    // The default layout also works without access to browser storage.
  }
  return {
    sidebar: Number.isFinite(saved?.sidebar) ? saved.sidebar : null,
    inspector: Number.isFinite(saved?.inspector) ? saved.inspector : null,
    inspectorDock: saved?.inspectorDock === 'bottom' ? 'bottom' : 'right',
    collapsed: {
      sidebar: saved?.collapsed?.sidebar === true,
      inspector: saved?.collapsed?.inspector === true,
    },
  };
}

function writeLayout(layout, preferences) {
  try {
    preferences.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // Changes remain active for the current session.
  }
}

function clamp(value, minimum, maximum) {
  return Math.round(Math.max(minimum, Math.min(maximum, value)));
}

function createDivider(panel, key, label) {
  const divider = document.createElement('div');
  divider.className = `workspace-divider workspace-divider--${key}`;
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-controls', panel.id);
  divider.setAttribute('aria-label', label);
  divider.title = `${label}，双击恢复默认宽度`;
  const measurement = document.createElement('span');
  measurement.className = 'workspace-divider-measurement';
  measurement.setAttribute('aria-hidden','true');
  divider.append(measurement);
  return divider;
}

function createPanelToggle(panel, key) {
  const button = document.createElement('button');
  button.className = `icon-button workspace-panel-toggle workspace-panel-toggle--${key}`;
  button.type = 'button';
  button.setAttribute('aria-controls', panel.id);
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(svgNamespace, 'svg');
  const chevron = document.createElementNS(svgNamespace, 'use');
  icon.setAttribute('aria-hidden', 'true');
  chevron.setAttribute('href', key === 'inspector' ? '#i-info' : '#i-chevron');
  icon.append(chevron);
  button.append(icon);
  return button;
}

export function initWorkspaceLayout(preferences = localStorage, sharedSidebar) {
  const app = document.querySelector('#app');
  const sidebar = app?.querySelector('.sidebar');
  const workArea = app?.querySelector('.work-area');
  const inspector = app?.querySelector('.inspector');
  const topbar = app?.querySelector('.topbar');
  const navigation = topbar?.querySelector('#workspace-tools-nav');
  const viewControls = workArea?.querySelector('.asset-filter-strip .view-controls');
  if (!sidebar || !workArea || !inspector || !navigation || !viewControls || app.querySelector('.workspace-divider')) return;

  sidebar.id ||= 'workspace-sidebar';
  inspector.id ||= 'workspace-inspector';

  const dividers = {
    sidebar: createDivider(sidebar, 'sidebar', '调整文件夹栏宽度'),
    inspector: createDivider(inspector, 'inspector', '调整资产详情栏宽度'),
  };
  if (sharedSidebar) dividers.sidebar.classList.add('workspace-divider--shared');
  sidebar.after(dividers.sidebar);
  inspector.before(dividers.inspector);

  const panels = { sidebar, inspector };
  const toggles = {
    sidebar: createPanelToggle(sidebar, 'sidebar'),
    inspector: createPanelToggle(inspector, 'inspector'),
  };
  const leading = document.createElement('div');
  leading.className = 'workspace-toolbar-leading';
  navigation.before(leading);
  leading.append(toggles.sidebar, navigation);
  viewControls.append(toggles.inspector);
  const inspectorDock = document.createElement('button');
  inspectorDock.type = 'button';
  inspectorDock.className = 'icon-button workspace-inspector-dock';
  inspectorDock.innerHTML = '<svg aria-hidden="true"><use href="#i-compare"/></svg>';
  viewControls.append(inspectorDock);

  const preferred = readLayout(preferences);
  const { collapsed } = preferred;
  let defaults;
  let geometry;
  let widths;
  let drag = null;
  let context = {assetView:true, split:false, pane:null, tabId:null};
  let overlayOpen = false;
  let overlayPane = null;
  let sidebarPeek = false;
  let peekTimer;

  const inspectorAvailable = () => context.assetView && (geometry.hasInspector || preferred.inspectorDock === 'bottom');
  const inspectorExpanded = () => inspectorAvailable() && (context.split ? overlayOpen : !collapsed.inspector);
  const reservedDetailWidth = () => geometry.hasInspector && preferred.inspectorDock === 'right' && !collapsed.inspector ? limits.inspector.min : 0;

  function readGeometry() {
    const viewport = window.innerWidth;
    const sideMin = viewport <= 640 ? Math.min(104, Math.round(viewport * .35)) : 156;
    const hasInspector = viewport > inspectorBreakpoint;
    const centerMin = hasInspector ? 390 : viewport <= 640 ? 166 : 280;
    geometry = { sideMin, hasInspector, panelSpace: viewport - centerMin };
    const rootStyle = getComputedStyle(document.documentElement);
    defaults = {
      sidebar: Number.parseFloat(rootStyle.getPropertyValue('--sidebar-width')) || limits.sidebar.defaultWidth,
      inspector: Number.parseFloat(rootStyle.getPropertyValue('--detail-width')) || limits.inspector.defaultWidth,
    };
  }

  function maxWidth(key, otherWidth) {
    return Math.min(limits[key].max, geometry.panelSpace - otherWidth);
  }

  function bounds(key) {
    if (key === 'sidebar') {
      if (sharedSidebar) return sharedSidebar.bounds();
      return {
        min: geometry.sideMin,
        max: Math.max(geometry.sideMin, maxWidth(key, Math.max(widths.inspector, reservedDetailWidth()))),
      };
    }
    return {
      min: limits.inspector.min,
      max: Math.max(limits.inspector.min, maxWidth(key, widths.sidebar)),
    };
  }

  function renderWidths() {
    const inspectorDocked = !context.split && preferred.inspectorDock === 'right' && inspectorExpanded();
    const sidebarWidth = collapsed.sidebar
      ? 0
      : sharedSidebar?.value() ?? clamp(preferred.sidebar ?? defaults.sidebar, geometry.sideMin,
        maxWidth('sidebar', reservedDetailWidth()));
    const inspectorWidth = inspectorDocked
      ? clamp(preferred.inspector ?? defaults.inspector, limits.inspector.min, maxWidth('inspector', sidebarWidth))
      : 0;
    widths = { sidebar: sidebarWidth, inspector: inspectorWidth };
    app.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    app.style.setProperty('--sidebar-peek-width', `${sharedSidebar?.value() ?? (preferred.sidebar ?? defaults.sidebar)}px`);
    app.style.setProperty('--detail-width', `${inspectorWidth}px`);
    if (overlayPane) {
      const overlayWidth = clamp(preferred.inspector ?? defaults.inspector, limits.inspector.min, limits.inspector.max);
      inspector.style.setProperty('--inspector-overlay-width', `${overlayWidth}px`);
    }
    for (const key of Object.keys(dividers)) {
      const divider = dividers[key];
      if (divider.hidden) continue;
      const { min, max } = bounds(key);
      divider.setAttribute('aria-valuemin', String(min));
      divider.setAttribute('aria-valuemax', String(max));
      divider.setAttribute('aria-valuenow', String(widths[key]));
      divider.setAttribute('aria-valuetext', `${widths[key]} 像素`);
      divider.firstElementChild.textContent = `${widths[key]} px`;
    }
  }

  function renderPanels() {
    if (!collapsed.sidebar) sidebarPeek = false;
    const bottom = preferred.inspectorDock === 'bottom';
    sidebar.toggleAttribute('data-sidebar-peek',sidebarPeek);
    workArea.toggleAttribute('data-inspector-bottom',bottom && !context.split && inspectorExpanded());
    inspectorDock.hidden = !context.assetView;
    inspectorDock.setAttribute('aria-pressed',String(bottom));
    inspectorDock.title = bottom ? '将资产详情移到右侧' : '将资产详情移到底部';
    inspectorDock.setAttribute('aria-label',inspectorDock.title);
    for (const key of Object.keys(panels)) {
      const { activeElement } = document;
      const sidebarPanel = key === 'sidebar';
      const available = sidebarPanel || inspectorAvailable();
      const expanded = sidebarPanel ? !collapsed.sidebar || sidebarPeek : inspectorExpanded();
      const docked = expanded && (sidebarPanel ? !sidebarPeek : !context.split && !bottom);
      const focusInPanel = panels[key].contains(activeElement) || dividers[key] === activeElement;
      if ((!expanded && focusInPanel) || (!available && toggles[key] === activeElement) ||
          (!docked && dividers[key] === activeElement)) {
        toggles[available ? key : 'sidebar'].focus({ preventScroll: true });
      }
      panels[key].hidden = !expanded;
      dividers[key].hidden = !docked;
      toggles[key].hidden = !available;
      toggles[key].setAttribute('aria-expanded', String(expanded));
      const label = sidebarPanel && sidebarPeek ? '固定显示左侧导航' : `${expanded ? '收起' : '展开'}${panelNames[key]}`;
      toggles[key].setAttribute('aria-label', label);
      toggles[key].title = label;
    }
    const nextPane = context.split && inspectorExpanded() ? context.pane : null;
    if (overlayPane !== nextPane) {
      overlayPane?.removeAttribute('data-pane-inspector');
      overlayPane?.removeAttribute('data-pane-inspector-bottom');
      if (nextPane) {
        nextPane.setAttribute('data-pane-inspector', '');
        nextPane.append(inspector);
      } else if (overlayPane) {
        dividers.inspector.after(inspector);
      }
      overlayPane = nextPane;
    }
    overlayPane?.toggleAttribute('data-pane-inspector-bottom',bottom);
    renderWidths();
  }

  function adjust(key, value) {
    if (key === 'sidebar' && sharedSidebar) {
      sharedSidebar.set(value);
      return;
    }
    const { min, max } = bounds(key);
    preferred[key] = clamp(value, min, max);
    renderWidths();
  }

  function resizeFromPointer(event, key) {
    const sign = key === 'sidebar' ? 1 : -1;
    adjust(key, drag.startWidth + sign * (event.clientX - drag.startX));
  }

  function endDrag(cancelled) {
    if (!drag) return;
    const { key, pointerId, originalWidth } = drag;
    drag = null;
    const divider = dividers[key];
    divider.classList.remove('is-resizing');
    app.classList.remove('workspace-resizing');
    if (cancelled) {
      if (key === 'sidebar' && sharedSidebar) sharedSidebar.set(originalWidth);
      else {
        preferred[key] = originalWidth;
        renderWidths();
      }
    } else {
      if (key === 'sidebar') sharedSidebar?.persist();
      writeLayout(preferred, preferences);
    }
    if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
  }

  function reset(key) {
    if (key === 'sidebar' && sharedSidebar) {
      sharedSidebar.set(null);
      sharedSidebar.persist();
      return;
    }
    preferred[key] = null;
    renderWidths();
    writeLayout(preferred, preferences);
  }

  inspectorDock.addEventListener('click',() => {
    if (drag?.key === 'inspector') endDrag(true);
    preferred.inspectorDock = preferred.inspectorDock === 'bottom' ? 'right' : 'bottom';
    if (context.split) overlayOpen = true;
    else collapsed.inspector = false;
    renderPanels();
    writeLayout(preferred,preferences);
  });
  const sidebarToggle = toggles.sidebar;
  const inSidebar = target => target instanceof Node && (sidebar.contains(target) || sidebarToggle.contains(target));
  function setSidebarPeek(value) {
    clearTimeout(peekTimer);
    const next = value && collapsed.sidebar;
    if (next === sidebarPeek) return;
    sidebarPeek = next;
    renderPanels();
  }
  for (const zone of [sidebar,sidebarToggle]) {
    zone.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse' || !collapsed.sidebar) return;
      clearTimeout(peekTimer);
      if (!sidebarPeek) peekTimer = setTimeout(() => setSidebarPeek(true),250);
    });
    zone.addEventListener('pointerleave',event => {
      if (event.pointerType !== 'mouse' || inSidebar(event.relatedTarget)) return;
      clearTimeout(peekTimer);
      if (sidebarPeek && !sidebar.contains(document.activeElement)) peekTimer = setTimeout(() => setSidebarPeek(false),180);
    });
    zone.addEventListener('focusout',event => {
      if (sidebarPeek && !inSidebar(event.relatedTarget) && !sidebar.matches(':hover')) setSidebarPeek(false);
    });
    zone.addEventListener('keydown',event => {
      if (event.key !== 'Escape' || !sidebarPeek) return;
      event.preventDefault();
      setSidebarPeek(false);
      sidebarToggle.focus({preventScroll:true});
    });
  }
  document.addEventListener('pointerdown',event => {
    if (sidebarPeek && !inSidebar(event.target)) setSidebarPeek(false);
  });

  for (const key of Object.keys(dividers)) {
    toggles[key].addEventListener('click', () => {
      if (drag) endDrag(true);
      if (key === 'inspector' && context.split) {
        overlayOpen = !overlayOpen;
        renderPanels();
        return;
      }
      collapsed[key] = !collapsed[key];
      renderPanels();
      writeLayout(preferred, preferences);
    });
    const divider = dividers[key];
    divider.addEventListener('pointerdown', event => {
      if (drag || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      divider.focus({ preventScroll: true });
      divider.setPointerCapture(event.pointerId);
      const originalWidth = key === 'sidebar' && sharedSidebar ? sharedSidebar.preferred() : preferred[key];
      drag = { key, pointerId: event.pointerId, startX: event.clientX, startWidth: widths[key], originalWidth };
      app.classList.add('workspace-resizing');
      divider.classList.add('is-resizing');
    });
    divider.addEventListener('pointermove', event => {
      if (drag?.pointerId === event.pointerId) resizeFromPointer(event, key);
    });
    divider.addEventListener('pointerup', event => {
      if (drag?.pointerId !== event.pointerId) return;
      if (event.clientX !== drag.startX) resizeFromPointer(event, key);
      endDrag(false);
    });
    for (const name of ['pointercancel', 'lostpointercapture']) {
      divider.addEventListener(name, event => {
        if (drag?.pointerId === event.pointerId) endDrag(true);
      });
    }
    divider.addEventListener('dblclick', () => reset(key));
    divider.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) {
        event.preventDefault();
        endDrag(true);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        reset(key);
        return;
      }
      let width;
      if (event.key === 'Home') width = bounds(key).min;
      else if (event.key === 'End') width = bounds(key).max;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const panelSide = key === 'sidebar' ? 1 : -1;
        width = widths[key] + panelSide * direction * (event.shiftKey ? 48 : 16);
      } else {
        return;
      }
      event.preventDefault();
      adjust(key, width);
      if (key === 'sidebar') sharedSidebar?.persist();
      writeLayout(preferred, preferences);
    });
  }

  function onResize() {
    readGeometry();
    if (drag && !geometry.hasInspector && drag.key === 'inspector') endDrag(true);
    renderPanels();
  }

  window.addEventListener('resize', onResize);
  onResize();
  sharedSidebar?.subscribe(renderWidths);
  return {
    snapshot() {
      return {
        sidebar:sharedSidebar ? sharedSidebar.preferred() : preferred.sidebar,
        inspector:preferred.inspector,
        inspectorDock:preferred.inspectorDock,
        collapsed:{...collapsed},
      };
    },
    applySnapshot(input) {
      if (drag) endDrag(true);
      const values = {
        sidebar:Number.isFinite(input?.sidebar) ? clamp(input.sidebar,0,480) : null,
        inspector:Number.isFinite(input?.inspector) ? clamp(input.inspector,limits.inspector.min,limits.inspector.max) : null,
        inspectorDock:input?.inspectorDock === 'bottom' ? 'bottom' : 'right',
        collapsed:{sidebar:input?.collapsed?.sidebar === true,inspector:input?.collapsed?.inspector === true},
      };
      preferences.setItem(storageKey,JSON.stringify(values));
      if (sharedSidebar) {
        sharedSidebar.set(values.sidebar);
        sharedSidebar.persist();
      }
      Object.assign(preferred,{sidebar:values.sidebar,inspector:values.inspector,inspectorDock:values.inspectorDock});
      Object.assign(collapsed,values.collapsed);
      overlayOpen = false;
      onResize();
    },
    setInspectorContext(next) {
      if (next.assetView === context.assetView && next.split === context.split &&
          next.pane === context.pane && next.tabId === context.tabId) return;
      if (drag?.key === 'inspector') endDrag(true);
      context = next;
      overlayOpen = false;
      renderPanels();
    },
    reload() {
      if (drag) endDrag(true);
      const saved = readLayout(preferences);
      preferred.sidebar = saved.sidebar;
      preferred.inspector = saved.inspector;
      preferred.inspectorDock = saved.inspectorDock;
      Object.assign(collapsed, saved.collapsed);
      onResize();
    },
    showSidebar() {
      if (!collapsed.sidebar) return;
      if (drag) endDrag(true);
      collapsed.sidebar = false;
      renderPanels();
      writeLayout(preferred, preferences);
    },
  };
}
