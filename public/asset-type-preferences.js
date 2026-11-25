const storageKey = 'nexus-asset-type-preferences-v1';
const defaultLabels = Object.freeze({
  model:'模型', scene:'工程', material:'材质', texture:'贴图', video:'视频',
  audio:'音频', bim:'BIM', cad:'CAD', script:'脚本', other:'其他',
});
const kinds = Object.keys(defaultLabels);
const systemKinds = new Set(['model', 'scene', 'material', 'texture']);

// Keep these in sync with kind() and video_mime() in src-tauri/src/lib.rs.
const builtInFormats = {
  model:'obj fbx gltf glb abc usd usda usdc stl ply 3dm 3ds 3mf aof ass atl atlo bvh cgeo cuap dae',
  scene:'blend c4d max ma mb hip hiplc hipnc',
  material:'mat mdl mtl mtlx rmtl sbs sbsar sbsprs skm vrmat xsh zip',
  texture:'png jpg jpeg webp tif tiff exr hdr tga bmp ies psd dds ai arw eps gif hdri renv svg',
  video:'mp4 m4v f4p f4v webm mov mkv 3gp amv avi flv m2v mp2 mpe mpeg mpg wmv',
  audio:'aac aiff alac flac m4a mp3 wav wma',
  bim:'gsm ifc pla pln rfa rft rte rvt val',
  cad:'dwg dxf iges igs sat step stp',
  script:'csc csr dyn gh ghuser mcr mel ms mse mzp py rb rbs',
  other:'ini pdf',
};
const formatKinds = new Map(Object.entries(builtInFormats)
  .flatMap(([kind, formats]) => formats.split(' ').map(ext => [ext, kind])));

function validKind(kind) {
  return Object.hasOwn(defaultLabels, kind);
}

function extKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/^\./, '') : '';
}

function extension(value) {
  const ext = extKey(value);
  return /^[a-z0-9][a-z0-9_+-]{0,31}$/.test(ext) ? ext : '';
}

function cleanSettings(input) {
  const labels = {};
  for (const kind of kinds) {
    const raw = input?.labels?.[kind];
    const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) : '';
    if (name) labels[kind] = name;
  }
  const formats = new Map();
  for (const [key, kind] of Object.entries(input?.formats || {})) {
    const ext = extension(key);
    if (ext && validKind(kind)) formats.set(ext, kind);
  }
  const disabledKinds = Array.isArray(input?.disabledKinds) ? input.disabledKinds : [];
  const disabledFormats = Array.isArray(input?.disabledFormats) ? input.disabledFormats : [];
  return {
    labels,
    formats:Object.fromEntries([...formats].sort(([a], [b]) => a.localeCompare(b))),
    disabledKinds:new Set(disabledKinds.filter(kind => validKind(kind) && !systemKinds.has(kind)).sort()),
    disabledFormats:new Set(disabledFormats.map(extension).filter(Boolean).sort()),
  };
}

function serialize(settings) {
  const {labels, formats, disabledKinds, disabledFormats} = settings;
  return JSON.stringify({labels, formats, disabledKinds:[...disabledKinds], disabledFormats:[...disabledFormats]});
}

export function initAssetTypePreferences({preferences, getAssets = () => [], notify = () => {}, onChange = () => {}}) {
  function read() {
    try { return cleanSettings(JSON.parse(preferences.getItem(storageKey))); }
    catch { return cleanSettings(); }
  }

  let settings = read();
  let currentScope;
  let indexedFormats;
  let draft;
  const dialog = document.createElement('dialog');
  dialog.id = 'asset-type-preferences-dialog';
  dialog.className = 'modal asset-type-preferences';
  dialog.setAttribute('aria-labelledby', 'asset-type-preferences-title');
  dialog.innerHTML = '<form>' +
    '<header class="modal-header">' +
      '<h2 id="asset-type-preferences-title">资产类型设置</h2>' +
      '<button type="button" class="icon-button" data-type-close aria-label="关闭"><svg aria-hidden="true"><use href="#i-close"/></svg></button>' +
    '</header>' +
    '<div class="asset-type-content">' +
      '<p class="asset-type-help">取消勾选会在当前库隐藏该类型或格式。把扩展名加入另一类型可调整归类。</p>' +
      '<div class="asset-type-grid" data-type-cards></div>' +
    '</div>' +
    '<p class="asset-type-error" data-type-error role="alert" hidden></p>' +
    '<footer class="modal-footer">' +
      '<button type="button" class="text-button" data-type-reset>恢复默认</button>' +
      '<button type="button" class="button subtle" data-type-close>取消</button>' +
      '<button type="submit" class="button primary">应用更改</button>' +
    '</footer>' +
  '</form>';
  document.body.append(dialog);
  const get = selector => dialog.querySelector(selector);
  const cards = get('[data-type-cards]');
  const feedback = get('[data-type-error]');
  const controls = new Map();

  function label(kind, defaultLabel) {
    if (!validKind(kind)) return defaultLabel || (kind === 'all' ? '全部' : defaultLabels.other);
    return settings.labels[kind] || defaultLabel || defaultLabels[kind];
  }

  function effectiveKind(asset) {
    const ext = extKey(asset?.ext);
    return (Object.hasOwn(settings.formats, ext) ? settings.formats[ext] : null) || asset?.kind || 'other';
  }

  function categoryEnabled(kind) {
    return !settings.disabledKinds.has(kind);
  }

  function indexedCatalog() {
    const entries = new Map(formatKinds);
    for (const asset of getAssets()) {
      const ext = extension(asset?.ext);
      if (ext && !entries.has(ext)) entries.set(ext, validKind(asset.kind) ? asset.kind : 'other');
    }
    return entries;
  }

  function setError(message = '') {
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function renderFormats() {
    const entries = new Map([...indexedFormats, ...Object.entries(draft.formats)]);
    const byKind = new Map(kinds.map(kind => [kind, []]));
    for (const [ext, kind] of entries) byKind.get(kind).push(ext);
    for (const [kind, controlsForKind] of controls) {
      const {card, title, toggle, list} = controlsForKind;
      title.textContent = draft.labels[kind] || defaultLabels[kind];
      const active = !draft.disabledKinds.has(kind);
      card.classList.toggle('is-off', !active);
      if (toggle) toggle.checked = active;
      const formats = byKind.get(kind).sort((a, b) => a.localeCompare(b));
      const rows = formats.map(ext => formatRow(kind, ext));
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'asset-type-empty';
        empty.textContent = '暂无格式';
        rows.push(empty);
      }
      list.replaceChildren(...rows);
    }
  }

  function formatRow(kind, ext) {
    const row = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.assetTypeFormat = ext;
    checkbox.checked = !draft.disabledFormats.has(ext);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) draft.disabledFormats.delete(ext);
      else draft.disabledFormats.add(ext);
    });
    const name = document.createElement('span');
    name.className = 'asset-type-extension-name';
    name.textContent = '.' + ext;
    label.append(checkbox, name);
    row.append(label);
    if (Object.hasOwn(draft.formats, ext)) {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'asset-type-restore';
      const action = indexedFormats.has(ext) ? '恢复归类' : '移除自定义格式';
      restore.title = action;
      restore.setAttribute('aria-label', action + ' .' + ext);
      restore.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
      restore.addEventListener('click', () => {
        delete draft.formats[ext];
        if (!indexedFormats.has(ext)) draft.disabledFormats.delete(ext);
        renderFormats();
        controls.get(kind).input.focus();
      });
      row.append(restore);
    }
    return row;
  }

  function pendingFormats(kind, input) {
    const value = input.value.trim();
    if (!value) return [];
    const formats = value.split(/[\s,，、;；]+/).filter(Boolean).map(extension);
    if (formats.length && formats.every(Boolean)) return formats;
    setError((draft.labels[kind] || defaultLabels[kind]) + '的扩展名格式无效，例如 FBX 或 .EXR。');
    input.focus();
    return null;
  }

  function assignFormats(kind, formats) {
    for (const ext of formats) {
      if (indexedFormats.get(ext) === kind) delete draft.formats[ext];
      else draft.formats[ext] = kind;
    }
  }

  function addFormats(kind) {
    const {input} = controls.get(kind);
    const requested = pendingFormats(kind, input);
    if (!requested || !requested.length) return;
    assignFormats(kind, requested);
    input.value = '';
    setError();
    renderFormats();
    input.focus();
  }

  for (const kind of kinds) {
    const card = document.createElement('fieldset');
    card.className = 'asset-type-card';
    card.dataset.assetTypeKind = kind;
    card.innerHTML = '<legend></legend><div class="asset-type-mode"></div>' +
      '<div class="asset-type-add-field">' +
        '<input type="text" maxlength="160" placeholder="添加扩展名" spellcheck="false" autocomplete="off">' +
        '<button type="button" class="icon-button" data-type-add><span aria-hidden="true">+</span></button>' +
      '</div><ul class="asset-type-extension-list"></ul>';
    const title = card.querySelector('legend');
    const mode = card.querySelector('.asset-type-mode');
    const input = card.querySelector('input');
    let toggle;
    if (systemKinds.has(kind)) {
      mode.textContent = '系统类型';
    } else {
      const modeLabel = document.createElement('label');
      toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.dataset.assetTypeEnabled = kind;
      toggle.addEventListener('change', () => {
        if (toggle.checked) draft.disabledKinds.delete(kind);
        else draft.disabledKinds.add(kind);
        card.classList.toggle('is-off', !toggle.checked);
      });
      modeLabel.append(toggle, document.createTextNode('使用此类型'));
      mode.append(modeLabel);
    }
    const add = card.querySelector('[data-type-add]');
    add.setAttribute('aria-label', '向' + defaultLabels[kind] + '添加扩展名');
    input.setAttribute('aria-label', defaultLabels[kind] + '扩展名');
    input.dataset.assetTypeAdd = kind;
    add.addEventListener('click', () => addFormats(kind));
    input.addEventListener('input', () => setError());
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      addFormats(kind);
    });
    cards.append(card);
    controls.set(kind, {card, title, toggle, input, list:card.querySelector('ul')});
  }

  function renderDraft(values) {
    draft = cleanSettings(JSON.parse(serialize(values)));
    for (const {input} of controls.values()) input.value = '';
    setError();
    renderFormats();
  }

  for (const button of dialog.querySelectorAll('[data-type-close]')) {
    button.addEventListener('click', () => dialog.close());
  }
  get('[data-type-reset]').addEventListener('click', () => renderDraft(cleanSettings()));
  get('form').addEventListener('submit', event => {
    event.preventDefault();
    const pending = new Map();
    for (const [kind, {input}] of controls) {
      const requested = pendingFormats(kind, input);
      if (!requested) return;
      for (const ext of requested) {
        if (pending.has(ext) && pending.get(ext) !== kind) {
          setError('.' + ext + ' 已填写在其他类型中，请选择一个分类。');
          input.focus();
          return;
        }
        pending.set(ext, kind);
      }
    }
    for (const [ext, kind] of pending) assignFormats(kind, [ext]);
    const next = cleanSettings(JSON.parse(serialize(draft)));
    const serialized = serialize(next);
    const changed = serialized !== serialize(settings);
    if (changed) {
      try {
        if (serialized === serialize(cleanSettings())) preferences.removeItem(storageKey);
        else preferences.setItem(storageKey, serialized);
      } catch {
        setError('无法保存当前库的资产类型设置。');
        return;
      }
      settings = next;
    }
    dialog.close();
    if (changed) {
      onChange();
      notify('已应用资产类型设置');
    }
  });

  return {
    label,
    effectiveKind,
    categoryEnabled,
    enabled(asset) {
      return (!settings.disabledKinds.size || categoryEnabled(effectiveKind(asset))) &&
        (!settings.disabledFormats.size || !settings.disabledFormats.has(extKey(asset?.ext)));
    },
    show() {
      if (dialog.open) return;
      indexedFormats = indexedCatalog();
      renderDraft(settings);
      dialog.showModal();
      controls.get('model').input.focus();
    },
    reload(scope) {
      if (currentScope === scope) return false;
      currentScope = scope;
      if (dialog.open) dialog.close();
      const next = read();
      const changed = serialize(next) !== serialize(settings);
      settings = next;
      return changed;
    },
  };
}
