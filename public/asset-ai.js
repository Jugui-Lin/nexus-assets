const maxAssets = 12;
const maxTags = 30;
const categoryPrefix = 'AI 分类/';
const modelKey = 'nexus-asset-ai-model';
const categories = [
  {id:'furniture', label:'家具家居'},
  {id:'architecture', label:'建筑空间'},
  {id:'product', label:'产品工业'},
  {id:'transport', label:'交通工具'},
  {id:'character', label:'人物角色'},
  {id:'nature', label:'植物自然'},
  {id:'lighting', label:'灯光环境'},
  {id:'material', label:'材质贴图'},
  {id:'motion', label:'动画特效'},
  {id:'reference', label:'参考素材'},
  {id:'tools', label:'工具脚本'},
  {id:'technical', label:'图纸资料'},
  {id:'other', label:'其他'},
];

const categoryLabels = new Map(categories.map(({id, label}) => [id, label]));
const tagKey = tag => tag.normalize('NFKC').trim().toLowerCase();
const isAiCategory = tag => tagKey(tag).startsWith(tagKey(categoryPrefix));
const failureText = error => String(error?.message || error || '请求失败').slice(0, 240);

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function proposalTags(tags, existing) {
  const seen = new Set(existing.map(tagKey));
  const result = [];
  for (const value of Array.isArray(tags) ? tags : []) {
    if (typeof value !== 'string') continue;
    const tag = Array.from(value.replace(/[\p{Cc}]/gu, '').trim()).slice(0, 40).join('');
    const key = tagKey(tag);
    if (!key || seen.has(key) || isAiCategory(tag)) continue;
    result.push(tag);
    seen.add(key);
    if (result.length >= 12) break;
  }
  return result;
}

function mergeProposal(existing, tags, category) {
  const label = categoryLabels.get(category);
  const preserved = label ? existing.filter(tag => !isAiCategory(tag)) : existing;
  const next = [...(preserved.length < maxTags ? preserved : existing)];
  let omitted = 0;
  const seen = new Set(next.map(tagKey));
  const candidates = label ? [categoryPrefix + label, ...tags] : tags;
  for (const tag of candidates) {
    const key = tagKey(tag);
    if (seen.has(key)) continue;
    if (next.length >= maxTags) {
      omitted++;
      continue;
    }
    next.push(tag);
    seen.add(key);
  }
  const original = new Set(existing);
  const changed = next.length !== existing.length || next.some(tag => !original.has(tag));
  return {tags:next, omitted, changed};
}

export function initAssetAI({dialog, api, getAsset, scope, getImage, apply, onApplied, openDownload, log}) {
  const get = id => dialog.querySelector('#asset-ai-' + id);
  const selection = get('selection');
  const modelSelect = get('model');
  const checkButton = get('check');
  const setup = get('setup');
  const status = get('status');
  const results = get('results');
  const analyzeButton = get('analyze');
  const applyButton = get('apply');
  let current;
  let preferred = '';
  try { preferred = localStorage.getItem(modelKey) || ''; } catch {}

  function message(text, failed = false) {
    status.textContent = text;
    status.dataset.error = String(failed);
  }

  function proposalSelected(row) {
    return row.toggle.checked && !row.applied &&
      (row.category.value || row.tags.some(({toggle}) => toggle.checked));
  }

  function updateControls(session) {
    const busy = Boolean(session.operation);
    checkButton.disabled = busy || session.stale;
    modelSelect.disabled = busy || session.stale || !session.models.length;
    analyzeButton.disabled = busy || session.stale || !modelSelect.value;
    applyButton.disabled = busy || session.stale || !session.rows.some(proposalSelected);
    for (const row of session.rows) {
      row.toggle.disabled = busy || row.applied;
      row.category.disabled = busy || row.applied || !row.toggle.checked;
      for (const {toggle} of row.tags) toggle.disabled = busy || row.applied || !row.toggle.checked;
    }
  }

  function active(session) {
    if (!session || !dialog.open || current !== session) return false;
    if (session.scope === scope()) return true;
    session.stale = true;
    updateControls(session);
    message('工作空间已切换，请重新打开 AI 自动整理。', true);
    return false;
  }

  async function detect(session) {
    if (!active(session) || session.operation) return;
    session.operation = 'detect';
    setup.hidden = true;
    message('正在检测本机 Ollama 模型…');
    updateControls(session);
    try {
      const response = await api('asset_ai_models');
      if (!active(session)) return;
      session.models = Array.isArray(response?.models) ? response.models
        .filter(item => typeof item?.name === 'string' && item.name)
        .sort((left, right) => Number(Boolean(right.vision)) - Number(Boolean(left.vision))) : [];
      modelSelect.replaceChildren(...session.models.map(({name, vision}) =>
        new Option(name + (vision ? ' · 支持看图' : ''), name)));
      if (session.models.some(model => model.name === preferred)) modelSelect.value = preferred;
      if (session.models.length) message('可以开始分析。');
      else message('没有检测到可用模型。请在 Ollama 安装一个模型后重新检测。', true);
    } catch (error) {
      if (!active(session)) return;
      session.models = [];
      modelSelect.replaceChildren();
      message('检测模型失败 · ' + failureText(error), true);
    } finally {
      if (active(session)) {
        session.operation = '';
        setup.hidden = Boolean(session.models.length);
        if (!session.models.length) modelSelect.add(new Option('暂无可用模型', ''));
        updateControls(session);
      }
    }
  }

  function appendResult(session, asset, suggestion, usedImage) {
    const card = make('li', '', 'asset-ai-result');
    const head = make('label', '', 'asset-ai-result-heading');
    const toggle = make('input');
    toggle.type = 'checkbox';
    toggle.checked = true;
    const name = make('strong', asset.name);
    name.title = asset.name;
    const source = make('small', usedImage ? '图片和文件资料' : '文件资料', 'asset-ai-source');
    head.append(toggle, name);
    const heading = make('div', '', 'asset-ai-result-head');
    heading.append(head, source);

    const classification = make('label', '', 'asset-ai-category');
    const category = make('select', '', 'text-field');
    category.append(new Option('保留现有分类', ''), ...categories.map(({id, label}) => new Option(label, id)));
    if (categoryLabels.has(suggestion?.kind)) category.value = suggestion.kind;
    classification.append(make('span', '分类'), category);

    const tagChoices = make('div', '', 'asset-ai-tags');
    tagChoices.setAttribute('role', 'group');
    tagChoices.setAttribute('aria-label', '建议标签');
    const tags = proposalTags(suggestion?.tags, asset.tags || []).map(tag => {
      const label = make('label', '', 'asset-ai-tag');
      const toggle = make('input');
      toggle.type = 'checkbox';
      toggle.checked = true;
      label.append(toggle, make('span', tag));
      tagChoices.append(label);
      return {tag, toggle};
    });
    if (!tags.length) tagChoices.append(make('small', '暂无新的标签建议'));
    const feedback = make('p', '', 'asset-ai-result-feedback');
    feedback.setAttribute('role', 'status');
    card.append(heading, classification, tagChoices, feedback);
    const row = {id:asset.id, toggle, category, tags, feedback, applied:false};
    card.addEventListener('change', () => updateControls(session));
    session.rows.push(row);
    results.append(card);
  }

  function appendFailure(name, error) {
    const card = make('li', '', 'asset-ai-result');
    const feedback = make('p', failureText(error), 'asset-ai-result-feedback');
    feedback.dataset.error = 'true';
    card.append(make('strong', name), feedback);
    results.append(card);
  }

  async function analyze(session) {
    if (!active(session) || session.operation) return;
    const model = session.models.find(item => item.name === modelSelect.value);
    if (!model) return;
    session.operation = 'analyze';
    session.rows = [];
    results.replaceChildren();
    updateControls(session);
    let failed = 0;
    try {
      for (const [index, id] of session.ids.entries()) {
        if (!active(session)) return;
        message(`正在分析 ${index + 1} / ${session.ids.length}…`);
        const asset = getAsset(id);
        if (!asset) {
          appendFailure('资产已移除', '此资产已不在当前工作空间。');
          failed++;
          continue;
        }
        try {
          let image;
          if (model.vision) {
            try { image = await getImage(asset); } catch {}
          }
          if (!active(session)) return;
          const suggestion = await api('suggest_asset_ai', {
            model:model.name, name:asset.name, extension:asset.ext, kind:asset.kind,
            tags:asset.tags || [], categories, ...(image ? {image} : {}),
          });
          if (!active(session)) return;
          appendResult(session, asset, suggestion, Boolean(image));
        } catch (error) {
          if (!active(session)) return;
          appendFailure(asset.name, error);
          failed++;
        }
      }
      const summary = `已分析 ${session.rows.length} 项` + (failed ? `，${failed} 项失败` : '');
      message(summary + '。勾选需要应用的标签与分类。', failed > 0);
      log?.('AI 自动整理 · ' + summary, failed ? 'error' : 'info');
    } finally {
      if (active(session)) {
        session.operation = '';
        updateControls(session);
      }
    }
  }

  async function applyProposals(session) {
    if (!active(session) || session.operation) return;
    const rows = session.rows.filter(proposalSelected);
    if (!rows.length) return;
    session.operation = 'apply';
    updateControls(session);
    let saved = 0;
    let failed = 0;
    let unchanged = 0;
    try {
      for (const [index, row] of rows.entries()) {
        if (!active(session)) return;
        message(`正在应用 ${index + 1} / ${rows.length}…`);
        const asset = getAsset(row.id);
        const selected = row.tags.filter(({toggle}) => toggle.checked).map(({tag}) => tag);
        row.feedback.dataset.error = 'false';
        try {
          if (!asset) throw Error('资产已不在当前工作空间。');
          const {tags, omitted, changed} = mergeProposal(asset.tags || [], selected, row.category.value);
          if (changed) {
            await apply(asset, {tags});
            saved++;
          } else unchanged++;
          if (!active(session)) return;
          row.applied = true;
          row.feedback.textContent = (changed ? '已应用' : '没有新增内容') +
            (omitted ? ` · 标签已达上限，跳过 ${omitted} 项` : '');
        } catch (error) {
          if (!active(session)) return;
          row.feedback.textContent = failureText(error);
          row.feedback.dataset.error = 'true';
          failed++;
        }
      }
      const summary = [`已应用 ${saved} 项`, unchanged && `${unchanged} 项无需更改`, failed && `${failed} 项失败`].filter(Boolean).join(' · ');
      message(summary, failed > 0);
      log?.('AI 自动整理 · ' + summary, failed ? 'error' : 'info');
    } finally {
      if (active(session)) {
        session.operation = '';
        updateControls(session);
      }
      if (saved && session.scope === scope()) onApplied?.();
    }
  }

  checkButton.addEventListener('click', () => { void detect(current); });
  analyzeButton.addEventListener('click', () => { void analyze(current); });
  applyButton.addEventListener('click', () => { void applyProposals(current); });
  get('close').addEventListener('click', () => dialog.close());
  get('ollama').addEventListener('click', async () => {
    const session = current;
    try { await openDownload(); }
    catch (error) {
      if (active(session)) message('无法打开 Ollama 下载页 · ' + failureText(error), true);
    }
  });
  modelSelect.addEventListener('change', () => {
    preferred = modelSelect.value;
    try { localStorage.setItem(modelKey, preferred); } catch {}
    if (current) updateControls(current);
  });
  dialog.addEventListener('close', () => {
    if (!dialog.open) current = null;
  });

  return {
    show(ids) {
      if (dialog.open) return;
      const valid = [...new Set(ids)].filter(id => getAsset(id));
      if (!valid.length) return;
      const session = {
        ids:valid.slice(0, maxAssets), scope:scope(), operation:'', rows:[], models:[], stale:false,
      };
      current = session;
      selection.textContent = valid.length > maxAssets
        ? `所选 ${valid.length} 项，本次分析前 ${maxAssets} 项。`
        : `已选 ${valid.length} 项资产。`;
      modelSelect.replaceChildren(new Option('正在检测…', ''));
      results.replaceChildren();
      setup.hidden = true;
      dialog.showModal();
      void detect(session);
    },
  };
}
