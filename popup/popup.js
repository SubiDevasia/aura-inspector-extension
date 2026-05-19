const DETECTION_LABELS = {
  'url-pattern': 'URL pattern',
  'fingerprint':  'Page fingerprint',
  'network':      'Network request',
  'manual':       'Manually enabled',
};

let currentTab    = null;
let pollTimer     = null;
let authPollTimer = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function buildEndpoint(origin, appPath) {
  return origin + (appPath === '/' ? '' : appPath) + '/s/sfsites/aura';
}

function fmtDuration(ms) {
  return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`;
}

function fmtCount(n) {
  return n?.toLocaleString() ?? '—';
}

// --- Badge helpers ---

function renderBadge(id, captured, capturedLabel, pendingLabel) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = captured ? capturedLabel : pendingLabel;
  el.className   = 'value badge ' + (captured ? 'badge-captured' : 'badge-pending');
}

function renderContextBadge(id, value, checked, notFoundLabel = 'Not found') {
  const el = document.getElementById(id);
  if (!el) return;
  if (value) {
    el.textContent = '✓ Captured';
    el.className   = 'value badge badge-captured';
  } else if (checked) {
    el.textContent = notFoundLabel;
    el.className   = 'value badge badge-not-found';
  } else {
    el.textContent = 'Pending';
    el.className   = 'value badge badge-pending';
  }
}

// --- Scan button state ---

function setScanButton(info) {
  const btn = document.getElementById('btn-scan');
  if (!btn) return;
  const canScan = !!info?.auraEndpoint;
  const running = info?.scanState === 'running';

  btn.disabled    = !canScan || running;
  btn.textContent = running         ? 'Scanning…'
                  : info?.scanResult ? 'Re-run Scan'
                  : 'Run Scan';
}

function setAuthScanButton(info) {
  const btn = document.getElementById('btn-auth-scan');
  if (!btn) return;
  const hasCookie = !!(document.getElementById('cookie-input')?.value?.trim());
  const canScan   = !!info?.auraEndpoint && hasCookie;
  const running   = info?.authScanState === 'running';

  btn.disabled    = !canScan || running;
  btn.textContent = running               ? 'Scanning…'
                  : info?.authScanResult  ? 'Re-run Auth Scan'
                  : 'Run Auth Scan';
}

// --- Progress bars ---

function renderProgress(progress) {
  if (!progress) { hide('scan-progress'); return; }
  show('scan-progress');
  const pct = (progress.total > 0) ? Math.round((progress.done / progress.total) * 100) : 0;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = pct + '%';
  setText('progress-label', progress.label ?? 'Running…');
}

function renderAuthProgress(progress) {
  if (!progress) { hide('auth-scan-progress'); return; }
  show('auth-scan-progress');
  const pct = (progress.total > 0) ? Math.round((progress.done / progress.total) * 100) : 0;
  const fill = document.getElementById('auth-progress-fill');
  if (fill) fill.style.width = pct + '%';
  setText('auth-progress-label', progress.label ?? 'Running…');
}

// --- Results rendering ---

function renderObjList(listId, items, valueKey, valueFn) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = '';
  if (!items?.length) { hide(listId); return; }
  show(listId);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'obj-row';
    row.innerHTML = `<span class="obj-name">${item.name ?? item.path ?? item.label ?? ''}</span>`
                  + `<span class="obj-count">${valueFn ? valueFn(item) : fmtCount(item[valueKey])}</span>`;
    list.appendChild(row);
  }
}

function showFindingRow(rowId, valId, count, singular, plural) {
  if (count > 0) {
    setText(valId, `${count} ${count === 1 ? singular : plural}`);
    show(rowId);
  } else {
    hide(rowId);
  }
}

function renderResults(result) {
  if (!result) { hide('scan-results'); hide('export-section'); return; }

  show('scan-results');
  show('export-section');

  setText('val-scan-duration', fmtDuration(result.finishedAt - result.startedAt));
  setText('val-objects-count', fmtCount(result.objectCount));

  // Accessible objects (Check 2)
  const accEl = document.getElementById('val-accessible-count');
  if (accEl) {
    const count = result.accessible?.length ?? 0;
    accEl.textContent = count === 0 ? '0 — none exposed' : `${count} object${count > 1 ? 's' : ''}`;
    accEl.className   = 'value badge ' + (count > 0 ? 'badge-finding' : 'badge-captured');
  }
  renderObjList('accessible-list', result.accessible, 'total', i => fmtCount(i.total) + ' records');

  // sortBy bypass (Check 3)
  showFindingRow('row-bypass', 'val-bypass-count',
    result.bypassWorks?.length ?? 0, 'object bypasses 2k limit', 'objects bypass 2k limit');

  // Errors
  showFindingRow('row-errors', 'val-errors-count',
    result.errors?.length ?? 0, 'object errored', 'objects errored');

  // List Views (Check 4)
  showFindingRow('row-listviews', 'val-listviews-count',
    result.listViews?.length ?? 0, 'object exposes list views', 'objects expose list views');

  // Admin URLs (Check 5)
  const homeCount = result.homeUrls?.length ?? 0;
  if (homeCount > 0) {
    setText('val-homeurls-count', `${homeCount} path${homeCount > 1 ? 's' : ''} exposed`);
    show('row-homeurls');
    const urlList = document.getElementById('homeurl-list');
    if (urlList) {
      urlList.innerHTML = '';
      show('homeurl-list');
      for (const { path, label, status } of result.homeUrls) {
        const row = document.createElement('div');
        row.className = 'obj-row';
        row.innerHTML = `<span class="obj-name" title="${path}">${label}</span>`
                      + `<span class="obj-count">${status}</span>`;
        urlList.appendChild(row);
      }
    }
  } else {
    hide('row-homeurls');
    hide('homeurl-list');
  }

  // Self-registration (Check 6)
  const sr = result.selfReg;
  if (sr) {
    show('row-selfreg');
    const srEl = document.getElementById('val-selfreg');
    if (srEl) {
      if (sr.enabled === true)  { srEl.textContent = '⚠ Enabled';       srEl.className = 'value badge badge-finding'; }
      if (sr.enabled === false) { srEl.textContent = '✓ Not enabled';   srEl.className = 'value badge badge-captured'; }
      if (sr.enabled === null)  { srEl.textContent = 'Inconclusive';    srEl.className = 'value badge badge-pending'; }
    }
  } else {
    hide('row-selfreg');
  }

  // GraphQL bypass (Check 7)
  showFindingRow('row-graphql', 'val-graphql-count',
    result.graphqlBypass?.length ?? 0, 'object bypasses via page 21', 'objects bypass via page 21');
}

// --- Auth diff + results ---

function computeDiff(guestResult, authResult) {
  if (!authResult || !guestResult) return { newAccess: [] };
  const guestNames = new Set((guestResult.accessible ?? []).map(o => o.name));
  const newAccess  = (authResult.accessible ?? []).filter(o => !guestNames.has(o.name));
  return { newAccess };
}

function renderAuthResults(authResult, guestResult) {
  if (!authResult) { hide('auth-scan-results'); return; }

  show('auth-scan-results');
  setText('val-auth-scan-duration', fmtDuration(authResult.finishedAt - authResult.startedAt));

  const { newAccess } = computeDiff(guestResult, authResult);
  const newEl = document.getElementById('val-new-access');
  if (newEl) {
    const count = newAccess.length;
    newEl.textContent = count === 0 ? '0 — no new access' : `${count} new object${count > 1 ? 's' : ''}`;
    newEl.className   = 'value badge ' + (count > 0 ? 'badge-finding' : 'badge-captured');
  }
  renderObjList('new-accessible-list', newAccess, 'total', i => fmtCount(i.total) + ' records');

  const sr = authResult.selfReg;
  if (sr) {
    show('row-auth-selfreg');
    const srEl = document.getElementById('val-auth-selfreg');
    if (srEl) {
      if (sr.enabled === true)  { srEl.textContent = '⚠ Enabled';     srEl.className = 'value badge badge-finding'; }
      if (sr.enabled === false) { srEl.textContent = '✓ Not enabled'; srEl.className = 'value badge badge-captured'; }
      if (sr.enabled === null)  { srEl.textContent = 'Inconclusive';  srEl.className = 'value badge badge-pending'; }
    }
  } else {
    hide('row-auth-selfreg');
  }
}

// --- Poll session storage while scan is running ---

function startPolling(tabId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    const r    = await chrome.storage.session.get(`tab:${tabId}`);
    const info = r[`tab:${tabId}`];
    if (!info) { stopPolling(); return; }

    renderProgress(info.scanProgress ?? null);
    setScanButton(info);

    if (info.scanState !== 'running') {
      stopPolling();
      hide('scan-progress');
      if (info.scanState === 'done') renderResults(info.scanResult);
      if (info.scanState === 'error') {
        show('scan-results');
        setText('val-objects-count', `Error: ${info.scanError}`);
      }
    }
  }, 500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startAuthPolling(tabId) {
  stopAuthPolling();
  authPollTimer = setInterval(async () => {
    const r    = await chrome.storage.session.get(`tab:${tabId}`);
    const info = r[`tab:${tabId}`];
    if (!info) { stopAuthPolling(); return; }

    renderAuthProgress(info.authScanProgress ?? null);
    setAuthScanButton(info);

    if (info.authScanState !== 'running') {
      stopAuthPolling();
      hide('auth-scan-progress');
      if (info.authScanState === 'done') renderAuthResults(info.authScanResult, info.scanResult);
    }
  }, 500);
}

function stopAuthPolling() {
  if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; }
}

// --- Main init ---

async function init() {
  stopPolling();
  stopAuthPolling();
  currentTab = await getActiveTab();
  if (!currentTab) { show('panel-none'); renderForceToggle(false, true); return; }

  const r    = await chrome.storage.session.get(`tab:${currentTab.id}`);
  const info = r[`tab:${currentTab.id}`] ?? null;

  if (info) renderSF(info);
  else renderNone();
}

function renderNone() {
  hide('panel-sf');
  show('panel-none');
  renderForceToggle(false, true);
}

function renderSF(info) {
  hide('panel-none');
  show('panel-sf');

  setText('val-host',      info.host);
  setText('val-app-path',  info.appPath);

  const viaEl = document.getElementById('val-via');
  if (viaEl) {
    viaEl.textContent = DETECTION_LABELS[info.detectedVia] ?? info.detectedVia;
    viaEl.className   = 'value badge badge-via badge-via-' + (info.detectedVia ?? 'unknown');
  }

  const endpoint = info.auraEndpoint ?? buildEndpoint(info.origin, info.appPath);
  setText('val-aura-endpoint', endpoint);

  renderContextBadge('val-context-status', info.auraContext, info.auraContextChecked, 'Not found');
  renderContextBadge('val-token-status',   info.auraToken,   info.auraContextChecked, 'None — guest');

  setScanButton(info);
  setAuthScanButton(info);

  // Restore guest scan state
  if (info.scanState === 'running') {
    renderProgress(info.scanProgress ?? null);
    startPolling(currentTab.id);
  } else {
    hide('scan-progress');
    if (info.scanState === 'done' && info.scanResult) renderResults(info.scanResult);
  }

  // Restore auth scan state
  if (info.authScanState === 'running') {
    renderAuthProgress(info.authScanProgress ?? null);
    startAuthPolling(currentTab.id);
  } else {
    hide('auth-scan-progress');
    if (info.authScanState === 'done' && info.authScanResult) {
      renderAuthResults(info.authScanResult, info.scanResult);
    }
  }

  const isManual = info.detectedVia === 'manual';
  renderForceToggle(isManual, isManual);
}

function renderForceToggle(checked, visible) {
  const section = document.getElementById('force-enable-section');
  const toggle  = document.getElementById('force-enable-toggle');
  if (!section || !toggle) return;
  section.classList.toggle('hidden', !visible);
  if (visible) toggle.checked = checked;
}

// --- User actions ---

async function handleScanClick() {
  if (!currentTab) return;
  chrome.runtime.sendMessage({ type: 'RUN_SCAN', tabId: currentTab.id });
  const r    = await chrome.storage.session.get(`tab:${currentTab.id}`);
  const info = r[`tab:${currentTab.id}`];
  if (info) setScanButton({ ...info, scanState: 'running' });
  hide('scan-results');
  startPolling(currentTab.id);
}

async function handleToggleChange(checked) {
  if (!currentTab) return;
  await chrome.runtime.sendMessage({
    type: 'MANUAL_OVERRIDE',
    tabId: currentTab.id,
    url: currentTab.url,
    enabled: checked,
  });
  await init();
}

async function handleAutoDetectCookie() {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: ['cookies'] });
  } catch {
    return;
  }
  if (!granted || !currentTab) return;

  const r = await chrome.runtime.sendMessage({ type: 'GET_COOKIE', tabId: currentTab.id });
  if (r?.cookie) {
    document.getElementById('cookie-input').value = r.cookie;
    refreshAuthScanButton();
  }
}

function refreshAuthScanButton() {
  if (!currentTab) return;
  chrome.storage.session.get(`tab:${currentTab.id}`).then(r => {
    const info = r[`tab:${currentTab.id}`] ?? {};
    setAuthScanButton(info);
  });
}

async function handleAuthScanClick() {
  if (!currentTab) return;
  const cookie = document.getElementById('cookie-input')?.value?.trim();
  if (!cookie) return;

  chrome.runtime.sendMessage({ type: 'RUN_AUTH_SCAN', tabId: currentTab.id, cookieHeader: cookie });
  const r    = await chrome.storage.session.get(`tab:${currentTab.id}`);
  const info = r[`tab:${currentTab.id}`];
  if (info) setAuthScanButton({ ...info, authScanState: 'running' });
  hide('auth-scan-results');
  startAuthPolling(currentTab.id);
}

// --- Chunk 6: export ---

function buildReport(info) {
  return {
    generatedAt:  new Date().toISOString(),
    site: {
      host:         info.host,
      appPath:      info.appPath,
      detectedVia:  info.detectedVia,
      auraEndpoint: info.auraEndpoint,
    },
    guestScan:  info.scanResult     ?? null,
    authScan:   info.authScanResult ?? null,
    diff:       info.authScanResult ? computeDiff(info.scanResult, info.authScanResult) : null,
  };
}

function triggerDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slugDate() {
  return new Date().toISOString().slice(0, 10);
}

async function handleExportJSON() {
  if (!currentTab) return;
  const r    = await chrome.storage.session.get(`tab:${currentTab.id}`);
  const info = r[`tab:${currentTab.id}`];
  if (!info?.scanResult) return;
  const filename = `aura-report-${info.host}-${slugDate()}.json`;
  triggerDownload(JSON.stringify(buildReport(info), null, 2), filename, 'application/json');
}

async function handleExportCSV() {
  if (!currentTab) return;
  const r    = await chrome.storage.session.get(`tab:${currentTab.id}`);
  const info = r[`tab:${currentTab.id}`];
  if (!info?.scanResult) return;

  const bypassSet   = new Set((info.scanResult.bypassWorks   ?? []).map(o => o.name));
  const listViewSet = new Set((info.scanResult.listViews     ?? []).map(o => o.name));
  const graphqlSet  = new Set((info.scanResult.graphqlBypass ?? []).map(o => o.name));
  const guestNames  = new Set((info.scanResult.accessible    ?? []).map(o => o.name));

  const rows = [['scan_type', 'object', 'records', 'bypass_2k', 'list_views', 'graphql_bypass', 'new_auth_access']];

  for (const obj of (info.scanResult.accessible ?? [])) {
    rows.push([
      'guest',
      obj.name,
      obj.total,
      bypassSet.has(obj.name)   ? 'yes' : 'no',
      listViewSet.has(obj.name) ? 'yes' : 'no',
      graphqlSet.has(obj.name)  ? 'yes' : 'no',
      'no',
    ]);
  }

  for (const obj of (info.authScanResult?.accessible ?? [])) {
    if (!guestNames.has(obj.name)) {
      rows.push(['auth_only', obj.name, obj.total, 'no', 'no', 'no', 'yes']);
    }
  }

  for (const { label, path, status } of (info.scanResult.homeUrls ?? [])) {
    rows.push(['admin_url', label, path, status, '', '', '']);
  }

  const csv      = rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const filename = `aura-report-${info.host}-${slugDate()}.csv`;
  triggerDownload(csv, filename, 'text/csv');
}

init();
document.getElementById('btn-scan')?.addEventListener('click', handleScanClick);
document.getElementById('btn-auth-scan')?.addEventListener('click', handleAuthScanClick);
document.getElementById('btn-auto-cookie')?.addEventListener('click', handleAutoDetectCookie);
document.getElementById('cookie-input')?.addEventListener('input', refreshAuthScanButton);
document.getElementById('btn-export-json')?.addEventListener('click', handleExportJSON);
document.getElementById('btn-export-csv')?.addEventListener('click', handleExportCSV);
document.getElementById('force-enable-toggle')?.addEventListener('change', e => handleToggleChange(e.target.checked));
