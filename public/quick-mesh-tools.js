const formatNumber = value => {
  if (!Number.isFinite(value)) return '超出数值范围';
  if (value && (Math.abs(value) < .001 || Math.abs(value) >= 1e7)) return value.toExponential(2);
  return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(value);
};

export function initQuickMeshTools(root, renderer) {
  const wireframe = root.querySelector('#quick-wireframe');
  const resetView = root.querySelector('#quick-reset');
  const guides = root.querySelector('[data-mesh-guides]');
  const rotation = root.querySelector('[data-mesh-spin]');
  const backfaces = root.querySelector('[data-mesh-backfaces]');
  const background = root.querySelector('[data-mesh-background]');
  const measure = root.querySelector('[data-mesh-measure]');
  const details = root.querySelector('details');
  const quality = root.querySelector('[data-mesh-quality]');
  const issues = root.querySelector('[data-mesh-issues]');
  const selectedFace = root.querySelector('[data-mesh-selected-face]');
  let frame = null;
  let previous = 0;

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    rotation.setAttribute('aria-pressed','false');
    rotation.textContent = '转台';
  }

  function animate(now) {
    if (root.classList.contains('hidden')) { stop(); return; }
    const elapsed = now - previous;
    if (elapsed >= 45) {
      previous = now;
      renderer.yaw += Math.min(elapsed,120) * .0005;
      renderer.draw();
    }
    frame = requestAnimationFrame(animate);
  }

  function toggle(button, key) {
    const next = renderer[key] = !renderer[key];
    button.setAttribute('aria-pressed',String(next));
    renderer.draw();
  }

  function reset() {
    stop();
    root.classList.add('hidden');
    renderer.wire = renderer.guides = renderer.backfaces = false;
    renderer.selectedFace = renderer.selectedVertex = null;
    renderer.projectedPoints = null;
    renderer.modelBackground = background.value = '';
    details.open = false;
    measure.textContent = selectedFace.textContent = '';
    for (const control of [wireframe,guides,backfaces]) control.setAttribute('aria-pressed','false');
  }

  function show(stats) {
    const {inspection,unit} = stats;
    if (!inspection) return;
    const {dimensions,minimum,maximum,degenerateCount,duplicateCount,degenerate,duplicates} = inspection;
    const dimensionsText = `尺寸 ${dimensions.map(formatNumber).join(' × ')}${unit ? ` ${unit}` : ' · 单位未标注'}`;
    measure.textContent = dimensionsText;
    measure.title = `包围盒最小值 ${minimum.map(formatNumber).join(', ')}\n最大值 ${maximum.map(formatNumber).join(', ')}`;
    const size = Math.max(...dimensions);
    const scale = unit === 'm' && (size < 1e-5 || size > 1e5) ? ' · 请核对模型尺度' : '';
    quality.textContent = `网格检查 · ${degenerateCount} 个退化面 · ${duplicateCount} 个重复顶点${scale}`;
    function row(label, action) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = label;
      button.addEventListener('click', () => { stop(); action(); });
      li.append(button);
      return li;
    }
    issues.replaceChildren(...degenerate.map(face => row(`定位退化面 #${face.order + 1}`,() => renderer.focusFace(face.order))),
      ...duplicates.map(({index,original}) => row(`定位重复顶点 #${index + 1}（与 #${original + 1} 重合）`,() => renderer.focusVertex(index))));
    details.querySelector('[data-mesh-extra]').textContent = degenerateCount > degenerate.length || duplicateCount > duplicates.length
      ? '每类显示前 24 个可定位结果。' : '';
    root.classList.remove('hidden');
  }

  renderer.onFace = face => {
    selectedFace.textContent = face ? `面 #${face.order + 1} · ${face.indices.length} 个顶点${face.name ? ` · ${face.name}` : ''}` : '';
  };
  renderer.canvas.addEventListener('pointerdown',stop);
  wireframe.addEventListener('click', () => toggle(wireframe,'wire'));
  guides.addEventListener('click', () => toggle(guides,'guides'));
  backfaces.addEventListener('click', () => toggle(backfaces,'backfaces'));
  background.addEventListener('change', () => { renderer.modelBackground = background.value; renderer.draw(); });
  resetView.addEventListener('click', () => { stop(); renderer.reset(); });
  for (const button of root.querySelectorAll('[data-mesh-turn]')) {
    button.addEventListener('click', () => { stop(); renderer.yaw += Number(button.dataset.meshTurn) * Math.PI / 12; renderer.draw(); });
  }
  rotation.addEventListener('click', () => {
    if (frame !== null) { stop(); return; }
    previous = performance.now();
    frame = requestAnimationFrame(animate);
    rotation.setAttribute('aria-pressed','true');
    rotation.textContent = '暂停转台';
  });
  return {show,reset};
}
