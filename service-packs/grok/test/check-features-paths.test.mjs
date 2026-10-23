import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveContainedRepoPath } from '../scripts/check-features.mjs';
import { FeatureChecklistError, validateFeatureReceipts } from '../src/feature-checklist.mjs';

test('feature checker resolves regular evidence files under the canonical repository root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grok-feature-path-'));
  try {
    await mkdir(path.join(root, 'verification', 'receipts'), { recursive: true });
    const file = path.join(root, 'verification', 'receipts', 'one.json');
    await writeFile(file, '{}\n');
    const resolved = await resolveContainedRepoPath(root, 'verification/receipts/one.json');
    assert.deepEqual(resolved, { path: file, missing: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a symlinked receipt parent is rejected before the checker reads its children', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grok-feature-link-'));
  try {
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'one.json'), '{}\n');
    await mkdir(path.join(root, 'verification'), { recursive: true });
    await symlink(outside, path.join(root, 'verification', 'receipts'), 'dir');
    await assert.rejects(
      resolveContainedRepoPath(root, 'verification/receipts/one.json'),
      error => error instanceof FeatureChecklistError && error.code === 'FEATURE_CHECK_PATH_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('receipt schema validation rejects unsafe hash paths before they can be opened', () => {
  const malformed = {
    schemaVersion: 1,
    serviceId: 'grok-web',
    featureId: 'private.history',
    requirementId: 'history.list',
    operationId: 'history.list',
    observedAt: '2026-10-06T00:00:00.000Z',
    recordedAt: '2026-10-06T00:00:01.000Z',
    execution: 'direct_http_client',
    liveReplay: true,
    liveReplayRecorded: true,
    mocked: false,
    ownerVerified: true,
    sameAuthenticatedOwner: true,
    evidenceScope: 'same_authenticated_owner',
    httpStatus: 200,
    responseMime: 'application/json',
    responseBytes: 1,
    capturedOperationSha256: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64),
    responseDigest: 'c'.repeat(64),
    handlerId: 'client.read',
    codeSha256: { 'src/../../outside.mjs': 'd'.repeat(64) },
  };
  assert.throws(() => validateFeatureReceipts([malformed]), error =>
    error instanceof FeatureChecklistError && error.code === 'FEATURE_CHECK_SCHEMA_INVALID');
});
