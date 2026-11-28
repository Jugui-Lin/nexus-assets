const channels = {
  base_color: ['底色', ['base color', 'base colour', 'basecolor', 'basecolour', 'albedo', 'diffuse', 'diff', 'color', 'colour', 'col']],
  ao: ['环境光遮蔽 (AO)', ['ambient occlusion', 'ambientocclusion', 'occlusion', 'ao']],
  metallic: ['金属度', ['metallic', 'metalness', 'metal']],
  roughness: ['粗糙度', ['roughness', 'rough']],
  specular: ['反射 / 高光', ['specular', 'spec', 'reflection', 'reflect']],
  glossiness: ['光泽度', ['glossiness', 'gloss']],
  bump: ['凹凸', ['bump']],
  normal: ['法线', ['normalgl', 'normaldx', 'normal', 'norm', 'nrm', 'nor']],
  opacity: ['不透明度', ['opacity', 'transparency', 'alpha', 'cutout']],
  displacement: ['置换', ['displacement', 'displace', 'height', 'disp']],
  emission: ['自发光', ['emission', 'emissive', 'emit']],
  translucency: ['半透明', ['translucency', 'translucent', 'transmission', 'trans']],
};
const maxAliases = 16;
const maxAliasBytes = 120;
const encoder = new TextEncoder();
const sources = Object.entries(channels);

function splitAliases(text) {
  const entries = [];
  let start = 0;
  let pattern = false;
  let characterClass = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (pattern) {
      if (character === '\\') i++;
      else if (character === '[') characterClass = true;
      else if (character === ']') characterClass = false;
      else if (character === '/' && !characterClass) pattern = false;
    } else if (character === '/' && !text.slice(start, i).trim()) {
      pattern = true;
    } else if (character === ',' || character === '，' || character === '\n') {
      entries.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (pattern) throw Error('正则表达式需要用 /…/ 包住');
  entries.push(text.slice(start).trim());
  return entries.filter(Boolean);
}

function normalizedAliases(entries) {
  if (!Array.isArray(entries) || entries.length > maxAliases) throw Error(`最多可填写 ${maxAliases} 个关键词`);
  const known = new Set();
  const aliases = [];
  for (const item of entries) {
    if (typeof item !== 'string' || !item.trim()) throw Error('关键词不能为空');
    const entry = item.trim();
    if (encoder.encode(entry).length > maxAliasBytes || /[\u0000-\u001f\u007f]/.test(entry)) {
      throw Error(`每个关键词最多 ${maxAliasBytes} 字节，并且要写在一行内`);
    }
    const pattern = entry.startsWith('/');
    if (pattern) {
      if (entry.length < 3 || !entry.endsWith('/')) throw Error('正则表达式需要用 /…/ 包住');
      try { new RegExp(entry.slice(1, -1), 'i'); }
      catch { throw Error(`正则表达式无效：${entry}`); }
    } else if (/[，,]/.test(entry)) {
      throw Error('请用逗号分隔多个关键词');
    }
    const key = pattern ? entry : entry.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    aliases.push(entry);
  }
  return aliases;
}

function customized(options) {
  return sources.some(([channel, [, defaults]]) =>
    options[channel].length !== defaults.length ||
    options[channel].some((value, index) => value !== defaults[index])) ? options : undefined;
}

export function storedMapKeywords(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    return customized(Object.fromEntries(sources.map(([channel, [, defaults]]) =>
      [channel, Object.hasOwn(value, channel) ? normalizedAliases(value[channel]) : defaults])));
  } catch {
    return undefined;
  }
}

export function initSmartMapKeywords() {
  const container = document.getElementById('smart-map-keyword-fields');
  const status = document.getElementById('smart-map-keyword-status');
  const fields = new Map();
  const labels = new Map();

  function resetValidation() {
    status.textContent = '';
    for (const field of fields.values()) field.removeAttribute('aria-invalid');
  }

  for (const [channel, [name]] of sources) {
    const label = document.createElement('label');
    label.className = 'field-label';
    const caption = document.createElement('span');
    caption.className = 'smart-map-keyword-caption';
    caption.textContent = name;
    const field = document.createElement('textarea');
    field.className = 'text-field';
    field.id = 'smart-map-' + channel;
    field.dataset.mapChannel = channel;
    field.rows = 2;
    field.maxLength = 2500;
    field.spellcheck = false;
    field.setAttribute('aria-describedby', 'smart-map-keyword-help smart-map-keyword-status');
    label.append(caption, field);
    container.append(label);
    fields.set(channel, field);
    labels.set(channel, name);
  }

  function load(options) {
    for (const [channel, [, defaults]] of sources) {
      fields.get(channel).value = (options?.[channel] ?? defaults).join(', ');
    }
    resetValidation();
  }

  document.getElementById('reset-smart-map-keywords').addEventListener('click', () => load());
  container.addEventListener('input', resetValidation);

  return {
    load,
    read() {
      resetValidation();
      const options = {};
      for (const [channel, field] of fields) {
        try { options[channel] = normalizedAliases(splitAliases(field.value)); }
        catch (failure) {
          field.setAttribute('aria-invalid', 'true');
          status.textContent = `${labels.get(channel)}：${failure.message}`;
          field.focus();
          return {valid:false};
        }
      }
      return {valid:true, keywords:customized(options)};
    },
  };
}
