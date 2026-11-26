const batchLimit = 500;
const dateFormat = new Intl.DateTimeFormat('zh-CN', {dateStyle:'medium', timeStyle:'short'});
const actions = {
  list: ['list_recycled_assets', 'team_list_recycled_assets'],
  move: ['recycle_assets', 'team_recycle_assets'],
  delete: ['delete_workspace_assets', 'team_delete_workspace_assets'],
  restore: ['restore_recycled_assets', 'team_restore_recycled_assets'],
};

export function initAssetRecycle({api, context, asset, validateMove, refreshCatalog, notify}) {
  const get = id => document.getElementById(id);
  const bin = get('recycle-bin-dialog');
  const list = get('recycle-bin-list');
  const status = get('recycle-bin-status');
  const refreshButton = get('recycle-bin-refresh');
  const moveDialog = get('recycle-assets-dialog');
  const moveForm = get('recycle-assets-form');
  const moveStatus = get('recycle-assets-status');
  const moveTitle = get('recycle-assets-title');
  const moveConfirm = get('recycle-assets-submit');
  const moveItems = get('recycle-assets-items');
  const moveScope = get('recycle-assets-scope');
  let visit = null;
  let draft = null;
  let moving = false;
  let restoring = false;

  function current(snapshot) {
    const now = context();
    return now?.scope === snapshot.scope && now.epoch === snapshot.epoch && now.workspace === snapshot.workspace;
  }

  function request(action, snapshot, ids) {
    const [local, team] = actions[action];
    return api(snapshot.teamId ? team : local, {
      ...(snapshot.teamId ? {teamId:snapshot.teamId} : {}),
      ...(ids ? {ids} : {}),
    });
  }

  function message(error) {
    return String(error?.message || error);
  }

  function sourceVersion(id) {
    const item = asset(id);
    return item && JSON.stringify([item.path, item.size, item.modified]);
  }

  function isVisit(open) {
    return visit === open && bin.open && current(open.context);
  }

  function setBinBusy(open) {
    refreshButton.disabled = open.loading || restoring;
    bin.querySelector('.close-modal').disabled = restoring;
    for (const button of list.querySelectorAll('button')) button.disabled = restoring;
    list.setAttribute('aria-busy', String(open.loading || restoring));
  }

  function renderList(rows) {
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const item = document.createElement('li');
      const details = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = row.name;
      title.title = row.name;
      details.append(title);
      if (row.path) {
        const path = document.createElement('span');
        path.textContent = row.path;
        path.title = row.path;
        details.append(path);
      }
      const date = new Date(row.recycledAt * 1000);
      const time = document.createElement('time');
      if (row.recycledAt > 0 && Number.isFinite(date.valueOf())) {
        time.dateTime = date.toISOString();
        time.textContent = dateFormat.format(date);
      }
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'button subtle';
      restore.dataset.recycleRestore = row.id;
      restore.textContent = '恢复';
      restore.setAttribute('aria-label', `恢复 ${row.name}`);
      restore.disabled = restoring;
      item.append(details, time, restore);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
  }

  async function load(open) {
    if (!isVisit(open) || open.loading || restoring) return;
    open.loading = true;
    status.textContent = '正在加载回收站…';
    setBinBusy(open);
    try {
      const rows = await request('list', open.context);
      if (!isVisit(open)) return;
      if (!Array.isArray(rows)) throw Error('无法读取回收站内容，请重试');
      open.rows = rows.filter(row => typeof row?.id === 'string' && typeof row.name === 'string')
        .sort((a,b) => b.recycledAt - a.recycledAt || a.name.localeCompare(b.name, 'zh-CN'));
      renderList(open.rows);
      status.textContent = open.rows.length ? `共 ${open.rows.length} 项资产` : '回收站为空';
    } catch (failure) {
      if (isVisit(open)) status.textContent = message(failure);
    } finally {
      open.loading = false;
      if (visit === open) setBinBusy(open);
    }
  }

  function openBin() {
    const scope = context();
    if (!scope || bin.open) return;
    const open = {context:scope, rows:[], loading:false};
    visit = open;
    list.replaceChildren();
    get('recycle-bin-description').textContent =
      `${scope.name}的已回收资产。源文件保留在原位置，可恢复到资产库。`;
    bin.showModal();
    load(open);
  }

  refreshButton.addEventListener('click', () => {
    if (visit) load(visit);
  });
  bin.addEventListener('cancel', event => {
    if (restoring) event.preventDefault();
  });
  bin.addEventListener('close', () => {
    if (!bin.open) visit = null;
  });
  list.addEventListener('click', async event => {
    const id = event.target.closest('[data-recycle-restore]')?.dataset.recycleRestore;
    const open = visit;
    if (!id || !open || !isVisit(open) || open.loading || restoring) return;
    const index = open.rows.findIndex(row => row.id === id);
    if (index < 0) return;
    restoring = true;
    setBinBusy(open);
    status.textContent = '正在恢复资产…';
    let restored = false;
    try {
      const {changed} = await request('restore', open.context, [id]);
      restored = true;
      if (!isVisit(open)) return;
      open.rows = open.rows.filter(row => row.id !== id);
      renderList(open.rows);
      const result = changed ? '已恢复 1 项资产' : '这项资产已不在回收站';
      status.textContent = open.rows.length ? result : `${result}。回收站为空。`;
      await refreshCatalog(open.context, []);
    } catch (failure) {
      if (isVisit(open)) status.textContent = restored
        ? `恢复操作已完成，资产列表同步失败。 ${message(failure)}` : message(failure);
    } finally {
      restoring = false;
      if (visit === open) {
        setBinBusy(open);
        const buttons = list.querySelectorAll('button');
        (buttons[Math.min(index, buttons.length - 1)] || refreshButton).focus({preventScroll:true});
      }
    }
  });

  function confirm(ids, action = 'move') {
    const scope = context();
    if (!scope || moveDialog.open || moving) return;
    const active = [...new Set(ids)].filter(id => Boolean(asset(id)));
    if (!active.length) return;
    if (active.length > batchLimit) {
      notify(`一次最多可处理 ${batchLimit} 项资产。请减少选中项后重试。`, true);
      return;
    }
    const label = active.length === 1 ? `「${asset(active[0]).name}」` : `${active.length} 项资产`;
    const permanent = action === 'delete';
    const shared = scope.teamId ? '团队成员的共享资产列表将隐藏这些记录。' : '';
    const caption = permanent ? '永久删除源文件' : '移到回收站';
    moveTitle.textContent = moveConfirm.textContent = caption;
    moveConfirm.classList.toggle('danger', permanent);
    moveConfirm.classList.toggle('primary', !permanent);
    get('recycle-assets-description').textContent = permanent
      ? `将从${scope.teamId ? '共享存储' : '磁盘'}永久删除${label}的源文件。此操作不可从 Nexus 回收站恢复。`
      : `将${label}的资产记录移到 Nexus 回收站。${shared}源文件保留在原位置，可以随时恢复记录。`;
    if (moveScope) {
      const sourcePaths = new Set(active.map(id => asset(id).path).filter(Boolean));
      const sourceImpact = permanent ? `${sourcePaths.size} 条源路径` : '源文件保留';
      moveScope.querySelector('summary').textContent = `选择范围 · ${active.length} 条资产记录 · ${sourceImpact}`;
      moveScope.querySelector('[data-recycle-impact]').textContent = scope.teamId
        ? `团队库「${scope.name}」中的选中记录` : `个人库「${scope.name}」中的选中记录`;
      moveScope.open = permanent;
    }
    moveItems.replaceChildren(...active.map(id => {
      const item = asset(id);
      const row = document.createElement('li');
      row.textContent = item.name;
      if (permanent && item.path) {
        const path = document.createElement('small');
        path.textContent = item.path;
        row.append(path);
      }
      return row;
    }));
    moveStatus.textContent = '';
    draft = {context:scope, ids:active, action, versions:permanent ? active.map(sourceVersion) : null};
    moveDialog.showModal();
  }

  moveDialog.addEventListener('cancel', event => {
    if (moving) event.preventDefault();
  });
  moveDialog.addEventListener('close', () => {
    if (!moveDialog.open) draft = null;
  });
  moveForm.addEventListener('submit', async event => {
    event.preventDefault();
    const pending = draft;
    if (!pending || moving) return;
    const {context:scope, ids, action, versions} = pending;
    if (!current(scope) || ids.some((id, index) => !asset(id) || (versions && versions[index] !== sourceVersion(id)))) {
      moveStatus.textContent = '资产列表已更新，请关闭后重新选择资产。';
      return;
    }
    try {
      validateMove(ids);
    } catch (failure) {
      moveStatus.textContent = message(failure);
      return;
    }
    moving = true;
    const buttons = [...moveForm.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    moveStatus.textContent = action === 'delete' ? '正在删除源文件…' : '正在移到回收站…';
    try {
      const result = await request(action, scope, ids);
      if (action === 'delete') {
        if (!current(scope)) {
          moveDialog.close();
          return;
        }
        const {deleted, missing, failed, deletedIds, errors, indexPending} = result;
        const report = [`已永久删除 ${deleted} 项源文件`];
        if (missing) report.push(`${missing} 项源文件已不存在`);
        if (failed) report.push(`${failed} 项失败`, errors?.[0]);
        if (indexPending) report.push('资产列表等待同步');
        const text = report.filter(Boolean).join(' · ');
        if (failed && !deleted && !missing) {
          moveStatus.textContent = text;
          return;
        }
        moveDialog.close();
        try {
          await refreshCatalog(scope, deletedIds || []);
          if (current(scope)) notify(text, Boolean(failed || indexPending));
        } catch (failure) {
          if (current(scope)) notify(`${text}。资产列表同步失败。${message(failure)}`, true);
        }
        return;
      }
      const {changed} = result;
      moveDialog.close();
      if (!current(scope)) return;
      try {
        await refreshCatalog(scope, ids);
        if (current(scope)) notify(changed ? `已将 ${changed} 项资产移到回收站` : '选中的资产已在回收站');
      } catch (failure) {
        if (current(scope)) notify(`回收操作已完成，资产列表同步失败。 ${message(failure)}`, true);
      }
    } catch (failure) {
      if (draft === pending && current(scope)) moveStatus.textContent = message(failure);
    } finally {
      moving = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  });

  return {openBin, confirm, current};
}
