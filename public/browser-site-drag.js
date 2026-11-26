const gridSelector = '.browser-site-grid';
const moveEasing = 'cubic-bezier(.2,.8,.25,1.06)';

export function initBrowserSiteDrag(list, {move, repaint}) {
  const scroller = list.closest('.browser-scroll');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let drag;
  let settling;
  let suppressClick = false;

  function details(card, grid, before) {
    return {id:card.dataset.siteId, category:grid.dataset.siteCategory, before:before?.dataset.siteId,
      bookmark:grid.hasAttribute('data-site-bookmarks')};
  }

  function begin(current) {
    const rect = current.card.getBoundingClientRect();
    const preview = current.card.cloneNode(true);
    preview.classList.add('browser-site-drag-preview');
    preview.removeAttribute('data-site-id');
    preview.setAttribute('aria-hidden', 'true');
    preview.inert = true;
    preview.style.width = rect.width + 'px';
    preview.style.height = rect.height + 'px';
    current.dx = current.x - rect.left;
    current.dy = current.y - rect.top;
    current.preview = preview;
    current.card.setAttribute('data-site-dragging', '');
    document.body.append(preview);
    list.setPointerCapture(current.pointer);
    suppressClick = true;
  }

  function moveInto(current, grid, before) {
    if (current.card.parentElement === grid && current.card.nextElementSibling === before) return;
    const previous = reducedMotion.matches ? [] : Array.from(list.querySelectorAll('[data-site-id]'))
      .filter(card => card !== current.card).map(card => [card, card.getBoundingClientRect()]);
    for (const animation of current.shifts) animation.cancel();
    current.shifts.length = 0;
    grid.insertBefore(current.card, before);
    for (const [card, from] of previous) {
      const to = card.getBoundingClientRect();
      const x = from.left - to.left;
      const y = from.top - to.top;
      if (x || y) current.shifts.push(card.animate([
        {transform:'translate(' + x + 'px,' + y + 'px)'}, {transform:'none'},
      ], {duration:175, easing:moveEasing}));
    }
  }

  function update(autoscroll = true) {
    const current = drag;
    if (!current?.preview) return;
    current.frame = 0;
    const {x, y, card, origin} = current;
    current.preview.style.transform = 'translate(' + (x - current.dx) + 'px,' + (y - current.dy) + 'px)';
    const bounds = scroller?.getBoundingClientRect();
    current.valid = false;
    if (bounds && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)) return;
    const grids = Array.from(list.querySelectorAll(gridSelector)).filter(grid =>
      grid.hasAttribute('data-site-bookmarks') === origin.hasAttribute('data-site-bookmarks'));
    const grid = grids.find(item => {
      const rect = item.parentElement.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    if (grid) {
      const rect = grid.getBoundingClientRect();
      const slot = Array.from(grid.children).find(item =>
        x >= rect.left + item.offsetLeft - 4 && x < rect.left + item.offsetLeft + item.offsetWidth + 4 &&
        y >= rect.top + item.offsetTop - 4 && y < rect.top + item.offsetTop + item.offsetHeight + 4);
      current.valid = true;
      if (slot !== card) {
        const after = slot && card.parentElement === grid &&
          Boolean(card.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING);
        moveInto(current, grid, slot ? (after ? slot.nextElementSibling : slot) : null);
      }
    }
    if (!bounds || !autoscroll) return;
    const step = y < bounds.top + 35 ? -12 : y > bounds.bottom - 35 ? 12 : 0;
    const previous = scroller.scrollTop;
    scroller.scrollTop += step;
    if (scroller.scrollTop !== previous) current.frame = requestAnimationFrame(() => update());
  }

  function clear(current, cancelShifts = true) {
    if (cancelShifts) for (const animation of current.shifts) animation.cancel();
    current.preview.remove();
    current.card.removeAttribute('data-site-dragging');
  }

  function end(apply, paint = true) {
    const current = drag;
    if (!current) return;
    drag = undefined;
    if (!current.preview) return;
    cancelAnimationFrame(current.frame);
    if (list.hasPointerCapture(current.pointer)) list.releasePointerCapture(current.pointer);
    const grid = current.card.parentElement;
    const before = current.card.nextElementSibling;
    const changed = grid !== current.origin || before !== current.next;
    const accepted = apply && current.valid && (!changed || move(details(current.card, grid, before)));
    if (!accepted && changed) current.origin.insertBefore(current.card, current.next);
    if (accepted && grid !== current.origin && !current.origin.childElementCount) current.origin.parentElement.remove();
    if (!accepted || reducedMotion.matches || !paint) {
      clear(current);
      if (paint) repaint(current.card.dataset.siteId);
      return;
    }
    const rect = current.card.getBoundingClientRect();
    const animation = current.preview.animate([
      {transform:current.preview.style.transform},
      {transform:'translate(' + rect.left + 'px,' + rect.top + 'px)'},
    ], {duration:150, easing:moveEasing, fill:'forwards'});
    settling = {current, animation};
    animation.onfinish = () => {
      if (settling?.animation !== animation) return;
      settling = undefined;
      clear(current,false);
      repaint(current.card.dataset.siteId);
    };
  }

  function cancel() {
    end(false, false);
    if (settling) {
      const {current, animation} = settling;
      settling = undefined;
      animation.cancel();
      clear(current);
    }
  }

  list.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || drag || settling) return;
    const card = event.target.closest('.browser-site')?.closest('[data-site-id]');
    suppressClick = false;
    if (!card) return;
    drag = {card, origin:card.parentElement, next:card.nextElementSibling, pointer:event.pointerId,
      startX:event.clientX, startY:event.clientY, x:event.clientX, y:event.clientY, shifts:[], frame:0};
  });
  window.addEventListener('pointermove', event => {
    const current = drag;
    if (!current || event.pointerId !== current.pointer) return;
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) return end(false);
    if (!current.preview) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
      begin(current);
    }
    current.x = event.clientX;
    current.y = event.clientY;
    event.preventDefault();
    if (!current.frame) current.frame = requestAnimationFrame(() => update());
  }, {capture:true, passive:false});
  window.addEventListener('pointerup', event => {
    if (drag?.pointer !== event.pointerId) return;
    if (drag.preview) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      cancelAnimationFrame(drag.frame);
      update(false);
    }
    end(true);
  }, {capture:true});
  for (const type of ['pointercancel', 'lostpointercapture']) {
    window.addEventListener(type, event => {
      if (drag?.pointer === event.pointerId) end(false);
    }, {capture:true});
  }
  list.addEventListener('click', event => {
    if (!suppressClick || !event.detail) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  list.addEventListener('keydown', event => {
    const direction = {'ArrowLeft':-1,'ArrowUp':-1,'ArrowRight':1,'ArrowDown':1}[event.key];
    const card = event.target.closest('.browser-site')?.closest('[data-site-id]');
    if (!direction || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !card || drag || settling) return;
    event.preventDefault();
    const target = direction < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (target && move(details(card, card.parentElement, direction < 0 ? target : target.nextElementSibling))) {
      repaint(card.dataset.siteId);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !drag?.preview) return;
    event.preventDefault();
    event.stopPropagation();
    end(false);
  }, {capture:true});
  window.addEventListener('blur', () => end(false));
  return {cancel, busy:() => Boolean(drag || settling)};
}
