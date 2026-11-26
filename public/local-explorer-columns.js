const storageKey = 'nexus-file-columns-v1';
const columns = [
  {id:'name',label:'名称',size:260,sort:'name'},
  {id:'date',label:'修改日期',size:154,sort:'date'},
  {id:'type',label:'类型',size:102,sort:'type'},
  {id:'size',label:'大小',size:96,sort:'size'},
  {id:'created',label:'创建日期',size:154,sort:'created'},
  {id:'author',label:'作者',size:150,property:true},
  {id:'tags',label:'标记',size:170,property:true},
  {id:'title',label:'标题',size:180,property:true},
  {id:'extension',label:'扩展名',size:90},
  {id:'path',label:'完整路径',size:300},
  {id:'dimensions',label:'尺寸',size:104,property:true},
  {id:'duration',label:'长度',size:104,property:true},
  {id:'attributes',label:'属性',size:96,property:true},
  {id:'copyright',label:'版权',size:170,property:true},
  {id:'subject',label:'主题',size:160,property:true},
  {id:'comments',label:'备注',size:180,property:true},
  {id:'company',label:'公司',size:150,property:true},
  {id:'fileVersion',label:'文件版本',size:125,property:true},
  {id:'owner',label:'所有者',size:160,property:true},
  {id:'dateTaken',label:'拍摄日期',size:154,property:true},
  {id:'assetStatus',label:'入库状态',size:110,asset:true},
  {id:'assetTags',label:'资产标签',size:192,asset:true},
  {id:'assetRating',label:'资产评分',size:104,asset:true},
  {id:'assetWorkflow',label:'工作流状态',size:124,asset:true},
  {id:'assetLibrary',label:'所属资产库',size:154,asset:true},
];
const quickColumns = ['name','date','type','size','created','author','tags','title','assetStatus'];
const defaults = ['name','date','type','size'];
const assetWorkflow = {wip:'制作中',review:'待审核',approved:'已审核',archived:'已归档'};
const minWidth = 64;
const maxWidth = 1200;

function preferences(definitions) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved?.visible)) {
      const visible = definitions.filter(col => col.id === 'name' || saved.visible.includes(col.id)).map(col => col.id);
      const widths = Object.fromEntries(definitions.flatMap(({id}) => {
        const width = saved.widths?.[id];
        return Number.isFinite(width) && width >= minWidth && width <= maxWidth ? [[id,width]] : [];
      }));
      return {visible,widths};
    }
  } catch {}
  return {visible:[...defaults],widths:{}};
}

function extension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

export function initExplorerColumns({table,onSort,formatters,onChange,showProperties = false,showAssets = false}) {
  const definitions = columns.filter(col => (!col.property || showProperties) && (!col.asset || showAssets));
  const {dateText,sizeText,fileType} = formatters;
  const values = {
    date: entry => dateText(entry.modified),
    type: fileType,
    size: entry => sizeText(entry.size),
    created: entry => dateText(entry.created),
    extension: entry => (!entry.isDirectory && extension(entry.name)) || '—',
    path: entry => entry.path,
  };
  const owner = table.ownerDocument;
  const panel = table.closest('.local-explorer');
  const trigger = panel.querySelector('[data-explorer-column-options]');
  const colgroup = table.querySelector('colgroup');
  const header = table.tHead.rows[0];
  const menu = owner.createElement('div');
  menu.className = 'local-explorer-columns-menu';
  menu.setAttribute('role','group');
  menu.setAttribute('aria-label','详细信息列');
  menu.hidden = true;
  panel.append(menu);
  const prefs = preferences(definitions);
  const visibleColumns = () => definitions.filter(({id}) => prefs.visible.includes(id));
  let sorting;
  let resize;
  let menuAnchor;

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch {}
  }

  function assignWidth(id,width) {
    prefs.widths[id] = Math.min(maxWidth,Math.max(minWidth,Math.round(width)));
    updateWidths();
  }

  function fitColumns(ids) {
    const context = owner.createElement('canvas').getContext('2d');
    if (!context) return;
    const style = node => owner.defaultView.getComputedStyle(node);
    const textWidth = node => {
      context.font = style(node).font;
      return context.measureText(node.textContent).width;
    };
    const horizontalPadding = node => {
      const css = style(node);
      return parseFloat(css.paddingInlineStart) + parseFloat(css.paddingInlineEnd);
    };
    for (const id of ids) {
      const index = visibleColumns().findIndex(col => col.id === id);
      if (index < 0) continue;
      const th = header.cells[index];
      let width = textWidth(th.firstElementChild) + horizontalPadding(th) + 26;
      for (const row of table.tBodies[0].querySelectorAll('tr[data-entry-index]')) {
        const cell = row.cells[index];
        const label = id === 'name' ? cell.querySelector('.local-explorer-entry-name') : cell;
        if (!label) continue;
        const decoration = id === 'name' ? 36 : 0;
        width = Math.max(width,textWidth(label) + horizontalPadding(cell) + decoration + 8);
      }
      prefs.widths[id] = Math.min(maxWidth,Math.max(minWidth,Math.ceil(width)));
    }
    updateWidths();
    persist();
  }

  function updateWidths() {
    const cols = visibleColumns();
    let total = 0;
    for (const [index,col] of cols.entries()) {
      const width = prefs.widths[col.id] ?? col.size;
      colgroup.children[index].style.inlineSize = col.id === 'name' && !prefs.widths.name ? '' : width + 'px';
      total += width;
    }
    table.style.inlineSize = prefs.widths.name ? total + 'px' : '';
    table.style.minInlineSize = String(total) + 'px';
  }

  function setSort(state) {
    sorting = state;
    const show = !table.hidden && !table.classList.contains('local-explorer-grid');
    trigger.hidden = !show;
    if (!show) closeMenu();
    for (const th of header.cells) {
      const key = th.dataset.columnSort;
      if (key && key === state.sortBy) th.setAttribute('aria-sort',state.descending ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
    }
  }

  function renderHeader() {
    const cols = visibleColumns();
    colgroup.replaceChildren(...cols.map(() => owner.createElement('col')));
    header.replaceChildren(...cols.map(col => {
      const th = owner.createElement('th');
      th.scope = 'col';
      th.dataset.explorerColumnKey = col.id;
      const label = owner.createElement(col.sort ? 'button' : 'span');
      label.className = 'local-explorer-column-label';
      label.textContent = col.label;
      if (col.sort) {
        th.dataset.columnSort = col.sort;
        label.type = 'button';
        label.addEventListener('click',() => onSort({
          sortBy:col.sort,descending:sorting?.sortBy === col.sort ? !sorting.descending : false,
        }));
      }
      const grip = owner.createElement('button');
      grip.type = 'button';
      grip.className = 'local-explorer-column-grip';
      grip.title = '拖动调整' + col.label + '列宽';
      grip.setAttribute('aria-label',grip.title);
      grip.addEventListener('pointerdown',event => {
        if (event.button !== 0) return;
        event.preventDefault();
        resize = {id:col.id,pointer:event.pointerId,x:event.clientX,width:th.getBoundingClientRect().width};
        table.toggleAttribute('data-column-resizing',true);
      });
      grip.addEventListener('keydown',event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        assignWidth(col.id,th.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 12 : -12));
        persist();
      });
      grip.addEventListener('dblclick',() => {
        fitColumns([col.id]);
      });
      th.append(label,grip);
      return th;
    }));
    table.setAttribute('data-explorer-custom-columns','');
    updateWidths();
    if (sorting) setSort(sorting);
  }

  function finishResize() {
    if (!resize) return;
    resize = null;
    table.removeAttribute('data-column-resizing');
    persist();
  }

  owner.addEventListener('pointermove',event => {
    if (resize?.pointer !== event.pointerId) return;
    if (event.buttons & 1) assignWidth(resize.id,resize.width + event.clientX - resize.x);
    else finishResize();
  },true);
  for (const type of ['pointerup','pointercancel']) owner.addEventListener(type,event => {
    if (resize?.pointer === event.pointerId) finishResize();
  },true);
  owner.defaultView.addEventListener('blur',finishResize);

  function appendCells(row,entry,nameCell) {
    for (const col of visibleColumns()) {
      const cell = col.id === 'name' ? nameCell : owner.createElement('td');
      cell.dataset.explorerColumnKey = col.id;
      if (col.id !== 'name') {
        cell.textContent = values[col.id]?.(entry) ?? '—';
        if (col.id === 'path' || col.property) cell.title = cell.textContent;
      }
      row.append(cell);
    }
  }

  function updateDetails(row,details) {
    for (const [id,value] of Object.entries(details)) {
      if (typeof value !== 'string' || !value) continue;
      const cell = [...row.cells].find(item => item.dataset.explorerColumnKey === id);
      if (!cell) continue;
      cell.textContent = id === 'created' ? dateText(Number(value)) : value;
      cell.title = cell.textContent;
    }
  }

  function updateAssetDetails(row,asset) {
    const values = {
      assetStatus:asset ? (asset.favorite ? '已入库 · 已收藏' : '已入库') : asset === null ? '未入库' : '',
      assetTags:Array.isArray(asset?.tags) ? asset.tags.join('、') : '',
      assetRating:asset?.rating > 0 ? asset.rating + ' / 5' : '',
      assetWorkflow:assetWorkflow[asset?.workflow],
      assetLibrary:asset?.library,
    };
    for (const cell of row.cells) {
      const key = cell.dataset.explorerColumnKey;
      if (!Object.hasOwn(values,key)) continue;
      cell.textContent = values[key] || '—';
      cell.title = values[key] || '';
    }
  }

  function closeMenu(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded','false');
    if (restoreFocus) (menuAnchor?.isConnected ? menuAnchor : trigger).focus({preventScroll:true});
  }

  function checkboxOption(col,checked,onChangeChecked) {
    const label = owner.createElement('label');
    label.className = 'local-explorer-column-option';
    const checkbox = owner.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = col.id;
    checkbox.checked = checked;
    checkbox.disabled = col.id === 'name';
    if (onChangeChecked) checkbox.addEventListener('change',() => onChangeChecked(checkbox.checked));
    label.append(checkbox,col.label);
    return label;
  }

  function openMoreColumns() {
    closeMenu();
    const dialog = owner.createElement('dialog');
    dialog.className = 'modal compact-dialog local-explorer-columns-dialog';
    dialog.setAttribute('aria-label','选择详细信息');
    const form = owner.createElement('form');
    form.method = 'dialog';
    const heading = owner.createElement('h2');
    heading.textContent = '选择详细信息';
    const list = owner.createElement('div');
    list.className = 'local-explorer-columns-dialog-list';
    list.append(...definitions.map(col => checkboxOption(col,prefs.visible.includes(col.id))));
    const footer = owner.createElement('div');
    footer.className = 'modal-footer';
    const reset = owner.createElement('button');
    reset.type = 'button';
    reset.className = 'button subtle';
    reset.textContent = '恢复默认列';
    let resetWidths = false;
    reset.addEventListener('click',() => {
      for (const input of list.querySelectorAll('input')) input.checked = defaults.includes(input.value);
      resetWidths = true;
    });
    for (const [value,text,className] of [['cancel','取消','subtle'],['save','确定','primary']]) {
      const button = owner.createElement('button');
      button.type = 'submit';
      button.value = value;
      button.className = 'button ' + className;
      button.textContent = text;
      footer.append(button);
    }
    footer.prepend(reset);
    form.append(heading,list,footer);
    dialog.append(form);
    dialog.addEventListener('close',() => {
      if (dialog.returnValue === 'save') {
        const nextVisible = [...list.querySelectorAll('input:checked')].map(input => input.value);
        const addedAssetColumn = definitions.some(col => col.asset && nextVisible.includes(col.id) && !prefs.visible.includes(col.id));
        prefs.visible = nextVisible;
        if (resetWidths) prefs.widths = {};
        persist();
        renderHeader();
        onChange(addedAssetColumn);
      }
      dialog.remove();
      (menuAnchor?.isConnected ? menuAnchor : trigger).focus({preventScroll:true});
    },{once:true});
    panel.append(dialog);
    dialog.showModal();
    list.querySelector('input:not(:disabled)')?.focus({preventScroll:true});
  }

  function menuCommand(label,run,disabled = false) {
    const button = owner.createElement('button');
    button.type = 'button';
    button.className = 'local-explorer-column-menu-command';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click',run);
    return button;
  }

  function separator() {
    const line = owner.createElement('hr');
    line.setAttribute('role','separator');
    return line;
  }

  function openMenu(x,y,th = null) {
    const key = th?.dataset.explorerColumnKey;
    menuAnchor = th?.querySelector('button') || trigger;
    const options = definitions.filter(col => quickColumns.includes(col.id)).map(col =>
      checkboxOption(col,prefs.visible.includes(col.id),checked => {
        prefs.visible = checked ? [...prefs.visible,col.id] : prefs.visible.filter(id => id !== col.id);
        persist();
        renderHeader();
        onChange(Boolean(col.asset && checked));
      }));
    menu.replaceChildren(
      menuCommand('调整此列宽度以适应内容',() => { fitColumns([key]); closeMenu(true); },!key),
      menuCommand('调整所有列宽度以适应内容',() => {
        fitColumns(visibleColumns().map(col => col.id));
        closeMenu(true);
      }),
      separator(),...options,separator(),menuCommand('其他…',openMoreColumns),
    );
    menu.hidden = false;
    trigger.setAttribute('aria-expanded','true');
    menu.style.left = Math.max(4,Math.min(x,owner.defaultView.innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4,Math.min(y,owner.defaultView.innerHeight - menu.offsetHeight - 4)) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }

  trigger.addEventListener('click',() => {
    if (!menu.hidden) { closeMenu(); return; }
    const rect = trigger.getBoundingClientRect();
    openMenu(rect.left,rect.bottom+4);
  });
  header.addEventListener('contextmenu',event => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(event.clientX,event.clientY,event.target.closest('th'));
  });
  owner.addEventListener('pointerdown',event => {
    if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
  });
  menu.addEventListener('keydown',event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeMenu(true);
  });
  renderHeader();
  return {
    appendCells,updateDetails,updateAssetDetails,setSort,
    openHeaderMenu(target) {
      const th = target.closest('th');
      if (!th || !header.contains(th)) return false;
      const rect = th.getBoundingClientRect();
      openMenu(rect.left,rect.bottom,th);
      return true;
    },
    get detailColumns() {
      return showProperties ? visibleColumns().filter(col => col.property || col.id === 'created').map(col => col.id) : [];
    },
    get columnCount() { return visibleColumns().length; },
  };
}
