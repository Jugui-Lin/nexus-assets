function parseAddress(value) {
  let path = String(value ?? '').trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (!path || path.includes('\0')) return null;

  const windows = /^[a-z]:(?:[\\/]|$)|^\\\\|^\/\/[^/]/i.test(path);
  let anchor;
  let rest;
  if (windows) {
    path = path.replaceAll('\\', '/');
    if (/^\/\/\?\/unc\//i.test(path)) path = '//' + path.slice(8);
    else if (path.startsWith('//?/')) path = path.slice(4);

    const drive = /^([a-z]:)(?:\/|$)/i.exec(path);
    if (drive) {
      anchor = drive[1] + '\\';
      rest = path.slice(drive[0].length);
    } else if (path.startsWith('//')) {
      const [host, share, ...segments] = path.slice(2).split('/');
      if (!host || !share || ['.', '..', '?'].includes(host) || ['.', '..'].includes(share)) return null;
      anchor = '\\\\' + host + '\\' + share;
      rest = segments.join('/');
    } else {
      return null;
    }
  } else {
    if (!path.startsWith('/')) return null;
    anchor = '/';
    rest = path.slice(1);
  }

  const segments = [];
  for (const component of rest.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else {
      if (windows && /[:*?"<>|]/.test(component)) return null;
      segments.push(component);
    }
  }
  return {anchor, segments, windows};
}

function pathText({anchor, segments, windows}) {
  const separator = windows ? '\\' : '/';
  const joiner = segments.length && !anchor.endsWith(separator) ? separator : '';
  return anchor + joiner + segments.join(separator);
}

function componentKey(component, windows) {
  return windows ? component.toLowerCase() : component;
}

export function matchFolderAddress(value, libraries) {
  const input = parseAddress(value);
  if (!input) return null;
  const inputAnchor = componentKey(input.anchor, input.windows);
  let deepest = null;
  let depth = -1;
  for (const library of libraries) {
    const root = parseAddress(library.path);
    if (!root || root.windows !== input.windows || root.segments.length <= depth ||
        root.segments.length > input.segments.length ||
        componentKey(root.anchor, root.windows) !== inputAnchor) continue;
    if (root.segments.some((segment, index) =>
      componentKey(segment, input.windows) !== componentKey(input.segments[index], input.windows))) continue;

    depth = root.segments.length;
    deepest = {
      libraryId: library.id,
      folder: input.segments.slice(depth).join('/'),
      caseInsensitive: input.windows,
    };
  }
  return {path: pathText(input), match: deepest};
}

export function initAssetFolderHistory({getLocation, findFolder, openFolder, goHome}) {
  const histories = new Map();

  function currentHistory() {
    const scope = getLocation().scope;
    if (!histories.has(scope)) histories.set(scope, {back: [], forward: [], current: null, replaying: false});
    return histories.get(scope);
  }

  function locationKey(libraryId, folder) {
    return JSON.stringify([libraryId || null, folder || '']);
  }

  function push(list, value) {
    list.push(value);
    if (list.length > 80) list.shift();
  }

  function isAvailable(destination) {
    return !destination.libraryId || Boolean(findFolder(destination.libraryId, destination.folder));
  }

  function recordLocation() {
    const {libraryId, folder} = getLocation();
    const history = currentHistory();
    const next = {libraryId, folder, key:locationKey(libraryId, folder)};
    if (next.key !== history.current?.key) {
      if (history.current && !history.replaying) {
        push(history.back, history.current);
        history.forward.length = 0;
      }
      history.current = next;
    }
  }

  function traverse(direction) {
    const history = currentHistory();
    if (!history.current) return;
    const source = history[direction];
    const destinationStack = history[direction === 'back' ? 'forward' : 'back'];
    let destination;
    while (source.length) {
      const candidate = source.pop();
      if (isAvailable(candidate) && candidate.key !== history.current.key) {
        destination = candidate;
        break;
      }
    }
    if (!destination) {
      recordLocation();
      return;
    }
    push(destinationStack, history.current);
    history.replaying = true;
    try {
      if (destination.libraryId) openFolder(destination.libraryId, destination.folder);
      else goHome();
    } finally {
      history.replaying = false;
      recordLocation();
    }
  }

  function goUp() {
    const location = getLocation();
    if (!location.libraryId) return;
    if (location.folder) {
      openFolder(location.libraryId, location.folder.split('/').slice(0, -1).join('/'));
    } else {
      goHome();
    }
  }

  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || getLocation().hidden || document.querySelector('dialog[open]')) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const direction = {ArrowLeft:'back', ArrowRight:'forward', ArrowUp:'up'}[event.key];
    if (direction === 'up' && getLocation().libraryId) {
      event.preventDefault();
      goUp();
    } else if ((direction === 'back' || direction === 'forward') && currentHistory()[direction].some(isAvailable)) {
      event.preventDefault();
      traverse(direction);
    }
  });
  return {recordLocation};
}
