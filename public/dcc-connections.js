const targetLabels = {
  ready: '待同步',
  initialize: '等待宿主首次启动',
  installed: '已安装',
  update: '待更新',
  conflict: '文件冲突',
};
const importSections = {c4d:'general', blender:'blender', max:'max'};
const focusRefreshInterval = 60_000;

export function initDccConnections({hosts, native, viewportPlacement, api, getSessions, escape, icon, open, openImportSettings}) {
  const dialog = document.querySelector('#connections-dialog');
  const cards = dialog.querySelector('#dcc-cards');
  const refreshButton = dialog.querySelector('#refresh-dcc-status');
  const feedback = dialog.querySelector('#bridge-sync-status');
  const notice = dialog.querySelector('#dcc-connection-notice');
  let detection;
  let pending;
  let syncFailed = false;
  let lastSyncStarted = -Infinity;
  let signature = '';

  function message(text, failed = false) {
    feedback.textContent = text;
    feedback.classList.toggle('error', failed);
  }

  function hostStatus(id) {
    return detection?.find(item => item.dcc === id);
  }

  function canChooseExecutable(id, status = hostStatus(id)) {
    return Boolean(native && viewportPlacement && !syncFailed && status?.supported &&
      (id === 'c4d' || !status.targets?.length));
  }

  function render() {
    const sessions = getSessions();
    const online = Object.fromEntries(Object.keys(hosts).map(id => [id, sessions.filter(session => session.dcc === id).length]));
    const placementHosts = new Set(viewportPlacement
      ? sessions.filter(session => session.placement === true).map(session => session.dcc) : []);
    const smartImport = sessions.some(session => session.dcc === 'c4d' && session.smartImport === true);
    const busy = Boolean(pending);
    const nextSignature = JSON.stringify([detection, busy, syncFailed, online, [...placementHosts], smartImport]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const before = document.activeElement;
    const focus = cards.contains(before) && ['importSettings','chooseExecutable'].find(key => before.dataset[key]);
    refreshButton.hidden = !native;
    refreshButton.disabled = !native || busy;
    cards.setAttribute('aria-busy',String(busy));

    cards.innerHTML = Object.entries(hosts).map(([id, host]) => {
      const status = hostStatus(id);
      const versions = (status?.targets ?? []).map(target => {
        const details = [target.path,target.activation].filter(Boolean).join(' · ');
        const state = id === 'c4d' && target.status === 'initialize' ? '先运行一次以创建首选项' :
          targetLabels[target.status] || '未知状态';
        const label = target.restartRequired ? state + '，重启后生效' : state;
        return '<span class="dcc-target" data-state="' + escape(target.status) + '" title="' + escape(details) + '">' +
          escape(target.version) + ' · ' + escape(label) + '</span>';
      }).join('');
      const availability = !native ? '请在桌面端使用'
        : status?.supported === false ? '当前系统不支持此宿主'
        : status ? '未检测到支持的版本'
        : busy ? '正在检测版本…'
        : syncFailed ? '暂时无法确认版本' : '等待检测';
      const onlineBadge = online[id] ? '<span class="dcc-online" title="宿主已连接">' + online[id] + ' 个在线</span>' : '';
      const placement = placementHosts.has(id);
      const placementBadge = placement ? '<span class="dcc-placement">视口放置</span>' : '';
      const smartBadge = id === 'c4d' && smartImport ? '<span class="dcc-placement">智能导入</span>' : '';
      const placementHelp = placement ? '<p class="dcc-placement-help">拖入 3D 视口并松手，移动鼠标预览，点击放下，Esc 取消。</p>' : '';
      const settings = native && importSections[id] ? '<button type="button" class="button dcc-import-settings" data-import-settings="' + id +
        '" aria-haspopup="dialog" aria-controls="smart-import-dialog" aria-label="' + escape(host.name) + ' 导入设置">' + icon('sliders') + '导入设置</button>' : '';
      const pickerLabel = id === 'c4d' && status?.targets?.length ? '查找其他版本' : '选择程序';
      const chooseExecutable = canChooseExecutable(id,status) ?
        '<button type="button" class="button dcc-choose-executable" data-choose-executable="' + id + '"' + (busy ? ' disabled' : '') +
        ' aria-label="' + escape(host.name + ' ' + pickerLabel) + '">' + icon('folder') + pickerLabel + '…</button>' : '';
      const actions = settings || chooseExecutable
        ? '<div class="dcc-card-actions"><div class="dcc-secondary-actions">' + chooseExecutable + settings + '</div></div>' : '';
      return '<article class="dcc-card"><span aria-hidden="true" class="dcc-logo">' + escape(host.logo) +
        '</span><div class="dcc-info"><h3>' + escape(host.name) + onlineBadge + placementBadge + smartBadge + '</h3><p>' + escape(host.hint) +
        '</p>' + placementHelp + '<div class="dcc-targets">' + (versions || '<span>' + availability + '</span>') +
        '</div></div>' + actions + '</article>';
    }).join('');

    if (focus) {
      const next = [...cards.querySelectorAll('button')].find(button => button.dataset[focus] === before.dataset[focus]);
      if (next && !next.disabled) next.focus({preventScroll:true});
    }
  }

  async function sync(dcc) {
    lastSyncStarted = performance.now();
    message('正在检测并同步桥接…');
    try {
      const {statuses,completed,errors} = await api('sync_bridges',dcc ? {dcc} : {});
      if (!Array.isArray(statuses)) throw Error('未收到桥接状态');
      detection = statuses;
      syncFailed = false;
      const updated = completed?.length ? '已同步 ' + completed.length + ' 项桥接。' : '';
      const failures = errors?.length ? errors.join('\n') : '';
      message([updated,failures].filter(Boolean).join('\n') || '检测完成。',Boolean(failures));
    } catch (error) {
      syncFailed = true;
      message('检测或同步失败 · ' + (error?.message || error),true);
    }
  }

  function run(work) {
    if (!native || pending) return pending;
    pending = Promise.resolve().then(work).finally(() => {
      pending = null;
      render();
    });
    render();
    return pending;
  }

  function refresh() {
    return run(() => sync());
  }

  async function chooseBridgeExecutable(dcc) {
    const host = hosts[dcc];
    if (!host || pending || !canChooseExecutable(dcc)) return;
    await run(async () => {
      try {
        const result = await api('choose_bridge_executable',{dcc});
        if (result) {
          detection = result;
          await sync(dcc);
        }
      } catch (error) {
        message('无法选择 ' + host.name + ' · ' + (error?.message || error),true);
      }
    });
    if (dialog.open) {
      const next = cards.querySelector('[data-choose-executable="' + dcc + '"]') || refreshButton;
      next.focus({preventScroll:true});
    }
  }

  refreshButton.addEventListener('click',refresh);
  if (native) window.addEventListener('focus',() => {
    if (!pending && performance.now() - lastSyncStarted >= focusRefreshInterval) void refresh();
  });
  cards.addEventListener('click',event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.chooseExecutable) void chooseBridgeExecutable(button.dataset.chooseExecutable);
    const host = button.dataset.importSettings;
    if (host) {
      const settings = openImportSettings(importSections[host]);
      settings.addEventListener('close',() => {
        if (dialog.open) cards.querySelector('[data-import-settings="' + host + '"]')?.focus({preventScroll:true});
      },{once:true});
    }
  });

  return {
    render,
    refresh,
    show(reason) {
      notice.textContent = reason || '';
      notice.hidden = !reason;
      open();
      render();
      void refresh();
    },
  };
}
