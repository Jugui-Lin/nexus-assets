const corners = {nw:[-1,-1],ne:[1,-1],sw:[-1,1],se:[1,1]};
const fullImage = [0,0,1,1];
const minResizeEdge = 16;
const maxEdge = 100_000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const coordinate = value => Math.round(clamp(value, -1_000_000, 1_000_000) * 10) / 10;
const length = value => Math.round(clamp(value, 1, maxEdge) * 10) / 10;

export function normalizeImageRotation(angle) {
  if (!Number.isFinite(angle)) return 0;
  if (angle >= -180 && angle < 180) return angle || 0;
  return ((angle % 360 + 540) % 360) - 180;
}

export function normalizeImageTransform(value) {
  const crop = value?.crop;
  const validCrop = Array.isArray(crop) && crop.length === 4 &&
    crop.every(edge => Number.isFinite(edge) && edge >= 0 && edge <= 1) &&
    crop[0] < crop[2] && crop[1] < crop[3];
  return {
    rotation:normalizeImageRotation(value?.rotation),
    flipX:value?.flipX === true,
    flipY:value?.flipY === true,
    crop:validCrop ? [...crop] : [...fullImage],
    opacity:Number.isFinite(value?.opacity) ? clamp(value.opacity, 0, 1) : 1,
  };
}

function rotateOffset(x, y, rotation) {
  const angle = rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {x:x * cosine - y * sine,y:x * sine + y * cosine};
}

function geometryAtOffset(item, width, height, dx, dy) {
  const offset = rotateOffset(dx, dy, normalizeImageRotation(item.imageTransform?.rotation));
  return {
    x:coordinate(item.x + item.width / 2 + offset.x - width / 2),
    y:coordinate(item.y + item.height / 2 + offset.y - height / 2),
    width,
    height,
  };
}

export function imageLocalPoint(item, worldX, worldY) {
  const offset = rotateOffset(worldX - item.x - item.width / 2, worldY - item.y - item.height / 2,
    -normalizeImageRotation(item.imageTransform?.rotation));
  return {x:offset.x / item.width + .5,y:offset.y / item.height + .5};
}

export function imageBounds(item) {
  const rotation = normalizeImageRotation(item.imageTransform?.rotation);
  const horizontal = rotateOffset(item.width / 2, 0, rotation);
  const vertical = rotateOffset(0, item.height / 2, rotation);
  const halfWidth = Math.abs(horizontal.x) + Math.abs(vertical.x);
  const halfHeight = Math.abs(horizontal.y) + Math.abs(vertical.y);
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  return {left:centerX - halfWidth,top:centerY - halfHeight,right:centerX + halfWidth,bottom:centerY + halfHeight};
}

function nearestEdgeOffset(start, end, neighborStart, neighborEnd, best, threshold) {
  const offsets = [neighborStart - start, neighborEnd - end, neighborStart - end, neighborEnd - start];
  for (const offset of offsets) {
    const distance = Math.abs(offset);
    if (distance <= threshold && (best === undefined || distance < Math.abs(best))) best = offset;
  }
  return best;
}

export function snapBoardMove(movingBounds, neighborBounds, dx, dy, threshold) {
  const left = movingBounds.left + dx;
  const right = movingBounds.right + dx;
  const top = movingBounds.top + dy;
  const bottom = movingBounds.bottom + dy;
  let horizontal, vertical;
  for (const neighbor of neighborBounds) {
    if (top <= neighbor.bottom + threshold && bottom >= neighbor.top - threshold) {
      horizontal = nearestEdgeOffset(left, right, neighbor.left, neighbor.right, horizontal, threshold);
    }
    if (left <= neighbor.right + threshold && right >= neighbor.left - threshold) {
      vertical = nearestEdgeOffset(top, bottom, neighbor.top, neighbor.bottom, vertical, threshold);
    }
  }
  return {dx:dx + (horizontal ?? 0),dy:dy + (vertical ?? 0)};
}

export function resizeImage(item, corner, dx, dy, {centered = false, free = false} = {}) {
  const [horizontal,vertical] = corners[corner];
  const offset = rotateOffset(dx, dy, -normalizeImageRotation(item.imageTransform?.rotation));
  const movementX = offset.x * horizontal * (centered ? 2 : 1);
  const movementY = offset.y * vertical * (centered ? 2 : 1);
  let width, height;
  if (free) {
    width = length(Math.max(item.width + movementX, Math.min(item.width, minResizeEdge)));
    height = length(Math.max(item.height + movementY, Math.min(item.height, minResizeEdge)));
  } else {
    const spanSquared = item.width ** 2 + item.height ** 2;
    const delta = (movementX * item.width + movementY * item.height) / spanSquared;
    const minimum = Math.min(1, minResizeEdge / Math.min(item.width, item.height));
    const maximum = maxEdge / Math.max(item.width, item.height);
    const scale = clamp(1 + delta, minimum, maximum);
    width = length(item.width * scale);
    height = length(item.height * scale);
  }
  const centerX = centered ? 0 : horizontal * (width - item.width) / 2;
  const centerY = centered ? 0 : vertical * (height - item.height) / 2;
  return geometryAtOffset(item, width, height, centerX, centerY);
}

export function cropImage(item, region) {
  if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)) return null;
  const [left,top,right,bottom] = region.map(edge => clamp(edge, 0, 1));
  const cropWidth = item.width * (right - left);
  const cropHeight = item.height * (bottom - top);
  if (!(cropWidth >= 1 && cropHeight >= 1) || (left === 0 && top === 0 && right === 1 && bottom === 1)) return null;

  const imageTransform = normalizeImageTransform(item.imageTransform);
  const [sourceLeft,sourceTop,sourceRight,sourceBottom] = imageTransform.crop;
  const sourceWidth = sourceRight - sourceLeft;
  const sourceHeight = sourceBottom - sourceTop;
  const [u0,u1] = imageTransform.flipX ? [1 - right, 1 - left] : [left,right];
  const [v0,v1] = imageTransform.flipY ? [1 - bottom, 1 - top] : [top,bottom];
  // The gesture follows the displayed orientation, while the stored crop samples the source image.
  const croppedLeft = clamp(sourceLeft + sourceWidth * u0, sourceLeft, sourceRight);
  const croppedTop = clamp(sourceTop + sourceHeight * v0, sourceTop, sourceBottom);
  const croppedRight = clamp(sourceLeft + sourceWidth * u1, sourceLeft, sourceRight);
  const croppedBottom = clamp(sourceTop + sourceHeight * v1, sourceTop, sourceBottom);
  if (croppedLeft >= croppedRight || croppedTop >= croppedBottom) return null;
  imageTransform.crop = [croppedLeft,croppedTop,croppedRight,croppedBottom];
  const centerX = item.width * ((left + right) / 2 - .5);
  const centerY = item.height * ((top + bottom) / 2 - .5);
  return {...geometryAtOffset(item, length(cropWidth), length(cropHeight), centerX, centerY), imageTransform};
}

export function resetImageCrop(item) {
  const imageTransform = normalizeImageTransform(item.imageTransform);
  const [left,top,right,bottom] = imageTransform.crop;
  if (left === 0 && top === 0 && right === 1 && bottom === 1) return null;

  const visibleWidth = right - left;
  const visibleHeight = bottom - top;
  const fit = Math.min(1, maxEdge * visibleWidth / item.width, maxEdge * visibleHeight / item.height);
  const width = length(fit * item.width / visibleWidth);
  const height = length(fit * item.height / visibleHeight);
  const centerX = width * (.5 - (left + right) / 2) * (imageTransform.flipX ? -1 : 1);
  const centerY = height * (.5 - (top + bottom) / 2) * (imageTransform.flipY ? -1 : 1);
  imageTransform.crop = [...fullImage];
  return {...geometryAtOffset(item, width, height, centerX, centerY), imageTransform};
}
