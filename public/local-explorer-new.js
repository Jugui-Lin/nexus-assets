const folder = {kind:'folder',label:'文件夹',icon:'folder',extension:''};
const shortcut = {kind:'shortcut',label:'快捷方式',icon:'link',extension:'.lnk'};
const invalidName = /[<>:"/\\|?*\u0000-\u001f]/;
const reservedName = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function fileName(value,item) {
  const name = value.trim();
  if (!name && item.kind === 'folder') return '';
  if (!name || name === '.' || name === '..' || name.endsWith('.') || invalidName.test(name) || reservedName.test(name))
    throw Error('请输入有效的名称。');
  if (!item.extension || name.toLowerCase().endsWith(item.extension.toLowerCase())) return name;
  if (name.lastIndexOf('.') > 0) throw Error('文件扩展名应为 ' + item.extension + '。');
  return name + item.extension;
}

function templateItems(items) {
  const byExtension = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.id !== 'string' || !item.id || item.id === 'shortcut' ||
        typeof item.label !== 'string' || !item.label || typeof item.extension !== 'string' ||
        !/^\.[^.\\/]+$/.test(item.extension)) continue;
    const extension = item.extension.toLowerCase();
    if (extension !== '.lnk' && (item.id === 'text' || !byExtension.has(extension)))
      byExtension.set(extension,{...item,kind:'template',icon:'notes'});
  }
  return [...byExtension.values()];
}

export function initExplorerNew({root,explorer,listTemplates,create,createFolder,supportsShortcut = Boolean(create),report}) {
  const menu = root?.querySelector('#file-workspace-new-menu');
  const summary = menu?.querySelector('summary');
  const itemsHost = menu?.querySelector('#file-workspace-new-items');
  if (!summary || !itemsHost) return {update() {}};
  const owner = root.ownerDocument;
  const staticItems = [...(createFolder ? [folder] : []),...(create && supportsShortcut ? [shortcut] : [])];
  let menuDirectory;
  let menuRevision = 0;
  let writing = false;

  function node(tag,className,text) {
    const element = owner.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    if (tag === 'button') element.type = 'button';
    return element;
  }

  function svg(icon) {
    const image = owner.createElementNS('http://www.w3.org/2000/svg','svg');
    image.setAttribute('aria-hidden','true');
    const use = owner.createElementNS(image.namespaceURI,'use');
    use.setAttribute('href','#i-' + icon);
    image.append(use);
    return image;
  }

  function directory() {
    const current = explorer.getFileActionDirectory || explorer.getCurrentDirectory;
    return !root.hidden && !writing && current?.() || null;
  }

  function update() {
    const path = directory();
    const available = Boolean(path && (staticItems.length || (create && listTemplates)));
    summary.setAttribute('aria-disabled',String(!available));
    summary.tabIndex = available ? 0 : -1;
    if (!available || (menuDirectory && path !== menuDirectory)) menu.open = false;
  }

  function field(label,value,options = {}) {
    const element = node('label','field-label',label);
    const input = node('input','text-field');
    input.type = 'text';
    input.value = value;
    input.autocomplete = 'off';
    input.spellcheck = false;
    Object.assign(input,options);
    element.append(input);
    return {element,input};
  }

  function showDialog(item,path) {
    if (path !== directory() || owner.querySelector('dialog[open]')) return;
    menu.open = false;
    const dialog = node('dialog','modal compact-dialog local-explorer-new-dialog');
    const titleText = '新建' + item.label;
    dialog.setAttribute('aria-label',titleText);
    const header = node('div','modal-header');
    const close = node('button','icon-button close-modal');
    close.setAttribute('aria-label','关闭');
    close.append(svg('close'));
    header.append(node('h2','',titleText),close);
    const form = node('form');
    const target = item.kind === 'shortcut' ? field('目标位置','',{
      placeholder:'输入文件或文件夹路径',maxLength:8192,required:true,
    }) : null;
    const defaultName = titleText + item.extension;
    const name = field(item.kind === 'folder' ? '文件夹名称' : '文件名',item.kind === 'folder' ? '' : defaultName,{
      maxLength:255,required:item.kind !== 'folder',placeholder:defaultName,
    });
    const error = node('p','local-explorer-new-error');
    error.setAttribute('role','alert');
    error.hidden = true;
    const footer = node('div','modal-footer');
    const cancel = node('button','button subtle','取消');
    const submit = node('button','button primary','创建');
    submit.type = 'submit';
    footer.append(cancel,submit);
    if (target) form.append(target.element);
    form.append(name.element,error,footer);
    dialog.append(header,form);
    root.append(dialog);

    const closeDialog = () => { if (!writing) dialog.close(); };
    close.addEventListener('click',closeDialog);
    cancel.addEventListener('click',closeDialog);
    dialog.addEventListener('cancel',event => { if (writing) event.preventDefault(); });
    dialog.addEventListener('close',() => {
      dialog.remove();
      if (directory()) summary.focus({preventScroll:true});
    },{once:true});
    form.addEventListener('input',() => { error.hidden = true; });
    form.addEventListener('submit',async event => {
      event.preventDefault();
      if (writing) return;
      const controls = [close,cancel,submit,name.input,...(target ? [target.input] : [])];
      let result;
      let nameText;
      try {
        if (path !== directory()) throw Error('当前文件夹已切换，请重新打开新建菜单。');
        nameText = fileName(name.input.value,item);
        const targetPath = target?.input.value.trim();
        if (target && !targetPath) throw Error('请输入快捷方式的目标位置。');
        writing = true;
        controls.forEach(control => { control.disabled = true; });
        update();
        result = item.kind === 'folder' ? await createFolder({directory:path,name:nameText || undefined}) :
          await create({directory:path,kind:item.kind,templateId:item.id,name:nameText,target:targetPath});
      } catch (failure) {
        error.textContent = String(failure?.message || failure);
        error.hidden = false;
        return;
      } finally {
        writing = false;
        controls.forEach(control => { control.disabled = false; });
        update();
      }
      dialog.close();
      if (explorer.refreshAfterTransfer) explorer.refreshAfterTransfer({directoryPath:path});
      else if (directory() === path) explorer.refresh();
      const createdName = typeof result === 'string' ? result.split(/[\\/]/).at(-1) : nameText;
      report?.('已创建 ' + (createdName || item.label));
    });

    dialog.showModal();
    if (target) target.input.focus();
    else {
      name.input.focus();
      name.input.setSelectionRange(0,defaultName.length - item.extension.length);
    }
  }

  function render(items,path,notice = '') {
    const focus = itemsHost.contains(owner.activeElement) ? owner.activeElement.dataset : null;
    const buttons = items.map(item => {
      const button = node('button','local-explorer-new-item');
      button.dataset.fileNewKind = item.kind;
      if (item.id) button.dataset.fileNewTemplate = item.id;
      button.append(svg(item.icon),node('span','',item.label));
      button.addEventListener('click',() => showDialog(item,path));
      return button;
    });
    itemsHost.replaceChildren(...buttons);
    if (notice) {
      const status = node('p','local-explorer-new-status',notice);
      status.setAttribute('role','status');
      itemsHost.append(status);
    }
    if (focus) buttons.find(button => button.dataset.fileNewKind === focus.fileNewKind &&
      button.dataset.fileNewTemplate === focus.fileNewTemplate)?.focus({preventScroll:true});
  }

  async function loadItems() {
    const revision = ++menuRevision;
    const path = directory();
    menuDirectory = menu.open ? path : null;
    if (!menu.open) return;
    if (!path) { update(); return; }
    const includesTemplates = create && listTemplates;
    render(staticItems,path,includesTemplates ? '正在读取文件类型…' : '');
    if (!includesTemplates) return;
    try {
      const items = await listTemplates();
      if (!menu.open || revision !== menuRevision || path !== directory()) return;
      render([...staticItems,...templateItems(items)],path);
    } catch {
      if (menu.open && revision === menuRevision && path === directory()) render(staticItems,path,'暂时无法读取文件类型。');
    }
  }

  summary.addEventListener('click',event => {
    update();
    if (summary.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });
  menu.addEventListener('toggle',loadItems);
  menu.addEventListener('keydown',event => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    menu.open = false;
    summary.focus({preventScroll:true});
  });
  owner.addEventListener('pointerdown',event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  const observer = new owner.defaultView.MutationObserver(update);
  observer.observe(root,{attributes:true,attributeFilter:['hidden','class']});
  const listing = root.querySelector('.local-explorer-listing');
  if (listing) observer.observe(listing,{attributes:true,attributeFilter:['aria-busy']});
  update();
  return {update};
}
