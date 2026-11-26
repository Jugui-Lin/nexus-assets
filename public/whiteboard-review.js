const reviewKey = 'nexus-whiteboard-review-v1:';
const ratios = {'16:9':16/9,'9:16':9/16,'21:9':21/9};
const fadeDuration = 2200;

export function initWhiteboardReview({shell,stage,icon,items,minimapItems = items,bounds,boardKey,getView,setView,canPresent,onPresent,onExit}) {
  shell.insertAdjacentHTML('beforeend',`<details class="whiteboard-review-setup" data-pane-transient>
    <summary>${icon('play')}演示</summary>
    <div class="whiteboard-review-options">
      <label>演示路径<select data-review-frame aria-label="演示路径"></select></label>
      <div class="whiteboard-review-order">
        <button type="button" data-review-action="up">上移画框</button>
        <button type="button" data-review-action="down">下移画框</button>
      </div>
      <label>停留秒数<input type="number" data-review-duration min="0" max="600" step="1" title="0 秒时手动切换"></label>
      <label>安全区比例<select data-review-ratio><option value="frame">画框原比例</option><option>16:9</option><option>9:16</option><option>21:9</option></select></label>
      <label>阅读预设<select data-review-theme><option value="native">当前主题</option><option value="light">浅色</option><option value="dark">深色</option><option value="projection">投影</option></select></label>
      <button type="button" data-review-action="start">播放所选画框</button>
    </div>
  </details>
  <div class="whiteboard-review-shield" data-pane-transient hidden>
    <div class="whiteboard-review-frame"><div class="whiteboard-review-safe"></div></div>
    <canvas class="whiteboard-review-laser" aria-hidden="true"></canvas>
  </div>
  <div class="whiteboard-review-controls" role="toolbar" aria-label="白板演示操作" data-pane-transient hidden>
    <button type="button" data-review-action="previous">上一幕</button><select data-review-jump aria-label="跳转画框"></select>
    <button type="button" data-review-action="next">下一幕</button>
    <button type="button" data-review-action="pause" aria-pressed="false">暂停自动切换</button>
    <button type="button" data-review-action="laser" aria-pressed="false">激光笔</button>
    <button type="button" data-review-action="exit" title="退出演示（Esc）">退出演示</button>
  </div>
  <canvas class="whiteboard-minimap" data-pane-transient tabindex="0" aria-label="白板小地图，点击或拖动定位，方向键平移" hidden></canvas>`);
  const find = selector => shell.querySelector(selector);
  const action = name => find(`[data-review-action="${name}"]`);
  const setup = find('.whiteboard-review-setup');
  const frameInput = find('[data-review-frame]');
  const durationInput = find('[data-review-duration]');
  const ratioInput = find('[data-review-ratio]');
  const themeInput = find('[data-review-theme]');
  const jump = find('[data-review-jump]');
  const controls = find('.whiteboard-review-controls');
  const shield = find('.whiteboard-review-shield');
  const outline = find('.whiteboard-review-frame');
  const laserCanvas = find('.whiteboard-review-laser');
  const map = find('.whiteboard-minimap');
  const empty = {order:[],durations:{},ratio:'frame',theme:'native'};
  let key;
  let preferences = empty;
  let signature;
  let frames = [];
  let playing;
  let timer;
  let laserFrame;
  let points = [];
  let mapFrame;
  let mapProjection;
  let mapDrag;

  function readPreferences(value) {
    try {
      const saved = JSON.parse(localStorage.getItem(reviewKey + value));
      return {...empty,...saved, order: Array.isArray(saved?.order) ? saved.order : [],
        durations:saved?.durations && typeof saved.durations === 'object' ? saved.durations : {}};
    } catch { return empty; }
  }

  function save(patch) {
    preferences = {...preferences,...patch};
    try { localStorage.setItem(reviewKey + key,JSON.stringify(preferences)); } catch {}
  }

  function duration(id) {
    return Math.max(0,Math.min(600,Math.round(Number(preferences.durations[id]) || 0)));
  }

  function paintOptions() {
    const index = frames.findIndex(frame => frame.id === frameInput.value);
    durationInput.disabled = action('start').disabled = index < 0;
    durationInput.value = index < 0 ? '' : duration(frameInput.value);
    action('up').disabled = index <= 0;
    action('down').disabled = index < 0 || index === frames.length - 1;
    ratioInput.value = Object.hasOwn(ratios,preferences.ratio) ? preferences.ratio : 'frame';
    themeInput.value = ['light','dark','projection'].includes(preferences.theme) ? preferences.theme : 'native';
  }

  function refresh() {
    const nextKey = boardKey();
    if (key !== nextKey) {
      exit(false);
      key = nextKey;
      preferences = key ? readPreferences(key) : empty;
      signature = undefined;
      setup.open = false;
    }
    const previous = frameInput.value;
    const remaining = new Map([...items()].filter(([,item]) => item.kind === 'frame'));
    frames = [];
    for (const id of preferences.order) {
      if (!remaining.has(id)) continue;
      frames.push(remaining.get(id));
      remaining.delete(id);
    }
    frames.push(...remaining.values());
    const next = JSON.stringify(frames.map(({id,text}) => [id,text]));
    if (signature !== next) {
      signature = next;
      for (const select of [frameInput,jump]) {
        select.replaceChildren(...frames.map(({id,text},index) => new Option(`${index+1}. ${text || '画框'}`,id)));
      }
      if (frames.some(frame => frame.id === previous)) frameInput.value = previous;
      paintOptions();
    }
    if (playing && !items().has(playing.id)) exit(false);
    if (playing) fitCurrent();
    requestMap();
  }

  function fitCurrent() {
    const frame = items().get(playing?.id);
    if (!frame) return;
    const ratio = ratios[ratioInput.value] || frame.width / frame.height;
    const width = Math.min(frame.width,frame.height * ratio);
    const height = width / ratio;
    const left = frame.x + (frame.width - width) / 2;
    const top = frame.y + (frame.height - height) / 2;
    const zoom = Math.min(3,Math.max(.002,Math.min((stage.clientWidth-28)/width,(stage.clientHeight-74)/height)));
    const x = (stage.clientWidth - width * zoom) / 2;
    const y = (stage.clientHeight - height * zoom - 40) / 2;
    Object.assign(outline.style,{left:`${x}px`,top:`${y}px`,width:`${width * zoom}px`,height:`${height * zoom}px`});
    setView({x:x-left*zoom,y:y-top*zoom,zoom});
  }

  function configureTimer() {
    clearTimeout(timer);
    if (!playing || playing.paused || action('next').disabled) return;
    const seconds = duration(playing.id);
    if (seconds) timer = setTimeout(() => step(1),seconds * 1000);
  }

  function show(id) {
    const index = frames.findIndex(frame => frame.id === id);
    if (index < 0) return;
    playing.id = jump.value = id;
    action('previous').disabled = index === 0;
    action('next').disabled = index === frames.length - 1;
    fitCurrent();
    configureTimer();
  }

  function step(offset) {
    const index = frames.findIndex(frame => frame.id === playing?.id);
    if (index >= 0 && frames[index + offset]) show(frames[index + offset].id);
  }

  function start() {
    if (!key || !getView() || !frameInput.value || !canPresent()) return;
    const first = frameInput.value;
    playing = {id:first,view:{...getView()}, paused:false};
    setup.open = false;
    stage.inert = true;
    shield.hidden = controls.hidden = false;
    shell.dataset.boardReviewTheme = themeInput.value;
    shell.setAttribute('data-board-presenting','');
    onPresent();
    if (!playing) return;
    show(first);
    jump.focus({preventScroll:true});
  }

  function exit(focus = true) {
    if (!playing) return;
    const previous = playing.view;
    playing = null;
    clearTimeout(timer);
    cancelAnimationFrame(laserFrame);
    laserFrame = 0;
    points = [];
    laserCanvas.width = 1;
    shield.hidden = controls.hidden = true;
    stage.inert = false;
    delete shell.dataset.boardReviewTheme;
    shell.removeAttribute('data-board-presenting');
    for (const name of ['laser','pause']) action(name).setAttribute('aria-pressed','false');
    shield.removeAttribute('data-laser');
    setView(previous);
    onExit?.();
    if (focus) setup.querySelector('summary').focus({preventScroll:true});
  }

  function drawLaser(now) {
    const context = laserCanvas.getContext('2d');
    const {clientWidth:w,clientHeight:h} = shield;
    if (laserCanvas.width !== w || laserCanvas.height !== h) { laserCanvas.width = w; laserCanvas.height = h; }
    context.clearRect(0,0,w,h);
    points = points.filter(point => now - point.time < fadeDuration);
    for (let index=0; index<points.length; index++) {
      const point = points[index];
      const previous = index && points[index - 1];
      context.globalAlpha = 1 - Math.max(0,now-point.time) / fadeDuration;
      context.strokeStyle = context.fillStyle = '#ff535c';
      context.lineWidth = 3;
      context.lineCap = 'round';
      context.beginPath();
      if (previous && !point.start) {
        context.moveTo(previous.x,previous.y);
        context.lineTo(point.x,point.y);
        context.stroke();
      } else { context.arc(point.x,point.y,4,0,2*Math.PI); context.fill(); }
    }
    laserFrame = points.length ? requestAnimationFrame(drawLaser) : 0;
  }

  function trace(event) {
    if (!shield.hasAttribute('data-laser') || !(event.buttons & 1)) return;
    const box = shield.getBoundingClientRect();
    points.push({x:event.clientX-box.left,y:event.clientY-box.top,time:performance.now(),start:event.type === 'pointerdown'});
    if (points.length > 100) points.shift();
    if (!laserFrame) laserFrame = requestAnimationFrame(drawLaser);
  }

  function paintMap() {
    mapFrame = 0;
    const view = getView();
    const entries = [...minimapItems().values()].filter(item => !item.connection);
    map.hidden = !key || !view || !entries.length;
    if (map.hidden || playing || !stage.clientWidth) return;
    const [w,h] = [map.clientWidth,map.clientHeight];
    const scale = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(w*scale), pixelHeight = Math.round(h*scale);
    if (map.width !== pixelWidth || map.height !== pixelHeight) { map.width = pixelWidth; map.height = pixelHeight; }
    const camera = {left:-view.x/view.zoom, top:-view.y/view.zoom,
      right:(stage.clientWidth-view.x)/view.zoom,bottom:(stage.clientHeight-view.y)/view.zoom};
    const boxes = entries.map(bounds);
    const edges = [...boxes,camera];
    const left = Math.min(...edges.map(box => box.left));
    const top = Math.min(...edges.map(box => box.top));
    const width = Math.max(...edges.map(box => box.right)) - left;
    const height = Math.max(...edges.map(box => box.bottom)) - top;
    const zoom = Math.min((w-12)/width,(h-12)/height);
    mapProjection = mapDrag || {zoom, x:(w-width*zoom)/2-left*zoom,y:(h-height*zoom)/2-top*zoom};
    const {x,y} = mapProjection;
    const box = ({left,top,right,bottom}) => [x+left*mapProjection.zoom,y+top*mapProjection.zoom,
      Math.max(1,(right-left)*mapProjection.zoom),Math.max(1,(bottom-top)*mapProjection.zoom)];
    const context = map.getContext('2d');
    context.setTransform(scale,0,0,scale,0,0);
    context.clearRect(0,0,w,h);
    const colors = getComputedStyle(shell);
    context.fillStyle = colors.getPropertyValue('--muted') || '#848f98';
    context.strokeStyle = context.fillStyle;
    boxes.forEach((part,index) => entries[index].kind === 'frame' ? context.strokeRect(...box(part)) : context.fillRect(...box(part)));
    context.strokeStyle = colors.getPropertyValue('--accent') || '#88bbeb';
    context.lineWidth = 1.5;
    context.strokeRect(...box(camera));
  }

  function requestMap() {
    if (!mapFrame) mapFrame = requestAnimationFrame(paintMap);
  }

  function mapTo(event) {
    if (!mapDrag) return;
    const box = map.getBoundingClientRect();
    const view = getView();
    const x = (event.clientX-box.left-mapDrag.x)/mapDrag.zoom;
    const y = (event.clientY-box.top-mapDrag.y)/mapDrag.zoom;
    setView({x:stage.clientWidth/2-x*view.zoom,y:stage.clientHeight/2-y*view.zoom,zoom:view.zoom});
  }

  map.addEventListener('pointerdown',event => {
    if (event.button !== 0 || !mapProjection) return;
    mapDrag = mapProjection;
    map.setPointerCapture(event.pointerId);
    mapTo(event);
  });
  map.addEventListener('pointermove',mapTo);
  map.addEventListener('lostpointercapture',() => { mapDrag = null; requestMap(); });
  map.addEventListener('keydown',event => {
    const shift = {ArrowUp:[0,80],ArrowDown:[0,-80],ArrowLeft:[80,0],ArrowRight:[-80,0]}[event.key];
    if (!shift || !getView()) return;
    event.preventDefault();
    const {x,y,zoom} = getView();
    setView({x:x+shift[0],y:y+shift[1],zoom});
  });

  setup.addEventListener('change',event => {
    if (!key) return;
    if (event.target === durationInput) save({durations:{...preferences.durations,[frameInput.value]:Number(durationInput.value)}});
    if (event.target === ratioInput) save({ratio:ratioInput.value});
    if (event.target === themeInput) save({theme:themeInput.value});
    paintOptions();
  });
  shell.addEventListener('click',event => {
    const command = event.target.closest('[data-review-action]')?.dataset.reviewAction;
    if (command === 'start') start();
    if (command === 'up' || command === 'down') {
      const id = frameInput.value;
      const order = frames.map(frame => frame.id);
      const index = order.indexOf(id);
      const to = index + (command === 'up' ? -1 : 1);
      if (index >= 0 && to >= 0 && to < order.length) {
        [order[index],order[to]] = [order[to],order[index]];
        save({order});
        refresh();
      }
    }
    if (!playing) return;
    if (command === 'exit') exit();
    if (command === 'previous' || command === 'next') step(command === 'next' ? 1 : -1);
    if (command === 'pause') {
      playing.paused = !playing.paused;
      action('pause').setAttribute('aria-pressed',String(playing.paused));
      configureTimer();
    }
    if (command === 'laser') action('laser').setAttribute('aria-pressed',String(shield.toggleAttribute('data-laser')));
  });
  jump.addEventListener('change',() => { if (playing) show(jump.value); });
  document.addEventListener('keydown',event => {
    if (!playing || event.defaultPrevented || event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    exit();
  });
  controls.addEventListener('keydown',event => {
    if (event.target !== jump && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();
      step(event.key === 'ArrowRight' ? 1 : -1);
    }
  });
  shield.addEventListener('pointerdown',event => {
    if (!shield.hasAttribute('data-laser') || event.button !== 0) return;
    shield.setPointerCapture(event.pointerId);
    trace(event);
  });
  shield.addEventListener('pointermove',trace);
  new ResizeObserver(() => { if (playing) fitCurrent(); requestMap(); }).observe(stage);
  return {refresh,requestMap,exit,presenting:() => Boolean(playing)};
}
