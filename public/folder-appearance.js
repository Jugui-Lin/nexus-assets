const icons = {
  folder:'文件夹', box:'模型', grid:'分类', stack:'素材', picture:'图片', play:'视频',
  star:'星标', tag:'标签', eye:'参考', person:'人物', notes:'文档', clock:'历史',
  settings:'工具', download:'下载', list:'清单', link:'链接', info:'资料', check:'完成',
};

const colors = {
  default:['默认', 'currentColor'], red:['红色', '#ff6f70'], orange:['橙色', '#ffae68'],
  yellow:['黄色', '#f3d26b'], green:['绿色', '#7dd69b'], cyan:['青色', '#67d4df'],
  blue:['蓝色', '#73b8ff'], violet:['紫色', '#bc9cfb'], pink:['粉色', '#f49cca'],
};

export function initFolderAppearance({scope, icon, change, notify}) {
  const appearanceKey = owner => 'nexus-folder-appearance-v1:' + owner;
  const key = (libraryId, path) => JSON.stringify([libraryId, path]);
  let loadedScope;
  let styles;

  function currentStyles() {
    const owner = scope();
    if (owner !== loadedScope) {
      try {
        const entries = JSON.parse(localStorage.getItem(appearanceKey(owner))) || [];
        styles = new Map(entries);
      } catch { styles = new Map(); }
      loadedScope = owner;
    }
    return styles;
  }

  function get(libraryId, path) {
    const style = currentStyles().get(key(libraryId, path));
    return {glyph:Object.hasOwn(icons, style?.glyph) ? style.glyph : 'folder',
      color:Object.hasOwn(colors, style?.color) ? style.color : 'default'};
  }

  return {
    icon(libraryId, path, fallback = 'folder') {
      const {glyph, color} = get(libraryId, path);
      return '<span class="folder-appearance-glyph" data-color="' + color + '">' +
        icon(glyph === 'folder' ? fallback : glyph) + '</span>';
    },
    choices({libraryId, path}) {
      const owner = scope();
      return {
        icons:Object.entries(icons),
        colors:Object.entries(colors),
        selected:() => get(libraryId, path),
        choose(selection) {
          if (scope() !== owner) return;
          const current = get(libraryId, path);
          const {glyph, color} = {...current, ...selection};
          if (glyph === current.glyph && color === current.color) return;
          const updated = new Map(currentStyles());
          const folderKey = key(libraryId, path);
          if (glyph === 'folder' && color === 'default') updated.delete(folderKey);
          else updated.set(folderKey, {glyph, color});
          try { localStorage.setItem(appearanceKey(owner), JSON.stringify([...updated])); }
          catch { notify('无法保存文件夹外观', true); return; }
          styles = updated;
          change();
        },
      };
    },
    move(libraryId, from, to) {
      const updated = new Map(currentStyles());
      for (const [raw, appearance] of currentStyles()) {
        const [id, path] = JSON.parse(raw);
        if (id === libraryId && (path === from || path.startsWith(from + '/'))) {
          updated.delete(raw);
          updated.set(key(id, to + path.slice(from.length)), appearance);
        }
      }
      try {
        localStorage.setItem(appearanceKey(scope()), JSON.stringify([...updated]));
        styles = updated;
      } catch { /* The folder move is already committed. */ }
    },
  };
}
