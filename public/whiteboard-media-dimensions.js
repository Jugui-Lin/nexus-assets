const cachedDimensions = new WeakMap();

function dimensions(width, height) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? {width,height} : null;
}

async function imageDimensions(image) {
  if (!image.naturalWidth) await image.decode().catch(() => {});
  return dimensions(image.naturalWidth,image.naturalHeight);
}

function videoDimensionsAt(url, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(null); return; }
    const video = document.createElement('video');
    const finish = value => {
      signal.removeEventListener('abort',cancel);
      video.onloadedmetadata = video.onerror = null;
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    const cancel = () => finish(null);
    signal.addEventListener('abort',cancel,{once:true});
    video.onloadedmetadata = () => finish(dimensions(video.videoWidth,video.videoHeight));
    video.onerror = cancel;
    video.preload = 'metadata';
    video.src = url;
  });
}

async function assetDimensions(asset, reference, image, signal) {
  const cached = cachedDimensions.get(asset);
  if (cached) return cached;
  let size;
  if (asset.kind === 'video') {
    size = dimensions(reference?.video.videoWidth,reference?.video.videoHeight);
    if (!size) {
      const source = await asset.playback();
      for (const url of [source?.url,source?.fallbackUrl].filter(Boolean)) {
        size = await videoDimensionsAt(url,signal);
        if (size || signal.aborted) break;
      }
    }
  } else {
    const nativeSize = await asset.dimensions?.();
    if (signal.aborted) return null;
    size = dimensions(nativeSize?.width,nativeSize?.height);
    if (!size && (image?.getAttribute('src') || asset.url)) {
      const preview = image?.getAttribute('src') ? image : new Image();
      if (!preview.getAttribute('src')) preview.src = asset.url;
      size = await imageDimensions(preview);
    }
  }
  if (size && !signal.aborted) cachedDimensions.set(asset,size);
  return size;
}

export function readWhiteboardMediaDimensions({item,node,videoReference,resolveAssetImage,imageUrl,signal}) {
  const timeout = AbortSignal.timeout(8_000);
  const request = signal ? AbortSignal.any([signal,timeout]) : timeout;
  if (request.aborted) return Promise.resolve(null);
  const read = async () => {
    const image = node?.querySelector('img.whiteboard-image');
    if (item.assetId) {
      const asset = videoReference?.asset || node?.whiteboardAsset || await resolveAssetImage();
      return asset && !request.aborted ? assetDimensions(asset,videoReference,image,request) : null;
    }
    if (image?.getAttribute('src')) return imageDimensions(image);
    const url = await imageUrl();
    try {
      if (request.aborted) return null;
      const original = new Image();
      original.src = url;
      return await imageDimensions(original);
    } finally { URL.revokeObjectURL(url); }
  };
  return new Promise(resolve => {
    const cancel = () => resolve(null);
    request.addEventListener('abort',cancel,{once:true});
    read().catch(() => null).then(result => {
      request.removeEventListener('abort',cancel);
      resolve(request.aborted ? null : result);
    });
  });
}
