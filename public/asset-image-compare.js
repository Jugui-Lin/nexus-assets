const fit = () => ({x:.5,y:.5,zoom:1});
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));

export function initAssetImageCompare({dialog,grid,readOriginal}) {
  const header = dialog.querySelector('.asset-compare-header');
  const controls = document.createElement('div');
  controls.hidden = true;
  controls.className = 'asset-compare-controls asset-image-compare-controls';
  controls.setAttribute('role','group');
  controls.setAttribute('aria-label','图像对照');
  controls.innerHTML = `<button type="button" class="button subtle" data-image-link aria-pressed="true">同步缩放和平移</button>
    <button type="button" class="button subtle" data-image-fit>适应画面</button>
    <button type="button" class="button subtle" data-image-wipe aria-pressed="false" hidden>分隔对照</button>
    <span data-image-compare-status role="status"></span>`;
  header.insertBefore(controls,header.querySelector('[data-close]'));
  const find = selector => controls.querySelector(selector);
  const link = find('[data-image-link]');
  const wipe = find('[data-image-wipe]');
  const status = find('[data-image-compare-status]');
  const overlay = document.createElement('section');
  overlay.hidden = true;
  overlay.className = 'asset-image-compare-overlay';
  overlay.setAttribute('aria-label','原图分隔对照');
  overlay.innerHTML = `<div class="asset-image-compare-names"><span></span><span></span></div>
    <div class="asset-image-wipe-stage" tabindex="0" aria-label="原图对照画面，拖动平移，滚轮或加减键缩放">
      <img alt="" draggable="false"><div class="asset-image-wipe-layer"><img alt="" draggable="false"></div>
      <div class="asset-image-wipe-line" aria-hidden="true"><span>◂▸</span></div>
    </div>
    <input type="range" class="asset-image-wipe-slider" min="0" max="100" step="1" value="50" aria-label="图像分隔线">`;
  grid.after(overlay);
  const stage = overlay.querySelector('.asset-image-wipe-stage');
  const slider = overlay.querySelector('input');
  const overlayImages = [...overlay.querySelectorAll('img')];
  const overlayNames = [...overlay.querySelectorAll('.asset-image-compare-names span')];
  const registered = new Map();
  const displayed = new Map();
  let linked = true;
  let active;
  let dragging;
  let pending = false;
  let generation = 0;
  let originals;
  let eligibleCount = 0;
  let wipeActive = false;

  function dimensions(view) {
    const {naturalWidth:width,naturalHeight:height} = view.images[0];
    const box = view.stage.getBoundingClientRect();
    if (!width || !height || !box.width || !box.height) return null;
    const scale = Math.min(box.width/width,box.height/height);
    return {box,width:width*scale,height:height*scale};
  }

  function draw(view) {
    const size = dimensions(view);
    if (!size) return;
    const {x,y,zoom} = view.camera;
    const width = size.width*zoom;
    const height = size.height*zoom;
    for (const image of view.images) {
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
      image.style.left = `${size.box.width/2-x*width}px`;
      image.style.top = `${size.box.height/2-y*height}px`;
    }
    view.stage.toggleAttribute('data-image-pannable',zoom>1);
  }

  function changeCamera(view,camera) {
    view.camera = {...camera,x:clamp(camera.x,0,1),y:clamp(camera.y,0,1)};
    draw(view);
    if (view.stage !== stage) active = view;
    if (linked) {
      for (const peer of displayed.values()) {
        if (peer === view) continue;
        peer.camera = {...view.camera};
        draw(peer);
      }
    }
  }

  function zoomAt(view,zoom,clientX,clientY) {
    const size = dimensions(view);
    if (!size) return;
    const {box,width,height} = size;
    const previous = view.camera;
    const next = clamp(zoom,.5,8);
    if (next === previous.zoom) return;
    const delta = 1/previous.zoom-1/next;
    const cursorX = (clientX ?? box.left+box.width/2)-box.left-box.width/2;
    const cursorY = (clientY ?? box.top+box.height/2)-box.top-box.height/2;
    changeCamera(view,{zoom:next,x:previous.x+cursorX*delta/width,y:previous.y+cursorY*delta/height});
  }

  function endDrag() {
    if (!dragging) return;
    const {view,id} = dragging;
    dragging = undefined;
    view.stage.removeAttribute('data-image-drag');
    if (view.stage.hasPointerCapture(id)) view.stage.releasePointerCapture(id);
  }

  function paintWipe() {
    stage.style.setProperty('--image-wipe',`${slider.value}%`);
    slider.setAttribute('aria-valuetext',`左图 ${slider.value}%，右图 ${100-slider.valueAsNumber}%`);
  }
  function moveWipe(x,box) { slider.value = String(clamp((x-box.left)/box.width*100,0,100)); paintWipe(); }
  slider.addEventListener('input',paintWipe);

  function register(viewStage,images) {
    const view = {stage:viewStage,images,camera:fit()};
    registered.set(viewStage,view);
    const enabled = () => viewStage === stage ? wipeActive : displayed.has(viewStage);
    viewStage.addEventListener('wheel',event => {
      if (!enabled() || !event.deltaY || event.ctrlKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewStage.clientHeight : 1;
      zoomAt(view,view.camera.zoom*Math.exp(-clamp(event.deltaY*unit,-240,240)*.003),event.clientX,event.clientY);
    },{passive:false});
    viewStage.addEventListener('pointerdown',event => {
      if (!enabled() || event.button !== 0 || !event.isPrimary || dragging) return;
      const size = dimensions(view);
      if (!size) return;
      const divider = viewStage === stage && (view.camera.zoom <= 1 || event.target.closest('.asset-image-wipe-line'));
      if (!divider && view.camera.zoom <= 1) return;
      event.preventDefault();
      viewStage.focus({preventScroll:true});
      dragging = {view,id:event.pointerId,divider,x:event.clientX,y:event.clientY};
      viewStage.setPointerCapture(event.pointerId);
      viewStage.dataset.imageDrag = divider ? 'divider' : 'pan';
      if (divider) moveWipe(event.clientX,size.box);
    });
    viewStage.addEventListener('pointermove',event => {
      if (dragging?.view !== view || dragging.id !== event.pointerId) return;
      const size = dimensions(view);
      if (!size) return;
      if (dragging.divider) moveWipe(event.clientX,size.box);
      else {
        const {x,y,zoom} = view.camera;
        changeCamera(view,{zoom,x:x-(event.clientX-dragging.x)/(size.width*zoom),y:y-(event.clientY-dragging.y)/(size.height*zoom)});
      }
      dragging.x = event.clientX;
      dragging.y = event.clientY;
    });
    for (const name of ['pointerup','pointercancel','lostpointercapture']) {
      viewStage.addEventListener(name,event => { if (dragging?.id === event.pointerId) endDrag(); });
    }
    viewStage.addEventListener('keydown',event => {
      if (!enabled() || event.altKey || event.ctrlKey || event.metaKey) return;
      const {x,y,zoom} = view.camera;
      switch (event.key) {
        case '+': case '=': zoomAt(view,zoom*1.2); break;
        case '-': zoomAt(view,zoom/1.2); break;
        case 'Home': changeCamera(view,fit()); break;
        case 'ArrowLeft': if (zoom>1) changeCamera(view,{x:x-.045/zoom,y,zoom}); break;
        case 'ArrowRight': if (zoom>1) changeCamera(view,{x:x+.045/zoom,y,zoom}); break;
        case 'ArrowUp': if (zoom>1) changeCamera(view,{x,y:y-.045/zoom,zoom}); break;
        case 'ArrowDown': if (zoom>1) changeCamera(view,{x,y:y+.045/zoom,zoom}); break;
        default: return;
      }
      event.preventDefault();
    });
    new ResizeObserver(() => { if (enabled()) draw(view); }).observe(viewStage);
    return view;
  }

  const wipeView = register(stage,overlayImages);
  for (const image of overlayImages) image.addEventListener('load',() => { if (wipeActive) draw(wipeView); });

  function paintControls() {
    controls.hidden = displayed.size === 0;
    link.hidden = displayed.size < 2 || wipeActive;
    link.setAttribute('aria-pressed',String(linked));
    wipe.hidden = eligibleCount !== 2 || displayed.size !== 2 || !readOriginal;
    wipe.disabled = pending;
    wipe.setAttribute('aria-pressed',String(wipeActive));
    wipe.textContent = wipeActive ? '返回并排' : '分隔对照';
  }

  async function loadOriginal(view) {
    const result = await readOriginal(view.asset);
    if (!result?.url) throw Error('当前格式暂不支持读取原图进行分隔对照');
    const image = new Image();
    image.src = result.url;
    await image.decode();
    const {naturalWidth:width,naturalHeight:height} = image;
    if (!(width===result.width && height===result.height || width===result.height && height===result.width)) {
      throw Error('无法确认原图的像素尺寸');
    }
    return {url:result.url,width,height};
  }

  wipe.addEventListener('click',async () => {
    if (pending || displayed.size !== 2) return;
    endDrag();
    if (wipeActive) {
      wipeActive = false;
      overlay.hidden = true;
      grid.hidden = false;
      paintControls();
      return;
    }
    const current = generation;
    const views = [...displayed.values()].sort((left,right) => left.order-right.order);
    if (!originals) {
      pending = true;
      status.textContent = '正在读取两张原图…';
      paintControls();
      try {
        const results = await Promise.all(views.map(loadOriginal));
        if (current !== generation) return;
        if (results[0].width !== results[1].width || results[0].height !== results[1].height) {
          throw Error('两张原图的分辨率不同，可用并排视图继续检查');
        }
        originals = results;
      } catch (failure) {
        if (current === generation) status.textContent = String(failure?.message || failure);
        return;
      } finally {
        if (current === generation) { pending = false; paintControls(); }
      }
    }
    status.textContent = `${originals[0].width} × ${originals[0].height}`;
    wipeView.camera = {...(active || views[0]).camera};
    originals.forEach(({url},index) => {
      overlayImages[index].src = url;
      overlayNames[index].textContent = views[index].asset.name;
    });
    wipeActive = grid.hidden = true;
    overlay.hidden = false;
    slider.value = '50';
    paintWipe();
    draw(wipeView);
    paintControls();
    slider.focus({preventScroll:true});
  });
  link.addEventListener('click',() => {
    linked = !linked;
    if (linked && active) changeCamera(active,active.camera);
    paintControls();
  });
  find('[data-image-fit]').addEventListener('click',() => {
    const view = wipeActive ? wipeView : active || displayed.values().next().value;
    if (view) changeCamera(view,fit());
  });

  return {
    reset(count = 0) {
      generation++;
      eligibleCount = count;
      endDrag();
      active = originals = undefined;
      linked = true;
      pending = wipeActive = false;
      displayed.clear();
      for (const [viewStage,view] of registered) {
        view.camera = fit();
        viewStage.removeAttribute('data-image-pannable');
        if (viewStage === stage) continue;
        viewStage.removeAttribute('data-image-navigation');
        viewStage.removeAttribute('tabindex');
        viewStage.removeAttribute('aria-label');
        for (const property of ['width','height','left','top']) view.images[0].style.removeProperty(property);
      }
      for (const image of overlayImages) image.removeAttribute('src');
      overlay.hidden = true;
      status.textContent = '';
      paintControls();
    },
    image(slot,asset) {
      const viewStage = slot.image.parentElement;
      const view = registered.get(viewStage) || register(viewStage,[slot.image]);
      view.asset = asset;
      view.order = slot.order;
      slot.image.draggable = false;
      viewStage.dataset.imageNavigation = '';
      viewStage.tabIndex = 0;
      viewStage.setAttribute('aria-label', `${asset.name}，滚轮缩放，拖动平移，Home 重置`);
      if (linked && active) view.camera = {...active.camera};
      displayed.set(viewStage,view);
      draw(view);
      paintControls();
    },
  };
}
