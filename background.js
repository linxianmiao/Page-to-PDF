// background.js — service worker (v2.0)
//
// Capture model: user-driven rolling screenshot (Feishu/Lark style).
//
//   1. Popup tells us to start → we inject capture-overlay.js into the tab.
//   2. Overlay shows a fixed toolbar at the top of the viewport.
//   3. User scrolls to their starting position, clicks [开始] →
//      overlay sends "overlayBegin" (we allocate a session, attach tab).
//   4. Overlay captures on each scroll-stop (500ms debounce) via
//      "overlayCapture" messages. We grab the visible viewport with
//      chrome.tabs.captureVisibleTab and push it into the session.
//   5. User clicks [完成] → "overlayFinish" → we stitch slices by their
//      recorded scrollY into one long PNG, stash the session, open the
//      editor window.
//
// No chrome.debugger. No CDP. No auto-scrolling. The user controls pace
// and range entirely.

// ----- Constants ------------------------------------------------------------
const MAX_CANVAS_DIM = 32000;           // Chromium single-axis canvas limit
const CAPTURE_THROTTLE_RETRY_MS = 700;  // captureVisibleTab rate-limit backoff

// ----- Session store --------------------------------------------------------
// editorSessions: stitched captures waiting for editor.html to load them.
const editorSessions = new Map();
function newSessionId() {
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function gcEditorSessions() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, s] of editorSessions) if (s.createdAt < cutoff) editorSessions.delete(id);
}

// activeCapture: the in-progress rolling capture. Only one at a time.
//   { tabId, windowId, slices: [{y, dataUrl}], viewportW, viewportH, clientWidth }
let activeCapture = null;

// ----- captureVisibleTab with rate-limit retry ------------------------------
async function captureViewportWithRetry(windowId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(msg) || /throttle/i.test(msg)) {
        await new Promise((r) => setTimeout(r, CAPTURE_THROTTLE_RETRY_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error("截图 API 被限流过多次,请稍后重试。");
}

// ----- Stitch slices into one tall PNG --------------------------------------
// slices is an array of { y, dataUrl } sorted implicitly by insertion (scroll
// order); we re-sort here in case the user scrolled around. dataUrls are at
// the tab's DPR — we derive that from the first bitmap's actual width.
async function stitch({ slices, viewportW, viewportH, clientWidth }) {
  if (!slices.length) throw new Error("没有截到任何内容。");

  // Ensure ascending y. Duplicates (same y) have already been deduped at
  // capture time, but sort defensively.
  slices = [...slices].sort((a, b) => a.y - b.y);

  // Derive DPR from the real pixel width of the first slice.
  const firstBlob = await (await fetch(slices[0].dataUrl)).blob();
  const firstBitmap = await createImageBitmap(firstBlob);
  const imgScale = firstBitmap.width / viewportW;
  firstBitmap.close();

  // Total height = (last slice scrollY + viewportH). We use the union of
  // visible regions so a user who scrolled past the end doesn't produce
  // a too-tall canvas.
  const last = slices[slices.length - 1];
  const totalHCss = last.y + viewportH;

  // Strip the scrollbar off the right edge.
  const scrollbarWidthCss = viewportW - clientWidth;
  const contentWcss = clientWidth;
  const contentWimg = Math.round(contentWcss * imgScale);

  // Clamp to the canvas size limit by dropping resolution if necessary.
  let effectiveScale = imgScale;
  while (
    effectiveScale > 1 &&
    (totalHCss * effectiveScale > MAX_CANVAS_DIM ||
      contentWcss * effectiveScale > MAX_CANVAS_DIM)
  ) {
    effectiveScale = Math.max(1, effectiveScale - 0.5);
  }

  const finalW = Math.round(contentWcss * effectiveScale);
  const finalH = Math.round(totalHCss * effectiveScale);
  const canvas = new OffscreenCanvas(finalW, finalH);
  const ctx = canvas.getContext("2d");

  // Slices may overlap (user scrolled back, or short scroll gaps). Drawing
  // in scroll order means later slices overwrite earlier ones — same content
  // at the same position, so visually identical.
  for (const slice of slices) {
    const blob = await (await fetch(slice.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const destY = Math.round(slice.y * effectiveScale);
    const destH = Math.round(viewportH * effectiveScale);
    ctx.drawImage(
      bitmap,
      0, 0, contentWimg, bitmap.height,
      0, destY, finalW, destH
    );
    bitmap.close();
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < outBytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, outBytes.subarray(i, i + chunk));
  }
  const dataUrl = `data:image/png;base64,${btoa(binary)}`;

  return {
    dataUrl,
    width: finalW,
    height: finalH,
    cssWidth: contentWcss,
    cssHeight: totalHCss,
    scale: effectiveScale,
  };
}

// ----- DOM analysis (used by editor auto-suggest) ---------------------------
async function analyzeDOM(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content-analyze.js"],
    });
    return results?.[0]?.result || null;
  } catch (err) {
    console.warn("DOM analysis failed:", err);
    return null;
  }
}

// ----- Inject overlay into a tab --------------------------------------------
async function startOverlay(tabId) {
  activeCapture = null;   // clear any prior state
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["capture-overlay.js"],
  });
  return { ok: true };
}

// ----- Message bridge -------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "startOverlay") {
    (async () => {
      try {
        await startOverlay(msg.tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "overlayBegin") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) throw new Error("无法获取标签页。");
        const [{ result: dims }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            viewportW: window.innerWidth,
            viewportH: window.innerHeight,
            clientWidth: document.documentElement.clientWidth,
          }),
        });
        activeCapture = {
          tabId,
          windowId: sender.tab.windowId,
          tabTitle: sender.tab.title || "",
          tabUrl: sender.tab.url || "",
          slices: [],
          viewportW: dims.viewportW,
          viewportH: dims.viewportH,
          clientWidth: dims.clientWidth,
          createdAt: Date.now(),
        };
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "overlayCapture") {
    (async () => {
      try {
        if (!activeCapture) throw new Error("没有活跃的截图会话。");
        if (sender.tab?.id !== activeCapture.tabId) {
          throw new Error("截图请求来自错误的标签页。");
        }
        const dataUrl = await captureViewportWithRetry(activeCapture.windowId);
        const y = typeof msg.scrollY === "number" ? msg.scrollY : 0;
        activeCapture.slices.push({ y, dataUrl });
        // Return the captured dataUrl so the overlay can show a live preview
        // of what's been stitched so far (Feishu-style). Also echo back
        // viewport info so the overlay can size the preview correctly without
        // a separate round-trip.
        sendResponse({
          ok: true,
          sliceCount: activeCapture.slices.length,
          slice: { y, dataUrl },
          viewportW: activeCapture.viewportW,
          viewportH: activeCapture.viewportH,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "overlayFinish") {
    (async () => {
      try {
        if (!activeCapture) throw new Error("没有活跃的截图会话。");
        const cap = activeCapture;
        activeCapture = null;   // release immediately so a second click can't double-submit

        const analysis = await analyzeDOM(cap.tabId);
        const shot = await stitch(cap);

        gcEditorSessions();
        const id = newSessionId();
        editorSessions.set(id, {
          ...shot,
          analysis,
          sourceTab: { title: cap.tabTitle, url: cap.tabUrl },
          createdAt: Date.now(),
        });

        const win = await chrome.windows.create({
          url: chrome.runtime.getURL(`editor.html?session=${id}`),
          type: "popup",
          width: 1200,
          height: 900,
          focused: true,
        });

        sendResponse({ ok: true, sessionId: id, windowId: win.id });
      } catch (err) {
        activeCapture = null;
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "overlayCancel") {
    activeCapture = null;
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === "getSession") {
    const s = editorSessions.get(msg.sessionId);
    if (!s) {
      sendResponse({ ok: false, error: "会话数据未找到或已过期,请重新截取。" });
    } else {
      sendResponse({ ok: true, session: s });
    }
    return false;
  }

  if (msg?.type === "releaseSession") {
    editorSessions.delete(msg.sessionId);
    sendResponse({ ok: true });
    return false;
  }
});
