import {batchKey, capture, isPaired, makeCapture, maxBatch} from './capture.js';

const retryAlarm = 'nexus-capture-batch';
const retryDelay = 2500;
const maxRetryTime = 100_000;
let working;
let timer;

async function store(batch) {
  await chrome.storage.session.set({[batchKey]:batch});
  await Promise.allSettled([
    chrome.action.setBadgeBackgroundColor({color:batch.items.length ? '#51696d' : batch.failed || batch.uncertain ? '#a14435' : '#285e52'}),
    chrome.action.setBadgeText({text:batch.items.length ? String(batch.items.length) : batch.failed || batch.uncertain ? '!' : '✓'}),
  ]);
}

async function readBatch() {
  return (await chrome.storage.session.get(batchKey))[batchKey];
}

export async function beginBatch(input) {
  if (!(await isPaired())) return {ok:false, message:'请先完成配对。'};
  if (working || (await readBatch())?.items.length) return {ok:false, message:'已有批量采集正在发送。'};
  const mappings = new Map();
  for (const item of (Array.isArray(input) ? input : []).slice(0, maxBatch)) {
    const payload = makeCapture(item || {});
    if (payload) mappings.set(payload.kind + ':' + payload.url, payload);
  }
  const items = [...mappings.values()];
  if (!items.length) return {ok:false, message:'请选择可采集的内容。'};
  await store({id:crypto.randomUUID(), total:items.length, items, sent:0, failed:0, uncertain:0});
  // Persist a wake-up before starting. The short timer handles usual two-slot backpressure.
  await chrome.alarms.create(retryAlarm, {periodInMinutes:1});
  refreshBatch().catch(console.error);
  return {ok:true};
}

async function runBatch() {
  const batch = await readBatch();
  if (!batch?.items.length) {
    await chrome.alarms.clear(retryAlarm);
    return;
  }
  if (batch.inFlight) {
    // The previous worker could have lost the response after Nexus accepted it.
    batch.uncertain++;
    batch.items.shift();
    batch.inFlight = false;
    delete batch.waitSince;
    await store(batch);
  }
  while (batch.items.length) {
    batch.inFlight = true;
    await store(batch);
    let busy = false;
    try {
      await capture(batch.items[0]);
      batch.sent++;
    } catch (failure) {
      busy = failure.status === 429;
      batch.message = failure.message;
      if (busy) batch.waitSince ??= Date.now();
      if (!busy && !failure.status) batch.uncertain++;
      else if (!busy || Date.now() - batch.waitSince >= maxRetryTime) batch.failed++;
    }
    const current = await readBatch();
    if (current?.id !== batch.id) return;
    batch.inFlight = false;
    if (busy && Date.now() - batch.waitSince < maxRetryTime) {
      await store(batch);
      clearTimeout(timer);
      timer = setTimeout(() => refreshBatch().catch(console.error), retryDelay);
      return;
    }
    delete batch.waitSince;
    batch.items.shift();
    await store(batch);
  }
  await chrome.alarms.clear(retryAlarm);
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === retryAlarm) refreshBatch().catch(console.error);
});

export async function refreshBatch() {
  if (working) return working;
  working = runBatch();
  try { await working; }
  finally { working = undefined; }
}
