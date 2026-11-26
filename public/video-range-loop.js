import {formatTime} from './video-controls.js';

export function initVideoRangeLoop(player,video) {
  const toggle = player.querySelector('#quick-video-loop');
  const panel = player.querySelector('#quick-video-loop-panel');
  const start = panel.querySelector('[data-loop-start]');
  const end = panel.querySelector('[data-loop-end]');
  const apply = panel.querySelector('[data-loop-apply]');
  const status = panel.querySelector('[data-loop-status]');
  const band = player.querySelector('#quick-video-loop-band');
  let bounds = null;
  let frame = 0;

  function point(value) {
    return Number(value.toFixed(3));
  }

  function stop() {
    bounds = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    band.hidden = true;
    apply.textContent = '开始循环';
    apply.setAttribute('aria-pressed','false');
    toggle.removeAttribute('data-loop-active');
  }

  function reset() {
    stop();
    toggle.disabled = true;
    toggle.setAttribute('aria-expanded','false');
    panel.hidden = true;
    start.value = '';
    end.value = '';
    status.textContent = '';
  }

  function monitor() {
    frame = 0;
    if (!bounds || video.paused) return;
    if (!video.seeking && (video.currentTime >= bounds.end || video.currentTime < bounds.start - .01)) {
      video.currentTime = bounds.start;
    }
    frame = requestAnimationFrame(monitor);
  }

  function onPlay() {
    if (bounds && !video.seeking &&
        (video.currentTime < bounds.start || video.currentTime >= bounds.end)) video.currentTime = bounds.start;
    if (bounds && !frame) frame = requestAnimationFrame(monitor);
  }

  function openPanel(show) {
    panel.hidden = !show;
    toggle.setAttribute('aria-expanded',String(show));
    if (!show) return;
    if (!start.value && !end.value) {
      const from = Math.min(video.currentTime,Math.max(0,video.duration - 2));
      start.value = point(from);
      end.value = point(Math.min(video.duration,from + 2));
    }
  }

  toggle.addEventListener('click',() => openPanel(panel.hidden));
  panel.addEventListener('click',event => {
    const control = event.target.closest('[data-loop-set]');
    if (!control) return;
    stop();
    (control.dataset.loopSet === 'start' ? start : end).value = point(video.currentTime);
    status.textContent = '';
  });
  for (const input of [start,end]) input.addEventListener('input',() => {
    stop();
    status.textContent = '';
  });
  apply.addEventListener('click',() => {
    if (bounds) {
      stop();
      status.textContent = '';
      return;
    }
    const from = start.valueAsNumber;
    const to = end.valueAsNumber;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > video.duration + .001 || to - from < .025) {
      status.textContent = '请选择视频范围内的起点和终点，终点应晚于起点。';
      return;
    }
    bounds = {start:from,end:Math.min(to,video.duration)};
    band.style.left = 100 * from / video.duration + '%';
    band.style.width = 100 * (bounds.end - from) / video.duration + '%';
    band.hidden = false;
    apply.textContent = '停止循环';
    apply.setAttribute('aria-pressed','true');
    toggle.setAttribute('data-loop-active','');
    status.textContent = formatTime(from) + '–' + formatTime(bounds.end) + ' · ' + (bounds.end - from).toFixed(2) + ' 秒';
    video.currentTime = from;
    video.play().catch(() => { status.textContent = '区间已设定，点击播放开始循环。'; });
  });
  panel.addEventListener('keydown',event => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.stopPropagation();
      event.preventDefault();
      openPanel(false);
      toggle.focus({preventScroll:true});
    }
  });
  video.addEventListener('loadedmetadata',() => {
    if (!Number.isFinite(video.duration) || video.duration < .025) return;
    toggle.disabled = false;
    for (const input of [start,end]) input.max = point(video.duration);
  });
  video.addEventListener('play',onPlay);
  video.addEventListener('pause',() => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  });
  video.addEventListener('ended',() => {
    if (!bounds) return;
    video.currentTime = bounds.start;
    video.play().catch(() => {});
  });
  video.addEventListener('emptied',reset);
  player.closest('dialog').addEventListener('close',reset);
}
