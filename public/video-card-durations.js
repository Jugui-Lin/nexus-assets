import {formatTime} from './video-controls.js';

export function initVideoCardDurations({grid, scope, lookup, measure}) {
  const cache = new Map();
  const active = new Map();
  const visible = new Map();
  const observer = new IntersectionObserver(entries => {
    for (const {target, isIntersecting} of entries) {
      const badge = target.querySelector('[data-video-duration]');
      if (isIntersecting && target.isConnected && badge) visible.set(target, badge);
      else visible.delete(target);
    }
    pump();
  });

  function identify(badge) {
    const asset = lookup(badge.dataset.videoDuration);
    if (!asset) return null;
    const key = JSON.stringify([scope(), asset.id, asset.path, asset.modified, asset.size]);
    return {asset, key};
  }

  function present(badge, label) {
    if (!label) return;
    badge.textContent = label;
    badge.classList.remove('hidden');
  }

  function forget(thumb) {
    visible.delete(thumb);
    observer.unobserve(thumb);
  }

  function cached(key) {
    const entry = cache.get(key);
    if (entry && entry.expires <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry;
  }

  async function measureAndCache(asset, key, signal) {
    let label = '';
    try {
      const duration = await measure(asset, signal);
      if (Number.isFinite(duration) && duration > 0) label = formatTime(duration);
    } catch {
      // Some containers or unavailable files cannot be read by the media engine.
    } finally {
      if (!signal.aborted) {
        cache.set(key, {label, expires:label ? Infinity : Date.now() + 30_000});
        if (cache.size > 512) cache.delete(cache.keys().next().value);
      }
      active.delete(key);
      pump();
    }
  }

  function pump() {
    for (const [thumb, badge] of visible) {
      const result = badge.isConnected && !grid.classList.contains('hidden') ? identify(badge) : null;
      if (!result) {
        forget(thumb);
        continue;
      }
      const {asset, key} = result;
      const entry = cached(key);
      if (entry) {
        present(badge, entry.label);
        forget(thumb);
      } else if (active.size < 2 && !active.has(key)) {
        const request = new AbortController();
        active.set(key, request);
        void measureAndCache(asset, key, request.signal);
      }
    }
  }

  return {
    refresh() {
      observer.disconnect();
      visible.clear();
      const rendered = new Set();
      const badges = grid.classList.contains('hidden') ? [] : grid.querySelectorAll('[data-video-duration]');
      for (const badge of badges) {
        const result = identify(badge);
        if (!result) continue;
        const entry = cached(result.key);
        if (entry) present(badge, entry.label);
        else {
          rendered.add(result.key);
          observer.observe(badge.parentElement);
        }
      }
      for (const [key, request] of active) {
        if (!rendered.has(key)) request.abort();
      }
    },
  };
}
