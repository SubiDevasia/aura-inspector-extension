// Chunk 3: Core Aura security checks — getConfigData, getItems, sortBy bypass
// Pure functions: take (endpoint, context, token) → return structured results.
// Called by service-worker.js; no chrome.* APIs used here.

const BATCH_SIZE = 100; // Aura supports up to 100 actions per request

// ---------------------------------------------------------------------------
// Low-level Aura POST
// ---------------------------------------------------------------------------

async function auraPost(endpoint, context, token, actions) {
  const body = new URLSearchParams();
  body.set('message',      JSON.stringify({ actions }));
  body.set('aura.context', JSON.stringify(context));
  body.set('aura.token',   token ?? 'null');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'omit', // guest context; Chunk 5 adds cookie support
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const text = await res.text();
  // Aura sometimes prepends /*-secure-community-protect;...–*/ before JSON
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) throw new Error(`Unexpected Aura response: ${text.slice(0, 80)}`);
  return JSON.parse(text.slice(jsonStart));
}

// ---------------------------------------------------------------------------
// Check 1: getConfigData — enumerate all objects the site exposes
// ---------------------------------------------------------------------------

export async function checkGetConfigData(endpoint, context, token) {
  const actions = [{
    id: '1;a',
    descriptor: 'serviceComponent://ui.force.components.controllers.hostConfig.HostConfigController/ACTION$getConfigData',
    callingDescriptor: 'UNKNOWN',
    params: {},
  }];

  const response = await auraPost(endpoint, context, token, actions);
  const action   = response.actions?.[0];

  if (action?.state !== 'SUCCESS') {
    return {
      state: 'ERROR',
      error: action?.error?.[0]?.message ?? `state=${action?.state ?? 'unknown'}`,
      objects: [],
    };
  }

  const objects = Object.keys(action.returnValue?.apiNamesToKeyPrefix ?? {}).sort();
  return { state: 'SUCCESS', objects };
}

// ---------------------------------------------------------------------------
// Check 2: getItems — probe record access per object, batched 100/request
// ---------------------------------------------------------------------------

function makeGetItemsAction(objName, extraParams = {}) {
  return {
    id: objName,
    descriptor: 'serviceComponent://ui.force.components.controllers.lists.selectableListDataProvider.SelectableListDataProviderController/ACTION$getItems',
    callingDescriptor: 'UNKNOWN',
    params: {
      entityNameOrId: objName,
      layoutType:     'FULL',
      pageSize:       100,
      currentPage:    0,
      useTimeout:     false,
      getCount:       true,
      enableRowActions: false,
      ...extraParams,
    },
  };
}

export async function checkGetItems(endpoint, context, token, objects, onBatchDone) {
  const results = {}; // objName → { state, total?, error? }

  for (let i = 0; i < objects.length; i += BATCH_SIZE) {
    const batch   = objects.slice(i, i + BATCH_SIZE);
    const actions = batch.map(obj => makeGetItemsAction(obj));

    try {
      const response = await auraPost(endpoint, context, token, actions);
      for (const action of (response.actions ?? [])) {
        const name = action.id;
        if (action.state === 'SUCCESS') {
          const rv    = action.returnValue ?? {};
          const total = rv.total ?? rv.records?.length ?? 0;
          results[name] = { state: 'SUCCESS', total };
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

    if (onBatchDone) onBatchDone(i + batch.length, objects.length);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 3: sortBy bypass — re-probe objects with total > 2000
// ---------------------------------------------------------------------------

export async function checkSortByBypass(endpoint, context, token, getItemsResults) {
  const targets = Object.entries(getItemsResults)
    .filter(([, r]) => r.state === 'SUCCESS' && r.total > 2000)
    .map(([name]) => name);

  if (targets.length === 0) return {};

  const bypass = {};

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch   = targets.slice(i, i + BATCH_SIZE);
    const actions = batch.map(obj => makeGetItemsAction(obj, { sortBy: 'Id' }));

    try {
      const response = await auraPost(endpoint, context, token, actions);
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
  }

  return bypass;
}

// ---------------------------------------------------------------------------
// Orchestrator — runs all three checks and returns a compact summary
// ---------------------------------------------------------------------------

export async function runCoreChecks(endpoint, context, token, onProgress) {
  const startedAt = Date.now();

  // Check 1
  onProgress?.({ phase: 'getConfigData', done: 0, total: 1 });
  const configData = await checkGetConfigData(endpoint, context, token);

  if (configData.state !== 'SUCCESS' || configData.objects.length === 0) {
    return {
      startedAt,
      finishedAt:      Date.now(),
      endpoint,
      objectCount:     0,
      accessible:      [],
      errors:          [],
      bypassWorks:     [],
      configDataState: configData.state,
      configDataError: configData.error,
    };
  }

  const { objects } = configData;

  // Check 2
  const getItems = await checkGetItems(
    endpoint, context, token, objects,
    (done, total) => onProgress?.({ phase: 'getItems', done, total }),
  );

  // Check 3
  const sortByBypass = await checkSortByBypass(endpoint, context, token, getItems);

  // Compact summary (avoid storing raw records in session storage)
  const accessible = Object.entries(getItems)
    .filter(([, r]) => r.state === 'SUCCESS' && r.total > 0)
    .map(([name, r]) => ({ name, total: r.total }))
    .sort((a, b) => b.total - a.total);

  const errors = Object.entries(getItems)
    .filter(([, r]) => r.state === 'ERROR')
    .map(([name, r]) => ({ name, error: r.error }));

  const bypassWorks = Object.entries(sortByBypass)
    .filter(([, r]) => r.bypassWorks)
    .map(([name, r]) => ({ name, total: r.total }));

  return {
    startedAt,
    finishedAt:      Date.now(),
    endpoint,
    objectCount:     objects.length,
    accessible,
    errors,
    bypassWorks,
    configDataState: 'SUCCESS',
  };
}
