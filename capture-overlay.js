// capture-overlay.js
// Content script injected into the target tab when the user starts a
// "rolling screenshot". Renders a fixed toolbar at the top of the viewport
// and drives the capture loop:
//
//   PREPARING  → user scrolls to the desired starting position, clicks [开始]
//   RECORDING  → we auto-capture on scroll-stop; user can keep scrolling
//   PROCESSING → user clicked [完成]; we tell the background to stitch and
//                open the editor, then remove the overlay
//
// The overlay covers the top 48px of the viewport. During each capture we
// set opacity: 0 on the overlay so it doesn't show up in the screenshot,
// then restore it. No document content is lost because at scrollY=0 we still
// capture the whole viewport (including what was under the invisible overlay).

(() => {
  // Guard against double-injection (user re-triggers before previous run ended).
  if (window.__p2p_overlay_active) return;
  window.__p2p_overlay_active = true;

  // ----- State --------------------------------------------------------------
  const STATE = { PREPARING: 1, RECORDING: 2, PROCESSING: 3 };
  const TICK_INTERVAL_MS = 1000;   // one capture + scroll cycle per second
  const SCROLL_STEP_FACTOR = 0.9;  // each step moves by 90% of viewport height → 10% overlap
  let state = STATE.PREPARING;
  let sliceCount = 0;
  let lastCapturedY = -1;        // dedup: skip capture if scrollY unchanged
  let pollInterval = null;       // setInterval handle while RECORDING
  let capturing = false;         // re-entrancy guard while a capture is in flight
  let ticking = false;           // re-entrancy guard for the whole tick (capture + scroll)

  // ----- DOM ---------------------------------------------------------------
  const host = document.createElement("div");
  host.id = "__p2p_overlay_host";
  // Use a shadow root so page CSS can't accidentally style our overlay.
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .bar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 48px;
      background: rgba(14, 16, 19, 0.94);
      color: #e6e8eb;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 12px;
      z-index: 2147483647;
      backdrop-filter: blur(8px);
      border-bottom: 1px solid rgba(245, 165, 36, 0.4);
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      /* NO transition here — we hide/show with display during capture, and a
         transition would animate the value change and leak into the screenshot. */
    }
    .preview {
      position: fixed;
      top: 64px;
      right: 16px;
      width: 200px;
      max-height: calc(100vh - 96px);
      background: rgba(14, 16, 19, 0.94);
      border: 1px solid rgba(245, 165, 36, 0.4);
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      color: #e6e8eb;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 11px;
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 2147483647;
      backdrop-filter: blur(8px);
    }
    .preview.active { display: flex; }
    .preview-header {
      padding: 8px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      color: #b8bdc6;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 10px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
    }
    .preview-header b {
      color: #f5a524;
      font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-weight: 600;
    }
    .preview-body {
      overflow-y: auto;
      padding: 6px;
      background: #f5f5f5;
      flex: 1;
    }
    .preview-stage {
      position: relative;
      width: 100%;
      background: #fff;
    }
    .preview-stage img {
      position: absolute;
      left: 0;
      width: 100%;
      height: auto;
      display: block;
      /* Slightly outlined so consecutive slices are visible even if their
         backgrounds are the same solid color. */
      box-shadow: 0 0 0 1px rgba(245, 165, 36, 0.15);
    }
    .preview-empty {
      padding: 24px 12px;
      text-align: center;
      color: #6b7280;
      font-size: 11px;
      line-height: 1.6;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #f5a524;
      flex-shrink: 0;
    }
    .brand {
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .divider {
      width: 1px; height: 18px;
      background: rgba(255,255,255,0.15);
      flex-shrink: 0;
    }
    .msg {
      flex: 1;
      color: #b8bdc6;
      font-size: 12px;
    }
    .msg strong {
      color: #f5a524;
      font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-weight: 600;
    }
    .btn {
      appearance: none;
      border: none;
      padding: 7px 14px;
      border-radius: 5px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      letter-spacing: 0.02em;
      transition: filter 0.1s;
    }
    .btn:hover { filter: brightness(1.08); }
    .btn:active { transform: scale(0.98); }
    .btn-primary {
      background: #f5a524;
      color: #1a1106;
    }
    .btn-ghost {
      background: transparent;
      color: #b8bdc6;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .btn-ghost:hover { border-color: rgba(255,255,255,0.4); color: #e6e8eb; }
    .pulse {
      width: 8px; height: 8px; border-radius: 50%;
      background: #ef4444;
      animation: p2p_pulse 1.2s infinite;
      flex-shrink: 0;
    }
    @keyframes p2p_pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.3; transform: scale(1.3); }
    }
  `;
  shadow.appendChild(style);

  const bar = document.createElement("div");
  bar.className = "bar";
  shadow.appendChild(bar);

  // Preview panel — Feishu-style live stitched thumbnail of captures so far.
  // Hidden until RECORDING begins. Slices are absolutely positioned inside
  // `preview-stage` at their scaled scrollY — overlaps and gaps show up
  // exactly as they will in the final stitch.
  const preview = document.createElement("div");
  preview.className = "preview";
  preview.innerHTML = `
    <div class="preview-header"><span>预览</span> <b id="pvc">0</b></div>
    <div class="preview-body"><div class="preview-stage"></div></div>
  `;
  shadow.appendChild(preview);

  const previewStage = preview.querySelector(".preview-stage");
  const previewBody = preview.querySelector(".preview-body");
  const previewCountEl = preview.querySelector("#pvc");

  // Relationship between CSS px (page) and preview px. Computed once the
  // first slice arrives (so we know the true viewport-width basis).
  let previewScale = 0;

  document.documentElement.appendChild(host);

  // ----- Render states ------------------------------------------------------
  function render() {
    bar.innerHTML = "";
    const dot = el("div", "dot");
    const brand = el("span", "brand", "Page2PDF · 滚动截图");
    const div = el("div", "divider");
    bar.append(dot, brand, div);

    if (state === STATE.PREPARING) {
      const msg = el("div", "msg", null);
      msg.innerHTML = "滚到你想开始截图的位置,再点 <strong>开始</strong>";
      const startBtn = el("button", "btn btn-primary", "开始");
      const cancelBtn = el("button", "btn btn-ghost", "取消");
      startBtn.onclick = onBegin;
      cancelBtn.onclick = onCancel;
      bar.append(msg, startBtn, cancelBtn);
    } else if (state === STATE.RECORDING) {
      const pulse = el("div", "pulse");
      const msg = el("div", "msg", null);
      msg.innerHTML = `已截 <strong>${sliceCount}</strong> 张 · 自动滚动中,到底会自动完成,提前结束点 <strong>完成</strong>`;
      const finishBtn = el("button", "btn btn-primary", "完成");
      const cancelBtn = el("button", "btn btn-ghost", "取消");
      finishBtn.onclick = onFinish;
      cancelBtn.onclick = onCancel;
      bar.append(pulse, msg, finishBtn, cancelBtn);
    } else {
      const msg = el("div", "msg", "正在生成长图,请稍候…");
      bar.append(msg);
    }
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ----- Actions ------------------------------------------------------------
  async function onBegin() {
    // Notify background to start a session, snap the initial viewport (slice
    // 0 is wherever the user was when they clicked), then start auto-scroll.
    const resp = await chrome.runtime.sendMessage({ type: "overlayBegin" });
    if (!resp?.ok) return fail(resp?.error || "启动失败");
    state = STATE.RECORDING;
    preview.classList.add("active");
    render();
    lastCapturedY = -1;
    await captureNow();
    startPolling();
  }

  async function onFinish() {
    stopPolling();
    state = STATE.PROCESSING;
    render();
    // One final capture of wherever the user has scrolled to.
    await captureNow();
    const resp = await chrome.runtime.sendMessage({ type: "overlayFinish" });
    if (!resp?.ok) return fail(resp?.error || "生成失败");
    teardown();
  }

  async function onCancel() {
    stopPolling();
    await chrome.runtime.sendMessage({ type: "overlayCancel" });
    teardown();
  }

  function fail(msg) {
    bar.innerHTML = "";
    const warn = el("div", "msg", null);
    warn.innerHTML = `<strong style="color:#ef4444;">出错:</strong> ${escapeHtml(msg)}`;
    bar.append(warn);
    setTimeout(teardown, 2500);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  function teardown() {
    stopPolling();
    host.remove();
    window.__p2p_overlay_active = false;
  }

  // ----- Auto-scroll + capture loop ----------------------------------------
  // Every TICK_INTERVAL_MS we:
  //   1. capture the current viewport (if it's a new scrollY we haven't hit)
  //   2. programmatically scroll down by SCROLL_STEP_FACTOR × viewportH
  //   3. if the scroll didn't advance (we hit the document bottom) — auto-finish.
  //
  // `scroll-behavior: instant` sidesteps CSS smooth-scroll that some sites
  // set — we need the scroll to land synchronously so the next tick sees
  // the new position.
  function startPolling() {
    stopPolling();
    pollInterval = setInterval(onPollTick, TICK_INTERVAL_MS);
  }
  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }
  async function onPollTick() {
    if (ticking || capturing) return;
    ticking = true;
    try {
      const y = Math.round(window.scrollY);

      // Capture if this is new territory.
      if (y !== lastCapturedY) {
        await captureNow();
      }

      // Step forward.
      const step = Math.max(120, Math.floor(window.innerHeight * SCROLL_STEP_FACTOR));
      const target = y + step;
      window.scrollTo({ top: target, left: 0, behavior: "instant" });

      // Let the scroll take effect, then re-read scrollY to detect "stuck at bottom".
      await new Promise((r) => requestAnimationFrame(r));
      const afterY = Math.round(window.scrollY);

      if (afterY === y) {
        // scrollTo didn't advance us → we're at the document bottom.
        // If we've already captured this position, auto-finish.
        if (y === lastCapturedY) {
          stopPolling();
          onFinish();          // opens the editor
        }
        // (If we haven't captured y yet, next tick will capture then auto-finish.)
      }
    } finally {
      ticking = false;
    }
  }

  // ----- Capture one viewport ----------------------------------------------
  async function captureNow() {
    if (capturing) return;                       // a capture is already running
    const y = Math.round(window.scrollY);
    if (y === lastCapturedY) return;             // dedup
    capturing = true;

    // Hide the overlay so it doesn't appear in the screenshot. We use
    // display:none on the HOST (not opacity on the bar) — display:none
    // removes the element from the render tree atomically, no animation,
    // no compositor-layer leftover. Opacity is dicey because any CSS
    // transition on the property would animate the value over tens of ms
    // and the screenshot would catch a half-transparent frame.
    host.style.display = "none";

    // Wait three animation frames for the layout/compositor to catch up.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "overlayCapture",
        scrollY: y,
      });
      if (resp?.ok) {
        sliceCount = resp.sliceCount;
        lastCapturedY = y;
        // Feed the returned slice into the live preview.
        if (resp.slice && resp.viewportW) {
          appendToPreview(resp.slice.dataUrl, resp.slice.y, resp.viewportW);
        }
      }
    } finally {
      host.style.display = "";    // back to the default ("block")
      capturing = false;
      if (state === STATE.RECORDING) render();    // re-renders with new count
    }
  }

  // Stack a newly captured slice into the preview panel at its scaled y.
  // We use absolute positioning inside .preview-stage — overlapping slices
  // (same scrollY captured twice, or user scrolled backward) stack naturally
  // with later slices painting over earlier ones, mirroring the final stitch.
  function appendToPreview(dataUrl, y, viewportW) {
    if (!previewScale) {
      // 200px panel minus 12px padding → ~188px drawable; use 188 / viewportW.
      const bodyW = previewBody.clientWidth || 188;
      previewScale = bodyW / viewportW;
    }

    const img = document.createElement("img");
    img.src = dataUrl;
    img.style.top = Math.round(y * previewScale) + "px";

    img.addEventListener("load", () => {
      // Now that the image is decoded, img.offsetHeight gives us the scaled
      // slice height — use it to grow the stage so scrolling works.
      const bottom = Math.round(y * previewScale) + img.offsetHeight;
      const currentH = parseInt(previewStage.style.height, 10) || 0;
      if (bottom > currentH) previewStage.style.height = bottom + "px";
      // Auto-scroll the panel to the newest capture.
      previewBody.scrollTop = previewBody.scrollHeight;
    }, { once: true });

    previewStage.appendChild(img);
    previewCountEl.textContent = sliceCount;
  }

  // ----- Boot ---------------------------------------------------------------
  render();
})();
