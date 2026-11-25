const svgNamespace = 'http://www.w3.org/2000/svg';
const folderButton = '[data-library][data-folder]';
const subfolderCard = '.subfolder-card[data-library][data-subfolder]';
const folderPath = row => row.dataset.subfolder ?? row.dataset.folder;

function glyph(name) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  const use = document.createElementNS(svgNamespace, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function button(label, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

function viewportPosition(value, size, viewport) {
  return Math.max(4, Math.min(value, viewport - size - 4));
}

function menuChoice(label, value) {
  const node = button('');
  node.tabIndex = -1;
  node.dataset.option = value;
  node.title = label;
  node.setAttribute('aria-label', label);
  node.setAttribute('role', 'menuitemradio');
  return node;
}

export function initFolderContext({
  lookup, hiddenFolders, canManage, canOpen, isPinned, open, togglePin, copyPath, appearanceChoices,
  browseInExplorer, includeChildren, refreshStructure, generateThumbnails, createFolder, rename, remove, removeLabel, restore, promote, notify,
}) {
  const folders = document.querySelector('#sidebar-panes');
  const subfolders = document.querySelector('#subfolder-grid');
  const showHidden = document.querySelector('#show-hidden-folders');
  const menu = document.createElement('div');
  menu.id = 'folder-context-menu';
  menu.className = 'asset-menu hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '文件夹操作');
  const iconMenu = document.createElement('div');
  iconMenu.id = 'folder-icon-choices';
  iconMenu.className = 'asset-menu folder-icon-choices hidden';
  iconMenu.setAttribute('role', 'menu');
  iconMenu.setAttribute('aria-label', '文件夹图标');
  document.body.append(menu, iconMenu);

  const removedDialog = document.createElement('dialog');
  removedDialog.id = 'removed-folders-dialog';
  removedDialog.className = 'modal';
  removedDialog.setAttribute('aria-labelledby', 'removed-folders-title');
  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.id = 'removed-folders-title';
  title.textContent = '已移除的文件夹';
  const close = button('', 'icon-button');
  close.setAttribute('aria-label', '关闭');
  close.append(glyph('close'));
  header.append(title, close);
  const explanation = document.createElement('p');
  explanation.className = 'modal-description';
  explanation.textContent = '恢复后，文件夹会重新显示在资产库。';
  const list = document.createElement('div');
  list.className = 'workspace-recent';
  const status = document.createElement('p');
  status.className = 'workspace-search-error';
  status.setAttribute('role', 'status');
  removedDialog.append(header, explanation, list, status);
  document.body.append(removedDialog);

  let anchor = null;
  let actionPending = false;
  let listSignature;
  let iconTrigger;

  function focusSelectedIcon() {
    (iconMenu.querySelector('[aria-checked="true"]') || iconMenu.firstElementChild)?.focus({preventScroll:true});
  }

  function openIcons(focus = false) {
    if (!iconTrigger || menu.classList.contains('hidden')) return;
    iconMenu.classList.remove('hidden');
    const trigger = iconTrigger.getBoundingClientRect();
    const parent = menu.getBoundingClientRect();
    const width = iconMenu.offsetWidth;
    const height = iconMenu.offsetHeight;
    let left = parent.right;
    let top = trigger.top;
    const fitsRight = left + width <= window.innerWidth - 4;
    const fitsLeft = parent.left - width >= 4;
    if (!fitsRight && fitsLeft) left = parent.left - width;
    if (!fitsRight && !fitsLeft) {
      left = trigger.left;
      top = trigger.bottom + height <= window.innerHeight - 4 ? trigger.bottom : trigger.top - height;
    }
    iconMenu.style.left = viewportPosition(left, width, window.innerWidth) + 'px';
    iconMenu.style.top = viewportPosition(top, height, window.innerHeight) + 'px';
    iconTrigger.dataset.submenuSide = !fitsRight && fitsLeft ? 'left' : 'right';
    iconTrigger.setAttribute('aria-expanded', 'true');
    if (focus) focusSelectedIcon();
  }

  function closeIcons(restoreFocus = false) {
    iconMenu.classList.add('hidden');
    iconTrigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) iconTrigger?.focus({preventScroll:true});
  }

  function closeMenu(restoreFocus = false) {
    if (!anchor) return;
    closeIcons();
    menu.classList.add('hidden');
    const previous = anchor;
    anchor = null;
    if (restoreFocus) {
      if (previous.isConnected) previous.focus({preventScroll:true});
      else {
        const candidates = previous.matches(subfolderCard)
          ? subfolders.querySelectorAll(subfolderCard) : folders.querySelectorAll(`#libraries ${folderButton}`);
        [...candidates].find(row => row.dataset.library === previous.dataset.library &&
          folderPath(row) === folderPath(previous))?.focus({preventScroll:true});
      }
    }
  }

  function appearanceItems(folder) {
    const appearance = appearanceChoices(folder);
    iconTrigger = button('文件夹图标', 'folder-icon-trigger');
    iconTrigger.tabIndex = -1;
    iconTrigger.setAttribute('role', 'menuitem');
    iconTrigger.setAttribute('aria-haspopup', 'menu');
    iconTrigger.setAttribute('aria-controls', iconMenu.id);
    iconTrigger.setAttribute('aria-expanded', 'false');
    iconTrigger.prepend(glyph('sliders'));
    const arrow = glyph('chevron');
    arrow.classList.add('folder-submenu-arrow');
    iconTrigger.append(arrow);
    iconTrigger.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse') openIcons();
    });
    iconTrigger.addEventListener('click', () => openIcons(true));

    const swatches = document.createElement('div');
    swatches.id = 'folder-color-choices';
    swatches.setAttribute('role', 'group');
    swatches.setAttribute('aria-label', '文件夹颜色');

    function paintChoices() {
      const {glyph: icon, color} = appearance.selected();
      for (const choice of iconMenu.children) choice.setAttribute('aria-checked', String(choice.dataset.option === icon));
      for (const choice of swatches.children) choice.setAttribute('aria-checked', String(choice.dataset.option === color));
    }

    function apply(selection) {
      appearance.choose(selection);
      paintChoices();
    }

    iconMenu.replaceChildren(...appearance.icons.map(([value, label]) => {
      const choice = menuChoice(label, value);
      choice.append(glyph(value));
      choice.addEventListener('click', () => apply({glyph:value}));
      return choice;
    }));
    swatches.replaceChildren(...appearance.colors.map(([value, [label, color]]) => {
      const choice = menuChoice(value === 'default' ? '默认颜色' : label, value);
      const swatch = document.createElement('span');
      swatch.style.backgroundColor = color;
      choice.append(swatch);
      choice.addEventListener('click', () => apply({color:value}));
      return choice;
    }));
    const reset = button('恢复默认外观');
    reset.tabIndex = -1;
    reset.setAttribute('role', 'menuitem');
    reset.prepend(glyph('refresh'));
    reset.addEventListener('click', () => apply({glyph:'folder', color:'default'}));
    paintChoices();
    return [iconTrigger, swatches, reset];
  }

  function showMenu(row, x, y) {
    const folder = lookup(row.dataset.library, folderPath(row));
    if (!folder) return false;
    closeIcons();
    anchor = row;
    const items = [
      ['folder', '在资产库中打开', open],
      ['stack', '包含子文件夹并浏览', includeChildren],
    ];
    if (togglePin) items.push(['star', isPinned(folder) ? '取消固定' : '固定到快捷访问', togglePin]);
    if (browseInExplorer && canOpen(folder)) items.push(['drag-out', '在文件管理器中显示', browseInExplorer]);
    if (copyPath && folder.diskPath) items.push(['link', '复制文件夹路径', copyPath]);
    if (refreshStructure && folder.canRefresh) items.push(['refresh', '刷新文件夹结构', refreshStructure]);
    if (generateThumbnails && row.matches(subfolderCard) && folder.canGenerateThumbnails) {
      items.push(['picture', '生成缩略图…', generateThumbnails]);
    }
    if (createFolder && folder.canCreate) items.push(['plus', '新建文件夹…', createFolder]);
    if (rename && folder.canRename) items.push(['edit', '重命名…', rename]);
    function actionItem([icon, label, action]) {
      const item = button(label);
      item.tabIndex = -1;
      item.setAttribute('role', 'menuitem');
      item.prepend(glyph(icon));
      item.addEventListener('click', async () => {
        closeMenu(true);
        try {
          await action(folder);
        } catch (error) {
          notify(String(error?.message || error), true);
        }
      });
      return item;
    }
    const entries = items.map(actionItem);
    if (appearanceChoices) entries.push(...appearanceItems(folder));
    if (remove && canManage(folder)) entries.push(actionItem(['close', removeLabel(folder), remove]));
    menu.replaceChildren(...entries);
    menu.classList.remove('hidden');
    menu.style.left = viewportPosition(x, menu.offsetWidth, window.innerWidth) + 'px';
    menu.style.top = viewportPosition(y, menu.offsetHeight, window.innerHeight) + 'px';
    menu.firstElementChild?.focus({preventScroll: true});
    return true;
  }

  for (const [area, findRow] of [
    [folders, target => target.closest('.folder-row')?.querySelector(folderButton)],
    [subfolders, target => target.closest(subfolderCard)],
  ]) {
    area.addEventListener('contextmenu', event => {
      const row = findRow(event.target);
      if (!row) return;
      const rect = row.getBoundingClientRect();
      if (showMenu(row, event.clientX || rect.left + 8, event.clientY || rect.bottom)) event.preventDefault();
    });
    area.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      const row = findRow(event.target);
      if (!row) return;
      const rect = row.getBoundingClientRect();
      if (showMenu(row, rect.left + 8, rect.bottom)) event.preventDefault();
    });
  }

  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      closeMenu(true);
      return;
    }
    const focused = document.activeElement;
    if (event.key === 'ArrowRight' && focused === iconTrigger) {
      event.preventDefault();
      openIcons(true);
      return;
    }
    const swatches = focused.closest('#folder-color-choices');
    if (swatches && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const entries = [...swatches.children];
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      entries[(entries.indexOf(focused) + step + entries.length) % entries.length].focus();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const entries = [...menu.children];
    const current = entries.indexOf(swatches || focused);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + entries.length) % entries.length;
    (entries[next]?.querySelector('[aria-checked="true"]') || entries[next])?.focus();
  });
  iconMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeIcons(true);
      return;
    }
    if (event.key === 'Tab') { closeMenu(true); return; }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const entries = [...iconMenu.children];
    const columns = entries.filter(item => item.offsetTop === entries[0].offsetTop).length;
    const step = {ArrowLeft:-1, ArrowRight:1, ArrowUp:-columns, ArrowDown:columns}[event.key];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
      : (entries.indexOf(document.activeElement) + step + entries.length) % entries.length;
    entries[next]?.focus();
  });

  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target) && !iconMenu.contains(event.target)) closeMenu();
  });
  window.addEventListener('blur', () => closeMenu());
  window.addEventListener('resize', () => closeMenu());

  async function runFolderAction(action, folder, index) {
    if (actionPending || !canManage(folder)) return;
    actionPending = true;
    status.textContent = '';
    render();
    try {
      await action(folder);
      if (!hiddenFolders().length) removedDialog.close();
    } catch (error) {
      status.textContent = String(error?.message || error);
    } finally {
      actionPending = false;
      render();
      if (removedDialog.open) {
        list.children[Math.min(index, list.children.length - 1)]?.querySelector('button')?.focus();
      }
    }
  }

  function render() {
    const hidden = hiddenFolders();
    showHidden.classList.toggle('hidden', !hidden.length);
    if (!removedDialog.open) return;
    const editing = canManage();
    const signature = JSON.stringify([hidden, actionPending, editing]);
    if (listSignature === signature) return;
    listSignature = signature;
    explanation.textContent = hidden.length
      ? editing ? '恢复后，文件夹会重新显示在资产库。' : '开启文件夹编辑后即可恢复。'
      : '没有已移除的文件夹。';
    list.replaceChildren(...hidden.map((folder, index) => {
      const row = document.createElement('div');
      row.className = 'team-library-row';
      const details = document.createElement('div');
      details.className = 'team-library-info';
      const name = document.createElement('strong');
      name.textContent = folder.name;
      const path = document.createElement('small');
      const location = folder.diskPath || [folder.libraryName, folder.path].filter(Boolean).join(' / ');
      path.textContent = [folder.scopeLabel, location].filter(Boolean).join(' · ');
      details.append(name, path);
      const restoreLabel = folder.shared ? '恢复到团队' : '恢复';
      const action = button(restoreLabel, 'button subtle');
      action.setAttribute('aria-label', restoreLabel + ' ' + folder.name);
      action.disabled = actionPending || !editing;
      action.addEventListener('click', () => runFolderAction(restore, folder, index));
      row.append(details, action);
      if (folder.canPromote && promote) {
        const sync = button('同步到团队', 'button subtle');
        sync.setAttribute('aria-label', '同步移除 ' + folder.name + ' 到团队');
        sync.disabled = actionPending || !editing;
        sync.addEventListener('click', () => runFolderAction(promote, folder, index));
        row.append(sync);
      }
      return row;
    }));
  }

  function openRemoved() {
    if (!hiddenFolders().length || removedDialog.open) return;
    closeMenu();
    status.textContent = '';
    listSignature = undefined;
    removedDialog.showModal();
    render();
  }
  showHidden.addEventListener('click', openRemoved);
  close.addEventListener('click', () => removedDialog.close());
  removedDialog.addEventListener('close', () => {
    if (!hiddenFolders().length) document.querySelector('#sidebar-folder-toggle')?.focus();
  });

  return {render, openRemoved, hasRemoved: () => hiddenFolders().length > 0};
}
