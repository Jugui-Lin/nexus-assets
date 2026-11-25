(() => {
  const key = 'nexus-appearance';
  const themes = new Set(['dotin-light', 'dotin-dark']);
  const root = document.documentElement;
  let theme = 'default';
  try {
    const saved = localStorage.getItem(key);
    if (themes.has(saved)) theme = saved;
  } catch {}

  function apply(value) {
    if (themes.has(value)) root.dataset.theme = value;
    else delete root.dataset.theme;
  }

  function updateWindow() {
    const current = window.__TAURI__?.window?.getCurrentWindow?.();
    current?.setTheme?.(theme === 'dotin-light' ? 'light' : 'dark').catch(() => {});
  }

  apply(theme);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('appearance-theme');
    select.value = theme;
    if (theme !== 'default') updateWindow();
    select.addEventListener('change', () => {
      theme = themes.has(select.value) ? select.value : 'default';
      apply(theme);
      updateWindow();
      try { localStorage.setItem(key, theme); } catch {}
      document.dispatchEvent(new CustomEvent('nexus-appearance-change', {detail:select.selectedOptions[0].text}));
    });
  });
})();
