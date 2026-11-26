import {stackPreferenceFields, stackPreferences} from './whiteboard-arrange.js';

const storageKey = 'nexus-whiteboard-stack-preferences';
export const stackSettingsLabel = '堆叠偏好';

function readStackSettings() {
  try { return stackPreferences(JSON.parse(localStorage.getItem(storageKey))); }
  catch { return stackPreferences(); }
}

export function initWhiteboardStackSettings(notify) {
  let settings = readStackSettings();
  const dialog = document.createElement('dialog');
  dialog.id = 'whiteboard-stack-settings';
  dialog.className = 'modal whiteboard-stack-settings';
  dialog.setAttribute('aria-labelledby','whiteboard-stack-settings-title');
  dialog.innerHTML = `<form>
    <header class="modal-header">
      <h2 id="whiteboard-stack-settings-title">${stackSettingsLabel}</h2>
      <button type="button" class="icon-button" aria-label="关闭" data-stack-cancel>
        <svg aria-hidden="true"><use href="#i-close"></use></svg>
      </button>
    </header>
    <div class="whiteboard-stack-fields">${Object.entries(stackPreferenceFields).map(([key,{label,max}]) => `
      <label for="whiteboard-stack-${key}">${label}</label>
      <output for="whiteboard-stack-${key}" data-stack-value="${key}"></output>
      <input type="range" id="whiteboard-stack-${key}" name="${key}" min="0" max="${max}" step="1">`).join('')}
    </div>
    <footer class="modal-footer">
      <button type="button" class="button subtle" data-stack-reset>恢复默认</button>
      <button type="submit" class="button primary" data-stack-save>保存</button>
    </footer>
  </form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form');
  const fields = Object.entries(stackPreferenceFields).map(([key,{unit}]) => ({key,unit,
    input:form.elements.namedItem(key), output:form.querySelector(`[data-stack-value="${key}"]`),
  }));
  const render = values => {
    for (const {key,unit,input,output} of fields) {
      input.value = values[key];
      output.textContent = input.value + unit;
      input.setAttribute('aria-valuetext',output.textContent);
    }
  };
  form.addEventListener('input', () => {
    render(Object.fromEntries(fields.map(({key,input}) => [key,input.valueAsNumber])));
  });
  form.querySelector('[data-stack-reset]').addEventListener('click', () => render(stackPreferences()));
  form.querySelector('[data-stack-cancel]').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', event => {
    event.preventDefault();
    const next = stackPreferences(Object.fromEntries(fields.map(({key,input}) => [key,input.valueAsNumber])));
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { notify('无法保存堆叠偏好。',true); return; }
    settings = next;
    dialog.close();
  });
  return {
    current:() => settings,
    isOpen:() => dialog.open,
    open() {
      if (document.querySelector('dialog[open]')) return;
      render(settings);
      dialog.showModal();
    },
    close() { if (dialog.open) dialog.close(); },
  };
}
