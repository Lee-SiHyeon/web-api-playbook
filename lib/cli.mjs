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
export async function stdinJsonNoEcho(limit = 8192, { input = process.stdin, timeoutMs = 120000,
  prompt = 'Enter the requested JSON on stdin (terminal input is hidden): ' } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1) fail('INPUT_LIMIT_INVALID');
  const tty = input.isTTY === true;
  const previousRawMode = input.isRaw === true;
  if (tty && typeof input.setRawMode !== 'function') fail('STDIN_TTY_RAW_UNAVAILABLE');
  const chunks = [];
  let ttyBytes = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      if (tty) { try { input.setRawMode(previousRawMode); } catch {} }
      input.pause?.();
      chunks.forEach(chunk => chunk.fill(0));
      ttyBytes.fill(0);
      ttyBytes = [];
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      if (error) { cleanup(); reject(error); return; }
      let bytes;
      try {
        bytes = tty ? Buffer.from(ttyBytes) : Buffer.concat(chunks);
        const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
        cleanup();
        resolve(value);
      } catch (cause) {
        cleanup();
        reject(cause?.code ? cause : Object.assign(new Error('INPUT_JSON_INVALID'), { code: 'INPUT_JSON_INVALID' }));
      } finally { bytes?.fill(0); }
    };
    const onData = chunk => {
      const bytes = Buffer.from(chunk);
      if (tty) {
        for (const byte of bytes) {
          if (byte === 0x03) { finish(Object.assign(new Error('INPUT_CANCELLED'), { code: 'INPUT_CANCELLED' })); break; }
          if (byte === 0x0d || byte === 0x0a) { finish(); break; }
          if (byte === 0x08 || byte === 0x7f) {
            if (ttyBytes.length) {
              let start = ttyBytes.length - 1;
              while (start > 0 && (ttyBytes[start] & 0xc0) === 0x80) start--;
              ttyBytes.splice(start);
              size = ttyBytes.length;
            }
            continue;
          }
          ttyBytes.push(byte);
          size++;
          if (size > limit) { finish(Object.assign(new Error('INPUT_SIZE'), { code: 'INPUT_SIZE' })); break; }
        }
      } else {
        size += bytes.length;
        if (size > limit) { finish(Object.assign(new Error('INPUT_SIZE'), { code: 'INPUT_SIZE' })); bytes.fill(0); }
        else chunks.push(bytes);
      }
      if (tty) bytes.fill(0);
    };
    const onEnd = () => {
      if (tty && ttyBytes.length === 0) finish(Object.assign(new Error('INPUT_JSON_INVALID'), { code: 'INPUT_JSON_INVALID' }));
      else finish();
    };
    const onError = () => finish(Object.assign(new Error('STDIN_READ_FAILED'), { code: 'STDIN_READ_FAILED' }));
    timer = setTimeout(() => finish(Object.assign(new Error('INPUT_TIMEOUT'), { code: 'INPUT_TIMEOUT' })), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    if (tty) {
      try { input.setRawMode(true); }
      catch { finish(Object.assign(new Error('STDIN_TTY_RAW_UNAVAILABLE'), { code: 'STDIN_TTY_RAW_UNAVAILABLE' })); return; }
      if (prompt && process.stderr.isTTY) process.stderr.write(prompt);
    }
    input.resume?.();
  });
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
