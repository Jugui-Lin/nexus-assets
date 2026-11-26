import {matchFolderAddress} from './folder-address.js';

const storageKey = 'nexus-file-workspace-preferences-v1';
const newTabActions = new Set(['menu','files','current','all','favorites','recent']);
const defaults = Object.freeze({
  startWorkspace:'assets',
  startLocation:'computer',
  startMode:'new',
  startupPaths:[],
  newTabAction:'menu',
  openMode:'double',
  compact:false,
  showFrequent:true,
  showHidden:false,
  showThumbnails:true,
  showStatus:true,
  showExtensions:true,
  showNavigation:true,
  showToolbar:true,
  showBookmarks:true,
  openBookmarkInNewTab:false,
  quickPreview:true,
  confirmCloseTabs:true,
  doubleClickUp:true,
  ctrlDoubleClickTab:true,
  doubleClickCloseTab:true,
  wheelSwitchTabs:false,
});
const fields = {
  startWorkspace:'start-workspace',
  startLocation:'start-location',
  compact:'compact-view',
  showFrequent:'show-frequent',
  showHidden:'show-hidden',
  showThumbnails:'show-thumbnails',
  showStatus:'show-status',
  showExtensions:'show-extensions',
  showNavigation:'show-navigation',
  showToolbar:'show-toolbar',
  showBookmarks:'show-bookmarks',
  openBookmarkInNewTab:'open-bookmark-in-new-tab',
  quickPreview:'quick-preview',
  confirmCloseTabs:'confirm-close-tabs',
  doubleClickUp:'double-click-up',
  ctrlDoubleClickTab:'ctrl-double-click-tab',
  doubleClickCloseTab:'double-click-close-tab',
  wheelSwitchTabs:'wheel-switch-tabs',
};
const viewOptions = {
  hidden:'showHidden',
  thumbnails:'showThumbnails',
  status:'showStatus',
  extensions:'showExtensions',
  navigation:'showNavigation',
};

function startupPaths(lines) {
  const paths = new Map();
  for (const value of lines) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const path = value.length <= 8192 && matchFolderAddress(value,[])?.path;
    if (!path) throw Error('指定标签页请填写本机或网络文件夹的完整路径。');
    const key = /^[a-z]:|^\\\\/i.test(path) ? path.toLowerCase() : path;
    paths.set(key,path);
    if (paths.size > 24) throw Error('最多可指定 24 个启动标签页。');
  }
  return [...paths.values()];
}

function normalizeNewTabAction(value) {
  return newTabActions.has(value) ? value : defaults.newTabAction;
}

function normalizeStartWorkspace(value) {
  return value === 'files' ? 'files' : defaults.startWorkspace;
}

export function readFileWorkspacePreferences() {
  const values = {...defaults};
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    values.startWorkspace = normalizeStartWorkspace(stored?.startWorkspace);
    if (stored?.startLocation === 'home') values.startLocation = 'home';
    if (stored?.startMode === 'restore' || stored?.startMode === 'paths') values.startMode = stored.startMode;
    if (stored?.openMode === 'single') values.openMode = 'single';
    values.newTabAction = normalizeNewTabAction(stored?.newTabAction);
    for (const key of Object.keys(defaults)) {
      if (typeof stored?.[key] === 'boolean' && typeof defaults[key] === 'boolean') values[key] = stored[key];
    }
    if (Array.isArray(stored?.startupPaths)) values.startupPaths = startupPaths(stored.startupPaths);
  } catch {}
  if (values.startMode === 'paths' && !values.startupPaths.length) values.startMode = 'new';
  return values;
}

export function initFileWorkspacePreferences({apply,resetSidebar,clearFrequent,openDefaultManager,focusNewTabControl,report}) {
  const dialog = document.querySelector('#file-workspace-preferences-dialog');
  const launcher = document.querySelector('#open-file-workspace-preferences');
  const view = document.querySelector('#file-workspace-view-menu');
  if (!dialog || !launcher || !view) return null;
  const elements = Object.fromEntries(Object.entries(fields).map(([key,suffix]) =>
    [key,dialog.querySelector('#file-workspace-' + suffix)]));
  const tabs = [...dialog.querySelectorAll('[data-file-preferences-tab]')];
  const pathsField = dialog.querySelector('#file-workspace-startup-paths');
  const startModes = [...dialog.querySelectorAll('[name="file-workspace-start-mode"]')];
  const tabDialog = document.querySelector('#workspace-tab-preferences-dialog');
  const newTabAction = tabDialog.querySelector('#workspace-new-tab-action');
  let saved = readFileWorkspacePreferences();
  let opener;
  let restoreTabSettingsFocus;

  function selectTab(id) {
    for (const tab of tabs) {
      const selected = tab.dataset.filePreferencesTab === id;
      tab.tabIndex = selected ? 0 : -1;
      tab.setAttribute('aria-selected',String(selected));
    }
    for (const panel of dialog.querySelectorAll('[data-file-preferences-panel]'))
      panel.hidden = panel.dataset.filePreferencesPanel !== id;
  }

  function fill(values) {
    for (const [key,element] of Object.entries(elements)) {
      if (!element) continue;
      if (element.tagName === 'SELECT') element.value = values[key];
      else element.checked = values[key];
    }
    for (const option of dialog.querySelectorAll('[name="file-workspace-open-mode"]'))
      option.checked = values.openMode === option.value;
    for (const option of startModes) option.checked = values.startMode === option.value;
    if (pathsField) pathsField.value = values.startupPaths.join('\n');
    syncStartupControls();
  }

  function syncStartupControls() {
    const mode = startModes.find(option => option.checked)?.value || 'new';
    if (elements.startLocation) elements.startLocation.disabled = mode !== 'new';
    if (pathsField) pathsField.disabled = mode !== 'paths';
  }

  function read() {
    const next = Object.fromEntries(Object.entries(elements).filter(([,element]) => element).map(([key,element]) =>
      [key,element.tagName === 'SELECT' ? element.value : element.checked]));
    next.openMode = dialog.querySelector('[name="file-workspace-open-mode"]:checked')?.value === 'single' ? 'single' : 'double';
    next.startMode = startModes.find(option => option.checked)?.value || 'new';
    next.startupPaths = startupPaths((pathsField?.value ?? '').split(/\r?\n/));
    if (next.startMode === 'paths' && !next.startupPaths.length) throw Error('请输入至少一个启动文件夹。');
    return {...saved,...next};
  }

  function syncMenu() {
    for (const option of view.querySelectorAll('[data-file-view-option]'))
      option.setAttribute('aria-pressed',String(saved[viewOptions[option.dataset.fileViewOption]]));
  }

  function save(next) {
    next = {...next,startWorkspace:normalizeStartWorkspace(next.startWorkspace),
      newTabAction:normalizeNewTabAction(next.newTabAction)};
    saved = next;
    try { localStorage.setItem(storageKey,JSON.stringify(saved)); } catch {}
    syncMenu();
    Promise.resolve().then(() => apply(next)).catch(failure => report(String(failure?.message || failure),true));
  }

  function open() {
    if (dialog.open) return;
    opener = document.activeElement;
    fill(saved);
    selectTab('general');
    dialog.showModal();
    tabs[0]?.focus();
  }

  function openTabSettings(restoreFocus = focusNewTabControl) {
    if (tabDialog.open) return;
    restoreTabSettingsFocus = restoreFocus;
    newTabAction.value = saved.newTabAction;
    tabDialog.showModal();
  }

  tabDialog.addEventListener('submit',event => {
    event.preventDefault();
    save({...saved,newTabAction:newTabAction.value});
    tabDialog.close();
  });
  tabDialog.addEventListener('close',() => restoreTabSettingsFocus?.());

  launcher.addEventListener('click',open);
  pathsField?.addEventListener('input',() => pathsField.setCustomValidity(''));
  for (const radio of startModes) radio.addEventListener('change',syncStartupControls);
  dialog.addEventListener('close',() => opener?.focus({preventScroll:true}));
  dialog.addEventListener('click',event => {
    const tab = event.target.closest('[data-file-preferences-tab]');
    if (tab) selectTab(tab.dataset.filePreferencesTab);
    const action = event.target.closest('[data-file-preferences-action]')?.dataset.filePreferencesAction;
    switch (action) {
      case 'cancel': dialog.close(); break;
      case 'apply':
      case 'save':
        try {
          save(read());
          if (action === 'save') dialog.close();
        } catch (failure) {
          if (pathsField && !pathsField.disabled) {
            pathsField.setCustomValidity(String(failure?.message || failure));
            pathsField.reportValidity();
          } else report(String(failure?.message || failure),true);
        }
        break;
    }
  });
  dialog.addEventListener('keydown',event => {
    const tab = event.target.closest('[data-file-preferences-tab]');
    if (tab && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      selectTab(next.dataset.filePreferencesTab);
      next.focus();
    }
  });
  dialog.querySelector('#file-workspace-reset-preferences').addEventListener('click',() => {
    pathsField?.setCustomValidity('');
    fill(defaults);
  });
  dialog.querySelector('#file-workspace-reset-sidebar').addEventListener('click',() => {
    resetSidebar();
    report('已恢复侧栏宽度');
  });
  dialog.querySelector('#file-workspace-clear-recent').addEventListener('click',() => {
    try {
      clearFrequent();
      report('已清空常用文件夹记录');
    } catch (failure) { report(String(failure?.message || failure),true); }
  });
  dialog.querySelector('#file-workspace-default-manager')?.addEventListener('click',() => {
    dialog.close();
    openDefaultManager?.();
  });
  view.addEventListener('click',event => {
    const option = event.target.closest('[data-file-view-option]');
    const key = viewOptions[option?.dataset.fileViewOption];
    if (key) save({...saved,[key]:!saved[key]});
    if (option || event.target.closest('[data-explorer-view]')) view.open = false;
  });
  view.addEventListener('keydown',event => {
    if (event.key === 'Escape' && view.open) {
      event.preventDefault();
      view.open = false;
      view.querySelector('summary').focus();
    }
  });
  document.addEventListener('pointerdown',event => {
    if (view.open && !view.contains(event.target)) view.open = false;
  });
  syncMenu();
  return {open,openTabSettings,get:() => saved};
}
