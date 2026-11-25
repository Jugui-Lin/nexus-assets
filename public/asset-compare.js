import {MeshPreview} from './preview.js';

const minimum = 2;
const maximum = 4;

export function initAssetCompare({readPreview, meshCapable, loadMesh, describeAsset}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'asset-compare-dialog';
  dialog.className = 'modal asset-compare';
  dialog.setAttribute('aria-labelledby', 'asset-compare-title');
  dialog.innerHTML = `
    <header class="asset-compare-header">
      <h2 id="asset-compare-title">资产对比</h2>
      <div class="asset-compare-controls" role="group" aria-label="三维预览控制" hidden>
        <button type="button" class="button subtle" data-link aria-pressed="true">同步视角</button>
        <button type="button" class="button subtle" data-wire aria-pressed="false">线框</button>
        <button type="button" class="button subtle" data-reset>重置视角</button>
      </div>
      <button type="button" class="icon-button" data-close autofocus aria-label="关闭资产对比">
        <svg aria-hidden="true"><use href="#i-close"/></svg>
      </button>
    </header>
    <div class="asset-compare-grid"></div>`;
  document.body.append(dialog);

  const grid = dialog.querySelector('.asset-compare-grid');
  const controls = dialog.querySelector('.asset-compare-controls');
  const link = dialog.querySelector('[data-link]');
  const wire = dialog.querySelector('[data-wire]');
  let version = 0;
  let linked = true;
  let wireframe = false;
  let activeMesh = null;

  const slots = Array.from({length: maximum}, () => {
    const panel = document.createElement('article');
    panel.className = 'asset-compare-panel';
    panel.innerHTML = `
      <header class="asset-compare-heading"><h3></h3><p></p></header>
      <div class="asset-compare-stage">
        <canvas tabindex="0" hidden></canvas>
        <img hidden>
        <div class="asset-compare-fallback">
          <svg aria-hidden="true"><use href="#i-box"/></svg>
          <span role="status"></span>
        </div>
      </div>
      <p class="asset-compare-path" hidden></p>`;
    grid.append(panel);
    return {
      panel,
      name: panel.querySelector('h3'),
      caption: panel.querySelector('.asset-compare-heading p'),
      canvas: panel.querySelector('canvas'),
      image: panel.querySelector('img'),
      fallback: panel.querySelector('.asset-compare-fallback'),
      status: panel.querySelector('[role=status]'),
      path: panel.querySelector('.asset-compare-path'),
    };
  });

  function meshSlots() {
    return slots.filter(slot => slot.mesh);
  }

  function updateControls() {
    const count = meshSlots().length;
    controls.hidden = count === 0;
    link.hidden = count < 2;
    link.setAttribute('aria-pressed', String(linked));
    wire.setAttribute('aria-pressed', String(wireframe));
  }

  function updateView(slot) {
    activeMesh = slot;
    if (!linked) return;
    const {yaw, pitch, zoom} = slot.renderer;
    for (const peer of meshSlots()) {
      if (peer === slot) continue;
      Object.assign(peer.renderer, {yaw, pitch, zoom});
      peer.renderer.scheduleDraw();
    }
  }

  function resetView(slot) {
    slot.renderer.reset();
    updateView(slot);
  }

  function rendererFor(slot) {
    if (slot.renderer) return slot.renderer;
    const {canvas} = slot;
    const renderer = new MeshPreview(canvas);
    slot.renderer = renderer;
    canvas.addEventListener('pointermove', event => {
      if (slot.mesh && canvas.hasPointerCapture(event.pointerId)) updateView(slot);
    });
    canvas.addEventListener('wheel', () => {
      if (slot.mesh) updateView(slot);
    });
    canvas.addEventListener('keydown', event => {
      if (!slot.mesh || event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key) {
        case 'ArrowLeft': renderer.yaw -= 0.12; break;
        case 'ArrowRight': renderer.yaw += 0.12; break;
        case 'ArrowUp': renderer.pitch = Math.max(-1.3, renderer.pitch - 0.12); break;
        case 'ArrowDown': renderer.pitch = Math.min(1.3, renderer.pitch + 0.12); break;
        case '+': case '=': renderer.zoom = Math.min(3, renderer.zoom * 1.12); break;
        case '-': renderer.zoom = Math.max(0.35, renderer.zoom / 1.12); break;
        case 'Home':
          event.preventDefault();
          resetView(slot);
          return;
        default: return;
      }
      event.preventDefault();
      renderer.scheduleDraw();
      updateView(slot);
    });
    return renderer;
  }

  function clearSlot(slot) {
    slot.panel.hidden = true;
    slot.mesh = false;
    slot.canvas.hidden = true;
    slot.image.hidden = true;
    slot.image.onload = slot.image.onerror = null;
    slot.image.removeAttribute('src');
    slot.fallback.hidden = false;
    slot.status.textContent = '';
    if (slot.renderer) {
      slot.renderer.vertices = [];
      slot.renderer.faces = [];
    }
  }

  async function loadSlot(slot, asset, serial) {
    const current = () => version === serial && dialog.open;
    if (asset.id.startsWith('team:') && !asset.teamMounted) {
      slot.status.textContent = '请先连接此资产的团队挂载目录';
      return;
    }
    let meshError;
    if (meshCapable(asset)) {
      try {
        const payload = await readPreview(asset, 'mesh');
        if (!current()) return;
        const renderer = rendererFor(slot);
        renderer.wire = wireframe;
        const stats = loadMesh(renderer, payload, asset);
        slot.mesh = true;
        slot.canvas.hidden = false;
        slot.fallback.hidden = true;
        slot.caption.append(` · ${stats.faces.toLocaleString()} 面`);
        if (linked && activeMesh) updateView(activeMesh);
        else activeMesh ??= slot;
        renderer.scheduleDraw();
        updateControls();
        return;
      } catch (error) {
        meshError = error;
      }
    }
    if (!current()) return;
    try {
      const payload = await readPreview(asset, 'large');
      if (!current()) return;
      if (!payload?.url) {
        slot.status.textContent = meshError ? String(meshError.message || meshError) : '暂无预览';
        return;
      }
      slot.image.onload = () => {
        if (!current()) return;
        slot.image.hidden = false;
        slot.fallback.hidden = true;
      };
      slot.image.onerror = () => {
        if (current()) slot.status.textContent = '预览图无法显示';
      };
      slot.image.src = payload.url;
    } catch (error) {
      if (current()) slot.status.textContent = error?.message || String(error);
    }
  }

  function show(assets) {
    const items = [...new Map(assets.filter(asset => asset?.id).map(asset => [asset.id, asset])).values()];
    if (items.length < minimum || items.length > maximum) return false;
    const serial = ++version;
    activeMesh = null;
    linked = true;
    wireframe = false;
    slots.forEach(clearSlot);
    updateControls();
    dialog.dataset.count = String(items.length);
    if (!dialog.open) dialog.showModal();
    items.forEach((asset, index) => {
      const slot = slots[index];
      slot.panel.hidden = false;
      slot.name.textContent = slot.name.title = asset.name;
      slot.caption.textContent = describeAsset(asset);
      slot.canvas.setAttribute('aria-label', `${asset.name}三维预览，方向键旋转，加减键缩放，Home 重置`);
      slot.image.alt = `${asset.name}预览`;
      const path = asset.relativePath || asset.path || '';
      slot.path.textContent = slot.path.title = path;
      slot.path.hidden = !path;
      slot.status.textContent = '正在加载预览…';
      void loadSlot(slot, asset, serial);
    });
    return true;
  }

  link.addEventListener('click', () => {
    linked = !linked;
    updateControls();
    if (linked && activeMesh) updateView(activeMesh);
  });
  wire.addEventListener('click', () => {
    wireframe = !wireframe;
    updateControls();
    for (const {renderer} of meshSlots()) {
      renderer.wire = wireframe;
      renderer.scheduleDraw();
    }
  });
  dialog.querySelector('[data-reset]').addEventListener('click', () => {
    for (const {renderer} of meshSlots()) renderer.reset();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    version++;
    activeMesh = null;
    slots.forEach(clearSlot);
  });
  return {show};
}
