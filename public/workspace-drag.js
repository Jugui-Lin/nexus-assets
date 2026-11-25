const dragThreshold = 6;
const interactive = 'button, a, input, select, textarea, [contenteditable]';

function bounds(x1, y1, x2, y2) {
  return {
    left: Math.min(x1, x2), top: Math.min(y1, y2),
    right: Math.max(x1, x2), bottom: Math.max(y1, y2),
  };
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function initWorkspaceDrag(options) {
  const grid = document.querySelector('#asset-grid');
  const scroll = document.querySelector('#browser-scroll');
  const marquee = document.querySelector('#selection-marquee');
  const badge = document.querySelector('#drag-badge');
  const dock = document.querySelector('#dcc-drop-dock');
  const app = document.querySelector('#app');
  let gesture;
  let highlighted;
  let suppressClickUntil = 0;
  let frame;
  let outgoing = false;

  function finish() {
    const current = gesture;
    if (!current) return null;
    gesture = null;
    if (app.hasPointerCapture(current.pointer)) app.releasePointerCapture(current.pointer);
    if (current.active) suppressClickUntil = performance.now() + 120;
    cancelAnimationFrame(frame);
    frame = 0;
    marquee.classList.add('hidden');
    badge.classList.add('hidden');
    dock.classList.add('hidden');
    highlighted?.classList.remove('drop-target-active');
    highlighted = null;
    app.classList.remove('dragging-assets', 'marquee-selecting', 'has-drop-target');
    return current;
  }

  function cancel() {
    const current = finish();
    if (current?.active && current.kind === 'marquee') options.mark(current.before);
  }

  function startOutgoing(current, ids) {
    if (gesture !== current || !ids.length) return;
    outgoing = true;
    finish();
    Promise.resolve()
      .then(() => options.dragOut(ids))
      .catch(options.onError)
      .finally(() => {
        outgoing = false;
        suppressClickUntil = performance.now() + 120;
      });
  }

  function promoteCardDrag(current) {
    if (gesture !== current || current.scope !== options.scope()) return;
    startOutgoing(current, current.ids);
  }

  function start(event) {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch' ||
        gesture || outgoing || grid.classList.contains('hidden')) return;
    const card = event.target.closest('.asset-card');
    const handle = event.target.closest('[data-native-drag]');
    if (!handle && event.target.closest(interactive + ', .asset-list-header')) return;
    const area = scroll.getBoundingClientRect();
    if (event.clientX >= area.left + scroll.clientWidth) return;
    gesture = {
      kind: handle ? 'native' : !card || event.shiftKey ? 'marquee' : 'assets',
      id: card?.dataset.id, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      scrollTop: scroll.scrollTop, before: options.marked(), additive: event.shiftKey || event.ctrlKey || event.metaKey,
      active: false,
    };
  }

  function drawMarquee(current, x, y) {
    const area = scroll.getBoundingClientRect();
    const rect = bounds(current.x, current.y + current.scrollTop - scroll.scrollTop, x, y);
    const visible = {
      left: Math.max(rect.left, area.left), top: Math.max(rect.top, area.top),
      right: Math.min(rect.right, area.left + scroll.clientWidth), bottom: Math.min(rect.bottom, area.bottom),
    };
    marquee.style.left = visible.left + 'px';
    marquee.style.top = visible.top + 'px';
    marquee.style.width = Math.max(0, visible.right - visible.left) + 'px';
    marquee.style.height = Math.max(0, visible.bottom - visible.top) + 'px';
    const hits = [...grid.querySelectorAll('.asset-card')]
      .filter(card => overlaps(rect, card.getBoundingClientRect()))
      .map(card => card.dataset.id);
    options.mark(current.additive ? new Set([...current.before, ...hits]) : new Set(hits));
  }

  function findTarget(x, y) {
    return document.elementFromPoint(x, y)?.closest(options.dropSelector) || null;
  }

  function drawAssets(x, y) {
    badge.style.left = Math.max(4, Math.min(x + 15, window.innerWidth - badge.offsetWidth - 6)) + 'px';
    badge.style.top = Math.max(4, Math.min(y + 16, window.innerHeight - badge.offsetHeight - 6)) + 'px';
    const target = findTarget(x, y);
    if (target === highlighted) return;
    highlighted?.classList.remove('drop-target-active');
    highlighted = target;
    highlighted?.classList.add('drop-target-active');
    app.classList.toggle('has-drop-target', Boolean(target));
  }

  function draw() {
    frame = 0;
    const current = gesture;
    if (!current?.active) return;
    const {clientX: x, clientY: y} = current;
    const area = scroll.getBoundingClientRect();
    const edge = 32;
    const delta = x >= area.left && x < area.right
      ? y < area.top + edge && y >= area.top - edge ? -12
      : y > area.bottom - edge && y <= area.bottom + edge ? 12 : 0
      : 0;
    const previous = scroll.scrollTop;
    if (delta) scroll.scrollTop += delta;
    if (current.kind === 'marquee') drawMarquee(current, x, y);
    else drawAssets(x, y);
    if (previous !== scroll.scrollTop) frame = requestAnimationFrame(draw);
  }

  function move(event) {
    const current = gesture;
    if (!current || event.pointerId !== current.pointer) return;
    if (!(event.buttons & 1)) return cancel();
    const {clientX, clientY} = event;
    if (!current.active) {
      if (Math.hypot(clientX - current.x, clientY - current.y) < dragThreshold) return;
      current.active = true;
      if (current.kind === 'native') {
        startOutgoing(current, options.draggedIds(current.id));
        return;
      }
      app.setPointerCapture(current.pointer);
      if (current.kind === 'marquee') {
        app.classList.add('marquee-selecting');
        marquee.classList.remove('hidden');
      } else {
        current.ids = options.draggedIds(current.id);
        current.scope = options.scope();
        app.classList.add('dragging-assets');
        const hint = options.outgoingHint?.(current.ids);
        badge.textContent = current.ids.length + ' 项资产' + (hint ? ' · ' + hint : '');
        badge.classList.remove('hidden');
        dock.classList.toggle('hidden', !dock.childElementCount);
        if (options.allowExternalDrag && options.waitForExternalDrag && current.ids.length) {
          // The Windows cursor watch also covers cases where the WebView drops an edge event.
          Promise.resolve().then(() => options.waitForExternalDrag()).then(exited => {
            if (exited) promoteCardDrag(current);
          }).catch(() => {});
        }
      }
    }
    event.preventDefault();
    if (options.allowExternalDrag && current.kind === 'assets' &&
        (clientX < 0 || clientY < 0 || clientX >= window.innerWidth || clientY >= window.innerHeight)) {
      promoteCardDrag(current);
      return;
    }
    current.clientX = clientX;
    current.clientY = clientY;
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function up(event) {
    if (gesture?.pointer !== event.pointerId) return;
    const target = gesture.active && gesture.kind === 'assets' && findTarget(event.clientX, event.clientY);
    if (gesture.active && gesture.kind === 'marquee') drawMarquee(gesture, event.clientX, event.clientY);
    const current = finish();
    if (target && current.scope === options.scope()) {
      Promise.resolve(options.drop(target, current.ids, current.scope)).catch(options.onError);
    }
  }

  scroll.addEventListener('pointerdown', start);
  scroll.addEventListener('dragstart', event => event.preventDefault());
  window.addEventListener('pointermove', move, {passive: false});
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  app.addEventListener('lostpointercapture', event => {
    if (gesture?.pointer !== event.pointerId) return;
    // The top bar can release capture while the mouse is still held. Window
    // listeners continue the asset gesture using the pointer's actual position.
    if (gesture.kind === 'assets' && (event.buttons & 1)) return;
    cancel();
  });
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && gesture?.active) {
      event.preventDefault();
      cancel();
    }
  });
  document.addEventListener('click', event => {
    if (event.detail && (gesture?.active || performance.now() < suppressClickUntil)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  return {isDraggingOut: () => outgoing};
}
