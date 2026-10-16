// Shared language tables. Loaded as a classic script in every context
// (content script, popup, options, offscreen). Attaches to `self`.
(function (global) {
  'use strict';

  // OCR source languages (Tesseract traineddata codes).
  // `_vert` variants exist for the CJK vertical writing modes.
  const OCR_LANGS = [
    { code: 'jpn', label: 'Japanese', vert: true },
    { code: 'eng', label: 'English', vert: false },
    { code: 'chi_sim', label: 'Chinese (Simplified)', vert: true },
    { code: 'chi_tra', label: 'Chinese (Traditional)', vert: true },
    { code: 'kor', label: 'Korean', vert: true },
    { code: 'rus', label: 'Russian', vert: false },
    { code: 'fra', label: 'French', vert: false },
    { code: 'deu', label: 'German', vert: false },
    { code: 'spa', label: 'Spanish', vert: false },
    { code: 'ita', label: 'Italian', vert: false },
    { code: 'por', label: 'Portuguese', vert: false },
    { code: 'tha', label: 'Thai', vert: false },
    { code: 'vie', label: 'Vietnamese', vert: false },
    { code: 'ind', label: 'Indonesian', vert: false },
  ];

  // Translation target languages. `google` is the code passed to the
  // free Google endpoint; `deepl` maps to DeepL target_lang codes.
  const TARGET_LANGS = [
    { code: 'en', label: 'English', deepl: 'EN-US', cjk: false },
    { code: 'ja', label: 'Japanese', deepl: 'JA', cjk: true },
    { code: 'zh-CN', label: 'Chinese (Simplified)', deepl: 'ZH', cjk: true },
    { code: 'zh-TW', label: 'Chinese (Traditional)', deepl: 'ZH-TW', cjk: true },
    { code: 'ko', label: 'Korean', deepl: 'KO', cjk: true },
    { code: 'es', label: 'Spanish', deepl: 'ES', cjk: false },
    { code: 'fr', label: 'French', deepl: 'FR', cjk: false },
    { code: 'de', label: 'German', deepl: 'DE', cjk: false },
    { code: 'it', label: 'Italian', deepl: 'IT', cjk: false },
    { code: 'pt', label: 'Portuguese', deepl: 'PT-BR', cjk: false },
    { code: 'ru', label: 'Russian', deepl: 'RU', cjk: false },
    { code: 'th', label: 'Thai', deepl: null, cjk: true },
    { code: 'vi', label: 'Vietnamese', deepl: 'VI', cjk: false },
    { code: 'id', label: 'Indonesian', deepl: 'ID', cjk: false },
  ];

  const CJK_BASE = new Set(['jpn', 'chi_sim', 'chi_tra', 'kor']);

  function ocrLabel(code) {
    if (code.endsWith('_vert')) {
      const base = ocrLabel(code.slice(0, -5));
      return base + ' (vertical)';
    }
    const found = OCR_LANGS.find((l) => l.code === code);
    return found ? found.label : code;
  }

  function targetLabel(code) {
    const found = TARGET_LANGS.find((l) => l.code === code);
    return found ? found.label : code;
  }

  function isCjkTarget(code) {
    const found = TARGET_LANGS.find((l) => l.code === code);
    return found ? found.cjk : false;
  }

  function hasVertical(code) {
    const base = code.endsWith('_vert') ? code.slice(0, -5) : code;
    return CJK_BASE.has(base);
  }

  function verticalVariant(code) {
    return code.endsWith('_vert') ? code : code + '_vert';
  }

  function baseVariant(code) {
    return code.endsWith('_vert') ? code.slice(0, -5) : code;
  }

  // Font stack used to render translated text on the overlay canvas.
  function fontStackFor(targetLang) {
    if (targetLang === 'ja') {
      return "'Noto Sans JP', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'Hiragino Kaku Gothic ProN', sans-serif";
    }
    if (targetLang === 'zh-CN') {
      return "'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', 'Heiti SC', sans-serif";
    }
    if (targetLang === 'zh-TW') {
      return "'Noto Sans TC', 'Microsoft JhengHei', 'PingFang TC', sans-serif";
    }
    if (targetLang === 'ko') {
      return "'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif";
    }
    if (targetLang === 'th') {
      return "'Noto Sans Thai', 'Leelawadee UI', 'Tahoma', sans-serif";
    }
    if (targetLang === 'ru') {
      return "'Segoe UI', 'PT Sans', Arial, sans-serif";
    }
    return "'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif";
  }

  const MTR_LANGS = {
    OCR_LANGS,
    TARGET_LANGS,
    ocrLabel,
    targetLabel,
    isCjkTarget,
    hasVertical,
    verticalVariant,
    baseVariant,
    fontStackFor,
  };

  global.MTR_LANGS = MTR_LANGS;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MTR_LANGS;
  }
})(typeof self !== 'undefined' ? self : globalThis);
