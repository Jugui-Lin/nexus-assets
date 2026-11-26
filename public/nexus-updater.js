const minute = 60_000;
const idlePeriod = 5 * minute;
const checkPeriod = 60 * minute;
const retryPeriod = 5 * minute;

export function initNexusUpdater({api, enabled, panel, indicators, canRestart, rememberReleaseNotes}) {
  if (!enabled) return {opened() {},checkNow() {}};
  panel.hidden = false;
  const button = panel.querySelector('button');
  const installNow = panel.querySelector('#nexus-install-now');
  const status = panel.querySelector('[role="status"]');
  const indicatorTitles = indicators.map(indicator => indicator.title);
  let update;
  let preparedVersion;
  let busy = false;
  let restarting = false;
  let lastInput = performance.now();
  let lastCheck = -Infinity;
  let nextCheck = 0;
  let retryAt = 0;

  function recordInput() { lastInput = performance.now(); }
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'input', 'visibilitychange']) {
    document.addEventListener(type, recordInput, {capture:true, passive:true});
  }
  window.addEventListener('focus', recordInput);

  function availableVersion() {
    return update?.available ? update.version : undefined;
  }

  function readyToInstall(version) {
    return Boolean(update?.automatic && version && preparedVersion === version);
  }

  function render(message) {
    const version = availableVersion();
    const notice = version ? `Nexus ${version} 可更新` : '';
    indicators.forEach((indicator, index) => {
      indicator.classList.toggle('has-nexus-update', Boolean(version));
      indicator.title = notice || indicatorTitles[index];
      if (notice) indicator.setAttribute('aria-description', notice);
      else indicator.removeAttribute('aria-description');
    });
    const manual = Boolean(version && !update.automatic);
    button.classList.toggle('primary', manual);
    button.classList.toggle('subtle', !manual);
    button.textContent = manual ? '下载更新' : '检查更新';
    installNow.hidden = !readyToInstall(version);
    if (message) status.textContent = message;
    else if (!version) status.textContent = update?.configured ? '已是最新版本' : 'GitHub 更新源待配置';
    else if (preparedVersion === version) status.textContent = `${version} 已就绪，空闲时或下次启动时自动安装`;
    else status.textContent = update.automatic ? `发现新版 ${version}，将自动下载` : `GitHub 已发布 ${version}`;
  }

  async function run(action) {
    if (busy || restarting) return;
    busy = button.disabled = installNow.disabled = true;
    try {
      await action();
    } finally {
      busy = false;
      button.disabled = installNow.disabled = restarting;
    }
  }

  function check(visibleFeedback = false) {
    return run(async () => {
      if (visibleFeedback) status.textContent = '正在检查 GitHub 更新…';
      try {
        const previousVersion = availableVersion();
        update = await api('check_nexus_update');
        if (update?.available) rememberReleaseNotes?.(update.version,update.notes);
        if (availableVersion() !== previousVersion) {
          preparedVersion = undefined;
          retryAt = 0;
        }
        nextCheck = performance.now() + checkPeriod;
        render();
      } catch (failure) {
        nextCheck = performance.now() + retryPeriod;
        if (visibleFeedback || !update) status.textContent = String(failure?.message || failure).slice(0,160);
      } finally {
        lastCheck = performance.now();
      }
    });
  }

  function retry(failure) {
    retryAt = performance.now() + retryPeriod;
    nextCheck = Math.min(nextCheck, retryAt);
    render(String(failure?.message || failure).slice(0, 120) + ' · 稍后重试');
  }

  function prepare(version) {
    return run(async () => {
      render(`正在后台下载并验证 ${version}…`);
      try {
        await api('prepare_nexus_update', {version});
        preparedVersion = version;
        render();
      } catch (failure) {
        retry(failure);
      }
    });
  }

  function install(version, automatic, now = false) {
    return run(async () => {
      render(`正在安装 ${version}，安装后将重新打开 Nexus…`);
      try {
        if (automatic) {
          const args = now ? {version, installNow:true} : {version};
          restarting = await api('apply_prepared_nexus_update', args);
        } else {
          await api('install_nexus_update', {version});
          restarting = true;
        }
        if (restarting) render('已启动安装，请等待 Nexus 重新打开…');
        else render(now ? '当前有任务正在进行，完成后可立即安装' : undefined);
      } catch (failure) {
        preparedVersion = undefined;
        if (automatic) retry(failure);
        else {
          update = undefined;
          render(String(failure?.message || failure).slice(0, 160));
        }
      }
    });
  }

  function tick() {
    if (busy || restarting) return;
    const now = performance.now();
    if (now >= nextCheck) return check();
    const version = availableVersion();
    if (!version || !update.automatic || now < retryAt) return;
    if (version !== preparedVersion) return prepare(version);
    if (now - lastInput >= idlePeriod && canRestart()) return install(version, true);
  }

  button.addEventListener('click', () => {
    const version = availableVersion();
    if (version && !update.automatic) return install(version, false);
    return check(true);
  });
  installNow.addEventListener('click', () => {
    const version = availableVersion();
    if (busy || restarting || !readyToInstall(version)) return;
    if (!canRestart()) {
      render('请先保存修改或完成当前操作，再立即安装');
      return;
    }
    return install(version, true, true);
  });
  setTimeout(tick, 3500);
  setInterval(tick, 15_000);
  return {
    opened() { if (performance.now() - lastCheck > 15 * minute) check(true); },
    checkNow: () => check(true),
  };
}
