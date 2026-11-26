import {initExplorerAssetMetadata} from './local-explorer-asset-metadata.js';

const titles = {preview:'预览窗格',details:'详细信息窗格'};
const date = new Intl.DateTimeFormat('zh-CN', {
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});
const number = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});

function dateValue(value) {
  const timestamp = new Date(value);
  return Number.isFinite(value) && Number.isFinite(timestamp.getTime()) ? date.format(timestamp) : '—';
}

function sizeValue(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B','KB','MB','GB','TB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return number.format(value) + ' ' + units[unit];
}

export function initExplorerInspector({root,selected,selectedEntries,thumbnail,fileIcon,closeAssetPane,assetMetadata}) {
  const pane = root.querySelector('#file-explorer-inspector');
  const menu = root.querySelector('#file-workspace-view-menu');
  const options = [...menu.querySelectorAll('[data-file-side-pane]')];
  const close = pane.querySelector('[data-file-inspector-close]');
  const title = pane.querySelector('#file-explorer-inspector-title');
  const content = pane.querySelector('[data-file-inspector-content]');
  const name = pane.querySelector('[data-file-inspector-name]');
  const details = pane.querySelector('[data-file-inspector-details]');
  const status = pane.querySelector('[data-file-inspector-status]');
  const visual = pane.querySelector('[data-file-inspector-visual]');
  const fallback = visual.querySelector('svg');
  const values = Object.fromEntries([...pane.querySelectorAll('[data-file-inspector-value]')]
    .map(node => [node.dataset.fileInspectorValue,node]));
  const metadata = assetMetadata && initExplorerAssetMetadata({host:content.parentElement,...assetMetadata});
  let mode, rendered, generation = 0;
  let timer;

  function metadataEntries() {
    return selectedEntries?.() ?? [selected()].filter(Boolean);
  }

  async function displayImage(read,path,size,kind,version) {
    if (!read || version !== generation) return false;
    try {
      const source = await read({path,size});
      if (version !== generation || typeof source !== 'string' || !source.startsWith('data:image/')) return false;
      const image = pane.ownerDocument.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.dataset.fileInspectorKind = kind;
      image.src = source;
      await image.decode();
      if (version !== generation) return false;
      visual.append(image);
      fallback.hidden = true;
      return true;
    } catch { return false; }
  }

  function refresh() {
    if (!mode) return;
    const entry = selected();
    const entries = mode === 'details' ? metadataEntries() : [];
    if (mode === 'details') void metadata?.refresh(entries);
    const next = JSON.stringify([mode,entry?.path,entry?.name,entry?.isDirectory,entry?.size,entry?.modified,entry?.created,entries.length]);
    if (next === rendered) return;
    rendered = next;
    const version = ++generation;
    clearTimeout(timer);
    visual.querySelector('img')?.remove();
    fallback.hidden = false;
    content.hidden = !entry;
    if (!entry) {
      status.textContent = entries.length > 1 ? '已选 ' + entries.length + ' 个项目。' : '请选择一项文件或文件夹。';
      return;
    }

    const preview = mode === 'preview';
    name.textContent = entry.name;
    fallback.querySelector('use').setAttribute('href',entry.isDirectory ? '#i-folder' : '#i-notes');
    details.hidden = preview;
    status.textContent = preview
      ? entry.isDirectory ? '选择文件以查看预览。' : '正在读取预览…'
      : '';

    if (!preview) {
      const extension = /[^.][.]([^.]+)$/.exec(entry.name)?.[1];
      values.type.textContent = entry.isDirectory ? '文件夹' : extension ? extension.toUpperCase() + ' 文件' : '文件';
      values.size.textContent = sizeValue(entry.size);
      values.modified.textContent = dateValue(entry.modified);
      values.created.textContent = dateValue(entry.created);
      values.path.textContent = entry.path || '—';
    }

    if (entry.isDirectory) return;
    timer = setTimeout(async () => {
      if (preview) {
        const found = await displayImage(thumbnail,entry.path,256,'preview',version);
        if (version !== generation) return;
        status.textContent = found ? '' : '此文件暂无预览。';
        if (found) return;
      }
      await displayImage(fileIcon,entry.path,64,'icon',version);
    },60);
  }

  function hide() {
    if (!mode) return;
    mode = rendered = null;
    generation++;
    clearTimeout(timer);
    visual.querySelector('img')?.remove();
    metadata?.hide();
    pane.hidden = true;
    for (const option of options) option.setAttribute('aria-pressed','false');
  }

  function closeAndFocus() {
    hide();
    menu.querySelector('summary').focus();
  }

  function showPane(next, focus = false) {
    closeAssetPane?.();
    mode = next;
    if (mode !== 'details') metadata?.hide();
    pane.hidden = false;
    title.textContent = titles[mode];
    for (const option of options) option.setAttribute('aria-pressed',String(option.dataset.fileSidePane === mode));
    refresh();
    if (focus) close.focus({preventScroll:true});
  }

  function togglePane(next, focus = false) {
    if (mode !== next) showPane(next,focus);
    else if (focus) closeAndFocus();
    else hide();
  }

  for (const button of options) button.addEventListener('click',() => {
    menu.open = false;
    togglePane(button.dataset.fileSidePane,true);
  });
  close.addEventListener('click',closeAndFocus);
  pane.addEventListener('keydown',event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeAndFocus();
  });
  return {
    hide,refresh,togglePreview:() => togglePane('preview'),showDetails:() => showPane('details',true),
    hasUnsavedChanges:() => metadata?.hasUnsavedChanges() ?? false,
    discardMetadataDrafts:() => metadata?.discardDrafts() ?? true,
    refreshMetadata:() => mode === 'details' ? metadata?.refresh(metadataEntries(),true) : undefined,
  };
}
