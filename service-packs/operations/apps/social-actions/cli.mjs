import { readFile } from 'node:fs/promises';
import { capabilities, prepareAction, executeAction, reconcileAction } from './index.mjs';
import { safeCode, safeReceipt, listPendingActions } from './lib/journal.mjs';

const help = `Social actions over direct HTTP

  node apps/social-actions/cli.mjs capabilities
  node apps/social-actions/cli.mjs prepare --service SERVICE --operation ACTION --target TARGET
  node apps/social-actions/cli.mjs execute --service SERVICE --operation ACTION --target TARGET [--journal PATH]
  node apps/social-actions/cli.mjs reconcile --journal PATH [--message-file PATH]
  node apps/social-actions/cli.mjs pending

Services: naver, tistory, x, threads, instagram
prepare only reads state and builds a safe request summary. execute sends one action to the explicit target.
Naver mutual requests can take --message-file PATH and --group-id ID.
Cookies and tokens are loaded from the current Windows user's protected store.
`;

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) { process.stdout.write(help); return; }
  if (command === 'capabilities') { console.log(JSON.stringify({ capabilities, execution: 'pure_http', browserUsed: false })); return; }
  if (command === 'pending') { console.log(JSON.stringify({ pending: await listPendingActions() })); return; }
  if (!['prepare', 'execute', 'reconcile'].includes(command)) throw Object.assign(new Error(), { code: 'SOCIAL_COMMAND_INVALID' });
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !['service', 'operation', 'target', 'journal', 'message-file', 'group-id'].includes(key)
      || !args[i + 1] || Object.hasOwn(options, key)) throw Object.assign(new Error(), { code: 'SOCIAL_ARGUMENT_INVALID' });
    options[key] = args[i + 1];
  }
  let message;
  if (options['message-file']) {
    message = await readFile(options['message-file'], 'utf8');
    if (message.length > 5000) throw Object.assign(new Error(), { code: 'SOCIAL_MESSAGE_TOO_LONG' });
    message = message.trim();
  }
  if (command === 'reconcile') {
    if (!options.journal) throw Object.assign(new Error(), { code: 'SOCIAL_JOURNAL_REQUIRED' });
    const result = await reconcileAction(options.journal, { message });
    console.log(JSON.stringify(result));
    if (!result.success) process.exitCode = 2;
    return;
  }
  if (!capabilities[options.service]?.includes(options.operation) || !options.target) throw Object.assign(new Error(), { code: 'SOCIAL_ACTION_INPUT' });
  const input = { service: options.service, operation: options.operation, target: options.target,
    ...(message !== undefined ? { message } : {}), ...(options['group-id'] ? { groupId: options['group-id'] } : {}) };
  const result = command === 'prepare' ? safeReceipt(await prepareAction(input)) : await executeAction(input, { journalPath: options.journal });
  console.log(JSON.stringify(result));
  if (command === 'prepare' ? result.ready !== true : result.success !== true) process.exitCode = 2;
}

main().catch(error => {
  console.log(JSON.stringify({ success: false, code: safeCode(error) }));
  process.exitCode = 2;
});
