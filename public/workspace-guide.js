const topics = [
  {id:'tabs', title:'默认新建标签页', path:'设置与工具 › 标签页设置', terms:'加号 Ctrl+T 复制当前标签',
    detail:'设置点「＋」或按 Ctrl+T 时打开的内容。选择「复制当前标签」可以保留当前的文件夹路径或资产视图。'},
  {id:'folders', title:'定位原文件', path:'资产详情 › 定位原文件', terms:'定位原件 文件视图 检查文件 转到资产目录 转到文件夹 在资产库中查看 入库状态',
    detail:'从资产卡片或详情打开并选中原文件。在文件夹点入库状态可编辑资产资料，多选后用「在资产库中查看」可定位当前视图中的对应资产。原件位置变化时可用「检查文件」及「重新关联文件」。'},
  {id:'browse', title:'文件夹浏览', path:'标题栏 › 文件夹 › 地址栏', terms:'空文件夹 地址 Ctrl+L Alt+↑ 上一级 标签 搜索',
    detail:'按 Ctrl+L 输入完整路径，按 Alt+↑ 返回上一级。搜索无结果时先尝试去掉文件格式或关键词，原关键词会留在搜索框。'},
  {id:'transfer', title:'导入与链接', path:'工作空间菜单 › 导入或链接', terms:'链接文件夹 链接入库 复制入库 原文件 NAS',
    detail:'同名 JPG、PNG 或文件夹里的 preview.jpg、preview.png 可以作封面。', definitions:[
      ['链接入库','让资产库索引现有位置，源文件保留在原处。'],
      ['复制入库','在所选目标位置写入副本，再索引副本。'],
      ['原文件','资产记录指向的磁盘或共享目录文件，可从「定位原文件」打开。'],
    ]},
  {id:'import-progress', title:'后台导入与进度', path:'导入资产 › 导入进度说明', terms:'扫描 暂停 取消 关闭 窗口 导入进度 索引',
    detail:'关闭尚未提交的导入窗口会返回原页面。开始扫描后，窗口会自动收起，任务继续在后台运行。底部状态栏显示扫描进度，完成通知会汇报处理结果。'},
  {id:'search', title:'搜索与筛选', path:'资产筛选栏 › 搜索', terms:'格式 标签 名称 路径 备注 文件名 记住此处',
    detail:'按 / 或 Ctrl+F 打开搜索。关键词会分别匹配名称、路径、标签或备注，多词需要同时匹配。没有结果时可尝试简化关键词，或用「清除其他筛选」保留关键词。文件名筛选按磁盘名称查找，「记住此处」保存该文件夹的快捷筛选。'},
  {id:'workspace', title:'个人库与团队库', path:'资产库顶部 › 工作空间', terms:'本机 共享 NAS 团队成员 部门 培训',
    detail:'个人库适合本机整理、草稿和只给自己看的参考。团队库适合多人共用的素材索引和白板。要预览或导入共享素材，请先连接团队挂载目录。'},
  {id:'preview', title:'预览和缩略图', path:'资产操作 › 生成缩略图', terms:'快速预览 空格 封面',
    detail:'选中资产后按空格快速预览。用「预览所选」逐项查看已选资产，素材栏也可以按当前搜索结果逐项预览。需要重建预览时，用「生成缩略图」。'},
  {id:'dcc', title:'DCC 连接中心', path:'设置与工具 › DCC 连接中心', terms:'插件 桥接 Blender C4D Cinema 4D 放置 3ds Max Maya Houdini',
    detail:'连接中心会检测创作软件并同步桥接。连接后可把卡片拖进视口。Blender 用 S 缩放，Cinema 4D 用 T，R 旋转，左键确认，Esc 取消。'},
  {id:'team', title:'网盘与 NAS', path:'设置与工具 › 网盘与采集 › 网盘与 NAS', terms:'SMB WebDAV rclone 团队挂载 同步',
    detail:'可以连接 SMB、WebDAV 或已配置的 rclone 网盘。预览和导入需要能访问原文件。资产列表的「刷新当前目录」会重新显示当前目录的资产。'},
  {id:'capture', title:'网页采集', path:'设置与工具 › 网盘与采集 › 网页采集', terms:'浏览器 Chrome Edge 扩展 配对',
    detail:'安装并配对 Chrome 或 Edge 扩展，再选择要采集到的资产库及目标文件夹。'},
  {id:'whiteboard', title:'白板', path:'资产库 › 白板', terms:'复制引用 框选 连接线 对齐 成组 撤销',
    detail:'在资产库按 Ctrl+C 复制图片或视频，再到白板按 Ctrl+V 粘贴引用。空白处拖动框选，Ctrl+G 成组，Ctrl+Shift+G 解组。拖动元素边缘的「＋」可连线。空格聚焦或返回，Ctrl+Z 撤销，Ctrl+Shift+Z 重做。'},
  {id:'review', title:'白板审片标注', path:'白板项目 › 视频卡片 › 审片标注', terms:'收藏片段 入点 出点 双视频 对照 分隔线 返修 时间点',
    detail:'快速预览视频时用「收藏片段」选择入点、出点、名称和白板项目。白板里双击片段播放指定范围，点「审片标注」暂停、圈出位置并写下返修说明。也可在白板「查找与大纲」里搜索标注，选中后跳到对应画面。'},
  {id:'logs', title:'运行日志', path:'资产库状态栏 › 运行日志', terms:'报错 失败 导入 拖放 缩略图 DCC NAS 诊断',
    detail:'按操作类别或失败状态筛选，查看本次运行的记录。复制按钮会复制当前显示的记录。'},
];

const bookmarkKey = 'nexus.workspace-guide.bookmarks';

function readBookmarks() {
  try {
    const saved = JSON.parse(localStorage.getItem(bookmarkKey) || '[]');
    if (Array.isArray(saved)) return new Set(topics.filter(topic => saved.includes(topic.id)).map(topic => topic.id));
  } catch {}
  return new Set();
}

function highlight(element, text, words) {
  const lower = text.toLowerCase();
  let offset = 0;
  while (offset < text.length) {
    const matches = words.map(word => ({word, index:lower.indexOf(word, offset)})).filter(match => match.index >= 0);
    matches.sort((a,b) => a.index - b.index || b.word.length - a.word.length);
    const match = matches[0];
    if (!match) {
      element.append(text.slice(offset));
      return;
    }
    element.append(text.slice(offset, match.index));
    const mark = document.createElement('mark');
    offset = match.index + match.word.length;
    mark.textContent = text.slice(match.index, offset);
    element.append(mark);
  }
}

export function initWorkspaceGuide(menu, closeMenu, {openFormatHelp} = {}) {
  const dialog = document.querySelector('#workspace-guide-dialog');
  const title = dialog.querySelector('#workspace-guide-title');
  const input = dialog.querySelector('#workspace-guide-query');
  const results = dialog.querySelector('#workspace-guide-results');
  const status = dialog.querySelector('#workspace-guide-status');
  const favorites = dialog.querySelector('#workspace-guide-bookmarks');
  dialog.querySelector('#workspace-format-help')?.addEventListener('click',() => openFormatHelp?.());
  const bookmarks = readBookmarks();
  let onlyBookmarks = false;
  let opener;

  function render() {
    const words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const found = topics.filter(topic => {
      const searchable = [topic.title,topic.path,topic.terms,topic.detail,...(topic.definitions?.flat() || [])].join(' ').toLowerCase();
      return (!onlyBookmarks || bookmarks.has(topic.id)) && words.every(word => searchable.includes(word));
    });
    favorites.setAttribute('aria-pressed', String(onlyBookmarks));
    status.hidden = found.length > 0;
    status.textContent = onlyBookmarks && !words.length ? '还没有收藏的指南条目' : '没有匹配的指南条目';
    results.replaceChildren(...found.map(topic => {
      const article = document.createElement('article');
      const heading = document.createElement('h3');
      const path = document.createElement('p');
      const detail = document.createElement('p');
      const button = document.createElement('button');
      highlight(heading,topic.title,words);
      path.className = 'muted workspace-guide-path';
      highlight(path,topic.path,words);
      detail.textContent = topic.detail;
      button.type = 'button';
      button.className = 'button subtle';
      button.dataset.guideBookmark = topic.id;
      button.textContent = bookmarks.has(topic.id) ? '已收藏' : '收藏';
      button.setAttribute('aria-label', `${topic.title}，${button.textContent}`);
      button.setAttribute('aria-pressed', String(bookmarks.has(topic.id)));
      article.append(heading, button, path, detail);
      if (topic.definitions) {
        const glossary = document.createElement('dl');
        glossary.className = 'workspace-guide-glossary';
        for (const [term,definition] of topic.definitions) {
          const name = document.createElement('dt');
          const meaning = document.createElement('dd');
          highlight(name,term,words);
          meaning.textContent = definition;
          glossary.append(name,meaning);
        }
        article.append(glossary);
      }
      return article;
    }));
  }

  input.addEventListener('input', render);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
    }
  });
  favorites.addEventListener('click', () => {
    onlyBookmarks = !onlyBookmarks;
    render();
  });
  results.addEventListener('click', event => {
    const id = event.target.closest('button[data-guide-bookmark]')?.dataset.guideBookmark;
    if (!id) return;
    if (bookmarks.has(id)) bookmarks.delete(id);
    else bookmarks.add(id);
    try { localStorage.setItem(bookmarkKey, JSON.stringify([...bookmarks])); } catch {}
    render();
    (results.querySelector(`[data-guide-bookmark="${id}"]`) || favorites).focus({preventScroll:true});
  });
  function open(trigger, contextTopic) {
    if (dialog.open) return;
    opener = menu.contains(trigger) ? menu.querySelector('summary') : trigger;
    if (menu.contains(trigger)) closeMenu(true);
    const topic = topics.find(topic => topic.id === (contextTopic || trigger?.dataset.workspaceGuide));
    const context = trigger?.dataset.workspaceGuideContext;
    title.textContent = topic ? `${context || '使用指南'} · ${topic.title}` : '使用指南';
    input.value = topic?.title || '';
    onlyBookmarks = false;
    render();
    dialog.showModal();
    input.focus();
  }
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-workspace-guide]');
    if (trigger) open(trigger);
  });
  dialog.addEventListener('close', () => opener?.focus({preventScroll:true}));

  const layer = document.createElement('div');
  layer.className = 'workspace-help-key-layer';
  layer.setAttribute('aria-hidden','true');
  layer.hidden = true;
  document.body.append(layer);
  const hints = [
    ['#workspace-new-tab','新建标签页（Ctrl+T）'],
    ['#workspace-tab-overview-open','搜索标签页'],
    ['.local-explorer-form input','地址栏（Ctrl+L）'],
    ['[data-explorer-search]','搜索文件'],
    ['[data-workspace-mode="files"]','切换到文件夹'],
    ['[data-workspace-mode="assets"]','切换到资产库'],
    ['#asset-search-toggle','搜索资产（Ctrl+F）'],
    ['#asset-filter-more-toggle','更多筛选和浏览选项'],
  ];
  let held;
  let timer;
  function renderHints() {
    layer.replaceChildren(...hints.flatMap(([selector,label]) => {
      const target = document.querySelector(selector);
      if (!target?.checkVisibility()) return [];
      const {left,top,bottom} = target.getBoundingClientRect();
      const hint = document.createElement('span');
      hint.textContent = label;
      hint.style.left = Math.min(Math.max(4,left),Math.max(4,innerWidth-180)) + 'px';
      hint.style.top = (bottom + 31 > innerHeight ? Math.max(4,top - 26) : bottom + 4) + 'px';
      return [hint];
    }));
    layer.hidden = false;
  }
  function resetHold() {
    clearTimeout(timer);
    held = false;
    layer.hidden = true;
  }
  document.addEventListener('keydown',event => {
    if (event.key !== 'F1' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    if (event.repeat || held) return;
    held = true;
    timer = setTimeout(renderHints,260);
  });
  document.addEventListener('keyup',event => {
    if (event.key !== 'F1' || !held) return;
    const tap = layer.hidden;
    resetHold();
    if (tap && !document.querySelector('dialog[open]')) {
      const files = !document.querySelector('#file-workspace')?.hidden;
      open(document.activeElement,files ? 'browse' : 'search');
    }
  });
  window.addEventListener('blur',resetHold);
  window.addEventListener('resize',() => { if (held && !layer.hidden) renderHints(); });
}
