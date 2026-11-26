import {readReviewNotes} from './whiteboard-review-notes.js';

const clipTag = /\n\[nexus-video-clip:v1:(\d+(?:\.\d{1,3})?):(\d+(?:\.\d{1,3})?)\]$/;

export function videoClipRange(start,end,duration = Infinity) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + .001) return null;
  const from = Math.round(start * 1000);
  const to = Math.round(Math.min(end,duration) * 1000);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) return null;
  return {start:from/1000,end:to/1000};
}

export function readVideoClip(text = '') {
  const body = readReviewNotes(text).text;
  const match = clipTag.exec(body);
  const range = match && videoClipRange(Number(match[1]),Number(match[2]));
  return {text:range ? body.slice(0,match.index) : body,range};
}

export function writeVideoClip(title,range) {
  const validated = videoClipRange(range?.start,range?.end);
  return validated ? readVideoClip(title).text.trim().slice(0,1800) +
    `\n[nexus-video-clip:v1:${validated.start.toFixed(3)}:${validated.end.toFixed(3)}]` : '';
}
