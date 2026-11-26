import {reviewShotCode} from './whiteboard-review-notes.js';

const shotCode = /^[a-z0-9_-]{1,48}$/i;
const roles = {scene:'C4D 工程', render:'渲染序列', preview:'当前样片', board:'白板参考'};
const versionFormat = /^v[0-9a-z_-]{1,47}$/i;

export function initShotDashboard({enabled,api,scope,assets,activeAsset,boards,open,networkPath,closeMenu,notify}) {
  if (!enabled) return;
  const trigger = document.getElementById('shot-dashboard');
  const dialog = document.getElementById('shot-dashboard-dialog');
  const field = suffix => dialog.querySelector('#shot-dashboard-' + suffix);
  const status = field('status');
  let context;
  let selected;
  let editRole = 'scene';
  let projectList = [];
  let working = false;
  let epoch = 0;
  const key = () => 'nexus-shot-dashboard-v1:' + context;
  const current = () => dialog.open && scope() === context;
  const find = id => assets().find(item => item.id === id);
  const allowed = (role,asset) => role === 'scene' ? asset.ext?.toLowerCase() === 'c4d' : asset.kind === 'video';
  const report = message => { status.textContent = message || ''; };

  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(key()));
      return Array.isArray(stored) ? stored.filter(item => shotCode.test(item?.code || '')).slice(0,300) : [];
    } catch { return []; }
  }

  function save(mutator) {
    if (!current()) throw Error('资产工作区已切换，请重新打开镜头看板。');
    const records = load();
    mutator(records);
    localStorage.setItem(key(),JSON.stringify(records));
  }

  function update(change) {
    save(records => {
      const shot = records.find(item => item.code === selected);
      if (!shot) throw Error('此镜头已被移除。');
      change(shot);
    });
    render();
  }

  function button(text,action,disabled = false) {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'button subtle';
    control.textContent = text;
    control.disabled = disabled || working;
    control.addEventListener('click',() => {
      try { Promise.resolve(action()).catch(error => report(error.message || error)); }
      catch (error) { report(error.message || error); }
    });
    return control;
  }

  function setReference(role,value) {
    update(record => {
      record[role] = value;
    });
    report('');
  }

  function launch(role,value) {
    if (working) return;
    if (!current()) throw Error('资产工作区已切换。');
    const expected = context;
    dialog.close();
    void Promise.resolve(open(role,value,expected)).catch(error => notify(error.message || String(error),true));
  }

  function renderCandidates() {
    const list = field('candidates');
    const query = field('query').value.toLowerCase().trim();
    list.replaceChildren();
    if (!selected) return;
    const currentAsset = activeAsset();
    const matches = [];
    if (query) {
      const tokens = query.split(/\s+/);
      for (const asset of assets()) {
        if (allowed(editRole,asset) && tokens.every(token =>
          [asset.name,asset.relativePath || asset.path].join(' ').toLowerCase().includes(token))) matches.push(asset);
        if (matches.length >= 30) break;
      }
    } else if (currentAsset && allowed(editRole,currentAsset)) matches.push(currentAsset);
    for (const asset of matches) {
      const choice = button(asset.name,() => setReference(editRole,{id:asset.id,name:asset.name}));
      choice.title = asset.relativePath || asset.path || asset.name;
      list.append(choice);
    }
  }

  function render() {
    const records = load();
    if (!records.some(record => record.code === selected)) selected = records[0]?.code;
    const tabs = field('list');
    tabs.replaceChildren();
    for (const shot of records) {
      const select = button(shot.code,() => {
        selected = shot.code;
        field('query').value = '';
        report('');
        render();
        tabs.querySelector('[aria-pressed="true"]')?.focus();
      });
      select.setAttribute('aria-pressed',String(shot.code === selected));
      tabs.append(select);
    }
    const shot = records.find(item => item.code === selected);
    const panel = field('panel');
    panel.hidden = !shot;
    if (!shot) return;
    const refs = field('references');
    refs.replaceChildren();
    for (const [role,label] of Object.entries(roles)) {
      const value = shot[role];
      const row = document.createElement('div');
      row.className = 'shot-dashboard-reference';
      const kind = document.createElement('span');
      kind.textContent = label;
      const name = document.createElement('span');
      name.textContent = value?.name || '待关联';
      row.append(kind,name);
      if (value) row.append(button('打开',() => launch(role,value)),button('移除关联',() => setReference(role,null)));
      if (role === 'render') {
        row.append(button('选择渲染目录…', async () => {
          const target = selected;
          const path = await api('pick_folder');
          if (!path || !current() || selected !== target) return;
          const portable = await networkPath(path,false);
          if (current() && selected === target) setReference('render',{path:portable,name:path.split(/[/\\]/).filter(Boolean).at(-1) || path});
        }));
      }
      if (role === 'board') {
        row.append(button('定位镜头区域',() => launch('board-region',{code:shot.code,projectId:value?.id})));
        const picker = document.createElement('select');
        picker.setAttribute('aria-label','关联白板');
        picker.add(new Option('关联白板…',''));
        for (const project of projectList) picker.add(new Option(project.name,project.id));
        picker.disabled = working || !projectList.length;
        picker.value = value?.id || '';
        picker.addEventListener('change',() => {
          const selectedBoard = projectList.find(item => item.id === picker.value);
          if (selectedBoard) setReference('board',selectedBoard);
        });
        row.append(picker);
      }
      refs.append(row);
    }
    const versions = field('versions');
    versions.replaceChildren();
    for (const version of shot.versions || []) {
      const row = document.createElement('div');
      row.className = 'shot-dashboard-reference';
      const label = document.createElement('span');
      label.textContent = version.version;
      const date = document.createElement('span');
      date.textContent = new Date(version.lockedAt * 1000).toLocaleString();
      row.append(label,date,button('播放送审副本',() => launch('locked',version)));
      if (version.board) row.append(button('打开送审白板',() => launch('board',version.board)));
      if (version.scene) row.append(button('打开送审工程链接',() => launch('scene',version.scene)));
      versions.append(row);
    }
    field('lock').disabled = working || !shot.preview || !find(shot.preview.id);
    renderCandidates();
  }

  field('create').addEventListener('submit',event => {
    event.preventDefault();
    if (working) return;
    const input = field('code');
    const code = reviewShotCode(input.value);
    if (!code) { report('镜头号须以字母或数字开头，可包含连字符或下划线。'); return; }
    try {
      save(records => {
        if (records.some(record => record.code.toUpperCase() === code)) return;
        if (records.length >= 300) throw Error('当前看板已达到 300 个镜头。');
        records.unshift({code});
      });
      selected = code;
      input.value = '';
      report('');
      render();
    } catch (error) { report(error.message); }
  });
  field('kind').addEventListener('change',event => { editRole = event.target.value; renderCandidates(); });
  field('query').addEventListener('input',renderCandidates);
  field('lock-form').addEventListener('submit',async event => {
    event.preventDefault();
    if (!current() || working) return;
    const state = load().find(item => item.code === selected);
    const asset = state?.preview && find(state.preview.id);
    const version = field('version').value.trim().toUpperCase();
    if (!asset || !versionFormat.test(version)) { report('请选择当前样片，并输入如 V04 的版号。'); return; }
    if ((state.versions || []).some(item => item.version === version)) { report('此版号已经锁定。'); return; }
    working = true;
    render();
    try {
      const destination = await api('pick_folder');
      if (!destination || !current()) return;
      report('正在保存送审副本…');
      const locked = await api('lock_shot_preview',{assetId:asset.id,destination,shot:state.code,version});
      if (!current()) return;
      save(records => {
        const entry = records.find(record => record.code === state.code);
        if (!entry) throw Error('送审副本已保存，镜头记录已变化。');
        entry.versions = [{...locked,scene:state.scene,board:state.board},...(entry.versions || [])];
      });
      field('version').value = '';
      report('已锁定 ' + version);
    } catch (error) { if (current()) report(error.message || error); }
    finally { working = false; if (current()) render(); }
  });
  dialog.addEventListener('cancel',event => { if (working) event.preventDefault(); });
  field('close').addEventListener('click',() => { if (!working) dialog.close(); });
  trigger.hidden = false;
  trigger.addEventListener('click',async () => {
    const revision = ++epoch;
    context = scope();
    selected = null;
    projectList = [];
    field('query').value = '';
    report('');
    closeMenu();
    dialog.showModal();
    render();
    try {
      const options = await boards(context);
      if (revision !== epoch || !current()) return;
      projectList = options;
      render();
    } catch (error) { if (revision === epoch && current()) report(error.message || error); }
  });
}
