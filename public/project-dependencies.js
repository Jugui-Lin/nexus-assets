const kinds = {buffer:'缓冲区',image:'贴图'};
const statuses = {available:'可访问',missing:'缺失',unavailable:'无法访问',embedded:'内嵌',unsupported:'不支持的路径'};

export function initProjectDependencies({api,reveal}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal project-dependencies-dialog';
  dialog.setAttribute('aria-labelledby','project-dependencies-title');
  dialog.innerHTML = `
    <div class="modal-header"><h2 id="project-dependencies-title">glTF 工程依赖</h2><button type="button" class="icon-button" data-close aria-label="关闭"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <p class="modal-description" data-source></p>
    <form>
      <div data-references class="project-dependency-list" aria-label="工程引用"></div>
      <label class="field-label">副本文件名<input class="text-field" name="copyName" maxlength="200" required></label>
      <p data-status class="workspace-search-error" role="status"></p>
      <div class="modal-footer">
        <button type="button" class="button subtle" data-reveal hidden>定位副本</button>
        <button type="submit" class="button primary" disabled>另存为工程副本</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const source = dialog.querySelector('[data-source]');
  const list = dialog.querySelector('[data-references]');
  const status = dialog.querySelector('[data-status]');
  const form = dialog.querySelector('form');
  const name = form.elements.copyName;
  const save = form.querySelector('[type=submit]');
  const revealCopy = form.querySelector('[data-reveal]');
  const close = dialog.querySelector('[data-close]');
  let current;

  const active = draft => dialog.open && current === draft;
  const message = failure => String(failure?.message || failure);
  const editable = ({status}) => ['available','missing','unavailable'].includes(status);

  function updateRows(draft) {
    list.replaceChildren(...draft.references.map(reference => {
      const row = document.createElement('div');
      row.className = 'project-dependency-row';
      const summary = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = `${kinds[reference.kind] || '引用'} ${reference.index + 1} · ${statuses[reference.status] || '未知状态'}`;
      const path = document.createElement('span');
      path.textContent = reference.status === 'embedded' ? '随工程保存' : reference.uri;
      path.title = reference.path || '';
      summary.append(label,path);
      row.append(summary);
      if (editable(reference)) {
        const replace = document.createElement('button');
        replace.type = 'button';
        replace.className = 'button subtle';
        replace.textContent = '选择替换文件…';
        replace.setAttribute('aria-label',`${replace.textContent} ${label.textContent}`);
        const replacement = draft.replacements.get(reference);
        if (replacement) {
          const hint = document.createElement('span');
          hint.textContent = `新引用　${replacement}`;
          summary.append(hint);
          const reset = document.createElement('button');
          reset.type = 'button';
          reset.className = 'text-button';
          reset.textContent = '撤销替换';
          reset.addEventListener('click',() => {
            draft.replacements.delete(reference);
            updateRows(draft);
          });
          row.append(reset);
        }
        replace.addEventListener('click',async () => {
          if (!active(draft) || draft.busy) return;
          draft.busy = true;
          replace.disabled = save.disabled = true;
          try {
            const replacement = await api('pick_project_dependency_file',{projectPath:draft.path});
            if (active(draft) && replacement) draft.replacements.set(reference,replacement);
          } catch (failure) {
            if (active(draft)) status.textContent = message(failure);
          } finally {
            draft.busy = false;
            if (active(draft)) updateRows(draft);
          }
        });
        row.append(replace);
      }
      return row;
    }));
    save.disabled = !draft.replacements.size || draft.busy;
  }

  async function show(path) {
    if (dialog.open) return;
    const draft = current = {path,revision:null,references:[],replacements:new Map(),busy:false};
    source.textContent = path;
    name.value = path.split(/[/\\]/).at(-1).replace(/\.gltf$/i,'_已重连.gltf');
    revealCopy.hidden = true;
    list.replaceChildren();
    save.disabled = true;
    status.textContent = '正在检查相对路径…';
    dialog.showModal();
    try {
      const report = await api('inspect_project_dependencies',{path});
      if (!active(draft)) return;
      draft.revision = report.revision;
      draft.references = report.references;
      status.textContent = report.references.length ? '' : '没有外部缓冲区或贴图引用。';
      updateRows(draft);
    } catch (failure) {
      if (active(draft)) status.textContent = message(failure);
    }
  }

  close.addEventListener('click',() => { if (!current?.saving) dialog.close(); });
  dialog.addEventListener('cancel',event => { if (current?.saving) event.preventDefault(); });
  form.addEventListener('submit',async event => {
    event.preventDefault();
    const draft = current;
    if (!draft?.revision || draft.busy || !draft.replacements.size) return;
    const replacements = [...draft.replacements].map(([{kind,index},path]) => ({kind,index,path}));
    draft.busy = draft.saving = true;
    save.disabled = true;
    status.textContent = '正在写入工程副本…';
    try {
      const result = await api('write_project_dependency_copy',{
        path:draft.path,revision:draft.revision,outputName:name.value.trim(),replacements,
      });
      if (!active(draft)) return;
      draft.copy = result.path;
      draft.replacements.clear();
      revealCopy.hidden = false;
      status.textContent = `已将 ${result.updated} 处引用写入副本 ${result.path}`;
    } catch (failure) {
      if (active(draft)) status.textContent = message(failure);
    } finally {
      draft.busy = draft.saving = false;
      if (active(draft)) updateRows(draft);
    }
  });
  revealCopy.addEventListener('click',async () => {
    if (!current?.copy || current.busy) return;
    try { await reveal(current.copy); dialog.close(); }
    catch (failure) { status.textContent = message(failure); }
  });

  return {show};
}
