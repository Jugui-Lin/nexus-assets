export function retainAssetOrder(rows, ids) {
  const remaining = new Map(rows.map(asset => [asset.id,asset]));
  const ordered = [];
  for (const id of ids) {
    const asset = remaining.get(id);
    if (!asset) continue;
    ordered.push(asset);
    remaining.delete(id);
  }
  return ordered.concat([...remaining.values()]);
}

export function assetFormatGroup(asset) {
  return String(asset?.ext || '').toUpperCase();
}

export function assetFormatGroups(rows) {
  const groups = new Map();
  for (const asset of rows) {
    const extension = assetFormatGroup(asset);
    if (!groups.has(extension)) groups.set(extension,[]);
    groups.get(extension).push(asset);
  }
  return groups;
}
