const targetLabels = {
  ready: '待安装',
  initialize: '首次启动后可安装',
  installed: '已安装',
  update: '可更新',
  conflict: '文件冲突',
};
const importSections = {c4d:'general', blender:'blender', max:'max'};

export function initDccConnections({hosts, native, viewportPlacement, api, getSessions, escape, icon, toast, open, openImportSettings, onUpdates}) {
  const dialog = document.querySelector('#connections-dialog');
  const cards = dialog.querySelector('#dcc-cards');
  const refreshButton = dialog.querySelector('#refresh-dcc-status');
  const feedback = dialog.querySelector('#bridge-export-result');
  let detection;
  let busy;
  let signature = '';

  function message(text, failed = false) {
    feedback.textContent = text;
    feedback.classList.toggle('error', failed);
  }

  function updateDetection(result) {
    detection = result;
    onUpdates(result.flatMap(({dcc, supported, targets = []}) => {
      if (!supported || !hosts[dcc]) return [];
      const versions = [...new Set(targets.filter(target => target.status === 'update').map(target => target.version))];
      return versions.length ? [{id:dcc, name:hosts[dcc].name, versions}] : [];
    }));
  }

  function render() {
    const sessions = getSessions();
    const online = Object.fromEntries(Object.keys(hosts).map(id => [id, sessions.filter(session => session.dcc === id).length]));
    const placementHosts = new Set(viewportPlacement
      ? sessions.filter(session => session.placement === true).map(session => session.dcc) : []);
    const smartImport = sessions.some(session => session.dcc === 'c4d' && session.smartImport === true);
    const nextSignature = JSON.stringify([detection, busy, online, [...placementHosts], smartImport]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const before = document.activeElement;
    const focus = cards.contains(before) && ['install', 'export', 'importSettings', 'chooseExecutable'].find(key => before.dataset[key]);
    refreshButton.disabled = !native || Boolean(busy);

    cards.innerHTML = Object.entries(hosts).map(([id, host]) => {
      const status = detection?.find(item => item.dcc === id);
      const targets = status?.targets ?? [];
      const installable = targets.filter(target => ['ready', 'installed', 'update'].includes(target.status));
      const canInstall = native && !busy && status?.supported && installable.length > 0;
      const installing = busy === 'install:' + id;
      const label = installing ? '正在安装…'
        : installable.some(target => target.status === 'ready') ? '自动安装'
        : installable.some(target => target.status === 'update') ? '更新插件'
        : installable.length ? '重新安装' : '自动安装';
      const versions = targets.map(target => {
        const details = [target.path, target.activation].filter(Boolean).join(' · ');
        return '<span class="dcc-target" data-state="' + escape(target.status) + '" title="' + escape(details) + '">' +
          escape(target.version) + ' · ' + escape(targetLabels[target.status] || '未知状态') + '</span>';
      }).join('');
      const availability = !native ? '桌面端可安装'
        : status?.supported === false ? '当前系统不支持此宿主'
        : busy === 'detect' ? '正在检测版本…'
        : status ? '未检测到支持的版本' : '等待检测';
      const onlineBadge = online[id] ? '<span class="dcc-online" title="宿主已连接">' + online[id] + ' 个在线</span>' : '';
      const placement = placementHosts.has(id);
      const placementBadge = placement ? '<span class="dcc-placement">视口放置</span>' : '';
      const smartBadge = id === 'c4d' && smartImport ? '<span class="dcc-placement">智能导入</span>' : '';
      const placementText = placement
        ? '拖入 3D 视口并松手，移动鼠标预览，点击放下，Esc 取消。'
        : id === 'blender' && viewportPlacement
          ? '安装或更新插件后重启 Blender，即可在 3D 视口预览并放置模型。'
          : '';
      const placementHelp = placementText ? '<p class="dcc-placement-help">' + placementText + '</p>' : '';
      const settings = native && importSections[id] ? '<button type="button" class="button dcc-import-settings" data-import-settings="' + id +
        '" aria-haspopup="dialog" aria-controls="smart-import-dialog" aria-label="' + escape(host.name) + ' 导入设置">' + icon('sliders') + '导入设置</button>' : '';
      const chooseExecutable = viewportPlacement && status?.supported !== false ?
        '<button type="button" class="button dcc-export" data-choose-executable="' + id + '"' + (busy ? ' disabled' : '') +
        ' aria-label="' + escape(host.name) + ' 选择程序">' + icon('folder') + '选择程序…</button>' : '';
      return '<article class="dcc-card"><span aria-hidden="true" class="dcc-logo">' + escape(host.logo) +
        '</span><div class="dcc-info"><h3>' + escape(host.name) + onlineBadge + placementBadge + smartBadge + '</h3><p>' + escape(host.hint) +
        '</p>' + placementHelp + '<div class="dcc-targets">' + (versions || '<span>' + availability + '</span>') +
        '</div></div><div class="dcc-card-actions"><button type="button" class="button primary" data-install="' + id +
        '"' + (canInstall ? '' : ' disabled') + '>' + label + '</button><div class="dcc-secondary-actions">' + chooseExecutable + settings +
        '<button type="button" class="button dcc-export" data-export="' + id +
        '"' + (native && !busy ? '' : ' disabled') + '>' + icon('download') + '导出脚本</button></div></div></article>';
    }).join('');

    if (focus) {
      const next = [...cards.querySelectorAll('button')].find(button => button.dataset[focus] === before.dataset[focus]);
      if (next && !next.disabled) next.focus({preventScroll: true});
    }
  }

  async function detect(notice = '') {
    if (!native || busy) return;
    busy = 'detect';
    message(notice || '正在检查已安装的创作软件…', Boolean(notice));
    render();
    try {
      updateDetection(await api('bridge_install_status'));
      message(notice, Boolean(notice));
    } catch (error) {
      message('检测失败 · ' + (error?.message || error), true);
    } finally {
      busy = null;
      render();
    }
  }

  async function install(dcc) {
    const host = hosts[dcc];
    if (!host || !native || busy) return;
    busy = 'install:' + dcc;
    message('正在安装 ' + host.name + ' 桥接…');
    render();
    try {
      const {completed, errors} = await api('install_bridge', {dcc});
      const targets = detection?.find(item => item.dcc === dcc)?.targets ?? [];
      // Update the successfully written rows even if the subsequent rescan is unavailable.
      for (const target of targets) {
        if (completed.includes(target.version)) target.status = 'installed';
      }
      try {
        updateDetection(await api('bridge_install_status'));
      } catch {
        // Keep verified installation results.
        if (detection) updateDetection(detection);
      }
      const installed = completed.length ? '已安装 ' + host.name + ' ' + completed.join('、') + '。重启 ' + host.name + ' 以加载桥接。' : '';
      const failure = errors.length ? errors.join('\n') : (!completed.length ? '没有可用的安装目标' : '');
      message([installed, failure].filter(Boolean).join('\n'), Boolean(failure));
      if (completed.length) toast(host.name + ' 桥接已安装，重启宿主后加载');
    } catch (error) {
      message('安装失败 · ' + (error?.message || error), true);
    } finally {
      busy = null;
      render();
    }
  }

  async function exportScript(dcc) {
    if (!hosts[dcc] || !native || busy) return;
    busy = 'export:' + dcc;
    render();
    try {
      const result = await api('export_bridge', {dcc});
      if (result) {
        message('脚本已保存到 ' + result.path + '。在目标软件中打开并运行。');
        toast('桥接脚本已导出');
      }
    } catch (error) {
      message('导出失败 · ' + (error?.message || error), true);
    } finally {
      busy = null;
      render();
    }
  }

  async function chooseBridgeExecutable(dcc) {
    const host = hosts[dcc];
    if (!host || !native || busy) return;
    busy = 'choose:' + dcc;
    render();
    try {
      const result = await api('choose_bridge_executable', {dcc});
      if (result) {
        updateDetection(result);
        message('已保存 ' + host.name + ' 的程序位置。');
      }
    } catch (error) {
      message('无法选择 ' + host.name + ' · ' + (error?.message || error), true);
    } finally {
      busy = null;
      render();
      cards.querySelector(`[data-choose-executable="${dcc}"]`)?.focus({preventScroll:true});
    }
  }

  refreshButton.addEventListener('click', () => detect());
  cards.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.install) install(button.dataset.install);
    if (button.dataset.export) exportScript(button.dataset.export);
    if (button.dataset.chooseExecutable) chooseBridgeExecutable(button.dataset.chooseExecutable);
    const host = button.dataset.importSettings;
    if (host) {
      const settings = openImportSettings(importSections[host]);
      settings.addEventListener('close', () => {
        if (dialog.open) cards.querySelector(`[data-import-settings="${host}"]`)?.focus({preventScroll:true});
      }, {once:true});
    }
  });

  return {
    render,
    refresh: detect,
    show(notice) {
      open();
      render();
      if (notice) message(notice, true);
      void detect(notice);
    },
  };
}
