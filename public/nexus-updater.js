export function initNexusUpdater({api, enabled, panel, indicator}) {
  if (!enabled) return {opened() {}};
  panel.hidden = false;
  const button = panel.querySelector('button');
  const status = panel.querySelector('[role="status"]');
  let update;
  let busy = false;
  let lastCheck = 0;

  function showUpdate() {
    const version = update?.available && update.version;
    indicator.classList.toggle('has-nexus-update',Boolean(version));
    indicator.title = version ? `Nexus ${version} 可更新` : '';
    button.classList.toggle('primary',Boolean(version));
    button.classList.toggle('subtle',!version);
    button.textContent = version ? '下载更新' : '检查更新';
    status.textContent = version ? `GitHub 已发布 ${version}`
      : update?.configured ? '已是最新版本' : 'GitHub 更新源待配置';
  }

  async function check(visibleFeedback = false) {
    if (busy) return;
    busy = button.disabled = true;
    if (visibleFeedback) status.textContent = '正在检查 GitHub 更新…';
    try {
      update = await api('check_nexus_update');
      showUpdate();
    } catch (failure) {
      if (visibleFeedback || !update) status.textContent = String(failure?.message || failure).slice(0,160);
    } finally {
      lastCheck = Date.now();
      busy = button.disabled = false;
    }
  }

  button.addEventListener('click', async () => {
    if (busy) return;
    const version = update?.available && update.version;
    if (!version) { await check(true); return; }
    busy = button.disabled = true;
    status.textContent = `正在下载并验证 ${version}，安装时将重启 Nexus…`;
    try {
      await api('install_nexus_update',{version});
      status.textContent = '已启动安装，请等待 Nexus 重新打开…';
    } catch (failure) {
      update = null;
      showUpdate();
      status.textContent = String(failure?.message || failure).slice(0,160);
      busy = button.disabled = false;
    }
  });

  setTimeout(() => { if (!lastCheck) check(); },3500);
  setInterval(() => { if (!document.hidden) check(); },6 * 60 * 60 * 1000);
  return {opened() { if (Date.now() - lastCheck > 15 * 60 * 1000) check(true); }};
}
