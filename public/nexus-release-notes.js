const cacheKey = 'nexus-release-notes-v1';
const releasesUrl = 'https://github.com/Jugui-Lin/nexus-assets/releases';
const bundledNotes = new Map([
  ['0.10.60', [
    '文件夹的素材搜索和暂存合为一张列表。暂存项置顶，同一原件只显示一条，可在列表内预览、定位或发送。',
    '框选文件和文件夹后可批量剪切、复制、重命名或移入 Windows 回收站。',
    '资产可直接添加到上次使用的白板。文件和资产详情可以定位到具体的白板卡片。团队 NAS 文件引用支持重试与重新链接。',
    '批量定位只重试失败项，文件检查可筛出缺失或无法访问的资产，并按目录重查。',
    '文件夹、资产库和白板共用同源同尺寸的图像缩略图。Windows 本机缓存默认上限为 5 GB，可改为不限。',
    '移除资产库的材质套图入口。',
  ]],
  ['0.10.59', [
    '收藏项目和到期历史已移到左侧「＋ 添加过滤」。',
    '关于 Nexus 始终显示更新日志，可打开 GitHub 上的完整版本记录。',
    '团队管理员可统一设置 NAS 缩略图缓存路径，成员同步后共用。',
    'MAX 导入 Cinema 4D 默认使用 Octane 材质，偏好可从发送入口旁打开。',
  ]],
  ['0.10.58', [
    '文件夹工具栏增加剪切、复制、粘贴、重命名和删除，右键菜单贴近点击位置展开。',
    '临时素材篮支持拖入原文件引用、显示候选数量，以及按篮内顺序连续预览。',
    '新建标签页菜单增加白板入口，从资产库新建「此电脑」时会保留已有标签的顺序。',
    '底部资产详情随可用宽度横向排列，站点导航可以拖动分类标题来调整整组顺序。',
    '团队库侧栏可直接链接文件夹，视频播放区域移除了焦点蓝框。',
  ]],
  ['0.10.57', [
    '加强文件夹与资产库之间的原件定位，返回时保留搜索和选区。',
    '序列帧堆叠支持连续编号的 EXR，缩略图使用首帧。',
    '优化大尺寸 PNG 缩略图生成，白板新增查找与大纲。',
  ]],
  ['0.10.52-local.15', [
    'B 站视频引用自动补齐标题和封面。',
    '白板文件引用显示缩略图，双击可在资源管理器定位。',
    '优化排列会转正卡片，成组和解组可从右键直接使用。',
    '站点卡片显示网站名称，堆叠图标旁可打开偏好。',
  ]],
  ['0.10.52-local.14', [
    '白板文件引用支持缩略图和双击定位。',
    '成组与解组可直接从右键菜单使用。',
    '优化排列会转正卡片，堆叠图标旁可打开偏好。',
    '站点卡片显示网站名称。',
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

export function initNexusReleaseNotes({dialog, button, openWebsite}) {
  const versionLabel = dialog.querySelector('[data-release-version]');
  const list = dialog.querySelector('ul');
  const empty = dialog.querySelector('[data-release-notes-empty]');
  const link = dialog.querySelector('[data-release-notes-link]');
  let current = {version:'',items:[]};
  let pending = false;

  function render() {
    versionLabel.textContent = current.version;
    versionLabel.hidden = !current.version;
    empty.hidden = Boolean(current.items.length);
    list.classList.toggle('hidden',!current.items.length);
    list.replaceChildren(...current.items.map(text => {
      const row = document.createElement('li');
      row.textContent = text;
      return row;
    }));
    link.href = current.items.length && /^\d+\.\d+\.\d+$/.test(current.version)
      ? releasesUrl + '/tag/v' + current.version : releasesUrl;
  }

  function markSeen() {
    pending = false;
    if (!current.items.length) return;
    const saved = storedNotes();
    saved.seen = [...new Set([...saved.seen,current.version])].slice(-20);
    storeNotes(saved);
  }

  function show() {
    if (dialog.open) return;
    render();
    dialog.showModal();
    markSeen();
  }

  function showPending() {
    if (pending && !document.querySelector('dialog[open]')) show();
  }

  button.addEventListener('click',show);
  link.addEventListener('click',event => {
    if (!openWebsite) return;
    event.preventDefault();
    openWebsite(link.href);
  });
  document.addEventListener('close',showPending,true);
  return {
    activate(version) {
      const saved = storedNotes();
      const downloaded = saved.downloads.find(note => note?.version === version)?.items;
      const items = bundledNotes.get(version) || (Array.isArray(downloaded) ? downloaded : []);
      current = {version,items};
      if (dialog.open) {
        render();
        markSeen();
        return;
      }
      // Bundled stable notes are available on demand after a fresh install.
      const followedUpdate = Array.isArray(downloaded) && downloaded.length;
      pending = Boolean(items.length && (followedUpdate || version.includes('-local.')) && !saved.seen.includes(version));
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
