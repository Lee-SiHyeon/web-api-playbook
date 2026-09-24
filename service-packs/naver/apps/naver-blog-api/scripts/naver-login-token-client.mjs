import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function issueLoginTokenInWorker({ pageUrl, sdk } = {}) {
  return new Promise((resolve, reject) => {
    const worker = fileURLToPath(new URL('./naver-login-token-worker.mjs', import.meta.url));
    const scripts = path.dirname(worker);
    const workspace = fileURLToPath(new URL('../../../', import.meta.url));
    const env = {};
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const child = fork(worker, [], { env, windowsHide: true, serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: ['--permission', `--allow-fs-read=${scripts}`, `--allow-fs-read=${path.join(workspace, 'node_modules')}`],
    });
    let settled = false;
    let pendingResult;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; child.kill(); reject(new Error('LOGIN_TOKEN_WORKER_TIMEOUT'));
    }, 35000);
    child.once('error', () => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill(); reject(new Error('LOGIN_TOKEN_WORKER_FAILED'));
    });
    child.once('message', result => {
      if (settled) return;
      if (result?.receipt?.browserEngineUsed !== false || (result.token != null
        && (typeof result.token !== 'string' || !result.token || result.token.length > 8192 || /[\r\n\0]/.test(result.token)))) {
        settled = true; clearTimeout(timer);
        child.kill(); reject(new Error('LOGIN_TOKEN_WORKER_RESULT_INVALID')); return;
      }
      pendingResult = result;
    });
    child.once('exit', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!pendingResult || (pendingResult.token && code !== 0)) {
        reject(new Error('LOGIN_TOKEN_WORKER_EXITED')); return;
      }
      pendingResult.receipt.workerExitedBeforeLogin = true;
      resolve(pendingResult);
    });
    child.send({ operation: 'issue-naver-login-token', pageUrl, sdk });
  });
}
