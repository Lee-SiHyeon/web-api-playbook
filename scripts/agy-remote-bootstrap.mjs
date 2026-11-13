import { options, safeError } from '../lib/cli.mjs';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { bootstrapAgyRemote } from '../lib/agy-remote-bootstrap.mjs';

try {
  if (process.argv.includes('--help')) {
    console.log('agy-remote-bootstrap.mjs --cdp=http://127.0.0.1:9341 --expected-email=<owner> --remote=<exact-name-or-id> [--tab=<owned-tab-id>] [--store-dir=<private-directory>] [--auto-sync]');
  } else {
    const args = options(process.argv.slice(2), ['cdp', 'expected-email', 'remote', 'tab', 'store-dir', 'auto-sync']);
    if (Object.entries(args).some(([k,x]) => k === 'auto-sync' ? x !== true : typeof x !== 'string')) throw Object.assign(new Error(), { code: 'AGY_ARGUMENT_INVALID' });
    const store = new ProtectedStore({ directory: args['store-dir'], provider: process.platform === 'win32' ? undefined : 'file' });
    console.log(JSON.stringify(await bootstrapAgyRemote({ endpoint: args.cdp, tabId: args.tab,
      expectedEmail: args['expected-email'], remote: args.remote, autoSync: args['auto-sync'] === true, store })));
  }
} catch (error) { console.error(JSON.stringify({ ok: false, code: safeError(error) })); process.exitCode = 1; }
