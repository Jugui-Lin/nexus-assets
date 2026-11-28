import {initExplorerAssetDisclosure} from './local-explorer-asset-disclosure.js';

const referenceTypes = new Map([['collection','合集'],['whiteboard','白板']]);

export function initExplorerAssetReferences({before,references,openReference}) {
  return initExplorerAssetDisclosure({
    before,className:'file-explorer-asset-references',title:'用在哪里',listLabel:'资产引用',
    loading:'正在查找资产引用…',empty:'在已加载的资料中未找到引用。',
    available:record => record.canReadReferences !== false,
    load:references,
    describe(reference) {
      const type = reference.kind === 'whiteboard' && reference.team ? '团队白板' : referenceTypes.get(reference.kind);
      if (!type || !reference.id || !reference.name) return null;
      const location = reference.total > 1 ? `引用 ${reference.position} / ${reference.total}` : '';
      return {
        title:reference.name,note:reference.cardTitle,caption:[type,location].filter(Boolean).join(' · '),
        action:reference.itemId ? '定位' : '打开',
        actionLabel:(reference.itemId ? '定位' : '打开') + type + '「' + reference.name + '」' + (location ? ' ' + location : ''),
      };
    },
    run:openReference,
  });
}
