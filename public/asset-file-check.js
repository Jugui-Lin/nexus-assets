export function initAssetFileCheck({summary, dialog, group, changeFilter, closeReport, retry, onError}) {
  const checked = summary.querySelector('[data-file-check-count]');
  const filters = [...summary.querySelectorAll('[data-file-check-filter]')];
  const open = summary.querySelector('[data-file-check-open]');
  const folders = dialog.querySelector('[data-file-check-folders]');
  const outcome = dialog.querySelector('[data-file-check-outcome]');
  const folderOrder = new Intl.Collator('zh-CN', {numeric:true});
  const counts = issues => issues.reduce((result,{status}) => {
    result[status]++;
    return result;
  }, {missing:0, unavailable:0});
  const labels = {missing:'只看缺失', unavailable:'只看无法访问'};

  function render({report, checkedCount = 0, issues = [], filter = '', busy = false}) {
    summary.hidden = !report;
    if (!report) {
      if (dialog.open) dialog.close();
      return;
    }
    const totals = counts(issues);
    checked.textContent = '已检查 ' + checkedCount + ' 项';
    for (const button of filters) {
      const status = button.dataset.fileCheckFilter;
      button.textContent = labels[status] + ' ' + totals[status];
      button.setAttribute('aria-pressed', String(filter === status));
      button.disabled = !totals[status] && filter !== status;
    }
    open.disabled = !issues.length || busy;
    if (!dialog.open) return;
    outcome.textContent = busy ? '正在检查此目录的失败项…'
      : issues.length ? '仍有 ' + issues.length + ' 项原件需要处理' : '本次检查的问题已全部处理';
    const statusById = new Map(issues.map(({asset,status}) => [asset.id,status]));
    const focus = document.activeElement?.dataset.fileCheckDirectory;
    const grouped = [...group(issues.map(issue => issue.asset)).values()];
    grouped.sort((a,b) => folderOrder.compare(a.title,b.title));
    const rows = grouped.map(({key,title,items}) => {
      const row = document.createElement('li');
      const info = document.createElement('div');
      const heading = document.createElement('strong');
      const detail = document.createElement('small');
      const button = document.createElement('button');
      const ids = items.map(item => item.id);
      const {missing, unavailable} = counts(ids.map(id => ({status:statusById.get(id)})));
      heading.textContent = title;
      heading.title = title;
      detail.textContent = [missing && missing + ' 项缺失', unavailable && unavailable + ' 项无法访问'].filter(Boolean).join(' · ');
      info.append(heading,detail);
      button.type = 'button';
      button.className = 'button subtle';
      button.textContent = '重试失败项';
      button.dataset.fileCheckDirectory = key;
      button.disabled = busy;
      button.setAttribute('aria-label', '重试 ' + title + ' 的失败项');
      button.addEventListener('click', () => retry(ids).catch(onError));
      row.append(info,button);
      return row;
    });
    folders.replaceChildren(...rows);
    if (focus !== undefined) {
      const button = [...folders.querySelectorAll('button')].find(button => button.dataset.fileCheckDirectory === focus);
      (button && !button.disabled ? button : dialog.querySelector('[data-file-check-dialog-close]')).focus({preventScroll:true});
    }
  }

  for (const button of filters) {
    button.addEventListener('click', () => changeFilter(
      button.getAttribute('aria-pressed') === 'true' ? '' : button.dataset.fileCheckFilter));
  }
  summary.querySelector('[data-file-check-dismiss]').addEventListener('click', closeReport);
  dialog.querySelector('[data-file-check-dialog-close]').addEventListener('click', () => dialog.close());
  return {
    render,
    onOpen(listener) { open.addEventListener('click', listener); },
  };
}
