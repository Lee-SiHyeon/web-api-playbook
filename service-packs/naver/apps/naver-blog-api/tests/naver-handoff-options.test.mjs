import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNaverHandoffWindow, NAVER_HANDOFF_DEFAULT_MAX_WAIT_MS,
  NAVER_HANDOFF_MAX_WAIT_MS, safeNaverHandoffCode } from '../scripts/naver-handoff-options.mjs';

test('default one-use handoff lifetime remains 120 seconds', () => {
  assert.deepEqual(createNaverHandoffWindow(1_000, []), {
    localForm: false, maxWaitMs: 120_000, expiresAt: 121_000,
  });
  assert.equal(NAVER_HANDOFF_DEFAULT_MAX_WAIT_MS, 120_000);
});

test('bounded max-wait flag extends the same startedAt-based expiry and accepts local form', () => {
  assert.deepEqual(createNaverHandoffWindow(10_000, ['--local-form', '--max-wait-ms=300000']), {
    localForm: true, maxWaitMs: 300_000, expiresAt: 310_000,
  });
  assert.equal(NAVER_HANDOFF_MAX_WAIT_MS, 300_000);
  assert.equal(createNaverHandoffWindow(0, ['--max-wait-ms=45000']).expiresAt, 45_000);
});

test('rejects out-of-range, malformed, repeated, and unknown arguments', async t => {
  const invalidCases = [
    ['zero', ['--max-wait-ms=0'], 'HANDOFF_MAX_WAIT_INVALID'],
    ['over limit', ['--max-wait-ms=300001'], 'HANDOFF_MAX_WAIT_INVALID'],
    ['negative', ['--max-wait-ms=-1'], 'HANDOFF_MAX_WAIT_INVALID'],
    ['decimal', ['--max-wait-ms=120000.5'], 'HANDOFF_MAX_WAIT_INVALID'],
    ['empty', ['--max-wait-ms='], 'HANDOFF_MAX_WAIT_INVALID'],
    ['missing equals value', ['--max-wait-ms'], 'HANDOFF_ARGUMENT_INVALID'],
    ['duplicate wait flags', ['--max-wait-ms=120000', '--max-wait-ms=300000'], 'HANDOFF_ARGUMENT_INVALID'],
    ['duplicate local form', ['--local-form', '--local-form'], 'HANDOFF_ARGUMENT_INVALID'],
    ['unknown flag', ['--forever'], 'HANDOFF_ARGUMENT_INVALID'],
  ];
  for (const [name, args, code] of invalidCases) await t.test(name, () => {
    assert.throws(() => createNaverHandoffWindow(1, args), { message: code });
  });
});

test('safe failure mapper preserves concrete auth and lock codes without leaking unknown messages', () => {
  assert.equal(safeNaverHandoffCode({ code: 'AUTH_MISSING', message: 'raw detail ignored' }), 'AUTH_MISSING');
  assert.equal(safeNaverHandoffCode({ message: 'NAVER_SESSION_BUSY' }), 'NAVER_SESSION_BUSY');
  assert.equal(safeNaverHandoffCode({ message: 'private response body value' }), 'HANDOFF_FAILED');
  assert.equal(safeNaverHandoffCode({ code: 'UNRELATED_PRIVATE_VALUE' }, 'HANDOFF_PERSIST_FAILED'), 'HANDOFF_PERSIST_FAILED');
});

test('runner applies parsed window to both process timeout and all existing capturedAt bounds', async () => {
  const source = await readFile(new URL('../tools/discovery/naver-encrypted-handoff.mjs', import.meta.url), 'utf8');
  assert.match(source, /createNaverHandoffWindow\(startedAt, process\.argv\.slice\(2\)\)/);
  assert.match(source, /setTimeout\([^\n]+, maxWaitMs\)/);
  assert.match(source, /if \(localForm\) \{ await serveLocalForm\(expiresAt, \(\) => clearTimeout\(timeout\)\); return; \}/);
  assert.match(source, /Date\.now\(\) > expiresAt/);
  assert.match(source, /received = true;\s+clearTimeout\(timeout\);\s+let bundle;/);
  assert.match(source, /if \(Buffer\.byteLength\(body\) > 262144\)[\s\S]*?clearWaitTimeout\(\);\s+const fields/);
  assert.equal((source.match(/bundle\.capturedAt < startedAt - 10000/g) || []).length, 2);
  assert.equal((source.match(/bundle\.capturedAt > Date\.now\(\) \+ 10000/g) || []).length, 2);
});
