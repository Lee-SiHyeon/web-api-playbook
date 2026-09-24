// Scoped bootstrap input only. Secrets enter on stdin and leave only as DPAPI ciphertext.
import { ProtectedStore } from '../lib/protected-store.mjs';
import { withSessionLock } from '../lib/session-lock.mjs';
import { stdinJson } from '../lib/cli.mjs';
import path from 'node:path';

try {
  const [service] = process.argv.slice(2);
  const input = await stdinJson(128 * 1024);
  let name, value;
  if (service === 'myrealtrip-login') {
    if (typeof input.email !== 'string' || !input.email.includes('@') || input.email.length > 320 ||
        typeof input.password !== 'string' || !input.password || input.password.length > 4096 ||
        /[\0\r\n]/.test(input.email + input.password) || typeof input.isKeepSignIn !== 'boolean' ||
        (input.partnerId !== undefined && input.partnerId !== null && !/^\d{1,16}$/.test(String(input.partnerId)))) throw Error();
    name = service;
    value = { version: 1, email: input.email, password: input.password, isKeepSignIn: input.isKeepSignIn,
      ...(input.partnerId == null ? {} : { partnerId: input.partnerId }) };
  } else {
    throw Error();
  }
  const store = new ProtectedStore();
  await withSessionLock(() => store.write(name, JSON.stringify(value)), {
    root: path.join(store.directory, 'locks'), key: 'myrealtrip-state',
  });
  console.log(JSON.stringify({ ok: true, service, stored: true, provider: 'Windows DPAPI CurrentUser', authenticated: false }));
} catch {
  console.log(JSON.stringify({ ok: false, code: 'WEB_AUTH_IMPORT_FAILED' }));
  process.exitCode = 2;
}
