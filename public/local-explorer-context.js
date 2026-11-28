const pinyin = new Intl.Collator('zh-CN-u-co-pinyin',{sensitivity:'base'});
const initials = [...'abcdefghjklmnopqrstwxyz'];
const pinyinBoundaries = [...'阿八擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝'];

function menuInitial(text) {
  if (/^重(?:命名|开|新)/.test(text)) return 'c';
  const first = [...text.trim()][0];
  if (!first || !/\p{Script=Han}/u.test(first)) return first?.toLowerCase();
  const index = pinyinBoundaries.findLastIndex(character => pinyin.compare(first,character) >= 0);
  return index < 0 ? undefined : initials[index];
}

export function initExplorerContextMenu(root) {
  const owner = root.ownerDocument;
  const popup = owner.createElement('div');
  popup.className = 'local-explorer-context-menu';
  popup.setAttribute('role','menu');
  popup.setAttribute('aria-label','文件操作');
  popup.tabIndex = -1;
  popup.hidden = true;
  root.append(popup);
  let pending;
  let frame = [];
  const parents = [];

  function dismiss(id = null,restoreFocus = true) {
    if (!pending) return;
    const {resolve,anchor} = pending;
    pending = null;
    parents.length = 0;
    frame = [];
    popup.hidden = true;
    popup.replaceChildren();
    if (restoreFocus && anchor?.isConnected && root.contains(anchor) && !root.hidden) {
      anchor.focus({preventScroll:true});
    }
    resolve(id);
  }

  function enabledItems() {
    return [...popup.querySelectorAll('button:not(:disabled)')];
  }

  function focusItem(button) {
    (button || popup).focus({preventScroll:true});
    if (!button) return;
    const bounds = button.getBoundingClientRect();
    const top = popup.getBoundingClientRect().top + popup.clientTop;
    const bottom = top + popup.clientHeight;
    if (bounds.top < top) popup.scrollTop += bounds.top - top;
    else if (bounds.bottom > bottom) popup.scrollTop += bounds.bottom - bottom;
  }

  function position() {
    const margin = 6;
    const {x,y,anchor} = pending;
    const previous = anchor?.getBoundingClientRect();
    const {clientWidth,clientHeight} = owner.documentElement;
    const edge = (value,size) => Math.max(margin,Math.min(size - margin,value));
    const startX = edge(x ?? previous?.left ?? margin,clientWidth);
    const below = edge(y ?? previous?.bottom ?? margin,clientHeight);
    const above = edge(y ?? previous?.top ?? margin,clientHeight);
    const belowSpace = clientHeight - margin - below;
    const aboveSpace = above - margin;
    popup.style.maxHeight = '';
    const opensAbove = popup.offsetHeight > belowSpace && aboveSpace > belowSpace;
    popup.style.maxHeight = Math.max(0,opensAbove ? aboveSpace : belowSpace) + 'px';

    const maxLeft = clientWidth - popup.offsetWidth - margin;
    const flippedLeft = startX - popup.offsetWidth;
    const left = startX <= maxLeft ? startX : flippedLeft >= margin ? flippedLeft : maxLeft;
    popup.style.left = Math.max(margin,left) + 'px';
    popup.style.top = (opensAbove ? above - popup.offsetHeight : below) + 'px';
  }

  function openChildren(button) {
    const item = frame.find(entry => entry.id === button?.dataset.explorerMenuItem);
    if (!item?.children?.length) return false;
    parents.push({items:frame,focus:item.id,scrollTop:popup.scrollTop});
    frame = item.children;
    popup.replaceChildren(menuItems(frame));
    popup.scrollTop = 0;
    position();
    focusItem(enabledItems()[0]);
    return true;
  }

  function returnToParent() {
    const previous = parents.pop();
    if (!previous) return false;
    frame = previous.items;
    popup.replaceChildren(menuItems(frame));
    position();
    popup.scrollTop = previous.scrollTop;
    focusItem(enabledItems().find(button => button.dataset.explorerMenuItem === previous.focus));
    return true;
  }

  popup.addEventListener('click',event => {
    const item = event.target.closest('button[data-explorer-menu-item]');
    if (item && !item.disabled && !openChildren(item)) dismiss(item.dataset.explorerMenuItem);
  });
  popup.addEventListener('contextmenu',event => {
    event.preventDefault();
    event.stopPropagation();
  });
  popup.addEventListener('keydown',event => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        if (!returnToParent()) dismiss();
        return;
      case 'ArrowRight':
      case 'ArrowLeft':
        if (event.key === 'ArrowRight' ? openChildren(owner.activeElement) : returnToParent()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      case 'Tab':
        dismiss();
        return;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'Home':
      case 'End': {
        event.preventDefault();
        event.stopPropagation();
        const items = enabledItems();
        const current = items.indexOf(owner.activeElement);
        const last = items.length - 1;
        const destination = {
          Home:0,End:last,ArrowUp:current <= 0 ? last : current - 1,
          ArrowDown:current >= last ? 0 : current + 1,
        }[event.key];
        focusItem(items[destination]);
        break;
      }
      default: {
        if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || [...event.key].length !== 1 || !event.key.trim()) return;
        const items = enabledItems();
        const first = items.indexOf(owner.activeElement) + 1;
        const key = event.key.toLowerCase();
        const match = [...items.slice(first),...items.slice(0,first)].find(button =>
          button.dataset.initial === key || button.querySelector('.local-explorer-context-label').textContent.toLowerCase().startsWith(key));
        if (!match) return;
        event.preventDefault();
        event.stopPropagation();
        focusItem(match);
      }
    }
  });
  owner.addEventListener('pointerdown',event => {
    if (!popup.contains(event.target)) dismiss(null,false);
  },true);
  owner.defaultView.addEventListener('blur',() => dismiss(null,false));
  owner.defaultView.addEventListener('resize',() => dismiss());

  function menuItems(items) {
    const result = owner.createDocumentFragment();
    let separator = false;
    for (const item of items) {
      if (item.separator) {
        separator = Boolean(result.childElementCount);
        continue;
      }
      if (!item.id || !item.label) continue;
      if (separator) {
        const line = owner.createElement('div');
        line.setAttribute('role','separator');
        result.append(line);
        separator = false;
      }
      const button = owner.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.disabled = Boolean(item.disabled);
      button.dataset.explorerMenuItem = item.id;
      button.dataset.initial = menuInitial(item.label) || '';
      button.setAttribute('role',item.checked == null ? 'menuitem' : 'menuitemcheckbox');
      if (item.checked != null) button.setAttribute('aria-checked',String(item.checked));

      const mark = owner.createElement('span');
      mark.className = 'local-explorer-context-mark';
      mark.setAttribute('aria-hidden','true');
      mark.textContent = item.checked ? '✓' : '';
      const label = owner.createElement('span');
      label.className = 'local-explorer-context-label';
      label.textContent = item.label;
      button.append(mark,label);
      if (item.children?.length) {
        button.setAttribute('aria-haspopup','menu');
        const arrow = owner.createElement('span');
        arrow.textContent = '›';
        arrow.setAttribute('aria-hidden','true');
        button.append(arrow);
      } else if (item.shortcut) {
        const shortcut = owner.createElement('kbd');
        shortcut.textContent = item.shortcut;
        button.append(shortcut);
      }
      result.append(button);
    }
    return result;
  }

  function show({x,y,items}) {
    const anchor = pending?.anchor || owner.activeElement;
    dismiss(null,false);
    if (root.hidden) return Promise.resolve(null);
    const content = menuItems(items);
    if (!content.childElementCount) return Promise.resolve(null);
    popup.replaceChildren(content);
    popup.hidden = false;
    frame = items;
    return new Promise(resolve => {
      pending = {resolve,anchor,x,y};
      position();
      popup.scrollTop = 0;
      focusItem(enabledItems()[0]);
    });
  }

  return show;
}
