import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { webApiPlaybookRoot } from '../adapters/web-auth-provider.mjs';

// Keep this consumer entrypoint narrow. Link creation is exposed only through the
// canonical client's product eligibility checks, write journal, and management readback.
// Session import and arbitrary command passthrough remain unavailable here.
const commands = new Set([
  'status', 'health',
  'shopping-search', 'shopping-stores', 'shopping-featured', 'shopping-event-tabs', 'shopping-event', 'shopping-event-products',
  'shopping-detail', 'shopping-links', 'shopping-create-link',
  'travel-search', 'travel-rates', 'travel-tabs', 'travel-recommend',
  'travel-detail', 'travel-links', 'travel-create-link',
]);

const [command = 'status', ...extraArgs] = process.argv.slice(2);
if (!commands.has(command) || extraArgs.length) {
  console.error(JSON.stringify({ ok: false, code: 'BRANDCONNECT_COMMAND_INVALID' }));
  process.exitCode = 2;
} else {
  const script = path.join(webApiPlaybookRoot(), 'scripts', 'brandconnect.mjs');
  if (!existsSync(script)) {
    console.error(JSON.stringify({ ok: false, code: 'WEB_AUTH_PLAYBOOK_NOT_INSTALLED' }));
    process.exitCode = 2;
  } else {
    const child = spawn(process.execPath, [script, command], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', () => {
      console.error(JSON.stringify({ ok: false, code: 'BRANDCONNECT_RUNTIME_FAILED' }));
      process.exitCode = 2;
    });
    child.on('exit', code => { process.exitCode = code ?? 2; });
  }
}
