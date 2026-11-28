const bytesPerGiB = 1024 ** 3;

function storageSize(bytes) {
  if (bytes === 0) return '0 MB';
  if (bytes < bytesPerGiB) return Math.max(.1, bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / bytesPerGiB).toFixed(1) + ' GB';
}

export function initThumbnailCacheLimit(dialog, api) {
  const section = dialog.querySelector('#thumbnail-local-cache');
  const select = section.querySelector('select');
  const save = section.querySelector('button');
  const status = section.querySelector('[role="status"]');
  let busy = false;
  let saved;

  function updateControls() {
    select.disabled = busy;
    save.disabled = busy || select.value === saved;
  }

  function render(result) {
    section.hidden = !result.supported;
    if (!result.supported) return;
    saved = result.limitGib == null ? '' : String(result.limitGib);
    if (![...select.options].some(option => option.value === saved)) {
      select.add(new Option(saved + ' GB', saved));
    }
    select.value = saved;
    const messages = ['缓存占用 ' + storageSize(result.usedBytes)];
    if (result.removedBytes > 0) messages.push('已释放 ' + storageSize(result.removedBytes));
    if (!result.complete) messages.push('部分缓存暂无法读取或清理');
    status.textContent = messages.join(' · ');
  }

  async function run(command, args) {
    if (busy) return;
    busy = true;
    updateControls();
    try {
      const result = await api(command, args);
      if (dialog.open) render(result);
    } catch (failure) {
      if (dialog.open) {
        section.hidden = false;
        status.textContent = String(failure?.message || failure);
      }
    } finally {
      busy = false;
      updateControls();
    }
  }

  select.addEventListener('change', updateControls);
  save.addEventListener('click', () => {
    if (save.disabled) return;
    status.textContent = '正在保存容量上限…';
    void run('set_thumbnail_cache_limit', {limitGib:select.value ? Number(select.value) : null});
  });

  return {refresh: () => run('get_thumbnail_cache_limit')};
}
