import {imageLocalPoint, normalizeImageRotation} from './whiteboard-image-transform.js';

export const boardPorts = {top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const connectableKinds = new Set(['image','note','text','rect','ellipse','frame']);

export function isBoardConnectable(item) {
  return connectableKinds.has(item?.kind);
}

export function boardPortPoint(item, side) {
  if (!isBoardConnectable(item) || !Object.hasOwn(boardPorts,side)) return null;
  const direction = boardPorts[side];
  const dx = direction[0] * item.width / 2;
  const dy = direction[1] * item.height / 2;
  const radians = normalizeImageRotation(item.imageTransform?.rotation) * Math.PI / 180;
  return {x:item.x + item.width / 2 + dx * Math.cos(radians) - dy * Math.sin(radians),
    y:item.y + item.height / 2 + dx * Math.sin(radians) + dy * Math.cos(radians)};
}

export function nearestBoardPort(item, point) {
  const local = imageLocalPoint(item,point.x,point.y);
  const distances = {
    top:Math.abs(local.y) * item.height,
    right:Math.abs(1 - local.x) * item.width,
    bottom:Math.abs(1 - local.y) * item.height,
    left:Math.abs(local.x) * item.width,
  };
  return Object.keys(distances).reduce((best, side) => distances[side] < distances[best] ? side : best);
}
