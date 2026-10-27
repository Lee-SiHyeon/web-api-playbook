import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MANIFEST_PATH, selectManifestPath } from '../scripts/verify-jobs-freelance.mjs';

test('freelance evidence verifier defaults to the fresh dated manifest', () => {
  assert.equal(selectManifestPath(), DEFAULT_MANIFEST_PATH);
  assert.equal(DEFAULT_MANIFEST_PATH, 'verification/jobs-freelance-2026-10-27/manifest.json');
});

test('freelance evidence verifier accepts only dated manifest paths under its verification family', () => {
  assert.equal(selectManifestPath(['--manifest=verification/jobs-freelance-2026-10-23/manifest.json']),
    'verification/jobs-freelance-2026-10-23/manifest.json');
  assert.equal(selectManifestPath(['--manifest=verification/jobs-freelance-2026-10-26/manifest.json']),
    'verification/jobs-freelance-2026-10-26/manifest.json');
  assert.equal(selectManifestPath(['--manifest=verification/jobs-freelance-2026-10-27/manifest.json']),
    'verification/jobs-freelance-2026-10-27/manifest.json');
});

test('freelance evidence verifier rejects extra arguments, traversal, and invalid dates', () => {
  for (const args of [
    ['manifest=verification/jobs-freelance-2026-10-26/manifest.json'],
    ['--manifest'],
    ['--manifest=verification/jobs-freelance-2026-10-26/manifest.json', '--network'],
    ['--manifest=verification/jobs-freelance-2026-10-26/../../manifest.json'],
    ['--manifest=/home/worker/manifest.json'],
    ['--manifest=verification/jobs-freelance-2026-02-30/manifest.json'],
    ['--manifest=verification/jobs-freelance-not-a-date/manifest.json'],
  ]) {
    assert.throws(() => selectManifestPath(args), error =>
      ['ARGUMENT_INVALID', 'MANIFEST_PATH_INVALID'].includes(error.code));
  }
});
