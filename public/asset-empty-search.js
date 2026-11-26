export function simplifyAssetQuery(raw) {
  const query = String(raw || '').trim();
  if (!query) return '';
  const file = query.split(/[\\/]/).filter(Boolean).at(-1) || query;
  const withoutFormat = file.replace(/\.[a-z\d]{1,8}$/i,'');
  if (withoutFormat !== query && withoutFormat.trim()) return withoutFormat.trim();
  const words = query.split(/\s+/);
  return words.length > 1 ? words.slice(0,-1).join(' ') : '';
}

export function initAssetEmptySearch(panel,{input,clearOtherFilters,focusSearch}) {
  const keyword = panel.querySelector('[data-empty-query]');
  const simplify = panel.querySelector('[data-simplify-query]');
  const clear = panel.querySelector('[data-clear-other-filters]');
  let suggestion;
  simplify.addEventListener('click',() => {
    if (!suggestion) return;
    input.value = suggestion;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    focusSearch();
  });
  clear.addEventListener('click',() => { clearOtherFilters(); focusSearch(); });
  return {
    render({empty,filtered}) {
      const query = input.value.trim();
      panel.hidden = !empty || (!query && !filtered);
      if (panel.hidden) return;
      keyword.hidden = !query;
      keyword.textContent = query ? `关键词「${query}」` : '';
      suggestion = simplifyAssetQuery(query);
      simplify.hidden = !suggestion;
      simplify.textContent = suggestion ? `试试「${suggestion}」` : '';
      clear.hidden = !filtered;
    },
  };
}
