export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

function setAction(button, glyph, label, shortcut) {
  button.querySelector('use').setAttribute('href', `#i-${glyph}`);
  button.setAttribute('aria-label', label);
  button.title = `${label}（${shortcut}）`;
}

export function initVideoControls(player, video) {
  const stage = player.closest('.quick-preview-stage');
  const controls = player.querySelector('#quick-video-controls');
  const seek = controls.querySelector('#quick-video-seek');
  const play = controls.querySelector('#quick-video-play');
  const elapsed = controls.querySelector('#quick-video-elapsed');
  const durationLabel = controls.querySelector('#quick-video-duration');
  const buffered = controls.querySelector('#quick-video-buffered');
  const mute = controls.querySelector('#quick-video-mute');
  const volume = controls.querySelector('#quick-video-volume');
  const speed = controls.querySelector('#quick-video-speed');
  const fullscreen = controls.querySelector('#quick-video-fullscreen');
  let scrubbing = false;
  let lastVolume = video.volume || 1;

  const seekableDuration = () => Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;

  function syncTime() {
    const duration = seekableDuration();
    seek.disabled = !duration;
    seek.max = String(duration);
    if (!scrubbing) seek.value = String(video.currentTime);
    const time = duration ? seek.valueAsNumber : 0;
    elapsed.textContent = formatTime(time);
    durationLabel.textContent = duration ? formatTime(duration) : '--:--';
    seek.setAttribute('aria-valuetext', duration ? `${elapsed.textContent} / ${durationLabel.textContent}` : '尚无可用进度');
    controls.style.setProperty('--video-played', String(duration ? time / duration : 0));
  }

  function syncBuffered() {
    const duration = seekableDuration();
    const segments = [];
    if (duration) {
      const ranges = video.buffered;
      for (let index = 0; index < ranges.length; index++) {
        const start = ranges.start(index) / duration;
        const end = Math.min(1, ranges.end(index) / duration);
        const segment = document.createElement('span');
        segment.style.left = `${start * 100}%`;
        segment.style.width = `${(end - start) * 100}%`;
        segments.push(segment);
      }
    }
    buffered.replaceChildren(...segments);
  }

  function syncPlay() {
    play.disabled = !video.hasAttribute('src') || Boolean(video.error);
    if (video.ended) setAction(play, 'media-replay', '重播', '空格');
    else if (video.paused) setAction(play, 'media-play', '播放', '空格');
    else setAction(play, 'media-pause', '暂停', '空格');
  }

  function syncVolume() {
    if (video.volume > 0) lastVolume = video.volume;
    volume.value = String(Math.round(video.volume * 100));
    volume.setAttribute('aria-valuetext', `${volume.value}%`);
    const silent = video.muted || video.volume === 0;
    setAction(mute, silent ? 'media-muted' : 'media-volume', silent ? '取消静音' : '静音', 'M');
  }

  function syncFullscreen() {
    const expanded = document.fullscreenElement === stage;
    fullscreen.disabled = !document.fullscreenEnabled || typeof stage.requestFullscreen !== 'function';
    setAction(fullscreen, expanded ? 'media-exit-fullscreen' : 'expand', expanded ? '退出全屏' : '全屏', 'F');
  }

  function togglePlay() {
    if (play.disabled) return;
    if (!video.paused && !video.ended) {
      video.pause();
      return;
    }
    if (video.ended) video.currentTime = 0;
    video.play().catch(() => {});
  }

  function setTime(seconds) {
    const duration = seekableDuration();
    if (duration) video.currentTime = Math.max(0, Math.min(duration, seconds));
    syncTime();
  }

  function toggleMute() {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = lastVolume;
    } else video.muted = true;
  }

  function toggleFullscreen() {
    if (fullscreen.disabled) return;
    const transition = document.fullscreenElement === stage ? document.exitFullscreen() : stage.requestFullscreen();
    transition.catch(() => {});
  }

  for (const event of ['play', 'pause', 'ended', 'loadstart', 'error', 'emptied']) video.addEventListener(event, syncPlay);
  for (const event of ['loadedmetadata', 'durationchange', 'emptied', 'seeked']) {
    video.addEventListener(event, syncTime);
    video.addEventListener(event, syncBuffered);
  }
  video.addEventListener('timeupdate', syncTime);
  video.addEventListener('progress', syncBuffered);
  video.addEventListener('volumechange', syncVolume);
  video.addEventListener('ratechange', () => { speed.value = String(video.playbackRate); });
  document.addEventListener('fullscreenchange', syncFullscreen);
  play.addEventListener('click', togglePlay);
  video.addEventListener('click', () => {
    play.focus({preventScroll:true});
    togglePlay();
  });
  seek.addEventListener('input', () => {
    scrubbing = true;
    syncTime();
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    setTime(seek.valueAsNumber);
  });
  for (const event of ['blur', 'pointercancel']) seek.addEventListener(event, () => {
    scrubbing = false;
    syncTime();
  });
  mute.addEventListener('click', toggleMute);
  volume.addEventListener('input', () => {
    video.muted = false;
    video.volume = volume.valueAsNumber / 100;
  });
  speed.addEventListener('change', () => {
    video.defaultPlaybackRate = Number(speed.value);
    video.playbackRate = video.defaultPlaybackRate;
  });
  fullscreen.addEventListener('click', toggleFullscreen);
  play.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const action = {
      ' ': togglePlay,
      k: togglePlay,
      arrowleft: () => setTime(video.currentTime - 5),
      arrowright: () => setTime(video.currentTime + 5),
      m: toggleMute,
      f: toggleFullscreen,
    }[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    action();
  });

  syncVolume();
  syncFullscreen();
  return {
    refresh: syncPlay,
    togglePlay,
    reset() {
      scrubbing = false;
      syncPlay();
      syncTime();
      syncBuffered();
      if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
    },
  };
}
