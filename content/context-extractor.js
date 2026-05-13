(function () {
  // Guard: one run per page load (sessionStorage resets on navigation)
  if (sessionStorage.getItem('__auraInspectorRunning')) return;
  sessionStorage.setItem('__auraInspectorRunning', '1');

  const BRIDGE_SRC = 'aura-inspector-bridge';
  const captured = { auraContext: null, auraToken: null };
  let reported = false;

  function buildEndpoint(origin, appPath) {
    return origin + (appPath === '/' ? '' : appPath) + '/s/sfsites/aura';
  }

  // Balanced-brace JSON extraction at a known start offset
  function extractJsonAt(text, start) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  // Phase 1: scan inline <script> tags for embedded Aura.context / Aura.token
  function domScan() {
    for (const el of document.querySelectorAll('script:not([src])')) {
      const text = el.textContent;
      if (!text.includes('Aura')) continue;

      if (!captured.auraContext) {
        for (const needle of ['Aura.context = {', 'Aura.context={', 'context":{']) {
          const idx = text.indexOf(needle);
          if (idx === -1) continue;
          const braceIdx = text.indexOf('{', idx + needle.length - 1);
          if (braceIdx === -1) continue;
          const parsed = extractJsonAt(text, braceIdx);
          // Validate it looks like an Aura context object
          if (parsed && (parsed.fwuid || parsed.mode)) {
            captured.auraContext = parsed;
            break;
          }
        }
      }

      if (!captured.auraToken) {
        const m = text.match(/Aura\.token\s*=\s*["']([^"']{8,})["']/);
        if (m) captured.auraToken = m[1];
      }

      if (captured.auraContext && captured.auraToken) break;
    }
  }

  // Phase 2: inject page-bridge.js into page context for $A access + XHR/fetch intercept
  function injectBridge() {
    if (document.getElementById('__auraInspectorBridge')) return;
    const script = document.createElement('script');
    script.id = '__auraInspectorBridge';
    script.src = chrome.runtime.getURL('content/page-bridge.js');
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener('load', () => script.remove());
  }

  async function report(endpoint) {
    if (reported) return;
    // Always report endpoint; report context/token only if captured
    reported = true;
    chrome.runtime.sendMessage({
      type: 'AURA_CONTEXT_CAPTURED',
      url: location.href,
      auraEndpoint: endpoint,
      ...(captured.auraContext ? { auraContext: captured.auraContext } : {}),
      ...(captured.auraToken   ? { auraToken:   captured.auraToken   } : {}),
    }).catch(() => {});
  }

  async function run() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO' }).catch(() => null);
    if (!response?.info) return; // SW says this tab is not an SF site

    const { origin, appPath } = response.info;
    const endpoint = response.info.auraEndpoint ?? buildEndpoint(origin, appPath);

    // Phase 1: DOM scan (synchronous, fast)
    domScan();

    // Always send the endpoint, even if context/token not yet captured
    await report(endpoint);

    // Phase 2: bridge for $A + live XHR/fetch interception
    injectBridge();

    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      if (event.data?.source !== BRIDGE_SRC || event.data?.type !== 'AURA_DATA') return;

      let updated = false;
      if (event.data.auraContext && !captured.auraContext) {
        captured.auraContext = event.data.auraContext;
        updated = true;
      }
      if (event.data.auraToken && !captured.auraToken) {
        captured.auraToken = event.data.auraToken;
        updated = true;
      }

      if (updated) {
        // Re-report with new data (SW merges, doesn't overwrite existing fields)
        reported = false;
        await report(endpoint);
      }
    });
  }

  run();
})();
