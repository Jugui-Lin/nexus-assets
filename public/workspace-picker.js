const openingViewKey = 'nexus-workspace-opening-view';

export function workspaceOpeningView(preferences = localStorage) {
  try {
    const view = preferences.getItem(openingViewKey);
    return view === 'favorites' ? 'favorites' : 'all';
  } catch { return 'all'; }
}

export function initWorkspacePicker({api, native, teamChoice, onWorkspace, onEnterTeam, onTeam, onImport, canSwitch,
  onPersonalRenamed, onTeamRenamed, notify, preferences = localStorage}) {
  const trigger = document.querySelector('#workspace-settings');
  const panel = document.querySelector('#workspace-switcher');
  const search = panel.querySelector('#workspace-search');
  const choices = panel.querySelector('#workspace-choices');
  const status = panel.querySelector('#workspace-switcher-status');
  const actions = panel.querySelector('#workspace-switcher-actions');
  const createForm = panel.querySelector('#workspace-quick-create');
  const nameInput = createForm.querySelector('#workspace-create-name');
  const nameLabel = createForm.querySelector('label');
  const saveName = createForm.querySelector('[type="submit"]');
  const createLocation = createForm.querySelector('#workspace-create-location');
  const createNameMaxLength = nameInput.maxLength;
  const dialog = document.querySelector('#workspace-dialog');
  const dialogStatus = dialog.querySelector('#workspace-status');
  const openingView = dialog.querySelector('#workspace-opening-view');
  let anchor = null;
  let busy = false;
  let snapshot;
  let renameDraft = null;

  function position() {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const left = rect.right - width;
    panel.style.left = Math.max(8, Math.min(left, innerWidth - width - 8)) + 'px';
    panel.style.top = rect.bottom + 6 + 'px';
    panel.style.maxHeight = Math.max(100, innerHeight - rect.bottom - 14) + 'px';
  }

  function close(restoreFocus = false) {
    if (!anchor) return;
    const previous = anchor;
    anchor = null;
    panel.classList.add('hidden');
    previous.setAttribute('aria-expanded', 'false');
    if (restoreFocus) previous.focus({preventScroll:true});
  }

  function render() {
    const current = snapshot?.current;
    const shared = teamChoice();
    dialog.querySelector('#workspace-current-name').textContent = current?.name || '个人工作空间';
    const currentPath = dialog.querySelector('#workspace-current-path');
    currentPath.textContent = current?.path || (native ? '正在读取…' : '桌面版可管理本地数据库');
    currentPath.title = current?.path || '';
    dialog.querySelector('#workspace-current-storage').hidden = !current?.path;
    dialog.querySelector('#workspace-migrate').disabled = busy || !native;
    dialog.querySelector('#workspace-team').disabled = busy || !native;
    if (!anchor) return;

    const personal = current ? [current, ...(snapshot.workspaces || []).filter(item => item.id !== current.id)] : [];
    const options = personal.map(item => ({
      ...item, selected:item.id === current.id && !shared?.active,
      action:item.id === current.id ? 'personal' : 'activate',
    }));
    if (shared) options.push({...shared, selected:shared.active, path:'团队资产库', action:'enter-team'});
    const term = search.value.trim().toLocaleLowerCase();
    choices.replaceChildren();
    for (const item of options) {
      if (!([item.name, item.path].join(' ').toLocaleLowerCase().includes(term))) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-choice';
      button.disabled = busy;
      if (item.selected) button.setAttribute('aria-current', 'true');
      button.title = item.path || item.name;
      const icon = document.createElement('span');
      icon.className = 'workspace-choice-icon';
      icon.textContent = item.action === 'enter-team' ? '团' : '库';
      icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'workspace-choice-text';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const path = document.createElement('small');
      path.textContent = item.path || '';
      text.append(name, path);
      button.append(icon, text);
      if (item.selected) {
        const check = document.createElement('span');
        check.className = 'workspace-choice-current';
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');
        button.append(check);
      }
      button.addEventListener('click', () => item.selected ? close(true) : change(item.action, item.id));
      const row = document.createElement('div');
      row.className = 'workspace-choice-row';
      row.append(button);
      const isTeam = item.action === 'enter-team';
      if (native && (!isTeam || item.canRename && item.teamId)) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'icon-button workspace-choice-rename';
        edit.dataset.workspaceRename = isTeam ? 'team' : 'personal';
        edit.disabled = busy;
        edit.title = '重命名';
        edit.setAttribute('aria-label', '重命名 ' + item.name);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(svg.namespaceURI, 'use');
        use.setAttribute('href', '#i-edit');
        svg.append(use);
        edit.append(svg);
        edit.addEventListener('click', () => toggleCreate(true, {
          id: isTeam ? item.teamId : item.id, name:item.name, isTeam,
        }));
        row.append(edit);
      }
      choices.append(row);
    }
    if (!choices.childElementCount) {
      const message = document.createElement('p');
      message.className = 'workspace-choice-empty';
      message.textContent = term ? '没有匹配的工作空间' : native ? '正在读取工作空间…' : '桌面版可切换工作空间';
      choices.append(message);
    }
    actions.querySelector('[data-workspace-action="team"]').classList.toggle('hidden', Boolean(shared));
    for (const button of panel.querySelectorAll('[data-workspace-action], [type="submit"]')) {
      const availableOnWeb = ['settings', 'import'].includes(button.dataset.workspaceAction);
      button.disabled = busy || (!native && !availableOnWeb);
    }
    position();
  }

  async function read() {
    if (!native) return null;
    snapshot = await api('personal_workspaces');
    render();
    return snapshot.current;
  }

  async function change(action, id = null, name = null, fromSettings = false) {
    if (!native || busy) return;
    const feedback = fromSettings ? dialogStatus : status;
    busy = true;
    render();
    try {
      if (!await canSwitch() || (fromSettings ? !dialog.open : !anchor)) return;
      feedback.textContent = action === 'create' ? '请选择个人库数据目录…' :
        action === 'migrate' ? '准备迁移数据库…' : '正在打开工作空间…';
      if (action === 'enter-team') {
        await onEnterTeam();
      } else if (action === 'personal') {
        await onWorkspace(snapshot?.current || await read());
      } else {
        const result = await api('change_personal_workspace', {action, id, name});
        if (!result) {
          feedback.textContent = '';
          return;
        }
        snapshot = result;
        await onWorkspace(snapshot.current);
      }
      if (fromSettings) dialog.close();
      else close(true);
      if (action === 'migrate') notify('数据库已迁移，原数据库可作备份');
    } catch (e) {
      feedback.textContent = String(e?.message || e);
    } finally {
      busy = false;
      render();
    }
  }

  function toggleCreate(value, draft = null) {
    renameDraft = value ? draft : null;
    createForm.classList.toggle('hidden', !value);
    actions.classList.toggle('hidden', value);
    status.textContent = '';
    nameLabel.textContent = draft?.isTeam ? '团队库名称' : '个人库名称';
    saveName.textContent = draft ? '保存名称' : '选择数据目录…';
    createLocation.hidden = Boolean(draft);
    if (draft) saveName.removeAttribute('aria-describedby');
    else saveName.setAttribute('aria-describedby',createLocation.id);
    nameInput.maxLength = draft ? (draft.isTeam ? 400 : 200) : createNameMaxLength;
    if (value) {
      nameInput.value = draft?.name || '';
      nameInput.focus();
      if (draft) nameInput.select();
    } else search.focus();
  }

  async function rename(target, name) {
    if (!native || busy) return;
    const limit = target.isTeam ? 200 : 100;
    if (!name || Array.from(name).length > limit || /\p{Cc}/u.test(name)) {
      status.textContent = `请输入 1 至 ${limit} 个字符的名称。`;
      nameInput.focus();
      return;
    }
    if (name === target.name) {
      toggleCreate(false);
      return;
    }
    const shared = target.isTeam ? teamChoice() : null;
    if (target.isTeam && (shared?.teamId !== target.id || !shared.canRename)) {
      status.textContent = '团队或管理权限已更改，请重新打开工作空间。';
      return;
    }
    busy = true;
    nameInput.disabled = true;
    status.textContent = '正在保存名称…';
    render();
    try {
      if (target.isTeam) {
        const result = await api('team_rename_workspace', {teamId:target.id, name});
        onTeamRenamed(result);
      } else {
        snapshot = await api('change_personal_workspace', {action:'rename', id:target.id, name});
        onPersonalRenamed(snapshot.current);
      }
      search.value = '';
      toggleCreate(false);
      notify('工作空间已重命名');
    } catch (error) {
      status.textContent = String(error?.message || error);
    } finally {
      busy = false;
      nameInput.disabled = false;
      render();
      if (renameDraft === target) nameInput.focus();
    }
  }

  async function openSettings() {
    close(true);
    dialogStatus.textContent = snapshot?.warning || '';
    openingView.value = workspaceOpeningView(preferences);
    render();
    if (!dialog.open) dialog.showModal();
    if (!snapshot) {
      try { await read(); }
      catch (e) { dialogStatus.textContent = String(e?.message || e); }
    }
  }

  trigger.addEventListener('click', async () => {
    if (busy) return;
    if (anchor) { close(true); return; }
    anchor = trigger;
    anchor.setAttribute('aria-expanded', 'true');
    panel.classList.remove('hidden');
    search.value = '';
    createForm.reset();
    toggleCreate(false);
    status.textContent = snapshot?.warning || '';
    render();
    if (!snapshot) {
      try { await read(); }
      catch (e) { status.textContent = String(e?.message || e); }
    }
  });
  search.addEventListener('input', render);
  panel.querySelector('#close-workspace-switcher').addEventListener('click', () => { if (!busy) close(true); });
  panel.addEventListener('click', event => {
    if (busy) return;
    const action = event.target.closest('[data-workspace-action]')?.dataset.workspaceAction;
    if (action === 'create') toggleCreate(true);
    else if (action === 'cancel-create') toggleCreate(false);
    else if (action === 'open') change('open');
    else if (action === 'settings') openSettings();
    else if (action === 'import') { close(true); onImport(); }
    else if (action === 'team') { close(true); onTeam(); }
  });
  createForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (renameDraft) rename(renameDraft, name);
    else if (name) change('create', null, name);
    else nameInput.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (anchor && !busy && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (busy) { event.preventDefault(); return; }
      event.preventDefault();
      if (!createForm.classList.contains('hidden')) toggleCreate(false);
      else close(true);
    } else if (event.key === 'ArrowDown' && event.target === search) {
      const first = choices.querySelector('button:not(:disabled)');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('resize', position);
  openingView.addEventListener('change', () => preferences.setItem(openingViewKey, openingView.value));
  dialog.querySelector('#workspace-migrate').addEventListener('click', () => change('migrate', null, null, true));
  dialog.querySelector('#workspace-team').addEventListener('click', () => {
    if (busy) return;
    dialog.close();
    onTeam();
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });

  return {read};
}

