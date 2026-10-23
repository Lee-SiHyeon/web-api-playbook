import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const alive = pid => {
  try { process.kill(pid,0); return true; }
  catch(error) { return error.code !== 'ESRCH'; }
};
const remove = async file => { try {await unlink(file);} catch(error) {if(error.code!=='ENOENT') throw error;} };

// Each attempt owns an immutable, unique filename. Concurrent contenders may
// both yield, but never unlink a replacement lock belonging to another run.
// Per-service write journals remain responsible for uncertain auth mutations.
export async function acquireRunLock(directory, {pid=process.pid,isAlive=alive}={}) {
  await mkdir(directory,{recursive:true});
  const own=path.join(directory,`active-${pid}-${randomUUID()}.lock`);
  await writeFile(own,JSON.stringify({pid,startedAt:new Date().toISOString()}),{flag:'wx'});
  try {
    for(const name of await readdir(directory)) {
      const match=/^active-(\d+)-[a-f0-9-]{36}\.lock$/.exec(name);
      if(!match && name!=='active.lock') continue;
      const file=path.join(directory,name);
      if(file===own) continue;
      let otherPid=match?Number(match[1]):null;
      if(otherPid===null) {
        try {otherPid=JSON.parse(await readFile(file,'utf8')).pid;}
        catch(error) {if(error.code==='ENOENT') continue; throw Error('ONBOARDING_LOCK_INVALID');}
      }
      if(!Number.isSafeInteger(otherPid)||otherPid<1) throw Error('ONBOARDING_LOCK_INVALID');
      if(await isAlive(otherPid)) throw Error('ONBOARDING_RUN_LOCKED');
      await remove(file);
    }
    return ()=>remove(own);
  } catch(error) {await remove(own);throw error;}
}
