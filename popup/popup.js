const DETECTION_LABELS = {
  'url-pattern': 'URL pattern',
  'fingerprint':  'Page fingerprint',
  'network':      'Network request',
  'manual':       'Manually enabled',
};

let currentTab = null;

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

function renderBadge(id, captured, capturedLabel, pendingLabel) {
  const el = document.getElementById(id);
  if (!el) return;
  if (captured) {
    el.textContent = capturedLabel;
    el.className = 'value badge badge-captured';
  } else {
    el.textContent = pendingLabel;
    el.className = 'value badge badge-pending';
  }
}

async function init() {
  currentTab = await getActiveTab();
  if (!currentTab) { show('panel-none'); renderForceToggle(false, true); return; }

  const result = await chrome.storage.session.get(`tab:${currentTab.id}`);
  const info = result[`tab:${currentTab.id}`] ?? null;

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

  // Identity
  setText('val-host', info.host);
  setText('val-app-path', info.appPath);
  setText('val-app-name', info.appName);

  const viaEl = document.getElementById('val-via');
  if (viaEl) {
    viaEl.textContent = DETECTION_LABELS[info.detectedVia] ?? info.detectedVia;
    viaEl.className = 'value badge badge-via badge-via-' + (info.detectedVia ?? 'unknown');
  }

  // Chunk 2: endpoint + capture status
  const endpoint = info.auraEndpoint ?? buildEndpoint(info.origin, info.appPath);
  setText('val-aura-endpoint', endpoint);

  renderBadge('val-context-status', !!info.auraContext, '✓ Captured', 'Pending');
  renderBadge('val-token-status',   !!info.auraToken,   '✓ Captured', 'Pending');

  // Force toggle only for manual (to allow disabling)
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
document.getElementById('force-enable-toggle')?.addEventListener('change', e => handleToggleChange(e.target.checked));
