const limit = 512;
const uncPrefix = /^[/\\]{2}(?:\?[/\\]unc[/\\])?/i;
const windowsPath = /^([a-z]:[/\\]|[/\\]{2})/i;

function normalPath(path) {
  if (typeof path !== 'string' || !path) return '';
  if (uncPrefix.test(path)) return '//'+path.replace(uncPrefix,'').replaceAll('\\','/');
  return windowsPath.test(path) ? path.replaceAll('\\','/') : path;
}

function keyFor(path) {
  return /^[a-z]:/i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

function parent(path) {
  return path.slice(0,path.lastIndexOf('/') + 1).replace(/\/$/,'') || '/';
}

export function createAssetSearchLocations({resolve,refresh,libraryName}) {
  let queryScope = '';
  let signature = '';
  let epoch = 0;
  let mappings = new Map();
  let aliases = new Map();
  const opened = new Set();

  function update(key,rows) {
    if (queryScope !== key) {
      queryScope = key;
      mappings = new Map();
      aliases = new Map();
      opened.clear();
    }
    const unique = new Set();
    if (key) for (const {path} of rows) {
      if (typeof path === 'string' && windowsPath.test(path) && path.length <= 4096) unique.add(path);
      if (unique.size === limit) break;
    }
    const paths = [...unique];
    const requestKey = JSON.stringify([key,paths]);
    if (requestKey === signature) return;
    signature = requestKey;
    const request = ++epoch;
    mappings = new Map();
    aliases = new Map();
    if (!paths.length || !resolve) return;
    Promise.resolve(resolve(paths)).then(values => {
      if (request !== epoch || !Array.isArray(values) || values.length !== paths.length) return;
      for (let i = 0; i < paths.length; i++) {
        if (typeof values[i] !== 'string' || !uncPrefix.test(values[i])) continue;
        const network = normalPath(values[i]);
        if (opened.has(keyFor(parent(normalPath(paths[i]))))) opened.add(keyFor(parent(network)));
        mappings.set(paths[i],network);
        const index = keyFor(network);
        if (!aliases.has(index)) aliases.set(index,new Map());
        aliases.get(index).set(keyFor(normalPath(paths[i])),paths[i]);
      }
      if (mappings.size) refresh();
    }).catch(() => {});
  }

  function group(asset) {
    const network = mappings.get(asset.path);
    const path = network || normalPath(asset.path);
    if (path && (path.startsWith('/') || windowsPath.test(path))) {
      const directory = parent(path);
      return {key:keyFor(directory),title:directory};
    }
    const folder = asset.relativePath?.replaceAll('\\','/').split('/').slice(0,-1).join('/') || '';
    const title = [libraryName(asset.libraryId),folder].filter(Boolean).join(' / ') || '无原件位置';
    return {key:JSON.stringify([asset.libraryId,folder]),title};
  }

  function groups(rows) {
    const result = new Map();
    for (const asset of rows) {
      const origin = group(asset);
      if (!result.has(origin.key)) result.set(origin.key,{...origin,items:[]});
      result.get(origin.key).items.push(asset);
    }
    return result;
  }

  return {
    update,group,groups,opened,
    alias(asset) {
      const identity = mappings.get(asset.path);
      const paths = identity && aliases.get(keyFor(identity));
      return paths?.size > 1 ? {path:identity,count:paths.size} : null;
    },
  };
}
