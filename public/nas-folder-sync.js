const storageKey = 'nexus-nas-folder-sync-v1';
const historyLimit = 40;
const stamp = new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',hourCycle:'h23'});
const number = new Intl.NumberFormat('zh-CN');

function summary(value) {
  const metrics = [];
  if (Number.isSafeInteger(value?.found) && value.found >= 0) metrics.push(`扫描 ${number.format(value.found)} 项`);
  if (Number.isSafeInteger(value?.changed) && value.changed >= 0) metrics.push(`更新 ${number.format(value.changed)} 项索引记录`);
  return metrics.join('，');
}

function timestamp(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 8.64e15) return '';
  return stamp.format(value);
}

function describeReport(report) {
  if (!report || typeof report !== 'object') throw Error('NAS 未返回扫描结果');
  const hasServerTime = Number.isFinite(report.completedAt) && report.completedAt > 0 && report.completedAt <= 8.64e12;
  const errors = Array.isArray(report.errors) ? report.errors.filter(Boolean).slice(0,3) : [];
  return {
    status:errors.length ? 'partial' : 'done',
    at:hasServerTime ? report.completedAt * 1000 : Date.now(),
    metrics:summary(report),
    note:errors.map(item => String(item).trim().slice(0,180)).join(' · '),
  };
}

function describeError(error) {
  const note = String(error?.message || error || '无法同步当前文件夹').trim().slice(0,400);
  const status = /NAS 正在扫描|超时|timed out|timeout/i.test(note) ? 'unconfirmed' : 'error';
  return {status,at:Date.now(),metrics:'',note};
}

const titles = {
  done:'NAS 扫描完成',partial:'NAS 扫描完成，部分项目无法读取',
  unconfirmed:'暂未收到 NAS 扫描结果',error:'本次同步失败',
};

export function initNasFolderSync({owner = document,isCurrent,scan,storage = window.localStorage}) {
  const dialog = owner.createElement('dialog');
  dialog.className = 'modal compact-dialog nas-folder-sync';
  dialog.setAttribute('aria-labelledby','nas-folder-sync-title');
  dialog.innerHTML = '<div class="modal-header"><h2 id="nas-folder-sync-title">同步 NAS 文件夹</h2>' +
    '<button type="button" class="icon-button" data-nas-sync-close aria-label="关闭"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>' +
    '<p class="modal-description">扫描 NAS 上的当前目录及其子目录，更新团队资产索引。</p>' +
    '<dl class="nas-folder-sync-details"><dt>团队资产库</dt><dd data-nas-sync-library></dd><dt>同步目录</dt><dd data-nas-sync-folder></dd>' +
    '<dt>上次完整同步</dt><dd data-nas-sync-last></dd></dl>' +
    '<div class="nas-folder-sync-result" role="status" aria-atomic="true"><strong data-nas-sync-status></strong><p data-nas-sync-note></p></div>' +
    '<div class="modal-footer"><button type="button" class="button subtle" data-nas-sync-close>关闭</button>' +
    '<button type="button" class="button primary" data-nas-sync-run>立即同步</button></div>';
  owner.body.append(dialog);
  const find = name => dialog.querySelector(`[data-nas-sync-${name}]`);
  const library = find('library');
  const folder = find('folder');
  const last = find('last');
  const status = find('status');
  const note = find('note');
  const run = find('run');
  const records = new Map();
  const inFlight = new Map();
  let target;
  let opener;

  try {
    const saved = JSON.parse(storage.getItem(storageKey));
    if (Array.isArray(saved)) for (const row of saved.slice(0,historyLimit)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[1] || typeof row[1] !== 'object') continue;
      records.set(row[0],row[1]);
    }
  } catch {}

  function key({scope,library,folderPath}) {
    return JSON.stringify([scope,library.id,folderPath]);
  }

  function save(current,attempt) {
    const id = key(current);
    const previous = records.get(id);
    records.delete(id);
    records.set(id,{attempt,success:attempt.status === 'done' ? attempt : previous?.success});
    if (records.size > historyLimit) records.delete(records.keys().next().value);
    try { storage.setItem(storageKey,JSON.stringify([...records])); } catch {}
  }

  function render() {
    if (!dialog.open || !target) return;
    if (!isCurrent(target)) { dialog.close(); return; }
    const record = records.get(key(target));
    const pending = inFlight.get(target.scope);
    const running = pending && key(pending) === key(target);
    const attempt = record?.attempt;
    const syncTime = timestamp(record?.success?.at);
    library.textContent = target.library.name;
    folder.textContent = target.folderPath || '库根目录';
    last.textContent = syncTime ? [syncTime,record.success.metrics].filter(Boolean).join(' · ') : '本机暂无记录';
    const state = running ? 'running' : pending ? 'busy' : Object.hasOwn(titles,attempt?.status) ? attempt.status : 'idle';
    dialog.dataset.nasSyncState = state;
    dialog.setAttribute('aria-busy',String(Boolean(running)));
    status.textContent = running ? '正在等待 NAS 扫描结果…' : pending ? '此团队已有一次文件夹同步正在处理'
      : titles[state] || '尚未从本机手动同步此目录';
    note.textContent = pending ? '' : [timestamp(attempt?.at),attempt?.metrics,attempt?.note].filter(Boolean).join(' · ');
    run.disabled = Boolean(pending);
    run.textContent = running ? '正在同步…' : state === 'partial' || state === 'error' || state === 'unconfirmed' ? '重试同步' : '立即同步';
  }

  run.addEventListener('click',async () => {
    const current = target;
    if (!current || !isCurrent(current) || inFlight.has(current.scope)) return;
    inFlight.set(current.scope,current);
    render();
    try { save(current,describeReport(await scan(current))); }
    catch (error) { save(current,describeError(error)); }
    finally {
      inFlight.delete(current.scope);
      render();
    }
  });
  for (const close of dialog.querySelectorAll('[data-nas-sync-close]')) {
    close.addEventListener('click',() => dialog.close());
  }
  dialog.addEventListener('close',() => {
    if (dialog.open) return;
    if (opener?.checkVisibility?.()) opener.focus({preventScroll:true});
    target = opener = undefined;
  });

  return {
    open(current,button) {
      if (!isCurrent(current)) return false;
      target = current;
      opener = button;
      if (!dialog.open) dialog.showModal();
      render();
      (run.disabled ? find('close') : run).focus({preventScroll:true});
      return true;
    },
    update:render,
  };
}
