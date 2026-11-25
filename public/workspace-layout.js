const storageKey = 'nexus-workspace-layout-v1';
const inspectorBreakpoint = 950;
const limits = {
  sidebar: { max: 380, defaultWidth: 226 },
  inspector: { min: 224, max: 540, defaultWidth: 307 },
};
const panelNames = { sidebar: '左侧导航', inspector: '右侧资产详情' };

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
  chevron.setAttribute('href', '#i-chevron');
  icon.append(chevron);
  button.append(icon);
  return button;
}

export function initWorkspaceLayout(preferences = localStorage) {
  const app = document.querySelector('#app');
  const sidebar = app?.querySelector('.sidebar');
  const workArea = app?.querySelector('.work-area');
  const inspector = app?.querySelector('.inspector');
  const topbar = app?.querySelector('.topbar');
  const navigation = topbar?.querySelector('#workspace-tools-nav');
  const topActions = topbar?.querySelector('.top-actions');
  if (!sidebar || !workArea || !inspector || !navigation || !topActions || app.querySelector('.workspace-divider')) return;

  sidebar.id ||= 'workspace-sidebar';
  inspector.id ||= 'workspace-inspector';

  const dividers = {
    sidebar: createDivider(sidebar, 'sidebar', '调整文件夹栏宽度'),
    inspector: createDivider(inspector, 'inspector', '调整资产详情栏宽度'),
  };
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
  topActions.append(toggles.inspector);

  const preferred = readLayout(preferences);
  const { collapsed } = preferred;
  let defaults;
  let geometry;
  let widths;
  let drag = null;

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
      return {
        min: geometry.sideMin,
        max: Math.max(geometry.sideMin, maxWidth(key, widths.inspector)),
      };
    }
    return {
      min: limits.inspector.min,
      max: Math.max(limits.inspector.min, maxWidth(key, widths.sidebar)),
    };
  }

  function renderWidths() {
    const inspectorVisible = geometry.hasInspector && !collapsed.inspector;
    const sidebarWidth = collapsed.sidebar
      ? 0
      : clamp(preferred.sidebar ?? defaults.sidebar, geometry.sideMin,
        maxWidth('sidebar', inspectorVisible ? limits.inspector.min : 0));
    const inspectorWidth = inspectorVisible
      ? clamp(preferred.inspector ?? defaults.inspector, limits.inspector.min, maxWidth('inspector', sidebarWidth))
      : 0;
    widths = { sidebar: sidebarWidth, inspector: inspectorWidth };
    app.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    app.style.setProperty('--detail-width', `${inspectorWidth}px`);
    for (const key of Object.keys(dividers)) {
      const divider = dividers[key];
      if (divider.hidden) continue;
      const { min, max } = bounds(key);
      divider.setAttribute('aria-valuemin', String(min));
      divider.setAttribute('aria-valuemax', String(max));
      divider.setAttribute('aria-valuenow', String(widths[key]));
      divider.setAttribute('aria-valuetext', `${widths[key]} 像素`);
    }
  }

  function renderPanels() {
    for (const key of Object.keys(panels)) {
      const { activeElement } = document;
      const available = key === 'sidebar' || geometry.hasInspector;
      const expanded = available && !collapsed[key];
      const focusInPanel = panels[key].contains(activeElement) || dividers[key] === activeElement;
      if ((!expanded && focusInPanel) || (!available && toggles[key] === activeElement)) {
        toggles[available ? key : 'sidebar'].focus({ preventScroll: true });
      }
      panels[key].hidden = !expanded;
      dividers[key].hidden = !expanded;
      toggles[key].hidden = !available;
      toggles[key].setAttribute('aria-expanded', String(expanded));
      const label = `${expanded ? '收起' : '展开'}${panelNames[key]}`;
      toggles[key].setAttribute('aria-label', label);
      toggles[key].title = label;
    }
    renderWidths();
  }

  function adjust(key, value) {
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
      preferred[key] = originalWidth;
      renderWidths();
    } else {
      writeLayout(preferred, preferences);
    }
    if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
  }

  function reset(key) {
    preferred[key] = null;
    renderWidths();
    writeLayout(preferred, preferences);
  }

  for (const key of Object.keys(dividers)) {
    toggles[key].addEventListener('click', () => {
      if (drag) endDrag(true);
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
      drag = { key, pointerId: event.pointerId, startX: event.clientX, startWidth: widths[key], originalWidth: preferred[key] };
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
  return {
    reload() {
      if (drag) endDrag(true);
      const saved = readLayout(preferences);
      preferred.sidebar = saved.sidebar;
      preferred.inspector = saved.inspector;
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
