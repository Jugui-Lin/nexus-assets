import {createWhiteboardImages, isWhiteboardImage} from './whiteboard-images.js';
import {normalizeImageTransform, normalizeImageRotation, resizeImage, imageLocalPoint,
  imageBounds, cropImage, resetImageCrop, snapBoardMove} from './whiteboard-image-transform.js';
import {boardHistoryEntry, boardHistoryOperations} from './whiteboard-history.js';
import {parseWhiteboardAssetClipboard} from './whiteboard-asset-clipboard.js';
import {groupSelected, ungroupSelected, extendGroupSelection, alignSelection, canAlignSelection} from './whiteboard-arrange.js';
import {boardPorts, isBoardConnectable, boardPortPoint, nearestBoardPort} from './whiteboard-connections.js';
import {strokeCurve} from './whiteboard-stroke.js';

const storageKey = 'nexus-whiteboard-v1:';
const clipboardType = 'application/x-nexus-whiteboard+json';
const webClipboardType = 'web ' + clipboardType;
const outboxKey = 'nexus-whiteboard-outbox-v1:';
const colors = {yellow:'黄色', mint:'薄荷绿', sky:'天蓝色', rose:'玫瑰色', violet:'紫色', slate:'灰色'};
const kinds = {note:'便签', text:'文字', rect:'矩形', ellipse:'椭圆', stroke:'画笔', arrow:'连接线', frame:'画框', image:'图片'};
const tools = {select:['选择','V','locate'], pan:['平移','H','arrow'], note:['便签','N','notes'],
  text:['文字','T','list'], rect:['矩形','R','grid'], ellipse:['椭圆','O','eye'],
  arrow:['连接线','L','arrow'], frame:['画框','F','expand'], stroke:['画笔','P','edit'], eraser:['橡皮擦','E','trash']};
const limits = {items:500, text:2048, points:768, batch:16, history:80};
const svgNS = 'http://www.w3.org/2000/svg';
const resizeCorners = {nw:[-1,-1,'左上'],ne:[1,-1,'右上'],sw:[-1,1,'左下'],se:[1,1,'右下']};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const coordinate = value => Math.round(clamp(value, -1_000_000, 1_000_000) * 10) / 10;
const length = value => Math.round(clamp(value, 1, 100_000) * 10) / 10;
const itemBounds = item => item.kind === 'image' ? imageBounds(item)
  : {left:item.x,top:item.y,right:item.x + item.width,bottom:item.y + item.height};
const imageActions = {
  crop:['裁剪','crop','C + 拖动'],
  flipX:['水平翻转','flip-x','Alt+Shift+H'],
  flipY:['垂直翻转','flip-y','Alt+Shift+V'],
  resetCrop:['重置裁剪','crop','Ctrl+Shift+C'],
  resetTransform:['重置变换','refresh','Ctrl+Shift+T'],
};
const alignActions = {
  left:['左对齐','x','start'],right:['右对齐','x','end'],
  top:['顶对齐','y','start'],bottom:['底对齐','y','end'],
  centerX:['水平居中','x','center'],centerY:['垂直居中','y','center'],
};
const alignKeys = {ArrowLeft:'left',ArrowRight:'right',ArrowUp:'top',ArrowDown:'bottom'};
const portNames = {top:'上边',right:'右边',bottom:'下边',left:'左边'};

function fromItems(items) {
  return new Map(items.slice(0, limits.items).filter(item => typeof item?.id === 'string' &&
    Object.hasOwn(kinds, item.kind) && [item.x, item.y, item.width, item.height].every(Number.isFinite) &&
    item.width > 0 && item.height > 0).map(item => [item.id, item]));
}

function applyOperations(base, operations) {
  const items = new Map(base);
  for (const {id, patch, delete:remove} of operations) {
    if (remove) items.delete(id);
    else if (items.has(id) || patch.kind) items.set(id, {...items.get(id), ...patch, id});
  }
  return items;
}

function segmentIntersectsBox(start, end, box) {
  let first = 0;
  let last = 1;
  for (const [axis, low, high] of [[0, box.left, box.right], [1, box.top, box.bottom]]) {
    const delta = end[axis] - start[axis];
    if (!delta) {
      if (start[axis] < low || start[axis] > high) return false;
      continue;
    }
    const from = (low - start[axis]) / delta;
    const to = (high - start[axis]) / delta;
    first = Math.max(first, Math.min(from, to));
    last = Math.min(last, Math.max(from, to));
  }
  return first <= last;
}

function arrowPoints(points) {
  if (points.length !== 2) return points;
  const [start,end] = points;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.hypot(dx, dy);
  if (!distance) return points;
  const size = Math.min(13, distance * .45) / distance;
  const head = direction => [
    end[0] - dx * size - dy * size * .5 * direction,
    end[1] - dy * size + dx * size * .5 * direction,
  ];
  return [start,end,head(1),end,head(-1)];
}

function pathPoints(item) {
  const points = Array.isArray(item.points) ? item.points.slice(0, 1024)
    .filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) : [];
  return item.kind === 'arrow' ? arrowPoints(points) : points;
}

const inkCurves = new WeakMap();

function inkCurve(item) {
  if (!Array.isArray(item.points)) return strokeCurve([]);
  if (!inkCurves.has(item.points)) inkCurves.set(item.points,strokeCurve(pathPoints(item)));
  return inkCurves.get(item.points);
}

function arrowGeometry(start, end) {
  const x = coordinate(Math.min(start.x,end.x) - 16);
  const y = coordinate(Math.min(start.y,end.y) - 16);
  const points = [start,end].map(point => [length(point.x - x),length(point.y - y)]);
  return {x,y,points,width:length(Math.max(...points.map(point => point[0])) + 16),
    height:length(Math.max(...points.map(point => point[1])) + 16)};
}

function overlapsBox(item, bounds) {
  return item.x <= bounds.right && item.y <= bounds.bottom &&
    item.x + item.width >= bounds.left && item.y + item.height >= bounds.top;
}

function intersectsMarquee(item, bounds) {
  if (item.kind === 'image') {
    const image = imageBounds(item);
    return image.left <= bounds.right && image.right >= bounds.left &&
      image.top <= bounds.bottom && image.bottom >= bounds.top;
  }
  if (!overlapsBox(item, bounds)) return false;
  if (item.kind === 'frame') {
    return item.x >= bounds.left && item.y >= bounds.top &&
      item.x + item.width <= bounds.right && item.y + item.height <= bounds.bottom;
  }
  if (item.kind !== 'stroke' && item.kind !== 'arrow') return true;
  // Stroke coordinates are local to the item. Test the path, including its visible width.
  const box = {left:bounds.left - item.x - 1.5, right:bounds.right - item.x + 1.5,
    top:bounds.top - item.y - 1.5, bottom:bounds.bottom - item.y + 1.5};
  let prior;
  const path = item.kind === 'stroke' ? inkCurve(item).points : pathPoints(item);
  for (const point of path) {
    if (segmentIntersectsBox(prior || point, point, box)) return true;
    prior = point;
  }
  return false;
}

function pointSegmentDistanceSquared([x,y], [ax,ay], [bx,by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const squareLength = dx * dx + dy * dy;
  const t = squareLength ? clamp(((x - ax) * dx + (y - ay) * dy) / squareLength, 0, 1) : 0;
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
}

function segmentsNear(a, b, c, d, radiusSquared) {
  const abX = b[0] - a[0];
  const abY = b[1] - a[1];
  const cdX = d[0] - c[0];
  const cdY = d[1] - c[1];
  const acX = c[0] - a[0];
  const acY = c[1] - a[1];
  const determinant = abX * cdY - abY * cdX;
  if (determinant) {
    const t = (acX * cdY - acY * cdX) / determinant;
    const u = (acX * abY - acY * abX) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
  }
  return Math.min(pointSegmentDistanceSquared(a,c,d), pointSegmentDistanceSquared(b,c,d),
    pointSegmentDistanceSquared(c,a,b), pointSegmentDistanceSquared(d,a,b)) <= radiusSquared;
}

function loadPersonal(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey + key));
    if (Array.isArray(saved?.items)) return fromItems(saved.items);
  } catch {}
  return new Map();
}

function loadOutbox(key, teamId) {
  try {
    const saved = JSON.parse(localStorage.getItem(outboxKey + key));
    if (saved?.teamId === teamId && Array.isArray(saved.queue)) {
      const {queue, batchId, operationCount} = saved;
      if (!queue.every(op => typeof op?.id === 'string' && (op.delete === true ||
        (op.patch && typeof op.patch === 'object' && !Array.isArray(op.patch))))) {
        return {queue:[],storageError:true};
      }
      const batch = typeof batchId === 'string' && Number.isInteger(operationCount) &&
        operationCount > 0 && operationCount <= Math.min(queue.length, limits.batch)
        ? {batchId, operations:queue.slice(0, operationCount)} : undefined;
      return {queue,batch};
    }
  } catch { return {queue:[],storageError:true}; }
  return {queue:[]};
}

export function initWhiteboard({panel, api, notify = () => {}, resolveAssetImage = async () => null}) {
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  panel.innerHTML = `<div class="whiteboard-shell">
    <div class="whiteboard-stage" tabindex="0" role="region" aria-label="白板画布">
      <div class="whiteboard-plane"><div class="whiteboard-group-outline" aria-hidden="true" hidden></div></div>
      <div class="whiteboard-marquee" aria-hidden="true" hidden></div>
      <p class="whiteboard-empty" hidden>粘贴图片，或选择工具开始</p>
    </div>
    <div class="whiteboard-tools" role="toolbar" aria-label="白板工具">${Object.entries(tools).map(([id,[label,key,glyph]]) =>
      `<button type="button" data-board-tool="${id}" aria-pressed="false" title="${label}（${key}）" aria-keyshortcuts="${key}">${icon(glyph)}<span>${label}</span></button>`).join('')}
      <button type="button" data-board-add-image>${icon('picture')}<span>图片</span></button>
      <input type="file" data-board-image-picker accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    </div>
    <div class="whiteboard-palette" role="toolbar" aria-label="所选元素操作">
      <div class="whiteboard-color-actions">${Object.entries(colors).map(([id,label]) =>
        `<button type="button" data-board-color="${id}" aria-pressed="false" aria-label="${label}" title="${label}"></button>`).join('')}</div>
      <div class="whiteboard-image-actions" hidden>${['crop','flipX','flipY'].map(id => {
        const [label,glyph,key] = imageActions[id];
        return `<button type="button" data-board-image-action="${id}" aria-label="${label}" title="${label}（${key}）">${icon(glyph)}</button>`;
      }).join('')}</div>
      <div class="whiteboard-arrange" hidden>
        <button type="button" data-board-arrange="group" title="成组（Ctrl+G）" aria-keyshortcuts="Control+G Meta+G">${icon('stack')}成组</button>
        <button type="button" data-board-arrange="ungroup" title="解组（Ctrl+Shift+G）" aria-keyshortcuts="Control+Shift+G Meta+Shift+G">解组</button>
        <details class="whiteboard-align">
          <summary>对齐${icon('chevron')}</summary>
          <div class="whiteboard-align-options">${Object.entries(alignActions).map(([id,[label]]) =>
            `<button type="button" data-board-arrange="${id}">${label}</button>`).join('')}</div>
        </details>
      </div>
      <button type="button" class="whiteboard-delete" title="删除所选项（Delete）" aria-label="删除所选项" disabled>${icon('trash')}</button>
    </div>
    <div class="whiteboard-sync"><span role="status"></span><button type="button" hidden>重试</button></div>
    <div class="whiteboard-view" role="toolbar" aria-label="视图缩放">
      <button type="button" data-board-view="out" title="缩小" aria-label="缩小">−</button>
      <button type="button" data-board-view="reset" title="恢复 100% 缩放">100%</button>
      <button type="button" data-board-view="in" title="放大" aria-label="放大">+</button>
      <button type="button" data-board-view="fit" title="适应全部内容" aria-label="适应全部内容">${icon('expand')}</button>
    </div>
    <div class="whiteboard-history" role="toolbar" aria-label="编辑历史">
      <button type="button" data-board-history="undo" title="撤销（Ctrl+Z）" aria-label="撤销" aria-keyshortcuts="Control+Z Meta+Z" disabled>${icon('undo')}</button>
      <button type="button" data-board-history="redo" title="重做（Ctrl+Shift+Z）" aria-label="重做" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" disabled>${icon('redo')}</button>
    </div>
    <p class="whiteboard-crop-hint" role="status" hidden>拖出保留区域 · Esc 退出</p>
    <p class="whiteboard-link-hint" role="status" hidden>点击要连接的元素 · Esc 取消</p>
  </div>`;
  const get = selector => panel.querySelector(selector);
  const stage = get('.whiteboard-stage');
  const plane = get('.whiteboard-plane');
  const marquee = get('.whiteboard-marquee');
  const empty = get('.whiteboard-empty');
  const status = get('.whiteboard-sync span');
  const retry = get('.whiteboard-sync button');
  const deleteButton = get('.whiteboard-delete');
  const imagePicker = get('[data-board-image-picker]');
  const undoButton = get('[data-board-history="undo"]');
  const redoButton = get('[data-board-history="redo"]');
  const imageTools = get('.whiteboard-image-actions');
  const colorTools = get('.whiteboard-color-actions');
  const cropHint = get('.whiteboard-crop-hint');
  const groupOutline = get('.whiteboard-group-outline');
  const linkHint = get('.whiteboard-link-hint');
  const arrangeTools = get('.whiteboard-arrange');
  const alignMenu = get('.whiteboard-align');
  const groupButton = get('[data-board-arrange="group"]');
  const ungroupButton = get('[data-board-arrange="ungroup"]');
  const media = createWhiteboardImages({api});
  const states = new Map();
  const nodes = new Map();
  let scope;
  let visible = false;
  let tool = 'select';
  let activeColor = 'yellow';
  let selected = new Set();
  let gesture;
  let editing;
  let cropMode = false;
  let cropKey = false;
  let cropAdjustKey = false;
  let zoomKey = false;
  let spaceDown = false;
  let focusedImage;
  let beforeFocus;
  let pointerPosition;
  let localClipboard;
  let linkStart;
  const preparedAssets = new Map();

  function orderedItems(state, board) {
    for (const id of board.keys()) {
      if (!state.order.has(id)) state.order.set(id,state.nextOrder++);
    }
    return new Map([...board].sort(([left],[right]) => state.order.get(left) - state.order.get(right)));
  }

  const items = () => scope ? orderedItems(scope, applyOperations(scope.base, scope.queue)) : new Map();
  const current = id => items().get(id);
  const canTransformImages = () => Boolean(scope && (!scope.teamId || scope.imageTransforms));
  const canUseAssetReferences = () => Boolean(scope && (!scope.teamId || scope.assetReferences));
  const canUseGroups = () => Boolean(scope && (!scope.teamId || scope.groups));
  const canUseConnections = () => Boolean(scope && (!scope.teamId || scope.connections));

  function showSync() {
    let text = !scope ? '' : !scope.teamId ? '本机白板'
      : scope.error ? (scope.queue.length ? '白板离线 · 更改待同步' : '团队白板暂未同步')
      : scope.queue.length ? '正在同步更改…' : scope.loaded ? '团队白板 · 已同步' : '正在加载团队白板…';
    if (scope?.error && /白板.*(?:过大|容量上限|无效|超出范围|已经用于)|^团队服务返回错误 (?:404|405|501)\b/.test(scope.error)) {
      text = scope.error.includes('团队服务返回错误') ? '团队服务需要更新以启用白板' : scope.error;
    }
    if (scope?.storageError) text += ' · 本机保存不可用';
    if (status.textContent !== text) status.textContent = text;
    status.title = scope?.error || '';
    retry.hidden = !scope?.error;
  }

  function savePersonal(state) {
    try { localStorage.setItem(storageKey + state.key, JSON.stringify({items:[...state.base.values()]})); }
    catch { notify('本机白板暂时无法保存。', true); }
  }

  function saveOutbox(state) {
    try {
      if (state.queue.length) localStorage.setItem(outboxKey + state.key, JSON.stringify({
        teamId:state.teamId, queue:state.queue, batchId:state.batch?.batchId,
        operationCount:state.batch?.operations.length,
      }));
      else localStorage.removeItem(outboxKey + state.key);
      state.storageError = false;
    } catch {
      if (!state.storageError) notify('团队白板更改暂时无法保存在本机。', true);
      state.storageError = true;
    }
  }

  async function sync(state = scope) {
    if (!state?.teamId || state.busy || state.workspaceKey !== scope?.workspaceKey ||
      ((!visible || state !== scope) && !state.queue.length)) return;
    state.busy = true;
    if (!state.batch && state.queue.length) {
      state.batch = {batchId:crypto.randomUUID(), operations:state.queue.slice(0, limits.batch)};
      saveOutbox(state);
      if (visible && state === scope) showSync();
    }
    const batch = state.batch;
    const target = state.projectId && state.projectId !== 'default'
      ? {teamId:state.teamId,projectId:state.projectId} : {teamId:state.teamId};
    try {
      if (batch) {
        const references = new Set(batch.operations.map(operation => operation.patch?.imageId).filter(Boolean));
        for (const item of state.base.values()) references.delete(item.imageId);
        for (const id of references) await media.ensureUploaded(state, id);
        if (state.workspaceKey !== scope?.workspaceKey) return;
      }
      const snapshot = batch
        ? await api('team_whiteboard_apply', {...target, ...batch})
        : await api('team_whiteboard_get', target);
      if (!Array.isArray(snapshot?.items) || !Number.isSafeInteger(snapshot.revision)) throw Error('团队白板返回了无效数据。');
      state.base = fromItems(snapshot.items);
      state.imageTransforms = snapshot.imageTransforms === true;
      state.assetReferences = snapshot.assetReferences === true;
      state.restoreItems = snapshot.restoreItems === true;
      state.groups = snapshot.groups === true;
      state.connections = snapshot.connections === true;
      if (batch) {
        state.queue.splice(0, batch.operations.length);
        state.batch = undefined;
        saveOutbox(state);
      }
      state.loaded = true;
      state.error = '';
    } catch (failure) {
      state.error = String(failure?.message || failure || '无法连接团队白板').slice(0, 180);
    } finally {
      state.busy = false;
      if (scope === state && visible) render();
      if (!state.error && state.queue.length) sync(state);
    }
  }

  function applyChanges(operations, next) {
    if (scope.teamId) {
      scope.queue.push(...operations);
      saveOutbox(scope);
    } else {
      scope.base = orderedItems(scope,next);
      savePersonal(scope);
    }
    render();
    if (!scope.error) sync();
  }

  function commit(...operations) {
    if (!scope || !operations.length) return;
    const before = items();
    const next = applyOperations(before, operations);
    const entry = boardHistoryEntry(before, next, operations);
    if (!entry.length) { render(); return; }
    scope.undo.push(entry);
    if (scope.undo.length > limits.history) scope.undo.shift();
    scope.redo.length = 0;
    applyChanges(operations, next);
  }

  function changeHistory(direction) {
    if (!scope) return;
    endGesture();
    const stack = scope[direction];
    const entry = stack.at(-1);
    if (!entry) return;
    const board = items();
    const {operations,applied} = boardHistoryOperations(entry, board, direction);
    if (!canTransformImages() && operations.some(operation => operation.patch?.imageTransform)) {
      notify('请更新团队服务后修改图片。', true);
      return;
    }
    if (!canUseAssetReferences() && operations.some(operation => operation.patch?.assetId)) {
      notify('请更新团队服务后恢复资产引用。', true);
      return;
    }
    if (operations.some(({patch}) => patch &&
      ((!canUseGroups() && patch.groupId !== undefined) || (!canUseConnections() && patch.connection)))) {
      notify('请更新团队服务后恢复组合或连线。', true);
      return;
    }
    if (applyOperations(board, operations).size > limits.items) {
      notify('白板最多可添加 500 个项目。', true);
      return;
    }
    stack.pop();
    if (applied.length < entry.length) notify('有些元素已在其他设备上改动。', true);
    if (operations.length) {
      // Team deletions leave tombstones. Legacy servers need a new ID to recover an item.
      for (const operation of operations) {
        if (!scope.teamId || !operation.patch?.kind || board.has(operation.id)) continue;
        if (scope.restoreItems) {
          operation.restore = true;
          continue;
        }
        const original = operation.id;
        operation.id = crypto.randomUUID();
        scope.order.set(operation.id,scope.order.get(original) ?? scope.nextOrder++);
        for (const group of [...scope.undo,...scope.redo,applied]) {
          for (const change of group) {
            if (change.id === original) change.id = operation.id;
          }
        }
        if (selected.delete(original)) selected.add(operation.id);
      }
      scope[direction === 'undo' ? 'redo' : 'undo'].push(applied);
      applyChanges(operations, applyOperations(board, operations));
    } else renderSelection(board);
  }

  function itemContent(node, item) {
    releaseImage(node);
    if (item.kind === 'image') {
      renderImage(node, item);
    } else if (item.kind === 'frame') {
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'whiteboard-frame-border');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      const box = document.createElementNS(svgNS, 'rect');
      box.setAttribute('width', '100');
      box.setAttribute('height', '100');
      box.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(box);
      const caption = document.createElement('span');
      caption.className = 'whiteboard-frame-title';
      caption.textContent = item.text || '画框';
      node.replaceChildren(svg, caption);
    } else if (item.kind === 'stroke' || item.kind === 'arrow') {
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${item.width} ${item.height}`);
      svg.setAttribute('aria-hidden', 'true');
      const stroke = item.kind === 'stroke';
      const line = document.createElementNS(svgNS, stroke ? 'path' : 'polyline');
      if (stroke) {
        line.setAttribute('class','whiteboard-ink-path');
        line.setAttribute('d',inkCurve(item).path);
      } else line.setAttribute('points', pathPoints(item).map(point => point.join(',')).join(' '));
      const hitArea = line.cloneNode();
      hitArea.setAttribute('class', 'whiteboard-stroke-hit');
      hitArea.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(hitArea, line);
      node.replaceChildren(svg);
    } else node.textContent = item.kind === 'note' || item.kind === 'text' ? item.text || '' : '';
  }

  function releaseImage(node) {
    if (node.whiteboardImageUrl) URL.revokeObjectURL(node.whiteboardImageUrl);
    node.whiteboardImageUrl = null;
    const video = node.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  function attachReferenceVideo(node, clip, image, asset, active) {
    const video = document.createElement('video');
    video.className = 'whiteboard-image';
    video.playsInline = true;
    video.preload = 'none';
    video.hidden = true;
    if (asset.poster) image.src = asset.poster;
    else image.hidden = true;
    clip.append(video);
    const play = document.createElement('button');
    play.type = 'button';
    play.dataset.boardPlayVideo = '';
    const setPlaying = running => {
      play.toggleAttribute('data-playing', running);
      play.innerHTML = icon(running ? 'media-pause' : 'media-play');
      play.title = running ? '暂停引用视频' : '播放引用视频';
      play.setAttribute('aria-label', play.title);
    };
    setPlaying(false);
    video.addEventListener('play', () => setPlaying(true));
    video.addEventListener('pause', () => setPlaying(false));
    video.addEventListener('ended', () => setPlaying(false));
    play.addEventListener('click', async () => {
      if (!video.paused) { video.pause(); return; }
      play.disabled = true;
      try {
        if (video.ended && video.src) video.currentTime = 0;
        if (!video.hasAttribute('src')) {
          const source = await asset.playback();
          if (!active() || !visible) return;
          for (const url of [source?.url, source?.fallbackUrl].filter(Boolean)) {
            video.src = url;
            try { await video.play(); break; } catch {}
            if (!active() || !visible) return;
          }
          if (video.paused) throw Error('视频暂时无法播放');
          video.hidden = false;
          image.hidden = true;
        } else await video.play();
      } catch {
        video.removeAttribute('src');
        video.load();
        video.hidden = true;
        image.hidden = !asset.poster;
        if (active() && visible) notify('引用的视频暂时无法播放。', true);
      } finally { play.disabled = false; }
    });
    node.append(play);
  }

  function renderImage(node, item) {
    const target = scope;
    node.whiteboardAssetReference = Boolean(item.assetId);
    const clip = document.createElement('div');
    clip.className = 'whiteboard-image-clip';
    const image = document.createElement('img');
    image.className = 'whiteboard-image';
    image.alt = item.text || '白板图片';
    image.draggable = false;
    const crop = document.createElement('div');
    crop.className = 'whiteboard-crop-box';
    crop.hidden = true;
    crop.setAttribute('aria-hidden','true');
    clip.append(image);
    node.replaceChildren(clip, crop);
    const active = () => scope === target && clip.parentElement === node && node.isConnected;
    if (item.assetId) {
      const prepared = preparedAssets.get(item.id);
      preparedAssets.delete(item.id);
      Promise.resolve(prepared || resolveAssetImage(item.assetId,target.workspaceKey)).then(asset => {
        if (!active()) return;
        if (asset?.kind === 'video') attachReferenceVideo(node,clip,image,asset,active);
        else if (asset?.url) image.src = asset.url;
        else throw Error('资产暂时无法读取');
        node.title = (asset.name || item.text || '资产') + ' · 资产库引用';
      }).catch(() => {
        if (!active()) return;
        image.hidden = true;
        const fallback = document.createElement('span');
        fallback.className = 'whiteboard-reference-missing';
        fallback.textContent = item.text ? item.text + ' · 引用暂不可用' : '资产引用暂不可用';
        node.append(fallback);
        node.title = fallback.textContent;
      });
      return;
    }
    media.url(target, item.imageId).then(url => {
      if (!active()) {
        URL.revokeObjectURL(url);
        return;
      }
      node.whiteboardImageUrl = url;
      image.src = url;
    }).catch(() => {
      if (!active()) return;
      image.alt = '图片暂时无法读取';
      node.whiteboardContent = null;
    });
  }

  function place(node, item) {
    node.style.left = item.x + 'px';
    node.style.top = item.y + 'px';
    node.style.width = item.width + 'px';
    node.style.height = item.height + 'px';
    node.dataset.color = Object.hasOwn(colors, item.color) ? item.color : 'slate';
    if (item.kind === 'image') {
      const {rotation, flipX, flipY, opacity, crop:[left,top,right,bottom]} = normalizeImageTransform(item.imageTransform);
      const width = right - left;
      const height = bottom - top;
      node.style.transform = rotation ? `rotate(${rotation}deg)` : '';
      node.style.setProperty('--image-flip', `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`);
      node.style.setProperty('--image-opacity', opacity);
      node.style.setProperty('--image-width', 100 / width + '%');
      node.style.setProperty('--image-height', 100 / height + '%');
      node.style.setProperty('--image-left', -100 * left / width + '%');
      node.style.setProperty('--image-top', -100 * top / height + '%');
    }
  }

  function render() {
    const board = items();
    for (const [id, node] of nodes) {
      if (board.has(id)) continue;
      if (editing?.id === id) editing = undefined;
      releaseImage(node);
      node.remove();
      nodes.delete(id);
    }
    let previous;
    for (const [id, item] of board) {
      let node = nodes.get(id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'whiteboard-item';
        node.dataset.boardId = id;
        node.dataset.kind = item.kind;
        node.setAttribute('role', 'group');
        node.setAttribute('aria-label', kinds[item.kind]);
        nodes.set(id, node);
        if (previous) previous.after(node);
        else plane.prepend(node);
      }
      previous = node;
      node.toggleAttribute('data-board-connected',Boolean(item.connection));
      if (item.connection) continue;
      place(node, presentedItem(item));
      const signature = item.kind === 'image' ? JSON.stringify([item.imageId, item.assetId, item.text])
        : item.kind === 'stroke' || item.kind === 'arrow' ? JSON.stringify([item.width, item.height, item.points]) : item.text || '';
      if (editing?.id !== id && signature !== node.whiteboardContent) {
        node.whiteboardContent = signature;
        itemContent(node, item);
      }
      if (item.kind === 'image') drawCropBox(node, gesture?.id === id ? gesture.region : null);
    }
    renderConnections(board);
    empty.hidden = board.size > 0 || Boolean(gesture?.preview) || !scope?.loaded;
    renderSelection(board);
    showSync();
  }

  function renderSelection(board = items()) {
    selected = extendGroupSelection(board,selected);
    const canAlign = canAlignSelection(board,selected);
    const hasGroup = [...selected].some(id => board.get(id).groupId);
    arrangeTools.hidden = !canAlign && !hasGroup;
    groupButton.hidden = !canAlign || !canUseGroups();
    ungroupButton.hidden = !hasGroup || !canUseGroups();
    alignMenu.hidden = !canAlign;
    if (alignMenu.hidden) alignMenu.open = false;
    undoButton.disabled = !scope?.undo.length;
    redoButton.disabled = !scope?.redo.length;
    const imageOnly = selected.size > 0 && [...selected].every(id => board.get(id).kind === 'image');
    imageTools.hidden = !imageOnly;
    colorTools.hidden = imageOnly;
    for (const button of imageTools.children) {
      button.disabled = !canTransformImages() || (button.dataset.boardImageAction === 'crop' && selected.size !== 1);
    }
    imageTools.firstElementChild.setAttribute('aria-pressed', String(cropMode));
    cropHint.hidden = !cropMode;
    stage.classList.toggle('is-cropping', cropMode || cropKey);
    const canResize = tool === 'select' && !cropMode && !cropKey && selected.size === 1;
    updateGroupOutline(board);
    for (const [id, node] of nodes) {
      node.classList.toggle('is-selected', selected.has(id));
      updateConnectionPorts(node,board.get(id));
      const handles = node.querySelector('.whiteboard-resize-handles');
      if (!(canResize && selected.has(id) && board.get(id)?.kind === 'image')) {
        handles?.remove();
        continue;
      }
      if (handles?.dataset.rotateEnabled === String(canTransformImages())) continue;
      handles?.remove();
      const wrapper = document.createElement('div');
      wrapper.className = 'whiteboard-resize-handles';
      wrapper.dataset.rotateEnabled = String(canTransformImages());
      for (const [corner, [,,label]] of Object.entries(resizeCorners)) {
        if (canTransformImages()) {
          const rotate = document.createElement('span');
          rotate.dataset.boardRotate = corner;
          rotate.title = '拖动旋转 · Shift 吸附到 45°';
          rotate.setAttribute('aria-hidden','true');
          wrapper.append(rotate);
        }
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.dataset.boardResize = corner;
        handle.setAttribute('aria-label', '调整图片尺寸 · ' + label);
        handle.title = canTransformImages() ? '拖动缩放 · 从角外拖动旋转' : '拖动缩放';
        handle.addEventListener('keydown', event => {
          const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
          const dy = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
          const item = current(id);
          if (!(dx || dy) || !item || event.altKey) return;
          if (event.ctrlKey || event.metaKey) {
            if (!dx || !canTransformImages()) return;
            event.preventDefault();
            const imageTransform = normalizeImageTransform(item.imageTransform);
            imageTransform.rotation = normalizeImageRotation(imageTransform.rotation + dx * (event.shiftKey ? 45 : 5));
            commit({id,patch:{imageTransform}});
            return;
          }
          event.preventDefault();
          const step = (event.shiftKey ? 10 : 2) / scope.view.zoom;
          commit({id,patch:resizeImage(item, corner, dx * step, dy * step)});
        });
        wrapper.append(handle);
      }
      node.append(wrapper);
    }
    deleteButton.disabled = !selected.size;
    const colors = new Set([...selected].map(id => board.get(id).color));
    const active = selected.size ? (colors.size === 1 ? colors.values().next().value : null) : activeColor;
    for (const button of panel.querySelectorAll('[data-board-color]')) {
      button.setAttribute('aria-pressed', String(button.dataset.boardColor === active));
    }
  }

  function arrangeSelection(action) {
    const board = items();
    const align = alignActions[action];
    let operations;
    if (align) operations = alignSelection(board,selected,align[1],align[2]);
    else {
      if (!canUseGroups()) { notify('请更新团队服务后使用组合。', true); return; }
      operations = action === 'group' ? groupSelected(board,selected,crypto.randomUUID())
        : ungroupSelected(board,selected);
    }
    alignMenu.open = false;
    commit(...operations);
    stage.focus({preventScroll:true});
  }

  function presentedItem(item) {
    const position = gesture?.mode === 'move' ? gesture.positions.get(item.id)
      : gesture?.id === item.id ? gesture.position : null;
    return position ? {...item,...position} : item;
  }

  function unionBounds(elements) {
    const boxes = elements.map(itemBounds);
    return {left:Math.min(...boxes.map(box => box.left)),right:Math.max(...boxes.map(box => box.right)),
      top:Math.min(...boxes.map(box => box.top)),bottom:Math.max(...boxes.map(box => box.bottom))};
  }

  function updateGroupOutline(board) {
    const entries = [...selected].map(id => board.get(id)).filter(Boolean);
    const group = entries[0]?.groupId;
    groupOutline.hidden = !group || entries.length < 2 || !entries.every(item => item.groupId === group);
    if (groupOutline.hidden) return;
    const box = unionBounds(entries.map(presentedItem));
    groupOutline.style.left = box.left + 'px';
    groupOutline.style.top = box.top + 'px';
    groupOutline.style.width = box.right - box.left + 'px';
    groupOutline.style.height = box.bottom - box.top + 'px';
  }

  function visibleConnector(item, board) {
    const from = item.connection?.from;
    const to = item.connection?.to;
    const source = board.get(from?.id);
    const target = board.get(to?.id);
    const start = source && boardPortPoint(presentedItem(source),from.side);
    const end = target && boardPortPoint(presentedItem(target),to.side);
    return start && end ? {...item,...arrowGeometry(start,end)} : item;
  }

  function renderConnections(board) {
    for (const [id,item] of board) {
      if (!item.connection) continue;
      const node = nodes.get(id);
      if (!node) continue;
      const arrow = visibleConnector(item,board);
      place(node,arrow);
      const signature = JSON.stringify([arrow.width,arrow.height,arrow.points]);
      if (signature !== node.whiteboardContent) {
        node.whiteboardContent = signature;
        itemContent(node,arrow);
      }
    }
  }

  function setLinkStart(value) {
    linkStart = value;
    linkHint.hidden = !value;
    stage.classList.toggle('is-linking',Boolean(value));
    for (const [id,node] of nodes) {
      for (const port of node.querySelectorAll('[data-board-port]')) port.tabIndex = value || selected.has(id) ? 0 : -1;
    }
  }

  function updateConnectionPorts(node, item) {
    const existing = node.querySelector('.whiteboard-connection-ports');
    if (!canUseConnections() || tool !== 'select' || cropMode || cropKey ||
        !isBoardConnectable(item) || editing?.id === item.id) {
      existing?.remove();
      return;
    }
    const tabIndex = linkStart || selected.has(item.id) ? 0 : -1;
    if (existing) {
      for (const port of existing.children) port.tabIndex = tabIndex;
      return;
    }
    const ports = document.createElement('div');
    ports.className = 'whiteboard-connection-ports';
    for (const side of Object.keys(boardPorts)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = tabIndex;
      button.dataset.boardPort = side;
      button.title = '从' + portNames[side] + '连接';
      button.setAttribute('aria-label', button.title);
      button.innerHTML = icon('plus');
      ports.append(button);
    }
    node.append(ports);
  }

  function connectionTarget(event, from, point) {
    const node = document.elementFromPoint(event.clientX,event.clientY);
    const id = node?.closest('[data-board-id]')?.dataset.boardId;
    const item = id && current(id);
    if (id === from.id || !isBoardConnectable(item)) return null;
    const side = node.closest('[data-board-port]')?.dataset.boardPort || nearestBoardPort(item,point);
    return {id,side};
  }

  function connectItems(from,to) {
    if (!canUseConnections() || !to || from.id === to.id) return;
    const board = items();
    const start = boardPortPoint(board.get(from.id),from.side);
    const end = boardPortPoint(board.get(to.id),to.side);
    if (!start || !end) return;
    // Clicking an edge is also supported so keyboard users can choose both endpoints.
    add({kind:'arrow',...arrowGeometry(start,end),color:activeColor,connection:{from,to}});
  }

  function previewConnection(drag, event, point) {
    if (!drag.active && Math.hypot(point.x - drag.start.x,point.y - drag.start.y) * scope.view.zoom < 4) return;
    drag.active = true;
    const target = connectionTarget(event,drag.from,point);
    const end = target ? boardPortPoint(current(target.id),target.side) || point : point;
    const arrow = {kind:'arrow',...arrowGeometry(drag.start,end),color:activeColor};
    place(drag.preview,arrow);
    itemContent(drag.preview,arrow);
    drag.preview.hidden = false;
    drag.to = target;
  }

  function paintView() {
    if (!scope) return;
    const {x,y,zoom} = scope.view;
    plane.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    plane.style.setProperty('--board-control-scale', Math.min(1, 1 / zoom));
    stage.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
    stage.style.backgroundPosition = `${x}px ${y}px`;
    get('[data-board-view="reset"]').textContent = Math.round(zoom * 100) + '%';
  }

  function world(clientX, clientY) {
    const bounds = stage.getBoundingClientRect();
    const {x,y,zoom} = scope.view;
    return {x:(clientX - bounds.left - x) / zoom,y:(clientY - bounds.top - y) / zoom};
  }

  function insertionPoint(position = pointerPosition) {
    const {left, top, width, height} = stage.getBoundingClientRect();
    const inside = position && position.x >= left && position.x <= left + width &&
      position.y >= top && position.y <= top + height;
    return inside ? world(position.x, position.y) : world(left + width / 2, top + height / 2);
  }

  function insertItems(entries, assets, itemIds = []) {
    const available = limits.items - items().size;
    if (entries.length > available) notify('白板最多可添加 500 个项目。', true);
    const operations = entries.slice(0, available).map((patch,index) => ({id:itemIds[index] || crypto.randomUUID(),patch}));
    if (!operations.length) return false;
    setTool('select');
    selected = new Set(operations.map(operation => operation.id));
    for (const {id,patch} of operations) {
      const asset = assets?.get(patch.assetId);
      if (asset) preparedAssets.set(id, asset);
    }
    commit(...operations);
    stage.focus({preventScroll:true});
    return true;
  }

  async function insertImages(files, point) {
    if (!visible || !scope) return;
    const target = scope;
    const origin = point || insertionPoint();
    const entries = [];
    let skipped = 0;
    let imageFailure;
    for await (const file of files) {
      if (target !== scope || !visible) return;
      if (!isWhiteboardImage(file)) { skipped++; continue; }
      const room = limits.items - items().size;
      if (entries.length >= room) { notify('白板最多可添加 500 个项目。', true); break; }
      try {
        const {id, width, height} = await media.prepare(target, file);
        const scale = Math.min(1, 680 / width, 480 / height);
        const offset = entries.length * 32;
        entries.push({kind:'image',imageId:id,text:(file.name || '').slice(0,limits.text),
          x:coordinate(origin.x + offset),y:coordinate(origin.y + offset),
          width:length(width * scale),height:length(height * scale)});
      } catch (failure) {
        skipped++;
        imageFailure ||= String(failure?.message || failure || '无法读取图片');
      }
    }
    if (target !== scope || !visible) return;
    if (skipped && entries.length) notify('有 ' + skipped + ' 张图片无法添加', true);
    else if (skipped && !entries.length) notify(imageFailure || '请选择可读取的 PNG、JPEG、GIF 或 WebP 图片。', true);
    insertItems(entries);
  }

  async function* nativeImages(paths) {
    for (const path of paths) {
      try {
        const {name,mime,base64} = await api('read_whiteboard_image_file', {path});
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        yield new File([bytes], name, {type:mime});
      } catch {
        yield null;
      }
    }
  }

  async function insertAssetReferences(references, point) {
    const target = scope;
    if (!target || references.workspaceKey !== target.workspaceKey) {
      notify('请在这组资产所在的库里打开白板后粘贴。', true);
      return;
    }
    if (!canUseAssetReferences()) {
      notify('请确认团队白板已联网，并更新团队服务以粘贴资产引用。', true);
      return;
    }
    const available = limits.items - items().size;
    if (references.assetIds.length > available) notify('白板最多可添加 500 个项目。', true);
    const entries = [];
    const assets = new Map();
    for (const assetId of references.assetIds.slice(0, available)) {
      if (!visible || target !== scope) return;
      const asset = await resolveAssetImage(assetId,target.workspaceKey).catch(() => null);
      if (!asset) continue;
      const image = new Image();
      const source = asset.kind === 'video' ? asset.poster : asset.url;
      if (source) {
        image.src = source;
        try { await image.decode(); } catch {}
      }
      const width = image.naturalWidth || (asset.kind === 'video' ? 480 : 320);
      const height = image.naturalHeight || (asset.kind === 'video' ? 270 : 240);
      const scale = Math.min(1,680 / width,480 / height);
      const offset = entries.length * 32;
      entries.push({kind:'image',assetId,text:(asset.name || '').slice(0,limits.text),
        x:coordinate(point.x + offset),y:coordinate(point.y + offset),
        width:length(width * scale),height:length(height * scale)});
      assets.set(assetId,asset);
    }
    if (!visible || target !== scope) return;
    if (entries.length) insertItems(entries,assets);
    if (entries.length < Math.min(available,references.assetIds.length)) notify('有些资产引用暂时无法读取。', true);
  }

  function duplicateEntries(source, point, sharedImages) {
    let entries = [...fromItems(source).values()].filter(item => {
      if (item.kind === 'image') return sharedImages &&
        (item.assetId ? canUseAssetReferences() && /^(?:team:)?[a-z0-9_-]{1,128}$/i.test(item.assetId)
          : /^[0-9a-f]{64}$/.test(item.imageId));
      if (item.kind !== 'arrow' && item.kind !== 'stroke') return true;
      const points = item.points;
      return Array.isArray(points) && points.length > 0 &&
        (item.kind === 'arrow' ? points.length === 2 : points.length <= 1024) &&
        points.every(pair => Array.isArray(pair) && pair.length === 2 &&
          pair.every(value => Number.isFinite(value) && Math.abs(value) <= 100000));
    });
    if (!entries.length) return false;
    const available = limits.items - items().size;
    if (entries.length > available) {
      notify('白板最多可添加 500 个项目。', true);
      entries = entries.slice(0,available);
    }
    if (!entries.length) return false;
    const left = Math.min(...entries.map(item => item.x));
    const top = Math.min(...entries.map(item => item.y));
    const ids = new Map(entries.map(item => [item.id,crypto.randomUUID()]));
    const groups = new Map();
    for (const item of entries) {
      if (canUseGroups() && item.groupId && !groups.has(item.groupId)) groups.set(item.groupId,crypto.randomUUID());
    }
    function copiedConnection(item) {
      const {from,to} = item.connection || {};
      if (item.kind !== 'arrow' || !canUseConnections() || !ids.has(from?.id) || !ids.has(to?.id) ||
          from.id === to.id || item.id === from.id || item.id === to.id ||
          !Object.hasOwn(boardPorts,from.side) || !Object.hasOwn(boardPorts,to.side)) return {};
      return {connection:{from:{id:ids.get(from.id),side:from.side},to:{id:ids.get(to.id),side:to.side}}};
    }
    return insertItems(entries.map(item => ({
      kind:item.kind, x:coordinate(point.x + item.x - left), y:coordinate(point.y + item.y - top),
      width:length(item.width), height:length(item.height), text:String(item.text || '').slice(0,limits.text),
      color:Object.hasOwn(colors,item.color) ? item.color : 'slate',
      ...((item.kind === 'arrow' || item.kind === 'stroke') && {points:item.points}),
      ...(item.kind === 'image' && (item.assetId ? {assetId:item.assetId} : {imageId:item.imageId})),
      ...(item.kind === 'image' && item.imageTransform && canTransformImages() &&
        {imageTransform:normalizeImageTransform(item.imageTransform)}),
      ...(groups.has(item.groupId) && {groupId:groups.get(item.groupId)}),
      ...copiedConnection(item),
    })),undefined,[...ids.values()]);
  }

  function selectedItems() {
    const board = items();
    return [...selected].map(id => board.get(id)).filter(Boolean)
      .map(item => item.connection ? visibleConnector(item,board) : item);
  }

  function duplicateSelected() {
    const entries = selectedItems();
    if (!entries.length) return;
    duplicateEntries(entries, {x:Math.min(...entries.map(item => item.x)) + 24,
      y:Math.min(...entries.map(item => item.y)) + 24}, true);
  }

  function deleteSelected() {
    const ids = new Set(selected);
    for (const item of items().values()) {
      if (selected.has(item.connection?.from?.id) || selected.has(item.connection?.to?.id)) ids.add(item.id);
    }
    commit(...[...ids].map(id => ({id,delete:true})));
  }

  function copySelected(data) {
    const entries = selectedItems();
    if (!entries.length) return false;
    const text = entries.every(item => ['note','text'].includes(item.kind))
      ? entries.map(item => item.text).join('\n') : 'Nexus 白板 · ' + entries.length + ' 个元素';
    const content = {workspaceKey:scope.workspaceKey,items:entries};
    localClipboard = {content,text};
    const json = JSON.stringify(content);
    if (data) {
      data.setData(clipboardType, json);
      if (text) data.setData('text/plain', text);
    } else if (navigator.clipboard) {
      const copyText = () => navigator.clipboard.writeText(text);
      if (typeof ClipboardItem === 'function' && navigator.clipboard.write) {
        try {
          const entry = new ClipboardItem({
            [webClipboardType]:new Blob([json], {type:clipboardType}),
            'text/plain':new Blob([text], {type:'text/plain'}),
          });
          navigator.clipboard.write([entry]).catch(copyText).catch(() => {});
        } catch { copyText().catch(() => {}); }
      } else copyText().catch(() => {});
    }
    return true;
  }

  async function pasteContents(json, text, point) {
    const target = scope;
    const references = parseWhiteboardAssetClipboard(text);
    if (references && !json) {
      await insertAssetReferences(references, point);
      return;
    }
    let content;
    if (json && json.length < 4 * 1024 * 1024) {
      try { content = JSON.parse(json); } catch {}
    }
    if (!content && localClipboard?.text === text) content = localClipboard.content;
    if (Array.isArray(content?.items)) {
      const sameWorkspace = target.workspaceKey === content.workspaceKey;
      const copied = [...fromItems(content.items).values()];
      if (!sameWorkspace && content.items.some(item => item?.kind === 'image')) {
        notify('图片可在同一个库的项目之间复制。', true);
      }
      const references = new Set(Array.from(items().values(), item => item.imageId));
      if (sameWorkspace) {
        for (const id of new Set(copied.map(item => item.imageId).filter(id => /^[0-9a-f]{64}$/.test(id)))) {
          if (references.has(id)) continue;
          try {
            const url = await media.url(target,id);
            URL.revokeObjectURL(url);
            references.add(id);
          } catch {
            if (target === scope && visible) notify('有一张复制的图片暂时无法读取。', true);
          }
        }
      }
      if (target === scope && visible) {
        duplicateEntries(copied.filter(item => item.kind !== 'image' || item.assetId || references.has(item.imageId)), point, sameWorkspace);
      }
      return;
    }
    const value = (text || '').trim().slice(0,limits.text);
    if (!value) return;
    insertItems([{kind:'text',x:coordinate(point.x),y:coordinate(point.y),width:280,
      height:Math.min(480,Math.max(62,(value.split('\n').length + Math.floor(value.length / 32)) * 22 + 22)),
      text:value,color:activeColor}]);
  }

  async function pasteFromClipboard(point) {
    const target = scope;
    try {
      const entries = await navigator.clipboard.read();
      if (!visible || scope !== target) return;
      const files = [];
      let json = '';
      let text = '';
      for (const item of entries) {
        const imageType = item.types.find(type => /^image\/(png|jpeg|gif|webp)$/.test(type));
        if (imageType) files.push(await item.getType(imageType));
        if (!json && item.types.includes(webClipboardType)) json = await (await item.getType(webClipboardType)).text();
        if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
      if (!visible || scope !== target) return;
      if (files.length) await insertImages(files, point);
      else await pasteContents(json, text, point);
    } catch {
      if (!visible || scope !== target) return;
      if (localClipboard) await pasteContents('', localClipboard.text, point);
      else notify('请在画布按 Ctrl+V 粘贴。', true);
    }
  }

  function boardClipboardEvent(event) {
    const target = event.target;
    return visible && scope && (target === stage || panel.contains(target)) &&
      !target.closest('textarea,input,[contenteditable="true"]') && !document.querySelector('dialog[open]');
  }

  document.addEventListener('paste', event => {
    if (!boardClipboardEvent(event) || !event.clipboardData) return;
    const files = [...event.clipboardData.files].filter(isWhiteboardImage);
    if (!files.length) {
      const image = [...event.clipboardData.items].find(item => item.kind === 'file' && item.type.startsWith('image/'));
      const file = image?.getAsFile();
      if (isWhiteboardImage(file)) files.push(file);
    }
    event.preventDefault();
    const point = insertionPoint();
    if (files.length) insertImages(files, point);
    else pasteContents(event.clipboardData.getData(clipboardType), event.clipboardData.getData('text/plain'), point);
  });
  for (const action of ['copy','cut']) {
    document.addEventListener(action, event => {
      if (!boardClipboardEvent(event) || !copySelected(event.clipboardData)) return;
      event.preventDefault();
      if (action === 'cut') deleteSelected();
    });
  }

  stage.addEventListener('pointermove', event => { pointerPosition = {x:event.clientX,y:event.clientY}; });
  stage.addEventListener('pointerleave', () => { pointerPosition = undefined; });
  stage.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  stage.addEventListener('drop', event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    insertImages([...event.dataTransfer.files], insertionPoint({x:event.clientX,y:event.clientY}));
  });
  imagePicker.addEventListener('change', () => {
    if (imagePicker.files.length) insertImages([...imagePicker.files]);
    imagePicker.value = '';
  });

  function zoomAt(x, y, value) {
    if (!scope) return;
    const view = scope.view;
    const zoom = clamp(value, .2, 3);
    const scale = zoom / view.zoom;
    view.x = x - (x - view.x) * scale;
    view.y = y - (y - view.y) * scale;
    view.zoom = zoom;
    paintView();
  }

  function fitView(board = [...items().values()], maxZoom = 1) {
    if (!scope) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!board.length) scope.view = {x:w/2,y:h/2,zoom:1};
    else {
      const boxes = board.map(itemBounds);
      const left = Math.min(...boxes.map(box => box.left));
      const top = Math.min(...boxes.map(box => box.top));
      const right = Math.max(...boxes.map(box => box.right));
      const bottom = Math.max(...boxes.map(box => box.bottom));
      const zoom = clamp(Math.min((w - 160) / (right - left), (h - 110) / (bottom - top)), .2, maxZoom);
      scope.view = {x:(w - zoom * (left + right)) / 2,y:(h - zoom * (top + bottom)) / 2,zoom};
    }
    paintView();
  }

  function focusImages(entries) {
    beforeFocus ||= {...scope.view};
    focusedImage = entries.length === 1 ? entries[0].id : undefined;
    fitView(entries, 3);
  }

  function toggleImageFocus(entries) {
    if (beforeFocus) {
      scope.view = beforeFocus;
      beforeFocus = focusedImage = undefined;
      paintView();
    } else if (entries.length) focusImages(entries);
    else fitView();
  }

  function stepImage(step) {
    const images = [...items().values()].filter(item => item.kind === 'image');
    const index = images.findIndex(item => item.id === focusedImage);
    const next = images[index + step];
    if (!next || index < 0) return;
    selected = new Set([next.id]);
    renderSelection();
    focusImages([next]);
  }

  function doImageAction(action) {
    const images = selectedItems().filter(item => item.kind === 'image');
    if (!images.length) return;
    if (!canTransformImages()) {
      notify('请更新团队服务后修改图片。', true);
      return;
    }
    if (action === 'crop') {
      if (images.length !== 1) return;
      cropMode = !cropMode;
      setTool('select');
      stage.focus({preventScroll:true});
      return;
    }
    const operations = [];
    for (const item of images) {
      const imageTransform = normalizeImageTransform(item.imageTransform);
      let patch = {imageTransform};
      if (action === 'resetCrop') patch = resetImageCrop(item);
      else if (action === 'resetTransform') {
        Object.assign(imageTransform, {rotation:0, flipX:false, flipY:false});
        const image = nodes.get(item.id)?.querySelector('img');
        if (image?.naturalWidth && image.naturalHeight) {
          const [left,top,right,bottom] = imageTransform.crop;
          const scale = Math.min(1,680 / image.naturalWidth,480 / image.naturalHeight);
          const width = length(image.naturalWidth * scale * (right - left));
          const height = length(image.naturalHeight * scale * (bottom - top));
          Object.assign(patch,{width,height,x:coordinate(item.x + (item.width - width) / 2),
            y:coordinate(item.y + (item.height - height) / 2)});
        }
      } else imageTransform[action] = !imageTransform[action];
      if (patch) operations.push({id:item.id,patch});
    }
    commit(...operations);
    stage.focus({preventScroll:true});
  }

  function setTool(next) {
    if (['stroke','eraser'].includes(next) && next !== tool) {
      if (gesture?.mode === 'marquee') endGesture();
      selected.clear();
    }
    if (next !== 'select') { cropMode = false; cropKey = false; cropAdjustKey = false; }
    if (next !== 'select' && linkStart) setLinkStart(null);
    tool = next;
    stage.dataset.tool = tool;
    for (const button of panel.querySelectorAll('[data-board-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.boardTool === tool));
    }
    renderSelection();
  }

  function stopEditing(save) {
    if (!editing) return;
    const {id,input} = editing;
    editing = undefined;
    const text = input.value;
    const node = nodes.get(id);
    if (node) node.whiteboardContent = undefined;
    const item = current(id);
    if (save && item && text !== (item.text || '')) commit({id,patch:{text}});
    else render();
  }

  function edit(id) {
    const node = nodes.get(id);
    const item = current(id);
    if (!node || !item || !['note','text','frame'].includes(item.kind)) return;
    stopEditing(true);
    selected = new Set([id]);
    renderSelection();
    const inFrame = item.kind === 'frame';
    const input = document.createElement(inFrame ? 'input' : 'textarea');
    input.className = 'whiteboard-editor';
    if (inFrame) input.classList.add('whiteboard-frame-editor');
    input.maxLength = limits.text;
    input.value = item.text || '';
    input.setAttribute('aria-label', '编辑' + kinds[item.kind]);
    editing = {id,input};
    if (inFrame) node.querySelector('.whiteboard-frame-title').replaceWith(input);
    else node.replaceChildren(input);
    input.addEventListener('blur', () => { if (editing?.input === input) stopEditing(true); });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Escape' && !(event.key === 'Enter' && (inFrame || event.ctrlKey || event.metaKey))) return;
      event.preventDefault();
      event.stopPropagation();
      stopEditing(event.key !== 'Escape');
      stage.focus({preventScroll:true});
    });
    input.focus({preventScroll:true});
  }

  function drawItem(drag, point) {
    const {kind,start} = drag;
    if (kind === 'stroke') {
      const x = coordinate(Math.min(...drag.points.map(p => p.x)) - 4);
      const y = coordinate(Math.min(...drag.points.map(p => p.y)) - 4);
      const points = drag.points.map(p => [length(p.x - x), length(p.y - y)]);
      return {kind,x,y,points,width:length(Math.max(...points.map(p => p[0])) + 4),
        height:length(Math.max(...points.map(p => p[1])) + 4),color:activeColor};
    }
    const sized = Math.hypot(point.x - start.x, point.y - start.y) > 10;
    if (kind === 'arrow') {
      const end = sized ? point : {x:start.x + 110,y:start.y};
      return {kind,...arrowGeometry(start,end),color:activeColor};
    }
    return {kind,x:coordinate(sized ? Math.min(point.x, start.x) : start.x),
      y:coordinate(sized ? Math.min(point.y, start.y) : start.y),color:activeColor,
      width:length(sized ? Math.abs(point.x-start.x) : kind === 'frame' ? 420 : 160),
      height:length(sized ? Math.abs(point.y-start.y) : kind === 'frame' ? 280 : 110)};
  }

  function sampleStroke(drag, point, isLast = false) {
    const previous = drag.points.at(-1);
    const distance = Math.hypot(point.x - previous.x,point.y - previous.y);
    if (distance < (isLast ? .05 : drag.sampleDistance)) return;
    if (drag.points.length >= limits.points) {
      const last = drag.points.length - 1;
      drag.points = drag.points.filter((_,index) => index === last || index % 2 === 0);
      drag.sampleDistance *= 2;
    }
    drag.points.push(point);
  }

  function add(item) {
    if (items().size >= limits.items) { notify('白板最多可添加 500 个项目。', true); return; }
    const id = crypto.randomUUID();
    selected = new Set(item.kind === 'stroke' ? [] : [id]);
    commit({id,patch:item});
    if (['note','text','frame'].includes(item.kind)) {
      setTool('select');
      edit(id);
    }
  }

  function moveOrigins(board) {
    const origins = new Map([...selected].filter(id => !board.get(id)?.connection).map(id => [id, board.get(id)]));
    for (const frame of [...origins.values()]) {
      if (frame?.kind !== 'frame') continue;
      for (const [id, item] of board) {
        if (!item.connection && item.x >= frame.x && item.y >= frame.y &&
          item.x + item.width <= frame.x + frame.width && item.y + item.height <= frame.y + frame.height) {
          origins.set(id, item);
        }
      }
    }
    for (const id of extendGroupSelection(board,new Set(origins.keys()))) {
      if (!board.get(id).connection) origins.set(id,board.get(id));
    }
    return origins;
  }

  function previewMove(drag, point, shift) {
    let dx = point.x - drag.start.x;
    let dy = point.y - drag.start.y;
    if (!drag.active && Math.hypot(dx, dy) * scope.view.zoom < 4) return;
    drag.active = true;
    drag.lastPoint = point;
    if (shift && spaceDown) {
      if (!drag.snap && drag.origins.size) {
        const bounds = unionBounds([...drag.origins.values()]);
        const neighbors = [...items().values()].filter(item => !item.connection && !drag.origins.has(item.id)).map(itemBounds);
        drag.snap = {bounds,neighbors};
      }
      if (drag.snap) ({dx,dy} = snapBoardMove(drag.snap.bounds,drag.snap.neighbors,dx,dy,8 / scope.view.zoom));
    } else if (shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    for (const [id, origin] of drag.origins) {
      const position = {x:coordinate(origin.x + dx),y:coordinate(origin.y + dy)};
      drag.positions.set(id, position);
      const node = nodes.get(id);
      if (node) {
        node.style.left = position.x + 'px';
        node.style.top = position.y + 'px';
      }
    }
    const board = items();
    if (!groupOutline.hidden) updateGroupOutline(board);
    renderConnections(board);
  }

  function eraseStrokes(drag, point) {
    const from = drag.point;
    const radius = 8 / scope.view.zoom + 1.5;
    const bounds = {left:Math.min(from.x, point.x) - radius,right:Math.max(from.x, point.x) + radius,
      top:Math.min(from.y, point.y) - radius,bottom:Math.max(from.y, point.y) + radius};
    for (const [id, stroke] of drag.strokes) {
      if (drag.ids.has(id) || !overlapsBox(stroke, bounds)) continue;
      const start = [from.x - stroke.x,from.y - stroke.y];
      const end = [point.x - stroke.x,point.y - stroke.y];
      let prior;
      for (const coordinate of stroke.points) {
        if (segmentsNear(prior || coordinate, coordinate, start, end, radius * radius)) {
          drag.ids.add(id);
          nodes.get(id)?.classList.add('is-erasing');
          break;
        }
        prior = coordinate;
      }
    }
    drag.point = point;
  }

  function drawCropBox(node, region) {
    const box = node.querySelector('.whiteboard-crop-box');
    if (!box) return;
    box.hidden = !region;
    if (!region) return;
    const [left, top, right, bottom] = region;
    box.style.left = left * 100 + '%';
    box.style.top = top * 100 + '%';
    box.style.width = (right - left) * 100 + '%';
    box.style.height = (bottom - top) * 100 + '%';
  }

  function previewImageGesture(drag, point, event) {
    const {item, start, mode} = drag;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const node = nodes.get(drag.id);
    if (mode === 'crop') {
      const from = drag.localStart;
      let to = imageLocalPoint(item, point.x, point.y);
      if (event.shiftKey && !drag.keyboardCrop) {
        const fromX = clamp(from.x,0,1);
        const fromY = clamp(from.y,0,1);
        const signX = to.x >= fromX ? 1 : -1;
        const signY = to.y >= fromY ? 1 : -1;
        const ratio = event.altKey ? item.width / item.height : 1;
        const width = Math.min(Math.max(Math.abs(to.x - fromX),Math.abs(to.y - fromY) / ratio),
          signX > 0 ? 1 - fromX : fromX, (signY > 0 ? 1 - fromY : fromY) / ratio);
        to = {x:fromX + signX * width,y:fromY + signY * width * ratio};
      }
      drag.region = [Math.min(from.x,to.x), Math.min(from.y,to.y), Math.max(from.x,to.x), Math.max(from.y,to.y)]
        .map(edge => clamp(edge,0,1));
      if (node) drawCropBox(node, drag.region);
      return;
    }
    if (mode === 'resize') {
      drag.position = resizeImage(item, drag.corner, dx, dy, {centered:event.altKey});
    } else if (mode === 'scale') {
      const factor = Math.exp(clamp((event.clientX - drag.clientX) / 180, -8, 8));
      const rotation = normalizeImageRotation(item.imageTransform?.rotation) * Math.PI / 180;
      const x = item.width * (factor - 1) / 2;
      const y = item.height * (factor - 1) / 2;
      drag.position = resizeImage(item, 'se', x * Math.cos(rotation) - y * Math.sin(rotation),
        x * Math.sin(rotation) + y * Math.cos(rotation), {centered:true});
    } else {
      const imageTransform = normalizeImageTransform(item.imageTransform);
      if (mode === 'rotate') {
        const {centerX,centerY} = drag;
        const delta = Math.hypot(start.x - centerX, start.y - centerY) * scope.view.zoom < 6
          ? dx * scope.view.zoom
          : (Math.atan2(point.y - centerY,point.x - centerX) - Math.atan2(start.y - centerY,start.x - centerX)) * 180 / Math.PI;
        let rotation = imageTransform.rotation + delta;
        if (event.shiftKey) rotation = Math.round(rotation / 45) * 45;
        imageTransform.rotation = normalizeImageRotation(Math.round(rotation * 10) / 10);
      } else if (mode === 'opacity') {
        imageTransform.opacity = Math.round(clamp(imageTransform.opacity + (event.clientX - drag.clientX) / 200,0,1) * 100) / 100;
      } else if (mode === 'cropPan' || mode === 'cropZoom') {
        const [left,top,right,bottom] = imageTransform.crop;
        const width = right - left;
        const height = bottom - top;
        const local = imageLocalPoint(item,point.x,point.y);
        const signX = imageTransform.flipX ? -1 : 1;
        const signY = imageTransform.flipY ? -1 : 1;
        let nextWidth = width;
        let nextHeight = height;
        let nextLeft = left - (local.x - drag.localStart.x) * width * signX;
        let nextTop = top - (local.y - drag.localStart.y) * height * signY;
        if (mode === 'cropZoom') {
          const scale = clamp(Math.exp((drag.clientX - event.clientX) / 180), .01, 1 / Math.max(width,height));
          nextWidth = width * scale;
          nextHeight = height * scale;
          nextLeft = left + (width - nextWidth) / 2;
          nextTop = top + (height - nextHeight) / 2;
        }
        nextLeft = clamp(nextLeft,0,1 - nextWidth);
        nextTop = clamp(nextTop,0,1 - nextHeight);
        imageTransform.crop = [nextLeft,nextTop,Math.min(1,nextLeft + nextWidth),Math.min(1,nextTop + nextHeight)];
      } else if (mode === 'flip' && Math.hypot(dx,dy) * scope.view.zoom >= 6) {
        const from = imageLocalPoint(item,start.x,start.y);
        const to = imageLocalPoint(item,point.x,point.y);
        const axis = Math.abs(to.x - from.x) * item.width >= Math.abs(to.y - from.y) * item.height ? 'flipX' : 'flipY';
        imageTransform[axis] = !imageTransform[axis];
      }
      drag.position = {imageTransform};
    }
    if (node) place(node, {...drag.item,...drag.position});
    renderConnections(items());
  }

  function endGesture(commitChange = false) {
    const drag = gesture;
    if (!drag) return;
    gesture = undefined;
    stage.classList.remove('is-panning');
    if (stage.hasPointerCapture(drag.pointer)) stage.releasePointerCapture(drag.pointer);
    drag.preview?.remove();
    if (drag.mode === 'link') {
      if (commitChange && drag.to) connectItems(drag.from,drag.to);
      else if (commitChange && !drag.active) setLinkStart(drag.from);
      return;
    }
    if (drag.mode === 'erase') {
      for (const id of drag.ids) nodes.get(id)?.classList.remove('is-erasing');
      if (commitChange && drag.ids.size) {
        commit(...[...drag.ids].map(id => ({id,delete:true})));
        return;
      }
    } else if (drag.mode === 'marquee') {
      marquee.hidden = true;
      if (!commitChange || (!drag.active && drag.additive)) selected = drag.before;
      else if (!drag.active) selected.clear();
    } else if (commitChange && drag.mode === 'move') {
      if (!drag.active) {
        if (!drag.additive) selected = new Set([drag.clicked]);
        else if (drag.wasSelected) {
          for (const id of extendGroupSelection(items(),new Set([drag.clicked]))) selected.delete(id);
        }
      }
      const board = items();
      const operations = [];
      for (const [id, position] of drag.positions) {
        const item = board.get(id);
        if (item && (position.x !== item.x || position.y !== item.y)) operations.push({id,patch:position});
      }
      if (operations.length) {
        commit(...operations);
        return;
      }
    } else if (commitChange && drag.id && current(drag.id)) {
      const patch = drag.mode === 'crop' && drag.region ? cropImage(drag.item, drag.region) : drag.position;
      if (patch) {
        if (drag.mode === 'crop') cropMode = false;
        commit({id:drag.id,patch});
        return;
      }
    } else if (commitChange && drag.mode === 'draw') {
      add(drag.item);
    }
    render();
  }

  function updateMarquee(drag, point) {
    const {start} = drag;
    const {x,y,zoom} = scope.view;
    if (!drag.active && Math.hypot(point.x - start.x, point.y - start.y) * zoom < 4) return;
    drag.active = true;
    const bounds = {left:Math.min(start.x, point.x), right:Math.max(start.x, point.x),
      top:Math.min(start.y, point.y), bottom:Math.max(start.y, point.y)};
    marquee.style.left = bounds.left * zoom + x + 'px';
    marquee.style.top = bounds.top * zoom + y + 'px';
    marquee.style.width = (bounds.right - bounds.left) * zoom + 'px';
    marquee.style.height = (bounds.bottom - bounds.top) * zoom + 'px';
    marquee.hidden = false;
    const board = items();
    selected = new Set(drag.additive ? drag.before : []);
    for (const [id, item] of board) {
      if (intersectsMarquee(item.connection ? visibleConnector(item,board) : item, bounds)) selected.add(id);
    }
    renderSelection(board);
  }

  stage.addEventListener('pointerdown', event => {
    if (!scope || gesture || !event.isPrimary || ![0,1].includes(event.button) ||
        event.target.closest('.whiteboard-editor,[data-board-play-video]')) return;
    event.preventDefault();
    alignMenu.open = false;
    stopEditing(true);
    stage.focus({preventScroll:true});
    const point = world(event.clientX, event.clientY);
    const pointer = event.pointerId;
    const control = event.ctrlKey || event.metaKey;
    const port = event.target.closest('[data-board-port]');
    if (event.button === 0 && tool === 'select' && linkStart && !event.altKey) {
      const from = linkStart;
      setLinkStart(null);
      connectItems(from,connectionTarget(event,from,point));
      return;
    }
    if (zoomKey && event.button === 0) {
      const bounds = stage.getBoundingClientRect();
      gesture = {mode:'zoom',pointer,clientX:event.clientX,x:event.clientX - bounds.left,
        y:event.clientY - bounds.top,zoom:scope.view.zoom};
    } else if (tool === 'pan' || event.button === 1 || (event.altKey && !control && !event.shiftKey &&
        !event.target.closest('[data-board-resize]'))) {
      gesture = {mode:'pan',pointer,x:event.clientX - scope.view.x,y:event.clientY - scope.view.y};
      stage.classList.add('is-panning');
    } else if (tool === 'select') {
      const id = event.target.closest('[data-board-id]')?.dataset.boardId;
      const corner = event.target.closest('[data-board-resize]')?.dataset.boardResize;
      const rotate = event.target.closest('[data-board-rotate]');
      const board = items();
      const item = board.get(id);
      if (port && isBoardConnectable(item) && canUseConnections()) {
        const from = {id,side:port.dataset.boardPort};
        const preview = document.createElement('div');
        preview.className = 'whiteboard-item whiteboard-preview whiteboard-link-preview';
        preview.dataset.kind = 'arrow';
        preview.hidden = true;
        plane.append(preview);
        gesture = {mode:'link',pointer,from,start:boardPortPoint(item,from.side),preview};
        stage.setPointerCapture(pointer);
        return;
      }
      const image = item?.kind === 'image';
      const alreadyCropped = image && item.imageTransform?.crop?.some((edge,index) => edge !== [0,0,1,1][index]);
      const mode = image && canTransformImages() && (
        cropMode || cropKey ? 'crop' : rotate ? 'rotate' :
        control && event.altKey && event.shiftKey ? 'opacity' :
        control && event.altKey ? 'scale' : control ? 'rotate' :
        event.altKey && event.shiftKey ? 'flip' :
        cropAdjustKey && alreadyCropped ? (event.shiftKey ? 'cropZoom' : 'cropPan') : null
      );
      if (mode) {
        selected = new Set([id]);
        gesture = {mode,pointer,id,item,start:point,clientX:event.clientX,keyboardCrop:cropKey,
          centerX:item.x + item.width / 2,centerY:item.y + item.height / 2,
          localStart:imageLocalPoint(item,point.x,point.y)};
        renderSelection(board);
      } else if ((cropMode || cropKey) && !image) {
        cropMode = false;
        renderSelection(board);
      } else if (!item) {
        gesture = {mode:'marquee',pointer,start:point,additive:event.shiftKey,before:new Set(selected)};
      } else if (corner && image) {
        gesture = {mode:'resize',pointer,id,corner,start:point,item};
      } else {
        const wasSelected = selected.has(id);
        if (!wasSelected) selected = extendGroupSelection(board,new Set(event.shiftKey ? [...selected,id] : [id]));
        const origins = moveOrigins(board);
        gesture = {mode:'move',pointer,clicked:id,start:point,origins,positions:new Map(),additive:event.shiftKey,wasSelected};
        if (focusedImage !== id) beforeFocus = focusedImage = undefined;
        renderSelection(board);
      }
    } else if (tool === 'eraser') {
      const strokes = [...items()].filter(([, item]) => item.kind === 'stroke')
        .map(([id,item]) => [id,{...item,points:inkCurve(item).points}]);
      gesture = {mode:'erase',pointer,point,strokes,ids:new Set()};
      eraseStrokes(gesture, point);
    } else if (tool === 'note' || tool === 'text') {
      add({kind:tool,x:coordinate(point.x),y:coordinate(point.y),width:tool === 'note' ? 195 : 255,
        height:tool === 'note' ? 145 : 80,text:'',color:activeColor});
    } else {
      const preview = document.createElement('div');
      preview.className = 'whiteboard-item whiteboard-preview';
      preview.dataset.kind = tool;
      gesture = {mode:'draw',pointer,kind:tool,start:point,points:[point],preview,sampleDistance:1.4 / scope.view.zoom};
      gesture.item = drawItem(gesture, point);
      place(preview, gesture.item);
      itemContent(preview, gesture.item);
      plane.append(preview);
      empty.hidden = true;
    }
    if (gesture) stage.setPointerCapture(pointer);
  });
  stage.addEventListener('pointermove', event => {
    const drag = gesture;
    if (event.pointerId !== drag?.pointer) return;
    if (drag.mode === 'pan') {
      scope.view.x = event.clientX - drag.x;
      scope.view.y = event.clientY - drag.y;
      paintView();
      return;
    }
    if (drag.mode === 'zoom') {
      zoomAt(drag.x, drag.y, drag.zoom * Math.exp((event.clientX - drag.clientX) / 180));
      return;
    }
    const point = world(event.clientX, event.clientY);
    if (drag.mode === 'move') {
      previewMove(drag, point, event.shiftKey);
    } else if (drag.mode === 'link') {
      previewConnection(drag,event,point);
    } else if (drag.mode === 'marquee') {
      updateMarquee(drag, point);
    } else if (drag.mode === 'erase') {
      eraseStrokes(drag, point);
    } else if (drag.id) {
      if (drag.position || drag.region || Math.hypot(point.x - drag.start.x, point.y - drag.start.y) * scope.view.zoom >= 2) {
        previewImageGesture(drag, point, event);
      }
    } else if (drag.mode === 'draw') {
      if (drag.kind === 'stroke') {
        for (const sample of event.getCoalescedEvents?.() || []) sampleStroke(drag,world(sample.clientX,sample.clientY));
        sampleStroke(drag,point);
      }
      drag.item = drawItem(drag, point);
      place(drag.preview, drag.item);
      if (drag.kind === 'stroke' || drag.kind === 'arrow') itemContent(drag.preview, drag.item);
    }
  });
  stage.addEventListener('pointerup', event => {
    if (gesture?.pointer !== event.pointerId) return;
    if (gesture.mode === 'move' && gesture.active) {
      previewMove(gesture, world(event.clientX,event.clientY),event.shiftKey);
    }
    if (gesture.mode === 'erase') eraseStrokes(gesture, world(event.clientX, event.clientY));
    if (gesture.mode === 'link') previewConnection(gesture,event,world(event.clientX,event.clientY));
    if (gesture.mode === 'draw' && gesture.kind === 'stroke') {
      const point = world(event.clientX,event.clientY);
      sampleStroke(gesture,point,true);
      gesture.item = drawItem(gesture,point);
    }
    if (gesture.id && (gesture.position || gesture.region)) {
      previewImageGesture(gesture, world(event.clientX, event.clientY),event);
    }
    endGesture(true);
  });
  stage.addEventListener('pointercancel', event => { if (gesture?.pointer === event.pointerId) endGesture(); });
  stage.addEventListener('lostpointercapture', event => { if (gesture?.pointer === event.pointerId) endGesture(); });
  stage.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
  stage.addEventListener('click', event => {
    const port = event.target.closest('[data-board-port]');
    if (!port || event.detail !== 0 || !canUseConnections()) return;
    const endpoint = {id:port.closest('[data-board-id]').dataset.boardId,side:port.dataset.boardPort};
    if (linkStart) {
      const from = linkStart;
      setLinkStart(null);
      connectItems(from,endpoint);
    } else setLinkStart(endpoint);
  });
  stage.addEventListener('dblclick', event => {
    if (tool === 'select' && !event.shiftKey && !event.target.closest('.whiteboard-editor,[data-board-port],[data-board-play-video]')) {
      const item = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-board-id]');
      if (!plane.contains(item)) return;
      const entry = current(item.dataset.boardId);
      if (entry?.kind === 'image') toggleImageFocus([entry]);
      else edit(item.dataset.boardId);
    }
  });
  stage.addEventListener('wheel', event => {
    if (!scope || gesture || event.target.closest('.whiteboard-editor')) return;
    event.preventDefault();
    const bounds = stage.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 130 : 1);
    zoomAt(event.clientX - bounds.left,event.clientY - bounds.top,scope.view.zoom * Math.exp(-clamp(delta,-250,250) * .002));
  }, {passive:false});
  stage.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.target.closest('.whiteboard-editor')) return;
    const control = event.ctrlKey || event.metaKey;
    const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (event.key === 'Escape' && linkStart) {
      event.preventDefault();
      setLinkStart(null);
      stage.focus({preventScroll:true});
      return;
    }
    if (control && !event.altKey && key === 'z') {
      event.preventDefault();
      changeHistory(event.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (event.target !== stage) return;
    if (!control && event.altKey && event.shiftKey && (key === 'h' || key === 'v')) {
      event.preventDefault();
      doImageAction(key === 'h' ? 'flipX' : 'flipY');
      return;
    }
    if (control) {
      if (!event.altKey && key === 'g') {
        event.preventDefault();
        if (!event.repeat) arrangeSelection(event.shiftKey ? 'ungroup' : 'group');
      } else if (!event.altKey && !event.shiftKey && Object.hasOwn(alignKeys,event.key)) {
        event.preventDefault();
        arrangeSelection(alignKeys[event.key]);
      } else if (event.shiftKey && key === 'c') {
        event.preventDefault();
        if (!event.repeat) doImageAction(event.altKey ? 'crop' : 'resetCrop');
      } else if (event.shiftKey && !event.altKey && key === 't') {
        event.preventDefault();
        doImageAction('resetTransform');
      } else if (event.altKey) return;
      else if (event.code === 'Space') {
        event.preventDefault();
        beforeFocus = focusedImage = undefined;
        fitView();
      } else if (['0','+','=','-'].includes(event.key)) {
        event.preventDefault();
        const value = event.key === '0' ? 1 : scope.view.zoom * (event.key === '-' ? 1/1.22 : 1.22);
        zoomAt(stage.clientWidth / 2,stage.clientHeight / 2,value);
      } else if (!event.shiftKey && key === 'i') {
        event.preventDefault();
        imagePicker.click();
      } else if (!event.shiftKey && key === 'a') {
        event.preventDefault();
        setTool('select');
        selected = new Set(items().keys());
        renderSelection();
      } else if (!event.shiftKey && key === 'd') {
        event.preventDefault();
        duplicateSelected();
      }
      return;
    }
    if (event.altKey) return;
    if (key === 'c' && tool === 'select' && canTransformImages()) {
      event.preventDefault();
      cropKey = true;
      renderSelection();
    } else if (key === 'v') {
      event.preventDefault();
      setTool('select');
      cropAdjustKey = true;
    } else if (key === 'z') {
      event.preventDefault();
      zoomKey = true;
    } else if (event.code === 'Space') {
      event.preventDefault();
      spaceDown = true;
      if (gesture?.mode === 'move' && gesture.lastPoint) previewMove(gesture,gesture.lastPoint,event.shiftKey);
      else if (!gesture && !event.repeat && !event.shiftKey) toggleImageFocus(selectedItems().filter(item => item.kind === 'image'));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      const cancelCrop = cropMode || cropKey || gesture?.mode === 'crop' || gesture?.mode === 'link';
      endGesture();
      cropMode = false;
      cropKey = false;
      if (!cancelCrop) { selected.clear(); beforeFocus = focusedImage = undefined; }
      setTool('select');
    } else if (['Delete','Backspace'].includes(event.key) && selected.size) {
      event.preventDefault();
      deleteSelected();
    } else if (focusedImage && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();
      stepImage(event.key === 'ArrowLeft' ? -1 : 1);
    } else if (selected.size && /^Arrow(Left|Right|Up|Down)$/.test(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? 12 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      commit(...selectedItems().filter(item => !item.connection)
        .map(({id,x,y}) => ({id,patch:{x:coordinate(x + dx),y:coordinate(y + dy)}})));
    } else if (event.key === 'Enter' && selected.size === 1) {
      event.preventDefault();
      edit(selected.values().next().value);
    } else {
      const hotkey = Object.keys(tools).find(key => tools[key][1] === event.key.toUpperCase());
      if (hotkey) { event.preventDefault(); setTool(hotkey); }
    }
  });
  window.addEventListener('keyup', event => {
    if (event.code === 'KeyC' && cropKey) { cropKey = false; renderSelection(); }
    if (event.code === 'KeyV') cropAdjustKey = false;
    if (event.code === 'KeyZ') zoomKey = false;
    if (event.code === 'Space' && spaceDown) {
      spaceDown = false;
      if (gesture?.mode === 'move' && gesture.lastPoint) previewMove(gesture,gesture.lastPoint,event.shiftKey);
    }
  });
  window.addEventListener('blur', () => {
    if (!visible) return;
    endGesture();
    setLinkStart(null);
    cropKey = cropAdjustKey = false;
    zoomKey = spaceDown = false;
    setTool(tool);
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const {boardTool,boardColor,boardView,boardHistory,boardImageAction,boardArrange} = button.dataset;
    if (boardHistory) { changeHistory(boardHistory); stage.focus({preventScroll:true}); }
    else if (boardArrange) arrangeSelection(boardArrange);
    else if (boardImageAction) doImageAction(boardImageAction);
    else if (boardTool) { setTool(boardTool); stage.focus({preventScroll:true}); }
    else if (boardColor) {
      activeColor = boardColor;
      if (selected.size) commit(...[...selected].map(id => ({id,patch:{color:boardColor}})));
      else renderSelection();
    } else if (boardView && scope) {
      if (boardView === 'fit') fitView();
      else {
        const value = boardView === 'reset' ? 1 : scope.view.zoom * (boardView === 'in' ? 1.22 : 1/1.22);
        zoomAt(stage.clientWidth / 2,stage.clientHeight / 2,value);
      }
    } else if (button.hasAttribute('data-board-add-image')) imagePicker.click();
    else if (button === deleteButton && selected.size) deleteSelected();
    else if (button === retry) sync();
  });
  setInterval(() => {
    if (document.hidden) return;
    for (const state of states.values()) sync(state);
  }, 3000);
  setTool('select');

  function show() {
    if (!scope.view) fitView();
    else paintView();
    render();
    sync();
  }

  return {
    refresh() {
      if (!visible) return;
      for (const [id,item] of items()) {
        const node = nodes.get(id);
        if (item.assetId && node?.querySelector('.whiteboard-reference-missing')) node.whiteboardContent = null;
      }
      render();
      sync();
    },
    dropNativeImages(paths, position) {
      if (!visible || !scope) return false;
      const point = position ? {x:position.x / window.devicePixelRatio,y:position.y / window.devicePixelRatio} : undefined;
      insertImages(nativeImages(paths), insertionPoint(point));
      return true;
    },
    contextMenu(event) {
      if (!visible || !stage.contains(event.target)) return null;
      const clicked = event.target.closest('[data-board-id]')?.dataset.boardId;
      if (clicked && !selected.has(clicked)) {
        selected = new Set([clicked]);
        setTool('select');
        renderSelection();
      }
      const point = insertionPoint(event.type === 'contextmenu' ? {x:event.clientX,y:event.clientY} : undefined);
      const actions = [
        ['stack', '粘贴', () => pasteFromClipboard(point)],
        ['picture', '添加图片…', () => imagePicker.click()],
      ];
      if (selected.size) actions.unshift(
        ['stack', '复制', () => copySelected()],
        ['edit', '剪切', () => { if (copySelected()) deleteSelected(); }],
        ['plus', '复制一份', duplicateSelected],
        ['trash', '删除选中项', deleteSelected],
      );
      if (canTransformImages() && selectedItems().some(item => item.kind === 'image')) {
        const transforms = Object.entries(imageActions).filter(([name]) =>
          name !== 'crop' || selected.size === 1);
        actions.unshift(...transforms.map(([name,[label,glyph]]) => [glyph,label,() => doImageAction(name)]));
      }
      if (canUseGroups()) {
        const board = items();
        if (canAlignSelection(board,selected)) actions.unshift(['stack','成组',()=>arrangeSelection('group')]);
        if (selectedItems().some(item => item.groupId)) actions.unshift(['stack','解组',()=>arrangeSelection('ungroup')]);
      }
      return {anchor:stage,actions,label:'白板操作'};
    },
    setVisible(value) {
      if (visible === value) return;
      if (!value) {
        stopEditing(true);
        endGesture();
        setLinkStart(null);
        alignMenu.open = false;
        cropMode = cropKey = cropAdjustKey = zoomKey = spaceDown = false;
        for (const node of nodes.values()) {
          if (!node.whiteboardAssetReference) continue;
          releaseImage(node);
          node.whiteboardContent = null;
        }
        setTool(tool);
      }
      visible = value;
      if (value && scope) show();
    },
    setScope({key,teamId,projectId,workspaceKey = key}) {
      if (!key || scope?.key === key) return;
      stopEditing(true);
      endGesture();
      setLinkStart(null);
      alignMenu.open = false;
      selected.clear();
      cropMode = cropKey = cropAdjustKey = zoomKey = spaceDown = false;
      beforeFocus = focusedImage = undefined;
      setTool('select');
      if (!states.has(key)) states.set(key, {key,teamId,projectId,workspaceKey,base:teamId ? new Map() : loadPersonal(key),
        ...(teamId ? loadOutbox(key, teamId) : {queue:[]}),loaded:!teamId,error:'',undo:[],redo:[],
        order:new Map(),nextOrder:0});
      scope = states.get(key);
      for (const node of nodes.values()) {
        releaseImage(node);
        node.remove();
      }
      nodes.clear();
      if (visible) show();
      else sync();
    },
  };
}
