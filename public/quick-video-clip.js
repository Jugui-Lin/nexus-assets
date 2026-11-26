import {videoClipRange} from './whiteboard-video-clip-reference.js';

export function initQuickVideoClip({dialog,video,context,listProjects,save}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button subtle';
  button.textContent = '收藏片段';
  button.hidden = true;
  button.setAttribute('aria-controls','quick-video-clip-panel');
  button.setAttribute('aria-expanded','false');
  dialog.querySelector('#quick-open-player').before(button);
  const panel = document.createElement('form');
  panel.id = 'quick-video-clip-panel';
  panel.className = 'quick-video-clip-panel';
  panel.setAttribute('aria-label','收藏视频片段到白板');
  panel.hidden = true;
  panel.innerHTML = `<label>名称<input data-clip-title maxlength="120" required></label>
    <label>入点（秒）<input type="number" data-clip-time="start" min="0" step=".001" required></label>
    <button type="button" class="button subtle" data-clip-set="start">当前为入点</button>
    <label>出点（秒）<input type="number" data-clip-time="end" min="0" step=".001" required></label>
    <button type="button" class="button subtle" data-clip-set="end">当前为出点</button>
    <label>白板项目<select data-clip-project required></select></label>
    <div class="quick-video-clip-actions"><button type="button" class="button subtle" data-clip-cancel>取消</button>
      <button type="submit" class="button primary" disabled>添加到白板</button></div>
    <p data-clip-status role="status"></p>`;
  dialog.querySelector('.quick-preview-stage').after(panel);
  const find = selector => panel.querySelector(selector);
  const title = find('[data-clip-title]');
  const start = find('[data-clip-time="start"]');
  const end = find('[data-clip-time="end"]');
  const projects = find('[data-clip-project]');
  const status = find('[data-clip-status]');
  const submit = find('[type="submit"]');
  let draft;
  const current = value => draft === value && dialog.open && context()?.serial === value.serial;
  const rounded = value => String(Math.round(value * 1000) / 1000);

  function refresh() {
    button.hidden = !context() || !video.hasAttribute('src') || !Number.isFinite(video.duration) || video.duration <= 0;
  }

  function reset(focus = false) {
    draft = null;
    panel.hidden = true;
    button.setAttribute('aria-expanded','false');
    panel.removeAttribute('aria-busy');
    refresh();
    if (focus && !button.hidden) button.focus({preventScroll:true});
  }

  async function open() {
    const details = context();
    if (!details || button.hidden) return;
    if (draft) { reset(true); return; }
    const request = {...details,duration:video.duration};
    draft = request;
    video.pause();
    panel.hidden = false;
    button.setAttribute('aria-expanded','true');
    title.value = details.name.slice(0,120);
    const time = video.currentTime < video.duration - .002 ? video.currentTime : Math.max(0,video.duration - 3);
    start.max = end.max = rounded(video.duration);
    start.value = rounded(time);
    end.value = rounded(Math.min(video.duration,time + 3));
    projects.replaceChildren();
    projects.disabled = submit.disabled = true;
    status.textContent = '正在加载当前资产库的白板项目…';
    title.focus({preventScroll:true});
    title.select();
    try {
      const available = await listProjects(request.scope);
      if (!current(request)) return;
      projects.replaceChildren(...available.map(project => new Option(project.name,project.id)));
      if (available.some(project => project.id === request.project)) projects.value = request.project;
      projects.disabled = submit.disabled = available.length === 0;
      status.textContent = available.length ? '' : '当前资产库没有可用的白板项目';
    } catch (failure) {
      if (current(request)) status.textContent = String(failure?.message || failure);
    }
  }

  button.addEventListener('click',() => void open());
  for (const event of ['loadedmetadata','durationchange','emptied','error']) video.addEventListener(event,refresh);
  panel.addEventListener('click',event => {
    const mark = event.target.closest('[data-clip-set]')?.dataset.clipSet;
    if (mark && draft) (mark === 'start' ? start : end).value = rounded(video.currentTime);
    if (event.target.closest('[data-clip-cancel]')) reset(true);
  });
  panel.addEventListener('submit',async event => {
    event.preventDefault();
    const request = draft;
    if (!request || !current(request) || submit.disabled) return;
    const segment = videoClipRange(start.valueAsNumber,end.valueAsNumber,request.duration);
    const name = title.value.trim();
    if (!segment || !name || !projects.value) {
      status.textContent = '请输入名称，并在视频时长范围内设置先入点、后出点';
      return;
    }
    submit.disabled = true;
    panel.setAttribute('aria-busy','true');
    status.textContent = '正在将片段引用添加到白板…';
    try {
      await save({...request,...segment,projectId:projects.value,title:name},() => current(request));
      if (current(request)) dialog.close();
    } catch (failure) {
      if (current(request)) status.textContent = String(failure?.message || failure);
    } finally {
      if (current(request)) {
        submit.disabled = false;
        panel.removeAttribute('aria-busy');
      }
    }
  });
  return {reset,contains:target => panel.contains(target)};
}
