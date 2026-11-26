const previewLimit = 250;
const invalidName = /[/\\<>:"|?*\u0000-\u001f]|[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function decoratedName(entry,prefix,suffix) {
  const extension = !entry.isDirectory && entry.name.lastIndexOf('.');
  const split = extension > 0 ? extension : entry.name.length;
  return prefix + entry.name.slice(0,split) + suffix + entry.name.slice(split);
}

export function showExplorerBatchRename({panel,entries,apply}) {
  const owner = panel.ownerDocument;
  if (!entries.length || owner.querySelector('dialog[open]')) return;
  const opener = owner.activeElement;
  const dialog = owner.createElement('dialog');
  dialog.className = 'modal local-explorer-batch-rename';
  dialog.setAttribute('aria-labelledby','explorer-batch-rename-title');
  dialog.innerHTML = '<form><h2 id="explorer-batch-rename-title">批量重命名</h2>' +
    '<div class="local-explorer-rename-fields"><label>名称前缀<input class="text-field" name="prefix" maxlength="64" autofocus></label>' +
    '<label>名称后缀<input class="text-field" name="suffix" maxlength="64"></label></div>' +
    '<p data-batch-rename-scope></p><div class="local-explorer-rename-list"><table>' +
    '<thead><tr><th scope="col">改名</th><th scope="col">原名称</th><th scope="col">新名称</th></tr></thead><tbody></tbody></table></div>' +
    '<p data-batch-rename-status role="status"></p><div class="modal-footer">' +
    '<button type="button" class="button subtle" data-batch-rename-close>关闭</button>' +
    '<button type="submit" class="button primary" disabled>重命名选中项</button></div></form>';
  const form = dialog.querySelector('form');
  const submit = form.querySelector('[type="submit"]');
  const close = form.querySelector('[data-batch-rename-close]');
  const scope = form.querySelector('[data-batch-rename-scope]');
  const status = form.querySelector('[data-batch-rename-status]');
  const {prefix,suffix} = form.elements;
  let busy = false;
  let composing = false;
  const rows = entries.slice(0,previewLimit).map(entry => {
    const row = owner.createElement('tr');
    const check = owner.createElement('input');
    check.type = 'checkbox';
    check.checked = true;
    check.setAttribute('aria-label','重命名 ' + entry.name);
    row.insertCell().append(check);
    row.insertCell().textContent = entry.name;
    const after = row.insertCell();
    return {entry,row,check,after,complete:false,name:entry.name};
  });
  form.querySelector('tbody').append(...rows.map(record => record.row));

  function valid(record) {
    return !record.complete && record.name !== record.entry.name && record.name.length <= 255 && !invalidName.test(record.name);
  }

  function update() {
    const names = new Map();
    for (const record of rows) {
      record.name = record.complete ? record.name : decoratedName(record.entry,prefix.value,suffix.value);
      const key = record.name.toLowerCase();
      if (record.check.checked && valid(record)) names.set(key,(names.get(key) || 0) + 1);
    }
    let accepted = 0;
    for (const record of rows) {
      const error = record.name !== record.entry.name && !record.complete &&
        (!valid(record) ? '名称不符合 Windows 文件命名规则' : (names.get(record.name.toLowerCase()) || 0) > 1 ? '预览中有重名' : '');
      record.applicable = valid(record) && !error;
      record.after.textContent = record.name + (error ? ' · ' + error : '');
      record.after.title = error || record.name;
      record.row.toggleAttribute('data-rename-conflict',Boolean(error));
      record.check.disabled = busy || record.complete || record.name === record.entry.name;
      if (record.applicable && record.check.checked) accepted++;
    }
    submit.disabled = busy || !accepted;
    scope.textContent = '预览 ' + rows.length + ' 项 · 将重命名 ' + accepted + ' 项' +
      (entries.length > rows.length ? ' · 另有 ' + (entries.length - rows.length) + ' 项未列入本次操作' : '');
  }

  form.addEventListener('input',event => { if (!event.isComposing && !composing) update(); });
  form.addEventListener('compositionstart',() => { composing = true; });
  form.addEventListener('compositionend',() => { composing = false; update(); });
  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (busy || composing || submit.disabled) return;
    const selected = rows.filter(record => record.applicable && record.check.checked);
    busy = true;
    prefix.disabled = suffix.disabled = close.disabled = true;
    update();
    status.textContent = '正在重命名选中的项目…';
    try {
      const results = await apply(selected.map(({entry,name}) => ({path:entry.path,name})));
      let failed = 0;
      for (const [index,record] of selected.entries()) {
        const message = results[index];
        if (message) { failed++; record.row.cells[1].textContent = record.entry.name + ' · ' + message; }
        else {
          record.complete = true;
          record.check.checked = false;
          record.row.cells[1].textContent = record.entry.name + ' · 已重命名';
        }
      }
      status.textContent = '已重命名 ' + (selected.length - failed) + ' 项' + (failed ? '，' + failed + ' 项失败。' : '。');
    } catch (failure) {
      status.textContent = String(failure?.message || failure);
    } finally {
      busy = false;
      prefix.disabled = suffix.disabled = close.disabled = false;
      update();
    }
  });
  dialog.addEventListener('cancel',event => { if (busy) event.preventDefault(); });
  close.addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => {
    dialog.remove();
    if (opener?.isConnected) opener.focus({preventScroll:true});
  },{once:true});
  update();
  panel.append(dialog);
  dialog.showModal();
}
