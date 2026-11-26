function videoReference(message) {
  const reference = message.kind === 'creative-video-reference' && message.videoReference;
  return typeof reference?.key === 'string' && reference.key ? reference : null;
}

export function initTeamAssetMessages({api, context, asset, jump, jumpVideoReference, formatDate, notify,
  onReceive, onPokeReceive, onAvailabilityChange, onError, openDccUpdates}) {
  const button = document.querySelector('#team-asset-messages');
  const count = document.querySelector('#team-asset-message-count');
  const dialog = document.querySelector('#team-asset-messages-dialog');
  const title = document.querySelector('#team-asset-messages-title');
  const list = document.querySelector('#team-asset-message-list');
  const status = document.querySelector('#team-asset-message-status');
  const clear = document.querySelector('#team-asset-message-clear');
  const clearPanel = document.querySelector('#team-asset-message-clear-panel');
  const clearPrompt = document.querySelector('#team-asset-message-clear-prompt');
  const cancelClear = document.querySelector('#team-asset-message-cancel-clear');
  const confirmClear = document.querySelector('#team-asset-message-confirm-clear');
  let messages = [];
  let dccUpdates = [];
  let available = null;
  let pokesAvailable = false;
  let videoReferencesAvailable = false;
  let revision = 0;
  let pending = null;
  let action = null;
  let clearDraft = null;
  let displayed = '';

  function current(scope) {
    return scope && scope.key === context()?.key;
  }

  function render() {
    const total = messages.length + dccUpdates.length;
    const panelName = dccUpdates.length ? '消息' : '团队消息';
    const countLabel = `${total} 条${panelName}`;
    button.setAttribute('aria-label', countLabel);
    button.title = panelName;
    title.textContent = panelName;
    count.textContent = total || '';
    button.classList.toggle('hidden', !total);
    clear.textContent = dccUpdates.length ? '清除团队消息' : '清除全部';
    clear.hidden = Boolean(dccUpdates.length && !messages.length);
    clear.disabled = !messages.length || Boolean(action || clearDraft);
    clear.setAttribute('aria-expanded', String(Boolean(clearDraft)));
    clearPanel.classList.toggle('hidden', !clearDraft);
    if (!dialog.open) return;
    const cards = messages.map(message => ({
      id:message.id, sender:message.senderName, created:formatDate(message.created),
      poke:message.kind === 'poke',
      videoReference:videoReference(message),
      entries:(message.assetIds || []).map((id, index) => ({id, name:asset(id)?.name || `定位第 ${index + 1} 项资产`})),
    }));
    const signature = JSON.stringify([dccUpdates, cards]);
    if (displayed !== signature) {
      displayed = signature;
      const localRows = dccUpdates.map(({id, name, versions}) => {
        const row = document.createElement('li');
        row.className = 'team-asset-notice';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'nav-item';
        open.dataset.openDccUpdate = id;
        open.textContent = `${name} 插件有更新 · ${versions.join(' / ')}`;
        row.append(open);
        return row;
      });
      list.replaceChildren(...localRows, ...cards.map(card => {
        const row = document.createElement('li');
        row.className = 'team-asset-notice';
        const head = document.createElement('div');
        head.className = 'team-asset-notice-heading';
        const sender = document.createElement('strong');
        sender.textContent = card.sender;
        const date = document.createElement('time');
        date.textContent = card.created;
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'text-button';
        dismiss.dataset.dismissNotice = card.id;
        dismiss.textContent = '移除';
        dismiss.setAttribute('aria-label', `移除 ${card.sender} 的消息`);
        head.append(sender, date, dismiss);
        row.append(head, ...card.entries.map(entry => {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'nav-item';
          open.dataset.openNoticeAsset = entry.id;
          open.title = entry.name;
          open.textContent = entry.name;
          return open;
        }));
        if (card.videoReference) {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'nav-item';
          open.dataset.openNoticeVideoReference = card.videoReference.key;
          const name = card.videoReference.title || '视频引用';
          open.title = '定位视频 · ' + name;
          open.setAttribute('aria-label',open.title);
          open.textContent = name;
          row.append(open);
        }
        if (card.poke) {
          const body = document.createElement('p');
          body.className = 'team-asset-notice-poke';
          body.textContent = '拍了拍你';
          row.append(body);
        }
        return row;
      }));
      if (!total && !status.textContent) status.textContent = '暂无团队消息';
      else if (total && status.textContent === '暂无团队消息') status.textContent = '';
    }
    for (const control of list.querySelectorAll('button')) control.disabled = Boolean(action || clearDraft);
  }

  async function refresh() {
    const scope = context();
    if (!scope || pending) return;
    const readRevision = revision;
    const task = api('team_asset_messages', {teamId:scope.teamId});
    pending = task;
    try {
      const result = await task;
      if (!current(scope) || readRevision !== revision) return;
      const supported = result?.available !== false && Array.isArray(result?.messages);
      const wasChecked = available !== null;
      const supportsPokes = supported && result.pokesAvailable === true;
      const supportsVideoReferences = supported && result.videoReferencesAvailable === true;
      if (available !== supported || pokesAvailable !== supportsPokes || videoReferencesAvailable !== supportsVideoReferences) {
        available = supported;
        pokesAvailable = supportsPokes;
        videoReferencesAvailable = supportsVideoReferences;
        onAvailabilityChange();
      }
      const previousIds = new Set(messages.map(message => message.id));
      // The server orders the inbox oldest first.
      messages = (supported ? result.messages : [])
        .filter(message => message && (message.kind === 'poke' || videoReference(message) ||
          (Array.isArray(message.assetIds) && message.assetIds.length)))
        .reverse();
      render();
      if (wasChecked) {
        const received = messages.filter(message => !previousIds.has(message.id));
        if (received.length) onReceive?.(received.length);
        const pokes = received.filter(message => message.kind === 'poke');
        if (pokes.length) onPokeReceive?.();
        if (received.length === 1 && pokes.length) {
          notify(`「${pokes[0].senderName}」拍了拍你`);
        } else if (received.length === 1) {
          const shared = videoReference(received[0]) ? '视频' : '素材';
          notify(`收到「${received[0].senderName}」分享的${shared} · 点击右上角消息定位`);
        } else if (received.length > 1) {
          notify(`收到 ${received.length} 条团队消息`);
        }
      }
    } catch {
      // Keep previously received messages while the team service is unavailable.
    } finally {
      if (pending === task) pending = null;
    }
  }

  async function send(recipient, assetIds) {
    const scope = context();
    if (!scope || !available) throw Error('团队服务暂不可发送素材消息');
    const ids = [...new Set(assetIds)];
    if (!ids.length || !ids.every(id => id.startsWith('team:') && asset(id))) throw Error('请选择当前团队库的资产');
    if (ids.length > 20) throw Error('一次最多分享 20 项资产');
    await api('team_send_asset_message', {teamId:scope.teamId, recipientId:recipient.id, assetIds:ids});
    if (current(scope)) notify(`已向「${recipient.name}」分享 ${ids.length} 项资产`);
  }

  async function sendVideoReference(recipient, referenceKey) {
    const scope = context();
    if (!scope || !videoReferencesAvailable) throw Error('团队服务暂不可发送视频定位');
    if (typeof referenceKey !== 'string' || !referenceKey) throw Error('视频同步到团队后即可分享');
    const result = await api('team_send_video_reference_message', {
      teamId:scope.teamId, recipientId:recipient.id, referenceKey,
    });
    if (result?.accepted !== true) throw Error('团队服务未确认视频定位消息');
    if (current(scope)) notify(`已向「${recipient.name}」发送视频定位`);
  }

  async function poke(recipient) {
    const scope = context();
    if (!scope || !pokesAvailable) throw Error('团队服务暂不可发送拍一拍');
    await api('team_send_poke', {teamId:scope.teamId, recipientId:recipient.id});
    if (!current(scope)) return false;
    notify(`你拍了拍「${recipient.name}」`);
    return true;
  }

  button.addEventListener('click', () => {
    if ((!dccUpdates.length && (!context() || !messages.length)) || dialog.open) return;
    status.textContent = '';
    dialog.showModal();
    render();
    refresh();
  });
  clear.addEventListener('click', () => {
    const scope = context();
    if (!scope || action || clearDraft || !messages.length) return;
    clearDraft = {scope, ids:messages.map(message => message.id)};
    clearPrompt.textContent = `清除你的 ${clearDraft.ids.length} 条团队消息？`;
    status.textContent = '';
    render();
    cancelClear.focus();
  });
  function cancelClearDraft() {
    clearDraft = null;
    render();
    clear.focus();
  }
  cancelClear.addEventListener('click', cancelClearDraft);
  dialog.addEventListener('cancel', event => {
    if (!clearDraft) return;
    event.preventDefault();
    cancelClearDraft();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open || !clearDraft) return;
    clearDraft = null;
    render();
  });
  confirmClear.addEventListener('click', async () => {
    if (!clearDraft || !current(clearDraft.scope) || action) return;
    const operation = clearDraft;
    const {scope, ids} = operation;
    action = operation;
    clearDraft = null;
    status.textContent = '正在清除消息…';
    render();
    const removed = new Set();
    const batchSize = 4;
    try {
      for (let start = 0; start < ids.length && current(scope); start += batchSize) {
        const batch = ids.slice(start, start + batchSize);
        const results = await Promise.allSettled(batch.map(async messageId => {
          await api('team_dismiss_asset_message', {teamId:scope.teamId, messageId});
          return messageId;
        }));
        for (const result of results) {
          if (result.status === 'fulfilled') removed.add(result.value);
        }
      }
      if (!current(scope)) return;
      revision++;
      messages = messages.filter(message => !removed.has(message.id));
      const failed = ids.length - removed.size;
      const report = `已清除 ${removed.size} 条消息` + (failed ? `，${failed} 条清除失败` : '');
      status.textContent = report;
    } finally {
      if (action === operation) {
        action = null;
        render();
        if (dialog.open) (clear.disabled ? dialog.querySelector('.close-modal') : clear).focus();
      }
    }
  });
  list.addEventListener('click', async event => {
    const control = event.target.closest('button');
    if (!control || action || clearDraft) return;
    if (control.dataset.openDccUpdate) {
      dialog.close();
      openDccUpdates();
      return;
    }
    const scope = context();
    if (!scope) return;
    const {openNoticeAsset, openNoticeVideoReference, dismissNotice} = control.dataset;
    const operation = {};
    action = operation;
    status.textContent = '';
    render();
    try {
      if (openNoticeAsset) {
        await jump(openNoticeAsset, () => current(scope) && dialog.open, () => dialog.close());
      } else if (openNoticeVideoReference) {
        await jumpVideoReference(openNoticeVideoReference, () => current(scope) && dialog.open, () => dialog.close());
      } else if (dismissNotice) {
        await api('team_dismiss_asset_message', {teamId:scope.teamId, messageId:dismissNotice});
        if (!current(scope)) return;
        revision++;
        messages = messages.filter(message => message.id !== dismissNotice);
      }
    } catch (error) {
      if (!current(scope)) return;
      if (dialog.open) status.textContent = String(error?.message || error);
      else onError(error);
    } finally {
      if (action === operation) {
        action = null;
        render();
        if (dialog.open && control.isConnected) control.focus();
      }
    }
  });

  return {
    enabled: () => available === true,
    pokesEnabled: () => pokesAvailable,
    videoReferencesEnabled: () => videoReferencesAvailable,
    refresh, render, send, sendVideoReference, poke,
    setDccUpdates(updates) {
      dccUpdates = updates;
      render();
    },
    reset() {
      available = null;
      pokesAvailable = false;
      videoReferencesAvailable = false;
      pending = action = null;
      clearDraft = null;
      revision++;
      messages = [];
      displayed = '';
      list.replaceChildren();
      dialog.close();
      render();
    },
  };
}
