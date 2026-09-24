import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const INPUT = new URL('../evidence/coupang-netlog-sanitized.json', import.meta.url);
const OUTPUT = new URL('../evidence/coupang-public-script-analysis.json', import.meta.url);
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const allowedOrigin = 'https://partners.coupang.com';
const safeField = /^[A-Za-z0-9_.~-]{1,100}$/;

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function endpointMetadata(raw) {
  let url;
  try { url = new URL(raw, allowedOrigin); } catch { return null; }
  if (url.origin !== allowedOrigin || !url.pathname.startsWith('/')) return null;
  return {
    origin: url.origin,
    path: url.pathname,
    queryFields: [...new Set([...url.searchParams.keys()].filter(key => safeField.test(key)))].sort(),
  };
}

function capability(path = '') {
  const value = path.toLowerCase();
  if (/search|product|item|catalog|category/.test(value)) return 'catalog.search_or_get';
  if (/short.*link|deeplink|deep-link|link.*(?:create|generate)|generate.*link/.test(value)) return 'links.create';
  if (/report|performance|earning|stat|click|impression/.test(value)) return 'reports.summary';
  if (/conversion|transaction|order|purchase/.test(value)) return 'transactions.list';
  if (/commission|rate|reward/.test(value)) return 'commission.rules';
  if (/settlement|payout|payment|withdraw/.test(value)) return 'payouts.list';
  if (/campaign|affiliate|partner|subid/.test(value)) return 'programs.list_or_portal';
  if (/promotion|coupon|event/.test(value)) return 'promotions.list';
  if (/config|notification|region|kmc/.test(value)) return 'portal_support';
  return 'unclassified';
}

function methodHints(source, index) {
  const nearby = source.slice(Math.max(0, index - 220), Math.min(source.length, index + 420));
  const methods = new Set();
  for (const match of nearby.matchAll(/\b(?:method|type)\s*[:=]\s*["'](GET|POST|PUT|PATCH|DELETE)["']/gi)) {
    methods.add(match[1].toUpperCase());
  }
  for (const match of nearby.matchAll(/\.(get|post|put|patch|delete)\s*\(/gi)) methods.add(match[1].toUpperCase());
  for (const match of nearby.matchAll(/\b(fetch|request)\s*\(/gi)) {
    if (!methods.size) methods.add('UNKNOWN');
  }
  return [...methods].sort();
}

function dynamic(path) {
  return /\$\{|\{[A-Za-z_$]|:[A-Za-z_$]|\.concat\(|\+/.test(path);
}

export function analyzeSource(source, scriptUrl) {
  if (typeof source !== 'string' || typeof scriptUrl !== 'string') throw new TypeError('source and scriptUrl required');
  const candidates = [];
  const routeHints = new Set();
  const identifierHints = new Set();

  const literalPatterns = [
    /["'`]((?:https:\/\/partners\.coupang\.com)?\/(?:api|_sec)\/[A-Za-z0-9_./?={}:&%+\-$]+)["'`]/gi,
    /["'`](\/#(?:affiliate|report|link|product|dashboard)[A-Za-z0-9_./?=&%+\-$]*)["'`]/gi,
    /["'`]((?:\/?#?\/?)(?:affiliate|report|performance|earning|links?|products?|dashboard|subId)\/[A-Za-z0-9_./?=&%+\-$]{1,160})["'`]/gi,
  ];
  for (const pattern of literalPatterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1];
      if (!raw.includes('/api/') && !raw.includes('/_sec/')) {
        const normalizedRoute = raw.startsWith('/') ? raw : '/' + raw;
        routeHints.add(normalizedRoute.replace(/[?].*$/, ''));
        continue;
      }
      const metadata = endpointMetadata(raw);
      if (!metadata) continue;
      candidates.push({
        ...metadata,
        methods: methodHints(source, match.index ?? 0),
        capability: capability(metadata.path),
        dynamicPath: dynamic(raw),
        sourceScript: scriptUrl,
        confidence: 'public_bundle_literal',
        executable: false,
        valuesObserved: false,
      });
    }
  }

  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]{2,100})\s*(?=[:=(])/g)) {
    if (/(?:affiliate|partner|product|item|search|link|report|earning|commission|settlement|payout|campaign|subid|dashboard|conversion)/i.test(match[1])) {
      identifierHints.add(match[1]);
    }
    if (identifierHints.size >= 300) break;
  }

  const merged = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.origin}|${candidate.path}|${candidate.queryFields.join(',')}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    existing.methods = [...new Set([...existing.methods, ...candidate.methods])].sort();
    existing.dynamicPath ||= candidate.dynamicPath;
  }

  return {
    url: scriptUrl,
    bytes: Buffer.byteLength(source),
    sha256: createHash('sha256').update(source).digest('hex'),
    candidates: [...merged.values()].sort((a, b) => a.path.localeCompare(b.path)),
    routeHints: [...routeHints].sort(),
    identifierHints: [...identifierHints].sort(),
  };
}

async function boundedText(response) {
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SCRIPT_BYTES) throw new Error('SCRIPT_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('NO_BODY');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SCRIPT_BYTES) {
      await reader.cancel();
      throw new Error('SCRIPT_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export async function run({ input = INPUT, output = OUTPUT, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const netlog = JSON.parse(await readFile(input, 'utf8'));
  const scripts = [...new Set((netlog.endpoints || [])
    .filter(item => item.origin === allowedOrigin && /^\/static\/js\/.*\.js$/i.test(item.path))
    .map(item => item.origin + item.path))].sort();

  const analyses = [];
  const failures = [];
  let totalBytes = 0;
  for (const url of scripts) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/javascript,text/javascript;q=0.9,*/*;q=0.1' }, signal: AbortSignal.timeout(20000) });
      const source = await boundedText(response);
      totalBytes += Buffer.byteLength(source);
      analyses.push(analyzeSource(source, url));
    } catch (error) {
      failures.push({ url, code: String(error?.message || 'FETCH_FAILED').slice(0, 80) });
    }
  }

  const candidates = new Map();
  for (const analysis of analyses) {
    for (const candidate of analysis.candidates) {
      const key = `${candidate.origin}|${candidate.path}|${candidate.queryFields.join(',')}`;
      const existing = candidates.get(key);
      if (!existing) {
        candidates.set(key, { ...candidate, sources: [analysis.url] });
      } else {
        existing.methods = [...new Set([...existing.methods, ...candidate.methods])].sort();
        existing.sources.push(analysis.url);
        existing.sources = [...new Set(existing.sources)].sort();
        existing.dynamicPath ||= candidate.dynamicPath;
      }
    }
  }
  const checkedAt = now();
  const record = {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    mode: 'public_coupang_partner_bundle_analysis',
    sourceEvidence: basename(input.pathname),
    scriptsAttempted: scripts.length,
    scriptsAnalyzed: analyses.length,
    totalBytes,
    candidateCount: candidates.size,
    candidates: [...candidates.values()].sort((a, b) => `${a.capability}:${a.path}`.localeCompare(`${b.capability}:${b.path}`)),
    routeHints: [...new Set(analyses.flatMap(item => item.routeHints))].sort(),
    identifierHints: [...new Set(analyses.flatMap(item => item.identifierHints))].sort(),
    analyses: analyses.map(item => ({ url: item.url, bytes: item.bytes, sha256: item.sha256,
      candidateCount: item.candidates.length, routeHints: item.routeHints, identifierHints: item.identifierHints })),
    failures,
    credentialsUsed: false,
    cookieValuesPersisted: false,
    responseBodiesPersisted: false,
    mutationRequestsSent: 0,
  };
  await writeFile(output, JSON.stringify(record, null, 2) + '\n');
  const archive = new URL(`../evidence/coupang-public-script-analysis-${timestamp(checkedAt)}.json`, import.meta.url);
  await writeFile(archive, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return { record, output, archive };
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  run().then(({ record, archive }) => {
    console.log(JSON.stringify({ completed: true, scriptsAnalyzed: record.scriptsAnalyzed,
      candidateCount: record.candidateCount, routeHints: record.routeHints.length,
      evidenceFile: basename(archive.pathname), mutationRequestsSent: 0 }));
  }).catch(() => {
    console.error(JSON.stringify({ completed: false, code: 'COUPANG_SCRIPT_ANALYSIS_FAILED' }));
    process.exitCode = 1;
  });
}
