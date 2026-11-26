const actions = [
  ['address','定位地址栏',['Ctrl+L','Alt+D']],
  ['search','搜索当前位置',['Ctrl+F','']],
  ['back','后退',['Alt+ArrowLeft','']],
  ['forward','前进',['Alt+ArrowRight','']],
  ['up','返回上一级',['Alt+ArrowUp','']],
  ['refresh','刷新当前位置',['F5','']],
  ['history','浏览历史',['','']],
];
const labels = new Map(actions.map(([id,label]) => [id,label]));
const reserved = new Map([
  ['Ctrl+T','新建标签页'],['Ctrl+Shift+A','搜索标签页'],['Ctrl+Shift+T','重开标签页'],['Ctrl+W','关闭标签页'],
  ['Ctrl+A','全选'],['Ctrl+C','复制'],['Ctrl+V','粘贴'],['Ctrl+X','剪切'],['Ctrl+Shift+N','新建文件夹'],
  ['Ctrl+Shift+L','切换文件夹和资产视图'],['Ctrl+Shift+F','工作区搜索'],['F2','重命名'],['F6','切换导航区域'],
  ['Ctrl+Shift+P','文件夹命令搜索'],
  ['F8','切换结果区域'],['Shift+F6','反向切换导航区域'],['Shift+F8','反向切换结果区域'],
  ['Shift+F10','打开右键菜单'],['F11','切换全屏'],['F12','开发者工具'],
  ['Alt+F4','关闭窗口'],['Ctrl+R','浏览器刷新'],['Ctrl+N','新窗口'],['Ctrl+P','打印'],
]);
const allowed = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:[A-Z0-9]|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|F(?:[1-9]|1[0-2]))$/;

function valid(binding) {
  return typeof binding === 'string' && allowed.test(binding) && /^(?:Ctrl\+|Alt\+|(?:Shift\+)?F\d+$)/.test(binding);
}

function chord(event) {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '',event.altKey ? 'Alt' : '',event.shiftKey ? 'Shift' : '',key]
    .filter(Boolean).join('+');
}

export function normalizeExplorerShortcuts(source) {
  const assignments = {};
  const occupied = new Set(reserved.keys());
  for (const [id,,defaults] of actions) {
    const raw = Array.isArray(source?.[id]) ? source[id] : defaults;
    assignments[id] = [0,1].map(index => {
      const value = raw[index];
      if (!valid(value) || occupied.has(value)) return '';
      occupied.add(value);
      return value;
    });
  }
  return assignments;
}

export function explorerShortcutAction(event,assignments) {
  const binding = chord(event);
  for (const [id,,defaults] of actions) {
    if ((assignments?.[id] ?? defaults).includes(binding)) return id;
  }
  return null;
}

export function initExplorerShortcutEditor(host) {
  if (!host) return null;
  const owner = host.ownerDocument;
  const status = host.querySelector('[role="status"]');
  const resolve = host.querySelector('[data-shortcut-resolve]');
  const rows = host.querySelector('[data-shortcut-rows]');
  const controls = new Map();
  let assignments;
  let conflict;

  function issue(message = '',next = null) {
    status.textContent = message;
    conflict = next;
    resolve.hidden = !next;
  }

  function draw() {
    for (const [id,inputs] of controls) inputs.forEach((input,index) => { input.value = assignments[id][index]; });
  }

  function ownerOf(binding,id,index) {
    if (!binding) return null;
    for (const [candidate,bindings] of Object.entries(assignments)) {
      const slot = bindings.indexOf(binding);
      if (slot >= 0 && (candidate !== id || slot !== index)) return {id:candidate,index:slot};
    }
    return null;
  }

  function record(event,id,index) {
    if (event.isComposing || event.key === 'Tab' || event.key === 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    const clear = !event.ctrlKey && !event.altKey && !event.metaKey && ['Backspace','Delete'].includes(event.key);
    const binding = clear ? '' : chord(event);
    if (!clear && !valid(binding)) { issue('请使用功能键，或按住 Ctrl / Alt 后输入组合键。'); return; }
    if (reserved.has(binding)) { issue(binding + ' 已用于「' + reserved.get(binding) + '」。请换一个组合键。'); return; }
    const other = ownerOf(binding,id,index);
    if (other) {
      issue(binding + ' 已用于「' + labels.get(other.id) + '」。', {id,index,binding,other});
      return;
    }
    assignments[id][index] = binding;
    issue();
    draw();
  }

  for (const [id,label,defaults] of actions) {
    const row = owner.createElement('div');
    const caption = owner.createElement('span');
    caption.textContent = label;
    row.append(caption);
    const inputs = [0,1].map(index => {
      const input = owner.createElement('input');
      input.readOnly = true;
      input.placeholder = index ? '备用' : '未设置';
      input.setAttribute('aria-label',label + (index ? '备用快捷键' : '主快捷键'));
      input.addEventListener('keydown',event => record(event,id,index));
      row.append(input);
      return input;
    });
    controls.set(id,inputs);
    const reset = owner.createElement('button');
    reset.type = 'button';
    reset.textContent = '恢复';
    reset.setAttribute('aria-label','恢复' + label + '的默认快捷键');
    reset.addEventListener('click',() => {
      const clashes = defaults.map((binding,index) => ownerOf(binding,id,index)).find(other => other && other.id !== id);
      if (clashes) { issue('默认快捷键已用于「' + labels.get(clashes.id) + '」，请先修改该操作。'); return; }
      assignments[id] = [...defaults];
      issue('已恢复「' + label + '」的默认快捷键。');
      draw();
    });
    row.append(reset);
    rows.append(row);
  }

  resolve.addEventListener('click',() => {
    if (!conflict) return;
    const {id,index,binding,other} = conflict;
    assignments[other.id][other.index] = '';
    assignments[id][index] = binding;
    issue('已将 ' + binding + ' 分配给「' + labels.get(id) + '」。');
    draw();
    controls.get(id)[index].focus({preventScroll:true});
  });

  return {
    fill(source) { assignments = normalizeExplorerShortcuts(source); issue(); draw(); },
    value() { return normalizeExplorerShortcuts(assignments); },
  };
}
