export function chooseAssetOriginalLocations(groups,{unavailable,current}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal asset-original-locations';
  dialog.setAttribute('aria-labelledby','asset-original-locations-title');
  dialog.innerHTML = `<div class="modal-header">
    <h2 id="asset-original-locations-title">定位原件</h2>
    <button type="button" class="icon-button" data-original-close aria-label="关闭">×</button>
  </div>
  <p class="modal-description" data-original-description></p>
  <ul data-original-groups aria-label="原件所在文件夹"></ul>
  <p class="modal-description" data-original-status role="status"></p>
  <div class="modal-footer"><button type="button" class="button primary" data-original-open-all>打开全部文件夹</button></div>`;
  const find = selector => dialog.querySelector(selector);
  const list = find('[data-original-groups]');
  const status = find('[data-original-status]');
  const all = find('[data-original-open-all]');
  find('[data-original-description]').textContent = `所选原件分布在 ${groups.length} 个文件夹。` +
    (unavailable ? `另有 ${unavailable} 项原件不可用。` : '');
  let selected = null;
  function accept(selection) {
    if (!current()) {
      status.textContent = '资产选择或原件位置已变化，请重新打开。';
      return;
    }
    selected = selection;
    dialog.close();
  }
  for (const group of groups) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.dir = 'ltr';
    label.textContent = group.directory;
    label.title = group.directory;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button subtle';
    button.setAttribute('data-original-open-folder','');
    button.setAttribute('aria-label',`定位 ${group.paths.length} 个原件，${group.directory}`);
    button.textContent = `定位 ${group.paths.length} 个原件`;
    button.addEventListener('click',() => accept([group]));
    row.append(label,button);
    list.append(row);
  }
  all.addEventListener('click',() => accept(groups));
  find('[data-original-close]').addEventListener('click',() => dialog.close());
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close',() => { dialog.remove(); resolve(selected); },{once:true});
    dialog.showModal();
    list.querySelector('button')?.focus();
  });
}
