const cacheKey = scope => 'nexus-team-browser-sites-cache:' + scope;
const migrationKey = scope => 'nexus-team-browser-sites-migrated:' + scope;

function readCached(scope, normalize) {
  try { return normalize(JSON.parse(localStorage.getItem(cacheKey(scope)))); }
  catch { return null; }
}

function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function alreadyMigrated(scope) {
  try { return localStorage.getItem(migrationKey(scope)) === '1'; }
  catch { return false; }
}

export function initBrowserSiteTeamSync({read, write, normalize, defaults, legacy, mergeLegacy,
  apply, status, busy}) {
  let active = null;
  const state = () => active?.phase || '';
  const canWrite = () => !active || (state() === 'ready' && !active.saving);

  function decode(result) {
    if (!Number.isSafeInteger(result?.revision) || result.revision < 0)
      throw Error('团队服务返回了无效的站点版本。');
    const navigation = normalize(result.navigation);
    if (result.revision ? !navigation : result.navigation !== null)
      throw Error('团队服务返回了无效的站点导航。');
    return {revision:result.revision, navigation};
  }

  function commit(context, result) {
    const {revision,navigation} = decode(result);
    context.revision = revision;
    context.confirmed = navigation || defaults();
    writePreference(cacheKey(context.scope), JSON.stringify(context.confirmed));
    apply(context.confirmed);
  }

  function setScope(scope, teamId) {
    if (!teamId) {
      active = null;
      status();
      return null;
    }
    const existing = legacy(scope);
    const confirmed = readCached(scope,normalize) || existing || defaults();
    active = {scope, teamId, confirmed, phase:'loading', revision:0,
      migration:alreadyMigrated(scope) ? null : existing};
    status('loading');
    return confirmed;
  }

  async function refresh() {
    const context = active;
    if (!context || context.reading || context.saving || busy()) return;
    const readMarker = {};
    const current = () => active === context && context.reading === readMarker;
    context.reading = readMarker;
    try {
      const result = await read({teamId:context.teamId});
      if (!current() || busy()) return;
      if (result?.available !== true) {
        context.phase = 'unavailable';
        status('unavailable');
        return;
      }
      const {revision,navigation} = decode(result);
      let confirmed = result;
      if (context.migration) {
        const migrated = navigation ? mergeLegacy(navigation, context.migration) : context.migration;
        if (migrated !== navigation) {
          context.saving = true;
          status('saving');
          try {
            confirmed = await write({teamId:context.teamId,revision,navigation:migrated});
            if (!current()) return;
            if (confirmed?.available !== true || !decode(confirmed).navigation)
              throw Error('团队服务未确认旧站点迁移。');
          } finally { context.saving = false; }
        }
        context.migration = null;
        writePreference(migrationKey(context.scope), '1');
      }
      context.phase = 'ready';
      commit(context, confirmed);
      status('ready');
    } catch (error) {
      if (current()) {
        context.phase = 'error';
        status('error', error);
      }
    } finally {
      if (current()) context.reading = null;
    }
  }

  function save(navigation) {
    const context = active;
    if (!context || !canWrite()) return false;
    context.reading = null;
    context.saving = true;
    status('saving');
    Promise.resolve().then(() => active === context &&
      write({teamId:context.teamId, revision:context.revision,navigation}))
      .then(result => {
        if (active !== context) return;
        if (result?.available !== true || !decode(result).navigation)
          throw Error('团队服务未确认站点导航。');
        context.phase = 'ready';
        commit(context, result);
        status('ready');
      }).catch(error => {
        if (active !== context) return;
        context.phase = 'error';
        apply(context.confirmed);
        status('writeError', error);
      }).finally(() => {
        context.saving = false;
      });
    return true;
  }

  return {setScope,refresh,save,canWrite};
}
