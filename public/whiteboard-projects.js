import {initWhiteboard} from './whiteboard.js';

const directoryKey = 'nexus-whiteboard-projects-v1:';
const defaultProject = {id:'default', name:'默认项目'};
const projectLimit = 100;
const nameLimit = 80;
const projectIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;

function cleanProjects(source) {
  const projects = new Map([[defaultProject.id, defaultProject]]);
  for (const project of source.slice(0, projectLimit)) {
    if (typeof project?.id === 'string' && projectIdPattern.test(project.id) &&
        typeof project.name === 'string' && project.name.trim()) {
      projects.set(project.id, {id:project.id, name:project.name.trim()});
    }
  }
  return [...projects.values()].slice(0, projectLimit);
}

function readProjects(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(directoryKey + key));
    if (Array.isArray(saved)) return cleanProjects(saved);
  } catch {}
  return [defaultProject];
}

function syncError(error) {
  const message = String(error?.message || error || '');
  return /^团队服务返回错误 (404|405|501)\b/.test(message)
    ? '更新团队服务后可使用白板项目。'
    : '暂时无法同步项目列表。';
}

export function initWhiteboardProjects({panel, api, notify = () => {}, resolveAssetImage}) {
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  panel.innerHTML = `<section class="whiteboard-project-home" aria-labelledby="whiteboard-project-heading">
    <header class="whiteboard-project-bar">
      <div class="whiteboard-project-heading"><h2 id="whiteboard-project-heading">白板项目</h2><p>双击项目打开画布</p></div>
      <button type="button" class="button primary" data-project-create>${icon('plus')}新建项目</button>
    </header>
    <div class="whiteboard-project-status" hidden>
      <span role="status"></span>
      <button type="button" class="text-button" data-project-retry hidden>重试</button>
    </div>
    <ul class="whiteboard-project-grid" aria-label="白板项目"></ul>
  </section>
  <section class="whiteboard-project-editor hidden" aria-labelledby="whiteboard-project-name">
    <header class="whiteboard-project-bar whiteboard-project-editor-bar">
      <button type="button" class="button subtle" data-project-back>${icon('arrow')}返回项目</button>
      <h2 id="whiteboard-project-name"></h2>
    </header>
    <div class="whiteboard-project-canvas"></div>
  </section>`;
  const $ = selector => panel.querySelector(selector);
  const home = $('.whiteboard-project-home');
  const editor = $('.whiteboard-project-editor');
  const editorName = $('#whiteboard-project-name');
  const canvas = $('.whiteboard-project-canvas');
  const grid = $('.whiteboard-project-grid');
  const create = $('[data-project-create]');
  const back = $('[data-project-back]');
  const retry = $('[data-project-retry]');
  const status = $('.whiteboard-project-status');
  const statusText = status.querySelector('span');
  const board = initWhiteboard({panel:canvas, api, notify, resolveAssetImage});

  const dialog = document.createElement('dialog');
  dialog.className = 'modal whiteboard-project-dialog';
  dialog.setAttribute('aria-labelledby', 'whiteboard-project-dialog-title');
  dialog.innerHTML = `<form>
    <header class="modal-header">
      <h2 id="whiteboard-project-dialog-title"></h2>
      <button type="button" class="icon-button" aria-label="关闭" data-project-cancel>${icon('close')}</button>
    </header>
    <label class="field-label" for="whiteboard-project-field">项目名称</label>
    <input class="text-field" id="whiteboard-project-field" maxlength="${nameLimit * 2}" required>
    <p class="whiteboard-project-error" role="alert" hidden></p>
    <footer class="modal-footer">
      <button type="button" class="button subtle" data-project-cancel>取消</button>
      <button type="submit" class="button primary" data-project-save>保存</button>
    </footer>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const nameInput = dialog.querySelector('input');
  const save = dialog.querySelector('[data-project-save]');
  const formError = dialog.querySelector('[role="alert"]');

  let scope;
  let visible = false;
  let activeProject = null;
  let draft;

  function persist(target) {
    try {
      localStorage.setItem(directoryKey + target.key, JSON.stringify(target.projects));
      return true;
    } catch { return false; }
  }

  function setBoardScope(id) {
    board.setScope({
      key:id === defaultProject.id ? scope.key : JSON.stringify([scope.key, id]),
      workspaceKey:scope.key,
      teamId:scope.teamId,
      projectId:id,
    });
  }

  function renderStatus() {
    statusText.textContent = scope.error || (scope.teamId && !scope.ready ? '正在同步项目…' : '');
    status.hidden = !statusText.textContent;
    retry.hidden = !scope.error;
    create.disabled = scope.projects.length >= projectLimit;
  }

  function focusCard(id) {
    [...grid.querySelectorAll('[data-project-open]')].find(button => button.dataset.projectOpen === id)?.focus();
  }

  function renderCards() {
    const focus = grid.contains(document.activeElement) ? document.activeElement : null;
    grid.replaceChildren(...scope.projects.map(project => {
      const card = document.createElement('li');
      card.className = 'whiteboard-project-card';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'whiteboard-project-open';
      open.dataset.projectOpen = project.id;
      open.title = '双击打开项目';
      open.innerHTML = `<span class="whiteboard-project-cover">${icon('whiteboard')}</span><span class="whiteboard-project-title"></span>`;
      open.querySelector('.whiteboard-project-title').textContent = project.name;
      open.addEventListener('dblclick', () => openProject(project.id));
      open.addEventListener('click', event => { if (event.detail === 0) openProject(project.id); });
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'icon-button whiteboard-project-rename';
      rename.dataset.projectRename = project.id;
      rename.title = '重命名';
      rename.setAttribute('aria-label', `重命名 ${project.name}`);
      rename.innerHTML = icon('edit');
      rename.addEventListener('click', () => startDraft(project));
      card.append(open, rename);
      return card;
    }));
    if (focus?.dataset.projectOpen) focusCard(focus.dataset.projectOpen);
    if (focus?.dataset.projectRename) {
      [...grid.querySelectorAll('[data-project-rename]')]
        .find(button => button.dataset.projectRename === focus.dataset.projectRename)?.focus();
    }
    renderStatus();
  }

  async function refreshProjects() {
    const target = scope;
    if (!visible || activeProject || !target?.teamId || target.request || target.saving) return;
    const request = {};
    target.request = request;
    try {
      const snapshot = await api('team_whiteboard_projects', {teamId:target.teamId});
      if (scope !== target || target.request !== request) return;
      if (!Array.isArray(snapshot?.projects)) throw Error('项目列表不可用');
      const projects = cleanProjects(snapshot.projects);
      const changed = JSON.stringify(projects) !== JSON.stringify(target.projects);
      target.ready = true;
      target.error = '';
      if (changed) {
        target.projects = projects;
        persist(target);
        renderCards();
      } else renderStatus();
    } catch (error) {
      if (scope === target && target.request === request) {
        target.error = syncError(error);
        renderStatus();
      }
    } finally {
      if (target.request === request) target.request = null;
    }
  }

  function openProject(id, focus = true) {
    const project = scope?.projects.find(item => item.id === id);
    if (!visible || !project) return;
    board.setVisible(false);
    activeProject = project.id;
    editorName.textContent = project.name;
    home.classList.add('hidden');
    editor.classList.remove('hidden');
    setBoardScope(project.id);
    board.setVisible(true);
    if (focus) canvas.querySelector('.whiteboard-stage')?.focus({preventScroll:true});
  }

  function showProjects(focus = false) {
    const previous = activeProject;
    board.setVisible(false);
    activeProject = null;
    editor.classList.add('hidden');
    home.classList.remove('hidden');
    if (focus && previous) focusCard(previous);
    refreshProjects();
  }

  function displayFormError(message = '') {
    formError.textContent = message;
    formError.hidden = !message;
  }

  function startDraft(project) {
    if (dialog.open || scope.saving) return;
    draft = {target:scope, id:project?.id || crypto.randomUUID(), rename:Boolean(project)};
    dialog.querySelector('h2').textContent = project ? '重命名项目' : '新建白板项目';
    nameInput.value = project?.name || '';
    save.textContent = project ? '保存' : '创建项目';
    save.disabled = false;
    displayFormError();
    dialog.showModal();
    nameInput.focus();
    nameInput.select();
  }

  async function saveProject(event) {
    event.preventDefault();
    if (!draft || scope !== draft.target || scope.saving) return;
    const name = nameInput.value.trim();
    if (!name || [...name].length > nameLimit || /\p{Cc}/u.test(name)) {
      displayFormError(`请输入 1–${nameLimit} 个字符的项目名称。`);
      nameInput.focus();
      return;
    }
    const current = draft;
    const {target, id, rename} = current;
    if (!rename && target.projects.length >= projectLimit) {
      displayFormError(`最多可以保存 ${projectLimit} 个白板项目。`);
      return;
    }
    target.saving = true;
    target.request = null;
    save.disabled = true;
    try {
      const previous = target.projects;
      if (target.teamId) {
        const command = rename ? 'team_whiteboard_rename_project' : 'team_whiteboard_create_project';
        const snapshot = await api(command, {teamId:target.teamId, projectId:id, name});
        if (!Array.isArray(snapshot?.projects)) throw Error('团队服务返回了无效的项目列表。');
        if (scope !== target) return;
        target.projects = cleanProjects(snapshot.projects);
        target.ready = true;
        target.error = '';
      } else {
        const project = {id, name};
        target.projects = rename ? previous.map(item => item.id === id ? project : item) : [...previous, project];
      }
      if (!persist(target) && !target.teamId) {
        target.projects = previous;
        throw Error('无法在本机保存白板项目。');
      }
      if (draft === current) dialog.close();
      renderCards();
      if (visible && !activeProject) focusCard(id);
    } catch (error) {
      if (draft === current) displayFormError(String(error?.message || error || '无法保存项目。'));
    } finally {
      target.saving = false;
      if (draft === current) save.disabled = false;
    }
  }

  form.addEventListener('submit', saveProject);
  nameInput.addEventListener('input', () => displayFormError());
  dialog.addEventListener('close', () => { draft = null; });
  for (const cancel of dialog.querySelectorAll('[data-project-cancel]')) {
    cancel.addEventListener('click', () => dialog.close());
  }
  create.addEventListener('click', () => startDraft());
  back.addEventListener('click', () => showProjects(true));
  retry.addEventListener('click', refreshProjects);
  window.setInterval(() => { if (!document.hidden) refreshProjects(); }, 5000);

  return {
    setContext({key, teamId, visible:show}) {
      if (scope?.key === key && visible === show) return;
      board.setVisible(false);
      if (dialog.open) dialog.close();
      if (scope?.key !== key) {
        scope = {key, teamId, projects:readProjects(key), ready:!teamId, error:''};
        setBoardScope(defaultProject.id);
        renderCards();
      }
      visible = show;
      showProjects();
    },
    showProjects,
    openProject,
    captureProject() { return activeProject; },
    busyForUpdate() { return board.busyForUpdate(); },
    dropNativeImages(paths, position) { return Boolean(activeProject) && board.dropNativeImages(paths, position); },
    contextMenu(event) {
      if (!visible) return null;
      if (activeProject) return board.contextMenu(event);
      const card = event.target.closest('.whiteboard-project-card');
      const anchor = card?.querySelector('[data-project-open]') || create;
      const project = scope.projects.find(item => item.id === anchor.dataset.projectOpen);
      const actions = project ? [
        ['whiteboard', '打开项目', () => openProject(project.id)],
        ['edit', '重命名项目…', () => startDraft(project)],
      ] : [];
      if (!create.disabled) actions.push(['plus', '新建项目…', () => startDraft()]);
      actions.push(['refresh', '刷新', refreshProjects]);
      return {anchor,actions,label:'白板项目操作'};
    },
    refresh() {
      if (activeProject) board.refresh();
      else refreshProjects();
    },
  };
}
