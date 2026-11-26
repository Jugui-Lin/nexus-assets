const batchSize = 24;
const imageCacheSize = 8;

export function analyzeRenderSequence(frames,sizes,completeListing = true) {
  const missing = [];
  const duplicate = [];
  const unreadable = [];
  const counts = new Map();
  let previous = frames[0]?.number - 1;
  for (const frame of frames) {
    if (completeListing && frame.number > previous + 1) missing.push({first:previous + 1,last:frame.number - 1});
    if (frame.number === previous) duplicate.push(frame.number);
    previous = frame.number;
    const size = sizes.get(frame.path);
    if (size?.width && size?.height) {
      const key = `${size.width} × ${size.height}`;
      counts.set(key,(counts.get(key) || 0) + 1);
    } else if (size) unreadable.push(frame.number);
  }
  let reference;
  let maximum = 0;
  for (const [key,count] of counts) if (count > maximum) {
    reference = key;
    maximum = count;
  }
  const mismatched = frames.flatMap(frame => {
    const size = sizes.get(frame.path);
    if (!size?.width || !size?.height) return [];
    const label = `${size.width} × ${size.height}`;
    return label !== reference ? [{number:frame.number,label}] : [];
  });
  return {missing,duplicate,unreadable,reference,mismatched};
}

export function initRenderSequenceViewer({api,onCompareExr}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal render-sequence-dialog';
  dialog.setAttribute('aria-labelledby','render-sequence-title');
  dialog.innerHTML = `
    <div class="modal-header"><h2 id="render-sequence-title">渲染序列检查</h2><button type="button" class="icon-button" data-close aria-label="关闭"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <div class="render-sequence-actions"><label>序列 <select data-groups disabled></select></label><label>预览帧率 <select data-fps><option>12</option><option selected>24</option><option>25</option><option>30</option></select></label><button type="button" class="button subtle" data-exr-compare hidden>通道对照</button></div>
    <div class="render-sequence-picture"><img data-frame-image alt="当前渲染帧" hidden draggable="false"><span data-picture-status></span></div>
    <div class="render-sequence-transport"><button type="button" class="button subtle" data-play disabled>播放</button><label>帧 <input data-seek type="range" min="0" max="0" disabled></label><output data-frame-number></output></div>
    <div class="render-sequence-timeline" data-timeline aria-hidden="true"></div>
    <p data-summary role="status"></p><p data-check-status role="status"></p>
    <ul class="render-sequence-issues" data-issues aria-label="异常帧"></ul>`;
  document.body.append(dialog);
  const groups = dialog.querySelector('[data-groups]');
  const image = dialog.querySelector('[data-frame-image]');
  const pictureStatus = dialog.querySelector('[data-picture-status]');
  const summary = dialog.querySelector('[data-summary]');
  const checkStatus = dialog.querySelector('[data-check-status]');
  const issues = dialog.querySelector('[data-issues]');
  const timeline = dialog.querySelector('[data-timeline]');
  const play = dialog.querySelector('[data-play]');
  const seek = dialog.querySelector('[data-seek]');
  const frameLabel = dialog.querySelector('[data-frame-number]');
  const fps = dialog.querySelector('[data-fps]');
  const exrCompare = dialog.querySelector('[data-exr-compare]');
  let current;

  const active = sequence => dialog.open && current?.sequence === sequence;
  const label = (sequence,number) => String(number).padStart(sequence.group.padding,'0');

  function stop(sequence) {
    if (sequence) {
      sequence.playing = false;
      clearTimeout(sequence.timer);
    }
    play.textContent = '播放';
  }

  function markers(sequence) {
    const analysis = analyzeRenderSequence(sequence.group.frames,sequence.sizes,!sequence.truncated);
    const missing = analysis.missing.reduce((sum,range) => sum + range.last - range.first + 1,0);
    const counts = [analysis.reference && `参考尺寸 ${analysis.reference}`,!sequence.truncated && `缺 ${missing} 帧`,
      `${analysis.mismatched.length} 帧尺寸不一致`,analysis.duplicate.length && `${analysis.duplicate.length} 帧重号`,
      analysis.unreadable.length && `${analysis.unreadable.length} 个帧头无法读取`];
    summary.textContent = counts.filter(Boolean).join(' · ');
    const span = Math.max(1,sequence.last - sequence.first + 1);
    const timelineNodes = [];
    const issueNodes = [];
    function add(kind,first,last,text) {
      const marker = document.createElement('i');
      marker.dataset.issue = kind;
      marker.style.left = `${100 * (first - sequence.first) / span}%`;
      marker.style.width = `${100 * (last - first + 1) / span}%`;
      marker.title = text;
      timelineNodes.push(marker);
      if (issueNodes.length >= 120) return;
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.dataset.frame = first;
      button.textContent = text;
      row.append(button);
      issueNodes.push(row);
    }
    for (const {first,last} of analysis.missing) add('missing',first,last,
      `缺帧 ${label(sequence,first)}${first !== last ? `–${label(sequence,last)}` : ''}`);
    for (const {number,label:dimensions} of analysis.mismatched) add('size',number,number,`尺寸不一致 ${label(sequence,number)} · ${dimensions}`);
    for (const number of analysis.duplicate) add('duplicate',number,number,`帧号重复 ${label(sequence,number)}`);
    for (const number of analysis.unreadable) add('unreadable',number,number,`帧头无法读取 ${label(sequence,number)}`);
    timeline.replaceChildren(...timelineNodes);
    issues.replaceChildren(...issueNodes);
  }

  async function showFrame(sequence,number) {
    if (!active(sequence)) return;
    const request = ++sequence.request;
    sequence.number = number;
    seek.value = number;
    frameLabel.textContent = `${label(sequence,number)} / ${label(sequence,sequence.last)}`;
    seek.setAttribute('aria-valuetext',`第 ${label(sequence,number)} 帧`);
    const frame = sequence.byNumber.get(number);
    exrCompare.hidden = !onCompareExr || !frame || sequence.group.extension !== 'exr';
    if (!frame) {
      image.hidden = true;
      pictureStatus.textContent = sequence.truncated ? '该帧未出现在本次扫描范围内' : `缺帧 ${label(sequence,number)}`;
      return;
    }
    pictureStatus.textContent = `正在读取 ${label(sequence,number)}…`;
    try {
      let preview = sequence.images.get(frame.path);
      if (!preview) {
        if (sequence.pendingPreview) await sequence.pendingPreview.catch(() => {});
        if (!active(sequence) || request !== sequence.request) return;
        const reading = api('render_sequence_frame_preview',{path:frame.path,size:768});
        sequence.pendingPreview = reading;
        try { preview = await reading; }
        finally { if (sequence.pendingPreview === reading) sequence.pendingPreview = null; }
        if (!active(sequence)) return;
        if (preview) sequence.images.set(frame.path,preview);
        if (sequence.images.size > imageCacheSize) sequence.images.delete(sequence.images.keys().next().value);
      }
      if (!active(sequence) || request !== sequence.request) return;
      if (!preview) throw Error('此帧暂无可用预览');
      image.src = preview;
      image.hidden = false;
      pictureStatus.textContent = '';
    } catch (failure) {
      if (!active(sequence) || request !== sequence.request) return;
      image.hidden = true;
      pictureStatus.textContent = String(failure?.message || failure);
    }
  }

  async function scanSizes(sequence,directory) {
    const frames = sequence.group.frames;
    for (let offset = 0; offset < frames.length; offset += batchSize) {
      if (!active(sequence)) return;
      checkStatus.textContent = `正在检查帧头 ${offset} / ${frames.length}`;
      try {
        const sizes = await api('render_sequence_frame_sizes',{directory,paths:frames.slice(offset,offset + batchSize).map(frame => frame.path)});
        if (!active(sequence)) return;
        for (const size of sizes) sequence.sizes.set(size.path,size);
      } catch (failure) {
        if (!active(sequence)) return;
        checkStatus.textContent = String(failure?.message || failure);
        markers(sequence);
        return;
      }
    }
    checkStatus.textContent = sequence.truncated ? '目录扫描达到上限，缺帧判断已停用。' : '';
    markers(sequence);
  }

  function choose(group,path) {
    stop(current.sequence);
    const {frames} = group;
    const first = frames[0].number;
    const last = frames.at(-1).number;
    const byNumber = new Map();
    for (const frame of frames) if (!byNumber.has(frame.number)) byNumber.set(frame.number,frame);
    const samePath = (a,b) => a === b || (/^[a-z]:|^\\\\/i.test(a) && a.toLowerCase() === b.toLowerCase());
    const number = path ? frames.find(frame => samePath(frame.path,path))?.number ?? first : first;
    const sequence = current.sequence = {group,first,last,number,byNumber,request:0,images:new Map(),sizes:new Map(),truncated:current.report.truncated};
    image.removeAttribute('src');
    image.hidden = true;
    seek.min = first;
    seek.max = last;
    seek.disabled = play.disabled = first === last;
    markers(sequence);
    void showFrame(sequence,number);
    void scanSizes(sequence,current.report.directory);
  }

  async function show({path,isDirectory}) {
    if (dialog.open) return;
    const draft = current = {};
    seek.disabled = play.disabled = groups.disabled = true;
    groups.replaceChildren();
    timeline.replaceChildren();
    issues.replaceChildren();
    summary.textContent = checkStatus.textContent = frameLabel.textContent = '';
    image.hidden = true;
    pictureStatus.textContent = '正在识别编号序列…';
    dialog.showModal();
    try {
      const report = await api('inspect_render_sequences',{path,isDirectory});
      if (current !== draft || !dialog.open) return;
      draft.report = report;
      if (!report.sequences.length) {
        pictureStatus.textContent = report.truncated ? '当前扫描范围内未发现连号序列。' : '未发现至少两帧的编号图像序列。';
        return;
      }
      const group = report.sequences.find(item => item.key === report.activeKey) || report.sequences[0];
      groups.replaceChildren(...report.sequences.map(item => new Option(`${item.label} · ${item.frames.length} 帧`,item.key)));
      groups.value = group.key;
      groups.disabled = report.sequences.length < 2;
      choose(group,isDirectory ? null : path);
    } catch (failure) {
      if (current === draft) pictureStatus.textContent = String(failure?.message || failure);
    }
  }

  exrCompare.addEventListener('click',() => {
    const sequence = current?.sequence;
    const frame = sequence?.byNumber.get(sequence.number);
    if (!frame || sequence.group.extension !== 'exr') return;
    stop(sequence);
    onCompareExr?.({path:frame.path});
  });
  groups.addEventListener('change',() => choose(current.report.sequences.find(item => item.key === groups.value)));
  seek.addEventListener('input',() => {
    const sequence = current?.sequence;
    if (!sequence) return;
    stop(sequence);
    void showFrame(sequence,seek.valueAsNumber);
  });
  issues.addEventListener('click',event => {
    const button = event.target.closest('[data-frame]');
    const sequence = current?.sequence;
    if (!button || !sequence) return;
    stop(sequence);
    void showFrame(sequence,Number(button.dataset.frame));
  });
  play.addEventListener('click',() => {
    const sequence = current?.sequence;
    if (!sequence?.byNumber.size) return;
    if (sequence.playing) { stop(sequence); return; }
    sequence.playing = true;
    play.textContent = '暂停';
    async function advance() {
      if (!active(sequence) || !sequence.playing) return;
      const start = performance.now();
      await showFrame(sequence,sequence.number >= sequence.last ? sequence.first : sequence.number + 1);
      if (active(sequence) && sequence.playing) sequence.timer = setTimeout(advance,Math.max(0,1000 / Number(fps.value) - (performance.now() - start)));
    }
    void advance();
  });
  dialog.querySelector('[data-close]').addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => {
    stop(current?.sequence);
    current = null;
    exrCompare.hidden = true;
    image.removeAttribute('src');
  });
  return {show};
}
