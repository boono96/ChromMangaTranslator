// Offscreen document: owns the single Tesseract.js worker. Lives as long as
// there is OCR traffic, then self-closes to free memory.

const OCR_MAX_DIM = 2600;
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const WORKER_INIT_TIMEOUT_MS = 90000;
const RECOGNIZE_TIMEOUT_MS = 150000;

let worker = null;
let workerLangKey = null;
let workerPromise = null;
let pendingCount = 0;
let idleTimer = null;

// Ring buffer + counters, readable from the SW/harness for diagnostics.
const MTR_DEBUG = {
  requests: 0,
  done: 0,
  failed: 0,
  workerReady: false,
  lastError: null,
  logs: [],
};
if (typeof window !== 'undefined') window.MTR_DEBUG = MTR_DEBUG;
function debugLog(...args) {
  const line = `${new Date().toISOString().slice(11, 19)} ${args.join(' ')}`;
  MTR_DEBUG.logs.push(line);
  if (MTR_DEBUG.logs.length > 40) MTR_DEBUG.logs.shift();
  console.log('[MTR-OCR]', ...args);
}

let ocrQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'OCR_PING') {
    sendResponse({ ok: true, workerReady: MTR_DEBUG.workerReady, requests: MTR_DEBUG.requests });
    return;
  }
  if (msg.type !== 'OCR_REQUEST') return;
  // Serialize: a language switch (reinitialize) must never race an
  // in-flight recognize on the shared worker.
  ocrQueue = ocrQueue
    .then(() => handleOcrRequest(msg))
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async response
});

async function handleOcrRequest(msg) {
  const { reqId, dataUrl, langs, psm } = msg;
  if (!Array.isArray(langs) || langs.length === 0) {
    return { ok: false, error: 'OCR: no source languages given' };
  }
  MTR_DEBUG.requests++;
  debugLog(`request ${reqId}: langs=${langs.join('+')} psm=${psm} bytes=${dataUrl.length}`);
  pendingCount++;
  clearTimeout(idleTimer);
  try {
    const canvas = await dataUrlToCanvas(dataUrl);
    await ensureWorker(langs);
    if (psm) {
      await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
    }
    const result = await Promise.race([
      worker.recognize(canvas, {}, { text: true, blocks: true }),
      sleep(RECOGNIZE_TIMEOUT_MS).then(() => {
        throw new Error(`recognize timed out after ${RECOGNIZE_TIMEOUT_MS / 1000}s`);
      }),
    ]);
    const lines = flattenLines(result.data);
    MTR_DEBUG.done++;
    debugLog(`request ${reqId} done: ${lines.length} lines`);
    return { ok: true, reqId, width: canvas.width, height: canvas.height, lines };
  } catch (e) {
    // A dead worker poisons everything after it — recycle on error.
    MTR_DEBUG.failed++;
    MTR_DEBUG.lastError = String(e && e.message || e);
    debugLog(`request ${reqId} failed: ${MTR_DEBUG.lastError}`);
    await terminateWorker();
    return { ok: false, reqId, error: String(e && e.message || e) };
  } finally {
    pendingCount--;
    if (pendingCount === 0) armIdleClose();
  }
}

async function ensureWorker(langs) {
  const langKey = langs.join('+');
  const langPath =
    (await getLangDataMode()) === 'local'
      ? chrome.runtime.getURL('lib/tessdata')
      : 'https://tessdata.projectnaptha.com/4.0.0';

  if (workerPromise) {
    await workerPromise; // serialize init with any in-flight init
  }
  if (worker && workerLangKey === langKey) return worker;

  if (worker) {
    try {
      await worker.reinitialize(langKey);
      workerLangKey = langKey;
      return worker;
    } catch (e) {
      await terminateWorker();
    }
  }

  workerPromise = Promise.race([
    Tesseract.createWorker(langKey, 1, {
      workerPath: chrome.runtime.getURL('lib/worker.min.js'),
      corePath: chrome.runtime.getURL('lib/core/'),
      langPath,
      workerBlobURL: false,
      gzip: true,
      logger: (m) => {
        if (m && m.status) {
          debugLog(`progress: ${m.status} ${Math.round((m.progress || 0) * 100)}%`);
          broadcast({
            type: 'OCR_PROGRESS',
            status: m.status,
            progress: m.progress || 0,
          });
        }
      },
    }),
    sleep(WORKER_INIT_TIMEOUT_MS).then(() => {
      throw new Error(`Tesseract worker init timed out after ${WORKER_INIT_TIMEOUT_MS / 1000}s`);
    }),
  ]);
  try {
    worker = await workerPromise;
  } catch (e) {
    workerPromise = null;
    throw e;
  }
  workerPromise = null;
  workerLangKey = langKey;
  MTR_DEBUG.workerReady = true;
  debugLog(`worker ready: ${langKey} (langPath=${langPath})`);
  return worker;
}

async function terminateWorker() {
  if (worker) {
    try { await worker.terminate(); } catch (e) { /* already gone */ }
  }
  worker = null;
  workerLangKey = null;
  workerPromise = null;
}

function flattenLines(data) {
  const out = [];
  const blocks = data && data.blocks;
  if (!Array.isArray(blocks)) return out;
  for (const block of blocks) {
    for (const par of block.paragraphs || []) {
      for (const line of par.lines || []) {
        const text = (line.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const b = line.bbox || {};
        out.push({
          text,
          conf: typeof line.confidence === 'number' ? line.confidence : 0,
          bbox: [b.x0 || 0, b.y0 || 0, (b.x1 || 0) - (b.x0 || 0), (b.y1 || 0) - (b.y0 || 0)],
        });
      }
    }
  }
  return out;
}

async function dataUrlToCanvas(dataUrl) {
  const img = await loadImage(dataUrl);
  let { naturalWidth: w, naturalHeight: h } = img;
  const scale = Math.min(1, OCR_MAX_DIM / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const domCanvas = document.createElement('canvas');
  domCanvas.width = w;
  domCanvas.height = h;
  const ctx = domCanvas.getContext('2d', { willReadFrequently: false });
  ctx.drawImage(img, 0, 0, w, h);
  return domCanvas;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}

async function getLangDataMode() {
  try {
    const res = await chrome.storage.sync.get(['mtrSettings']);
    const s = res.mtrSettings;
    return s && s.langData === 'local' ? 'local' : 'cdn';
  } catch (e) {
    return 'cdn';
  }
}

function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (e) {
    // no receivers — ignore
  }
}

function armIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pendingCount === 0) {
      terminateWorker().then(() => {
        chrome.runtime.sendMessage({ type: 'CLOSE_OFFSCREEN' }).catch(() => {});
      });
    }
  }, IDLE_CLOSE_MS);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
