import { options, safeError, stdinJson } from '../lib/cli.mjs';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { AGY_STORE } from '../lib/agy-remote.mjs';
import { createAgyRemoteRuntime } from '../lib/agy-remote-runtime.mjs';
import path from 'node:path';
import os from 'node:os';

try {
  const [operation = 'help', ...rest] = process.argv.slice(2);
  if (operation === 'help' || operation === '--help') {
    console.log('agy-remote.mjs status|owner|remotes|models|projects|sessions|read|create|send|wait|rename|cancel|delete|reconcile [--remote=<exact-name-or-id>] [--id=<conversation-id>] [--store-dir=<private-directory>] [--journal-dir=<private-directory>] [--confirm=CONFIRM] [--intent=<stable-key>] [--timeout-ms=120000] [--limit=100] [--cursor=<cursor>] [--project=<id>] [--query=<title>] [--journal-key=<key>]');
    console.log('create/send/rename read their JSON payload from stdin. Writes require --confirm=CONFIRM and --intent. Business operations use independent Node HTTP.');
  } else {
    const args = options(rest, ['remote', 'id', 'store-dir', 'journal-dir', 'confirm', 'intent', 'timeout-ms', 'limit', 'cursor', 'project', 'query', 'journal-key']);
    if (Object.values(args).some(x => typeof x !== 'string')) throw Object.assign(new Error(), { code: 'AGY_ARGUMENT_INVALID' });
    const store = new ProtectedStore({ directory: args['store-dir'], provider: process.platform === 'win32' ? undefined : 'file' });
    if (operation === 'status') console.log(JSON.stringify({ storage: store.status(AGY_STORE), authenticated: 'not_probed', businessMode: 'pure_http' }));
    else {
      if (!['owner','remotes','models','projects','sessions','read','create','send','wait','rename','cancel','delete','reconcile'].includes(operation)) throw Object.assign(new Error(), { code: 'AGY_OPERATION_UNKNOWN' });
      const raw = store.read(AGY_STORE);
      if (!raw) throw Object.assign(new Error(), { code: 'AGY_BOOTSTRAP_REQUIRED' });
      const write = ['create','send','rename','cancel','delete'].includes(operation);
      if (write && args.confirm !== 'CONFIRM') throw Object.assign(new Error(), { code: 'AGY_CONFIRM_REQUIRED' });
      if (write && !args.intent) throw Object.assign(new Error(), { code: 'AGY_INTENT_REQUIRED' });
      const runtime = createAgyRemoteRuntime({ state: JSON.parse(raw), store, remote: args.remote, allowMaintenance: true,
        journalRoot: args['journal-dir'] || path.join(os.homedir(), '.local/state/web-api-playbook/agy-remote/journal'),
      });
      const base = { remote: args.remote, id: args.id, confirm: args.confirm, intent: args.intent };
      const waitDeadline = Date.now() + Number(args['timeout-ms'] ?? 120000);
      const execute = async client => {
      let result;
      if (operation === 'remotes') result = { remotes: await client.instances() };
      else if (['owner','models','projects'].includes(operation)) result = await client[operation](args.remote);
      else if (operation === 'sessions') result = await client.sessions(args.remote, { ...(args.limit ? { limit: Number(args.limit) } : {}),
        cursor: args.cursor, projectId: args.project, query: args.query });
      else if (operation === 'reconcile') result = await client.reconcile({ remote: args.remote, journalKey: args['journal-key'] });
      else if (operation === 'read') result = await client.read(args.remote, args.id);
      else if (operation === 'wait') result = await client.wait({ ...base, timeoutMs: Math.max(1, waitDeadline - Date.now()) });
      else if (['create','send','rename'].includes(operation)) {
        // Content and credentials never travel in command arguments.
        const input = await stdinJson(256 * 1024);
        const allowed = operation === 'create' ? ['projectId','model','title'] : operation === 'send' ? ['prompt','model'] : ['title'];
        if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(k => !allowed.includes(k))) throw Object.assign(new Error(), { code: 'AGY_PAYLOAD_INVALID' });
        result = await client[operation]({ ...input, ...base });
      } else result = await client[operation === 'delete' ? 'remove' : operation](base);
      return result;
      };
      const result = await runtime.run(execute, { write });
      console.log(JSON.stringify({ ok: true, businessMode: 'pure_http', sessionMaintenance: runtime.maintenance, ...result }));
    }
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: safeError(error), ...(error.journalKey ? { journalKey: error.journalKey } : {}) }));
  process.exitCode = 1;
}
