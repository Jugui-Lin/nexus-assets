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

export function addressForFolder(library, folder = '') {
  const root = parseAddress(library?.path);
  if (!root) return '';
  return pathText({...root, segments: [...root.segments, ...folder.split('/').filter(Boolean)]});
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

export function initFolderAddress({getLocation, getLibraries, findFolder, openFolder, goHome, onUnknownPath, browseFolder, openAddressMenu, copyAddress, notify}) {
  const section = document.querySelector('#folder-address');
  const toggle = section.querySelector('#folder-address-toggle');
  const panel = document.createElement('nav');
  panel.id = 'folder-address-panel';
  panel.className = 'folder-address-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', '文件夹地址和导航');
  panel.innerHTML = '<form class="folder-address-form">' +
    '<button type="button" class="folder-address-open" title="在文件管理器中打开当前文件夹" ' +
    'aria-label="在文件管理器中打开当前文件夹" disabled>' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3z"/></svg></button>' +
    '<input id="folder-address-input" type="text" aria-label="当前文件夹路径，输入后按 Enter 前往" ' +
    'aria-keyshortcuts="Control+L Meta+L" autocomplete="off" spellcheck="false" placeholder="输入文件夹路径…" />' +
    '<button type="submit" class="folder-address-go" aria-label="前往输入的路径">前往</button></form>';
  section.insertBefore(panel, toggle);

  const input = section.querySelector('#folder-address-input');
  const form = section.querySelector('form');
  const browse = section.querySelector('.folder-address-open');
  const histories = new Map();
  let display;

  function setPanelOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) input.focus({preventScroll:true});
    else input.value = display?.address || '';
  }

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

  function currentAddress({libraryId, folder}) {
    return addressForFolder(getLibraries().find(item => item.id === libraryId), folder);
  }

  function render() {
    const location = getLocation();
    const {scope, libraryId, folder, hidden} = location;
    const history = currentHistory();
    const next = {libraryId, folder, key:locationKey(libraryId, folder)};
    if (next.key !== history.current?.key) {
      if (history.current && !history.replaying) {
        push(history.back, history.current);
        history.forward.length = 0;
      }
      history.current = next;
    }

    section.hidden = Boolean(hidden);
    if (hidden || (display && display.scope !== scope)) setPanelOpen(false);
    const address = currentAddress(location);
    const displayKey = JSON.stringify([scope, next.key, address]);
    if (displayKey !== display?.key) {
      display = {key:displayKey, scope, address};
      input.value = address;
      input.title = address;
    }
    browse.disabled = !browseFolder || !address || Boolean(hidden);
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
      render();
      return;
    }
    push(destinationStack, history.current);
    history.replaying = true;
    try {
      if (destination.libraryId) openFolder(destination.libraryId, destination.folder);
      else goHome();
    } finally {
      history.replaying = false;
      render();
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

  function matchedFolder(match) {
    const {libraryId, folder, caseInsensitive} = match;
    const direct = findFolder(libraryId, folder);
    if (direct || !caseInsensitive || !folder) return direct;
    // Team directory names are stored verbatim even on a case-insensitive mount.
    let current = findFolder(libraryId, '');
    for (const component of folder.split('/')) {
      current = current?.children.find(child => child.name.toLowerCase() === component.toLowerCase());
      if (!current) break;
    }
    return current;
  }

  toggle.addEventListener('click', () => setPanelOpen(panel.hidden));
  function showAddressMenu(event) {
    event.preventDefault();
    if (section.hidden || !display?.address || document.querySelector('dialog[open]')) return;
    const {key, address} = display;
    const useCurrentAddress = action => () => {
      if (!section.hidden && display?.key === key) return action(address);
    };
    openAddressMenu(toggle, event, {
      browse: browseFolder && useCurrentAddress(browseFolder),
      copy: useCurrentAddress(copyAddress),
    });
  }
  toggle.addEventListener('contextmenu', showAddressMenu);
  toggle.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) showAddressMenu(event);
  });
  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !section.contains(event.target)) setPanelOpen(false);
  });
  browse.addEventListener('click', async () => {
    const location = getLocation();
    const address = currentAddress(location);
    if (!browseFolder || !address || location.hidden) return;
    try {
      await browseFolder(address);
    } catch (error) {
      notify(String(error?.message || error), true);
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!input.value.trim()) return;
    const result = matchFolderAddress(input.value, getLibraries());
    if (!result) {
      notify('请输入完整的文件夹路径', true);
      return;
    }
    const {path, match} = result;
    const folder = match && matchedFolder(match);
    if (folder) {
      openFolder(match.libraryId, folder.path);
      render();
      input.value = display.address;
      return;
    }
    try {
      await onUnknownPath(path, match);
    } catch (error) {
      notify(String(error?.message || error), true);
    }
  });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setPanelOpen(false);
    toggle.focus({preventScroll:true});
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || section.hidden || document.querySelector('dialog[open]')) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      setPanelOpen(true);
      input.select();
      return;
    }
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
  return {render};
}
