export function initAssetRepresentationStatus({
  panel, workspace, current, inspectOriginal, relinkOriginal, linkDirectory, retryThumbnail, reportError,
}) {
  const original = panel.querySelector('[data-asset-original-status]');
  const cover = panel.querySelector('[data-asset-cover-status]');
  const relink = panel.querySelector('[data-asset-original-relink]');
  const link = panel.querySelector('[data-asset-original-link]');
  const retry = panel.querySelector('[data-asset-cover-retry]');
  const retrying = new Set();
  let active;
  let pending;

  function show(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function originalStatus(report, id) {
    if (!Array.isArray(report?.missing) || !Array.isArray(report?.unavailable)) return '无法确认';
    if (report.missing.includes(id)) return '缺失';
    return report.unavailable.includes(id) ? '无法访问' : '可用';
  }

  function renderCover(selection) {
    const busy = retrying.has(selection.key);
    show(cover, busy ? '正在重试…' : selection.cover);
    retry.hidden = !retryThumbnail || (!busy && !selection.coverUnread);
    retry.disabled = busy;
  }

  function render() {
    const selection = current();
    if (selection?.key !== active?.key) {
      active = selection && {id:selection.id, key:selection.key, original:null};
    }
    if (!selection || !panel.checkVisibility()) return;

    renderCover(selection);
    const status = selection.original || active.original;
    relink.hidden = !relinkOriginal || selection.shared || status !== '缺失';
    link.hidden = !linkDirectory || !selection.shared || status !== '未挂载';
    if (status) {
      show(original, status);
      return;
    }
    if (!inspectOriginal) {
      show(original, '需在桌面端确认');
      return;
    }

    show(original, '正在检查…');
    if (pending) return;
    const request = pending = active;
    inspectOriginal(selection).then(report => {
      request.original = originalStatus(report, selection.id);
    }).catch(() => {
      request.original = '无法确认';
    }).finally(() => {
      pending = null;
      render();
    });
  }

  function visibleSelection() {
    const selection = current();
    return selection?.key === active?.key && panel.checkVisibility() ? selection : null;
  }

  for (const [button, action] of [[relink, relinkOriginal], [link, linkDirectory]]) {
    button.addEventListener('click', async () => {
      const selection = visibleSelection();
      if (!selection || button.hidden) return;
      try { await action(selection); }
      catch (failure) { if (visibleSelection()?.key === selection.key) reportError(failure); }
    });
  }
  retry.addEventListener('click', async () => {
    const selection = visibleSelection();
    if (!selection || retry.hidden || retry.disabled) return;
    retrying.add(selection.key);
    renderCover(selection);
    try { await retryThumbnail(selection); }
    catch (failure) { if (visibleSelection()?.key === selection.key) reportError(failure); }
    finally {
      retrying.delete(selection.key);
      render();
    }
  });

  const visibility = new MutationObserver(render);
  visibility.observe(panel, {attributeFilter:['hidden']});
  visibility.observe(workspace, {attributeFilter:['class']});
  return {
    render,
    recordOriginalCheck(ids, report) {
      const selection = current();
      if (selection && ids.includes(selection.id)) {
        active = {id:selection.id, key:selection.key, original:originalStatus(report, selection.id)};
      }
    },
    updateCover(id) {
      const selection = visibleSelection();
      if (selection?.id === id) renderCover(selection);
    },
  };
}
