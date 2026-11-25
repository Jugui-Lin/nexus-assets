const folderButton = '.folder-row button[data-library][data-folder]';
const dragThreshold = 6;
const scrollEdge = 24;

export function initFolderPinDrag({tree, zone, scroll, getScope, pinFolder, canMoveFolder, moveFolder}) {
  if (!tree || !zone) return;
  const badge = document.createElement('div');
  badge.className = 'folder-pin-drag-badge hidden';
  badge.setAttribute('aria-hidden', 'true');
  document.body.append(badge);
  let drag;
  let frame;
  let moveTarget = null;
  let suppressClickUntil = 0;

  function dropTarget(x, y, current) {
    const hit = document.elementFromPoint(x, y);
    if (hit && zone.contains(hit)) return {kind:'pin'};
    const button = hit?.closest(folderButton);
    if (!button || !tree.contains(button)) return null;
    const {library, folder} = button.dataset;
    if (!canMoveFolder?.(current.library, current.folder, library, folder)) return null;
    return {kind:'move', button, folder};
  }

  function highlightMove(button) {
    if (moveTarget === button) return;
    moveTarget?.classList.remove('is-folder-move-target');
    moveTarget = button;
    moveTarget?.classList.add('is-folder-move-target');
  }

  function scrollNearPointer(container, x, y) {
    if (!container || container.hidden) return false;
    const area = container.getBoundingClientRect();
    if (x < area.left || x >= area.right || y < area.top || y >= area.bottom) return false;
    const previous = container.scrollTop;
    if (y < area.top + scrollEdge) container.scrollTop -= 12;
    else if (y >= area.bottom - scrollEdge) container.scrollTop += 12;
    return container.scrollTop !== previous;
  }

  function finish() {
    const current = drag;
    drag = null;
    if (!current?.active) return;
    if (tree.hasPointerCapture(current.pointer)) tree.releasePointerCapture(current.pointer);
    cancelAnimationFrame(frame);
    frame = 0;
    current.button.classList.remove('is-pin-source');
    highlightMove(null);
    zone.classList.remove('is-pin-target', 'is-pin-hover');
    document.body.classList.remove('folder-pin-dragging');
    badge.classList.add('hidden');
    suppressClickUntil = performance.now() + 200;
  }

  function draw() {
    frame = 0;
    if (!drag?.active) return;
    if (drag.scope !== getScope()) return finish();
    const {x, y} = drag;
    badge.style.left = Math.max(4, Math.min(x + 14, window.innerWidth - badge.offsetWidth - 4)) + 'px';
    badge.style.top = Math.max(4, Math.min(y + 16, window.innerHeight - badge.offsetHeight - 4)) + 'px';
    if (scrollNearPointer(tree, x, y) || scrollNearPointer(scroll, x, y)) frame = requestAnimationFrame(draw);
    const target = dropTarget(x, y, drag);
    zone.classList.toggle('is-pin-hover', target?.kind === 'pin');
    highlightMove(target?.button ?? null);
    badge.textContent = target?.kind === 'move' ? `移动到「${target.button.querySelector('.folder-label').textContent}」`
      : target?.kind === 'pin' ? `固定「${drag.label}」` : drag.label;
  }

  tree.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || event.pointerType === 'touch' || drag) return;
    const button = event.target.closest(folderButton);
    if (!button) return;
    drag = {
      button, pointer: event.pointerId, scope: getScope(), library: button.dataset.library,
      folder: button.dataset.folder, x: event.clientX, y: event.clientY, active: false,
      label: button.querySelector('.folder-label')?.textContent || '文件夹',
    };
  });

  tree.addEventListener('dragstart', event => {
    if (event.target.closest(folderButton)) event.preventDefault();
  });

  window.addEventListener('pointermove', event => {
    if (drag?.pointer !== event.pointerId) return;
    if (!(event.buttons & 1) || drag.scope !== getScope()) return finish();
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold) return;
      tree.setPointerCapture(drag.pointer);
      drag.active = true;
      drag.button.classList.add('is-pin-source');
      zone.classList.add('is-pin-target');
      document.body.classList.add('folder-pin-dragging');
      badge.textContent = drag.label;
      badge.classList.remove('hidden');
    }
    event.preventDefault();
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!frame) frame = requestAnimationFrame(draw);
  }, {passive: false});

  window.addEventListener('pointerup', event => {
    const current = drag;
    if (current?.pointer !== event.pointerId) return;
    const dropped = current.active && current.scope === getScope()
      ? dropTarget(event.clientX, event.clientY, current) : null;
    finish();
    if (dropped?.kind === 'pin') pinFolder(current.library, current.folder);
    else if (dropped?.kind === 'move') moveFolder(current.library, current.folder, dropped.folder);
  });

  function cancelPointer(event) {
    if (drag?.pointer === event.pointerId) finish();
  }
  window.addEventListener('pointercancel', cancelPointer);
  tree.addEventListener('lostpointercapture', cancelPointer);
  window.addEventListener('blur', finish);
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !drag?.active) return;
    event.preventDefault();
    finish();
  });
  document.addEventListener('pointerdown', () => { suppressClickUntil = 0; }, true);
  document.addEventListener('click', event => {
    if (!event.detail || performance.now() >= suppressClickUntil ||
        !(tree.contains(event.target) || zone.contains(event.target))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
