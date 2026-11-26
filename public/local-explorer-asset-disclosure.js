export function initExplorerAssetDisclosure({
  before,className,title,listLabel,loading,empty,available,load,describe,run,success,
}) {
  const doc = before.ownerDocument;
  const details = doc.createElement('details');
  details.className = 'file-explorer-asset-disclosure ' + className;
  details.hidden = true;
  const summary = doc.createElement('summary');
  summary.textContent = title;
  const status = doc.createElement('p');
  status.setAttribute('role','status');
  const list = doc.createElement('ul');
  list.setAttribute('aria-label',listLabel);
  details.append(summary,status,list);
  before.before(details);
  let selection, generation = 0;

  function message(text, issue = false) {
    status.textContent = text;
    status.toggleAttribute('data-metadata-error',issue);
  }

  function showError(error) {
    message(String(error?.message || error).slice(0,240),true);
  }

  function update(record, scope) {
    const enabled = record && available(record);
    const key = enabled ? JSON.stringify([scope,record.id,record.path]) : null;
    if (key && key === selection?.key) {
      selection.record = record;
      return;
    }
    generation++;
    selection = enabled ? {key,record,scope} : null;
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
      if (request !== generation || !details.open || button.disabled) return;
      button.disabled = true;
      message('');
      try {
        const result = await run(target.record,item,target.scope);
        if (request === generation && details.open && result && success) message(success);
      } catch (error) {
        if (request === generation && details.open) showError(error);
      } finally {
        button.disabled = false;
      }
    });
    row.append(button);
    return row;
  }

  details.addEventListener('toggle',async () => {
    const request = ++generation;
    details.removeAttribute('aria-busy');
    const target = selection;
    if (!target || !details.open) return;
    details.setAttribute('aria-busy','true');
    list.replaceChildren();
    message(loading);
    try {
      const records = await load(target.record,target.scope);
      if (request !== generation || !details.open) return;
      const items = doc.createDocumentFragment();
      for (const item of records) {
        const row = makeRow(item,target,request);
        if (row) items.append(row);
      }
      message(items.childElementCount ? '' : empty);
      list.append(items);
    } catch (error) {
      if (request === generation && details.open) showError(error);
    } finally {
      if (request === generation) details.removeAttribute('aria-busy');
    }
  });

  return {update};
}
