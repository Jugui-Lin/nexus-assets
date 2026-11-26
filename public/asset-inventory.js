import {buildCsvMetadataPlan, favoriteMarkdown, inventoryFields, inventoryPath, parseAssetCsv, pathIdentity, writeAssetCsv} from './asset-inventory-format.js';
import {downloadWorkspaceFile} from './workspace-download.js';

const pageSize = 50;
const registryPrefix = 'nexus-inventory-external-ids-v1:';
const defaultFields = ['id','name','format','tags','rating'];
const aliases = {
  id:['资产编号','nexus 资产编号','nexus id','asset id','id'], path:['原件路径','路径','path','file path'],
  name:['名称','文件名','name','filename'], tags:['标签','tags','keywords'],
  notes:['备注','notes','description'], rating:['评分','rating','stars'], external:['外部编号','external id','external_id'],
};

export function initAssetInventory({scope,data,apply,partlyApplied,pickFolder,closeMenu,canImport,exportHtml,openHtml}) {
  const dialog = document.querySelector('#asset-inventory-dialog');
  const options = selector => dialog.querySelector(selector);
  const mode = options('[data-inventory-mode]');
  const root = options('[data-inventory-root]');
  const fields = options('[data-inventory-fields]');
  const notice = options('[data-inventory-status]');
  const action = options('[data-inventory-apply]');
  const rows = options('[data-inventory-rows]');
  const maps = options('[data-inventory-maps]');
  const preview = options('[data-inventory-preview]');
  const related = options('[data-inventory-source]');
  const rowControls = options('[data-inventory-pagination]');
  let context, csv, plan = null, page = 0, busy = false, stop = false, request = 0, htmlPath = '';
  mode.querySelector('[value="import"]').disabled = !canImport;
  mode.querySelector('[value="html"]').disabled = !exportHtml;
  options('[data-inventory-pick]').hidden = !pickFolder;

  const selectedFields = () => [...fields.querySelectorAll('input:checked')].map(input => input.value);
  const selectorValue = name => options('[data-inventory-' + name + ']')?.value ?? '';
  const checked = name => Boolean(options('[data-inventory-' + name + ']')?.checked);
  const checkedRows = () => plan?.filter(row => row.patch && !row.error && row.enabled && !row.done) || [];
  const inScope = () => dialog.open && context === scope();
  const label = values => Array.isArray(values) ? values.join('、') || '空' : String(values ?? '') || '空';
  const setNotice = message => { notice.textContent = message; };

  function externalRegistry() {
    try {
      const raw = JSON.parse(localStorage.getItem(registryPrefix + context));
      if (Array.isArray(raw)) return new Map(raw.filter(entry =>
        Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string')));
    } catch {}
    return new Map();
  }

  function makeField(key) {
    const item = document.createElement('li');
    const select = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = key;
    input.checked = defaultFields.includes(key);
    select.append(input,inventoryFields[key]);
    item.append(select);
    for (const direction of ['up','down']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button subtle';
      button.dataset.inventoryMove = direction;
      button.setAttribute('aria-label',inventoryFields[key] + (direction === 'up' ? '上移' : '下移'));
      button.textContent = direction === 'up' ? '↑' : '↓';
      item.append(button);
    }
    return item;
  }

  function fieldButtons() {
    for (const item of fields.children) {
      item.querySelector('[data-inventory-move="up"]').disabled = !item.previousElementSibling;
      item.querySelector('[data-inventory-move="down"]').disabled = !item.nextElementSibling;
    }
  }

  function chosenAssets() {
    const current = data();
    return mode.value === 'favorites' ? current.favorites : related.value === 'marked' ? current.marked : current.visible;
  }

  function renderControls() {
    const importing = mode.value === 'import';
    const html = mode.value === 'html';
    options('[data-inventory-export]').hidden = importing;
    options('[data-inventory-import]').hidden = !importing;
    options('[data-inventory-source-field]').hidden = mode.value === 'favorites';
    options('[data-inventory-csv-fields]').hidden = mode.value !== 'csv';
    options('[data-inventory-favorite-fields]').hidden = mode.value !== 'favorites';
    options('[data-inventory-path-field]').hidden = html;
    options('[data-inventory-html-options]').hidden = !html;
    options('[data-inventory-open-html]').hidden = !html || !htmlPath || !openHtml || busy;
    options('[data-inventory-external-field]').hidden = selectorValue('match-mode') === 'external';
    options('[data-inventory-root]').disabled = busy;
    action.textContent = importing ? '应用所选行' : html ? '生成离线目录' : '导出文件';
    action.disabled = busy || (importing ? !checkedRows().length :
      !chosenAssets().length || mode.value === 'csv' && !selectedFields().length || html && !exportHtml);
    options('[data-inventory-preview-action]').disabled = busy || !csv;
    options('[data-inventory-stop]').hidden = !busy || !importing;
    options('[data-inventory-close]').disabled = busy;
    preview.hidden = !importing || !plan;
    options('[data-inventory-summary]').textContent = importing ? '' : '可导出 ' + chosenAssets().length.toLocaleString('zh-CN') + ' 项资产';
  }

  function columnBoxes() {
    const activeMode = selectorValue('match-mode');
    const keys = {'match-column':activeMode,'map-tags':'tags','map-notes':'notes','map-rating':'rating','external-column':'external'};
    for (const [selector,field] of Object.entries(keys)) {
      const select = options('[data-inventory-' + selector + ']');
      select.replaceChildren(new Option('未选择',''),...(csv?.header || []).map((label,index) =>
        new Option((index + 1) + ' · ' + (label.trim() || '空表头'),String(index))));
      const matched = csv?.header.findIndex(label => aliases[field].includes(label.trim().toLowerCase())) ?? -1;
      select.value = matched < 0 ? '' : String(matched);
    }
    maps.hidden = !csv;
  }

  function column(name) {
    const value = selectorValue(name);
    return value === '' ? undefined : Number(value);
  }

  function renderRows() {
    rows.replaceChildren();
    if (!plan) { renderControls(); return; }
    for (const [i,row] of plan.slice(page * pageSize,(page + 1) * pageSize).entries()) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.inventoryRow = String(page * pageSize + i);
      check.disabled = Boolean(busy || row.error || !row.patch || row.done);
      check.checked = !check.disabled && row.enabled;
      const name = document.createElement('strong');
      name.textContent = '第 ' + row.line + ' 行 · ' + (row.asset?.name || row.reference || '空标识');
      label.append(check,name);
      li.append(label);
      const fields = document.createElement('small');
      fields.textContent = row.done ? '已更新' : row.error || [
        ...Object.entries(row.patch).map(([key,value]) => inventoryFields[key] + '　' + labelValue(row.asset[key]) + ' → ' + labelValue(value)),
        ...(row.external ? ['外部编号　' + row.external] : []),
      ].join('\n');
      li.append(fields);
      rows.append(li);
    }
    options('[data-inventory-page]').textContent = (page + 1) + ' / ' + Math.max(1,Math.ceil(plan.length / pageSize));
    rowControls.querySelector('[data-inventory-step="-1"]').disabled = page === 0;
    rowControls.querySelector('[data-inventory-step="1"]').disabled = (page + 1) * pageSize >= plan.length;
    renderControls();
  }

  function labelValue(value) { return label(value).replace(/[\r\n]+/g,' ↵ '); }

  function projectRoot(requireRoot = false) {
    const path = root.value.trim();
    if (path && !pathIdentity(path)) throw Error('项目根目录需要使用本机或 NAS 的完整路径。');
    if (!path && requireRoot) throw Error('请填写相对路径使用的项目根目录。');
    return path;
  }

  function makePlan() {
    const matchColumn = column('match-column');
    const match = selectorValue('match-mode');
    const externalColumn = match === 'external' ? undefined : column('external-column');
    const fields = {tags:column('map-tags'),notes:column('map-notes'),rating:column('map-rating')};
    if (matchColumn === undefined) throw Error('请选择用来匹配资产的列。');
    if (externalColumn === undefined && !Object.values(fields).some(Number.isInteger)) throw Error('请选择标签、备注、评分或要关联的外部编号列。');
    const columns = [matchColumn,externalColumn,...Object.values(fields)].filter(Number.isInteger);
    if (new Set(columns).size !== columns.length) throw Error('一个表格列只能用于一种字段。');
    plan = buildCsvMetadataPlan(csv,{mode:match,matchColumn,externalColumn,fields,assets:data(true).assets,
      externalIds:externalRegistry(),root:match === 'path' ? projectRoot() : '',clearEmpty:checked('clear'),
      spreadsheetSafe:checked('unescape')}).map(row => ({...row,enabled:!row.error}));
    page = 0;
    setNotice('预览 ' + plan.length + ' 行，可应用 ' + checkedRows().length + ' 行。');
    renderRows();
  }

  function exportInventory() {
    const source = chosenAssets();
    const selected = selectedFields();
    const markdown = mode.value === 'favorites';
    const includePath = markdown ? checked('favorite-path') : selected.includes('path');
    const relativeRoot = includePath && selectorValue('path-mode') === 'relative' ? projectRoot(true) : '';
    if (includePath && relativeRoot && source.some(asset => !inventoryPath(asset,relativeRoot))) {
      throw Error('部分资产位于项目根目录之外或没有可用路径，请核对导出范围或调整路径方式。');
    }
    if (markdown) {
      downloadWorkspaceFile(document,'Nexus 收藏.md',favoriteMarkdown(source,
        {root:relativeRoot,includePath,includeNotes:checked('favorite-notes')}),'text/markdown;charset=utf-8');
    } else {
      const separator = {comma:',',semi:';',tab:'\t'}[selectorValue('separator')];
      const cells = source.map(asset => ({...asset,path:includePath ? inventoryPath(asset,relativeRoot) : '',
        format:asset.ext?.toUpperCase(),tags:JSON.stringify(asset.tags || [])}));
      downloadWorkspaceFile(document,separator === '\t' ? 'Nexus 资产清单.tsv' : 'Nexus 资产清单.csv',
        writeAssetCsv(selected,cells,{separator,spreadsheetSafe:checked('spreadsheet-safe')}),
        separator === '\t' ? 'text/tab-separated-values;charset=utf-8' : 'text/csv;charset=utf-8');
    }
    setNotice('已生成 ' + source.length + ' 项资产的文件。');
  }

  async function exportCatalog() {
    const directory = projectRoot(true);
    const ids = [...new Set(chosenAssets().map(asset => asset.id))];
    const controls = [mode,related,options('[data-inventory-pick]')];
    const revision = request;
    htmlPath = '';
    busy = true;
    for (const control of controls) control.disabled = true;
    setNotice(`正在读取 ${ids.length} 项资产的封面并生成目录…`);
    renderControls();
    try {
      const result = await exportHtml(directory,ids,context);
      if (!inScope() || revision !== request) return;
      if (!result?.htmlPath || !Number.isInteger(result.assets) || !Number.isInteger(result.covers)) {
        throw Error('无法读取离线目录的保存结果');
      }
      htmlPath = result.htmlPath;
      const missing = result.assets-result.covers;
      setNotice(`已生成 ${result.assets} 项资产的离线目录，包含 ${result.covers} 张封面${missing ? `，${missing} 项使用占位图` : ''}。`);
    } catch (error) {
      if (inScope() && revision === request) setNotice(error.message || String(error));
    } finally {
      for (const control of controls) control.disabled = false;
      busy = false;
      renderControls();
    }
  }

  async function applyPlan() {
    const selected = checkedRows();
    if (!canImport || !selected.length) return;
    const controls = [...options('[data-inventory-options]').querySelectorAll('input,select,button')].filter(item => !item.disabled);
    controls.forEach(item => { item.disabled = true; });
    busy = true;
    stop = false;
    renderRows();
    let done = 0, failed = 0;
    try {
      for (const row of selected) {
        if (stop || !inScope()) break;
        setNotice('已更新 ' + done + ' · 失败 ' + failed + ' / ' + selected.length + ' 行');
        try {
          if (row.external) {
            const current = externalRegistry();
            if (current.has(row.external) && current.get(row.external) !== row.asset.id) throw Error('外部编号的关联已被其他窗口修改。');
            if (!current.has(row.external) && current.size >= 10000) throw Error('外部编号关联已达到 10,000 项。');
          }
          const changed = await apply(row.asset,row.patch,context);
          if (row.external && inScope()) {
            try {
              const current = externalRegistry();
              if (current.has(row.external) && current.get(row.external) !== row.asset.id) throw Error('外部编号的关联已被其他窗口修改。');
              current.set(row.external,row.asset.id);
              localStorage.setItem(registryPrefix + context,JSON.stringify([...current]));
            } catch (error) { throw Error((changed ? '资产资料已更新。' : '') + '外部编号未保存：' + error.message); }
          }
          row.done = true;
          done++;
        } catch (error) {
          row.error = error?.message || String(error);
          failed++;
        }
      }
    } finally {
      busy = false;
      controls.forEach(item => { item.disabled = false; });
      setNotice('已更新 ' + done + ' 行 · 失败 ' + failed + ' 行 · 未处理 ' + (selected.length - done - failed) + ' 行');
      renderRows();
      partlyApplied(context);
    }
  }

  document.querySelector('#asset-inventory').addEventListener('click',() => {
    closeMenu();
    context = scope();
    csv = plan = null;
    page = 0;
    request++;
    htmlPath = '';
    mode.value = 'csv';
    root.value = data().root || '';
    options('[data-inventory-file]').value = '';
    fields.replaceChildren(...Object.keys(inventoryFields).map(makeField));
    fieldButtons();
    columnBoxes();
    setNotice('');
    dialog.showModal();
    renderRows();
  });

  options('[data-inventory-file]').addEventListener('change',async event => {
    const revision = ++request;
    csv = plan = null;
    columnBoxes();
    renderRows();
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw Error('表格文件最多 4 MB。');
      const text = await file.text();
      if (!inScope() || revision !== request) return;
      csv = parseAssetCsv(text);
      columnBoxes();
      setNotice('已读取 ' + csv.records.length + ' 行，请核对列映射后预览。');
    } catch (error) { if (inScope() && revision === request) setNotice(error.message); }
    renderRows();
  });
  options('[data-inventory-pick]').addEventListener('click',async () => {
    const revision = request;
    try {
      const path = await pickFolder?.();
      if (path && revision === request && inScope()) {
        root.value = path;
        htmlPath = '';
        plan = null;
        renderRows();
      }
    } catch (error) { setNotice(error.message || String(error)); }
  });
  options('[data-inventory-options]').addEventListener('change',event => {
    if (event.target === root || event.target === mode || event.target === related) htmlPath = '';
    if (event.target.matches('[data-inventory-match-mode]')) columnBoxes();
    if (event.target.closest('[data-inventory-import]') || event.target === root) plan = null;
    renderRows();
  });
  fields.addEventListener('click',event => {
    const move = event.target.closest('[data-inventory-move]');
    if (!move) return;
    const item = move.closest('li');
    const other = move.dataset.inventoryMove === 'up' ? item.previousElementSibling : item.nextElementSibling;
    if (!other) return;
    if (move.dataset.inventoryMove === 'up') other.before(item);
    else other.after(item);
    fieldButtons();
    (move.disabled ? item.querySelector('[data-inventory-move]:not(:disabled)') : move)?.focus({preventScroll:true});
  });
  rows.addEventListener('change',event => {
    const row = plan?.[Number(event.target.dataset.inventoryRow)];
    if (!row) return;
    row.enabled = event.target.checked;
    renderControls();
  });
  rowControls.addEventListener('click',event => {
    const step = Number(event.target.dataset.inventoryStep);
    if (!step) return;
    page += step;
    rows.scrollTop = 0;
    renderRows();
  });
  options('[data-inventory-preview-action]').addEventListener('click',() => {
    try { if (inScope()) makePlan(); }
    catch (error) { plan = null; renderRows(); setNotice(error.message); }
  });
  action.addEventListener('click',async () => {
    if (!inScope() || busy) return;
    try {
      if (mode.value === 'import') void applyPlan();
      else if (mode.value === 'html') await exportCatalog();
      else exportInventory();
    } catch (error) { setNotice(error.message); }
  });
  options('[data-inventory-open-html]').addEventListener('click',async () => {
    if (!inScope() || !htmlPath || !openHtml) return;
    try { await openHtml(htmlPath); }
    catch (error) { if (inScope()) setNotice(error.message || String(error)); }
  });
  options('[data-inventory-stop]').addEventListener('click',() => { stop = true; setNotice('将完成当前行后停止。'); });
  dialog.addEventListener('cancel',event => { if (busy) event.preventDefault(); });
  options('[data-inventory-close]').addEventListener('click',() => { if (!busy) dialog.close(); });
}
