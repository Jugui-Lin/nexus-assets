const labels = {smb: 'SMB / NAS', webdav: 'HTTPS WebDAV', rclone: 'rclone'};
const statusLabels = {connected: '已挂载', starting: '正在启动', disconnected: '未连接', occupied: '盘符已占用', unknown: '状态未知'};

function makeButton(text, action, style = 'subtle') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button ' + style;
  button.textContent = text;
  button.addEventListener('click', action);
  return button;
}

export function initCloudMounts({api, enabled, onBrowse}) {
  const dialog = document.querySelector('#cloud-mount-dialog');
  const get = id => dialog.querySelector('#cloud-' + id);
  const form = get('mount-form');
  const status = get('status');
  const kind = get('kind');
  const drive = get('drive');
  const address = get('address');
  const remote = get('remote');
  const password = get('password');
  const submit = get('connect');
  let snapshot;
  let reconnect = null;
  let busy = false;
  let remoteRequest = 0;
  let remotePending = false;
  let remoteNotice;
  let timer;

  function updateControls() {
    const isRclone = kind.value === 'rclone';
    address.required = !isRclone;
    get('address-label').classList.toggle('hidden', isRclone);
    get('credentials').classList.toggle('hidden', isRclone);
    get('rclone').classList.toggle('hidden', !isRclone);
    get('address-label').firstElementChild.textContent = kind.value === 'webdav' ? 'WebDAV 地址' : '共享路径';
    address.placeholder = kind.value === 'webdav' ? 'https://nas.example.com/dav/' : '\\\\NAS\\素材库';
    submit.textContent = reconnect ? '重新挂载' : '挂载到盘符';
    submit.disabled = busy || !drive.value || (isRclone && (!remote.value || remotePending || Boolean(remoteNotice)));
    get('refresh').disabled = busy;
    get('new').classList.toggle('hidden', !reconnect);
    for (const field of [kind, drive, get('name'), address, remote, get('subpath')]) {
      field.disabled = busy || Boolean(reconnect);
    }
    get('user').disabled = password.disabled = get('new').disabled = busy;
  }

  function setOptions(select, values, wanted) {
    select.replaceChildren(...values.map(value => new Option(value, value)));
    if (values.includes(wanted)) select.value = wanted;
  }

  function render() {
    form.classList.toggle('hidden', !snapshot?.supported);
    setOptions(drive, reconnect ? [reconnect.drive] : snapshot?.availableDrives || [], reconnect?.drive || drive.value);
    const list = get('mount-list');
    list.replaceChildren();
    for (const record of snapshot?.mounts || []) {
      const row = document.createElement('div');
      row.className = 'team-library-row';
      const info = document.createElement('div');
      info.className = 'team-library-info';
      const title = document.createElement('strong');
      title.textContent = record.name;
      const detail = document.createElement('small');
      detail.textContent = [record.drive, labels[record.kind], record.address + (record.subpath ? ':' + record.subpath : ''), statusLabels[record.status]].join(' · ');
      info.append(title, detail);
      const actions = document.createElement('div');
      actions.className = 'cloud-actions';
      if (record.status === 'connected') {
        actions.append(makeButton('选择目录', () => onBrowse(record.drive + '\\')), makeButton('断开', () => changeRecord('disconnect', record)));
      } else if (record.status === 'starting') {
        actions.append(makeButton('停止挂载', () => changeRecord('disconnect', record)));
      } else {
        if (record.status === 'disconnected') actions.append(makeButton('重新挂载', () => edit(record)));
        actions.append(makeButton('移除记录', () => changeRecord('forget', record)));
      }
      for (const button of actions.children) button.disabled = busy;
      row.append(info, actions);
      list.append(row);
    }
    updateControls();
  }

  async function refresh() {
    clearTimeout(timer);
    if (!enabled || !dialog.open || busy) return;
    try {
      snapshot = await api('cloud_mount_list');
      if (!dialog.open) return;
      render();
      if (snapshot.mounts.some(record => record.status === 'starting')) {
        timer = setTimeout(refresh, 2000);
      }
    } catch (error) {
      status.textContent = String(error?.message || error);
    }
  }

  async function loadRemotes(wanted = remote.value) {
    const request = ++remoteRequest;
    remotePending = true;
    remoteNotice = '';
    get('rclone-help').textContent = '正在读取 rclone 配置…';
    updateControls();
    try {
      const result = await api('cloud_mount_remotes');
      if (request !== remoteRequest) return;
      setOptions(remote, result.names, wanted);
      remoteNotice = result.notice || (!result.names.length ? '请先用 rclone config 添加网盘。' : '');
      if (reconnect && !result.names.includes(reconnect.address)) {
        remoteNotice = '找不到原来的 rclone 网盘，请恢复 rclone 配置。';
      }
    } catch (error) {
      if (request === remoteRequest) remoteNotice = String(error?.message || error);
    } finally {
      if (request === remoteRequest) {
        remotePending = false;
        get('rclone-help').textContent = remoteNotice || '以只读方式挂载，打开文件时从网盘读取。';
        updateControls();
      }
    }
  }

  function edit(record = null) {
    reconnect = record;
    kind.value = record?.kind || 'smb';
    get('name').value = record?.name || '';
    address.value = record?.address || '';
    get('subpath').value = record?.subpath || '';
    get('user').value = '';
    password.value = '';
    render();
    if (kind.value === 'rclone') loadRemotes(record.address);
    if (record) (kind.value === 'rclone' ? submit : get('user')).focus();
  }

  async function changeRecord(action, record) {
    if (busy) return;
    busy = true;
    render();
    try {
      await api('cloud_mount_' + action, {id: record.id});
      status.textContent = action === 'disconnect' ? '已断开挂载。' : '已移除挂载记录。';
      if (reconnect?.id === record.id) edit();
    } catch (error) {
      status.textContent = String(error?.message || error);
    } finally {
      busy = false;
      render();
      await refresh();
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const input = {
      id: reconnect?.id || null, kind: kind.value, drive: drive.value, name: get('name').value,
      address: kind.value === 'rclone' ? remote.value : address.value,
      subpath: kind.value === 'rclone' ? get('subpath').value : null,
      username: kind.value === 'rclone' ? null : get('user').value,
      password: kind.value === 'rclone' ? null : password.value,
    };
    password.value = '';
    busy = true;
    status.textContent = '正在挂载…';
    render();
    try {
      const mounted = await api('cloud_mount_connect', {input});
      status.textContent = mounted.status === 'connected' ? '挂载成功。可以选择目录加入资产库。' : '挂载已启动，等待 Windows 盘符就绪。';
      edit();
    } catch (error) {
      status.textContent = String(error?.message || error);
    } finally {
      busy = false;
      render();
      await refresh();
    }
  });

  kind.addEventListener('change', () => {
    updateControls();
    if (kind.value === 'rclone') loadRemotes();
  });
  drive.addEventListener('change', updateControls);
  remote.addEventListener('change', updateControls);
  get('new').addEventListener('click', () => edit());
  get('browse').addEventListener('click', () => onBrowse(null));
  get('refresh').addEventListener('click', () => {
    status.textContent = '';
    refresh();
    if (kind.value === 'rclone') loadRemotes();
  });
  dialog.addEventListener('close', () => {
    password.value = '';
    clearTimeout(timer);
    ++remoteRequest;
    remotePending = false;
  });

  return {
    show() {
      if (dialog.open) return;
      get('refresh').classList.toggle('hidden', !enabled);
      status.textContent = '';
      dialog.showModal();
      if (!busy) edit();
      refresh();
    },
    close() { dialog.close(); },
  };
}
