const prefix = 'nexus-browser-site-metadata-v1:';
const retryDelay = 30 * 60 * 1000;
const refreshDelay = 24 * 60 * 60 * 1000;
const requestLimit = 3;
const storedLimit = 96;
const storageBudget = 650_000;

function metadataAddress(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function initBrowserSiteMetadata({initialScope, read, normalize, visible, onChange}) {
  const queue = new Map();
  const inFlight = new Set();
  let scope = initialScope;
  let epoch = 0;
  let active = 0;
  let scheduled = false;

  function load() {
    try {
      const rows = JSON.parse(localStorage.getItem(prefix + scope));
      if (!Array.isArray(rows)) return new Map();
      return new Map(rows.slice(0, storedLimit).flatMap(row => {
        if (!row || !Number.isFinite(row.nextCheck)) return [];
        const url = metadataAddress(row.url);
        if (!url || url.length > 2048) return [];
        const metadata = normalize(row);
        const delay = metadata.iconData ? refreshDelay : retryDelay;
        return [[url, {...metadata, nextCheck:Math.min(row.nextCheck, Date.now() + delay)}]];
      }));
    } catch { return new Map(); }
  }

  let cache = load();

  function persist(url, value) {
    cache.delete(url);
    cache.set(url, value);
    while (cache.size > storedLimit) cache.delete(cache.keys().next().value);
    let size = 0;
    const rows = [];
    for (const [url, row] of [...cache].reverse()) {
      size += url.length + (row.name?.length || 0) + (row.description?.length || 0) + (row.iconData?.length || 0) + 65;
      if (size > storageBudget) break;
      rows.push({url, ...row});
    }
    try { localStorage.setItem(prefix + scope, JSON.stringify(rows.reverse())); } catch {}
  }

  function pump() {
    scheduled = false;
    while (read && visible() && active < requestLimit && queue.size) {
      const url = [...queue].find(([, priority]) => priority)?.[0] ?? queue.keys().next().value;
      queue.delete(url);
      if (inFlight.has(url) || (cache.get(url)?.nextCheck ?? 0) > Date.now()) continue;
      const context = epoch;
      inFlight.add(url);
      active++;
      Promise.resolve().then(() => read(url)).catch(() => null).then(result => {
        if (context !== epoch) return;
        const metadata = {...cache.get(url), ...normalize(result)};
        persist(url, {...metadata, nextCheck:Date.now() + (metadata.iconData ? refreshDelay : retryDelay)});
        onChange(url);
      }).finally(() => {
        active--;
        if (context === epoch) inFlight.delete(url);
        schedule();
      });
    }
  }

  function schedule() {
    if (!scheduled && queue.size && active < requestLimit) {
      scheduled = true;
      queueMicrotask(pump);
    }
  }

  return {
    get(url) { return cache.get(metadataAddress(url)); },
    pending(url) {
      const key = metadataAddress(url);
      return queue.has(key) || inFlight.has(key);
    },
    request(urls, priority = false) {
      if (!read || !visible()) return;
      for (const value of urls) {
        const url = metadataAddress(value);
        if (url && url.length <= 2048 && !inFlight.has(url) && (cache.get(url)?.nextCheck ?? 0) <= Date.now()) {
          queue.set(url, priority || queue.get(url) || false);
        }
      }
      schedule();
    },
    setScope(next) {
      if (next === scope) return;
      scope = next;
      epoch++;
      queue.clear();
      inFlight.clear();
      cache = load();
    },
  };
}
