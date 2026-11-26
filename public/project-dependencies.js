const kinds = {buffer:'缓冲区',image:'贴图'};
const statuses = {available:'可访问',missing:'缺失',unavailable:'无法访问',embedded:'内嵌',
  unsupported:'不支持的路径',incompatible:'格式或大小不兼容',unverified:'待确认格式'};

function referenceKey(reference) {
  if (!reference.path) return JSON.stringify([reference.kind,'uri',reference.uri]);
  const path = /^[a-z]:|^\\\\/i.test(reference.path) ? reference.path.replaceAll('/','\\').toLowerCase() : reference.path;
  return JSON.stringify([reference.kind,'path',path]);
}

export function compareProjectReferences(before, after) {
  const external = list => list.filter(reference => reference.status !== 'embedded' && reference.uri);
  const originals = new Map();
  for (const row of external(before)) {
    const key = referenceKey(row);
    if (!originals.has(key)) originals.set(key,[]);
    originals.get(key).push(row);
  }
  const displaced = external(after).filter(row => {
    const matches = originals.get(referenceKey(row));
    const index = matches?.findIndex(original => original.index === row.index) ?? -1;
    if (index < 0) return true;
    matches.splice(index,1);
    return false;
  });
  const additions = displaced.filter(row => !originals.get(referenceKey(row))?.pop());
  const remaining = Array.from(originals.values()).flat();
  const slot = row => JSON.stringify([row.kind,row.index]);
  const removed = new Map(remaining.map(row => [slot(row),row]));
  const differences = additions.map(row => {
    const key = slot(row);
    const original = removed.get(key);
    removed.delete(key);
    return original ? {state:'replaced',before:original,after:row} : {state:'added',after:row};
  });
  for (const row of removed.values()) differences.push({state:'removed',before:row});
  return differences.sort((left,right) => {
    const a = left.after || left.before;
    const b = right.after || right.before;
    return a.kind.localeCompare(b.kind) || a.index - b.index;
  });
}

export function initProjectDependencies({api,reveal}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal project-dependencies-dialog';
  dialog.setAttribute('aria-labelledby','project-dependencies-title');
  dialog.innerHTML = `
    <div class="modal-header"><h2 id="project-dependencies-title">glTF 工程依赖</h2><button type="button" class="icon-button" data-close aria-label="关闭"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <p class="modal-description" data-source></p>
    <p class="modal-description" data-project-extensions hidden></p>
    <form>
      <div class="project-dependency-tools">
        <p class="modal-description" data-reference-summary></p>
        <label><input type="checkbox" data-problems-only>仅显示需检查项</label>
        <button type="button" class="button subtle" data-suggest disabled>查找候选文件夹…</button>
      </div>
      <div data-references class="project-dependency-list" aria-label="工程引用"></div>
      <section data-diff class="project-dependency-diff" aria-label="依赖版本差异" hidden>
        <strong data-diff-summary aria-live="polite"></strong>
        <ul data-diff-list></ul>
      </section>
      <label class="field-label">副本文件名<input class="text-field" name="copyName" maxlength="200" required></label>
      <p data-status class="workspace-search-error" role="status"></p>
      <div class="modal-footer">
        <button type="button" class="button subtle" data-compare disabled>比较工程版本…</button>
        <button type="button" class="button subtle" data-reveal hidden>定位副本</button>
        <button type="submit" class="button primary" disabled>另存为工程副本</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const source = dialog.querySelector('[data-source]');
  const extensions = dialog.querySelector('[data-project-extensions]');
  const summary = dialog.querySelector('[data-reference-summary]');
  const problemsOnly = dialog.querySelector('[data-problems-only]');
  const list = dialog.querySelector('[data-references]');
  const status = dialog.querySelector('[data-status]');
  const form = dialog.querySelector('form');
  const name = form.elements.copyName;
  const save = form.querySelector('[type=submit]');
  const compare = form.querySelector('[data-compare]');
  const suggest = form.querySelector('[data-suggest]');
  const diff = form.querySelector('[data-diff]');
  const diffSummary = diff.querySelector('[data-diff-summary]');
  const diffList = diff.querySelector('[data-diff-list]');
  const revealCopy = form.querySelector('[data-reveal]');
  const close = dialog.querySelector('[data-close]');
  let current;

  const active = draft => dialog.open && current === draft;
  const message = failure => String(failure?.message || failure);
  const editable = ({status}) => ['available','missing','unavailable','incompatible','unverified'].includes(status);
  const needsReview = reference => reference.temporary ||
    ['missing','unavailable','incompatible','unsupported','unverified'].includes(reference.status);
  const searchTarget = ({status}) => ['missing','incompatible'].includes(status);

  function updateActions(draft) {
    save.disabled = !draft.replacements.size || draft.busy;
    compare.disabled = !draft.revision || draft.busy;
    suggest.disabled = !draft.revision || draft.busy || !draft.references.some(searchTarget);
    list.toggleAttribute('inert',draft.busy);
    summary.textContent = draft.revision ?
      `${draft.references.length} 项依赖 · ${draft.references.filter(needsReview).length} 项需检查` +
        (draft.replacements.size ? ` · 已勾选 ${draft.replacements.size} 项替换` : '') : '';
  }

  function appendChoices(row,draft,reference) {
    const choices = draft.proposals.get(reference);
    if (!choices?.length) return;
    const accepted = draft.replacements.get(reference);
    const section = document.createElement('fieldset');
    section.className = 'project-dependency-candidates';
    const legend = document.createElement('legend');
    legend.textContent = choices.length > 1 ? `候选方案 (${choices.length})` : '候选方案';
    section.append(legend);
    for (const candidate of choices) {
      const option = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = candidate === accepted;
      checkbox.setAttribute('aria-label',`采用 ${candidate.path}`);
      const text = document.createElement('span');
      const file = document.createElement('strong');
      file.textContent = candidate.path;
      const preview = document.createElement('small');
      preview.textContent = `写入相对路径 ${candidate.uri}`;
      const reason = document.createElement('small');
      reason.textContent = [...candidate.evidence,...(candidate.temporary ? ['位于系统临时目录'] : [])].join(' · ');
      text.append(file,preview,reason);
      option.append(checkbox,text);
      checkbox.addEventListener('change',() => {
        if (checkbox.checked) {
          for (const other of section.querySelectorAll('input')) {
            if (other !== checkbox) other.checked = false;
          }
          draft.replacements.set(reference,candidate);
        } else {
          draft.replacements.delete(reference);
        }
        updateActions(draft);
      });
      section.append(option);
    }
    row.append(section);
  }

  function updateRows(draft) {
    const shown = draft.references.filter(reference => !problemsOnly.checked || needsReview(reference) ||
      draft.replacements.has(reference));
    list.replaceChildren(...shown.map(reference => {
      const row = document.createElement('div');
      row.className = 'project-dependency-row';
      row.dataset.dependencySlot = reference.kind + ':' + reference.index;
      const summary = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = `${kinds[reference.kind] || '引用'} ${reference.index + 1} · ${statuses[reference.status] || '未知状态'}`;
      const path = document.createElement('span');
      path.textContent = reference.status === 'embedded' ? '随工程保存' : reference.uri;
      path.title = reference.path || '';
      summary.append(label,path);
      if (reference.detail || reference.temporary) {
        const detail = document.createElement('span');
        detail.textContent = [reference.detail,reference.temporary && '位于系统临时目录'].filter(Boolean).join(' · ');
        summary.append(detail);
      }
      row.append(summary);
      if (editable(reference)) {
        const replace = document.createElement('button');
        replace.type = 'button';
        replace.className = 'button subtle';
        replace.textContent = '选择替换文件…';
        replace.setAttribute('aria-label',`${replace.textContent} ${label.textContent}`);
        replace.addEventListener('click',async () => {
          if (!active(draft) || draft.busy) return;
          draft.busy = true;
          updateActions(draft);
          try {
            const replacementPath = await api('pick_project_dependency_file',{projectPath:draft.path});
            if (!active(draft) || !replacementPath) return;
            status.textContent = '正在检查候选和新引用路径…';
            const candidate = await api('preview_project_dependency_replacement',{
              path:draft.path, revision:draft.revision, kind:reference.kind,index:reference.index,replacementPath,
            });
            if (!active(draft)) return;
            const previous = draft.proposals.get(reference) || [];
            draft.proposals.set(reference,[candidate,...previous.filter(preview => preview.path !== candidate.path)].slice(0,5));
            if (draft.replacements.get(reference)?.path === candidate.path) draft.replacements.delete(reference);
            status.textContent = '核对候选及新引用路径后，勾选需要采用的方案。';
          } catch (failure) {
            if (active(draft)) status.textContent = message(failure);
          } finally {
            draft.busy = false;
            if (active(draft)) updateRows(draft);
          }
        });
        row.append(replace);
      }
      appendChoices(row,draft,reference);
      return row;
    }));
    updateActions(draft);
  }

  async function show(path) {
    if (dialog.open) return;
    const draft = current = {path,revision:null,references:[],replacements:new Map(),proposals:new Map(),busy:false};
    source.textContent = path;
    extensions.hidden = true;
    extensions.textContent = summary.textContent = '';
    problemsOnly.checked = false;
    name.value = path.split(/[/\\]/).at(-1).replace(/\.gltf$/i,'_已重连.gltf');
    revealCopy.hidden = true;
    diff.hidden = true;
    diffList.replaceChildren();
    list.replaceChildren();
    updateActions(draft);
    status.textContent = '正在检查相对路径…';
    dialog.showModal();
    try {
      const report = await api('inspect_project_dependencies',{path});
      if (!active(draft)) return;
      draft.revision = report.revision;
      draft.references = report.references;
      const required = report.requiredExtensions || [];
      extensions.hidden = !required.length;
      extensions.textContent = required.length ? `工程要求 glTF 扩展 ${required.join('、')}` : '';
      status.textContent = report.references.length ? '' : '没有外部缓冲区或贴图引用。';
      updateRows(draft);
    } catch (failure) {
      if (active(draft)) status.textContent = message(failure);
    }
  }

  close.addEventListener('click',() => { if (!current?.saving) dialog.close(); });
  dialog.addEventListener('cancel',event => { if (current?.saving) event.preventDefault(); });
  problemsOnly.addEventListener('change',() => { if (current) updateRows(current); });
  suggest.addEventListener('click',async () => {
    const draft = current;
    if (!draft?.revision || draft.busy) return;
    draft.busy = true;
    updateActions(draft);
    try {
      const folder = await api('pick_project_dependency_file',{projectPath:draft.path,folder:true});
      if (!active(draft) || !folder) return;
      status.textContent = '正在查找同名且兼容的文件…';
      const report = await api('suggest_project_dependency_replacements',{
        path:draft.path,revision:draft.revision,folder,
      });
      if (!active(draft)) return;
      for (const {kind,index,choices} of report.groups) {
        const reference = draft.references.find(item => item.kind === kind && item.index === index);
        if (!reference) continue;
        let adopted = draft.replacements.get(reference);
        const previous = draft.proposals.get(reference) || [];
        const candidates = new Map(choices.map(candidate => [candidate.path,candidate]));
        for (const candidate of previous) {
          if (!candidates.has(candidate.path)) candidates.set(candidate.path,candidate);
        }
        if (adopted && candidates.get(adopted.path)?.stamp !== adopted.stamp) {
          draft.replacements.delete(reference);
          adopted = null;
        }
        if (adopted) candidates.delete(adopted.path);
        draft.proposals.set(reference,[...(adopted ? [adopted] : []),...candidates.values()].slice(0,5));
      }
      status.textContent = (report.groups.length
        ? `找到 ${report.groups.length} 项依赖的候选。请逐项核对文件和新引用路径。`
        : '在此文件夹内未找到同名且兼容的候选。') +
        (report.truncated ? ' 已达到查找上限，可换用更小的文件夹。' : '');
    } catch (failure) {
      if (active(draft)) status.textContent = message(failure);
    } finally {
      draft.busy = false;
      if (active(draft)) updateRows(draft);
    }
  });
  compare.addEventListener('click',async () => {
    const draft = current;
    if (!draft?.revision || draft.busy) return;
    draft.busy = true;
    updateActions(draft);
    try {
      const previousPath = await api('pick_project_dependency_file',{projectPath:draft.path,gltfOnly:true});
      if (!active(draft) || !previousPath) return;
      status.textContent = '正在比较外部依赖…';
      const previous = await api('inspect_project_dependencies',{path:previousPath});
      if (!active(draft)) return;
      const changes = compareProjectReferences(previous.references,draft.references);
      const labels = {added:'新增',removed:'移除',replaced:'替换'};
      const rows = changes.map(({state,before,after}) => {
        const row = document.createElement('li');
        const ref = after || before;
        const change = before && after ? `${before.uri} → ${after.uri}` : ref.uri;
        row.textContent = `${labels[state]} · ${kinds[ref.kind] || '引用'} · ${change}`;
        if (before?.path || after?.path) row.title = [before?.path,after?.path].filter(Boolean).join('\n');
        return row;
      });
      diffList.replaceChildren(...rows);
      diffSummary.textContent = changes.length ? `相对参考版本有 ${changes.length} 处外部引用路径变化` : '外部引用路径无变化';
      diffSummary.title = previousPath;
      diff.hidden = false;
      status.textContent = '';
    } catch (failure) {
      if (active(draft)) status.textContent = message(failure);
    } finally {
      draft.busy = false;
      if (active(draft)) updateRows(draft);
    }
  });
  form.addEventListener('submit',async event => {
    event.preventDefault();
    const draft = current;
    if (!draft?.revision || draft.busy || !draft.replacements.size) return;
    const replacements = [...draft.replacements].map(([{kind,index},{path,stamp}]) => ({kind,index,path,stamp}));
    draft.busy = draft.saving = true;
    updateActions(draft);
    status.textContent = '正在写入工程副本…';
    try {
      const result = await api('write_project_dependency_copy',{
        path:draft.path,revision:draft.revision,outputName:name.value.trim(),replacements,
      });
      if (!active(draft)) return;
      draft.copy = result.path;
      draft.replacements.clear();
      draft.proposals.clear();
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
