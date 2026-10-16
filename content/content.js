// Content script: discovers manga images, runs the
// fetch → OCR → translate → render pipeline, and draws translations onto
// fixed-position canvases that track each image every animation frame.
(() => {
  'use strict';

  const MAX_CANVAS_DIM = 4096;
  const OCR_MAX_DIM = 2200;
  const MAX_CONCURRENT_JOBS = 2;
  const SEND_TIMEOUT = {
    FETCH_IMAGE: 45000,
    OCR: 180000,
    TRANSLATE: 90000,
  };

  const state = {
    active: false,
    showOriginal: false,
    settings: null,
    jobs: new Map(), // HTMLImageElement -> job
    queue: [],
    running: 0,
    rafId: 0,
    observer: null,
    loadListener: null,
    keepaliveTimer: 0,
  };

  const fetchCache = new Map(); // src -> dataUrl
  const ocrCache = new Map(); // src|langs -> {lines, ocrW, ocrH}
  const MAX_CACHE_ENTRIES = 8;

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'PING':
        sendResponse({ ok: true });
        return;
      case 'GET_STATUS':
        sendResponse({ ok: true, status: snapshot() });
        return;
      case 'TRANSLATE_PAGE':
        startSession().catch((e) => console.error('[MTR] start failed', e));
        sendResponse({ ok: true });
        return;
      case 'TRANSLATE_ONE':
        queueOne(msg.src).catch((e) => console.error('[MTR] queue failed', e));
        sendResponse({ ok: true });
        return;
      case 'RESTORE_PAGE':
        restoreAll();
        sendResponse({ ok: true });
        return;
      case 'SHOW_ORIGINAL':
        state.showOriginal = true;
        sendResponse({ ok: true });
        return;
      case 'SHOW_TRANSLATION':
        state.showOriginal = false;
        sendResponse({ ok: true });
        return;
      default:
        return;
    }
  });

  function send(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${type} timed out`)), timeoutMs || 30000);
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async function startSession() {
    state.settings = await MTR_SETTINGS.get();
    state.active = true;
    state.showOriginal = false;
    installObserver();
    scanAndQueue();
    startLoop();
    startKeepalive();
    pump();
    broadcastStatus();
  }

  // MV3 service workers are killed after ~30s of idleness, which would drop
  // any pending OCR/translation response. Ping the SW while a session is on.
  function startKeepalive() {
    stopKeepalive();
    state.keepaliveTimer = setInterval(() => {
      try {
        chrome.runtime.sendMessage({ type: 'KEEPALIVE' }).catch(() => {});
      } catch (e) {
        /* SW restarting — it will wake on the next tick */
      }
    }, 20000);
  }

  function stopKeepalive() {
    if (state.keepaliveTimer) {
      clearInterval(state.keepaliveTimer);
      state.keepaliveTimer = 0;
    }
  }

  async function queueOne(src) {
    if (!state.active) await startSession();
    const el = Array.from(document.images).find(
      (img) => (img.currentSrc || img.src) === src
    );
    if (!el || el.dataset.mtrQueued) return;
    el.dataset.mtrQueued = '1';
    state.queue.push({ el, src });
    pump();
    broadcastStatus();
  }

  function restoreAll() {
    state.active = false;
    state.showOriginal = false;
    stopKeepalive();
    for (const job of state.jobs.values()) job.cancelled = true;
    state.queue = [];
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.loadListener) {
      document.removeEventListener('load', state.loadListener, true);
      state.loadListener = null;
    }
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    document
      .querySelectorAll('img[data-mtr-queued]')
      .forEach((imgEl) => delete imgEl.dataset.mtrQueued);
    for (const job of state.jobs.values()) {
      if (job.canvas && job.canvas.parentNode) job.canvas.parentNode.removeChild(job.canvas);
    }
    state.jobs.clear();
    fetchCache.clear();
    if (ocrCache.size > MAX_CACHE_ENTRIES * 2) ocrCache.clear();
    sendBadge({ done: 0, total: 0 });
    broadcastStatus();
  }

  function installObserver() {
    if (state.observer || !state.settings.autoNewImages) return;
    state.observer = new MutationObserver(() => {
      clearTimeout(state.observer._t);
      state.observer._t = setTimeout(() => {
        if (state.active) scanAndQueue();
      }, 400);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });

    state.loadListener = (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !state.active) return;
      if (img.dataset.mtrQueued) return;
      const src = img.currentSrc || img.src;
      if (!src || img.naturalWidth < state.settings.minImageWidth) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) return;
      img.dataset.mtrQueued = '1';
      state.queue.push({ el: img, src });
      pump();
    };
    document.addEventListener('load', state.loadListener, true);
  }

  // -------------------------------------------------------------------------
  // Candidate discovery
  // -------------------------------------------------------------------------

  function scanAndQueue() {
    if (!state.active || !state.settings) return;
    const min = state.settings.minImageWidth;
    const candidates = [];
    for (const img of document.images) {
      if (img.dataset.mtrQueued) continue;
      const src = img.currentSrc || img.src;
      if (!src) continue;
      if (img.naturalWidth && img.naturalWidth < min) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) continue;
      img.dataset.mtrQueued = '1';
      candidates.push({ el: img, src, rect, visible: isRectVisible(rect) });
    }
    // Visible images first, then top-of-viewport first.
    candidates.sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? -1 : 1;
      return Math.abs(a.rect.top) - Math.abs(b.rect.top);
    });
    for (const c of candidates) state.queue.push({ el: c.el, src: c.src });
    pump();
    broadcastStatus();
  }

  function isRectVisible(rect) {
    return (
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  function pump() {
    while (state.running < MAX_CONCURRENT_JOBS && state.queue.length > 0) {
      const next = state.queue.shift();
      if (!next.el.isConnected) continue;
      state.running++;
      processJob(next.el, next.src)
        .catch((e) => console.error('[MTR] job failed', e))
        .finally(() => {
          state.running--;
          pump();
        });
    }
  }

  // -------------------------------------------------------------------------
  // Per-image pipeline
  // -------------------------------------------------------------------------

  async function processJob(imgEl, src) {
    const job = {
      el: imgEl,
      src,
      status: 'fetching',
      phaseText: '',
      error: null,
      regions: [],
      cancelled: false,
      canvas: null,
      ctx: null,
      baseImg: null,
    };
    state.jobs.set(imgEl, job);
    broadcastStatus();

    try {
      // 1. Fetch the image bytes (background fetch avoids canvas tainting).
      let dataUrl;
      if (src.startsWith('data:')) {
        dataUrl = src;
      } else {
        dataUrl = fetchCache.get(src);
        if (!dataUrl) {
          const res = await send('FETCH_IMAGE', { url: src }, SEND_TIMEOUT.FETCH_IMAGE);
          if (!res.ok) throw new Error(res.error || 'image fetch failed');
          dataUrl = res.dataUrl;
          cachePut(fetchCache, src, dataUrl);
        }
      }
      if (job.cancelled) return;

      // 2. Decode and set up the overlay canvas.
      job.status = 'decoding';
      broadcastStatus();
      const baseImg = await loadImage(dataUrl);
      job.baseImg = baseImg;
      const natW = baseImg.naturalWidth;
      const natH = baseImg.naturalHeight;
      if (!natW || !natH) throw new Error('image has no dimensions');
      const capScale = Math.min(1, MAX_CANVAS_DIM / Math.max(natW, natH));
      job.natW = natW;
      job.natH = natH;
      job.canvasW = Math.max(1, Math.round(natW * capScale));
      job.canvasH = Math.max(1, Math.round(natH * capScale));
      job.scale = job.canvasW / natW;
      attachOverlay(job);

      // 3. OCR passes (horizontal + vertical in auto mode).
      const passes = buildOcrPasses(state.settings);
      const blockLists = [];
      let ocrError = null;
      for (const pass of passes) {
        if (job.cancelled) return;
        try {
          const lines = await ocrPass(job, pass);
          if (state.settings.debug) {
            console.log(
              `[MTR] pass ${pass.langs.join('+')} → ${lines.length} lines:`,
              JSON.stringify(lines.slice(0, 12).map((l) => ({ b: l.bbox.map(Math.round), c: Math.round(l.conf), t: l.text.slice(0, 16) })))
            );
          }
          const cjkSource = state.settings.sourceLangs.some((c) => /^(jpn|chi|kor)/.test(c));
          const passOrigin = pass.langs.some((l) => l.endsWith('_vert')) ? 'v' : 'h';
          blockLists.push(
            MTR_TEXTBOX.groupLines(lines, {
              minConfidence: state.settings.minConfidence,
              cjk: cjkSource,
              imageW: natW,
              imageH: natH,
            }).map((b) => ({ ...b, pass: passOrigin }))
          );
        } catch (e) {
          ocrError = ocrError || e;
        }
      }
      if (job.cancelled) return;
      const blocks = MTR_TEXTBOX.mergeBlocks(blockLists);
      if (state.settings.debug) {
        console.log(
          '[MTR] blocks:',
          JSON.stringify(blocks.map((b) => ({ box: b.box, conf: Math.round(b.conf), v: !!b.vertical, text: b.text.slice(0, 40) })))
        );
      }
      if (blocks.length === 0) {
        job.status = 'done';
        job.phaseText = 'no text found';
        broadcastStatus();
        sendBadge();
        return;
      }

      // 5. Translate.
      job.status = 'translating';
      job.phaseText = `${blocks.length} block(s)`;
      broadcastStatus();
      const tr = await send(
        'TRANSLATE',
        {
          texts: blocks.map((b) => b.text),
          from: state.settings.sourceLangs.length === 1 ? state.settings.sourceLangs[0] : '',
          to: state.settings.targetLang,
          provider: state.settings.provider,
        },
        SEND_TIMEOUT.TRANSLATE
      );
      if (!tr.ok) throw new Error(tr.error || 'translation failed');
      if (job.cancelled) return;

      // 6. Render.
      job.regions = blocks
        .map((b, i) => ({ box: b.box, text: (tr.translations[i] || '').trim() }))
        .filter((r) => r.text.length > 0);
      renderJob(job);
      job.status = 'done';
      job.phaseText = `${job.regions.length} region(s)`;
      if (tr.failed && tr.failed > 0) {
        job.warning = `${tr.failed}/${blocks.length} block(s) failed to translate — original text kept (${tr.lastError || 'provider error'})`;
        job.phaseText += ` · ${tr.failed} translation(s) failed`;
      }
      broadcastStatus();
      sendBadge();
    } catch (e) {
      job.status = 'error';
      job.error = String((e && e.message) || e);
      broadcastStatus();
      sendBadge();
    }
  }

  function buildOcrPasses(settings) {
    const base = ((settings.sourceLangs && settings.sourceLangs.length
      ? settings.sourceLangs
      : ['jpn']
    ).map(MTR_LANGS.baseVariant));
    const horizontal = base;
    const vertical = base.map((c) => (MTR_LANGS.hasVertical(c) ? MTR_LANGS.verticalVariant(c) : c));
    const hasVerticalVariant = vertical.some((c, i) => c !== horizontal[i]);
    if (settings.direction === 'vertical' && hasVerticalVariant) {
      return [{ langs: vertical, psm: 5 }];
    }
    if (settings.direction === 'horizontal' || !hasVerticalVariant) {
      return [{ langs: horizontal, psm: 6 }];
    }
    // auto: run both passes and merge — vertical CJK is invisible to the
    // horizontal model (and vice versa). PSM 6 = uniform block (max recall
    // for sparse bubble text), PSM 5 = vertical text columns.
    return [
      { langs: horizontal, psm: 6 },
      { langs: vertical, psm: 5 },
    ];
  }

  async function ocrPass(job, pass) {
    const langs = pass.langs;
    const key = `${job.src}|${langs.join(',')}|${pass.psm}`;
    let cached = ocrCache.get(key);
    if (!cached) {
      const small = await downscaleForOcr(job.baseImg);
      job.status = 'ocr';
      job.phaseText = langs.map((l) => MTR_LANGS.ocrLabel(l)).join(' + ');
      broadcastStatus();
      const res = await send(
        'OCR',
        {
          reqId: `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          dataUrl: small,
          langs,
          psm: pass.psm,
        },
        SEND_TIMEOUT.OCR
      );
      if (!res.ok) throw new Error(res.error || 'OCR failed');
      cached = { lines: res.lines, ocrW: res.width, ocrH: res.height };
      cachePut(ocrCache, key, cached);
    }
    const k = job.natW / cached.ocrW;
    return cached.lines.map((l) => ({
      text: l.text,
      conf: l.conf,
      bbox: [l.bbox[0] * k, l.bbox[1] * k, l.bbox[2] * k, l.bbox[3] * k],
    }));
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUrl;
    });
  }

  function downscaleForOcr(baseImg) {
    const scale = Math.min(1, OCR_MAX_DIM / Math.max(baseImg.naturalWidth, baseImg.naturalHeight));
    const w = Math.max(1, Math.round(baseImg.naturalWidth * scale));
    const h = Math.max(1, Math.round(baseImg.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(baseImg, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  function cachePut(map, key, value) {
    if (map.size >= MAX_CACHE_ENTRIES) {
      map.delete(map.keys().next().value);
    }
    map.set(key, value);
  }

  // -------------------------------------------------------------------------
  // Overlay canvas + rendering
  // -------------------------------------------------------------------------

  function attachOverlay(job) {
    const canvas = document.createElement('canvas');
    canvas.className = 'mtr-overlay-canvas';
    canvas.width = job.canvasW;
    canvas.height = job.canvasH;
    (document.body || document.documentElement).appendChild(canvas);
    job.canvas = canvas;
    job.ctx = canvas.getContext('2d', { willReadFrequently: true });
    job.ctx.imageSmoothingQuality = 'high';
    job.ctx.drawImage(job.baseImg, 0, 0, job.canvasW, job.canvasH);
  }

  function renderJob(job) {
    const { ctx } = job;
    if (!ctx) return;
    ctx.clearRect(0, 0, job.canvasW, job.canvasH);
    ctx.drawImage(job.baseImg, 0, 0, job.canvasW, job.canvasH);
    const s = job.scale;
    const target = state.settings.targetLang;
    const fontStack =
      state.settings.fontFamily && state.settings.fontFamily !== 'auto'
        ? state.settings.fontFamily
        : MTR_LANGS.fontStackFor(target);

    for (const region of job.regions) {
      const x = region.box[0] * s;
      const y = region.box[1] * s;
      const w = region.box[2] * s;
      const h = region.box[3] * s;
      if (w < 8 || h < 8) continue;

      const bg = MTR_TEXTBOX.sampleBackground(ctx, x, y, w, h, job.canvasW, job.canvasH);
      ctx.save();
      roundRectPath(ctx, x, y, w, h, Math.min(12, Math.min(w, h) * 0.3));
      ctx.fillStyle = bg.uniform ? bg.color : withAlpha(bg.color, 0.9);
      ctx.fill();

      const insetX = Math.max(2, w * 0.05);
      const insetY = Math.max(2, h * 0.08);
      const fit = MTR_TEXTBOX.fitText(ctx, region.text, w - insetX * 2, h - insetY * 2, {
        fontStack,
        cjk: MTR_LANGS.isCjkTarget(target),
      });
      if (fit) {
        ctx.fillStyle = textColor(state.settings, bg);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const cx = x + w / 2;
        const totalH = fit.lines.length * fit.lineHeight;
        let ly = y + (h - totalH) / 2 + fit.lineHeight / 2;
        for (const line of fit.lines) {
          ctx.fillText(line, cx, ly);
          ly += fit.lineHeight;
        }
      }
      ctx.restore();
    }
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
  }

  function textColor(settings, bg) {
    if (settings.textColor === 'black') return '#141414';
    if (settings.textColor === 'white') return '#ffffff';
    return bg.dark ? '#ffffff' : '#141414';
  }

  function withAlpha(rgbColor, alpha) {
    return rgbColor.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  }

  // -------------------------------------------------------------------------
  // rAF loop: keeps every overlay canvas glued to its image
  // -------------------------------------------------------------------------

  function startLoop() {
    const tick = () => {
      if (!state.active) return;
      for (const job of state.jobs.values()) {
        if (!job.canvas) continue;
        if (!job.el.isConnected || state.showOriginal || job.status !== 'done') {
          job.canvas.style.display = 'none';
          continue;
        }
        const rect = contentRect(job.el);
        if (rect.width < 4 || rect.height < 4) {
          job.canvas.style.display = 'none';
          continue;
        }
        job.canvas.style.display = 'block';
        job.canvas.style.left = `${rect.x}px`;
        job.canvas.style.top = `${rect.y}px`;
        job.canvas.style.width = `${rect.width}px`;
        job.canvas.style.height = `${rect.height}px`;
      }
      state.rafId = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(tick);
  }

  function contentRect(el) {
    const rect = el.getBoundingClientRect();
    let nw = 0;
    let nh = 0;
    try {
      nw = el.naturalWidth;
      nh = el.naturalHeight;
    } catch (e) {
      /* detached */
    }
    if (!nw || !nh) return rect;
    const fit = getComputedStyle(el).objectFit || 'fill';
    if (fit === 'contain') {
      const boxAR = rect.width / rect.height;
      const imgAR = nw / nh;
      if (imgAR > boxAR) {
        const h2 = rect.width / imgAR;
        return { x: rect.x, y: rect.y + (rect.height - h2) / 2, width: rect.width, height: h2 };
      }
      const w2 = rect.height * imgAR;
      return { x: rect.x + (rect.width - w2) / 2, y: rect.y, width: w2, height: rect.height };
    }
    return rect; // fill / cover / none: layout box is the best approximation
  }

  // -------------------------------------------------------------------------
  // Status reporting
  // -------------------------------------------------------------------------

  function snapshot() {
    const jobs = Array.from(state.jobs.values());
    return {
      active: state.active,
      showOriginal: state.showOriginal,
      targetLang: state.settings ? state.settings.targetLang : null,
      url: location.href,
      total: jobs.length,
      done: jobs.filter((j) => j.status === 'done' || j.status === 'error').length,
      regions: jobs.reduce((acc, j) => acc + (j.regions ? j.regions.length : 0), 0),
      images: jobs.map((j) => ({
        src: j.src.length > 140 ? j.src.slice(0, 140) + '…' : j.src,
        status: j.status,
        phaseText: j.phaseText || '',
        error: j.error,
        warning: j.warning,
        regions: j.regions.length,
      })),
    };
  }

  function broadcastStatus() {
    try {
      chrome.runtime.sendMessage({ type: 'STATUS', status: snapshot() }).catch(() => {});
    } catch (e) {
      /* popup closed */
    }
  }

  function sendBadge(forced) {
    const snap = snapshot();
    const done = forced ? forced.done : snap.done;
    const total = forced ? forced.total : snap.total;
    try {
      chrome.runtime.sendMessage({ type: 'BADGE', done, total }).catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }
})();
