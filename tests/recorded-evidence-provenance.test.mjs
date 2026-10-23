import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyManifestImplementation } from '../lib/recorded-evidence-provenance.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const readFrom = files => async file => {
  if (!files.has(file)) throw Object.assign(new Error(`missing ${file}`), { code: 'ENOENT' });
  return files.get(file);
};

test('verification-tool drift is reported separately while runtime hashes remain strict', async () => {
  const original = new Map([
    ['lib/client.mjs', Buffer.from('client-v1')],
    ['lib/capability-checklist.mjs', Buffer.from('validator-v1')],
    ['scripts/verify-record.mjs', Buffer.from('verifier-v1')],
  ]);
  const current = new Map([
    ['lib/client.mjs', original.get('lib/client.mjs')],
    ['lib/capability-checklist.mjs', Buffer.from('validator-v2')],
    ['scripts/verify-record.mjs', Buffer.from('verifier-v2')],
  ]);
  const implementation = Object.fromEntries([...original].map(([file, bytes]) => [file, sha256(bytes)]));
  const result = await verifyManifestImplementation({
    implementation,
    readFile: readFrom(current),
    sha256,
    verificationToolKinds: {
      'lib/capability-checklist.mjs': 'evidence_validator',
      'scripts/verify-record.mjs': 'offline_verifier',
    },
  });

  assert.equal(result.runtimeImplementationHashesMatched, true);
  assert.deepEqual(result.verificationToolProvenance.map(({ path, kind, status }) => ({ path, kind, status })), [
    { path: 'lib/capability-checklist.mjs', kind: 'evidence_validator', status: 'historical_tool_changed' },
    { path: 'scripts/verify-record.mjs', kind: 'offline_verifier', status: 'historical_tool_changed' },
  ]);
});

test('a runtime implementation change still fails', async () => {
  const recorded = Buffer.from('client-v1');
  await assert.rejects(verifyManifestImplementation({
    implementation: { 'lib/client.mjs': sha256(recorded) },
    readFile: readFrom(new Map([['lib/client.mjs', Buffer.from('client-v2')]])),
    sha256,
  }), error => error.code === 'RECORDED_RUNTIME_IMPLEMENTATION_CHANGED' && error.path === 'lib/client.mjs');
});

test('inherited object properties are not accepted as verification-tool allowlist entries', async () => {
  await assert.rejects(verifyManifestImplementation({
    implementation: { constructor: sha256('client-v1') },
    readFile: readFrom(new Map([['constructor', Buffer.from('client-v2')]])),
    sha256,
  }), error => error.code === 'RECORDED_RUNTIME_IMPLEMENTATION_CHANGED' && error.path === 'constructor');
});

test('invalid recorded hashes and missing allowlisted files fail closed', async () => {
  await assert.rejects(verifyManifestImplementation({
    implementation: { 'lib/client.mjs': 'not-a-hash' }, readFile: async () => Buffer.from('x'), sha256,
  }), error => error.code === 'RECORDED_IMPLEMENTATION_HASH_INVALID');
  await assert.rejects(verifyManifestImplementation({
    implementation: { 'lib/validator.mjs': sha256('old') }, readFile: async () => { throw new Error('missing'); }, sha256,
    verificationToolKinds: { 'lib/validator.mjs': 'evidence_validator' },
  }));
});
