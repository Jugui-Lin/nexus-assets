const aliases = {
  'appearance-theme': '颜色 配色 深色 浅色 主题 theme',
  'workspace-new-tab-action': '加号 默认 打开 复制当前标签 Ctrl+T',
  'file-workspace-start-workspace': '启动优先 默认打开 资产库 文件夹 此电脑',
  'file-workspace-show-extensions': '后缀 文件格式 扩展名 extension',
  'file-workspace-show-thumbnails': '预览 封面 缩略图 thumbnail',
  'file-workspace-quick-preview': 'Space 空格 快看',
  'settings': '插件 桥接 Blender Cinema 4D C4D Maya Houdini Max',
  'cloud-mounts': 'SMB WebDAV rclone 挂载 网络位置',
};

function fieldTitle(field) {
  if (field.hasAttribute('aria-label')) return field.getAttribute('aria-label');
  const label = field.labels?.[0]?.cloneNode(true);
  if (!label) return '';
  label.querySelector('select')?.remove();
  return textOf(label);
}

function textOf(element) {
  return element.textContent.replace(/\s+/g, ' ').trim();
}

export function initWorkspaceSettingsSearch(menu, closeMenu) {
  const input = menu.querySelector('#workspace-settings-query');
  const results = menu.querySelector('#workspace-settings-matches');
  const panel = input.closest('.workspace-tools-panel');
  const preferences = document.querySelector('#file-workspace-preferences-dialog');
  const fileSettings = panel.querySelector('[data-file-workspace-command="preferences"]');
  const tabSettings = panel.querySelector('[data-file-workspace-command="tab-preferences"]');
  const theme = panel.querySelector('#appearance-theme');

  function clear() {
    input.value = '';
    panel.classList.remove('is-searching');
    results.hidden = true;
    results.replaceChildren();
  }

  function focusField(field, entry, tab) {
    entry.click();
    tab?.click();
    if (field.closest('dialog')?.open) field.focus();
  }

  function entries() {
    const tools = [...panel.querySelectorAll(':scope > button, .workspace-tools-section-actions > button')]
      .filter(button => !button.hidden && !button.classList.contains('hidden') && !button.disabled &&
        button.dataset.fileWorkspaceCommand !== 'quit' &&
        (menu.id !== 'top-tools' || !button.hasAttribute('data-file-workspace-command')))
      .map(button => ({
        label: textOf(button),
        path: button.closest('.workspace-tools-section')?.querySelector('summary')?.textContent.trim() || '',
        terms: aliases[button.id],
        activate: () => button.click(),
      }));
    const themeEntry = {
      label: fieldTitle(theme), path: '外观', terms: aliases[theme.id],
      activate() {
        input.focus({preventScroll:true});
        clear();
        theme.closest('.workspace-tools-section').open = true;
        theme.focus();
      },
    };
    if (menu.id === 'top-tools') return [themeEntry, ...tools];

    const fields = [...preferences.querySelectorAll('.folder-preferences-panel :is(input, select, textarea)')]
      .filter(field => !field.disabled)
      .map(field => {
        const section = field.closest('.folder-preferences-panel');
        const tab = document.getElementById(section.getAttribute('aria-labelledby'));
        return {
          label: fieldTitle(field), path: `文件夹设置 › ${textOf(tab)}`, terms: aliases[field.id],
          activate: () => focusField(field, fileSettings, tab),
        };
      });
    const newTab = document.querySelector('#workspace-new-tab-action');
    fields.push({label: fieldTitle(newTab), path: '标签页设置', terms: aliases[newTab.id],
      activate: () => focusField(newTab, tabSettings)});
    return [themeEntry, ...tools, ...fields];
  }

  function render() {
    const query = input.value.normalize('NFKC').toLowerCase().trim();
    if (!query) {
      panel.classList.remove('is-searching');
      results.hidden = true;
      results.replaceChildren();
      return;
    }
    const words = query.split(/\s+/);
    const matches = entries().filter(entry => {
      const keywords = [entry.label, entry.path, entry.terms].join(' ').normalize('NFKC').toLowerCase();
      return entry.label && words.every(word => keywords.includes(word));
    });
    matches.sort((a,b) => Number(b.label.includes(query)) - Number(a.label.includes(query)));
    const options = matches.map(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-item workspace-settings-result';
      button.textContent = entry.label;
      if (entry.path) {
        const path = document.createElement('small');
        path.textContent = entry.path;
        button.append(path);
      }
      button.addEventListener('click', entry.activate);
      return button;
    });
    if (!options.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.role = 'status';
      empty.textContent = '没有匹配的设置';
      options.push(empty);
    }
    panel.classList.add('is-searching');
    results.hidden = false;
    results.replaceChildren(...options);
  }

  input.addEventListener('input', render);
  menu.addEventListener('toggle', () => {
    if (!menu.open) clear();
  });
  panel.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && input.value && (event.target === input || results.contains(event.target))) {
      event.preventDefault();
      event.stopPropagation();
      clear();
      input.focus();
      return;
    }
    if (event.target !== input && !results.contains(event.target)) return;
    const options = [...results.querySelectorAll('button')];
    if (!options.length) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.target === input ? options[0] : event.target).click();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const index = options.indexOf(event.target) + 1 + (event.key === 'ArrowDown' ? 1 : -1);
      if (index < 1 || index > options.length) input.focus();
      else options[index - 1].focus();
    }
  });
}
