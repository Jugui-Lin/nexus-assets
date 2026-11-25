export function initWorkspaceTabs({getScope, capture, restore, beforeSwitch, goHome, icon, onDuplicate = () => {}, onError = () => {}}) {
  const heading = document.getElementById('page-title');
  const list = document.getElementById('workspace-tab-list');
  const add = document.getElementById('workspace-tab-add');
  let scope;
  let sequence = 0;
  let tabs = [];
  let active;
  let operation;

  function createTab(title, snapshot) {
    const group = document.createElement('div');
    group.className = 'workspace-tab';
    group.setAttribute('role', 'presentation');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'workspace-tab-trigger';
    trigger.setAttribute('role', 'tab');
    trigger.setAttribute('aria-controls', 'browser-scroll');
    trigger.setAttribute('aria-keyshortcuts', 'Delete');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'workspace-tab-close';
    close.innerHTML = icon('close');
    const tab = {id:'workspace-tab-' + ++sequence, title, snapshot, group, trigger, close};
    trigger.id = tab.id;
    group.append(trigger, close);
    trigger.addEventListener('click', () => activate(tab));
    close.addEventListener('click', () => remove(tab));
    return tab;
  }

  function paint() {
    list.dataset.single = String(tabs.length === 1);
    for (const tab of tabs) {
      const selected = tab === active;
      if (tab.trigger.textContent !== tab.title) tab.trigger.textContent = tab.title;
      tab.trigger.title = tab.title;
      tab.trigger.setAttribute('aria-selected', String(selected));
      tab.trigger.tabIndex = selected ? 0 : -1;
      const closeLabel = '关闭「' + tab.title + '」';
      tab.close.setAttribute('aria-label', closeLabel);
      tab.close.title = closeLabel;
      tab.close.tabIndex = selected ? 0 : -1;
      tab.group.toggleAttribute('data-active', selected);
    }
  }

  function resetScope() {
    scope = getScope();
    operation = undefined;
    list.removeAttribute('aria-busy');
    active = createTab(heading.textContent.trim() || '资产工作台');
    tabs = [active];
    list.replaceChildren(active.group);
    paint();
  }

  function ensureScope() {
    if (!active || scope !== getScope()) resetScope();
  }

  function focusTab(tab) {
    tab.trigger.scrollIntoView({block:'nearest', inline:'nearest'});
    tab.trigger.focus({preventScroll:true});
  }

  async function transition(action) {
    ensureScope();
    if (operation) return;
    const token = {};
    operation = token;
    list.setAttribute('aria-busy', 'true');
    const current = () => operation === token && scope === getScope();
    try {
      if (await beforeSwitch() === false || !current()) return;
      await action(current);
    } catch (failure) {
      if (current()) onError(failure);
    } finally {
      if (operation === token) {
        operation = undefined;
        list.removeAttribute('aria-busy');
      }
    }
  }

  async function showTab(tab, current) {
    const previous = active;
    active = tab;
    paint();
    try {
      await restore(tab.snapshot);
    } catch (failure) {
      if (current()) {
        active = previous;
        paint();
      }
      throw failure;
    }
  }

  function activate(tab, focus = false) {
    ensureScope();
    if (!tabs.includes(tab) || tab === active) return;
    transition(async current => {
      active.snapshot = capture();
      await showTab(tab, current);
      if (current() && focus) focusTab(tab);
    });
  }

  function remove(tab) {
    ensureScope();
    if (operation || !tabs.includes(tab)) return;
    if (tab !== active) {
      tabs = tabs.filter(item => item !== tab);
      tab.group.remove();
      paint();
      focusTab(active);
      return;
    }
    transition(async current => {
      const index = tabs.indexOf(tab);
      const neighbor = tabs[index + 1] || tabs[index - 1];
      if (neighbor) {
        await showTab(neighbor, current);
        if (!current()) return;
        tabs.splice(index, 1);
        tab.group.remove();
      } else {
        const fresh = createTab(tab.title);
        active = fresh;
        tabs = [fresh];
        list.replaceChildren(fresh.group);
        paint();
        try {
          await goHome();
        } catch (failure) {
          if (current()) {
            active = tab;
            tabs = [tab];
            list.replaceChildren(tab.group);
            paint();
          }
          throw failure;
        }
      }
      if (!current()) return;
      paint();
      focusTab(active);
    });
  }

  add.addEventListener('click', () => {
    ensureScope();
    if (operation) return;
    try {
      active.snapshot = capture();
      const tab = createTab(active.title, active.snapshot);
      tabs.splice(tabs.indexOf(active) + 1, 0, tab);
      active.group.after(tab.group);
      active = tab;
      paint();
      onDuplicate();
      focusTab(tab);
    } catch (failure) { onError(failure); }
  });

  list.addEventListener('keydown', event => {
    const tab = tabs.find(item => item.trigger === event.target || item.close === event.target);
    if (!tab || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Delete') {
      event.preventDefault();
      remove(tab);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === 'ArrowLeft' ? -1 : 1;
    const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
      : tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
    activate(target, true);
  });

  resetScope();
  return {
    render(title) {
      ensureScope();
      const label = String(title || '').trim() || '资产工作台';
      if (active.title === label) return;
      active.title = label;
      paint();
    },
    activeId() {
      ensureScope();
      return active.id;
    },
    resetScope,
  };
}
