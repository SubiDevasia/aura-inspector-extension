(function () {
  if (sessionStorage.getItem('__auraInspectorRunning')) return;
  sessionStorage.setItem('__auraInspectorRunning', '1');

  const BRIDGE_SRC = 'aura-inspector-bridge';
  const captured = { auraContext: null, auraToken: null };
  let reported = false;
  let endpoint = null;

  function buildEndpoint(origin, appPath) {
    return origin + (appPath === '/' ? '' : appPath) + '/s/sfsites/aura';
  }

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

  function injectBridge() {
    if (document.getElementById('__auraInspectorBridge')) return;
    const script = document.createElement('script');
    script.id  = '__auraInspectorBridge';
    script.src = chrome.runtime.getURL('content/page-bridge.js');
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener('load', () => script.remove());
  }

  async function report() {
    if (reported || !endpoint) return;
    reported = true;
    chrome.runtime.sendMessage({
      type: 'AURA_CONTEXT_CAPTURED',
      url: location.href,
      auraEndpoint: endpoint,
      ...(captured.auraContext ? { auraContext: captured.auraContext } : {}),
      ...(captured.auraToken   ? { auraToken:   captured.auraToken   } : {}),
    }).catch(() => {});
  }

  // Register listener FIRST — before injectBridge() and before the async run().
  // Bridge may post AURA_DATA before run() resolves its GET_TAB_INFO await;
  // captured data is stored immediately and report() fires once endpoint is known.
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

    if (updated && endpoint) {
      reported = false;
      await report();
    }
    // If endpoint not yet set, run() will call report() after it resolves —
    // picking up whatever captured contains at that point.
  });

  // Inject bridge before page scripts finish (document_start) so XHR/fetch
  // patching happens before Aura makes its first network calls.
  injectBridge();

  async function run() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO' }).catch(() => null);
    if (!response?.info) return;

    const { origin, appPath } = response.info;
    endpoint = response.info.auraEndpoint ?? buildEndpoint(origin, appPath);

    // domScan picks up anything in inline scripts
    domScan();

    // Report — includes any bridge data already captured before run() resolved
    await report();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
