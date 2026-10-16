// E2E harness: loads the unpacked extension in real Chrome, wakes its service
// worker, triggers TRANSLATE_PAGE from the SW, polls GET_STATUS, and captures
// console output from the page, the SW, and the offscreen document.
//
// Usage: node run.mjs [--langs jpn] [--target en] [--timeout 150] [--shot out.png]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const EXT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_URL = arg('url', 'http://127.0.0.1:8123/test/page.html');
const TIMEOUT_S = Number(arg('timeout', '150'));
const SHOT = arg('shot', '');
const CHROME = arg('chrome', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

const PRESET = {
  sourceLangs: arg('langs', 'jpn').split(','),
  targetLang: arg('target', 'en'),
  direction: arg('direction', 'auto'),
  minImageWidth: 220,
  debug: true,
};

// Copy extension to a temp dir with a pinned key => deterministic extension ID.
function prepareExtension() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mtr-ext-'));
  fs.cpSync(EXT_ROOT, tmp, {
    recursive: true,
    filter: (s) => !s.includes(path.join('tools', 'e2e')) && !s.includes('node_modules'),
  });
  const manifestPath = path.join(tmp, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.key =
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmp++VHpX9uo0HLfqIqTIf/eGTsjDv+YLGXMGjeFzma5AJnC0/XGCYu2NVXFZRntAnRUAQXxxhxrmg9NtSsbcP9WuvRgrLuD6dXmZfFkUd+KstHxCyNxYZa1WObSGekvq4eLIVdOAML7vgw0ExtKSa1ped76u3tO8/gWZXiBC9qNXVj6SaQdjx56Cm6f10EdOQJRINK0m651QFwYylKKltgpWhtSV3Z9fZEPtaYK073rBQQuxV2Dr0vQ/6rvaG0c700nCWSYgQON6zZnAMnH4kZuv8FnVnfZH0D91MR1UbJI+s32BSLKn+Irs8R01JylNXVAAZrMU8gPUqd4DmvybbwIDAQAB';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const id = extensionIdFromKey(manifest.key);
  log('extension staged at', tmp, 'id', id);
  return { dir: tmp, id };
}

function extensionIdFromKey(keyBase64) {
  const pub = crypto.createPublicKey({ key: Buffer.from(keyBase64, 'base64'), format: 'der', type: 'spki' });
  const spkiDer = pub.export({ format: 'der', type: 'spki' });
  const hash = crypto.createHash('sha256').update(spkiDer).digest('hex');
  return hash.slice(0, 32).replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);
}

const { dir: extDir, id: extId } = prepareExtension();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: arg('headless', 'false') === 'true' ? 'new' : false,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'mtr-e2e-')),
    '--window-size=1500,1000',
  ],
  defaultViewport: { width: 1400, height: 950 },
});

try {
  // ---- browser-level CDP: catch renderer crashes with reasons ------------
  const browserCDP = await browser.target().createCDPSession();
  await browserCDP.send('Target.setDiscoverTargets', { discover: true });
  browserCDP.on('Target.targetCrashed', (e) => log('[CRASH]', JSON.stringify(e)));
  browserCDP.on('Target.targetDestroyed', (e) => log('[cdp-target-destroyed]', e.type, e.targetId));

  // ---- probe: open an extension page to confirm the extension loaded -----
  const probe = await browser.newPage();
  await probe.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load', timeout: 15000 });
  log('options page loaded — extension is live');
  // Wake the service worker: a runtime message forces the SW to spawn.
  await probe.evaluate(() => chrome.runtime.sendMessage({ type: 'WAKE' }).catch(() => {}));
  await probe.close();

  // ---- find the extension service worker (re-acquire if it restarts) ------
  browser.on('targetdestroyed', (t) => {
    if (t.url().includes(extId)) log('[lifecycle] target destroyed:', t.type(), t.url());
  });
  browser.on('targetcreated', (t) => {
    if (t.url().includes(extId)) log('[lifecycle] target created:', t.type(), t.url());
  });

  let swClient = null;
  async function acquireSw() {
    let swTarget = null;
    for (let i = 0; i < 40 && !swTarget; i++) {
      swTarget = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId));
      if (!swTarget) await new Promise((r) => setTimeout(r, 500));
    }
    if (!swTarget) {
      console.error('SW never appeared. Targets:', browser.targets().map((t) => `${t.type()} ${t.url()}`));
      throw new Error('extension SW not found');
    }
    log('service worker found');
    const sw = await swTarget.worker();
    swClient = await swTarget.createCDPSession();
    await swClient.send('Runtime.enable');
    swClient.on('Runtime.consoleAPICalled', (e) => {
      const text = (e.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (text) log('[sw]', text);
    });
    swClient.on('Runtime.exceptionThrown', (e) =>
      log('[sw-exception]', e.exceptionDetails.text, JSON.stringify(e.exceptionDetails.exception?.description || ''))
    );
    return sw;
  }

  const sw = await acquireSw();

  // seed settings
  await sw.evaluate(async (preset) => {
    const cur = await chrome.storage.sync.get(['mtrSettings']);
    await chrome.storage.sync.set({ mtrSettings: { ...(cur.mtrSettings || {}), ...preset } });
  }, PRESET);
  log('settings seeded:', JSON.stringify(PRESET));

  // ---- open the test page --------------------------------------------------
  const page = await browser.newPage();
  page.on('console', (m) => log('[page]', m.text()));
  page.on('pageerror', (e) => log('[page-error]', e.message));
  await page.goto(TEST_URL, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));

  const sendToTab = async (msg) => {
    try {
      return await sw.evaluate(async (m, url) => {
        const tabs = await chrome.tabs.query({ url: url.split('#')[0] + '*' });
        if (!tabs.length) return { ok: false, error: 'tab not found' };
        return new Promise((resolve) => {
          chrome.tabs.sendMessage(tabs[0].id, m, (res) => {
            if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
            else resolve(res);
          });
        });
      }, msg, TEST_URL);
    } catch (e) {
      return { ok: false, error: 'sw gone: ' + e.message };
    }
  };

  // ---- attach to the offscreen document (when it appears) ------------------
  let offscreenClient = null;
  let lastDebug = '';
  const attachOffscreen = async () => {
    if (offscreenClient) return;
    const t = browser.targets().find((x) => x.url().includes('offscreen.html'));
    if (!t) return;
    log('offscreen document detected — attaching (' + t.type() + ')');
    const client = await t.createCDPSession();
    await client.send('Runtime.enable');
    offscreenClient = client;
    client.on('Runtime.consoleAPICalled', (e) => {
      const text = (e.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      log('[offscreen]', text);
    });
    client.on('Runtime.exceptionThrown', (e) =>
      log('[offscreen-exception]', e.exceptionDetails.text, JSON.stringify(e.exceptionDetails.exception?.description || ''))
    );
    // Ground truth from inside the offscreen context
    try {
      const res = await client.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.MTR_DEBUG || {missing: true})',
        returnByValue: true,
      });
      log('[offscreen-state]', res.result.value);
    } catch (e) {
      log('[offscreen-state] evaluate failed:', e.message);
    }

    // ---- OCR lab: compare PSM modes on the test image -----------------------
    if (arg('lab', 'false') === 'true') {
      try {
        const lab = await client.send('Runtime.evaluate', {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async () => {
            const resp = await fetch('http://127.0.0.1:8123/test/img-vertical.svg');
            const svg = await resp.text();
            const svgUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
            const img = new Image();
            img.src = svgUrl;
            await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg load failed')); });
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            const dataUrl = c.toDataURL('image/png');
            const opts = {
              workerPath: chrome.runtime.getURL('lib/worker.min.js'),
              corePath: chrome.runtime.getURL('lib/core/'),
              langPath: 'https://tessdata.projectnaptha.com/4.0.0',
              workerBlobURL: false,
              gzip: true,
            };
            const out = [];
            for (const combo of [['jpn_vert', '5'], ['jpn_vert', '11'], ['jpn_vert', '3'], ['jpn', '11'], ['jpn', '6']]) {
              try {
                const w = await Tesseract.createWorker(combo[0], 1, opts);
                await w.setParameters({ tessedit_pageseg_mode: combo[1] });
                const { data } = await w.recognize(dataUrl, {}, { text: true, blocks: true });
                const lines = [];
                for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
                  lines.push({ t: (l.text || '').trim().slice(0, 14), c: Math.round(l.confidence), b: [l.bbox.x0, l.bbox.y0, l.bbox.x1 - l.bbox.x0, l.bbox.y1 - l.bbox.y0].map(Math.round) });
                }
                out.push({ combo: combo.join('/'), n: lines.length, lines: lines.slice(0, 10) });
                await w.terminate();
              } catch (e) {
                out.push({ combo: combo.join('/'), error: String(e && e.message) });
              }
            }
            return JSON.stringify(out);
          })()`,
        });
        const combos = JSON.parse(lab.result.value);
        for (const r of combos) {
          if (r.error) { log('[lab]', r.combo, 'ERROR', r.error); continue; }
          log('[lab]', r.combo, '→', r.n, 'lines');
          for (const l of r.lines) log('   ', JSON.stringify(l));
        }
      } catch (e) {
        log('[lab] failed:', e.message);
      }
    }

    // ---- probe: instrument Worker and run the real createWorker -------------
    if (arg('probe', 'false') === 'true') {
      try {
        const probe = await client.send('Runtime.evaluate', {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async () => {
            const wlog = [];
            window.__wlog = wlog;
            if (!window.__wpatched) {
              window.__wpatched = true;
              const origPost = Worker.prototype.postMessage;
              Worker.prototype.postMessage = function (msg, ...rest) {
                try { wlog.push('POST ' + JSON.stringify(msg).slice(0, 110)); } catch (_) { wlog.push('POST <unserializable>'); }
                return origPost.call(this, msg, ...rest);
              };
              const desc = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage');
              Object.defineProperty(Worker.prototype, 'onmessage', {
                set(fn) {
                  wlog.push('ONMESSAGE-SET');
                  desc.set.call(this, function (e) {
                    try { wlog.push('RECV ' + JSON.stringify(e.data).slice(0, 110)); } catch (_) {}
                    return fn.call(this, e);
                  });
                },
                get() { return desc.get.call(this); },
              });
              // IndexedDB probe (tesseract caches lang data there)
              const idb = await new Promise((resolve) => {
                try {
                  const req = indexedDB.open('mtr-probe-db', 1);
                  const t = setTimeout(() => resolve('TIMEOUT-5s'), 5000);
                  req.onsuccess = () => { clearTimeout(t); try { req.result.close(); } catch (_) {} resolve('opened'); };
                  req.onerror = () => { clearTimeout(t); resolve('error: ' + req.error); };
                } catch (e) { resolve('throw: ' + e.message); }
              });
              wlog.push('IDB: ' + idb);
            }
            wlog.push('--- decode probe');
            try {
              const c = document.createElement('canvas');
              c.width = 100;
              c.height = 100;
              const cx = c.getContext('2d');
              cx.fillStyle = '#fff';
              cx.fillRect(0, 0, 100, 100);
              const dataUrl = c.toDataURL('image/jpeg', 0.9);
              wlog.push('toDataURL ok len=' + dataUrl.length);
              const img = new Image();
              img.src = dataUrl;
              await Promise.race([
                img.decode(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('DECODE TIMEOUT 5s')), 5000)),
              ]);
              wlog.push('img.decode ok');
            } catch (e) {
              wlog.push('decode probe FAILED: ' + e.message);
            }
            wlog.push('--- createWorker starting');
            const logger = (m) => wlog.push('LOGGER: ' + m.status + ' ' + Math.round((m.progress || 0) * 100) + '%');
            Tesseract.createWorker('eng', 1, {
              workerPath: chrome.runtime.getURL('lib/worker.min.js'),
              corePath: chrome.runtime.getURL('lib/core/'),
              langPath: 'https://tessdata.projectnaptha.com/4.0.0',
              workerBlobURL: false,
              gzip: true,
              logger,
            }).then(() => wlog.push('CREATEWORKER RESOLVED'))
              .catch((e) => wlog.push('CREATEWORKER REJECTED: ' + (e && e.message)));
            await new Promise((r) => setTimeout(r, 25000));
            return JSON.stringify(wlog);
          })()`,
        });
        const lines = JSON.parse(probe.result.value);
        for (const l of lines) log('[probe]', l);
      } catch (e) {
        log('[worker-probe] failed:', e.message);
      }
    }
  };
  const pollOffscreenDebug = async () => {
    if (!offscreenClient) return;
    try {
      const res = await offscreenClient.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.MTR_DEBUG || {missing: true})',
        returnByValue: true,
      });
      if (res.result.value !== lastDebug) {
        lastDebug = res.result.value;
        log('[offscreen-state]', lastDebug);
      }
    } catch (e) {
      log('[offscreen-state] evaluate failed:', e.message);
      offscreenClient = null;
    }
  };

  // ---- kick off translation -------------------------------------------------
  log('ping:', JSON.stringify(await sendToTab({ type: 'PING' })));
  log('sending TRANSLATE_PAGE');
  await sendToTab({ type: 'TRANSLATE_PAGE' });

  // ---- poll status ------------------------------------------------------------
  const start = Date.now();
  let last = '';
  while (Date.now() - start < TIMEOUT_S * 1000) {
    await attachOffscreen();
    await pollOffscreenDebug();
    const status = await sendToTab({ type: 'GET_STATUS' });
    const s = status && status.ok ? status.status : null;
    if (s) {
      const brief = JSON.stringify({
        active: s.active,
        total: s.total,
        done: s.done,
        regions: s.regions,
        images: s.images.map((i) => `${i.status}${i.error ? ':' + i.error : i.phaseText ? ':' + i.phaseText : ''}`),
      });
      if (brief !== last) {
        log('status', brief);
        last = brief;
      }
      if (s.total > 0 && s.done === s.total) {
        log(`FINISHED: ${s.regions} regions rendered`);

        // ---- exercise restore + re-translate (OCR should hit cache) ----
        if (arg('cycle', 'true') === 'true') {
          await sendToTab({ type: 'RESTORE_PAGE' });
          await new Promise((r) => setTimeout(r, 1200));
          const after = await sendToTab({ type: 'GET_STATUS' });
          log('after restore:', JSON.stringify({ active: after.status && after.status.active, total: after.status && after.status.total }));
          const t0 = Date.now();
          await sendToTab({ type: 'TRANSLATE_PAGE' });
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const st = await sendToTab({ type: 'GET_STATUS' });
            const s2 = st.status;
            if (s2 && s2.total > 0 && s2.done === s2.total) {
              log(`RE-FINISHED in ${Math.round((Date.now() - t0) / 1000)}s: ${s2.regions} regions`);
              break;
            }
          }
        }

        if (SHOT) {
          await page.screenshot({ path: SHOT, fullPage: false });
          log('screenshot saved:', SHOT);
        }
        break;
      }
    } else {
      log('status unreachable:', JSON.stringify(status));
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
} finally {
  await browser.close().catch(() => {});
}
