export function initExplorerIndexedMove(dialog) {
  const form = dialog.querySelector('form');
  const summary = form.querySelector('[data-indexed-move-summary]');
  const directory = form.querySelector('[data-indexed-move-directory]');
  const sources = form.querySelector('[data-indexed-move-sources]');
  const status = form.querySelector('[data-indexed-move-status]');
  const pick = form.querySelector('[data-indexed-move-pick]');
  const dismiss = form.querySelector('[data-indexed-move-close]');
  const confirm = form.querySelector('[data-indexed-move-confirm]');
  const reveal = form.querySelector('[data-indexed-move-reveal]');
  let current;

  function paths(list, label) {
    sources.setAttribute('aria-label',label);
    sources.replaceChildren(...list.map(path => {
      const row = dialog.ownerDocument.createElement('li');
      row.dir = 'ltr';
      row.textContent = path;
      return row;
    }));
  }

  function controls() {
    if (!current) return;
    pick.disabled = Boolean(current.pending);
    confirm.disabled = Boolean(current.pending || !current.plan);
    dismiss.disabled = current.pending === 'move';
    dismiss.textContent = current.moved ? '关闭' : '取消';
    pick.hidden = confirm.hidden = Boolean(current.moved);
    reveal.hidden = !current.moved?.length;
  }

  function setDirectory(value) {
    directory.value = value;
    current.plan = null;
    status.textContent = '';
    try { current.plan = current.inspect(value); }
    catch (error) { status.textContent = String(error?.message || error); }
    controls();
  }

  function finish(target = null) {
    const request = current;
    current = null;
    if (dialog.open) dialog.close();
    request?.resolve(request.moved ? {target} : null);
  }

  dialog.addEventListener('cancel', event => {
    if (current?.pending === 'move') event.preventDefault();
  });
  dialog.addEventListener('close', () => { if (!dialog.open) finish(); });
  dismiss.addEventListener('click', () => finish());
  reveal.addEventListener('click', () => {
    const moved = current?.moved;
    if (moved?.length) finish({paths:moved.map(item => item.path),directory:current.plan.directoryPath});
  });
  pick.addEventListener('click', async () => {
    const request = current;
    if (!request || request.pending || request.moved) return;
    request.pending = 'picker';
    controls();
    try {
      const target = await request.pick();
      if (current === request && target) setDirectory(target);
    } catch (error) {
      if (current === request) status.textContent = String(error?.message || error);
    } finally {
      if (current === request) {
        request.pending = null;
        controls();
      }
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const request = current;
    if (!request?.plan || request.pending || request.moved) return;
    request.pending = 'move';
    controls();
    status.textContent = '正在移动原件并更新资产记录…';
    try {
      const moved = await request.move(request.plan);
      if (current !== request) return;
      request.moved = moved;
      summary.textContent = `已移动 ${moved.length} 个文件，原资产记录已更新。`;
      paths(moved.map(result => result.path),'移动后的文件');
      status.textContent = '';
    } catch (error) {
      if (current === request) status.textContent = String(error?.message || error);
    } finally {
      if (current === request) {
        request.pending = null;
        controls();
        if (request.moved) dismiss.focus({preventScroll:true});
      }
    }
  });

  return ({entries,initial,pick:pickFolder,inspect,move}) => {
    if (current || dialog.open) return null;
    return new Promise(resolve => {
      current = {resolve,pick:pickFolder,inspect,move,plan:null,pending:null,moved:null};
      summary.textContent = `将 ${entries.length} 个原件移动到所选文件夹，文件名和资产记录将保留。`;
      paths(entries.map(entry => entry.path),'原文件');
      setDirectory(initial);
      dialog.showModal();
      dismiss.focus({preventScroll:true});
    });
  };
}
