import {readReviewNotes, reviewShotCode} from './whiteboard-review-notes.js';

const regionId = /^nexus-region-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shotSuffix = /\n\[nexus-shot:([A-Z0-9][A-Z0-9_-]{0,47})\]$/;
const nameLimit = 80;

export const newWhiteboardRegionId = () => 'nexus-region-' + crypto.randomUUID();
export const isWhiteboardRegion = item => item?.kind === 'frame' && regionId.test(item.id);

export function readWhiteboardRegion(item) {
  if (!isWhiteboardRegion(item) || typeof item.text !== 'string' || !item.text.trim() ||
      ![item.x,item.y,item.width,item.height].every(Number.isFinite) || item.width <= 0 || item.height <= 0) return null;
  const suffix = item.text.match(shotSuffix);
  const name = (suffix ? item.text.slice(0,suffix.index) : item.text).trim().slice(0,nameLimit);
  return name ? {id:item.id,name,shot:suffix?.[1] || '',item} : null;
}

export function whiteboardRegionText(name,shot) {
  return name.trim().slice(0,nameLimit) + (shot ? `\n[nexus-shot:${shot}]` : '');
}

export function suggestedRegionShot(selection) {
  const shots = new Set();
  for (const item of selection) {
    const {text, notes} = readReviewNotes(item.text);
    for (const note of notes) if (note.shot) shots.add(note.shot);
    const nameCode = text.match(/(?:^|[^a-z0-9])(sh(?:ot)?[-_]?\d{1,8}[a-z]?)(?=$|[^a-z0-9])/i)?.[1];
    if (nameCode) shots.add(reviewShotCode(nameCode));
  }
  return shots.size === 1 ? [...shots][0] : '';
}

export function chooseWhiteboardRegion(matches,shot) {
  if (matches.length < 2) return Promise.resolve(matches[0] || null);
  const dialog = document.createElement('dialog');
  dialog.className = 'modal whiteboard-regions-dialog';
  dialog.innerHTML = `<div class="modal-header">
    <h2 id="whiteboard-region-picker-title"></h2>
    <button type="button" class="icon-button" data-region-cancel aria-label="关闭">×</button>
  </div><div class="whiteboard-region-results" data-region-choices></div>`;
  dialog.setAttribute('aria-labelledby','whiteboard-region-picker-title');
  dialog.querySelector('h2').textContent = `选择 ${shot} 的白板区域`;
  const choices = dialog.querySelector('[data-region-choices]');
  let selected = null;
  for (const region of matches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button subtle whiteboard-region-choice';
    button.textContent = `${region.projectName} · ${region.name}`;
    button.addEventListener('click',() => { selected = region; dialog.close(); });
    choices.append(button);
  }
  document.body.append(dialog);
  dialog.querySelector('[data-region-cancel]').addEventListener('click',() => dialog.close());
  return new Promise(resolve => {
    dialog.addEventListener('close',() => { dialog.remove(); resolve(selected); },{once:true});
    dialog.showModal();
    choices.firstElementChild.focus();
  });
}

export function initWhiteboardRegions({regions,context,canEdit,capture,save,remove,jump}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal whiteboard-regions-dialog';
  dialog.setAttribute('aria-labelledby','whiteboard-regions-title');
  dialog.innerHTML = `<header class="modal-header">
    <h2 id="whiteboard-regions-title">白板区域</h2>
    <button type="button" class="icon-button" data-region-close aria-label="关闭">×</button>
  </header>
  <div class="whiteboard-region-results" data-region-list></div>
  <form class="whiteboard-region-form" data-region-form>
    <h3 data-region-form-heading></h3>
    <div class="whiteboard-region-fields">
      <label>区域名称<input data-region-name maxlength="${nameLimit}" required></label>
      <label>镜头号（可选）<input data-region-shot maxlength="48" placeholder="如 SH010"></label>
      <label>范围<select data-region-source></select></label>
    </div>
    <div class="modal-footer">
      <button type="button" class="button subtle" data-region-reset hidden>取消编辑</button>
      <button type="submit" class="button primary" data-region-save>保存区域</button>
    </div>
  </form>
  <p data-region-status role="status"></p>`;
  document.body.append(dialog);
  const get = selector => dialog.querySelector(selector);
  const list = get('[data-region-list]');
  const form = get('[data-region-form]');
  const name = get('[data-region-name]');
  const shot = get('[data-region-shot]');
  const source = get('[data-region-source]');
  const reset = get('[data-region-reset]');
  const status = get('[data-region-status]');
  let board;
  let position;
  let editing;
  let signature;

  function action(label,handler,regionAction) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button subtle';
    button.textContent = label;
    button.dataset.regionAction = regionAction;
    button.addEventListener('click',handler);
    return button;
  }

  function draw() {
    if (!dialog.open) return;
    const allowed = canEdit();
    const entries = regions();
    form.hidden = !allowed;
    const next = JSON.stringify([allowed,entries.map(({id,name,shot}) => [id,name,shot])]);
    if (next === signature) return;
    signature = next;
    list.replaceChildren();
    if (!entries.length) {
      list.textContent = '此项目还没有白板区域。';
      return;
    }
    for (const region of entries) {
      const row = document.createElement('div');
      row.className = 'whiteboard-region-row';
      const go = action(region.name,() => {
        if (context() !== board || !jump(region.id)) { status.textContent = '该区域已移除或当前画布不可用'; return; }
        dialog.close();
      },'jump');
      go.classList.add('whiteboard-region-choice');
      if (region.shot) {
        const code = document.createElement('small');
        code.textContent = region.shot;
        go.append(code);
      }
      row.append(go);
      if (allowed) row.append(action('编辑',() => edit(region),'edit'),action('删除',() => {
        try {
          remove(board,region.id);
          if (editing === region.id) edit(null);
          status.textContent = '区域已删除，可在白板中撤销';
          list.querySelector('[data-region-action="jump"]')?.focus();
        } catch (failure) { status.textContent = failure.message; }
      },'remove'));
      list.append(row);
    }
  }

  function edit(region) {
    editing = region?.id;
    name.value = region?.name || '';
    shot.value = region ? region.shot : position.shot;
    source.replaceChildren();
    if (region) source.add(new Option('保留原区域','previous'));
    source.add(new Option('当前画面','view'));
    if (position.selection) source.add(new Option('所选内容','selection'));
    source.value = region ? 'previous' : position.selection ? 'selection' : 'view';
    reset.hidden = !region;
    get('[data-region-form-heading]').textContent = region ? '编辑区域' : '新建区域';
    status.textContent = '';
  }

  form.addEventListener('submit',event => {
    event.preventDefault();
    if (!name.value.trim()) { status.textContent = '请输入区域名称'; return; }
    const code = reviewShotCode(shot.value);
    if (shot.value.trim() && !code) { status.textContent = '镜头号须以字母或数字开头，可包含连字符或下划线'; return; }
    try {
      save(board,editing,name.value,code,position[source.value]);
      const message = editing ? '区域已更新' : '区域已保存';
      edit(null);
      status.textContent = message;
    } catch (failure) { status.textContent = failure.message; }
  });
  reset.addEventListener('click',() => { edit(null); name.focus(); });
  get('[data-region-close]').addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => { board = position = editing = signature = null; });
  return {
    open() {
      if (dialog.open) return;
      board = context();
      if (!board) return;
      position = capture();
      edit(null);
      dialog.showModal();
      draw();
      (list.querySelector('[data-region-action="jump"]') || (!form.hidden && name) || get('[data-region-close]')).focus();
    },
    close() { if (dialog.open) dialog.close(); },
    isOpen:() => dialog.open,
    refresh:draw,
  };
}
