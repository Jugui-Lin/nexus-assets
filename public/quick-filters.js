const quickFilterKeys = ['favorite', 'tagged', 'notes', 'cover', 'recent'];
export const assetKindLabels = {
  model:'三维模型', scene:'场景工程', material:'材质资源', texture:'图片与贴图', video:'视频',
  audio:'音频', bim:'BIM', cad:'CAD', script:'脚本', other:'其他文件',
};
export const normalizeAssetKind = kind => Object.hasOwn(assetKindLabels, kind) ? kind : 'all';
const recentWindow = 7 * 86400000;
const folderStore = 'nexus-folder-quick-filters-v1:';

export function normalizeQuickFilters(values) {
  return Array.isArray(values) ? quickFilterKeys.filter(key => values.includes(key)) : [];
}

function normalizedName(value) {
  return value.normalize('NFC').toLowerCase();
}

export function assetFilename(asset) {
  const path = asset.relativePath || asset.path || '';
  return path.replaceAll('\\', '/').split('/').pop();
}

export function isRecentlyAdded(value, now = Date.now()) {
  const added = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return added >= now - recentWindow;
}

export function summarizeQuickFilters(assets, {kind, fileNameQuery, quickFilters}, customCovers,
  now = Date.now(), kindOfAsset = asset => asset.kind, assetEnabled = () => true) {
  const filename = normalizedName((fileNameQuery || '').trim());
  const selected = normalizeQuickFilters(quickFilters);
  const activeMask = quickFilterKeys.reduce((mask, key, index) =>
    selected.includes(key) ? mask | (1 << index) : mask, 0);
  const typeCounts = new Map([['all', 0]]);
  const counts = Object.fromEntries(quickFilterKeys.map(key => [key, 0]));
  const rows = [];

  for (const asset of assets) {
    if (!assetEnabled(asset)) continue;
    if (filename && !normalizedName(assetFilename(asset)).includes(filename)) continue;
    const flags = [
      Boolean(asset.favorite),
      asset.tags?.some(tag => tag.trim()),
      Boolean(asset.notes?.trim()),
      Boolean(asset.thumbnail) || customCovers.has(asset.id),
      isRecentlyAdded(asset.added, now),
    ];
    const mask = flags.reduce((bits, flag, index) => flag ? bits | (1 << index) : bits, 0);
    if ((mask & activeMask) !== activeMask) continue;
    const assetKind = kindOfAsset(asset);
    typeCounts.set('all', typeCounts.get('all') + 1);
    typeCounts.set(assetKind, (typeCounts.get(assetKind) || 0) + 1);
    if (kind !== 'all' && assetKind !== kind) continue;
    rows.push(asset);
    for (const [index, key] of quickFilterKeys.entries()) {
      if (flags[index]) counts[key]++;
    }
  }
  return {rows, typeCounts, counts};
}

export function initQuickFilters({getState, getScope, kindLabel, categoryEnabled, onChange, onError}) {
  const typeTabs = document.querySelector('#type-tabs');
  const filterGroup = document.querySelector('#quick-filter-group');
  const filename = document.querySelector('#filter-filename');
  const clear = document.querySelector('#reset-quick-filters');
  const remember = document.querySelector('#remember-folder-quick-filters');

  function folderKey() {
    const {library, folder} = getState();
    return library ? folderStore + JSON.stringify([getScope(), library, folder]) : null;
  }

  function remembered(key = folderKey()) {
    if (!key) return null;
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (!saved) return null;
      return {
        kind: normalizeAssetKind(saved.kind),
        quickFilters: normalizeQuickFilters(saved.quickFilters),
        fileNameQuery: typeof saved.fileNameQuery === 'string' ? saved.fileNameQuery.slice(0, 255) : '',
      };
    } catch {
      return null;
    }
  }

  function saveRemembered(key = folderKey()) {
    if (!key) return;
    const {kind, quickFilters, fileNameQuery} = getState();
    try {
      localStorage.setItem(key, JSON.stringify({kind, quickFilters, fileNameQuery}));
    } catch {
      onError('无法在此设备保存文件夹快筛');
    }
  }

  function renderRemembered() {
    const key = folderKey();
    remember.classList.toggle('hidden', !key);
    remember.setAttribute('aria-pressed', String(Boolean(remembered(key))));
  }

  function change(criteria) {
    onChange(criteria);
    if (remembered()) saveRemembered();
  }

  typeTabs.addEventListener('click', event => {
    const button = event.target.closest('[data-kind]');
    if (button) change({kind: button.dataset.kind});
  });
  filterGroup.addEventListener('click', event => {
    const button = event.target.closest('[data-quick-filter]');
    if (!button) return;
    const key = button.dataset.quickFilter;
    const current = getState().quickFilters;
    const next = current.includes(key) ? current.filter(value => value !== key) : [...current, key];
    change({quickFilters: normalizeQuickFilters(next)});
  });
  filename.addEventListener('input', () => change({fileNameQuery: filename.value}));
  clear.addEventListener('click', () => {
    change({kind: 'all', quickFilters: [], fileNameQuery: ''});
  });
  remember.addEventListener('click', () => {
    const key = folderKey();
    if (!key) return;
    if (remembered(key)) {
      try {
        localStorage.removeItem(key);
      } catch {
        onError('无法清除文件夹快筛记录');
      }
    } else {
      saveRemembered(key);
    }
    renderRemembered();
  });

  return {
    remembered,
    saveIfRemembered() {
      if (remembered()) saveRemembered();
    },
    render({typeCounts, counts}) {
      const state = getState();
      for (const button of typeTabs.querySelectorAll('[data-kind]')) {
        const kind = button.dataset.kind;
        button.hidden = !categoryEnabled(kind);
        button.setAttribute('aria-pressed', String(state.kind === kind));
        button.querySelector('[data-filter-label]').textContent = kindLabel(kind);
        button.querySelector('[data-filter-count]').textContent = typeCounts.get(kind) || 0;
      }
      for (const button of filterGroup.querySelectorAll('[data-quick-filter]')) {
        const key = button.dataset.quickFilter;
        button.setAttribute('aria-pressed', String(state.quickFilters.includes(key)));
        button.querySelector('[data-filter-count]').textContent = counts[key];
      }
      if (filename.value !== state.fileNameQuery) filename.value = state.fileNameQuery;
      clear.disabled = state.kind === 'all' && !state.quickFilters.length && !state.fileNameQuery;
      renderRemembered();
    },
  };
}
