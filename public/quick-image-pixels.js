const channelIndexes = {red:0,green:1,blue:2,alpha:3};

export function initQuickImagePixels({viewport,image,toolbar,original,pointAt}) {
  const start = toolbar.querySelector('[data-pixel-sample]');
  const channels = toolbar.querySelector('[data-pixel-channel]');
  const output = toolbar.querySelector('[data-pixel-values]');
  if (!start || !channels || !output) return null;

  const namespace = 'http://www.w3.org/2000/svg';
  const filters = document.createElementNS(namespace,'svg');
  filters.setAttribute('class','quick-image-channel-filters');
  filters.setAttribute('aria-hidden','true');
  const definitions = document.createElementNS(namespace,'defs');
  for (const [channel,index] of Object.entries(channelIndexes)) {
    const filter = document.createElementNS(namespace,'filter');
    filter.id = 'quick-image-channel-' + channel;
    const matrix = document.createElementNS(namespace,'feColorMatrix');
    matrix.setAttribute('color-interpolation-filters','sRGB');
    matrix.setAttribute('type','matrix');
    const row = Array.from({length:5},(_,column) => column === index ? 1 : 0).join(' ');
    matrix.setAttribute('values',`${row} ${row} ${row} 0 0 0 0 1`);
    filter.append(matrix);
    definitions.append(filter);
  }
  filters.append(definitions);
  toolbar.append(filters);

  let sampling = false;
  let pinned = false;
  let failure = false;
  let lastPoint;
  let pointer;
  let frame = 0;
  let scratch;
  let context;
  let revision = 0;

  function showPoint(point) {
    if (failure) return;
    if (!point) {
      if (lastPoint) output.textContent = '指向图像取样，单击固定';
      lastPoint = undefined;
      return;
    }
    const [x,y] = point;
    if (lastPoint?.[0] === x && lastPoint[1] === y) return;
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = scratch.height = 1;
      context = scratch.getContext('2d',{willReadFrequently:true});
      if (!context) {
        failure = true;
        output.textContent = '此图像的像素取样不可用';
        return;
      }
      context.imageSmoothingEnabled = false;
    }
    try {
      context.clearRect(0,0,1,1);
      context.drawImage(image,x,y,1,1,0,0,1,1);
      const rgba = [...context.getImageData(0,0,1,1).data];
      const hex = '#' + rgba.map(value => value.toString(16).padStart(2,'0')).join('').toUpperCase();
      lastPoint = point;
      output.textContent = `X ${x}   Y ${y} · RGBA ${rgba.join(', ')} · ${hex}`;
    } catch {
      failure = true;
      output.textContent = '此图像的像素取样不可用';
    }
  }

  function setSampling(value) {
    sampling = value;
    pinned = false;
    lastPoint = undefined;
    pointer = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    start.setAttribute('aria-pressed',String(value));
    viewport.toggleAttribute('data-pixel-sampling',value);
    output.hidden = !value;
    output.textContent = value ? '指向图像取样，单击固定' : '';
    if (value) {
      viewport.tabIndex = 0;
      viewport.setAttribute('aria-label','图像像素取样，方向键移动，空格固定或取消固定');
      viewport.focus({preventScroll:true});
    } else {
      viewport.removeAttribute('tabindex');
      viewport.removeAttribute('aria-label');
    }
  }

  function setPinned(value) {
    pinned = value;
    output.classList.toggle('is-pinned',value);
  }

  function setChannel(value) {
    channels.value = value;
    const filter = Object.hasOwn(channelIndexes,value) ? `url(#quick-image-channel-${value})` : '';
    image.style.filter = filter;
  }

  start.addEventListener('click',async () => {
    if (sampling) { setSampling(false); setPinned(false); return; }
    const current = revision;
    if (await original() && revision === current) setSampling(true);
  });
  channels.addEventListener('change',async () => {
    const current = revision;
    const value = channels.value;
    if (value && !await original()) {
      if (revision === current) setChannel('');
      return;
    }
    if (revision === current) setChannel(value);
  });
  viewport.addEventListener('pointermove',event => {
    if (!sampling || pinned || event.buttons && event.buttons !== 1) return;
    pointer = [event.clientX,event.clientY];
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      if (pointer && sampling && !pinned) showPoint(pointAt(...pointer));
    });
  });
  viewport.addEventListener('click',event => {
    if (!sampling || event.button !== 0) return;
    const point = pointAt(event.clientX,event.clientY);
    if (!point) return;
    showPoint(point);
    setPinned(!pinned);
  });
  viewport.addEventListener('keydown',event => {
    if (!sampling || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if (!direction && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    if (!direction) { if (lastPoint) setPinned(!pinned); return; }
    const {naturalWidth:width,naturalHeight:height} = image;
    if (!width || !height) return;
    const [x,y] = lastPoint || [Math.floor(width/2),Math.floor(height/2)];
    const step = event.shiftKey ? 10 : 1;
    showPoint([Math.max(0,Math.min(width-1,x+direction[0]*step)),Math.max(0,Math.min(height-1,y+direction[1]*step))]);
  });

  return {
    reset() {
      revision++;
      failure = false;
      scratch = context = null;
      setSampling(false);
      setPinned(false);
      setChannel('');
    },
    ready(available) { start.disabled = channels.disabled = !available; },
  };
}
