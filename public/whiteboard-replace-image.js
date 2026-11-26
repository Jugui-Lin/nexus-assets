export function initWhiteboardReplaceImage({search,preview,commit}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal compact-dialog whiteboard-replace-image';
  dialog.setAttribute('aria-label','替换参考图');
  dialog.innerHTML = `<header class="modal-header"><h2>替换参考图</h2><button type="button" class="icon-button" data-replace-close aria-label="关闭">×</button></header>
    <p class="modal-description" data-replace-reference></p>
    <input type="search" class="text-field" data-replace-query placeholder="搜索当前资产库的图片…" aria-label="搜索替换图片">
    <div class="whiteboard-replace-image-choices"><ul data-replace-results aria-label="索引中的图片"></ul>
      <img data-replace-preview alt="选中的替换图片" hidden></div>
    <p data-replace-status role="status"></p>
    <div class="modal-footer"><button type="button" class="button subtle" data-replace-close>取消</button>
      <button type="button" class="button primary" data-replace-apply disabled>替换参考图</button></div>`;
  document.body.append(dialog);
  const find = selector => dialog.querySelector(selector);
  const query = find('[data-replace-query]');
  const results = find('[data-replace-results]');
  const image = find('[data-replace-preview]');
  const status = find('[data-replace-status]');
  const apply = find('[data-replace-apply]');
  let draft;
  let loadId = 0;

  function select(candidate) {
    const target = draft;
    if (!target?.current() || target.busy) return;
    const request = ++loadId;
    target.candidate = candidate;
    target.media = null;
    apply.disabled = true;
    image.hidden = true;
    image.removeAttribute('src');
    for (const button of results.querySelectorAll('button')) {
      button.setAttribute('aria-pressed',String(button.dataset.replacementAsset === candidate.id));
    }
    status.textContent = '正在读取所选参考图…';
    Promise.resolve(preview(target,candidate)).then(media => {
      if (target !== draft || request !== loadId || !target.current()) return;
      if (!media?.previewImage?.src) throw Error('这张图片暂时无法预览');
      target.media = media;
      apply.disabled = false;
      image.src = media.previewImage.src;
      image.hidden = false;
      status.textContent = '已选「' + candidate.name + '」';
    }).catch(failure => {
      if (target === draft && request === loadId && target.current()) status.textContent = String(failure?.message || failure);
    });
  }

  function render() {
    if (!draft?.current()) return;
    const candidates = search(draft.scope,query.value.trim());
    results.replaceChildren(...candidates.map(record => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.dataset.replacementAsset = record.id;
      button.disabled = record.id === draft.original;
      button.setAttribute('aria-pressed',String(record.id === draft.candidate?.id));
      button.textContent = record.name;
      button.title = record.fileName || record.name;
      button.addEventListener('click',() => select(record));
      row.append(button);
      return row;
    }));
    if (!draft.candidate) status.textContent = candidates.length ? '' : '没有匹配的图片';
  }

  function close() {
    draft = null;
    loadId++;
    image.removeAttribute('src');
    if (dialog.open) dialog.close();
  }

  function open(target) {
    if (!target.current() || dialog.open) return;
    draft = {...target};
    find('[data-replace-reference]').textContent = `替换「${target.title}」的图片，保留这张卡片的尺寸、位置和文字。`;
    query.value = '';
    image.hidden = apply.disabled = true;
    render();
    dialog.showModal();
    query.focus();
  }

  apply.addEventListener('click',async () => {
    const target = draft;
    if (!target?.media || !target.current() || target.busy) return;
    target.busy = true;
    apply.disabled = true;
    try {
      if (await commit(target,() => target === draft && dialog.open) && target === draft) close();
    } catch (failure) {
      if (target === draft) status.textContent = String(failure?.message || failure);
    } finally {
      target.busy = false;
      if (target === draft) apply.disabled = !target.media || !target.current();
    }
  });
  query.addEventListener('input',render);
  for (const button of dialog.querySelectorAll('[data-replace-close]')) button.addEventListener('click',close);
  dialog.addEventListener('close',() => { if (!dialog.open && draft) close(); });
  return {open,close,isOpen:() => dialog.open};
}
