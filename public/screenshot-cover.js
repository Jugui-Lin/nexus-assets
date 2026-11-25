const maxBytes = 32 * 1024 * 1024;
const formats = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];

function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result.split(',')[1]));
    reader.addEventListener('error', () => reject(Error('无法读取截图')));
    reader.readAsDataURL(file);
  });
}

export function initScreenshotCover({api, windows, onSaved}) {
  const dialog = document.querySelector('#screenshot-cover-dialog');
  const preview = dialog.querySelector('#screenshot-cover-preview');
  const status = dialog.querySelector('#screenshot-cover-status');
  const name = dialog.querySelector('#screenshot-cover-name');
  const capture = dialog.querySelector('#screenshot-cover-capture');
  const clipboard = dialog.querySelector('#screenshot-cover-clipboard');
  const save = dialog.querySelector('#screenshot-cover-save');
  let asset;
  let screenshot;
  let url;
  let busy = false;

  function resetImage() {
    if (url) URL.revokeObjectURL(url);
    url = null;
    screenshot = null;
    preview.removeAttribute('src');
    preview.classList.add('hidden');
    save.disabled = true;
  }

  function selectImage(file) {
    if (!file || !formats.includes(file.type)) {
      status.textContent = '剪贴板中没有可用的截图。';
      return;
    }
    if (file.size > maxBytes) {
      status.textContent = '截图超过 32 MiB，请缩小截图范围。';
      return;
    }
    resetImage();
    screenshot = file;
    url = URL.createObjectURL(file);
    preview.src = url;
    preview.classList.remove('hidden');
    status.textContent = '';
    save.disabled = false;
  }

  dialog.addEventListener('paste', event => {
    if (!dialog.open || busy) return;
    event.preventDefault();
    selectImage([...event.clipboardData.files].find(file => formats.includes(file.type)));
  });
  capture.classList.toggle('hidden', !windows);
  capture.addEventListener('click', async () => {
    try {
      await api('start_cover_capture');
      if (dialog.open) status.textContent = '截图完成后，回到此窗口按 Ctrl+V。';
    } catch {
      if (dialog.open) status.textContent = '可按 Win+Shift+S 截图，再回到此窗口按 Ctrl+V。';
    }
  });
  clipboard.classList.toggle('hidden', typeof navigator.clipboard?.read !== 'function');
  clipboard.addEventListener('click', async () => {
    const requestedAsset = asset;
    try {
      const items = await navigator.clipboard.read();
      const item = items.find(candidate => formats.some(format => candidate.types.includes(format)));
      const file = item ? await item.getType(formats.find(format => item.types.includes(format))) : null;
      if (dialog.open && asset === requestedAsset && !busy) selectImage(file);
    } catch {
      if (dialog.open && asset === requestedAsset) status.textContent = '请在此窗口按 Ctrl+V 或 ⌘V 粘贴截图。';
    }
  });
  save.addEventListener('click', async () => {
    if (!asset || !screenshot || busy) return;
    busy = true;
    save.disabled = capture.disabled = clipboard.disabled = true;
    const target = asset;
    try {
      const imageBase64 = await base64(screenshot);
      if (!dialog.open || asset !== target) return;
      await api('set_clipboard_cover', {id: target.id, imageBase64});
      if (dialog.open && asset === target) dialog.close();
      await onSaved(target.id);
    } catch (error) {
      if (dialog.open && asset === target) status.textContent = String(error?.message || error);
    } finally {
      busy = false;
      save.disabled = !screenshot;
      capture.disabled = clipboard.disabled = false;
    }
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    asset = null;
    resetImage();
  });

  return {
    show(target) {
      if (busy) return;
      resetImage();
      asset = target;
      name.textContent = target.kind === 'texture' ? target.name : `${target.name} · 截图将以同名 PNG 保存到源文件旁`;
      status.textContent = '';
      if (!dialog.open) dialog.showModal();
    },
  };
}
