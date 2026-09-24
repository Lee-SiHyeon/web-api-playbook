import { credentialExists, credentialStoreReady, writeCredential } from './secure-credential-store.mjs';

const [operation, name] = process.argv.slice(2);
const safeName = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const managedNames = new Set(['naver-blog-session', 'x-session', 'threads-anonymous-session']);

try {
  if (!credentialStoreReady()) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
  if (!safeName.test(name || '')) throw new Error('CREDENTIAL_NAME_INVALID');
  if (operation === 'status') {
    console.log(JSON.stringify({ name, available: credentialExists(name), encryption: 'Windows DPAPI CurrentUser' }));
  } else if (operation === 'store') {
    if (managedNames.has(name)) throw new Error('CREDENTIAL_NAME_MANAGED_BY_PROVIDER');
    if (process.stdin.isTTY) throw new Error('CREDENTIAL_STDIN_REQUIRED');
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 131072) throw new Error('CREDENTIAL_VALUE_INVALID');
      chunks.push(chunk);
    }
    let value = Buffer.concat(chunks, size).toString('utf8');
    value = value.replace(/\r?\n$/, '');
    const result = writeCredential(name, value);
    console.log(JSON.stringify({ name, ...result }));
  } else {
    throw new Error('Use credential-cli.mjs store|status NAME; store reads stdin');
  }
} catch (error) {
  console.error(error?.message && /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'CREDENTIAL_STORE_FAILED');
  process.exitCode = 1;
}
