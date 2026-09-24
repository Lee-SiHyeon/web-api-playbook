import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function fail(code) { const error = new Error(code); error.code = code; throw error; }
export function options(args, allowed) {
  const result = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(arg);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(result, match[1])) fail('ARGUMENT_INVALID');
    result[match[1]] = match[2] ?? true;
  }
  return result;
}
export async function stdinJson(limit = 2 * 1024 * 1024) {
  if (process.stdin.isTTY) fail('STDIN_REQUIRED');
  const chunks = []; let size = 0;
  try {
    for await (const chunk of process.stdin) { size += chunk.length; if (size > limit) fail('INPUT_SIZE'); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) { fail(error.code === 'INPUT_SIZE' ? error.code : 'INPUT_JSON_INVALID'); }
  finally { chunks.forEach(chunk => chunk.fill(0)); }
}
export async function jsonFile(file) {
  if (typeof file !== 'string') fail('FILE_REQUIRED');
  let text;
  try { text = await readFile(path.resolve(file), 'utf8'); } catch { fail('INPUT_FILE_UNAVAILABLE'); }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('INPUT_JSON_INVALID'); }
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function reserveOutput(file) {
  if (!file) return null;
  try { return await open(path.resolve(file), 'wx', 0o600); } catch { fail('OUTPUT_RESERVATION_FAILED'); }
}
export async function report(value, handle) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (handle) await handle.writeFile(text);
  console.log(text.trimEnd());
}
export function safeError(error) {
  const code = error?.code || error?.message || '';
  return /^[A-Z][A-Z0-9_]{1,100}$/.test(code) ? code : 'OPERATION_FAILED';
}
