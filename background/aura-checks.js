// Aura security checks — Chunks 3, 4, 5 & 7.
// Pure functions: take (endpoint, context, token, ...) → structured results.
// No chrome.* APIs. Called by service-worker.js.

import { HOME_URL_PROBES } from './home-url-probes.js';

const BATCH_SIZE        = 100;
const REQUEST_TIMEOUT   = 15_000;  // ms — per Aura POST
const PROBE_TIMEOUT     = 10_000;  // ms — per HEAD probe
const BATCH_DELAY       = 200;     // ms — between batches (rate limit)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Low-level Aura POST  (with timeout)
// ---------------------------------------------------------------------------

async function auraPost(endpoint, context, token, actions, cookieHeader = null) {
  const body = new URLSearchParams();
  body.set('message',      JSON.stringify({ actions }));
  body.set('aura.context', JSON.stringify(context));
  body.set('aura.token',   token ?? 'null');

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body:        body.toString(),
      credentials: 'omit',
      signal:      controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const text = await res.text();
    const jsonStart = text.indexOf('{');
    if (jsonStart === -1) throw new Error(`Unexpected Aura response: ${text.slice(0, 80)}`);
    return JSON.parse(text.slice(jsonStart));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap: get real Aura context from server using empty context
// Every Aura POST response includes the server's context — no page injection needed
// ---------------------------------------------------------------------------

export async function bootstrapAuraContext(endpoint, token = 'null', cookieHeader = null) {
  try {
    const actions = [{
      id: '0;b',
      descriptor: 'serviceComponent://ui.force.components.controllers.hostConfig.HostConfigController/ACTION$getConfigData',
      callingDescriptor: 'UNKNOWN',
      params: {},
    }];
    const response = await auraPost(endpoint, {}, token, actions, cookieHeader);
    return response.context ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Check 1: getConfigData
// ---------------------------------------------------------------------------

export async function checkGetConfigData(endpoint, context, token, cookieHeader = null) {
  const actions = [{
    id: '1;a',
    descriptor: 'serviceComponent://ui.force.components.controllers.hostConfig.HostConfigController/ACTION$getConfigData',
    callingDescriptor: 'UNKNOWN',
    params: {},
  }];

  const response = await auraPost(endpoint, context, token, actions, cookieHeader);

  // Server always returns a context — use it to bootstrap when caller had none
  const serverContext = response.context ?? null;
  const action        = response.actions?.[0];

  if (action?.state !== 'SUCCESS') {
    return {
      state: 'ERROR',
      error: action?.error?.[0]?.message ?? `state=${action?.state ?? 'unknown'}`,
      objects: [],
      serverContext,
    };
  }

  const objects = Object.keys(action.returnValue?.apiNamesToKeyPrefix ?? {}).sort();
  return { state: 'SUCCESS', objects, serverContext };
}

// ---------------------------------------------------------------------------
// Check 2: getItems (batched + rate-limited)
// ---------------------------------------------------------------------------

function makeGetItemsAction(objName, extraParams = {}) {
  return {
    id: objName,
    descriptor: 'serviceComponent://ui.force.components.controllers.lists.selectableListDataProvider.SelectableListDataProviderController/ACTION$getItems',
    callingDescriptor: 'UNKNOWN',
    params: {
      entityNameOrId:   objName,
      layoutType:       'FULL',
      pageSize:         100,
      currentPage:      0,
      useTimeout:       false,
      getCount:         true,
      enableRowActions: false,
      ...extraParams,
    },
  };
}

export async function checkGetItems(endpoint, context, token, objects, onBatchDone, cookieHeader = null) {
  const results = {};

  for (let i = 0; i < objects.length; i += BATCH_SIZE) {
    const batch   = objects.slice(i, i + BATCH_SIZE);
    const actions = batch.map(obj => makeGetItemsAction(obj));

    try {
      const response = await auraPost(endpoint, context, token, actions, cookieHeader);
      for (const action of (response.actions ?? [])) {
        const name = action.id;
        if (action.state === 'SUCCESS') {
          const rv = action.returnValue ?? {};
          results[name] = { state: 'SUCCESS', total: rv.total ?? rv.records?.length ?? 0 };
        } else {
          results[name] = {
            state: action.state,
            error: action.error?.[0]?.message ?? `state=${action.state}`,
          };
        }
      }
    } catch (err) {
      for (const obj of batch) results[obj] = { state: 'ERROR', error: err.message };
    }

    onBatchDone?.(i + batch.length, objects.length);
    if (i + BATCH_SIZE < objects.length) await sleep(BATCH_DELAY);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 3: sortBy bypass (rate-limited)
// ---------------------------------------------------------------------------

export async function checkSortByBypass(endpoint, context, token, getItemsResults, cookieHeader = null) {
  const targets = Object.entries(getItemsResults)
    .filter(([, r]) => r.state === 'SUCCESS' && r.total > 2000)
    .map(([name]) => name);

  if (targets.length === 0) return {};

  const bypass = {};

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch   = targets.slice(i, i + BATCH_SIZE);
    const actions = batch.map(obj => makeGetItemsAction(obj, { sortBy: 'Id' }));

    try {
      const response = await auraPost(endpoint, context, token, actions, cookieHeader);
      for (const action of (response.actions ?? [])) {
        const name  = action.id;
        const total = action.returnValue?.total ?? null;
        bypass[name] = {
          state:       action.state,
          total,
          bypassWorks: action.state === 'SUCCESS' && (total ?? 0) > 2000,
        };
      }
    } catch (err) {
      for (const obj of batch) bypass[obj] = { state: 'ERROR', error: err.message };
    }

    if (i + BATCH_SIZE < targets.length) await sleep(BATCH_DELAY);
  }

  return bypass;
}

// ---------------------------------------------------------------------------
// Check 4: getInitialListViews (batched + rate-limited)
// ---------------------------------------------------------------------------

export async function checkGetInitialListViews(endpoint, context, token, objects, onBatchDone, cookieHeader = null) {
  const results = {};

  for (let i = 0; i < objects.length; i += BATCH_SIZE) {
    const batch   = objects.slice(i, i + BATCH_SIZE);
    const actions = batch.map(obj => ({
      id: obj,
      descriptor: 'serviceComponent://ui.force.components.controllers.lists.listViewPickerDataProvider.ListViewPickerDataProviderController/ACTION$getInitialListViews',
      callingDescriptor: 'UNKNOWN',
      params: { objectApiName: obj },
    }));

    try {
      const response = await auraPost(endpoint, context, token, actions, cookieHeader);
      for (const action of (response.actions ?? [])) {
        const name      = action.id;
        const listViews = action.returnValue?.listViews ?? [];
        results[name] = {
          state: action.state,
          count: action.state === 'SUCCESS' ? listViews.length : 0,
          views: listViews.slice(0, 20).map(lv => ({ id: lv.id, label: lv.label })),
        };
      }
    } catch (err) {
      for (const obj of batch) results[obj] = { state: 'ERROR', count: 0 };
    }

    onBatchDone?.(i + batch.length, objects.length);
    if (i + BATCH_SIZE < objects.length) await sleep(BATCH_DELAY);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 5: Home URL enumeration (with per-probe timeout)
// ---------------------------------------------------------------------------

export async function checkHomeUrls(origin, cookieHeader = null) {
  const results = [];

  for (const { path, label } of HOME_URL_PROBES) {
    const url        = origin + path;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), PROBE_TIMEOUT);

    try {
      const headers = {};
      if (cookieHeader) headers['Cookie'] = cookieHeader;
      const res = await fetch(url, {
        method:      'HEAD',
        headers,
        credentials: 'omit',
        redirect:    'follow',
        signal:      controller.signal,
      });
      results.push({ path, label, url, status: res.status, exposed: res.status === 200 });
    } catch {
      results.push({ path, label, url, status: null, exposed: false });
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 6: Self-registration probe
// ---------------------------------------------------------------------------

function interpretSelfReg(action) {
  if (action.state === 'SUCCESS') return { enabled: true, evidence: 'Action returned SUCCESS' };

  const msg = (action.error?.[0]?.message ?? '').toLowerCase();

  if (/self.?registration is not enabled|community self.?registration/.test(msg)) {
    return { enabled: false, evidence: action.error?.[0]?.message };
  }

  if (/already registered|already exists|password|invalid email|username|required field/.test(msg)) {
    return { enabled: true, evidence: action.error?.[0]?.message };
  }

  return { enabled: null, evidence: action.error?.[0]?.message ?? `state=${action.state}` };
}

export async function checkSelfRegistration(endpoint, context, token, cookieHeader = null) {
  const probeEmail = `aura-probe-${Date.now()}@aura-inspector-probe.invalid`;

  const actions = [{
    id: '1;a',
    descriptor: 'apex://LightningLoginFormController/ACTION$selfRegister',
    callingDescriptor: 'UNKNOWN',
    params: {
      regConfirmUrl:  null,
      firstName:      'AuraInspector',
      lastName:       'Probe',
      email:          probeEmail,
      password:       'AuraInspect0r!Probe',
      confirmPassword:'AuraInspect0r!Probe',
      extraFields:    [],
    },
  }];

  try {
    const response = await auraPost(endpoint, context, token, actions, cookieHeader);
    const action   = response.actions?.[0];
    if (!action) return { state: 'ERROR', enabled: null, evidence: 'No action in response' };
    return { state: action.state, ...interpretSelfReg(action) };
  } catch (err) {
    return { state: 'ERROR', enabled: false, evidence: err.message };
  }
}

// ---------------------------------------------------------------------------
// Check 7: GraphQL / cursor-page bypass (rate-limited)
// ---------------------------------------------------------------------------

export async function checkGraphQLBypass(endpoint, context, token, accessibleObjects, cookieHeader = null) {
  const targets = accessibleObjects
    .filter(obj => obj.total > 2000)
    .slice(0, 10)
    .map(obj => obj.name);

  if (targets.length === 0) return [];

  const bypass = [];

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch   = targets.slice(i, i + BATCH_SIZE);
    const actions = batch.map(obj => makeGetItemsAction(obj, {
      currentPage: 20,
      getCount:    false,
    }));

    try {
      const response = await auraPost(endpoint, context, token, actions, cookieHeader);
      for (const action of (response.actions ?? [])) {
        const records = action.returnValue?.records ?? [];
        bypass.push({
          name:         action.id,
          state:        action.state,
          recordsFound: records.length,
          bypassWorks:  action.state === 'SUCCESS' && records.length > 0,
        });
      }
    } catch (err) {
      for (const obj of batch) bypass.push({ name: obj, state: 'ERROR', bypassWorks: false });
    }

    if (i + BATCH_SIZE < targets.length) await sleep(BATCH_DELAY);
  }

  return bypass;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runCoreChecks(endpoint, context, token, onProgress, cookieHeader = null) {
  const startedAt = Date.now();
  const origin    = new URL(endpoint).origin;

  // Check 1 — always use {} context so server bootstraps fresh.
  // Sending a stored context with aura.token='null' causes HTTP 400 on sites
  // that enforce CSRF validation for non-empty contexts.
  onProgress?.({ phase: 'getConfigData', done: 0, total: 1, label: 'Fetching object list…' });
  const configData = await checkGetConfigData(endpoint, {}, token, cookieHeader);

  // Always use the server-returned context for all subsequent checks.
  const effectiveContext = configData.serverContext ?? context ?? {};

  if (configData.state !== 'SUCCESS' || configData.objects.length === 0) {
    return {
      startedAt, finishedAt: Date.now(), endpoint, objectCount: 0,
      accessible: [], errors: [], bypassWorks: [],
      listViews: [], homeUrls: [], selfReg: null, graphqlBypass: [],
      configDataState: configData.state, configDataError: configData.error,
      bootstrappedContext: configData.serverContext ?? null,
    };
  }

  const { objects } = configData;

  // Check 2
  const getItems = await checkGetItems(
    endpoint, effectiveContext, token, objects,
    (done, total) => onProgress?.({ phase: 'getItems', done, total, label: `Probing objects: ${done}/${total}` }),
    cookieHeader,
  );

  // Check 3
  onProgress?.({ phase: 'sortBy', done: 0, total: 1, label: 'Testing sortBy bypass…' });
  const sortByBypass = await checkSortByBypass(endpoint, effectiveContext, token, getItems, cookieHeader);

  // Check 4
  const listViewsRaw = await checkGetInitialListViews(
    endpoint, effectiveContext, token, objects,
    (done, total) => onProgress?.({ phase: 'listViews', done, total, label: `Checking list views: ${done}/${total}` }),
    cookieHeader,
  );

  // Check 5
  onProgress?.({ phase: 'homeUrls', done: 0, total: HOME_URL_PROBES.length, label: 'Probing admin URLs…' });
  const homeUrlsRaw = await checkHomeUrls(origin, cookieHeader);

  // Check 6
  onProgress?.({ phase: 'selfReg', done: 0, total: 1, label: 'Testing self-registration…' });
  const selfReg = await checkSelfRegistration(endpoint, effectiveContext, token, cookieHeader);

  // Build accessible list for Check 7
  const accessible = Object.entries(getItems)
    .filter(([, r]) => r.state === 'SUCCESS' && r.total > 0)
    .map(([name, r]) => ({ name, total: r.total }))
    .sort((a, b) => b.total - a.total);

  // Check 7
  onProgress?.({ phase: 'graphql', done: 0, total: 1, label: 'Testing GraphQL bypass…' });
  const graphqlBypassRaw = await checkGraphQLBypass(endpoint, effectiveContext, token, accessible, cookieHeader);

  // Compact summaries
  const errors = Object.entries(getItems)
    .filter(([, r]) => r.state === 'ERROR')
    .map(([name, r]) => ({ name, error: r.error }));

  const bypassWorks = Object.entries(sortByBypass)
    .filter(([, r]) => r.bypassWorks)
    .map(([name, r]) => ({ name, total: r.total }));

  const listViews = Object.entries(listViewsRaw)
    .filter(([, r]) => r.count > 0)
    .map(([name, r]) => ({ name, count: r.count }))
    .sort((a, b) => b.count - a.count);

  const homeUrls      = homeUrlsRaw.filter(h => h.exposed);
  const graphqlBypass = graphqlBypassRaw.filter(r => r.bypassWorks);

  return {
    startedAt,
    finishedAt:          Date.now(),
    endpoint,
    objectCount:         objects.length,
    accessible,
    errors,
    bypassWorks,
    listViews,
    homeUrls,
    selfReg,
    graphqlBypass,
    configDataState:     'SUCCESS',
    bootstrappedContext: configData.serverContext ?? null,
  };
}
