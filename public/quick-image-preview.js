const minimumZoom = .25;
const maximumZoom = 8;
const middleButton = 1;
const middlePressed = 4;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function initQuickImagePreview({viewport, image}) {
  let zoom = 1;
  let x = 0;
  let y = 0;
  let drag;

  function bounds() {
    if (viewport.hidden || !image.complete || !image.naturalWidth || !image.naturalHeight) return null;
    const box = viewport.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const fit = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    return {box, width:image.naturalWidth * fit, height:image.naturalHeight * fit};
  }

  function update(size) {
    // Center smaller previews and keep the fitted area covered when zoomed in.
    const excess = Math.max(0, zoom - 1);
    const limitX = size.width * excess / 2;
    const limitY = size.height * excess / 2;
    x = clamp(x, -limitX, limitX);
    y = clamp(y, -limitY, limitY);
    image.style.transform = zoom === 1 ? '' : `translate(${x}px, ${y}px) scale(${zoom})`;
    viewport.classList.toggle('is-zoomed', excess > 0);
    if (!excess) endDrag();
  }

  function refresh() {
    const size = bounds();
    if (size) update(size);
  }

  function endDrag() {
    if (!drag) return;
    const {id} = drag;
    drag = undefined;
    if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    viewport.classList.remove('is-panning');
  }

  function reset() {
    endDrag();
    viewport.hidden = true;
    zoom = 1;
    x = 0;
    y = 0;
    image.style.removeProperty('transform');
    image.removeAttribute('src');
    viewport.classList.remove('is-zoomed');
  }

  function show(url) {
    reset();
    image.src = url;
    viewport.hidden = false;
  }

  viewport.addEventListener('wheel', event => {
    const size = bounds();
    if (!size || !event.deltaY) return;
    event.preventDefault();
    const {box} = size;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? box.height : 1;
    const delta = clamp(event.deltaY * unit, -240, 240);
    const next = clamp(zoom * Math.exp(-delta * .0025), minimumZoom, maximumZoom);
    if (next === zoom) return;
    const ratio = next / zoom;
    const cursorX = event.clientX - box.left - box.width / 2;
    const cursorY = event.clientY - box.top - box.height / 2;
    x = cursorX - (cursorX - x) * ratio;
    y = cursorY - (cursorY - y) * ratio;
    zoom = next;
    update(size);
  }, {passive:false});

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== middleButton || viewport.hidden) return;
    event.preventDefault();
    if (!bounds() || zoom <= 1) return;
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY};
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
  });
  viewport.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    if (!(event.buttons & middlePressed)) { endDrag(); return; }
    const size = bounds();
    if (!size) return;
    x += event.clientX - drag.x;
    y += event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    update(size);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    viewport.addEventListener(name, event => {
      if (event.pointerId === drag?.id) endDrag();
    });
  }
  for (const name of ['mousedown', 'auxclick']) {
    viewport.addEventListener(name, event => {
      if (event.button === middleButton) event.preventDefault();
    });
  }
  window.addEventListener('blur', endDrag);
  image.addEventListener('load', refresh);
  new ResizeObserver(refresh).observe(viewport);
  return {show, reset};
}
