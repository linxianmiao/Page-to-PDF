# Page2PDF 滚动截图 → PDF / 长图

把整页网页自动滚动 + 截图,拼成长图,然后在编辑器里调分割线**导出 PDF**,
或者直接**导出整张长图 PNG**(不分页)。

![icon](icons/icon128.png)

## v2.0 交互流程

1. **点击扩展图标** → 弹出小面板,只有一个"开始滚动截图"按钮
2. **点按钮** → 页面顶部出现一条琥珀色**悬浮工具条**(48 px 高),
   popup 自动关闭
3. **工具条 · 准备中**:手动滚到你想开始截图的位置,点 **[开始]**
4. **工具条 · 记录中**:**每秒自动向下滚动一次**(每次约 90% 视窗,
   留 10% 重叠),滚一次截一张;工具条上实时显示"已截 N 张",
   右上角有缩略图预览
5. **滚到文档底部** → **自动结束**;想提前停可点 **[完成]**
6. **编辑器自动打开**:左侧是完整长截图 + 已自动推荐好的分割线,
   右侧是分割线列表
7. 两种导出方式二选一:
   - **导出 PDF** —— 按分割线把长图切成多页 PDF
   - **导出长图** —— 忽略分割线,直接把拼好的整张 PNG 存到本地

任何时候点 **[取消]** 都干净退出,不留痕迹。

## 关键设计

### 截图模型

- **`chrome.tabs.captureVisibleTab`** —— 标准扩展 API,不用 `chrome.debugger`,
  没有"正在调试此浏览器"横幅
- **每秒一次** auto-scroll + capture,`scroll-behavior: instant` 强制同步落点;
  下一个 tick 检测到 `scrollY` 没动就判定到底,自动收尾
- **重复位置去重** —— `lastCapturedY` 记录上一张截图的 scrollY,
  同位置不重复截

### 工具条 / 隐身截图

- **Shadow DOM 工具条** —— 样式完全隔离,页面 CSS 改不到它
- **截图前 `display: none` host 三帧 RAF** —— 让合成器真正卸下这一层,
  避免截到工具条;不用 opacity 是因为页面级 transition 可能把数值
  动画化,会拍到半透明帧

### 拼接

- **`OffscreenCanvas`** 在 Service Worker 里按 scrollY 排序拼成一张长 PNG;
  重叠区域后写覆盖前写(同位置像素相同,安全)
- **DPR 自动反推** —— 用首张截图实际像素宽 / `viewportW` 算出真实缩放比,
  不读 `devicePixelRatio`(SW 拿不到)
- **自动裁掉滚动条** —— 取 `innerWidth - clientWidth` 作为滚动条宽度,
  从每张切片右边裁掉
- **超长降倍率** —— 单轴超过 32000 px 自动降 scale,不静默出空图

### 编辑器

- **显示用 `<img>`,不用 `<canvas>`** —— Chromium canvas 单轴 16384 px 上限,
  超长截图会黑屏;`<img>` 没这个限制
- **Auto-suggest 预填分割线** —— `content-analyze.js` 在源页面里读 DOM,
  收集 `<section>`/`<article>`/`<h1-3>` 等位置作为 `hints`,把
  `<img>`/`<table>`/`.card` 等位置作为 `avoid`;编辑器跑一个简单
  scheduler:每页目标 ~1200 CSS px,优先在 hint 处断,绝不在 avoid 区断
- **PDF 一段一页一尺寸** —— 没有纸张/边距概念,每个分割段独立 page size,
  上限 5000 mm

## 已知限制

- **JS 驱动的演示文稿页面**(reveal.js、impress.js、自研 pitch deck 等)
  的 slide 切换**不响应浏览器滚动**,只能拿到第一屏的重复截图,
  自动会判定"到底"立刻结束。这类页面推荐用 Chrome 原生
  **Cmd+P → 存储为 PDF**
- **chrome://、扩展页面、Chrome 应用商店**禁止脚本注入,无法使用
- **单张长图超过 32000 px**(超高页面 × Retina 2× DPR)会自动降倍率

## 安装方法(开发模式)

1. 打开 `chrome://extensions`
2. 右上角开**开发者模式**
3. 点**加载已解压的扩展程序**,选择本文件夹

## 权限说明

| 权限 | 用途 |
|---|---|
| `activeTab` | 获取当前标签页并对其调用 `captureVisibleTab` |
| `downloads` | 保存生成的 PDF |
| `scripting` | 注入 `capture-overlay.js` 和 `content-analyze.js` |

**没有** `debugger`、`storage`、`<all_urls>` 等高危/广权限。

## 文件结构

```
page2pdf/
├── manifest.json          MV3 清单
├── background.js          Service Worker:会话 + captureVisibleTab + 拼接
├── capture-overlay.js     注入目标页:浮动工具条 + auto-scroll + capture 循环
├── content-analyze.js     注入目标页:DOM 分析,产出分页 hints / avoid
├── popup.html / .js       单按钮启动面板
├── editor.html / .js      分割线编辑器 + jsPDF 导出
├── lib/
│   └── jspdf.umd.min.js   jsPDF 2.5.2(内置,离线可用)
└── icons/
    └── icon{16,32,48,128}.png
```

## 可调参数

| 参数 | 位置 | 说明 |
|---|---|---|
| `TICK_INTERVAL_MS = 1000` | `capture-overlay.js` | 滚动 + 截图周期 |
| `SCROLL_STEP_FACTOR = 0.9` | `capture-overlay.js` | 单步占视窗高度的比例(留重叠) |
| `1200` (slicePx) | `editor.js` `applyAutoSuggest` | auto-suggest 每页目标 CSS 像素高 |
| `MAX_PAGE_MM = 5000` | `editor.js` | PDF 单页毫米上限 |
| `MAX_CANVAS_DIM = 32000` | `background.js` | 拼接画布单轴像素上限 |

## 许可证

MIT
