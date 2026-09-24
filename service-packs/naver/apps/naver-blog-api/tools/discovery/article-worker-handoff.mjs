import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopedLoginHeader } from './publisher-session-handoff.mjs';
export function startArticleWorker({ cookies, job, output, journal, mode, nodeExecutable, runtimeEnvironment = {} }) {
  scopedLoginHeader(cookies);
  if (!['prepare','publish'].includes(mode) || [job,output,journal,nodeExecutable].some(v => typeof v !== 'string' || /[\r\n\0]/.test(v))) throw Error('INPUT');
  const secrets = cookies.map(c => c.value);
  const status = { completed: false, progress: [], result: null };
  const child = spawn(nodeExecutable, ['scripts/hybrid/publisher-cli.mjs',`--job=${job}`,`--output=${output}`,`--journal=${journal}`,`--command=${mode === 'prepare' ? 'prepare-create' : 'create'}`], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true, shell: false,
    env: { SystemRoot: runtimeEnvironment.SystemRoot || 'C:\\WINDOWS', LOCALAPPDATA: runtimeEnvironment.LOCALAPPDATA,
      USERPROFILE: runtimeEnvironment.USERPROFILE, TEMP: runtimeEnvironment.TEMP, NAVER_COOKIE: scopedLoginHeader(cookies) }, stdio: ['pipe','pipe','pipe'], timeout: 210000 });
  let buffer = '', size = 0;
  const collect = chunk => {
    size += chunk.length; if (size > 65536) { child.kill(); return; }
    buffer += chunk.toString();
    for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0,i); buffer = buffer.slice(i+1);
      if (secrets.some(s => s && line.includes(s))) { status.result = { ok: false, code: 'OUTPUT_REDACTED' }; child.kill(); return; }
      try { const value = JSON.parse(line); if (value.progress) status.progress.push(value.progress); else status.result = value; } catch {} }
  };
  child.stdout.on('data',collect); child.stderr.on('data',collect);
  child.stdin.on('error',()=>{});
  child.on('error',()=>{ status.result = { ok:false,code:'WORKER_START_FAILED' }; });
  child.on('close',code=>{ status.completed = true; status.exitCode = code; secrets.fill(''); });
  child.stdin.end();
  return status;
}
