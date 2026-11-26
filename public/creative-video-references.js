import {bindWhiteboardLinkDrag} from './whiteboard-links.js';
import {downloadWorkspaceFile} from './workspace-download.js';

const storageKey = 'nexus-creative-video-references-v1';
const migrationKey = storageKey + ':team-migrated';
const maximumReferences = 120;
const cardSelector = '[data-reference-index]';
const savedReference = ({url,title,coverUrl}) => ({url,title,...(coverUrl && {coverUrl})});
const noteFields = [
  ['credit','来源署名',200,1],
  ['summary','内容摘要',800,3],
  ['chapters','章节与时间点',1000,3],
  ['usage','使用说明与选用理由',1000,3],
];

const cleanNotes = values => Object.fromEntries(noteFields.flatMap(([name,,limit]) => {
  const value = typeof values?.[name] === 'string' ? values[name].trim().slice(0,limit) : '';
  return value ? [[name,value]] : [];
}));

const markdown = value => value.replace(/([\\`*_{}\[\]()<>#!|~])/g,'\\$1');

export function referenceListMarkdown(entries) {
  const sections = ['# 视频参考清单'];
  for (const {entry,notes} of entries) {
    sections.push('## ' + markdown(entry.title.replace(/\s+/g,' ')));
    const url = entry.url.replace(/[<>]/g, char => char === '<' ? '%3C' : '%3E');
    sections.push(`- 来源：${markdown(entry.platform)} · <${url}>`);
    for (const [field,label] of noteFields) {
      if (!notes?.[field]) continue;
      const lines = notes[field].split(/\r?\n/u).map(line => markdown(line.trim()));
      sections.push(`- ${label}：${lines.join('\n  ')}`);
    }
  }
  return sections.join('\n\n') + '\n';
}

export function initCreativeVideoReferences({panel, preferences, describe, readMetadata, play, openWeb, icon, escape, notify,
  whiteboardLinkDrop, teamReferenceDrop, teamApi}) {
  const form = panel.querySelector('form');
  const addToggle = panel.querySelector('#creator-reference-add-button');
  const input = form.querySelector('input');
  const addButton = form.querySelector('[type="submit"]');
  const cancelAdd = form.querySelector('button[type="button"]');
  const status = panel.querySelector('#creator-video-reference-status');
  const teamStatus = panel.querySelector('#creator-reference-team-status');
  const search = panel.querySelector('input[type="search"]');
  const searchEmpty = panel.querySelector('#creator-reference-search-empty');
  const exportButton = panel.querySelector('#creator-reference-export');
  const list = panel.querySelector('ul');
  let records = [];
  let team = null;
  let renderedCards = '';
  let workspaceRevision = 0;
  let visible = false;
  let activeReads = 0;
  let notesKey;
  let notes = new Map();
  let noteDraft = null;
  const attempted = new WeakSet();

  const noteEditor = document.createElement('dialog');
  noteEditor.className = 'modal creator-reference-note-dialog';
  noteEditor.setAttribute('aria-labelledby','creator-reference-note-title');
  noteEditor.innerHTML = `
    <form>
      <div class="modal-header"><h2 id="creator-reference-note-title">视频参考资料</h2><button type="button" class="icon-button" data-note-close aria-label="关闭">${icon('close')}</button></div>
      <p class="modal-description" data-note-source></p>
      <p class="modal-description">此处资料保存在本机。导出清单时会包含已填写的内容。</p>
      ${noteFields.map(([name,label,limit,rows]) => `
        <label class="field-label"><span>${label}</span><textarea class="text-field" name="${name}" rows="${rows}" maxlength="${limit}"${name === 'chapters' ? ' placeholder="例如 02:15 光线设置"' : ''}></textarea></label>`).join('')}
      <div class="modal-footer"><p role="alert" data-note-status></p><button type="submit" class="button primary">保存资料</button></div>
    </form>`;
  document.body.append(noteEditor);
  const noteForm = noteEditor.querySelector('form');
  const noteStatus = noteEditor.querySelector('[data-note-status]');

  function cardMarkup(entry,index) {
    const title = escape(entry.title);
    const playLabel = entry.embedded ? '播放视频' : '打开原网页';
    const image = entry.displayCover ?
      '<img class="creator-work-image" src="' + escape(entry.displayCover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '';
    return '<li class="creator-work creator-reference-card" data-reference-index="' + index + '">' +
      '<div class="creator-work-cover" aria-hidden="true">' + icon('play') + image + '</div>' +
      '<div class="creator-reference-caption"><span class="creator-reference-label">' +
      '<strong class="creator-work-title" title="' + title + '">' + title + '</strong>' +
      '<span class="creator-reference-host" title="' + escape(notes.get(entry.key)?.credit || entry.host) + '">' +
      escape(notes.get(entry.key)?.credit || entry.host) + '</span></span>' +
      '<button type="button" class="icon-button" data-reference-action="play" title="' + playLabel +
      '" aria-label="' + playLabel + ' · ' + title + '">' + icon(entry.embedded ? 'play' : 'drag-out') + '</button>' +
      (entry.embedded ? '<button type="button" class="icon-button" data-reference-action="open" title="打开原网页" aria-label="打开原网页 · ' +
        title + '">' + icon('drag-out') + '</button>' : '') +
      '<button type="button" class="icon-button" data-reference-action="notes" title="视频参考资料" aria-label="视频参考资料 · ' +
      title + '"' + (notes.has(entry.key) ? ' data-has-notes' : '') + '>' + icon('notes') + '</button>' +
      '<button type="button" class="icon-button" data-reference-action="remove" title="移除引用" aria-label="移除引用 · ' +
      title + '"' + (team && !Number.isSafeInteger(entry.revision) ? ' disabled' : '') +
      '>' + icon('trash') + '</button></div></li>';
  }

  function displayedEntries() {
    const query = search.value.trim().toLocaleLowerCase();
    return records.flatMap((entry,index) => {
      const data = notes.get(entry.key);
      const searchable = [entry.title,entry.platform,entry.url,...Object.values(data || {})];
      return !query || searchable.some(value => value.toLocaleLowerCase().includes(query))
        ? [{entry,index,notes:data}] : [];
    });
  }

  function render() {
    const shown = displayedEntries();
    const cards = shown.map(({entry,index}) => cardMarkup(entry,index)).join('');
    if (renderedCards !== cards) {
      const action = list.contains(document.activeElement) && document.activeElement.dataset.referenceAction;
      const index = action && document.activeElement.closest(cardSelector)?.dataset.referenceIndex;
      renderedCards = cards;
      list.innerHTML = cards;
      if (index) list.querySelector('[data-reference-index="' + index + '"] [data-reference-action="' + action + '"]')
        ?.focus({preventScroll:true});
    }
    list.hidden = !cards;
    searchEmpty.hidden = !search.value.trim() || Boolean(cards);
    exportButton.disabled = !shown.length;
  }

  function normalize(rows, shared = false) {
    const unique = new Map();
    for (const candidate of Array.isArray(rows) ? rows.slice(0, maximumReferences) : []) {
      if (shared && !Number.isSafeInteger(candidate?.revision)) continue;
      const entry = describe(candidate?.url,candidate?.title,candidate?.coverUrl);
      if (entry && !unique.has(entry.key)) {
        unique.set(entry.key, shared ? {...entry,revision:candidate.revision,referenceKey:candidate.key} : entry);
      }
    }
    return [...unique.values()];
  }

  function readLocal(shared) {
    try {
      if (shared && preferences.getItem(migrationKey) === '1') return [];
      return normalize(JSON.parse(preferences.getItem(storageKey)));
    }
    catch { return []; }
  }

  function clearSearch() {
    search.value = '';
    render();
  }

  function syncAddControls() {
    const pending = Boolean(team?.mutating);
    const unavailable = Boolean(team && !team.available);
    addToggle.disabled = pending || (unavailable && form.hidden);
    addButton.disabled = pending || unavailable;
    cancelAdd.disabled = pending;
  }

  function setAdding(open, focus = false) {
    form.hidden = !open;
    addToggle.setAttribute('aria-expanded',String(open));
    status.textContent = '';
    if (!open) input.value = '';
    syncAddControls();
    if (focus) (open ? input : addToggle.disabled ? search : addToggle).focus({preventScroll:true});
  }

  function renderTeamStatus() {
    teamStatus.hidden = !team || team.phase === 'ready';
    teamStatus.dataset.phase = team?.phase || '';
    teamStatus.textContent = team?.phase === 'ready' ? '团队共享 · 已同步' :
      team?.phase === 'error' ? '团队视频引用同步失败，可点击「刷新订阅」重试。' :
      team?.phase === 'unavailable' ? '团队服务需要更新后才能同步视频引用。' :
      team ? '正在同步团队视频引用…' : '';
    syncAddControls();
  }

  function reload(context = null) {
    workspaceRevision++;
    if (noteEditor.open) noteEditor.close();
    noteDraft = null;
    notesKey = `${storageKey}:notes:${context?.cacheKey || context?.teamId || 'personal'}`;
    try {
      const saved = JSON.parse(preferences.getItem(notesKey));
      notes = new Map((Array.isArray(saved) ? saved : []).slice(-maximumReferences * 2).flatMap(row =>
        Array.isArray(row) && typeof row[0] === 'string' ? [[row[0],cleanNotes(row[1])]] : []));
    } catch {
      notes = new Map();
    }
    records = readLocal(Boolean(context));
    team = context ? {
      teamId:context.teamId, phase:'loading', pending:Promise.resolve(), legacy:records, shared:[],
      migrating:records.length > 0,
    } : null;
    setAdding(false);
    clearSearch();
    renderTeamStatus();
    loadMissingMetadata();
  }

  function saveLocal(next) {
    try {
      preferences.setItem(storageKey,JSON.stringify(next.map(savedReference)));
    } catch {
      status.textContent = '暂时无法保存视频引用。';
      return false;
    }
    records = next;
    render();
    return true;
  }

  function renderShared(workspace) {
    const merged = new Map(workspace.shared.map(entry => [entry.key,entry]));
    for (const entry of workspace.legacy) if (!merged.has(entry.key)) merged.set(entry.key,entry);
    records = [...merged.values()];
    render();
  }

  function applySnapshot(workspace, result, migratedKey) {
    if (!Array.isArray(result?.references)) throw Error('团队视频引用数据无效。');
    const previous = new Map(workspace.shared.map(entry => [entry.key,entry]));
    workspace.shared = normalize(result.references,true).map(entry => {
      const old = previous.get(entry.key);
      return old && old.revision === entry.revision && old.referenceKey === entry.referenceKey && old.url === entry.url &&
        old.title === entry.title && old.coverUrl === entry.coverUrl ? old : entry;
    });
    if (migratedKey) workspace.legacy = workspace.legacy.filter(item => item.key !== migratedKey);
    renderShared(workspace);
  }

  function queueTeam(workspace, perform) {
    const task = workspace.pending.then(() => {
      if (workspace === team) return perform();
    });
    workspace.pending = task.catch(() => {});
    return task;
  }

  function syncTeam() {
    const workspace = team;
    if (!workspace?.teamId || !teamApi) return;
    if (workspace.refreshing) return workspace.refreshing;
    workspace.refreshing = queueTeam(workspace, async () => {
      const {teamId} = workspace;
      try {
        const snapshot = await teamApi('team_creative_video_references',{teamId});
        if (workspace !== team) return;
        workspace.available = snapshot?.available === true;
        if (!workspace.available) { workspace.phase = 'unavailable'; return; }
        applySnapshot(workspace,snapshot);
        for (const entry of [...workspace.legacy].reverse()) {
          try {
            const result = await teamApi('team_save_creative_video_reference',{
              teamId, reference:savedReference(entry), migration:true,
            });
            if (workspace !== team) return;
            applySnapshot(workspace,result,entry.key);
          } catch {
            if (workspace !== team) return;
          }
        }
        if (workspace.migrating && !workspace.legacy.length) {
          try { preferences.setItem(migrationKey,'1'); } catch {}
          workspace.migrating = false;
        }
        workspace.phase = workspace.legacy.length ? 'error' : 'ready';
      } catch {
        workspace.phase = 'error';
      } finally {
        workspace.refreshing = null;
        if (workspace === team) {
          renderTeamStatus();
          loadMissingMetadata();
        }
      }
    });
    return workspace.refreshing;
  }

  async function changeTeam(command, payload, entry) {
    const workspace = team;
    if (!workspace?.available || workspace.mutating) return false;
    workspace.mutating = true;
    renderTeamStatus();
    try {
      return await queueTeam(workspace, async () => {
        const current = entry && workspace.shared.find(item => item.key === entry.key);
        if (entry && current?.revision !== entry.revision) throw Error('视频引用已变化，请重试。');
        const result = await teamApi(command,{
          teamId:workspace.teamId, ...payload, ...(entry && {revision:entry.revision}),
        });
        if (workspace !== team) return false;
        applySnapshot(workspace,result);
        return true;
      });
    } catch (failure) {
      if (workspace === team) {
        status.textContent = String(failure?.message || failure || '暂时无法保存团队视频引用。').slice(0,200);
        syncTeam();
      }
      return false;
    } finally {
      workspace.mutating = false;
      if (workspace === team) {
        renderTeamStatus();
        loadMissingMetadata();
      }
    }
  }

  function loadMissingMetadata() {
    if (!visible || !readMetadata) return;
    const revision = workspaceRevision;
    for (const entry of records) {
      if (activeReads >= 3) break;
      if (!entry.needsMetadata || attempted.has(entry) || (team && !Number.isSafeInteger(entry.revision))) continue;
      const workspace = team;
      attempted.add(entry);
      activeReads++;
      Promise.resolve().then(() => readMetadata(entry)).then(async result => {
        if (!result || workspaceRevision !== revision) return;
        const index = records.indexOf(entry);
        if (index < 0) return;
        const updated = describe(entry.url,result.title || entry.title,result.coverUrl || entry.coverUrl);
        if (!updated || (updated.title === entry.title && updated.coverUrl === entry.coverUrl)) return;
        attempted.add(updated);
        if (workspace) {
          await queueTeam(workspace, async () => {
            if (!workspace.shared.includes(entry)) return;
            const snapshot = await teamApi('team_save_creative_video_reference',{
              teamId:workspace.teamId, reference:savedReference(updated), revision:entry.revision,
            });
            if (workspace === team) applySnapshot(workspace,snapshot);
          });
          return;
        }
        const next = [...records];
        next[index] = updated;
        saveLocal(next);
      }).catch(() => {}).finally(() => {
        activeReads--;
        loadMissingMetadata();
      });
    }
  }

  async function add() {
    const scope = workspaceRevision;
    if (team && (!team.available || team.mutating)) return;
    const entry = describe(input.value);
    if (!entry) { status.textContent = '请粘贴有效的公开视频网址。'; return; }
    if (records.some(item => item.key === entry.key)) {
      status.textContent = '这个视频已添加。';
      return;
    }
    if (records.length >= maximumReferences) {
      status.textContent = '已达到视频引用上限，请先移除一项。';
      return;
    }
    const entered = input.value;
    const hadFormFocus = form.contains(document.activeElement);
    const saved = team ? await changeTeam('team_save_creative_video_reference',{reference:savedReference(entry)}) :
      saveLocal([entry,...records]);
    if (!saved || workspaceRevision !== scope) return;
    if (input.value === entered) {
      setAdding(false,hadFormFocus && (form.contains(document.activeElement) || document.activeElement === document.body));
    }
    status.textContent = '';
    loadMissingMetadata();
  }

  form.addEventListener('submit', event => { event.preventDefault(); add(); });
  exportButton.addEventListener('click', () => {
    const shown = displayedEntries();
    if (!shown.length) return;
    downloadWorkspaceFile(document,'Nexus 视频参考清单.md',referenceListMarkdown(shown),'text/markdown;charset=utf-8');
  });
  noteEditor.querySelector('[data-note-close]').addEventListener('click',() => noteEditor.close());
  noteEditor.addEventListener('close',() => { if (!noteEditor.open) noteDraft = null; });
  noteForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!noteDraft || noteDraft.scope !== workspaceRevision || !records.some(entry => entry.key === noteDraft.key)) {
      noteStatus.textContent = '此视频引用已变化，请重新打开资料。';
      return;
    }
    const next = new Map(notes);
    const data = cleanNotes(Object.fromEntries(new FormData(noteForm)));
    next.delete(noteDraft.key);
    if (Object.keys(data).length) next.set(noteDraft.key,data);
    const bounded = [...next].slice(-maximumReferences * 2);
    try { preferences.setItem(notesKey,JSON.stringify(bounded)); }
    catch { noteStatus.textContent = '暂时无法保存视频资料。'; return; }
    notes = new Map(bounded);
    const key = noteDraft.key;
    noteEditor.close();
    render();
    const index = records.findIndex(entry => entry.key === key);
    (list.querySelector('[data-reference-index="' + index + '"] [data-reference-action="notes"]')
      || search).focus({preventScroll:true});
  });
  addToggle.addEventListener('click', () => setAdding(form.hidden,true));
  cancelAdd.addEventListener('click', () => setAdding(false,true));
  form.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (!team?.mutating) setAdding(false,true);
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !search.value) return;
    event.preventDefault();
    event.stopPropagation();
    clearSearch();
  });
  input.addEventListener('input', () => { status.textContent = ''; });
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    input.value = text.trim().slice(0,2048);
    add();
  });
  list.addEventListener('click', async event => {
    const card = event.target.closest(cardSelector);
    const index = Number(card?.dataset.referenceIndex);
    const entry = records[index];
    if (!entry) return;
    const action = event.target.closest('[data-reference-action]')?.dataset.referenceAction;
    if (action === 'notes') {
      if (noteEditor.open) return;
      noteDraft = {scope:workspaceRevision,key:entry.key};
      noteStatus.textContent = '';
      noteEditor.querySelector('[data-note-source]').textContent = entry.title;
      for (const [key] of noteFields) noteForm.elements[key].value = notes.get(entry.key)?.[key] || '';
      noteEditor.showModal();
      noteForm.elements.credit.focus();
    } else if (action === 'remove') {
      const scope = workspaceRevision;
      const position = [...list.children].indexOf(card);
      const removed = team ? Number.isSafeInteger(entry.revision) &&
        await changeTeam('team_delete_creative_video_reference',{url:entry.url},entry) :
        saveLocal(records.filter(item => item !== entry));
      if (removed && workspaceRevision === scope) {
        status.textContent = '';
        const next = list.children[Math.min(position,list.children.length - 1)];
        (next?.querySelector('[data-reference-action="play"]') || search).focus({preventScroll:true});
      }
    } else if (action === 'open' || !entry.embedded) openWeb(entry.url);
    else play(entry);
  });
  list.addEventListener('error', event => {
    const image = event.target;
    if (!image.matches('.creator-work-image')) return;
    const entry = records[Number(image.closest(cardSelector)?.dataset.referenceIndex)];
    if (entry?.coverUrl && image.src !== entry.coverUrl) image.src = entry.coverUrl;
    else image.hidden = true;
  },true);

  if (whiteboardLinkDrop) bindWhiteboardLinkDrag(list, {
    ...whiteboardLinkDrop, cardSelector, icon, notify,
    ...(teamReferenceDrop && {alternateTarget:{
      ...teamReferenceDrop,
      available:entry => Boolean(team && entry.referenceKey && teamReferenceDrop.available()),
    }}),
    resolve: card => records[Number(card.dataset.referenceIndex)],
  });

  const findShared = referenceKey => referenceKey ? records.findIndex(entry => entry.referenceKey === referenceKey) : -1;
  function locate(referenceKey) {
    const index = findShared(referenceKey);
    if (index < 0) return false;
    clearSearch();
    const card = list.querySelector('[data-reference-index="' + index + '"]');
    if (!card) return false;
    card.scrollIntoView({block:'nearest',inline:'nearest'});
    card.querySelector('[data-reference-action="play"]')?.focus({preventScroll:true});
    card.classList.add('is-located');
    setTimeout(() => card.classList.remove('is-located'),1800);
    return true;
  }

  reload();
  return {reload,syncTeam,locate,hasShared: key => findShared(key) >= 0,setVisible(value) {
    visible = value;
    loadMissingMetadata();
  }};
}
