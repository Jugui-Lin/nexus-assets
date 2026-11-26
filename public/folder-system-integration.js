export function initFolderSystemIntegration({ api, enabled, closeMenu }) {
  if (!enabled) return;

  const element = (suffix = '') => document.getElementById(`folder-system-integration${suffix}`);
  const menuButton = element();
  const dialog = element('-dialog');
  const status = element('-status');
  const error = element('-error');
  const actions = element('-actions');
  const enable = element('-enable');
  const restore = element('-restore');
  const refresh = element('-refresh');
  const confirmation = element('-confirmation');
  const cancel = element('-cancel');
  const confirm = element('-confirm');
  let state = null;
  let busy = false;

  const setHidden = (target, hidden) => target.classList.toggle('hidden', hidden);
  const setConfirming = confirming => {
    setHidden(actions, confirming);
    setHidden(confirmation, !confirming);
  };

  async function run(command, pendingMessage) {
    if (busy) return;
    busy = true;
    setConfirming(false);
    dialog.setAttribute('aria-busy', 'true');
    error.textContent = '';
    status.textContent = pendingMessage;
    for (const button of [enable, restore, refresh]) button.disabled = true;

    try {
      state = await api(command);
    } catch (failure) {
      error.textContent = String(failure?.message ?? failure);
      state = null;
      if (command !== 'folder_shell_status') {
        try {
          state = await api('folder_shell_status');
        } catch {
          // The retry button allows a fresh query if this check fails as well.
        }
      }
    } finally {
      busy = false;
      dialog.removeAttribute('aria-busy');
      for (const button of [enable, restore, refresh]) button.disabled = false;
      setHidden(enable, !(state?.supported && state.canEnable));
      setHidden(restore, !(state?.supported && state.canRestore));
      setHidden(refresh, Boolean(state));
      status.textContent = state?.detail || (state?.supported
        ? (state.enabled ? '已设为默认文件管理器。' : '尚未设为默认文件管理器。')
        : (state ? '当前版本无法设置默认文件管理器。' : '无法读取默认文件管理器状态。'));
    }
  }

  const readStatus = () => run('folder_shell_status', '正在读取当前设置…');

  menuButton.addEventListener('click', () => {
    closeMenu?.();
    if (!dialog.open) dialog.showModal();
    void readStatus();
  });
  refresh.addEventListener('click', readStatus);
  enable.addEventListener('click', () => {
    if (busy || !state?.canEnable) return;
    setConfirming(true);
    cancel.focus();
  });
  cancel.addEventListener('click', () => {
    setConfirming(false);
    enable.focus();
  });
  confirm.addEventListener('click', () => {
    if (state?.canEnable) void run('enable_folder_shell', '正在设置默认文件管理器…');
  });
  restore.addEventListener('click', () => {
    if (state?.canRestore) void run('restore_folder_shell', '正在恢复原来的打开方式…');
  });
  dialog.addEventListener('close', () => setConfirming(false));
  setHidden(menuButton, false);
}
