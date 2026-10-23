import test from 'node:test';
import assert from 'node:assert/strict';
import { botPidMayExist, botProcessKey, readBotProcessPresence, botWorkerPresence } from '../lib/bot-process-presence.mjs';

test('an access-denied PID probe stays pending while confirmed absence is dead', () => {
  const probe = code => () => { throw Object.assign(new Error(), { code }); };
  assert.equal(botPidMayExist(123, probe('EPERM')), true);
  assert.equal(botPidMayExist(123, probe('ESRCH')), false);
  assert.equal(botPidMayExist(undefined), false);
});
test('one batch rejects a reused worker PID and confirms only the expected script', async () => {
  const a = { script: 'x-invite-worker.mjs' }, b = { script: 'x-reflection-worker.mjs' }; let calls = 0;
  const result = await readBotProcessPresence([{ spec: a, pid: 1 }, { spec: b, pid: 2 }], {
    pidAlive: () => true, processReader: async (_exe, args) => {
      calls++; assert.ok(args.at(-1).includes("Name -eq 'node.exe'"));
      assert.ok(args.at(-1).includes('IsNullOrWhiteSpace'));
      assert.ok(args.at(-1).includes('x-invite-worker\\.mjs')); // exact script token, not a substring
      return { stdout: JSON.stringify([{ key: botProcessKey(a, 1), present: false }, { key: botProcessKey(b, 2), present: true }]) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(botWorkerPresence(a, { pid: 1 }, {}, result).workerAlive, false);
  assert.equal(botWorkerPresence(b, { pid: 2 }, {}, result).workerAlive, true);
});
test('failed, malformed and missing probe results cannot authorize a duplicate launch', async () => {
  const spec = { script: 'x-supervisor.mjs' };
  for (const processReader of [async () => { throw new Error('secret'); }, async () => ({ stdout: 'bad' }), async () => ({ stdout: '[]' })]) {
    const map = await readBotProcessPresence([{ spec, pid: 11 }], { pidAlive: () => true, processReader });
    const result = botWorkerPresence(spec, { pid: 11 }, {}, map);
    assert.equal(result.workerAlive, null); assert.equal(result.identityPending, true);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});
test('newly launched script identity takes precedence over the old terminal status', () => {
  const spec = { script: 'x-followback-bot.mjs' }, now = Date.now();
  const previous = { pid: 22, restartedAt: new Date(now - 1_000).toISOString() };
  const map = new Map([[botProcessKey(spec, 11), false], [botProcessKey(spec, 22), true]]);
  assert.deepEqual(botWorkerPresence(spec, { pid: 11 }, previous, map, now), {
    pid: 22, workerAlive: true, identityPending: false, startupPending: true,
  });
  assert.equal(botWorkerPresence(spec, { pid: 11 }, previous, map, now + 60_000).startupPending, false);
});
test('an existing Node PID with unreadable command line remains pending',async()=>{
  const spec={script:'x-followback-bot.mjs'},pid=55;
  const presence=await readBotProcessPresence([{spec,pid}],{pidAlive:()=>true,
    processReader:async()=>({stdout:JSON.stringify([{key:botProcessKey(spec,pid),present:null}])})});
  const result=botWorkerPresence(spec,{pid},{},presence);
  assert.equal(result.workerAlive,null);assert.equal(result.identityPending,true);
});
