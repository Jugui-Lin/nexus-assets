import {initQuickImagePixels} from './quick-image-pixels.js';

const minimumZoom = .25;
const maximumZoom = 8;
const middleButton = 1;
const middlePressed = 4;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function initQuickImagePreview({viewport, image, background, toolbar}) {
  const rotate = toolbar.querySelector('[data-rotate]');
  const horizontal = toolbar.querySelector('[data-flip-horizontal]');
  const vertical = toolbar.querySelector('[data-flip-vertical]');
  const actual = toolbar.querySelector('[data-actual]');
  const fit = toolbar.querySelector('[data-fit]');
  const status = toolbar.querySelector('[data-status]');
  let zoom = 1;
  let x = 0;
  let y = 0;
  let angle = 0;
  let mirrorX = 1;
  let mirrorY = 1;
  let actualSize = false;
  let drag;
  let readOriginal;
  let sourceIsOriginal = false;
  let pending = false;
  let pendingImage;
  let generation = 0;
  const pixelScale = () => 1 / (window.devicePixelRatio || 1);
  const scale = size => actualSize ? pixelScale() : size.fit * zoom;
  const pixels = initQuickImagePixels({viewport,image,toolbar,original:ensureOriginal,pointAt:pixelAt});

  function bounds() {
    if (viewport.hidden || !image.complete || !image.naturalWidth || !image.naturalHeight) return null;
    const box = viewport.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const sideways = angle % 180 !== 0;
    const width = sideways ? image.naturalHeight : image.naturalWidth;
    const height = sideways ? image.naturalWidth : image.naturalHeight;
    return {box,width,height,fit:Math.min(box.width / width, box.height / height)};
  }

  function panBounds(size) {
    const factor = scale(size);
    return [Math.max(0,(size.width * factor - size.box.width) / 2),
      Math.max(0,(size.height * factor - size.box.height) / 2)];
  }

  function pixelAt(clientX,clientY) {
    const size = bounds();
    if (!size) return null;
    const {box} = size;
    const factor = scale(size);
    const dx = (clientX-box.left-box.width/2-x)*mirrorX/factor;
    const dy = (clientY-box.top-box.height/2-y)*mirrorY/factor;
    const [u,v] = [[dx,dy],[dy,-dx],[-dx,-dy],[-dy,dx]][angle/90];
    const {naturalWidth:width,naturalHeight:height} = image;
    const px = Math.floor(u+width/2);
    const py = Math.floor(v+height/2);
    return px >= 0 && px < width && py >= 0 && py < height ? [px,py] : null;
  }

  function update(size) {
    const factor = scale(size);
    const [limitX,limitY] = panBounds(size);
    x = clamp(x, -limitX, limitX);
    y = clamp(y, -limitY, limitY);
    image.style.width = `${image.naturalWidth * factor}px`;
    image.style.height = `${image.naturalHeight * factor}px`;
    image.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${mirrorX}, ${mirrorY}) rotate(${angle}deg)`;
    const pannable = limitX > .01 || limitY > .01;
    viewport.classList.toggle('is-zoomed', pannable);
    if (!pannable) endDrag();
  }

  function renderControls(size) {
    for (const button of [rotate,horizontal,vertical,fit]) button.disabled = !size;
    actual.disabled = !size || pending || !(sourceIsOriginal || readOriginal);
    pixels?.ready(!actual.disabled);
    actual.setAttribute('aria-pressed',String(actualSize));
    horizontal.setAttribute('aria-pressed',String(mirrorX < 0));
    vertical.setAttribute('aria-pressed',String(mirrorY < 0));
    toolbar.setAttribute('aria-busy',String(pending));
  }

  function refresh() {
    const size = bounds();
    if (size) update(size);
    renderControls(size);
  }

  function endDrag() {
    if (!drag) return;
    const {id} = drag;
    drag = undefined;
    if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    viewport.classList.remove('is-panning');
  }

  function reset() {
    generation++;
    if (pendingImage) pendingImage.removeAttribute('src');
    pendingImage = null;
    pending = false;
    readOriginal = null;
    sourceIsOriginal = false;
    pixels?.reset();
    endDrag();
    toolbar.hidden = viewport.hidden = true;
    if (background) background.hidden = true;
    zoom = 1;
    x = 0;
    y = 0;
    angle = 0;
    mirrorX = mirrorY = 1;
    actualSize = false;
    status.textContent = '';
    for (const property of ['transform','width','height']) image.style.removeProperty(property);
    image.removeAttribute('src');
    viewport.classList.remove('is-zoomed');
    renderControls(null);
  }

  function show(url,{original,originalDisplayed = false} = {}) {
    reset();
    readOriginal = original;
    sourceIsOriginal = originalDisplayed;
    actual.title = sourceIsOriginal || readOriginal ? '按屏幕实际像素显示原图' : '此预览暂不支持原始像素';
    image.src = url;
    toolbar.hidden = viewport.hidden = false;
    if (background) background.hidden = false;
    refresh();
  }

  async function ensureOriginal() {
    if (!bounds() || pending) return false;
    if (!sourceIsOriginal) {
      if (!readOriginal) return false;
      const request = generation;
      pending = true;
      status.textContent = '正在读取原图…';
      renderControls(bounds());
      try {
        const original = await readOriginal();
        if (request !== generation) return false;
        if (!original?.url) throw Error('此文件暂不支持原始像素预览');
        const loaded = pendingImage = new Image();
        loaded.src = original.url;
        await loaded.decode();
        if (request !== generation) return false;
        const {naturalWidth:width,naturalHeight:height} = loaded;
        if (!(width === original.width && height === original.height || width === original.height && height === original.width)) {
          throw Error('当前解码器无法显示原图像素尺寸');
        }
        image.src = original.url;
        await image.decode();
        if (request !== generation) return false;
        sourceIsOriginal = true;
      } catch (failure) {
        if (request === generation) status.textContent = String(failure?.message || failure);
        return false;
      } finally {
        if (request === generation) {
          pendingImage = null;
          pending = false;
          renderControls(bounds());
        }
      }
    }
    status.textContent = '';
    return true;
  }

  async function showActual() {
    const request = generation;
    if (actualSize || !await ensureOriginal() || request !== generation) return;
    actualSize = true;
    x = y = 0;
    refresh();
  }

  background?.addEventListener('change', () => { viewport.dataset.background = background.value; });
  rotate.addEventListener('click', () => {
    angle = (angle + 90) % 360;
    x = y = 0;
    refresh();
  });
  horizontal.addEventListener('click', () => { mirrorX = -mirrorX; x = -x; refresh(); });
  vertical.addEventListener('click', () => { mirrorY = -mirrorY; y = -y; refresh(); });
  actual.addEventListener('click', showActual);
  fit.addEventListener('click', () => {
    actualSize = false;
    zoom = 1;
    x = y = 0;
    refresh();
  });

  viewport.addEventListener('wheel', event => {
    const size = bounds();
    if (!size || !event.deltaY) return;
    event.preventDefault();
    const {box} = size;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? box.height : 1;
    const delta = clamp(event.deltaY * unit, -240, 240);
    const previous = scale(size) / size.fit;
    const exactZoom = sourceIsOriginal ? pixelScale() / size.fit : 1;
    const next = clamp(previous * Math.exp(-delta * .0025),
      Math.min(minimumZoom,exactZoom), Math.max(maximumZoom,exactZoom));
    if (next === previous) return;
    const ratio = next / previous;
    const cursorX = event.clientX - box.left - box.width / 2;
    const cursorY = event.clientY - box.top - box.height / 2;
    x = cursorX - (cursorX - x) * ratio;
    y = cursorY - (cursorY - y) * ratio;
    zoom = next;
    actualSize = false;
    update(size);
    renderControls(size);
  }, {passive:false});

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== middleButton || viewport.hidden) return;
    event.preventDefault();
    const size = bounds();
    if (!size || !panBounds(size).some(limit => limit > .01)) return;
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
  window.addEventListener('resize', refresh);
  image.addEventListener('load', refresh);
  new ResizeObserver(refresh).observe(viewport);
  return {show, reset};
}
