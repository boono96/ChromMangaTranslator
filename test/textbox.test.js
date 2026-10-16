// Node unit tests for content/textbox.js (pure logic only).
// Run: node test/textbox.test.js
'use strict';

const path = require('path');
const MTR = require(path.join(__dirname, '..', 'content', 'textbox.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// Fake 2D context: monospace-ish measurement (0.55 * fontSize per char).
function fakeCtx() {
  let font = '';
  return {
    get font() {
      return font;
    },
    set font(v) {
      font = v;
    },
    measureText(text) {
      const size = parseFloat((font.match(/(\d+(?:\.\d+)?)px/) || [])[1] || '16');
      return { width: String(text).length * size * 0.55 };
    },
    getImageData() {
      return { data: new Uint8ClampedArray(4) };
    },
  };
}

// ---------------------------------------------------------------- groupLines

test('groupLines: merges two lines of one bubble into a block', () => {
  const lines = [
    { text: '今日はいい', conf: 90, bbox: [100, 100, 150, 30] },
    { text: '天気ですね', conf: 90, bbox: [100, 140, 150, 30] },
  ];
  const blocks = MTR.groupLines(lines, { minConfidence: 55, cjk: true, imageW: 1000, imageH: 1000 });
  assert(blocks.length === 1, `expected 1 block, got ${blocks.length}`);
  assert(blocks[0].text.replace(/\s/g, '') === '今日はいい天気ですね', `joined text wrong: ${blocks[0].text}`);
  assert(blocks[0].box[0] <= 100 && blocks[0].box[1] <= 100, 'box should cover lines');
});

test('groupLines: keeps distant bubbles separate', () => {
  const lines = [
    { text: 'left', conf: 90, bbox: [50, 100, 80, 24] },
    { text: 'right', conf: 90, bbox: [600, 500, 80, 24] },
  ];
  const blocks = MTR.groupLines(lines, { minConfidence: 55, cjk: false, imageW: 1000, imageH: 1000 });
  assert(blocks.length === 2, `expected 2 blocks, got ${blocks.length}`);
});

test('groupLines: filters low-confidence noise', () => {
  const lines = [
    { text: 'real text', conf: 90, bbox: [50, 100, 120, 24] },
    { text: 'zzz', conf: 10, bbox: [400, 100, 40, 24] },
  ];
  const blocks = MTR.groupLines(lines, { minConfidence: 55, cjk: false, imageW: 1000, imageH: 1000 });
  assert(blocks.length === 1, `expected 1 block, got ${blocks.length}`);
  assert(blocks[0].text === 'real text', `text wrong: ${blocks[0].text}`);
});

test('groupLines: orders vertical columns right-to-left', () => {
  const lines = [
    { text: 'は', conf: 90, bbox: [300, 100, 28, 120] }, // left column read second
    { text: 'こ', conf: 90, bbox: [360, 100, 28, 120] }, // right column read first
  ];
  const blocks = MTR.groupLines(lines, { minConfidence: 55, cjk: true, imageW: 1000, imageH: 1000 });
  assert(blocks.length === 1, `expected 1 block, got ${blocks.length}`);
  assert(blocks[0].text === 'こは', `vertical order wrong: ${blocks[0].text}`);
});

test('groupLines: merges words on the same row (horizontal text)', () => {
  const lines = [
    { text: 'It was a quiet', conf: 90, bbox: [380, 250, 180, 22] },
    { text: 'afternoon', conf: 88, bbox: [380, 282, 120, 22] },
  ];
  const blocks = MTR.groupLines(lines, { minConfidence: 55, cjk: false, imageW: 1000, imageH: 1000 });
  assert(blocks.length === 1, `expected 1 block, got ${blocks.length}`);
  assert(blocks[0].text === 'It was a quiet afternoon', `text wrong: ${blocks[0].text}`);
});

// ------------------------------------------------------------------ wrapText

test('wrapText: wraps long text into lines that respect maxWidth', () => {
  const ctx = fakeCtx();
  ctx.font = '600 20px sans-serif';
  const lines = MTR.wrapText(ctx, 'the quick brown fox jumps over the lazy dog', 150, false);
  for (const line of lines) {
    assert(ctx.measureText(line).width <= 150 + 0.01, `line too wide: "${line}"`);
  }
  assert(lines.join(' ').split(/\s+/).join(' ').length > 0, 'no words lost');
  const allWords = lines.join(' ').split(/\s+/);
  assert(allWords.length === 9, `expected 9 words, got ${allWords.length}: ${allWords}`);
});

test('wrapText: breakAnywhere splits CJK text char by char', () => {
  const ctx = fakeCtx();
  ctx.font = '600 20px sans-serif';
  const lines = MTR.wrapText(ctx, '今日はいい天気ですね', 70, true);
  assert(lines.length > 1, 'should wrap into multiple lines');
  assert(lines.join('') === '今日はいい天気ですね', 'characters lost in wrapping');
  for (const line of lines) {
    assert(line.length <= 7, `line too long: ${line}`);
  }
});

test('wrapText: hard-breaks a single oversized token', () => {
  const ctx = fakeCtx();
  ctx.font = '600 16px sans-serif';
  const lines = MTR.wrapText(ctx, 'supercalifragilisticexpialidocious', 60, false);
  assert(lines.length > 1, 'oversized token should be split');
});

// ------------------------------------------------------------------- fitText

test('fitText: returns a size whose wrapped block fits the box', () => {
  const ctx = fakeCtx();
  const fit = MTR.fitText(ctx, 'Hello world, this is a fairly long sentence.', 200, 120, {
    fontStack: 'sans-serif',
  });
  assert(fit, 'no fit returned');
  assert(fit.lines.length * fit.lineHeight <= 121, `too tall: ${fit.lines.length * fit.lineHeight}`);
  assert(fit.size >= 8, 'size below minimum');
});

test('fitText: clamps to minSize on tiny boxes', () => {
  const ctx = fakeCtx();
  const fit = MTR.fitText(ctx, 'Some long text that cannot fit', 40, 14, { fontStack: 'sans-serif' });
  assert(fit.size === 8, `expected min size 8, got ${fit.size}`);
});

test('fitText: empty text returns null', () => {
  const ctx = fakeCtx();
  assert(MTR.fitText(ctx, '   ', 100, 100, {}) === null, 'expected null for empty text');
});

// ---------------------------------------------------------- sampleBackground

test('sampleBackground: white border ring is detected as light and uniform', () => {
  const W = 60;
  const H = 60;
  const canvas = { width: W, height: H };
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const ctx = {
    getImageData(x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const src = ((y + yy) * W + (x + xx)) * 4;
          const dst = (yy * w + xx) * 4;
          out[dst] = data[src];
          out[dst + 1] = data[src + 1];
          out[dst + 2] = data[src + 2];
          out[dst + 3] = 255;
        }
      }
      return { data: out };
    },
  };
  const bg = MTR.sampleBackground(ctx, 20, 20, 20, 20, W, H);
  assert(bg.uniform, 'white ring should be uniform');
  assert(!bg.dark, 'white ring should not be dark');
  assert(bg.color === 'rgb(255,255,255)', `expected white, got ${bg.color}`);
});

test('sampleBackground: falls back to white when the ring is out of bounds', () => {
  const ctx = { getImageData: () => ({ data: new Uint8ClampedArray(0) }) };
  const bg = MTR.sampleBackground(ctx, 0, 0, 50, 50, 50, 50);
  assert(bg.color === 'rgb(255,255,255)', 'expected white fallback');
});

// ------------------------------------------------------- iou + mergeBlocks

test('iou: identical boxes = 1, disjoint = 0, partial = expected', () => {
  assert(MTR.iou([0, 0, 10, 10], [0, 0, 10, 10]) === 1, 'identical boxes should be 1');
  assert(MTR.iou([0, 0, 10, 10], [100, 100, 10, 10]) === 0, 'disjoint boxes should be 0');
  const v = MTR.iou([0, 0, 10, 10], [5, 0, 10, 10]); // 50 / 150
  assert(Math.abs(v - 1 / 3) < 0.001, `partial overlap should be 1/3, got ${v}`);
});

test('mergeBlocks: keeps higher-confidence block on overlap, keeps both apart', () => {
  const h = { box: [10, 10, 100, 40], text: 'horizontal win', conf: 90 };
  const v = { box: [14, 12, 96, 44], text: 'vertical loser', conf: 60 };
  const far = { box: [400, 400, 80, 30], text: 'far text', conf: 50 };
  const merged = MTR.mergeBlocks([[h], [v, far]]);
  assert(merged.length === 2, `expected 2 blocks, got ${merged.length}`);
  assert(merged.some((b) => b.text === 'horizontal win'), 'high-conf block should survive');
  assert(merged.some((b) => b.text === 'far text'), 'non-overlapping block should survive');
  assert(!merged.some((b) => b.text === 'vertical loser'), 'low-conf overlap should be dropped');
});

// ------------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
