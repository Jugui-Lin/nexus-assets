import {defaultFileWorkspacePreferences as defaults, mergeFilePreferences, validateFilePreference} from './file-workspace-preferences.js';
import {downloadWorkspaceFile} from './workspace-download.js';

const format = 'nexus-file-preferences';
const undoKey = 'nexus-file-preference-transfer-undo-v1';
const groups = [
  ['启动与标签页', {
    startWorkspace:'启动工作区', startMode:'首次打开文件夹时', startLocation:'新标签页位置',
    startupPaths:'启动路径', newTabAction:'按加号时', confirmCloseTabs:'关闭多个标签页时确认',
  }],
  ['文件夹显示', {
    compact:'紧凑视图', showFrequent:'显示常用文件夹', showHidden:'显示隐藏项目',
    stackSequences:'堆叠序列帧', showUnindexed:'显示未入库标记',
    showThumbnails:'显示缩略图', showStatus:'显示状态栏', showExtensions:'显示文件扩展名',
    showNavigation:'显示导航窗格', showToolbar:'显示操作工具栏', showBookmarks:'显示书签栏',
  }],
  ['打开方式与手势', {
    openMode:'打开文件和文件夹', openBookmarkInNewTab:'在新标签页中打开书签',
    quickPreview:'空格键快速预览', doubleClickUp:'双击空白处返回上一级',
    ctrlDoubleClickTab:'Ctrl 双击标签时新建标签页', doubleClickCloseTab:'双击标签关闭',
    wheelSwitchTabs:'滚轮切换标签页',
  }],
];
const valueLabels = {
  assets:'资产库', files:'文件夹标签页', computer:'此电脑', home:'主文件夹',
  new:'打开一个新标签页', restore:'恢复上次的文件夹标签页', paths:'打开指定路径',
  single:'单击打开', double:'双击打开', menu:'显示新建菜单', current:'复制当前标签',
  all:'全部资产', favorites:'资产收藏', recent:'最近入库',
};
const actionLabels = {export:'导出所选设置', import:'应用所选设置', reset:'恢复所选设置', undo:'确认撤回'};
const same = (left,right) => JSON.stringify(left) === JSON.stringify(right);

function describe(value) {
  if (Array.isArray(value)) return value.join('\n') || '未设置';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return valueLabels[value] || String(value);
}

function readValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('设置文件缺少有效的设置项。');
  const accepted = {};
  const rejected = {};
  let unknown = 0;
  for (const [key,value] of Object.entries(values)) {
    if (!Object.hasOwn(defaults,key)) {
      unknown++;
      continue;
    }
    try { accepted[key] = validateFilePreference(key,value); }
    catch (error) { rejected[key] = error.message; }
  }
  return {accepted,rejected,unknown};
}

function loadUndo() {
  try {
    const record = JSON.parse(localStorage.getItem(undoKey));
    if (!record || !Number.isFinite(record.time)) return null;
    const before = readValues(record.before);
    const after = readValues(record.after);
    const keys = Object.keys(before.accepted);
    if (before.unknown || after.unknown || Object.keys(before.rejected).length ||
        Object.keys(after.rejected).length || !keys.length || keys.length !== Object.keys(after.accepted).length ||
        !keys.every(key => Object.hasOwn(after.accepted,key))) return null;
    return {before:before.accepted, after:after.accepted, time:record.time};
  } catch { return null; }
}

export function initFilePreferenceTransfer({controller,closeMenu}) {
  const dialog = document.getElementById('file-preference-transfer-dialog');
  if (!controller || !dialog) return;
  const field = name => dialog.querySelector('#file-preference-transfer-' + name);
  const mode = field('mode');
  const file = field('file');
  const paths = field('paths');
  const rows = field('rows');
  const status = field('status');
  const apply = field('apply');
  let preview;
  let revision = 0;
  let imported;

  function updateAction() {
    apply.disabled = !rows.querySelector('input[data-file-preference]:checked:not(:disabled)');
  }

  function render() {
    const current = controller.get();
    const operation = mode.value;
    const undo = operation === 'undo' ? loadUndo() : null;
    const stale = undo && Object.entries(undo.after).some(([key,value]) => !same(current[key],value));
    const source = operation === 'import' ? imported?.accepted || {}
      : operation === 'reset' ? defaults
      : operation === 'undo' ? undo?.before || {}
      : current;
    preview = {current,source,undo};
    field('file-label').hidden = operation !== 'import';
    field('path-label').hidden = operation !== 'export';
    apply.textContent = actionLabels[operation];
    rows.replaceChildren();
    for (const [title,labels] of groups) {
      const group = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = title;
      group.append(legend);
      for (const [key,label] of Object.entries(labels)) {
        const rejected = operation === 'import' && imported?.rejected[key];
        if (!rejected && (!Object.hasOwn(source,key) || (operation !== 'export' && same(current[key],source[key])))) continue;
        const row = document.createElement('label');
        row.className = 'file-preference-transfer-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.filePreference = key;
        checkbox.disabled = Boolean(rejected || stale || (operation === 'export' && !paths.checked &&
          (key === 'startupPaths' || (key === 'startMode' && current.startMode === 'paths'))));
        checkbox.checked = !checkbox.disabled;
        if (operation === 'undo' && checkbox.checked) checkbox.disabled = true;
        const name = document.createElement('span');
        name.textContent = label;
        const old = document.createElement('small');
        const next = document.createElement('small');
        old.textContent = describe(current[key]);
        next.textContent = operation === 'export' ? (same(current[key],defaults[key]) ? '默认值' : '本机自定义')
          : rejected || '→ ' + describe(source[key]);
        row.append(checkbox,name,old,next);
        group.append(row);
      }
      if (group.children.length > 1) rows.append(group);
    }
    updateAction();
    if (operation === 'undo') apply.disabled = !undo || stale;
    if (stale) status.textContent = '这些设置之后又修改过，原撤回记录已失效。';
    else if (undo) status.textContent = '最近一次导入或恢复于 ' + new Date(undo.time).toLocaleString();
    else if (operation === 'undo') status.textContent = '暂无可撤回的导入或恢复记录。';
    else if (operation === 'import' && imported?.unknown) status.textContent = '已跳过 ' + imported.unknown + ' 项无法识别的设置。';
    else if (operation === 'import' && imported && !rows.childElementCount) status.textContent = '文件中没有需要更新的设置。';
    else if (operation === 'reset' && !rows.childElementCount) status.textContent = '当前设置均为默认值。';
    else status.textContent = '';
  }

  function commit() {
    const operation = mode.value;
    const keys = [...rows.querySelectorAll('input[data-file-preference]:checked')]
      .map(checkbox => checkbox.dataset.filePreference);
    const current = controller.get();
    if (keys.some(key => !same(current[key],preview.current[key])) ||
        (operation === 'undo' && !same(loadUndo(),preview.undo))) {
      render();
      throw Error('其他窗口已修改设置，请重新核对。');
    }
    if (!keys.length) return;
    const changes = Object.fromEntries(keys.map(key => [key,preview.source[key]]));
    if (operation === 'export') {
      if (changes.startMode === 'paths' && !changes.startupPaths?.length) throw Error('请同时勾选启动路径或取消勾选指定路径启动。');
      downloadWorkspaceFile(document,'Nexus 文件夹与标签页设置.json',JSON.stringify({format,version:1,values:changes},null,2));
      status.textContent = '已生成所选设置文件。';
      return;
    }
    mergeFilePreferences(current,changes);
    const previous = localStorage.getItem(undoKey);
    if (operation === 'undo') localStorage.removeItem(undoKey);
    else localStorage.setItem(undoKey,JSON.stringify({
      before:Object.fromEntries(keys.map(key => [key,current[key]])), after:changes, time:Date.now(),
    }));
    try { controller.replace(changes); }
    catch (error) {
      if (previous === null) localStorage.removeItem(undoKey);
      else localStorage.setItem(undoKey,previous);
      throw error;
    }
    render();
    status.textContent = (operation === 'undo' ? '已撤回 ' : '已更新 ') + keys.length + ' 项设置。';
  }

  document.getElementById('file-preference-transfer').addEventListener('click',() => {
    closeMenu();
    mode.value = 'export';
    file.value = '';
    paths.checked = false;
    imported = undefined;
    render();
    dialog.showModal();
  });
  dialog.addEventListener('close',() => { revision++; });
  mode.addEventListener('change',render);
  paths.addEventListener('change',render);
  rows.addEventListener('change',updateAction);
  file.addEventListener('change',async () => {
    const request = ++revision;
    const selected = file.files[0];
    imported = undefined;
    render();
    if (!selected) return;
    try {
      if (selected.size > 1024 * 1024) throw Error('设置文件超过 1 MB。');
      const payload = JSON.parse(await selected.text());
      if (payload?.format !== format || payload.version !== 1) throw Error('此文件与当前版本的设置格式不兼容。');
      if (request !== revision) return;
      imported = readValues(payload.values);
      render();
    } catch (error) {
      if (request === revision && mode.value === 'import') status.textContent = error instanceof SyntaxError
        ? '文件内容不是有效的 JSON。' : error.message || '读取设置文件失败。';
    }
  });
  apply.addEventListener('click',() => {
    try { commit(); }
    catch (error) { status.textContent = error.message || '操作未完成。'; }
  });
}
