import {initExplorerContextMenu} from './local-explorer-context.js';

export function initWorkspaceTabManagement({bar,files,assets,onError}) {
  const owner = bar.ownerDocument;
  const choices = bar.querySelector('#workspace-new-tab-options');
  const showMenu = initExplorerContextMenu(bar);
  const menu = bar.querySelector('.local-explorer-context-menu');
  menu.classList.add('workspace-tab-context-menu');
  menu.setAttribute('aria-label','标签页操作');
  const reopenButton = owner.createElement('button');
  reopenButton.type = 'button';
  reopenButton.id = 'workspace-reopen-closed-tab';
  reopenButton.hidden = true;
  reopenButton.setAttribute('aria-keyshortcuts','Control+Shift+T');
  reopenButton.innerHTML = '<svg aria-hidden="true"><use href="#i-refresh"/></svg><span></span>';
  choices.querySelector('[data-new-tab="settings"]').previousElementSibling.before(reopenButton);
  let restoring = false;

  function restoreTarget() {
    const inFiles = bar.dataset.activeWorkspace === 'files';
    const order = inFiles ? [files,assets] : [assets,files];
    return order.find(controller => controller.hasClosedTabs?.());
  }

  function restoreLabel(controller) {
    return '重新打开已关闭的' + (controller === files ? '文件夹标签' : '资产标签');
  }

  async function restore(controller) {
    if (!controller || restoring) return;
    restoring = true;
    try {
      if (choices.matches(':popover-open')) choices.hidePopover();
      await controller.restoreClosedTab();
    } catch (failure) {
      onError(failure);
    } finally {
      restoring = false;
    }
  }

  choices.addEventListener('beforetoggle',event => {
    if (event.newState !== 'open') return;
    const target = restoreTarget();
    reopenButton.hidden = !target;
    reopenButton.querySelector('span').textContent = target ? restoreLabel(target) : '';
  });
  reopenButton.addEventListener('click',() => void restore(restoreTarget()));

  function forElement(element) {
    const tab = files.findManagedTab?.(element);
    if (tab) return {controller:files,tab};
    const assetTab = assets.findManagedTab(element);
    return assetTab ? {controller:assets,tab:assetTab} : null;
  }

  async function contextMenu({controller,tab},{x,y} = {}) {
    const result = await showMenu({x,y,items:[
      {id:'pin',label:tab.pinned ? '取消固定标签' : '固定标签'},
      {id:'close',label:'关闭标签'},
      {id:'close-others',label:'关闭其他标签',disabled:controller.canCloseOtherTabs?.(tab.id) === false},
      {separator:true},
      {id:'reopen',label:restoreLabel(controller),shortcut:'Ctrl+Shift+T',disabled:!controller.hasClosedTabs?.()},
    ]});
    try {
      if (result === 'pin') controller.setTabPinned(tab.id,!tab.pinned);
      if (result === 'close') await controller.closeManagedTab(tab.id);
      if (result === 'close-others') await controller.closeOtherTabs(tab.id);
      if (result === 'reopen') await restore(controller);
    } catch (failure) { onError(failure); }
  }

  bar.addEventListener('contextmenu',event => {
    const target = forElement(event.target);
    if (!target || owner.querySelector('dialog[open]')) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.target.closest('.local-explorer-tab,.workspace-tab')
      ?.querySelector('.local-explorer-tab-select,.workspace-tab-trigger');
    anchor?.focus({preventScroll:true});
    const point = event.clientX || event.clientY ? {x:event.clientX,y:event.clientY} : undefined;
    void contextMenu(target,point);
  });

  bar.addEventListener('keydown',event => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    const target = forElement(event.target);
    if (!target || owner.querySelector('dialog[open]')) return;
    event.preventDefault();
    event.stopPropagation();
    void contextMenu(target);
  });

  owner.defaultView.addEventListener('keydown',event => {
    if (bar.hidden || event.defaultPrevented || event.isComposing || event.altKey || !event.shiftKey ||
        !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 't' ||
        owner.querySelector('dialog[open], .local-explorer-context-menu:not([hidden])')) return;
    const controller = restoreTarget();
    if (!controller) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void restore(controller);
  },{capture:true});
}
