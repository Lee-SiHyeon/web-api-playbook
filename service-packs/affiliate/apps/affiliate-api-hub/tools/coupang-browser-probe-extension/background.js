const RECEIVER = 'http://127.0.0.1:48765/result';
const TARGET_PREFIX = 'https://partners.coupang.com/';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_ROWS = 4000;

let running = false;

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return {
      origin: url.origin,
      path: url.pathname,
      queryFields: [...new Set([...url.searchParams.keys()])].sort().slice(0, 100),
      hashPath: url.hash ? url.hash.replace(/[?#].*$/, '').slice(0, 200) : ''
    };
  } catch {
    return null;
  }
}

function collectJsonKeys(value, prefix = '', output = new Set(), depth = 0) {
  if (depth > 6 || output.size >= 300 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) collectJsonKeys(item, prefix, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, nested] of Object.entries(value).slice(0, 100)) {
    if (!/^[A-Za-z_$][\w$.-]{0,100}$/.test(key)) continue;
    const full = prefix ? `${prefix}.${key}` : key;
    output.add(full);
    collectJsonKeys(nested, full, output, depth + 1);
  }
  return output;
}

function bodyFieldNames(postData, contentType = '') {
  if (typeof postData !== 'string' || !postData || postData.length > 2_000_000) return [];
  const fields = new Set();
  try {
    const parsed = JSON.parse(postData);
    for (const key of collectJsonKeys(parsed)) fields.add(key);
  } catch {}
  try {
    if (/application\/x-www-form-urlencoded/i.test(contentType) || /^[^={]+=[^&]*/.test(postData)) {
      for (const key of new URLSearchParams(postData).keys()) {
        if (/^[A-Za-z_$][\w$.-]{0,100}$/.test(key)) fields.add(key);
      }
    }
  } catch {}
  for (const match of postData.matchAll(/name=\"([A-Za-z_$][\w$.-]{0,100})\"/g)) fields.add(match[1]);
  return [...fields].sort().slice(0, 300);
}

function requestMetadata(request, resourceType = null) {
  const url = safeUrl(request?.url);
  if (!url) return null;
  const method = String(request?.method || '').toUpperCase();
  const contentType = Object.entries(request?.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
  return {
    method,
    ...url,
    resourceType: resourceType || null,
    bodyFieldNames: bodyFieldNames(request?.postData, String(contentType)),
    blocked: !READ_METHODS.has(method)
  };
}

function dedupe(rows) {
  const output = new Map();
  for (const row of rows) {
    if (!row) continue;
    const key = [row.method, row.origin, row.path, (row.queryFields || []).join(','), (row.bodyFieldNames || []).join(','), row.resourceType || '', row.blocked].join('|');
    if (!output.has(key)) output.set(key, row);
    else {
      const prior = output.get(key);
      if (row.httpStatus !== undefined) prior.httpStatus = row.httpStatus;
      if (row.mimeType) prior.mimeType = row.mimeType;
      if (row.failed) prior.failed = true;
    }
  }
  return [...output.values()].slice(0, MAX_ROWS);
}

async function command(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function evaluate(target) {
  const expression = `(() => {
    const take = (value, n) => Array.from(value || []).slice(0, n);
    return {
      title: document.title,
      location: location.href,
      links: take(document.querySelectorAll('a[href]'), 1000).map(a => ({
        label: (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        url: a.href
      })),
      forms: take(document.forms, 100).map(form => ({
        method: (form.method || 'GET').toUpperCase(),
        url: form.action || location.href,
        fieldNames: [...new Set(take(form.elements, 1000).map(element => element.name).filter(Boolean))].sort()
      })),
      scripts: take(document.scripts, 1000).map(script => script.src).filter(Boolean),
      frames: take(document.querySelectorAll('iframe[src]'), 300).map(frame => frame.src),
      storageKeys: {
        local: Array.from({length: localStorage.length}, (_, i) => localStorage.key(i)).filter(Boolean).sort(),
        session: Array.from({length: sessionStorage.length}, (_, i) => sessionStorage.key(i)).filter(Boolean).sort()
      },
      globals: Object.keys(window).filter(key => /(api|affiliate|partner|product|link|report|commission|campaign|promotion)/i.test(key)).sort().slice(0, 500)
    };
  })()`;
  const result = await command(target, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result?.result?.value || {};
}

function sanitizeDom(raw) {
  const links = (raw?.links || []).map(link => {
    const url = safeUrl(link.url);
    return url ? { label: String(link.label || '').slice(0, 160), ...url } : null;
  }).filter(Boolean);
  const forms = (raw?.forms || []).map(form => {
    const url = safeUrl(form.url);
    return url ? {
      method: String(form.method || 'GET').toUpperCase(),
      ...url,
      fieldNames: [...new Set((form.fieldNames || []).filter(name => /^[A-Za-z_$][\w$.-]{0,100}$/.test(name)))].sort().slice(0, 1000)
    } : null;
  }).filter(Boolean);
  return {
    title: String(raw?.title || '').slice(0, 200),
    page: safeUrl(raw?.location || ''),
    links: dedupe(links.map(link => ({ ...link, method: 'GET', resourceType: 'dom_link', blocked: false }))),
    forms,
    scripts: [...new Map((raw?.scripts || []).map(safeUrl).filter(Boolean).map(item => [JSON.stringify(item), item])).values()].slice(0, 1000),
    frames: [...new Map((raw?.frames || []).map(safeUrl).filter(Boolean).map(item => [JSON.stringify(item), item])).values()].slice(0, 300),
    storageKeys: {
      local: (raw?.storageKeys?.local || []).filter(name => typeof name === 'string').slice(0, 500),
      session: (raw?.storageKeys?.session || []).filter(name => typeof name === 'string').slice(0, 500)
    },
    globals: (raw?.globals || []).filter(name => typeof name === 'string').slice(0, 500)
  };
}

async function deliver(record) {
  const response = await fetch(RECEIVER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(record),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`receiver_${response.status}`);
}

async function runProbe() {
  if (running) return;
  running = true;
  await chrome.action.setBadgeText({ text: '...' });
  await chrome.action.setBadgeBackgroundColor({ color: '#666666' });
  let target = null;
  let listener = null;
  try {
    const tabs = await chrome.tabs.query({ url: `${TARGET_PREFIX}*` });
    const tab = tabs.find(item => item.active) || tabs[0];
    if (!tab?.id) throw new Error('coupang_tab_not_found');
    target = { tabId: tab.id };
    await chrome.debugger.attach(target, '1.3');

    const requests = [];
    const byId = new Map();
    listener = async (source, method, params) => {
      if (source.tabId !== target.tabId) return;
      try {
        if (method === 'Fetch.requestPaused') {
          const row = requestMetadata(params.request, params.resourceType);
          if (row) requests.push(row);
          if (row?.blocked) {
            await command(target, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
          } else {
            await command(target, 'Fetch.continueRequest', { requestId: params.requestId });
          }
        } else if (method === 'Network.requestWillBeSent') {
          const row = requestMetadata(params.request, params.type);
          if (row) { byId.set(params.requestId, row); requests.push(row); }
        } else if (method === 'Network.responseReceived') {
          const row = byId.get(params.requestId);
          if (row) {
            row.httpStatus = params.response?.status;
            row.mimeType = String(params.response?.mimeType || '').slice(0, 120);
          }
        } else if (method === 'Network.loadingFailed') {
          const row = byId.get(params.requestId);
          if (row) row.failed = true;
        }
      } catch {}
    };
    chrome.debugger.onEvent.addListener(listener);
    await command(target, 'Network.enable');
    await command(target, 'Runtime.enable');
    await command(target, 'Page.enable');
    await command(target, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await command(target, 'Page.reload', { ignoreCache: false });
    await new Promise(resolve => setTimeout(resolve, 12_000));
    const dom = sanitizeDom(await evaluate(target));
    const record = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      mode: 'logged_in_coupang_partners_read_only_browser_probe',
      target: dom.page,
      tabTitle: dom.title,
      requests: dedupe(requests),
      dom,
      blockedNonReadRequests: dedupe(requests.filter(row => row.blocked)),
      allowedReadRequests: requests.filter(row => !row.blocked).length,
      mutationRequestsSent: 0,
      cookieValuesCaptured: false,
      headerValuesCaptured: false,
      responseBodiesCaptured: false,
      requestBodyValuesCaptured: false,
      storageValuesCaptured: false
    };
    await deliver(record);
    await chrome.action.setBadgeText({ text: 'OK' });
    await chrome.action.setBadgeBackgroundColor({ color: '#16803a' });
  } catch (error) {
    try {
      await deliver({
        schemaVersion: 1,
        checkedAt: new Date().toISOString(),
        mode: 'logged_in_coupang_partners_read_only_browser_probe',
        completed: false,
        error: String(error?.message || error).slice(0, 200),
        mutationRequestsSent: 0,
        cookieValuesCaptured: false
      });
    } catch {}
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#a61b1b' });
  } finally {
    if (listener) chrome.debugger.onEvent.removeListener(listener);
    if (target) await chrome.debugger.detach(target).catch(() => {});
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => void runProbe());
chrome.runtime.onStartup.addListener(() => void runProbe());
chrome.action.onClicked.addListener(() => void runProbe());
