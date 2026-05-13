import { runCoreChecks } from './aura-checks.js';

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

async function injectContextExtractor(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content/context-extractor.js'],
    });
  } catch {}
}

// --- Detection layer handlers ---

async function handleLayer1(tabId, url) {
  const base = parseSFSiteInfo(url);
  if (!base) return;
  const auraEndpoint = buildAuraEndpoint(base.origin, base.appPath);
  await setTabInfo(tabId, { ...base, detectedVia: 'url-pattern', auraEndpoint });
  await setBadgeGreen(tabId);
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
  } catch {}
}

async function handleManualOverride({ tabId, url, enabled }) {
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
    } catch {}
  } else {
    await chrome.storage.session.remove(`tab:${tabId}`);
    await clearBadge(tabId);
  }
}

async function handleContextCaptured(tabId, msg) {
  const existing = await getTabInfo(tabId);
  if (!existing) return;

  const updated = { ...existing };
  if (msg.auraEndpoint && !updated.auraEndpoint) updated.auraEndpoint = msg.auraEndpoint;
  if (msg.auraContext) updated.auraContext = msg.auraContext;
  if (msg.auraToken)   updated.auraToken   = msg.auraToken;

  await setTabInfo(tabId, updated);
}

// --- Scan orchestration (guest + auth) ---

async function handleRunScan(tabId) {
  const info = await getTabInfo(tabId);
  if (!info) return;
  if (!info.auraEndpoint) return;
  if (!info.auraContext)  return;

  await setTabInfo(tabId, { ...info, scanState: 'running', scanProgress: null, scanResult: null, scanError: null });

  // Keep SW alive during long scans (MV3 SW may sleep after ~30s of inactivity)
  const keepAlive = setInterval(() => chrome.storage.session.get('__ka__'), 20_000);

  try {
    const result = await runCoreChecks(
      info.auraEndpoint,
      info.auraContext,
      info.auraToken ?? 'null',
      async (progress) => {
        const current = await getTabInfo(tabId);
        if (current) await setTabInfo(tabId, { ...current, scanProgress: progress });
      },
    );

    const current = await getTabInfo(tabId);
    await setTabInfo(tabId, { ...current, scanState: 'done', scanResult: result, scanProgress: null });
  } catch (err) {
    const current = await getTabInfo(tabId);
    await setTabInfo(tabId, { ...current, scanState: 'error', scanError: err.message, scanProgress: null });
  } finally {
    clearInterval(keepAlive);
  }
}

async function handleRunAuthScan(tabId, cookieHeader) {
  const info = await getTabInfo(tabId);
  if (!info?.auraEndpoint || !info?.auraContext) return;

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
      info.auraContext,
      info.auraToken ?? 'null',
      async (progress) => {
        const current = await getTabInfo(tabId);
        if (current) await setTabInfo(tabId, { ...current, authScanProgress: progress });
      },
      cookieHeader,
    );

    const current = await getTabInfo(tabId);
    await setTabInfo(tabId, { ...current, authScanState: 'done', authScanResult: result, authScanProgress: null });
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
  if (changeInfo.status === 'complete' && tab.url) updateTab(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) updateTab(tabId, tab.url);
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab:${tabId}`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SF_DETECTED_BY_FINGERPRINT' && sender.tab?.id) {
    handleFingerprintDetection(sender.tab.id, msg);
    return false;
  }

  if (msg.type === 'MANUAL_OVERRIDE') {
    handleManualOverride(msg).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_TAB_INFO' && sender.tab?.id) {
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
        sendResponse({ cookie: cookie ? `sid=${cookie.value}` : null });
      } catch {
        sendResponse({ cookie: null });
      }
    })();
    return true;
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    if (!url.includes('/aura') && !url.includes('.salesforce.com') && !url.includes('.force.com')) return;

    try {
      const u = new URL(url);
      if (AURA_PATH_RE.test(u.pathname) || SF_HOST_RE.test(u.hostname)) {
        handleNetworkDetection(details.tabId, url);
      }
    } catch {}
  },
  { urls: ['<all_urls>'] }
);
