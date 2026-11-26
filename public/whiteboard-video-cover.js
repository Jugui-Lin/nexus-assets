const coverTag = /\n\[nexus-video-cover:v1:(\d+(?:\.\d{1,3})?)\]$/;

export function readVideoCover(text = '') {
  if (typeof text !== 'string') return {title:'', time:null};
  const match = coverTag.exec(text);
  const time = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(Math.round(time * 1000))
    ? {title:text.slice(0,match.index), time}
    : {title:text, time:null};
}

export function writeVideoCover(text, time) {
  return readVideoCover(text).title.slice(0, 1970) + '\n[nexus-video-cover:v1:' + time.toFixed(3) + ']';
}

export function copyVideoFrame(video, canvas = document.createElement('canvas')) {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
  const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, width, height);
    return canvas;
  } catch {
    return null;
  }
}

export function videoFrameUrl(canvas) {
  try { return canvas?.toDataURL('image/webp', .82); } catch { return null; }
}

function waitForFrame(video, event, change, signal, deadline) {
  return new Promise((resolve, reject) => {
    function done(error) {
      clearTimeout(timeout);
      video.removeEventListener(event, loaded);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', failed);
      if (error) reject(error);
      else resolve();
    }
    const loaded = () => done();
    const failed = () => done(Error('无法读取封面帧'));
    const timeout = setTimeout(failed, Math.max(0, deadline - performance.now()));
    video.addEventListener(event, loaded);
    video.addEventListener('error', failed);
    if (signal.aborted) return failed();
    signal.addEventListener('abort', failed, {once:true});
    try { change(); } catch (error) { done(error); }
  });
}

export async function loadVideoCoverFrame(playback, time, signal) {
  const media = await playback();
  const sources = [...new Set([media?.url, media?.fallbackUrl].filter(Boolean))];
  for (const [index, url] of sources.entries()) {
    if (signal.aborted) return null;
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    const deadline = performance.now() + (index === 0 && sources.length > 1 ? 5000 : 8000);
    try {
      await waitForFrame(video,'loadeddata',() => { video.src = url; },signal,deadline);
      const seconds = Number.isFinite(video.duration) ? Math.min(time,Math.max(0,video.duration - .05)) : time;
      if (seconds > .01) await waitForFrame(video,'seeked',() => { video.currentTime = seconds; },signal,deadline);
      const previewUrl = videoFrameUrl(copyVideoFrame(video));
      if (previewUrl) return previewUrl;
    } catch {
      // The reference can expose both its range stream and the local asset protocol.
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }
  return null;
}
