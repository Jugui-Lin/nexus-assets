export function initExplorerAssetDisclosure({
  before,className,title,listLabel,loading,empty,available,load,describe,run,success,primaryAction,
}) {
  const doc = before.ownerDocument;
  const details = doc.createElement('details');
  details.className = 'file-explorer-asset-disclosure ' + className;
  details.hidden = true;
  const summary = doc.createElement('summary');
  summary.textContent = title;
  details.append(summary);
  const action = primaryAction && doc.createElement('button');
  if (action) {
    action.type = 'button';
    action.textContent = primaryAction.label;
    action.setAttribute(primaryAction.attribute,'');
    action.hidden = true;
    details.append(action);
  }
  const status = doc.createElement('p');
  status.setAttribute('role','status');
  const list = doc.createElement('ul');
  list.setAttribute('aria-label',listLabel);
  details.append(status,list);
  before.before(details);
  let selection, generation = 0, actionTarget;

  function message(text, issue = false) {
    status.textContent = text;
    status.toggleAttribute('data-metadata-error',issue);
  }

  function showError(error) {
    message(String(error?.message || error).slice(0,240),true);
  }

  function updateAction() {
    if (!action) return;
    action.hidden = !selection || !primaryAction.available(selection.record);
    action.disabled = Boolean(selection && actionTarget === selection);
  }

  function update(record, scope) {
    const enabled = record && available(record);
    const key = enabled ? JSON.stringify([scope,record.id,record.path]) : null;
    if (key && key === selection?.key) {
      selection.record = record;
      updateAction();
      return;
    }
    generation++;
    selection = enabled ? {key,record,scope} : null;
    updateAction();
    details.open = false;
    details.hidden = !enabled;
    details.removeAttribute('aria-busy');
    list.replaceChildren();
    message('');
  }

  function makeRow(item, target, request) {
    const content = describe(item);
    if (!content) return null;
    const row = doc.createElement('li');
    const description = doc.createElement('div');
    for (const [tag,text] of [['strong',content.title],['span',content.note],['small',content.caption]]) {
      if (!text) continue;
      const label = doc.createElement(tag);
      label.textContent = text;
      description.append(label);
    }
    row.append(description);
    if (!run) return row;
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = content.action;
    button.setAttribute('aria-label',content.actionLabel);
    button.addEventListener('click',async () => {
      const stillRequested = () => request === generation && details.open;
      if (!stillRequested() || button.disabled) return;
      button.disabled = true;
      message('');
      try {
        const result = await run(target.record,item,target.scope,stillRequested);
        if (stillRequested() && result && success) message(success);
      } catch (error) {
        if (stillRequested()) showError(error);
      } finally {
        button.disabled = false;
      }
    });
    row.append(button);
    return row;
  }

  async function reload(confirmation = '') {
    const request = ++generation;
    details.removeAttribute('aria-busy');
    const target = selection;
    if (!target || !details.open) return;
    details.setAttribute('aria-busy','true');
    list.replaceChildren();
    message(loading);
    try {
      const stillRequested = () => request === generation && details.open;
      const loaded = await load(target.record,target.scope,stillRequested);
      if (!stillRequested()) return;
      const {records,note} = Array.isArray(loaded) ? {records:loaded} : loaded;
      const items = doc.createDocumentFragment();
      for (const item of records) {
        const row = makeRow(item,target,request);
        if (row) items.append(row);
      }
      message(confirmation || note || (items.childElementCount ? '' : empty));
      list.append(items);
    } catch (error) {
      if (request === generation && details.open) showError(error);
    } finally {
      if (request === generation) details.removeAttribute('aria-busy');
    }
  }

  details.addEventListener('toggle',() => void reload());
  action?.addEventListener('click',async () => {
    const target = selection;
    if (!target || !details.open || action.hidden || action.disabled) return;
    actionTarget = target;
    updateAction();
    try {
      if (await primaryAction.run(target.record,target.scope) && selection === target && details.open)
        await reload(primaryAction.success);
    } catch (error) {
      if (selection === target && details.open) showError(error);
    } finally {
      if (actionTarget === target) actionTarget = null;
      updateAction();
      if (selection === target && details.open && !action.hidden && doc.activeElement === doc.body)
        action.focus({preventScroll:true});
    }
  });

  return {update};
}
