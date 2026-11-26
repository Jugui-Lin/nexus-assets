const storageKey = 'nexus-delivery-templates-v1';
const standard = {
  name:'制作与交付', rootPattern:'{项目}_{日期}',
  folders:['工程','素材/贴图','渲染','审片','交付/{日期}'],
};

export function initDeliveryTemplate({api,currentFolder,openFolder,closeMenu,notify}) {
  const dialog = document.querySelector('#delivery-template-dialog');
  const trigger = document.querySelector('#delivery-template');
  const get = field => dialog.querySelector('[data-delivery-' + field + ']');
  const form = get('form');
  const selection = get('preset');
  const status = get('status');
  const preview = get('preview');
  const controls = [...form.querySelectorAll('input,select,textarea,button')];
  let plan, busy = false, created;

  function today() {
    const date = new Date();
    return [date.getFullYear(),date.getMonth() + 1,date.getDate()].map(part => String(part).padStart(2,'0')).join('-');
  }

  function templates() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(storageKey)); }
    catch {}
    return [standard,...(Array.isArray(stored) ? stored.filter(item => item &&
      typeof item.name === 'string' && item.name.length <= 48 && typeof item.rootPattern === 'string' &&
      Array.isArray(item.folders) && item.folders.length <= 48 && item.folders.every(value => typeof value === 'string')).slice(0,23) : [])];
  }

  function selectTemplates(name) {
    selection.replaceChildren(...templates().map(item => new Option(item.name,item.name)));
    selection.value = name;
  }

  function readInput() {
    return {
      destination:get('destination').value.trim(), project:get('project').value.trim(), date:get('date').value,
      rootPattern:get('pattern').value.trim(),
      folders:get('paths').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
    };
  }

  function render() {
    for (const item of controls) item.disabled = busy;
    get('close').disabled = busy;
    get('create').disabled = busy || !plan || plan.exists;
    get('open').hidden = !created;
    get('open').disabled = busy;
    preview.hidden = !plan;
    if (plan) {
      get('root').textContent = plan.root;
      get('rows').replaceChildren(...plan.folders.map(path => {
        const li = document.createElement('li');
        li.textContent = path;
        return li;
      }));
    }
  }

  function refreshDraft() {
    plan = created = null;
    status.textContent = '';
    render();
  }

  async function prepare(verb) {
    if (busy || !form.reportValidity()) return;
    const input = readInput();
    if (verb === 'create' && (!plan || plan.exists || plan.signature !== JSON.stringify(input))) return;
    busy = true;
    render();
    try {
      const result = await api(verb === 'create' ? 'create_delivery_template' : 'preview_delivery_template',{input});
      if (verb === 'preview') {
        plan = {...result,signature:JSON.stringify(input)};
        status.textContent = result.exists ? '目标位置已有同名文件或文件夹。' : '将新建 ' + result.folders.length + ' 个子目录。';
      } else {
        created = result.root;
        plan = null;
        status.textContent = '已创建 ' + result.root;
        notify('交付目录已创建。');
      }
    } catch (error) {
      plan = null;
      status.textContent = error.message || String(error);
    } finally { busy = false; render(); }
  }

  function load(choice) {
    get('pattern').value = choice.rootPattern;
    get('paths').value = choice.folders.join('\n');
    get('name').value = choice === standard ? '' : choice.name;
    refreshDraft();
  }

  form.addEventListener('input',event => { if (event.target !== get('name')) refreshDraft(); });
  form.addEventListener('submit',event => { event.preventDefault(); void prepare('preview'); });
  selection.addEventListener('change',() => {
    const template = templates().find(item => item.name === selection.value);
    if (template) load(template);
  });
  get('save').addEventListener('click',() => {
    const name = get('name').value.trim();
    const {rootPattern,folders} = readInput();
    if (!name || name.length > 48 || name === standard.name || !rootPattern || !folders.length || folders.length > 48) {
      status.textContent = '请填写自定义模板名称、最外层名称和子目录。';
      return;
    }
    try {
      const existing = templates().filter(item => item !== standard && item.name !== name);
      if (existing.length >= 23) throw Error('本机最多保存 23 个自定义模板。');
      localStorage.setItem(storageKey,JSON.stringify([{name,rootPattern,folders},...existing]));
      selectTemplates(name);
      status.textContent = '已保存模板「' + name + '」。';
    } catch (error) { status.textContent = error.message; }
  });
  get('pick').addEventListener('click',async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      const path = await api('pick_folder',{purpose:'delivery-template'});
      if (path) { get('destination').value = path; refreshDraft(); }
    } catch (error) { status.textContent = error.message || String(error); }
    finally { busy = false; render(); }
  });
  get('create').addEventListener('click',() => { void prepare('create'); });
  get('open').addEventListener('click',() => {
    if (!created || busy) return;
    dialog.close();
    Promise.resolve(openFolder(created)).catch(error => notify(error.message || String(error),true));
  });
  get('close').addEventListener('click',() => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel',event => { if (busy) event.preventDefault(); });
  trigger.hidden = false;
  trigger.addEventListener('click',() => {
    closeMenu();
    selectTemplates(standard.name);
    get('date').value = today();
    get('project').value = '';
    get('destination').value = currentFolder() || '';
    load(standard);
    dialog.showModal();
  });
}
