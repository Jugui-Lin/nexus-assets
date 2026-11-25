const commonTagGroups = [
  ['资产类型', ['模型', '材质', 'PBR 贴图', 'HDRI', '动画', '工程', '参考图', '视频']],
  ['制作环节', ['建模', 'UV 展开', '绑定', '灯光', '渲染', '合成']],
  ['用途与风格', ['产品展示', '室内场景', '户外场景', '写实', '卡通', '低多边形']],
  ['管理状态', ['待整理', '待检查', '待转换', '已验证', '可复用']],
];

export function suggestAssetTags(existingTags, query = '') {
  const existing = new Set(existingTags.map(tag => tag.toLowerCase()));
  const term = query.trim().toLowerCase();
  return commonTagGroups.map(([name, tags]) => [name, tags.filter(tag => {
    const key = tag.toLowerCase();
    return !existing.has(key) && (name.includes(term) || key.includes(term));
  })]).filter(([, tags]) => tags.length);
}

function tagNode() {
  return { children: new Map(), tag: null };
}

export function buildTagTree(assets, query = '') {
  const root = tagNode();
  const term = query.trim().toLocaleLowerCase();
  for (const asset of assets) {
    for (const tag of new Set(asset.tags)) {
      if (term && !tag.toLocaleLowerCase().includes(term)) continue;
      const parts = tag.split('/');
      const hierarchy = parts.every(part => part.trim()) ? parts : [tag];
      let branch = root;
      let prefix = '';
      for (const part of hierarchy) {
        prefix = prefix ? prefix + '/' + part : part;
        if (!branch.children.has(part)) {
          branch.children.set(part, {...tagNode(), name: part, prefix});
        }
        branch = branch.children.get(part);
      }
      branch.tag = tag;
    }
  }
  return root;
}

export function matchesTag(tags, tag) {
  if (!tag) return true;
  const key = tag.toLowerCase();
  return tags.some(value => {
    const candidate = value.toLowerCase();
    return candidate === key || key.endsWith('/') && candidate.startsWith(key);
  });
}
