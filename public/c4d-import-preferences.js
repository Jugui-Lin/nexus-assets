const defaultCacheReminderGb = 1;
const bytesPerGb = 1024 ** 3;
const validReminderGb = value => Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER / bytesPerGb;
const reminderGb = value => validReminderGb(value) ? value : defaultCacheReminderGb;
const cacheReminderKey = (workspace, directory, gb) => JSON.stringify([workspace, directory || '', gb]);

function formatCacheBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function initC4dImportPreferences({api, native, scope = () => 'personal:personal', openCacheSettings}) {
  const get = id => document.getElementById(id);
  const dialog = get('smart-import-dialog');
  const title = get('smart-import-title');
  const nativeSections = [...dialog.querySelectorAll('[data-c4d-import-preferences]')];
  const tablist = dialog.querySelector('.smart-import-tabs');
  const content = dialog.querySelector('.smart-import-content');
  const tabs = [...tablist.querySelectorAll('[data-import-section]')];
  const status = get('c4d-import-preferences-status');
  const effective = get('c4d-import-effective-directory');
  const directory = get('c4d-import-temp-directory');
  const startup = get('c4d-import-cleanup-on-startup');
  const threshold = get('c4d-import-cache-reminder-gb');
  const clearCache = get('c4d-import-clear-cache');
  const cacheStatus = get('c4d-import-cache-status');
  const cacheSize = get('c4d-import-cache-size');
  const reminder = get('c4d-cache-reminder');
  const reminderMessage = get('c4d-cache-reminder-message');
  const blender = get('c4d-import-blender-executable');
  const max = get('c4d-import-max-batch-executable');
  const mode = get('c4d-import-max-mode');
  const pickers = {directory, blender, max};
  const sectionTitles = {general:'Cinema 4D 导入选项', max:'3ds Max 转换设置', blender:'Blender 转换设置', pbr:'PBR 贴图设置'};
  const cleanupWorkspaces = new Set();
  const dismissedReminders = new Set();
  let generation = 0;
  let measurement = 0;
  let reminderMeasurement = 0;
  let reminderWorkspace;
  let reminderKey;
  let busy = false;
  let baseline;
  let openedWorkspace;

  for (const section of nativeSections) section.hidden = !native;
  for (const tab of tabs) tab.hidden = !native && tab.hasAttribute('data-native-only');

  function showSection(id) {
    const next = tabs.find(tab => tab.dataset.importSection === id && !tab.hidden);
    if (!next) return;
    title.textContent = sectionTitles[id];
    for (const tab of tabs) {
      const active = tab === next;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      get(tab.getAttribute('aria-controls')).hidden = !active;
    }
    content.scrollTop = 0;
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => showSection(tab.dataset.importSection));
  }
  tablist.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const available = tabs.filter(tab => !tab.hidden && !tab.disabled);
    const current = available.indexOf(event.target);
    if (current < 0) return;
    const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1)
      : available[(current + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length];
    event.preventDefault();
    showSection(next.dataset.importSection);
    next.focus();
  });

  function read() {
    return {
      directory:directory.value.trim() || null,
      cleanupOnStartup:startup.checked,
      cacheReminderGb:threshold.valueAsNumber,
      blenderExecutable:blender.value.trim() || null,
      maxBatchExecutable:max.value.trim() || null,
      maxMode:mode.value,
    };
  }

  function render(preferences) {
    directory.value = preferences?.directory || '';
    startup.checked = preferences?.cleanupOnStartup === true;
    threshold.value = String(reminderGb(preferences?.cacheReminderGb));
    blender.value = preferences?.blenderExecutable || '';
    max.value = preferences?.maxBatchExecutable || '';
    mode.value = preferences?.maxMode === 'direct' ? 'direct' : 'application';
    effective.textContent = preferences?.effectiveDirectory ? `已保存的实际目录 · ${preferences.effectiveDirectory}` : '';
  }

  function showError(failure) {
    status.textContent = String(failure?.message || failure);
  }

  function showCacheStatus(message, error = false) {
    cacheStatus.toggleAttribute('data-error', error);
    cacheStatus.textContent = message;
  }

  function showCacheSize(message, failure = '') {
    cacheSize.toggleAttribute('data-error', Boolean(failure));
    cacheSize.title = failure;
    cacheSize.textContent = message;
  }

  const current = (token, workspace) => token === generation && dialog.open && workspace === scope();

  get('c4d-cache-reminder-open').addEventListener('click', () => openCacheSettings());
  get('c4d-cache-reminder-dismiss').addEventListener('click', () => {
    if (reminderKey) dismissedReminders.add(reminderKey);
    reminder.hidden = true;
  });

  async function measureCache(workspace) {
    if (reminderWorkspace !== workspace) {
      reminderWorkspace = workspace;
      reminderKey = undefined;
      reminder.hidden = true;
    }
    const request = ++reminderMeasurement;
    const result = await api('c4d_import_cache_size', {workspace});
    if (!Number.isSafeInteger(result?.bytes) || result.bytes < 0) throw Error('缓存大小数据无效');
    if (request === reminderMeasurement && workspace === scope()) {
      const gb = reminderGb(result.cacheReminderGb);
      const reached = result.bytes >= gb * bytesPerGb;
      reminderKey = cacheReminderKey(workspace, result.effectiveDirectory, gb);
      if (!reached) dismissedReminders.delete(reminderKey);
      reminder.hidden = !reached || dismissedReminders.has(reminderKey);
      if (!reminder.hidden) {
        const message = `Cinema 4D 导入缓存已达 ${formatCacheBytes(result.bytes)}，建议清理。`;
        if (reminderMessage.textContent !== message) reminderMessage.textContent = message;
      }
    }
    return result.bytes;
  }

  function checkCacheSize() {
    if (!native) return;
    const workspace = scope();
    if (!cleanupWorkspaces.has(workspace)) void measureCache(workspace).catch(() => {});
  }

  async function refreshCacheSize(workspace, token) {
    const request = ++measurement;
    const valid = () => request === measurement && current(token, workspace);
    showCacheSize('正在读取缓存大小…');
    try {
      const bytes = await measureCache(workspace);
      if (!valid()) return;
      showCacheSize(`缓存占用 ${formatCacheBytes(bytes)}`);
    } catch (failure) {
      if (valid()) showCacheSize('无法读取缓存大小', String(failure?.message || failure));
    }
  }

  async function open(section = 'general') {
    const token = ++generation;
    const workspace = openedWorkspace = scope();
    baseline = undefined;
    busy = false;
    status.textContent = '';
    clearCache.disabled = cleanupWorkspaces.has(workspace);
    showCacheStatus(clearCache.disabled ? '正在清理导入缓存…' : '');
    showCacheSize(native ? '正在读取缓存大小…' : '');
    render(null);
    showSection(section);
    for (const section of nativeSections) section.disabled = true;
    if (!native) return;
    busy = true;
    status.textContent = '正在读取导入设置…';
    try {
      const preferences = await api('get_c4d_import_preferences', {workspace});
      if (!current(token, workspace)) return;
      render(preferences);
      baseline = read();
      for (const section of nativeSections) section.disabled = false;
      status.textContent = '';
      void refreshCacheSize(workspace, token);
    } catch (failure) {
      if (current(token, workspace)) {
        showError(failure);
        showCacheSize('无法读取缓存大小', String(failure?.message || failure));
      }
    } finally {
      if (token === generation) busy = false;
    }
  }

  dialog.addEventListener('close', () => {
    if (!dialog.open) generation++;
  });

  clearCache.addEventListener('click', async () => {
    const token = generation;
    const workspace = openedWorkspace;
    if (!dialog.open || !baseline || busy || cleanupWorkspaces.has(workspace)) return;
    if (workspace !== scope()) {
      showCacheStatus('资产库已切换，请重新打开导入设置。', true);
      return;
    }
    cleanupWorkspaces.add(workspace);
    measurement++;
    reminderMeasurement++;
    clearCache.disabled = true;
    showCacheStatus('正在清理导入缓存…');
    try {
      const {removed, skipped} = await api('clear_c4d_import_cache', {workspace});
      if (token !== generation || !dialog.open || workspace !== scope()) return;
      if (skipped) {
        showCacheStatus(`已清理 ${removed} 项导入缓存，跳过 ${skipped} 项。`);
      } else {
        showCacheStatus(removed ? `已清理 ${removed} 项导入缓存。` : '没有可清理的导入缓存。');
      }
    } catch (failure) {
      if (token === generation && dialog.open && workspace === scope()) {
        showCacheStatus(String(failure?.message || failure), true);
      }
    } finally {
      cleanupWorkspaces.delete(workspace);
      if (dialog.open && openedWorkspace === workspace) {
        clearCache.disabled = false;
        if (workspace !== scope()) {
          showCacheStatus('资产库已切换，请重新打开导入设置。', true);
        } else if (token !== generation) {
          showCacheStatus('');
        }
        if (workspace === scope() && baseline) void refreshCacheSize(workspace, generation);
      } else if (workspace === scope()) checkCacheSize();
    }
  });

  for (const button of dialog.querySelectorAll('[data-c4d-import-picker]')) {
    button.addEventListener('click', async () => {
      if (busy || button.closest('fieldset').disabled) return;
      const token = generation;
      const {c4dImportPicker:kind} = button.dataset;
      busy = true;
      status.textContent = '';
      try {
        const path = await (kind === 'directory' ? api('pick_folder', {purpose:'c4d-cache'}) : api('pick_c4d_converter', {kind}));
        if (path && token === generation && dialog.open) {
          pickers[kind].value = path;
          pickers[kind].focus();
        }
      } catch (failure) {
        if (token === generation && dialog.open) showError(failure);
      } finally {
        if (token === generation) busy = false;
      }
    });
  }

  return {
    open,
    checkCacheSize,
    showSection,
    async save() {
      if (cleanupWorkspaces.has(openedWorkspace)) throw Error('正在清理导入缓存，请稍候。');
      if (busy) throw Error('导入设置正在读取或选择，请稍候。');
      if (!baseline) return;
      const preferences = read();
      if (!validReminderGb(preferences.cacheReminderGb)) {
        showSection('general');
        throw Error('请输入有效的缓存提醒阈值（GB）。');
      }
      if (Object.keys(preferences).every(key => preferences[key] === baseline[key])) return;
      const workspace = openedWorkspace;
      const token = generation;
      const changedThreshold = baseline.cacheReminderGb !== preferences.cacheReminderGb;
      if (workspace !== scope()) throw Error('资产库已切换，请重新打开导入设置。');
      const saved = await api('set_c4d_import_preferences', {workspace, preferences});
      if (!current(token, workspace)) return;
      if (changedThreshold) {
        dismissedReminders.delete(cacheReminderKey(workspace, saved.effectiveDirectory, reminderGb(saved.cacheReminderGb)));
      }
      render(saved);
      baseline = read();
      status.textContent = '';
      void refreshCacheSize(workspace, token);
    },
    showError,
  };
}
