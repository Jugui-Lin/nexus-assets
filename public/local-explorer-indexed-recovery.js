export function initExplorerIndexedRecovery({notice,dialog,inspect,recover,onResolved}) {
  const count = notice.querySelector('[role=status]');
  const show = notice.querySelector('button');
  const list = dialog.querySelector('[data-indexed-recovery-entries]');
  const status = dialog.querySelector('[data-indexed-recovery-status]');
  const close = dialog.querySelector('[data-indexed-recovery-close]');
  const retry = dialog.querySelector('[data-indexed-recovery-retry]');
  let scope, report, pending;
  let revision = 0;

  function render(message = '') {
    const blocked = report?.status === 'blocked';
    const entries = blocked ? report.entries : [];
    notice.hidden = !scope || !blocked;
    count.textContent = !blocked ? '' : entries.length ?
      `${entries.length} 个原件的移动待恢复` : '有原件移动待恢复';
    if (!dialog.open) return;
    status.textContent = message || (blocked ? '下列原件的移动尚未恢复。' : '当前没有等待恢复的移动。');
    list.hidden = !entries.length;
    const doc = dialog.ownerDocument;
    list.replaceChildren(...entries.map(({oldPath,path,reason}) => {
      const row = doc.createElement('li');
      const state = doc.createElement('strong');
      state.textContent = reason || '移动中断';
      row.append(state);
      for (const [label,value] of [['原位置',oldPath],['尝试移动到',path]]) {
        const line = doc.createElement('div');
        const location = doc.createElement('span');
        location.dir = 'ltr';
        location.textContent = value;
        line.append(label + ' · ',location);
        row.append(line);
      }
      return row;
    }));
    retry.hidden = !blocked || !report.operationId || !report.workspaceId;
    retry.disabled = Boolean(pending);
    close.disabled = pending === 'retry';
  }

  async function refresh(foreground = false) {
    if (!scope || pending) return;
    const request = ++revision;
    pending = 'inspect';
    if (foreground) render('正在检查中断的移动…');
    let message = '';
    try {
      const next = await inspect();
      if (request === revision) report = next;
    } catch (error) {
      if (foreground) message = String(error?.message || error);
    } finally {
      if (request === revision) {
        pending = null;
        render(message);
      }
    }
  }

  show.addEventListener('click',() => {
    if (!scope || report?.status !== 'blocked' || dialog.ownerDocument.querySelector('dialog[open]')) return;
    dialog.showModal();
    render(pending ? '正在检查中断的移动…' : '');
    close.focus({preventScroll:true});
    void refresh(true);
  });
  close.addEventListener('click',() => dialog.close());
  dialog.addEventListener('cancel',event => { if (pending === 'retry') event.preventDefault(); });
  retry.addEventListener('click',async () => {
    if (!scope || pending || report?.status !== 'blocked' || !report.operationId || !report.workspaceId) return;
    const {workspaceId,operationId} = report;
    const request = ++revision;
    pending = 'retry';
    render('正在恢复中断的移动…');
    let message = '';
    try {
      const result = await recover({workspaceId,operationId});
      if (request !== revision) return;
      report = result;
      if (result.status === 'recovered') {
        onResolved(result.entries);
        message = '中断的移动已恢复。';
      } else if (result.status === 'blocked') message = '恢复还未完成，请核对下列路径。';
    } catch (error) {
      if (request === revision) {
        message = String(error?.message || error);
        try {
          const next = await inspect();
          if (request === revision) report = next;
        } catch {}
      }
    } finally {
      if (request === revision) {
        pending = null;
        render(message);
        if (dialog.open && retry.hidden) close.focus({preventScroll:true});
      }
    }
  });

  return {
    refresh,
    hasIssue:() => report?.status === 'blocked',
    sync(nextScope) {
      if (scope === nextScope) return;
      scope = nextScope;
      revision++;
      report = pending = null;
      if (dialog.open) dialog.close();
      render();
      if (scope) void refresh();
    },
  };
}
