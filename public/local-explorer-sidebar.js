const widthKey = 'nexus-file-sidebar-width-v1';
const widthProperty = '--explorer-sidebar-width';
const minimum = 128;
const maximum = 480;

export function createExplorerSidebarWidth(storage = localStorage) {
  let preferred = null;
  try {
    const value = storage.getItem(widthKey);
    const saved = value === null ? JSON.parse(storage.getItem('nexus-workspace-layout-v1'))?.sidebar : Number(value);
    if (saved >= minimum && saved <= maximum) preferred = saved;
  } catch {}

  const listeners = new Set();
  const bounds = () => ({min:minimum,max:Math.max(minimum,Math.min(maximum,Math.floor(window.innerWidth * .55)))});
  function value() {
    const viewport = window.innerWidth;
    const fallback = viewport <= 700 ? 131 : Math.max(156,Math.min(266,viewport * .17));
    return Math.round(Math.min(bounds().max,preferred ?? fallback));
  }
  return {
    bounds,
    value,
    preferred:() => preferred,
    set(next) {
      const {min,max} = bounds();
      preferred = next == null ? null : Math.max(min,Math.min(max,Math.round(next)));
      for (const listener of listeners) listener();
    },
    persist() {
      try { storage.setItem(widthKey,preferred == null ? '' : String(preferred)); } catch {}
    },
    subscribe(listener) { listeners.add(listener); },
  };
}

export function initExplorerSidebar(root,sharedWidth = createExplorerSidebarWidth()) {
  const body = root.querySelector('.local-explorer-body');
  const sidebar = root.querySelector('.local-explorer-sidebar');
  const divider = root.querySelector('[data-explorer-sidebar-divider]');
  const owner = root.ownerDocument;
  let drag;
  function render() {
    const {min,max} = sharedWidth.bounds();
    const value = sharedWidth.value();
    body.style.setProperty(widthProperty,value + 'px');
    divider.setAttribute('aria-valuemin',String(min));
    divider.setAttribute('aria-valuemax',String(max));
    divider.setAttribute('aria-valuenow',String(value));
  }
  sharedWidth.subscribe(render);
  owner.defaultView.addEventListener('resize',render);
  render();

  function finish(cancel = false) {
    if (!drag) return;
    if (cancel) sharedWidth.set(drag.previous);
    else sharedWidth.persist();
    drag = null;
    divider.removeAttribute('data-resizing');
  }

  divider.addEventListener('pointerdown',event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    divider.focus({preventScroll:true});
    drag = {pointer:event.pointerId,x:event.clientX,start:sidebar.getBoundingClientRect().width,previous:sharedWidth.preferred()};
    divider.setAttribute('data-resizing','');
  });
  owner.addEventListener('pointermove',event => {
    if (drag?.pointer !== event.pointerId) return;
    if (event.buttons & 1) sharedWidth.set(drag.start + event.clientX - drag.x);
    else finish();
  },true);
  owner.addEventListener('pointerup',event => { if (drag?.pointer === event.pointerId) finish(); },true);
  owner.addEventListener('pointercancel',event => { if (drag?.pointer === event.pointerId) finish(true); },true);
  owner.defaultView.addEventListener('blur',() => finish());
  const reset = () => { sharedWidth.set(null); sharedWidth.persist(); };
  divider.addEventListener('dblclick',reset);
  divider.addEventListener('keydown',event => {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      finish(true);
      return;
    }
    const {min,max} = sharedWidth.bounds();
    const start = sidebar.getBoundingClientRect().width;
    const step = event.shiftKey ? 48 : 16;
    const width = {ArrowLeft:start - step,ArrowRight:start + step,Home:min,End:max}[event.key];
    if (typeof width !== 'number') return;
    event.preventDefault();
    sharedWidth.set(width);
    sharedWidth.persist();
  });
  return {reset};
}
