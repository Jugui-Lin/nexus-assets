const cacheKey = 'nexus-release-notes-v1';
const bundledNotes = new Map([
  ['0.10.52', [
    'B 站视频引用自动补齐标题和封面。',
    '白板文件引用显示缩略图，双击可在资源管理器定位。',
    '优化排列会转正卡片，成组和解组可从右键直接使用。',
    '站点卡片显示网站名称，堆叠图标旁可打开偏好。',
  ]],
]);

function storedNotes() {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey));
    return {
      seen:Array.isArray(value?.seen) ? value.seen : [],
      downloads:Array.isArray(value?.downloads) ? value.downloads : [],
    };
  } catch { return {seen:[],downloads:[]}; }
}

function storeNotes(value) {
  try { localStorage.setItem(cacheKey,JSON.stringify(value)); } catch {}
}

function summarizeNotes(value) {
  if (typeof value !== 'string') return [];
  const lines = value.slice(0,12_000).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const bullet = /^(?:[-*•]|\d+[.)])\s+/;
  const preferred = lines.filter(line => bullet.test(line));
  return (preferred.length ? preferred : lines.filter(line => !/^(?:#{1,6}\s|---|https?:\/\/)/i.test(line)))
    .map(line => line.replace(bullet,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[`*_]/g,'').trim())
    .filter(Boolean).slice(0,4).map(line => line.length > 100 ? line.slice(0,99).trimEnd() + '…' : line);
}

export function initNexusReleaseNotes({dialog, button}) {
  const versionLabel = dialog.querySelector('[data-release-version]');
  const list = dialog.querySelector('ul');
  let current;
  let pending = false;

  function show() {
    if (!current || dialog.open) return;
    versionLabel.textContent = current.version;
    list.replaceChildren(...current.items.map(text => {
      const row = document.createElement('li');
      row.textContent = text;
      return row;
    }));
    dialog.showModal();
    pending = false;
    const saved = storedNotes();
    saved.seen = [...new Set([...saved.seen,current.version])].slice(-20);
    storeNotes(saved);
  }

  function showPending() {
    if (pending && !document.querySelector('dialog[open]')) show();
  }

  button.addEventListener('click',show);
  document.addEventListener('close',showPending,true);
  return {
    activate(version) {
      const saved = storedNotes();
      const downloaded = saved.downloads.find(note => note?.version === version)?.items;
      const items = bundledNotes.get(version) || (Array.isArray(downloaded) ? downloaded : []);
      if (!items.length) return;
      current = {version,items};
      button.hidden = false;
      pending = !saved.seen.includes(version);
      showPending();
    },
    remember(version, notes) {
      if (typeof version !== 'string' || !version || version.length > 64) return;
      const items = summarizeNotes(notes);
      if (!items.length) return;
      const saved = storedNotes();
      saved.downloads = [...saved.downloads.filter(note => note?.version !== version),{version,items}].slice(-5);
      storeNotes(saved);
    },
  };
}
