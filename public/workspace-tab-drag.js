const tabSelector = '.workspace-tab[data-tab-id]';
const dragAttribute = 'data-workspace-tab-dragging';
const shiftProperty = '--workspace-tab-drag-shift';
const dragDistance = 7;
const stripTolerance = 14;

function stripLayout(list) {
  const rect = list.getBoundingClientRect();
  const style = getComputedStyle(list);
  const gap = parseFloat(style.columnGap) || 0;
  let left = rect.left + list.clientLeft + (parseFloat(style.paddingLeft) || 0) - list.scrollLeft;
  const tabs = [...list.children].filter(tab => tab.matches(tabSelector)).map(tab => {
    const width = tab.getBoundingClientRect().width;
    const slot = {tab, left, width};
    left += width + gap;
    return slot;
  });
  return {list, rect, tabs, gap};
}

function getStripAt(strips, x, y) {
  const row = strips.filter(({rect}) => rect.height &&
    y >= rect.top - stripTolerance && y <= rect.bottom + stripTolerance &&
    x >= rect.left - stripTolerance && x <= rect.right + stripTolerance);
  const distance = ({rect}) => Math.max(rect.left - x, x - rect.right, 0);
  return row.sort((a, b) => distance(a) - distance(b))[0];
}

function getDockEdge(rect, x, y, current, accept) {
  if (!rect.width || !rect.height || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const offsetX = (x - rect.left) / rect.width - .5;
  const offsetY = (y - rect.top) / rect.height - .5;
  const edge = Math.abs(offsetX) <= Math.min(24 / rect.width, .035) &&
      Math.abs(offsetY) <= Math.min(24 / rect.height, .035) ? current
    : Math.abs(offsetX) >= Math.abs(offsetY) ? (offsetX < 0 ? 'left' : 'right')
      : (offsetY < 0 ? 'top' : 'bottom');
  return edge && accept(edge) ? edge : null;
}

export function dockAxis(edge) {
  return edge === 'top' || edge === 'bottom' ? 'rows' : 'columns';
}

export function dockRect(rect, edge, {ratio = .5, gap = 0, bottomInset = 0} = {}) {
  const rows = dockAxis(edge) === 'rows';
  const leading = edge === 'left' || edge === 'top';
  const innerHeight = rect.height - bottomInset;
  const available = Math.max(0, (rows ? innerHeight : rect.width) - gap);
  const length = available * (leading ? ratio : 1 - ratio);
  const width = rows ? rect.width : length;
  const height = rows ? length : innerHeight;
  return {
    left: edge === 'right' ? rect.right - width : rect.left,
    top: edge === 'bottom' ? rect.top + innerHeight - height : rect.top,
    width, height,
  };
}

function autoScroll({list, rect}, x) {
  if (list.scrollWidth <= list.clientWidth) return false;
  const edge = Math.min(34, rect.width / 4);
  const left = Math.max(0, rect.left + edge - x);
  const right = Math.max(0, x - rect.right + edge);
  const change = Math.round(Math.min(20, right * 0.45) - Math.min(20, left * 0.45));
  if (!change) return false;
  const before = list.scrollLeft;
  list.scrollLeft += change;
  return list.scrollLeft !== before;
}

function applyStripOffsets(strips, source, target, index, width) {
  for (const strip of strips) {
    let shift = 0;
    let insertion = 0;
    const pitch = width + strip.gap;
    const incoming = strip === target;
    const otherStrip = incoming && source.parentElement !== strip.list;
    strip.list.toggleAttribute('data-workspace-tab-strip-incoming', otherStrip);
    if (otherStrip) strip.list.style.setProperty('--workspace-tab-drag-space', width + 'px');
    else strip.list.style.removeProperty('--workspace-tab-drag-space');
    for (const {tab} of strip.tabs) {
      if (tab === source) {
        shift -= pitch;
        continue;
      }
      if (incoming && insertion === index) shift += pitch;
      tab.style.setProperty(shiftProperty, shift + 'px');
      insertion++;
    }
  }
}

const dockLabels = {left:'停靠到左侧', right:'停靠到右侧', top:'停靠到上方', bottom:'停靠到下方'};

export function initWorkspaceTabDrag({
  root, bounds = root, getLists, onDrop, getDockRect,
  canDrag = () => true, canSplit = () => true,
}) {
  const documentRoot = document.documentElement;
  const listeners = new AbortController();
  const signal = listeners.signal;
  const styledLists = new Set();
  let gesture;
  let frame = 0;
  let suppressClick = false;

  const ghost = document.createElement('div');
  ghost.className = 'workspace-tab-drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');

  const preview = document.createElement('div');
  preview.className = 'workspace-tab-drop-preview';
  preview.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  preview.append(label);

  function setPreview(rect, edge) {
    if (!edge) {
      preview.removeAttribute('data-workspace-tab-drop-edge');
      return;
    }
    const {left, top, width, height} = getDockRect?.(edge, rect) ?? dockRect(rect, edge);
    Object.assign(preview.style, {left:left + 7 + 'px', top:top + 7 + 'px',
      width:Math.max(0, width - 14) + 'px', height:Math.max(0, height - 14) + 'px'});
    if (preview.dataset.workspaceTabDropEdge !== edge) {
      label.textContent = dockLabels[edge];
      preview.dataset.workspaceTabDropEdge = edge;
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      updateTarget(true);
    });
  }

  function updateTarget(scroll = false) {
    const current = gesture;
    if (!current?.dragging) return;
    const {x, y, dx, dy, source, tabId, paneId, width, height} = current;
    if (!source.isConnected || !canDrag({tabId, paneId})) {
      stop();
      return;
    }
    let strips = Array.from(getLists(), stripLayout);
    let target = getStripAt(strips, x, y);
    if (target && scroll && autoScroll(target, x)) {
      strips = Array.from(getLists(), stripLayout);
      target = getStripAt(strips, x, y);
      schedule();
    }
    const surface = typeof bounds === 'function' ? bounds() : bounds;
    const rect = surface?.getBoundingClientRect();
    const edge = !target && rect ? getDockEdge(rect, x, y, current.drop?.edge, edge =>
      canSplit({tabId, paneId, edge})) : null;
    let index = null;
    if (target) {
      const peers = target.tabs.filter(({tab}) => tab !== source);
      index = peers.findIndex(slot => x < slot.left + slot.width / 2);
      if (index === -1) index = peers.length;
    }
    for (const {list} of strips) styledLists.add(list);
    applyStripOffsets(strips, source, target, index, width);
    setPreview(rect, edge);

    const top = target ? target.rect.top + (target.rect.height - height) / 2 : y - dy;
    ghost.style.transform = 'translate3d(' + (x - dx) + 'px,' + top + 'px,0)';
    ghost.toggleAttribute('data-workspace-tab-snapped', Boolean(target || edge));
    current.drop = target || edge
      ? {tabId, paneId, targetPaneId:target?.list.dataset.paneId ?? paneId, index, edge}
      : null;
  }

  function beginDrag(current) {
    current.dragging = true;
    suppressClick = true;
    current.source.setAttribute('data-workspace-tab-source', '');
    root.setAttribute(dragAttribute, '');
    documentRoot.setAttribute(dragAttribute, '');
    ghost.textContent = current.source.querySelector('.workspace-tab-trigger')?.textContent ?? '';
    ghost.style.width = current.width + 'px';
    ghost.style.height = current.height + 'px';
    document.body.append(preview, ghost);
    try { current.source.setPointerCapture(current.pointerId); } catch {}
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const current = gesture;
    gesture = undefined;
    if (!current?.dragging) return;
    if (current.source.hasPointerCapture(current.pointerId)) current.source.releasePointerCapture(current.pointerId);
    current.source.removeAttribute('data-workspace-tab-source');
    root.removeAttribute(dragAttribute);
    documentRoot.removeAttribute(dragAttribute);
    for (const list of styledLists) {
      list.removeAttribute('data-workspace-tab-strip-incoming');
      list.style.removeProperty('--workspace-tab-drag-space');
      for (const tab of list.querySelectorAll(tabSelector)) tab.style.removeProperty(shiftProperty);
    }
    styledLists.clear();
    setPreview(null, null);
    preview.remove();
    ghost.remove();
  }

  document.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || gesture) return;
    suppressClick = false;
    if (event.target.closest('.workspace-tab-close')) return;
    const source = event.target.closest(tabSelector);
    const list = source?.parentElement;
    if (!source || !Array.from(getLists()).includes(list)) return;
    const {tabId} = source.dataset;
    const {paneId} = list.dataset;
    if (!tabId || !paneId || !canDrag({tabId, paneId})) return;
    const {left, top, width, height} = source.getBoundingClientRect();
    gesture = {
      source, tabId, paneId, pointerId:event.pointerId, width, height,
      startX:event.clientX, startY:event.clientY, x:event.clientX, y:event.clientY,
      dx:event.clientX - left, dy:event.clientY - top,
    };
  }, {capture:true, signal});

  document.addEventListener('pointermove', event => {
    const current = gesture;
    if (!current || event.pointerId !== current.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (!current.dragging) {
      if (Math.hypot(current.x - current.startX, current.y - current.startY) < dragDistance) return;
      if (!current.source.isConnected || !canDrag(current)) {
        stop();
        return;
      }
      beginDrag(current);
    }
    event.preventDefault();
    schedule();
  }, {capture:true, signal});

  document.addEventListener('pointerup', event => {
    const current = gesture;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.dragging) {
      stop();
      return;
    }
    event.preventDefault();
    current.x = event.clientX;
    current.y = event.clientY;
    updateTarget();
    const drop = gesture?.drop;
    stop();
    if (drop) onDrop(drop);
  }, {capture:true, signal});

  document.addEventListener('click', event => {
    if (!suppressClick || !event.detail) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, {capture:true, signal});

  for (const type of ['pointercancel', 'lostpointercapture']) {
    document.addEventListener(type, event => {
      if (event.pointerId === gesture?.pointerId) stop();
    }, {capture:true, signal});
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !gesture?.dragging) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stop();
  }, {capture:true, signal});
  window.addEventListener('blur', stop, {signal});

  return {
    cancel:stop,
    destroy() {
      stop();
      listeners.abort();
    },
  };
}
