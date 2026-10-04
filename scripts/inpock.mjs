// Browser-free one-shot runner. Linux secrets arrive on stdin and stay in memory.
import { ProtectedStore } from '../lib/protected-store.mjs';
import { stdinJson, options, safeError } from '../lib/cli.mjs';
import { createInpockAuth } from '../lib/web-auth/inpock.mjs';
import { createInpockReadClient } from '../lib/inpock-read.mjs';

try {
  const [command = 'status', ...args] = process.argv.slice(2);
  const inputOptions = options(args, ['credentials-stdin']);
  if (!['status', 'login', 'ensure', 'owner', 'health', 'verify', 'blocks', 'public', 'stats', 'inventory'].includes(command) ||
      (inputOptions['credentials-stdin'] !== undefined && inputOptions['credentials-stdin'] !== true)) {
    throw Object.assign(new Error('COMMAND_NOT_ALLOWED'), { code: 'COMMAND_NOT_ALLOWED' });
  }
  const store = new ProtectedStore(inputOptions['credentials-stdin'] ? { provider: 'memory' } : {});
  const auth = createInpockAuth({ store });
  if (inputOptions['credentials-stdin']) {
    const input = await stdinJson(32768);
    try { await auth.importLogin(input); } finally { input.password = ''; }
  }
  const reader = createInpockReadClient({ auth });
  const summary = ({ blocks, profile, ...receipt }) => ({ ...receipt, ...(profile ? { profileFields: Object.keys(profile) } : {}) });
  let result;
  if (command === 'verify') result = { login: await auth.ensure(), health: await auth.health(), reuse: await auth.ensure() };
  else if (command === 'blocks') result = summary(await reader.listBlocks());
  else if (command === 'public') result = summary(await reader.publicProfile());
  else if (command === 'stats') result = await reader.miniStats();
  else if (command === 'inventory') result = {
    blocks: summary(await reader.listBlocks()), public: summary(await reader.publicProfile()), stats: await reader.miniStats(),
  };
  else result = await auth[command]();
  console.log(JSON.stringify({ ok: true, service: 'inpock', command,
    credentialProvider: inputOptions['credentials-stdin'] ? 'process-memory' : 'Windows DPAPI CurrentUser',
    persistent: !inputOptions['credentials-stdin'], ...result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: safeError(error), ...(error.receipt ? { receipt: error.receipt } : {}) }));
  process.exitCode = 2;
}
