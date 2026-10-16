// Shared settings schema: defaults + normalization. Classic script.
(function (global) {
  'use strict';

  const DEFAULTS = {
    targetLang: 'en',
    sourceLangs: ['jpn'],
    // auto | horizontal | vertical  — how to treat CJK OCR
    direction: 'auto',
    // google | deepl | libre | custom
    provider: 'google',
    deeplKey: '',
    libreUrl: 'https://libretranslate.com/translate',
    libreKey: '',
    customUrl: '',
    // dot path into the custom endpoint's JSON response, e.g. "0.0" or "data.text"
    customPath: '0.0',
    minImageWidth: 220,
    minConfidence: 60,
    // auto | black | white
    textColor: 'auto',
    fontFamily: 'auto',
    autoNewImages: true,
    // cdn | local  — where Tesseract traineddata is loaded from
    langData: 'cdn',
    debug: false,
  };

  const STORAGE_KEY = 'mtrSettings';

  function get() {
    return new Promise((resolve) => {
      chrome.storage.sync.get([STORAGE_KEY], (res) => {
        resolve(normalize(res[STORAGE_KEY] || {}));
      });
    });
  }

  function save(partial) {
    return new Promise((resolve) => {
      chrome.storage.sync.get([STORAGE_KEY], (res) => {
        const merged = Object.assign({}, DEFAULTS, res[STORAGE_KEY] || {}, partial);
        chrome.storage.sync.set({ [STORAGE_KEY]: normalize(merged) }, () => resolve());
      });
    });
  }

  function normalize(raw) {
    const s = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return s;
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in raw)) continue;
      const def = DEFAULTS[key];
      const val = raw[key];
      if (Array.isArray(def)) {
        if (Array.isArray(val)) s[key] = val.filter((v) => typeof v === 'string' && v.length > 0);
      } else if (typeof def === 'number') {
        const n = Number(val);
        if (Number.isFinite(n)) s[key] = n;
      } else if (typeof def === 'boolean') {
        if (typeof val === 'boolean') s[key] = val;
      } else {
        if (typeof val === 'string') s[key] = val;
      }
    }
    if (!['auto', 'horizontal', 'vertical'].includes(s.direction)) s.direction = 'auto';
    if (!['google', 'deepl', 'libre', 'custom'].includes(s.provider)) s.provider = 'google';
    if (!['auto', 'black', 'white'].includes(s.textColor)) s.textColor = 'auto';
    if (!['cdn', 'local'].includes(s.langData)) s.langData = 'cdn';
    if (s.minImageWidth < 32) s.minImageWidth = 32;
    if (s.minConfidence < 0) s.minConfidence = 0;
    if (s.minConfidence > 95) s.minConfidence = 95;
    return s;
  }

  const MTR_SETTINGS = { DEFAULTS, STORAGE_KEY, get, save, normalize };
  global.MTR_SETTINGS = MTR_SETTINGS;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MTR_SETTINGS;
  }
})(typeof self !== 'undefined' ? self : globalThis);
