const dateText = new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'short',day:'numeric'});
const sizeText = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});

function localDateInput(date) {
  return [date.getFullYear(),date.getMonth()+1,date.getDate()]
    .map((part,index) => String(part).padStart(index ? 2 : 4,'0')).join('-');
}

function dateBoundary(input, dayOffset = 0) {
  const [year,month,day] = input.value.split('-').map(Number);
  if (!year || !month || !day) return NaN;
  const date = new Date(0);
  date.setFullYear(year,month-1,day+dayOffset);
  date.setHours(0,0,0,0);
  return Math.floor(date.getTime()/1000);
}

function node(tag,className,text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

function button(text, action, id) {
  const element = node('button','button subtle',text);
  element.type = 'button';
  element.dataset.action = action;
  if (id) element.dataset.id = id;
  return element;
}

export function initDuplicateReview({api,context,preview,reveal,validateMove,refresh,notify}) {
  const dialog = document.getElementById('asset-duplicate-dialog');
  const form = dialog.querySelector('form');
  const status = dialog.querySelector('[role="status"]');
  const results = dialog.querySelector('[data-duplicate-groups]');
  const scan = dialog.querySelector('[type="submit"]');
  const close = dialog.querySelector('[data-duplicate-close]');
  const startField = form.elements.start;
  const endField = form.elements.end;
  let visit;

  const active = current => dialog.open && current === visit && context() === current.context;
  const message = failure => String(failure?.message || failure);

  function busy(current,value) {
    current.busy = value;
    scan.disabled = close.disabled = startField.disabled = endField.disabled = value;
    results.toggleAttribute('inert',value);
  }

  function draw(current) {
    const sections = current.groups.map((group,index) => {
      const section = node('section','duplicate-review-group');
      section.dataset.duplicateGroup = String(index);
      const label = group.size < 1024*1024 ? sizeText.format(group.size/1024) + ' KB'
        : sizeText.format(group.size/(1024*1024)) + ' MB';
      section.append(node('h3',null,`${group.members.length} 条相同内容 · ${label}`));
      const items = node('fieldset','duplicate-review-members');
      items.append(node('legend',null,'选择一条保留'));
      for (const {id,name,path,added,favorite} of group.members) {
        const row = node('div','duplicate-review-row');
        const choice = node('label');
        const radio = node('input');
        radio.type = 'radio';
        radio.name = 'keeper-' + index;
        radio.value = id;
        radio.setAttribute('aria-label','保留 ' + name + ' ' + path);
        const info = node('span','duplicate-review-file');
        info.append(node('strong',null,name),node('small',null,path),
          node('small',null,`${dateText.format(added*1000)}${favorite ? ' · 已收藏' : ''}`));
        choice.append(radio,info);
        row.append(choice,button('预览','preview',id),button('定位','locate',id));
        items.append(row);
      }
      const move = button(`将其余 ${group.members.length-1} 条移到回收站`,'recycle');
      move.disabled = true;
      section.append(items,move);
      return section;
    });
    results.replaceChildren(...sections);
  }

  function show() {
    const scope = context();
    if (!scope || dialog.open) return;
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate()-29);
    startField.value = localDateInput(start);
    endField.value = localDateInput(today);
    visit = {context:scope,groups:[]};
    status.textContent = '';
    busy(visit,false);
    draw(visit);
    dialog.showModal();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const current = visit;
    if (!current || current.busy || !active(current)) return;
    const start = dateBoundary(startField);
    const end = dateBoundary(endField,1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      status.textContent = '请选择有效的入库日期范围。';
      return;
    }
    current.range = {start,end};
    current.groups = [];
    draw(current);
    busy(current,true);
    status.textContent = '正在检查同大小文件的内容…';
    try {
      const result = await api('review_asset_duplicates',current.range);
      if (!active(current)) return;
      current.groups = result.groups;
      current.scope = result.scope;
      draw(current);
      status.textContent = `检查 ${result.examined} 条索引，完成 ${result.hashed} 条内容校验，找到 ${result.groups.length} 组重复。` +
        (result.skipped ? ` ${result.skipped} 条缺少可读的本机文件或超出单文件上限。` : '') +
        (result.truncated ? ' 已到本次检查上限，可缩小日期范围。' : '');
    } catch (failure) {
      if (active(current)) status.textContent = message(failure);
    } finally {
      if (visit === current) busy(current,false);
    }
  });

  form.addEventListener('input', () => {
    if (visit?.busy || !visit?.groups.length) return;
    visit.groups = [];
    draw(visit);
    status.textContent = '日期范围已修改，请重新检查。';
  });
  results.addEventListener('change', event => {
    const group = event.target.closest('[data-duplicate-group]');
    if (group && event.target.matches('input[type="radio"]')) {
      group.querySelector('[data-action="recycle"]').disabled = !group.querySelector('input:checked');
    }
  });
  results.addEventListener('click', async event => {
    const action = event.target.closest('button[data-action]');
    const current = visit;
    if (!action || !current || current.busy || !active(current)) return;
    const section = action.closest('[data-duplicate-group]');
    const index = Number(section.dataset.duplicateGroup);
    const group = current.groups[index];
    if (action.dataset.action === 'preview') return preview(action.dataset.id,group.members.map(item => item.id));
    if (action.dataset.action === 'locate') {
      dialog.close();
      try { await reveal(action.dataset.id); }
      catch (failure) { notify(message(failure),true); }
      return;
    }
    const keeper = section.querySelector('input:checked')?.value;
    if (!keeper || !group.members.some(member => member.id === keeper)) return;
    const duplicates = group.members.filter(member => member.id !== keeper).map(member => member.id);
    busy(current,true);
    status.textContent = '正在再次校验所选记录…';
    let moved = 0;
    try {
      validateMove(duplicates);
      moved = await api('recycle_verified_duplicates',{
        ...current.range,scope:current.scope,keeper,duplicates,fingerprint:group.fingerprint,
      });
      if (!active(current)) return;
      current.groups.splice(index,1);
      draw(current);
      status.textContent = `已将 ${moved} 条索引移到回收站。保留的记录和原文件可继续使用。`;
      await refresh(duplicates);
    } catch (failure) {
      if (active(current)) status.textContent = (moved ? `已回收 ${moved} 条索引。` : '') + message(failure);
    } finally {
      if (visit === current) busy(current,false);
    }
  });
  close.addEventListener('click',() => dialog.close());
  dialog.addEventListener('cancel',event => { if (visit?.busy) event.preventDefault(); });
  dialog.addEventListener('close',() => { if (!dialog.open) visit = null; });
  return {show};
}
