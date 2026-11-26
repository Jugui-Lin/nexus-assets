function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

export function distinguishTabLabels(tabs) {
  const groups = new Map();
  const labels = new Map();
  for (const tab of tabs) {
    const title = normalize(tab.title);
    if (!groups.has(title)) groups.set(title,[]);
    groups.get(title).push(tab);
    labels.set(tab.id,tab.title);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const paths = group.map(tab => {
      const parts = String(tab.location || '').split(/[\\/›]/).map(part => part.trim()).filter(Boolean);
      return {tab,path:normalize(parts.join('/')), parents:parts.slice(0,-1)};
    });
    for (const {tab,path,parents} of paths) {
      const peers = paths.filter(peer => peer.path && peer.path !== path);
      if (!peers.length) continue;
      for (let depth=1; depth <= parents.length; depth++) {
        const suffix = parents.slice(-depth).join(' / ');
        const key = normalize(suffix);
        if (depth < parents.length && peers.some(peer => normalize(peer.parents.slice(-depth).join(' / ')) === key)) continue;
        labels.set(tab.id,`${tab.title} · ${suffix}`);
        break;
      }
    }
  }
  return labels;
}
