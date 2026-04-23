// editor.js — split editor
//
// Coordinate systems:
//   IMAGE_PX  — native pixels of the captured PNG (could be 10000+ tall)
//   DISPLAY_PX — on-screen pixels after CSS scaling
// State and PDF output use IMAGE_PX. DOM events give DISPLAY_PX and we
// convert using scaleFactor = displayHeight / imageHeight.
//
// The canvas element holds the decoded image at full IMAGE_PX size; CSS
// shrinks it to fit the viewport. Break lines are absolute-positioned on
// the stage (which is sized in CSS to match the displayed canvas).
//
// PDF model (v1.4): each PDF page = the slice itself. Page width/height in
// mm is derived by converting image px → CSS px → mm at 96 DPI. No paper
// size, no margins, no fit-mode.

// ----- Constants ------------------------------------------------------------
const PX_TO_MM = 25.4 / 96;
const MAX_PAGE_MM = 5000;          // PDF viewer stability ceiling

// ----- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const stage = $("stage");
// Display element is an <img> — a <canvas> would hit Chromium's 16384px
// single-axis limit on tall captures (everything below that height renders
// as blank, showing the dark stage bg and looking like "bottom is black").
// The img has no such limit; we keep `state.image` as a separate in-memory
// HTMLImageElement that export slicing reads from.
const displayImg = $("cv");
const ghost = $("ghost");
const linesList = $("linesList");
const linesEmpty = $("linesEmpty");
const lineCountEl = $("lineCount");
const statusEl = $("status");
const loadingEl = $("loading");
const exportBtn = $("exportBtn");
const exportPngBtn = $("exportPngBtn");

// ----- State ----------------------------------------------------------------
const state = {
  sessionId: null,
  session: null,              // { dataUrl, width, height, scale, analysis, sourceTab }
  image: null,                // decoded HTMLImageElement
  imageH: 0,                  // alias in IMAGE_PX
  imageW: 0,
  displayScale: 1,            // DISPLAY_PX / IMAGE_PX
  breaks: [],                 // sorted array of Y positions in IMAGE_PX (excluding 0 and imgH)
};

// ----- Bootstrap ------------------------------------------------------------
(async function init() {
  const params = new URLSearchParams(location.search);
  state.sessionId = params.get("session");
  if (!state.sessionId) {
    showError("会话 ID 丢失,请关闭窗口重试。");
    return;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: "getSession", sessionId: state.sessionId });
    if (!resp?.ok) throw new Error(resp?.error || "加载会话数据失败。");
    state.session = resp.session;
    await loadImage();
    applyAutoSuggest({ silent: true });   // pre-populate with algorithmic breaks
    loadingEl.style.display = "none";
    setStatus("就绪");
  } catch (err) {
    showError(err.message || String(err));
  }
})();

async function loadImage() {
  state.image = await decodeImage(state.session.dataUrl);
  state.imageW = state.image.naturalWidth;
  state.imageH = state.image.naturalHeight;

  // Point the display <img> at the same data URL. Browsers render img
  // elements of essentially any size (far beyond canvas's 16384px limit),
  // so ultra-tall captures show up fully without black tails.
  displayImg.src = state.session.dataUrl;

  // Set stage dimensions. Break-line positioning is anchored to stage, so
  // stage must match the full scaled-image box — NOT just what canvas could
  // render.
  recomputeDisplayScale();
  document.title = `Page2PDF — ${state.session.sourceTab.title || "Edit"}`;
}

function recomputeDisplayScale() {
  const wrap = $("canvasWrap");
  const padding = 48;  // px
  const available = wrap.clientWidth - padding;
  const targetW = Math.min(available, 1100);
  state.displayScale = targetW / state.imageW;
  stage.style.width = targetW + "px";
  stage.style.height = state.imageH * state.displayScale + "px";
}

function decodeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("截图解码失败。"));
    img.src = src;
  });
}

window.addEventListener("resize", () => {
  recomputeDisplayScale();
  renderLines();
});

// ----- Auto-suggest (run algorithmic planner) ------------------------------
function applyAutoSuggest({ silent } = {}) {
  // Build a rough "slice height" so the planner has something to aim at.
  // Without paper/margins we just target ~1200 CSS px per slice (roughly
  // A4-ish at 96 DPI). The user can then move lines anywhere.
  const slicePx = 1200 * state.session.scale;

  const a = state.session.analysis;
  if (!a || !a.hints || !a.hints.length) {
    // No DOM structure — fall back to even slices as a starting sketch.
    const n = Math.max(1, Math.round(state.imageH / slicePx));
    state.breaks = [];
    for (let i = 1; i < n; i++) {
      state.breaks.push(Math.round((state.imageH / n) * i));
    }
  } else {
    const hints = a.hints.map((y) => Math.round(y * state.session.scale));
    const avoid = a.avoid.map(([s, e]) => [Math.round(s * state.session.scale), Math.round(e * state.session.scale)]);
    state.breaks = planBreaks(state.imageH, slicePx, hints, avoid).slice(1, -1);  // drop sentinel 0 and imgH
  }

  renderLines();
  if (!silent) setStatus(`已推荐 ${state.breaks.length} 条分割线。`);
}

// Lifted verbatim from popup.js — same algorithm, single source of truth.
function planBreaks(imgH, sliceHpx, hints, avoid) {
  const minFill = 0.40;
  const minH = Math.floor(sliceHpx * minFill);
  const maxH = sliceHpx;
  function inAvoid(y) {
    for (const [s, e] of avoid) if (y > s && y < e) return [s, e];
    return null;
  }
  const breaks = [0];
  let y = 0, guard = 0;
  while (y < imgH) {
    if (guard++ > 1000) break;
    if (imgH - y <= maxH) { breaks.push(imgH); break; }
    const winLo = y + minH, winHi = y + maxH;
    let chosen = null;
    for (let i = hints.length - 1; i >= 0; i--) {
      const h = hints[i];
      if (h < winLo) break;
      if (h > winHi) continue;
      if (inAvoid(h)) continue;
      chosen = h; break;
    }
    if (chosen == null) {
      const hit = inAvoid(winHi);
      if (hit) chosen = hit[0] > y ? hit[0] : winHi;
      else chosen = winHi;
    }
    if (chosen <= y) chosen = Math.min(y + maxH, imgH);
    breaks.push(chosen);
    y = chosen;
  }
  if (breaks[breaks.length - 1] < imgH) breaks.push(imgH);
  return breaks;
}

// ----- Break lines: rendering and manipulation -----------------------------
function renderLines() {
  // Clean old line DOM
  stage.querySelectorAll(".break-line, .page-badge").forEach((n) => n.remove());

  // Deduplicate and clamp
  state.breaks = [...new Set(state.breaks.map((y) => Math.round(y)))]
    .filter((y) => y > 4 && y < state.imageH - 4)
    .sort((a, b) => a - b);

  for (let i = 0; i < state.breaks.length; i++) {
    const y = state.breaks[i];
    const el = document.createElement("div");
    el.className = "break-line";
    el.style.top = (y * state.displayScale) + "px";
    el.dataset.index = i;
    el.innerHTML = `
      <div class="handle">
        <span class="label">#${i + 1} · ${y}px</span>
        <span class="remove" title="删除">×</span>
      </div>`;
    stage.appendChild(el);
    wireLine(el, i);
  }

  // Page-number badges at midpoints of ranges
  const ranges = [0, ...state.breaks, state.imageH];
  for (let i = 0; i < ranges.length - 1; i++) {
    const mid = (ranges[i] + ranges[i + 1]) / 2;
    const badge = document.createElement("div");
    badge.className = "page-badge";
    badge.style.top = (mid * state.displayScale) + "px";
    badge.textContent = `第 ${i + 1} 页`;
    stage.appendChild(badge);
  }

  // Side list
  renderList();
  lineCountEl.textContent = state.breaks.length;
}

function renderList() {
  linesList.innerHTML = "";
  if (state.breaks.length === 0) {
    linesEmpty.style.display = "block";
    return;
  }
  linesEmpty.style.display = "none";
  state.breaks.forEach((y, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="idx">${i + 1}</span>
      <input type="number" value="${y}" min="1" max="${state.imageH - 1}" step="1" />
      <span class="unit">px</span>
      <button class="del" title="删除">×</button>
    `;
    const input = li.querySelector("input");
    input.addEventListener("change", () => {
      const v = parseInt(input.value, 10);
      if (isNaN(v)) { input.value = y; return; }
      state.breaks[i] = Math.max(1, Math.min(state.imageH - 1, v));
      renderLines();
    });
    li.querySelector(".del").addEventListener("click", () => {
      state.breaks.splice(i, 1);
      renderLines();
    });
    linesList.appendChild(li);
  });
}

// ----- Interactions: click canvas to add, drag handle to move --------------
function canvasYFromEvent(e) {
  const rect = stage.getBoundingClientRect();
  const displayY = e.clientY - rect.top;
  return Math.round(displayY / state.displayScale);
}

stage.addEventListener("mousemove", (e) => {
  // Only show ghost line when hovering empty canvas area, not over a handle
  if (e.target.closest(".handle, .break-line")) {
    ghost.style.opacity = "0";
    return;
  }
  const rect = stage.getBoundingClientRect();
  const y = e.clientY - rect.top;
  ghost.style.top = y + "px";
  ghost.style.opacity = "0.6";
});
stage.addEventListener("mouseleave", () => { ghost.style.opacity = "0"; });

stage.addEventListener("click", (e) => {
  // Don't add on handle clicks — they have their own behavior.
  if (e.target.closest(".handle, .break-line")) return;
  const y = canvasYFromEvent(e);
  if (y < 10 || y > state.imageH - 10) return;
  // Avoid adding a duplicate if user clicks very near an existing line.
  if (state.breaks.some((b) => Math.abs(b - y) < 8 / state.displayScale)) return;
  state.breaks.push(y);
  renderLines();
});

function wireLine(el, index) {
  const handle = el.querySelector(".handle");
  const remove = handle.querySelector(".remove");

  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    state.breaks.splice(index, 1);
    renderLines();
  });

  let dragging = false;
  let startY = 0;
  let startBreak = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startBreak = state.breaks[index];
    el.classList.add("dragging");
    document.body.style.cursor = "ns-resize";
  });

  function onMove(e) {
    if (!dragging) return;
    const dy = (e.clientY - startY) / state.displayScale;
    const next = Math.max(1, Math.min(state.imageH - 1, Math.round(startBreak + dy)));
    state.breaks[index] = next;
    // Update just this line's position for smoothness; full render on drop.
    el.style.top = (next * state.displayScale) + "px";
    handle.querySelector(".label").textContent = `#${index + 1} · ${next}px`;
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    document.body.style.cursor = "";
    renderLines();  // re-sort and re-index if this line passed another
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// ----- Right-panel controls -------------------------------------------------
$("clearBtn").addEventListener("click", () => {
  state.breaks = [];
  renderLines();
  setStatus("已清除全部分割线。");
});
$("suggestBtn").addEventListener("click", () => applyAutoSuggest({ silent: false }));

// ----- Status helpers -------------------------------------------------------
function setStatus(msg, kind = "") {
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.textContent = msg;
}
function showError(msg) {
  loadingEl.style.display = "none";
  setStatus(msg, "err");
}

// ----- Export ---------------------------------------------------------------
exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  exportPngBtn.disabled = true;
  setStatus("正在生成 PDF…");

  try {
    const { jsPDF } = window.jspdf;

    // Build the list of slices from user-drawn breaks. state.breaks is
    // sorted and deduped by renderLines().
    const ranges = [0, ...state.breaks, state.imageH];

    // Page width is the same for every slice (= captured image width at 96 DPI).
    const pageW_mm = (state.imageW / state.session.scale) * PX_TO_MM;

    // First slice determines the initial PDF page size.
    const firstSliceHpx = ranges[1] - ranges[0];
    const firstH_mm_raw = (firstSliceHpx / state.session.scale) * PX_TO_MM;
    const firstH_mm = Math.min(firstH_mm_raw, MAX_PAGE_MM);

    const pdf = new jsPDF({
      unit: "mm",
      format: [pageW_mm, firstH_mm],
      orientation: pageW_mm > firstH_mm ? "landscape" : "portrait",
      compress: true,
    });

    let truncated = false;

    for (let i = 0; i < ranges.length - 1; i++) {
      const yStart = ranges[i];
      const yEnd = ranges[i + 1];
      const sliceH_px = yEnd - yStart;
      if (sliceH_px <= 0) continue;

      const pageH_mm_raw = (sliceH_px / state.session.scale) * PX_TO_MM;
      const pageH_mm = Math.min(pageH_mm_raw, MAX_PAGE_MM);
      if (pageH_mm_raw > MAX_PAGE_MM) truncated = true;

      if (i > 0) {
        pdf.addPage(
          [pageW_mm, pageH_mm],
          pageW_mm > pageH_mm ? "landscape" : "portrait"
        );
      }

      // Extract the slice via an offscreen canvas so addImage gets clean bytes.
      const slice = document.createElement("canvas");
      slice.width = state.imageW;
      slice.height = sliceH_px;
      slice.getContext("2d").drawImage(
        state.image,
        0, yStart, state.imageW, sliceH_px,
        0, 0, state.imageW, sliceH_px
      );
      const sliceUrl = slice.toDataURL("image/png");

      pdf.addImage(
        sliceUrl, "PNG",
        0, 0,
        pageW_mm, pageH_mm,
        undefined, "FAST"
      );

      setStatus(`正在处理第 ${i + 1}/${ranges.length - 1} 页…`);
    }

    setStatus("正在保存…");
    const filename = `${sanitize(state.session.sourceTab.title)} — ${localDateISO()}.pdf`;
    const blob = pdf.output("blob");
    const blobUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);

    setStatus(
      truncated
        ? `完成 ✓ — 有切片超过 ${MAX_PAGE_MM}mm 已截断。`
        : "完成 ✓ — 会话保持打开,可继续调整后再次导出。",
      "ok"
    );
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), "err");
  } finally {
    exportBtn.disabled = false;
    exportPngBtn.disabled = false;
  }
});

// PNG export — drops the original stitched long image straight to disk.
// Ignores break lines (the whole point is "no splits").
exportPngBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  exportPngBtn.disabled = true;
  setStatus("正在保存长图…");
  try {
    const blob = await (await fetch(state.session.dataUrl)).blob();
    const blobUrl = URL.createObjectURL(blob);
    const filename = `${sanitize(state.session.sourceTab.title)} — ${localDateISO()}.png`;
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    setStatus("长图已保存 ✓", "ok");
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), "err");
  } finally {
    exportBtn.disabled = false;
    exportPngBtn.disabled = false;
  }
});

function localDateISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function sanitize(name) {
  return (name || "page")
    .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 80) || "page";
}

// Release session on window close so SW drops the big base64 blob from RAM.
window.addEventListener("beforeunload", () => {
  if (state.sessionId) {
    chrome.runtime.sendMessage({ type: "releaseSession", sessionId: state.sessionId });
  }
});
