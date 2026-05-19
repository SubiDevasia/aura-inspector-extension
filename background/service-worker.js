import { runCoreChecks, bootstrapAuraContext } from './aura-checks.js';

// ---------------------------------------------------------------------------
// Internal log — gated ring buffer, enable/disable via popup toggle
// ---------------------------------------------------------------------------

const LOG_KEY     = '__log__';
const LOG_ENABLED = '__log_enabled__';
const LOG_START   = '__log_session_start__';
const LOG_MAX     = 500;

// In-memory cache — avoids a storage read on every swLog call
let logEnabled = false;
chrome.storage.session.get(LOG_ENABLED)
  .then(r => { logEnabled = r[LOG_ENABLED] ?? false; })
  .catch(() => {});

// In-memory queue + serialised flush — prevents concurrent read-modify-write race
const logQueue = [];
let logFlushing = false;

async function flushLogQueue() {
  if (logFlushing || logQueue.length === 0) return;
  logFlushing = true;
  const batch = logQueue.splice(0, logQueue.length);
  try {
    const r   = await chrome.storage.session.get(LOG_KEY);
    const log = r[LOG_KEY] ?? [];
    log.push(...batch);
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    await chrome.storage.session.set({ [LOG_KEY]: log });
  } catch {}
  logFlushing = false;
  if (logQueue.length > 0) flushLogQueue();
}

function swLog(source, level, msg) {
  if (!logEnabled) return;
  logQueue.push({ ts: Date.now(), source, level, msg: String(msg) });
  flushLogQueue();
}

// ---------------------------------------------------------------------------
// Layer 1: known SF domain patterns
const SF_PATTERNS = [
  /^https?:\/\/[^.]+\.my\.site\.com(\/|$)/,
  /^https?:\/\/[^.]+\.vf\.force\.com(\/|$)/,
  /^https?:\/\/[^.]+\.my\.salesforce-sites\.com(\/|$)/,
  /^https?:\/\/[^.]+\.my\.salesforce\.com(\/|$)/,
];

const AURA_PATH_RE = /\/(?:s\/sfsites\/)?aura(?:\?|$|\/)/;
const SF_HOST_RE = /\.(?:salesforce|force)\.com$/;

function isSFSite(url) {
  return url && SF_PATTERNS.some(p => p.test(url));
}

function parseAppParts(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  const sIdx = segs.indexOf('s');
  if (sIdx <= 0) return { appPath: '/', appName: '(default)' };
  return { appPath: '/' + segs.slice(0, sIdx).join('/'), appName: segs[0] };
}

function parseSFSiteInfo(url) {
  try {
    const u = new URL(url);
    const { appPath, appName } = parseAppParts(u.pathname);
    return { origin: u.origin, host: u.hostname, appPath, appName };
  } catch {
    return null;
  }
}

function buildAuraEndpoint(origin, appPath) {
  return origin + (appPath === '/' ? '' : appPath) + '/s/sfsites/aura';
}

function extractAuraEndpoint(requestUrl) {
  try {
    const u = new URL(requestUrl);
    const match = u.pathname.match(/^(.*?\/(?:s\/sfsites\/)?aura)/);
    if (match) return u.origin + match[1];
  } catch {}
  return null;
}

async function getTabInfo(tabId) {
  const r = await chrome.storage.session.get(`tab:${tabId}`);
  return r[`tab:${tabId}`] ?? null;
}

async function setTabInfo(tabId, info) {
  await chrome.storage.session.set({ [`tab:${tabId}`]: info });
}

async function setBadgeGreen(tabId) {
  await chrome.action.setBadgeText({ tabId, text: 'SF' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#22c55e' });
}

async function clearBadge(tabId) {
  await chrome.action.setBadgeText({ tabId, text: '' });
}

async function waitForTabComplete(tabId, timeoutMs = 8000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return true;
  } catch { return false; }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    function listener(id, changeInfo) {
      if (id !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectContextExtractor(tabId) {
  const ready = await waitForTabComplete(tabId);
  if (!ready) {
    swLog('sw', 'warn', `[inject] tab=${tabId} not complete after timeout — skipping inject`);
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content/context-extractor.js'],
    });
    swLog('sw', 'info', `[inject] context-extractor.js → tab=${tabId} OK`);
  } catch (err) {
    swLog('sw', 'error', `[inject] context-extractor.js → tab=${tabId} FAILED: ${err.message}`);
  }
}

// --- Detection layer handlers ---

// Fires-and-forgets: after detection sets tab info, bootstrap context from the
// Aura endpoint directly so we don't depend on page-injection timing.
async function autoBootstrapContext(tabId) {
  const info = await getTabInfo(tabId);
  if (!info?.auraEndpoint || info.auraContext) return;
  swLog('sw', 'info', `[bootstrap:auto] starting — endpoint=${info.auraEndpoint}`);
  try {
    const ctx = await bootstrapAuraContext(info.auraEndpoint, info.auraToken ?? 'null');
    if (ctx) {
      const current = await getTabInfo(tabId);
      if (current && !current.auraContext) {
        await setTabInfo(tabId, { ...current, auraContext: ctx, auraContextChecked: true });
        swLog('sw', 'info', `[bootstrap:auto] context acquired fwuid=${ctx.fwuid ?? '?'}`);
      }
    } else {
      swLog('sw', 'warn', `[bootstrap:auto] no context returned`);
    }
  } catch (err) {
    swLog('sw', 'warn', `[bootstrap:auto] failed: ${err.message}`);
  }
}

async function handleLayer1(tabId, url) {
  const base = parseSFSiteInfo(url);
  if (!base) return;
  const auraEndpoint = buildAuraEndpoint(base.origin, base.appPath);
  const existing = await getTabInfo(tabId);
  // Skip if same origin + already have context — just refresh badge
  if (existing?.origin === base.origin && existing?.auraContext) {
    await setBadgeGreen(tabId);
    return;
  }
  await setTabInfo(tabId, { ...base, detectedVia: 'url-pattern', auraEndpoint });
  await setBadgeGreen(tabId);
  swLog('sw', 'info', `[detect] url-pattern → ${base.host}${base.appPath}`);
  autoBootstrapContext(tabId);
}

async function handleFingerprintDetection(tabId, msg) {
  const existing = await getTabInfo(tabId);
  if (existing?.detectedVia === 'url-pattern') return;

  try {
    const u = new URL(msg.url);
    const appPath = msg.appPath ?? '/';
    const appName = appPath === '/' ? '(custom domain)' : appPath.split('/').filter(Boolean)[0];
    await setTabInfo(tabId, {
      origin: u.origin,
      host: u.hostname,
      appPath,
      appName,
      auraEndpoint: buildAuraEndpoint(u.origin, appPath),
      detectedVia: 'fingerprint',
      markers: msg.markers,
    });
    await setBadgeGreen(tabId);
    await injectContextExtractor(tabId);
    swLog('sw', 'info', `[detect] fingerprint → ${u.hostname} markers=${JSON.stringify(msg.markers ?? [])}`);
    autoBootstrapContext(tabId);
  } catch {}
}

async function handleNetworkDetection(tabId, requestUrl) {
  const existing = await getTabInfo(tabId);
  if (existing && ['url-pattern', 'fingerprint', 'network'].includes(existing.detectedVia)) return;

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab.url || isSFSite(tab.url)) return;

  const auraEndpoint = extractAuraEndpoint(requestUrl);

  try {
    const u = new URL(tab.url);
    await setTabInfo(tabId, {
      origin: u.origin,
      host: u.hostname,
      appPath: '/',
      appName: '(detected via network)',
      detectedVia: 'network',
      auraEndpoint: auraEndpoint ?? buildAuraEndpoint(u.origin, '/'),
    });
    await setBadgeGreen(tabId);
    await injectContextExtractor(tabId);
    swLog('sw', 'info', `[detect] network → tab=${tabId} endpoint=${auraEndpoint ?? '(built)'}`);
    autoBootstrapContext(tabId);
  } catch {}
}

async function handleManualOverride({ tabId, url, enabled }) {
  swLog('sw', 'info', `[manual] tab=${tabId} enabled=${enabled} url=${url}`);
  if (enabled) {
    try {
      const u = new URL(url);
      await setTabInfo(tabId, {
        origin: u.origin,
        host: u.hostname,
        appPath: '/',
        appName: '(manual override)',
        detectedVia: 'manual',
      });
      await setBadgeGreen(tabId);
      await injectContextExtractor(tabId);
      autoBootstrapContext(tabId);
    } catch {}
  } else {
    await chrome.storage.session.remove(`tab:${tabId}`);
    await clearBadge(tabId);
  }
}

async function handleContextCaptured(tabId, msg) {
  const existing = await getTabInfo(tabId);
  if (!existing) return;

  const updated = { ...existing, auraContextChecked: true };
  if (msg.auraEndpoint && !updated.auraEndpoint) updated.auraEndpoint = msg.auraEndpoint;
  if (msg.auraContext) updated.auraContext = msg.auraContext;
  if (msg.auraToken)   updated.auraToken   = msg.auraToken;

  await setTabInfo(tabId, updated);
  swLog('sw', 'info', `[context] captured — context=${!!msg.auraContext} token=${!!msg.auraToken} endpoint=${msg.auraEndpoint ?? '(none)'}`);
}

// --- Scan orchestration (guest + auth) ---

async function handleRunScan(tabId) {
  const info = await getTabInfo(tabId);
  if (!info) return;
  if (!info.auraEndpoint) return;

  // Pre-scan: bootstrap context from server if not yet captured
  if (!info.auraContext) {
    try {
      const ctx = await bootstrapAuraContext(info.auraEndpoint, info.auraToken ?? 'null');
      if (ctx) {
        info = { ...info, auraContext: ctx, auraContextChecked: true };
        await setTabInfo(tabId, info);
        swLog('sw', 'info', `[bootstrap] context acquired from server`);
      }
    } catch {}
  }

  await setTabInfo(tabId, { ...info, scanState: 'running', scanProgress: null, scanResult: null, scanError: null });
  swLog('sw', 'info', `[scan] started — endpoint=${info.auraEndpoint} hasContext=${!!info.auraContext} hasToken=${!!info.auraToken}`);

  const keepAlive = setInterval(() => chrome.storage.session.get('__ka__'), 20_000);

  try {
    const result = await runCoreChecks(
      info.auraEndpoint,
      info.auraContext ?? {},
      info.auraToken ?? 'null',
      async (progress) => {
        const current = await getTabInfo(tabId);
        if (current) await setTabInfo(tabId, { ...current, scanProgress: progress });
        swLog('sw', 'info', `[scan] ${progress.label}`);
      },
    );

    const current = await getTabInfo(tabId);
    const update  = { ...current, scanState: 'done', scanResult: result, scanProgress: null };
    if (result.bootstrappedContext && !current.auraContext) {
      update.auraContext        = result.bootstrappedContext;
      update.auraContextChecked = true;
    }
    await setTabInfo(tabId, update);
    swLog('sw', 'info', `[scan] done — objects=${result.objectCount} accessible=${result.accessible?.length ?? 0} bootstrapped=${!!result.bootstrappedContext}`);
  } catch (err) {
    const current = await getTabInfo(tabId);
    await setTabInfo(tabId, { ...current, scanState: 'error', scanError: err.message, scanProgress: null });
    swLog('sw', 'error', `[scan] error — ${err.message}`);
  } finally {
    clearInterval(keepAlive);
  }
}

async function handleRunAuthScan(tabId, cookieHeader) {
  const info = await getTabInfo(tabId);
  if (!info?.auraEndpoint) return;

  await setTabInfo(tabId, {
    ...info,
    authScanState: 'running',
    authScanProgress: null,
    authScanResult: null,
    authScanError: null,
  });

  const keepAlive = setInterval(() => chrome.storage.session.get('__ka__'), 20_000);

  try {
    const result = await runCoreChecks(
      info.auraEndpoint,
      info.auraContext ?? {},
      info.auraToken ?? 'null',
      async (progress) => {
        const current = await getTabInfo(tabId);
        if (current) await setTabInfo(tabId, { ...current, authScanProgress: progress });
      },
      cookieHeader,
    );

    const current = await getTabInfo(tabId);
    const update  = { ...current, authScanState: 'done', authScanResult: result, authScanProgress: null };
    if (result.bootstrappedContext && !current.auraContext) {
      update.auraContext        = result.bootstrappedContext;
      update.auraContextChecked = true;
    }
    await setTabInfo(tabId, update);
  } catch (err) {
    const current = await getTabInfo(tabId);
    await setTabInfo(tabId, { ...current, authScanState: 'error', authScanError: err.message, authScanProgress: null });
  } finally {
    clearInterval(keepAlive);
  }
}

// --- Tab lifecycle ---

async function updateTab(tabId, url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
    await clearBadge(tabId);
    return;
  }

  if (isSFSite(url)) {
    await handleLayer1(tabId, url);
    return;
  }

  const existing = await getTabInfo(tabId);

  if (existing?.detectedVia === 'manual') {
    await setBadgeGreen(tabId);
    return;
  }

  try {
    const currentOrigin = new URL(url).origin;
    if (existing && existing.origin === currentOrigin) {
      await setBadgeGreen(tabId);
      return;
    }
  } catch {}

  await chrome.storage.session.remove(`tab:${tabId}`);
  await clearBadge(tabId);
}

// --- Event Listeners ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    swLog('sw', 'info', `[tab:updated] tab=${tabId} url=${tab.url.slice(0, 100)}`);
    updateTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    swLog('sw', 'info', `[tab:activated] tab=${tabId} url=${(tab.url ?? '').slice(0, 100)}`);
    if (tab.url) updateTab(tabId, tab.url);
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  swLog('sw', 'info', `[tab:removed] tab=${tabId}`);
  chrome.storage.session.remove(`tab:${tabId}`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const from = sender.tab ? `tab:${sender.tab.id}` : 'popup/ext';
  if (msg.type !== 'LOG') {
    swLog('sw', 'info', `[msg:in] type=${msg.type} from=${from}`);
  }

  if (msg.type === 'SET_LOG_ENABLED') {
    logEnabled = !!msg.enabled;
    if (logEnabled) {
      chrome.storage.session.set({
        [LOG_ENABLED]: true,
        [LOG_START]: Date.now(),
        [LOG_KEY]: [],
      }).then(() => {
        swLog('sw', 'info', '[log] recording started');
        sendResponse({ ok: true });
      });
    } else {
      swLog('sw', 'info', '[log] recording stopped');
      chrome.storage.session.set({ [LOG_ENABLED]: false }).then(() => sendResponse({ ok: true }));
    }
    return true;
  }

  if (msg.type === 'SF_DETECTED_BY_FINGERPRINT' && sender.tab?.id) {
    handleFingerprintDetection(sender.tab.id, msg);
    return false;
  }

  if (msg.type === 'MANUAL_OVERRIDE') {
    handleManualOverride(msg).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_TAB_INFO' && sender.tab?.id) {
    swLog('sw', 'info', `[msg:GET_TAB_INFO] tab=${sender.tab.id}`);
    getTabInfo(sender.tab.id).then(info => sendResponse({ info }));
    return true;
  }

  if (msg.type === 'AURA_CONTEXT_CAPTURED' && sender.tab?.id) {
    handleContextCaptured(sender.tab.id, msg);
    return false;
  }

  if (msg.type === 'RUN_SCAN') {
    handleRunScan(msg.tabId);
    return false;
  }

  if (msg.type === 'LOG') {
    swLog(msg.source ?? 'content', msg.level ?? 'info', msg.msg ?? '');
    return false;
  }

  if (msg.type === 'RUN_AUTH_SCAN') {
    handleRunAuthScan(msg.tabId, msg.cookieHeader);
    return false;
  }

  if (msg.type === 'GET_COOKIE') {
    (async () => {
      const info = await getTabInfo(msg.tabId);
      if (!info?.origin) { sendResponse({ cookie: null }); return; }
      try {
        const cookie = await chrome.cookies.get({ url: info.origin, name: 'sid' });
        const found  = cookie ? `sid=***` : 'null';
        swLog('sw', 'info', `[cookie] sid lookup → ${found}`);
        sendResponse({ cookie: cookie ? `sid=${cookie.value}` : null });
      } catch (err) {
        swLog('sw', 'warn', `[cookie] lookup failed: ${err.message}`);
        sendResponse({ cookie: null });
      }
    })();
    return true;
  }
});

// Only trigger on actual Aura API calls (has /aura path + query params), not static assets
const AURA_API_RE = /\/(?:s\/sfsites\/)?aura\?/;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    if (!AURA_API_RE.test(url)) return;

    swLog('sw', 'info', `[net:detect] aura API tab=${details.tabId} url=${url.slice(0, 120)}`);
    handleNetworkDetection(details.tabId, url);
  },
  { urls: ['<all_urls>'] }
);
