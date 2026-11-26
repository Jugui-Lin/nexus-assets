export function initExrChannelViewer({api}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal exr-channel-dialog';
  dialog.setAttribute('aria-labelledby','exr-channel-title');
  dialog.innerHTML = `
    <div class="modal-header"><h2 id="exr-channel-title">EXR 通道对照</h2><button type="button" class="icon-button" data-close aria-label="关闭"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <p class="modal-description" data-exr-file></p>
    <p data-exr-status role="status"></p>
    <div class="exr-channel-comparison" data-exr-panes hidden></div>
    <p class="modal-description" data-exr-note hidden>RGB 使用显示色彩转换，超出常规范围的单通道按本帧范围拉伸。</p>`;
  document.body.append(dialog);
  const sourceLabel = dialog.querySelector('[data-exr-file]');
  const body = dialog.querySelector('[data-exr-panes]');
  const note = dialog.querySelector('[data-exr-note]');
  const status = dialog.querySelector('[data-exr-status]');
  let current;
  const active = draft => dialog.open && current === draft;

  const panes = ['左侧','右侧'].map(side => {
    const pane = document.createElement('section');
    pane.className = 'exr-channel-pane';
    const label = document.createElement('label');
    label.textContent = side + '通道';
    const select = document.createElement('select');
    label.append(select);
    const stage = document.createElement('div');
    stage.className = 'exr-channel-stage';
    const image = document.createElement('img');
    image.hidden = true;
    image.draggable = false;
    const message = document.createElement('p');
    message.setAttribute('role','status');
    stage.append(image,message);
    const details = document.createElement('p');
    details.className = 'exr-channel-details';
    pane.append(label,stage,details);
    body.append(pane);
    const view = {select,image,message,details,request:0,reading:null};
    select.addEventListener('change',() => { if (current) void preview(current,view); });
    return view;
  });

  async function preview(draft,pane) {
    const view = draft.views.find(view => view.key === pane.select.value);
    if (!view || !active(draft)) return;
    const request = ++pane.request;
    pane.image.hidden = true;
    pane.image.removeAttribute('src');
    pane.details.textContent = `${view.width} × ${view.height} · ${view.channels.join(' / ')}`;
    pane.message.textContent = '正在读取通道…';
    try {
      if (pane.reading) await pane.reading.catch(() => {});
      if (!active(draft) || pane.request !== request) return;
      const reading = api('read_exr_channel_view',{...draft.source,choice:view.key,revision:draft.revision});
      pane.reading = reading;
      let result;
      try { result = await reading; }
      finally { if (pane.reading === reading) pane.reading = null; }
      if (!active(draft) || pane.request !== request) return;
      if (!result?.url) throw Error('此通道无法显示');
      pane.image.alt = view.label;
      pane.image.src = result.url;
      pane.image.hidden = false;
      pane.message.textContent = '';
    } catch (failure) {
      if (active(draft) && pane.request === request) pane.message.textContent = String(failure?.message || failure);
    }
  }

  async function show({id,path,name}) {
    if (dialog.open) return;
    const draft = {source:id ? {id} : {path},views:[],revision:null};
    current = draft;
    sourceLabel.textContent = name || path?.split(/[\\/]/).at(-1) || '';
    status.textContent = '正在读取 EXR 通道…';
    body.hidden = note.hidden = true;
    dialog.showModal();
    try {
      const result = await api('read_exr_channel_view',draft.source);
      if (!active(draft)) return;
      if (!result?.views?.length || !result.revision) throw Error('未找到可预览的 EXR 通道');
      draft.views = result.views;
      draft.revision = result.revision;
      const left = draft.views.find(view => /^beauty\b/i.test(view.label) && view.channels.length === 3)
        || draft.views.find(view => view.channels.length === 3) || draft.views[0];
      const right = draft.views.find(view => view !== left && /reflect|shadow|depth|\bz\b/i.test(view.label))
        || draft.views.find(view => view !== left) || left;
      for (const [index,pane] of panes.entries()) {
        pane.select.replaceChildren(...draft.views.map(view => new Option(view.label,view.key)));
        pane.select.value = (index ? right : left).key;
      }
      status.textContent = '';
      body.hidden = note.hidden = false;
      for (const pane of panes) void preview(draft,pane);
    } catch (failure) {
      if (active(draft)) status.textContent = String(failure?.message || failure);
    }
  }

  dialog.querySelector('[data-close]').addEventListener('click',() => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    current = null;
    for (const pane of panes) {
      pane.request++;
      pane.image.removeAttribute('src');
      pane.image.hidden = true;
    }
  });
  return {show};
}
