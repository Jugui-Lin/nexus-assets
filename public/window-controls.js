export function initWindowControls({windowHandle, shouldConfirmClose, report}) {
  if (!windowHandle) return;
  const template = document.getElementById('nexus-window-controls');
  const hosts = document.querySelectorAll('[data-window-controls]');
  const actions = {minimize:'minimize', maximize:'toggleMaximize', close:'close'};
  let revision = 0;
  let frame = 0;
  let nativeCloseGuard = false;
  let closePrompt;

  function confirmClose() {
    if (closePrompt) return closePrompt;
    const reason = shouldConfirmClose?.();
    if (!reason) return true;
    const dialog = document.createElement('dialog');
    dialog.id = 'confirm-close-workspace';
    dialog.className = 'modal compact-dialog';
    dialog.setAttribute('aria-labelledby','confirm-close-workspace-title');
    dialog.innerHTML = '<div class="modal-header"><h2 id="confirm-close-workspace-title">关闭窗口</h2></div>' +
      '<p class="modal-description">当前打开了多个标签页。要关闭这个窗口吗？</p>' +
      '<form method="dialog" class="modal-footer">' +
      '<button class="button subtle" value="cancel" autofocus>取消</button>' +
      '<button class="button primary" value="close">关闭窗口</button></form>';
    if (typeof reason === 'string') dialog.querySelector('.modal-description').textContent = reason;
    document.body.append(dialog);
    dialog.showModal();
    closePrompt = new Promise(resolve => {
      dialog.addEventListener('close',() => {
        const allowed = dialog.returnValue === 'close';
        dialog.remove();
        closePrompt = null;
        resolve(allowed);
      },{once:true});
    });
    return closePrompt;
  }

  if (shouldConfirmClose && typeof windowHandle.onCloseRequested === 'function') {
    Promise.resolve(windowHandle.onCloseRequested(async event => {
      if (!await confirmClose()) event.preventDefault();
    })).then(() => { nativeCloseGuard = true; }).catch(report);
  }

  function updateMaximizeButton() {
    if (frame) return;
    frame = requestAnimationFrame(async () => {
      frame = 0;
      const request = ++revision;
      try {
        const maximized = await windowHandle.isMaximized();
        if (request !== revision) return;
        const label = maximized ? '还原窗口' : '最大化窗口';
        for (const host of hosts) {
          const button = host.querySelector('[data-window-action="maximize"]');
          button.title = label;
          button.setAttribute('aria-label',label);
          button.querySelector('use').setAttribute('href',maximized ? '#i-window-restore' : '#i-window-maximize');
        }
      } catch (failure) {
        report(failure);
      }
    });
  }

  for (const host of hosts) {
    host.append(template.content.cloneNode(true));
    host.hidden = false;
    host.addEventListener('click', async event => {
      const action = event.target.closest('[data-window-action]')?.dataset.windowAction;
      if (!Object.hasOwn(actions,action)) return;
      try {
        if (action === 'close' && !nativeCloseGuard && !await confirmClose()) return;
        await windowHandle[actions[action]]();
        if (action === 'maximize') updateMaximizeButton();
      } catch (failure) {
        report(failure);
      }
    });
  }
  for (const area of document.querySelectorAll('[data-window-drag]')) {
    area.setAttribute('data-tauri-drag-region','');
    area.hidden = false;
  }
  window.addEventListener('resize',updateMaximizeButton);
  updateMaximizeButton();
}
