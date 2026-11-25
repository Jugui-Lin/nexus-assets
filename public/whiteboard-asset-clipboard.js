const prefix = 'nexus-asset-references:v1:';
const maxItems = 500;
const workspaceKeyPattern = /^(?:personal(?::[a-z0-9_-]{1,128})?|team:[a-z0-9_-]{1,128}:[a-z0-9_-]{1,128})$/i;
const assetIdPattern = /^(?:team:)?[a-z0-9_-]{1,128}$/i;

export function encodeWhiteboardAssetClipboard(workspaceKey, assetIds) {
  if (assetIds?.length > maxItems) throw Error(`一次最多复制 ${maxItems} 项媒体引用。`);
  if (!validReferenceList(workspaceKey, assetIds)) throw Error('无法复制这组媒体引用。');
  return prefix + JSON.stringify({workspaceKey, assetIds});
}

export function parseWhiteboardAssetClipboard(text) {
  if (typeof text !== 'string' || !text.startsWith(prefix) || text.length > 72_000) return null;
  try {
    const {workspaceKey, assetIds} = JSON.parse(text.slice(prefix.length));
    if (!validReferenceList(workspaceKey, assetIds)) return null;
    return {workspaceKey, assetIds:[...new Set(assetIds)]};
  } catch {
    return null;
  }
}

function validReferenceList(workspaceKey, assetIds) {
  return typeof workspaceKey === 'string' && workspaceKeyPattern.test(workspaceKey) &&
    Array.isArray(assetIds) && assetIds.length > 0 && assetIds.length <= maxItems &&
    assetIds.every(id => typeof id === 'string' && assetIdPattern.test(id));
}
