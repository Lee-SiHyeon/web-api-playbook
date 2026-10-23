#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, currentSettingsRoundtripMatchesReceipt, operationDigest,
  validateFeatureReceipts } from '../src/feature-checklist.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const proofPath = process.argv[2];
if (!/^verification\/one-shot\/[A-Za-z0-9._-]+\.json$/.test(proofPath ?? '') || process.argv.length !== 3) {
  throw new Error('SETTINGS_PROOF_PATH_INVALID');
}
const proofBytes = await readFile(path.join(root, proofPath));
const proof = JSON.parse(proofBytes.toString('utf8'));
const registryPath = path.join(root, 'contracts/grok-web.v1.json');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const operation = registry.operations.find(item => item.id === 'settings.update');
const ownerOperation = registry.operations.find(item => item.id === 'auth.owner.read');
const readOperation = registry.operations.find(item => item.id === 'settings.read');
const codeSha256 = Object.fromEntries(Object.entries(proof.sourceBeforeImports ?? {})
  .filter(([file]) => !file.startsWith('contracts/')));
for (const [file, digest] of Object.entries(codeSha256)) {
  if (!/^(?:src|scripts)\/[A-Za-z0-9._-]+\.(?:mjs|py)$/.test(file)
      || hash(await readFile(path.join(root, file))) !== digest) throw new Error('SETTINGS_PROOF_SOURCE_DRIFT');
}
const now = new Date().toISOString();
const persistenceAssertions = Object.fromEntries([
  'credentialValuesPersisted', 'cookiesPersisted', 'tokensPersisted', 'requestBodiesPersisted',
  'responseBodiesPersisted', 'signedUrlValuesPersisted', 'passwordValuesPersisted',
  'conversationIdsPersisted', 'conversationTitlesPersisted', 'responseIdsPersisted', 'messageBodiesPersisted',
].map(key => [key, false]));
const base = {
  schemaVersion: 1, serviceId: 'grok-web', observedAt: proof.finishedAt, recordedAt: now,
  execution: 'direct_http_client', liveReplay: true, liveReplayRecorded: true, mocked: false,
  ownerVerified: true, sameAuthenticatedOwner: true, evidenceScope: 'same_authenticated_owner',
  ownerScopeSha256: proof.ownerScopeSha256,
  readinessAssertions: { handlerDispatchVerified: true, ownerScopeBound: true }, persistenceAssertions,
};
const owner = {
  ...base, featureId: 'auth.owner-identity', requirementId: 'auth.owner.read', operationId: 'auth.owner.read',
  httpStatus: proof.ownerRead?.httpStatus, responseMime: proof.ownerRead?.mime,
  responseBytes: proof.ownerRead?.responseBytes, requestDigest: proof.ownerRead?.requestDigest,
  responseDigest: proof.ownerRead?.rawBodySha256, responseDigestKind: 'raw_http_body',
  capturedOperationSha256: operationDigest(ownerOperation), handlerId: 'client.verify-owner',
  dispatchBinding: { handlerId: 'client.verify-owner', operationId: 'auth.owner.read',
    operationKind: 'read', mode: 'identity_role_dispatch' },
  codeSha256: Object.fromEntries(['src/client.mjs', 'src/transport.mjs', 'src/session.mjs']
    .map(file => [file, codeSha256[file]])),
};
const ownerDigest = hash(canonicalJson(owner));
const settingsRead = {
  ...base, featureId: 'user-settings', requirementId: 'settings.read', operationId: 'settings.read',
  ownerProofPath: `verification/owner-proofs/${ownerDigest}.json`, ownerProofSha256: ownerDigest,
  httpStatus: proof.before?.httpStatus, responseMime: proof.before?.mime,
  responseBytes: proof.before?.responseBytes, requestDigest: proof.before?.requestDigest,
  responseDigest: proof.before?.rawBodySha256, responseDigestKind: 'raw_http_body',
  capturedOperationSha256: operationDigest(readOperation), handlerId: 'client.read',
  dispatchBinding: { handlerId: 'client.read', operationId: 'settings.read',
    operationKind: 'read', mode: 'validated_registry_generic' },
  codeSha256: Object.fromEntries(['src/client.mjs', 'src/transport.mjs', 'src/session.mjs',
    'src/grok-conversations.mjs'].map(file => [file, codeSha256[file]])),
};
const direct = proof.apply?.responseReceipt;
const restore = proof.restore?.responseReceipt;
const receipt = {
  ...base, featureId: 'user-settings', requirementId: 'settings.update', operationId: 'settings.update',
  ownerProofPath: `verification/owner-proofs/${ownerDigest}.json`, ownerProofSha256: ownerDigest,
  httpStatus: direct?.responseStatus, responseMime: direct?.responseContentType,
  responseBytes: direct?.responseBytes, requestDigest: direct?.requestDigest, intentDigest: direct?.intentDigest,
  responseDigest: direct?.responseDigest, responseDigestKind: 'raw_http_body',
  handlerId: 'client.submit', dispatchBinding: { handlerId: 'client.submit', operationId: 'settings.update',
    operationKind: 'submit', mode: 'validated_registry_generic' },
  semanticReadback: {
    readbackVerified: proof.changedValueMatched, readbackStatus: proof.afterApply?.httpStatus,
    preferenceName: proof.preference, beforeValue: proof.baseline, afterValue: !proof.baseline,
    otherPreferencesUnchanged: proof.apply?.otherPreferencesUnchanged,
    otherSettingsUnchanged: proof.apply?.otherSettingsUnchanged,
    restoreVerified: proof.baselineRestored && proof.wholeSettingsRestored,
    restoreStatus: proof.afterRestore?.httpStatus, restoreBeforeValue: !proof.baseline,
    restoreAfterValue: proof.baseline, restoreOtherPreferencesUnchanged: proof.restore?.otherPreferencesUnchanged,
  },
  restoreReplay: { httpStatus: restore?.responseStatus, readbackStatus: proof.afterRestore?.httpStatus,
    requestDigest: restore?.requestDigest, intentDigest: restore?.intentDigest,
    readbackVerified: proof.baselineRestored && proof.wholeSettingsRestored,
    otherPreferencesUnchanged: proof.restore?.otherPreferencesUnchanged,
    otherSettingsUnchanged: proof.restore?.otherSettingsUnchanged },
  sourceProofPath: proofPath, sourceProofSha256: hash(proofBytes),
  codeHashCapturedAtExecution: true, codeSha256,
};
if (!currentSettingsRoundtripMatchesReceipt(receipt, proof)) throw new Error('SETTINGS_ROUNDTRIP_PROOF_INVALID');
operation.evidence.directReplayReceipt = proofPath;
operation.evidence.directReplay = {
  source: 'direct_http', status: direct.responseStatus, parsedData: true, observedAt: direct.observedAt,
  ownerVerified: true, tlsVerified: direct.tlsVerified, trustEnv: direct.trustEnv,
  redirectsFollowed: direct.redirectsFollowed, explicitRetries: direct.explicitRetries,
  attemptCountPerMutation: direct.attemptCount, responseBytes: direct.responseBytes,
  responseDigestPersisted: true, responseSha256: direct.responseDigest,
  requestHeaderNames: direct.requestHeaderNames, cookieNames: direct.cookieNames,
  requestDigest: direct.requestDigest, intentDigest: direct.intentDigest,
};
operation.evidence.firstLiveReplayPermit = false;
receipt.capturedOperationSha256 = operationDigest(operation);
validateFeatureReceipts([owner, settingsRead, receipt]);
const save = async (file, value) => {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const previous = await readFile(destination);
    await writeFile(path.join(root, 'verification/one-shot', `settings-canonical-before-${path.basename(file)}-${hash(previous).slice(0, 16)}.json`), previous, { mode: 0o600, flag: 'wx' });
  } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  await writeFile(destination, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};
await save('verification/grok-feature-live-receipts/auth-owner.read.json', owner);
await save(`verification/owner-proofs/${ownerDigest}.json`, owner);
await save('verification/grok-feature-live-receipts/settings.read.json', settingsRead);
await save('verification/grok-feature-live-receipts/settings.update.json', receipt);
await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n');
process.stdout.write(JSON.stringify({ status: 'current_settings_proof_recorded', proofPath, ownerScopeBound: true }) + '\n');
