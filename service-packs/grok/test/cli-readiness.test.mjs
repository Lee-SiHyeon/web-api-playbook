import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('operation inventory does not require a native credential provider or journal', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(process.execPath, ['src/cli.mjs','operations'], {
    cwd: root, encoding:'utf8', timeout:10000,
    env:Object.fromEntries(['PATH','HOME','TMPDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),
  });
  assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout);
  assert.equal(data.capabilities.publicModels.clientExists,true);
  assert.equal(data.capabilities.textGeneration.clientExists,false);
  assert.equal(data.capabilities.imageGeneration.liveReplay,false);
  assert.equal(data.capabilities.videoGeneration.liveReplay,false);
  assert.equal(result.stdout.includes('PROTECTED_STORE_PROVIDER_REQUIRED'),false);
});
