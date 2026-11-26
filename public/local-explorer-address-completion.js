const completionLimit = 12;
const invalidSegment = /[\\/\u0000-\u001f\u007f]/;
const absoluteWindowsParent = /^(?:(?:\\\\\?\\)?[a-z]:[\\/]|(?:\\\\\?\\UNC\\|[\\/]{2})(?![?.][\\/])[^\\/]+[\\/])/i;

function isFileLink(path) {
  if (!/^(?:file|smb):\/\//i.test(path)) return false;
  try {
    const url = new URL(path);
    return url.pathname.endsWith('/') && (url.protocol === 'file:' || Boolean(url.hostname)) &&
      !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}

function pathSegment(input) {
  const {value,selectionStart:caret,selectionEnd} = input;
  if (caret == null || selectionEnd !== caret) return null;
  const leading = value.slice(0,caret);
  const start = Math.max(leading.lastIndexOf('\\'),leading.lastIndexOf('/')) + 1;
  const path = leading.slice(0,start);
  const link = isFileLink(path);
  if (!link && !absoluteWindowsParent.test(path) && !/^\/(?!\/)/.test(path)) return null;
  let prefix = leading.slice(start);
  if (link) {
    try { prefix = decodeURIComponent(prefix); } catch { return null; }
  }
  if (!prefix || [...prefix].length > 255 || invalidSegment.test(prefix)) return null;
  const rest = value.slice(caret);
  const boundary = rest.search(/[\\/]/);
  return {value,caret,start,end:boundary < 0 ? value.length : caret + boundary,path,prefix,link};
}

export function initExplorerAddressCompletion({input,popup,read,isActive}) {
  if (!popup || !read) return {clear() {}};
  const owner = input.ownerDocument;
  const list = popup.querySelector('[role="listbox"]');
  const view = owner.defaultView;
  let pending, timer, displayed;
  let inFlight = false;
  let active = -1;
  input.setAttribute('role','combobox');
  input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls',list.id);
  input.setAttribute('aria-expanded','false');

  function hide() {
    displayed = null;
    active = -1;
    list.replaceChildren();
    popup.hidden = true;
    input.setAttribute('aria-expanded','false');
    input.removeAttribute('aria-activedescendant');
  }

  function clear() {
    view.clearTimeout(timer);
    timer = undefined;
    pending = null;
    hide();
  }

  function current(request) {
    return isActive() && owner.activeElement === input && input.value === request.value &&
      input.selectionStart === request.caret && input.selectionEnd === request.caret;
  }

  function show(request,entries) {
    if (!Array.isArray(entries) || !current(request)) return;
    const prefix = request.prefix.toLowerCase();
    const names = [...new Set(entries.map(entry => entry?.name).filter(name => typeof name === 'string' &&
      name.length && !invalidSegment.test(name) && name !== '.' && name !== '..' && name.toLowerCase().startsWith(prefix)))].slice(0,completionLimit);
    if (!names.length) return;
    displayed = {request,names};
    active = -1;
    list.replaceChildren(...names.map((name,index) => {
      const option = owner.createElement('li');
      option.id = list.id + '-' + index;
      option.setAttribute('role','option');
      option.setAttribute('aria-selected','false');
      option.dataset.completionIndex = String(index);
      option.textContent = option.title = name;
      return option;
    }));
    popup.hidden = false;
    input.setAttribute('aria-expanded','true');
  }

  async function flush() {
    if (inFlight || !pending || timer !== undefined) return;
    const request = pending;
    if (!current(request)) { clear(); return; }
    inFlight = true;
    try {
      const entries = await read({path:request.path,prefix:request.prefix});
      if (pending === request) show(request,entries);
    } catch { /* An unavailable directory can still be edited or opened through the address field. */ }
    finally {
      inFlight = false;
      if (pending === request) pending = null;
      void flush();
    }
  }

  function schedule() {
    clear();
    const request = pathSegment(input);
    if (!request || !current(request)) return;
    pending = request;
    timer = view.setTimeout(() => {
      timer = undefined;
      void flush();
    },140);
  }

  function complete(index,continuePath) {
    if (!displayed || !current(displayed.request)) { clear(); return false; }
    const {request,names} = displayed;
    const {start,end,value} = request;
    let replacement = names[index];
    if (!replacement) return false;
    if (request.link) replacement = encodeURIComponent(replacement);
    if (continuePath && end === value.length) replacement += request.path.at(-1);
    if (value.length - (end - start) + replacement.length > input.maxLength) return false;
    input.setRangeText(replacement,start,end,'end');
    if (continuePath && end < value.length) input.setSelectionRange(input.selectionEnd + 1,input.selectionEnd + 1);
    clear();
    return true;
  }

  input.addEventListener('input',event => { if (!event.isComposing) schedule(); });
  input.addEventListener('compositionstart',clear);
  input.addEventListener('compositionend',schedule);
  input.addEventListener('blur',clear);
  input.addEventListener('selectionchange',() => {
    if ((displayed && !current(displayed.request)) || (pending && !current(pending))) clear();
  });
  input.addEventListener('keydown',event => {
    if (!displayed || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!current(displayed.request)) { clear(); return; }
    if (event.key === 'Tab' && !event.shiftKey && complete(Math.max(0,active),true)) {
      event.preventDefault();
    } else if (event.key === 'Enter' && active >= 0 && complete(active,false)) {
      event.preventDefault();
      input.form?.requestSubmit();
    } else if (!event.shiftKey && ['ArrowUp','ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const last = displayed.names.length - 1;
      active = event.key === 'ArrowDown' ? active >= last ? 0 : active + 1 : active <= 0 ? last : active - 1;
      for (const [index,option] of [...list.children].entries()) option.setAttribute('aria-selected',String(index === active));
      const option = list.children[active];
      input.setAttribute('aria-activedescendant',option.id);
      option.scrollIntoView({block:'nearest',inline:'nearest'});
    }
  });
  list.addEventListener('mousedown',event => { if (event.button === 0) event.preventDefault(); });
  list.addEventListener('click',event => {
    const option = event.target.closest('[data-completion-index]');
    if (option) complete(Number(option.dataset.completionIndex),true);
  });

  return {clear};
}
