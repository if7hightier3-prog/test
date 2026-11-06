/* ============================================================
   TrueRedact — app.js
   100% client-side redaction. Rasterize, don't overlay.

   Pipeline for PDFs:
     pdf.js renders a page to canvas (text/vectors -> pixels)
     -> user drags boxes -> ctx.fillRect() burns black into pixel data
     -> canvas.toBlob('image/png') -> pdf-lib embeds PNG as full-page image
     -> output re-loaded with pdf.js + getTextContent() to VERIFY no text.

   Pipeline for images:
     decode -> canvas -> fillRect boxes -> canvas.toBlob('image/png')
     (re-encoding through canvas also strips EXIF, incl. GPS).

   No fetch(), no XHR, no analytics anywhere in this file. The only
   network use is the browser loading pdf.js / pdf-lib from CDN once.
   After that, everything works offline.
   ============================================================ */

'use strict';

/* ---------- pdf.js loader (dynamic ESM import, cached) ---------- */
const PDFJS_VERSION = '6.4.299';
const PDFJS_MODULE_URL =
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER_URL =
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

let pdfjsLibPromise = null;
function loadPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(/* @vite-ignore */ PDFJS_MODULE_URL)
      .then((lib) => {
        if (!lib || !lib.getDocument) throw new Error('pdf.js failed to load');
        // Cross-origin worker needs a module wrapper (required by pdf.js >= 4).
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        try {
          lib.GlobalWorkerOptions.workerPort = new Worker(
            new URL(PDFJS_WORKER_URL, PDFJS_MODULE_URL),
            { type: 'module' }
          );
        } catch (_) {
          /* fall back to workerSrc */
        }
        return lib;
      })
      .catch((err) => {
        pdfjsLibPromise = null;
        throw new Error(
          'Could not load the pdf.js library. If you are offline, reload this page once while online. (' +
            (err && err.message ? err.message : err) + ')'
        );
      });
  }
  return pdfjsLibPromise;
}

function getPdfLib() {
  if (!window.PDFLib || !window.PDFLib.PDFDocument) {
    throw new Error(
      'The pdf-lib library has not finished loading yet. Wait a moment and try again — if you are offline, reload this page once while online.'
    );
  }
  return window.PDFLib;
}

/* ---------- small DOM helpers ---------- */
const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  browseBtn: $('browseBtn'),
  fileInput: $('fileInput'),
  fileList: $('fileList'),
  workspace: $('workspace'),
  fileTabs: $('fileTabs'),
  removeFileBtn: $('removeFileBtn'),
  pageNav: $('pageNav'),
  prevPageBtn: $('prevPageBtn'),
  nextPageBtn: $('nextPageBtn'),
  pageIndicator: $('pageIndicator'),
  undoBoxBtn: $('undoBoxBtn'),
  clearBoxesBtn: $('clearBoxesBtn'),
  canvasScroll: $('canvasScroll'),
  canvasWrap: $('canvasWrap'),
  canvas: $('mainCanvas'),
  busyOverlay: $('busyOverlay'),
  busyText: $('busyText'),
  boxList: $('boxList'),
  boxListEmpty: $('boxListEmpty'),
  boxCountChip: $('boxCountChip'),
  applyBtn: $('applyBtn'),
  verifyPanel: $('verifyPanel'),
  downloadBlock: $('downloadBlock'),
  downloadLink: $('downloadLink'),
  outputSize: $('outputSize'),
  toastRegion: $('toastRegion'),
  netPill: $('netPill'),
};

const ctx = els.canvas.getContext('2d', { willReadFrequently: true });

/* ---------- constants ---------- */
const RENDER_SCALE = 2;              // pixels per CSS/PDF point (~144 DPI)
const MAX_CANVAS_SIDE = 8192;        // keep huge scans inside canvas limits
const MIN_BOX_PX = 4;                // ignore accidental single-pixel drags
const REDACT_CSS = '#e5484d';

/* ---------- session state ---------- */
const state = {
  files: [],          // DocEntry[]
  activeId: null,
  seq: 0,
  applying: false,
};

/* DocEntry shape:
{
  id, name, kind: 'pdf'|'image', ext, sizeBytes,
  arrayBuffer (pdf input, detached after build), blob (image input),
  pdfDoc (pdf.js doc), pages: [PageState],
  built: bool, outBlob: Blob|null, outName: string
}
PageState: { w,h (CSS px), cssScale, rendered:bool, canvas:HTMLCanvasElement,
             applied:bool, boxes:[{x,y,w,h}] (CSS px, relative to page) }
*/

/* ---------- utilities ---------- */
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function baseName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function toast(msg, type = 'warn', ms = 6000) {
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
  t.textContent = msg;
  els.toastRegion.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function showBusy(text) {
  els.busyText.textContent = text;
  els.busyOverlay.hidden = false;
}
function hideBusy() {
  els.busyOverlay.hidden = true;
}

function getActiveDoc() {
  return state.files.find((f) => f.id === state.activeId) || null;
}
function activePage() {
  const d = getActiveDoc();
  if (!d) return null;
  return d.pages[d.pageIndex] || null;
}

/* ---------- file intake ---------- */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

function classify(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (IMAGE_EXT.has(ext) || type.startsWith('image/')) return ext === 'gif' ? 'image' : 'image';
  return null;
}

async function handleFiles(list) {
  const files = Array.from(list || []);
  if (!files.length) return;
  let firstNewId = null;
  for (const file of files) {
    const kind = classify(file);
    if (!kind) {
      toast(`Unsupported file type: “${file.name}”. TrueRedact handles PDFs and images (PNG/JPG/WEBP/GIF/BMP).`, 'error');
      continue;
    }
    if (file.size === 0) {
      toast(`“${file.name}” is empty — it looks like a corrupt or unfinished file.`, 'error');
      continue;
    }
    try {
      const entry = await addFile(file, kind);
      if (!firstNewId) firstNewId = entry.id;
    } catch (err) {
      toast(`Could not open “${file.name}”: ${err && err.message ? err.message : err}`, 'error');
    }
  }
  if (firstNewId) selectFile(firstNewId);
  renderFileList();
}

async function addFile(file, kind) {
  const buffer = await file.arrayBuffer(); // throws on unreadable/corrupt disk file
  const id = ++state.seq;
  const entry = {
    id,
    name: file.name,
    kind,
    ext: kind === 'pdf' ? 'pdf' : 'png', // image output is always re-encoded PNG
    sizeBytes: file.size,
    pages: [],
    pageIndex: 0,
    built: false,
    outBlob: null,
    outName: '',
    pdfDoc: null,
    arrayBuffer: kind === 'pdf' ? buffer : null,
    blob: kind === 'image' ? file : null,
  };

  if (kind === 'pdf') {
    const pdfjs = await loadPdfJs();
    let doc;
    try {
      // Transfer the buffer (pdf.js may detach it). A fresh copy stays for rebuilds.
      doc = await pdfjs.getDocument({ data: buffer }).promise;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/password|encrypt/i.test(msg)) {
        throw new Error('this PDF is password-protected. Unlock it first — TrueRedact does not handle encrypted PDFs.');
      }
      throw new Error('this PDF could not be parsed — it may be corrupt. (' + msg + ')');
    }
    entry.pdfDoc = doc;
    const n = doc.numPages;
    // Probe every page up front so broken pages fail loudly at load time.
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      let cssScale = Math.min(1, (MAX_CANVAS_SIDE - 1) / vp1.width, (MAX_CANVAS_SIDE - 1) / vp1.height);
      cssScale = Math.max(cssScale, 0.05);
      entry.pages.push({
        w: Math.floor(vp1.width * cssScale),
        h: Math.floor(vp1.height * cssScale),
        cssScale,
        rendered: false,
        canvas: null,
        applied: false,
        boxes: [],
      });
      page.cleanup();
    }
  } else {
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (_) {
      // Fallback path gives clearer errors for some formats.
      const url = URL.createObjectURL(file);
      try {
        bmp = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('the image data appears corrupt or unsupported by this browser'));
          img.src = url;
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    }
    let cssScale = Math.min(1, (MAX_CANVAS_SIDE - 1) / bmp.width, (MAX_CANVAS_SIDE - 1) / bmp.height);
    cssScale = Math.max(cssScale, 0.02);
    entry.pages.push({
      w: Math.floor(bmp.width * cssScale),
      h: Math.floor(bmp.height * cssScale),
      cssScale,
      rendered: false,
      canvas: null,
      applied: false,
      boxes: [],
      _bitmap: bmp,
    });
  }

  state.files.push(entry);
  return entry;
}

function renderFileList() {
  els.fileList.textContent = '';
  for (const d of state.files) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'fl-icon';
    icon.textContent = d.kind === 'pdf' ? '📄' : '🖼️';
    const nm = document.createElement('span');
    nm.className = 'fl-name';
    nm.textContent = d.name;
    const meta = document.createElement('span');
    meta.className = 'fl-meta';
    const pagesTxt = d.kind === 'pdf' ? `${d.pages.length} page${d.pages.length === 1 ? '' : 's'} · ` : '';
    meta.textContent = pagesTxt + fmtBytes(d.sizeBytes) + (d.built ? ' · ✓ redacted' : '');
    li.append(icon, nm, meta);
    els.fileList.appendChild(li);
  }
}

/* ---------- selection / tabs ---------- */
function selectFile(id) {
  const d = getActiveDoc();
  if (d && d.kind === 'pdf' && d.pdfDoc) {
    // Keep buffers alive until export; nothing sensitive here beyond the doc itself.
  }
  state.activeId = id;
  els.workspace.hidden = !id;
  renderTabs();
  const doc = getActiveDoc();
  if (doc) resetUiForDoc(doc);
}

function renderTabs() {
  els.fileTabs.textContent = '';
  for (const d of state.files) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file-tab' + (d.id === state.activeId ? ' active' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', d.id === state.activeId ? 'true' : 'false');
    b.title = d.name;
    const mark = d.built ? '<span class="ft-done">✓ </span>' : '';
    b.innerHTML = mark + escapeHtml(shortName(d.name));
    b.addEventListener('click', () => selectFile(d.id));
    els.fileTabs.appendChild(b);
  }
}

function shortName(n) {
  return n.length > 26 ? n.slice(0, 10) + '…' + n.slice(-12) : n;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resetUiForDoc(doc) {
  updatePageNav();
  renderBoxList();
  els.verifyPanel.hidden = true;
  els.verifyPanel.className = 'verify-panel';
  els.verifyPanel.textContent = '';
  if (doc.built && doc.outBlob) {
    showDownload(doc);
    showVerificationResult(doc);
  } else {
    els.downloadBlock.hidden = true;
    releaseDownloadUrl();
  }
  updateApplyEnabled();
  renderCurrentPage();
}

/* ---------- page navigation ---------- */
function updatePageNav() {
  const d = getActiveDoc();
  const multi = !!d && d.pages.length > 1;
  els.pageNav.style.visibility = multi ? 'visible' : 'hidden';
  if (!d) return;
  els.pageIndicator.textContent = `Page ${d.pageIndex + 1} / ${d.pages.length}`;
  els.prevPageBtn.disabled = d.pageIndex === 0;
  els.nextPageBtn.disabled = d.pageIndex >= d.pages.length - 1;
}

function gotoPage(delta) {
  const d = getActiveDoc();
  if (!d) return;
  const next = Math.min(Math.max(d.pageIndex + delta, 0), d.pages.length - 1);
  if (next === d.pageIndex) return;
  d.pageIndex = next;
  updatePageNav();
  renderBoxList();
  renderCurrentPage();
}

/* ---------- rendering ---------- */
async function renderCurrentPage() {
  const d = getActiveDoc();
  if (!d) return;
  const pg = d.pages[d.pageIndex];
  fitCanvasCss(pg);
  if (pg.rendered) {
    blit(pg);
    drawOverlays();
    return;
  }
  showBusy('Rendering page ' + (d.pageIndex + 1) + '…');
  try {
    const c = document.createElement('canvas');
    const devW = Math.max(1, Math.round(pg.w * RENDER_SCALE));
    const devH = Math.max(1, Math.round(pg.h * RENDER_SCALE));
    c.width = devW;
    c.height = devH;
    const cctx = c.getContext('2d', { willReadFrequently: true });

    if (d.kind === 'pdf') {
      const pdfjs = await loadPdfJs();
      const page = await d.pdfDoc.getPage(d.pageIndex + 1);
      const viewport = page.getViewport({ scale: pg.cssScale * RENDER_SCALE });
      await page.render({ canvasContext: cctx, viewport, canvas: c }).promise;
      page.cleanup();
    } else {
      cctx.fillStyle = '#ffffff';
      cctx.fillRect(0, 0, devW, devH);
      cctx.drawImage(pg._bitmap, 0, 0, devW, devH);
    }
    pg.canvas = c;
    pg.rendered = true;
    blit(pg);
    drawOverlays();
  } catch (err) {
    toast(`Failed to render page ${d.pageIndex + 1}: ${(err && err.message) || err}`, 'error');
  } finally {
    hideBusy();
  }
}

function fitCanvasCss(pg) {
  const avail = els.canvasScroll.clientWidth - 36; // padding
  const targetW = Math.max(280, Math.min(pg.w, avail));
  els.canvas.style.width = targetW + 'px';
  els.canvas.style.height = pg.h * (targetW / pg.w) + 'px';
}

function blit(pg) {
  els.canvas.width = pg.canvas.width;
  els.canvas.height = pg.canvas.height;
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.drawImage(pg.canvas, 0, 0);
}

/* CSS->display factor for the live canvas */
function displayFactor() {
  return els.canvas.clientWidth / els.canvas.width;
}

/* Coordinate spaces:
   - stored boxes & drag coords: "render-CSS" space (pg.w x pg.h)
   - canvas device px = render-CSS * RENDER_SCALE
*/
function eventToRenderPx(ev) {
  const rect = els.canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const k = els.canvas.width / rect.width; // display -> device
  return { x: sx * k / RENDER_SCALE, y: sy * k / RENDER_SCALE };
}

/* ---------- overlays (pending boxes + live drag) ---------- */
let drag = null; // {startX,startY,x,y} in render-CSS px

function drawOverlays() {
  const d = getActiveDoc();
  if (!d) return;
  const pg = d.pages[d.pageIndex];
  if (!pg.rendered) return;
  const s = RENDER_SCALE;
  ctx.save();
  for (const b of pg.boxes) {
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
    ctx.strokeStyle = REDACT_CSS;
    ctx.lineWidth = Math.max(2, 1.5 * s);
    ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
  }
  if (drag) {
    const r = normRect(drag.startX, drag.startY, drag.x, drag.y);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeStyle = REDACT_CSS;
    ctx.lineWidth = Math.max(2, 1.5 * s);
    ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function normRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/* ---------- pointer drawing ---------- */
els.canvas.addEventListener('pointerdown', (ev) => {
  const d = getActiveDoc();
  if (!d || d.built || state.applying || ev.button !== 0) return;
  const p = eventToRenderPx(ev);
  drag = { startX: p.x, startY: p.y, x: p.x, y: p.y };
  els.canvas.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});

els.canvas.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const p = eventToRenderPx(ev);
  drag.x = p.x;
  drag.y = p.y;
  drawOverlays();
});

function endDrag(ev) {
  if (!drag) return;
  const d = getActiveDoc();
  const pg = activePage();
  const r = normRect(drag.startX, drag.startY, drag.x, drag.y);
  drag = null;
  if (!d || !pg || d.built) { drawOverlays(); return; }
  if (r.w < MIN_BOX_PX || r.h < MIN_BOX_PX) { drawOverlays(); return; }
  // Clamp inside the page.
  r.x = Math.max(0, Math.min(r.x, pg.w));
  r.y = Math.max(0, Math.min(r.y, pg.h));
  r.w = Math.min(r.w, pg.w - r.x);
  r.h = Math.min(r.h, pg.h - r.y);
  if (r.w < MIN_BOX_PX || r.h < MIN_BOX_PX) { drawOverlays(); return; }
  pg.boxes.push(r);
  renderBoxList();
  drawOverlays();
  if (ev && ev.pointerId !== undefined && els.canvas.hasPointerCapture?.(ev.pointerId)) {
    try { els.canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
  }
}
els.canvas.addEventListener('pointerup', endDrag);
els.canvas.addEventListener('pointercancel', () => { drag = null; drawOverlays(); });

/* ---------- pending box list ---------- */
function totalPendingBoxes(d) {
  return d.pages.reduce((n, p) => n + p.boxes.length, 0);
}

function renderBoxList() {
  const d = getActiveDoc();
  els.boxList.textContent = '';
  if (!d) return;
  const pg = d.pages[d.pageIndex];
  let idx = 0;
  d.pages.forEach((p, pi) => {
    p.boxes.forEach((b, bi) => {
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = 'box-swatch';
      const loc = document.createElement('span');
      loc.className = 'box-loc';
      loc.textContent =
        (d.pages.length > 1 ? `p${pi + 1} · ` : '') +
        `${Math.round(b.w)}×${Math.round(b.h)} at (${Math.round(b.x)}, ${Math.round(b.y)})`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'box-remove';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => {
        p.boxes.splice(bi, 1);
        renderBoxList();
        drawOverlays();
        updateApplyEnabled();
      });
      li.append(sw, loc, rm);
      if (pi === d.pageIndex) li.style.borderColor = 'rgba(229,72,77,0.5)';
      els.boxList.appendChild(li);
      idx++;
    });
  });
  const n = totalPendingBoxes(d);
  els.boxCountChip.textContent = String(n);
  els.boxListEmpty.hidden = n > 0;
  updateApplyEnabled();
}

function updateApplyEnabled() {
  const d = getActiveDoc();
  const ok = !!d && !d.built && !state.applying && totalPendingBoxes(d) > 0;
  els.applyBtn.disabled = !ok;
  if (d && d.built) {
    els.applyBtn.textContent = 'Redactions applied';
    els.applyBtn.disabled = true;
  } else {
    els.applyBtn.textContent = 'Apply Redactions';
  }
}

/* ---------- THE CORE: apply redactions ---------- */
async function applyRedactions() {
  const d = getActiveDoc();
  if (!d || d.built || state.applying) return;
  if (totalPendingBoxes(d) === 0) {
    toast('Draw at least one redaction box before applying.', 'warn');
    return;
  }
  state.applying = true;
  updateApplyEnabled();
  showBusy(d.kind === 'pdf' ? 'Burning boxes into pixels and rebuilding the PDF…' : 'Burning boxes into pixels and re-encoding…');
  setVerify('checking', 'Applying…', 'Painting solid black directly into each page’s pixel data.');

  try {
    // 1. Burn black rectangles into every flagged page's pixel data.
    //    (fillRect writes the actual pixels — no separate object exists afterwards.)
    for (let pi = 0; pi < d.pages.length; pi++) {
      const pg = d.pages[pi];
      if (!pg.boxes.length) continue;
      if (!pg.rendered) await renderPageQuietly(d, pi);
      const pctx = pg.canvas.getContext('2d', { willReadFrequently: true });
      pctx.fillStyle = '#000000';
      for (const b of pg.boxes) {
        pctx.fillRect(
          Math.floor(b.x * RENDER_SCALE),
          Math.floor(b.y * RENDER_SCALE),
          Math.ceil(b.w * RENDER_SCALE),
          Math.ceil(b.h * RENDER_SCALE)
        );
      }
      pg.applied = true;
    }

    // 2. Rebuild the output file from pixels only.
    if (d.kind === 'pdf') {
      await rebuildPdf(d);
    } else {
      await rebuildImage(d);
    }

    d.built = true;
    els.canvas.style.cursor = 'default';

    // 3. Show flattened result.
    blit(activePage());
    renderTabs();
    renderFileList();
    showDownload(d);

    // 4. Built-in verification pass.
    await runVerification(d);
  } catch (err) {
    console.error(err);
    setVerify('bad', '✕ Something went wrong', String((err && err.message) || err));
    toast('Applying redactions failed: ' + ((err && err.message) || err), 'error');
  } finally {
    state.applying = false;
    hideBusy();
    updateApplyEnabled();
  }
}

async function renderPageQuietly(d, pi) {
  const pg = d.pages[pi];
  if (pg.rendered) return;
  const pdfjs = await loadPdfJs();
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(pg.w * RENDER_SCALE));
  c.height = Math.max(1, Math.round(pg.h * RENDER_SCALE));
  const cctx = c.getContext('2d', { willReadFrequently: true });
  const page = await d.pdfDoc.getPage(pi + 1);
  const viewport = page.getViewport({ scale: pg.cssScale * RENDER_SCALE });
  await page.render({ canvasContext: cctx, viewport, canvas: c }).promise;
  page.cleanup();
  pg.canvas = c;
  pg.rendered = true;
}

/* Encode a page canvas to PNG bytes via toBlob (as specified). */
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('canvas.toBlob() returned null — the page may exceed the browser’s canvas memory limit.'));
      else resolve(blob);
    }, 'image/png');
  });
}

async function rebuildPdf(d) {
  const { PDFDocument } = getPdfLib();
  const out = await PDFDocument.create();
  for (let pi = 0; pi < d.pages.length; pi++) {
    const pg = d.pages[pi];
    if (pg.applied) {
      // Flattened page: original dimensions, full-page PNG image.
      const pngBlob = await canvasToPngBlob(pg.canvas);
      const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
      const img = await out.embedPng(pngBytes);
      const page = out.addPage([pg.w / pg.cssScale, pg.h / pg.cssScale]);
      page.drawImage(img, { x: 0, y: 0, width: pg.w / pg.cssScale, height: pg.h / pg.cssScale });
    } else {
      // Untouched page: copy the ORIGINAL page (keeps selectable text, fonts, size).
      const [copied] = await out.copyPages(d.pdfDocOriginal || (d.pdfDocOriginal = await originalPdfLibDoc(d)), [pi]);
      out.addPage(copied);
    }
  }
  out.setProducer('TrueRedact (client-side rasterizing redaction)');
  out.setCreator('TrueRedact');
  const bytes = await out.save();
  d.outBlob = new Blob([bytes], { type: 'application/pdf' });
  d.outName = baseName(d.name) + '-redacted.pdf';
}

async function originalPdfLibDoc(d) {
  const { PDFDocument } = getPdfLib();
  const buf = d.arrayBuffer
    ? d.arrayBuffer.slice(0) // fresh copy: pdf-lib may transfer/detach it
    : null;
  if (!buf) throw new Error('The original PDF data is no longer available in memory. Re-add the file.');
  try {
    return await PDFDocument.load(buf, { updateMetadata: false });
  } catch (err) {
    throw new Error('Re-reading the source PDF failed — it may be corrupt. ' + ((err && err.message) || err));
  }
}

async function rebuildImage(d) {
  const pg = d.pages[0];
  d.outBlob = await canvasToPngBlob(pg.canvas); // re-encode = EXIF/GPS stripped
  d.outName = baseName(d.name) + '-redacted.png';
}

/* ---------- verification pass ---------- */
async function runVerification(d) {
  setVerify('checking', 'Verifying…', 'Re-loading the generated file with pdf.js and extracting text from every redacted page.');
  try {
    const redactedIdx = d.pages.map((p, i) => (p.applied ? i : -1)).filter((i) => i >= 0);
    const results = [];
    if (d.kind === 'pdf') {
      const pdfjs = await loadPdfJs();
      const bytes = new Uint8Array(await d.outBlob.arrayBuffer());
      const check = await pdfjs.getDocument({ data: bytes }).promise;
      for (let i = 1; i <= check.numPages; i++) {
        const page = await check.getPage(i);
        const tc = await page.getTextContent();
        const items = (tc.items || []).filter(
          (it) => typeof it.str === 'string' && it.str.trim().length > 0
        );
        results.push({ page: i, count: items.length, redacted: redactedIdx.includes(i - 1) });
      }
      check.destroy();
    } else {
      // Images contain no text layer by construction; sanity-check the PNG signature.
      const head = new Uint8Array(await d.outBlob.slice(0, 8).arrayBuffer());
      const sigOk = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      results.push({ page: 1, count: 0, redacted: true, sigOk });
      if (!sigOk) throw new Error('Output PNG failed its format sanity check.');
    }

    d.verifyResults = results;
    showVerificationResult(d);
  } catch (err) {
    d.verifyResults = [{ error: String((err && err.message) || err) }];
    setVerify(
      'bad',
      '✕ Verification could not run',
      'Do NOT trust this output. ' + ((err && err.message) || err)
    );
  }
}

function showVerificationResult(d) {
  const results = d.verifyResults;
  if (!results) return;
  if (results[0] && results[0].error) {
    setVerify('bad', '✕ Verification could not run', 'Do NOT trust this output: ' + results[0].error);
    return;
  }
  const badRedacted = results.filter((r) => r.redacted && r.count > 0);
  if (badRedacted.length === 0) {
    if (d.kind === 'pdf') {
      const untouched = results.filter((r) => !r.redacted);
      let extra = '';
      if (untouched.length) {
        extra = `<ul><li>${untouched.length} page${untouched.length === 1 ? '' : 's'} had no boxes — copied unchanged with their original text layer (nothing was hidden there).</li></ul>`;
      }
      setVerify(
        'ok',
        '✓ Verified — no extractable text found on redacted pages',
        `pdf.js re-opened the finished file and ran getTextContent() on all ${results.filter((r) => r.redacted).length} redacted page(s): zero text items returned.${extra}`
      );
    } else {
      setVerify(
        'ok',
        '✓ Verified — flat pixel output, no text layer',
        'The exported PNG contains only pixel data (no text layer can exist in a PNG). Re-encoding also stripped EXIF metadata, including any embedded GPS coordinates.'
      );
    }
    toast('Redaction verified — output is clean.', 'success', 4000);
  } else {
    const lines = badRedacted
      .map((r) => `<li>Page ${r.page}: ${r.count} unexpected text item(s) still extractable</li>`)
      .join('');
    setVerify(
      'bad',
      '✕ WARNING — text still found on redacted pages',
      `This should never happen. Do NOT download this output as safe. Pages affected:<ul>${lines}</ul>`
    );
    toast('Verification FAILED — do not distribute this output.', 'error', 12000);
  }
}

function setVerify(kind, title, bodyHtml) {
  const p = els.verifyPanel;
  p.hidden = false;
  p.className = 'verify-panel ' + kind;
  p.innerHTML = `<span class="vp-title">${escapeHtml(title)}</span>` + bodyHtml;
}

/* ---------- download ---------- */
let currentUrl = null;
function releaseDownloadUrl() {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}
function showDownload(d) {
  releaseDownloadUrl();
  currentUrl = URL.createObjectURL(d.outBlob);
  els.downloadLink.href = currentUrl;
  els.downloadLink.download = d.outName;
  els.downloadLink.textContent = d.kind === 'pdf' ? '⬇ Download redacted PDF' : '⬇ Download redacted PNG';
  els.outputSize.textContent = `${d.outName} · ${fmtBytes(d.outBlob.size)}`;
  els.downloadBlock.hidden = false;
}

/* ---------- remove file / reset ---------- */
function removeActiveFile() {
  const d = getActiveDoc();
  if (!d) return;
  const label = d.name;
  state.files = state.files.filter((f) => f.id !== d.id);
  if (d.kind === 'pdf' && d.pdfDoc) { try { d.pdfDoc.destroy(); } catch (_) {} }
  d.pages.forEach((p) => { if (p._bitmap && p._bitmap.close) { try { p._bitmap.close(); } catch (_) {} } });
  releaseDownloadUrl();
  els.workspace.hidden = state.files.length === 0;
  if (state.files.length) {
    selectFile(state.files[state.files.length - 1].id);
  } else {
    state.activeId = null;
    renderTabs();
    renderFileList();
    els.verifyPanel.hidden = true;
    els.downloadBlock.hidden = true;
    // Wipe the visible canvas so nothing sensitive remains on screen.
    els.canvas.width = 10; els.canvas.height = 10;
    ctx.clearRect(0, 0, 10, 10);
  }
  renderFileList();
  toast(`Removed “${label}” from this session. Nothing was ever sent anywhere — it only ever lived in this tab’s memory.`);
}

/* ---------- drag & drop wiring ---------- */
els.dropzone.addEventListener('click', (ev) => {
  if (ev.target === els.browseBtn) return;
  els.fileInput.click();
});
els.dropzone.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); els.fileInput.click(); }
});
els.browseBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  handleFiles(els.fileInput.files);
  els.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((t) =>
  els.dropzone.addEventListener(t, (ev) => {
    ev.preventDefault();
    els.dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((t) =>
  els.dropzone.addEventListener(t, (ev) => {
    ev.preventDefault();
    els.dropzone.classList.remove('dragover');
  })
);
els.dropzone.addEventListener('drop', (ev) => {
  const dt = ev.dataTransfer;
  if (dt && dt.files && dt.files.length) handleFiles(dt.files);
});
// Block the browser's default "open file in tab" behavior when missing the zone.
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', (ev) => ev.preventDefault());

/* ---------- toolbar wiring ---------- */
els.prevPageBtn.addEventListener('click', () => gotoPage(-1));
els.nextPageBtn.addEventListener('click', () => gotoPage(1));
els.undoBoxBtn.addEventListener('click', () => {
  const d = getActiveDoc();
  if (!d || d.built) return;
  // Undo last box across the whole doc (most recently added anywhere).
  let target = null, best = -1;
  d.pages.forEach((p, pi) => { if (p.boxes.length) { target = p; best = pi; } });
  if (!target) return;
  target.boxes.pop();
  if (best !== d.pageIndex) { d.pageIndex = best; updatePageNav(); renderCurrentPage(); }
  renderBoxList();
  drawOverlays();
});
els.clearBoxesBtn.addEventListener('click', () => {
  const d = getActiveDoc();
  if (!d || d.built) return;
  d.pages.forEach((p) => (p.boxes = []));
  renderBoxList();
  drawOverlays();
});
els.applyBtn.addEventListener('click', () => {
  const d = getActiveDoc();
  if (!d || d.built) return;
  const n = totalPendingBoxes(d);
  const where = d.pages.length > 1 ? `across ${d.pages.length} page(s)` : 'on this page';
  if (!confirm(`Apply ${n} redaction box(es) ${where}?\n\nThis is IRREVERSIBLE for this document: the boxes will be burned into the page pixels and the file rebuilt. You can always start over by adding the original file again.`)) {
    return;
  }
  applyRedactions();
});
els.removeFileBtn.addEventListener('click', removeActiveFile);

document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') {
    const d = getActiveDoc();
    if (d && !d.built && totalPendingBoxes(d) > 0 && document.activeElement === document.body) {
      ev.preventDefault();
      els.undoBoxBtn.click();
    }
  }
});

/* ---------- resize handling ---------- */
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    const pg = activePage();
    if (pg) { fitCanvasCss(pg); drawOverlays(); }
  }, 120);
});

/* ---------- offline status pill ---------- */
function updateNetPill() {
  if (!navigator.onLine) {
    els.netPill.textContent = '● Offline — working locally as designed';
    els.netPill.classList.add('offline-real');
  } else {
    els.netPill.textContent = '● Files never leave this device';
    els.netPill.classList.remove('offline-real');
  }
}
window.addEventListener('online', updateNetPill);
window.addEventListener('offline', updateNetPill);
updateNetPill();

/* ---------- warn before leaving with unsaved output ---------- */
window.addEventListener('beforeunload', (ev) => {
  const dirty = state.files.some((f) => f.built && f.outBlob && !f.downloaded);
  if (dirty || state.applying) { ev.preventDefault(); ev.returnValue = ''; }
});
els.downloadLink.addEventListener('click', () => {
  const d = getActiveDoc();
  if (d) d.downloaded = true;
});

/* ---------- boot ---------- */
(async function boot() {
  // Warm up pdf.js right away so the (single, load-time-only) CDN fetch happens now.
  try {
    await loadPdfJs();
  } catch (err) {
    toast(String((err && err.message) || err), 'error', 10000);
  }
})();
