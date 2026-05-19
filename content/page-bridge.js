// Runs in page (MAIN) context. Injected by context-extractor.js via <script src>.
// Reads Aura globals and intercepts XHR/fetch, then postMessages results back.
(function () {
  if (window.__auraInspectorBridgeLoaded) return;
  window.__auraInspectorBridgeLoaded = true;

  const SRC = 'aura-inspector-bridge';

  function post(data) {
    window.postMessage({ source: SRC, ...data }, '*');
  }

  function log(msg, level = 'info') {
    post({ type: 'LOG', source: 'bridge', level, msg });
  }

  // Strip Aura security prefix (e.g. ";/*ERROR*/") before parsing
  function safeJson(str) {
    if (typeof str !== 'string') return str ?? null;
    const start = str.indexOf('{');
    if (start === -1) return null;
    try { return JSON.parse(start > 0 ? str.slice(start) : str); } catch { return null; }
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

  log(`loaded | $A=${!!window.$A} Aura=${!!window.Aura}`);

  const immediate = readGlobals();
  log(`readGlobals → context=${!!immediate.auraContext} token=${!!immediate.auraToken}`);

  if (immediate.auraContext || immediate.auraToken) {
    post({ type: 'AURA_DATA', ...immediate });
  }

  function extractTokenFromParams(bodyOrSearch) {
    try {
      const p = new URLSearchParams(typeof bodyOrSearch === 'string' ? bodyOrSearch : '');
      const t = p.get('aura.token');
      return (t && t !== 'null' && t !== 'undefined') ? t : null;
    } catch { return null; }
  }

  function extractTokenFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const t = u.searchParams.get('aura.token');
      return (t && t !== 'null' && t !== 'undefined') ? t : null;
    } catch { return null; }
  }

  function postAuraData(out, source) {
    if (out.auraContext || out.auraToken) {
      log(`${source} → context=${!!out.auraContext} token=${!!out.auraToken}`);
      post({ type: 'AURA_DATA', ...out });
    }
  }

  // --- 2. XHR interception ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__auraUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__auraUrl?.includes('/aura')) {
      // Extract token from request body before it's sent
      const reqToken = extractTokenFromParams(body) ?? extractTokenFromUrl(this.__auraUrl);
      if (reqToken) postAuraData({ auraToken: reqToken }, 'XHR req');

      this.addEventListener('load', function () {
        const json = safeJson(this.responseText);
        if (!json) return;
        const out = {};
        if (json.context) out.auraContext = json.context;
        if (json.token)   out.auraToken   = String(json.token);
        postAuraData(out, 'XHR resp');
      });
    }
    return origSend.call(this, body);
  };

  // --- 3. fetch interception ---
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url    = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
    const isAura = url.includes('/aura');

    if (isAura) {
      // Extract token from request before awaiting response
      const init     = args[1] ?? {};
      const reqBody  = typeof init.body === 'string' ? init.body : (args[0]?.body ?? null);
      const reqToken = extractTokenFromParams(reqBody) ?? extractTokenFromUrl(url);
      if (reqToken) postAuraData({ auraToken: reqToken }, 'fetch req');
    }

    const res = await origFetch.apply(this, args);

    if (isAura) {
      res.clone().text().then(text => {
        const json = safeJson(text);
        if (!json) return;
        const out = {};
        if (json.context) out.auraContext = json.context;
        if (json.token)   out.auraToken   = String(json.token);
        postAuraData(out, 'fetch resp');
      }).catch(() => {});
    }

    return res;
  };
})();
