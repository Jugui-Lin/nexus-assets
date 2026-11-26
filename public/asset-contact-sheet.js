import {downloadWorkspaceFile} from './workspace-download.js';

export const contactSheetLimit = 16;
const tileWidth = 254;
const tileHeight = 164;
const nameHeight = 30;
const gap = 10;

function clippedText(context, text, width) {
  if (context.measureText(text).width <= width) return text;
  let truncated = text.slice(0,128);
  while (truncated.length && context.measureText(truncated + '…').width > width) truncated = truncated.slice(0,-1);
  return truncated + '…';
}

function exposureLookup(exposure) {
  const factor = 2 ** exposure;
  return Uint8ClampedArray.from({length:256},(_, i) => {
    const value = i / 255;
    const linear = (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * factor;
    return 255 * (linear <= .0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - .055);
  });
}

export function initAssetContactSheet({readThumbnail}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal asset-contact-sheet';
  dialog.setAttribute('aria-labelledby','asset-contact-sheet-title');
  dialog.innerHTML = `
    <div class="modal-header"><h2 id="asset-contact-sheet-title">选中素材校样</h2><button type="button" class="icon-button" data-close aria-label="关闭"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <div class="asset-contact-sheet-controls">
      <label>背景 <select data-sheet-background><option value="#1d2124">深灰</option><option value="#777f85">中灰</option><option value="#f5f6f7">浅色</option></select></label>
      <label>显示曝光 <select data-sheet-exposure><option value="-2">−2 EV</option><option value="-1">−1 EV</option><option value="0" selected>0 EV</option><option value="1">+1 EV</option><option value="2">+2 EV</option></select></label>
    </div>
    <canvas data-sheet-canvas aria-label="统一尺寸的素材校样" hidden></canvas>
    <p data-sheet-status role="status"></p>
    <div class="modal-footer"><button type="button" class="button primary" data-sheet-save disabled>下载 PNG</button></div>`;
  document.body.append(dialog);
  const canvas = dialog.querySelector('[data-sheet-canvas]');
  const context = canvas.getContext('2d');
  const sample = document.createElement('canvas');
  sample.width = tileWidth;
  sample.height = tileHeight;
  const sampleContext = sample.getContext('2d',{willReadFrequently:true});
  const status = dialog.querySelector('[data-sheet-status]');
  const background = dialog.querySelector('[data-sheet-background]');
  const exposure = dialog.querySelector('[data-sheet-exposure]');
  const save = dialog.querySelector('[data-sheet-save]');
  let current;

  function compose(draft) {
    if (current !== draft || !draft.ready || !dialog.open) return;
    const columns = Math.min(4,Math.ceil(Math.sqrt(draft.rows.length)));
    const rows = Math.ceil(draft.rows.length / columns);
    canvas.width = columns * (tileWidth + gap) + gap;
    canvas.height = rows * (tileHeight + nameHeight + gap) + gap;
    context.fillStyle = background.value;
    context.fillRect(0,0,canvas.width,canvas.height);
    const table = exposure.value !== '0' ? exposureLookup(Number(exposure.value)) : null;
    let failures = 0;
    for (const [index,{asset,image}] of draft.rows.entries()) {
      const x = gap + index % columns * (tileWidth + gap);
      const y = gap + Math.floor(index / columns) * (tileHeight + nameHeight + gap);
      if (image) {
        try {
          const scale = Math.min(tileWidth / image.naturalWidth,tileHeight / image.naturalHeight);
          const width = image.naturalWidth * scale;
          const height = image.naturalHeight * scale;
          sampleContext.clearRect(0,0,tileWidth,tileHeight);
          sampleContext.drawImage(image,(tileWidth - width) / 2,(tileHeight - height) / 2,width,height);
          const pixels = sampleContext.getImageData(0,0,tileWidth,tileHeight);
          if (table) for (let p = 0; p < pixels.data.length; p += 4) {
            pixels.data[p] = table[pixels.data[p]];
            pixels.data[p + 1] = table[pixels.data[p + 1]];
            pixels.data[p + 2] = table[pixels.data[p + 2]];
          }
          sampleContext.putImageData(pixels,0,0);
          context.drawImage(sample,x,y);
        } catch {
          failures++;
          sample.width = tileWidth;
        }
      } else failures++;
      context.fillStyle = '#101316e6';
      context.fillRect(x,y + tileHeight,tileWidth,nameHeight);
      context.fillStyle = '#edf3f6';
      context.font = '13px sans-serif';
      context.fillText(clippedText(context,asset.name,tileWidth - 16),x + 8,y + tileHeight + 20);
    }
    canvas.hidden = false;
    save.disabled = failures === draft.rows.length;
    status.textContent = `${draft.rows.length} 项 · ${canvas.width} × ${canvas.height} px${failures ? ` · ${failures} 项暂无预览` : ''}`;
  }

  async function show(assets) {
    if (dialog.open || !assets.length || assets.length > contactSheetLimit) return;
    const draft = current = {rows:[],ready:false};
    canvas.hidden = true;
    save.disabled = true;
    dialog.showModal();
    for (const [index,asset] of assets.entries()) {
      if (current !== draft) return;
      status.textContent = `正在读取预览 ${index + 1} / ${assets.length}`;
      let image;
      try {
        const url = await readThumbnail(asset);
        if (current !== draft) return;
        if (url) {
          const decoded = new Image();
          decoded.src = url;
          await decoded.decode();
          if (decoded.naturalWidth && decoded.naturalHeight) image = decoded;
        }
      } catch { /* The label remains on the sheet when its preview cannot be read. */ }
      draft.rows.push({asset,image});
    }
    draft.ready = true;
    compose(draft);
  }

  dialog.querySelector('[data-close]').addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => { current = null; canvas.width = canvas.height = 1; });
  for (const select of [background,exposure]) select.addEventListener('change',() => current && compose(current));
  save.addEventListener('click', () => {
    const draft = current;
    canvas.toBlob(blob => {
      if (!blob || current !== draft || !dialog.open) return;
      downloadWorkspaceFile(document,`Nexus-校样-${new Date().toISOString().slice(0,10)}.png`,blob,'image/png');
    },'image/png');
  });
  return {show};
}
