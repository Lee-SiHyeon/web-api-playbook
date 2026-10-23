import { mkdirSync, writeFileSync, renameSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeBotFailure, safeBotEvent } from './bot-diagnostics.mjs';

const bots = new Set(['threads-benefits', 'threads-outreach', 'threads-watchdog']);
const atomic = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temp, file);
};

// Async logging cannot finish after Node's exit event. These small synchronous
// receipts retain only safe metadata. No handler suppresses a fatal exception.
// Forced OS termination cannot emit an exit event; the watchdog records that
// separately as an observed disappearance with an unknown exit code.
export function installThreadsProcessLifecycle(bot, root, { processRef = process, now = Date.now,
  save = atomic, append = appendFileSync, read = readFileSync } = {}) {
  if (!bots.has(bot)) throw Object.assign(new Error(), { code: 'THREADS_PROCESS_LOG_INPUT' });
  const startedAt = new Date(now()).toISOString();
  let fatal = null;
  const store = (file, value) => { try { save(path.join(root, file), value); } catch { /* Preserve the original exit. */ } };
  store('process-start.json', { schemaVersion: 1, bot, pid: processRef.pid, startedAt });
  const onFatal = error => { fatal = safeBotFailure(error); };
  const onExit = exitCode => {
    let status = {};
    try {
      const snapshot = JSON.parse(read(path.join(root, bot === 'threads-watchdog' ? 'status.json' : 'worker-status.json'), 'utf8'));
      if (snapshot.pid === processRef.pid) status = snapshot;
    } catch { /* Startup failures can precede the first status. */ }
    const expected = ['stopped', 'expired', 'completed_once'].includes(status.status);
    const event = safeBotEvent(bot, { pid: processRef.pid, event: expected && !fatal ? 'finished' : 'worker_exit',
      runStartedAt: startedAt, exitCode, status: status.status, phase: 'process_exit',
      code: fatal?.code || status.code || (expected ? null : 'THREADS_WORKER_EXITED'),
      failure: fatal || status.diagnostic }, now());
    store('process-exit.json', { ...event, unexpected: !expected || !!fatal });
    try { append(path.join(root, 'failures.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }); } catch { /* Receipt is independent. */ }
  };
  processRef.on('uncaughtExceptionMonitor', onFatal);
  processRef.on('exit', onExit);
  return () => { processRef.off('uncaughtExceptionMonitor', onFatal); processRef.off('exit', onExit); };
}
