const liveInterval = 185;
const idleInterval = 1_000;
const retryInterval = 2_500;
const cursorIdleTime = 12_000;
const responseIdleTime = 5_000;
const avatarLimit = 4;
const coordinateLimit = 1_000_000;
const svgNs = 'http://www.w3.org/2000/svg';

const now = () => performance.now();
const pointValid = point => Number.isFinite(point?.x) && Number.isFinite(point?.y) &&
  Math.abs(point.x) <= coordinateLimit && Math.abs(point.y) <= coordinateLimit;

function avatarTone(id) {
  let index = 0;
  for (const character of id) index = (Math.imul(index,31) + character.codePointAt(0)) | 0;
  return Math.abs(index) % 8;
}

function insideStage(point, bounds) {
  return point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
}

function avatarFace() {
  const node = document.createElement('span');
  node.className = 'whiteboard-presence-avatar';
  return node;
}

function showAvatar(face, photo, initial) {
  face.textContent = initial;
  if (typeof photo !== 'string' || !photo.startsWith('data:image/png;base64,') || photo.length > 90_000) return;
  const image = document.createElement('img');
  image.alt = '';
  image.addEventListener('error', () => {
    if (image.parentElement === face) face.textContent = initial;
  }, {once:true});
  image.src = photo;
  face.replaceChildren(image);
}

function presenceNodes(id) {
  const cursor = document.createElement('div');
  cursor.className = 'whiteboard-presence-cursor';
  cursor.hidden = true;
  cursor.dataset.tone = avatarTone(id);
  const arrow = document.createElementNS(svgNs,'svg');
  arrow.setAttribute('viewBox','0 0 20 22');
  arrow.setAttribute('aria-hidden','true');
  const shape = document.createElementNS(svgNs,'path');
  shape.setAttribute('d','M2 2 18 13 10.4 14.4 7 21Z');
  arrow.append(shape);
  const label = document.createElement('div');
  label.className = 'whiteboard-presence-label';
  const cursorAvatar = avatarFace();
  const caption = document.createElement('span');
  caption.className = 'whiteboard-presence-name';
  label.append(cursorAvatar,caption);
  cursor.append(arrow,label);
  const badge = avatarFace();
  badge.dataset.tone = cursor.dataset.tone;
  badge.setAttribute('role','img');
  return {cursor,cursorAvatar,caption,badge};
}

export function initWhiteboardPresence({stage, cursors, avatars, api, world, loadAvatar = async () => null}) {
  const members = new Map();
  const unsupported = new Set();
  const overflow = document.createElement('span');
  overflow.className = 'whiteboard-presence-overflow';
  overflow.setAttribute('role','img');
  let target;
  let session;
  let view;

  function paintCursor(member, animate) {
    const point = member.point;
    const {cursor} = member;
    cursor.classList.toggle('is-tracking',animate && !cursor.hidden);
    cursor.hidden = !point || !view;
    if (cursor.hidden) return;
    cursor.style.translate = `${view.x + point.x * view.zoom}px ${view.y + point.y * view.zoom}px`;
  }

  function paintAvatars() {
    const records = [...members.values()];
    const shown = records.slice(0,avatarLimit).map(member => member.badge);
    const extra = records.slice(avatarLimit);
    if (extra.length) {
      overflow.textContent = '+' + extra.length;
      overflow.title = extra.map(member => member.name).join('、');
      overflow.setAttribute('aria-label',overflow.title);
      shown.push(overflow);
    }
    if (avatars.childElementCount !== shown.length || shown.some((node,index) => avatars.children[index] !== node)) {
      avatars.replaceChildren(...shown);
    }
    avatars.hidden = !shown.length;
  }

  function updateMembers(records) {
    const seen = new Set();
    for (const row of records) {
      const {memberId:id,name,avatarRevision,cursor} = row || {};
      if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || seen.has(id)) continue;
      seen.add(id);
      let member = members.get(id);
      if (!member) {
        member = {...presenceNodes(id),point:null};
        members.set(id,member);
        cursors.append(member.cursor);
      }
      const displayName = name.trim().slice(0,80);
      if (member.name !== displayName || member.revision !== avatarRevision) {
        const initial = Array.from(displayName)[0];
        member.name = displayName;
        member.revision = avatarRevision;
        member.caption.textContent = displayName;
        member.badge.title = displayName;
        member.badge.setAttribute('aria-label',displayName);
        showAvatar(member.badge,null,initial);
        showAvatar(member.cursorAvatar,null,initial);
        if (avatarRevision) {
          const revision = Symbol();
          member.avatarRequest = revision;
          Promise.resolve(loadAvatar({memberId:id, avatarRevision})).then(photo => {
            if (members.get(id) !== member || member.avatarRequest !== revision) return;
            showAvatar(member.badge,photo,Array.from(member.name)[0]);
            showAvatar(member.cursorAvatar,photo,Array.from(member.name)[0]);
          }).catch(() => {});
        } else member.avatarRequest = null;
      }
      const point = pointValid(cursor) ? cursor : null;
      if (member.point?.x !== point?.x || member.point?.y !== point?.y) {
        member.point = point;
        paintCursor(member,true);
      }
    }
    for (const [id,member] of members) {
      if (seen.has(id)) continue;
      member.cursor.remove();
      members.delete(id);
    }
    paintAvatars();
  }

  function send(current, active, cursor = null) {
    return api('team_whiteboard_presence',{
      teamId:current.teamId, projectId:current.projectId, sessionId:current.id, active, cursor,
    });
  }

  function stop(sendLeave = true) {
    const current = session;
    if (!current) return;
    session = null;
    clearTimeout(current.timer);
    clearTimeout(current.expireTimer);
    updateMembers([]);
    if (sendLeave && current.started) {
      // Finish the last heartbeat before leaving so a queued update cannot restore the cursor.
      if (current.inFlight) current.leave = true;
      else void send(current,false).catch(() => {});
    }
  }

  function schedule(current, interval) {
    if (current !== session || current.inFlight) return;
    const due = Math.max(now() + interval, current.lastPoll + liveInterval);
    if (current.timer && current.due <= due) return;
    clearTimeout(current.timer);
    current.due = due;
    current.timer = setTimeout(() => poll(current), Math.max(0,due - now()));
  }

  async function poll(current) {
    if (current !== session) return;
    current.timer = null;
    current.lastPoll = now();
    current.inFlight = current.started = true;
    const sample = current.sample;
    let failed = false;
    try {
      const local = now() - current.lastMove < cursorIdleTime && current.pointer;
      const bounds = local && stage.getBoundingClientRect();
      const point = local && insideStage(local,bounds) && world(local.x,local.y,bounds);
      const cursor = pointValid(point) ? {x:Math.round(point.x * 10) / 10, y:Math.round(point.y * 10) / 10} : null;
      const data = await send(current,true,cursor);
      if (current !== session) return;
      if (data === null) {
        unsupported.add(current.key);
        stop(false);
        return;
      }
      updateMembers(Array.isArray(data?.members) ? data.members : []);
      clearTimeout(current.expireTimer);
      if (members.size) current.expireTimer = setTimeout(() => {
        if (session === current) updateMembers([]);
      },responseIdleTime);
    } catch {
      failed = true;
    } finally {
      current.inFlight = false;
      if (current.leave) void send(current,false).catch(() => {});
      if (current !== session) return;
      const interval = failed ? retryInterval : sample !== current.sample ? 0 : members.size ? liveInterval : idleInterval;
      schedule(current,interval);
    }
  }

  function activate() {
    if (session || !target || unsupported.has(target.key) || document.hidden || !document.hasFocus()) return;
    session = {...target,id:crypto.randomUUID(),lastPoll:-Infinity,lastMove:-Infinity,sample:0};
    schedule(session,0);
  }

  function updatePointer(pointer) {
    const current = session;
    if (!current || (!pointer && !current.pointer)) return;
    current.pointer = pointer;
    current.lastMove = now();
    current.sample++;
    schedule(current,0);
  }

  function onPointerMove(event) {
    if (session) updatePointer({x:event.clientX,y:event.clientY});
  }

  stage.addEventListener('pointermove', onPointerMove, {passive:true});
  stage.addEventListener('pointerenter', onPointerMove, {passive:true});
  stage.addEventListener('pointerleave', () => updatePointer(null));
  stage.addEventListener('pointercancel', () => updatePointer(null));
  window.addEventListener('focus',activate);
  window.addEventListener('blur', () => stop());
  window.addEventListener('pagehide', () => stop());
  window.addEventListener('pageshow',activate);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else activate(); });

  return {
    setContext(scope, visible) {
      const next = visible && scope?.teamId ? scope : null;
      if (target?.key !== next?.key) stop();
      target = next;
      activate();
    },
    paint(nextView) {
      view = nextView;
      for (const member of members.values()) paintCursor(member,false);
      if (session?.pointer && now() - session.lastMove < cursorIdleTime) {
        session.sample++;
        schedule(session,0);
      }
    },
  };
}
