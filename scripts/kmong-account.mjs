import { ProtectedStore } from '../lib/protected-store.mjs';
import { options, safeError, stdinJsonNoEcho } from '../lib/cli.mjs';
import { createKmongAuth } from '../lib/web-auth/kmong.mjs';

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
  const inputOptions = options(args, ['memory', 'persist', 'store-dir']);
  const commands = ['session-import', 'status', 'owner', 'health', 'verify'];
  if (!commands.includes(command) ||
      inputOptions.memory !== undefined && inputOptions.memory !== true ||
      inputOptions.persist !== undefined && inputOptions.persist !== true ||
      inputOptions['store-dir'] !== undefined && typeof inputOptions['store-dir'] !== 'string' ||
      inputOptions.memory && inputOptions.persist) {
    throw Object.assign(new Error('KMONG_AUTH_COMMAND_INVALID'), { code: 'KMONG_AUTH_COMMAND_INVALID' });
  }

  let store;
  if (command === 'session-import') {
    if (inputOptions.memory !== true && inputOptions.persist !== true ||
        inputOptions.persist === true && !inputOptions['store-dir'] ||
        inputOptions.memory === true && inputOptions['store-dir'] !== undefined) {
      throw Object.assign(new Error('KMONG_AUTH_STORAGE_MODE_REQUIRED'), { code: 'KMONG_AUTH_STORAGE_MODE_REQUIRED' });
    }
    store = inputOptions.memory
      ? new ProtectedStore({ provider: 'memory' })
      : new ProtectedStore({ directory: inputOptions['store-dir'] });
  } else {
    if (inputOptions.memory !== undefined || inputOptions.persist !== undefined ||
        ['owner', 'health', 'verify'].includes(command) && !inputOptions['store-dir']) {
      throw Object.assign(new Error('KMONG_AUTH_STORE_DIR_REQUIRED'), { code: 'KMONG_AUTH_STORE_DIR_REQUIRED' });
    }
    store = inputOptions['store-dir']
      ? new ProtectedStore({ directory: inputOptions['store-dir'] })
      : new ProtectedStore({ provider: 'memory' });
  }

  const auth = createKmongAuth({ store });
  let result;
  if (command === 'session-import') {
    const input = await stdinJsonNoEcho(128 * 1024);
    try { result = await auth.importSession(input); }
    finally { clearImportInput(input); }
  } else if (command === 'status') result = auth.status();
  else result = await auth[command]();

  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: safeError(error), ...(error?.receipt ? { receipt: error.receipt } : {}) }));
  process.exitCode = 2;
}
