import {formatTime} from './video-controls.js';

const tolerance = .06;
const formatPosition = seconds => `${formatTime(seconds)}.${String(Math.floor(seconds * 100) % 100).padStart(2,'0')}`;

export function initAssetVideoCompare(dialog, readSource) {
  dialog.insertAdjacentHTML('beforeend',`<section class="asset-video-compare" aria-label="双视频同步对照" hidden>
    <div class="asset-video-compare-names"><span data-video-name="A"></span><span data-video-name="B"></span></div>
    <div class="asset-video-compare-stage" data-mode="wipe">
      <video preload="auto" muted playsinline></video><video preload="auto" muted playsinline></video>
      <span class="asset-video-compare-divider" aria-hidden="true"></span>
    </div>
    <div class="asset-video-compare-controls">
      <button type="button" class="button subtle" data-compare-play disabled>播放</button>
      <input type="range" data-compare-time min="0" max="0" step=".01" value="0" aria-label="共同时间轴" disabled>
      <output data-compare-position></output>
    </div>
    <div class="asset-video-compare-options">
      <label>显示<select data-compare-mode><option value="wipe">分隔线</option><option value="side">并排</option></select></label>
      <label data-compare-wipe-label>分隔位置<input type="range" data-compare-wipe min="0" max="100" value="50" aria-label="分隔位置"></label>
      <label>声音<select data-compare-audio><option value="muted">静音</option><option value="0">A</option><option value="1">B</option></select></label>
    </div>
    <p class="asset-video-compare-status" role="status"></p>
  </section>`);
  const root = dialog.querySelector('.asset-video-compare');
  const find = selector => root.querySelector(selector);
  const stage = find('.asset-video-compare-stage');
  const videos = [...stage.querySelectorAll('video')];
  const [leader,follower] = videos;
  const play = find('[data-compare-play]');
  const timeline = find('[data-compare-time]');
  const position = find('[data-compare-position]');
  const mode = find('[data-compare-mode]');
  const wipe = find('[data-compare-wipe]');
  const audio = find('[data-compare-audio]');
  const status = find('[role="status"]');
  let current;
  let animation;
  let dividerDrag;

  function setWipe(percent) {
    const value = Math.round(Math.min(100,Math.max(0,percent)));
    wipe.value = String(value);
    stage.style.setProperty('--video-wipe',`${value}%`);
    wipe.setAttribute('aria-valuetext',`左侧 A ${value}%，右侧 B ${100-value}%`);
  }

  function syncControls(session = current) {
    const ready = Boolean(session?.length && !session.error);
    play.disabled = timeline.disabled = !ready;
    play.textContent = session?.playing ? '暂停' : '播放';
    timeline.max = String(session?.length || 0);
    if (!session?.scrubbing) timeline.value = String(Math.min(leader.currentTime,session?.length || 0));
    position.textContent = ready ? `${formatPosition(timeline.valueAsNumber)} / ${formatPosition(session.length)}` : '—';
    timeline.setAttribute('aria-valuetext',position.textContent);
  }

  function syncStatus(session) {
    if (session.error) status.textContent = session.error;
    else if (!session.length) status.textContent = '正在加载两版视频…';
    else if (session.waiting) status.textContent = '正在缓冲，已暂停两版以保持对齐…';
    else if (Math.abs(leader.duration - follower.duration) > .01) {
      status.textContent = `A ${formatPosition(leader.duration)} · B ${formatPosition(follower.duration)} · 同步范围取较短版本`;
    } else status.textContent = '';
  }

  function pauseMedia() {
    for (const video of videos) video.pause();
    follower.playbackRate = 1;
    cancelAnimationFrame(animation);
    animation = 0;
  }

  function seekBoth(session,time) {
    const target = Math.min(session.length,Math.max(0,time));
    for (const video of videos) if (Math.abs(video.currentTime - target) >= .001) video.currentTime = target;
    syncControls(session);
  }

  function stop(session,time = leader.currentTime) {
    session.playing = session.waiting = false;
    pauseMedia();
    if (session.length) seekBoth(session,time);
    syncStatus(session);
  }

  function fail(session,message) {
    session.error = message;
    stop(session);
    syncControls(session);
  }

  function monitor() {
    animation = 0;
    const session = current;
    if (!session?.playing || session.scrubbing || session.waiting || leader.paused || follower.paused) return;
    if (leader.currentTime >= session.length - .002 || follower.currentTime >= session.length - .002) {
      stop(session,session.length);
      return;
    }
    if (!leader.seeking && !follower.seeking) {
      const difference = leader.currentTime - follower.currentTime;
      if (Math.abs(difference) > tolerance && !session.starting) follower.currentTime = leader.currentTime;
      else follower.playbackRate = Math.max(.96,Math.min(1.04,1 + difference * .6));
    }
    syncControls(session);
    animation = requestAnimationFrame(monitor);
  }

  function readyToPlay(session) {
    if (session !== current || !session.playing || session.scrubbing || session.starting ||
        videos.some(video => video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)) return;
    if (Math.abs(leader.currentTime - follower.currentTime) > tolerance) {
      follower.currentTime = leader.currentTime;
      return;
    }
    session.waiting = false;
    syncStatus(session);
    const transition = Promise.all(videos.map(video => video.play()));
    session.starting = transition;
    transition.then(() => {
      if (session === current && session.playing && !animation) animation = requestAnimationFrame(monitor);
    }).catch(failure => {
      if (session === current && session.playing && !session.scrubbing && failure?.name !== 'AbortError') {
        fail(session,'无法开始同步播放 · ' + (failure?.message || failure));
      }
    }).finally(() => {
      if (session.starting === transition) session.starting = null;
      if (session === current && session.waiting && !session.scrubbing) readyToPlay(session);
    });
  }

  function togglePlay() {
    const session = current;
    if (!session?.length || session.error) return;
    if (session.playing) { stop(session); return; }
    if (leader.currentTime >= session.length - .002) seekBoth(session,0);
    session.playing = true;
    session.waiting = true;
    syncControls(session);
    syncStatus(session);
    readyToPlay(session);
  }

  function refreshMetadata(session) {
    if (session.error || videos.some(video => !video.videoWidth || !Number.isFinite(video.duration) || video.duration <= 0)) return;
    session.length = Math.min(...videos.map(video => video.duration));
    clearTimeout(session.timer);
    stage.style.setProperty('--video-compare-ratio',`${leader.videoWidth}/${leader.videoHeight}`);
    syncControls(session);
    syncStatus(session);
  }

  for (const [index,video] of videos.entries()) {
    for (const event of ['loadedmetadata','durationchange']) video.addEventListener(event,() => current && refreshMetadata(current));
    for (const event of ['canplay','seeked']) video.addEventListener(event,() => {
      if (!current) return;
      if (current.playing && (current.waiting || videos.some(item => item.paused))) readyToPlay(current);
      else syncControls(current);
    });
    video.addEventListener('waiting',() => {
      const session = current;
      if (!session?.playing || session.scrubbing || session.waiting || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
      pauseMedia();
      session.waiting = true;
      syncStatus(session);
    });
    video.addEventListener('ended',() => { if (current?.playing) stop(current,current.length); });
    video.addEventListener('error',() => {
      const session = current;
      if (session && video.getAttribute('src') && video.error) fail(session,`${session.items[index].name} 无法解码或读取`);
    });
  }

  function close() {
    if (current) clearTimeout(current.timer);
    current = null;
    pauseMedia();
    for (const video of videos) {
      video.removeAttribute('src');
      video.load();
    }
    dividerDrag = null;
    root.hidden = true;
  }

  async function open(items) {
    close();
    const session = {items,length:0,playing:false,waiting:false,scrubbing:false};
    current = session;
    root.hidden = false;
    mode.value = stage.dataset.mode = 'wipe';
    find('[data-compare-wipe-label]').hidden = false;
    audio.value = 'muted';
    setWipe(50);
    syncControls(session);
    syncStatus(session);
    for (const [index,video] of videos.entries()) {
      video.muted = true;
      const letter = index ? 'B' : 'A';
      const item = items[index];
      const label = find(`[data-video-name="${letter}"]`);
      label.textContent = label.title = `${letter} · ${item.name}`;
      video.setAttribute('aria-label',label.textContent);
    }
    session.timer = setTimeout(() => {
      if (session === current && !session.length && !session.error) fail(session,'等待视频超时，请检查文件或共享目录连接');
    },20000);
    await Promise.all(items.map(async (item,index) => {
      try {
        const source = await readSource(item);
        if (session !== current || session.error) return;
        if (!source) throw Error('没有可用的视频流');
        videos[index].src = source;
      } catch (failure) {
        if (session === current) fail(session,`${item.name} · ${failure?.message || failure}`);
      }
    }));
  }

  play.addEventListener('click',togglePlay);
  timeline.addEventListener('input',() => {
    const session = current;
    if (!session?.length || session.error) return;
    session.scrubbing = true;
    pauseMedia();
    seekBoth(session,timeline.valueAsNumber);
  });
  function commitTime() {
    const session = current;
    if (!session?.scrubbing) return;
    session.scrubbing = false;
    if (session.playing) {
      session.waiting = true;
      readyToPlay(session);
    }
  }
  for (const event of ['change','pointercancel','blur']) timeline.addEventListener(event,commitTime);
  mode.addEventListener('change',() => {
    stage.dataset.mode = mode.value;
    find('[data-compare-wipe-label]').hidden = mode.value !== 'wipe';
  });
  audio.addEventListener('change',() => {
    for (const [index,video] of videos.entries()) video.muted = audio.value !== String(index);
  });
  wipe.addEventListener('input',() => setWipe(wipe.valueAsNumber));
  function moveDivider(event) {
    const {left,width} = stage.getBoundingClientRect();
    if (width) setWipe((event.clientX-left)/width*100);
  }
  stage.addEventListener('pointerdown',event => {
    if (mode.value !== 'wipe' || event.button !== 0) return;
    dividerDrag = event.pointerId;
    stage.setPointerCapture(dividerDrag);
    moveDivider(event);
  });
  stage.addEventListener('pointermove',event => { if (dividerDrag === event.pointerId) moveDivider(event); });
  stage.addEventListener('lostpointercapture',() => { dividerDrag = null; });
  root.addEventListener('keydown',event => {
    if (event.key.toLowerCase() !== 'k' || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    event.preventDefault();
    togglePlay();
  });
  return {open,close};
}
