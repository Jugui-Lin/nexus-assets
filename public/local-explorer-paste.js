const kinds = {image:'图片',video:'视频',audio:'音频',project:'工程',other:'其他'};
const number = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});

function bytes(value) {
  if (value == null) return '';
  const units = ['B','KB','MB','GB','TB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return number.format(value) + ' ' + units[index];
}

export function showExplorerPasteConflicts({panel,destination,preview,apply}) {
  const owner = panel.ownerDocument;
  const dialog = owner.createElement('dialog');
  dialog.className = 'modal explorer-paste-dialog';
  dialog.setAttribute('aria-labelledby','explorer-paste-title');
  dialog.innerHTML = `
    <form>
      <div class="modal-header"><h2 id="explorer-paste-title">粘贴文件重名</h2><button type="button" class="icon-button" aria-label="关闭" data-close>×</button></div>
      <p class="muted" dir="ltr" data-destination></p>
      <div class="explorer-paste-groups">
        <label>类型<select data-group></select></label>
        <button type="button" class="button subtle" data-bulk="keep-both">此类型全部保留两份</button>
        <button type="button" class="button subtle" data-bulk="skip">此类型全部跳过</button>
      </div>
      <div class="explorer-paste-list" data-rows></div>
      <p role="status" data-status></p>
      <ul class="explorer-paste-errors" data-errors hidden></ul>
      <div class="modal-footer">
        <button type="button" class="button subtle" data-cancel>取消</button>
        <button type="submit" class="button primary">粘贴</button>
      </div>
    </form>`;
  const find = selector => dialog.querySelector(selector);
  const form = find('form');
  const rows = find('[data-rows]');
  const group = find('[data-group]');
  const status = find('[data-status]');
  const errors = find('[data-errors]');
  const submit = find('[type="submit"]');
  const cancel = find('[data-cancel]');
  const close = find('[data-close]');
  const counted = new Set(preview.conflicts.map(row => row.kind));
  const addOption = (select,value,label) => {
    const option = owner.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  };
  addOption(group,'all','所有重名项');
  for (const [key,label] of Object.entries(kinds)) if (counted.has(key)) addOption(group,key,label);
  find('[data-destination]').textContent = destination;
  let outcome;
  let working = false;

  function update() {
    const selected = details.filter(row => row.choice.value === 'keep-both').length;
    const newFiles = preview.total - preview.conflicts.length;
    status.textContent = `${number.format(preview.conflicts.length)} 项重名 · 保留两份 ${selected} 项 · 跳过 ${preview.conflicts.length - selected} 项` +
      (newFiles ? ` · 正常粘贴 ${newFiles} 项` : '');
  }

  const details = preview.conflicts.map(entry => {
    const row = owner.createElement('section');
    row.className = 'explorer-paste-row';
    const heading = owner.createElement('strong');
    heading.dir = 'ltr';
    heading.textContent = entry.name;
    const text = owner.createElement('div');
    const addInfo = (label,value) => {
      const line = owner.createElement('p');
      const content = owner.createElement('bdi');
      content.dir = 'ltr';
      content.textContent = value;
      line.append(label,content);
      text.append(line);
    };
    addInfo('来源 ',entry.source + ' · ' + bytes(entry.sourceSize));
    addInfo('冲突 ',entry.blockingPath
      ? entry.blockingPath + (entry.blockingDirectory ? ' · 文件夹' : ' · ' + bytes(entry.blockingSize))
      : '本批已有同名文件');
    addInfo('保留两份时的名称 ',entry.suggestedName);
    const choice = owner.createElement('select');
    choice.setAttribute('aria-label',entry.name + ' 的重名处理');
    addOption(choice,'skip','跳过');
    addOption(choice,'keep-both','保留两份');
    choice.addEventListener('change',update);
    row.append(heading,text,choice);
    rows.append(row);
    return {entry,choice};
  });
  update();

  for (const button of dialog.querySelectorAll('[data-bulk]')) {
    button.addEventListener('click',() => {
      for (const {entry,choice} of details) {
        if (group.value === 'all' || entry.kind === group.value) choice.value = button.dataset.bulk;
      }
      update();
    });
  }
  const controls = [...dialog.querySelectorAll('button,select')];
  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (working || submit.disabled) return;
    working = true;
    controls.forEach(control => { control.disabled = true; });
    status.textContent = '正在复制文件…';
    let messages;
    try {
      outcome = await apply(details.map(({entry,choice}) => ({index:entry.index,choice:choice.value})));
      if (!outcome?.errors?.length) { dialog.close(); return; }
      status.textContent = `已复制 ${outcome.copied} 项，跳过 ${outcome.skipped} 项，${outcome.errors.length} 项未完成。`;
      messages = outcome.errors;
    } catch (failure) {
      status.textContent = '本次粘贴未能完成。';
      messages = [String(failure?.message || failure)];
    } finally {
      working = false;
      close.disabled = cancel.disabled = false;
    }
    errors.replaceChildren(...messages.map(message => {
      const item = owner.createElement('li');
      item.textContent = message;
      return item;
    }));
    errors.hidden = false;
    cancel.textContent = '关闭';
    cancel.focus();
  });
  dialog.addEventListener('cancel',event => { if (working) event.preventDefault(); });
  for (const control of [close,cancel]) control.addEventListener('click',() => { if (!working) dialog.close(); });
  owner.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close',() => {
      dialog.remove();
      resolve(outcome);
    },{once:true});
    dialog.showModal();
    group.focus();
  });
}
