import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const NETLOG = new URL('../evidence/coupang-netlog-sanitized.json', import.meta.url);
const SCRIPTS = new URL('../evidence/coupang-public-script-analysis.json', import.meta.url);
const SHAPES = new URL('../references/coupang-request-shape-hints.json', import.meta.url);
const REFERENCE = new URL('../references/coupang-portal-contracts.json', import.meta.url);

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function classifyCapability(path = '') {
  const value = String(path).toLowerCase();
  if (/\/api\/v1\/(?:search|discovery|performance\/product|widgets\/instances\/search)|product|catalog|category/.test(value)) return 'catalog.search_or_get';
  if (/\/api\/v1\/(?:url|banner)|deeplink|short.*link|copyurl/.test(value)) return 'links.create_or_list';
  if (/settlement|payout/.test(value)) return 'payouts.read';
  if (/\/api\/v1\/(?:earning|performance|report|downloads\/async\/reports)|dashboard/.test(value)) return 'reports.read';
  if (/commission|high-commission|top-commission|reward|rate/.test(value)) return 'commission.discovery';
  if (/events|promotion|coupon/.test(value)) return 'promotions.read';
  if (/widgets|dynamic-banner|search-bar/.test(value)) return 'widgets.manage_or_read';
  if (/subid|trackingcode/.test(value)) return 'tracking_ids.manage_or_read';
  if (/affiliate|payment|kmc|profile|registration|unsubscribe|associated-account/.test(value)) return 'account.manage_or_read';
  if (/config|notification|region|wdpop|_sec/.test(value)) return 'portal.support';
  return 'unclassified';
}

function operationNature(path, methods = []) {
  const methodSet = new Set(methods);
  const capability = classifyCapability(path);
  if (capability === 'catalog.search_or_get' || capability === 'reports.read' || capability === 'payouts.read'
    || capability === 'commission.discovery' || capability === 'promotions.read') return 'read_query';
  if (capability === 'links.create_or_list') return methodSet.has('POST') ? 'link_generation_or_write' : 'read_query';
  if (capability === 'widgets.manage_or_read' || capability === 'tracking_ids.manage_or_read') {
    return methodSet.has('POST') || methodSet.has('PUT') || methodSet.has('DELETE') ? 'mixed_read_write' : 'read_query';
  }
  if (capability === 'account.manage_or_read') {
    return methodSet.has('POST') || methodSet.has('PUT') || methodSet.has('DELETE') ? 'account_mutation' : 'account_read';
  }
  return methodSet.has('POST') || methodSet.has('PUT') || methodSet.has('DELETE') ? 'unknown_write_or_query' : 'read_query';
}

function priority(capability, liveObserved) {
  if (['catalog.search_or_get', 'links.create_or_list', 'reports.read', 'payouts.read'].includes(capability)) return liveObserved ? 'P0' : 'P1';
  if (['commission.discovery', 'promotions.read', 'widgets.manage_or_read', 'tracking_ids.manage_or_read'].includes(capability)) return 'P1';
  return 'P2';
}

function normalizedKey(origin, path) {
  return `${origin ?? 'origin-unresolved'}|${path}`;
}

export function buildCatalog(netlog, scripts, shapes = { shapes: [] }, { now = () => new Date() } = {}) {
  const map = new Map();
  for (const request of netlog?.observedRequests || []) {
    if (request.origin !== 'https://partners.coupang.com'
      || (!request.path.startsWith('/api/') && !request.path.startsWith('/_sec/'))) continue;
    const key = normalizedKey(request.origin, request.path);
    const capability = classifyCapability(request.path);
    const observedMethods = [...new Set(request.methods || [])].filter(method => method !== 'OPTIONS').sort();
    map.set(key, {
      id: createHash('sha256').update(key).digest('hex').slice(0, 20),
      origin: request.origin,
      path: request.path,
      methodsObserved: observedMethods,
      preflightObserved: (request.methods || []).includes('OPTIONS'),
      methodsHinted: [],
      queryFields: [...new Set(request.queryFields || [])].sort(),
      statusesObserved: [...new Set(request.statuses || [])].sort((a, b) => a - b),
      capability,
      operationNature: operationNature(request.path, observedMethods),
      liveObserved: request.requestObserved === true,
      responseObserved: request.responseObserved === true,
      response200Verified: (request.statuses || []).includes(200),
      sources: ['coupang-netlog-sanitized.json:authenticated_browser_session'],
      confidence: ['live_authenticated_netlog'],
      priority: priority(capability, true),
      authContext: 'existing_chrome_default_profile_session',
      bodySchemaObserved: false,
      bodySchemaHinted: false,
      bodyFieldHints: [],
      pathParameters: [],
      filterColumns: [],
      opaqueBodyObject: false,
      valuesPersisted: false,
      executable: false,
    });
  }

  for (const candidate of scripts?.candidates || []) {
    if (candidate.origin !== 'https://partners.coupang.com' || !candidate.path?.startsWith('/')) continue;
    const key = normalizedKey(candidate.origin, candidate.path);
    const existing = map.get(key);
    const capability = classifyCapability(candidate.path);
    if (!existing) {
      map.set(key, {
        id: createHash('sha256').update(key).digest('hex').slice(0, 20),
        origin: candidate.origin,
        path: candidate.path,
        methodsObserved: [],
        preflightObserved: false,
        methodsHinted: [...new Set(candidate.methods || [])].sort(),
        queryFields: [...new Set(candidate.queryFields || [])].sort(),
        statusesObserved: [],
        capability,
        operationNature: operationNature(candidate.path, candidate.methods || []),
        liveObserved: false,
        responseObserved: false,
        response200Verified: false,
        sources: ['coupang-public-script-analysis.json:public_bundle'],
        confidence: ['public_bundle_literal'],
        priority: priority(capability, false),
        authContext: 'unknown_or_portal_session',
        bodySchemaObserved: false,
        bodySchemaHinted: false,
        bodyFieldHints: [],
        pathParameters: [],
        filterColumns: [],
        opaqueBodyObject: false,
        valuesPersisted: false,
        executable: false,
      });
      continue;
    }
    existing.methodsHinted = [...new Set([...existing.methodsHinted, ...(candidate.methods || [])])].sort();
    existing.queryFields = [...new Set([...existing.queryFields, ...(candidate.queryFields || [])])].sort();
    existing.sources = [...new Set([...existing.sources, 'coupang-public-script-analysis.json:public_bundle'])].sort();
    existing.confidence = [...new Set([...existing.confidence, 'public_bundle_literal'])].sort();
  }

  for (const shape of shapes?.shapes || []) {
    if (!shape?.path?.startsWith('/')) continue;
    const key = normalizedKey('https://partners.coupang.com', shape.path);
    let existing = map.get(key);
    if (!existing) {
      const capability = classifyCapability(shape.path);
      existing = {
        id: createHash('sha256').update(key).digest('hex').slice(0, 20),
        origin: 'https://partners.coupang.com',
        path: shape.path,
        methodsObserved: [],
        preflightObserved: false,
        methodsHinted: shape.method ? [shape.method] : [],
        queryFields: [],
        statusesObserved: [],
        capability,
        operationNature: operationNature(shape.path, shape.method ? [shape.method] : []),
        liveObserved: false,
        responseObserved: false,
        response200Verified: false,
        sources: [],
        confidence: [],
        priority: priority(capability, false),
        authContext: 'unknown_or_portal_session',
        bodySchemaObserved: false,
        bodySchemaHinted: false,
        bodyFieldHints: [],
        pathParameters: [],
        filterColumns: [],
        opaqueBodyObject: false,
        valuesPersisted: false,
        executable: false,
      };
      map.set(key, existing);
    }
    if (shape.method) existing.methodsHinted = [...new Set([...existing.methodsHinted, shape.method])].sort();
    existing.queryFields = [...new Set([...existing.queryFields, ...(shape.queryFields || [])])].sort();
    existing.bodyFieldHints = [...new Set([...existing.bodyFieldHints, ...(shape.bodyFields || [])])].sort();
    existing.pathParameters = [...new Set([...existing.pathParameters, ...(shape.pathParameters || [])])].sort();
    existing.filterColumns = [...new Set([...existing.filterColumns, ...(shape.filterColumns || [])])].sort();
    existing.opaqueBodyObject ||= shape.opaqueBodyObject === true;
    existing.bodySchemaHinted ||= existing.bodyFieldHints.length > 0 || existing.opaqueBodyObject;
    existing.sources = [...new Set([...existing.sources, 'coupang-request-shape-hints.json:public_bundle_direct_call'])].sort();
    existing.confidence = [...new Set([...existing.confidence, shape.confidence || 'public_bundle_direct_call'])].sort();
  }

  const contracts = [...map.values()].sort((a, b) => `${a.priority}:${a.capability}:${a.path}`.localeCompare(`${b.priority}:${b.capability}:${b.path}`));
  const checkedAt = now();
  return {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    provider: 'coupang_partners',
    mode: 'portal_contract_candidate_catalog',
    sessionReuse: {
      browser: 'Google Chrome Stable',
      profile: 'Default',
      strategy: 'in_place_existing_session',
      cookieValuesCopied: false,
      sessionTokenValuesCopied: false,
      credentialsPersisted: false,
    },
    sourceEvidence: ['coupang-netlog-sanitized.json', 'coupang-public-script-analysis.json', 'coupang-request-shape-hints.json'],
    contractCount: contracts.length,
    liveObservedCount: contracts.filter(item => item.liveObserved).length,
    response200VerifiedCount: contracts.filter(item => item.response200Verified).length,
    executableCount: 0,
    bodySchemasObserved: 0,
    valuesPersisted: false,
    contracts,
  };
}

export async function run({ netlogFile = NETLOG, scriptsFile = SCRIPTS, shapesFile = SHAPES,
  reference = REFERENCE, now = () => new Date() } = {}) {
  const netlog = JSON.parse(await readFile(netlogFile, 'utf8'));
  const scripts = JSON.parse(await readFile(scriptsFile, 'utf8'));
  const shapes = JSON.parse(await readFile(shapesFile, 'utf8'));
  const record = buildCatalog(netlog, scripts, shapes, { now });
  const text = JSON.stringify(record, null, 2) + '\n';
  await writeFile(reference, text);
  const evidence = new URL(`../evidence/coupang-portal-contracts-${timestamp(new Date(record.checkedAt))}.json`, import.meta.url);
  await writeFile(evidence, text, { flag: 'wx' });
  return { record, reference, evidence };
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  run().then(({ record, evidence }) => {
    console.log(JSON.stringify({ completed: true, contractCount: record.contractCount,
      liveObservedCount: record.liveObservedCount, response200VerifiedCount: record.response200VerifiedCount,
      evidenceFile: basename(evidence.pathname), executableCount: 0 }));
  }).catch(() => {
    console.error(JSON.stringify({ completed: false, code: 'COUPANG_CATALOG_BUILD_FAILED' }));
    process.exitCode = 1;
  });
}
