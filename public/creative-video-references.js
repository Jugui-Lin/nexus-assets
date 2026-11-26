import {bindWhiteboardLinkDrag} from './whiteboard-links.js';

const storageKey = 'nexus-creative-video-references-v1';
const maximumReferences = 120;
const cardSelector = '[data-reference-index]';

export function initCreativeVideoReferences({panel, preferences, describe, readMetadata, play, openWeb, icon, escape, notify,
  whiteboardLinkDrop}) {
  const form = panel.querySelector('form');
  const input = form.querySelector('input');
  const status = panel.querySelector('[role="status"]');
  const list = panel.querySelector('ul');
  let records;
  let workspaceRevision = 0;
  let visible = false;
  let activeReads = 0;
  const attempted = new WeakSet();

  function cardMarkup(entry,index) {
    const title = escape(entry.title);
    const playLabel = entry.embedded ? '播放视频' : '打开原网页';
    const image = entry.displayCover ?
      '<img class="creator-work-image" src="' + escape(entry.displayCover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '';
    return '<li class="creator-work creator-reference-card" data-reference-index="' + index + '">' +
      '<div class="creator-work-cover" aria-hidden="true">' + icon('play') + image + '</div>' +
      '<div class="creator-reference-caption"><span class="creator-reference-label">' +
      '<strong class="creator-work-title" title="' + title + '">' + title + '</strong>' +
      '<span class="creator-reference-host">' + escape(entry.host) + '</span></span>' +
      '<button type="button" class="icon-button" data-reference-action="play" title="' + playLabel +
      '" aria-label="' + playLabel + ' · ' + title + '">' + icon(entry.embedded ? 'play' : 'drag-out') + '</button>' +
      (entry.embedded ? '<button type="button" class="icon-button" data-reference-action="open" title="打开原网页" aria-label="打开原网页 · ' +
        title + '">' + icon('drag-out') + '</button>' : '') +
      '<button type="button" class="icon-button" data-reference-action="remove" title="移除引用" aria-label="移除引用 · ' +
      title + '">' + icon('trash') + '</button></div></li>';
  }

  function render() {
    list.innerHTML = records.map(cardMarkup).join('');
    list.hidden = !records.length;
  }

  function reload() {
    workspaceRevision++;
    const unique = new Map();
    try {
      const saved = JSON.parse(preferences.getItem(storageKey));
      for (const candidate of Array.isArray(saved) ? saved.slice(0, maximumReferences) : []) {
        const entry = describe(candidate?.url,candidate?.title,candidate?.coverUrl);
        if (entry && !unique.has(entry.key)) unique.set(entry.key,entry);
      }
    } catch {}
    records = [...unique.values()];
    input.value = '';
    status.textContent = '';
    render();
    loadMissingMetadata();
  }

  function save(next, updatedIndex) {
    try {
      preferences.setItem(storageKey,JSON.stringify(next.map(({url,title,coverUrl}) => ({url,title,...(coverUrl && {coverUrl})}))));
    } catch {
      status.textContent = '暂时无法保存视频引用。';
      return false;
    }
    records = next;
    const card = list.children[updatedIndex];
    if (card) {
      const focus = card.contains(document.activeElement) ? document.activeElement.dataset.referenceAction : '';
      card.outerHTML = cardMarkup(records[updatedIndex],updatedIndex);
      if (focus) list.children[updatedIndex].querySelector('[data-reference-action="' + focus + '"]')?.focus({preventScroll:true});
    } else render();
    return true;
  }

  function loadMissingMetadata() {
    if (!visible || !readMetadata) return;
    const revision = workspaceRevision;
    for (const entry of records) {
      if (activeReads >= 3) break;
      if (!entry.needsMetadata || attempted.has(entry)) continue;
      attempted.add(entry);
      activeReads++;
      Promise.resolve().then(() => readMetadata(entry)).then(result => {
        if (!result || workspaceRevision !== revision) return;
        const index = records.indexOf(entry);
        if (index < 0) return;
        const updated = describe(entry.url,result.title || entry.title,result.coverUrl || entry.coverUrl);
        if (!updated || (updated.title === entry.title && updated.coverUrl === entry.coverUrl)) return;
        attempted.add(updated);
        const next = [...records];
        next[index] = updated;
        save(next,index);
      }).catch(() => {}).finally(() => {
        activeReads--;
        loadMissingMetadata();
      });
    }
  }

  function add() {
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
    if (!save([entry,...records])) return;
    input.value = '';
    status.textContent = '';
    loadMissingMetadata();
  }

  form.addEventListener('submit', event => { event.preventDefault(); add(); });
  input.addEventListener('input', () => { status.textContent = ''; });
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    input.value = text.trim().slice(0,2048);
    add();
  });
  list.addEventListener('click', event => {
    const card = event.target.closest(cardSelector);
    const index = Number(card?.dataset.referenceIndex);
    const entry = records[index];
    if (!entry) return;
    const action = event.target.closest('[data-reference-action]')?.dataset.referenceAction;
    if (action === 'remove') {
      if (save(records.filter(item => item !== entry))) {
        status.textContent = '';
        const next = list.children[Math.min(index,records.length - 1)];
        (next?.querySelector('[data-reference-action="play"]') || input).focus({preventScroll:true});
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
    resolve: card => records[Number(card.dataset.referenceIndex)],
  });
  reload();
  return {reload,setVisible(value) {
    visible = value;
    loadMissingMetadata();
  }};
}
