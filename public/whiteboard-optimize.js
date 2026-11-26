import {imageBounds, normalizeImageTransform} from './whiteboard-image-transform.js';
import {itemGap, selectedUnits} from './whiteboard-arrange.js';

const coordinateLimit = 1_000_000;
const positionTolerance = 1e-7;
const layoutKinds = new Set(['image','note','text','rect','ellipse']);

function arrangementUnits(board, selection) {
  return selectedUnits(board,selection.size ? selection : new Set(board.keys()))
    .filter(items => items.some(item => layoutKinds.has(item.kind)));
}

export function canOptimizeArrangement(board, selection) {
  return arrangementUnits(board,selection).length > 1;
}

function boundsFor(items, rotations) {
  const boxes = items.map(item => item.kind === 'image' && !rotations?.has(item.id) ? imageBounds(item) :
    {left:item.x,right:item.x + item.width,top:item.y,bottom:item.y + item.height});
  const left = Math.min(...boxes.map(box => box.left));
  const top = Math.min(...boxes.map(box => box.top));
  const right = Math.max(...boxes.map(box => box.right));
  const bottom = Math.max(...boxes.map(box => box.bottom));
  return {items,left,right,top,bottom,width:right-left,height:bottom-top};
}

function placeOnShelves(units, targetWidth) {
  const shelves = [];
  let bottom = 0;
  let right = 0;
  const positions = units.map(unit => {
    let shelf;
    for (const candidate of shelves) {
      if (candidate.right + itemGap + unit.width <= targetWidth + positionTolerance &&
          (!shelf || candidate.right > shelf.right + positionTolerance)) {
        shelf = candidate;
      }
    }
    if (!shelf) {
      shelf = {right:-itemGap,y:bottom ? bottom + itemGap : 0};
      shelves.push(shelf);
      bottom = shelf.y + unit.height;
    }
    const x = shelf.right + itemGap;
    shelf.right = x + unit.width;
    right = Math.max(right,shelf.right);
    return {unit,x,y:shelf.y};
  });
  return {positions,width:right,height:bottom};
}

function layoutOrigin(positions, axis, desired) {
  const start = axis === 'x' ? 'left' : 'top';
  const values = positions.flatMap(({unit,[axis]:position}) =>
    unit.items.map(item => position + item[axis] - unit[start]));
  const min = -coordinateLimit - Math.min(...values);
  const max = coordinateLimit - Math.max(...values);
  return min <= max ? Math.max(min,Math.min(max,desired)) : null;
}

export function optimizeArrangement(board, selection, viewportRatio, canRotate = false) {
  const original = arrangementUnits(board,selection).map(items => boundsFor(items));
  if (original.length < 2) return [];
  const rotations = new Map();
  if (canRotate) {
    for (const {items} of original) {
      for (const item of items) {
        if (item.kind !== 'image' || !item.imageTransform?.rotation) continue;
        const transform = normalizeImageTransform(item.imageTransform);
        if (transform.rotation) rotations.set(item.id,{...transform,rotation:0});
      }
    }
  }
  const units = rotations.size ? original.map(({items}) => boundsFor(items,rotations)) : [...original];
  // Ignore floating point noise in rotated bounds so equal cards retain their order.
  const compare = (a,b) => Math.abs(a - b) < positionTolerance ? 0 : a - b;
  units.sort((a,b) => compare(b.height,a.height) || compare(b.width,a.width));
  const ratio = Math.max(.35,Math.min(3,viewportRatio || 1));
  const area = units.reduce((total,unit) => total + (unit.width + itemGap) * (unit.height + itemGap),0);
  const idealWidth = Math.sqrt(area * ratio);
  const widest = Math.max(...units.map(unit => unit.width));
  const layout = [.65,.8,1,1.15,1.35,1.6,2].map(scale => placeOnShelves(units,Math.max(widest,idealWidth * scale)))
    .sort((a,b) => {
      const scale = Math.max(a.width,a.height,b.width,b.height);
      return compare(Math.max(a.width / ratio,a.height),Math.max(b.width / ratio,b.height)) ||
        compare(a.width * a.height / scale,b.width * b.height / scale);
    })[0];
  const centerX = (Math.min(...original.map(unit => unit.left)) + Math.max(...original.map(unit => unit.right))) / 2;
  const centerY = (Math.min(...original.map(unit => unit.top)) + Math.max(...original.map(unit => unit.bottom))) / 2;
  const x = layoutOrigin(layout.positions,'x',centerX - layout.width / 2);
  const y = layoutOrigin(layout.positions,'y',centerY - layout.height / 2);
  if (x === null || y === null) return [];
  return layout.positions.flatMap(({unit,x:left,y:top}) => {
    const dx = x + left - unit.left;
    const dy = y + top - unit.top;
    const moved = Math.abs(dx) >= positionTolerance || Math.abs(dy) >= positionTolerance;
    return unit.items.flatMap(item => {
      const imageTransform = rotations.get(item.id);
      if (!moved && !imageTransform) return [];
      return [{id:item.id,patch:{
        ...(moved && {
          x:Math.max(-coordinateLimit,Math.min(coordinateLimit,item.x + dx)),
          y:Math.max(-coordinateLimit,Math.min(coordinateLimit,item.y + dy)),
        }),
        ...(imageTransform && {imageTransform}),
      }}];
    });
  });
}
