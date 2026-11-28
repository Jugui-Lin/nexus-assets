import {createWhiteboardImages, isWhiteboardImage} from './whiteboard-images.js';
import {normalizeImageTransform, normalizeImageRotation, resizeImage, imageLocalPoint,
  imageBounds, cropImage, resetImageCrop, snapBoardMove} from './whiteboard-image-transform.js';
import {boardHistoryEntry, boardHistoryOperations} from './whiteboard-history.js';
import {parseWhiteboardAssetClipboard} from './whiteboard-asset-clipboard.js';
import {groupSelected, ungroupSelected, extendGroupSelection, alignSelection, distributeSelection,
  stackSelection, canAlignSelection, canDockSelection, canNormalizeSelection,
  normalizeSelection, normalizeScaleItems} from './whiteboard-arrange.js';
import {boardPorts, isBoardConnectable, boardPortPoint, nearestBoardEdge, facingBoardPort,
  boardConnectionControls, readBoardConnectionOffsets, writeBoardConnectionOffsets} from './whiteboard-connections.js';
import {strokeCurve} from './whiteboard-stroke.js';
import {readWhiteboardLink, whiteboardLinkCard, whiteboardLinkPatch} from './whiteboard-links.js';
import {createWhiteboardFilePreviews, readWhiteboardFile, whiteboardFileCard, writeWhiteboardFile} from './whiteboard-files.js';
import {initVideoHoverPreview} from './video-hover-preview.js';
import {readVideoCover, writeVideoCover, copyVideoFrame, videoFrameUrl, loadVideoCoverFrame} from './whiteboard-video-cover.js';
import {initWhiteboardPresence} from './whiteboard-presence.js';
import {readWhiteboardMediaDimensions} from './whiteboard-media-dimensions.js';
import {canOptimizeArrangement, optimizeArrangement} from './whiteboard-optimize.js';
import {initWhiteboardStackSettings, stackSettingsLabel} from './whiteboard-stack-settings.js';
import {initWhiteboardReview} from './whiteboard-review.js';
import {initWhiteboardNavigation} from './whiteboard-navigation.js';
import {readVideoClip,videoClipRange,writeVideoClip} from './whiteboard-video-clip-reference.js';
import {initWhiteboardVideoReview} from './whiteboard-video-review.js';
import {initWhiteboardReplaceImage} from './whiteboard-replace-image.js';
import {initWhiteboardRegions, isWhiteboardRegion, newWhiteboardRegionId, readWhiteboardRegion,
  suggestedRegionShot, whiteboardRegionText} from './whiteboard-regions.js';
import {formatTime} from './video-controls.js';

const storageKey = 'nexus-whiteboard-v1:';
const clipboardType = 'application/x-nexus-whiteboard+json';
const webClipboardType = 'web ' + clipboardType;
const outboxKey = 'nexus-whiteboard-outbox-v1:';
const colorFilterKey = 'nexus-whiteboard-color-filter-v1:';
const colors = {yellow:'黄色', mint:'薄荷绿', sky:'天蓝色', rose:'玫瑰色', violet:'紫色', slate:'灰色'};
const kinds = {note:'便签', text:'文字', rect:'矩形', ellipse:'椭圆', stroke:'画笔', arrow:'连接线', frame:'画框', image:'图片'};
const tools = {select:['选择','V','locate'], pan:['平移','H','arrow'], note:['便签','N','notes'],
  text:['文字','T','list'], rect:['矩形','R','grid'], ellipse:['椭圆','O','eye'],
  arrow:['连接线','L','arrow'], frame:['画框','F','expand'], stroke:['画笔','P','edit'], eraser:['橡皮擦','E','trash']};
const limits = {items:500, text:2048, points:768, batch:16, history:80};
const svgNS = 'http://www.w3.org/2000/svg';
const connectorCurve = Symbol('connectorCurve');
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
  left:['左对齐','x','start','align-left','Ctrl+←','Control+ArrowLeft Meta+ArrowLeft'],
  right:['右对齐','x','end','align-right','Ctrl+→','Control+ArrowRight Meta+ArrowRight'],
  top:['顶对齐','y','start','align-top','Ctrl+↑','Control+ArrowUp Meta+ArrowUp'],
  bottom:['底对齐','y','end','align-bottom','Ctrl+↓','Control+ArrowDown Meta+ArrowDown'],
  centerX:['水平居中','x','center','align-center-horizontal'],
  centerY:['垂直居中','y','center','align-center-vertical'],
  distributeX:['水平排列','x',null,'distribute-horizontal','Ctrl+Alt+Shift+↑','Control+Alt+Shift+ArrowUp Meta+Alt+Shift+ArrowUp'],
  distributeY:['垂直排列','y',null,'distribute-vertical','Ctrl+Alt+Shift+↓','Control+Alt+Shift+ArrowDown Meta+Alt+Shift+ArrowDown'],
  stack:['堆叠',null,null,'stack','Ctrl+Alt+S','Control+Alt+S Meta+Alt+S'],
  optimal:['优化排列',null,null,'grid','Ctrl+P','Control+P Meta+P'],
};
const alignKeys = {ArrowLeft:'left',ArrowRight:'right',ArrowUp:'top',ArrowDown:'bottom'};
const directionalAlignActions = new Set(Object.values(alignKeys));
const distributeKeys = {ArrowUp:'distributeX',ArrowDown:'distributeY'};
const normalizeActions = {
  height:['等高','align-top','Ctrl+Alt+←','Control+Alt+ArrowLeft Meta+Alt+ArrowLeft'],
  width:['等宽','align-left','Ctrl+Alt+→','Control+Alt+ArrowRight Meta+Alt+ArrowRight'],
  size:['等最长边','expand','Ctrl+Alt+↑','Control+Alt+ArrowUp Meta+Alt+ArrowUp'],
  area:['等面积','grid'],
  scale:['等缩放比例','sliders','Ctrl+Alt+↓','Control+Alt+ArrowDown Meta+Alt+ArrowDown'],
};
const normalizeKeys = {ArrowLeft:'height',ArrowRight:'width',ArrowUp:'size',ArrowDown:'scale'};
const normalizeModes = {first:'以首个选中项为准',average:'取平均值'};
const normalizeModeKey = 'nexus-whiteboard-normalize-mode';
const portNames = {top:'上边',right:'右边',bottom:'下边',left:'左边'};

function readColorFilter(key) {
  try {
    const stored = localStorage.getItem(colorFilterKey + key);
    return Object.hasOwn(colors,stored) ? stored : '';
  } catch { return ''; }
}

const boardColorOf = item => Object.hasOwn(colors,item.color) ? item.color : 'slate';

function fromItems(items) {
  return new Map(items.slice(0, limits.items).filter(item => typeof item?.id === 'string' &&
    Object.hasOwn(kinds, item.kind) && [item.x, item.y, item.width, item.height].every(Number.isFinite) &&
    item.width > 0 && item.height > 0).map(item => [item.id, item]));
}

function applyOperations(base, operations) {
  const items = new Map(base);
  for (const {id, patch, delete:remove} of operations) {
    if (remove) items.delete(id);
    else if (items.has(id) || patch.kind) {
      const next = {...items.get(id), ...patch, id};
      if (patch.assetId) delete next.imageId;
      else if (patch.imageId) delete next.assetId;
      items.set(id,next);
    }
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
  if (item.kind !== 'arrow') return points;
  if (!item[connectorCurve] || points.length !== 2) return arrowPoints(points);
  const [start,end] = points;
  const [first,last] = item[connectorCurve];
  const samples = Array.from({length:25}, (_, index) => {
    const t = index / 24;
    const u = 1 - t;
    return [0,1].map(i => u ** 3 * start[i] + 3 * u * u * t * first[i] +
      3 * u * t * t * last[i] + t ** 3 * end[i]);
  });
  return [...samples,...arrowPoints([last,end]).slice(2)];
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

function connectedGeometry(start, end, fromItem, fromSide, toItem, toSide) {
  const geometry = arrowGeometry(start,end);
  const curve = boardConnectionControls(start,end,fromItem,fromSide,toItem,toSide)
    .map(([x,y]) => [x - geometry.x,y - geometry.y]);
  return {...geometry,[connectorCurve]:curve};
}

function connectionShaft(item) {
  const [start,end] = item.points;
  const [first,last] = item[connectorCurve];
  return 'M' + start.join(' ') + ' C' + [first,last,end].map(point => point.join(' ')).join(' ');
}

function connectionPath(item) {
  const [,end] = item.points;
  const [,last] = item[connectorCurve];
  const head = arrowPoints([last,end]).slice(2);
  const shaft = connectionShaft(item);
  return head.length ? shaft + ' M' + head.map(point => point.join(' ')).join(' L') : shaft;
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
  if (!item[connectorCurve] && !overlapsBox(item, bounds)) return false;
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

function loadPersonal(key,strict = false) {
  try {
    const raw = localStorage.getItem(storageKey + key);
    const saved = JSON.parse(raw);
    if (Array.isArray(saved?.items)) return fromItems(saved.items);
    if (strict && raw !== null) throw Error('白板数据无效');
  } catch (error) {
    if (strict) throw error;
  }
  return new Map();
}

function writePersonalItems(key,items) {
  localStorage.setItem(storageKey + key, JSON.stringify({items:[...items.values()]}));
}

export function personalBoardReferencesAsset(key, assetId) {
  for (const item of loadPersonal(key).values()) {
    if (item.assetId === assetId) return true;
  }
  return false;
}

export const personalBoardRegions = key => [...loadPersonal(key).values()].map(readWhiteboardRegion).filter(Boolean);

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

export function initWhiteboard({panel, api, notify = () => {}, resolveAssetImage = async () => null, openLink,
  locateAsset, openVideoSource, reviewAssignees, searchReplacementImages,loadPresenceAvatar,
  revealPastedFile, importPastedFiles, handleDroppedFiles, loadFilePreview, colorFilter}) {
  const stackSettings = initWhiteboardStackSettings(notify);
  let normalizeSource = 'first';
  try { if (localStorage.getItem(normalizeModeKey) === 'average') normalizeSource = 'average'; } catch {}
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  panel.innerHTML = `<div class="whiteboard-shell">
    <div class="whiteboard-stage" tabindex="0" role="region" aria-label="白板画布">
      <div class="whiteboard-grid" aria-hidden="true"></div>
      <div class="whiteboard-plane">
        <div class="whiteboard-group-frames" aria-hidden="true"></div>
        <div class="whiteboard-group-outline" aria-hidden="true" hidden></div>
        <div class="whiteboard-connector-endpoints" data-pane-transient hidden>
          <button type="button" data-board-endpoint="from" aria-label="移动连接线起点" title="拖动调整连接线起点"></button>
          <button type="button" data-board-endpoint="to" aria-label="移动连接线终点" title="拖动调整连接线终点"></button>
          <button type="button" data-board-cut-connector aria-label="断开连接线" title="断开连接线">${icon('scissors')}</button>
        </div>
      </div>
      <div class="whiteboard-marquee" aria-hidden="true" hidden></div>
      <p class="whiteboard-empty" hidden>粘贴图片，或选择工具开始</p>
      <div class="whiteboard-presence-cursors" data-pane-transient aria-hidden="true"></div>
      <div class="whiteboard-node-picker" role="group" aria-label="添加连接节点" hidden>
        <button type="button" data-board-node-kind="note">${icon('notes')}便签</button>
        <button type="button" data-board-node-kind="text">${icon('list')}文字</button>
        <button type="button" data-board-node-kind="image">${icon('picture')}图片</button>
      </div>
      <input type="file" data-board-node-image accept="image/png,image/jpeg,image/webp,image/gif" hidden>
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
      </div>
      <div class="whiteboard-align-actions" role="group" aria-label="对齐与排列" hidden>${Object.entries(alignActions).map(([id,[label,,,glyph,shortcut,key]]) => {
        const button = `<button type="button" data-board-arrange="${id}" aria-label="${label}" title="${label}${shortcut ? `（${shortcut}）` : ''}"${key ? ` aria-keyshortcuts="${key}"` : ''}>${icon(glyph)}</button>`;
        if (id !== 'stack') return button;
        return `<div class="whiteboard-stack-control" role="group" aria-label="堆叠操作" hidden>
          ${button}<button type="button" data-board-stack-preferences aria-label="${stackSettingsLabel}" title="${stackSettingsLabel}"
            aria-haspopup="dialog" aria-controls="whiteboard-stack-settings">${icon('chevron')}</button>
        </div>`;
      }).join('')}</div>
      <div class="whiteboard-normalize" hidden>
        <button type="button" data-board-normalize-toggle aria-label="缩放对齐" aria-expanded="false" aria-controls="whiteboard-normalize-panel">
          ${icon('expand')}<span>缩放对齐</span>${icon('chevron')}
        </button>
        <div id="whiteboard-normalize-panel" class="whiteboard-normalize-panel" role="group" aria-label="缩放对齐" data-pane-transient hidden>
          <div class="whiteboard-normalize-modes" role="group" aria-label="缩放参照">${Object.entries(normalizeModes).map(([id,label]) =>
            `<button type="button" data-board-normalize-source="${id}" aria-pressed="${normalizeSource === id}">${label}</button>`).join('')}</div>
          <div class="whiteboard-normalize-actions">${Object.entries(normalizeActions).map(([id,[label,glyph,shortcut,key]]) =>
            `<button type="button" data-board-normalize="${id}"${key ? ` aria-keyshortcuts="${key}"` : ''}>
              ${icon(glyph)}<span>${label}</span>${shortcut ? `<kbd aria-hidden="true">${shortcut}</kbd>` : ''}
            </button>`).join('')}</div>
        </div>
      </div>
      <button type="button" class="whiteboard-delete" title="删除所选项（Delete）" aria-label="删除所选项" disabled>${icon('trash')}</button>
    </div>
    <div class="whiteboard-sync">
      <div class="whiteboard-presence-roster" data-pane-transient role="group" aria-label="此白板的在线协作者" hidden></div>
      <span role="status"></span><button type="button" hidden>重试</button>
    </div>
    <div class="whiteboard-view" role="toolbar" aria-label="视图缩放">
      <button type="button" data-board-view="out" title="缩小" aria-label="缩小">−</button>
      <button type="button" data-board-view="reset" title="恢复 100% 缩放">100%</button>
      <button type="button" data-board-view="in" title="放大" aria-label="放大">+</button>
      <button type="button" data-board-view="fit" title="优化画布（Ctrl+O）" aria-label="适应全部内容" aria-keyshortcuts="Control+O Meta+O">${icon('expand')}</button>
    </div>
    <div class="whiteboard-history" role="toolbar" aria-label="画布快捷操作">
      <button type="button" data-board-history="undo" title="撤销（Ctrl+Z）" aria-label="撤销" aria-keyshortcuts="Control+Z Meta+Z" disabled>${icon('undo')}</button>
      <button type="button" data-board-history="redo" title="重做（Ctrl+Shift+Z）" aria-label="重做" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" disabled>${icon('redo')}</button>
      <button type="button" data-board-navigation title="查找与大纲（Ctrl+F）" aria-label="查找与大纲" aria-haspopup="dialog" aria-keyshortcuts="Control+F Meta+F">${icon('search')}</button>
    </div>
    <p class="whiteboard-crop-hint" role="status" hidden>拖出保留区域 · Esc 退出</p>
    <p class="whiteboard-link-hint" role="status" hidden>点击要连接的元素 · Esc 取消</p>
  </div>`;
  const get = selector => panel.querySelector(selector);
  const shell = get('.whiteboard-shell');
  const stage = get('.whiteboard-stage');
  const filePreviews = createWhiteboardFilePreviews(stage,loadFilePreview);
  const grid = get('.whiteboard-grid');
  const plane = get('.whiteboard-plane');
  const marquee = get('.whiteboard-marquee');
  const empty = get('.whiteboard-empty');
  const status = get('.whiteboard-sync > span');
  const retry = get('.whiteboard-sync button');
  const deleteButton = get('.whiteboard-delete');
  const imagePicker = get('[data-board-image-picker]');
  const undoButton = get('[data-board-history="undo"]');
  const redoButton = get('[data-board-history="redo"]');
  const zoomLabel = get('[data-board-view="reset"]');
  const imageTools = get('.whiteboard-image-actions');
  const cropHint = get('.whiteboard-crop-hint');
  const groupFrameLayer = get('.whiteboard-group-frames');
  const groupOutline = get('.whiteboard-group-outline');
  const connectorEndpoints = get('.whiteboard-connector-endpoints');
  const endpointHandles = connectorEndpoints.querySelectorAll('[data-board-endpoint]');
  const connectorCut = get('[data-board-cut-connector]');
  const connectorMeasure = document.createElementNS(svgNS,'path');
  const linkHint = get('.whiteboard-link-hint');
  const nodePicker = get('.whiteboard-node-picker');
  const nodeImage = get('[data-board-node-image]');
  const arrangeTools = get('.whiteboard-arrange');
  const alignmentTools = get('.whiteboard-align-actions');
  const alignmentDock = alignmentTools.parentElement;
  const alignOptions = alignmentTools.querySelectorAll('[data-board-arrange]');
  const stackControl = get('.whiteboard-stack-control');
  const stackPreferencesButton = get('[data-board-stack-preferences]');
  const normalizeTools = get('.whiteboard-normalize');
  const normalizeToggle = get('[data-board-normalize-toggle]');
  const normalizeLabel = normalizeToggle.querySelector('span');
  const normalizePanel = get('#whiteboard-normalize-panel');
  const normalizeSources = normalizePanel.querySelectorAll('[data-board-normalize-source]');
  const normalizeScale = normalizePanel.querySelector('[data-board-normalize="scale"]');
  const groupButton = get('[data-board-arrange="group"]');
  const ungroupButton = get('[data-board-arrange="ungroup"]');
  const media = createWhiteboardImages({api});
  const presence = initWhiteboardPresence({stage,cursors:get('.whiteboard-presence-cursors'),
    avatars:get('.whiteboard-presence-roster'),api,world,loadAvatar:loadPresenceAvatar});
  const states = new Map();
  const nodes = new Map();
  const groupFrames = new Map();
  const selectionChrome = {
    stage, toolbar:alignmentTools, sidebar:get('.whiteboard-tools'),
    history:get('.whiteboard-history'), palette:alignmentDock, zoom:get('.whiteboard-view'),
  };
  const chromeSizes = new Map();
  let selectionBox;
  let outlinedGroup;
  let scope;
  let visible = false;
  let visibilityRevision = 0;
  let tool = 'select';
  let activeColor = 'yellow';
  const colorForNewItem = () => scope?.colorFilter || activeColor;
  let selected = new Set();
  let gesture;
  let gestureFrame = 0;
  let gestureEvent;
  let viewFrame = 0;
  let paintedZoom;
  let editing;
  let cropMode = false;
  let cropKey = false;
  let cropAdjustKey = false;
  let zoomKey = false;
  let spaceDown = false;
  let focusedImage;
  let beforeFocus;
  let pointerPosition;
  let pendingContextImage;
  let localClipboard;
  let linkStart;
  let pendingNode;
  let pendingNodeImage;
  let pendingMedia = 0;
  let normalizeRequest;
  const preparedAssets = new Map();
  const videoReferences = new WeakMap();
  const pinnedVideoFrames = new Map();
  let restoreVideoCovers = Promise.resolve();
  let pendingCoverPin;
  const videoCoverObserver = new IntersectionObserver(entries => {
    for (const {target:node,isIntersecting} of entries) {
      if (!isIntersecting) continue;
      videoCoverObserver.unobserve(node);
      const reference = videoReferences.get(node);
      if (reference) queueVideoCover(reference);
    }
  }, {root:stage});
  const whiteboardHover = initVideoHoverPreview({
    grid:stage,
    source(node) { return videoReferences.get(node)?.asset.playback(); },
    canPreview(node) {
      const reference = videoReferences.get(node);
      return reference?.active() && !reference.segment && reference.video.paused && !reference.play.disabled;
    },
    isBlocked: () => !visible || tool !== 'select' || Boolean(gesture || editing || pendingNode || linkStart ||
      cropMode || cropKey || cropAdjustKey || zoomKey ||
      document.querySelector('dialog[open], .asset-menu:not(.hidden), .dragging-assets, .marquee-selecting')),
    scrub:{
      target(target) {
        const node = target.closest?.('[data-board-id]');
        return node && videoReferences.has(node) ? node : null;
      },
      ratio(node, event) {
        const point = world(event.clientX,event.clientY);
        const item = current(node.dataset.boardId);
        return item ? imageLocalPoint(item,point.x,point.y).x : 0;
      },
      mount(node, layer, video, guide) {
        layer.classList.add('whiteboard-video-hover');
        video.className = 'whiteboard-image';
        layer.setAttribute('data-pane-transient','');
        guide.setAttribute('data-pane-transient','');
        videoReferences.get(node).clip.append(layer);
        node.append(guide);
      },
      frame(node, video) {
        const reference = videoReferences.get(node);
        if (!reference) return;
        const canvas = copyVideoFrame(video,reference.preview?.canvas);
        if (canvas) reference.preview = {canvas,time:video.currentTime};
      },
      leave(node) {
        const reference = videoReferences.get(node);
        const preview = reference?.preview;
        if (!preview) return;
        reference.preview = null;
        const url = videoFrameUrl(preview.canvas);
        if (!url || !reference.active()) return;
        reference.lastFrame = {url,time:preview.time};
        reference.video.hidden = true;
        reference.image.src = url;
        reference.image.hidden = false;
        return reference.lastFrame;
      },
    },
  });

  function orderedItems(state, board) {
    for (const id of board.keys()) {
      if (!state.order.has(id)) state.order.set(id,state.nextOrder++);
    }
    return new Map([...board].sort(([left],[right]) => state.order.get(left) - state.order.get(right)));
  }

  const emptyBoard = new Map();
  const records = () => scope
    ? (scope.board ??= orderedItems(scope, applyOperations(scope.base, scope.queue)))
    : emptyBoard;
  function canvasItems() {
    if (!scope) return emptyBoard;
    const all = records();
    if (scope.canvasSource !== all) {
      scope.canvasSource = all;
      scope.canvasItems = new Map([...all].filter(([,item]) => !isWhiteboardRegion(item)));
    }
    return scope.canvasItems;
  }
  function items() {
    const all = canvasItems();
    const filter = scope?.colorFilter;
    if (!filter || review.presenting()) return all;
    if (scope.colorItemsSource !== all || scope.shownColor !== filter) {
      scope.colorItemsSource = all;
      scope.shownColor = filter;
      const shown = new Map([...all].filter(([,item]) => boardColorOf(item) === filter));
      for (const [id,item] of shown) {
        if (item.connection && (!shown.has(item.connection.from?.id) || !shown.has(item.connection.to?.id))) shown.delete(id);
      }
      scope.colorItems = shown;
    }
    return scope.colorItems;
  }
  const review = initWhiteboardReview({shell,stage,icon,items:canvasItems,minimapItems:items,bounds:itemBounds,
    boardKey:() => visible ? scope?.key : null,
    getView:() => scope?.view,
    setView(view) { if (scope) { scope.view = view; paintView(); } },
    canPresent:() => visible && !gesture && !editing && !cropMode && !normalizeRequest,
    onPresent() {
      whiteboardHover.stop();
      navigation.close();
      videoReviews.close();
      regions.close();
      for (const video of stage.querySelectorAll('video')) video.pause();
      dismissNodePicker(true);
      setLinkStart(null);
      if (colorFilter) colorFilter.disabled = true;
      if (scope?.colorFilter) render();
    },
    onExit() {
      if (colorFilter) colorFilter.disabled = false;
      if (scope?.colorFilter) render();
    },
  });
  function changeColorFilter(value) {
    if (!visible || !scope || review.presenting()) return;
    endGesture();
    stopEditing(true);
    scope.colorFilter = Object.hasOwn(colors,value) ? value : '';
    if (colorFilter) colorFilter.value = scope.colorFilter;
    try {
      if (scope.colorFilter) localStorage.setItem(colorFilterKey + scope.key,scope.colorFilter);
      else localStorage.removeItem(colorFilterKey + scope.key);
    } catch {}
    render();
  }
  if (colorFilter) {
    colorFilter.replaceChildren(new Option('全部颜色',''),...Object.entries(colors).map(([id,label]) => new Option(label,id)));
    colorFilter.addEventListener('change',() => changeColorFilter(colorFilter.value));
  }
  const current = id => items().get(id);
  const videoReviews = initWhiteboardVideoReview({world,current,
    visible:() => visible && !review.presenting(),
    mayEdit:() => Boolean(scope?.loaded && (!scope.teamId || canUseAssetReferences() && !scope.error)),
    assignees:() => reviewAssignees?.(scope?.workspaceKey) || [],
    commit:(id,text) => commit({id,patch:{text}}),
  });
  const canTransformImages = () => Boolean(scope && (!scope.teamId || scope.imageTransforms));
  const canUseAssetReferences = () => Boolean(scope && (!scope.teamId || scope.assetReferences));
  const canUseGroups = () => Boolean(scope && (!scope.teamId || scope.groups));
  const canUseConnections = () => Boolean(scope && (!scope.teamId || scope.connections));
  const savedRegions = () => [...records().values()].map(readWhiteboardRegion).filter(Boolean);
  const canEditRegions = () => Boolean(visible && scope?.loaded && (!scope.teamId || canUseAssetReferences() && !scope.error));
  const regions = initWhiteboardRegions({regions:savedRegions,
    context:() => visible && !review.presenting() && !gesture && scope?.view ? scope : null,
    canEdit:canEditRegions,
    capture:captureRegion,
    save(target,id,name,shot,geometry) {
      if (target !== scope || !canEditRegions()) throw Error('当前白板无法修改区域');
      if (id && !readWhiteboardRegion(records().get(id))) throw Error('该区域已移除');
      if (!id && (records().size >= limits.items || savedRegions().length >= 60)) throw Error('此白板已达到区域或项目容量上限');
      commit({id:id || newWhiteboardRegionId(),patch:{...geometry,
        ...(!id && {kind:'frame',points:[],color:'slate'}),text:whiteboardRegionText(name,shot)}});
    },
    remove(target,id) {
      if (target !== scope || !canEditRegions()) throw Error('当前白板无法修改区域');
      if (!readWhiteboardRegion(records().get(id))) throw Error('该区域已移除');
      commit({id,delete:true});
    },
    jump:jumpToRegion,
  });
  const canOpenNavigation = () => Boolean(visible && scope?.view && !editing && !gesture && !review.presenting());
  const navigation = initWhiteboardNavigation({trigger:get('[data-board-navigation]'),items:records,kinds,icon,
    bounds:itemBounds,assetName:item => nodes.get(item.id)?.whiteboardAsset?.name,
    canOpen:canOpenNavigation,canRename:canEditRegions,jump:jumpToBoardResult});
  const replaceImage = searchReplacementImages ? initWhiteboardReplaceImage({search:searchReplacementImages,
    async preview(request,candidate) {
      if (!request.current() || !searchReplacementImages(request.scope,'',candidate.id).length) return null;
      const media = await prepareReferenceMedia(candidate.id,request.target);
      return media?.kind === 'image' && media.previewImage.naturalWidth ? media : null;
    },
    async commit(request,stillRequested) {
      if (request.target.teamId) await sync(request.target);
      if (!request.current() || !stillRequested()) throw Error('白板卡片已变更，请重新选择');
      if (!searchReplacementImages(request.scope,'',request.candidate.id).length) throw Error('所选图片暂不可用');
      preparedAssets.set(request.id,request.media);
      commit({id:request.id,patch:{assetId:request.candidate.id}});
      notify('已替换白板参考图');
      return true;
    },
  }) : null;

  function canReplaceImage(item) {
    return Boolean(replaceImage && item?.kind === 'image' && scope?.loaded &&
      (!scope.teamId || canUseAssetReferences() && !scope.error) && !review.presenting() &&
      (item.imageId || nodes.get(item.id)?.whiteboardAsset?.kind === 'image'));
  }

  function showReplaceImage(item) {
    if (!canReplaceImage(item)) return;
    const target = scope;
    const revision = visibilityRevision;
    const signature = record => record && JSON.stringify([record.assetId,record.imageId,record.x,record.y,
      record.width,record.height,record.text,record.imageTransform,record.groupId]);
    const expected = signature(item);
    replaceImage.open({target,id:item.id,scope:target.workspaceKey,original:item.assetId,
      title:item.text || nodes.get(item.id)?.whiteboardAsset?.name || '参考图',
      current:() => visible && target === scope && revision === visibilityRevision && selected.size === 1 &&
        selected.has(item.id) && canReplaceImage(current(item.id)) && signature(current(item.id)) === expected,
    });
  }

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
    regions.refresh();
  }

  function savePersonal(state) {
    try {
      writePersonalItems(state.key,state.base);
      state.storageError = false;
    } catch {
      state.storageError = true;
      notify('本机白板暂时无法保存。', true);
    }
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
    if (!state?.teamId || state.workspaceKey !== scope?.workspaceKey ||
      (state === scope && gesture && !state.queue.length) ||
      ((!visible || state !== scope) && !state.queue.length)) return;
    if (state.busy) return state.syncCompletion;
    let finished;
    state.syncCompletion = new Promise(resolve => { finished = resolve; });
    state.busy = true;
    if (!state.batch && state.queue.length) {
      state.batch = {batchId:crypto.randomUUID(), operations:state.queue.slice(0, limits.batch)};
      saveOutbox(state);
      if (visible && state === scope) showSync();
    }
    const batch = state.batch;
    const target = state.projectId && state.projectId !== 'default'
      ? {teamId:state.teamId,projectId:state.projectId} : {teamId:state.teamId};
    let changed = false;
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
      changed = Boolean(batch) || state.revision !== snapshot.revision;
      if (changed) {
        state.base = fromItems(snapshot.items);
        state.revision = snapshot.revision;
        state.board = undefined;
      }
      for (const feature of ['imageTransforms','assetReferences','restoreItems','groups','connections']) {
        const supported = snapshot[feature] === true;
        changed ||= state[feature] !== supported;
        state[feature] = supported;
      }
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
      finished();
      if (scope === state && visible) {
        if (changed) render();
        else showSync();
      }
      if (!state.error && state.queue.length) sync(state);
    }
  }

  function applyChanges(operations, next) {
    scope.board = undefined;
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
    const before = records();
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
    const board = records();
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
        operation.id = isWhiteboardRegion({id:original,kind:operation.patch.kind}) ? newWhiteboardRegionId() : crypto.randomUUID();
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
    } else renderSelection();
  }

  function itemContent(node, item) {
    releaseImage(node);
    const link = item.kind === 'text' && readWhiteboardLink(item.text);
    const file = item.kind === 'text' && readWhiteboardFile(item.text);
    node.toggleAttribute('data-board-link-card', Boolean(link));
    node.toggleAttribute('data-board-file-card', Boolean(file));
    node.setAttribute('aria-label', file ? (file.isFolder ? '文件夹 · ' : '文件 · ') + file.name : link ? '链接 · ' + link.title : kinds[item.kind]);
    if (link) {
      node.replaceChildren(whiteboardLinkCard(link, icon, openLink));
    } else if (file) {
      const target = scope;
      const available = () => visible && scope === target && current(item.id)?.text === item.text;
      const reveal = revealPastedFile && file.teamId === target?.teamId ? async () => {
        if (!available()) return;
        try { await revealPastedFile(file); }
        catch (failure) { notify(String(failure?.message || failure),true); }
      } : null;
      node.replaceChildren(whiteboardFileCard(file,icon,reveal));
      if (!file.isFolder && file.teamId === target?.teamId) filePreviews?.add(node,file,available);
    } else if (item.kind === 'image') {
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
    } else if (item.kind === 'text') {
      const value = document.createElement('span');
      value.className = 'whiteboard-text-value';
      value.textContent = item.text || '';
      node.replaceChildren(value);
    } else if (item.kind === 'stroke' || item.kind === 'arrow') paintStroke(node,item);
    else node.textContent = item.kind === 'note' ? item.text || '' : '';
  }

  function paintStroke(node,item) {
    const stroke = item.kind === 'stroke';
    const curve = item[connectorCurve];
    const tag = stroke || curve ? 'path' : 'polyline';
    let svg = node.firstElementChild;
    let hitArea = svg?.firstElementChild;
    let line = svg?.lastElementChild;
    if (!hitArea?.classList.contains('whiteboard-stroke-hit') || line?.localName !== tag) {
      svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('aria-hidden', 'true');
      line = document.createElementNS(svgNS, tag);
      hitArea = line.cloneNode();
      hitArea.setAttribute('class', 'whiteboard-stroke-hit');
      hitArea.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(hitArea, line);
      node.replaceChildren(svg);
    }
    svg.setAttribute('viewBox', `0 0 ${item.width} ${item.height}`);
    if (stroke) line.setAttribute('class','whiteboard-ink-path');
    else if (curve) line.setAttribute('class','whiteboard-curve-path');
    const attribute = tag === 'path' ? 'd' : 'points';
    const path = stroke ? inkCurve(item).path : curve ? connectionPath(item)
      : pathPoints(item).map(point => point.join(',')).join(' ');
    hitArea.setAttribute(attribute,path);
    line.setAttribute(attribute,path);
  }

  function releaseImage(node) {
    filePreviews?.remove(node);
    whiteboardHover.stopFor(node);
    videoCoverObserver.unobserve(node);
    if (videoReferences.has(node)) videoReviews.release(node.dataset.boardId);
    videoReferences.get(node)?.coverAbort.abort();
    videoReferences.delete(node);
    node.whiteboardAsset = null;
    node.whiteboardReferenceReady = null;
    if (node.whiteboardImageUrl) URL.revokeObjectURL(node.whiteboardImageUrl);
    node.whiteboardImageUrl = null;
    const video = node.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  function rememberVideoCover(key, url) {
    pinnedVideoFrames.delete(key);
    pinnedVideoFrames.set(key,url);
    if (pinnedVideoFrames.size > 24) pinnedVideoFrames.delete(pinnedVideoFrames.keys().next().value);
  }

  function videoCoverKey(workspace, assetId, time) {
    return JSON.stringify([workspace,assetId,Number(time.toFixed(3))]);
  }

  function queueVideoCover(reference) {
    const {coverAbort:{signal},coverTime,coverKey,asset,active,image} = reference;
    restoreVideoCovers = restoreVideoCovers.then(async () => {
      if (signal.aborted || !active() || !visible) return;
      const url = pinnedVideoFrames.get(coverKey) || await loadVideoCoverFrame(asset.playback,coverTime,signal);
      if (!url || signal.aborted || !active()) return;
      rememberVideoCover(coverKey,url);
      if (!reference.lastFrame) {
        image.src = url;
        image.hidden = false;
      }
    }).catch(() => {});
  }

  function finishVideoCoverPin(save) {
    const pending = pendingCoverPin;
    if (!pending) return;
    pendingCoverPin = null;
    clearTimeout(pending.timer);
    if (save) pending.save();
  }

  function clickVideoPreview(drag, event) {
    if (event?.pointerType !== 'mouse' || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const node = nodes.get(drag.clicked);
    if (!videoReferences.has(node)) return;
    if (drag.videoPreview) pinVideoCover(drag.clicked,drag.videoPreview.frame);
    else whiteboardHover.previewAt(node,event);
  }

  function pinVideoCover(id, frame) {
    const reference = videoReferences.get(nodes.get(id));
    const item = current(id);
    if (!frame || !item?.assetId || !reference?.video.paused) return;
    const {time,url} = frame;
    const text = writeVideoCover(item.text,time);
    const workspace = scope.workspaceKey;
    const revision = visibilityRevision;
    finishVideoCoverPin(pendingCoverPin?.id !== id);
    const save = () => {
      if (!visible || visibilityRevision !== revision || !reference.active() || current(id)?.assetId !== item.assetId) return;
      rememberVideoCover(videoCoverKey(workspace,item.assetId,time),url);
      if (current(id).text !== text) commit({id,patch:{text}});
    };
    pendingCoverPin = {id,save,timer:setTimeout(() => finishVideoCoverPin(true),500)};
  }

  function updateVideoCover(node, item, reference) {
    const {title,time} = readVideoCover(item.text);
    const key = time === null ? null : videoCoverKey(scope.workspaceKey,item.assetId,time);
    reference.image.alt = title || '白板图片';
    videoReviews.update(item.id);
    node.title = (reference.asset.name || title || '资产') + ' · 资产库引用';
    if (reference.coverKey === key) return;

    whiteboardHover.stopFor(node);
    videoCoverObserver.unobserve(node);
    reference.coverAbort.abort();
    reference.coverAbort = new AbortController();
    reference.coverTime = time;
    reference.coverKey = key;
    reference.lastFrame = null;
    const cached = key && pinnedVideoFrames.get(key);
    const url = cached || reference.asset.poster;
    if (url) reference.image.src = url;
    else reference.image.removeAttribute('src');
    reference.image.hidden = !url || !reference.video.hidden;
    if (key && !cached) videoCoverObserver.observe(node);
  }

  function attachReferenceVideo(node, clip, image, asset, item, active) {
    const video = document.createElement('video');
    video.className = 'whiteboard-image';
    video.playsInline = true;
    video.preload = 'none';
    video.hidden = true;
    const {time:coverTime} = readVideoCover(item.text);
    const {text:segmentTitle,range:segment} = readVideoClip(item.text);
    const coverKey = coverTime === null ? null : videoCoverKey(scope.workspaceKey,item.assetId,coverTime);
    const cachedCover = coverKey && pinnedVideoFrames.get(coverKey);
    if (cachedCover) image.src = cachedCover;
    else if (asset.poster) {
      if (!image.hasAttribute('src')) image.src = asset.poster;
    } else image.hidden = true;
    clip.append(video);
    const play = document.createElement('button');
    play.type = 'button';
    play.dataset.boardPlayVideo = '';
    const reference = {asset,active,clip,image,video,play,coverTime,coverKey,segment,
      assetId:item.assetId,imageId:item.imageId,coverAbort:new AbortController()};
    videoReferences.set(node,reference);
    if (coverKey && !cachedCover) videoCoverObserver.observe(node);
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
    if (segment) {
      const label = document.createElement('span');
      label.className = 'whiteboard-video-clip-label';
      label.textContent = `${segmentTitle} · ${formatTime(segment.start)}–${formatTime(segment.end)}`;
      label.title = `${segmentTitle} · ${segment.start.toFixed(3)}s–${segment.end.toFixed(3)}s`;
      node.append(label);
      if (openVideoSource) {
        const source = document.createElement('button');
        source.type = 'button';
        source.className = 'whiteboard-video-clip-source';
        source.dataset.boardOpenVideoSource = '';
        source.textContent = '打开原片';
        const workspace = scope.workspaceKey;
        source.addEventListener('click',() => {
          if (active() && visible) { video.pause(); openVideoSource(item.assetId,segment.start,workspace); }
        });
        node.append(source);
      }
      let monitor;
      function boundPlayback() {
        if (!active() || !visible || video.paused) return;
        const limit = Math.min(segment.end,video.duration);
        if (Number.isFinite(limit) && video.currentTime >= limit - .002) {
          video.pause();
          if (video.currentTime > limit) video.currentTime = limit;
          return;
        }
        if (video.currentTime < segment.start - .004) video.currentTime = segment.start;
      }
      function tick() {
        boundPlayback();
        if (active() && visible && !video.paused) monitor = requestAnimationFrame(tick);
      }
      video.addEventListener('playing',() => { cancelAnimationFrame(monitor); tick(); });
      video.addEventListener('timeupdate',boundPlayback);
      video.addEventListener('pause',() => cancelAnimationFrame(monitor));
    }
    play.addEventListener('click', async () => {
      whiteboardHover.stopFor(node);
      if (!video.paused) { video.pause(); return; }
      const revision = visibilityRevision;
      const stillVisible = () => active() && visible && revision === visibilityRevision;
      const segmentRestart = segment && (video.currentTime < segment.start || video.currentTime >= segment.end - .002);
      const startTime = video.hidden || video.ended || segmentRestart ? segment?.start ?? reference.lastFrame?.time ?? reference.coverTime ?? 0 : null;
      const startPlayback = () => {
        if (startTime !== null) {
          const end = Number.isFinite(video.duration) ? Math.max(0,video.duration - .05) : Infinity;
          if (segment && Number.isFinite(video.duration) && video.duration <= segment.start) throw Error('原片时长已改变');
          video.currentTime = Math.min(startTime,end);
        }
        return video.play();
      };
      play.disabled = true;
      try {
        if (!video.hasAttribute('src')) {
          const source = await asset.playback();
          if (!stillVisible()) return;
          for (const url of [source?.url, source?.fallbackUrl].filter(Boolean)) {
            video.src = url;
            try { await startPlayback(); break; } catch {}
            if (!stillVisible()) return;
          }
          if (video.paused) throw Error('视频暂时无法播放');
        } else await startPlayback();
        if (!stillVisible()) return;
        video.hidden = false;
        image.hidden = true;
      } catch {
        video.removeAttribute('src');
        video.load();
        video.hidden = true;
        image.hidden = !image.hasAttribute('src');
        if (stillVisible()) notify('引用的视频暂时无法播放。', true);
      } finally { play.disabled = false; }
    });
    node.append(play);
    videoReviews.attach({id:item.id,assetId:item.assetId,node,clip,video,image,asset,active,segment,initialTime:coverTime,
      title:readVideoCover(item.text).title || asset.name || '视频'});
  }

  function renderImage(node, item) {
    const target = scope;
    node.whiteboardAssetReference = Boolean(item.assetId);
    const prepared = preparedAssets.get(item.id);
    preparedAssets.delete(item.id);
    const clip = document.createElement('div');
    clip.className = 'whiteboard-image-clip';
    const image = prepared?.previewImage || document.createElement('img');
    image.className = 'whiteboard-image';
    const title = readVideoCover(item.text).title;
    image.alt = title || '白板图片';
    image.draggable = false;
    const crop = document.createElement('div');
    crop.className = 'whiteboard-crop-box';
    crop.hidden = true;
    crop.setAttribute('aria-hidden','true');
    clip.append(image);
    node.replaceChildren(clip, crop);
    const active = () => scope === target && clip.parentElement === node && node.isConnected;
    if (item.assetId) {
      node.whiteboardReferenceReady = Promise.resolve(prepared || resolveAssetImage(item.assetId,target.workspaceKey)).then(asset => {
        if (!active()) return;
        node.whiteboardAsset = asset;
        if (asset?.kind === 'video') attachReferenceVideo(node,clip,image,asset,item,active);
        else if (asset?.url) {
          if (!image.hasAttribute('src')) image.src = asset.url;
        } else throw Error('资产暂时无法读取');
        node.title = (readVideoClip(item.text).range ? title : asset.name || title || '资产') + ' · 资产库引用';
        if (asset.name && asset.name !== title) navigation.refresh(true);
      }).catch(() => {
        if (!active()) return;
        image.hidden = true;
        const fallback = document.createElement('span');
        fallback.className = 'whiteboard-reference-missing';
        fallback.textContent = title ? title + ' · 引用暂不可用' : '资产引用暂不可用';
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
    const color = boardColorOf(item);
    if (node.dataset.color !== color) {
      node.dataset.color = color;
      node.setAttribute('aria-label',`${kinds[item.kind]} · ${colors[color]}`);
    }
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
      if (videoReferences.has(node)) videoReviews.reposition(item.id);
    }
  }

  function render() {
    const board = items();
    const textAttachments = new Map();
    for (const item of board.values()) {
      const to = item.connection?.to;
      if (!to || textAttachments.has(to.id) || board.get(to.id)?.kind !== 'text' ||
          !isBoardConnectable(board.get(item.connection.from?.id)) || !Object.hasOwn(boardPorts,to.side) ||
          readBoardConnectionOffsets(item.text).to !== .5) continue;
      textAttachments.set(to.id,to.side);
    }
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
      if (item.kind === 'text') {
        const side = textAttachments.get(id);
        if (side !== node.dataset.boardTextSide) {
          if (side) node.dataset.boardTextSide = side;
          else delete node.dataset.boardTextSide;
        }
      }
      if (gesture?.mode === 'move') {
        place(node, item);
        const position = gesture.positions.get(id);
        if (position) translateMove(node,item,position);
      } else place(node, presentedItem(item));
      const signature = item.kind === 'image' ? JSON.stringify([item.imageId, item.assetId, item.text])
        : item.kind === 'stroke' || item.kind === 'arrow' ? JSON.stringify([item.width, item.height, item.points]) : item.text || '';
      if (editing?.id !== id && signature !== node.whiteboardContent) {
        node.whiteboardContent = signature;
        const reference = videoReferences.get(node);
        if (reference && item.kind === 'image' && item.assetId === reference.assetId && item.imageId === reference.imageId) {
          updateVideoCover(node,item,reference);
        } else itemContent(node, item);
      }
      if (item.kind === 'image') drawCropBox(node, gesture?.id === id ? gesture.region : null);
    }
    renderGroupFrames(board);
    renderConnections(board);
    empty.hidden = board.size > 0 || Boolean(gesture?.preview) || !scope?.loaded;
    empty.textContent = scope?.colorFilter && canvasItems().size && !review.presenting()
      ? '此颜色下没有元素，切回全部颜色可查看画布' : '粘贴图片，或选择工具开始';
    renderSelection(board);
    showSync();
    review.refresh();
    navigation.refresh();
  }

  function renderSelection(board = items()) {
    for (const id of selected) if (!board.has(id)) selected.delete(id);
    selected = extendGroupSelection(board,selected);
    updateNormalizeControls(board);
    const canAlign = canAlignSelection(board,selected);
    const canDock = !canAlign && canDockSelection(board,selected);
    const canOptimize = selected.size > 0 && canOptimizeArrangement(board,selected);
    const hasGroup = [...selected].some(id => board.get(id).groupId);
    groupButton.hidden = !canAlign || !canUseGroups();
    ungroupButton.hidden = !hasGroup || !canUseGroups();
    arrangeTools.hidden = groupButton.hidden && ungroupButton.hidden;
    alignmentTools.hidden = !canAlign && !canDock && !canOptimize;
    stackControl.hidden = !canAlign;
    for (const option of alignOptions) {
      const action = option.dataset.boardArrange;
      option.hidden = action === 'optimal' ? !canOptimize : !canAlign && (!canDock || !directionalAlignActions.has(action));
    }
    undoButton.disabled = !scope?.undo.length;
    redoButton.disabled = !scope?.redo.length;
    const imageOnly = selected.size > 0 && [...selected].every(id => board.get(id).kind === 'image');
    imageTools.hidden = !imageOnly;
    for (const button of imageTools.children) {
      button.disabled = !canTransformImages() || (button.dataset.boardImageAction === 'crop' && selected.size !== 1);
    }
    imageTools.firstElementChild.setAttribute('aria-pressed', String(cropMode));
    cropHint.hidden = !cropMode;
    stage.classList.toggle('is-cropping', cropMode || cropKey);
    const canResize = tool === 'select' && !cropMode && !cropKey && selected.size === 1;
    updateGroupOutline(board);
    updateConnectorEndpoints(board);
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
    const selectionColors = new Set([...selected].map(id => boardColorOf(board.get(id))));
    const active = selected.size ? (selectionColors.size === 1 ? selectionColors.values().next().value : null) : colorForNewItem();
    for (const button of panel.querySelectorAll('[data-board-color]')) {
      button.setAttribute('aria-pressed', String(button.dataset.boardColor === active));
      button.disabled = Boolean(scope?.colorFilter && !selected.size && button.dataset.boardColor !== scope.colorFilter);
    }
  }

  function arrangeSelection(action) {
    const board = items();
    const align = alignActions[action];
    let operations;
    if (action === 'optimal') { runOptimalArrangement(); return; }
    if (action === 'stack') operations = stackSelection(board,selected,stackSettings.current(),canTransformImages());
    else if (align) {
      const [,axis,edge] = align;
      operations = edge ? alignSelection(board,selected,axis,edge) : distributeSelection(board,selected,axis);
    } else {
      if (!canUseGroups()) { notify('请更新团队服务后使用组合。', true); return; }
      operations = action === 'group' ? groupSelected(board,selected,crypto.randomUUID())
        : ungroupSelected(board,selected);
    }
    commit(...operations);
    stage.focus({preventScroll:true});
  }

  function setNormalizeOpen(open, restoreFocus = false) {
    normalizePanel.hidden = !open;
    normalizeToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      [...normalizeSources].find(button => button.dataset.boardNormalizeSource === normalizeSource)?.focus({preventScroll:true});
    } else if (restoreFocus && !normalizeTools.hidden) normalizeToggle.focus({preventScroll:true});
  }

  function cancelNormalizeRequest() {
    const request = normalizeRequest;
    normalizeRequest = undefined;
    request?.controller.abort();
  }

  function normalizeRequestCurrent(request, board = items()) {
    return normalizeRequest === request && visible && scope === request.target && visibilityRevision === request.revision &&
      board === request.board && selected.size === request.selection.size &&
      [...selected].every((id,index) => id === request.order[index]);
  }

  function updateNormalizeControls(board) {
    if (normalizeRequest && !normalizeRequestCurrent(normalizeRequest,board)) cancelNormalizeRequest();
    const available = canNormalizeSelection(board,selected);
    normalizeTools.hidden = !available;
    normalizeScale.disabled = !available || !canNormalizeSelection(board,selected,'scale');
    normalizeToggle.setAttribute('aria-busy', String(Boolean(normalizeRequest)));
    normalizeToggle.setAttribute('aria-disabled', String(Boolean(normalizeRequest)));
    normalizeLabel.textContent = normalizeRequest ? '读取尺寸…' : '缩放对齐';
    if (!available && !normalizePanel.hidden) setNormalizeOpen(false);
  }

  function setNormalizeSource(source) {
    if (!Object.hasOwn(normalizeModes,source) || source === normalizeSource) return;
    cancelNormalizeRequest();
    normalizeSource = source;
    try { localStorage.setItem(normalizeModeKey,source); } catch {}
    for (const button of normalizeSources) {
      button.setAttribute('aria-pressed', String(button.dataset.boardNormalizeSource === source));
    }
    updateNormalizeControls(items());
  }

  async function runNormalize(action) {
    const board = items();
    if (!visible || !scope || gesture || !canNormalizeSelection(board,selected,action)) return;
    cancelNormalizeRequest();
    const selection = new Set(selected);
    const source = normalizeSource;
    if (action !== 'scale') {
      updateNormalizeControls(board);
      commit(...normalizeSelection(board,selection,action,source));
      return;
    }
    const target = scope;
    const controller = new AbortController();
    const request = {target,revision:visibilityRevision,board,selection,order:[...selection],controller};
    normalizeRequest = request;
    updateNormalizeControls(board);
    try {
      const mediaItems = normalizeScaleItems(board,selection);
      const dimensions = new Map();
      for (let index = 0; index < mediaItems.length; index += 4) {
        const batch = mediaItems.slice(index,index + 4);
        const sizes = await Promise.all(batch.map(item => {
          const node = nodes.get(item.id);
          return readWhiteboardMediaDimensions({
            item,node,videoReference:videoReferences.get(node),
            resolveAssetImage:() => resolveAssetImage(item.assetId,target.workspaceKey),
            imageUrl:() => media.url(target,item.imageId),signal:controller.signal,
          });
        }));
        if (!normalizeRequestCurrent(request)) return;
        if (sizes.some(size => !size || !(size.width > 0 && size.height > 0))) {
          notify('暂时无法读取全部素材的原始尺寸。',true);
          return;
        }
        for (const [position,item] of batch.entries()) dimensions.set(item.id,sizes[position]);
      }
      if (!normalizeRequestCurrent(request)) return;
      normalizeRequest = undefined;
      commit(...normalizeSelection(board,selection,action,source,dimensions));
    } catch {
      if (normalizeRequestCurrent(request)) notify('暂时无法读取全部素材的原始尺寸。',true);
    } finally {
      if (normalizeRequest === request) cancelNormalizeRequest();
      if (visible && scope === target) updateNormalizeControls(items());
    }
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

  function paintBounds(node, elements) {
    const box = unionBounds(elements.map(presentedItem));
    node.style.left = box.left + 'px';
    node.style.top = box.top + 'px';
    node.style.width = box.right - box.left + 'px';
    node.style.height = box.bottom - box.top + 'px';
    return box;
  }

  function positionSelectionTools() {
    if (!selectionBox || !scope?.view || alignmentTools.hidden) return;
    const viewport = chromeSizes.get(stage);
    const toolbar = chromeSizes.get(alignmentTools);
    if (!viewport?.width || !toolbar?.width) return;
    const {x,y,zoom} = scope.view;
    const left = selectionBox.left * zoom + x;
    const right = selectionBox.right * zoom + x;
    const top = selectionBox.top * zoom + y;
    const bottom = selectionBox.bottom * zoom + y;
    const visible = left < viewport.width && right > 0 && top < viewport.height && bottom > 0;
    alignmentTools.toggleAttribute('data-positioned',visible);
    if (!visible) return;

    const gap = 12;
    const maxLeft = Math.max(gap,viewport.width - toolbar.width - gap);
    const leftLimit = Math.min(maxLeft,gap * 2 + (chromeSizes.get(selectionChrome.sidebar)?.width || 0));
    const center = (clamp(left,0,viewport.width) + clamp(right,0,viewport.width)) / 2;
    const toolbarX = clamp(center - toolbar.width / 2,leftLimit,maxLeft);
    const topLimit = gap * 2 + (chromeSizes.get(selectionChrome.history)?.height || 0);
    const foot = Math.max(chromeSizes.get(alignmentDock)?.height || 0,chromeSizes.get(selectionChrome.zoom)?.height || 0);
    const maxTop = Math.max(topLimit,viewport.height - toolbar.height - foot - gap * 2);
    const above = top - toolbar.height - gap;
    const below = bottom + gap;
    const spaceAbove = top - topLimit;
    const spaceBelow = maxTop + toolbar.height - bottom;
    const topAt = below <= maxTop || (above < topLimit && spaceBelow > spaceAbove) ? below : above;
    const toolbarY = clamp(topAt,topLimit,maxTop);
    alignmentTools.style.transform = `translate3d(${Math.round(toolbarX)}px, ${Math.round(toolbarY)}px, 0)`;
  }

  function followSelectionTools(box) {
    selectionBox = box;
    const follow = Boolean(box);
    if (alignmentTools.hasAttribute('data-floating') !== follow) {
      const focus = alignmentTools.contains(document.activeElement) ? document.activeElement : null;
      alignmentTools.toggleAttribute('data-floating',follow);
      alignmentTools.toggleAttribute('data-pane-transient',follow);
      if (follow) shell.append(alignmentTools);
      else {
        alignmentTools.removeAttribute('data-positioned');
        alignmentTools.style.removeProperty('transform');
        alignmentDock.insertBefore(alignmentTools,normalizeTools);
      }
      focus?.focus({preventScroll:true});
    }
    positionSelectionTools();
  }

  const chromeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const sizes = entry.borderBoxSize?.[0];
      chromeSizes.set(entry.target,sizes ? {width:sizes.inlineSize,height:sizes.blockSize} : entry.contentRect);
    }
    positionSelectionTools();
  });
  for (const element of Object.values(selectionChrome)) chromeObserver.observe(element);

  function renderGroupFrames(board) {
    const groups = new Map();
    for (const item of board.values()) {
      if (!item.groupId || item.connection) continue;
      if (!groups.has(item.groupId)) groups.set(item.groupId, []);
      groups.get(item.groupId).push(item);
    }
    for (const [id,frame] of groupFrames) {
      if (groups.get(id)?.length >= 2) continue;
      frame.node.remove();
      groupFrames.delete(id);
    }
    for (const [id,members] of groups) {
      if (members.length < 2) continue;
      let frame = groupFrames.get(id);
      if (!frame) {
        const node = document.createElement('div');
        node.className = 'whiteboard-group-frame';
        node.hidden = id === outlinedGroup;
        frame = {node,members};
        groupFrames.set(id,frame);
        groupFrameLayer.append(node);
      } else frame.members = members;
      paintBounds(frame.node,members);
    }
  }

  function updateGroupOutline(board) {
    const entries = [...selected].map(id => board.get(id)).filter(item => item && !item.connection);
    const group = entries.length > 1 && entries[0].groupId;
    const matchingGroup = group && entries.every(item => item.groupId === group) ? group : undefined;
    if (outlinedGroup !== matchingGroup) {
      const before = groupFrames.get(outlinedGroup);
      if (before) {
        before.node.hidden = false;
        paintBounds(before.node,before.members);
      }
      outlinedGroup = matchingGroup;
      const now = groupFrames.get(outlinedGroup)?.node;
      if (now) now.hidden = true;
    }
    groupOutline.hidden = entries.length < 2;
    if (groupOutline.hidden) { followSelectionTools(null); return; }
    groupOutline.toggleAttribute('data-grouped', Boolean(matchingGroup));
    followSelectionTools(paintBounds(groupOutline,entries));
  }

  function visibleConnector(item, board) {
    const from = item.connection?.from;
    const to = item.connection?.to;
    const source = board.get(from?.id);
    const target = board.get(to?.id);
    if (!source || !target) return item;
    const origin = presentedItem(source);
    const destination = presentedItem(target);
    const offsets = readBoardConnectionOffsets(item.text);
    const preview = gesture?.mode === 'endpoint' && gesture.id === item.id && gesture.edge ? gesture : null;
    if (preview) offsets[preview.endpoint] = preview.edge.offset;
    const fromSide = preview?.endpoint === 'from' ? preview.edge.side : from.side;
    const toSide = preview?.endpoint === 'to' ? preview.edge.side : to.side;
    const start = boardPortPoint(origin,fromSide,offsets.from);
    const end = boardPortPoint(destination,toSide,offsets.to);
    return start && end ? {...item,...connectedGeometry(start,end,origin,fromSide,destination,toSide)} : item;
  }

  function showConnectorEndpoints(arrow) {
    connectorEndpoints.hidden = !arrow?.[connectorCurve];
    if (connectorEndpoints.hidden) return;
    for (const [index,handle] of endpointHandles.entries()) {
      handle.style.left = arrow.x + arrow.points[index][0] + 'px';
      handle.style.top = arrow.y + arrow.points[index][1] + 'px';
    }
    connectorMeasure.setAttribute('d',connectionShaft(arrow));
    const middle = connectorMeasure.getPointAtLength(connectorMeasure.getTotalLength() / 2);
    connectorCut.style.left = arrow.x + middle.x + 'px';
    connectorCut.style.top = arrow.y + middle.y + 'px';
  }

  function updateConnectorEndpoints(board) {
    const id = selected.size === 1 ? selected.values().next().value : null;
    const item = board.get(id);
    const show = item?.connection && tool === 'select' && !linkStart && !cropMode && !cropKey && canUseConnections();
    connectorEndpoints.dataset.connectorId = show ? id : '';
    showConnectorEndpoints(show ? visibleConnector(item,board) : null);
  }

  function renderConnector(item,board) {
    const node = nodes.get(item.id);
    if (!node) return;
    const arrow = visibleConnector(item,board);
    place(node,arrow);
    const signature = JSON.stringify([arrow.width,arrow.height,arrow.points,arrow[connectorCurve]]);
    if (signature !== node.whiteboardContent) {
      node.whiteboardContent = signature;
      itemContent(node,arrow);
    }
    if (connectorEndpoints.dataset.connectorId === item.id) showConnectorEndpoints(arrow);
  }

  function renderConnections(board, moved) {
    for (const item of board.values()) {
      if (!item.connection) continue;
      if (moved && !moved.has(item.connection.from?.id) && !moved.has(item.connection.to?.id)) continue;
      renderConnector(item,board);
    }
  }

  function previewConnectorEndpoint(drag, point) {
    if (!drag.edge && Math.hypot(point.x - drag.start.x,point.y - drag.start.y) * scope.view.zoom < 2) return;
    const board = items();
    const item = board.get(drag.id);
    const binding = item?.connection?.[drag.endpoint];
    const card = board.get(binding?.id);
    if (binding?.id !== drag.cardId || !isBoardConnectable(card)) return;
    const location = {x:point.x + drag.grab.x,y:point.y + drag.grab.y};
    drag.edge = nearestBoardEdge(card,location,drag.edge?.side ?? binding.side);
    renderConnector(item,board);
  }

  function moveConnectorEndpoint(item,endpoint,position) {
    const binding = item?.connection?.[endpoint];
    if (!binding || !position || !canUseConnections()) return false;
    const offsets = readBoardConnectionOffsets(item.text);
    const offset = Math.round(clamp(position.offset,0,1) * 1_000_000) / 1_000_000;
    if (binding.side === position.side && offsets[endpoint] === offset) return false;
    offsets[endpoint] = offset;
    const patch = {text:writeBoardConnectionOffsets(offsets)};
    if (position.side !== binding.side) patch.connection = {...item.connection,[endpoint]:{...binding,side:position.side}};
    commit({id:item.id,patch});
    return true;
  }

  function setLinkStart(value) {
    linkStart = value;
    linkHint.hidden = !value;
    stage.classList.toggle('is-linking',Boolean(value));
    for (const [id,node] of nodes) {
      for (const port of node.querySelectorAll('[data-board-port]')) port.tabIndex = value || selected.has(id) ? 0 : -1;
    }
    updateConnectorEndpoints(items());
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
    const port = node.closest('[data-board-port]')?.dataset.boardPort;
    return {id,...(port ? {side:port,offset:.5} : nearestBoardEdge(item,point))};
  }

  function connectItems(from,to) {
    if (!canUseConnections() || !to || from.id === to.id) return;
    const board = items();
    const start = boardPortPoint(board.get(from.id),from.side,from.offset);
    const end = boardPortPoint(board.get(to.id),to.side,to.offset);
    if (!start || !end) return;
    const connection = {from:{id:from.id,side:from.side},to:{id:to.id,side:to.side}};
    const text = writeBoardConnectionOffsets({from:from.offset,to:to.offset});
    add({kind:'arrow',...arrowGeometry(start,end),color:colorForNewItem(),connection,...(text && {text})});
  }

  function previewConnection(drag, event, point) {
    if (!drag.active && Math.hypot(point.x - drag.start.x,point.y - drag.start.y) * scope.view.zoom < 4) return;
    drag.active = true;
    const target = connectionTarget(event,drag.from,point);
    const destination = target && current(target.id);
    const end = destination && boardPortPoint(destination,target.side,target.offset) || point;
    const arrow = {kind:'arrow',...connectedGeometry(drag.start,end,current(drag.from.id),drag.from.side,destination,target?.side),color:colorForNewItem()};
    place(drag.preview,arrow);
    paintStroke(drag.preview,arrow);
    drag.preview.hidden = false;
    drag.to = target;
  }

  function dismissNodePicker(restoreFocus = false) {
    if (!pendingNode) return;
    pendingNode.preview.remove();
    pendingNode = null;
    nodePicker.hidden = true;
    if (restoreFocus) stage.focus({preventScroll:true});
  }

  function openNodePicker(drag, event) {
    const hit = document.elementFromPoint(event.clientX,event.clientY);
    if (!stage.contains(hit) || hit.closest('[data-board-id]')) return false;
    if (records().size + 2 > limits.items) {
      notify('白板空间不足，添加连接节点需要两个空位。', true);
      return false;
    }
    dismissNodePicker();
    pendingNode = {scope,revision:visibilityRevision,from:drag.from,
      point:world(event.clientX,event.clientY),preview:drag.preview};
    nodePicker.hidden = false;
    const bounds = stage.getBoundingClientRect();
    nodePicker.style.left = clamp(event.clientX - bounds.left + 9,4,Math.max(4,bounds.width - nodePicker.offsetWidth - 4)) + 'px';
    nodePicker.style.top = clamp(event.clientY - bounds.top + 7,4,Math.max(4,bounds.height - nodePicker.offsetHeight - 4)) + 'px';
    nodePicker.querySelector('button').focus({preventScroll:true});
    return true;
  }

  function insertConnectedNode(request, patch, asset) {
    if (!visible || request.scope !== scope || request.revision !== visibilityRevision || !canUseConnections()) return;
    const {from,point} = request;
    const board = items();
    const start = boardPortPoint(board.get(from.id),from.side);
    if (!start) return;
    if (records().size + 2 > limits.items) {
      notify('白板空间不足，添加连接节点需要两个空位。', true);
      return;
    }
    const side = facingBoardPort(start,point);
    const [portX,portY] = boardPorts[side];
    const id = crypto.randomUUID();
    const node = {...patch,x:coordinate(point.x - patch.width * (1 + portX) / 2),
      y:coordinate(point.y - patch.height * (1 + portY) / 2),color:colorForNewItem()};
    const to = {id,side};
    const arrow = {kind:'arrow',...arrowGeometry(start,boardPortPoint(node,side)),color:colorForNewItem(),connection:{from,to}};
    if (asset) preparedAssets.set(id,asset);
    selected = new Set([id]);
    commit({id,patch:node},{id:crypto.randomUUID(),patch:arrow});
    if (patch.kind === 'image' || readWhiteboardFile(patch.text)) stage.focus({preventScroll:true});
    else edit(id);
  }

  nodePicker.addEventListener('click', event => {
    const kind = event.target.closest('[data-board-node-kind]')?.dataset.boardNodeKind;
    if (!pendingNode || !kind) return;
    const request = pendingNode;
    dismissNodePicker(true);
    if (kind === 'image') {
      pendingNodeImage = request;
      nodeImage.click();
    } else {
      insertConnectedNode(request,{kind,width:kind === 'note' ? 195 : 255,height:kind === 'note' ? 145 : 80,text:''});
    }
  });
  nodePicker.addEventListener('keydown', event => {
    if (!['Escape','ArrowUp','ArrowDown','Home','End','Enter',' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return dismissNodePicker(true);
    if (event.key === 'Enter' || event.key === ' ') {
      if (!event.repeat) event.target.closest('button')?.click();
      return;
    }
    const buttons = [...nodePicker.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + buttons.length + (event.key === 'ArrowUp' ? -1 : 1)) % buttons.length;
    buttons[next].focus({preventScroll:true});
  });
  nodePicker.addEventListener('focusout', event => {
    if (!nodePicker.contains(event.relatedTarget)) dismissNodePicker();
  });
  document.addEventListener('pointerdown', event => {
    if (!nodePicker.contains(event.target)) dismissNodePicker();
    if (!normalizePanel.hidden && !normalizeTools.contains(event.target)) setNormalizeOpen(false);
  }, {capture:true});
  normalizeTools.addEventListener('focusout', event => {
    if (!normalizePanel.hidden && !normalizeTools.contains(event.relatedTarget)) setNormalizeOpen(false);
  });
  normalizeTools.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || (normalizePanel.hidden && !normalizeRequest)) return;
    event.preventDefault();
    event.stopPropagation();
    cancelNormalizeRequest();
    updateNormalizeControls(items());
    setNormalizeOpen(false,true);
  });
  nodeImage.addEventListener('cancel', () => { pendingNodeImage = null; });
  nodeImage.addEventListener('change', () => {
    const request = pendingNodeImage;
    const file = nodeImage.files[0];
    pendingNodeImage = null;
    nodeImage.value = '';
    if (!request || !file || scope !== request.scope || visibilityRevision !== request.revision) return;
    insertMedia(async () => {
      try {
        if (request.scope.teamId) {
          const {teamId,workspaceKey} = request.scope;
          const available = () => visible && scope === request.scope && visibilityRevision === request.revision &&
            items().has(request.from.id) && records().size + 2 <= limits.items;
          if (!available() || !importPastedFiles) return;
          const result = await importPastedFiles({teamId,workspaceKey,files:[file],paths:[],available,limit:1});
          const reference = result?.files?.[0];
          if (!available() || !reference) return;
          const asset = await prepareReferenceMedia(reference.assetId,request.scope);
          if (!available()) return;
          if (asset) {
            const scale = Math.min(1,680 / asset.width,480 / asset.height);
            insertConnectedNode(request,{kind:'image',assetId:reference.assetId,text:(asset.name || '').slice(0,limits.text),
              width:length(asset.width * scale),height:length(asset.height * scale)},asset);
          } else {
            const text = reference.file?.teamId === teamId && writeWhiteboardFile(reference.file);
            if (text) insertConnectedNode(request,{kind:'text',text,width:272,height:64});
          }
          return;
        }
        const {id,width,height} = await media.prepare(request.scope,file);
        const scale = Math.min(1,680 / width,480 / height);
        insertConnectedNode(request,{kind:'image',imageId:id,text:file.name.slice(0,limits.text),
          width:length(width * scale),height:length(height * scale)});
      } catch (failure) { notify(String(failure?.message || '无法读取这张图片。'),true); }
    });
  });

  function paintView() {
    cancelAnimationFrame(viewFrame);
    viewFrame = 0;
    if (!scope) return;
    const {x,y,zoom} = scope.view;
    const pitch = 24 * zoom;
    const offset = value => ((value + 72) % pitch + pitch) % pitch;
    plane.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
    presence.paint(scope.view);
    grid.style.transform = `translate3d(${offset(x)}px, ${offset(y)}px, 0)`;
    if (paintedZoom !== zoom) {
      paintedZoom = zoom;
      plane.style.setProperty('--board-control-scale', Math.min(1, 1 / zoom));
      grid.style.backgroundSize = `${pitch}px ${pitch}px`;
      zoomLabel.textContent = Math.round(zoom * 100) + '%';
    }
    positionSelectionTools();
    review.requestMap();
  }

  function world(clientX, clientY, bounds = stage.getBoundingClientRect()) {
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
    const available = limits.items - records().size;
    if (entries.length > available) notify('白板最多可添加 500 个项目。', true);
    const operations = entries.slice(0, available).map((patch,index) => ({id:itemIds[index] || crypto.randomUUID(),
      patch:scope.colorFilter && !patch.color ? {...patch,color:scope.colorFilter} : patch}));
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

  async function insertMedia(operation, ...args) {
    pendingMedia++;
    try {
      return await operation(...args);
    } finally {
      pendingMedia--;
    }
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
      const room = limits.items - records().size;
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

  async function insertExternalFiles({files = [], paths = [], drop = false, readClipboard = false}, point) {
    const target = scope;
    const revision = visibilityRevision;
    const available = () => visible && target === scope && revision === visibilityRevision;
    const handler = drop ? handleDroppedFiles : importPastedFiles;
    if (!available() || !target) return true;
    if (target.teamId) {
      if (handler) {
        const limit = limits.items - records().size;
        if (!limit) { notify('白板最多可添加 500 个项目。', true); return true; }
        try {
          const result = await handler({teamId:target.teamId, workspaceKey:target.workspaceKey,
            files,paths,readClipboard,available,limit});
          if (!available()) return true;
          if (result != null) {
            if (result.files?.length) await insertAssetReferences(result,point);
            return true;
          }
        } catch (failure) {
          if (available()) notify(String(failure?.message || failure || '暂时无法添加这批白板文件。'), true);
          return true;
        }
      }
      return Boolean(paths.length || files.length);
    }
    if (paths.length) await insertImages(nativeImages(paths),point);
    else if (files.length) await insertImages(files,point);
    else return false;
    return true;
  }

  async function prepareReferenceMedia(assetId, target) {
    if (!assetId || !canUseAssetReferences()) return null;
    const asset = await resolveAssetImage(assetId,target.workspaceKey).catch(() => null);
    if (!asset) return null;
    const previewImage = new Image();
    const video = asset.kind === 'video';
    const source = video ? asset.poster : asset.url;
    if (source) {
      previewImage.src = source;
      try { await previewImage.decode(); } catch {}
    }
    return {...asset,previewImage,width:previewImage.naturalWidth || (video ? 480 : 320),
      height:previewImage.naturalHeight || (video ? 270 : 240)};
  }

  async function insertAssetReferences(references, point, placement, availableNow = () => true) {
    const target = scope;
    const revision = visibilityRevision;
    const current = () => visible && target === scope && revision === visibilityRevision && availableNow();
    if (!target || references.workspaceKey !== target.workspaceKey) {
      notify('请在这组资产所在的库里打开白板后添加引用。', true);
      return;
    }
    const sources = [...(references.assetIds || []).map(assetId => ({assetId})), ...(references.files || []), ...(references.clips || [])];
    const canUseAssets = canUseAssetReferences();
    if (!canUseAssets && sources.every(source => !source.file)) {
      notify('请确认团队白板已联网，并更新团队服务以添加资产引用。', true);
      return;
    }
    const available = limits.items - records().size;
    if (sources.length > available) notify('白板最多可添加 500 个项目。', true);
    const entries = [];
    const assets = new Map();
    let offset = placement ? 32 : 0;
    for (const {assetId,file,segment,title} of sources.slice(0, available)) {
      if (!current()) return;
      const asset = await prepareReferenceMedia(assetId,target);
      if (segment && asset?.kind !== 'video') continue;
      if (!asset) {
        const text = file?.teamId === target.teamId && writeWhiteboardFile(file);
        if (text) {
          entries.push({kind:'text',text,x:coordinate(point.x + offset),y:coordinate(point.y + offset),
            width:272,height:64,color:colorForNewItem()});
          offset += 32;
        }
        continue;
      }
      const {width,height} = asset;
      const lead = placement?.assetId === assetId;
      const scale = lead ? Math.min(placement.width / width, placement.height / height) : Math.min(1,680 / width,480 / height);
      const itemWidth = length(width * scale);
      const itemHeight = length(height * scale);
      const x = point.x + (lead ? -itemWidth * placement.gripX : offset);
      const y = point.y + (lead ? -itemHeight * placement.gripY : offset);
      const text = segment ? writeVideoClip(title,segment) : (asset.name || '').slice(0,limits.text);
      entries.push({kind:'image',assetId,text,
        x:coordinate(x),y:coordinate(y),width:itemWidth,height:itemHeight});
      assets.set(assetId,asset);
      if (!lead) offset += 32;
    }
    if (!current()) return;
    if (entries.length < Math.min(available,sources.length)) notify('有些文件引用暂时无法读取。', true);
    return insertItems(entries,assets);
  }

  async function addIndexedReferences({key,teamId,projectId},assets,stillRequested) {
    if (!stillRequested()) return 0;
    const state = states.get(key);
    const target = teamId && {teamId,...(projectId !== 'default' && {projectId})};
    let before;
    if (target) {
      const snapshot = await api('team_whiteboard_get',target);
      if (!stillRequested()) return 0;
      if (!snapshot?.assetReferences) throw Error('当前团队白板尚未支持资产引用');
      if (!Array.isArray(snapshot.items) || !Number.isSafeInteger(snapshot.revision)) throw Error('团队白板返回了无效数据');
      if (state?.queue.length) throw Error('此白板还有尚未同步的更改，请同步后再试');
      before = fromItems(snapshot.items);
    } else {
      if (state?.storageError) throw Error('此白板还有未保存的更改，请保存后再试');
      before = loadPersonal(key,true);
    }
    if (before.size + assets.length > limits.items) throw Error('白板已接近容量上限，请减少选择后再试');
    const bounds = [...before.values()].filter(item => !isWhiteboardRegion(item)).map(itemBounds);
    const top = bounds.length ? Math.max(...bounds.map(bound => bound.bottom)) + 48 : 0;
    const left = bounds.length ? Math.min(...bounds.map(bound => bound.left)) : 0;
    const operations = assets.map(({id:assetId,name,kind},index) => ({id:crypto.randomUUID(),patch:{
      kind:'image',assetId,text:name.slice(0,limits.text),x:coordinate(left + (index % 4) * 344),
      y:coordinate(top + Math.floor(index / 4) * 264),width:320,height:kind === 'video' ? 180 : 240,
    }}));
    if (!stillRequested()) return 0;
    let next;
    if (target) {
      const snapshot = await api('team_whiteboard_apply',{...target,operations,batchId:crypto.randomUUID()});
      if (!Array.isArray(snapshot?.items) || !Number.isSafeInteger(snapshot.revision)) throw Error('无法确认团队白板的保存结果');
      next = fromItems(snapshot.items);
      if (!operations.every(({id,patch}) => next.get(id)?.assetId === patch.assetId))
        throw Error('团队白板未返回新增引用，请查看目标白板');
      if (state?.busy || state?.revision > snapshot.revision) return operations.length;
      if (state) state.revision = snapshot.revision;
    } else {
      next = applyOperations(before,operations);
      writePersonalItems(key,next);
    }
    if (state) {
      state.base = next;
      state.board = undefined;
      state.undo.push(boardHistoryEntry(before,next,operations));
      if (state.undo.length > limits.history) state.undo.shift();
      state.redo.length = 0;
      if (scope === state && visible) render();
    }
    return operations.length;
  }

  function duplicateEntries(source, point, sharedImages) {
    let entries = [...fromItems(source).values()].filter(item => {
      const file = item.kind === 'text' && readWhiteboardFile(item.text);
      if (file) return sharedImages && file.teamId === scope?.teamId;
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
    const available = limits.items - records().size;
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

  function selectionKind(item) {
    if (item.kind === 'image') {
      return videoReferences.has(nodes.get(item.id)) || readVideoClip(item.text).range ? 'video' : 'image';
    }
    if (item.kind !== 'text') return item.kind;
    const file = readWhiteboardFile(item.text);
    if (file) return file.isFolder ? 'folder' : 'file';
    return readWhiteboardLink(item.text) ? 'link' : 'text';
  }

  const matchingSelections = {
    k:{label:'选中同类元素',shortcut:'Shift+K',property:selectionKind},
    b:{label:'选中同色元素',shortcut:'Shift+B',property:boardColorOf},
  };

  function matchingValue(board,property,id) {
    if (id) {
      const item = board.get(id);
      return item && property(item);
    }
    let value;
    for (const selectedId of selected) {
      const item = board.get(selectedId);
      if (!item) continue;
      const next = property(item);
      if (value && value !== next) return;
      value = next;
    }
    return value;
  }

  function selectMatching(property,id) {
    if (!visible || !scope || gesture || editing || review.presenting()) return;
    const board = items();
    const value = matchingValue(board,property,id);
    if (!value) return;
    whiteboardHover.stop();
    if (linkStart) setLinkStart(null);
    cropMode = cropKey = cropAdjustKey = false;
    beforeFocus = focusedImage = undefined;
    selected = new Set(id ? [id] : selected);
    for (const item of board.values()) {
      if (property(item) === value) selected.add(item.id);
    }
    setTool('select');
    stage.focus({preventScroll:true});
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
    const text = entries.every(item => ['note','text'].includes(item.kind) && !readWhiteboardFile(item.text))
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
      await insertMedia(insertAssetReferences, references, point);
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
      if (!sameWorkspace && content.items.some(item => item?.kind === 'image' || readWhiteboardFile(item?.text))) {
        notify('文件引用可在同一个库的项目之间复制。', true);
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
      text:value,color:colorForNewItem()}]);
  }

  async function pasteClipboardPayload({files,json,text}, point) {
    const target = scope;
    const revision = visibilityRevision;
    if (!json && !parseWhiteboardAssetClipboard(text) && (!text || localClipboard?.text !== text)) {
      if (await insertMedia(insertExternalFiles,{files,readClipboard:true},point)) return;
    }
    if (target === scope && revision === visibilityRevision && visible) await pasteContents(json,text,point);
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
      await pasteClipboardPayload({files,json,text},point);
    } catch {
      if (!visible || scope !== target) return;
      if (localClipboard) await pasteContents('', localClipboard.text, point);
      else if (!await insertMedia(insertExternalFiles,{readClipboard:true},point)) notify('请在画布按 Ctrl+V 粘贴。', true);
    }
  }

  function boardClipboardEvent(event) {
    const target = event.target;
    return visible && scope && !review.presenting() && (target === stage || panel.contains(target)) &&
      !target.closest('textarea,input,[contenteditable="true"]') && !document.querySelector('dialog[open]');
  }

  document.addEventListener('paste', event => {
    if (!boardClipboardEvent(event) || !event.clipboardData) return;
    const files = [...event.clipboardData.files];
    if (!files.length) {
      for (const item of event.clipboardData.items) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    event.preventDefault();
    const point = insertionPoint();
    pasteClipboardPayload({files,json:event.clipboardData.getData(clipboardType),
      text:event.clipboardData.getData('text/plain')},point);
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
    insertMedia(insertExternalFiles,{files:[...event.dataTransfer.files],drop:true},insertionPoint({x:event.clientX,y:event.clientY}));
  });
  imagePicker.addEventListener('cancel', () => { pendingContextImage = undefined; });
  imagePicker.addEventListener('change', () => {
    const request = pendingContextImage;
    pendingContextImage = undefined;
    if (imagePicker.files.length && (!request || request.scope === scope && request.revision === visibilityRevision)) {
      insertMedia(insertExternalFiles,{files:[...imagePicker.files]},request?.point || insertionPoint());
    }
    imagePicker.value = '';
  });

  function zoomAt(x, y, value, deferPaint = false) {
    if (!scope) return;
    const view = scope.view;
    const zoom = clamp(value, .2, 3);
    if (zoom === view.zoom) return;
    const scale = zoom / view.zoom;
    view.x = x - (x - view.x) * scale;
    view.y = y - (y - view.y) * scale;
    view.zoom = zoom;
    if (!deferPaint) paintView();
    else if (!viewFrame) viewFrame = requestAnimationFrame(paintView);
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

  function captureRegion() {
    const {x,y,zoom} = scope.view;
    const entries = selectedItems();
    const geometry = (left,top,right,bottom) => ({x:coordinate(left),y:coordinate(top),
      width:length(right-left),height:length(bottom-top)});
    let selection;
    if (entries.length) {
      const boxes = entries.map(itemBounds);
      const padding = 48 / zoom;
      selection = geometry(Math.min(...boxes.map(box => box.left))-padding,Math.min(...boxes.map(box => box.top))-padding,
        Math.max(...boxes.map(box => box.right))+padding,Math.max(...boxes.map(box => box.bottom))+padding);
    }
    return {view:geometry(-x/zoom,-y/zoom,(stage.clientWidth-x)/zoom,(stage.clientHeight-y)/zoom),
      selection,shot:suggestedRegionShot(entries)};
  }

  function jumpToRegion(id,shot) {
    if (!visible || !scope?.view || editing || gesture || review.presenting()) return false;
    const region = readWhiteboardRegion(records().get(id));
    if (!region || (shot && region.shot !== shot) || !stage.clientWidth || !stage.clientHeight) return false;
    const {x,y,width,height} = region.item;
    const zoom = clamp(Math.min(stage.clientWidth/width,stage.clientHeight/height),.2,3);
    beforeFocus = focusedImage = undefined;
    scope.view = {x:stage.clientWidth/2-zoom*(x+width/2),y:stage.clientHeight/2-zoom*(y+height/2),zoom};
    paintView();
    const target = scope;
    requestAnimationFrame(() => { if (scope === target && visible) stage.focus({preventScroll:true}); });
    return true;
  }

  function jumpToBoardResult(entry,rename) {
    if (!canOpenNavigation()) return false;
    if (entry.region) return jumpToRegion(entry.itemId);
    const item = canvasItems().get(entry.itemId);
    if (!item || rename && (item.kind !== 'frame' || !canEditRegions())) return false;
    if (!items().has(item.id)) changeColorFilter('');
    whiteboardHover.stop();
    setLinkStart(null);
    cropMode = cropKey = cropAdjustKey = zoomKey = spaceDown = false;
    beforeFocus = focusedImage = undefined;
    selected = new Set([item.id]);
    setTool('select');
    fitView([item],item.kind === 'frame' ? 2 : 1.25);
    const target = scope;
    const revision = visibilityRevision;
    const stillCurrent = () => visible && target === scope && revision === visibilityRevision &&
      selected.size === 1 && selected.has(item.id) && !review.presenting() && !navigation.isOpen();
    requestAnimationFrame(() => {
      if (!stillCurrent()) return;
      if (rename) edit(item.id);
      else stage.focus({preventScroll:true});
    });
    if (entry.noteId) {
      void Promise.resolve(nodes.get(item.id)?.whiteboardReferenceReady).then(async () => {
        if (!stillCurrent()) return;
        try {
          if (!await videoReviews.locateNote(item.id,entry.noteId,stillCurrent) && stillCurrent()) {
            notify('已定位标注所在卡片，原片画面暂不可用。',true);
          }
        } catch (failure) { if (stillCurrent()) notify(String(failure?.message || failure),true); }
      });
    }
    return true;
  }

  function optimizeCanvas() {
    if (!visible || !scope || gesture) return;
    beforeFocus = focusedImage = undefined;
    fitView([...items().values()].filter(item => !item.connection));
    stage.focus({preventScroll:true});
  }

  function runOptimalArrangement(all = false) {
    if (!visible || !scope || gesture) return;
    const ratio = Math.max(1,stage.clientWidth - 160) / Math.max(1,stage.clientHeight - 110);
    const operations = optimizeArrangement(items(),all ? new Set() : selected,ratio,canTransformImages());
    commit(...operations);
    if (all) optimizeCanvas();
    else stage.focus({preventScroll:true});
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
    if (next !== 'select') whiteboardHover.stop();
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
    if (!node || !item || node.hasAttribute('data-board-file-card') || !['note','text','frame'].includes(item.kind)) return;
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
      if (event.isComposing) return;
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
        height:length(Math.max(...points.map(p => p[1])) + 4),color:colorForNewItem()};
    }
    const sized = Math.hypot(point.x - start.x, point.y - start.y) > 10;
    if (kind === 'arrow') {
      const end = sized ? point : {x:start.x + 110,y:start.y};
      return {kind,...arrowGeometry(start,end),color:colorForNewItem()};
    }
    return {kind,x:coordinate(sized ? Math.min(point.x, start.x) : start.x),
      y:coordinate(sized ? Math.min(point.y, start.y) : start.y),color:colorForNewItem(),
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
    if (records().size >= limits.items) { notify('白板最多可添加 500 个项目。', true); return; }
    const id = crypto.randomUUID();
    selected = new Set(item.kind === 'stroke' ? [] : [id]);
    commit({id,patch:item});
    if (['note','text','frame'].includes(item.kind)) {
      setTool('select');
      edit(id);
    }
  }

  function addTextAt(kind, point) {
    add({kind,x:coordinate(point.x),y:coordinate(point.y),width:kind === 'note' ? 195 : 255,
      height:kind === 'note' ? 145 : 80,text:'',color:colorForNewItem()});
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

  function translateMove(node,item,position) {
    node.style.translate = `${position.x - item.x}px ${position.y - item.y}px`;
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
    const board = items();
    let movedGroups;
    for (const [id, origin] of drag.origins) {
      const position = {x:coordinate(origin.x + dx),y:coordinate(origin.y + dy)};
      const previous = drag.positions.get(id);
      if (previous?.x === position.x && previous.y === position.y) continue;
      drag.positions.set(id, position);
      const item = board.get(id);
      const frame = groupFrames.get(item?.groupId);
      if (frame && !frame.node.hidden) (movedGroups ??= new Set()).add(frame);
      const node = nodes.get(id);
      if (node) translateMove(node,item,position);
    }
    if (movedGroups) for (const frame of movedGroups) paintBounds(frame.node,frame.members);
    if (!groupOutline.hidden) updateGroupOutline(board);
    renderConnections(board,drag.origins);
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
    const board = items();
    const frame = groupFrames.get(board.get(drag.id)?.groupId);
    if (frame && !frame.node.hidden) paintBounds(frame.node,frame.members);
    if (!groupOutline.hidden) updateGroupOutline(board);
    renderConnections(board,new Set([drag.id]));
  }

  function endGesture(commitChange = false, event) {
    const drag = gesture;
    if (!drag) return;
    gesture = undefined;
    cancelAnimationFrame(gestureFrame);
    gestureFrame = 0;
    gestureEvent = undefined;
    stage.classList.remove('is-panning');
    if (stage.hasPointerCapture(drag.pointer)) stage.releasePointerCapture(drag.pointer);
    if (drag.mode === 'pan' || drag.mode === 'zoom') return;
    if (drag.mode === 'endpoint') {
      delete connectorEndpoints.dataset.dragging;
      const item = current(drag.id);
      if (commitChange && item?.connection?.[drag.endpoint]?.id === drag.cardId &&
          current(drag.cardId) && moveConnectorEndpoint(item,drag.endpoint,drag.edge)) return;
      if (item?.connection) renderConnector(item,items());
      return;
    }
    if (drag.mode === 'move') {
      for (const id of drag.positions.keys()) nodes.get(id)?.style.removeProperty('translate');
    }
    if (drag.mode === 'link' && commitChange && drag.active && !drag.to && event && openNodePicker(drag,event)) return;
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
      renderSelection();
      return;
    } else if (commitChange && drag.mode === 'move') {
      if (!drag.active) {
        clickVideoPreview(drag,event);
        if (!drag.additive) selected = new Set([drag.clicked]);
        else if (drag.wasSelected) {
          for (const id of extendGroupSelection(items(),new Set([drag.clicked]))) selected.delete(id);
        }
        renderSelection();
        return;
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
    const selection = new Set(drag.additive ? drag.before : []);
    for (const [id, item] of board) {
      if (intersectsMarquee(item.connection ? visibleConnector(item,board) : item, bounds)) selection.add(id);
    }
    const next = extendGroupSelection(board,selection);
    if (next.size !== selected.size || [...next].some(id => !selected.has(id))) {
      selected = next;
      renderSelection(board);
    }
  }

  stage.addEventListener('pointerdown', event => {
    const videoPreview = whiteboardHover.stop();
    if (normalizeRequest) {
      cancelNormalizeRequest();
      updateNormalizeControls(items());
    }
    if (!scope || gesture || !event.isPrimary || ![0,1].includes(event.button) ||
        event.target.closest('.whiteboard-editor,.whiteboard-node-picker,[data-board-play-video],[data-board-open-video-source],[data-board-open-link],[data-board-reveal-file],[data-board-cut-connector]')) return;
    if (viewFrame) paintView();
    event.preventDefault();
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
      const endpoint = event.target.closest('[data-board-endpoint]')?.dataset.boardEndpoint;
      if (endpoint) {
        const connector = board.get(connectorEndpoints.dataset.connectorId);
        const binding = connector?.connection?.[endpoint];
        const card = board.get(binding?.id);
        const anchor = boardPortPoint(card,binding?.side,readBoardConnectionOffsets(connector?.text)[endpoint]);
        if (!anchor || !canUseConnections()) return;
        gesture = {mode:'endpoint',pointer,id:connector.id,endpoint,cardId:card.id,start:point,
          grab:{x:anchor.x - point.x,y:anchor.y - point.y}};
        connectorEndpoints.dataset.dragging = endpoint;
        stage.setPointerCapture(pointer);
        return;
      }
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
        gesture = {mode:'move',pointer,clicked:id,start:point,origins,positions:new Map(),additive:event.shiftKey,wasSelected,
          videoPreview:videoPreview?.thumb === nodes.get(id) ? videoPreview : null};
        if (focusedImage !== id) beforeFocus = focusedImage = undefined;
        renderSelection(board);
      }
    } else if (tool === 'eraser') {
      const strokes = [...items()].filter(([, item]) => item.kind === 'stroke')
        .map(([id,item]) => [id,{...item,points:inkCurve(item).points}]);
      gesture = {mode:'erase',pointer,point,strokes,ids:new Set()};
      eraseStrokes(gesture, point);
    } else if (tool === 'note' || tool === 'text') {
      addTextAt(tool,point);
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
  function paintGesture() {
    cancelAnimationFrame(gestureFrame);
    gestureFrame = 0;
    const event = gestureEvent;
    gestureEvent = undefined;
    const drag = gesture;
    if (!event || !drag) return;
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
    const bounds = stage.getBoundingClientRect();
    const point = world(event.clientX, event.clientY, bounds);
    if (drag.mode === 'move') {
      previewMove(drag, point, event.shiftKey);
    } else if (drag.mode === 'link') {
      previewConnection(drag,event,point);
    } else if (drag.mode === 'endpoint') {
      previewConnectorEndpoint(drag,point);
    } else if (drag.mode === 'marquee') {
      updateMarquee(drag, point);
    } else if (drag.mode === 'erase') {
      for (const sample of drag.samples) eraseStrokes(drag, world(sample.clientX,sample.clientY,bounds));
      drag.samples.length = 0;
    } else if (drag.id) {
      if (drag.position || drag.region || Math.hypot(point.x - drag.start.x, point.y - drag.start.y) * scope.view.zoom >= 2) {
        previewImageGesture(drag, point, event);
      }
    } else if (drag.mode === 'draw') {
      if (drag.kind === 'stroke') {
        for (const sample of drag.samples) sampleStroke(drag,world(sample.clientX,sample.clientY,bounds));
        drag.samples.length = 0;
      }
      drag.item = drawItem(drag, point);
      place(drag.preview, drag.item);
      if (drag.kind === 'stroke' || drag.kind === 'arrow') paintStroke(drag.preview, drag.item);
    }
  }

  stage.addEventListener('pointermove', event => {
    const drag = gesture;
    if (event.pointerId !== drag?.pointer) return;
    if (drag.mode === 'erase' || drag.kind === 'stroke') {
      drag.samples ??= [];
      const samples = event.getCoalescedEvents?.();
      if (samples?.length) drag.samples.push(...samples);
      else drag.samples.push(event);
    }
    gestureEvent = event;
    if (!gestureFrame) gestureFrame = requestAnimationFrame(paintGesture);
  });
  stage.addEventListener('pointerup', event => {
    if (gesture?.pointer !== event.pointerId) return;
    if (gestureFrame) paintGesture();
    if (gesture.mode === 'move' && gesture.active) {
      previewMove(gesture, world(event.clientX,event.clientY),event.shiftKey);
    }
    if (gesture.mode === 'erase') eraseStrokes(gesture, world(event.clientX, event.clientY));
    if (gesture.mode === 'link') previewConnection(gesture,event,world(event.clientX,event.clientY));
    if (gesture.mode === 'endpoint') previewConnectorEndpoint(gesture,world(event.clientX,event.clientY));
    if (gesture.mode === 'draw' && gesture.kind === 'stroke') {
      const point = world(event.clientX,event.clientY);
      sampleStroke(gesture,point,true);
      gesture.item = drawItem(gesture,point);
    }
    if (gesture.id && (gesture.position || gesture.region)) {
      previewImageGesture(gesture, world(event.clientX, event.clientY),event);
    }
    endGesture(true,event);
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
    const item = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-board-id]');
    if (pendingCoverPin?.id === item?.dataset.boardId) finishVideoCoverPin(false);
    if (tool === 'select' && !event.shiftKey && !event.target.closest('.whiteboard-editor,[data-board-port],[data-board-endpoint],[data-board-play-video],[data-board-open-video-source],[data-board-open-link],[data-board-reveal-file],[data-board-cut-connector]')) {
      if (!plane.contains(item)) return;
      whiteboardHover.stop();
      const entry = current(item.dataset.boardId);
      const reference = videoReferences.get(item);
      if (reference?.segment) reference.play.click();
      else if (entry?.kind === 'image') toggleImageFocus([entry]);
      else if (item.hasAttribute('data-board-file-card')) item.querySelector('[data-board-reveal-file]')?.click();
      else edit(item.dataset.boardId);
    }
  });
  stage.addEventListener('wheel', event => {
    if (!scope || gesture || event.target.closest('.whiteboard-editor')) return;
    event.preventDefault();
    whiteboardHover.stop();
    dismissNodePicker(true);
    const bounds = stage.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 130 : 1);
    zoomAt(event.clientX - bounds.left,event.clientY - bounds.top,scope.view.zoom * Math.exp(-clamp(delta,-250,250) * .002),true);
  }, {passive:false});
  stage.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.target.closest('.whiteboard-editor')) return;
    const control = event.ctrlKey || event.metaKey;
    const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (event.key === 'Escape' && normalizeRequest) {
      event.preventDefault();
      cancelNormalizeRequest();
      updateNormalizeControls(items());
      return;
    }
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
    const endpoint = event.target.closest('[data-board-endpoint]')?.dataset.boardEndpoint;
    if (endpoint && !control && !event.altKey && /^Arrow(Left|Right|Up|Down)$/.test(event.key)) {
      const connector = current(connectorEndpoints.dataset.connectorId);
      const binding = connector?.connection?.[endpoint];
      const card = current(binding?.id);
      const anchor = boardPortPoint(card,binding?.side,readBoardConnectionOffsets(connector?.text)[endpoint]);
      if (!anchor || !canUseConnections()) return;
      event.preventDefault();
      const step = (event.shiftKey ? 12 : 2) / scope.view.zoom;
      const x = anchor.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0);
      const y = anchor.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
      moveConnectorEndpoint(connector,endpoint,nearestBoardEdge(card,{x,y},binding.side));
      return;
    }
    if (event.target !== stage) return;
    if (!control && event.shiftKey && !event.altKey && Object.hasOwn(matchingSelections,key)) {
      event.preventDefault();
      if (!event.repeat) selectMatching(matchingSelections[key].property);
      return;
    }
    if (!control && event.altKey && event.shiftKey && (key === 'h' || key === 'v')) {
      event.preventDefault();
      doImageAction(key === 'h' ? 'flipX' : 'flipY');
      return;
    }
    if (control) {
      if (!event.altKey && !event.shiftKey && key === 'o') {
        event.preventDefault();
        if (!event.repeat) optimizeCanvas();
      } else if (!event.shiftKey && key === 'p') {
        event.preventDefault();
        if (!event.repeat) runOptimalArrangement(event.altKey);
      } else if (!event.altKey && key === 'g') {
        event.preventDefault();
        if (!event.repeat) arrangeSelection(event.shiftKey ? 'ungroup' : 'group');
      } else if (!event.altKey && !event.shiftKey && Object.hasOwn(alignKeys,event.key)) {
        event.preventDefault();
        arrangeSelection(alignKeys[event.key]);
      } else if (event.altKey && event.shiftKey && Object.hasOwn(distributeKeys,event.key)) {
        event.preventDefault();
        if (!event.repeat) arrangeSelection(distributeKeys[event.key]);
      } else if (event.altKey && !event.shiftKey && Object.hasOwn(normalizeKeys,event.key)) {
        const action = normalizeKeys[event.key];
        if (canNormalizeSelection(items(),selected,action)) {
          event.preventDefault();
          if (!event.repeat) void runNormalize(action);
        }
      } else if (event.altKey && !event.shiftKey && key === 's') {
        event.preventDefault();
        if (!event.repeat) arrangeSelection('stack');
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
      const cancelCrop = cropMode || cropKey || ['crop','link','endpoint'].includes(gesture?.mode);
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
  (panel.closest('.whiteboard-project-editor') || panel).addEventListener('keydown',event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey ||
      !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' ||
      event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (navigation.open()) event.preventDefault();
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
    cancelNormalizeRequest();
    setNormalizeOpen(false);
    endGesture();
    dismissNodePicker();
    setLinkStart(null);
    cropKey = cropAdjustKey = false;
    zoomKey = spaceDown = false;
    setTool(tool);
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const {boardTool,boardColor,boardView,boardHistory,boardImageAction,boardArrange,boardNormalize,boardNormalizeSource} = button.dataset;
    if (button === connectorCut) {
      const connector = current(connectorEndpoints.dataset.connectorId);
      if (connector?.connection && !connectorEndpoints.hidden) {
        commit({id:connector.id,delete:true});
        stage.focus({preventScroll:true});
      }
    } else if (button === stackPreferencesButton) stackSettings.open();
    else if (button === normalizeToggle) {
      if (!normalizeRequest) {
        const open = normalizePanel.hidden;
        setNormalizeOpen(open);
        if (!open) stage.focus({preventScroll:true});
      }
    } else if (boardNormalizeSource) setNormalizeSource(boardNormalizeSource);
    else if (boardNormalize) {
      setNormalizeOpen(false);
      stage.focus({preventScroll:true});
      void runNormalize(boardNormalize);
    } else if (boardHistory) { changeHistory(boardHistory); stage.focus({preventScroll:true}); }
    else if (boardArrange) arrangeSelection(boardArrange);
    else if (boardImageAction) doImageAction(boardImageAction);
    else if (boardTool) { setTool(boardTool); stage.focus({preventScroll:true}); }
    else if (boardColor) {
      activeColor = boardColor;
      if (selected.size) commit(...[...selected].map(id => ({id,patch:{color:boardColor}})));
      else renderSelection();
    } else if (boardView && scope) {
      if (boardView === 'fit') optimizeCanvas();
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

  function retryMissingAssetReferences() {
    for (const node of nodes.values()) {
      if (node.whiteboardAssetReference && node.querySelector('.whiteboard-reference-missing')) {
        node.whiteboardContent = null;
      }
    }
  }

  function show() {
    if (!scope.view) fitView();
    else paintView();
    retryMissingAssetReferences();
    render();
    sync();
  }

  return {
    busyForUpdate() {
      return Boolean(review.presenting() || videoReviews.isOpen() || replaceImage?.isOpen() || regions.isOpen() || navigation.isOpen() || gesture || editing || pendingMedia || pendingNode || pendingNodeImage || pendingCoverPin || normalizeRequest || stackSettings.isOpen() ||
        [...states.values()].some(state => state.storageError && (!state.teamId || state.queue.length)) ||
        [...stage.querySelectorAll('video')].some(video => !video.paused && !video.ended));
    },
    refresh() {
      if (!visible) return;
      retryMissingAssetReferences();
      render();
      sync();
    },
    addIndexedReferences:(target,assets,stillRequested) => insertMedia(addIndexedReferences,target,assets,stillRequested),
    showRegions:regions.open,
    async focusShotRegion(id,shot,stillRequested) {
      const target = scope;
      const revision = visibilityRevision;
      if (!visible || !target || !stillRequested()) return false;
      if (target.teamId) await sync(target);
      return visible && target === scope && revision === visibilityRevision && stillRequested() &&
        !target.error && jumpToRegion(id,shot);
    },
    dropNativeImages(paths, position) {
      if (!visible || !scope || review.presenting()) return false;
      const point = position ? {x:position.x / window.devicePixelRatio,y:position.y / window.devicePixelRatio} : undefined;
      insertMedia(insertExternalFiles,{paths,drop:true},insertionPoint(point));
      return true;
    },
    dropAssetReferences(references, offset) {
      if (!visible || !scope?.view || review.presenting()) return false;
      const {left,top} = stage.getBoundingClientRect();
      const zoom = scope.view.zoom;
      const placement = offset.media && {...offset.media, width:offset.media.width / zoom, height:offset.media.height / zoom};
      return insertMedia(insertAssetReferences, references, world(left + offset.x, top + offset.y), placement);
    },
    async addVideoClip({workspaceKey,id,title,start,end},stillRequested) {
      const target = scope;
      const revision = visibilityRevision;
      const segment = videoClipRange(start,end);
      const current = () => visible && target === scope && revision === visibilityRevision && stillRequested() && !review.presenting();
      if (!segment || !current() || workspaceKey !== target?.workspaceKey) return false;
      if (target.teamId && !target.loaded) await sync(target);
      if (!current()) return false;
      if (!canUseAssetReferences()) throw Error('当前团队白板尚未确认支持资产引用，请连接团队服务后再试');
      return insertMedia(insertAssetReferences,{workspaceKey,clips:[{assetId:id,title,segment}]},insertionPoint(),null,current);
    },
    dropLink(text, offset) {
      if (!visible || !scope?.view || review.presenting()) return false;
      const {left,top} = stage.getBoundingClientRect();
      const point = world(left + offset.x, top + offset.y);
      const patch = whiteboardLinkPatch(text, {x:coordinate(point.x), y:coordinate(point.y)});
      return patch ? insertItems([patch]) : false;
    },
    contextMenu(event) {
      if (!visible || !scope || !stage.contains(event.target)) return null;
      if (!normalizePanel.hidden) setNormalizeOpen(false);
      const clicked = event.target.closest('[data-board-id]')?.dataset.boardId;
      if (clicked && !selected.has(clicked)) {
        selected = new Set([clicked]);
        setTool('select');
        renderSelection();
      }
      const board = items();
      const selection = selectedItems();
      const images = selection.filter(item => item.kind === 'image');
      const point = insertionPoint(event.type === 'contextmenu' ? {x:event.clientX,y:event.clientY} : undefined);
      const revision = visibilityRevision;
      const target = scope;
      const available = () => visible && scope === target && revision === visibilityRevision;
      const editActions = [['notes', '粘贴', () => pasteFromClipboard(point), 'Ctrl+V']];
      const createActions = [
        ['notes', '新建便签', () => addTextAt('note',point)],
        ['list', '新建文字', () => addTextAt('text',point)],
        ['picture', '添加图片…', () => { pendingContextImage = {scope,revision,point}; imagePicker.click(); }, 'Ctrl+I'],
        ['edit', '画笔工具', () => setTool('stroke'), 'P'],
      ];
      const item = clicked && current(clicked);
      const link = item?.kind === 'text' && readWhiteboardLink(item.text);
      const file = item?.kind === 'text' && readWhiteboardFile(item.text);
      if (selection.length) editActions.unshift(
        ['copy', '复制', () => copySelected(), 'Ctrl+C'],
        ['edit', '剪切', () => { if (copySelected()) deleteSelected(); }, 'Ctrl+X'],
      );
      if (link && openLink) editActions.unshift(['drag-out', '在浏览器打开', () => openLink(link.url)]);
      if (file && revealPastedFile && file.teamId === target.teamId) {
        editActions.unshift(['folder',file.isFolder ? '打开共享文件夹' : '在共享文件夹中定位', () => {
          if (available() && current(clicked)?.text === item.text) return revealPastedFile(file);
        }]);
      }
      if (item?.kind === 'image' && item.assetId && locateAsset) {
        editActions.unshift(['locate', '在资产库中定位', () => locateAsset(item.assetId,
          () => available() && current(clicked)?.assetId === item.assetId)]);
      }
      if (selection.length === 1 && canReplaceImage(item)) editActions.unshift(['picture','替换参考图…',() => showReplaceImage(item)]);

      const canAlign = canAlignSelection(board,selected);
      const canDock = !canAlign && canDockSelection(board,selected);
      const canOptimize = canOptimizeArrangement(board,selected);
      const arrange = Object.entries(alignActions).filter(([id]) => id === 'optimal' ? canOptimize
        : canAlign || (canDock && directionalAlignActions.has(id)))
        .map(([id,[label,,,glyph,shortcut]]) => [glyph,label,() => arrangeSelection(id),shortcut]);
      arrange.push(['sliders',stackSettingsLabel,() => stackSettings.open()]);
      const groupActions = [];
      if (canUseGroups()) {
        if (canAlign) groupActions.push(['stack','成组',() => arrangeSelection('group'),'Ctrl+G']);
        if (selection.some(item => item.groupId)) {
          groupActions.push(['stack','解组',() => arrangeSelection('ungroup'),'Ctrl+Shift+G']);
        }
      }
      const transforms = images.length && canTransformImages() ? Object.entries(imageActions)
        .filter(([id]) => id !== 'crop' || images.length === 1)
        .map(([id,[label,glyph,shortcut]]) => [glyph,label,() => doImageAction(id),shortcut]) : [];
      const normalization = canNormalizeSelection(board,selected) ? [
        ...Object.entries(normalizeModes).map(([id,label]) =>
          [normalizeSource === id ? 'check' : 'locate',label,() => setNormalizeSource(id)]),
        ...Object.entries(normalizeActions).map(([id,[label,glyph,shortcut]]) =>
          [glyph,label,() => runNormalize(id),shortcut,!canNormalizeSelection(board,selected,id)]),
      ] : [];
      const view = [
        ['locate', '全选', () => { selected = new Set(items().keys()); setTool('select'); }, 'Ctrl+A', !board.size],
        ['expand', '优化画布', optimizeCanvas, 'Ctrl+O', !board.size],
        ['grid', '全部优化排列并适应画布', () => runOptimalArrangement(true), 'Ctrl+Alt+P', !canOptimizeArrangement(board,new Set())],
        ['picture', '实际大小', () => zoomAt(stage.clientWidth / 2,stage.clientHeight / 2,1), 'Ctrl+0'],
      ];
      if (images.length) view.push(['locate','聚焦所选图片',() => toggleImageFocus(images),'Space']);

      const tools = [['plus','添加元素','create'], ['whiteboard','画布与选择','view']];
      if (arrange.length) tools.push(['stack','对齐与排列','arrange']);
      if (normalization.length) tools.push(['expand','缩放对齐','normalize']);
      if (transforms.length) tools.push(['sliders','图片变换','transform']);
      const selectedActions = selection.length ? [
        ...Object.values(matchingSelections)
          .filter(({property}) => !review.presenting() && matchingValue(board,property,clicked))
          .map(({label,shortcut,property}) => ['locate',label,() => selectMatching(property,clicked),shortcut]),
        ...groupActions,
        ['plus', '复制一份', duplicateSelected, 'Ctrl+D'],
        ['trash', '删除选中项', deleteSelected, 'Delete'],
      ] : [];
      return {anchor:stage,label:'白板操作',actions:{
        available,
        context:{name:selection.length ? `已选 ${selection.length} 个元素` : '白板画布', detail:'', glyph:'whiteboard'},
        sections:[['编辑',editActions], ['画布',tools], ['所选元素',selectedActions]],
        submenus:{create:['添加元素',createActions],view:['画布与选择',view],arrange:['对齐与排列',arrange],
          normalize:['缩放对齐',normalization],transform:['图片变换',transforms]},
      }};
    },
    setVisible(value) {
      if (visible === value) return;
      if (!value) {
        review.exit(false);
        navigation.close();
        replaceImage?.close();
        regions.close();
        videoReviews.close();
        stackSettings.close();
        cancelNormalizeRequest();
        setNormalizeOpen(false);
        presence.setContext(scope,false);
        finishVideoCoverPin(true);
      }
      visibilityRevision++;
      if (!value) {
        whiteboardHover.stop();
        cancelAnimationFrame(viewFrame);
        viewFrame = 0;
        dismissNodePicker();
        pendingNodeImage = null;
        stopEditing(true);
        endGesture();
        setLinkStart(null);
        cropMode = cropKey = cropAdjustKey = zoomKey = spaceDown = false;
        for (const node of nodes.values()) {
          const reference = videoReferences.get(node);
          if (!reference) continue;
          const {video,image,coverKey} = reference;
          video.pause();
          if (video.hasAttribute('src')) {
            video.removeAttribute('src');
            video.load();
          }
          video.hidden = true;
          image.hidden = !image.hasAttribute('src');
          reference.coverAbort.abort();
          if (coverKey && !pinnedVideoFrames.has(coverKey)) {
            reference.coverAbort = new AbortController();
            videoCoverObserver.observe(node);
          }
        }
        setTool(tool);
      }
      visible = value;
      filePreviews?.setVisible(value);
      if (value && scope) {
        show();
        presence.setContext(scope,true);
      }
    },
    setScope({key,teamId,projectId,workspaceKey = key}) {
      if (!key || scope?.key === key) return;
      review.exit(false);
      navigation.reset();
      replaceImage?.close();
      regions.close();
      videoReviews.close();
      stackSettings.close();
      cancelNormalizeRequest();
      setNormalizeOpen(false);
      presence.setContext(scope,false);
      finishVideoCoverPin(true);
      whiteboardHover.stop();
      dismissNodePicker();
      pendingNodeImage = null;
      stopEditing(true);
      endGesture();
      setLinkStart(null);
      selected.clear();
      cropMode = cropKey = cropAdjustKey = zoomKey = spaceDown = false;
      beforeFocus = focusedImage = undefined;
      setTool('select');
      if (!states.has(key)) states.set(key, {key,teamId,projectId,workspaceKey,base:teamId ? new Map() : loadPersonal(key),
        ...(teamId ? loadOutbox(key, teamId) : {queue:[]}),loaded:!teamId,error:'',undo:[],redo:[],
        order:new Map(),nextOrder:0,colorFilter:readColorFilter(key)});
      scope = states.get(key);
      if (colorFilter) colorFilter.value = scope.colorFilter;
      for (const node of nodes.values()) {
        releaseImage(node);
        node.remove();
      }
      nodes.clear();
      groupFrames.clear();
      groupFrameLayer.replaceChildren();
      outlinedGroup = undefined;
      if (visible) {
        show();
        presence.setContext(scope,true);
      } else sync();
    },
  };
}
