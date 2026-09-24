import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'parse5';
import { normalizeUrl } from '../lib/contracts.mjs';
import { writeNewSnapshot } from '../lib/frontier.mjs';

const MAX_HTML_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function errorCode(error) {
  return /^XHR_[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'XHR_HTML_DISCOVERY_FAILED';
}

function attr(node, name) {
  const item = node.attrs?.find(attribute => attribute.name === name);
  return item?.value;
}

function walk(root, visit) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    visit(node);
    if (node.content) stack.push(node.content);
    for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index -= 1) stack.push(node.childNodes[index]);
  }
}

function resolveSafe(raw, baseUrl) {
  try { return normalizeUrl(raw, { baseUrl }); }
  catch { return null; }
}

function candidateHash(kind, target, reason = null) {
  return createHash('sha256').update(JSON.stringify({ kind, target, reason })).digest('hex').slice(0, 24);
}

export function discoverHtml(html, { baseUrl } = {}) {
  if (typeof html !== 'string' || typeof baseUrl !== 'string' || !html.length) throw fail('XHR_HTML_INPUT_INVALID');
  const requestedBase = resolveSafe(baseUrl, undefined);
  if (!requestedBase) throw fail('XHR_HTML_BASE_INVALID');
  const document = parse(html);
  const nodes = [];
  walk(document, node => nodes.push(node));

  let effectiveBaseUrl = baseUrl;
  const baseElement = nodes.find(node => node.tagName === 'base' && typeof attr(node, 'href') === 'string');
  if (baseElement) {
    try { effectiveBaseUrl = new URL(attr(baseElement, 'href'), baseUrl).href; }
    catch { /* Fall back to the explicit base URL without retaining the invalid attribute. */ }
  }
  const effectiveBase = resolveSafe(effectiveBaseUrl, undefined) ?? requestedBase;
  const rootOrigin = requestedBase.origin;
  const candidates = new Map();
  let sourceOrdinal = 0;

  for (const node of nodes) {
    let tag;
    let raw;
    let kind;
    if (node.tagName === 'a' || node.tagName === 'area') {
      tag = node.tagName;
      raw = attr(node, 'href');
      kind = 'navigation_link';
    } else if (node.tagName === 'iframe' || node.tagName === 'frame') {
      tag = node.tagName;
      raw = attr(node, 'src');
      kind = 'embedded_frame';
    } else if (node.tagName === 'script') {
      tag = node.tagName;
      raw = attr(node, 'src');
      kind = 'script_asset';
    } else if (node.tagName === 'link') {
      tag = node.tagName;
      raw = attr(node, 'href');
      kind = 'link_resource';
    } else continue;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    sourceOrdinal += 1;
    const target = resolveSafe(raw, effectiveBaseUrl);
    const reason = target ? null : 'non_http_or_invalid_url';
    const key = JSON.stringify({ kind, target, reason });
    const existing = candidates.get(key);
    const evidence = { element: `${tag}-${sourceOrdinal}` };
    if (existing) {
      existing.occurrences += 1;
      if (existing.evidence.length < 20) existing.evidence.push(evidence);
      continue;
    }
    const candidate = {
      id: candidateHash(kind, target, reason),
      kind,
      target,
      sameOrigin: target ? target.origin === rootOrigin : false,
      state: 'candidate',
      reason,
      evidence: [evidence],
      occurrences: 1,
      operationSemantics: 'unknown',
      queryValuesRecorded: false,
      requestObserved: false,
    };
    candidates.set(key, candidate);
  }

  const candidateList = [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
  const counts = Object.fromEntries(['navigation_link', 'embedded_frame', 'script_asset', 'link_resource']
    .map(kind => [kind, candidateList.filter(candidate => candidate.kind === kind).length]));
  return {
    schema: 'xhr-html-candidates-v1',
    sourceEvidence: {
      kind: 'local_saved_html',
      liveNetworkUsed: false,
      xhrContractsObserved: 0,
      htmlTextRecorded: false,
      attributeValuesRecorded: false,
    },
    rootOrigin,
    suppliedBase: { origin: requestedBase.origin, path: requestedBase.path, queryFields: requestedBase.queryFields },
    effectiveBase: { origin: effectiveBase.origin, path: effectiveBase.path, queryFields: effectiveBase.queryFields },
    observedCandidateCount: candidateList.length,
    counts,
    candidates: candidateList,
  };
}

function parseArgs(args) {
  let input;
  let base;
  let output;
  for (const arg of args) {
    if (arg.startsWith('--input=') && input === undefined && arg.length > 8) input = arg.slice(8);
    else if (arg.startsWith('--base=') && base === undefined && arg.length > 7) base = arg.slice(7);
    else if (arg.startsWith('--output=') && output === undefined && arg.length > 9) output = arg.slice(9);
    else throw fail('XHR_ARGUMENTS_INVALID');
  }
  if (!input || !base) throw fail('XHR_ARGUMENTS_INVALID');
  return { input, base, output };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  let info;
  try { info = await stat(inputPath); } catch { throw fail('XHR_INPUT_READ_FAILED'); }
  if (!info.isFile() || info.size > MAX_HTML_BYTES) throw fail('XHR_INPUT_TOO_LARGE');
  let html;
  try { html = await readFile(inputPath, 'utf8'); } catch { throw fail('XHR_INPUT_READ_FAILED'); }
  const output = discoverHtml(html, { baseUrl: args.base });
  const serialized = JSON.stringify(output, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTPUT_BYTES) throw fail('XHR_OUTPUT_TOO_LARGE');
  if (args.output) {
    await writeNewSnapshot(path.resolve(args.output), output);
    process.stdout.write(JSON.stringify({ written: true, schema: output.schema, candidates: output.observedCandidateCount }) + '\n');
  } else process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ ok: false, code: errorCode(error) }) + '\n');
    process.exitCode = 1;
  });
}
