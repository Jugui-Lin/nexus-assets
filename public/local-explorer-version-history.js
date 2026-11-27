import {initExplorerAssetDisclosure} from './local-explorer-asset-disclosure.js';

const versionDate = new Intl.DateTimeFormat('zh-CN', {
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});
const sizeNumber = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});

function versionSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return bytes + ' B';
  const unit = Math.min(4,Math.floor(Math.log2(bytes) / 10));
  return sizeNumber.format(bytes / 1024 ** unit) + ' ' + ['B','KB','MB','GB','TB'][unit];
}

function versionTime(created) {
  if (!Number.isFinite(created)) return '';
  const date = new Date(created < 1e12 ? created * 1000 : created);
  return Number.isFinite(date.getTime()) ? versionDate.format(date) : '';
}

export function initExplorerVersionHistory({before,versions,openVersion,saveVersion}) {
  return initExplorerAssetDisclosure({
    before,className:'file-explorer-version-history',title:'文件版本',listLabel:'已保存的文件版本',
    loading:'正在加载文件版本…',empty:'暂无已保存的文件版本。',
    available:record => record.canReadVersions !== false,
    load:versions,
    describe:version => ({
      title:'版本 ' + version.version,
      note:version.note,
      caption:[versionTime(version.created),versionSize(version.size)].filter(Boolean).join(' · '),
      action:'另存副本',actionLabel:'另存版本 ' + version.version + ' 的副本',
    }),
    run:openVersion && ((record,version,scope) => openVersion(record,version.id,scope)),
    success:'已另存版本副本。',
    primaryAction:saveVersion && {
      attribute:'data-explorer-save-version',label:'保存当前版本…',
      available:record => record.canCreateVersion === true,
      run:saveVersion,success:'已保存当前文件版本。',
    },
  });
}
