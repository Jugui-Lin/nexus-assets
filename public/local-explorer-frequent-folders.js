const storageKey = 'nexus-file-workspace-frequent-v1';
const visitInterval = 30 * 60 * 1000;
const historyAge = 30 * 24 * 60 * 60 * 1000;
const historyLimit = 32;
const candidateLimit = 96;
const slotLimit = 5;

export const frequentFolderDwell = 8000;

export function createFrequentFolders(storage,keyForPath) {
  const entries = new Map();
  let slots = [];
  let rankDay = '';

  try {
    const saved = JSON.parse(storage.getItem(storageKey) || 'null');
    for (const entry of (saved?.entries || []).slice(0,candidateLimit)) {
      if (typeof entry?.path !== 'string' || !entry.path || typeof entry.name !== 'string' ||
          !Array.isArray(entry.visits)) continue;
      const visits = entry.visits.filter(Number.isFinite).sort((a,b) => a - b).slice(-historyLimit);
      if (visits.length) entries.set(keyForPath(entry.path),{path:entry.path,name:entry.name,visits});
    }
    if (Array.isArray(saved?.slots)) slots = [...new Set(saved.slots.filter(key => entries.has(key)))].slice(0,slotLimit);
    if (typeof saved?.rankDay === 'string') rankDay = saved.rankDay;
  } catch {}

  function save() {
    try { storage.setItem(storageKey,JSON.stringify({entries:[...entries.values()],slots,rankDay})); } catch {}
  }

  function rank(now) {
    const cutoff = now - historyAge;
    return [...entries].map(([key,entry]) => ({key,entry,
      count:entry.visits.filter(timestamp => timestamp >= cutoff).length,
    })).filter(item => item.count).sort((a,b) => b.count - a.count ||
      b.entry.visits.at(-1) - a.entry.visits.at(-1) || a.key.localeCompare(b.key));
  }

  function record(path,name,now = Date.now()) {
    const key = keyForPath(path);
    if (!key) return false;
    const visits = entries.get(key)?.visits || [];
    if (visits.length && now < visits.at(-1) + visitInterval) return false;
    entries.set(key,{path,name,visits:[...visits.filter(timestamp => timestamp >= now - historyAge),now].slice(-historyLimit)});
    if (entries.size > candidateLimit) {
      const keep = new Set([...slots,...rank(now).map(item => item.key)].slice(0,candidateLimit));
      for (const candidate of entries.keys()) {
        if (!keep.has(candidate)) entries.delete(candidate);
      }
    }
    save();
    return true;
  }

  function list(eligible,now = Date.now()) {
    if (!entries.size) return [];
    const day = new Date(now).toDateString();
    const candidates = rank(now).filter(({count,entry}) => count >= 2 && eligible(entry.path));
    const available = new Set(candidates.map(item => item.key));
    const retained = day === rankDay ? slots.filter(key => available.has(key)) : [];
    const updated = [...new Set([...retained,...available])].slice(0,slotLimit);
    if (rankDay !== day || updated.some((key,index) => key !== slots[index]) || updated.length !== slots.length) {
      slots = updated;
      rankDay = day;
      save();
    }
    return slots.map(key => entries.get(key));
  }

  return {record,list,clear() {
    entries.clear();
    slots = [];
    rankDay = '';
    try { storage.removeItem(storageKey); } catch {}
  }};
}
