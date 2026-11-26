const ratios = [['16:9',16/9],['9:16',9/16],['1:1',1]];
const clamp = value => Math.max(0,Math.min(1,value));
const center = () => ({x:.5,y:.5});

export function initVideoFraming({video,player,dialog}) {
  const button = dialog.querySelector('#quick-video-framing');
  const tools = player.querySelector('#video-framing-tools');
  const activeSelect = tools.querySelector('select');
  const overlay = player.querySelector('#video-framing-overlay');
  const shade = overlay.querySelector('.video-framing-shade');
  const frames = new Map();
  let active = '9:16';
  let open = false;
  let drag;
  let image = null;
  for (const [label,ratio] of ratios) {
    const element = document.createElement('div');
    element.className = 'video-framing-box';
    element.dataset.ratio = label;
    const caption = document.createElement('span');
    caption.textContent = label;
    element.setAttribute('aria-label',label + ' 取景框，使用方向键移动');
    element.append(caption);
    overlay.append(element);
    const checkbox = tools.querySelector('[value="' + label + '"]:is(input)');
    frames.set(label,{element,checkbox,ratio,position:center()});
    checkbox.addEventListener('change',() => {
      if (!checkbox.checked && active === label) {
        active = [...frames].find(([,frame]) => frame.checkbox.checked)?.[0] || '';
      } else if (checkbox.checked && !active) active = label;
      paint();
    });
  }

  function bounds(frame) {
    const w = Math.min(image.width,image.height * frame.ratio);
    const h = Math.min(image.height,image.width / frame.ratio);
    const dx = Math.max(0,image.width - w);
    const dy = Math.max(0,image.height - h);
    return {w,h,dx,dy,x:dx * frame.position.x,y:dy * frame.position.y};
  }

  function place(element,{w,h,x,y}) {
    element.style.width = w + 'px';
    element.style.height = h + 'px';
    element.style.left = x + 'px';
    element.style.top = y + 'px';
  }

  function paint() {
    if (!open || !video.videoWidth || !video.videoHeight) return;
    const rect = video.getBoundingClientRect();
    const parent = player.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth,rect.height / video.videoHeight);
    if (!(scale > 0)) return;
    image = {width:video.videoWidth * scale,height:video.videoHeight * scale};
    place(overlay,{w:image.width,h:image.height,
      x:rect.left - parent.left + (rect.width - image.width) / 2,
      y:rect.top - parent.top + (rect.height - image.height) / 2});
    const picked = frames.get(active);
    shade.hidden = !picked;
    if (picked) place(shade,bounds(picked));
    for (const [label,frame] of frames) {
      activeSelect.querySelector('option[value="' + label + '"]').disabled = !frame.checkbox.checked;
      const isActive = label === active;
      frame.element.hidden = !frame.checkbox.checked;
      frame.element.tabIndex = isActive ? 0 : -1;
      frame.element.toggleAttribute('data-active',isActive);
      place(frame.element,bounds(frame));
    }
    activeSelect.value = active;
    activeSelect.disabled = !picked;
    tools.querySelector('[data-framing-center]').disabled = !picked;
  }

  function toggle(next) {
    open = next;
    drag = undefined;
    button.setAttribute('aria-pressed',String(open));
    tools.hidden = !open;
    overlay.hidden = !open;
    if (open) {
      video.pause();
      paint();
    }
  }

  button.addEventListener('click',() => toggle(!open));
  activeSelect.addEventListener('change',() => {
    active = activeSelect.value;
    paint();
  });
  tools.querySelector('[data-framing-center]').addEventListener('click',() => {
    const frame = frames.get(active);
    if (!frame) return;
    frame.position = center();
    paint();
  });
  overlay.addEventListener('pointerdown',event => {
    const frame = frames.get(active);
    if (event.button !== 0 || !frame?.element.contains(event.target)) return;
    drag = {id:event.pointerId,frame,x:event.clientX,y:event.clientY,initial:{...frame.position}};
    frame.element.setPointerCapture(event.pointerId);
    frame.element.focus({preventScroll:true});
    event.preventDefault();
  });
  overlay.addEventListener('pointermove',event => {
    if (!drag || event.pointerId !== drag.id) return;
    const {dx,dy} = bounds(drag.frame);
    drag.frame.position = {
      x:dx ? clamp(drag.initial.x + (event.clientX - drag.x) / dx) : drag.initial.x,
      y:dy ? clamp(drag.initial.y + (event.clientY - drag.y) / dy) : drag.initial.y,
    };
    paint();
  });
  overlay.addEventListener('lostpointercapture',() => { drag = undefined; });
  overlay.addEventListener('keydown',event => {
    const offsets = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if (!Object.hasOwn(offsets,event.key) || !frames.has(active)) return;
    event.preventDefault();
    event.stopPropagation();
    const frame = frames.get(active);
    const [x,y] = offsets[event.key];
    const step = event.shiftKey ? .1 : .02;
    frame.position = {x:clamp(frame.position.x + x * step),y:clamp(frame.position.y + y * step)};
    paint();
  });

  function reset() {
    toggle(false);
    button.hidden = true;
    active = '9:16';
    for (const frame of frames.values()) {
      frame.position = center();
      frame.checkbox.checked = true;
    }
  }
  video.addEventListener('loadedmetadata',() => { button.hidden = !video.videoWidth; paint(); });
  video.addEventListener('emptied',reset);
  dialog.addEventListener('close',reset);
  new ResizeObserver(paint).observe(video);
}
