import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { webApiPlaybookRoot } from '../adapters/web-auth-provider.mjs';

// Job JSON travels on stdin. The canonical runtime reads its own DPAPI store.
const script = path.join(webApiPlaybookRoot(), 'scripts', 'myrealtrip.mjs');
if (!existsSync(script)) {
  console.error(JSON.stringify({ ok: false, code: 'WEB_AUTH_PLAYBOOK_NOT_INSTALLED' }));
  process.exitCode = 2;
} else {
  const child = spawn(process.execPath, [script], { stdio: 'inherit', windowsHide: true });
  child.on('error', () => {
    console.error(JSON.stringify({ ok: false, code: 'WEB_AUTH_RUNTIME_FAILED' }));
    process.exitCode = 2;
  });
  child.on('exit', code => { process.exitCode = code ?? 2; });
}
