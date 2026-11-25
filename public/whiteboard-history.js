import {normalizeImageTransform} from './whiteboard-image-transform.js';

const defaults = {text:'', color:'slate', points:[], groupId:''};
const itemFields = ['kind','x','y','width','height','text','color','points','imageId','assetId','imageTransform','groupId','connection'];

function fieldValue(item, field) {
  if (field === 'imageTransform' && item.kind === 'image') return normalizeImageTransform(item[field]);
  return item[field] ?? defaults[field];
}

function sameValue(left, right) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function boardHistoryEntry(before, after, operations) {
  const changes = [];
  for (const id of new Set(operations.map(operation => operation.id))) {
    const previous = before.get(id);
    const next = after.get(id);
    if (!previous || !next) {
      if (previous || next) changes.push({id, previous, next});
      continue;
    }
    const oldValues = {};
    const newValues = {};
    for (const field of itemFields) {
      const oldValue = fieldValue(previous, field);
      const newValue = fieldValue(next, field);
      if (sameValue(oldValue, newValue)) continue;
      oldValues[field] = oldValue;
      newValues[field] = newValue;
    }
    if (Object.keys(oldValues).length) changes.push({id, previous:oldValues, next:newValues, update:true});
  }
  return changes;
}

export function boardHistoryOperations(changes, board, direction) {
  const operations = [];
  const applied = [];
  for (const change of changes) {
    const {id, previous, next, update} = change;
    const expected = direction === 'undo' ? next : previous;
    const destination = direction === 'undo' ? previous : next;
    const current = board.get(id);
    if (update) {
      if (!current || Object.keys(expected).some(field => !sameValue(fieldValue(current, field), expected[field]))) continue;
      operations.push({id,patch:destination});
    } else {
      if (Boolean(expected) !== Boolean(current) ||
          (current && itemFields.some(field => !sameValue(fieldValue(current, field), fieldValue(expected, field))))) continue;
      if (destination) {
        const patch = Object.fromEntries(itemFields.filter(field => destination[field] !== undefined)
          .map(field => [field,destination[field]]));
        operations.push({id,patch});
      } else operations.push({id,delete:true});
    }
    applied.push(change);
  }
  return {operations,applied};
}
