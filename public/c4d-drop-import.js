const sceneFormats = new Set(['max', 'blend', 'c4d', 'fbx', 'obj', 'abc', 'stl']);
const fbxSources = new Set(['max', 'blend', 'fbx']);
const companionFormats = ['c4d', 'fbx'];

export function isC4dSceneAsset(asset) {
  return sceneFormats.has(asset?.ext);
}

function assetLocation(asset) {
  const path = (asset.relativePath || asset.path || '').replaceAll('\\', '/');
  const index = path.lastIndexOf('/');
  const filename = path.slice(index + 1);
  const suffix = filename.lastIndexOf('.');
  return {folder:path.slice(0, Math.max(0, index)).toLowerCase(), filename,
    stem:filename.slice(0, suffix < 0 ? filename.length : suffix).toLowerCase()};
}

export function compatibleMaxSources(asset, assets, isUsable) {
  if (asset.ext !== 'max') return [];
  const {folder, stem} = assetLocation(asset);
  const unqualified = stem.replace(/[_. -](?:v[-_ ]?ray|corona)$/i, '');
  const matches = new Map(companionFormats.map(ext => [ext, {exact:[], alternate:[]}]));
  for (const candidate of assets) {
    if (candidate.libraryId !== asset.libraryId || !matches.has(candidate.ext) || !isUsable(candidate)) continue;
    const path = assetLocation(candidate);
    if (path.folder !== folder) continue;
    if (path.stem === stem) matches.get(candidate.ext).exact.push(candidate);
    else if (path.stem === unqualified) matches.get(candidate.ext).alternate.push(candidate);
  }
  return companionFormats.flatMap(ext => {
    const {exact, alternate} = matches.get(ext);
    if (exact.length) return exact.length === 1 ? exact : [];
    return alternate.length === 1 ? alternate : [];
  });
}

const pendingStatuses = new Set(['queued', 'running']);
const statusMessages = {
  queued:'等待 Cinema 4D 接收',
  running:'Cinema 4D 正在处理',
  done:'已导入 Cinema 4D',
  failed:'Cinema 4D 导入失败',
  interrupted:'Cinema 4D 导入已中断',
};

export function initC4dDropImport({asset, assets, session, isUsable, supports, scope, defaultRenderer, queue, notify, showJobs, showConnections, openWeb}) {
  const get = id => document.getElementById(id);
  const dialog = get('c4d-drop-dialog');
  const form = get('c4d-drop-form');
  const sources = get('c4d-drop-sources');
  const conversion = get('c4d-drop-conversion');
  const mode = get('c4d-drop-max-mode');
  const blenderNote = get('c4d-drop-blender-note');
  const sceneFields = get('c4d-drop-scene-fields');
  const normals = form.elements.normals;
  const normalsField = normals.closest('label');
  const storeTextures = form.elements.storeTextures;
  const storeTexturesField = get('c4d-drop-store-textures');
  const renderer = get('c4d-drop-renderer');
  const rendererOptions = Object.fromEntries([...renderer.options].map(option => [option.value, option]));
  const octanePreviewNote = get('c4d-drop-octane-preview-note');
  const bridgeNote = get('c4d-drop-bridge-note');
  const status = get('c4d-drop-status');
  const activity = get('c4d-drop-activity');
  const stage = get('c4d-drop-stage');
  const activityName = get('c4d-drop-name');
  const detail = get('c4d-drop-detail');
  const meter = get('c4d-drop-meter');
  const dismiss = get('c4d-drop-dismiss');
  const submitProgress = get('c4d-drop-submit-progress');
  const checks = [...sceneFields.querySelectorAll('input')].filter(input => input !== storeTextures);
  const tracked = new Map();
  let draft;
  let busy = false;
  let submitting = '';

  function picks() {
    return [...new Set(draft.entries.map(({select}) => select.value))];
  }

  function renderFields() {
    const selected = picks().map(id => asset(id));
    const scene = selected.some(isC4dSceneAsset);
    const fbxMaterials = selected.some(source => fbxSources.has(source?.ext));
    conversion.hidden = !draft.custom || !selected.some(source => source?.ext === 'max');
    blenderNote.hidden = conversion.hidden || mode.value !== 'direct';
    if (blenderNote.hidden) mode.removeAttribute('aria-describedby');
    else mode.setAttribute('aria-describedby', blenderNote.id);
    sceneFields.hidden = !draft.custom || !scene;
    bridgeNote.hidden = draft.custom || !scene;
    const importObjects = form.elements.objects.checked;
    normalsField.hidden = sceneFields.hidden || !fbxMaterials;
    normals.disabled = normalsField.hidden || !importObjects;
    for (const key of ['cameras', 'lights', 'animation', 'emptyObjects']) {
      form.elements[key].disabled = !importObjects;
    }
    const importMaterials = form.elements.materials.checked;
    form.elements.textures.disabled = !importMaterials || !importObjects;
    const linkTextures = !form.elements.textures.disabled && form.elements.textures.checked;
    storeTexturesField.hidden = sceneFields.hidden || !draft.archiveTextures;
    storeTextures.disabled = storeTexturesField.hidden || !linkTextures;
    renderer.disabled = !importMaterials || (!fbxMaterials && !linkTextures);
    rendererOptions.standard.text = fbxMaterials && !linkTextures ? '保留 FBX 原材质' : 'Standard / Physical（补建材质）';
    rendererOptions.octane.text = fbxMaterials ? 'Octane（转换 FBX 材质）' : 'Octane（补建材质）';
    rendererOptions.redshift.disabled = !linkTextures;
    rendererOptions.arnold.disabled = !linkTextures;
    if (rendererOptions[renderer.value]?.disabled) renderer.value = 'auto';
    const octanePreview = !sceneFields.hidden && !renderer.disabled && fbxMaterials &&
      (renderer.value === 'octane' || renderer.value === 'auto');
    octanePreviewNote.hidden = !octanePreview;
    if (octanePreview) {
      const condition = renderer.value === 'auto' ? '若当前工程使用 Octane，' : '';
      octanePreviewNote.textContent = condition +
        '导入前可在 Octane Live Viewer → Options → Previews 关闭 Materials Previews，避免自动生成材质缩略图。';
      renderer.setAttribute('aria-describedby', octanePreviewNote.id);
    } else renderer.removeAttribute('aria-describedby');
  }

  function show(ids, sessionId, {validate,exactSources = false} = {}) {
    if (dialog.open || busy) return;
    const target = session(sessionId);
    if (!target || target.dcc !== 'c4d') throw Error('目标 Cinema 4D 已离线');
    const list = ids.map(asset).filter(Boolean);
    const supported = list.filter(item => supports(item, target));
    if (!supported.length) throw Error('所选资产没有可导入 Cinema 4D 的格式');
    draft = {scope:scope(), sessionId, validate, custom:target.smartImport === true && target.sceneImportOptions === true,
      archiveTextures:target.archiveTextures === true, entries:[]};
    for (const row of sources.querySelectorAll('label')) row.remove();
    for (const item of supported) {
      const label = document.createElement('label');
      label.className = 'field-label';
      label.textContent = assetLocation(item).filename || item.name;
      const select = document.createElement('select');
      select.className = 'text-field';
      select.dataset.sourceAsset = item.id;
      const alternatives = exactSources ? [] : compatibleMaxSources(item, assets(item.libraryId), isUsable);
      for (const [index, source] of [item, ...alternatives].entries()) {
        const filename = assetLocation(source).filename || source.name;
        select.add(new Option(filename + (index ? ' · 可直接导入' : ' · 原文件'), source.id));
      }
      if (alternatives.length) select.value = alternatives[0].id;
      label.append(select);
      sources.append(label);
      draft.entries.push({select});
    }
    for (const input of checks) input.checked = true;
    storeTextures.checked = draft.archiveTextures;
    mode.value = 'direct';
    renderer.value = defaultRenderer();
    get('c4d-drop-target').textContent = target.label || 'Cinema 4D';
    status.textContent = list.length !== supported.length ? '已跳过 ' + (list.length - supported.length) + ' 项不支持的资产' : '';
    renderFields();
    dialog.showModal();
    draft.entries[0].select.focus();
  }

  function renderActivity(jobs = []) {
    for (const job of jobs) {
      if (tracked.has(job.id) || (job.dcc === 'c4d' && pendingStatuses.has(job.status))) {
        tracked.set(job.id, job);
      }
    }
    const relevant = [...tracked.values()];
    const active = relevant.find(job => job.status === 'running') ||
      relevant.find(job => pendingStatuses.has(job.status));
    const failed = relevant.filter(job => ['failed', 'interrupted'].includes(job.status));
    const done = relevant.filter(job => job.status === 'done');
    const job = active || failed[0] || done[0];
    activity.hidden = !job && !submitting;
    if (activity.hidden) return;
    const inProgress = Boolean(active || submitting);
    const state = submitting ? 'submitting' : !active && failed.length ? 'failed' : job.status;
    const caption = submitting ? '正在提交 Cinema 4D 导入'
      : active?.progress || statusMessages[job.status];
    const count = relevant.length > 1 ? ' · ' + done.length + '/' + relevant.length + ' 项完成'
      + (failed.length ? ' · ' + failed.length + ' 项未完成' : '') : '';
    const information = !inProgress && (job.error || job.message) || '';
    if (stage.textContent !== caption + count) stage.textContent = caption + count;
    activityName.textContent = submitting || job.name;
    detail.textContent = information;
    detail.hidden = !information;
    activity.dataset.status = state;
    activity.dataset.stage = job?.progressStage || state;
    dismiss.hidden = inProgress;
    meter.hidden = state === 'failed';
    if (state === 'done') meter.value = 1;
    else meter.removeAttribute('value');
  }

  sources.addEventListener('change', renderFields);
  mode.addEventListener('change', renderFields);
  get('c4d-drop-blender-download').addEventListener('click', event => {
    event.preventDefault();
    openWeb(event.currentTarget.href);
  });
  form.elements.objects.addEventListener('change', renderFields);
  form.elements.materials.addEventListener('change', renderFields);
  form.elements.textures.addEventListener('change', renderFields);
  renderer.addEventListener('change', renderFields);
  get('c4d-drop-open-jobs').addEventListener('click', showJobs);
  get('c4d-drop-bridge-update').addEventListener('click', () => {
    dialog.close();
    showConnections();
  });
  dismiss.addEventListener('click', () => {
    tracked.clear();
    renderActivity();
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (!dialog.open) draft = undefined; });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!draft || busy) return;
    const current = draft;
    const selected = picks();
    const scene = Object.fromEntries(checks.map(input => [input.name, input.checked && !input.disabled]));
    if (storeTextures.checked && !storeTextures.disabled) scene.storeTextures = true;
    const method = mode.value;
    const materialRenderer = renderer.disabled ? null : renderer.value;
    if (current.scope !== scope()) {
      dialog.close();
      notify('工作空间已切换，请重新拖动资产', true);
      return;
    }
    busy = true;
    const enabled = [...form.elements].filter(control => !control.disabled);
    enabled.forEach(control => control.disabled = true);
    status.textContent = '正在提交导入任务…';
    for (const [id, job] of tracked) {
      if (!pendingStatuses.has(job.status)) tracked.delete(id);
    }
    submitting = selected.length === 1 ? asset(selected[0])?.name || '1 项资产' : selected.length + ' 项资产';
    submitProgress.hidden = false;
    renderActivity();
    const failures = [];
    let submitted = 0;
    try {
      for (const id of selected) {
        let source = asset(id);
        try {
          if (current.scope !== scope()) throw Error('工作空间已切换，请重新拖动资产');
          if (current.validate) source = current.validate(id,current.sessionId).asset;
          if (!source || !isUsable(source)) throw Error('资产文件不可用，请检查挂载');
          const already = [...tracked.values()].find(job =>
            job.sessionId === current.sessionId && job.assetId === id && pendingStatuses.has(job.status));
          if (already) continue;
          const options = {};
          const isScene = isC4dSceneAsset(source);
          if (current.custom && isScene) {
            options.scene_import = scene;
              if (materialRenderer && (scene.textures || fbxSources.has(source.ext))) {
              options.renderer = materialRenderer;
            }
          }
          if (current.custom && source.ext === 'max' && method) options.max_mode = method;
          const job = await queue(source, current.sessionId, isScene, options);
          tracked.set(job.id, {assetId:id, sessionId:current.sessionId, ...job});
          submitted++;
        } catch (failure) {
          failures.push((source?.name ? source.name + ' · ' : '') + (failure?.message || failure));
        }
      }
      if (failures.length && !submitted) {
        status.textContent = failures[0];
        return;
      }
      dialog.close();
      if (failures.length) notify('有 ' + failures.length + ' 项未能提交 · ' + failures[0], true);
      else if (!submitted) notify('所选资产已在 Cinema 4D 导入队列中');
    } finally {
      submitting = '';
      submitProgress.hidden = true;
      renderActivity();
      enabled.forEach(control => control.disabled = false);
      busy = false;
    }
  });

  return {show, renderActivity, pending:() => busy || [...tracked.values()].some(job => pendingStatuses.has(job.status))};
}
