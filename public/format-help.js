const previewNames = {
  image:'图片预览', photometric:'IES 光照分布预览', mesh:'交互网格预览', video:'视频播放',
  embedded:'工程封面', cover:'仅封面', unsupported:'无资产预览能力',
};
const bytesLabel = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});

function line(list,label,detail) {
  const name = document.createElement('dt');
  name.textContent = label;
  const value = document.createElement('dd');
  value.textContent = detail;
  list.append(name,value);
}

function previewDescription(preview,file) {
  const details = [previewNames[preview.mode]];
  if (preview.byteLimit) {
    details.push(`源文件限制 ${bytesLabel.format(preview.byteLimit/1024**2)} MiB`);
    if (file?.bytes > preview.byteLimit) details.push('此文件超过预览限制');
  }
  if (preview.coverFound) details.push('发现封面文件');
  if (preview.mode === 'cover' && preview.coverFound === false) details.push('此文件旁暂无封面');
  if (preview.condition) details.push(preview.condition);
  return details.filter(Boolean).join(' · ');
}

export function initFormatHelp({api,native,context,kindName}) {
  const dialog = document.getElementById('format-help-dialog');
  const form = dialog.querySelector('form');
  const extension = form.elements.extension;
  const lookup = form.querySelector('[type=submit]');
  const browse = dialog.querySelector('[data-format-browse]');
  const close = dialog.querySelector('[data-format-close]');
  const status = dialog.querySelector('[data-format-status]');
  const result = dialog.querySelector('[data-format-result]');
  let visit;

  const active = draft => dialog.open && visit === draft;

  function busy(draft,value) {
    draft.busy = value;
    extension.disabled = lookup.disabled = browse.disabled = !native || value;
  }

  function draw(report,workspace) {
    const values = document.createElement('dl');
    values.className = 'format-help-report';
    const {file} = report;
    const format = report.extension ? '.' + report.extension : '无扩展名';
    if (file) line(values,'选中的文件',`${file.name} · ${file.readable ? '可读取' : '当前不可读取'}`);
    line(values,'格式索引',report.kind ? `${format} · 可索引为${kindName(report.kind) || report.kind}` :
      `${format} · 不在资产索引格式清单`);
    const workspaceFacts = [workspace.name];
    if (file) workspaceFacts.push(!workspace.loaded ? '索引暂不可读'
      : workspace.indexed ? '已在当前库索引' : '当前库未找到此文件');
    if (workspace.hiddenFormat) workspaceFacts.push('当前显示偏好隐藏此格式');
    if (file && workspace.team && !workspace.indexed) workspaceFacts.push('共享素材需从关联的挂载目录访问');
    line(values,'当前工作空间',workspaceFacts.filter(Boolean).join(' · '));
    line(values,'资产预览',previewDescription(report.preview,file));
    if (!report.dcc.length) line(values,'DCC 导入','没有已登记的桥接导入路径');
    for (const host of report.dcc) {
      const connection = host.online === 0 ? '此格式有导入路径 · 未连接'
        : host.direct || host.smart ? [
          '已连接',host.direct && `${host.direct} 个实例支持直接导入`,
          host.smart && `${host.smart} 个实例支持智能导入`,
        ].filter(Boolean).join(' · ') : '已连接 · 当前桥接未提供此格式';
      line(values,host.label,[connection,host.condition].filter(Boolean).join(' · '));
    }
    result.replaceChildren(values);
  }

  async function query(args) {
    const draft = visit;
    if (!native || !draft || draft.busy) return;
    const previousStatus = status.textContent;
    busy(draft,true);
    status.textContent = args.pickFile ? '请选择要查询的文件…' : '正在查询格式能力…';
    try {
      const report = await api('query_format_capabilities',args);
      if (!active(draft)) return;
      if (!report) { status.textContent = previousStatus; return; }
      const workspace = await context(report);
      if (!active(draft)) return;
      draw(report,workspace);
      status.textContent = '查询依据为扩展名、文件可访问状态和当前桥接连接。';
    } catch (failure) {
      if (!active(draft)) return;
      result.replaceChildren();
      status.textContent = String(failure?.message || failure);
    } finally {
      if (active(draft)) busy(draft,false);
    }
  }

  form.addEventListener('submit',event => {
    event.preventDefault();
    void query({extension:extension.value});
  });
  browse.addEventListener('click',() => { void query({pickFile:true}); });
  close.addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => { if (!dialog.open) visit = null; });
  return {
    show() {
      if (dialog.open) return;
      visit = {};
      result.replaceChildren();
      extension.value = '';
      status.textContent = native ? '' : '格式查询可在 Nexus 桌面版使用。';
      busy(visit,false);
      dialog.showModal();
      (native ? extension : close).focus();
    },
  };
}
