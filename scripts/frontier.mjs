import path from 'node:path';
import {
  addNode,
  createFrontier,
  frontierReport,
  loadFrontier,
  markNode,
  nextNodes,
  setFailureBoundary,
  writeNewSnapshot,
} from '../lib/frontier.mjs';

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function errorCode(error) {
  return /^XHR_[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'XHR_FRONTIER_COMMAND_FAILED';
}

function parseArgs(args) {
  const [command, ...flags] = args;
  if (!['init', 'add', 'next', 'mark', 'report'].includes(command)) throw fail('XHR_ARGUMENTS_INVALID');
  const parsed = { command, includeDeferred: false };
  for (const flag of flags) {
    if (flag === '--include-deferred' && !parsed.includeDeferred) parsed.includeDeferred = true;
    else if (flag.startsWith('--input=') && parsed.input === undefined && flag.length > 8) parsed.input = flag.slice(8);
    else if (flag.startsWith('--snapshot=') && parsed.snapshot === undefined && flag.length > 11) parsed.snapshot = flag.slice(11);
    else if (flag.startsWith('--output=') && parsed.output === undefined && flag.length > 9) parsed.output = flag.slice(9);
    else if (flag.startsWith('--limit=') && parsed.limit === undefined) {
      const limit = Number(flag.slice(8));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('XHR_LIMIT_INVALID');
      parsed.limit = limit;
    } else if (flag.startsWith('--stage=') && parsed.stage === undefined && flag.length > 8) parsed.stage = flag.slice(8);
    else throw fail('XHR_ARGUMENTS_INVALID');
  }
  if (['add', 'next', 'mark', 'report'].includes(command) && !parsed.snapshot) throw fail('XHR_SNAPSHOT_REQUIRED');
  if (['init', 'add', 'mark'].includes(command) && !parsed.input) parsed.stdin = true;
  if (['init', 'add', 'mark'].includes(command) && !parsed.output) throw fail('XHR_OUTPUT_REQUIRED');
  return parsed;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_PAYLOAD_BYTES) throw fail('XHR_INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function readJsonInput(input) {
  let text;
  if (!input || input === '-') text = await readStdin();
  else {
    try { text = await (await import('node:fs/promises')).readFile(path.resolve(input), 'utf8'); }
    catch { throw fail('XHR_INPUT_READ_FAILED'); }
    if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) throw fail('XHR_INPUT_TOO_LARGE');
  }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw fail('XHR_INPUT_INVALID'); }
}

async function emit(data, output) {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(text, 'utf8') > MAX_STDOUT_BYTES) throw fail('XHR_OUTPUT_TOO_LARGE');
  if (output) {
    await writeNewSnapshot(path.resolve(output), data);
    process.stdout.write(JSON.stringify({ written: true, schema: data.schema ?? null }) + '\n');
  } else process.stdout.write(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.command === 'init') {
    const payload = await readJsonInput(args.input);
    result = createFrontier(payload);
  } else if (args.command === 'add') {
    const frontier = await loadFrontier(path.resolve(args.snapshot));
    const payload = await readJsonInput(args.input);
    const items = Array.isArray(payload.nodes) ? payload.nodes : [payload.node ?? payload];
    if (!items.length || items.length > 10_000) throw fail('XHR_FRONTIER_NODE_LIMIT');
    for (const item of items) {
      const parentId = item.parentId ?? payload.parentId ?? null;
      const edgeType = item.edgeType ?? payload.edgeType ?? 'link';
      const observedAt = item.observedAt ?? payload.observedAt;
      addNode(frontier, item, { parentId, edgeType, ...(observedAt ? { observedAt } : {}) });
    }
    result = frontier;
  } else if (args.command === 'mark') {
    const frontier = await loadFrontier(path.resolve(args.snapshot));
    const payload = await readJsonInput(args.input);
    markNode(frontier, payload);
    if (Object.hasOwn(payload, 'sharedFailureBoundary')) setFailureBoundary(frontier, payload.sharedFailureBoundary);
    result = frontier;
  } else {
    const frontier = await loadFrontier(path.resolve(args.snapshot));
    result = args.command === 'next'
      ? { schema: 'xhr-frontier-next-v1', nodes: nextNodes(frontier, { limit: args.limit, stage: args.stage, includeDeferred: args.includeDeferred }) }
      : frontierReport(frontier);
  }
  await emit(result, args.output ? path.resolve(args.output) : null);
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, code: errorCode(error) }) + '\n');
  process.exitCode = 1;
});
