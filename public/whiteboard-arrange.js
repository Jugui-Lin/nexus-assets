import {imageBounds, normalizeImageTransform} from './whiteboard-image-transform.js';

const coordinateLimit = 1_000_000;
export const itemGap = 8;
const positionTolerance = 1e-7;
const dimensionLimit = 100_000;
const dockableKinds = new Set(['image','note','text','rect','ellipse']);
export const stackPreferenceFields = Object.freeze({
  stagger:{value:16,max:64,label:'叠放距离',unit:' px'},
  variation:{value:28,max:50,label:'位置错落',unit:'%'},
  rotation:{value:4,max:12,label:'随机倾斜',unit:'°'},
});

export function stackPreferences(value) {
  return Object.fromEntries(Object.entries(stackPreferenceFields).map(([key,field]) => {
    const raw = value?.[key];
    return [key,Number.isFinite(raw) ? Math.max(0,Math.min(field.max,Math.round(raw))) : field.value];
  }));
}

function selectedGroupIds(board, selection) {
  const groups = new Set();
  for (const id of selection) {
    const item = board.get(id);
    if (item?.groupId && !item.connection) groups.add(item.groupId);
  }
  return groups;
}

export function extendGroupSelection(board, selection) {
  const expanded = new Set([...selection].filter(id => board.has(id)));
  const groups = selectedGroupIds(board, expanded);
  if (groups.size) {
    for (const [id, item] of board) {
      if (groups.has(item.groupId) && !item.connection) expanded.add(id);
    }
  }
  return expanded;
}

export function selectedUnits(board, selection) {
  const units = new Map();
  for (const id of extendGroupSelection(board, selection)) {
    const item = board.get(id);
    if (!item || item.connection) continue;
    const key = item.groupId ? 'group:' + item.groupId : 'item:' + id;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(item);
  }
  return [...units.values()];
}

export function canAlignSelection(board, selection) {
  return selectedUnits(board, selection).length > 1;
}

export function canDockSelection(board, selection) {
  return selectedUnits(board,selection).some(unit => unit.some(item => dockableKinds.has(item.kind)));
}

export function groupSelected(board, selection, groupId) {
  const units = selectedUnits(board, selection);
  if (units.length < 2 || !groupId) return [];
  return units.flatMap(unit => unit.filter(item => item.groupId !== groupId)
    .map(({id}) => ({id,patch:{groupId}})));
}

export function ungroupSelected(board, selection) {
  const groups = selectedGroupIds(board, selection);
  if (!groups.size) return [];
  return [...board.values()].filter(item => !item.connection && groups.has(item.groupId))
    .map(({id}) => ({id,patch:{groupId:''}}));
}

function unitRange(unit, axis) {
  const horizontal = axis === 'x';
  const ranges = unit.map(item => {
    if (item.kind !== 'image') return [item[axis], item[axis] + (horizontal ? item.width : item.height)];
    const bounds = imageBounds(item);
    return horizontal ? [bounds.left, bounds.right] : [bounds.top, bounds.bottom];
  });
  return [Math.min(...ranges.map(([start]) => start)), Math.max(...ranges.map(([,end]) => end))];
}

function movableRange(unit, axis) {
  const [start,end] = unitRange(unit,axis);
  const positions = unit.map(item => item[axis]);
  return {start,end,size:end - start,
    min:start - coordinateLimit - Math.min(...positions),
    max:start + coordinateLimit - Math.max(...positions)};
}

function unitRanges(items) {
  return {items,x:movableRange(items,'x'),y:movableRange(items,'y')};
}

function orderedUnits(board, selection, axis) {
  const cross = axis === 'x' ? 'y' : 'x';
  return selectedUnits(board,selection).map(unitRanges)
    .sort((a,b) => a[axis].start - b[axis].start || a[cross].start - b[cross].start);
}

function packedStarts(ranges) {
  let latest = Infinity;
  // Leave room for the remaining items even when the last is near the canvas limit.
  for (let index = ranges.length - 1; index >= 0; index--) {
    const {min,max,size} = ranges[index];
    latest = Math.min(max,latest - size - itemGap);
    if (latest < min) return null;
  }
  let next = Math.min(latest,ranges[0].start);
  return ranges.map(({min,size}) => {
    const start = Math.max(min,next);
    next = start + size + itemGap;
    return start;
  });
}

function moveUnit(unit, axis, start, cross, crossStart, roundPositions = true) {
  const offset = start - unit[axis].start;
  const crossOffset = crossStart - unit[cross].start;
  const translate = (value,distance) => {
    if (Math.abs(distance) < positionTolerance) return value;
    const position = value + distance;
    return roundPositions ? Math.round(position * 10) / 10
      : Math.max(-coordinateLimit,Math.min(coordinateLimit,position));
  };
  return unit.items.flatMap(item => {
    const patch = {};
    const position = translate(item[axis],offset);
    const crossPosition = translate(item[cross],crossOffset);
    if (position !== item[axis]) patch[axis] = position;
    if (crossPosition !== item[cross]) patch[cross] = crossPosition;
    return Object.keys(patch).length ? [{id:item.id,patch}] : [];
  });
}

function directionalRange(range, reverse) {
  if (!reverse) return range;
  const {start,end,size,min,max} = range;
  return {start:-end, end:-start, size, min:-max-size, max:-min-size};
}

function overlaps(a,b) {
  return Math.min(a.end,b.end) - Math.max(a.start,b.start) > positionTolerance;
}

function slideUnit(unit, axis, distance) {
  if (Math.abs(distance) < positionTolerance) return [];
  return unit.items.map(item => ({id:item.id,patch:{
    [axis]:Math.max(-coordinateLimit,Math.min(coordinateLimit,item[axis] + distance)),
  }}));
}

function dockUnit(board, unit, axis, cross, reverse) {
  if (!unit.items.some(item => dockableKinds.has(item.kind))) return [];
  const range = directionalRange(unit[axis],reverse);
  const moving = new Set(unit.items.map(item => item.id));
  let edge = -Infinity;
  for (const neighbor of board.values()) {
    if (moving.has(neighbor.id) || neighbor.connection || !dockableKinds.has(neighbor.kind)) continue;
    const lane = movableRange([neighbor],cross);
    if (!overlaps(unit[cross],lane)) continue;
    const obstacle = directionalRange(movableRange([neighbor],axis),reverse);
    if (obstacle.start >= range.start) continue;
    if (obstacle.end > range.start + positionTolerance) return [];
    edge = Math.max(edge,obstacle.end + itemGap);
  }
  if (edge < range.min || edge >= range.start - positionTolerance) return [];
  return slideUnit(unit,axis,(edge - range.start) * (reverse ? -1 : 1));
}

function packTowardEdge(units, axis, cross, reverse) {
  const lanes = units.map(unit => ({unit,range:directionalRange(unit[axis],reverse),cross:unit[cross]}))
    .sort((a,b) => a.range.start - b.range.start || a.cross.start - b.cross.start);
  // Work back from the coordinate limits so each colliding lane has room to fit.
  for (let i = lanes.length - 1; i >= 0; i--) {
    const lane = lanes[i];
    lane.latest = lane.range.max;
    for (let j = i + 1; j < lanes.length; j++) {
      if (overlaps(lane.cross,lanes[j].cross)) lane.latest = Math.min(lane.latest,lanes[j].latest - lane.range.size - itemGap);
    }
    if (lane.latest < lane.range.min) return [];
  }
  const edge = Math.min(lanes[0].range.start,...lanes.map(lane => lane.latest));
  const operations = [];
  for (const [index,lane] of lanes.entries()) {
    let start = Math.max(edge,lane.range.min);
    for (let j = 0; j < index; j++) {
      if (overlaps(lane.cross,lanes[j].cross)) start = Math.max(start,lanes[j].end + itemGap);
    }
    lane.end = start + lane.range.size;
    operations.push(...slideUnit(lane.unit,axis,(start - lane.range.start) * (reverse ? -1 : 1)));
  }
  return operations;
}

export function alignSelection(board, selection, axis, alignment) {
  if (!['x','y'].includes(axis) || !['start','center','end'].includes(alignment)) return [];
  const cross = axis === 'x' ? 'y' : 'x';
  const units = orderedUnits(board,selection,cross);
  if (!units.length) return [];
  if (alignment !== 'center') {
    const reverse = alignment === 'end';
    return units.length === 1 ? dockUnit(board,units[0],axis,cross,reverse) : packTowardEdge(units,axis,cross,reverse);
  }
  if (units.length < 2) return [];
  const crossRanges = units.map(unit => unit[cross]);
  const crossStarts = packedStarts(crossRanges);
  if (!crossStarts) return [];
  const first = Math.min(...units.map(unit => unit[axis].start));
  const last = Math.max(...units.map(unit => unit[axis].end));
  const target = (first + last) / 2;
  return units.flatMap((unit,index) => {
    const {min,max,size} = unit[axis];
    const start = Math.max(min,Math.min(max,target - size / 2));
    return moveUnit(unit,axis,start,cross,crossStarts[index]);
  });
}

function centeredStart({min,max,size}, center) {
  return Math.max(min,Math.min(max,center - size / 2));
}

export function distributeSelection(board, selection, axis) {
  if (!['x','y'].includes(axis)) return [];
  const cross = axis === 'x' ? 'y' : 'x';
  const units = orderedUnits(board,selection,axis);
  if (units.length < 2) return [];
  const ranges = units.map(unit => unit[axis]);
  const crossRanges = units.map(unit => unit[cross]);
  const center = (Math.min(...crossRanges.map(range => range.start)) + Math.max(...crossRanges.map(range => range.end))) / 2;
  const starts = packedStarts(ranges);
  if (!starts) return [];
  return units.flatMap((unit,index) => moveUnit(unit,axis,starts[index],cross,centeredStart(unit[cross],center)));
}

function stackStarts(units, axis, offsets, currentCenter) {
  const ranges = units.map(unit => unit[axis]);
  const min = Math.max(...ranges.map((range,index) => range.min - offsets[index]));
  const max = Math.min(...ranges.map((range,index) => range.max - offsets[index]));
  if (min > max) return null;
  const stackCenter = (Math.min(...offsets) + Math.max(...ranges.map((range,index) => offsets[index] + range.size))) / 2;
  const anchor = Math.max(min,Math.min(max,currentCenter - stackCenter));
  return offsets.map(offset => anchor + offset);
}

function stackFraction(key, channel) {
  let hash = channel;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index),16777619);
  hash = Math.imul(hash ^ (hash >>> 16),0x45d9f3b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

function stackJitter(units, axis, distance, variation) {
  const gapLimit = Math.min(...units.map(unit => unit[axis].size / 2));
  let distanceFromFront = 0;
  const offsets = new Array(units.length);
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index];
    if (index < units.length - 1) {
      const random = stackFraction(unit.key,axis === 'x' ? 2166136261 : 1392393599);
      const factor = 1 + (random * 2 - 1) * variation / 100;
      distanceFromFront += Math.min(gapLimit,distance * factor);
    }
    offsets[index] = distanceFromFront;
  }
  return offsets;
}

function tiltStackUnit(unit, amount, direction) {
  const [item] = unit.items;
  if (!amount || unit.items.length !== 1 || item.groupId || item.kind !== 'image') return unit;
  const imageTransform = normalizeImageTransform(item.imageTransform);
  if (imageTransform.rotation) return unit;
  const sample = stackFraction(unit.key,3718424891);
  imageTransform.rotation = direction * Math.round(amount * (3.5 + sample * 6.5)) / 10;
  return {...unit,...unitRanges([{...item,imageTransform}]),imageTransform};
}

function stackCenter(units, axis) {
  const min = Math.min(...units.map(unit => unit[axis].start));
  const max = Math.max(...units.map(unit => unit[axis].end));
  return (min + max) / 2;
}

export function stackSelection(board, selection, preferences, canRotate = false) {
  const layerOrder = new Map([...board.keys()].map((id,index) => [id,index]));
  const original = selectedUnits(board,selection).map(items => ({
    key:items[0].groupId || items[0].id,
    ...unitRanges(items), layer:Math.max(...items.map(item => layerOrder.get(item.id))),
  })).sort((back,front) => back.layer - front.layer);
  if (original.length < 2) return [];
  const {stagger,variation,rotation} = stackPreferences(preferences);
  const front = original.length - 1;
  const firstDirection = stackFraction(original[front].key,3927836827) < .5 ? -1 : 1;
  const units = original.map((unit,index) => canRotate && index < front
    ? tiltStackUnit(unit,rotation,(front - index) % 2 ? firstDirection : -firstDirection) : unit);
  const offsetX = stackJitter(units,'x',stagger,variation);
  const offsetY = stackJitter(units,'y',stagger,variation);
  // Keep each rear card's top/right edge exposed, even when it is much smaller than the front card.
  const x = stackStarts(units,'x',units.map((unit,index) => offsetX[index] - unit.x.size),stackCenter(original,'x'));
  const y = stackStarts(units,'y',offsetY.map(distance => -distance),stackCenter(original,'y'));
  if (!x || !y) return [];
  return units.flatMap((unit,index) => {
    const moved = moveUnit(unit,'x',x[index],'y',y[index],false);
    if (!unit.imageTransform) return moved;
    const {id} = unit.items[0];
    return [{id,patch:{...moved[0]?.patch,imageTransform:unit.imageTransform}}];
  });
}

function scaleReference(unit) {
  return unit.find(item => item.kind === 'image');
}

export function normalizeScaleItems(board, selection) {
  return selectedUnits(board,selection).map(scaleReference).filter(Boolean);
}

export function canNormalizeSelection(board, selection, action) {
  return action === 'scale' ? normalizeScaleItems(board,selection).length > 1 : canAlignSelection(board,selection);
}

function normalizeMetric(unit, action, dimensions) {
  const width = unit.x.size;
  const height = unit.y.size;
  if (action === 'height') return height;
  if (action === 'width') return width;
  if (action === 'size') return Math.max(width,height);
  if (action === 'area') return width * height;
  const item = scaleReference(unit.items);
  const source = dimensions?.get(item.id);
  if (!(source?.width > 0 && source?.height > 0)) return NaN;
  const [left,top,right,bottom] = normalizeImageTransform(item.imageTransform).crop;
  return Math.sqrt((item.width / (source.width * (right - left))) *
    (item.height / (source.height * (bottom - top))));
}

function scalablePoints(item) {
  if (!['arrow','stroke'].includes(item.kind) || !Array.isArray(item.points)) return [];
  return item.points.filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
}

function scaleLimits(items) {
  const widths = items.map(item => item.width);
  const heights = items.map(item => item.height);
  const xs = items.map(item => item.x);
  const ys = items.map(item => item.y);
  const pointExtent = Math.max(0,...items.map(item => scalablePoints(item)
    .reduce((max,point) => Math.max(max,Math.abs(point[0]),Math.abs(point[1])),0)));
  return [1 / Math.min(...widths,...heights),Math.min(
    dimensionLimit / Math.max(...widths,...heights,pointExtent),
    2 * coordinateLimit / (Math.max(...xs) - Math.min(...xs)),
    2 * coordinateLimit / (Math.max(...ys) - Math.min(...ys)),
  )];
}

function boundedAxisCenter(items, axis, center, factor) {
  const offsets = items.map(item => (item[axis] - center) * factor);
  const min = -coordinateLimit - Math.min(...offsets);
  const max = coordinateLimit - Math.max(...offsets);
  return Math.max(min,Math.min(max,center));
}

function scaleUnit(unit, factor) {
  if (Math.abs(factor - 1) < positionTolerance) return [];
  const centerX = (unit.x.start + unit.x.end) / 2;
  const centerY = (unit.y.start + unit.y.end) / 2;
  const x = boundedAxisCenter(unit.items,'x',centerX,factor);
  const y = boundedAxisCenter(unit.items,'y',centerY,factor);
  return unit.items.map(item => {
    const patch = {
      x:Math.max(-coordinateLimit,Math.min(coordinateLimit,x + (item.x - centerX) * factor)),
      y:Math.max(-coordinateLimit,Math.min(coordinateLimit,y + (item.y - centerY) * factor)),
      width:Math.max(1,Math.min(dimensionLimit,item.width * factor)),
      height:Math.max(1,Math.min(dimensionLimit,item.height * factor)),
    };
    const points = scalablePoints(item);
    if (points.length) {
      patch.points = points.map(point => point.map(value =>
        Math.max(-dimensionLimit,Math.min(dimensionLimit,value * factor))));
    }
    return {id:item.id,patch};
  });
}

export function normalizeSelection(board, selection, action, source, dimensions) {
  if (!['height','width','size','area','scale'].includes(action)) return [];
  const units = selectedUnits(board,selection).filter(unit => action !== 'scale' || scaleReference(unit)).map(unitRanges);
  if (units.length < 2) return [];
  const values = units.map(unit => normalizeMetric(unit,action,dimensions));
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return [];
  const power = action === 'area' ? 2 : 1;
  const requested = source === 'first' ? values[0] : values.reduce((sum,value) => sum + value,0) / values.length;
  const limits = units.map(unit => scaleLimits(unit.items));
  // Use a common achievable target so every unit keeps its aspect ratio at the size limits.
  const min = Math.max(...limits.map(([limit],index) => values[index] * limit ** power));
  const max = Math.min(...limits.map(([,limit],index) => values[index] * limit ** power));
  if (min > max) return [];
  const target = Math.max(min,Math.min(max,requested));
  return units.flatMap((unit,index) => scaleUnit(unit,(target / values[index]) ** (1 / power)));
}
