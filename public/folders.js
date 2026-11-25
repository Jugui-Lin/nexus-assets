const folderOrder = new Intl.Collator('zh-CN', {numeric: true});

function absoluteParts(value) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const windows = /^[a-z]:[\\/]|^\\\\|^\/\/[^/]/i.test(value);
  let path = windows ? value.replaceAll('\\', '/') : value;
  if (windows && path.startsWith('//?/')) {
    path = /^\/\/\?\/unc\//i.test(path) ? '//' + path.slice(8) : path.slice(4);
  }

  let volume;
  let parts;
  if (windows && /^[a-z]:\//i.test(path)) {
    volume = path.slice(0, 2).toLowerCase();
    parts = path.slice(3).split('/');
  } else if (windows && path.startsWith('//')) {
    const [host, share, ...rest] = path.slice(2).split('/');
    if (!host || !share || host === '.' || host === '?') return null;
    volume = '//' + host.toLowerCase() + '/' + share.toLowerCase();
    parts = rest;
  } else if (!windows && path.startsWith('/')) {
    volume = '/';
    parts = path.slice(1).split('/');
  } else {
    return null;
  }

  if (parts.includes('..')) return null;
  return {volume, parts: parts.filter(part => part && part !== '.'), windows};
}

function relativeParts(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\0')) return null;
  const parts = path.split('/').filter(Boolean);
  return parts.includes('..') ? null : parts.filter(part => part !== '.');
}

function caseKey(part, windows) {
  return windows ? part.toLowerCase() : part;
}

function hasPrefix(parts, prefix, windows) {
  return prefix.length <= parts.length &&
    prefix.every((part, index) => caseKey(part, windows) === caseKey(parts[index], windows));
}

/**
 * Returns a library-relative asset path. The team catalog's relative path
 * remains available even before a member maps the shared library locally.
 */
export function relativeAssetPath(asset, library) {
  if (!library || asset.libraryId !== library.id) return null;
  return relativePathInRoot(asset, absoluteParts(library.path));
}

function relativePathInRoot(asset, root) {
  if (typeof asset.relativePath === 'string') {
    const path = asset.relativePath.replaceAll('\\', '/');
    if (/^[a-z]:/i.test(path) || path.endsWith('/')) return null;
    return relativeParts(path)?.join('/') || null;
  }

  const file = absoluteParts(asset.path);
  if (!root || !file || root.volume !== file.volume ||
      !hasPrefix(file.parts, root.parts, root.windows)) {
    return null;
  }
  return file.parts.slice(root.parts.length).join('/') || null;
}

export function assetInFolder(asset, library, folderPath = '', recursive = true) {
  return createFolderMatcher(library, folderPath, recursive)(asset);
}

export function createFolderMatcher(library, folderPath = '', recursive = true) {
  if (!library) return () => false;
  if (folderPath === '' && recursive) return asset => asset.libraryId === library.id;
  const folder = relativeParts(folderPath);
  if (!folder) return () => false;
  const root = absoluteParts(library.path);
  const windows = library.source !== 'team' && Boolean(root?.windows);
  return asset => {
    if (asset.libraryId !== library.id) return false;
    const relative = relativePathInRoot(asset, root);
    if (!relative) return false;
    const parent = relative.split('/').slice(0, -1);
    return (recursive || parent.length === folder.length) && hasPrefix(parent, folder, windows);
  };
}

export function folderAncestors(path) {
  const parts = relativeParts(path) || [];
  return parts.map((name, index) => ({name, path: parts.slice(0, index + 1).join('/')}));
}

/**
 * Builds a tree from scanned directories. Asset paths fill in directories
 * for older and team catalogs that have no complete inventory.
 */
export function buildFolderTree(assets, library, thumbnailRank) {
  const rootPath = absoluteParts(library?.path);
  const windows = library?.source !== 'team' && Boolean(rootPath?.windows);
  const root = folderNode(library?.name || '', '');
  const childrenByName = new Map([[root, new Map()]]);
  root.caseInsensitive = windows;
  if (!library) return root;
  const foldersComplete = library.foldersComplete === true;

  function insert(parts, asset = null) {
    const rank = asset && parts.length && thumbnailRank ? thumbnailRank(asset) : 0;
    const previewNodes = rank ? [] : null;
    let parent = root;
    for (const name of parts) {
      const children = childrenByName.get(parent);
      const key = caseKey(name, windows);
      let child = children.get(key);
      if (!child) {
        if (asset && foldersComplete) return;
        const path = parent.path ? parent.path + '/' + name : name;
        child = folderNode(name, path);
        children.set(key, child);
        parent.children.push(child);
        childrenByName.set(child, new Map());
      }
      if (asset) child.count++;
      if (previewNodes) previewNodes.push(child);
      parent = child;
    }
    if (asset) parent.directCount++;
    if (!previewNodes) return;
    for (const node of previewNodes) {
      const previews = node.previews ??= [];
      const position = previews.findIndex(preview => preview.rank < rank);
      if (position !== -1) {
        previews.splice(position, 0, {id:asset.id, rank});
        if (previews.length > 3) previews.pop();
      } else if (previews.length < 3) {
        previews.push({id:asset.id, rank});
      }
    }
  }

  const scanned = Array.isArray(library.folders) ? library.folders : [];
  for (const folder of scanned) {
    const parts = relativeParts(folder);
    if (parts?.length) insert(parts);
  }

  for (const asset of assets) {
    if (asset.libraryId !== library.id) continue;
    root.count++;
    const relative = relativePathInRoot(asset, rootPath);
    if (relative) insert(relative.split('/').slice(0, -1), asset);
  }

  for (const node of childrenByName.keys()) {
    node.children.sort((left, right) => folderOrder.compare(left.name, right.name));
  }
  return root;
}

function folderNode(name, path) {
  return {name, path, count: 0, directCount: 0, children: []};
}

export function findFolder(root, path) {
  const parts = relativeParts(path);
  if (!root || !parts) return null;
  let node = root;
  for (const part of parts) {
    const key = caseKey(part, root.caseInsensitive);
    node = node.children.find(child => caseKey(child.name, root.caseInsensitive) === key);
    if (!node) return null;
  }
  return node;
}

export function filterFolderTree(root, query) {
  const needle = query.trim().toLocaleLowerCase();
  function match(node) {
    if (!node || !needle || node.name.toLocaleLowerCase().includes(needle)) return node;
    const children = node.children.map(match).filter(Boolean);
    return children.length ? {...node, children} : null;
  }
  return match(root);
}

export function applyTeamFolderVisibility(catalog, removals) {
  if (!removals.length) return catalog;

  const rules = new Map();
  for (const {libraryId, path} of removals) {
    if (!rules.has(libraryId)) rules.set(libraryId, {paths: new Set(), ancestors: new Set()});
    rules.get(libraryId).paths.add(path);
  }

  function isHidden(path, rule) {
    const folders = folderAncestors(path);
    const index = folders.findIndex(folder => rule.paths.has(folder.path));
    if (index === -1) return false;
    for (const folder of folders.slice(0, index)) rule.ancestors.add(folder.path);
    return true;
  }

  const librariesById = new Map(catalog.libraries.map(library => [library.id, library]));
  const assets = catalog.assets.filter(asset => {
    const rule = rules.get(asset.libraryId);
    if (!rule) return true;
    if (rule.paths.has('')) return false;
    const relative = relativeAssetPath(asset, librariesById.get(asset.libraryId));
    const directory = relative?.split('/').slice(0, -1).join('/') || '';
    return !isHidden(directory, rule);
  });
  const libraries = catalog.libraries.flatMap(library => {
    const rule = rules.get(library.id);
    if (!rule) return [library];
    if (rule.paths.has('')) return [];
    const visible = (library.folders || []).filter(path => !isHidden(path, rule));
    return [{...library, folders: [...new Set([...visible, ...rule.ancestors])]}];
  });
  return {assets, libraries};
}

export function restoreLinkedTeamFolders(removals, links, libraries) {
  if (!removals.length || !links.length) return removals;
  const windowsLibraries = new Set(libraries.filter(library => absoluteParts(library.path)?.windows).map(library => library.id));
  const linked = new Map();
  for (const {libraryId, folder} of links) {
    const windows = windowsLibraries.has(libraryId);
    const parts = relativeParts(windows && typeof folder === 'string' ? folder.replaceAll('\\', '/') : folder);
    if (!parts) continue;
    if (!linked.has(libraryId)) linked.set(libraryId, []);
    linked.get(libraryId).push(parts);
  }
  const remaining = removals.filter(({libraryId, path}) => {
    const windows = windowsLibraries.has(libraryId);
    const parts = relativeParts(windows ? path.replaceAll('\\', '/') : path);
    return !parts || !linked.get(libraryId)?.some(folder => hasPrefix(folder, parts, windows));
  });
  return remaining.length === removals.length ? removals : remaining;
}

export function mergedTeamFolderMap(links) {
  const merged = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    const path = typeof link?.folder === 'string' ? link.folder.replaceAll('\\', '/') : null;
    const parts = relativeParts(path);
    if (typeof link?.libraryId === 'string' && link.libraryId &&
        typeof link.targetLibraryId === 'string' && link.targetLibraryId && link.libraryId !== link.targetLibraryId &&
        parts?.length && !/^[a-z]:/i.test(path)) {
      merged.set(link.libraryId, {libraryId: link.targetLibraryId, folder: parts.join('/')});
    }
  }
  return merged;
}

export function rebaseMergedTeamFolder(merged, libraryId, folder) {
  if (!merged.has(libraryId)) return null;
  const path = typeof folder === 'string' ? folder.replaceAll('\\', '/') : null;
  const parts = relativeParts(path);
  if (!parts || /^[a-z]:/i.test(path)) return null;

  const seen = new Set();
  let currentFolder = parts.join('/');
  let currentLibrary = libraryId;
  while (merged.has(currentLibrary)) {
    if (seen.has(currentLibrary)) return null;
    seen.add(currentLibrary);
    const target = merged.get(currentLibrary);
    currentLibrary = target.libraryId;
    currentFolder = currentFolder ? `${target.folder}/${currentFolder}` : target.folder;
  }
  return {libraryId: currentLibrary, folder: currentFolder};
}
