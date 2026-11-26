const aspectProperty = '--masonry-aspect';
const aspectCacheKey = 'nexus-masonry-aspects-v1';
const aspectCacheLimit = 1600;
let aspects;
let saveTimer;

function knownAspects() {
  if (!aspects) {
    aspects = new Map();
    try {
      const saved = JSON.parse(localStorage.getItem(aspectCacheKey) || '[]');
      for (const [key, ratio] of saved.slice(-aspectCacheLimit)) {
        if (typeof key === 'string' && key.length <= 512 && ratio >= 1 / 6 && ratio <= 6) aspects.set(key, Number(ratio));
      }
    } catch {}
  }
  return aspects;
}

function saveKnownAspects() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try { localStorage.setItem(aspectCacheKey, JSON.stringify(Array.from(aspects))); } catch {}
}

function scheduleAspectSave() {
  if (!saveTimer) saveTimer = setTimeout(saveKnownAspects, 300);
}

window.addEventListener('pagehide', () => { if (saveTimer) saveKnownAspects(); });

function refreshAspect(card) {
  const thumb = card.querySelector('.card-thumb');
  const image = thumb?.querySelector('img:not(.hidden)');
  const video = thumb?.querySelector('video');
  const frame = thumb?.querySelector('canvas[data-pane-media]');
  const key = card.dataset.masonryAspectKey;
  const known = key && knownAspects().get(key);
  const posterRatio = image?.naturalWidth / image?.naturalHeight;
  const frameRatio = frame?.width > 1 && frame?.height > 1 && frame.width / frame.height;
  const ratio = posterRatio || known || frameRatio || video?.videoWidth / video?.videoHeight;
  if (Number.isFinite(ratio) && ratio > 0) {
    const clamped = Math.min(6, Math.max(1 / 6, ratio));
    if (card.style.getPropertyValue(aspectProperty) !== String(clamped)) card.style.setProperty(aspectProperty, clamped);
    // A live poster can replace a provisional size. A downscaled canvas copy cannot.
    if (key && posterRatio && clamped !== known) {
      const cache = knownAspects();
      cache.delete(key);
      cache.set(key, clamped);
      if (cache.size > aspectCacheLimit) cache.delete(cache.keys().next().value);
      scheduleAspectSave();
    }
  }
}

function sameCard(previous, card) {
  return previous && card && (previous === card || (previous.dataset.id && previous.dataset.id === card.dataset.id &&
    previous.dataset.masonryAspectKey === card.dataset.masonryAspectKey));
}

export function layoutAssetMasonry(grid, previous = []) {
  if (!grid.classList.contains('masonry-mode') || grid.classList.contains('list-mode')) {
    grid.removeAttribute('data-masonry-layout');
    delete grid.dataset.masonryColumns;
    return [];
  }
  if (!grid.clientWidth) return [];
  const style = getComputedStyle(grid);
  const number = property => Number.parseFloat(style.getPropertyValue(property)) || 0;
  const start = number('padding-inline-start');
  const top = number('padding-block-start');
  const bottomPadding = number('padding-block-end');
  const available = grid.clientWidth - start - number('padding-inline-end');
  if (available <= 0) return [];
  const horizontalGap = number('column-gap');
  const verticalGap = number('row-gap');
  const customWidth = number('--grid-zoom-width');
  const requestedWidth = customWidth || number('--card-min') || 139;
  const columns = Math.max(1, Math.floor((available + horizontalGap) / (requestedWidth + horizontalGap)));
  const width = (available - (columns - 1) * horizontalGap) / columns;
  const cards = Array.from(grid.children).filter(child => child.classList.contains('asset-card'));
  let reuseColumn = Number(grid.dataset.masonryColumns) === columns;

  grid.style.setProperty('--masonry-width', width + 'px');
  grid.setAttribute('data-masonry-layout', '');
  grid.dataset.masonryColumns = String(columns);
  for (const card of cards) refreshAspect(card);
  const heights = cards.map(card => card.getBoundingClientRect().height);
  const bottoms = Array(columns).fill(top);
  const positions = cards.map((card, index) => {
    const old = previous[index];
    const retained = previous.length ? (sameCard(old?.card, card) ? old.column : NaN) : Number(card.dataset.masonryColumn);
    reuseColumn &&= retained >= 0 && retained < columns && Number.isInteger(retained);
    let column = retained;
    if (!reuseColumn) {
      column = 0;
      for (let candidate = 1; candidate < columns; candidate++) {
        if (bottoms[candidate] < bottoms[column]) column = candidate;
      }
    }
    const top = bottoms[column];
    const bottom = top + heights[index];
    bottoms[column] = bottom + verticalGap;
    card.dataset.masonryColumn = String(column);
    card.style.setProperty('--masonry-inline', start + column * (width + horizontalGap) + 'px');
    card.style.setProperty('--masonry-top', top + 'px');
    return {card, column, top, bottom};
  });
  const height = cards.length ? Math.max(...bottoms) - verticalGap + bottomPadding : 0;
  grid.style.setProperty('--masonry-height', height + 'px');
  return positions;
}

export function initAssetMasonry(grid) {
  const scroller = grid.closest('.browser-scroll');
  let frame = 0;
  let observedWidth;
  let positions = [];
  let scrollAnchor;

  function visibleAnchor() {
    if (!scroller?.scrollTop || !grid.clientWidth) return -1;
    const line = scroller.getBoundingClientRect().top + scroller.clientTop - grid.getBoundingClientRect().top;
    const end = line + scroller.clientHeight;
    if (scrollAnchor && Math.abs(scrollAnchor.scrollTop - scroller.scrollTop) < 1) {
      const retained = positions[scrollAnchor.index];
      if (retained?.bottom > line && retained.top < end) return scrollAnchor.index;
    }
    let anchor = -1;
    let distance = Infinity;
    for (let index = 0; index < positions.length; index++) {
      const item = positions[index];
      if (item.bottom <= line || item.top >= end) continue;
      const gap = Math.abs(item.top - line);
      if (gap >= distance) continue;
      anchor = index;
      distance = gap;
    }
    return anchor;
  }

  function sync({preserveAnchor = true} = {}) {
    cancelAnimationFrame(frame);
    frame = 0;
    const index = preserveAnchor ? visibleAnchor() : -1;
    const old = positions[index];
    const scrollTop = old ? scroller.scrollTop : 0;
    positions = layoutAssetMasonry(grid, positions);
    const next = positions[index];
    if (old && next && sameCard(old.card, next.card)) {
      const shift = next.top - old.top;
      if (Math.abs(scrollTop + shift - scroller.scrollTop) > .5) scroller.scrollTop = scrollTop + shift;
      scrollAnchor = {index, scrollTop:scroller.scrollTop};
    } else scrollAnchor = undefined;
  }

  function schedule() {
    if (!frame && grid.classList.contains('masonry-mode')) frame = requestAnimationFrame(() => sync());
  }

  function mediaChanged(event) {
    if (!event.target.matches('.card-thumb img, .card-thumb video')) return;
    if (grid.classList.contains('masonry-mode')) schedule();
    else if (event.type === 'load') {
      const card = event.target.closest('.asset-card');
      if (card) refreshAspect(card);
    }
  }

  const mediaEvents = ['load', 'error', 'loadedmetadata'];
  for (const type of mediaEvents) grid.addEventListener(type, mediaChanged, true);
  const observer = new ResizeObserver(([entry]) => {
    const {width} = entry.contentRect;
    if (width === observedWidth) return;
    observedWidth = width;
    schedule();
  });
  observer.observe(grid);

  return {
    sync,
    refresh: schedule,
    forgetAspect(key) {
      if (knownAspects().delete(key)) scheduleAspectSave();
    },
    cardAtDirection(card, direction) {
      const current = positions.find(position => position.card === card);
      if (!current) return positions[0]?.card;
      const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
      const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1;
      const column = current.column + (horizontal ? sign : 0);
      const center = (current.top + current.bottom) / 2;
      let best = current;
      let nearestGap = Infinity;
      let nearestCenter = Infinity;
      for (const item of positions) {
        if (item.column !== column || item === current || !item.card.isConnected) continue;
        const distance = (item.top + item.bottom) / 2 - center;
        if (!horizontal && sign * distance <= 0) continue;
        const gap = Math.max(0, current.top - item.bottom, item.top - current.bottom);
        const centerDistance = Math.abs(distance);
        if (gap > nearestGap || (gap === nearestGap && centerDistance >= nearestCenter)) continue;
        best = item;
        nearestGap = gap;
        nearestCenter = centerDistance;
      }
      return best.card;
    },
    dispose() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const type of mediaEvents) grid.removeEventListener(type, mediaChanged, true);
    },
  };
}
