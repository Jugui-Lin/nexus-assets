const tabSelectors = '.local-explorer-tab-select, .workspace-tab-trigger';

function normalize(value) {
  return value.normalize('NFKC').toLowerCase().replaceAll('\\','/');
}

export function initWorkspaceTabOverview(bar, hasAssetView) {
  const owner = bar.ownerDocument;
  const launcher = bar.querySelector('#workspace-tab-overview-open');
  const dialog = owner.getElementById('workspace-tab-overview');
  const input = owner.getElementById('workspace-tab-overview-query');
  const results = owner.getElementById('workspace-tab-overview-results');
  const status = owner.getElementById('workspace-tab-overview-status');
  let activated = false;

  function render() {
    const terms = normalize(input.value).trim().split(/\s+/).filter(Boolean);
    const showAssets = hasAssetView();
    const records = [...bar.querySelectorAll(tabSelectors)].flatMap(tab => {
      const label = tab.dataset.tabTitle || tab.querySelector('span')?.textContent.trim();
      if (!label) return [];
      const files = tab.classList.contains('local-explorer-tab-select');
      if (!files && !showAssets) return [];
      const kind = files ? '文件夹' : '资产库';
      const path = files ? tab.title : tab.dataset.tabLocation || '';
      const keywords = normalize(`${kind} ${label} ${path}`);
      if (!terms.every(term => keywords.includes(term))) return [];
      const current = files ? bar.dataset.activeWorkspace === 'files' && tab.hasAttribute('aria-current')
        : bar.dataset.activeWorkspace === 'assets' && tab.getAttribute('aria-selected') === 'true' &&
          Boolean(tab.closest('[data-pane-focused]'));
      const row = owner.createElement('button');
      row.type = 'button';
      row.className = 'workspace-tab-overview-result';
      if (current) row.setAttribute('aria-current','page');
      row.title = path || label;
      const name = owner.createElement('span');
      name.textContent = label;
      const location = owner.createElement('small');
      const pinned = tab.parentElement.hasAttribute('data-pinned') ? ' · 已固定' : '';
      location.textContent = kind + pinned + (path && path !== label ? ' · ' + path : '');
      row.append(name,location);
      row.addEventListener('click', () => {
        if (!tab.isConnected || !bar.contains(tab)) { render(); input.focus(); return; }
        activated = true;
        dialog.close();
        tab.click();
        if (tab.isConnected) tab.focus({preventScroll:true});
      });
      return [row];
    });
    results.replaceChildren(...records);
    status.hidden = Boolean(records.length);
    status.textContent = terms.length ? '没有匹配的标签页' : '当前窗口没有打开的标签页';
  }

  function show() {
    if (bar.hidden || dialog.open || owner.querySelector('dialog[open]')) return;
    activated = false;
    input.value = '';
    render();
    dialog.showModal();
    input.focus();
  }

  launcher.hidden = false;
  launcher.addEventListener('click',show);
  input.addEventListener('input',render);
  dialog.addEventListener('close', () => {
    if (!activated) launcher.focus({preventScroll:true});
  });
  dialog.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dialog.close();
      return;
    }
    const buttons = [...results.children];
    const inResults = results.contains(event.target);
    if (event.key === 'Enter' && buttons.length && (event.target === input || inResults)) {
      event.preventDefault();
      (inResults ? event.target : buttons[0]).click();
      return;
    }
    if (event.target !== input && !inResults) return;
    if (!['ArrowDown','ArrowUp'].includes(event.key) || !buttons.length) return;
    event.preventDefault();
    const movement = event.key === 'ArrowDown' ? 1 : -1;
    const index = buttons.indexOf(event.target);
    const next = index < 0 && movement < 0 ? buttons.at(-1) : buttons[index + movement];
    (next || input).focus();
  });
  owner.defaultView.addEventListener('keydown', event => {
    if (bar.hidden || event.defaultPrevented || event.isComposing || event.altKey ||
        !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'a' ||
        owner.querySelector('dialog[open], .local-explorer-context-menu:not([hidden])')) return;
    event.preventDefault();
    if (!event.repeat) show();
  },{capture:true});
}
