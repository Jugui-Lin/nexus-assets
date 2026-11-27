export function chooseWhiteboardReferenceTarget(projects,{workspace,count,skipped,current}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal compact-dialog';
  dialog.setAttribute('aria-labelledby','whiteboard-reference-target-title');
  dialog.innerHTML = `<form>
    <header class="modal-header"><h2 id="whiteboard-reference-target-title">添加到白板</h2></header>
    <p class="modal-description" data-reference-summary></p>
    <label class="field-label" for="whiteboard-reference-project">目标白板</label>
    <select class="text-field" id="whiteboard-reference-project" required></select>
    <p class="modal-description" data-reference-status role="status" hidden></p>
    <footer class="modal-footer">
      <button class="button subtle" type="button" data-reference-cancel>取消</button>
      <button class="button primary" type="submit">添加引用</button>
    </footer>
  </form>`;
  const select = dialog.querySelector('select');
  const submit = dialog.querySelector('[type=submit]');
  const status = dialog.querySelector('[data-reference-status]');
  dialog.querySelector('[data-reference-summary]').textContent = `将 ${count} 个素材引用添加到${workspace}。` +
    (skipped ? `另有 ${skipped} 项没有可用的图片或视频索引。` : '');
  if (projects.length > 1) select.append(new Option('请选择白板', ''));
  select.append(...projects.map(project => new Option(project.name, project.id)));
  submit.disabled = !select.value;
  select.addEventListener('change',() => { submit.disabled = !select.value; });
  let result = null;
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    if (!select.value) return;
    if (!current()) {
      status.textContent = '文件选择或资产库已变化，请重新打开。';
      status.hidden = false;
      submit.disabled = true;
      return;
    }
    result = projects.find(project => project.id === select.value) || null;
    if (result) dialog.close();
  });
  dialog.querySelector('[data-reference-cancel]').addEventListener('click',() => dialog.close());
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close',() => { dialog.remove(); resolve(result); },{once:true});
    dialog.showModal();
    select.focus();
  });
}
