import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { annotateBotError, recordBotFailure, recordBotStatus } from './bot-diagnostics.mjs';

// Retry only committing an already written local file. Never rerun the caller
// or a social request. A unique temporary file prevents competing saves from
// sharing a .tmp file, and a failed commit preserves the previous document.
export async function atomicBotJson(file, value, { fs = { open, rename, unlink }, sleep = delay } = {}) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const startedAt = Date.now(), base = path.basename(file, '.json');
  const fileKind = ['state', 'status', 'worker-status'].includes(base) ? base : 'other';
  let handle, stage = 'local_open';
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    stage = 'local_write'; await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    stage = 'local_sync'; await handle.sync();
    stage = 'local_close'; await handle.close(); handle = null;
    stage = 'local_rename';
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 3) throw error;
        await sleep(50 * 2 ** attempt);
      }
    }
  } catch (error) { annotateBotError(error, { stage, fileKind, elapsedMs: Date.now() - startedAt }); throw error; }
  finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function writeBotJson(bot, file, value) {
  const root = path.dirname(file);
  if (['status.json', 'worker-status.json'].includes(path.basename(file))) {
    value.updatedAt = new Date().toISOString(); await recordBotStatus(bot, root, value);
  }
  try { await atomicBotJson(file, value); }
  catch (error) { await recordBotFailure(bot, root, error, { phase: 'local_persistence', status: value?.status }); throw error; }
}
