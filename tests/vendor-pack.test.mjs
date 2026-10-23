import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, packFiles, checkVendored, MANIFEST, sha256 } from '../scripts/vendor-pack.mjs';

test('argument parsing is strict', () => {
  assert.throws(() => parseArgs(['--pack', 'naver']), /VENDOR_DEST_REQUIRED/);
  assert.throws(() => parseArgs(['--pack', 'coupang', '--dest', 'x']), /VENDOR_PACK_INVALID/);
  assert.throws(() => parseArgs(['--dest', 'x', '--force']), /VENDOR_ARGUMENT_INVALID/);
  assert.deepEqual(parseArgs(['--check', '--dest', 'x']).check, true);
});

test('pack file list keeps consumer-owned metadata out', () => {
  const { files } = packFiles({ pack: 'tistory' });
  assert.ok(files.includes('lib/transport.mjs'));
  assert.ok(files.includes('lib/login-identity.mjs'));
  for (const owned of ['package.json', 'package-lock.json', 'README.md']) assert.ok(!files.includes(owned));
});

test('drift check reports edited or missing vendored files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vendor-'));
  writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ commit: 'c', pack: 'p',
    files: [{ path: 'a.mjs', sha256: sha256(path.join(dir, 'a.mjs')) }, { path: 'b.mjs', sha256: 'x' }] }));
  assert.deepEqual(checkVendored(dir).drift, ['b.mjs']);
  writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 2;\n');
  assert.deepEqual(checkVendored(dir).drift, ['a.mjs', 'b.mjs']);
});
