const ROOT = '/apps/bdpan';
const ROOT_LABEL = '我的应用数据 / bdpan';
const APP_FOLDER = ROOT + '/Nexus Assets';

export function initBaiduCloud({api, native, copy, workspace, icon, closeMenu, log = () => {}}) {
  const dialog = document.querySelector('#baidu-cloud-dialog');
  const get = name => dialog.querySelector('#baidu-cloud-' + name);
  const status = get('status');
  const rows = get('rows');
  const up = get('up');
  const add = get('add');
  const refresh = get('refresh');
  const logout = get('logout');
  const logoutConfirm = get('logout-confirm');
  const createFolder = get('create-folder');
  const more = get('more');
  const browser = get('browser');
  const device = get('device');
  const code = get('code');
  const copyButton = get('copy');
  const cancel = get('cancel');
  let view = null;

  const request = (current, kind, fields = {}) => api('baidu_cloud', {
    teamId: current.workspace.teamId, action: {kind, ...fields},
  });
  const isCurrent = current => view === current && dialog.open && workspace().scope === current.workspace.scope;
  const report = error => { status.textContent = String(error?.message || error); };
  const displayPath = path => ROOT_LABEL + path.slice(ROOT.length).replaceAll('/', ' / ');

  function update(current) {
    const {mode, path, link, next, authorization, busy, connected, available, confirming} = current;
    const isTeam = Boolean(current.workspace.teamId);
    get('location').textContent = mode === 'pick' ? displayPath(path)
      : mode === 'files' ? [link.name, path].filter(Boolean).join(' / ')
      : isTeam ? '团队共享的网盘文件夹' : '个人库的网盘文件夹';
    get('location').title = get('location').textContent;
    up.classList.toggle('hidden', mode === 'links');
    add.classList.toggle('hidden', (mode === 'links' && !available) || mode === 'files' || Boolean(authorization));
    add.textContent = mode === 'pick' ? (isTeam ? '共享此文件夹' : '添加此文件夹')
      : connected ? '选择文件夹' : '登录百度网盘';
    add.disabled = busy || Boolean(confirming) || (mode === 'pick' && path === ROOT);
    refresh.classList.toggle('hidden', mode !== 'links' || !native || Boolean(authorization));
    refresh.disabled = busy || Boolean(confirming);
    logout.classList.toggle('hidden', mode !== 'links' || !connected || Boolean(authorization) || Boolean(confirming));
    logout.disabled = busy;
    logoutConfirm.classList.toggle('hidden', confirming !== 'logout');
    get('logout-submit').disabled = busy;
    get('logout-cancel').disabled = busy;
    createFolder.classList.toggle('hidden', mode !== 'pick' || path !== ROOT || current.hasAppFolder);
    createFolder.disabled = busy;
    get('notice').classList.toggle('hidden', mode !== 'links' || connected || !available || Boolean(authorization));
    up.disabled = busy;
    more.classList.toggle('hidden', next == null);
    more.disabled = busy;
    device.classList.toggle('hidden', !authorization);
    const codeLabel = authorization?.userCode ? '百度授权码 ' + authorization.userCode : '';
    if (code.textContent !== codeLabel) {
      code.textContent = codeLabel;
      clearTimeout(current.copyTimer);
      copyButton.textContent = '复制授权码';
    }
    copyButton.classList.toggle('hidden', !authorization?.userCode);
    browser.classList.toggle('hidden', !authorization?.verificationUrl);
    cancel.disabled = busy;
    for (const button of rows.querySelectorAll('button')) button.disabled = busy || confirming === 'logout';
  }

  function makeRow({name, metadata, glyph, activate, control}) {
    const item = document.createElement('div');
    item.className = 'baidu-cloud-row';
    const label = document.createElement(activate ? 'button' : 'div');
    if (activate) {
      label.type = 'button';
      label.addEventListener('click', activate);
    }
    label.className = 'baidu-cloud-row-name';
    label.innerHTML = icon(glyph);
    const nameElement = document.createElement('span');
    nameElement.textContent = name;
    nameElement.title = name;
    label.append(nameElement);
    item.append(label);
    if (metadata) {
      const detail = document.createElement('span');
      detail.className = 'muted baidu-cloud-row-meta';
      detail.textContent = metadata;
      item.append(detail);
    }
    if (control) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button subtle';
      button.textContent = control.label;
      button.setAttribute('aria-label', control.label + ' ' + name);
      button.addEventListener('click', control.click);
      item.append(button);
    }
    return item;
  }

  async function run(task, message = '') {
    const current = view;
    if (!isCurrent(current) || current.busy) return;
    current.linksGeneration++;
    current.busy = true;
    status.textContent = message;
    update(current);
    try {
      await task(current);
    } catch (error) {
      if (isCurrent(current)) report(error);
    } finally {
      current.busy = false;
      if (isCurrent(current)) update(current);
    }
  }

  function renderLinks(current, links) {
    current.links = links;
    rows.replaceChildren(...links.map(link => makeRow({
      name:link.name, metadata:link.owner, glyph:'link',
      activate:() => run(active => loadDirectory(active, 'files', '', link), '正在读取网盘目录…'),
      control:link.owned ? {label:'取消链接', click: () => confirmRemove(current, link)} : null,
    })));
    status.textContent = links.length ? '' : current.workspace.teamId
      ? '当前团队还没有共享的网盘文件夹。已登录的成员可选择文件夹并共享。'
      : '当前个人库还没有添加网盘文件夹。';
  }

  function confirmRemove(current, link) {
    if (!isCurrent(current) || current.busy) return;
    current.confirming = 'remove';
    update(current);
    status.textContent = '取消「' + link.name + '」的链接？网盘原文件会保留。';
    const buttons = document.createElement('div');
    buttons.className = 'baidu-cloud-bar';
    for (const [label, click] of [
      ['返回', () => run(loadLinks)],
      ['确认取消链接', () => run(async active => {
        await request(active, 'remove', {id:link.id});
        if (isCurrent(active)) await loadLinks(active);
      })],
    ]) {
      const button = document.createElement('button');
      button.className = 'button subtle';
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', click);
      buttons.append(button);
    }
    rows.replaceChildren(buttons);
    buttons.firstChild.focus();
  }

  async function loadLinks(current) {
    const wasBrowsing = current.mode !== 'links' || Boolean(current.confirming);
    current.mode = 'links';
    current.next = null;
    current.confirming = null;
    if (wasBrowsing) rows.replaceChildren();
    if (!native) { status.textContent = '请在 Nexus 桌面版连接百度网盘'; return; }
    const generation = current.linksGeneration;
    let connection;
    const currentList = () => isCurrent(current) && current.mode === 'links' && generation === current.linksGeneration;
    const connectionTask = request(current, 'status').then(value => {
      connection = value;
      if (!currentList()) return;
      current.available = value.available;
      current.connected = value.connected;
      if (value.upgradeRequired) status.textContent = '请先更新 NAS 上的 Nexus 团队服务。';
      else if (!value.available) status.textContent = '当前环境无法连接百度网盘。';
      update(current);
    }).catch(() => {
      if (currentList() && current.links?.length === 0) status.textContent += ' 暂时无法获取当前账号的登录状态。';
    });
    try {
      const links = await request(current, 'links');
      if (currentList() && connection?.available !== false) renderLinks(current, links);
    } catch (error) {
      await connectionTask;
      if (connection?.available !== false) throw error;
    }
  }

  async function refreshSharedLinks() {
    const current = view;
    if (!current?.workspace.teamId || !isCurrent(current) || !current.available || current.mode !== 'links' ||
      current.busy || current.authorization || current.confirming || current.refreshing || document.hidden) return;
    current.refreshing = true;
    const generation = current.linksGeneration;
    try {
      const links = await request(current, 'links');
      if (isCurrent(current) && generation === current.linksGeneration && current.mode === 'links' && !current.busy && !current.confirming && !current.authorization &&
        JSON.stringify(links) !== JSON.stringify(current.links)) {
        renderLinks(current, links);
        update(current);
      }
    } catch { /* Keep the last visible shared list. */ }
    finally { current.refreshing = false; }
  }

  function size(bytes) {
    return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
      : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B';
  }

  async function loadDirectory(current, mode, path, link = null, offset = 0) {
    const page = await request(current, mode === 'pick' ? 'browse' : 'list',
      {path, offset, ...(link && {id:link.id})});
    if (!isCurrent(current)) return;
    Object.assign(current, {mode, path, link, next:page.nextOffset});
    if (mode === 'pick' && path === ROOT) {
      current.hasAppFolder = (offset > 0 && current.hasAppFolder) || page.entries.some(entry => entry.directory && entry.path === APP_FOLDER);
    }
    if (!offset) rows.replaceChildren();
    for (const entry of page.entries) {
      rows.append(makeRow({
        name:entry.name, metadata:entry.directory ? '' : size(entry.size),
        glyph:entry.directory ? 'folder' : 'download',
        activate:entry.directory
          ? () => run(active => loadDirectory(active, mode, entry.path, link), '正在读取网盘目录…')
          : () => run(async active => {
            const result = await request(active, 'download', {id:link.id, path:entry.path});
            if (!isCurrent(active)) return;
            status.textContent = result.saved ? '已保存「' + entry.name + '」' : '';
          }, '正在下载「' + entry.name + '」…'),
      }));
    }
    status.textContent = rows.childElementCount ? '' : mode === 'pick' && path === ROOT
      ? '授权目录为空。可以创建 Nexus Assets 文件夹，再选择添加或共享。' : '当前文件夹为空';
  }

  function scheduleAuthorizationPoll(current) {
    const authorization = current.authorization;
    clearTimeout(current.timer);
    current.timer = setTimeout(async () => {
      const isActive = () => isCurrent(current) && current.authorization === authorization;
      if (!isActive()) return;
      let progress;
      try {
        progress = await request(current, 'poll');
      } catch (error) {
        if (isActive()) {
          current.authorization = null;
          update(current);
          report(error);
        }
        return;
      }
      if (!isActive()) return;
      if (progress.connected) current.busy = true;
      try {
        await showAuthorization(current, progress);
      } catch (error) {
        if (isCurrent(current)) report(error);
      } finally {
        if (progress.connected) current.busy = false;
        if (isCurrent(current)) update(current);
      }
    }, 2200);
  }

  async function showAuthorization(current, progress) {
    const authorization = current.authorization;
    if (progress.connected) {
      current.authorization = null;
      current.connected = true;
      status.textContent = '授权已完成，正在读取网盘目录…';
      update(current);
      await loadDirectory(current, 'pick', ROOT);
      return;
    }
    if (!progress.pending) {
      current.authorization = null;
      throw Error('登录未完成，请重新登录百度网盘');
    }
    authorization.pending = true;
    authorization.verificationUrl = progress.verificationUrl || authorization.verificationUrl;
    authorization.userCode = progress.userCode || authorization.userCode;
    const message = authorization.verificationUrl ? '请在百度网页完成授权'
      : '正在等待百度授权…';
    if (status.textContent !== message) status.textContent = message;
    update(current);
    if (authorization.verificationUrl && !authorization.opened) {
      authorization.opened = true;
      api('baidu_open_authorization', {url:authorization.verificationUrl}).catch(() => {});
    }
    scheduleAuthorizationPoll(current);
  }

  const open = () => {
    closeMenu?.();
    view = {workspace:workspace(), mode:'links', path:'', next:null, linksGeneration:0};
    rows.replaceChildren();
    get('context').textContent = view.workspace.teamId
      ? '在百度网页授权后选择要共享的目录。授权由团队 NAS 保管，同一团队的成员可以直接浏览已共享的文件夹。'
      : '从百度网盘授权目录选择文件夹，添加到当前个人库。';
    get('notice').textContent = view.workspace.teamId
      ? '百度官方网盘工具处于测试阶段。请备份重要文件、仅在可信的 NAS 上授权，并在百度网页核对授权范围。请妥善保管授权信息，核对要共享的文件夹。百度可能因违规或风险暂停服务。'
      : '登录会调用百度官方网盘工具。请在打开的百度页面核对授权范围。';
    dialog.showModal();
    run(loadLinks, '正在读取网盘连接…');
  };
  document.querySelector('#baidu-cloud').addEventListener('click', open);
  refresh.addEventListener('click', () => run(loadLinks, '正在刷新网盘文件夹…'));
  setInterval(refreshSharedLinks, 12_000);
  createFolder.addEventListener('click', () => run(async current => {
    const result = await request(current, 'createAppFolder');
    if (!isCurrent(current)) return;
    if (result?.path !== APP_FOLDER) throw Error('网盘未确认 Nexus Assets 文件夹。');
    await loadDirectory(current, 'pick', result.path);
  }, '正在准备 Nexus Assets 文件夹…'));
  logout.addEventListener('click', () => {
    const current = view;
    if (!isCurrent(current) || current.busy || !current.connected) return;
    current.confirming = 'logout';
    status.textContent = current.workspace.teamId
      ? '退出后，你共享的文件夹将暂停访问。重新登录后请重新选择要共享的文件夹。'
      : '退出后，当前账号的文件夹将暂停访问。重新登录后请重新选择要添加的文件夹。';
    update(current);
    get('logout-cancel').focus();
  });
  get('logout-cancel').addEventListener('click', () => {
    if (!isCurrent(view) || view.busy) return;
    view.confirming = null;
    renderLinks(view, view.links || []);
    update(view);
    logout.focus();
  });
  get('logout-submit').addEventListener('click', () => run(async current => {
    await request(current, 'logout');
    if (!isCurrent(current)) return;
    current.connected = false;
    await loadLinks(current);
  }, '正在退出百度网盘…'));
  up.addEventListener('click', () => run(current => {
    if (current.mode === 'pick' && current.path === ROOT || current.mode === 'files' && !current.path) {
      return loadLinks(current);
    }
    return loadDirectory(current, current.mode, current.path.split('/').slice(0, -1).join('/'), current.link);
  }));
  more.addEventListener('click', () => run(current =>
    loadDirectory(current, current.mode, current.path, current.link, current.next)));
  add.addEventListener('click', () => run(async current => {
    if (current.mode === 'pick') {
      const link = await request(current, 'add', {path:current.path});
      if (!isCurrent(current)) return;
      await loadLinks(current);
      if (isCurrent(current)) status.textContent = current.workspace.teamId ? `已共享「${link.name}」，团队成员可在这里查看。` : `已添加「${link.name}」。`;
    } else if (current.connected) {
      await loadDirectory(current, 'pick', ROOT);
    } else {
      current.authorization = {};
      try {
        const initial = await request(current, 'start');
        if (isCurrent(current)) await showAuthorization(current, initial);
        else await request(current, 'cancel').catch(() => {});
      } catch (error) { current.authorization = null; throw error; }
    }
  }, '正在处理…'));
  copyButton.addEventListener('click', async () => {
    const current = view;
    const userCode = current?.authorization?.userCode;
    if (!userCode || !isCurrent(current)) return;
    let label = '已复制';
    try {
      await copy(userCode);
    } catch {
      label = '复制失败';
    }
    log(label === '已复制' ? '复制百度网盘授权码完成' : '复制百度网盘授权码失败',
      label === '已复制' ? 'info' : 'error');
    if (!isCurrent(current) || current.authorization?.userCode !== userCode) return;
    clearTimeout(current.copyTimer);
    copyButton.textContent = label;
    current.copyTimer = setTimeout(() => { copyButton.textContent = '复制授权码'; }, 1600);
  });
  browser.addEventListener('click', async () => {
    const current = view;
    const url = current?.authorization?.verificationUrl;
    if (!url || !isCurrent(current)) return;
    try {
      await api('baidu_open_authorization', {url});
    } catch (error) {
      if (isCurrent(current) && current.authorization?.verificationUrl === url) report(error);
    }
  });
  cancel.addEventListener('click', () => run(async current => {
    const authorization = current.authorization;
    clearTimeout(current.timer);
    current.authorization = null;
    try {
      await request(current, 'cancel');
    } catch (error) {
      if (isCurrent(current)) {
        current.authorization = {...authorization};
        scheduleAuthorizationPoll(current);
      }
      throw error;
    }
    if (isCurrent(current)) await loadLinks(current);
  }, '正在取消登录…'));
  dialog.addEventListener('close', () => {
    const current = view;
    view = null;
    clearTimeout(current?.timer);
    clearTimeout(current?.copyTimer);
    if (current?.authorization?.pending) request(current, 'cancel').catch(() => {});
  });
}
