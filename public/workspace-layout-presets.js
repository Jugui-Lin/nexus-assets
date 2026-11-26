const key = 'nexus-workspace-layout-presets-v1';
const layoutLabels = {grid:'缩略图网格',masonry:'瀑布流',list:'资产列表'};
const sizeLabels = {compact:'小',normal:'标准',large:'大'};

export function initWorkspaceLayoutPresets({preferences,scope,closeMenu,enabled,capture,apply,notify}) {
  const dialog = document.getElementById('workspace-layout-presets-dialog');
  const trigger = document.getElementById('workspace-layout-presets');
  const field = name => dialog.querySelector('#workspace-layout-presets-' + name);
  const choice = field('choice');
  const status = field('status');
  let context;
  let presets = [];

  function load() {
    try {
      const source = JSON.parse(preferences.getItem(key));
      return Array.isArray(source) ? source.filter(item => item && typeof item.name === 'string' &&
        item.name.length > 0 && item.name.length <= 48 && item.data?.panels && layoutLabels[item.data.view]).slice(0,24) : [];
    } catch { return []; }
  }

  function store(next) {
    if (context !== scope()) throw Error('工作空间已切换，请重新打开布局快照。');
    preferences.setItem(key,JSON.stringify(next));
    presets = next;
  }

  function preview() {
    const settings = presets.find(item => item.name === choice.value)?.data;
    const panels = settings?.panels;
    field('apply').disabled = !settings;
    field('remove').disabled = !settings;
    const width = value => Number.isFinite(value) ? ' · ' + value + ' px' : '';
    field('preview').textContent = panels ? [
      '显示方式　' + layoutLabels[settings.view],
      '缩略图　' + (settings.zoom ? settings.zoom + ' px' : sizeLabels[settings.density]),
      '左侧导航　' + (panels.collapsed?.sidebar ? '收起' : '展开') + width(panels.sidebar),
      '资产详情　' + (panels.collapsed?.inspector ? '收起' : panels.inspectorDock === 'bottom' ? '底部' : '右侧') + width(panels.inspector),
      ...(settings.search?.query ? ['搜索　' + settings.search.query] : []),
    ].join('\n') : '选择已保存的布局查看详情。';
  }

  function render(name = '') {
    choice.replaceChildren(new Option('选择布局快照',''),...presets.map(item => new Option(item.name,item.name)));
    choice.value = name || presets[0]?.name || '';
    preview();
  }

  trigger.addEventListener('click',() => {
    closeMenu();
    if (!enabled()) { notify('请先打开资产列表，再保存或使用布局。',true); return; }
    context = scope();
    presets = load();
    field('name').value = '';
    field('search').checked = false;
    status.textContent = '';
    render();
    dialog.showModal();
  });
  choice.addEventListener('change',() => { status.textContent = ''; preview(); });
  field('create').addEventListener('submit',event => {
    event.preventDefault();
    const name = field('name').value.trim();
    if (!name || name.length > 48) return;
    try {
      const latest = load();
      if (latest.some(item => item.name === name)) throw Error('已有同名布局，请换一个名称。');
      if (latest.length >= 24) throw Error('当前工作空间最多保存 24 个布局。');
      store([{name,data:capture(field('search').checked)},...latest]);
      render(name);
      field('name').value = '';
      status.textContent = '布局已保存。';
    } catch (error) { status.textContent = error.message || String(error); }
  });
  field('apply').addEventListener('click',() => {
    try {
      if (context !== scope()) throw Error('工作空间已切换，请重新打开布局快照。');
      const preset = presets.find(item => item.name === choice.value);
      if (!preset || !enabled()) return;
      apply(preset.data);
      dialog.close();
      notify('已应用布局「' + preset.name + '」');
    } catch (error) { status.textContent = error.message || String(error); }
  });
  field('remove').addEventListener('click',() => {
    try {
      store(load().filter(item => item.name !== choice.value));
      render();
      status.textContent = '已移除布局快照。';
    } catch (error) { status.textContent = error.message || String(error); }
  });
}
