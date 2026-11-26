const preferenceKey = 'nexus-filter-toolbar-layout-v3';
const defaultPins = ['type', 'tags', 'rating', 'format', 'sort'];
const optionOrder = new Intl.Collator('zh-CN', {numeric:true, sensitivity:'base'});

function create(tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  if (tag === 'button') element.type = 'button';
  return element;
}

function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const use = document.createElementNS(namespace, 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function loadLayout(definitions, preferences) {
  const validKeys = values => (Array.isArray(values) ? values.filter(key => definitions.has(key)) : []);
  let pins = defaultPins;
  let order = [];
  try {
    const current = JSON.parse(preferences.getItem(preferenceKey));
    if (Array.isArray(current?.pins)) {
      pins = validKeys(current.pins);
      order = validKeys(current.order);
    } else {
      const previous = JSON.parse(preferences.getItem('nexus-filter-toolbar-pins-v2'));
      if (Array.isArray(previous)) pins = validKeys(previous);
      else {
        const legacy = JSON.parse(preferences.getItem('nexus-filter-toolbar-pins-v1'));
        if (Array.isArray(legacy)) pins = [...defaultPins, ...validKeys(legacy)];
      }
    }
  } catch {
    // Use the defaults if the stored preference cannot be read.
  }
  return {pins:new Set(pins), order:[...new Set([...order, ...pins, ...definitions.keys()])]};
}

function searchField(id, label, placeholder) {
  const field = create('label', 'asset-filter-search');
  const input = create('input');
  input.id = id;
  input.type = 'search';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  field.append(icon('search'), input);
  return {field, input};
}

function groupValues(assets, key) {
  const entries = new Map();
  for (const asset of assets) {
    const values = key === 'format' ? [asset.ext] : asset.tags;
    const seen = new Set();
    for (const raw of values || []) {
      const label = raw?.trim();
      if (!label) continue;
      const normalized = label.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      let entry = entries.get(normalized);
      if (!entry) {
        entry = {label:key === 'format' ? label.toUpperCase() : label, count:0};
        entries.set(normalized, entry);
      }
      entry.count++;
    }
  }
  return entries;
}

export function initAssetFilterToolbar({getState, getFacetAssets, onChange, onError, preferences = localStorage}) {
  const get = id => document.getElementById(id);
  const toolbar = get('asset-filter-toolbar');
  const strip = toolbar.querySelector('.asset-filter-strip');
  const pinned = get('asset-pinned-filters');
  const moreTrigger = get('asset-filter-more-toggle');
  const morePanel = get('asset-filter-more-panel');
  const definitions = new Map([
    ['type', {label:'类型', icon:'grid', panel:get('asset-type-panel'), enabled:s => s.kind !== 'all'}],
    ['tags', {label:'标签', icon:'tag', facet:true, enabled:s => s.tag || s.tagIncludes.length || s.tagExcludes.length}],
    ['rating', {label:'评分', icon:'star', select:get('rating-filter'), enabled:s => s.rating > 0}],
    ['format', {label:'格式', icon:'notes', facet:true, enabled:s => s.formatIncludes.length || s.formatExcludes.length}],
    ['sort', {label:'排序', icon:'list', select:get('sort'), enabled:s => s.sort !== 'added'}],
    ['workflow', {label:'状态', icon:'sliders', select:get('workflow-filter'), enabled:s => s.workflow}],
    ['filename', {label:'文件名', icon:'search', panel:get('asset-filename-panel'), focus:get('filter-filename'),
      enabled:s => s.fileNameQuery.trim()}],
  ]);
  const quickFilters = toolbar.querySelectorAll('#quick-filter-group [data-quick-filter]');
  for (const button of quickFilters) {
    const key = button.dataset.quickFilter;
    const label = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
      .textContent.trim();
    definitions.set(key, {label, icon:button.querySelector('use').getAttribute('href').slice(3),
      quick:button, enabled:s => s.quickFilters.includes(key)});
  }

  let {pins, order} = loadLayout(definitions, preferences);
  const menuRows = create('div', 'asset-filter-options');
  const menuSearch = searchField('asset-filter-menu-search', '搜索筛选项', '搜索筛选项…');
  const menuEmpty = create('p', 'asset-filter-empty', '没有匹配的筛选项');
  menuRows.append(menuEmpty);
  morePanel.prepend(menuSearch.field, menuRows);

  let active;
  let drag;
  let dropTarget;
  let suppressClick = false;

  function alignPanel() {
    if (!active) return;
    const {panel, trigger} = active;
    const base = toolbar.getBoundingClientRect();
    const left = trigger.getBoundingClientRect().left - base.left;
    panel.style.insetInlineStart = Math.max(0, Math.min(left, base.width - panel.offsetWidth)) + 'px';
  }

  function close(restoreFocus = false) {
    if (!active) return;
    const {panel, trigger} = active;
    active = undefined;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({preventScroll:true});
  }

  function toggle(key, trigger, panel, focus) {
    if (active?.panel === panel) { close(true); return; }
    close();
    active = {key, trigger, panel};
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    alignPanel();
    focus?.focus({preventScroll:true});
  }

  function facetSelection(key) {
    const state = getState();
    if (key === 'format') return [state.formatIncludes, state.formatExcludes];
    const includes = state.tag ? [...state.tagIncludes, state.tag.toLowerCase()] : state.tagIncludes;
    return [includes, state.tagExcludes];
  }

  function changeFacet(key, includes, excludes) {
    onChange(key === 'format' ? {formatIncludes:includes, formatExcludes:excludes}
      : {tag:null, tagIncludes:includes, tagExcludes:excludes});
  }

  function flipValue(key, value, exclude) {
    const [includes, excludes] = facetSelection(key);
    const selected = exclude ? excludes : includes;
    const next = selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value];
    if (exclude) changeFacet(key, includes.filter(item => item !== value), next);
    else changeFacet(key, next, excludes.filter(item => item !== value));
  }

  function buildFacet(key, definition) {
    const prefix = 'asset-' + key;
    const panel = create('div', 'asset-filter-panel');
    panel.id = prefix + '-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', definition.label);
    const {field, input} = searchField(prefix + '-search', '搜索' + definition.label, '搜索' + definition.label + '…');
    const options = create('div', 'asset-filter-options');
    options.id = prefix + '-options';
    const footer = create('div', 'asset-filter-panel-actions asset-filter-selection-help');
    const clear = create('button', 'text-button', '清除');
    clear.addEventListener('click', () => {
      changeFacet(key, [], []);
      input.focus({preventScroll:true});
    });
    footer.append(create('span', '', '左键包含 · 右键排除'), clear);
    panel.append(field, options, footer);
    toolbar.append(panel);

    let entries;
    function renderOptions() {
      const query = input.value.trim().toLowerCase();
      const [includes, excludes] = facetSelection(key);
      const focused = options.contains(document.activeElement) ? document.activeElement.dataset.filterValue : null;
      const rows = [];
      for (const [value, entry] of entries) {
        if (query && !value.includes(query)) continue;
        const button = create('button', 'asset-filter-option');
        button.dataset.filterValue = value;
        const mode = excludes.includes(value) ? 'exclude' : includes.includes(value) ? 'include' : 'neutral';
        button.dataset.mode = mode;
        button.setAttribute('aria-label', entry.label + '，' + entry.count + ' 项' +
          (mode === 'include' ? '，已包含' : mode === 'exclude' ? '，已排除' : ''));
        const mark = create('span', 'asset-filter-mark');
        mark.setAttribute('aria-hidden', 'true');
        if (mode === 'include') mark.append(icon('check'));
        if (mode === 'exclude') mark.textContent = '−';
        button.append(mark, create('span', 'asset-filter-label', entry.label),
          create('span', 'asset-filter-count', String(entry.count)));
        rows.push(button);
      }
      options.replaceChildren(...(rows.length ? rows : [create('p', 'asset-filter-empty',
        query ? '没有匹配的选项' : '当前没有可用选项')]));
      rows.find(row => row.dataset.filterValue === focused)?.focus({preventScroll:true});
      clear.disabled = !includes.length && !excludes.length;
    }

    function activate(event, exclude) {
      const button = event.target.closest('[data-filter-value]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      flipValue(key, button.dataset.filterValue, exclude);
    }

    input.addEventListener('input', renderOptions);
    options.addEventListener('click', event => activate(event, false));
    options.addEventListener('contextmenu', event => activate(event, true));
    options.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.shiftKey) activate(event, true);
    });

    definition.panel = panel;
    definition.focus = input;
    definition.refresh = () => {
      const counts = groupValues(getFacetAssets(key), key);
      for (const value of facetSelection(key).flat()) {
        if (!counts.has(value)) counts.set(value, {label:key === 'format' ? value.toUpperCase() : value, count:0});
      }
      entries = [...counts].sort(([, left], [, right]) => optionOrder.compare(left.label, right.label));
      renderOptions();
    };
  }

  function buildSelectPanel(key, definition) {
    const panel = create('div', 'asset-filter-panel');
    panel.id = 'asset-' + key + '-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', definition.label);
    const options = create('div', 'asset-filter-options');
    for (const option of definition.select.options) {
      const button = create('button', 'asset-filter-option', option.textContent);
      button.dataset.value = option.value;
      button.addEventListener('click', () => {
        if (option.hidden || option.disabled) return;
        definition.select.value = option.value;
        definition.select.dispatchEvent(new Event('change', {bubbles:true}));
        close(true);
      });
      options.append(button);
    }
    panel.append(options);
    toolbar.append(panel);
    definition.panel = panel;
    definition.refresh = () => {
      for (const [index, button] of [...options.children].entries()) {
        const option = definition.select.options[index];
        button.classList.toggle('hidden', option.hidden);
        button.disabled = option.disabled;
        button.setAttribute('aria-pressed', String(button.dataset.value === definition.select.value));
      }
    };
  }

  function openFilter(key, trigger) {
    const definition = definitions.get(key);
    if (definition.quick) {
      definition.quick.click();
      return;
    }
    if (active?.panel !== definition.panel) {
      if (definition.facet) definition.focus.value = '';
      definition.refresh?.();
    }
    const focus = definition.focus || definition.panel.querySelector('button[aria-pressed="true"]') ||
      definition.panel.querySelector('button');
    toggle(key, trigger, definition.panel, focus);
  }

  function renderMenu() {
    const query = menuSearch.input.value.trim().toLowerCase();
    let matches = 0;
    for (const [key, definition] of definitions) {
      const {row, pin} = definition;
      row.hidden = Boolean(query && !definition.label.includes(query) && !key.includes(query));
      if (!row.hidden) matches++;
      pin.setAttribute('aria-pressed', String(pins.has(key)));
      pin.title = (pins.has(key) ? '取消固定' : '固定') + definition.label;
    }
    menuEmpty.hidden = matches > 0;
  }

  function render() {
    const state = getState();
    for (const [key, definition] of definitions) {
      const enabled = Boolean(definition.enabled(state));
      definition.trigger.classList.toggle('is-active', enabled);
      definition.row.classList.toggle('is-active', enabled);
      if (definition.quick) {
        definition.trigger.setAttribute('aria-pressed', String(enabled));
        definition.menuButton.setAttribute('aria-pressed', String(enabled));
        definition.count.textContent = definition.quick.querySelector('[data-filter-count]').textContent;
      }
    }
    moreTrigger.classList.toggle('is-active',
      [...definitions].some(([key, definition]) => !pins.has(key) && definition.enabled(state)));
    definitions.get(active?.key)?.refresh?.();
  }

  function updatePins() {
    for (const key of order) {
      const {row, trigger} = definitions.get(key);
      menuRows.insertBefore(row, menuEmpty);
      if (pins.has(key)) pinned.append(trigger);
      else trigger.remove();
    }
    renderMenu();
    render();
    alignPanel();
  }

  function saveLayout() {
    try { preferences.setItem(preferenceKey, JSON.stringify({pins:[...pins], order})); }
    catch { onError('无法保存筛选工具栏'); }
  }

  function moveFilter(key, target, before) {
    if (key === target) return;
    const position = order.indexOf(key);
    order.splice(position, 1);
    const destination = order.indexOf(target) + (before ? 0 : 1);
    order.splice(destination, 0, key);
    if (destination === position) return;
    saveLayout();
    updatePins();
  }

  function reorderItems(track) {
    return [...track.children].filter(item => item.dataset.filterReorder && !item.hidden);
  }

  function moveByKeyboard(event, control) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const item = control.closest('[data-filter-reorder]');
    const track = item.parentElement;
    const horizontal = track === pinned;
    const step = event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp') ? -1
      : event.key === (horizontal ? 'ArrowRight' : 'ArrowDown') ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const items = reorderItems(track);
    const target = items[items.indexOf(item) + step];
    if (!target) return;
    moveFilter(item.dataset.filterReorder, target.dataset.filterReorder, step < 0);
    control.focus({preventScroll:true});
  }

  function showDropTarget(target) {
    if (dropTarget) delete dropTarget.item.dataset.filterDrop;
    dropTarget = target;
    if (target) target.item.dataset.filterDrop = target.before ? 'before' : 'after';
  }

  function endDrag(event, apply) {
    if (drag?.id !== event.pointerId) return;
    const {item, id, dragging} = drag;
    drag = undefined;
    if (!dragging) return;
    suppressClick = true;
    if (item.hasPointerCapture(id)) item.releasePointerCapture(id);
    item.classList.remove('is-reordering');
    const target = dropTarget;
    showDropTarget();
    if (apply && target) moveFilter(item.dataset.filterReorder, target.item.dataset.filterReorder, target.before);
  }

  toolbar.addEventListener('pointerdown', event => {
    suppressClick = false;
    if (!event.isPrimary || event.button !== 0 || event.pointerType === 'touch') return;
    const item = event.target.closest('[data-filter-reorder]');
    if (!item || event.target.closest('.asset-filter-pin')) return;
    drag = {id:event.pointerId, item, track:item.parentElement, x:event.clientX, y:event.clientY};
  });
  toolbar.addEventListener('dragstart', event => {
    if (event.target.closest('[data-filter-reorder]')) event.preventDefault();
  });
  toolbar.addEventListener('click', event => {
    if (!suppressClick || !event.detail) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    if (!(event.buttons & 1)) { endDrag(event, false); return; }
    const {item, track, x, y} = drag;
    if (!drag.dragging) {
      if (Math.hypot(event.clientX - x, event.clientY - y) < 5) return;
      drag.dragging = true;
      item.setPointerCapture(event.pointerId);
      item.classList.add('is-reordering');
    }
    event.preventDefault();
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const target = hit?.closest('[data-filter-reorder]');
    if (!target || target === item || target.parentElement !== track) { showDropTarget(); return; }
    const box = target.getBoundingClientRect();
    const before = track === pinned ? event.clientX < box.left + box.width / 2
      : event.clientY < box.top + box.height / 2;
    showDropTarget({item:target, before});
  }, {passive:false});
  window.addEventListener('pointerup', event => endDrag(event, true));
  window.addEventListener('pointercancel', event => endDrag(event, false));
  window.addEventListener('blur', () => { if (drag) endDrag({pointerId:drag.id}, false); });

  for (const [key, definition] of definitions) {
    if (definition.facet) buildFacet(key, definition);
    if (definition.select) buildSelectPanel(key, definition);
    const trigger = create('button', 'asset-filter-trigger');
    trigger.id = 'asset-' + key + '-toggle';
    trigger.dataset.pinnedFilter = key;
    trigger.dataset.filterReorder = key;
    trigger.title = '拖动排序，或按 Alt + 左右方向键';
    trigger.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
    trigger.append(icon(definition.icon), definition.label);
    if (definition.panel) {
      trigger.setAttribute('aria-controls', definition.panel.id);
      trigger.setAttribute('aria-expanded', 'false');
    }
    trigger.addEventListener('click', () => openFilter(key, trigger));
    trigger.addEventListener('keydown', event => moveByKeyboard(event, trigger));

    const row = create('div', 'asset-filter-menu-row');
    row.dataset.filterReorder = key;
    const menuButton = create('button', 'asset-filter-option');
    menuButton.dataset.openFilter = key;
    menuButton.title = '拖动排序，或按 Alt + 上下方向键';
    menuButton.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    const grip = create('span', 'asset-filter-reorder-grip');
    grip.setAttribute('aria-hidden', 'true');
    menuButton.append(grip, icon(definition.icon), create('span', 'asset-filter-label', definition.label));
    const count = definition.quick ? create('span', 'asset-filter-count') : null;
    if (count) menuButton.append(count);
    menuButton.addEventListener('click', () => openFilter(key, moreTrigger));
    menuButton.addEventListener('keydown', event => moveByKeyboard(event, menuButton));
    const pin = create('button', 'asset-filter-pin');
    pin.dataset.filterPin = key;
    pin.setAttribute('aria-label', '固定' + definition.label + '到筛选栏');
    pin.append(icon('pin'));
    pin.addEventListener('click', () => {
      if (pins.has(key)) pins.delete(key);
      else pins.add(key);
      saveLayout();
      updatePins();
      pin.focus({preventScroll:true});
    });
    row.append(menuButton, pin);
    menuRows.insertBefore(row, menuEmpty);
    Object.assign(definition, {trigger, row, menuButton, pin, count});
  }

  menuSearch.input.addEventListener('input', renderMenu);
  moreTrigger.addEventListener('click', () => {
    if (active && active.trigger === moreTrigger) { close(true); return; }
    menuSearch.input.value = '';
    renderMenu();
    toggle('more', moreTrigger, morePanel, menuSearch.input);
  });
  get('asset-type-panel').addEventListener('click', event => {
    if (event.target.closest('[data-kind]')) close(true);
  });
  toolbar.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag?.dragging) {
      event.preventDefault();
      event.stopPropagation();
      endDrag({pointerId:drag.id}, false);
      return;
    }
    if (event.key !== 'Escape' || !active) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  toolbar.addEventListener('focusout', event => {
    if (event.relatedTarget && !toolbar.contains(event.relatedTarget)) close();
  });
  document.addEventListener('pointerdown', event => {
    if (!toolbar.contains(event.target)) close();
  });
  strip.addEventListener('scroll', alignPanel, {passive:true});
  new ResizeObserver(alignPanel).observe(toolbar);

  updatePins();
  return {
    render, close,
    reload() {
      if (drag) endDrag({pointerId:drag.id}, false);
      close();
      menuSearch.input.value = '';
      ({pins, order} = loadLayout(definitions, preferences));
      updatePins();
    },
  };
}
