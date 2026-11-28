import {readWhiteboardFile} from './whiteboard-files.js';
import {readWhiteboardLink} from './whiteboard-links.js';
import {readWhiteboardRegion} from './whiteboard-regions.js';
import {readReviewNotes, reviewTime} from './whiteboard-review-notes.js';
import {readVideoCover} from './whiteboard-video-cover.js';

const pageSize = 80;
const nameOrder = new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
const normalize = value => value.normalize('NFKC').toLowerCase();
const oneLine = value => String(value ?? '').replace(/\s+/g,' ').trim();

function entriesFor(item,kinds,assetName,bounds) {
  const region = readWhiteboardRegion(item);
  const file = item.kind === 'text' && readWhiteboardFile(item.text);
  const link = item.kind === 'text' && readWhiteboardLink(item.text);
  const asset = item.assetId && assetName(item);
  const body = region?.name || file?.name || link?.title ||
    (item.kind === 'image' ? readVideoCover(item.text).title : item.text) || '';
  const type = region ? '区域' : file ? file.isFolder ? '文件夹' : '文件' :
    link ? '链接' : item.assetId ? '素材引用' : kinds[item.kind];
  const title = oneLine(body) || asset || type;
  const detail = region?.shot || file?.path || file?.unc || link?.host || (asset !== title && asset) || '';
  const entry = {itemId:item.id,title,type,detail,bounds:bounds(item),frame:item.kind === 'frame' && !region,
    region:Boolean(region),key:'item:' + item.id,
    terms:normalize([title,type,detail,body,file?.unc,link?.url,asset].filter(Boolean).join(' '))};
  const notes = item.kind === 'image' && item.assetId ? readReviewNotes(item.text).notes : [];
  return {entry,notes:notes.map(note => {
    const time = reviewTime(note.time);
    const detail = [title,note.shot,note.ownerName,time,note.resolved ? '已解决' : '待返修'].filter(Boolean).join(' · ');
    return {itemId:item.id,noteId:note.id,title:oneLine(note.message),type:'审片标注',detail,
      key:`note:${item.id}:${note.id}`,terms:normalize([note.message,detail,asset,'审片标注'].join(' '))};
  })};
}

function outline(entries,byName) {
  const sorted = entries.slice().sort((a,b) => (byName ? nameOrder.compare(a.title,b.title) : 0) ||
    a.bounds.top-b.bounds.top || a.bounds.left-b.bounds.left);
  const area = ({left,top,right,bottom}) => (right-left)*(bottom-top);
  const frames = sorted.filter(entry => entry.frame).map(entry => ({...entry,area:area(entry.bounds)}))
    .sort((a,b) => a.area-b.area);
  const children = new Map();
  for (const entry of sorted) {
    const {left,top,right,bottom} = entry.bounds;
    const entryArea = area(entry.bounds);
    const parent = !entry.region && frames.find(frame => frame.itemId !== entry.itemId &&
      (!entry.frame || frame.area > entryArea) && left >= frame.bounds.left && top >= frame.bounds.top &&
      right <= frame.bounds.right && bottom <= frame.bounds.bottom);
    const parentId = parent ? parent.itemId : null;
    if (!children.has(parentId)) children.set(parentId,[]);
    children.get(parentId).push(entry);
  }
  return children;
}

export function initWhiteboardNavigation({trigger,items,kinds,assetName,bounds,canOpen,canRename,jump,icon}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal whiteboard-navigation-dialog';
  dialog.setAttribute('aria-label','白板查找与大纲');
  dialog.innerHTML = `<header class="modal-header">
    <h2>查找与大纲</h2>
    <button type="button" class="icon-button" data-board-navigation-close aria-label="关闭">${icon('close')}</button>
  </header>
  <div class="whiteboard-navigation-controls">
    <input type="search" class="text-field" maxlength="160" aria-label="查找白板内容" placeholder="查找画框、素材、便签或审片标注…">
    <select class="text-field" aria-label="大纲排序"><option value="position">按位置</option><option value="name">按名称</option></select>
  </div>
  <p data-board-navigation-status role="status"></p>
  <ul class="whiteboard-navigation-list" aria-label="白板大纲"></ul>
  <button type="button" class="button subtle" data-board-navigation-more hidden>显示更多</button>`;
  document.body.append(dialog);

  const input = dialog.querySelector('input');
  const sort = dialog.querySelector('select');
  const list = dialog.querySelector('ul');
  const more = dialog.querySelector('[data-board-navigation-more]');
  const status = dialog.querySelector('[data-board-navigation-status]');
  const expanded = new Set();
  const shown = new Map();
  let source, content, children, outlineSort, scheduled = 0;
  let limit = pageSize;

  function refreshIndex() {
    const current = items();
    if (source === current && content) return;
    source = current;
    content = [...source.values()].map(item => entriesFor(item,kinds,assetName,bounds));
    children = null;
  }

  function row(entry,depth,count) {
    shown.set(entry.key,entry);
    const li = document.createElement('li');
    li.className = 'whiteboard-navigation-row';
    li.dataset.navigationEntry = entry.key;
    li.style.setProperty('--navigation-depth',Math.min(depth,5));
    if (count) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'icon-button whiteboard-navigation-toggle';
      toggle.dataset.boardNavigationToggle = entry.itemId;
      toggle.setAttribute('aria-expanded',String(expanded.has(entry.itemId)));
      toggle.setAttribute('aria-label',`${expanded.has(entry.itemId) ? '折叠' : '展开'} ${entry.title}（${count} 项）`);
      toggle.innerHTML = icon('chevron');
      li.append(toggle);
    }
    const locate = document.createElement('button');
    locate.type = 'button';
    locate.className = 'whiteboard-navigation-locate';
    locate.dataset.boardNavigationLocate = entry.key;
    locate.title = entry.title;
    const type = document.createElement('small');
    type.className = 'whiteboard-navigation-type';
    type.textContent = entry.type;
    const text = document.createElement('span');
    const label = document.createElement('span');
    label.className = 'whiteboard-navigation-label';
    label.textContent = entry.title;
    text.append(label);
    if (entry.detail) {
      const detail = document.createElement('small');
      detail.className = 'whiteboard-navigation-detail';
      detail.textContent = entry.detail;
      text.append(detail);
    }
    locate.append(text,type);
    li.append(locate);
    if (entry.frame && canRename()) {
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'icon-button';
      rename.dataset.boardNavigationRename = entry.key;
      rename.setAttribute('aria-label','重命名 ' + entry.title);
      rename.title = '重命名画框';
      rename.innerHTML = icon('edit');
      li.append(rename);
    }
    return li;
  }

  function draw() {
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
    if (!dialog.open) return;
    refreshIndex();
    const tokens = normalize(input.value).trim().split(/\s+/).filter(Boolean);
    let rows;
    if (tokens.length) {
      rows = content.flatMap(({entry,notes}) => [entry,...notes])
        .filter(entry => tokens.every(token => entry.terms.includes(token)))
        .map(entry => [entry,0,0]);
      status.textContent = rows.length ? `找到 ${rows.length} 项` : '没有找到匹配的内容';
      list.setAttribute('aria-label','查找结果');
    } else {
      if (!children || outlineSort !== sort.value) {
        outlineSort = sort.value;
        children = outline(content.map(({entry}) => entry),outlineSort === 'name');
      }
      rows = [];
      function visit(parent,depth) {
        for (const entry of children.get(parent) || []) {
          rows.push([entry,depth,children.get(entry.itemId)?.length || 0]);
          if (expanded.has(entry.itemId)) visit(entry.itemId,depth+1);
        }
      }
      visit(null,0);
      status.textContent = content.length ? `${content.filter(({entry}) => entry.frame).length} 个画框 · ${content.length} 个元素` : '白板还没有内容';
      list.setAttribute('aria-label','白板大纲');
    }
    sort.hidden = Boolean(tokens.length);
    const active = document.activeElement;
    const focusAttribute = ['boardNavigationLocate','boardNavigationToggle','boardNavigationRename'].find(key => active?.dataset[key]);
    const focusValue = focusAttribute && active.dataset[focusAttribute];
    shown.clear();
    list.replaceChildren(...rows.slice(0,limit).map(args => row(...args)));
    more.hidden = rows.length <= limit;
    if (focusValue) {
      const focus = [...list.querySelectorAll('button')].find(button => button.dataset[focusAttribute] === focusValue);
      (focus || input).focus({preventScroll:true});
    } else if (active === more && more.hidden) {
      list.querySelector('li:last-child [data-board-navigation-locate]')?.focus();
    }
  }

  function activate(entry,rename = false) {
    if (!entry || !canOpen()) return;
    if (!jump(entry,rename)) {
      status.textContent = '该内容暂时无法定位，白板可能已更新';
      return;
    }
    dialog.close();
  }

  function close() {
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
    if (dialog.open) dialog.close();
  }
  function open() {
    if (!canOpen()) return false;
    if (!dialog.open) {
      dialog.showModal();
      draw();
    }
    input.focus();
    input.select();
    return true;
  }
  function toggle(id) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    draw();
  }

  trigger.addEventListener('click',open);
  dialog.querySelector('[data-board-navigation-close]').addEventListener('click',close);
  input.addEventListener('input',() => { limit = pageSize; list.scrollTop = 0; draw(); });
  sort.addEventListener('change',() => { limit = pageSize; list.scrollTop = 0; draw(); });
  more.addEventListener('click',() => { limit += pageSize; draw(); });
  list.addEventListener('click',event => {
    const button = event.target.closest('button');
    if (!button) return;
    const {boardNavigationToggle,boardNavigationLocate,boardNavigationRename} = button.dataset;
    if (boardNavigationToggle) toggle(boardNavigationToggle);
    else activate(shown.get(boardNavigationLocate || boardNavigationRename),Boolean(boardNavigationRename));
  });
  dialog.addEventListener('keydown',event => {
    if (event.isComposing || event.altKey || event.shiftKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      open();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target !== input && !list.contains(target)) return;
    const actions = [...list.querySelectorAll('[data-board-navigation-locate]')];
    if (!actions.length) return;
    if (event.key === 'Enter' && (target === input || target.dataset.boardNavigationLocate)) {
      event.preventDefault();
      activate(shown.get((target === input ? actions[0] : target).dataset.boardNavigationLocate));
      return;
    }
    const rowButton = target.closest('li')?.querySelector('[data-board-navigation-locate]');
    const index = actions.indexOf(rowButton);
    const disclosure = rowButton?.closest('li').querySelector('[data-board-navigation-toggle]');
    if (disclosure && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();
      if (expanded.has(disclosure.dataset.boardNavigationToggle) === (event.key === 'ArrowLeft')) {
        toggle(disclosure.dataset.boardNavigationToggle);
      }
      return;
    }
    const next = event.key === 'ArrowDown' ? Math.min(index+1,actions.length-1) :
      event.key === 'ArrowUp' ? (index < 0 ? actions.length-1 : index-1) :
      target !== input && event.key === 'Home' ? 0 : target !== input && event.key === 'End' ? actions.length-1 : null;
    if (next === null) return;
    event.preventDefault();
    (actions[next] || input).focus();
  });

  return {
    open,close,
    isOpen:() => dialog.open,
    reset() {
      close();
      input.value = '';
      sort.value = 'position';
      expanded.clear();
      shown.clear();
      source = content = children = null;
      limit = pageSize;
    },
    refresh(assetChanged = false) {
      if (assetChanged) content = null;
      if (dialog.open && !scheduled && (!content || source !== items())) scheduled = requestAnimationFrame(draw);
    },
  };
}
