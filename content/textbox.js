// Pure text-layout helpers: OCR line grouping, text wrapping/fitting, and
// background color sampling. No extension APIs — testable from Node.
(function (global) {
  'use strict';

  // --------------------------------------------------------------------------
  // Group OCR lines into text blocks (bubbles / caption boxes)
  // --------------------------------------------------------------------------

  // lines: [{text, conf, bbox:[x,y,w,h]}] in one common coordinate space.
  // opts: {minConfidence, cjk, imageW, imageH}
  function groupLines(lines, opts) {
    opts = opts || {};
    const minConf = opts.minConfidence != null ? opts.minConfidence : 55;
    const cand = lines.filter((l) => {
      if (!l || !l.text || !l.text.trim()) return false;
      if (l.conf < minConf) return false;
      const [x, y, w, h] = l.bbox;
      if (!(w >= 6 && h >= 6)) return false;
      return true;
    });
    if (cand.length === 0) return [];

    const sortedH = cand.map((l) => l.bbox[3]).slice().sort((a, b) => a - b);
    const sortedW = cand.map((l) => l.bbox[2]).slice().sort((a, b) => a - b);
    const medH = sortedH[Math.floor(sortedH.length / 2)];
    const medW = sortedW[Math.floor(sortedW.length / 2)];
    // Tall, narrow lines indicate vertical CJK text columns.
    const vertical = medH > medW * 1.6;

    // Union-find clustering.
    const parent = cand.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (i, j) => {
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    };

    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        if (linesBelongTogether(cand[i], cand[j], medH, medW, vertical)) union(i, j);
      }
    }

    const groups = new Map();
    cand.forEach((l, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(l);
    });

    const blocks = [];
    for (const groupLinesArr of groups.values()) {
      const block = buildBlock(groupLinesArr, medH, medW, vertical, opts);
      if (block) blocks.push(block);
    }
    // Drop blocks fully contained inside another block (rare OCR double-detects).
    return blocks.filter((b, i) => !blocks.some((o, j) => j !== i && containedIn(b.box, o.box)));
  }

  function linesBelongTogether(a, b, medH, medW, vertical) {
    const [ax, ay, aw, ah] = a.bbox;
    const [bx, by, bw, bh] = b.bbox;
    const aCx = ax + aw / 2;
    const aCy = ay + ah / 2;
    const bCx = bx + bw / 2;
    const bCy = by + bh / 2;

    if (vertical) {
      // Columns read right-to-left: merge when horizontally adjacent
      // and vertically overlapping.
      const horizGap = Math.max(0, Math.max(ax, bx) - Math.min(ax + aw, bx + bw));
      const vertOverlap = Math.min(ay + ah, by + bh) - Math.max(ay, by);
      return horizGap <= medW * 1.6 && vertOverlap >= Math.min(ah, bh) * 0.15;
    }

    // Same visual row (horizontal text).
    const rowGap = Math.abs(aCy - bCy);
    const horizGap = Math.max(0, Math.max(ax, bx) - Math.min(ax + aw, bx + bw));
    if (rowGap <= medH * 0.75 && horizGap <= medH * 2.6) return true;

    // Stacked lines inside one bubble.
    const vertGap = Math.max(0, Math.max(ay, by) - Math.min(ay + ah, by + bh));
    const horizOverlap = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
    const overlapRatio = horizOverlap / Math.max(1, Math.min(aw, bw));
    if (vertGap <= medH * 1.6 && overlapRatio >= 0.2) return true;

    return false;
  }

  function buildBlock(group, medH, medW, vertical, opts) {
    // Decide reading order per block, not per page: a block made of tall
    // narrow lines is a vertical CJK column group (read right-to-left),
    // even on a page classified as horizontal (and vice versa).
    const tallLines = group.filter((l) => l.bbox[3] > l.bbox[2] * 1.2).length;
    const blockVertical = tallLines > group.length / 2;

    const sorted = group.slice().sort((a, b) => {
      if (blockVertical) return b.bbox[0] - a.bbox[0] || a.bbox[1] - b.bbox[1];
      if (Math.abs(a.bbox[1] - b.bbox[1]) > medH * 0.6) return a.bbox[1] - b.bbox[1];
      return a.bbox[0] - b.bbox[0];
    });

    const joiner = blockVertical || opts.cjk ? '' : ' ';
    const text = sorted.map((l) => l.text.trim()).join(joiner).trim();
    if (!text) return null;
    const conf = sorted.reduce((acc, l) => acc + (l.conf || 0), 0) / sorted.length;

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of sorted) {
      const [x, y, w, h] = l.bbox;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w);
      y1 = Math.max(y1, y + h);
    }

    const padX = blockVertical ? Math.max(5, medW * 0.6) : Math.max(6, medH * 0.3);
    const padY = blockVertical ? Math.max(5, medH * 0.15) : Math.max(6, medH * 0.25);
    x0 -= padX;
    y0 -= padY;
    x1 += padX;
    y1 += padY;

    if (opts.imageW && opts.imageH) {
      x0 = Math.max(0, x0);
      y0 = Math.max(0, y0);
      x1 = Math.min(opts.imageW, x1);
      y1 = Math.min(opts.imageH, y1);
    }
    const box = [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)];
    if (box[2] < 8 || box[3] < 8) return null;
    return { box, text, conf, lineCount: sorted.length, vertical: blockVertical };
  }

  // Intersection-over-union of two [x,y,w,h] boxes.
  function iou(a, b) {
    const inter = intersectionArea(a, b);
    if (inter === 0) return 0;
    const union = a[2] * a[3] + b[2] * b[3] - inter;
    return union > 0 ? inter / union : 0;
  }

  function intersectionArea(a, b) {
    const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    return ix * iy;
  }

  // Merge block lists from multiple OCR passes (e.g. horizontal + vertical).
  // Greedy by confidence: a block is dropped when the already-kept
  // higher-confidence blocks cover at least `threshold` of its area.
  // Additionally, multi-line horizontal blocks that a vertical-pass block
  // largely covers are dropped: the horizontal model reads vertical CJK
  // columns as rows of interleaved garbage, and the vertical model is
  // authoritative in those regions.
  function mergeBlocks(lists, threshold = 0.5) {
    const all = lists.flat().filter(Boolean);
    if (all.length <= 1) return all;
    all.sort((a, b) => (b.conf || 0) - (a.conf || 0));
    const kept = [];
    const coveredRatio = (block, pool) => {
      const area = block.box[2] * block.box[3];
      if (area <= 0) return 1;
      let covered = 0;
      for (const k of pool) covered += intersectionArea(block.box, k.box);
      return covered / area;
    };
    for (const block of all) {
      if (coveredRatio(block, kept) >= threshold) continue;
      // A vertical-pass block that is wider than tall is the vertical model
      // misreading horizontal text, not a real column.
      if (block.pass === 'v' && block.box[2] > block.box[3] * 1.15) continue;
      if (
        block.pass === 'h' &&
        (block.lineCount || 1) >= 2 &&
        coveredRatio(block, kept.filter((k) => k.pass === 'v')) >= 0.35
      ) {
        continue;
      }
      kept.push(block);
    }
    return kept;
  }

  function containedIn(inner, outer) {
    return (
      inner[0] >= outer[0] - 2 &&
      inner[1] >= outer[1] - 2 &&
      inner[0] + inner[2] <= outer[0] + outer[2] + 2 &&
      inner[1] + inner[3] <= outer[1] + outer[3] + 2
    );
  }

  // --------------------------------------------------------------------------
  // Text wrapping + fitting
  // --------------------------------------------------------------------------

  function wrapText(ctx, text, maxWidth, breakAnywhere) {
    maxWidth = Math.max(1, maxWidth);
    const lines = [];
    let current = '';
    const pushCurrent = () => {
      if (current) {
        lines.push(current);
        current = '';
      }
    };

    const tokens = breakAnywhere ? Array.from(text) : text.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const sep = current && !breakAnywhere ? ' ' : '';
      const candidate = current + sep + tok;
      if (measureWidth(ctx, candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      pushCurrent();
      // Hard-break tokens that alone exceed the line width.
      let rest = tok;
      while (measureWidth(ctx, rest) > maxWidth && rest.length > 1) {
        let lo = 1;
        let hi = rest.length;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (measureWidth(ctx, rest.slice(0, mid)) <= maxWidth) lo = mid;
          else hi = mid - 1;
        }
        lines.push(rest.slice(0, lo));
        rest = rest.slice(lo);
      }
      current = rest;
    }
    pushCurrent();
    return lines.length ? lines : [''];
  }

  function measureWidth(ctx, text) {
    return ctx.measureText(text).width;
  }

  // Find the largest font size whose wrapped text fits in boxW x boxH.
  function fitText(ctx, text, boxW, boxH, opts) {
    opts = opts || {};
    const fontStack = opts.fontStack || 'sans-serif';
    const weight = opts.weight || 600;
    const cjk = !!opts.cjk;
    const minSize = Math.max(7, opts.minSize || 8);
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) return null;

    let size = Math.max(minSize, Math.floor(Math.min(boxH, boxW, 220)));
    for (;;) {
      ctx.font = `${weight} ${size}px ${fontStack}`;
      const lines = wrapText(ctx, clean, boxW, cjk);
      const lineHeight = Math.round(size * 1.2);
      if (lines.length * lineHeight <= boxH + 1) {
        return { size, lineHeight, lines };
      }
      if (size <= minSize) {
        return { size: minSize, lineHeight: Math.round(minSize * 1.2), lines };
      }
      size = Math.max(minSize, Math.floor(size * 0.86));
    }
  }

  // --------------------------------------------------------------------------
  // Background sampling for cover patches
  // --------------------------------------------------------------------------

  // Samples a ring of pixels just outside the box and returns the median
  // border color plus simple statistics. (x,y,w,h) in canvas coordinates.
  function sampleBackground(ctx, x, y, w, h, imgW, imgH) {
    const samples = [];
    const thickness = Math.max(2, Math.round(Math.min(w, h) * 0.12));
    const clampX0 = Math.max(0, Math.floor(x - thickness));
    const clampY0 = Math.max(0, Math.floor(y - thickness));
    const clampX1 = Math.min(imgW - 1, Math.ceil(x + w + thickness));
    const clampY1 = Math.min(imgH - 1, Math.ceil(y + h + thickness));
    const bx0 = Math.max(0, Math.floor(x));
    const by0 = Math.max(0, Math.floor(y));
    const bx1 = Math.min(imgW, Math.ceil(x + w));
    const by1 = Math.min(imgH, Math.ceil(y + h));

    const pushStrip = (sx0, sy0, sx1, sy1) => {
      if (sx1 <= sx0 || sy1 <= sy0) return;
      if (sx0 >= bx0 && sx1 <= bx1 && sy0 >= by0 && sy1 <= by1) return; // inside box
      const data = ctx.getImageData(sx0, sy0, sx1 - sx0, sy1 - sy0).data;
      for (let i = 0; i < data.length; i += 16) {
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    };

    pushStrip(clampX0, clampY0, clampX1, by0); // above
    pushStrip(clampX0, by1, clampX1, clampY1); // below
    pushStrip(clampX0, by0, bx0, by1);         // left
    pushStrip(bx1, by0, clampX1, by1);         // right

    if (samples.length === 0) {
      return { color: 'rgb(255,255,255)', dark: false, uniform: true };
    }

    const r = median(samples.map((s) => s[0]));
    const g = median(samples.map((s) => s[1]));
    const b = median(samples.map((s) => s[2]));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const devs = samples.map((s) => Math.abs(0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2] - lum));
    const uniform = median(devs) < 30;
    return {
      color: `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`,
      dark: lum < 110,
      uniform,
    };
  }

  function median(arr) {
    if (!arr.length) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  const MTR_TEXTBOX = { groupLines, wrapText, fitText, sampleBackground, median, iou, mergeBlocks };
  global.MTR_TEXTBOX = MTR_TEXTBOX;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MTR_TEXTBOX;
  }
})(typeof self !== 'undefined' ? self : globalThis);
