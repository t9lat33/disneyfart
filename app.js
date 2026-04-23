// app.js — T9 Browser companion
// Provides: handleDev, setAdblockEnabled, goHome
// These are called by T9's inline JS but were never defined there.

// ── Adblock ───────────────────────────────────────────────────────────────────
// Sends an enable/disable message to the service worker.
// T9's menu calls: setAdblockEnabled(!adblockEnabled)
let adblockEnabled = localStorage.getItem('t9_adblock') !== 'false';

function setAdblockEnabled(next) {
  adblockEnabled = next;
  localStorage.setItem('t9_adblock', String(next));
  try {
    const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (controller) {
      controller.postMessage({ type: 'adblock', enabled: next });
    }
  } catch (e) {
    // Service worker not available — silently ignore
  }
}

// ── Dev tools ─────────────────────────────────────────────────────────────────
// Injects Eruda into the proxied page.
// T9's menu calls: handleDev()
function handleDev() {
  const frame = document.getElementById('proxy-frame');
  if (!frame) return;

  try {
    const doc = frame.contentDocument;
    if (!doc) {
      console.warn('[T9] Dev tools: frame document not accessible');
      return;
    }

    // Already injected?
    if (doc.querySelector('script[data-t9-eruda]')) {
      try {
        if (doc.defaultView && doc.defaultView.eruda) {
          doc.defaultView.eruda.init({ autoScale: true });
        }
      } catch (e) {}
      return;
    }

    let head = doc.head;
    if (!head) {
      head = doc.createElement('head');
      const first = doc.documentElement && doc.documentElement.firstChild;
      if (first) doc.documentElement.insertBefore(head, first);
      else if (doc.documentElement) doc.documentElement.appendChild(head);
      else return;
    }

    const script = doc.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/eruda/eruda.min.js';
    script.setAttribute('data-t9-eruda', 'loader');
    script.onload = function () {
      try {
        if (doc.defaultView && doc.defaultView.eruda) {
          doc.defaultView.eruda.init({ autoScale: true });
          doc.defaultView.eruda.position({ x: 20, y: 20 });
        }
      } catch (e) {}
    };
    head.appendChild(script);
  } catch (e) {
    // Cross-origin frame — devtools cannot be injected
    console.warn('[T9] Dev tools unavailable for this page (cross-origin):', e.message);
  }
}

// ── goHome ────────────────────────────────────────────────────────────────────
// T9's home() calls goHome() if it exists as a function.
// We provide a no-op here because T9 already does all the home cleanup inline;
// this just prevents the "goHome is not defined" console error.
function goHome() {
  // Intentionally empty — T9's home() handles everything after this call.
}