function pathKey(path) {
  return path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

function volume(path) {
  return /^([a-z]:|\\\\[^\\]+\\[^\\]+)(?:\\|$)/.exec(pathKey(path))?.[1];
}

const dragNumber = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});

function sizeText(bytes) {
  const units = ['B','KB','MB','GB','TB'];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
  return dragNumber.format(bytes) + ' ' + units[index];
}

function dragSummary(count,entries) {
  if (count < 2) return '';
  if (!entries?.length) return count + ' 个项目';
  let bytes = 0;
  let files = 0;
  let folders = 0;
  let incomplete = false;
  for (const entry of entries) {
    if (entry.isDirectory) { folders++; continue; }
    files++;
    if (Number.isFinite(entry.size)) bytes += entry.size;
    else incomplete = true;
  }
  const counts = [files && files + ' 个文件',folders && folders + ' 个文件夹'].filter(Boolean).join(' · ');
  const size = files && !incomplete ? sizeText(bytes) + (folders ? '（文件）' : '') : '';
  return [counts,size].filter(Boolean).join(' · ');
}

export function initExplorerFileDrop({root, explorer, transfer, report, assetDragSource, basket, dragOut, waitForExit}) {
  const hint = root.querySelector('[data-explorer-drop-hint]');
  const pinBar = root.querySelector('.local-explorer-pin-bar');
  const pinItems = pinBar.querySelector('[data-explorer-pins]');
  const pinButton = pinBar.querySelector('[data-explorer-pin]');
  const ghost = root.ownerDocument.createElement('div');
  ghost.className = 'local-explorer-drag-ghost';
  ghost.setAttribute('aria-hidden','true');
  ghost.hidden = true;
  root.append(ghost);
  let gesture;
  let dragged;
  let nativePaths = [];
  let draggedSummary = '';
  let lastPointer;
  let expandFolders = false;
  let highlighted;
  let busy = false;
  let outgoing = false;
  let suppressClickUntil = 0;

  function clearTargetHighlight() {
    highlighted?.removeAttribute('data-explorer-drop-active');
    pinBar.removeAttribute('data-explorer-pin-append');
    pinBar.style.removeProperty('--explorer-pin-drop-offset');
    highlighted = null;
  }

  function clearHighlight() {
    clearTargetHighlight();
    hint.hidden = true;
    hint.removeAttribute('data-follow-pointer');
    hint.style.removeProperty('left');
    hint.style.removeProperty('top');
  }

  function clear() {
    const pointer = gesture?.pointer;
    if (dragged) suppressClickUntil = performance.now() + 160;
    gesture = null;
    clearHighlight();
    ghost.hidden = true;
    ghost.replaceChildren();
    root.removeAttribute('data-file-dragging');
    nativePaths = [];
    dragged = null;
    draggedSummary = '';
    lastPointer = null;
    expandFolders = false;
    explorer.clearDropFolders?.();
    if (pointer != null && root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer);
  }

  function describe(hit, paths, modifiers) {
    if (root.hidden || busy || !hit) return null;
    const entries = dragged?.entries;
    const basketTarget = basket?.target(hit);
    if (basketTarget) return entries?.length ? {element:basketTarget,basketEntries:entries} : null;
    const tabTarget = explorer.getFolderTabsDropTarget?.(hit);
    if (tabTarget && paths.length && (!dragged || entries?.some(entry => entry.isDirectory)))
      return {element:tabTarget,openTabs:true,folders:entries?.filter(entry => entry.isDirectory)};
    if (entries?.length && entries.every(entry => entry.isDirectory)) {
      if (pinBar.contains(hit) && !hit.closest('[data-explorer-drop-path]')) {
        return {element:pinBar,pins:entries};
      }
      if (!modifiers?.ctrlKey && !modifiers?.shiftKey) {
        const sidebar = explorer.getSidebarPinTarget(hit);
        if (sidebar) return {element:sidebar,pins:entries,sidebar:true};
      }
    }
    const target = explorer.getDropTarget(hit);
    if (!target || !paths.length) return null;
    const destination = pathKey(target.path);
    if (paths.some(path => {
      const source = pathKey(path);
      return source === destination || destination.startsWith(source + '\\');
    })) return null;
    const sameParent = paths.some(path => pathKey(path).slice(0,pathKey(path).lastIndexOf('\\')) === destination);
    if (dragged?.forceCopy) {
      if (sameParent || !dragged.valid()) return null;
      return {...target,effect:'copy'};
    }
    const sameVolume = Boolean(volume(target.path)) && paths.every(path => volume(path) === volume(target.path));
    // The webview accepts Windows-origin drops as copies. For drags that
    // start here, use the usual same-drive default and the live Ctrl/Shift keys.
    const move = modifiers && !modifiers.ctrlKey && (modifiers.shiftKey || sameVolume);
    if (move && sameParent) return null;
    return {...target,effect:move ? 'move' : 'copy'};
  }

  function positionPinMarker() {
    const rail = pinBar.getBoundingClientRect();
    const last = pinItems.lastElementChild;
    const end = last
      ? Math.min(last.getBoundingClientRect().right,pinItems.getBoundingClientRect().right)
      : pinButton.getBoundingClientRect().right;
    pinBar.style.setProperty('--explorer-pin-drop-offset',Math.min(end + 4,rail.right - 6) - rail.left + 'px');
  }

  function show(target, point) {
    if (!target) { clearHighlight(); return; }
    const topPin = Boolean(target.pins && target.element === pinBar);
    if (highlighted !== target.element) {
      clearTargetHighlight();
      highlighted = target.element;
      highlighted.setAttribute(topPin ? 'data-explorer-pin-append' : 'data-explorer-drop-active','');
    }
    if (topPin) positionPinMarker();
    const summary = dragged ? draggedSummary : dragSummary(nativePaths.length);
    const volumeLabel = summary && target.path && explorer.getVolumeLabel?.(target.path);
    const description = target.basketEntries ? '松开暂存到素材' : target.openTabs ? '在新标签页打开文件夹' :
      target.pins ? (target.sidebar ? '固定到左侧快速访问' : '固定到快速访问') :
      (target.effect === 'move' ? '移动到 ' : '复制到 ') + target.label;
    const text = [description,summary,volumeLabel && volumeLabel !== target.label && '目标卷 ' + volumeLabel]
      .filter(Boolean).join(' · ');
    if (hint.textContent !== text) hint.textContent = text;
    hint.hidden = false;
    const followsPointer = Boolean((target.pins || target.basketEntries) && point);
    hint.toggleAttribute('data-follow-pointer',followsPointer);
    if (followsPointer) {
      hint.style.left = Math.max(4,Math.min(point.clientX + 16,window.innerWidth - hint.offsetWidth - 6)) + 'px';
      hint.style.top = Math.max(4,Math.min(point.clientY + 20,window.innerHeight - hint.offsetHeight - 6)) + 'px';
    } else {
      hint.style.removeProperty('left');
      hint.style.removeProperty('top');
    }
  }

  async function drop(paths,target) {
    clear();
    if (!target || busy) return;
    if (target.basketEntries) {
      basket.add(target.basketEntries);
      return;
    }
    if (target.openTabs) {
      busy = true;
      try {
        const folders = target.folders || await explorer.classifyDroppedFolders(paths);
        const {opened,remaining} = explorer.openDroppedFolderTabs(folders);
        const description = opened ? '已打开 ' + opened + ' 个文件夹标签' : '没有新增文件夹标签';
        report(description + (remaining ? '，达到标签上限，另有 ' + remaining + ' 个未打开' : ''));
      } catch (failure) { report(String(failure?.message || failure),true); }
      finally { busy = false; }
      return;
    }
    if (target.pins) {
      const count = target.sidebar ? explorer.pinSidebarFolders(target.pins) : explorer.pinFolders(target.pins);
      if (count) report(target.sidebar ? '已在左侧固定 ' + count + ' 个文件夹' : '已固定 ' + count + ' 个文件夹');
      else if (target.sidebar) report('没有添加新的快速访问');
      return;
    }
    busy = true;
    try {
      await transfer({paths,directoryPath:target.path,effect:target.effect});
      report((target.effect === 'move' ? '已移动到 ' : '已复制到 ') + target.label);
    } catch (failure) {
      report(String(failure?.message || failure),true);
    } finally {
      busy = false;
      explorer.refreshAfterTransfer({paths,directoryPath:target.path,effect:target.effect});
    }
  }

  function startPreview(source) {
    const icon = source.element.querySelector('.local-explorer-folder-preview');
    const preview = icon?.getClientRects().length ? icon :
      source.element.querySelector(source.forceCopy ? '.folder-asset-thumbnail' : '.local-explorer-entry');
    if (!preview) return;
    const copy = preview.cloneNode(true);
    copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    ghost.replaceChildren(copy);
    ghost.hidden = false;
  }

  async function leaveWindow(current) {
    if (!dragOut || !dragged || gesture !== current || outgoing) return;
    const source = dragged;
    if (source.valid && !source.valid()) { clear(); return; }
    outgoing = true;
    clear();
    try {
      await dragOut({paths:source.paths,entries:source.entries});
    } catch (failure) {
      report(String(failure?.message || failure),true);
    } finally {
      outgoing = false;
      suppressClickUntil = performance.now() + 160;
    }
  }

  function updateDragTarget(point) {
    if (!dragged) return;
    const atPoint = () => document.elementFromPoint(point.clientX,point.clientY);
    let hit = atPoint();
    if (!hit?.closest('.local-explorer-sidebar')) explorer.clearDropFolders?.();
    let target = describe(hit,dragged.paths,point);
    if (expandFolders && target?.path && explorer.expandDropFolder?.(hit)) {
      hit = atPoint();
      target = describe(hit,dragged.paths,point);
    }
    show(target,point);
  }

  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType === 'touch' || gesture || busy || outgoing ||
        document.querySelector('dialog[open]') || explorer.useAlternateMenu?.(event)) return;
    const source = assetDragSource?.(event.target) || explorer.getDragSource(event.target);
    if (source?.paths.length) gesture = {source,pointer:event.pointerId,x:event.clientX,y:event.clientY};
  });
  root.addEventListener('dragstart', event => {
    if (gesture || event.target.closest('[data-folder-asset-id], [data-entry-index]')) event.preventDefault();
  });
  window.addEventListener('pointermove',event => {
    const current = gesture;
    if (!current || current.pointer !== event.pointerId) return;
    if (!(event.buttons & 1)) { clear(); return; }
    if (!dragged) {
      if (Math.hypot(event.clientX - current.x,event.clientY - current.y) < 6) return;
      dragged = current.source;
      draggedSummary = dragSummary(dragged.paths.length,dragged.entries);
      root.setPointerCapture(current.pointer);
      root.setAttribute('data-file-dragging','');
      startPreview(dragged);
      waitForExit?.().then(exited => { if (exited) void leaveWindow(current); }).catch(() => {});
    }
    event.preventDefault();
    const {clientX,clientY} = event;
    if (dragOut && (clientX < 0 || clientY < 0 || clientX >= window.innerWidth || clientY >= window.innerHeight)) {
      void leaveWindow(current);
      return;
    }
    ghost.style.left = Math.max(1,clientX - 20) + 'px';
    ghost.style.top = Math.max(1,clientY - 24) + 'px';
    lastPointer = event;
    updateDragTarget(event);
  },{passive:false});
  window.addEventListener('pointerup',event => {
    if (gesture?.pointer !== event.pointerId) return;
    if (!dragged) { clear(); return; }
    const paths = dragged.paths;
    const target = describe(document.elementFromPoint(event.clientX,event.clientY),paths,event);
    void drop(paths,target);
  });
  window.addEventListener('pointercancel',event => {
    if (gesture?.pointer === event.pointerId) clear();
  });
  window.addEventListener('blur',() => { if (gesture) clear(); });
  window.addEventListener('keydown',event => {
    if (event.key === 'Escape' && gesture) { clear(); return; }
    if (event.code !== 'Space' || !dragged || !lastPointer) return;
    event.preventDefault();
    event.stopPropagation();
    expandFolders = true;
    updateDragTarget(lastPointer);
  },true);
  window.addEventListener('keyup',event => {
    if (event.code === 'Space') expandFolders = false;
  });
  root.addEventListener('click',event => {
    if (!event.detail || performance.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClickUntil = 0;
  },true);
  root.addEventListener('lostpointercapture',event => {
    if (gesture?.pointer === event.pointerId && !(event.buttons & 1)) clear();
  });

  async function handleNative({type,paths,position}) {
    if (dragged || busy || outgoing) return;
    if (type === 'leave') { clear(); return; }
    if (type === 'enter') nativePaths = paths || [];
    if (!position) return;
    const ratio = window.devicePixelRatio || 1;
    const hit = document.elementFromPoint(position.x / ratio,position.y / ratio);
    if (type === 'drop') {
      const incoming = paths || nativePaths;
      await drop(incoming,describe(hit,incoming,null));
    } else if (type === 'enter' || type === 'over') {
      show(describe(hit,nativePaths,null));
    }
  }

  return {clear,handleNative};
}
