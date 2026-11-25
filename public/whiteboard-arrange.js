import {imageBounds} from './whiteboard-image-transform.js';

const coordinateLimit = 1_000_000;

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

function selectedUnits(board, selection) {
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

export function alignSelection(board, selection, axis, alignment) {
  if (!['x','y'].includes(axis) || !['start','center','end'].includes(alignment)) return [];
  const units = selectedUnits(board, selection);
  if (units.length < 2) return [];
  const ranges = units.map(unit => unitRange(unit, axis));
  const anchor = (start, end) => alignment === 'start' ? start : alignment === 'end' ? end : (start + end) / 2;
  const target = anchor(Math.min(...ranges.map(([start]) => start)), Math.max(...ranges.map(([,end]) => end)));

  return units.flatMap((unit, index) => {
    const delta = target - anchor(...ranges[index]);
    const coordinates = unit.map(item => item[axis]);
    const minimum = -coordinateLimit - Math.min(...coordinates);
    const maximum = coordinateLimit - Math.max(...coordinates);
    const movement = Math.max(minimum, Math.min(maximum, delta));
    if (!movement) return [];
    return unit.flatMap(item => {
      const position = Math.round((item[axis] + movement) * 10) / 10;
      return position === item[axis] ? [] : [{id:item.id,patch:{[axis]:position}}];
    });
  });
}
