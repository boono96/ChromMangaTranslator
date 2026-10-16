// Popup controller: language selection, translate/restore actions, live status.
(() => {
  'use strict';

  const el = {
    pageState: document.getElementById('pageState'),
    targetLang: document.getElementById('targetLang'),
    ocrChips: document.getElementById('ocrChips'),
    direction: document.getElementById('direction'),
    actionBtn: document.getElementById('actionBtn'),
    originalBtn: document.getElementById('originalBtn'),
    progress: document.getElementById('progress'),
    progressText: document.getElementById('progressText'),
    regionCount: document.getElementById('regionCount'),
    barFill: document.getElementById('barFill'),
    imageList: document.getElementById('imageList'),
    openOptions: document.getElementById('openOptions'),
  };

  let settings = null;
  let selectedOcr = [];
  let activeTabId = null;
  let activeTabUrl = null;
  let lastStatus = null;

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  init();

  async function init() {
    settings = await MTR_SETTINGS.get();
    selectedOcr = settings.sourceLangs.slice();

    for (const lang of MTR_LANGS.TARGET_LANGS) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.label;
      el.targetLang.appendChild(opt);
    }
    el.targetLang.value = settings.targetLang;
    el.direction.value = settings.direction;

    renderChips();

    el.targetLang.addEventListener('change', persistAndApply);
    el.direction.addEventListener('change', persistAndApply);

    el.actionBtn.addEventListener('click', onAction);
    el.originalBtn.addEventListener('click', onToggleOriginal);
    el.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'STATUS' && msg.status) {
        // Only show updates coming from the tab this popup is attached to.
        if (activeTabUrl && pageKey(msg.status.url) !== pageKey(activeTabUrl)) return;
        lastStatus = msg.status;
        renderStatus(msg.status);
      }
    });

    const tab = await getActiveTab();
    if (!tab || !/^https?:/i.test(tab.url || '')) {
      el.pageState.textContent = 'Open a manga page in this tab';
      return;
    }
    activeTabId = tab.id;
    activeTabUrl = tab.url;
    chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        el.pageState.textContent = 'Open a manga page in this tab';
        return;
      }
      lastStatus = res.status;
      renderStatus(res.status);
    });
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
        resolve(tabs && tabs[0])
      );
    });
  }

  function pageKey(url) {
    return String(url || '').split('#')[0];
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  function renderChips() {
    el.ocrChips.textContent = '';
    for (const lang of MTR_LANGS.OCR_LANGS) {
      const chip = document.createElement('button');
      chip.className = 'chip' + (selectedOcr.includes(lang.code) ? ' on' : '');
      chip.textContent = lang.label;
      chip.addEventListener('click', () => {
        const idx = selectedOcr.indexOf(lang.code);
        if (idx >= 0) {
          if (selectedOcr.length === 1) return; // keep at least one
          selectedOcr.splice(idx, 1);
        } else {
          selectedOcr.push(lang.code);
        }
        chip.classList.toggle('on', selectedOcr.includes(lang.code));
        persistAndApply();
      });
      el.ocrChips.appendChild(chip);
    }
  }

  async function persistAndApply() {
    settings.targetLang = el.targetLang.value;
    settings.direction = el.direction.value;
    settings.sourceLangs = selectedOcr.slice();
    await MTR_SETTINGS.save(settings);
  }

  async function onAction() {
    if (!activeTabId) return;
    await persistAndApply();
    if (lastStatus && lastStatus.active) {
      chrome.tabs.sendMessage(activeTabId, { type: 'RESTORE_PAGE' }, () => {
        void chrome.runtime.lastError;
      });
      el.actionBtn.textContent = 'Translate page';
      el.actionBtn.classList.remove('restore');
    } else {
      chrome.tabs.sendMessage(activeTabId, { type: 'TRANSLATE_PAGE' }, () => {
        void chrome.runtime.lastError;
      });
      el.actionBtn.textContent = 'Restore originals';
      el.actionBtn.classList.add('restore');
      el.pageState.textContent = 'Working…';
    }
  }

  function onToggleOriginal() {
    if (!activeTabId || !lastStatus) return;
    const msgType = lastStatus.showOriginal ? 'SHOW_TRANSLATION' : 'SHOW_ORIGINAL';
    chrome.tabs.sendMessage(activeTabId, { type: msgType }, () => {
      void chrome.runtime.lastError;
    });
    setTimeout(refreshStatus, 120);
  }

  function refreshStatus() {
    if (!activeTabId) return;
    chrome.tabs.sendMessage(activeTabId, { type: 'GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) return;
      lastStatus = res.status;
      renderStatus(res.status);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderStatus(status) {
    const active = !!status.active;
    el.actionBtn.disabled = false;

    if (active) {
      el.actionBtn.textContent = 'Restore originals';
      el.actionBtn.classList.add('restore');
      el.originalBtn.classList.toggle('hidden', false);
      el.originalBtn.textContent = status.showOriginal
        ? 'Show translation'
        : 'Show original';
    } else {
      el.actionBtn.textContent = 'Translate page';
      el.actionBtn.classList.remove('restore');
      el.originalBtn.classList.add('hidden');
    }

    const busyCount = status.images
      ? status.images.filter((i) => !['done', 'error'].includes(i.status)).length
      : 0;
    if (active) {
      el.pageState.textContent =
        busyCount > 0
          ? `Translating… (${busyCount} in progress)`
          : `${status.regions} text region(s) translated`;
    } else {
      el.pageState.textContent = status.total
        ? 'Session restored'
        : 'Ready';
    }

    el.progress.classList.toggle('hidden', !active || status.total === 0);
    if (active && status.total > 0) {
      el.progressText.textContent = `${status.done} / ${status.total} images`;
      el.regionCount.textContent = status.regions ? `${status.regions} regions` : '';
      el.barFill.style.width = `${Math.round((status.done / status.total) * 100)}%`;
      el.barFill.style.background = status.done === status.total ? 'var(--ok)' : 'var(--accent)';

      el.imageList.textContent = '';
      for (const img of status.images) {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        if (img.status === 'done') dot.classList.add('done');
        else if (img.status === 'error') dot.classList.add('error');
        else dot.classList.add('busy');
        li.appendChild(dot);

        const label = document.createElement('span');
        label.className = 'imgLabel';
        label.textContent = describeImage(img);
        label.title = img.src;
        li.appendChild(label);

        if (img.error) {
          const err = document.createElement('span');
          err.className = 'errorText';
          err.textContent = img.error;
          err.title = img.error;
          li.appendChild(err);
        } else if (img.regions) {
          const n = document.createElement('span');
          n.textContent = `${img.regions}`;
          n.style.color = 'var(--ok)';
          li.appendChild(n);
        }
        el.imageList.appendChild(li);
      }
    }
  }

  function describeImage(img) {
    if (img.phaseText && !['done', 'error'].includes(img.status)) {
      return `${img.status} — ${img.phaseText}`;
    }
    try {
      const u = new URL(img.src);
      return u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    } catch (e) {
      return img.src.startsWith('data:') ? 'inline image' : img.src.slice(0, 60);
    }
  }
})();
