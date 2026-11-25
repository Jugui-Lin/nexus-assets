const cacheKey = 'nexus-team-organization-v1';
const cacheLimit = 400_000;
const cacheEntries = 4;
const collectionWrites = new Set(['create_collection', 'rename_collection', 'delete_collection', 'set_collection_membership']);

function emptySnapshot() {
  return {revision:0, favoriteIds:[], collections:[]};
}

function assetIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.startsWith('team:')))];
}

function collection(input) {
  return typeof input?.id === 'string' && input.id && typeof input.name === 'string' && input.name.trim()
    ? {id:input.id, name:input.name, assetIds:assetIds(input.assetIds)} : null;
}

function normalized(snapshot) {
  return {revision:Number.isSafeInteger(snapshot?.revision) ? snapshot.revision : 0,
    favoriteIds:assetIds(snapshot?.favoriteIds),
    collections:(Array.isArray(snapshot?.collections) ? snapshot.collections : []).map(collection).filter(Boolean)};
}

function cacheHistory() {
  try {
    const stored = localStorage.getItem(cacheKey);
    const history = stored && stored.length <= cacheLimit ? JSON.parse(stored) : null;
    return Array.isArray(history) ? history.slice(0, cacheEntries) : [];
  } catch { return []; }
}

function storeCache(identity, snapshot) {
  try {
    const history = [{identity, snapshot}, ...cacheHistory().filter(entry => entry?.identity !== identity)]
      .slice(0, cacheEntries);
    while (history.length) {
      const serialized = JSON.stringify(history);
      if (serialized.length <= cacheLimit) {
        localStorage.setItem(cacheKey, serialized);
        return;
      }
      history.pop();
    }
  } catch { /* Remote state still applies if local storage cannot be written. */ }
}

const describeError = failure => String(failure?.message || failure || '团队收藏和合集同步失败').slice(0, 220);
const normalizedName = name => name.trim().toLowerCase();

export function initTeamOrganization({api, context, onChange, notify}) {
  const mergeButton = document.getElementById('merge-local-organization');
  const status = document.getElementById('team-organization-status');
  let workspace = null;

  function identityOf(value) {
    return value?.teamId ? JSON.stringify([value.teamId, value.key]) : null;
  }

  function isCurrent(state) {
    return state === workspace && state.identity === identityOf(context());
  }

  function updateControls(state) {
    mergeButton.classList.toggle('hidden', !state);
    mergeButton.disabled = state?.phase !== 'ready' || Boolean(state?.writing);
    status.classList.toggle('hidden', !state || state.phase === 'ready' && !state.notice);
    status.dataset.phase = state?.phase || '';
    const message = state?.notice || state?.message || '';
    if (status.textContent !== message) status.textContent = message;
  }

  function selectWorkspace() {
    const current = context();
    const identity = identityOf(current);
    if (identity === (workspace?.identity ?? null)) return workspace;
    if (!identity) {
      workspace = null;
      updateControls(null);
      return null;
    }
    const cached = cacheHistory().find(entry => entry?.identity === identity)?.snapshot;
    const snapshot = cached ? normalized(cached) : emptySnapshot();
    workspace = {identity, teamId:current.teamId, snapshot, favorites:new Set(snapshot.favoriteIds),
      phase:'loading', message:'正在同步团队收藏和合集…', cached:Boolean(cached)};
    updateControls(workspace);
    return workspace;
  }

  function publicSnapshot(state) {
    return {available:state.phase === 'ready', phase:state.phase, message:state.message, ...state.snapshot};
  }

  function publish(state) {
    if (!isCurrent(state)) return;
    updateControls(state);
    const value = publicSnapshot(state);
    const signature = JSON.stringify(value);
    if (signature === state.published) return;
    state.published = signature;
    onChange(value);
  }

  function replace(state, snapshot) {
    state.snapshot = snapshot;
    state.favorites = new Set(snapshot.favoriteIds);
  }

  function refresh() {
    const state = selectWorkspace();
    if (!state) return Promise.resolve(null);
    publish(state);
    if (state.writing) return Promise.resolve(publicSnapshot(state));
    if (state.read) return state.read;
    const read = Promise.resolve().then(async () => {
      try {
        const result = await api('team_organization', {teamId:state.teamId});
        if (!isCurrent(state) || state.read !== read) return publicSnapshot(state);
        if (result?.available === false) {
          state.phase = 'unavailable';
          state.message = '团队服务需要更新，收藏和合集暂时只读。';
        } else {
          if (result?.available !== true || !Array.isArray(result.favoriteIds) || !Array.isArray(result.collections)) {
            throw Error('团队服务未返回收藏和合集。');
          }
          const snapshot = normalized(result);
          const signature = JSON.stringify(snapshot);
          if (signature !== state.lastCached) {
            state.lastCached = signature;
            storeCache(state.identity, snapshot);
          }
          replace(state, snapshot);
          state.cached = true;
          state.phase = 'ready';
          state.message = '';
        }
      } catch (failure) {
        if (isCurrent(state) && state.read === read) {
          state.phase = 'error';
          state.message = `${state.cached ? '显示上次同步的收藏和合集 · ' : ''}${describeError(failure)}`;
        }
      } finally {
        if (isCurrent(state) && state.read === read) {
          state.read = null;
          publish(state);
        }
      }
      return publicSnapshot(state);
    });
    state.read = read;
    return read;
  }

  function assertCurrent(state) {
    if (!isCurrent(state)) throw Error('团队工作空间已切换。');
  }

  async function write(state, operation) {
    assertCurrent(state);
    if (state.phase !== 'ready') throw Error(state.message || '团队收藏和合集当前只读。');
    if (state.writing) throw Error('正在保存团队收藏或合集，请稍后再试。');
    state.writing = true;
    state.read = null;
    updateControls(state);
    try {
      const result = await operation();
      assertCurrent(state);
      return result;
    } finally {
      if (isCurrent(state)) {
        state.writing = false;
        publish(state);
        refresh();
      }
    }
  }

  async function send(state, command, args = {}) {
    assertCurrent(state);
    const result = await api(command, {...args, teamId:state.teamId});
    assertCurrent(state);
    return result;
  }

  function updateCollection(state, result) {
    const entry = collection(result);
    if (!entry) throw Error('团队服务未确认合集修改。');
    const {collections} = state.snapshot;
    const items = collections.some(item => item.id === entry.id)
      ? collections.map(item => item.id === entry.id ? entry : item) : [...collections, entry];
    state.snapshot = {...state.snapshot, collections:items};
  }

  async function request(command, args = {}) {
    const state = selectWorkspace();
    if (!state) throw Error('请先进入团队工作空间。');
    if (command === 'list_collections') {
      await refresh();
      assertCurrent(state);
      return state.snapshot.collections;
    }
    if (!collectionWrites.has(command)) throw Error('不支持的团队合集操作。');
    return write(state, async () => {
      const result = await send(state, 'team_' + command, args);
      if (command === 'delete_collection') {
        if (typeof result?.removed !== 'boolean') throw Error('团队服务未确认移除合集。');
        state.snapshot = {...state.snapshot, collections:state.snapshot.collections.filter(item => item.id !== args.id)};
      } else updateCollection(state, result);
      return result;
    });
  }

  async function saveFavorite(state, id, favorite) {
    const result = await send(state, 'team_set_favorite', {id, favorite});
    if (typeof result?.favorite !== 'boolean') throw Error('团队服务未确认收藏修改。');
    if (result.favorite) state.favorites.add(id);
    else state.favorites.delete(id);
    return result;
  }

  async function setFavorite(id, favorite) {
    const state = selectWorkspace();
    if (!state) throw Error('请先进入团队工作空间。');
    return write(state, async () => {
      const result = await saveFavorite(state, id, favorite);
      state.snapshot = {...state.snapshot, favoriteIds:[...state.favorites]};
      return result;
    });
  }

  function applyFavorites(assets) {
    const state = selectWorkspace();
    if (!state) return assets;
    state.assets = assets;
    for (const asset of assets) {
      if (asset.id.startsWith('team:')) asset.favorite = state.favorites.has(asset.id);
    }
    return assets;
  }

  async function matchingCollection(state, name) {
    const match = items => items.find(item => normalizedName(item.name) === normalizedName(name));
    const existing = match(state.snapshot.collections);
    if (existing) return existing;
    try {
      const created = await send(state, 'team_create_collection', {name});
      updateCollection(state, created);
      return created;
    } catch (failure) {
      // Another member may have created the same collection after the last sync.
      const latest = await send(state, 'team_organization');
      const found = match(normalized(latest).collections);
      if (!found) throw failure;
      updateCollection(state, found);
      return found;
    }
  }

  async function mergeLocal() {
    const state = selectWorkspace();
    if (!state) return;
    let favorites = 0;
    let collections = 0;
    let skipped = 0;
    try {
      if (!state.assets) throw Error('请先同步团队资产目录，再合并本机收藏和合集。');
      await write(state, async () => {
        state.notice = '正在合并本机收藏和合集…';
        updateControls(state);
        try {
          const local = normalized(await send(state, 'team_local_organization'));
          const visible = new Set(state.assets.map(asset => asset.id));
          const filterVisible = ids => ids.filter(id => {
            if (visible.has(id)) return true;
            skipped++;
            return false;
          });
          for (const id of filterVisible(local.favoriteIds)) {
            if (state.favorites.has(id)) continue;
            await saveFavorite(state, id, true);
            favorites++;
          }
          for (const localEntry of local.collections) {
            const target = await matchingCollection(state, localEntry.name);
            const entries = new Set(target.assetIds);
            const ids = filterVisible(localEntry.assetIds).filter(id => !entries.has(id));
            if (ids.length) updateCollection(state, await send(state, 'team_set_collection_membership',
              {id:target.id, assetIds:ids, include:true}));
            collections++;
          }
        } finally {
          state.notice = '';
          state.snapshot = {...state.snapshot, favoriteIds:[...state.favorites]};
        }
      });
      notify(`已新增 ${favorites} 项团队收藏，合并 ${collections} 个合集${skipped ? `，跳过 ${skipped} 个不可用引用` : ''}`);
    } catch (failure) {
      if (isCurrent(state)) notify(`合并未完成 · 已新增 ${favorites} 项收藏、合并 ${collections} 个合集 · ${describeError(failure)}`, true);
    }
  }

  mergeButton.addEventListener('click', mergeLocal);
  return {refresh, request, setFavorite, applyFavorites, mergeLocal};
}
