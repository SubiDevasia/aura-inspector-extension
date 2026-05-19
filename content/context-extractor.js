(function () {
  if (sessionStorage.getItem('__auraInspectorRunning')) return;
  sessionStorage.setItem('__auraInspectorRunning', '1');

  const BRIDGE_SRC = 'aura-inspector-bridge';
  const captured = { auraContext: null, auraToken: null };
  let reported = false;
  let endpoint = null;

  function swLog(source, level, msg) {
    chrome.runtime.sendMessage({ type: 'LOG', source, level, msg }).catch(() => {});
  }

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
    swLog('extractor', 'info', `[report] sending — context=${!!captured.auraContext} token=${!!captured.auraToken}`);
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
    if (event.data?.source !== BRIDGE_SRC) return;

    // Forward bridge log messages to SW
    if (event.data.type === 'LOG') {
      swLog('bridge', event.data.level ?? 'info', event.data.msg ?? '');
      return;
    }

    if (event.data.type !== 'AURA_DATA') return;

    swLog('extractor', 'info', `[bridge-msg] context=${!!event.data.auraContext} token=${!!event.data.auraToken}`);

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
      if (!endpoint) {
        // SW may have set tab info after our initial GET_TAB_INFO returned null —
        // re-query now that we have data worth reporting.
        const r = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO' }).catch(() => null);
        if (r?.info) {
          endpoint = r.info.auraEndpoint ?? buildEndpoint(r.info.origin, r.info.appPath);
          swLog('extractor', 'info', `[bridge-msg] late endpoint resolved=${endpoint}`);
        }
      }
      if (endpoint) {
        reported = false;
        await report();
      }
    }
  });

  // Inject bridge before page scripts finish so XHR/fetch patching happens
  // before Aura makes its first network calls.
  injectBridge();
  swLog('extractor', 'info', `[init] bridge injected readyState=${document.readyState}`);

  async function run() {
    let response = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO' }).catch(() => null);
    swLog('extractor', 'info', `[run] GET_TAB_INFO → hasInfo=${!!response?.info}`);

    // SW may not have processed url-pattern/fingerprint detection yet — retry once after delay.
    if (!response?.info) {
      await new Promise(r => setTimeout(r, 1500));
      response = await chrome.runtime.sendMessage({ type: 'GET_TAB_INFO' }).catch(() => null);
      swLog('extractor', 'info', `[run] GET_TAB_INFO retry → hasInfo=${!!response?.info}`);
    }

    if (!response?.info) return;

    const { origin, appPath } = response.info;
    endpoint = response.info.auraEndpoint ?? buildEndpoint(origin, appPath);

    domScan();
    swLog('extractor', 'info', `[domScan] context=${!!captured.auraContext} token=${!!captured.auraToken}`);

    await report();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
