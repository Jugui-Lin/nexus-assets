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

const failureLabels = {
  unavailable: '原件位置不可用',
  directory: '无法访问所在文件夹',
  'tab-limit': '文件夹标签页已满',
  missing: '未出现在当前文件视图',
  limited: '超出本次定位上限',
};

export function chooseAssetOriginalRetry(failures,{located,current}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal asset-original-location-failures';
  dialog.setAttribute('aria-labelledby','asset-original-failures-title');
  dialog.innerHTML = `<div class="modal-header">
    <h2 id="asset-original-failures-title">原件定位结果</h2>
    <button type="button" class="icon-button" data-original-close aria-label="关闭">×</button>
  </div>
  <p class="modal-description" data-original-description></p>
  <ul aria-label="未能定位的原件" tabindex="0"></ul>
  <p class="modal-description" data-original-status role="status"></p>
  <div class="modal-footer"><button type="button" class="button primary" data-original-retry>重试失败项</button></div>`;
  const list = dialog.querySelector('ul');
  const description = dialog.querySelector('[data-original-description]');
  description.textContent = `已定位 ${located} 个原件，${failures.length} 项需要处理。` +
    (failures.some(item => item.reason === 'tab-limit') ? '可关闭此窗口，释放标签页后从资产库重试。' : '');
  const rows = document.createDocumentFragment();
  for (const {name,path,reason} of failures) {
    const row = document.createElement('li');
    const identity = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = name;
    identity.append(title);
    if (path) {
      const location = document.createElement('small');
      location.dir = 'ltr';
      location.textContent = path;
      identity.append(location);
    }
    const status = document.createElement('small');
    status.textContent = failureLabels[reason];
    row.append(identity,status);
    rows.append(row);
  }
  list.append(rows);
  const retry = dialog.querySelector('[data-original-retry]');
  let selected = false;
  retry.addEventListener('click',() => {
    if (!current()) {
      dialog.querySelector('[data-original-status]').textContent = '资产选择或工作空间已变化，请重新定位原件。';
      return;
    }
    selected = true;
    dialog.close();
  });
  dialog.querySelector('[data-original-close]').addEventListener('click',() => dialog.close());
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close',() => { dialog.remove(); resolve(selected); },{once:true});
    dialog.showModal();
  });
}
