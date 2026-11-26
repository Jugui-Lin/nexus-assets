import {formatTime} from './video-controls.js';

const hoverDelay = 115;
const seekInterval = 85;
const resumeDelay = 230;

export function initVideoHoverPreview({grid, canPreview, source, isBlocked, scrub}) {
  let active = null;

  function release(session) {
    clearTimeout(session.startTimer);
    clearTimeout(session.loadTimer);
    clearTimeout(session.seekTimer);
    clearTimeout(session.resumeTimer);
    session.events?.abort();
    if (session.video) {
      session.video.pause();
      session.video.removeAttribute('src');
      session.video.load();
    }
    session.layer?.remove();
    session.guide?.remove();
  }

  function stop() {
    if (!active) return;
    const session = active;
    active = null;
    const frame = scrub?.leave(session.thumb);
    release(session);
    return {thumb:session.thumb,frame};
  }

  function playingSession(session) {
    return active === session && !session.failed && session.thumb.isConnected &&
      !isBlocked() && (!scrub || canPreview(session.id));
  }

  function fail(session) {
    if (active !== session) return;
    session.failed = true;
    release(session);
  }

  function showProgress(session, ratio) {
    if (!Number.isFinite(ratio)) return;
    (session.guide || session.layer)?.style.setProperty('--video-hover-progress', Math.min(1, Math.max(0, ratio)));
    const duration = session.video?.duration;
    if (session.time && Number.isFinite(duration) && duration > 0) session.time.textContent = formatTime(ratio * duration);
  }

  function showScrubFrame(session) {
    if (!scrub || !playingSession(session) || session.video.readyState < 2 || session.video.seeking ||
        session.seekTimer || session.target !== null) return;
    clearTimeout(session.loadTimer);
    session.layer.classList.remove('hidden');
    session.guide.classList.remove('hidden');
    if (session.frameTime !== session.video.currentTime) {
      session.frameTime = session.video.currentTime;
      scrub.frame(session.thumb, session.video);
    }
  }

  function playIfIdle(session) {
    const video = session.video;
    if (!scrub && playingSession(session) && video && video.paused && !video.seeking &&
        session.target === null && !session.resumeTimer) {
      video.play().catch(() => {});
    }
  }

  function seekLatest(session) {
    const video = session.video;
    if (!playingSession(session) || !video || !video.readyState || video.seeking ||
        session.seekTimer || session.target === null) return;
    const wait = Math.max(0, seekInterval - (performance.now() - session.lastSeek));
    session.seekTimer = setTimeout(() => {
      session.seekTimer = null;
      if (!playingSession(session) || video.seeking || session.target === null) return;
      const ratio = session.target;
      session.target = null;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const end = Math.max(0, video.duration - .05);
        const time = Math.min(end, ratio * video.duration);
        if (Math.abs(video.currentTime - time) >= .025) {
          try {
            video.currentTime = time;
            session.lastSeek = performance.now();
          } catch {
            // Leave the current frame available if the stream cannot seek yet.
          }
        }
      }
      showScrubFrame(session);
      playIfIdle(session);
    }, wait);
  }

  async function start(session) {
    if (active !== session) return;
    if (!playingSession(session)) return stop();
    try {
      session.loadTimer = setTimeout(() => fail(session), 8_000);
      const media = await source(session.id);
      if (active !== session || session.failed) return;
      if (!playingSession(session)) return stop();

      const layer = document.createElement('div');
      layer.className = 'video-hover-preview hidden';
      layer.setAttribute('aria-hidden', 'true');
      const video = document.createElement('video');
      video.preload = 'auto';
      video.defaultMuted = true;
      video.muted = true;
      video.playsInline = true;
      if (scrub) video.crossOrigin = 'anonymous';
      video.loop = !scrub;
      video.disablePictureInPicture = true;
      const progress = document.createElement('span');
      progress.className = 'video-hover-progress';
      if (scrub) {
        const guide = document.createElement('div');
        guide.className = 'whiteboard-video-hover-guide hidden';
        guide.setAttribute('aria-hidden', 'true');
        const time = document.createElement('span');
        time.className = 'whiteboard-video-hover-time';
        guide.append(progress, time);
        layer.append(video);
        scrub.mount(session.thumb, layer, video, guide);
        Object.assign(session, {guide, time});
      } else {
        layer.append(video, progress);
        session.thumb.querySelector('.format-badge').before(layer);
      }
      Object.assign(session, {video, layer, events:new AbortController()});
      const {signal} = session.events;
      video.addEventListener('loadedmetadata', () => {
        if (scrub) showProgress(session, session.ratio);
        seekLatest(session);
      }, {signal});
      video.addEventListener('loadeddata', () => {
        if (!playingSession(session)) return;
        if (scrub) showScrubFrame(session);
        else {
          clearTimeout(session.loadTimer);
          layer.classList.remove('hidden');
          playIfIdle(session);
        }
      }, {signal});
      video.addEventListener('seeked', () => {
        seekLatest(session);
        showScrubFrame(session);
        playIfIdle(session);
      }, {signal});
      video.addEventListener('timeupdate', () => {
        if (!scrub && !session.resumeTimer && session.target === null && !video.seeking) {
          showProgress(session, video.currentTime / video.duration);
        }
      }, {signal});
      const urls = [...new Set((typeof media === 'string' ? [media] : [media?.url, media?.fallbackUrl]).filter(Boolean))];
      const trySource = () => {
        if (!playingSession(session) || !urls.length) return fail(session);
        layer.classList.add('hidden');
        session.guide?.classList.add('hidden');
        if (scrub) session.target = session.ratio;
        video.src = urls.shift();
      };
      video.addEventListener('error', trySource, {signal});
      trySource();
      playIfIdle(session);
    } catch {
      fail(session);
    }
  }

  function beginPreview(thumb, id, event) {
    const ratio = scrub ? Math.min(1, Math.max(0, scrub.ratio(thumb, event))) : null;
    const session = {thumb, id, x:event.clientX, y:event.clientY, ratio, target:ratio, lastSeek:-Infinity};
    active = session;
    session.startTimer = setTimeout(() => start(session), hoverDelay);
  }

  function followPointer(event) {
    if (scrub && !active) return;
    const thumb = scrub ? scrub.target(event.target) : event.target.closest('.card-thumb');
    const id = scrub ? thumb : thumb?.closest('[data-video-hover]')?.dataset.id;
    if (event.pointerType !== 'mouse' || event.buttons || !id || event.target.closest('button') ||
        isBlocked() || !canPreview(id)) return stop();
    if (active?.thumb !== thumb) {
      stop();
      if (!scrub) beginPreview(thumb,id,event);
      return;
    }
    const session = active;
    if (session.failed || event.type !== 'pointermove' || (Math.abs(event.clientX - session.x) < 2 &&
        (!scrub || Math.abs(event.clientY - session.y) < 2))) return;
    session.x = event.clientX;
    session.y = event.clientY;
    let ratio;
    if (scrub) ratio = scrub.ratio(thumb, event);
    else {
      const {left, width} = thumb.getBoundingClientRect();
      if (!width) return;
      ratio = (event.clientX - left) / width;
    }
    session.ratio = Math.min(1, Math.max(0, ratio));
    session.target = session.ratio;
    session.video?.pause();
    showProgress(session, session.target);
    if (!scrub) {
      clearTimeout(session.resumeTimer);
      session.resumeTimer = setTimeout(() => {
        session.resumeTimer = null;
        playIfIdle(session);
      }, resumeDelay);
    }
    seekLatest(session);
  }

  grid.addEventListener('pointerover', followPointer);
  grid.addEventListener('pointermove', followPointer);
  grid.addEventListener('pointerout', event => {
    if (active?.thumb.contains(event.target) && !active.thumb.contains(event.relatedTarget)) stop();
  });
  if (!scrub) grid.addEventListener('pointerdown', stop, {capture:true});
  for (const event of ['pointercancel', 'dragstart', 'contextmenu']) {
    grid.addEventListener(event, stop, {capture:true});
  }
  grid.closest('#browser-scroll')?.addEventListener('scroll', stop, {passive:true});
  document.addEventListener('focusin', event => { if (event.target.closest('dialog')) stop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('blur', stop);
  return {
    stop,
    stopFor(thumb) { if (active?.thumb === thumb) stop(); },
    previewAt(thumb, event) {
      if (!scrub || !thumb || event.pointerType !== 'mouse' || isBlocked() || !canPreview(thumb)) return;
      stop();
      beginPreview(thumb,thumb,event);
    },
  };
}
