const maximumText = 2048;
const cardWidth = 280;
const cardHeight = 62;
const linkMarker = '🔗 ';

function linkAddress(value) {
  if (typeof value !== 'string' || value.length > maximumText || !/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    const hostname = url.hostname.replace(/\.$/, '');
    if (!hostname.includes('.') || /(^|\.)(localhost|local|internal|home\.arpa)$/.test(hostname) ||
        /^\d+(\.\d+){3}$/.test(hostname)) return null;
    return url;
  } catch { return null; }
}

export function whiteboardLinkText({title, url}) {
  const address = linkAddress(url);
  if (!address) return null;
  const name = typeof title === 'string' ? title.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 120) : '';
  const text = linkMarker + (name || address.hostname) + '\n' + address.href;
  return text.length <= maximumText ? text : null;
}

export function readWhiteboardLink(text) {
  if (typeof text !== 'string' || !text.startsWith(linkMarker) || text.length > maximumText) return null;
  const [title, url, ...rest] = text.slice(linkMarker.length).split('\n');
  if (rest.length || !title.trim() || title.length > 120) return null;
  const address = linkAddress(url);
  return address && {title:title.trim(), url:address.href, host:address.host};
}

export function whiteboardLinkCard(link, icon, open) {
  const card = document.createElement('div');
  card.className = 'whiteboard-link-card';
  const mark = document.createElement('span');
  mark.className = 'whiteboard-link-mark';
  mark.innerHTML = icon('link');
  const description = document.createElement('div');
  description.className = 'whiteboard-link-description';
  const title = document.createElement('strong');
  title.textContent = link.title;
  title.title = link.title;
  const host = document.createElement('span');
  host.textContent = link.host;
  host.title = link.url;
  description.append(title, host);
  card.append(mark, description);
  if (open) {
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.dataset.boardOpenLink = '';
    launch.className = 'icon-button whiteboard-link-open';
    launch.setAttribute('aria-label', '在浏览器打开 ' + link.title);
    launch.title = '在浏览器打开';
    launch.innerHTML = icon('drag-out');
    launch.addEventListener('click', () => open(link.url));
    card.append(launch);
  } else {
    const launch = document.createElement('span');
    launch.className = 'whiteboard-link-open';
    launch.innerHTML = icon('drag-out');
    card.append(launch);
  }
  return card;
}

export function whiteboardLinkPatch(text, point) {
  return readWhiteboardLink(text) && {kind:'text', text, x:point.x, y:point.y, width:cardWidth, height:cardHeight, color:'slate'};
}

export function bindWhiteboardLinkDrag(cards, {resolve, icon, available, targetAt, scope, drop, notify,
  cardSelector = '.creator-card[data-creator-id]'}) {
  let drag;
  let settling = false;
  let suppressUntil = 0;

  function cancel() {
    const current = drag;
    if (!current) return;
    drag = null;
    if (cards.hasPointerCapture(current.pointer)) cards.releasePointerCapture(current.pointer);
    if (current.preview) {
      current.preview.remove();
      suppressUntil = performance.now() + 150;
    }
  }

  function previewPosition(current, x, y, target) {
    const transform = target?.querySelector('.whiteboard-plane')?.style.transform;
    const zoom = transform ? new DOMMatrixReadOnly(transform).a : 1;
    const left = x - current.grabX * cardWidth * zoom;
    const top = y - current.grabY * cardHeight * zoom;
    current.preview.style.transform = `translate(${left}px, ${top}px) scale(${zoom})`;
    return {x:left, y:top};
  }

  cards.addEventListener('pointerdown', event => {
    if (settling || drag || !event.isPrimary || event.button !== 0 || event.pointerType === 'touch' ||
        event.target.closest('button, a, input, textarea, select, [contenteditable]') || !available()) return;
    const card = event.target.closest(cardSelector);
    const text = card && whiteboardLinkText(resolve(card) || {});
    if (!text) return;
    const {left,top,width,height} = card.getBoundingClientRect();
    drag = {pointer:event.pointerId, x:event.clientX, y:event.clientY, text, scope:scope(),
      grabX:(event.clientX-left)/width, grabY:(event.clientY-top)/height};
  });
  cards.addEventListener('dragstart', event => { if (drag) event.preventDefault(); });
  window.addEventListener('pointermove', event => {
    const current = drag;
    if (!current || event.pointerId !== current.pointer) return;
    if (!(event.buttons & 1) || current.scope !== scope() || !cards.checkVisibility()) return cancel();
    if (!current.preview) {
      if (Math.hypot(event.clientX-current.x, event.clientY-current.y) < 6) return;
      current.preview = whiteboardLinkCard(readWhiteboardLink(current.text), icon);
      current.preview.classList.add('whiteboard-link-ghost');
      current.preview.setAttribute('aria-hidden', 'true');
      current.preview.style.width = cardWidth + 'px';
      current.preview.style.height = cardHeight + 'px';
      cards.setPointerCapture(current.pointer);
      document.body.append(current.preview);
    }
    previewPosition(current, event.clientX, event.clientY, targetAt(event.clientX,event.clientY));
    event.preventDefault();
  }, {capture:true, passive:false});
  window.addEventListener('pointerup', event => {
    const current = drag;
    if (!current || event.pointerId !== current.pointer) return;
    const target = current.preview && current.scope === scope() && cards.checkVisibility() && targetAt(event.clientX,event.clientY);
    if (!target) return cancel();
    drag = null;
    suppressUntil = performance.now() + 150;
    if (cards.hasPointerCapture(current.pointer)) cards.releasePointerCapture(current.pointer);
    const position = previewPosition(current, event.clientX, event.clientY, target);
    settling = true;
    Promise.resolve().then(() => drop(target, current.text, current.scope, position))
      .catch(error => notify(String(error?.message || error), true))
      .finally(() => { settling = false; current.preview.remove(); });
  }, {capture:true});
  for (const type of ['pointercancel', 'lostpointercapture']) {
    window.addEventListener(type, event => { if (event.pointerId === drag?.pointer) cancel(); }, {capture:true});
  }
  window.addEventListener('blur', cancel);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !drag?.preview) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  }, {capture:true});
  document.addEventListener('click', event => {
    if (!event.detail || performance.now() >= suppressUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, {capture:true});
}
