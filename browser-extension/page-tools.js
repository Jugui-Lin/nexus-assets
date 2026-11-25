(() => {
  if (globalThis.nexusPageCapture) return;
  globalThis.nexusPageCapture = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    .notice, .target, .area-note { box-sizing: border-box; font: 600 14px system-ui, sans-serif;
      color: #ecf8f6; background: #172527; border: 1px solid #83d9c8; border-radius: 8px; }
    .notice { position: absolute; inset: 16px 16px auto auto; padding: 10px 14px; max-width: min(450px, 90vw); }
    .notice.error { border-color: #ffb5ac; }
    .target { position: absolute; inset: auto 20px 20px auto; width: 216px; height: 132px;
      display: grid; place-content: center; text-align: center; line-height: 1.6; border: 2px dashed #83d9c8; pointer-events: auto; }
    .target:hover, .target.active { background: #235653; border-style: solid; }
    .area { position: absolute; inset: 0; pointer-events: auto; cursor: crosshair; touch-action: none;
      user-select: none; overflow: hidden; background: rgb(10 17 20 / .33); }
    .area.selecting { background: transparent; }
    .area-note { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); white-space: nowrap;
      padding: 9px 13px; pointer-events: none; }
    .selection { position: absolute; box-sizing: border-box; border: 1px solid #83d9c8;
      box-shadow: 0 0 0 100vmax rgb(10 17 20 / .45); pointer-events: none; }
    [hidden] { display: none !important; }
  `);
  let host;
  let shadow;
  let notice;
  let noticeTimer;
  let disposeMode = () => {};

  function create(tag, className, label) {
    const node = document.createElement(tag);
    node.className = className;
    if (label) node.textContent = label;
    return node;
  }

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    shadow = host.attachShadow({mode:'closed'});
    shadow.adoptedStyleSheets = [sheet];
    document.documentElement.append(host);
  }

  function notify(message, error = false) {
    if (!message) return;
    ensureHost();
    notice?.remove();
    clearTimeout(noticeTimer);
    notice = create('div', error ? 'notice error' : 'notice', message);
    notice.setAttribute('role', 'status');
    shadow.append(notice);
    noticeTimer = setTimeout(() => notice?.remove(), 3200);
  }

  async function request(message) {
    try {
      const result = await chrome.runtime.sendMessage(message);
      notify(result?.message || '请查看 Nexus 的采集箱。', !result?.ok);
    } catch { notify('扩展已更新，请重新启用当前页采集。', true); }
  }

  function gestureImage(event) {
    const image = event.composedPath().find(node => node instanceof HTMLImageElement);
    if (!image) return null;
    try {
      const url = new URL(image.currentSrc || image.src, document.baseURI);
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) return null;
      return {url:url.href, title:(image.alt || image.title || '').slice(0, 120)};
    } catch { return null; }
  }

  function gestures() {
    const target = create('div', 'target', '松开鼠标，保存到 Nexus');
    target.hidden = true;
    shadow.append(target);
    let dragged;
    const controller = new AbortController();
    const capture = {capture:true, signal:controller.signal};
    const within = {signal:controller.signal};
    window.addEventListener('dragstart', event => {
      if (!event.isTrusted) return;
      dragged = gestureImage(event);
      target.hidden = !dragged;
    }, capture);
    window.addEventListener('dragend', () => {
      dragged = null;
      target.hidden = true;
      target.classList.remove('active');
    }, capture);
    target.addEventListener('dragover', event => {
      if (!event.isTrusted || !dragged) return;
      event.preventDefault();
      event.stopPropagation();
      target.classList.add('active');
    }, within);
    target.addEventListener('dragleave', () => target.classList.remove('active'), within);
    target.addEventListener('drop', event => {
      if (!event.isTrusted || !dragged) return;
      event.preventDefault();
      event.stopPropagation();
      request({type:'capture-gesture', ...dragged});
      target.hidden = true;
      dragged = null;
    }, within);
    window.addEventListener('contextmenu', event => {
      if (!event.isTrusted || !event.altKey) return;
      const image = gestureImage(event);
      if (!image) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      request({type:'capture-gesture', ...image});
    }, capture);
    window.addEventListener('keydown', event => {
      if (event.isTrusted && event.key === 'Escape') {
        disposeMode();
        notify('网页拖拽采集已关闭。');
      }
    }, capture);
    notify('拖动图片到右下角，或按住 Alt 右键点击图片。按 Esc 退出。');
    return () => { controller.abort(); target.remove(); };
  }

  function selectionCapture(mode) {
    const layer = create('div', 'area');
    const guide = create('div', 'area-note', mode === 'element' ? '点击选择要截图的元素 · Esc 取消' : '拖动框选截图区域 · Esc 取消');
    const outline = create('div', 'selection');
    outline.hidden = true;
    layer.append(guide, outline);
    shadow.append(layer);
    let start;
    const controller = new AbortController();
    const options = {signal:controller.signal};
    function corner(event) {
      return [Math.max(0, Math.min(innerWidth, event.clientX)), Math.max(0, Math.min(innerHeight, event.clientY))];
    }
    function bounds(event) {
      const [x, y] = corner(event);
      return {x:Math.min(x, start.x), y:Math.min(y, start.y), width:Math.abs(x - start.x), height:Math.abs(y - start.y),
        viewportWidth:innerWidth, viewportHeight:innerHeight};
    }
    function showBox({x, y, width, height}) {
      outline.style.left = x + 'px';
      outline.style.top = y + 'px';
      outline.style.width = width + 'px';
      outline.style.height = height + 'px';
    }
    function elementBounds(event) {
      const [x, y] = corner(event);
      const target = document.elementsFromPoint(x, y).find(node => node !== host && node !== document.documentElement);
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      if (right - left < 3 || bottom - top < 3) return null;
      return {x:left, y:top, width:right - left, height:bottom - top, viewportWidth:innerWidth, viewportHeight:innerHeight};
    }
    function submitCrop(crop) {
      disposeMode();
      requestAnimationFrame(() => requestAnimationFrame(() => request({type:'capture-area', crop})));
    }
    layer.addEventListener('pointerdown', event => {
      if (!event.isTrusted || event.button !== 0 || start) return;
      event.preventDefault();
      if (mode === 'element') return;
      const [x, y] = corner(event);
      start = {x, y, id:event.pointerId};
      layer.setPointerCapture(event.pointerId);
      guide.hidden = false;
      outline.hidden = false;
      showBox(bounds(event));
      layer.classList.add('selecting');
    }, options);
    layer.addEventListener('pointermove', event => {
      if (!event.isTrusted) return;
      if (mode === 'element') {
        const crop = elementBounds(event);
        outline.hidden = !crop;
        layer.classList.toggle('selecting', Boolean(crop));
        if (crop) showBox(crop);
      } else if (start?.id === event.pointerId) showBox(bounds(event));
    }, options);
    layer.addEventListener('pointerup', event => {
      if (!event.isTrusted || start?.id !== event.pointerId) return;
      event.preventDefault();
      const crop = bounds(event);
      if (crop.width < 3 || crop.height < 3) {
        start = null;
        outline.hidden = true;
        layer.classList.remove('selecting');
        return;
      }
      submitCrop(crop);
    }, options);
    layer.addEventListener('click', event => {
      if (!event.isTrusted || mode !== 'element') return;
      event.preventDefault();
      event.stopPropagation();
      const crop = elementBounds(event);
      if (crop) submitCrop(crop);
    }, options);
    layer.addEventListener('pointercancel', () => disposeMode(), options);
    layer.addEventListener('wheel', event => event.preventDefault(), {...options, passive:false});
    window.addEventListener('keydown', event => {
      if (event.isTrusted && event.key === 'Escape') {
        event.preventDefault();
        disposeMode();
      }
    }, {...options, capture:true});
    return () => { controller.abort(); layer.remove(); };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'activate-page-tool') return false;
    ensureHost();
    disposeMode();
    notice?.remove();
    disposeMode = message.mode === 'gesture' ? gestures() : selectionCapture(message.mode);
    respond({ok:true});
    return false;
  });
})();
