export function initExplorerC4dSend(dialog, {openMaxPreferences} = {}) {
  const form = dialog.querySelector('form');
  const target = form.querySelector('select');
  const summary = form.querySelector('[data-c4d-send-summary]');
  const skipped = form.querySelector('[data-c4d-send-skipped]');
  const status = form.querySelector('[data-c4d-send-status]');
  const cancel = form.querySelector('[data-c4d-send-cancel]');
  const maxPreferences = form.querySelector('#explorer-c4d-max-preferences');
  const confirm = form.querySelector('[data-c4d-send-confirm]');
  let current;

  function review() {
    if (!current) return;
    const session = current.sessions.find(item => item.id === target.value);
    const {ready, excluded} = current.inspect(session);
    current.plan = {session,ready};
    target.disabled = current.pending || !current.sessions.length;
    confirm.disabled = current.pending || !ready.length;
    maxPreferences.hidden = !current.hasMax || !openMaxPreferences;
    maxPreferences.disabled = current.pending;
    const count = ready.length;
    summary.textContent = count + ' 项可以发送' + (excluded.length ? ' · 将跳过 ' + excluded.length + ' 项' : '');
    const rows = excluded.slice(0, 5).map(({name,reason}) => `${name} · ${reason}`);
    if (excluded.length > rows.length) rows.push('另有 ' + (excluded.length - rows.length) + ' 项');
    skipped.replaceChildren(...rows.map(text => {
      const item = dialog.ownerDocument.createElement('li');
      item.textContent = text;
      return item;
    }));
    skipped.hidden = !rows.length;
  }

  function finish(result) {
    const request = current;
    current = undefined;
    if (dialog.open) dialog.close();
    request?.resolve(result);
  }

  target.addEventListener('change',() => {
    review();
    status.textContent = '';
  });
  cancel.addEventListener('click', () => finish(null));
  maxPreferences.addEventListener('click', () => {
    if (current?.hasMax && !current.pending) openMaxPreferences?.();
  });
  dialog.addEventListener('close', () => { if (!dialog.open) finish(null); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const request = current;
    if (!request || confirm.disabled) return;
    request.pending = true;
    review();
    status.textContent = '正在确认目标和原文件…';
    try {
      const result = await request.prepare(request.plan);
      if (current === request && dialog.open) finish(result);
    } catch (error) {
      if (current === request) status.textContent = String(error?.message || error);
    } finally {
      if (current === request) {
        request.pending = false;
        review();
      }
    }
  });

  return ({sessions,inspect,prepare,empty,hasMax = false}) => {
    if (current || dialog.open) return null;
    target.replaceChildren(...sessions.map(({id,label}) => new Option(label,id)));
    if (!sessions.length) target.add(new Option('暂无可接收的 Cinema 4D 实例',''));
    status.textContent = empty;
    return new Promise(resolve => {
      current = {sessions,inspect,prepare,resolve,hasMax,pending:false};
      review();
      dialog.showModal();
      const focus = target.disabled ? (maxPreferences.hidden ? cancel : maxPreferences) : target;
      focus.focus({preventScroll:true});
    });
  };
}
