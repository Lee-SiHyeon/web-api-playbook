#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const files = [
  'scripts/verify-settings-roundtrip-once.mjs', 'src/grok-conversations.mjs',
  'src/client.mjs', 'src/runtime.mjs', 'src/session.mjs', 'src/transport.mjs',
  'src/journal.mjs', 'src/contracts.mjs', 'src/authenticated-chrome-fetch.mjs',
  'scripts/authenticated-chrome-transport.py', 'contracts/grok-web.v1.json',
];
const snapshot = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, hash(await readFile(path.join(root, file)))])));
const sourceBeforeImports = await snapshot();
const { createInMemoryGrokConversationRuntime } = await import(pathToFileURL(path.join(root, 'src/runtime.mjs')));
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) throw new Error('INPUT_LIMIT');
  chunks.push(Buffer.from(chunk));
}
const raw = Buffer.concat(chunks);
let input;
try { input = JSON.parse(raw.toString('utf8')); }
finally { raw.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
const proof = {
  schema: 'grok-settings-current-source-roundtrip-v2', startedAt: new Date().toISOString(),
  sourceBeforeImports, preference: 'autoWrapLongLinesCode',
  writeAttempts: { apply: 0, restore: 0 }, remotePrivacyFieldsSubmitted: false,
  rawSettingsCredentialsValuesPersisted: false,
};
const readMeta = result => ({
  httpStatus: result.status, mime: result.contentType, responseBytes: result.responseBytes,
  rawBodySha256: result.rawResponseDigest, rawDigestKind: result.rawResponseDigestKind,
  requestDigest: result.requestDigest,
});
const writeMeta = result => ({
  state: result.state, verified: result.verified === true,
  httpStatus: result.httpStatus, readbackStatus: result.readbackStatus,
  responseReceipt: result.responseReceipt ?? null,
  otherPreferencesUnchanged: result.otherPreferencesUnchanged,
  otherSettingsUnchanged: result.otherSettingsUnchanged,
});
let runtime, baseline, changedVerified = false;
try {
  if (input.confirm !== true || typeof input.intentPrefix !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{15,120}$/.test(input.intentPrefix)
      || !/^[a-f0-9]{64}$/.test(input.expectedOwnerScopeSha256 ?? '')
      || typeof input.expectedIdentity !== 'string'
      || hash(input.expectedIdentity.trim().toLowerCase()) !== input.expectedOwnerScopeSha256) {
    throw new Error('SETTINGS_INPUT_INVALID');
  }
  runtime = await createInMemoryGrokConversationRuntime({ pythonExecutable: input.pythonExecutable });
  await runtime.client.importSession(input.sessionBundle);
  const owner = await runtime.client.verifyOwner(input.expectedIdentity);
  proof.ownerVerified = owner.ownerVerified === true;
  proof.ownerScopeSha256 = input.expectedOwnerScopeSha256;
  if (!proof.ownerVerified) throw new Error('OWNER_UNVERIFIED');
  const ownerRead = await runtime.client.read('auth.owner.read', {});
  proof.ownerRead = readMeta(ownerRead);
  const initial = await runtime.conversations.settings();
  proof.before = readMeta(initial);
  baseline = initial.data.preferences?.autoWrapLongLinesCode;
  if (typeof baseline !== 'boolean') throw new Error('BOOLEAN_BASELINE_UNAVAILABLE');
  proof.baseline = baseline;
  proof.writeAttempts.apply++;
  const applied = await runtime.conversations.updateSettingsPreference('autoWrapLongLinesCode', !baseline, {
    confirm: true, intentId: `${input.intentPrefix}-apply`,
  });
  proof.apply = writeMeta(applied);
  const changed = await runtime.conversations.settings();
  proof.afterApply = readMeta(changed);
  changedVerified = changed.data.preferences?.autoWrapLongLinesCode === !baseline;
  proof.changedValueMatched = changedVerified;
  if (!changedVerified) throw new Error('SETTINGS_FLIP_UNVERIFIED');
  proof.writeAttempts.restore++;
  const restored = await runtime.conversations.updateSettingsPreference('autoWrapLongLinesCode', baseline, {
    confirm: true, intentId: `${input.intentPrefix}-restore`,
  });
  proof.restore = writeMeta(restored);
  const final = await runtime.conversations.settings();
  proof.afterRestore = readMeta(final);
  proof.baselineRestored = final.data.preferences?.autoWrapLongLinesCode === baseline;
  proof.wholeSettingsRestored = hash(JSON.stringify(initial.data)) === hash(JSON.stringify(final.data));
  proof.outcome = applied.verified && restored.verified && proof.baselineRestored
    && proof.wholeSettingsRestored ? 'verified' : 'needs_review';
} catch (error) {
  proof.outcome = 'needs_review';
  proof.failureCode = /^[A-Z][A-Z0-9_]{1,90}$/.test(error.code ?? error.message)
    ? error.code ?? error.message : 'SETTINGS_ROUNDTRIP_FAILED';
} finally {
  if (changedVerified && !proof.baselineRestored) proof.restoreRequired = true;
  proof.finishedAt = new Date().toISOString();
  proof.sourceStable = JSON.stringify(sourceBeforeImports) === JSON.stringify(await snapshot());
  process.stdout.write(JSON.stringify({ receipt: proof }) + '\n');
  if (runtime) await runtime.client.clearSession();
  input = null;
}
