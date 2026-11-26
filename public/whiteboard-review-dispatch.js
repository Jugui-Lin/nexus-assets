import {reviewTime} from './whiteboard-review-notes.js';

const unassigned = 'unassigned';
const assignedKey = value => value ? `id:${value}` : unassigned;

export function initWhiteboardReviewDispatch({key,list,projectName,exportSelected,copyText}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal compact-dialog whiteboard-review-dispatch';
  dialog.setAttribute('aria-label','按镜头分发修改意见');
  dialog.innerHTML = `<header class="modal-header"><h2>按镜头分发修改意见</h2>
      <button type="button" class="icon-button" data-dispatch-close aria-label="关闭">×</button></header>
    <div class="whiteboard-review-dispatch-filters">
      <label>镜头<select data-dispatch-shot aria-label="筛选镜头"></select></label>
      <label>负责人<select data-dispatch-owner aria-label="筛选负责人"></select></label>
      <label><input type="checkbox" data-dispatch-all>选择显示的意见</label>
    </div>
    <ul data-dispatch-list aria-label="未解决的修改意见"></ul>
    <p data-dispatch-status role="status"></p>
    <footer class="modal-footer"><button type="button" class="button subtle" data-dispatch-copy>复制所选意见</button>
      <button type="button" class="button primary" data-dispatch-export>导出所选意见</button></footer>`;
  document.body.append(dialog);
  const find = selector => dialog.querySelector(selector);
  const shot = find('[data-dispatch-shot]');
  const owner = find('[data-dispatch-owner]');
  const all = find('[data-dispatch-all]');
  const container = find('[data-dispatch-list]');
  const status = find('[data-dispatch-status]');
  const copy = find('[data-dispatch-copy]');
  const exportButton = find('[data-dispatch-export]');
  let draft;

  function matching() {
    return draft?.rows.filter(note => (!shot.value || shot.value === assignedKey(note.shot)) &&
      (!owner.value || owner.value === assignedKey(note.ownerId))) || [];
  }

  function renderCount(rows = matching()) {
    const chosen = rows.filter(note => draft.selected.has(note.key)).length;
    all.disabled = !rows.length;
    all.checked = chosen > 0 && chosen === rows.length;
    all.indeterminate = chosen > 0 && chosen < rows.length;
    copy.disabled = exportButton.disabled = !chosen || Boolean(draft?.busy);
    status.textContent = chosen ? `已选 ${chosen} 条修改意见` : rows.length ? '选择要分发的修改意见' : '当前条件没有未解决的修改意见';
  }

  function render() {
    const rows = matching();
    container.replaceChildren(...rows.map(note => {
      const row = document.createElement('li');
      const label = document.createElement('label');
      const input = document.createElement('input');
      const body = document.createElement('span');
      const header = document.createElement('strong');
      const message = document.createElement('small');
      input.type = 'checkbox';
      input.dataset.dispatchNote = note.key;
      input.checked = draft.selected.has(note.key);
      header.textContent = [note.shot || '未分配镜头',note.ownerName || '未分配负责人',note.title,reviewTime(note.time)].join(' · ');
      message.textContent = note.message;
      body.append(header,message);
      label.append(input,body);
      row.append(label);
      return row;
    }));
    renderCount(rows);
  }

  function close() {
    draft = null;
    if (dialog.open) dialog.close();
  }

  function open() {
    const scope = key();
    if (!scope || dialog.open) return;
    const rows = list();
    draft = {scope,rows,selected:new Set(rows.map(note => note.key))};
    const options = new Map(rows.map(note => [assignedKey(note.ownerId),note.ownerName || '未分配负责人']));
    const shots = new Map(rows.map(note => [assignedKey(note.shot),note.shot || '未分配镜头']));
    const add = (element,label,values) => element.replaceChildren(new Option(label,''),
      ...[...values].sort((a,b) => a[1].localeCompare(b[1],'zh-CN')).map(([value,label]) => new Option(label,value)));
    add(shot,'全部镜头',shots);
    add(owner,'全部负责人',options);
    render();
    dialog.showModal();
  }

  for (const filter of [shot,owner]) filter.addEventListener('change',() => {
    if (!draft) return;
    draft.selected = new Set(matching().map(note => note.key));
    render();
  });
  all.addEventListener('change',() => {
    if (!draft) return;
    draft.selected = new Set(all.checked ? matching().map(note => note.key) : []);
    render();
  });
  container.addEventListener('change',event => {
    const choice = event.target.dataset.dispatchNote;
    if (!choice || !draft) return;
    if (event.target.checked) draft.selected.add(choice);
    else draft.selected.delete(choice);
    renderCount();
  });
  find('[data-dispatch-close]').addEventListener('click',close);
  dialog.addEventListener('close',() => { if (!dialog.open) draft = null; });

  async function output(action) {
    const request = draft;
    if (!request || request.scope !== key() || request.busy) return;
    const review = new Map(list().map(note => [note.key,note]));
    const snapshot = new Map(request.rows.map(note => [note.key,note]));
    const keys = matching().filter(note => request.selected.has(note.key)).map(note => note.key);
    const selected = keys.map(id => review.get(id));
    if (!keys.length || selected.some((note,index) => !note || JSON.stringify(note) !== JSON.stringify(snapshot.get(keys[index])))) {
      status.textContent = '所选标注有变化，请重新打开分发面板核对';
      return;
    }
    request.busy = true;
    renderCount();
    const heading = [projectName(),shot.value && shot.selectedOptions[0]?.textContent,owner.value && owner.selectedOptions[0]?.textContent].filter(Boolean).join(' · ');
    selected.sort((a,b) => (a.shot || '').localeCompare(b.shot || '') || a.title.localeCompare(b.title,'zh-CN') || a.time - b.time);
    let result;
    try {
      if (action === 'copy') {
        const lines = selected.map(note => [note.shot || '未分配镜头',note.ownerName || '未分配负责人',note.title,
          reviewTime(note.time),note.message].join(' · '));
        await copyText([heading,...lines].join('\n'));
        result = `已复制 ${selected.length} 条意见`;
      } else {
        await exportSelected(selected,heading);
        result = `已导出 ${selected.length} 条意见`;
      }
    } catch (failure) { result = String(failure?.message || failure); }
    finally {
      if (draft === request) {
        request.busy = false;
        renderCount();
        status.textContent = result;
      }
    }
  }
  copy.addEventListener('click',() => void output('copy'));
  exportButton.addEventListener('click',() => void output('export'));
  return {open,close,isOpen:() => dialog.open};
}
