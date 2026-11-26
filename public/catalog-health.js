import {downloadWorkspaceFile} from './workspace-download.js';

const figures = new Intl.NumberFormat('zh-CN');

function bytes(count) {
  if (count < 1024) return figures.format(count) + ' B';
  const power = Math.min(4,Math.floor(Math.log(count) / Math.log(1024)));
  return (count / 1024 ** power).toLocaleString('zh-CN',{maximumFractionDigits:2}) + ' ' +
    ['B','KB','MB','GB','TB'][power];
}

export function initCatalogHealth({enabled,api,closeMenu,current}) {
  if (!enabled) return;
  const trigger = document.getElementById('catalog-health');
  const dialog = document.getElementById('catalog-health-dialog');
  const field = name => dialog.querySelector('#catalog-health-' + name);
  const status = field('status');
  const results = field('results');
  const recheck = field('recheck');
  const save = field('export');
  let revision = 0;
  let report;
  let workspace;
  trigger.hidden = false;

  function list(title,items) {
    if (!items.length) return;
    const group = document.createElement('details');
    const heading = document.createElement('summary');
    heading.textContent = title;
    const entries = document.createElement('ul');
    for (const item of items) {
      const row = document.createElement('li');
      row.textContent = item;
      entries.append(row);
    }
    group.append(heading,entries);
    results.append(group);
  }

  function render(value) {
    const cache = value.thumbnailCache;
    const metrics = [
      ['索引资产',figures.format(value.assets)],
      ['已登记目录',figures.format(value.catalogs)],
      ['登记目录内的文件引用',figures.format(value.registeredReferences)],
      ['单独入库的文件引用',figures.format(value.looseReferences)],
      ['失去目录的引用',figures.format(value.orphanReferences)],
      ['失效的集合成员',figures.format(value.orphanCollectionMembers)],
      ['数据库文件',bytes(value.databaseBytes)],
      ['数据库预写日志',bytes(value.walBytes)],
      ['缩略图缓存',figures.format(cache.files) + ' 项 · ' + bytes(cache.bytes)],
    ];
    const overview = document.createElement('dl');
    overview.className = 'catalog-health-metrics';
    for (const [label,amount] of metrics) {
      const key = document.createElement('dt');
      const detail = document.createElement('dd');
      key.textContent = label;
      detail.textContent = amount;
      overview.append(key,detail);
    }
    results.replaceChildren(overview);
    list('数据库检查',value.databaseIssues);
    list('缺失的索引',value.missingIndexes);
    list('缓存检查',[cache.error, cache.skipped ? '跳过 ' + figures.format(cache.skipped) + ' 项非普通文件或无法读取的条目' : null].filter(Boolean));
    list('登记目录重叠 · ' + figures.format(value.directoryOverlapCount),
      value.directoryOverlaps.map(({parent,child}) => parent + ' → ' + child));
    list('检查范围',[value.directory,...value.registeredRoots]);
    results.hidden = false;
  }

  async function inspect() {
    const request = ++revision;
    workspace = current();
    report = undefined;
    save.disabled = true;
    recheck.disabled = true;
    results.hidden = true;
    if (!workspace) {
      status.textContent = '请切换到个人库再检查数据库。';
      return;
    }
    status.textContent = '正在检查 ' + workspace.name + ' 的数据库与本机缓存…';
    try {
      const data = await api('inspect_personal_catalog_health');
      if (request !== revision || !dialog.open) return;
      if (current()?.id !== workspace.id) throw Error('已切换资料库，请在当前资料库重新检查。');
      report = data;
      render(report);
      save.disabled = false;
      status.textContent = workspace.name + ' · ' + new Date(report.checkedAt * 1000).toLocaleString() +
        ' · 客户端 ' + report.clientVersion;
    } catch (error) {
      if (request === revision && dialog.open) status.textContent = error.message || String(error);
    } finally {
      if (request === revision) recheck.disabled = false;
    }
  }

  trigger.addEventListener('click',() => {
    closeMenu();
    field('include-paths').checked = false;
    dialog.showModal();
    void inspect();
  });
  dialog.addEventListener('close',() => { revision++; });
  recheck.addEventListener('click',inspect);
  save.addEventListener('click',() => {
    if (!report) return;
    const {directory,registeredRoots,directoryOverlaps,...summary} = report;
    const include = field('include-paths').checked;
    const data = include ? {...summary,directory,registeredRoots,directoryOverlaps} : summary;
    // Diagnostic text can include host filesystem details when SQLite or a cache read fails.
    if (!include) {
      data.databaseIssues = report.databaseIssues.map(() => '数据库检查发现异常');
      data.thumbnailCache = {...report.thumbnailCache,error:report.thumbnailCache.error ? '无法读取缓存' : null};
    }
    const payload = {format:'nexus-personal-catalog-health',version:1,...data};
    downloadWorkspaceFile(document,'Nexus 个人库检查报告.json',JSON.stringify(payload,null,2));
  });
}
