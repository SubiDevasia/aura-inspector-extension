// Runs in page (MAIN) context. Injected by context-extractor.js via <script src>.
// Reads Aura globals and intercepts XHR/fetch, then postMessages results back.
(function () {
  if (window.__auraInspectorBridgeLoaded) return;
  window.__auraInspectorBridgeLoaded = true;

  const SRC = 'aura-inspector-bridge';

  function post(data) {
    window.postMessage({ source: SRC, ...data }, '*');
  }

  function safeJson(str) {
    try { return typeof str === 'string' ? JSON.parse(str) : str; } catch { return null; }
  }

  // --- 1. Read globals immediately ---
  function readGlobals() {
    const out = {};
    try {
      if (window.Aura?.context) out.auraContext = safeJson(window.Aura.context);
      if (window.Aura?.token)   out.auraToken   = String(window.Aura.token);
    } catch {}
    try {
      if (window.$A) {
        if (!out.auraToken   && typeof window.$A.getToken   === 'function') out.auraToken   = String(window.$A.getToken());
        if (!out.auraContext && typeof window.$A.getContext === 'function') out.auraContext = safeJson(window.$A.getContext());
      }
    } catch {}
    return out;
  }

  const immediate = readGlobals();
  if (immediate.auraContext || immediate.auraToken) {
    post({ type: 'AURA_DATA', ...immediate });
  }

  // --- 2. XHR interception ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__auraUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', function () {
      if (!this.__auraUrl?.includes('/aura')) return;
      const json = safeJson(this.responseText);
      if (!json) return;
      const out = {};
      if (json.context) out.auraContext = json.context;
      if (json.token)   out.auraToken   = String(json.token);
      if (out.auraContext || out.auraToken) post({ type: 'AURA_DATA', ...out });
    });
    return origSend.call(this, body);
  };

  // --- 3. fetch interception ---
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
      if (url.includes('/aura')) {
        res.clone().json().then(json => {
          const out = {};
          if (json?.context) out.auraContext = json.context;
          if (json?.token)   out.auraToken   = String(json.token);
          if (out.auraContext || out.auraToken) post({ type: 'AURA_DATA', ...out });
        }).catch(() => {});
      }
    } catch {}
    return res;
  };
})();
