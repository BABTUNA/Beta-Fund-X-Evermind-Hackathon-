// EverNav content script (runs on github.com).
//
// This commit: viewport element enumerator + message listener skeleton.
// Overlay rendering lands in the next commit; turbo handling after that.

const MAX_ELEMENTS = 80;
const VIEWPORT_PAD = 200; // px of slack above/below the viewport
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=tab]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Map<number, Element> — index returned to SW resolves back to a live node here. */
let elementRegistry = new Map();

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (parseFloat(style.opacity || "1") < 0.1) return false;
  return true;
}

function isInExtendedViewport(el) {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  return (
    rect.bottom > -VIEWPORT_PAD &&
    rect.top < vh + VIEWPORT_PAD &&
    rect.right > 0 &&
    rect.left < vw
  );
}

function textOf(el) {
  // Visible text (no markup), trimmed and capped.
  const raw =
    el.getAttribute("aria-label") ||
    el.innerText ||
    el.value ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 80);
}

function describe(el, idx) {
  const rect = el.getBoundingClientRect();
  return {
    idx,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    text: textOf(el),
    aria: el.getAttribute("aria-label") || undefined,
    testid: el.getAttribute("data-testid") || undefined,
    bbox: [
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
    ],
  };
}

function buildElementList() {
  const all = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const visible = all.filter((el) => isVisible(el) && isInExtendedViewport(el));

  // Stable order: by document position (querySelectorAll order is doc order).
  const picked = visible.slice(0, MAX_ELEMENTS);

  elementRegistry = new Map();
  const out = picked.map((el, i) => {
    elementRegistry.set(i, el);
    return describe(el, i);
  });

  return out;
}

function resolveIndex(idx) {
  const el = elementRegistry.get(idx);
  if (!el || !el.isConnected) return null;
  return el;
}

function elementSignature(el) {
  // Stable-ish descriptor used to re-find an element during cached-trail replay.
  return {
    tag: el.tagName.toLowerCase(),
    text: textOf(el).toLowerCase(),
    aria: (el.getAttribute("aria-label") || "").toLowerCase() || undefined,
    testid: el.getAttribute("data-testid") || undefined,
    role: el.getAttribute("role") || undefined,
  };
}

// ─── overlay ──────────────────────────────────────────────────────────────────

const OVERLAY_IDS = [
  "__evernav_backdrop__",
  "__evernav_clone__",
  "__evernav_halo__",
  "__evernav_tooltip__",
];

let overlayState = null; // { target, onResize, onClick, instruction }

function clearOverlay() {
  for (const id of OVERLAY_IDS) {
    document.getElementById(id)?.remove();
  }
  if (overlayState) {
    window.removeEventListener("scroll", overlayState.onResize, true);
    window.removeEventListener("resize", overlayState.onResize);
    if (overlayState.target && overlayState.onClick) {
      overlayState.target.removeEventListener("click", overlayState.onClick, true);
    }
    overlayState = null;
  }
}

function positionElements(target) {
  const rect = target.getBoundingClientRect();
  const pad = 4;
  const halo = document.getElementById("__evernav_halo__");
  const clone = document.getElementById("__evernav_clone__");
  const tip = document.getElementById("__evernav_tooltip__");

  const setBox = (el, r) => {
    if (!el) return;
    el.style.top = `${r.top - pad}px`;
    el.style.left = `${r.left - pad}px`;
    el.style.width = `${r.width + pad * 2}px`;
    el.style.height = `${r.height + pad * 2}px`;
  };
  setBox(halo, rect);

  if (clone) {
    clone.style.top = `${rect.top}px`;
    clone.style.left = `${rect.left}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
  }

  if (tip) {
    const tipRect = tip.getBoundingClientRect();
    const below = rect.bottom + 12;
    const above = rect.top - tipRect.height - 12;
    const top = below + tipRect.height < window.innerHeight ? below : Math.max(8, above);
    const leftRaw = rect.left + rect.width / 2 - tipRect.width / 2;
    const left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, leftRaw));
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }
}

function renderOverlay(target, instruction, opts = {}) {
  clearOverlay();
  if (!target) return false;

  target.scrollIntoView({ block: "center", behavior: "instant" });

  // Backdrop (blur layer)
  const backdrop = document.createElement("div");
  backdrop.id = "__evernav_backdrop__";
  document.documentElement.appendChild(backdrop);

  // Clone of target so it appears sharp above the blurred backdrop.
  // Using a literal innerHTML clone preserves rendered look without hooking
  // up React/Turbo internals.
  const clone = document.createElement("div");
  clone.id = "__evernav_clone__";
  clone.innerHTML = target.outerHTML;
  // Strip ids from cloned subtree to avoid duplicate-id pollution.
  clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  document.documentElement.appendChild(clone);

  // Halo
  const halo = document.createElement("div");
  halo.id = "__evernav_halo__";
  document.documentElement.appendChild(halo);

  // Tooltip
  if (instruction) {
    const tip = document.createElement("div");
    tip.id = "__evernav_tooltip__";
    tip.innerHTML = `<span class="__evernav_kicker__">Next step</span>${escapeHtml(instruction)}`;
    document.documentElement.appendChild(tip);
  }

  positionElements(target);

  // Reposition on scroll/resize. capture:true on scroll catches nested scrolls.
  const onResize = () => positionElements(target);
  window.addEventListener("scroll", onResize, true);
  window.addEventListener("resize", onResize);

  // Advance on the user actually clicking the target.
  const onClick = () => {
    const sig = elementSignature(target);
    chrome.runtime.sendMessage({
      type: "STEP_COMPLETED",
      stepIndex: opts.stepIndex ?? null,
      target: sig,
    });
    clearOverlay();
  };
  target.addEventListener("click", onClick, { once: true, capture: true });

  overlayState = { target, onResize, onClick, instruction };
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ─── messaging ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "ENUMERATE_ELEMENTS": {
          const elements = buildElementList();
          sendResponse({ ok: true, elements, url: location.href });
          break;
        }
        case "REPLAY_TRAIL": {
          // TODO(commit 7+): drive overlay through cached trail.
          sendResponse({ ok: true, queued: msg.trail?.length || 0 });
          break;
        }
        case "HIGHLIGHT_INDEX": {
          const el = resolveIndex(msg.idx);
          const drawn = renderOverlay(el, msg.instruction, { stepIndex: msg.stepIndex });
          sendResponse({ ok: drawn, found: !!el });
          break;
        }
        case "CLEAR_OVERLAY": {
          clearOverlay();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown type: ${msg.type}` });
      }
    } catch (e) {
      console.error("[evernav/content]", e);
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

console.log("[evernav/content] loaded on", location.href);
