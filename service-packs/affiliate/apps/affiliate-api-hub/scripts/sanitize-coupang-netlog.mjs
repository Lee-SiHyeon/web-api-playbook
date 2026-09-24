import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_INPUT = new URL('../evidence/coupang-netlog-20260919-151448.json', import.meta.url);
const DEFAULT_OUTPUT = new URL('../evidence/coupang-netlog-sanitized.json', import.meta.url);
const safeField = /^[A-Za-z0-9_.~-]{1,100}$/;
const firstPartyHost = /(^|\.)(?:coupang\.com|coupangcdn\.com)$/i;
const apiWord = /(?:^|\/)(?:api|apis|v\d+|affiliate|partner|product|item|search|link|deeplink|report|performance|earning|commission|campaign|conversion|transaction|order|settlement|payout|payment)(?:\/|$)/i;
const secretName = /authorization|cookie|token|session|password|secret|signature|credential|jwt|api[-_]?key/i;

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function redactPath(pathname) {
  const parts = pathname.split('/').map(part => {
    if (!part) return part;
    if (/^\d{8,}$/.test(part)) return ':number';
    if (/^[0-9a-f]{16,}$/i.test(part)) return ':hex';
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ':uuid';
    if (part.length > 80) return ':opaque';
    return part;
  });
  return parts.join('/') || '/';
}

export function sanitizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return {
    origin: url.origin,
    host: url.hostname.toLowerCase(),
    path: redactPath(url.pathname),
    queryFields: [...new Set([...url.searchParams.keys()].filter(key => safeField.test(key)))].sort(),
    firstParty: firstPartyHost.test(url.hostname),
  };
}

function strings(value, output = [], depth = 0) {
  if (depth > 10 || output.length > 5000) return output;
  if (typeof value === 'string') { output.push(value); return output; }
  if (Array.isArray(value)) {
    for (const item of value) strings(item, output, depth + 1);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, output, depth + 1);
  }
  return output;
}

function urlCandidates(value) {
  const found = [];
  for (const text of strings(value)) {
    if (/^https?:\/\//i.test(text)) found.push(text);
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) found.push(match[0]);
  }
  return [...new Set(found)].map(sanitizeUrl).filter(Boolean);
}

function methodHints(value) {
  const methods = new Set();
  for (const text of strings(value)) {
    for (const match of text.matchAll(/(?:^|\s|:)(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)(?:\s|$)/gi)) {
      methods.add(match[1].toUpperCase());
    }
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/method/i.test(key) && typeof item === 'string' && /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/i.test(item)) {
        methods.add(item.toUpperCase());
      }
    }
  }
  return [...methods].sort();
}

function statusHints(value) {
  const statuses = new Set();
  const visit = (item, depth = 0) => {
    if (depth > 10 || item == null) return;
    if (typeof item === 'string') {
      for (const match of item.matchAll(/(?:HTTP\/\d(?:\.\d)?\s+|:status\s*[:=]\s*)(\d{3})/gi)) statuses.add(Number(match[1]));
      return;
    }
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (/status|response.*code|http.*code/i.test(key) && Number.isInteger(Number(child)) && Number(child) >= 100 && Number(child) <= 599) {
          statuses.add(Number(child));
        }
        visit(child, depth + 1);
      }
    }
  };
  visit(value);
  return [...statuses].sort((a, b) => a - b);
}

function headerNames(value) {
  const names = new Set();
  const visit = (item, key = '', depth = 0) => {
    if (depth > 10 || item == null) return;
    if (typeof item === 'string' && /header/i.test(key)) {
      const index = item.indexOf(':');
      if (index > 0) {
        const name = item.slice(0, index).trim().toLowerCase();
        if (/^:?[a-z0-9-]{1,80}$/.test(name)) names.add(name);
      }
      return;
    }
    if (Array.isArray(item)) { for (const child of item) visit(child, key, depth + 1); return; }
    if (typeof item === 'object') {
      for (const [childKey, child] of Object.entries(item)) {
        if (/header/i.test(key) && /^:?[a-z0-9-]{1,80}$/i.test(childKey)) names.add(childKey.toLowerCase());
        visit(child, childKey, depth + 1);
      }
    }
  };
  visit(value);
  return [...names].sort();
}

function capabilities(path) {
  const result = [];
  const text = path.toLowerCase();
  if (/product|item|search|catalog/.test(text)) result.push('catalog.search_or_get');
  if (/deeplink|short.*link|link.*create|tracking.*link/.test(text)) result.push('links.create');
  if (/report|performance|earning|stat/.test(text)) result.push('reports.summary');
  if (/conversion|transaction|order/.test(text)) result.push('transactions.list');
  if (/commission|rate/.test(text)) result.push('commission.rules');
  if (/settlement|payout|payment/.test(text)) result.push('payouts.list');
  if (/campaign|affiliate|partner/.test(text)) result.push('programs.list_or_portal');
  if (/promotion|coupon/.test(text)) result.push('promotions.list');
  return [...new Set(result)];
}

export function sanitizeNetLog(data, { sourceName = 'netlog.json', now = () => new Date() } = {}) {
  const typeMap = data?.constants?.logEventTypes || {};
  const reverseTypes = new Map(Object.entries(typeMap).map(([name, id]) => [id, name]));
  const records = new Map();
  const requestSources = new Map();
  const hosts = new Map();
  const eventTypeCounts = new Map();

  for (const event of Array.isArray(data?.events) ? data.events : []) {
    const type = reverseTypes.get(event.type) || String(event.type);
    eventTypeCounts.set(type, (eventTypeCounts.get(type) || 0) + 1);
    const urls = urlCandidates(event.params);
    const methods = methodHints(event.params);
    const statuses = statusHints(event.params);
    const headers = headerNames(event.params).filter(name => !secretName.test(name));
    const sourceId = event?.source?.id;
    const sourceType = event?.source?.type;
    if (sourceId !== undefined && sourceId !== null) {
      const sourceKey = `${sourceType ?? 'unknown'}:${sourceId}`;
      const source = requestSources.get(sourceKey) || {
        sourceKey,
        urls: new Map(),
        methods: new Set(),
        statuses: new Set(),
        eventTypes: new Set(),
        headerNames: new Set(),
        events: 0,
      };
      for (const url of urls) source.urls.set(`${url.origin}|${url.path}|${url.queryFields.join(',')}`, url);
      for (const method of methods) source.methods.add(method);
      for (const status of statuses) source.statuses.add(status);
      for (const header of headers) source.headerNames.add(header);
      source.eventTypes.add(type);
      source.events++;
      requestSources.set(sourceKey, source);
    }
    for (const url of urls) {
      hosts.set(url.host, (hosts.get(url.host) || 0) + 1);
      if (!url.firstParty) continue;
      const key = `${url.origin}|${url.path}`;
      const existing = records.get(key) || {
        id: createHash('sha256').update(key).digest('hex').slice(0, 20),
        origin: url.origin,
        path: url.path,
        queryFields: new Set(),
        methods: new Set(),
        statuses: new Set(),
        eventTypes: new Set(),
        headerNames: new Set(),
        observations: 0,
      };
      for (const field of url.queryFields) existing.queryFields.add(field);
      for (const method of methods) existing.methods.add(method);
      for (const status of statuses) existing.statuses.add(status);
      for (const header of headers) existing.headerNames.add(header);
      existing.eventTypes.add(type);
      existing.observations++;
      records.set(key, existing);
    }
  }

  const endpoints = [...records.values()].map(record => ({
    id: record.id,
    origin: record.origin,
    path: record.path,
    methods: [...record.methods].sort(),
    queryFields: [...record.queryFields].sort(),
    statuses: [...record.statuses].sort((a, b) => a - b),
    headerNames: [...record.headerNames].sort(),
    eventTypes: [...record.eventTypes].sort(),
    observations: record.observations,
    likelyApi: apiWord.test(record.path),
    capabilities: capabilities(record.path),
    executable: false,
    valuesPersisted: false,
  })).sort((a, b) => `${a.origin}${a.path}`.localeCompare(`${b.origin}${b.path}`));

  const observedRequestMap = new Map();
  for (const source of requestSources.values()) {
    const firstPartyUrls = [...source.urls.values()].filter(url => url.firstParty);
    if (!firstPartyUrls.length) continue;
    const eventTypes = [...source.eventTypes].sort();
    const requestObserved = eventTypes.some(type => /URL_REQUEST_START_JOB|REQUEST_ALIVE|SEND_REQUEST|CORS_REQUEST/.test(type));
    const responseObserved = eventTypes.some(type => /READ_RESPONSE_HEADERS|RECV_HEADERS|RESPONSE_STARTED/.test(type));
    if (!requestObserved && !responseObserved) continue;
    for (const url of firstPartyUrls) {
      const methods = [...source.methods].filter(method => method !== 'UNKNOWN').sort();
      const key = `${url.origin}|${url.path}|${methods.join(',')}|${url.queryFields.join(',')}`;
      const existing = observedRequestMap.get(key) || {
        id: createHash('sha256').update(key).digest('hex').slice(0, 20),
        origin: url.origin,
        path: url.path,
        methods: new Set(),
        queryFields: new Set(),
        statuses: new Set(),
        headerNames: new Set(),
        eventTypes: new Set(),
        sourceCount: 0,
        eventCount: 0,
        requestObserved: false,
        responseObserved: false,
      };
      for (const method of methods) existing.methods.add(method);
      for (const field of url.queryFields) existing.queryFields.add(field);
      for (const status of source.statuses) existing.statuses.add(status);
      for (const header of source.headerNames) existing.headerNames.add(header);
      for (const eventType of eventTypes) existing.eventTypes.add(eventType);
      existing.sourceCount++;
      existing.eventCount += source.events;
      existing.requestObserved ||= requestObserved;
      existing.responseObserved ||= responseObserved;
      observedRequestMap.set(key, existing);
    }
  }
  const observedRequests = [...observedRequestMap.values()].map(record => ({
    id: record.id,
    origin: record.origin,
    path: record.path,
    methods: [...record.methods].sort(),
    queryFields: [...record.queryFields].sort(),
    statuses: [...record.statuses].sort((a, b) => a - b),
    headerNames: [...record.headerNames].sort(),
    eventTypes: [...record.eventTypes].sort(),
    sourceCount: record.sourceCount,
    eventCount: record.eventCount,
    requestObserved: record.requestObserved,
    responseObserved: record.responseObserved,
    likelyApi: apiWord.test(record.path),
    capabilities: capabilities(record.path),
    executable: false,
    valuesPersisted: false,
  })).sort((a, b) => `${a.origin}${a.path}:${a.methods.join(',')}`.localeCompare(`${b.origin}${b.path}:${b.methods.join(',')}`));

  const checkedAt = now();
  return {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    source: sourceName,
    sourceSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    mode: 'offline_netlog_metadata_sanitization',
    eventCount: Array.isArray(data?.events) ? data.events.length : 0,
    endpoints,
    observedRequests,
    observedRequestContracts: observedRequests.filter(request => request.requestObserved).length,
    observedResponseContracts: observedRequests.filter(request => request.responseObserved).length,
    likelyApiEndpoints: endpoints.filter(endpoint => endpoint.likelyApi).length,
    firstPartyEndpoints: endpoints.length,
    observedHosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([host, observations]) => ({ host, observations })),
    topEventTypes: [...eventTypeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50)
      .map(([type, count]) => ({ type, count })),
    cookieValuesPersisted: false,
    authorizationValuesPersisted: false,
    queryValuesPersisted: false,
    requestBodiesPersisted: false,
    responseBodiesPersisted: false,
    rawHeadersPersisted: false,
    mutationRequestsSent: 0,
  };
}

export function parseNetLogText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('NETLOG_EMPTY');
  try {
    return { data: JSON.parse(text), sourceComplete: true, repairedTrailingEventsArray: false };
  } catch (originalError) {
    const trimmed = text.trimEnd();
    // chrome://net-export writes a streaming JSON document whose events array remains open
    // until the user stops capture. A snapshot ending immediately after a complete event and
    // comma can be closed without guessing or altering any event content.
    if (!trimmed.startsWith('{"constants"') || !trimmed.includes('"events"') || !trimmed.endsWith(',')) {
      throw originalError;
    }
    const repaired = trimmed.slice(0, -1) + ']}';
    return { data: JSON.parse(repaired), sourceComplete: false, repairedTrailingEventsArray: true };
  }
}

export async function run({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT, now = () => new Date() } = {}) {
  const raw = await readFile(input);
  const parsed = parseNetLogText(raw.toString('utf8'));
  const data = parsed.data;
  const record = sanitizeNetLog(data, { sourceName: basename(input.pathname || String(input)), now });
  record.sourceComplete = parsed.sourceComplete;
  record.repairedTrailingEventsArray = parsed.repairedTrailingEventsArray;
  record.sourceSnapshotBytes = raw.length;
  await writeFile(output, JSON.stringify(record, null, 2) + '\n');
  return { record, output };
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  run().then(({ record, output }) => {
    console.log(JSON.stringify({ completed: true, eventCount: record.eventCount,
      firstPartyEndpoints: record.firstPartyEndpoints, likelyApiEndpoints: record.likelyApiEndpoints,
      outputFile: basename(output.pathname), mutationRequestsSent: 0 }));
  }).catch(() => {
    console.error(JSON.stringify({ completed: false, code: 'NETLOG_SANITIZATION_FAILED' }));
    process.exitCode = 1;
  });
}
