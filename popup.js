// popup.js — v2.0
// Single-button popup. Clicking "开始滚动截图" tells the background to inject
// the in-page overlay (capture-overlay.js) into the active tab, then closes
// the popup so the user sees the page and the overlay's floating toolbar.

const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");

function setStatus(msg, kind = "") {
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.textContent = msg;
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("正在注入工具条…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有找到当前标签页。");
    const url = tab.url || "";
    if (/^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url)) {
      throw new Error("无法在这类页面上截图(chrome://、扩展页等)。");
    }

    const resp = await chrome.runtime.sendMessage({
      type: "startOverlay",
      tabId: tab.id,
    });
    if (!resp?.ok) throw new Error(resp?.error || "启动失败。");

    setStatus("工具条已就位,关闭此面板查看。", "ok");
    setTimeout(() => window.close(), 500);
  } catch (err) {
    setStatus(err.message || String(err), "err");
    startBtn.disabled = false;
  }
});
