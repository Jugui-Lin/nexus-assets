const hoverDelay = 115;
const seekInterval = 85;
const resumeDelay = 230;

export function initVideoHoverPreview({grid, canPreview, source, isBlocked}) {
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
  }

  function stop() {
    if (!active) return;
    const session = active;
    active = null;
    release(session);
  }

  function playingSession(session) {
    return active === session && !session.failed && session.thumb.isConnected && !isBlocked();
  }

  function fail(session) {
    if (active !== session) return;
    session.failed = true;
    release(session);
  }

  function showProgress(session, ratio) {
    if (Number.isFinite(ratio)) session.layer?.style.setProperty('--video-hover-progress', Math.min(1, Math.max(0, ratio)));
  }

  function playIfIdle(session) {
    const video = session.video;
    if (playingSession(session) && video && video.paused && !video.seeking &&
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
      playIfIdle(session);
    }, wait);
  }

  async function start(session) {
    if (active !== session) return;
    if (!playingSession(session)) return stop();
    try {
      session.loadTimer = setTimeout(() => fail(session), 8_000);
      const url = await source(session.id);
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
      video.loop = true;
      video.disablePictureInPicture = true;
      const progress = document.createElement('span');
      progress.className = 'video-hover-progress';
      layer.append(video, progress);
      session.thumb.querySelector('.format-badge').before(layer);
      Object.assign(session, {video, layer, events:new AbortController()});
      const {signal} = session.events;
      video.addEventListener('loadedmetadata', () => seekLatest(session), {signal});
      video.addEventListener('loadeddata', () => {
        if (!playingSession(session)) return;
        clearTimeout(session.loadTimer);
        layer.classList.remove('hidden');
        playIfIdle(session);
      }, {signal, once:true});
      video.addEventListener('seeked', () => {
        seekLatest(session);
        playIfIdle(session);
      }, {signal});
      video.addEventListener('timeupdate', () => {
        if (!session.resumeTimer && session.target === null && !video.seeking) {
          showProgress(session, video.currentTime / video.duration);
        }
      }, {signal});
      video.addEventListener('error', () => fail(session), {signal, once:true});
      video.src = url;
      playIfIdle(session);
    } catch {
      fail(session);
    }
  }

  function followPointer(event) {
    const thumb = event.target.closest('.card-thumb');
    const id = thumb?.closest('[data-video-hover]')?.dataset.id;
    if (event.pointerType !== 'mouse' || event.buttons || !id || event.target.closest('button') ||
        isBlocked() || !canPreview(id)) return stop();
    if (active?.thumb !== thumb) {
      stop();
      const session = {thumb, id, x:event.clientX, target:null, lastSeek:-Infinity};
      active = session;
      session.startTimer = setTimeout(() => start(session), hoverDelay);
      return;
    }
    const session = active;
    if (session.failed || event.type !== 'pointermove' || Math.abs(event.clientX - session.x) < 2) return;
    session.x = event.clientX;
    const {left, width} = thumb.getBoundingClientRect();
    if (!width) return;
    session.target = Math.min(1, Math.max(0, (event.clientX - left) / width));
    session.video?.pause();
    showProgress(session, session.target);
    clearTimeout(session.resumeTimer);
    session.resumeTimer = setTimeout(() => {
      session.resumeTimer = null;
      playIfIdle(session);
    }, resumeDelay);
    seekLatest(session);
  }

  grid.addEventListener('pointerover', followPointer);
  grid.addEventListener('pointermove', followPointer);
  grid.addEventListener('pointerout', event => {
    if (active?.thumb.contains(event.target) && !active.thumb.contains(event.relatedTarget)) stop();
  });
  for (const event of ['pointerdown', 'pointercancel', 'dragstart', 'contextmenu']) {
    grid.addEventListener(event, stop, {capture:true});
  }
  grid.closest('#browser-scroll').addEventListener('scroll', stop, {passive:true});
  document.addEventListener('focusin', event => { if (event.target.closest('dialog')) stop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('blur', stop);
  return {stop};
}
