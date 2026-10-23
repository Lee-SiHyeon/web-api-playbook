import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';
import { readBotProcessPresence, botProcessKey } from './bot-process-presence.mjs';

const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
};
const observerPresence = async (pid, owner, script) => {
  if (owner.manual) return alive(pid);
  const spec={script};
  const presence=await readBotProcessPresence([{spec,pid}]);
  return presence.get(botProcessKey(spec,pid)) ?? null;
};

// Every starter and releaser uses the same acquisition guard. The long-lived
// lease remains separate so this guard is held only for local file operations.
export async function acquireBotWorkerLease(root, { manual = false, script = 'social-bot-report-worker.mjs', processAlive, fs = { open, lstat, unlink }, now = Date.now } = {}) {
  if(!/^[a-z0-9][a-z0-9_.-]{0,100}\.mjs$/.test(script)||processAlive!==undefined&&typeof processAlive!=='function')
    throw Object.assign(new Error(),{code:'BOT_WORKER_LEASE_INPUT'});
  const probe=processAlive||((pid,owner)=>observerPresence(pid,owner,script));
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'worker.lock'), guard = path.join(root, 'worker-acquire.lock');
  const lock = callback => withSessionLock(callback, { lockPath: guard, timeoutMs: 30_000 });
  const read = async () => {
    try {
      const info=await fs.lstat(file);
      if(!info.isFile()||info.isSymbolicLink())return {invalid:true,info};
      let owner;
      try{owner=JSON.parse(await readFile(file,'utf8'));}catch(error){if(!(error instanceof SyntaxError))throw error;}
      if(!Number.isSafeInteger(owner?.pid)||owner.pid<=0)return {invalid:true,info};
      return {owner,info};
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const owner = { pid: process.pid, script, nonce: randomUUID(), startedAt: new Date().toISOString(), ...(manual ? { manual: true } : {}) };
  const acquired = await lock(async () => {
    const old = await read();
    // A one-shot manual notice queues behind any observer lease. Only the
    // regular observer starter owns stale recovery.
    if(old && (manual || old.invalid && now()-old.info.mtimeMs<120_000
      || !old.invalid && await probe(old.owner.pid,old.owner)!==false))return false;
    if(old){
      if(old.info.isSymbolicLink()||!old.info.isFile())return false;
      const current=await fs.lstat(file);
      if(current.dev!==old.info.dev||current.ino!==old.info.ino||current.mtimeMs!==old.info.mtimeMs)return false;
      await fs.unlink(file);
    }
    const handle = await fs.open(file, 'wx', 0o600);
    let identity;
    try { identity=await handle.stat(); await handle.writeFile(JSON.stringify(owner) + '\n'); await handle.sync(); }
    catch(error){
      await handle.close();
      const current=await fs.lstat(file).catch(()=>null);
      if(identity&&current?.dev===identity.dev&&current.ino===identity.ino)await fs.unlink(file).catch(()=>{});
      throw error;
    } finally { await handle.close().catch(()=>{}); }
    return true;
  });
  if (!acquired) return null;
  return { pid: owner.pid, nonce: owner.nonce, release: () => lock(async () => {
    const current = await read();
    if (current?.owner?.pid !== owner.pid || current.owner.nonce !== owner.nonce) return false;
    await fs.unlink(file);
    return true;
  }) };
}
