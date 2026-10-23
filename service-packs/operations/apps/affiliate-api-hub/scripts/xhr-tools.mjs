import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectShoppingSessions } from './shopping-session-status.mjs';
import { webApiPlaybookRoot } from '../adapters/web-auth-provider.mjs';

const HTML_LIMIT = 8 * 1024 * 1024;
const REQUESTS_LIMIT = 8 * 1024 * 1024;
const HAR_LIMIT = 32 * 1024 * 1024;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const MAX_CONTRACTS = 2000;
const MAX_OBSERVATIONS = 20000;
const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/;
const SAFE_CODES = new Set([
  'XHR_ARGUMENTS_INVALID', 'XHR_COMMAND_INVALID', 'XHR_INPUT_REQUIRED', 'XHR_INPUT_TOO_LARGE',
  'XHR_INPUT_READ_FAILED', 'XHR_INPUT_SCHEMA_INVALID', 'XHR_HTML_BASE_INVALID', 'XHR_DOM_ANALYSIS_FAILED',
  'XHR_HAR_TOOL_UNAVAILABLE', 'XHR_HAR_PARSE_FAILED', 'XHR_OUTPUT_TOO_LARGE', 'XHR_OUTPUT_CREATE_FAILED',
  'XHR_BROWSER_PROBE_UNAVAILABLE', 'SHOPPING_STATUS_INPUT_OR_PROVIDER_FAILED',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  return SAFE_CODES.has(error?.code) ? error.code : 'XHR_TOOL_FAILED';
}

function usage() {
  return {
    kind: 'xhr_tools', schemaVersion: 1,
    tools: [
      { command: 'list', description: 'Show available local analysis commands.', examples: ['xhr-tools.mjs list'] },
      { command: 'sessions [service ...]', description: 'Report saved shopping-session readiness metadata; no credentials are returned.', examples: ['xhr-tools.mjs sessions', 'xhr-tools.mjs sessions gmarket-search'] },
      { command: 'dom --input=<HTML file|-> --base=<URL> [--requests=<sanitized inventory>] [--output=<new JSON file>]', description: 'Analyze saved HTML and optional sanitized XHR contract inventory; no network requests.', examples: ['xhr-tools.mjs dom --input=page.html --base=https://shop.example/search', 'xhr-tools.mjs dom --input=page.html --base=https://shop.example/search --requests=contracts.json --output=analysis.json'] },
      { command: 'har --input=<HAR file|-> [--output=<new JSON file>]', description: 'Convert a saved HAR to sanitized contract metadata using the sibling web-api-playbook parser.', examples: ['xhr-tools.mjs har --input=capture.har', 'xhr-tools.mjs har --input=capture.har --output=contracts.json'] },
      { command: 'browser-probe [--output=<new JS file>]', description: 'Print or save the read-only DOM inspection function for optional discovery in an authorized browser.', examples: ['xhr-tools.mjs browser-probe', 'xhr-tools.mjs browser-probe --output=dom-probe.js'] },
    ],
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw fail('XHR_COMMAND_INVALID');
  if (command === 'list') {
    if (rest.length) throw fail('XHR_ARGUMENTS_INVALID');
    return { command };
  }
  if (command === 'sessions') {
    if (rest.some(value => value.startsWith('--'))) throw fail('XHR_ARGUMENTS_INVALID');
    return { command, services: rest };
  }
  if (!['dom', 'har', 'browser-probe'].includes(command)) throw fail('XHR_COMMAND_INVALID');
  const options = Object.create(null);
  for (const arg of rest) {
    const match = /^--(input|base|requests|output)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw fail('XHR_ARGUMENTS_INVALID');
    options[match[1]] = match[2];
  }
  if (command === 'dom' && (!options.input || !options.base || Object.keys(options).some(key => !['input', 'base', 'requests', 'output'].includes(key))))
    throw fail('XHR_ARGUMENTS_INVALID');
  if (command === 'dom' && options.requests === '-') throw fail('XHR_ARGUMENTS_INVALID');
  if (command === 'har' && (!options.input || Object.keys(options).some(key => !['input', 'output'].includes(key))))
    throw fail('XHR_ARGUMENTS_INVALID');
  if (command === 'browser-probe' && Object.keys(options).some(key => key !== 'output')) throw fail('XHR_ARGUMENTS_INVALID');
  return { command, ...options };
}

async function readBounded(input, limit) {
  if (input === '-') {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) throw fail('XHR_INPUT_TOO_LARGE');
      chunks.push(buffer);
    }
    const result = Buffer.concat(chunks, size);
    if (result.length > limit) throw fail('XHR_INPUT_TOO_LARGE');
    return result;
  }
  let info;
  try { info = await stat(path.resolve(input)); } catch { throw fail('XHR_INPUT_READ_FAILED'); }
  if (!info.isFile() || info.size > limit) throw fail('XHR_INPUT_TOO_LARGE');
  let result;
  try { result = await readFile(path.resolve(input)); } catch { throw fail('XHR_INPUT_READ_FAILED'); }
  if (result.length > limit) throw fail('XHR_INPUT_TOO_LARGE');
  return result;
}

function safePath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || /[?#\x00-\x20\x7f]/.test(value))
    throw fail('XHR_INPUT_SCHEMA_INVALID');
  const sensitivePredecessor = /^(?:access|account|auth|authorization|category|code|comment|csrf|file|id|item|key|member|nonce|order|post|product|profile|refresh|resource|session|signature|state|token|uid|user|uuid)$/i;
  const segments = value.split('/').map((segment, index, all) => {
    if (!segment) return '';
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return ':id'; }
    if (decoded !== segment || decoded === '.' || decoded === '..' ||
        !(decoded === ':id' || /^[A-Za-z0-9_.~-]{1,64}$/.test(decoded))) return ':id';
    const previous = all[index - 1] ?? '';
    if (/^\d{3,}$/.test(decoded) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded)
      || /^[0-9a-f]{16,}$/i.test(decoded) || /^[A-Za-z0-9_-]{24,}$/.test(decoded)
      || /[\u0080-\uffff]/.test(decoded)
      || sensitivePredecessor.test(previous) && !/^(?:authorize|callback|config|exchange|list|login|manage|new|refresh|search|settings)$/i.test(decoded)) return ':id';
    return decoded;
  });
  return segments.join('/').replace(/\/+/g, '/') || '/';
}

function safeFields(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 256) throw fail('XHR_INPUT_SCHEMA_INVALID');
  // Names such as csrfToken are part of the contract. Omit their values, while
  // collapsing keys that look like dynamic identifiers instead of field names.
  return [...new Set(value.filter(field => typeof field === 'string' && FIELD_NAME.test(field)).map(field =>
    field.length >= 24 && /^[A-Za-z0-9_-]+$/.test(field) ? ':dynamicKey' : field))].sort().slice(0, 256);
}

function safeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('XHR_INPUT_SCHEMA_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw fail('XHR_INPUT_SCHEMA_INVALID');
  if (/(?:^|\.)(?:trycloudflare\.com|ngrok-free\.app)$/i.test(url.hostname)) throw fail('XHR_INPUT_SCHEMA_INVALID');
  return url.origin;
}

function safeMime(value) {
  if (typeof value !== 'string') return null;
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : null;
}

function safeObservation(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw fail('XHR_INPUT_SCHEMA_INVALID');
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const status = Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 ? row.status : null;
  const observedAt = typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt)) ? new Date(row.observedAt).toISOString() : null;
  return {
    source: 'HAR', sourceEntry: count(row.sourceEntry), observedAt,
    requestMime: safeMime(row.requestMime), requestBytes: count(row.requestBytes), status,
    responseMime: safeMime(row.responseMime), responseBytes: count(row.responseBytes),
    responseBodyAvailable: typeof row.responseBodyAvailable === 'boolean' ? row.responseBodyAvailable : null,
    selectorValuesRecorded: false,
  };
}

function sanitizeInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 'xhr-contract-inventory-v1'
      || !Array.isArray(value.contracts) || value.contracts.length > MAX_CONTRACTS) throw fail('XHR_INPUT_SCHEMA_INVALID');
  let observationCount = 0, unsupportedMethodContractsSkipped = 0;
  const contracts = value.contracts.flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.method !== 'string'
      || !/^[A-Za-z]{3,12}$/.test(row.method) || typeof row.path !== 'string') throw fail('XHR_INPUT_SCHEMA_INVALID');
    if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(row.method)) { unsupportedMethodContractsSkipped++; return []; }
    const observations = row.observations == null ? [] : row.observations;
    if (!Array.isArray(observations) || (observationCount += observations.length) > MAX_OBSERVATIONS) throw fail('XHR_INPUT_SCHEMA_INVALID');
    const identity = { method: row.method.toUpperCase(), origin: safeOrigin(row.origin), path: safePath(row.path),
      queryFields: safeFields(row.queryFields), bodyFields: safeFields(row.bodyFields), encoding: safeMime(row.encoding),
      operationFields: safeFields(row.operationFields) };
    const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
    return [{ id, ...identity, mutationCandidate: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(identity.method),
      semanticOperation: identity.operationFields.length ? 'selector_fields_observed_values_omitted' : 'unknown',
      evidence: { source: 'HAR', valuesRecorded: false }, observations: observations.map(safeObservation) }];
  });
  return { schema: 'xhr-contract-inventory-v1', generatedAt: typeof value.generatedAt === 'string' && Number.isFinite(Date.parse(value.generatedAt))
      ? new Date(value.generatedAt).toISOString() : null,
    sourceEvidence: { kind: 'sanitized_request_inventory', entriesSeen: Number.isSafeInteger(value.sourceEvidence?.entriesSeen) && value.sourceEvidence.entriesSeen >= 0 ? value.sourceEvidence.entriesSeen : null,
      entriesSkipped: Number.isSafeInteger(value.sourceEvidence?.entriesSkipped) && value.sourceEvidence.entriesSkipped >= 0 ? value.sourceEvidence.entriesSkipped : null,
      unsupportedMethodContractsSkipped, valuesRecorded: false }, contracts };
}

function serialize(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > OUTPUT_LIMIT) throw fail('XHR_OUTPUT_TOO_LARGE');
  return text;
}

async function emit(text, output) {
  if (!output) { process.stdout.write(text); return; }
  let file;
  try { file = await open(path.resolve(output), 'wx'); }
  catch { throw fail('XHR_OUTPUT_CREATE_FAILED'); }
  try { await file.writeFile(text, 'utf8'); await file.sync(); }
  catch {
    await file.close().catch(() => {});
    const { unlink } = await import('node:fs/promises');
    await unlink(path.resolve(output)).catch(() => {});
    throw fail('XHR_OUTPUT_CREATE_FAILED');
  }
  await file.close();
}

async function runDom(options) {
  let base;
  try { const url = new URL(options.base); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw 0; base = url.href; }
  catch { throw fail('XHR_HTML_BASE_INVALID'); }
  const htmlBytes = await readBounded(options.input, HTML_LIMIT);
  const { publicPageInternals } = await import('../lib/cps-public-reader.mjs');
  const declared = publicPageInternals.parseCharset('', htmlBytes);
  const contentType = /^(?:cp949|ms949|windows-949|x-windows-949)$/i.test(declared) ? 'text/html; charset=euc-kr' : '';
  const html = publicPageInternals.decodeHtml(htmlBytes, contentType);
  let requestInventory = null;
  if (options.requests) {
    const bytes = await readBounded(options.requests, REQUESTS_LIMIT);
    try { requestInventory = sanitizeInventory(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))); }
    catch (error) { if (error?.code === 'XHR_INPUT_SCHEMA_INVALID') throw error; throw fail('XHR_INPUT_SCHEMA_INVALID'); }
  }
  let analyzeHtml;
  try { ({ analyzeHtml } = await import('../lib/dom-analysis.mjs')); }
  catch { throw fail('XHR_DOM_ANALYSIS_FAILED'); }
  let result;
  try { result = analyzeHtml(html, { baseUrl: base, requestInventory }); }
  catch { throw fail('XHR_DOM_ANALYSIS_FAILED'); }
  const text = serialize(result);
  if (options.output) {
    await emit(text, options.output);
    return `${JSON.stringify({ written: true, schema: result.schema })}\n`;
  }
  return text;
}

async function runHar(options) {
  const bytes = await readBounded(options.input, HAR_LIMIT);
  let har;
  try { har = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw fail('XHR_INPUT_SCHEMA_INVALID'); }
  let contractsFromHar;
  try {
    const root = webApiPlaybookRoot();
    const moduleUrl = pathToFileURL(path.join(root, 'lib', 'contracts.mjs')).href;
    ({ contractsFromHar } = await import(moduleUrl));
  } catch { throw fail('XHR_HAR_TOOL_UNAVAILABLE'); }
  let result;
  try { result = sanitizeInventory(contractsFromHar(har)); }
  catch (error) { if (error?.code === 'XHR_INPUT_SCHEMA_INVALID') throw error; throw fail('XHR_HAR_PARSE_FAILED'); }
  const text = serialize(result);
  if (options.output) {
    await emit(text, options.output);
    return `${JSON.stringify({ written: true, schema: result.schema, contracts: result.contracts.length })}\n`;
  }
  return text;
}

async function runBrowserProbe(options) {
  let browserDomProbeSource;
  try { ({ browserDomProbeSource } = await import('../lib/dom-analysis.mjs')); }
  catch { throw fail('XHR_BROWSER_PROBE_UNAVAILABLE'); }
  let source;
  try { source = browserDomProbeSource(); } catch { throw fail('XHR_BROWSER_PROBE_UNAVAILABLE'); }
  if (typeof source !== 'string' || !source.trim()) throw fail('XHR_BROWSER_PROBE_UNAVAILABLE');
  if (Buffer.byteLength(source, 'utf8') > OUTPUT_LIMIT) throw fail('XHR_OUTPUT_TOO_LARGE');
  await emit(source.endsWith('\n') ? source : `${source}\n`, options.output);
  return null;
}

export async function runXhrTools(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'list') return serialize(usage());
  if (options.command === 'sessions') {
    try { return serialize(inspectShoppingSessions(options.services.length ? options.services : undefined)); }
    catch { throw fail('SHOPPING_STATUS_INPUT_OR_PROVIDER_FAILED'); }
  }
  if (options.command === 'dom') return runDom(options);
  if (options.command === 'har') return runHar(options);
  if (options.command === 'browser-probe') { await runBrowserProbe(options); return null; }
  throw fail('XHR_COMMAND_INVALID');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runXhrTools().then(output => { if (output !== null) process.stdout.write(output); })
    .catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, code: safeErrorCode(error) })}\n`); process.exitCode = 2; });
}
