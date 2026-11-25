const subscriptionKey = 'nexus-creative-subscriptions-v1';
const workLayoutKey = 'nexus-creator-work-layout';
const creatorOrderKey = 'nexus-creator-card-order';
const maximumCreators = 100;
const teamRefreshInterval = 20_000;
const playerLoadingTimeout = 12_000;
const xinpianchangEditorial = 'https://www.xinpianchang.com/recommend/editor';
const youtubeImages = new Set(['i.ytimg.com', 'i1.ytimg.com', 'i2.ytimg.com', 'i3.ytimg.com', 'i4.ytimg.com',
  'yt3.googleusercontent.com', 'yt3.ggpht.com']);
const knownPlatforms = [
  ['Behance', 'behance.net'], ['Instagram', 'instagram.com'], ['哔哩哔哩', 'bilibili.com'],
  ['YouTube', 'youtube.com', 'youtu.be'], ['Vimeo', 'vimeo.com'], ['ArtStation', 'artstation.com'], ['新片场', 'xinpianchang.com'],
];
const dateFormat = new Intl.DateTimeFormat('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});

function webUrl(value, httpsOnly = false) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol) ||
        (httpsOnly && url.protocol !== 'https:')) return null;
    return url;
  } catch { return null; }
}

function creatorUrl(value) {
  const raw = value.trim();
  const embedded = raw.match(/https?:\/\/[^\s<>"'，。；、！？（）【】]+/i)?.[0];
  const naked = /^[^\s/:?#]+\.[^\s/:?#]+(?:[/?#]|$)/.test(raw) ? 'https://' + raw : '';
  const url = (!/\s/.test(raw) && webUrl(raw)) || webUrl(embedded?.replace(/[),.;!]+$/, '')) || webUrl(naked);
  if (!url) return null;
  if (url.hostname === 'space.bilibili.com' && /^\/\d+\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
  } else if (['www.xinpianchang.com', 'xinpianchang.com'].includes(url.hostname) && !url.port && /^\/recommend\/editor\/?$/.test(url.pathname)) {
    return new URL(xinpianchangEditorial);
  }
  return url;
}

function publicName(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120) : '';
}

function description(value, limit) {
  return typeof value === 'string' ? value.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit) : '';
}

function mediaUrl(value) {
  const url = webUrl(value, true);
  if (!url || url.port) return '';
  return url.hostname.endsWith('.hdslb.com') || youtubeImages.has(url.hostname) ||
    url.hostname === 'oss-xpc0.xpccdn.com' ? url.href : '';
}

function bilibiliPlayerUrl(value) {
  const source = webUrl(value, true);
  if (!source || source.port ||
      !['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(source.hostname)) return null;
  const video = source.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,19})\/?$/i);
  const episode = source.pathname.match(/^\/bangumi\/play\/ep([1-9]\d{0,19})\/?$/);
  if (!video && !episode) return null;
  const player = new URL('https://player.bilibili.com/player.html');
  if (episode) player.searchParams.set('episodeId', episode[1]);
  else if (video[1].slice(0, 2).toLowerCase() === 'bv') player.searchParams.set('bvid', 'BV' + video[1].slice(2));
  else player.searchParams.set('aid', video[1].slice(2));
  const part = source.searchParams.get('p') || '';
  if (video && /^[1-9]\d{0,3}$/.test(part)) player.searchParams.set('p', part);
  player.searchParams.set('autoplay', '1');
  player.searchParams.set('danmaku', '0');
  return player.href;
}

function youtubePlayerUrl(value) {
  const source = webUrl(value, true);
  if (!source || source.port) return null;

  let id;
  if (source.hostname === 'youtu.be') {
    id = source.pathname.match(/^\/([\w-]{11})\/?$/)?.[1];
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(source.hostname)) {
    id = source.pathname === '/watch' ? source.searchParams.get('v') :
      source.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/)?.[1];
  } else if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(source.hostname)) {
    id = source.pathname.match(/^\/embed\/([\w-]{11})\/?$/)?.[1];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;

  const player = new URL(`https://www.youtube.com/embed/${id}`);
  player.searchParams.set('autoplay', '1');
  player.searchParams.set('playsinline', '1');
  return player.href;
}

function xinpianchangArticleId(value) {
  const article = webUrl(value, true);
  if (!article || article.port || !['xinpianchang.com', 'www.xinpianchang.com'].includes(article.hostname)) return null;
  return article.pathname.match(/^\/a([1-9]\d{0,19})\/?$/)?.[1] ?? null;
}

function xinpianchangPlayerUrl(value, articleId) {
  const player = webUrl(value, true);
  if (!player || player.port || player.hostname !== 'player.xinpianchang.com' || player.pathname !== '/' || player.hash) return null;
  const {searchParams} = player;
  return searchParams.size === 2 && searchParams.get('aid') === articleId &&
    /^[A-Za-z0-9]{1,64}$/.test(searchParams.get('mid') || '') ? player.href : null;
}

function profileMetadata(profile) {
  return {avatarUrl:mediaUrl(profile?.avatarUrl), bio:description(profile?.bio, 400)};
}

function durationLabel(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const tail = String(seconds % 60).padStart(2, '0');
  return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + tail : minutes + ':' + tail;
}

function platformFor(url) {
  const host = new URL(url).hostname;
  return knownPlatforms.find(([, ...domains]) => domains.some(domain => host === domain || host.endsWith('.' + domain)))?.[0] || '其他平台';
}

function directFeed(source) {
  if (source.feed) return source.feed;
  const url = webUrl(source.url, true);
  return url && /(?:\.(?:rss|atom|xml)|\/(?:rss|atom|feed)\/?)$/i.test(url.pathname) ? url.href : '';
}

function profileLabel(creator) {
  if (creator.url === xinpianchangEditorial) return '新片场 · 编辑精选';
  const url = new URL(creator.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const handle = parts.find(part => part.startsWith('@')) ||
    (parts[0] === 'channel' ? parts[1] : parts[0]);
  if (!handle || directFeed({url:creator.url})) return url.hostname;
  try { return decodeURIComponent(handle).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) || url.hostname; }
  catch { return handle.slice(0, 120); }
}

function normalizedCreators(parsed) {
  if (!Array.isArray(parsed)) return [];
  const ids = new Set();
  return parsed.slice(0, maximumCreators).flatMap(source => {
    const url = typeof source?.url === 'string' ? creatorUrl(source.url) : null;
    if (!url || typeof source.id !== 'string' || !source.id || ids.has(source.id)) return [];
    ids.add(source.id);
    return [{id:source.id, name:typeof source.name === 'string' ? source.name.slice(0, 120) : '',
      detectedName:publicName(source.detectedName), url:url.href, feed:webUrl(source.feed, true)?.href || '',
      ...profileMetadata(source), ...(Number.isSafeInteger(source.revision) ? {revision:source.revision} : {})}];
  });
}

function readCreators(key = subscriptionKey) {
  try {
    return normalizedCreators(JSON.parse(localStorage.getItem(key)));
  } catch { return []; }
}

function normalizedWorks(items, {preserveOrder = false} = {}) {
  const seen = new Set();
  const works = [];
  for (const item of Array.isArray(items) ? items.slice(0, 100) : []) {
    const url = webUrl(item?.url);
    const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 400) : '';
    if (!url || !title || seen.has(url.href)) continue;
    seen.add(url.href);
    const timestamp = item.publishedTimestamp;
    const parsed = Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 253402300799
      ? timestamp * 1000
      : typeof item.publishedAt === 'string' ? Date.parse(item.publishedAt) : NaN;
    works.push({title, url:url.href, time:Number.isFinite(parsed) ? parsed : null,
      platform:platformFor(url.href), coverUrl:mediaUrl(item.coverUrl), summary:description(item.description, 500),
      duration:durationLabel(item.durationSeconds),
      views:Number.isSafeInteger(item.viewCount) && item.viewCount >= 0 ? item.viewCount : null});
  }
  if (!preserveOrder) works.sort((a, b) => (b.time ?? -Infinity) - (a.time ?? -Infinity));
  return works;
}

export function initCreativeSubscriptions({api, native, icon, escape, openWeb, log, notify = () => {},
  subscriptionScope = () => null, personalScope = () => 'personal', preferences = localStorage}) {
  const get = id => document.getElementById(id);
  const section = get('creative-subscriptions');
  const overview = get('creator-overview');
  const cards = get('creator-cards');
  const creatorSearch = get('creator-search');
  const platform = get('creator-platform');
  const detail = get('creator-detail');
  const workSearch = get('creator-work-search');
  const workList = get('creator-works');
  const workLayoutPreference = get('creator-work-default-layout');
  const player = get('creator-player-dialog');
  const playerTitle = get('creator-player-title');
  const playerMeta = get('creator-player-meta');
  const playerStage = get('creator-player-stage');
  const playerView = get('creator-player-view');
  const playerFeedback = get('creator-player-feedback');
  const playerStatus = get('creator-player-status');
  const playerRetry = get('creator-player-retry');
  const playerTheater = get('creator-player-theater');
  const playerPage = get('creator-player-page');
  const workViews = [...detail.querySelectorAll('[data-work-layout]')];
  const detailMark = get('creator-detail-mark');
  const detailBio = get('creator-detail-bio');
  const editor = get('creative-subscription-dialog');
  const form = get('creative-subscription-form');
  const formStatus = get('creator-form-status');
  const profileStatus = get('creator-profile-status');
  const linkField = get('creator-url');
  const nameField = get('creator-name');
  const feedField = get('creator-feed-url');
  const removeConfirm = get('creator-remove-confirm');
  const scroller = get('browser-scroll');
  const libraryStatus = get('creator-library-status');
  const detailLibraryStatus = get('creator-detail-library-status');
  const mergeButton = get('creator-merge-local');
  const statuses = new Map();
  const scheduled = new Map();
  const pendingProfiles = new WeakSet();
  const queue = [];
  let personalKey = subscriptionKey;
  let creators = readCreators(personalKey);
  let active = false;
  let opened = false;
  let pending = 0;
  let selected = null;
  let editing = null;
  let editingRevision;
  let editorBusy = false;
  let workspaceEpoch = 0;
  let teamWorkspace = null;
  let overviewScroll = 0;
  let overviewMarkup = '';
  let creatorOrder = readCreatorOrder();
  let creatorDrag;
  let creatorDrop;
  let workMarkup = '';
  let detailMarkMarkup = '';
  let visibleWorks = [];
  let selectedWork = '';
  let playingWork;
  let playerTimer;
  let playerAttempt = 0;
  let playerBackdropDown = false;
  let workLayout = readWorkLayout();
  let profileTimer;
  let profileRequest = 0;
  let nameTouched = false;
  let feedTouched = false;
  let profileUrl = '';
  let inspectedProfile;

  const find = id => creators.find(creator => creator.id === id);
  const canSync = creator => Boolean(directFeed(creator) || webUrl(creator.url, true));
  const label = creator => creator.name || creator.detectedName || statuses.get(creator.id)?.title || profileLabel(creator);
  const mark = creator => [...label(creator)].slice(0, 2).join('').toLocaleUpperCase();
  const canWrite = () => !teamWorkspace || (teamWorkspace.phase === 'ready' && !teamWorkspace.writing);
  const errorMessage = failure => String(failure?.message || failure || '团队订阅同步失败').slice(0, 200);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const creatorMoveEasing = 'cubic-bezier(.2, .8, .2, 1)';

  function readWorkLayout() {
    try { return preferences.getItem(workLayoutKey) === 'list' ? 'list' : 'cards'; }
    catch { return 'cards'; }
  }

  function readCreatorOrder() {
    try {
      const order = JSON.parse(preferences.getItem(creatorOrderKey));
      return Array.isArray(order) ? [...new Set(order.slice(0, maximumCreators).filter(id => typeof id === 'string'))] : [];
    } catch { return []; }
  }

  function orderedCreators() {
    const remaining = new Map(creators.map(creator => [creator.id, creator]));
    const ordered = [];
    for (const id of creatorOrder) {
      if (!remaining.has(id)) continue;
      ordered.push(remaining.get(id));
      remaining.delete(id);
    }
    return [...ordered, ...remaining.values()];
  }

  function moveCreator(id, targetId, visibleIds) {
    const current = orderedCreators().map(creator => creator.id);
    const visible = new Set(visibleIds);
    const selectedIds = current.filter(key => visible.has(key));
    const from = selectedIds.indexOf(id);
    const to = selectedIds.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return false;
    selectedIds.splice(from, 1);
    selectedIds.splice(to, 0, id);
    let index = 0;
    creatorOrder = current.map(key => visible.has(key) ? selectedIds[index++] : key);
    try { preferences.setItem(creatorOrderKey, JSON.stringify(creatorOrder)); }
    catch { notify('无法保存创作者卡片顺序。', true); }
    return true;
  }

  function startCreatorDrag(drag) {
    const bounds = drag.card.getBoundingClientRect();
    const preview = drag.card.cloneNode(true);
    preview.classList.add('creator-card--drag-preview');
    delete preview.dataset.creatorId;
    preview.removeAttribute('tabindex');
    preview.setAttribute('aria-hidden', 'true');
    preview.inert = true;
    preview.style.width = `${bounds.width}px`;
    preview.style.height = `${bounds.height}px`;
    preview.style.transform = `translate(${bounds.left}px, ${bounds.top}px)`;
    drag.offsetX = drag.x - bounds.left;
    drag.offsetY = drag.y - bounds.top;
    drag.width = bounds.width;
    drag.height = bounds.height;
    drag.preview = preview;
    drag.card.classList.add('is-reordering');
    document.body.append(preview);
  }

  function placeCreatorCard(drag, before) {
    const focused = document.activeElement === drag.grip;
    cards.insertBefore(drag.card, before);
    if (focused) drag.grip.focus({preventScroll:true});
  }

  function shiftCreatorCards(drag, slots, index) {
    // Start each move from the position on screen, even during an earlier move.
    const previous = reducedMotion.matches ? [] : slots.filter(card => card !== drag.card)
      .map(card => [card, card.getBoundingClientRect()]);
    for (const animation of drag.shifts) animation.cancel();
    drag.shifts.length = 0;
    const target = slots[index];
    placeCreatorCard(drag, index > drag.index ? target.nextElementSibling : target);
    drag.index = index;
    for (const [card, from] of previous) {
      const to = card.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx || dy) drag.shifts.push(card.animate([
        {transform:`translate(${dx}px, ${dy}px)`}, {transform:'none'},
      ], {duration:185, easing:creatorMoveEasing}));
    }
  }

  function updateCreatorDrop(autoscroll = true) {
    const drag = creatorDrag;
    if (!drag?.preview) return;
    drag.frame = 0;
    drag.preview.style.transform = `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px)`;
    const bounds = scroller.getBoundingClientRect();
    drag.inSlot = false;
    if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) return;
    const grid = cards.getBoundingClientRect();
    const x = drag.x - grid.left;
    const y = drag.y - grid.top;
    const slots = [...cards.children];
    // Use grid geometry so animated cards cannot change which slot was hit.
    const index = slots.findIndex(card => x >= card.offsetLeft - drag.gapX &&
      x < card.offsetLeft + card.offsetWidth + drag.gapX && y >= card.offsetTop - drag.gapY &&
      y < card.offsetTop + card.offsetHeight + drag.gapY);
    drag.inSlot = index >= 0;
    if (drag.inSlot && index !== drag.index) shiftCreatorCards(drag, slots, index);
    if (!autoscroll) return;
    const step = drag.y < bounds.top + 36 ? -12 : drag.y > bounds.bottom - 36 ? 12 : 0;
    const before = scroller.scrollTop;
    scroller.scrollTop += step;
    if (scroller.scrollTop !== before) drag.frame = requestAnimationFrame(() => updateCreatorDrop());
  }

  function clearCreatorPreview(drag) {
    for (const animation of drag.shifts) animation.cancel();
    drag.preview?.remove();
    drag.card.classList.remove('is-reordering');
  }

  function finishCreatorDrop() {
    if (!creatorDrop) return;
    const {animation, drag} = creatorDrop;
    creatorDrop = undefined;
    animation.cancel();
    clearCreatorPreview(drag);
    if (active) render();
  }

  function endCreatorDrag(apply = false) {
    const drag = creatorDrag;
    if (!drag) return;
    creatorDrag = undefined;
    cancelAnimationFrame(drag.frame);
    if (cards.hasPointerCapture(drag.pointer)) cards.releasePointerCapture(drag.pointer);
    const moved = drag.index !== drag.startIndex;
    const drop = apply && drag.inSlot && (!moved ||
      moveCreator(drag.card.dataset.creatorId, drag.visibleIds[drag.index], drag.visibleIds));
    if (!drop && moved) placeCreatorCard(drag, drag.originalNext);
    if (!drop || reducedMotion.matches) {
      clearCreatorPreview(drag);
      if (active) render();
      return;
    }
    const target = drag.card.getBoundingClientRect();
    const animation = drag.preview.animate([
      {transform:drag.preview.style.transform},
      {transform:`translate(${target.left}px, ${target.top}px) scale(${target.width / drag.width}, ${target.height / drag.height})`},
    ], {duration:170, easing:creatorMoveEasing, fill:'forwards'});
    creatorDrop = {animation, drag};
    animation.onfinish = () => { if (creatorDrop?.animation === animation) finishCreatorDrop(); };
  }

  function save(next) {
    localStorage.setItem(personalKey, JSON.stringify(next));
    creators = next;
  }

  function setTeamCreators(rows) {
    const entries = normalizedCreators(rows).filter(creator => Number.isSafeInteger(creator.revision));
    const snapshot = JSON.stringify(entries);
    if (snapshot === teamWorkspace.snapshot) return;
    teamWorkspace.snapshot = snapshot;
    try { localStorage.setItem(teamWorkspace.cacheKey, snapshot); } catch {}
    const previous = new Map(creators.map(creator => [creator.id, creator]));
    const changed = [];
    creators = entries.map(entry => {
      const old = previous.get(entry.id);
      previous.delete(entry.id);
      if (old?.revision === entry.revision) return old;
      if (old?.url !== entry.url || old?.feed !== entry.feed) statuses.delete(entry.id);
      if (!statuses.has(entry.id) || scheduled.has(entry.id)) {
        scheduled.delete(entry.id);
        changed.push(entry);
      }
      return entry;
    });
    for (const id of previous.keys()) {
      statuses.delete(id);
      scheduled.delete(id);
    }
    if (!find(selected)) selected = null;
    if (active) schedule(changed);
    render();
  }

  async function syncTeam() {
    const workspace = teamWorkspace;
    if (!native || !workspace?.teamId || workspace.read || workspace.writing) return;
    const read = {};
    workspace.read = read;
    const current = () => workspace === teamWorkspace && workspace.read === read;
    try {
      const result = await api('team_creative_subscriptions', {teamId:workspace.teamId});
      if (!current()) return;
      if (result?.available === true && !Array.isArray(result.subscriptions)) throw Error('团队订阅数据无效。');
      workspace.phase = result?.available === true ? 'ready' : 'unavailable';
      workspace.problem = '';
      if (workspace.phase === 'ready') setTeamCreators(result.subscriptions);
    } catch (failure) {
      if (current()) {
        workspace.phase = 'error';
        workspace.problem = errorMessage(failure);
      }
    } finally {
      if (current()) {
        workspace.read = null;
        render();
      }
    }
  }

  function setWorkspace() {
    const context = subscriptionScope();
    const key = context ? `${subscriptionKey}:team:${context.cacheKey || context.teamId || 'pending'}` : null;
    const personalId = personalScope();
    const nextPersonalKey = !personalId || personalId === 'personal' ? subscriptionKey : `${subscriptionKey}:personal:${personalId}`;
    if (key === (teamWorkspace?.cacheKey ?? null) && context?.teamId === teamWorkspace?.teamId &&
      (context || personalKey === nextPersonalKey)) return;
    endCreatorDrag();
    finishCreatorDrop();
    workspaceEpoch++;
    personalKey = nextPersonalKey;
    creatorOrder = readCreatorOrder();
    workLayout = readWorkLayout();
    updateWorkLayout();
    teamWorkspace = context ? {teamId:context.teamId, cacheKey:key, phase:'loading', canMerge:readCreators().length > 0} : null;
    creators = key ? readCreators(key).filter(creator => Number.isSafeInteger(creator.revision)) : readCreators(personalKey);
    selected = null;
    selectedWork = '';
    opened = false;
    queue.length = 0;
    pending = 0;
    statuses.clear();
    scheduled.clear();
    creatorSearch.value = '';
    platform.value = '';
    if (editor.open) editor.close();
    setEditorBusy(false);
    if (player.open) player.close();
    if (active) {
      opened = true;
      schedule(creators);
      syncTeam();
    }
  }

  async function writeTeam(action) {
    const workspace = teamWorkspace;
    if (!workspace || !canWrite()) throw Error('团队订阅连接可用后才能修改。');
    workspace.writing = true;
    workspace.read = null;
    workspace.notice = '';
    workspace.noticeError = false;
    render();
    try {
      return await action(workspace.teamId, () => workspace === teamWorkspace, workspace);
    } finally {
      if (workspace === teamWorkspace) {
        workspace.writing = false;
        render();
        syncTeam();
      }
    }
  }

  function teamFields({name, detectedName, url, feed, avatarUrl, bio}) {
    return {name, detectedName, url, feed, avatarUrl, bio};
  }

  function updateTeamEntry(entry) {
    setTeamCreators(find(entry.id) ? creators.map(creator => creator.id === entry.id ? entry : creator) : [...creators, entry]);
  }

  function renderLibraryStatus() {
    const workspace = teamWorkspace;
    const phase = workspace?.phase || '';
    const status = !workspace ? '个人库订阅'
      : phase === 'loading' ? '团队共享 · 正在同步'
      : phase === 'unavailable' ? '团队共享 · 团队服务需要更新'
      : phase === 'error' ? '团队共享 · 同步失败' + (creators.length ? ' · 显示上次同步' : '')
      : workspace.notice || '团队共享 · 已同步';
    for (const node of [libraryStatus, detailLibraryStatus]) {
      if (node.textContent !== status) node.textContent = status;
      node.dataset.phase = workspace?.noticeError ? 'error' : phase;
      node.title = workspace?.problem || '';
    }
    detailLibraryStatus.hidden = false;
    get('creator-add').disabled = !canWrite();
    get('creator-edit').disabled = !canWrite();
    mergeButton.classList.toggle('hidden', !workspace?.canMerge);
    mergeButton.disabled = !canWrite();
  }

  function rememberCreatorProfile(creator, profile) {
    const detectedName = creator.name ? '' : publicName(profile?.name);
    const fields = {...profileMetadata(profile), detectedName};
    const changed = Object.entries(fields).filter(([key, value]) => value && value !== creator[key]);
    if (!changed.length) return;
    Object.assign(creator, Object.fromEntries(changed));
    if (!teamWorkspace) {
      try { save(creators); } catch { /* Display the detected profile for the current session. */ }
    }
  }

  function loadSupplementalProfile(creator) {
    if (pendingProfiles.has(creator) || creator.avatarUrl) return;
    const url = new URL(creator.url);
    const youtubeChannel = ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) &&
      (url.pathname.startsWith('/@') || url.pathname.startsWith('/channel/') ||
       (url.pathname === '/feeds/videos.xml' && url.searchParams.has('channel_id')));
    if (!youtubeChannel && (platformFor(creator.url) !== '哔哩哔哩' || creator.bio)) return;
    pendingProfiles.add(creator);
    api('subscription_profile', {url:creator.url}).then(profile => {
      if (find(creator.id) !== creator) return;
      rememberCreatorProfile(creator, profile);
      render();
    }).catch(() => {}).finally(() => pendingProfiles.delete(creator));
  }

  function avatarContents(creator) {
    const initials = escape(mark(creator));
    if (!creator.avatarUrl) return initials;
    return `${initials}<img class="creator-avatar-image" src="${escape(creator.avatarUrl)}" alt="" referrerpolicy="no-referrer">`;
  }

  function statusLabel(creator) {
    const phase = statuses.get(creator.id)?.phase;
    if (phase === 'loading' || phase === 'queued') return '正在同步';
    if (phase === 'ready') return '已同步';
    if (phase === 'error') return '同步失败';
    if (phase === 'unavailable' || !canSync(creator)) return '仅主页';
    return native ? '等待同步' : '桌面版可同步';
  }

  function creatorCard(creator) {
    const id = escape(creator.id);
    const name = escape(label(creator));
    const state = statuses.get(creator.id);
    const bio = escape(creator.bio || '');
    return `<article class="creator-card" data-creator-id="${id}" tabindex="0" aria-label="${name}">
      <div class="creator-identity"><span class="creator-mark" aria-hidden="true">${avatarContents(creator)}</span><div class="creator-identity-copy"><h2 title="${name}">${name}</h2><p>${platformFor(creator.url)}</p></div>
        <button type="button" class="icon-button creator-card-grip" data-creator-action="reorder" aria-label="调整 ${name} 的顺序" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" title="拖动排序，或按 Alt + 方向键"></button>
      </div>
      ${bio ? `<p class="creator-bio" title="${bio}">${bio}</p>` : ''}
      <div class="creator-card-footer"><span class="creator-status" data-phase="${state?.phase || ''}" title="${escape(state?.message || '')}">${statusLabel(creator)}</span>
        <button type="button" class="text-button" data-creator-action="view" aria-label="查看 ${name} 的作品">查看作品</button>
        <button type="button" class="icon-button" data-creator-action="edit" title="编辑订阅" aria-label="编辑 ${name} 的订阅"${canWrite() ? '' : ' disabled'}>${icon('edit')}</button>
      </div>
    </article>`;
  }

  function renderOverview() {
    const currentPlatform = platform.value;
    const platforms = [...new Set(creators.map(creator => platformFor(creator.url)))].sort((a,b) => a.localeCompare(b,'zh-CN'));
    const options = '<option value="">全部平台</option>' + platforms.map(name => `<option value="${name}">${name}</option>`).join('');
    if (platform.innerHTML !== options) {
      platform.innerHTML = options;
      platform.value = platforms.includes(currentPlatform) ? currentPlatform : '';
    }
    const term = creatorSearch.value.trim().toLocaleLowerCase();
    const matching = orderedCreators().filter(creator => (!platform.value || platformFor(creator.url) === platform.value) &&
      (!term || `${label(creator)} ${creator.url}`.toLocaleLowerCase().includes(term)));
    const markup = matching.map(creatorCard).join('');
    if (!creatorDrag && !creatorDrop && overviewMarkup !== markup) {
      const focused = document.activeElement;
      const focusedId = focused?.closest?.('[data-creator-id]')?.dataset.creatorId;
      const action = focused?.dataset?.creatorAction;
      overviewMarkup = markup;
      cards.innerHTML = markup;
      if (focusedId) {
        const next = [...cards.children].find(card => card.dataset.creatorId === focusedId);
        (action ? next?.querySelector(`[data-creator-action="${action}"]`) : next)?.focus({preventScroll:true});
      }
    }
    const empty = get('creator-list-empty');
    empty.textContent = creators.length ? '没有匹配的创作者。' :
      teamWorkspace?.phase === 'loading' ? '正在读取团队订阅…' :
      teamWorkspace?.phase === 'unavailable' ? '更新团队服务后即可管理共享订阅。' :
      teamWorkspace?.phase === 'error' ? '暂时无法读取团队订阅，可刷新重试。' :
      '还没有订阅。添加公开主页或 RSS / Atom 地址即可开始。';
    empty.classList.toggle('hidden', Boolean(matching.length));
    get('creator-refresh').disabled = !native || (teamWorkspace
      ? Boolean(teamWorkspace.read || teamWorkspace.writing || !teamWorkspace.teamId)
      : !creators.some(creator => canSync(creator) && !scheduled.has(creator.id)));
  }

  function workItem(work, index, creatorPlatform) {
    const title = escape(work.title);
    const summary = escape(work.summary);
    const platform = work.platform === '其他平台' ? creatorPlatform : work.platform;
    const date = work.time === null ? '' :
      `<time datetime="${new Date(work.time).toISOString()}">${dateFormat.format(work.time)}</time>`;
    const views = work.views === null ? '' : `<span>${work.views.toLocaleString('zh-CN')} 次播放</span>`;
    const image = work.coverUrl ?
      `<img class="creator-work-image" src="${escape(work.coverUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
    return `<li class="creator-work"><button type="button" class="creator-work-play" data-work-index="${index}" aria-pressed="false" aria-keyshortcuts="Enter" title="双击播放 · ${title}">
      <span class="creator-work-cover" aria-hidden="true">${icon('play')}${image}
        ${work.duration ? `<span class="creator-work-duration">${work.duration}</span>` : ''}
      </span>
      <span class="creator-work-content">
        <span class="creator-work-title">${title}</span>
        <span class="creator-work-meta"><span>${platform}</span>${date}${views}
          ${work.duration ? `<span class="creator-work-spoken-duration">${work.duration}</span>` : ''}
        </span>
        ${summary ? `<span class="creator-work-description" title="${summary}">${summary}</span>` : ''}
      </span>
    </button>
    <button type="button" class="icon-button creator-work-open" data-work-page="${index}" title="打开原网页" aria-label="打开原网页 · ${title}">
      ${icon('drag-out')}
    </button></li>`;
  }

  function updateWorkSelection() {
    for (const button of workList.querySelectorAll('[data-work-index]')) {
      button.setAttribute('aria-pressed', String(visibleWorks[Number(button.dataset.workIndex)]?.url === selectedWork));
    }
  }

  function selectWork(button) {
    const work = visibleWorks[Number(button?.dataset.workIndex)];
    if (work && selectedWork !== work.url) {
      selectedWork = work.url;
      updateWorkSelection();
    }
    return work;
  }

  function setPlayerFeedback(state, message = '') {
    playerStage.dataset.state = state;
    playerView.setAttribute('aria-busy', String(state === 'loading'));
    playerFeedback.hidden = !message;
    playerStatus.textContent = message;
    playerRetry.hidden = state !== 'slow' && state !== 'error';
  }

  function loadPlayer(src, provider) {
    clearTimeout(playerTimer);
    setPlayerFeedback('loading', '正在加载播放器…');
    const frame = document.createElement('iframe');
    frame.className = 'creator-player-frame';
    frame.title = playingWork.title + ' · 作品播放器';
    const youtube = provider === 'youtube';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin' + (youtube ? ' allow-presentation' : ''));
    frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture' + (youtube ? '; encrypted-media' : ''));
    frame.referrerPolicy = youtube ? 'strict-origin-when-cross-origin' : 'no-referrer';
    const currentFrame = () => player.open && frame.parentElement === playerView;
    frame.addEventListener('load', () => {
      if (!currentFrame()) return;
      clearTimeout(playerTimer);
      setPlayerFeedback('ready');
    }, {once:true});
    frame.addEventListener('error', () => {
      if (!currentFrame()) return;
      clearTimeout(playerTimer);
      frame.remove();
      setPlayerFeedback('error', '播放器加载失败。');
    }, {once:true});
    frame.src = src;
    playerView.replaceChildren(frame);
    playerTimer = setTimeout(() => {
      if (currentFrame()) setPlayerFeedback('slow', '播放器加载时间较长。');
    }, playerLoadingTimeout);
  }

  function setTheater(expanded) {
    player.classList.toggle('is-theater', expanded);
    playerTheater.setAttribute('aria-pressed', String(expanded));
    playerTheater.title = expanded ? '退出影院模式' : '影院模式';
  }

  function setPlayerUnavailable() {
    playerView.replaceChildren();
    playerTheater.hidden = true;
    player.classList.add('is-unavailable');
    setTheater(false);
    setPlayerFeedback('unavailable', '此作品可在浏览器打开。');
  }

  function workPlayer(work) {
    const youtube = youtubePlayerUrl(work.url);
    if (youtube) return {provider:'youtube', src:youtube};
    const bilibili = bilibiliPlayerUrl(work.url);
    if (bilibili) return {provider:'bilibili', src:bilibili};
    const articleId = native ? xinpianchangArticleId(work.url) : null;
    return articleId ? {provider:'xinpianchang', articleId} : null;
  }

  async function requestPlayer(work, source = workPlayer(work)) {
    const attempt = ++playerAttempt;
    const current = () => player.open && playerAttempt === attempt;
    clearTimeout(playerTimer);
    if (!source) { setPlayerUnavailable(); return; }
    if (source.src) { loadPlayer(source.src, source.provider); return; }
    playerView.replaceChildren();
    setPlayerFeedback('loading', '正在获取新片场播放器…');
    playerTimer = setTimeout(() => {
      if (current()) setPlayerFeedback('slow', '新片场播放器获取时间较长。');
    }, playerLoadingTimeout);
    try {
      const value = await api('xinpianchang_player', {input:work.url});
      if (!current()) return;
      clearTimeout(playerTimer);
      const src = xinpianchangPlayerUrl(value, source.articleId);
      if (src) loadPlayer(src, source.provider);
      else setPlayerUnavailable();
    } catch {
      if (!current()) return;
      clearTimeout(playerTimer);
      setPlayerFeedback('error', '暂时无法获取新片场播放器。');
    }
  }

  function playWork(work) {
    if (!work || player.open) return;
    playingWork = work;
    playerTitle.textContent = work.title;
    playerTitle.title = work.title;
    const creator = find(selected);
    const platform = work.platform === '其他平台' && creator ? platformFor(creator.url) : work.platform;
    const source = workPlayer(work);
    const supported = Boolean(source);
    playerStage.dataset.provider = source?.provider || '';
    playerMeta.textContent = [platform, work.duration, supported ? '可在浏览器登录并查看可用画质' : ''].filter(Boolean).join(' · ');
    playerMeta.title = playerMeta.textContent;
    playerPage.title = supported ? '在系统浏览器打开，可登录并查看可用画质' : '在系统浏览器打开';
    playerTheater.hidden = !supported;
    player.classList.toggle('is-unavailable', !supported);
    setTheater(false);
    player.showModal();
    requestPlayer(work, source);
  }

  function onPlayerBackdrop(event) {
    if (event.target !== player) return false;
    const {left, right, top, bottom} = player.getBoundingClientRect();
    return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
  }

  function updateWorkLayout() {
    workList.dataset.layout = workLayout;
    workLayoutPreference.value = workLayout;
    for (const button of workViews) button.setAttribute('aria-pressed', String(button.dataset.workLayout === workLayout));
  }

  function setWorkLayout(layout) {
    workLayout = layout;
    updateWorkLayout();
    try { preferences.setItem(workLayoutKey, workLayout); } catch {}
  }

  function renderDetail(creator) {
    const current = statuses.get(creator.id);
    const creatorPlatform = platformFor(creator.url);
    get('creator-detail-title').textContent = label(creator);
    get('creator-detail-platform').textContent = creatorPlatform;
    const avatar = avatarContents(creator);
    if (detailMarkMarkup !== avatar) {
      detailMarkMarkup = avatar;
      detailMark.innerHTML = avatar;
    }
    detailBio.textContent = creator.bio || '';
    detailBio.title = detailBio.textContent;
    detailBio.hidden = !creator.bio;
    get('creator-detail-refresh').disabled = !native || !canSync(creator) || scheduled.has(creator.id);
    const phase = current?.phase;
    const waiting = phase === 'loading' || phase === 'queued';
    const works = current?.works || [];
    const term = workSearch.value.trim().toLocaleLowerCase();
    visibleWorks = term ? works.filter(work =>
      `${work.title} ${work.summary}`.toLocaleLowerCase().includes(term)) : works;
    get('creator-work-status').textContent = waiting ? '正在同步作品…' :
      phase === 'ready' ? (term ? `${visibleWorks.length} / ${works.length} 项作品` : `${works.length} 项作品`) :
      phase === 'error' ? `${current.message}${works.length ? ' · 显示上次同步的作品' : ''}` : '';
    get('creator-work-skeleton').classList.toggle('hidden', !waiting || Boolean(works.length));
    workList.setAttribute('aria-busy', String(waiting));
    const markup = visibleWorks.map((work, index) => workItem(work, index, creatorPlatform)).join('');
    if (markup !== workMarkup) {
      workMarkup = markup;
      workList.innerHTML = markup;
      updateWorkSelection();
    }
    const empty = get('creator-work-empty');
    empty.classList.toggle('hidden', Boolean(visibleWorks.length) || (waiting && !works.length));
    const emptySource = current?.source === 'public-works' ? '此创作者暂无可显示的公开投稿。' : '此订阅源暂无作品。';
    empty.textContent = term && works.length ? '没有匹配的作品。' : phase === 'ready' ? emptySource :
      !native && canSync(creator) ? '请使用 Nexus 桌面版同步作品。' :
      phase === 'unavailable' ? current.message :
      phase === 'error' ? '可以重试刷新，或打开创作者主页。' : '添加公开订阅源后可同步作品。';
  }

  function render() {
    if (!active) return;
    renderLibraryStatus();
    const creator = find(selected);
    overview.classList.toggle('hidden', Boolean(creator));
    detail.classList.toggle('hidden', !creator);
    if (creator) renderDetail(creator);
    else renderOverview();
  }

  async function load(creator) {
    const {id} = creator;
    const isCurrent = () => find(id) === creator && scheduled.get(id) === creator;
    const before = statuses.get(id);
    let feed = directFeed(creator) || before?.feed;
    let discovered;
    statuses.set(id, {...before, phase:'loading'});
    render();
    try {
      if (!feed) {
        discovered = await api('subscription_discover', {url:creator.url});
        feed = webUrl(discovered?.feedUrl, true)?.href;
      } else loadSupplementalProfile(creator);
      if (!isCurrent()) return;
      rememberCreatorProfile(creator, discovered);
      if (!feed) {
        if (discovered?.sourceStatus === 'public-works' && Array.isArray(discovered.items)) {
          const works = normalizedWorks(discovered.items, {preserveOrder:true});
          statuses.set(id, {phase:'ready', source:'public-works', works});
          return;
        }
        if (discovered?.sourceStatus === 'public-works-unavailable') {
          statuses.set(id, {...before, phase:'error', message:creator.url === xinpianchangEditorial
            ? '暂时无法读取新片场编辑精选。' : '暂时无法读取哔哩哔哩的公开投稿。'});
          return;
        }
        const message = discovered?.sourceStatus === 'no-public-feed'
          ? '此创作者未公开 RSS / Atom 订阅源。可打开主页查看作品。'
          : '未找到公开订阅源。可以打开主页，或在编辑订阅时填写 RSS / Atom 地址。';
        statuses.set(id, {phase:'unavailable', message});
        return;
      }
      const result = await api('subscription_feed', {url:feed});
      if (!isCurrent()) return;
      const title = publicName(result?.title);
      const works = normalizedWorks(result?.items);
      if (!creator.detectedName) rememberCreatorProfile(creator, {name:title});
      statuses.set(id, {phase:'ready', feed, title, works});
    } catch (error) {
      if (isCurrent()) statuses.set(id, {...before, feed, phase:'error',
        message:String(error?.message || error || '同步订阅源失败').slice(0, 220)});
    }
  }

  function pump() {
    const epoch = workspaceEpoch;
    while (pending < 3 && queue.length) {
      const creator = queue.shift();
      if (scheduled.get(creator.id) !== creator || find(creator.id) !== creator) continue;
      pending++;
      load(creator).finally(() => {
        if (epoch !== workspaceEpoch) return;
        if (scheduled.get(creator.id) === creator) scheduled.delete(creator.id);
        pending--;
        pump();
        render();
      });
    }
  }

  function schedule(targets) {
    if (!native) return;
    for (const creator of targets) {
      if (!creator || !canSync(creator) || scheduled.get(creator.id) === creator) continue;
      scheduled.set(creator.id, creator);
      statuses.set(creator.id, {...statuses.get(creator.id), phase:'queued'});
      queue.push(creator);
    }
    pump();
    render();
  }

  async function refresh() {
    const epoch = workspaceEpoch;
    if (teamWorkspace) await syncTeam();
    if (epoch !== workspaceEpoch) return;
    const targets = (selected ? [find(selected)] : creators).filter(creator => creator && canSync(creator));
    if (targets.length) log(`刷新创作订阅 · ${targets.length} 位创作者`);
    schedule(targets);
  }

  async function mergeLocal() {
    const workspace = teamWorkspace;
    if (!workspace || !canWrite()) return;
    const known = new Set(creators.map(creator => creator.url));
    const missing = readCreators().filter(creator => {
      if (known.has(creator.url)) return false;
      known.add(creator.url);
      return true;
    });
    if (!missing.length) {
      workspace.notice = '团队共享 · 已包含所有本机订阅';
      workspace.noticeError = false;
      render();
      return;
    }
    let added = 0;
    try {
      await writeTeam(async (teamId, current) => {
        for (const [index, creator] of missing.entries()) {
          if (!current()) return;
          workspace.notice = `团队共享 · 正在合并 ${index + 1}/${missing.length}`;
          render();
          const result = await api('team_create_creative_subscription', {teamId, subscription:teamFields(creator)});
          if (!current()) return;
          if (!result?.subscription?.id) throw Error('团队服务未确认订阅。');
          if (result.created === true) added++;
          updateTeamEntry(result.subscription);
        }
        workspace.notice = `团队共享 · 已合并 ${added} 项本机订阅`;
      });
    } catch (failure) {
      if (workspace === teamWorkspace) {
        workspace.notice = `团队共享 · 已合并 ${added} 项，后续失败`;
        workspace.noticeError = true;
        notify(errorMessage(failure), true);
        render();
      }
    }
  }

  function openCreator(id) {
    const creator = find(id);
    if (!creator) return;
    overviewScroll = scroller.scrollTop;
    selected = id;
    selectedWork = '';
    workSearch.value = '';
    render();
    updateWorkSelection();
    scroller.scrollTop = 0;
    get('creator-detail-title').focus({preventScroll:true});
    if (!statuses.has(id)) schedule([creator]);
  }

  function back() {
    const previous = selected;
    selected = null;
    render();
    scroller.scrollTop = overviewScroll;
    const card = [...cards.children].find(item => item.dataset.creatorId === previous);
    (card || get('creator-add')).focus({preventScroll:true});
  }

  function openUrl(value) {
    const url = webUrl(value);
    if (url) openWeb(url.href);
  }

  function showProfileStatus(message = '') {
    profileStatus.textContent = message;
    profileStatus.hidden = !message;
  }

  function inspectLink(value, {delay = 320, preserve = false} = {}) {
    clearTimeout(profileTimer);
    const request = ++profileRequest;
    const url = creatorUrl(value);
    if (profileUrl !== (url?.href || '')) {
      inspectedProfile = undefined;
      if (!preserve) {
        if (!nameTouched) nameField.value = '';
        if (!feedTouched) feedField.value = '';
      }
    }
    profileUrl = url?.href || '';
    if (!url) { showProfileStatus(); return; }
    const platform = platformFor(url.href);
    if (!native) { showProfileStatus(platform); return; }
    showProfileStatus(`${platform} · 正在识别公开资料…`);
    profileTimer = setTimeout(async () => {
      try {
        const profile = await api('subscription_profile', {url:url.href});
        if (!editor.open || request !== profileRequest) return;
        inspectedProfile = profileMetadata(profile);
        const name = publicName(profile?.name);
        const feed = webUrl(profile?.feed, true)?.href;
        if (!nameTouched && name) nameField.value = name;
        if (!feedTouched && feed) feedField.value = feed;
        const details = [platform];
        if (name) details.push(url.href === xinpianchangEditorial ? '已识别编辑精选' : '已识别创作者');
        if (feed) details.push('已找到订阅源');
        else if (profile?.sourceStatus === 'no-public-feed') details.push('未公开 RSS / Atom');
        else if (!name) details.push('可手动补充名称');
        showProfileStatus(details.join(' · '));
      } catch {
        if (editor.open && request === profileRequest) showProfileStatus(`${platform} · 公开资料暂未读取，可手动填写`);
      }
    }, delay);
  }

  function setEditorBusy(busy) {
    editorBusy = busy;
    for (const field of form.elements) field.disabled = busy;
  }

  async function showEditor(creator = null, source = null) {
    setWorkspace();
    const epoch = workspaceEpoch;
    if (teamWorkspace?.phase === 'loading') await syncTeam();
    if (epoch !== workspaceEpoch || editor.open) return;
    if (!canWrite()) {
      notify('团队订阅连接可用后才能修改。', true);
      return;
    }
    editing = creator?.id || null;
    editingRevision = creator?.revision;
    form.reset();
    formStatus.textContent = '';
    removeConfirm.classList.add('hidden');
    get('creator-remove').classList.toggle('hidden', !creator);
    nameField.value = creator?.name || creator?.detectedName || publicName(source?.name);
    linkField.value = creator?.url || source?.url || '';
    feedField.value = creator?.feed || '';
    nameTouched = Boolean(creator?.name);
    feedTouched = Boolean(creator?.feed);
    get('creative-subscription-title').textContent = creator ? '编辑订阅' : '添加订阅';
    get('creator-save').textContent = creator ? '保存' : '添加订阅';
    get('creator-editor-library').textContent = teamWorkspace
      ? '保存到团队共享订阅，团队成员可见。'
      : '保存到当前个人库。粘贴公开主页或订阅源，Nexus 会自动填写可识别的信息。';
    get('creator-remove-description').textContent = teamWorkspace
      ? '从团队共享订阅移除此创作者？团队其他设备同步后也会移除。'
      : '从本机订阅列表移除此创作者？';
    editor.showModal();
    linkField.focus();
    inspectLink(linkField.value, {delay:0, preserve:true});
  }

  nameField.addEventListener('input', () => { nameTouched = true; });
  feedField.addEventListener('input', () => { feedTouched = true; });
  linkField.addEventListener('input', () => inspectLink(linkField.value));
  linkField.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    const url = text && creatorUrl(text);
    if (!url) return;
    event.preventDefault();
    linkField.value = url.href;
    inspectLink(url.href, {delay:0});
  });
  editor.addEventListener('close', () => {
    if (editor.open) return;
    clearTimeout(profileTimer);
    profileRequest++;
    profileUrl = '';
    inspectedProfile = undefined;
  });
  editor.addEventListener('cancel', event => { if (editorBusy) event.preventDefault(); });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (editorBusy) return;
    const url = creatorUrl(linkField.value);
    const feedInput = feedField.value.trim();
    const feed = webUrl(feedInput, true);
    if (!url) { formStatus.textContent = '请输入有效的公开 HTTP 或 HTTPS 主页地址。'; return; }
    if (feedInput && !feed) { formStatus.textContent = '请输入公开的 HTTPS 订阅源地址。'; return; }
    if (creators.some(creator => creator.id !== editing && creator.url === url.href)) {
      formStatus.textContent = '已订阅此主页。'; return;
    }
    const previous = find(editing);
    if (editing && !previous) { formStatus.textContent = '订阅已从团队移除，请关闭后刷新列表。'; return; }
    if (!previous && creators.length >= maximumCreators) { formStatus.textContent = '订阅列表已满。'; return; }
    const enteredName = publicName(nameField.value);
    const currentProfile = previous?.url === url.href ? profileMetadata(previous) : {};
    const detectedProfile = profileUrl === url.href ? inspectedProfile : undefined;
    let creator = {id:editing || crypto.randomUUID(), name:nameTouched ? enteredName : '',
      detectedName:nameTouched ? '' : enteredName, url:url.href, feed:feed?.href || '',
      avatarUrl:detectedProfile?.avatarUrl || currentProfile.avatarUrl || '',
      bio:detectedProfile?.bio || currentProfile.bio || ''};
    const changed = !previous || previous.url !== creator.url || previous.feed !== creator.feed;
    const epoch = workspaceEpoch;
    if (teamWorkspace) {
      setEditorBusy(true);
      formStatus.textContent = '正在保存到团队共享订阅…';
      try {
        await writeTeam(async (teamId, current) => {
          const subscription = teamFields(creator);
          const result = previous
            ? await api('team_update_creative_subscription', {teamId, id:previous.id, revision:editingRevision, subscription})
            : await api('team_create_creative_subscription', {teamId, subscription});
          if (!current()) return;
          if (!previous && result?.created === false) throw Error('团队已订阅此主页。');
          const saved = normalizedCreators([result?.subscription])[0];
          if (!saved || !Number.isSafeInteger(saved.revision)) throw Error('团队服务未确认订阅。');
          creator = saved;
          updateTeamEntry(saved);
        });
      } catch (failure) {
        if (epoch === workspaceEpoch) formStatus.textContent = errorMessage(failure);
        return;
      } finally {
        if (epoch === workspaceEpoch) setEditorBusy(false);
      }
    } else {
      try { save(previous ? creators.map(item => item.id === creator.id ? creator : item) : [...creators, creator]); }
      catch { formStatus.textContent = '无法保存订阅，请检查本机存储空间。'; return; }
    }
    if (epoch !== workspaceEpoch) return;
    log(`${previous ? '更新' : '添加'}创作订阅 · ${label(creator)}`);
    if (!previous) { creatorSearch.value = ''; platform.value = ''; }
    if (!teamWorkspace && (changed || scheduled.has(creator.id))) {
      statuses.delete(creator.id);
      scheduled.delete(creator.id);
      schedule([creator]);
    }
    editor.close();
    render();
  });

  get('creator-remove').addEventListener('click', () => {
    removeConfirm.classList.remove('hidden');
    get('creator-remove-cancel').focus();
  });
  get('creator-remove-cancel').addEventListener('click', () => {
    removeConfirm.classList.add('hidden');
    get('creator-remove').focus();
  });
  get('creator-remove-submit').addEventListener('click', async () => {
    if (!editing || editorBusy) return;
    const id = editing;
    const removed = find(id);
    const wasSelected = selected === id;
    const epoch = workspaceEpoch;
    if (teamWorkspace) {
      setEditorBusy(true);
      formStatus.textContent = '正在移除团队共享订阅…';
      try {
        await writeTeam(async (teamId, current) => {
          const result = await api('team_delete_creative_subscription', {teamId, id, revision:editingRevision});
          if (!current()) return;
          if (result?.removed !== true) throw Error('团队服务未确认移除。');
          setTeamCreators(creators.filter(item => item.id !== id));
        });
      } catch (failure) {
        if (epoch === workspaceEpoch) formStatus.textContent = errorMessage(failure);
        return;
      } finally {
        if (epoch === workspaceEpoch) setEditorBusy(false);
      }
    } else {
      try { save(creators.filter(item => item.id !== id)); }
      catch { formStatus.textContent = '无法保存订阅，请检查本机存储空间。'; return; }
    }
    if (epoch !== workspaceEpoch) return;
    if (removed) log(`移除创作订阅 · ${label(removed)}`);
    statuses.delete(id);
    scheduled.delete(id);
    editor.close();
    if (wasSelected) back();
    else render();
  });

  cards.addEventListener('click', event => {
    const action = event.target.closest('[data-creator-action]')?.dataset.creatorAction;
    const id = event.target.closest('[data-creator-id]')?.dataset.creatorId;
    if (action === 'view') openCreator(id);
    if (action === 'edit' && find(id)) showEditor(find(id));
  });
  cards.addEventListener('dblclick', event => {
    if (!event.target.closest('button')) openCreator(event.target.closest('[data-creator-id]')?.dataset.creatorId);
  });
  cards.addEventListener('keydown', event => {
    if (event.target.matches('[data-creator-action="reorder"]') && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const step = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : 0;
      if (!step) return;
      event.preventDefault();
      if (creatorDrag || creatorDrop) return;
      const id = event.target.closest('[data-creator-id]').dataset.creatorId;
      const visible = [...cards.children].map(card => card.dataset.creatorId);
      moveCreator(id, visible[visible.indexOf(id) + step], visible);
      render();
      return;
    }
    if (event.key !== 'Enter' || !event.target.matches('[data-creator-id]')) return;
    event.preventDefault();
    openCreator(event.target.dataset.creatorId);
  });
  cards.addEventListener('pointerdown', event => {
    const grip = event.target.closest('[data-creator-action="reorder"]');
    if (!grip || !event.isPrimary || event.button !== 0 || creatorDrag || creatorDrop || cards.children.length < 2) return;
    const card = grip.closest('[data-creator-id]');
    event.preventDefault();
    grip.focus({preventScroll:true});
    const visible = [...cards.children];
    const index = visible.indexOf(card);
    const {columnGap, rowGap} = getComputedStyle(cards);
    creatorDrag = {
      pointer:event.pointerId, card, grip, x:event.clientX, y:event.clientY, frame:0,
      index, startIndex:index, originalNext:card.nextElementSibling,
      visibleIds:visible.map(item => item.dataset.creatorId), shifts:[],
      gapX:parseFloat(columnGap) / 2 || 0, gapY:parseFloat(rowGap) / 2 || 0,
    };
    cards.setPointerCapture(event.pointerId);
  });
  window.addEventListener('pointermove', event => {
    const drag = creatorDrag;
    if (event.pointerId !== drag?.pointer) return;
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
      endCreatorDrag();
      return;
    }
    if (!drag.preview) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      startCreatorDrag(drag);
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.frame) drag.frame = requestAnimationFrame(() => updateCreatorDrop());
  }, {capture:true});
  window.addEventListener('pointerup', event => {
    if (event.pointerId !== creatorDrag?.pointer) return;
    const drag = creatorDrag;
    drag.x = event.clientX;
    drag.y = event.clientY;
    cancelAnimationFrame(drag.frame);
    updateCreatorDrop(false);
    endCreatorDrag(true);
  }, {capture:true});
  cards.addEventListener('lostpointercapture', event => { if (event.pointerId === creatorDrag?.pointer) endCreatorDrag(); });
  window.addEventListener('pointercancel', event => {
    if (event.pointerId === creatorDrag?.pointer) endCreatorDrag();
  }, {capture:true});
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !creatorDrag) return;
    event.preventDefault();
    event.stopPropagation();
    endCreatorDrag();
  }, {capture:true});
  window.addEventListener('blur', () => {
    endCreatorDrag();
    finishCreatorDrop();
  });
  workList.addEventListener('click', event => {
    const page = event.target.closest('[data-work-page]');
    if (page) openUrl(visibleWorks[Number(page.dataset.workPage)]?.url);
    else selectWork(event.target.closest('[data-work-index]'));
  });
  workList.addEventListener('dblclick', event => {
    playWork(selectWork(event.target.closest('[data-work-index]')));
  });
  workList.addEventListener('keydown', event => {
    const button = event.target.closest('[data-work-index]');
    if (event.key !== 'Enter' || !button) return;
    event.preventDefault();
    if (!event.repeat) playWork(selectWork(button));
  });
  player.addEventListener('close', () => {
    if (player.open) return;
    playerAttempt++;
    clearTimeout(playerTimer);
    playerView.replaceChildren();
    delete playerStage.dataset.provider;
    setTheater(false);
    setPlayerFeedback('idle');
    playerBackdropDown = false;
    playingWork = undefined;
  });
  player.addEventListener('pointerdown', event => {
    playerBackdropDown = event.button === 0 && onPlayerBackdrop(event);
  });
  player.addEventListener('click', event => {
    if (playerBackdropDown && onPlayerBackdrop(event)) player.close();
    playerBackdropDown = false;
  });
  player.addEventListener('cancel', event => {
    if (!player.classList.contains('is-theater')) return;
    event.preventDefault();
    setTheater(false);
  });
  playerTheater.addEventListener('click', () => setTheater(!player.classList.contains('is-theater')));
  playerRetry.addEventListener('click', () => {
    if (playingWork) requestPlayer(playingWork);
  });
  playerPage.addEventListener('click', () => {
    const url = playingWork?.url;
    player.close();
    openUrl(url);
  });
  section.addEventListener('error', event => {
    if (event.target.matches?.('.creator-avatar-image, .creator-work-image')) event.target.hidden = true;
  }, true);
  for (const button of workViews) {
    button.addEventListener('click', () => setWorkLayout(button.dataset.workLayout));
  }
  workLayoutPreference.addEventListener('change', () => setWorkLayout(workLayoutPreference.value));
  updateWorkLayout();
  mergeButton.addEventListener('click', mergeLocal);
  get('creator-add').addEventListener('click', () => showEditor());
  get('creator-refresh').addEventListener('click', refresh);
  get('creator-detail-refresh').addEventListener('click', refresh);
  get('creator-edit').addEventListener('click', () => showEditor(find(selected)));
  get('creator-open-home').addEventListener('click', () => openUrl(find(selected)?.url));
  get('creator-back').addEventListener('click', back);
  function updateCreatorFilter() {
    endCreatorDrag();
    finishCreatorDrop();
    render();
  }
  platform.addEventListener('change', updateCreatorFilter);
  creatorSearch.addEventListener('input', updateCreatorFilter);
  workSearch.addEventListener('input', render);
  setInterval(() => {
    if (!active || document.hidden) return;
    setWorkspace();
    syncTeam();
  }, teamRefreshInterval);

  return {
    addFromLink: source => showEditor(null, source),
    captureLocation() {
      return {selected, selectedWork, creatorSearch:creatorSearch.value, platform:platform.value, workSearch:workSearch.value, overviewScroll};
    },
    restoreLocation(location) {
      endCreatorDrag();
      finishCreatorDrop();
      selected = find(location?.selected)?.id || null;
      creatorSearch.value = location?.creatorSearch || '';
      platform.value = location?.platform || '';
      overviewScroll = location?.overviewScroll || 0;
      workSearch.value = location?.workSearch || '';
      selectedWork = location?.selectedWork || '';
      render();
      if (selected) {
        updateWorkSelection();
        if (!statuses.has(selected)) schedule([find(selected)]);
      }
    },
    refresh,
    workLink(element) {
      const item = element?.closest('.creator-work');
      if (!active || !selected || !workList.contains(item)) return '';
      const index = Number(item.querySelector('[data-work-index]')?.dataset.workIndex);
      return visibleWorks[index]?.url || '';
    },
    setWorkspace,
    focusSearch() { (selected ? workSearch : creatorSearch).focus(); },
    setVisible(visible, keepSelection = false) {
      setWorkspace();
      if (!visible) {
        endCreatorDrag();
        finishCreatorDrop();
      }
      if (!visible && !keepSelection) selected = null;
      if (active === visible) return;
      active = visible;
      section.classList.toggle('hidden', !visible);
      if (!visible) return;
      render();
      if (!opened) {
        opened = true;
        schedule(creators);
      }
      syncTeam();
    },
  };
}
