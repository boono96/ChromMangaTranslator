// Options page controller: loads settings, wires the form, saves.
(() => {
  'use strict';

  const FIELDS = [
    'provider',
    'deeplKey',
    'libreUrl',
    'libreKey',
    'customUrl',
    'customPath',
    'minImageWidth',
    'minConfidence',
    'langData',
    'textColor',
    'fontFamily',
    'autoNewImages',
    'debug',
  ];

  const els = {};
  for (const f of FIELDS) els[f] = document.getElementById(f);
  const savedNote = document.getElementById('savedNote');

  init();

  async function init() {
    const settings = await MTR_SETTINGS.get();
    for (const f of FIELDS) {
      if (!(f in els) || !els[f]) continue;
      if (els[f].type === 'checkbox') els[f].checked = !!settings[f];
      else els[f].value = settings[f];
    }
    updateProviderVisibility();
    updateConfidenceLabel();

    els.provider.addEventListener('change', updateProviderVisibility);
    els.minConfidence.addEventListener('input', updateConfidenceLabel);

    document.getElementById('save').addEventListener('click', save);
    document.getElementById('reset').addEventListener('click', reset);
  }

  function updateProviderVisibility() {
    const provider = els.provider.value;
    document.querySelectorAll('.provider-field').forEach((row) => {
      row.style.display = row.dataset.provider === provider ? '' : 'none';
    });
  }

  function updateConfidenceLabel() {
    document.getElementById('minConfidenceVal').textContent = els.minConfidence.value;
  }

  async function save() {
    const partial = {};
    for (const f of FIELDS) {
      if (!(f in els) || !els[f]) continue;
      partial[f] = els[f].type === 'checkbox' ? els[f].checked : els[f].value;
    }
    partial.minImageWidth = Number(partial.minImageWidth) || 220;
    partial.minConfidence = Number(partial.minConfidence) || 0;
    await MTR_SETTINGS.save(partial);
    savedNote.classList.remove('hidden');
    setTimeout(() => savedNote.classList.add('hidden'), 1800);
  }

  async function reset() {
    await chrome.storage.sync.remove([MTR_SETTINGS.STORAGE_KEY]);
    const settings = MTR_SETTINGS.normalize({});
    for (const f of FIELDS) {
      if (!(f in els) || !els[f]) continue;
      if (els[f].type === 'checkbox') els[f].checked = !!settings[f];
      else els[f].value = settings[f];
    }
    updateProviderVisibility();
    updateConfidenceLabel();
  }
})();
