import { ProtectedStore } from '../lib/protected-store.mjs';
import { options, safeError, stdinJsonNoEcho } from '../lib/cli.mjs';
import { createSoomgoAuth } from '../lib/web-auth/soomgo.mjs';

function clearImportInput(input, seen = new Set()) {
  if (!input || typeof input !== 'object' || seen.has(input)) return;
  seen.add(input);
  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index++) {
      if (typeof input[index] === 'string') input[index] = '';
      else clearImportInput(input[index], seen);
    }
    return;
  }
  for (const key of Object.keys(input)) {
    if (typeof input[key] === 'string') input[key] = '';
    else clearImportInput(input[key], seen);
  }
}

try {
  const [command = 'status', ...args] = process.argv.slice(2);
  const optionNames = ['memory', 'persist', 'store-dir',
    ...(command === 'requests' ? ['status', 'max-pages', 'after'] : [])];
  const inputOptions = options(args, optionNames);
  const commands = ['session-import', 'status', 'owner', 'health', 'verify', 'requests', 'chats'];
  if (!commands.includes(command) ||
      inputOptions.memory !== undefined && inputOptions.memory !== true ||
      inputOptions.persist !== undefined && inputOptions.persist !== true ||
      inputOptions['store-dir'] !== undefined && typeof inputOptions['store-dir'] !== 'string' ||
      inputOptions.memory && inputOptions.persist) {
    throw Object.assign(new Error('SOOMGO_AUTH_COMMAND_INVALID'), { code: 'SOOMGO_AUTH_COMMAND_INVALID' });
  }

  let store;
  if (command === 'session-import') {
    if (inputOptions.memory !== true && inputOptions.persist !== true ||
        inputOptions.persist === true && !inputOptions['store-dir'] ||
        inputOptions.memory === true && inputOptions['store-dir'] !== undefined) {
      throw Object.assign(new Error('SOOMGO_AUTH_STORAGE_MODE_REQUIRED'), { code: 'SOOMGO_AUTH_STORAGE_MODE_REQUIRED' });
    }
    store = inputOptions.memory
      ? new ProtectedStore({ provider: 'memory' })
      : new ProtectedStore({ directory: inputOptions['store-dir'] });
  } else {
    if (inputOptions.memory !== undefined || inputOptions.persist !== undefined ||
        ['owner', 'health', 'verify', 'requests', 'chats'].includes(command) && !inputOptions['store-dir']) {
      throw Object.assign(new Error('SOOMGO_AUTH_STORE_DIR_REQUIRED'), { code: 'SOOMGO_AUTH_STORE_DIR_REQUIRED' });
    }
    store = inputOptions['store-dir']
      ? new ProtectedStore({ directory: inputOptions['store-dir'] })
      : new ProtectedStore({ provider: 'memory' });
  }

  const auth = createSoomgoAuth({ store });
  let result;
  if (command === 'session-import') {
    const input = await stdinJsonNoEcho(128 * 1024);
    try { result = await auth.importSession(input); }
    finally { clearImportInput(input); }
  } else if (command === 'status') result = auth.status();
  else if (command === 'requests') {
    const maxPages = inputOptions['max-pages'] === undefined ? 1 :
      /^[1-9]$|^1[0-5]$/.test(inputOptions['max-pages']) ? Number(inputOptions['max-pages']) : null;
    if (inputOptions['max-pages'] !== undefined && maxPages === null) {
      throw Object.assign(new Error('SOOMGO_AUTH_REQUEST_OPTIONS_INVALID'), { code: 'SOOMGO_AUTH_REQUEST_OPTIONS_INVALID' });
    }
    result = await auth.requests({
      status: inputOptions.status ?? 'opened',
      maxPages,
      ...(inputOptions.after === undefined ? {} : { after: inputOptions.after }),
    });
  } else if (command === 'chats') result = await auth.chats();
  else result = await auth[command]();

  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: safeError(error),
    ...(error?.receipt ? { receipt: error.receipt } : {}),
    ...(error?.partialResult ? { partialResult: error.partialResult } : {}) }));
  process.exitCode = 2;
}
