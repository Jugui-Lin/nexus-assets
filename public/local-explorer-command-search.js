const historyKey = 'nexus-explorer-command-history-v1';
const limit = 12;

function normalized(text) {
  return text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' ');
}

function match(query,terms) {
  if (!query) return 0;
  if (terms.includes(query)) return 3;
  if (terms.some(term => term.startsWith(query))) return 2;
  return query.split(' ').every(word => terms.some(term => term.includes(word))) ? 1 : 0;
}

export function initExplorerCommandSearch(dialog,{commands,isActive,onError}) {
  if (!dialog) return {show:() => false};
  const owner = dialog.ownerDocument;
  const input = dialog.querySelector('input');
  const results = dialog.querySelector('[role="listbox"]');
  const status = dialog.querySelector('[role="status"]');
  const entries = commands.map(command => ({
    ...command,
    terms:[command.label,...command.aliases].map(normalized),
  }));
  const identifiers = new Set(entries.map(command => command.id));
  const storage = owner.defaultView.localStorage;
  let recent = [];
  try {
    const saved = JSON.parse(storage.getItem(historyKey));
    if (Array.isArray(saved)) recent = [...new Set(saved.filter(id => identifiers.has(id)))].slice(0,limit);
  } catch {}
  let matches = [];
  let active = -1;

  function select(index,scroll = false) {
    active = index;
    [...results.children].forEach((option,position) => option.setAttribute('aria-selected',String(position === index)));
    const option = results.children[index];
    if (!option) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant',option.id);
    if (scroll && option.offsetHeight) {
      if (option.offsetTop < results.scrollTop) results.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > results.scrollTop + results.clientHeight)
        results.scrollTop = option.offsetTop + option.offsetHeight - results.clientHeight;
    }
  }

  function render() {
    const query = normalized(input.value);
    const frequency = new Map(recent.map((id,index) => [id,recent.length - index]));
    matches = entries
      .filter(entry => entry.available())
      .map(entry => ({entry,score:match(query,entry.terms)}))
      .filter(({score}) => !query || score > 0)
      .sort((first,second) => second.score - first.score ||
        (frequency.get(second.entry.id) || 0) - (frequency.get(first.entry.id) || 0))
      .map(({entry}) => entry);
    results.replaceChildren(...matches.map((entry,index) => {
      const option = owner.createElement('div');
      option.id = dialog.id + '-command-' + entry.id;
      option.dataset.commandIndex = String(index);
      option.setAttribute('role','option');
      const label = owner.createElement('span');
      label.textContent = entry.label;
      option.append(label);
      if (!query && frequency.has(entry.id)) {
        const detail = owner.createElement('small');
        detail.textContent = '最近使用';
        option.append(detail);
      }
      return option;
    }));
    status.textContent = matches.length ? '' : '没有可用的匹配命令。';
    results.scrollTop = 0;
    select(matches.length ? 0 : -1);
  }

  function show() {
    if (!isActive() || dialog.open || owner.querySelector('dialog[open]')) return false;
    input.value = '';
    render();
    dialog.showModal();
    input.focus({preventScroll:true});
    return true;
  }

  async function run(index) {
    const entry = matches[index];
    if (!entry || !dialog.open) return;
    if (!isActive() || !entry.available()) {
      render();
      return;
    }
    dialog.close();
    try {
      if ((await entry.run()) === false) return;
      recent = [entry.id,...recent.filter(id => id !== entry.id)].slice(0,limit);
      try { storage.setItem(historyKey,JSON.stringify(recent)); } catch {}
    } catch (error) {
      onError(error);
    }
  }

  input.addEventListener('input',render);
  input.addEventListener('keydown',event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void run(active);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (matches.length)
        select((active + matches.length + (event.key === 'ArrowUp' ? -1 : 1)) % matches.length,true);
    }
  });
  results.addEventListener('mousedown',event => event.preventDefault());
  results.addEventListener('click',event => {
    const option = event.target.closest('[data-command-index]');
    if (option) void run(Number(option.dataset.commandIndex));
  });

  return {show};
}
