import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { contractsFromHar } from '../lib/contracts.mjs';
import { writeNewSnapshot } from '../lib/frontier.mjs';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function errorCode(error) {
  return /^XHR_[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'XHR_HAR_CONVERSION_FAILED';
}

function parseArgs(args) {
  let input;
  let output;
  for (const arg of args) {
    if (arg.startsWith('--input=') && input === undefined && arg.length > 8) input = arg.slice(8);
    else if (arg.startsWith('--output=') && output === undefined && arg.length > 9) output = arg.slice(9);
    else throw Object.assign(new Error(), { code: 'XHR_ARGUMENTS_INVALID' });
  }
  return { input, output };
}

async function readStdin(limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) throw Object.assign(new Error(), { code: 'XHR_INPUT_TOO_LARGE' });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function readInput(file) {
  if (!file) return readStdin(MAX_INPUT_BYTES);
  const resolved = path.resolve(file);
  let info;
  try { info = await stat(resolved); } catch { throw Object.assign(new Error(), { code: 'XHR_INPUT_READ_FAILED' }); }
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw Object.assign(new Error(), { code: 'XHR_INPUT_TOO_LARGE' });
  try { return await readFile(resolved, 'utf8'); }
  catch { throw Object.assign(new Error(), { code: 'XHR_INPUT_READ_FAILED' }); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputText = await readInput(args.input);
  let har;
  try { har = JSON.parse(inputText.replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(new Error(), { code: 'XHR_HAR_INVALID' }); }
  const inventory = contractsFromHar(har);
  const outputText = JSON.stringify(inventory, null, 2) + '\n';
  if (Buffer.byteLength(outputText, 'utf8') > MAX_OUTPUT_BYTES) throw Object.assign(new Error(), { code: 'XHR_OUTPUT_TOO_LARGE' });
  if (args.output) {
    await writeNewSnapshot(path.resolve(args.output), inventory);
    process.stdout.write(JSON.stringify({ written: true, schema: inventory.schema, contracts: inventory.contracts.length }) + '\n');
  } else process.stdout.write(outputText);
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, code: errorCode(error) }) + '\n');
  process.exitCode = 1;
});
