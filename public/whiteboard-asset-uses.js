import {readReviewNotes} from './whiteboard-review-notes.js';
import {readVideoCover} from './whiteboard-video-cover.js';

const itemIdPattern = /^[a-z0-9_-]{1,64}$/i;

export function matchingWhiteboardAssetCards(items, assetId) {
  const matches = new Map();
  for (const item of items) {
    if (item?.assetId !== assetId || typeof item?.id !== 'string' || !itemIdPattern.test(item.id) || matches.has(item.id)) continue;
    const {title} = readVideoCover(readReviewNotes(item.text).text);
    matches.set(item.id, {itemId:item.id,cardTitle:title.replace(/\s+/g,' ').trim().slice(0,100)});
  }
  return [...matches.values()].map((match,index) => ({...match,position:index + 1,total:matches.size}));
}
