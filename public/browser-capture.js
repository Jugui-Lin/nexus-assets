const dateFormat = new Intl.DateTimeFormat('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
const kinds = {image:'图片', video:'视频', link:'链接'};
const states = {queued:'处理中', saved:'已保存', failed:'失败'};

export function initBrowserCapture({native, api, copyText, workspaces, libraries, active, onImported, log}) {
  if (!native) return;
  const get = id => document.getElementById('browser-capture-' + id);
  const openers = [get('open'), get('settings')];
  const dialog = get('dialog');
  const extension = get('extension');
  const detect = get('detect');
  const installer = get('install');
  const browserList = get('browsers');
  const extensionPath = get('extension-path');
  const inbox = get('inbox');
  const importButton = get('import');
  const generate = get('pair');
  const copy = get('copy');
  const connection = get('connection');
  const codeRow = get('code-row');
  const code = get('code');
  const expiry = get('expiry');
  const feedback = get('feedback');
  const empty = get('empty');
  const recent = get('recent');
  let pairCode;
  let expiresAt = 0;
  let interval;
  let reading = false;
  let pairing = false;
  let generation = 0;
  let pairingRequest = 0;
  let captureSnapshot;
  let media = [];
  let importing = false;
  let recheckInstall = false;
  const observed = new Map();
  const destination = initBrowserCaptureDestination({get, workspaces, libraries, active, changed:updateImport});

  function updateImport() {
    importButton.disabled = importing || !media.length || !destination.target();
  }

  function message(text = '', failed = false) {
    feedback.textContent = text;
    feedback.dataset.error = String(failed);
  }

  function showError(error, fallback) {
    const detail = typeof error === 'string' ? error : error?.message;
    message(detail?.slice(0, 150) || fallback, true);
  }

  function renderPairing() {
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    if (pairCode && !seconds) {
      pairCode = undefined;
      message('配对码已过期，可以重新生成。');
    }
    codeRow.hidden = !pairCode;
    code.textContent = pairCode || '';
    expiry.textContent = pairCode ? `剩余 ${seconds} 秒` : '';
  }

  function renderRecent(items) {
    const serialized = JSON.stringify(items);
    if (serialized === captureSnapshot) return;
    captureSnapshot = serialized;
    media = items.filter(item => item.state === 'saved' && typeof item.file === 'string').map(item => item.id);
    updateImport();
    for (const item of items.slice().reverse()) {
      if (item.state !== observed.get(item.id) && ['saved', 'failed'].includes(item.state)) {
        const kind = kinds[item.kind] || '网页';
        log(`网页采集 · ${kind} · ${item.message || states[item.state]}`, item.state === 'failed' ? 'error' : 'info');
      }
    }
    observed.clear();
    for (const item of items) observed.set(item.id, item.state);
    empty.hidden = Boolean(items.length);
    empty.textContent = '当前会话暂无采集记录。';
    recent.replaceChildren(...items.map(item => {
      const row = document.createElement('li');
      const info = document.createElement('div');
      const title = document.createElement('strong');
      const detail = document.createElement('small');
      const state = document.createElement('span');
      const when = new Date(item.created * 1000);
      const kind = kinds[item.kind] || '网页';
      row.dataset.state = item.state;
      title.textContent = item.title || kind;
      title.title = title.textContent;
      detail.textContent = [kind, Number.isFinite(+when) ? dateFormat.format(when) : '', item.message].filter(Boolean).join(' · ');
      detail.title = detail.textContent;
      info.append(title, detail);
      state.className = 'browser-capture-state';
      state.textContent = states[item.state];
      row.append(info, state);
      return row;
    }));
  }

  async function refresh() {
    renderPairing();
    if (reading || !dialog.open || document.hidden) return;
    const current = generation;
    const priorPairing = pairingRequest;
    reading = true;
    try {
      const status = await api('browser_capture_status');
      if (current !== generation || !dialog.open) return;
      connection.textContent = status?.paired ? '已配对' : '未配对';
      connection.dataset.paired = String(status?.paired === true);
      if (pairCode && !pairing && priorPairing === pairingRequest && status?.pairingPending === false) {
        pairCode = undefined;
        message('');
        renderPairing();
      }
      renderRecent(Array.isArray(status?.captures) ? status.captures : []);
    } catch {
      if (current !== generation || !dialog.open) return;
      connection.textContent = '暂时无法读取状态';
      connection.dataset.paired = 'false';
      if (captureSnapshot === undefined) empty.textContent = '暂时无法读取采集记录。';
    } finally {
      reading = false;
    }
  }

  async function openFolder(button, command, fallback) {
    button.disabled = true;
    message('');
    try { await api(command); }
    catch (error) { if (dialog.open) showError(error, fallback); }
    finally { button.disabled = false; }
  }

  async function openInstall(browser, button) {
    button.disabled = true;
    message('');
    try {
      const {extensionPath: path} = await api('browser_extension_open_install', {browser});
      recheckInstall = true;
      if (!dialog.open) return;
      extensionPath.textContent = path || extensionPath.textContent;
      const copied = path && await copyText(path).then(() => true, () => false);
      message(copied
        ? '已复制扩展目录。请在浏览器点击「加载已解压的扩展程序」并确认。'
        : '已打开扩展管理页，请在浏览器加载下方的扩展目录。');
    } catch (error) {
      if (dialog.open) showError(error, '无法打开浏览器的扩展管理页。');
    } finally {
      button.disabled = false;
    }
  }

  function browserRow(browser, hasPackage) {
    const row = document.createElement('li');
    const text = document.createElement('div');
    const name = document.createElement('strong');
    const detail = document.createElement('small');
    name.textContent = browser.name;
    const status = !browser.available ? ['未检测到浏览器']
      : browser.installedProfiles ? [`已检测到 ${browser.installedProfiles} 个配置中的扩展`]
      : ['未检测到 Nexus 扩展'];
    if (browser.disabledProfiles) status.push(`${browser.disabledProfiles} 个已停用`);
    if (browser.updateProfiles) status.push(`${browser.updateProfiles} 个待重新加载`);
    if (browser.profileReadIncomplete) status.push('部分配置无法读取');
    detail.textContent = status.join(' · ');
    text.append(name, detail);
    row.append(text);
    if (browser.available) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button subtle';
      button.textContent = browser.installedProfiles ? '管理扩展' : '打开加载页';
      button.disabled = !hasPackage;
      button.addEventListener('click', () => openInstall(browser.id, button));
      row.append(button);
    }
    return row;
  }

  async function detectBrowsers(launch) {
    if (detect.disabled) return;
    const current = generation;
    detect.disabled = true;
    if (launch) message('正在检测浏览器和扩展…');
    try {
      const result = await api('browser_extension_detect');
      if (generation !== current || !dialog.open) return;
      if (!result?.supported) {
        message('当前系统可以通过「打开扩展目录」手动加载。');
        return;
      }
      const browsers = Array.isArray(result.browsers) ? result.browsers : [];
      extensionPath.textContent = result.extensionPath || '';
      browserList.replaceChildren(...browsers.map(browser => browserRow(browser, Boolean(result.extensionPath))));
      installer.hidden = false;
      const installed = browsers.filter(browser => browser.available);
      if (launch) {
        message(!result.extensionPath ? '当前安装包缺少扩展文件。' : installed.length ? '请选择浏览器。' : '未检测到 Chrome 或 Edge。', !result.extensionPath || !installed.length);
        if (result.extensionPath && installed.length === 1 && !installed[0].installedProfiles) {
          await openInstall(installed[0].id, detect);
        } else if (installed.length === 1 && installed[0].installedProfiles) {
          message('已检测到 Nexus 扩展。可在浏览器工具栏打开扩展并配对。');
        }
      } else if (installed.some(browser => browser.installedProfiles > browser.disabledProfiles)) {
        message('已检测到 Nexus 扩展已加载。请在浏览器工具栏打开扩展并配对。');
      }
    } catch (error) {
      if (dialog.open && launch) showError(error, '无法检测已安装的浏览器。');
    } finally {
      detect.disabled = false;
    }
  }

  for (const opener of openers) {
    opener.hidden = false;
    opener.addEventListener('click', () => {
      if (dialog.open) return;
      message('');
      dialog.showModal();
      destination.refresh();
      refresh();
      clearInterval(interval);
      interval = setInterval(refresh, 1500);
    });
  }
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    generation++;
    destination.stop();
    clearInterval(interval);
  });
  detect.addEventListener('click', () => detectBrowsers(true));
  window.addEventListener('focus', () => {
    if (dialog.open && recheckInstall) {
      recheckInstall = false;
      detectBrowsers(false);
    }
  });
  extension.addEventListener('click', () => openFolder(extension, 'browser_capture_open_extension', '无法打开扩展目录。'));
  inbox.addEventListener('click', () => openFolder(inbox, 'browser_capture_open_inbox', '无法打开采集箱。'));
  importButton.addEventListener('click', async () => {
    const target = destination.target();
    if (!media.length || !target || importing) return;
    const current = generation;
    destination.remember();
    importing = true;
    destination.setBusy(true);
    message('正在导入到所选位置…');
    try {
      const result = await api('browser_capture_import', {ids:media, target});
      const report = [`已导入 ${result.found ?? result.copied ?? 0} 项`];
      if (result.conflicts) report.push(`${result.conflicts} 项同名冲突`);
      if (result.duplicates) report.push(`跳过 ${result.duplicates} 个重复文件`);
      if (result.skipped) report.push(`跳过 ${result.skipped} 项`);
      if (result.failed) report.push(`${result.failed} 项失败`);
      if (result.indexPending) report.push('等待索引同步');
      if (result.errors?.length) report.push(result.errors[0]);
      if (dialog.open && current === generation) message(report.join(' · '), Boolean(result.failed || result.conflicts || result.errors?.length));
      await onImported(target, result);
    } catch (error) {
      if (dialog.open && current === generation) showError(error, '无法导入到所选位置。');
    } finally {
      importing = false;
      destination.setBusy(false);
    }
  });
  generate.addEventListener('click', async () => {
    generate.disabled = true;
    pairing = true;
    pairingRequest++;
    message('');
    try {
      const result = await api('browser_capture_pairing');
      if (typeof result?.code !== 'string' || !/^\d{8}$/.test(result.code) || !Number.isFinite(result?.expiresInSeconds) || result.expiresInSeconds <= 0) {
        throw Error('暂时无法生成配对码。');
      }
      pairCode = result.code;
      expiresAt = Date.now() + result.expiresInSeconds * 1000;
      renderPairing();
    } catch (error) {
      if (dialog.open) showError(error, '暂时无法生成配对码。');
    } finally {
      pairing = false;
      generate.disabled = false;
    }
  });
  copy.addEventListener('click', async () => {
    renderPairing();
    if (!pairCode) return;
    try {
      await copyText(pairCode);
      if (dialog.open) message('已复制配对码。');
    } catch { if (dialog.open) message('无法写入剪贴板，可手动选择配对码。', true); }
  });
}
import {initBrowserCaptureDestination} from './browser-capture-destination.js';

