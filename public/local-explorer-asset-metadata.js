import {initExplorerAssetReferences} from './local-explorer-asset-references.js';
import {initExplorerVersionHistory} from './local-explorer-version-history.js';

const editableFields = ['name','notes','workflow'];
const workflows = [
  ['unset','未设置'],['wip','制作中'],['review','待审核'],['approved','已审核'],['archived','已归档'],
];

function metadataValues(asset) {
  return {
    name:asset?.name ?? '', notes:asset?.notes ?? '', workflow:asset?.workflow || 'unset',
    addTags:'', removeTags:'',
  };
}

function splitTags(value) {
  return [...new Set(value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))];
}

function snapshotAsset(asset) {
  return {...asset,tags:[...new Set(asset.tags || [])]};
}

function errorMessage(error) {
  return String(error?.message || error).slice(0,240);
}

export function initExplorerAssetMetadata({host,lookup,save,versions,openVersion,references,openReference}) {
  const owner = host.ownerDocument;
  const section = owner.createElement('section');
  section.className = 'file-explorer-asset-metadata';
  section.setAttribute('aria-labelledby','file-explorer-metadata-heading');
  section.hidden = true;
  section.innerHTML = `
    <h3 id="file-explorer-metadata-heading">资产库信息</h3>
    <p role="status" data-metadata-summary></p>
    <form autocomplete="off" hidden>
      <fieldset>
        <div class="file-explorer-metadata-fields" data-metadata-single>
          <label>资产展示名称 <input name="name" required maxlength="200"></label>
          <label>备注 <textarea name="notes" rows="3" maxlength="10000"></textarea></label>
          <label>工作流状态 <select name="workflow">${workflows.map(([value,label]) =>
            `<option value="${value}">${label}</option>`).join('')}</select></label>
        </div>
        <div class="file-explorer-metadata-tags" data-metadata-tags>
          <div data-metadata-common-row><h4 data-metadata-common-label>共有标签</h4><ul data-metadata-common></ul></div>
          <div data-metadata-different-row><h4>部分资产的标签</h4><ul data-metadata-different></ul></div>
        </div>
        <div class="file-explorer-metadata-fields" data-metadata-edit-tags>
          <label>添加标签 <input name="addTags" placeholder="以逗号分隔" maxlength="1240"></label>
          <label>移除标签 <input name="removeTags" placeholder="以逗号分隔" maxlength="1240"></label>
        </div>
      </fieldset>
      <div class="file-explorer-metadata-actions" data-metadata-actions>
        <button type="button" data-metadata-reset>撤销更改</button>
        <button type="submit" data-metadata-save>保存资产信息</button>
      </div>
      <p role="status" data-metadata-status></p>
    </form>`;
  host.append(section);
  const query = selector => section.querySelector(selector);
  const form = query('form');
  const disclosures = [
    versions && initExplorerVersionHistory({before:form,versions,openVersion}),
    references && initExplorerAssetReferences({before:form,references,openReference}),
  ].filter(Boolean);
  const fieldset = query('fieldset');
  const singleFields = query('[data-metadata-single]');
  const tagFields = query('[data-metadata-edit-tags]');
  const tagSummary = query('[data-metadata-tags]');
  const commonTags = query('[data-metadata-common]');
  const differentTags = query('[data-metadata-different]');
  const actions = query('[data-metadata-actions]');
  const summary = query('[data-metadata-summary]');
  const status = query('[data-metadata-status]');
  const saveButton = query('[data-metadata-save]');
  const resetButton = query('[data-metadata-reset]');
  const fields = Object.fromEntries(Object.keys(metadataValues()).map(key => [key,form.elements.namedItem(key)]));
  const drafts = new Map();
  let current, loadingKey, generation = 0, saving = false;

  function renderTagList(container, tags) {
    container.replaceChildren();
    if (!tags.length) {
      const item = owner.createElement('li');
      item.className = 'file-explorer-metadata-empty-tag';
      item.textContent = '无';
      container.append(item);
      return;
    }
    let shown = 0;
    function appendPage() {
      const items = tags.slice(shown,shown + 40).map(label => {
        const item = owner.createElement('li');
        item.textContent = label;
        return item;
      });
      shown += items.length;
      container.append(...items);
      if (shown === tags.length) return;
      const more = owner.createElement('li');
      const button = owner.createElement('button');
      button.type = 'button';
      button.textContent = `另有 ${tags.length - shown} 个标签`;
      button.addEventListener('click',() => {
        more.remove();
        appendPage();
        container.lastElementChild.querySelector('button')?.focus({preventScroll:true});
      });
      more.append(button);
      container.append(more);
    }
    appendPage();
  }

  function renderTags(assets, single) {
    const counts = new Map();
    for (const {tags} of assets) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const labels = [...counts].sort(([left],[right]) => left.localeCompare(right,'zh-CN'));
    query('[data-metadata-common-label]').textContent = single ? '资产标签' : '共有标签';
    query('[data-metadata-different-row]').hidden = single;
    renderTagList(commonTags, labels.filter(([,count]) => count === assets.length).map(([tag]) => tag));
    renderTagList(differentTags, labels.filter(([,count]) => count < assets.length)
      .map(([tag,count]) => `${tag}（${count}/${assets.length}）`));
  }

  function setStatus(message, issue = false) {
    status.textContent = message;
    status.toggleAttribute('data-metadata-error',issue);
  }

  function updateControls() {
    const dirty = Boolean(current && drafts.has(current.key));
    const writable = current?.assets.some(asset => asset.writable) === true;
    fieldset.disabled = saving || !writable;
    for (const key of editableFields) fields[key].disabled = current?.batch || !writable;
    actions.hidden = tagFields.hidden = !writable;
    saveButton.setAttribute('aria-disabled',String(!dirty || saving));
    resetButton.setAttribute('aria-disabled',String(!dirty || saving));
    form.setAttribute('aria-busy',String(saving));
  }

  function showCurrent(message = '', issue = false) {
    const {assets,batch,total} = current;
    const asset = assets[0];
    form.hidden = !asset;
    for (const disclosure of disclosures) disclosure.update(batch ? null : asset,current.scope);
    if (!asset) {
      summary.textContent = total === 1 ? '这份文件尚未匹配到当前资产库。' : '所选文件尚未匹配到当前资产库。';
      return;
    }
    const writable = assets.filter(asset => asset.writable).length;
    summary.textContent = batch
      ? `所选 ${total} 个文件 · ${assets.length} 项已入库 · ${writable} 项可编辑`
      : (asset.collectionLabel || '已入库') + (writable ? '' : ' · 只读');
    singleFields.hidden = batch;
    tagSummary.hidden = false;
    renderTags(assets,!batch);
    const values = drafts.get(current.key)?.values ?? metadataValues(batch ? null : asset);
    for (const [key,value] of Object.entries(values)) {
      if (fields[key].value !== value) fields[key].value = value;
    }
    setStatus(message,issue);
    updateControls();
  }

  async function refresh(entries, force = false) {
    const files = entries.filter(entry => entry && !entry.isDirectory && entry.path);
    const selectedKey = JSON.stringify(files.map(entry => entry.path).sort());
    if (!force && selectedKey === loadingKey) return;
    const keepCurrent = selectedKey === loadingKey && current;
    loadingKey = selectedKey;
    const pending = ++generation;
    if (!keepCurrent) {
      current = null;
      form.hidden = true;
      for (const disclosure of disclosures) disclosure.update(null);
    }
    section.hidden = !files.length;
    section.removeAttribute('aria-busy');
    if (!files.length) return;
    section.setAttribute('aria-busy','true');
    if (!keepCurrent) summary.textContent = '正在查找对应资产…';
    try {
      const {scope,assets} = await lookup(files);
      if (pending !== generation) return;
      const records = assets.map(snapshotAsset);
      current = {
        key:JSON.stringify([scope,selectedKey,records.map(asset => asset.id).sort()]),
        scope, assets:records, batch:files.length > 1, total:files.length,
      };
      showCurrent();
    } catch (error) {
      if (pending === generation) {
        const message = '无法读取资产信息。' + errorMessage(error);
        if (current?.assets.length) setStatus(message,true);
        else summary.textContent = message;
      }
    } finally {
      if (pending === generation) section.removeAttribute('aria-busy');
    }
  }

  function hide() {
    generation++;
    loadingKey = current = null;
    section.hidden = true;
    for (const disclosure of disclosures) disclosure.update(null);
    section.removeAttribute('aria-busy');
  }

  function rememberDraft() {
    if (!current || saving) return;
    const original = drafts.get(current.key);
    const base = original?.base ?? (current.batch ? null : current.assets[0]);
    const values = Object.fromEntries(Object.entries(fields).map(([key,field]) => [key,field.value]));
    const initial = metadataValues(base);
    const changed = Object.keys(initial).some(key => values[key] !== initial[key]);
    if (changed) drafts.set(current.key,{base,values});
    else drafts.delete(current.key);
    setStatus('');
    updateControls();
  }

  function updatesFor(target, draft) {
    const {values,base} = draft;
    const add = splitTags(values.addTags);
    const remove = new Set(splitTags(values.removeTags));
    if (add.some(tag => remove.has(tag))) throw Error('同一个标签不能同时添加和移除。');
    if (add.some(tag => [...tag].length > 40)) throw Error('标签最多 40 个字符。');
    return target.assets.filter(asset => asset.writable).flatMap(asset => {
      const original = base ?? asset;
      const patch = {};
      if (!target.batch) {
        const name = values.name.trim();
        if (!name) throw Error('请填写资产展示名称。');
        const initial = metadataValues(original);
        if (name !== initial.name) patch.name = name;
        if (values.notes !== initial.notes) patch.notes = values.notes;
        if (values.workflow !== initial.workflow) patch.workflow = values.workflow;
      }
      if (add.length || remove.size) {
        const tags = [...new Set([...original.tags.filter(tag => !remove.has(tag)),...add])];
        if (tags.length > 30) throw Error('每项资产最多保留 30 个标签。');
        if (tags.length !== original.tags.length || tags.some((tag,index) => tag !== original.tags[index])) {
          patch.tags = tags;
        }
      }
      return Object.keys(patch).length ? [{id:asset.id,path:asset.path,revision:original.revision,patch}] : [];
    });
  }

  form.addEventListener('input',rememberDraft);
  resetButton.addEventListener('click',() => {
    if (!current || saving || !drafts.delete(current.key)) return;
    showCurrent('已撤销未保存的更改。');
  });
  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (!current || saving) return;
    const target = current;
    const draft = drafts.get(target.key);
    if (!draft) return;
    let updates;
    try { updates = updatesFor(target,draft); }
    catch (error) { setStatus(errorMessage(error),true); return; }
    if (!updates.length) {
      drafts.delete(target.key);
      showCurrent('资产信息没有变化。');
      return;
    }

    const focused = owner.activeElement;
    saving = true;
    updateControls();
    setStatus('正在保存资产信息…');
    try {
      const result = await save({scope:target.scope,updates});
      const records = Array.isArray(result) ? result : result?.assets ?? [];
      const errors = result?.errors ?? [];
      if (!errors.length) drafts.delete(target.key);
      if (current?.key !== target.key) return;
      const byId = new Map(records.map(asset => [asset.id,asset]));
      current.assets = current.assets.map(asset => byId.has(asset.id)
        ? snapshotAsset({...asset,...byId.get(asset.id)}) : asset);
      showCurrent(errors.length
        ? `已保存 ${records.length} 项，有 ${errors.length} 项未保存。${errorMessage(errors[0])}`
        : '资产信息已保存。',Boolean(errors.length));
    } catch (error) {
      if (current?.key === target.key) setStatus(errorMessage(error),true);
    } finally {
      saving = false;
      if (current) updateControls();
      if (current?.key === target.key && owner.activeElement === owner.body && form.contains(focused)) {
        focused.focus({preventScroll:true});
      }
    }
  });

  return {
    refresh, hide,
    hasUnsavedChanges:() => saving || drafts.size > 0,
    discardDrafts() {
      if (saving) return false;
      drafts.clear();
      if (current) showCurrent();
      return true;
    },
  };
}
