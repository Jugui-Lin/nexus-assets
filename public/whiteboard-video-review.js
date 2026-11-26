import {imageLocalPoint,normalizeImageTransform} from './whiteboard-image-transform.js';
import {readReviewNotes,writeReviewNotes,reviewTime,repairListHtml,reviewShotCode} from './whiteboard-review-notes.js';
import {copyVideoFrame,videoFrameUrl,readVideoCover,loadVideoCoverFrame} from './whiteboard-video-cover.js';
import {initWhiteboardReviewDispatch} from './whiteboard-review-dispatch.js';

function readyFor(video, events, valid, update) {
  return new Promise((resolve,reject) => {
    const done = failure => {
      clearTimeout(timer);
      for (const event of events) video.removeEventListener(event,ready);
      video.removeEventListener('error',failed);
      video.removeEventListener('emptied',check);
      return failure ? reject(failure) : resolve();
    };
    const ready = () => valid() ? done() : done(Error('白板视频已切换'));
    const check = () => { if (!valid()) done(Error('白板视频已切换')); };
    const failed = () => done(Error('无法读取该时间的画面'));
    const timer = setTimeout(failed,8000);
    for (const event of events) video.addEventListener(event,ready);
    video.addEventListener('error',failed);
    video.addEventListener('emptied',check);
    try { update(); } catch (error) { done(error); }
  });
}

export function initWhiteboardVideoReview({world,current,visible,mayEdit,commit,items,projectName,notify,scope,
  assignees = () => [],copyText = value => navigator.clipboard.writeText(value)}) {
  const references = new Map();
  const dialog = document.createElement('dialog');
  dialog.className = 'modal compact-dialog whiteboard-video-review-dialog';
  dialog.setAttribute('aria-label','审片标注');
  dialog.innerHTML = `<header class="modal-header"><h2>审片标注</h2><button type="button" data-review-close class="icon-button" aria-label="关闭">×</button></header>
    <p class="whiteboard-video-review-context"></p>
    <ul data-video-review-notes aria-label="此视频的标注"></ul>
    <button type="button" class="button subtle" data-review-pick>添加画面标注</button>
    <form data-video-review-edit hidden><label>返修说明<textarea maxlength="180" required rows="3"></textarea></label>
      <div class="whiteboard-review-edit-fields"><label>镜头号<input data-review-shot maxlength="48" placeholder="如 SH010"></label>
      <label>负责人<select data-review-assignee aria-label="负责人（在线团队成员）"></select></label></div>
      <button type="submit" class="button primary">保存标注</button></form>
    <p data-video-review-status role="status"></p>`;
  document.body.append(dialog);
  const find = selector => dialog.querySelector(selector);
  const list = find('[data-video-review-notes]');
  const form = find('[data-video-review-edit]');
  const message = form.querySelector('textarea');
  const shot = find('[data-review-shot]');
  const owner = find('[data-review-assignee]');
  const status = find('[data-video-review-status]');
  let selected;
  let selectionPoint;
  let picking;
  let serial = 0;
  let activeExport;
  const dispatch = initWhiteboardReviewDispatch({key:scope,list:reportEntries,projectName,exportSelected:exportReport,copyText});

  function available(reference) {
    return Boolean(reference?.active() && visible() && current(reference.id)?.assetId === reference.assetId);
  }

  function stopPick() {
    if (picking) picking.picker.hidden = true;
    picking = null;
  }

  function close() {
    stopPick();
    serial++;
    selected = selectionPoint = null;
    if (dialog.open) dialog.close();
  }

  function paint(reference) {
    if (!available(reference)) return;
    const {notes} = readReviewNotes(current(reference.id).text);
    const {video,rings} = reference;
    const {crop:[left,top,right,bottom]} = normalizeImageTransform(current(reference.id).imageTransform);
    const timestamp = video.hidden ? reference.segment?.start ?? reference.initialTime ?? 0 : video.currentTime;
    const matching = notes.filter(note => Math.abs(note.time - timestamp*1000) < 85);
    const geometry = `${matching.map(note => note.id).join(',')}:${left}:${top}:${right}:${bottom}`;
    if (reference.geometry === geometry) return;
    reference.geometry = geometry;
    rings.replaceChildren(...matching.flatMap(note => {
      const x = note.x/10000, y = note.y/10000;
      if (x < left || x > right || y < top || y > bottom) return [];
      const marker = document.createElement('span');
      marker.style.left = `${(x-left)*100/(right-left)}%`;
      marker.style.top = `${(y-top)*100/(bottom-top)}%`;
      marker.dataset.reviewResolved = String(note.resolved);
      marker.title = note.message;
      return [marker];
    }));
  }

  async function seekFrame(reference,time,valid) {
    const {video,asset,segment} = reference;
    video.pause();
    if (!video.videoWidth || !video.hasAttribute('src')) {
      const media = await asset.playback();
      if (!valid()) return false;
      let loaded = false;
      for (const url of [media?.url,media?.fallbackUrl].filter(Boolean)) {
        try {
          await readyFor(video,['loadeddata'],valid,() => { video.preload = 'auto'; video.src = url; });
          loaded = true;
          break;
        } catch { if (!valid()) return false; }
      }
      if (!loaded) throw Error('原片暂时无法读取');
    }
    if (!valid()) return false;
    const upper = Math.min(video.duration,segment?.end ?? Infinity);
    if (!Number.isFinite(upper) || upper <= 0 || time > upper + .005) throw Error('此标注时间已超出原片范围');
    const target = Math.max(segment?.start ?? 0,Math.min(upper,time));
    if (video.seeking || Math.abs(video.currentTime-target)>.002) {
      await readyFor(video,['seeked'],valid,() => { video.currentTime = target; });
    }
    if (!valid()) return false;
    video.hidden = false;
    reference.image.hidden = true;
    paint(reference);
    return true;
  }

  function renderDialog(reference) {
    const {notes} = readReviewNotes(current(reference.id).text);
    const editable = mayEdit();
    find('.whiteboard-video-review-context').textContent = reference.title;
    find('[data-review-pick]').disabled = !editable;
    form.hidden = !selectionPoint;
    list.replaceChildren(...notes.slice().sort((a,b) => a.time-b.time).map(note => {
      const row = document.createElement('li');
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'text-button';
      jump.dataset.reviewJump = note.id;
      jump.textContent = `${reviewTime(note.time)} · ${note.message}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'button subtle';
      toggle.dataset.reviewToggle = note.id;
      toggle.textContent = note.resolved ? '恢复待返修' : '标为已解决';
      toggle.disabled = !editable;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'button subtle';
      edit.dataset.reviewRewrite = note.id;
      edit.textContent = '编辑';
      edit.disabled = !editable;
      const details = [note.shot,note.ownerName].filter(Boolean).join(' · ');
      if (details) jump.textContent += ` · ${details}`;
      row.append(jump,edit,toggle);
      return row;
    }));
  }

  function show(reference,point = null) {
    stopPick();
    if (!available(reference)) return;
    reference.video.pause();
    selected = reference;
    selectionPoint = point;
    status.textContent = point ? `标注时间 ${reviewTime(point.time)}` : '';
    message.value = point?.message || '';
    const automaticShot = /(?:^|[^A-Z0-9])((?:SH|SHOT)[-_]?\d{1,8})(?=$|[^A-Z0-9])/i.exec(reference.asset.name || '')?.[1];
    shot.value = point?.shot ?? (point?.id ? '' : reviewShotCode(automaticShot));
    const people = new Map(assignees().filter(item => item?.id && item.name).map(item => [item.id,item.name]));
    if (point?.ownerId && !people.has(point.ownerId)) people.set(point.ownerId,point.ownerName);
    owner.replaceChildren(new Option('未分配',''),...Array.from(people,([id,name]) => new Option(name,id)));
    owner.value = point?.ownerId || '';
    renderDialog(reference);
    if (!dialog.open) dialog.showModal();
    if (point) message.focus();
  }

  async function requestPick(reference) {
    const key = ++serial;
    const valid = () => key === serial && selected === reference && available(reference) && mayEdit();
    const time = reference.video.hidden ? reference.segment?.start ?? reference.initialTime ?? 0 : reference.video.currentTime;
    status.textContent = '正在读取要标注的画面…';
    try {
      if (!await seekFrame(reference,time,valid)) return;
      dialog.close();
      picking = reference;
      reference.picker.hidden = false;
      reference.picker.focus({preventScroll:true});
    } catch (failure) { if (valid()) status.textContent = String(failure?.message || failure); }
  }

  function saveNotes(reference,mutate) {
    if (!available(reference) || !mayEdit()) throw Error('当前白板无法编辑此标注');
    const item = current(reference.id);
    const {notes} = readReviewNotes(item.text);
    commit(reference.id,writeReviewNotes(item.text,mutate(notes)));
    reference.geometry = null;
    paint(reference);
  }

  dialog.addEventListener('click',async event => {
    const reference = selected;
    if (event.target.closest('[data-review-close]')) { close(); return; }
    if (!available(reference)) return;
    if (event.target.closest('[data-review-pick]')) { await requestPick(reference); return; }
    const toggle = event.target.closest('[data-review-toggle]')?.dataset.reviewToggle;
    const jump = event.target.closest('[data-review-jump]')?.dataset.reviewJump;
    const rewrite = event.target.closest('[data-review-rewrite]')?.dataset.reviewRewrite;
    if (rewrite && mayEdit()) {
      const note = readReviewNotes(current(reference.id).text).notes.find(item => item.id === rewrite);
      if (note) show(reference,note);
      return;
    }
    if (toggle) {
      try {
        saveNotes(reference,notes => notes.map(note => note.id === toggle ? {...note,resolved:!note.resolved} : note));
        renderDialog(reference);
      } catch (failure) { status.textContent = String(failure?.message || failure); }
    } else if (jump) {
      const note = readReviewNotes(current(reference.id).text).notes.find(item => item.id === jump);
      if (!note) return;
      const key = ++serial;
      const valid = () => key === serial && available(reference);
      status.textContent = '正在定位到标注时间…';
      try {
        if (await seekFrame(reference,note.time/1000,valid)) close();
      } catch (failure) { if (valid()) status.textContent = String(failure?.message || failure); }
    }
  });
  dialog.addEventListener('cancel',event => { event.preventDefault(); close(); });
  form.addEventListener('submit',event => {
    event.preventDefault();
    const point = selectionPoint;
    const text = message.value.trim();
    if (!selected || !point || !text) return;
    const shotCode = reviewShotCode(shot.value);
    if (shot.value.trim() && !shotCode) { status.textContent = '镜头号请用字母、数字、连字符或下划线'; return; }
    const person = owner.value && (assignees().find(item => item.id === owner.value) ||
      (point.ownerId === owner.value ? {id:point.ownerId,name:point.ownerName} : null));
    if (owner.value && !person) { status.textContent = '可用负责人已变更，请重新打开编辑'; return; }
    try {
      const changes = {message:text,shot:shotCode,ownerId:person?.id,ownerName:person?.name};
      saveNotes(selected,notes => {
        const prior = notes.find(note => note.id === point.id);
        if (point.id && !prior) throw Error('此标注已被移除，请重新打开审片标注');
        if (prior) return notes.map(note => note.id === prior.id ? {...note,...changes} : note);
        return [...notes,{...point,...changes,id:crypto.randomUUID(),resolved:false}];
      });
      close();
    } catch (failure) { status.textContent = String(failure?.message || failure); }
  });

  function attach({id,assetId,node,clip,video,image,asset,active,segment,initialTime,title}) {
    const rings = document.createElement('div');
    rings.className = 'whiteboard-video-review-rings';
    rings.setAttribute('aria-hidden','true');
    clip.append(rings);
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.dataset.boardVideoReview = '';
    trigger.textContent = '审片标注';
    const picker = document.createElement('button');
    picker.type = 'button';
    picker.dataset.boardVideoPick = '';
    picker.textContent = '点击要圈出的位置 · Esc 取消';
    picker.hidden = true;
    node.append(trigger,picker);
    const reference = {id,assetId,node,video,image,asset,active,segment,initialTime,title,rings,trigger,picker};
    references.set(id,reference);
    trigger.addEventListener('click',() => show(reference));
    picker.addEventListener('keydown',event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      stopPick();
      trigger.focus();
    });
    for (const control of [trigger,picker]) control.addEventListener('pointerdown',event => event.stopPropagation());
    picker.addEventListener('click',event => {
      if (picking !== reference || !available(reference) || !mayEdit()) return;
      const item = current(id);
      const {flipX,flipY,crop:[left,top,right,bottom]} = normalizeImageTransform(item.imageTransform);
      const point = event.detail ? world(event.clientX,event.clientY) : {x:item.x+item.width/2,y:item.y+item.height/2};
      const within = imageLocalPoint(item,point.x,point.y);
      const fraction = value => Math.min(1,Math.max(0,value));
      const x = left + fraction(flipX ? 1-within.x : within.x)*(right-left);
      const y = top + fraction(flipY ? 1-within.y : within.y)*(bottom-top);
      show(reference,{time:Math.round(video.currentTime*1000),x:Math.round(x*10000),y:Math.round(y*10000)});
    });
    for (const event of ['timeupdate','seeked','loadeddata']) video.addEventListener(event,() => paint(reference));
    update(id);
  }

  function update(id) {
    const reference = references.get(id);
    if (!available(reference)) return;
    const count = readReviewNotes(current(id).text).notes.filter(note => !note.resolved).length;
    const video = readVideoCover(current(id).text);
    reference.initialTime = video.time;
    reference.title = video.title || reference.asset.name || '视频';
    reference.trigger.textContent = count ? `审片标注 ${count}` : '审片标注';
    reference.geometry = null;
    paint(reference);
  }

  function release(id) {
    if (picking?.id === id || selected?.id === id) close();
    references.delete(id);
  }

  function reportEntries() {
    const result = [];
    for (const item of items().values()) {
      if (item.kind !== 'image' || !item.assetId) continue;
      const reference = references.get(item.id);
      const {notes} = readReviewNotes(item.text);
      const title = readVideoCover(item.text).title || reference?.asset.name || '未命名视频';
      for (const note of notes.filter(item => !item.resolved)) {
        result.push({...note,title,source:reference?.asset.name,key:`${item.id}:${note.id}`,itemId:item.id});
      }
    }
    return result;
  }

  async function exportReport(selected,heading) {
    if (!visible() || activeExport) {
      if (selected) throw Error('导出正在处理或白板已切换');
      return;
    }
    const result = (selected || reportEntries()).map(note => ({...note}));
    if (!result.length) { notify('当前白板没有未解决的审片标注'); return; }
    const name = heading || projectName() || '白板';
    const images = [];
    let imageBytes = 0;
    for (const entry of result) {
      const reference = references.get(entry.itemId);
      const video = reference?.video;
      if (video && !video.hidden && video.paused && Math.abs(video.currentTime*1000-entry.time) < 50 && imageBytes < 2_000_000) {
        entry.frame = videoFrameUrl(copyVideoFrame(video));
        imageBytes += entry.frame?.length || 0;
      }
      if (!entry.frame && available(reference) && images.length < 4) images.push({entry,reference});
    }
    if (images.length) {
      const request = new AbortController();
      activeExport = request;
      const timeout = setTimeout(() => request.abort(),4500);
      try {
        await Promise.all([0,1].map(async () => {
          while (images.length && !request.signal.aborted && imageBytes < 2_000_000) {
            const {entry,reference} = images.shift();
            if (!available(reference)) continue;
            try {
              const shot = await loadVideoCoverFrame(reference.asset.playback,entry.time/1000,request.signal);
              if (shot && imageBytes + shot.length < 2_000_000) {
                entry.frame = shot;
                imageBytes += shot.length;
              }
            } catch { /* The text and coordinates remain in the report. */ }
          }
        }));
      } finally {
        clearTimeout(timeout);
        activeExport = null;
      }
    }
    const url = URL.createObjectURL(new Blob([repairListHtml(name,result)],{type:'text/html;charset=utf-8'}));
    const download = document.createElement('a');
    download.href = url;
    download.download = `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')}-返修单.html`;
    download.click();
    setTimeout(() => URL.revokeObjectURL(url),30000);
  }

  return {attach,update,release,close,exportReport,openDispatch:dispatch.open,closeDispatch:dispatch.close,reposition(id) {
    const reference = references.get(id);
    if (reference) paint(reference);
  }, isOpen:() => dialog.open || dispatch.isOpen() || Boolean(picking)};
}
