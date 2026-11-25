const preference = 'nexus-browser-capture-target-v1';

function savedTarget() {
  try { return JSON.parse(localStorage.getItem(preference)); }
  catch { return null; }
}

export function initBrowserCaptureDestination({get, workspaces, libraries, active, changed}) {
  const workspaceSelect = get('workspace');
  const librarySelect = get('library');
  const folderSelect = get('folder');
  const note = get('target-note');
  let available = [];
  let sources = [];
  let request = 0;
  let busy = false;
  let loading = false;
  let ready = false;

  function target() {
    if (!ready || loading) return null;
    const workspace = available.find(item => item.key === workspaceSelect.value);
    const library = sources.find(item => item.id === librarySelect.value);
    if (!workspace || !library) return null;
    const location = {libraryId:library.id || null, folder:folderSelect.value};
    return workspace.kind === 'team'
      ? {kind:'team', teamId:workspace.id, ...location}
      : {kind:'personal', workspaceId:workspace.id, ...location};
  }

  function renderDisabled() {
    workspaceSelect.disabled = busy || !available.length;
    librarySelect.disabled = busy || loading || !sources.length;
    folderSelect.disabled = busy || loading || !ready || folderSelect.options.length < 2;
    changed();
  }

  function setFolders(preferred = '') {
    const library = sources.find(item => item.id === librarySelect.value);
    const folders = [...new Set((library?.folders || []).filter(value => typeof value === 'string' && value))];
    const root = !library ? '请选择目录来源' : library.id ? '根目录' : '库默认采集目录';
    folderSelect.replaceChildren(new Option(root, ''), ...folders.map(folder => new Option(folder, folder)));
    folderSelect.value = folders.includes(preferred) ? preferred : '';
    ready = Boolean(library);
    renderDisabled();
  }

  async function setWorkspace(preferred) {
    const workspace = available.find(item => item.key === workspaceSelect.value);
    if (!workspace) return;
    const generation = ++request;
    ready = false;
    loading = true;
    sources = [];
    librarySelect.replaceChildren(new Option('正在读取…', ''));
    setFolders();
    note.textContent = '';
    try {
      const rows = await libraries(workspace);
      if (generation !== request) return;
      sources = Array.isArray(rows) ? rows.filter(item => item?.id && item.name) : [];
      if (workspace.kind === 'personal') {
        sources.unshift({id:'', name:'库默认采集目录', folders:[]});
      }
      const options = sources.map(source => new Option(source.name, source.id));
      if (workspace.kind === 'team' && options.length) options.unshift(new Option('请选择已链接目录', ''));
      librarySelect.replaceChildren(...options);
      if (sources.some(item => item.id === preferred?.libraryId)) librarySelect.value = preferred.libraryId;
      if (!sources.length) {
        librarySelect.add(new Option('无可写入的已链接目录', ''));
        note.textContent = '请先链接可写入的团队目录。';
      }
      setFolders(librarySelect.value === preferred?.libraryId ? preferred.folder : '');
    } catch (error) {
      if (generation !== request) return;
      librarySelect.replaceChildren(new Option('无法读取', ''));
      note.textContent = String(error?.message || error || '目标资产库暂不可用');
    } finally {
      if (generation === request) {
        loading = false;
        renderDisabled();
      }
    }
  }

  async function refresh() {
    const generation = ++request;
    loading = true;
    ready = false;
    available = [];
    sources = [];
    note.textContent = '';
    workspaceSelect.replaceChildren(new Option('正在读取…', ''));
    librarySelect.replaceChildren(new Option('请选择资产库', ''));
    setFolders();
    try {
      const rows = await workspaces();
      if (generation !== request) return;
      available = rows;
      if (!rows.length) throw Error('没有可导入的资产库');
      workspaceSelect.replaceChildren(...rows.map(row => new Option(row.name, row.key)));
      const stored = savedTarget();
      const preferred = rows.some(row => row.key === stored?.key) ? stored : active();
      if (rows.some(row => row.key === preferred?.key)) workspaceSelect.value = preferred.key;
      await setWorkspace(preferred?.key === workspaceSelect.value ? preferred : null);
    } catch (error) {
      if (generation !== request) return;
      loading = false;
      workspaceSelect.replaceChildren(new Option('无法读取', ''));
      note.textContent = String(error?.message || error || '无法读取资产库');
      renderDisabled();
    }
  }

  function remember() {
    if (!target()) return;
    try {
      localStorage.setItem(preference, JSON.stringify({
        key:workspaceSelect.value, libraryId:librarySelect.value, folder:folderSelect.value,
      }));
    } catch {}
  }

  workspaceSelect.addEventListener('change', async () => {
    await setWorkspace(null);
    remember();
  });
  librarySelect.addEventListener('change', () => { setFolders(); remember(); });
  folderSelect.addEventListener('change', remember);

  return {
    target, refresh, remember,
    stop() { request++; },
    setBusy(value) { busy = value; renderDisabled(); },
  };
}
