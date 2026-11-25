const operationLabels = {
  team_catalog: '同步团队库', team_refresh_library: '刷新团队文件夹',
  team_link_folders: '链接团队文件夹', team_import_paths: '导入团队素材', team_ingest_drop: '拖入团队素材',
  ingest_drop: '导入个人素材', import_files: '导入素材文件',
  scan_library: '扫描文件夹', rescan_library: '重新扫描文件夹',
  scan_workspace_folder: '重新扫描当前文件夹', team_rescan_folder: '重新扫描当前团队文件夹',
  list_recycled_assets: '查看回收站', team_list_recycled_assets: '查看团队回收站',
  recycle_assets: '移到回收站', team_recycle_assets: '移到团队回收站',
  restore_recycled_assets: '从回收站恢复', team_restore_recycled_assets: '从团队回收站恢复',
  delete_workspace_assets: '永久删除源文件', team_delete_workspace_assets: '永久删除团队源文件',
  team_create_folder: '新建团队文件夹', create_library_folder: '新建文件夹',
  team_move_folder: '移动团队文件夹', move_library_folder: '移动文件夹',
  team_unlink_folder: '取消链接团队文件夹', delete_workspace_folder: '删除文件夹',
  scan_selected_libraries: '扫描所选文件夹',
  open_folder_location: '在资源管理器中打开文件夹', reveal_asset: '在资源管理器中显示资产',
  copy_workspace_files: '复制团队资产文件', copy_asset_files: '复制资产文件',
  check_workspace_files: '检查团队资产文件', check_asset_files: '检查资产文件',
  relink_asset_file: '重新关联资产文件',
  list_asset_versions: '读取文件版本', create_asset_version: '创建文件版本', export_asset_version: '导出文件版本',
  start_cover_capture: '启动截图工具', set_clipboard_cover: '设置截图封面', open_asset_video: '在系统播放器中打开视频',
  queue_import: '提交到创作工具', place_asset: '发送到创作工具', start_asset_drag: '拖放资产到桌面应用',
  install_bridge: '安装创作工具插件', export_bridge: '导出创作工具插件',
  bridge_install_status: '检测创作软件和插件', choose_bridge_executable: '选择创作软件程序',
  get_c4d_import_preferences: '读取 Cinema 4D 导入设置',
  set_c4d_import_preferences: '保存 Cinema 4D 导入设置',
  pick_c4d_converter: '选择 Cinema 4D 转换程序', clear_c4d_import_cache: '清理 Cinema 4D 导入缓存',
  create_local_tag: '新建标签', rename_local_tag: '重命名标签', delete_local_tag: '删除标签',
  team_create_tag: '新建团队标签', team_rename_tag: '重命名团队标签', team_delete_tag: '删除团队标签',
  create_collection: '新建合集', rename_collection: '重命名合集', delete_collection: '删除合集',
  change_personal_workspace: '切换个人工作空间', team_save_profile: '保存团队个人资料',
  team_rename_workspace: '重命名团队工作空间',
  team_set_quick_access: '更新团队快速访问',
  create_hosted_team: '创建团队', start_hosted_team: '启动本机团队服务',
  team_connect: '连接团队', team_join_by_address: '加入团队', team_reconnect_nas: '重新连接团队 NAS',
  team_disconnect: '断开团队连接', export_team_for_nas: '导出 NAS 团队配置',
  team_set_mount: '更新团队盘符映射', team_publish: '发布团队资产库',
  team_send_asset_message: '发送团队素材消息', team_send_poke: '拍一拍团队成员', team_dismiss_asset_message: '移除团队消息',
  cloud_mount_connect: '挂载网盘', cloud_mount_disconnect: '断开网盘挂载', cloud_mount_forget: '移除网盘挂载记录',
  cloud_mount_remotes: '读取可挂载网盘',
  subscription_profile: '识别创作者公开资料', subscription_discover: '查找公开作品来源',
  subscription_feed: '同步创作订阅', subscription_open: '在系统浏览器中打开网页',
  team_create_creative_subscription: '添加团队创作订阅',
  team_update_creative_subscription: '更新团队创作订阅',
  team_delete_creative_subscription: '移除团队创作订阅',
  browser_site_metadata: '识别站点资料', browser_capture_pairing: '生成网页采集配对信息',
  browser_extension_open_install: '打开浏览器扩展安装页', browser_capture_import: '导入网页采集',
  team_whiteboard_create_project: '创建团队白板项目',
  team_whiteboard_rename_project: '重命名团队白板项目',
  team_whiteboard_delete_project: '删除团队白板项目',
  baidu_open_authorization: '打开百度授权网页',
};

const dccLabels = {
  c4d: 'Cinema 4D', blender: 'Blender', max: '3ds Max', maya: 'Maya', houdini: 'Houdini',
};

const baiduLabels = {
  status: '读取百度网盘连接', links: '读取百度网盘链接',
  start: '启动百度网盘授权', poll: '百度网盘授权', cancel: '取消百度网盘授权',
  browse: '浏览百度网盘文件夹', list: '读取百度网盘目录', add: '添加百度网盘文件夹',
  remove: '取消链接百度网盘文件夹', download: '下载百度网盘文件',
};

const longerOperations = new Set([
  'team_link_folders', 'team_import_paths', 'team_refresh_library', 'team_connect', 'team_join_by_address',
  'team_reconnect_nas', 'ingest_drop', 'team_ingest_drop', 'scan_library', 'rescan_library', 'scan_selected_libraries',
  'scan_workspace_folder', 'team_rescan_folder',
  'move_library_folder', 'team_move_folder',
  'recycle_assets', 'team_recycle_assets', 'restore_recycled_assets', 'team_restore_recycled_assets',
  'delete_workspace_assets', 'team_delete_workspace_assets', 'clear_c4d_import_cache',
  'bridge_install_status',
  'cloud_mount_connect', 'subscription_profile', 'subscription_discover', 'subscription_feed', 'install_bridge',
]);

const scopedScans = new Set(['scan_workspace_folder', 'team_rescan_folder']);
const optionalResults = new Set([
  'change_asset_cover', 'copy_asset_files', 'copy_workspace_files', 'relink_asset_file', 'export_asset_version',
]);

const pickerOperations = new Set(['choose_bridge_executable', 'pick_c4d_converter']);

function logText(value) {
  return String(value?.message || value || '未知错误')
    .replace(/\b(?:https?|smb|sftp|ftp|davs?|file):\/\/[^\s<>"']+/gi, '[网址已隐藏]')
    .replace(/\b(Bearer|Basic)\s+[a-z\d+/_=.~-]+/gi, '$1 [已隐藏]')
    .replace(/(["']?(?:\b(?:token|[\w-]+[_-]token|(?:access|refresh)token|(?:user|device|auth(?:orization)?|pair(?:ing)?)[_-]?code|api[_-]?key|password|passphrase|passwd|secret)|授权密钥|访问密钥|授权码|配对码)["']?\s*[:=：]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;}]+)/gi, '$1[已隐藏]')
    .replace(/(?:\b[a-z]:[\\/]|\\\\)[^\r\n]*/gi, '[路径已隐藏]')
    .replace(/(^|[\s("'=：])\/(?!\/)\S[^\r\n]*/g, '$1[路径已隐藏]')
    .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, '[地址已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 340);
}

function operationError(error, args) {
  let message = String(error?.message || error || '未知错误');
  for (const record of [args, args.input, args.action, args.credentials]) {
    for (const [key, value] of Object.entries(record || {})) {
      if (/(token|password|passwd|passphrase|secret|authorization|code|api[_-]?key)/i.test(key)
        && typeof value === 'string' && value.length > 3) {
        message = message.replaceAll(value, '[已隐藏]');
      }
    }
  }
  return logText(message);
}

function labelFor(command, args) {
  switch (command) {
    case 'queue_import': return args.projectExport ? '提交 Cinema 4D 工程转换' : operationLabels[command];
    case 'choose_bridge_executable': return dccLabels[args.dcc] ? '选择 ' + dccLabels[args.dcc] + ' 程序' : operationLabels[command];
    case 'pick_c4d_converter': return dccLabels[args.kind] ? '选择 ' + dccLabels[args.kind] + ' 转换程序' : operationLabels[command];
    case 'move_library_folder': return args.newName ? '重命名文件夹' : operationLabels[command];
    case 'team_move_folder': return args.newName ? '重命名团队文件夹' : operationLabels[command];
    case 'baidu_cloud': return baiduLabels[args.action?.kind];
    case 'read_preview': return ['large', 'mesh'].includes(args.mode) ? '打开快速预览' : null;
    case 'patch_asset':
    case 'team_edit':
      return typeof args.patch?.favorite === 'boolean' ? favoriteLabel(args.patch.favorite) : '保存资产资料';
    case 'team_favorite': return favoriteLabel(args.favorite);
    case 'set_collection_membership': return args.include === false ? '从合集移除资产' : '将资产加入合集';
    case 'change_asset_cover': return args.clear ? '恢复自动封面' : '设置资产封面';
    case 'set_library_folder_hidden':
    case 'team_set_folder_visibility': return args.hidden ? '隐藏文件夹' : '显示文件夹';
    case 'team_set_quick_access': return args.pinned ? '固定到团队快速访问' : '取消团队快速访问固定';
    case 'change_personal_workspace':
      if (args.action === 'create') return '创建个人工作空间';
      if (args.action === 'open') return '打开个人工作空间';
      if (args.action === 'rename') return '重命名个人工作空间';
      if (args.action === 'migrate') return '迁移个人工作空间';
      return operationLabels[command];
    default: return operationLabels[command];
  }
}

function favoriteLabel(favorite) {
  return favorite ? '收藏资产' : '取消收藏资产';
}

function operationScope(command, args) {
  if (!scopedScans.has(command)) return '';
  return args.folder ? ' · 所选文件夹' : ' · 所选根目录';
}

function countOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function listLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function initRuntimeLog({copy}) {
  const button = document.querySelector('#open-runtime-log');
  const dialog = document.querySelector('#runtime-log-dialog');
  const view = document.querySelector('#runtime-log-entries');
  const entries = [];
  const pendingMounts = new Set();
  let authorizationPhase = null;
  const stamp = new Intl.DateTimeFormat('zh-CN', {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});

  function rowText(entry) {
    return `${entry.time}  ${entry.message}${entry.count > 1 ? `（${entry.count} 次）` : ''}`;
  }

  function render(follow = false) {
    if (!dialog.open) return;
    const bottom = follow || view.scrollHeight - view.scrollTop - view.clientHeight < 24;
    view.replaceChildren(...entries.map(entry => {
      const row = document.createElement('div');
      row.textContent = rowText(entry);
      if (entry.level === 'error') row.className = 'runtime-log-error';
      return row;
    }));
    if (bottom) view.scrollTop = view.scrollHeight;
  }

  function add(message, level = 'info') {
    const entry = {time:stamp.format(new Date()), message:logText(message), level, count:1};
    const previous = entries.at(-1);
    if (previous?.message === entry.message && previous.level === level) {
      previous.time = entry.time;
      previous.count++;
    } else {
      entries.push(entry);
      if (entries.length > 480) entries.shift();
    }
    render();
  }

  function start(command, args = {}) {
    if (command === 'baidu_cloud' && args.action?.kind === 'start') {
      authorizationPhase = null;
      add('开始百度网盘授权');
      return;
    }
    if (!longerOperations.has(command)) return;
    const paths = args.paths;
    const count = Array.isArray(paths) && paths.length ? ` · ${paths.length} 个来源` : '';
    add(`开始${labelFor(command, args)}${operationScope(command, args)}${count}`);
  }

  function jobResult(job) {
    const host = Object.hasOwn(dccLabels, job.dcc) ? dccLabels[job.dcc] : 'DCC';
    const label = job.projectExport ? 'Cinema 4D 工程转换' : host + ' 导入';
    if (job.status === 'done') {
      const counts = typeof job.message === 'string' && /^已导入 (\d{1,8}) 个对象、(\d{1,8}) 个材质/.exec(job.message);
      add(label + '完成' + (counts ? ` · ${counts[1]} 个对象、${counts[2]} 个材质` : ''));
    } else if (job.status === 'failed' || job.status === 'interrupted') {
      const summary = job.status === 'failed' ? '失败' : '中断';
      add(label + summary + (job.error ? ' · ' + logText(job.error) : ''), 'error');
    }
  }

  function recordBridgeDetection(label, result) {
    const supported = Array.isArray(result) ? result.filter(host => host?.supported && Array.isArray(host.targets)) : [];
    const targets = supported.flatMap(host => host.targets);
    const counts = [
      ['installed','已安装'], ['update','可更新'], ['ready','待安装'],
      ['initialize','待首次启动'], ['conflict','文件冲突'],
    ].flatMap(([status, title]) => {
      const count = targets.filter(target => target?.status === status).length;
      return count ? [`${title} ${count} 个版本`] : [];
    });
    add(label + '完成 · ' + (counts.length ? counts.join(' · ') : '未检测到支持的版本'),
      targets.some(target => target?.status === 'conflict') ? 'error' : 'info');
  }

  function recordBaidu(action, label, result) {
    if (action === 'start' || action === 'poll') {
      const next = result?.connected ? 'connected' : !result?.pending ? 'ended'
        : result.verificationUrl || authorizationPhase === 'ready' ? 'ready' : 'waiting';
      if (authorizationPhase === next) return;
      authorizationPhase = next;
      if (next === 'connected') add('百度网盘授权完成');
      else if (next === 'ready') add('百度授权网页已准备 · 等待用户确认');
      else if (next === 'waiting') add('已启动百度网盘授权 · 正在准备授权网页');
      else add('百度网盘授权未完成', 'error');
      return;
    }
    if (action === 'status') {
      if (result?.available === false) {
        add(result.upgradeRequired ? '百度网盘暂不可用 · 请先更新团队 NAS 服务' : '百度网盘在当前环境不可用', 'error');
      }
      return;
    }
    if (action === 'links' || action === 'download' && !result?.saved) return;
    if (action === 'cancel') authorizationPhase = null;
    const count = Array.isArray(result?.entries) ? ` · ${result.entries.length} 项` : '';
    add(`${label}完成${count}`);
  }

  function recordMount(result) {
    const drive = /^[d-z]:$/i.test(result?.drive) ? ` · ${result.drive}` : '';
    if (result?.status === 'starting') {
      if (result.id) pendingMounts.add(result.id);
      add(`已启动网盘挂载${drive} · 等待盘符就绪`);
    } else if (result?.status === 'connected') {
      add(`网盘挂载完成${drive}`);
    } else {
      add(`网盘挂载未就绪${drive}`, 'error');
    }
  }

  function operation(command, args = {}, result, error = null) {
    if (command === 'cloud_mount_list') {
      for (const mount of result?.mounts ?? []) {
        if (mount.status !== 'starting' && pendingMounts.delete(mount.id)) recordMount(mount);
      }
      return;
    }
    const label = labelFor(command, args);
    if (!label || (command === 'team_catalog' && args.since != null)) return;
    const scope = operationScope(command, args);
    if (error !== null) {
      add(`${label}失败${scope} · ${operationError(error, args)}`, 'error');
      return;
    }
    if (command === 'baidu_cloud') {
      recordBaidu(args.action.kind, label, result);
      return;
    }
    if (optionalResults.has(command) && result == null) return;
    if (pickerOperations.has(command) && result == null) {
      add(`已取消${label}`);
      return;
    }
    switch (command) {
      case 'start_asset_drag':
        if (result?.c4dImport) add('Cinema 4D 拖放 · 准备转换并导入');
        else if (result?.bridgeRequired) add('拖放需要连接 DCC 插件');
        else if (result?.effect === 'copy') add(`${label}完成`);
        return;
      case 'queue_import': {
        const host = Object.hasOwn(dccLabels, result?.dcc) ? ' · ' + dccLabels[result.dcc] : '';
        add(`${label} · 已进入队列${host}`);
        return;
      }
      case 'bridge_install_status':
        recordBridgeDetection(label, result);
        return;
      case 'install_bridge': {
        const installed = listLength(result?.completed);
        const failed = listLength(result?.errors);
        const detail = failed ? ' · ' + operationError(result.errors[0], args) : '';
        add(`${label} · 已安装 ${installed} 个版本${failed ? ' · 失败 ' + failed + ' 项' : ''}${detail}`,
          failed ? 'error' : 'info');
        return;
      }
      case 'clear_c4d_import_cache': {
        const removed = countOf(result?.removed);
        const skipped = countOf(result?.skipped);
        add(`${label}完成 · 已清理 ${removed} 项${skipped ? ' · 跳过 ' + skipped + ' 项' : ''}`);
        return;
      }
      case 'browser_site_metadata': {
        const details = [result?.name ? '已识别名称' : '', result?.iconData ? '已识别图标' : ''].filter(Boolean);
        add(`${label} · ${details.length ? details.join(' · ') : '未读取到名称或图标'}`);
        return;
      }
      case 'cloud_mount_remotes':
        add(`${label}完成 · ${listLength(result?.names)} 项`);
        return;
      case 'subscription_profile': {
        const profile = result?.name ? `已识别「${logText(result.name).slice(0, 64)}」` : '未识别创作者名称';
        const feed = result?.feed ? ' · 已找到公开订阅源'
          : result?.sourceStatus === 'no-public-feed' ? ' · 未公开 RSS / Atom' : '';
        add(`${label}完成${scope} · ${profile}${feed}`);
        return;
      }
      case 'subscription_discover':
        if (result?.sourceStatus === 'public-works') {
          add(`已读取公开投稿${scope} · ${result.items?.length ?? 0} 项作品`);
        } else if (result?.sourceStatus === 'public-works-unavailable') {
          add(`暂时无法读取公开投稿${scope}`, 'error');
        } else {
          add(`${label}${scope} · ${result?.feedUrl ? '已找到 RSS / Atom' : '未找到公开 RSS / Atom'}`);
        }
        return;
      case 'subscription_feed': {
        const title = result?.title ? ` · ${logText(result.title).slice(0, 64)}` : '';
        add(`${label}完成${scope}${title} · ${result?.items?.length ?? 0} 项作品`);
        return;
      }
      case 'cloud_mount_connect':
        recordMount(result);
        return;
      case 'cloud_mount_disconnect':
      case 'cloud_mount_forget':
        pendingMounts.delete(args.id);
        break;
      case 'read_preview':
        if (result?.url || result?.text || result?.base64) add(`${label}完成`);
        return;
      case 'team_catalog':
        if (Array.isArray(result?.assets)) add(`${label}完成 · ${result.assets.length} 项资产`);
        return;
      case 'team_send_asset_message':
      case 'set_collection_membership':
        add(`${label}完成 · ${args.assetIds?.length ?? 0} 项资产`);
        return;
      case 'list_recycled_assets':
      case 'team_list_recycled_assets':
        add(`${label} · ${result?.length ?? 0} 项资产`);
        return;
      case 'recycle_assets':
      case 'team_recycle_assets':
      case 'restore_recycled_assets':
      case 'team_restore_recycled_assets':
        add(`${label}完成 · ${result?.changed ?? 0} 项资产`);
        return;
      case 'delete_workspace_assets':
      case 'team_delete_workspace_assets': {
        const deleted = countOf(result?.deleted);
        const missing = countOf(result?.missing);
        const failed = countOf(result?.failed);
        const details = [`已删除 ${deleted} 项`];
        if (missing) details.push(`源文件已不存在 ${missing} 项`);
        if (failed) details.push(`失败 ${failed} 项`);
        if (result?.indexPending) details.push('等待资产索引同步');
        add(`${label} · ${details.join(' · ')}`, failed ? 'error' : 'info');
        return;
      }
      case 'check_workspace_files':
      case 'check_asset_files':
        return; // The caller logs the totals after all batches finish.
      case 'import_files':
        if (!result?.found && !result?.duplicates && !result?.failed) return;
        break;
      case 'list_asset_versions':
        add(`${label}完成 · ${result?.length ?? 0} 个版本`);
        return;
    }
    const counts = [
      ['linked','已链接'], ['copied','已复制'], ['found','已索引'], ['indexed','已索引'], ['existing','已存在'],
      ['directoriesCreated','新增目录'], ['duplicates','重复'], ['skipped','跳过'], ['conflicts','同名冲突'], ['failed','失败'],
    ].flatMap(([key, title]) => {
      const total = countOf(result?.[key]);
      const teamImport = command === 'team_import_paths' || command === 'team_ingest_drop';
      const count = key === 'skipped' && teamImport ? total - countOf(result?.duplicates) : total;
      return count > 0 ? [`${title} ${count} 项`] : [];
    });
    if (result?.indexPending) counts.push('等待 NAS 索引');
    const detail = result?.errors?.[0] || result?.indexError || result?.indexErrors?.[0];
    if (detail) counts.push(operationError(detail, args));
    const outcome = counts.length ? ` · ${counts.join(' · ')}` : '完成';
    add(`${label}${outcome}${scope}`, result?.failed || result?.conflicts || detail ? 'error' : 'info');
  }

  button.addEventListener('click', () => {
    document.querySelector('#runtime-log-status').textContent = '';
    if (!dialog.open) dialog.showModal();
    render(true);
    view.focus();
  });
  document.querySelector('#copy-runtime-log').addEventListener('click', async () => {
    const status = document.querySelector('#runtime-log-status');
    try {
      await copy(entries.map(rowText).join('\n'));
      status.textContent = '已复制';
    } catch (error) { status.textContent = logText(error); }
  });
  add('Nexus 工作台已启动');
  return {add, start, operation, jobResult};
}
