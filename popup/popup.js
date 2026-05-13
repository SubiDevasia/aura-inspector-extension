const DETECTION_LABELS = {
  'url-pattern': 'URL pattern',
  'fingerprint':  'Page fingerprint',
  'network':      'Network request',
  'manual':       'Manually enabled',
};

let currentTab   = null;
let pollTimer    = null;

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

// --- Scan button state ---

function setScanButton(info) {
  const btn = document.getElementById('btn-scan');
  if (!btn) return;
  const canScan = !!info?.auraContext;
  const running = info?.scanState === 'running';

  btn.disabled    = !canScan || running;
  btn.textContent = running         ? 'Scanning…'
                  : info?.scanResult ? 'Re-run Scan'
                  : 'Run Scan';
}

// --- Progress bar ---

function renderProgress(progress) {
  if (!progress) { hide('scan-progress'); return; }

  show('scan-progress');
  const pct = progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = pct + '%';

  const label = progress.phase === 'getConfigData'
    ? 'Fetching object list…'
    : `Checking objects: ${progress.done} / ${progress.total}`;
  setText('progress-label', label);
}

// --- Results rendering ---

function renderResults(result) {
  if (!result) { hide('scan-results'); return; }

  show('scan-results');

  const duration = result.finishedAt - result.startedAt;
  setText('val-scan-duration', fmtDuration(duration));
  setText('val-objects-count', fmtCount(result.objectCount));

  // Accessible count badge
  const accEl = document.getElementById('val-accessible-count');
  if (accEl) {
    const count = result.accessible?.length ?? 0;
    accEl.textContent = count === 0 ? '0 (none exposed)' : `${count} object${count > 1 ? 's' : ''}`;
    accEl.className   = 'value badge ' + (count > 0 ? 'badge-finding' : 'badge-captured');
  }

  // Bypass row
  const bypassCount = result.bypassWorks?.length ?? 0;
  if (bypassCount > 0) {
    setText('val-bypass-count', `${bypassCount} object${bypassCount > 1 ? 's' : ''} bypass 2k limit`);
    show('row-bypass');
  } else {
    hide('row-bypass');
  }

  // Error row
  const errCount = result.errors?.length ?? 0;
  if (errCount > 0) {
    setText('val-errors-count', `${errCount} object${errCount > 1 ? 's' : ''} errored`);
    show('row-errors');
  } else {
    hide('row-errors');
  }

  // Accessible objects list
  const list = document.getElementById('accessible-list');
  if (list) {
    list.innerHTML = '';
    const items = result.accessible ?? [];
    if (items.length > 0) {
      show('accessible-list');
      for (const { name, total } of items) {
        const row = document.createElement('div');
        row.className = 'obj-row';
        row.innerHTML = `<span class="obj-name">${name}</span><span class="obj-count">${fmtCount(total)}</span>`;
        list.appendChild(row);
      }
    } else {
      hide('accessible-list');
    }
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

// --- Main init ---

async function init() {
  stopPolling();
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

  renderBadge('val-context-status', !!info.auraContext, '✓ Captured', 'Pending');
  renderBadge('val-token-status',   !!info.auraToken,   '✓ Captured', 'Pending');

  setScanButton(info);

  // Restore scan state from session
  if (info.scanState === 'running') {
    renderProgress(info.scanProgress ?? null);
    startPolling(currentTab.id);
  } else {
    hide('scan-progress');
    if (info.scanState === 'done' && info.scanResult) renderResults(info.scanResult);
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
  // Optimistic UI update; SW will set scanState='running' in storage
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

init();
document.getElementById('btn-scan')?.addEventListener('click', handleScanClick);
document.getElementById('force-enable-toggle')?.addEventListener('change', e => handleToggleChange(e.target.checked));
