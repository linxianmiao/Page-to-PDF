// content-analyze.js
// Runs in the target page's context to find "good places to break pages".
//
// The problem: mechanically slicing a full-page screenshot every N pixels
// inevitably cuts titles in half, splits cards, etc. This script reads the
// real DOM and reports "break hints" — vertical positions where a page break
// would be natural (end of a section, between cards, etc.).
//
// We also report "avoid regions" — ranges we'd prefer NOT to cut through
// (images, figures, tall cards). The scheduler in the popup uses hints as
// preferred break points and avoid-regions as hard blockers.

(() => {
  // CSS-pixel Y-coordinate of an element relative to the document origin.
  function topOf(el) {
    const r = el.getBoundingClientRect();
    return r.top + window.scrollY;
  }
  function bottomOf(el) {
    const r = el.getBoundingClientRect();
    return r.bottom + window.scrollY;
  }

  const hints = new Set();   // preferred break Y positions (in CSS px)
  const avoid = [];          // [ [yStart, yEnd], ... ] regions not to cut

  // --- Hints: boundaries of major structural elements ------------------------
  // These tags are the usual "one visual chunk" carriers in modern layouts.
  const sectionSelectors = [
    "section",
    "article",
    "header",
    "footer",
    "main > div",                 // common container pattern
    "[class*='section' i]",
    "[class*='slide' i]",
    "[class*='page' i]",
    "[data-section]",
  ];
  const sectionEls = new Set();
  for (const sel of sectionSelectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => sectionEls.add(el));
    } catch {}
  }
  for (const el of sectionEls) {
    const r = el.getBoundingClientRect();
    // Ignore elements that are too small to matter or hidden.
    if (r.height < 40 || r.width < 50) continue;
    hints.add(Math.round(topOf(el)));
    hints.add(Math.round(bottomOf(el)));
  }

  // Also treat headings as useful hint points — a break RIGHT BEFORE a heading
  // is almost always better than cutting mid-paragraph.
  document.querySelectorAll("h1, h2, h3").forEach((h) => {
    // Some margin of safety: put the break a few px above the heading.
    hints.add(Math.round(topOf(h) - 8));
  });

  // --- Avoid regions: elements we should not split through ------------------
  const avoidSelectors = [
    "img",
    "picture",
    "video",
    "canvas",
    "svg",
    "figure",
    "table",
    "pre",
    "blockquote",
    "[class*='card' i]",
    "[class*='tile' i]",
  ];
  for (const sel of avoidSelectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height < 20 || r.width < 20) return;
        // Skip things that are visually hidden.
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return;
        avoid.push([Math.round(topOf(el)), Math.round(bottomOf(el))]);
      });
    } catch {}
  }

  // Merge overlapping avoid regions so the scheduler has a clean list.
  avoid.sort((a, b) => a[0] - b[0]);
  const mergedAvoid = [];
  for (const [s, e] of avoid) {
    const last = mergedAvoid[mergedAvoid.length - 1];
    if (last && s <= last[1] + 4) {
      last[1] = Math.max(last[1], e);
    } else {
      mergedAvoid.push([s, e]);
    }
  }

  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  );

  return {
    hints: [...hints].filter((y) => y > 0 && y < docHeight).sort((a, b) => a - b),
    avoid: mergedAvoid,
  };
})();
