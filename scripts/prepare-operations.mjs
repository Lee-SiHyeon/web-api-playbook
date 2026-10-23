import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { jsonFile, reserveOutput, safeError } from '../lib/cli.mjs';
import { prepareOperations } from '../lib/prepare-operations.mjs';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function parseArgs(args) {
  const parsed = { bundles: [] };
  const seen = new Set();
  for (const arg of args) {
    const match = /^--(har|html|bundle|base-url|intent|profile|output)=(.+)$/s.exec(arg);
    if (!match || match[1] !== 'bundle' && seen.has(match[1])) fail('XHR_PREPARE_ARGUMENTS_INVALID');
    if (match[1] === 'bundle') parsed.bundles.push(match[2]);
    else { parsed[match[1]] = match[2]; seen.add(match[1]); }
  }
  return parsed;
}
async function sourceFile(file) {
  try { return await readFile(path.resolve(file), 'utf8'); }
  catch { fail('XHR_PREPARE_INPUT_READ_FAILED'); }
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  const inputs = { baseUrl: parsed['base-url'], intent: parsed.intent };
  if (parsed.har) inputs.har = await jsonFile(parsed.har);
  if (parsed.html) inputs.html = await sourceFile(parsed.html);
  if (parsed.profile) inputs.profile = await jsonFile(parsed.profile);
  inputs.bundles = await Promise.all(parsed.bundles.map(async file => ({ name: path.basename(file), source: await sourceFile(file) })));
  const result = prepareOperations(inputs);
  const serialized = JSON.stringify(result, null, 2) + '\n';
  // Reserve only after all inputs have been read and preparation succeeded.
  // Existing artifacts, including source files, are never overwritten.
  const handle = await reserveOutput(parsed.output);
  if (handle) {
    try { await handle.writeFile(serialized, 'utf8'); } finally { await handle.close(); }
  }
  process.stdout.write(serialized);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ ok: false, code: safeError(error) }) + '\n');
    process.exitCode = 1;
  });
}
