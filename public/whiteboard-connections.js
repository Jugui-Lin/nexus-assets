import {imageLocalPoint, normalizeImageRotation} from './whiteboard-image-transform.js';

export const boardPorts = {top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const connectableKinds = new Set(['image','note','text','rect','ellipse','frame']);
const positionPrefix = 'nexus:connector-edge:v1:';
const clampOffset = value => Number.isFinite(value) ? Math.max(0,Math.min(1,value)) : .5;

export function isBoardConnectable(item) {
  return connectableKinds.has(item?.kind);
}

// The arrow's existing text field carries offsets through team servers that already support connections.
export function readBoardConnectionOffsets(text) {
  const parts = typeof text === 'string' && text.startsWith(positionPrefix)
    ? text.slice(positionPrefix.length).split(',') : [];
  const offsets = parts.length === 2 ? parts.map(part => part ? Number(part) : NaN) : [];
  const readOffset = index => offsets[index] >= 0 && offsets[index] <= 1 ? offsets[index] : .5;
  return {from:readOffset(0),to:readOffset(1)};
}

export function writeBoardConnectionOffsets({from = .5,to = .5}) {
  return from === .5 && to === .5 ? '' : positionPrefix + [from,to].join(',');
}

export function boardPortPoint(item, side, offset = .5) {
  if (!isBoardConnectable(item) || !Object.hasOwn(boardPorts,side)) return null;
  const [x,y] = boardPorts[side];
  const across = clampOffset(offset) - .5;
  const angle = across * Math.PI / 2;
  const tangent = item.kind === 'ellipse' ? Math.sin(angle) : across * 2;
  const normal = item.kind === 'ellipse' ? Math.cos(angle) : 1;
  const dx = (x * normal + Math.abs(y) * tangent) * item.width / 2;
  const dy = (y * normal + Math.abs(x) * tangent) * item.height / 2;
  const radians = normalizeImageRotation(item.imageTransform?.rotation) * Math.PI / 180;
  return {x:item.x + item.width / 2 + dx * Math.cos(radians) - dy * Math.sin(radians),
    y:item.y + item.height / 2 + dx * Math.sin(radians) + dy * Math.cos(radians)};
}

export function nearestBoardEdge(item, point, preferredSide = 'top') {
  const local = imageLocalPoint(item,point.x,point.y);
  if (item.kind === 'ellipse') {
    const {x,y} = {x:local.x - .5,y:local.y - .5};
    const side = Math.abs(x) > Math.abs(y) ? (x < 0 ? 'left' : 'right') : (y < 0 ? 'top' : 'bottom');
    const horizontal = !boardPorts[side][0];
    const angle = Math.atan2(horizontal ? x : y,Math.abs(horizontal ? y : x));
    return {side,offset:.5 + angle / (Math.PI / 2)};
  }
  const x = clampOffset(local.x);
  const y = clampOffset(local.y);
  const edges = {top:[x,0,x],right:[1,y,y],bottom:[x,1,x],left:[0,y,y]};
  const distance = side => Math.hypot((local.x - edges[side][0]) * item.width,
    (local.y - edges[side][1]) * item.height);
  const side = Object.keys(edges).reduce((best, candidate) => distance(candidate) < distance(best) ? candidate : best, preferredSide);
  return {side,offset:edges[side][2]};
}

export function facingBoardPort(start, end) {
  const x = end.x - start.x;
  const y = end.y - start.y;
  return Math.abs(x) >= Math.abs(y) ? (x >= 0 ? 'left' : 'right') : (y >= 0 ? 'top' : 'bottom');
}

function portDirection(item, side) {
  const [x,y] = boardPorts[side];
  const radians = normalizeImageRotation(item?.imageTransform?.rotation) * Math.PI / 180;
  return [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)];
}

export function boardConnectionControls(start, end, fromItem, fromSide, toItem, toSide = facingBoardPort(start,end)) {
  const handle = Math.min(180, Math.hypot(end.x - start.x,end.y - start.y) * .48);
  const [fromX,fromY] = portDirection(fromItem,fromSide);
  const [toX,toY] = portDirection(toItem,toSide);
  return [[start.x + fromX * handle,start.y + fromY * handle], [end.x + toX * handle,end.y + toY * handle]];
}
