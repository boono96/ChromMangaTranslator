# Manga Translator (Chrome Extension)

A Manifest V3 Chrome extension that finds text in manga / webtoon images on any
web page, translates it, and draws the translation **back in place** on the
image — covering the original text with a background-matched patch and
auto-fitted, wrapped text.

```
┌──────────────┐  image URLs   ┌───────────────┐  bytes (data URL)
│ content.js   │ ────────────► │ background.js │ ─────────────────┐
│ (per tab)    │               │ service worker│                  ▼
│  discovers   │ ◄──────────── │  fetch +      │        ┌──────────────────┐
│  <img>, draws│   translations│  translate    │        │ offscreen doc    │
│  overlays    │               └───────────────┘        │ Tesseract.js OCR │
└──────────────┘                                        └──────────────────┘
```

## Features

- **One-click page translation** from the popup, or right-click → *Translate
  this image* / *Translate this page* / *Restore original page*.
- **OCR with Tesseract.js** (bundled locally, no external code): Japanese,
  English, Chinese (S/T), Korean, Russian, French, German, Spanish, Italian,
  Portuguese, Thai, Vietnamese, Indonesian.
- **Vertical CJK support**: in *Auto* direction mode every image gets two OCR
  passes — `jpn` with PSM 6 (max recall for sparse bubble text) and
  `jpn_vert` with PSM 5 (vertical columns) — merged by confidence with
  overlap/coverage rules so each region is translated by whichever model
  actually read it. Force *Horizontal* or *Vertical* to run a single pass.
- **Translation providers**: Google (free endpoint, no key), DeepL (API key),
  LibreTranslate, or any custom GET JSON endpoint.
- **Smart rendering**: OCR lines are grouped into bubbles/blocks, the
  background color is sampled around each block, the patch is drawn to match,
  and the translated text is auto-sized and wrapped to fit the bubble. Text
  color auto-contrasts (white on dark bubbles).
- **Overlay tracks the image** through scrolling, zooming, and layout changes
  (fixed-position canvas synced every animation frame, `object-fit: contain`
  aware).
- **Live progress**: per-image status in the popup, progress badge on the
  toolbar icon, lazy-loaded images picked up automatically while you scroll.
- **Caching**: OCR results and translations are cached per session
  (re-translating into another language skips OCR; repeated bubbles cost one
  request).
- **Restore anytime**: one click hides the overlays and un-touches the page —
  the original DOM is never modified except by appending overlay canvases.

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder
   (`ChromMangaTranslator/`).
4. Pin the extension, open any manga page, click the icon, pick your
   languages, and press **Translate page**.

The Tesseract runtime (`lib/`) is bundled, so no build step is required.
Language models (~10–25 MB each) are downloaded on first use from
`tessdata.projectnaptha.com` and cached in IndexedDB; see
[Offline language data](#offline-language-data) to avoid that.

## Usage

| Action | How |
| --- | --- |
| Translate the whole page | Popup → *Translate page* |
| Translate one image | Right-click the image → *Translate this image* |
| Peek at the original | Popup → *Show original* |
| Remove everything | Popup → *Restore originals* |
| Change target language / provider / rendering | Popup ⚙ or the options page |

## Options

- **Translation** — provider, DeepL key, LibreTranslate URL/key, or a custom
  endpoint template (`{q}`, `{sl}`, `{tl}`) plus a JSON response path
  (e.g. `data.translations.0.translatedText`).

  Note: the public `libretranslate.com` instance **requires an API key**
  (get one at portal.libretranslate.com). Without a key every request
  fails — the popup now shows the provider's error instead of silently
  keeping the original text. For unlimited use, self-host
  [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) and
  point the URL at it (e.g. `http://localhost:5000/translate`).
- **OCR** — confidence threshold, minimum image width, language data source.
- **Rendering** — text color mode, custom font stack.
- **Behavior** — auto-translate newly loaded (lazy) images, debug logging.

## Offline language data

By default traineddata is fetched from the CDN on demand. For fully offline
use, download `.traineddata.gz` files from
[tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) (e.g.
`jpn_vert.traineddata.gz`, `eng.traineddata.gz`) into `lib/tessdata/` and set
*Language data source* → **Local folder** in the options.

## Testing

- Layout/grouping/merge logic has Node unit tests (15 assertions):
  ```
  node test/textbox.test.js
  ```
- **End-to-end harness** (`tools/e2e/`, uses `puppeteer-core` + a real
  browser): loads the unpacked extension, wakes the service worker, triggers
  *Translate page*, polls per-image status, captures console output from the
  page, the SW, and the offscreen OCR document, exercises restore +
  re-translate, and saves a screenshot:
  ```
  cd tools/e2e
  npm install
  node run.mjs --langs jpn --target en --timeout 150 --shot shot.png
  # flags: --lab true runs a PSM comparison probe inside the OCR context;
  #        --cycle false skips the restore/re-translate phase;
  #        --provider libre --libreUrl … --libreKey … pins a translation
  #        provider (tools/e2e/mock_lt.py is a mock LibreTranslate on
  #        127.0.0.1:8124 — key "testkey" — for offline provider testing);
  #        --chrome <path> picks the browser (default: Edge)
  ```
  Note: Chrome ≥ 137 ignores `--load-extension` in branded builds, so the
  harness defaults to Edge (`msedge.exe`); Chrome for Testing also works.
- A visual test page with manga-style SVG images (horizontal JP, vertical JP,
  and English bubbles):
  ```
  python -m http.server 8000
  # then open http://localhost:8000/test/page.html and click Translate page
  ```
- Manual checklist: translate → show original → restore → re-translate;
  scroll a lazy-loading webtoon (new images translate as they appear);
  right-click single image; swap target language and re-translate (OCR cache).

## Architecture

```
manifest.json            MV3 manifest (offscreen, storage, contextMenus…)
background.js            SW: image fetch → dataURL, translation providers,
                         OCR routing, badge, context menus
offscreen/
  offscreen.html|js      DOM + WebAssembly context that owns one Tesseract
                         worker (self-closes after 5 idle minutes)
content/
  content.js             image discovery, pipeline, fixed overlay canvases
  textbox.js             pure logic: line grouping, wrap/fit, bg sampling
  overlay.css            overlay canvas isolation rules
shared/
  langs.js               language tables (OCR + target), font stacks
  settings.js            settings defaults / normalization / storage
popup/, options/         UI
lib/                     tesseract.min.js, worker.min.js, core/*.wasm.js
test/                    unit tests + visual test page
tools/gen_icons.py       icon generator (no dependencies)
```

Pipeline per image: **fetch** (in the SW, with credentials, to dodge canvas
tainting and CORS) → **downscale** to ≤2200 px JPEG → **OCR** (offscreen,
returns line boxes + confidence) → **scale boxes** back to natural size →
**group lines** into blocks per pass (row/column clustering, union-find;
vertical columns merge right-to-left) → **merge passes** (greedy by
confidence; coverage rules drop cross-pass garbage) → **translate** blocks
(concurrency 4, retry, cache, per-block fallback to original text) →
**render** (sample border color → cover patch → fit/wrap/center text).

### MV3 lifetime notes (learned the hard way — keep these!)

- **The service worker dies after ~30 s idle.** While a session is active the
  content script pings it every 20 s (`KEEPALIVE`); without that, the SW
  dies mid-OCR and the pending response is lost — the popup hangs on "ocr"
  forever. All long operations additionally race a hard timeout.
- **`img.decode()` never settles in offscreen documents** (no rendering
  pipeline). Always load images with `onload`/`onerror` there.
- OCR requests are **serialized** in the offscreen document so a language
  switch (`reinitialize`) can't race an in-flight `recognize`.
- The offscreen document self-closes after 5 idle minutes.

## Troubleshooting

- **"Image fetch failed (hotlink protection)"** — some CDNs require a page
  `Referer` header that the service worker cannot send. The image cannot be
  read by the extension on that site.
- **Nothing detected on a page** — the site may render pages into `<canvas>`
  (only `<img>` elements are supported) or use very stylized fonts. Try
  lowering the confidence threshold or the minimum image width.
- **Wrong reading order / garbage text** — try forcing *Text direction* to
  *Vertical* or *Horizontal* in the popup, or add the correct OCR language
  chip.
- **Wasm / OCR errors on strict-CSP sites** — OCR runs in the extension's
  offscreen document (extension CSP), so page CSP does not block it; if you
  still see errors, check the offscreen console via `chrome://extensions` →
  service worker logs.
- **file:// pages** — enable *Allow access to file URLs* for the extension on
  `chrome://extensions`, or serve the test page over HTTP.

## Privacy

Images are sent to the translation provider you choose (Google/DeepL/
LibreTranslate/custom) as plain text — never the image itself. OCR runs
entirely locally. The free Google endpoint is unofficial; for production use
pick a provider with an SLA.

## License

MIT — do what you like, no warranty. Manga artwork belongs to its authors;
use the tool responsibly and support official releases.
