import {initAssetMasonry} from './asset-masonry.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
const omittedElements = new Set(['audio', 'dialog', 'embed', 'image', 'link', 'object', 'script', 'source', 'style', 'track']);
const liveAttributes = new Set(['autofocus', 'contenteditable', 'data-thumb', 'data-thumb-candidates', 'data-video-hover',
  'form', 'formaction', 'for', 'popover', 'popovertarget', 'srcset', 'tabindex']);
const previewReadLimit = 4;
let previewSequence = 0;

function thumbnailIds(source) {
  let candidates = [];
  if (source.dataset.thumbCandidates) {
    try { candidates = JSON.parse(source.dataset.thumbCandidates); } catch {}
  }
  return [...new Set([source.dataset.thumb, ...(Array.isArray(candidates) ? candidates : [])])]
    .filter(id => typeof id === 'string' && id)
    .slice(0, 3);
}

export function captureWorkspacePane(scroll, {thumbnail, controls} = {}) {
  const {scrollTop, scrollLeft, ownerDocument: document} = scroll;
  const prefix = 'workspace-preview-svg-' + ++previewSequence + '-';
  const svgIds = new Map();
  const svgCopies = [];
  const pendingThumbs = new Map();
  const cachedReads = new Map();
  const queue = [];
  let observer;
  let masonry;
  let reading = 0;
  let disposed = false;
  let availablePixels = 10 * 1024 * 1024;

  function copyStyles(source, copy) {
    copy.removeAttribute('style');
    if (!source.style) return;
    for (const property of source.style) {
      copy.style.setProperty(property, source.style.getPropertyValue(property), source.style.getPropertyPriority(property));
    }
  }

  function freezeMedia(source, allowEmpty = true, stageBounds) {
    if (!allowEmpty && availablePixels < 1) return null;
    const tag = source.localName;
    const copy = document.createElement('canvas');
    copy.className = source.className;
    copyStyles(source, copy);
    copy.dataset.paneMedia = tag === 'img' ? 'image' : tag;
    copy.width = 1;
    copy.height = 1;
    if (availablePixels < 1) return copy;
    const [width, height] = tag === 'img' ? [source.naturalWidth, source.naturalHeight]
      : tag === 'video' ? [source.videoWidth, source.videoHeight] : [source.width, source.height];
    if (!width || !height || (tag === 'video' && source.readyState < 2) ||
      (tag === 'img' && !source.complete)) return allowEmpty ? copy : null;
    if (stageBounds) {
      const {left, top, right, bottom} = source.getBoundingClientRect();
      if (right <= stageBounds.left || bottom <= stageBounds.top ||
        left >= stageBounds.right || top >= stageBounds.bottom) return copy;
    }
    const displaySize = Math.max(source.clientWidth, source.clientHeight);
    const displayLimit = Math.min(520, Math.max(80, displaySize * Math.min(2, window.devicePixelRatio || 1)));
    const scale = Math.min(1, displayLimit / Math.max(width, height));
    const rasterWidth = Math.max(1, Math.round(width * scale));
    const rasterHeight = Math.max(1, Math.round(height * scale));
    if (rasterWidth * rasterHeight > availablePixels) return allowEmpty ? copy : null;
    copy.width = rasterWidth;
    copy.height = rasterHeight;
    try {
      const context = copy.getContext('2d');
      if (context) context.drawImage(source, 0, 0, copy.width, copy.height);
      else if (!allowEmpty) return null;
    } catch {
      if (!allowEmpty) return null;
    }
    availablePixels -= copy.width * copy.height;
    return copy;
  }

  function whiteboardCaptureBounds(stage) {
    const {left, top, right, bottom} = stage.getBoundingClientRect();
    const deck = stage.closest('.workspace-pane-deck');
    if (!deck) return {left, top, right, bottom};
    // The passive pane can grow when the user moves the divider.
    return {left, top, right:Math.max(right, left + deck.clientWidth),
      bottom:Math.max(bottom, top + deck.clientHeight)};
  }

  function cloneThumb(source) {
    if (!source.hidden && !source.classList.contains('hidden')) {
      const canvas = freezeMedia(source, false);
      if (canvas) return {node:canvas};
    }
    const url = source.currentSrc || source.getAttribute('src');
    if (!url && !thumbnail) return null;
    const node = document.createElement('img');
    node.alt = '';
    node.draggable = false;
    node.setAttribute('data-pane-pending-thumb', '');
    return {node, deferred:{node, url, ids:thumbnail ? thumbnailIds(source) : []}};
  }

  function readCached(id) {
    if (!cachedReads.has(id)) {
      cachedReads.set(id, Promise.resolve().then(() => disposed ? null : thumbnail(id)).catch(() => null));
    }
    return cachedReads.get(id);
  }

  async function showThumbnail({node, url, ids, fallback}) {
    const tried = new Set();
    async function decode(candidate) {
      if (disposed || typeof candidate !== 'string' || !candidate || tried.has(candidate)) return false;
      tried.add(candidate);
      node.src = candidate;
      try { await node.decode(); } catch { return false; }
      if (disposed || !node.naturalWidth) return false;
      node.dataset.paneMedia = 'image';
      node.removeAttribute('data-pane-pending-thumb');
      fallback?.classList.add('hidden');
      masonry?.refresh();
      return true;
    }
    if (await decode(url)) return;
    for (const id of ids) {
      if (disposed || await decode(await readCached(id))) return;
    }
    node.removeAttribute('src');
  }

  function pumpThumbnails() {
    while (!disposed && reading < previewReadLimit && queue.length) {
      reading++;
      void showThumbnail(queue.shift()).finally(() => {
        reading--;
        pumpThumbnails();
      });
    }
  }

  function observeThumbnails() {
    if (disposed || observer || !element.isConnected || !pendingThumbs.size) return;
    observer = new IntersectionObserver(entries => {
      if (disposed) return;
      for (const {target, isIntersecting} of entries) {
        if (!isIntersecting || !pendingThumbs.has(target)) continue;
        observer.unobserve(target);
        queue.push(pendingThumbs.get(target));
        pendingThumbs.delete(target);
      }
      pumpThumbnails();
    }, {root:element});
    for (const container of pendingThumbs.keys()) observer.observe(container);
  }

  function cloneVisible(source, keepVisible = false, stageBounds) {
    if (source.nodeType === Node.TEXT_NODE) return source.cloneNode();
    if (source.nodeType !== Node.ELEMENT_NODE || source.hasAttribute('data-pane-transient')) return null;
    const tag = source.localName;
    if (omittedElements.has(tag) || !keepVisible && (source.hasAttribute('hidden') || source.classList.contains('hidden'))) return null;
    if (tag === 'img' || tag === 'video' || tag === 'canvas') return freezeMedia(source, true, stageBounds);
    if (tag === 'iframe') {
      const placeholder = document.createElement('div');
      placeholder.className = 'workspace-pane-static-frame';
      const {width, height} = source.getBoundingClientRect();
      if (width && height) placeholder.style.aspectRatio = width + ' / ' + height;
      return placeholder;
    }

    const copy = source.cloneNode(false);
    copyStyles(source, copy);
    if (source.matches('.asset-card[data-video-hover]')) copy.setAttribute('data-masonry-video', '');
    if (keepVisible) {
      copy.removeAttribute('hidden');
      copy.classList.remove('hidden');
    }
    for (const attribute of [...copy.attributes]) {
      if (liveAttributes.has(attribute.name) || attribute.name.startsWith('on') ||
        (attribute.localName === 'href' && (tag !== 'use' || !attribute.value.startsWith('#')))) {
        copy.removeAttributeNode(attribute);
      }
    }
    if (source.namespaceURI === svgNamespace) {
      svgCopies.push(copy);
      if (source.id) {
        const id = prefix + svgIds.size;
        svgIds.set(source.id, id);
        copy.id = id;
      }
    } else if (source.id) {
      copy.removeAttribute('id');
      copy.dataset.paneSource = source.id;
    }

    const thumb = source.matches('.card-thumb, .subfolder-cover') && source.querySelector(':scope > img[data-thumb]');
    const thumbCopy = thumb && cloneThumb(thumb);
    const placeholder = thumb && thumb.previousElementSibling;
    const needsFallback = thumb && (!thumbCopy || thumbCopy.deferred);
    if (source.classList.contains('whiteboard-stage')) stageBounds = whiteboardCaptureBounds(source);
    for (const child of source.childNodes) {
      const fallback = needsFallback && child === placeholder;
      const selectedOption = tag === 'select' && child === source.selectedOptions[0];
      const visible = child === thumb ? thumbCopy?.node : cloneVisible(child, fallback || selectedOption, stageBounds);
      if (visible) copy.append(visible);
      if (fallback && thumbCopy?.deferred) thumbCopy.deferred.fallback = visible;
    }
    if (thumbCopy?.deferred) pendingThumbs.set(copy, thumbCopy.deferred);
    if (tag === 'textarea' || tag === 'select' || (tag === 'input' && source.type !== 'file')) copy.value = source.value;
    if (tag === 'input') copy.checked = source.checked;
    return copy;
  }

  const element = cloneVisible(scroll);
  const header = controls ? cloneVisible(controls) : null;
  if (header) {
    header.classList.add('workspace-pane-asset-preview');
    header.inert = true;
    header.setAttribute('aria-hidden', 'true');
    for (const trigger of header.querySelectorAll('[aria-expanded="true"]')) {
      trigger.setAttribute('aria-expanded', 'false');
    }
  }
  const masonryGrid = element.querySelector('.asset-grid.masonry-mode');
  for (const copy of svgCopies) {
    for (const attribute of [...copy.attributes]) {
      const value = attribute.value.replace(/url\(#([^)]+)\)/g, (original, id) =>
        svgIds.has(id) ? 'url(#' + svgIds.get(id) + ')' : original);
      const href = attribute.localName === 'href' && value.startsWith('#') && svgIds.get(value.slice(1));
      const rewritten = href ? '#' + href : value;
      if (rewritten !== attribute.value) attribute.value = rewritten;
    }
  }
  element.classList.add('workspace-pane-preview');
  element.setAttribute('aria-hidden', 'true');
  element.tabIndex = -1;
  for (const child of element.children) child.setAttribute('inert', '');
  return {
    element, header,
    restoreScroll(top = scrollTop, left = scrollLeft) {
      if (masonryGrid && element.isConnected && !disposed) {
        masonry ??= initAssetMasonry(masonryGrid);
        masonry.sync();
      }
      element.scrollTop = top;
      element.scrollLeft = left;
      observeThumbnails();
    },
    dispose() {
      disposed = true;
      observer?.disconnect();
      masonry?.dispose();
      pendingThumbs.clear();
      cachedReads.clear();
      queue.length = 0;
    },
  };
}
