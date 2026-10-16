// Background service worker: message hub between content script, offscreen
// OCR document, translation providers, and the toolbar badge.

importScripts('shared/settings.js', 'shared/langs.js');

const OFFSCREEN_URL = 'offscreen/offscreen.html';

// ---------------------------------------------------------------------------
// Settings seed on install + context menu
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await MTR_SETTINGS_GET();
  if (!settings) {
    await chrome.storage.sync.set({ [MTR_SETTINGS_KEY]: MTR_SETTINGS_DEFAULTS });
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mtr-image',
      title: 'Translate this image',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: 'mtr-page',
      title: 'Translate this page',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'mtr-restore',
      title: 'Restore original page',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'mtr-image') {
    await sendToTab(tab.id, { type: 'TRANSLATE_ONE', src: info.srcUrl });
  } else if (info.menuItemId === 'mtr-page') {
    await sendToTab(tab.id, { type: 'TRANSLATE_PAGE' });
  } else if (info.menuItemId === 'mtr-restore') {
    await sendToTab(tab.id, { type: 'RESTORE_PAGE' });
  }
});

chrome.runtime.onSuspend.addListener(() => {
  console.warn('[MTR-BG] service worker suspending');
});

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      void chrome.runtime.lastError; // content script may not be there
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

let ensuringOffscreen = null;

async function ensureOffscreen() {
  if (ensuringOffscreen) return ensuringOffscreen;
  ensuringOffscreen = (async () => {
    const hasOffscreenApi = typeof chrome.offscreen !== 'undefined' && chrome.offscreen.createDocument;
    if (!hasOffscreenApi) throw new Error('Offscreen API unavailable (Chrome 109+ required)');

    let exists = false;
    try {
      if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
        });
        exists = contexts && contexts.length > 0;
      }
    } catch (e) {
      exists = false;
    }
    if (!exists) {
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['DOM_SCRAPING'],
          justification: 'Run Tesseract.js OCR on manga images (needs DOM + WebAssembly).',
        });
      } catch (e) {
        // "Only a single offscreen document..." means it already exists.
        if (!String(e && e.message).includes('single offscreen document')) throw e;
      }
    }
  })();
  try {
    await ensuringOffscreen;
  } finally {
    ensuringOffscreen = null;
  }
}

// ---------------------------------------------------------------------------
// Message hub
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'FETCH_IMAGE':
      handleFetchImage(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    case 'TRANSLATE':
      handleTranslate(msg)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    case 'OCR':
      handleOcr(msg)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    case 'BADGE':
      handleBadge(msg);
      return;

    case 'KEEPALIVE':
      // Cheap no-op that resets the SW idle timer while a session is active.
      sendResponse({ ok: true });
      return;

    case 'CLOSE_OFFSCREEN':
      chrome.offscreen && chrome.offscreen.closeDocument &&
        chrome.offscreen.closeDocument().catch(() => {});
      return;

    default:
      return; // unknown types (OCR_PROGRESS etc.) are broadcast-only
  }
});

// ---------------------------------------------------------------------------
// Image fetching (bypasses canvas taint + CORS by fetching in the SW)
// ---------------------------------------------------------------------------

async function handleFetchImage(url) {
  let response;
  try {
    response = await fetch(url, { credentials: 'include', mode: 'cors', signal: AbortSignal.timeout(30000) });
  } catch (e) {
    try {
      response = await fetch(url, { credentials: 'omit', mode: 'cors', signal: AbortSignal.timeout(30000) });
    } catch (e2) {
      return { ok: false, error: 'Image fetch failed (hotlink protection or network): ' + String(e2) };
    }
  }
  if (!response.ok) {
    return { ok: false, error: `Image fetch failed: HTTP ${response.status}` };
  }
  const blob = await response.blob();
  if (blob.size === 0) return { ok: false, error: 'Image fetch returned empty body' };
  if (blob.size > 40 * 1024 * 1024) return { ok: false, error: 'Image too large (>40MB)' };

  const buf = new Uint8Array(await blob.arrayBuffer());
  const mime =
    blob.type && blob.type.startsWith('image/')
      ? blob.type
      : sniffImageMime(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  const dataUrl = `data:${mime};base64,${btoa(binary)}`;
  return { ok: true, dataUrl };
}

function sniffImageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  if (buf.length > 12 && buf[8] === 0x66 && buf[9] === 0x74 && buf[10] === 0x79 && buf[11] === 0x70) return 'image/avif';
  if (buf.length > 16 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

const GOOGLE_SL_MAP = {
  jpn: 'ja',
  jpn_vert: 'ja',
  eng: 'en',
  chi_sim: 'zh-CN',
  chi_sim_vert: 'zh-CN',
  chi_tra: 'zh-TW',
  chi_tra_vert: 'zh-TW',
  kor: 'ko',
  kor_vert: 'ko',
  rus: 'ru',
  fra: 'fr',
  deu: 'de',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  tha: 'th',
  vie: 'vi',
  ind: 'id',
};

const translationCache = new Map(); // key -> translation

async function handleTranslate(msg) {
  const { texts, from, to, provider, keys } = msg;
  if (!Array.isArray(texts) || texts.length === 0) return { ok: true, translations: [] };

  const results = new Array(texts.length).fill(null);
  const todo = [];

  texts.forEach((t, i) => {
    const cacheKey = cacheKeyFor(provider, from, to, t);
    const cached = translationCache.get(cacheKey);
    if (cached != null) {
      results[i] = cached;
    } else {
      todo.push(i);
    }
  });

  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const idx = todo[cursor++];
      const text = texts[idx];
      let out = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          out = await translateOne(provider, from, to, text);
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (out == null) {
        // Degrade gracefully: keep the original text for this block.
        console.warn('[MTR] translation failed for one block:', lastErr);
        out = text;
      }
      results[idx] = out;
      translationCache.set(cacheKeyFor(provider, from, to, text), out);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, todo.length); i++) workers.push(worker());
  await Promise.all(workers);

  return { ok: true, translations: results };
}

function cacheKeyFor(provider, from, to, text) {
  return `${provider}|${from}|${to}|${text}`;
}

async function translateOne(provider, from, to, text) {
  if (!text || !text.trim()) return '';
  switch (provider) {
    case 'deepl':
      return translateDeepl(text, to);
    case 'libre':
      return translateLibre(text, from, to);
    case 'custom':
      return translateCustom(text, from, to);
    case 'google':
    default:
      return translateGoogle(text, from, to);
  }
}

async function translateGoogle(text, from, to) {
  const sl = from && GOOGLE_SL_MAP[from] ? GOOGLE_SL_MAP[from] : 'auto';
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Google: unexpected response');
  return data[0].map((seg) => (seg && seg[0]) || '').join('');
}

async function translateDeepl(text, to) {
  const settings = await getSettings();
  const key = (settings.deeplKey || '').trim();
  if (!key) throw new Error('DeepL API key not set (see options)');
  const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const target = mapDeeplTarget(to);
  const res = await fetch(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [text], target_lang: target }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
  const data = await res.json();
  if (!data.translations || !data.translations[0]) throw new Error('DeepL: unexpected response');
  return data.translations[0].text;
}

function mapDeeplTarget(to) {
  const table = {
    en: 'EN-US', ja: 'JA', 'zh-CN': 'ZH', 'zh-TW': 'ZH-TW', ko: 'KO',
    es: 'ES', fr: 'FR', de: 'DE', it: 'IT', pt: 'PT-BR', ru: 'RU',
    vi: 'VI', id: 'ID',
  };
  const t = table[to];
  if (!t) throw new Error(`DeepL does not support target language: ${to}`);
  return t;
}

async function translateLibre(text, from, to) {
  const settings = await getSettings();
  const endpoint = (settings.libreUrl || '').trim();
  if (!endpoint) throw new Error('LibreTranslate URL not set (see options)');
  const body = {
    q: text,
    source: from && GOOGLE_SL_MAP[from] ? GOOGLE_SL_MAP[from] : 'auto',
    target: to,
    format: 'text',
  };
  if (settings.libreKey) body.api_key = settings.libreKey;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`LibreTranslate HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data.translatedText !== 'string') throw new Error('LibreTranslate: unexpected response');
  return data.translatedText;
}

async function translateCustom(text, from, to) {
  const settings = await getSettings();
  const template = (settings.customUrl || '').trim();
  if (!template) throw new Error('Custom endpoint URL not set (see options)');
  const url = template
    .replace('{q}', encodeURIComponent(text))
    .replace('{sl}', encodeURIComponent(from || 'auto'))
    .replace('{tl}', encodeURIComponent(to));
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Custom endpoint HTTP ${res.status}`);
  const data = await res.json();
  const out = resolvePath(data, settings.customPath || '0.0');
  if (typeof out !== 'string') throw new Error(`Custom endpoint: no string at path "${settings.customPath}"`);
  return out;
}

function resolvePath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    if (Array.isArray(acc)) return acc[Number(key)];
    return acc[key];
  }, obj);
}

async function getSettings() {
  const res = await chrome.storage.sync.get(['mtrSettings']);
  return res.mtrSettings || {};
}

// ---------------------------------------------------------------------------
// OCR routing to the offscreen document
// ---------------------------------------------------------------------------

const OCR_RESPONSE_TIMEOUT_MS = 150000;

async function handleOcr(msg) {
  const { reqId, dataUrl, langs, psm } = msg;
  await ensureOffscreen();

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Never let a dead offscreen document hang the pipeline: race the
      // response against a hard timeout.
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: 'OCR_REQUEST', reqId, dataUrl, langs, psm }),
        sleep(OCR_RESPONSE_TIMEOUT_MS).then(() => ({
          ok: false,
          error: `OCR worker did not respond within ${OCR_RESPONSE_TIMEOUT_MS / 1000}s`,
        })),
      ]);
      if (response && response.ok === false && response.retry) {
        lastErr = new Error(response.error || 'OCR failed');
        await sleep(800);
        continue;
      }
      return response;
    } catch (e) {
      // "Receiving end does not exist" — offscreen document not ready yet.
      lastErr = e;
      await sleep(700);
    }
  }
  return { ok: false, error: `OCR unavailable: ${lastErr}` };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

let badgeClearTimer = null;

function handleBadge(msg) {
  const { done, total } = msg;
  if (!chrome.action) return;
  if (typeof total === 'number' && total > 0 && done < total) {
    setBadge(`${done}/${total}`, '#4F46E5');
  } else if (typeof done === 'number' && done > 0) {
    setBadge('OK', '#16A34A');
    clearTimeout(badgeClearTimer);
    badgeClearTimer = setTimeout(() => setBadge(''), 2500);
  } else {
    setBadge('');
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// ---------------------------------------------------------------------------
// Shared settings access
// ---------------------------------------------------------------------------

const MTR_SETTINGS_KEY = self.MTR_SETTINGS.STORAGE_KEY;
const MTR_SETTINGS_DEFAULTS = self.MTR_SETTINGS.DEFAULTS;

async function MTR_SETTINGS_GET() {
  const res = await chrome.storage.sync.get([self.MTR_SETTINGS.STORAGE_KEY]);
  return res[self.MTR_SETTINGS.STORAGE_KEY] || null;
}
