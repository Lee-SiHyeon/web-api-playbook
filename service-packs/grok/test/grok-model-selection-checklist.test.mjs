import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('model selection evidence stays separate from preference writes, backend version, and expired-session recovery', () => {
  const result = spawnSync(process.execPath, ['scripts/check-features.mjs', '--json'], {
    cwd: ROOT, encoding: 'utf8', env: {},
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  const checklist = JSON.parse(readFileSync(path.join(ROOT, 'contracts/grok-feature-checklist.v1.json'), 'utf8'));
  const modelCodeFiles = checklist.handlerBindings['models.selected-mode-text'].codeFiles;
  for (const file of ['src/grok-mode-selected-text.mjs', 'src/grok-model-selection.mjs', 'src/grok-text-websocket.mjs',
    'scripts/grok-text-websocket-transport.py', 'src/grok-session-renewal.mjs', 'src/session.mjs', 'src/journal.mjs',
    'src/nonsecret-json-store.mjs', 'src/protected-json-store.mjs', 'src/authenticated-chrome-fetch.mjs',
    'scripts/authenticated-chrome-transport.py', 'src/cli.mjs', 'contracts/grok-web.v1.json']) {
    assert.ok(modelCodeFiles.includes(file), `missing model selection source binding: ${file}`);
  }
  assert.ok(!modelCodeFiles.includes('scripts/check-features.mjs'));
  assert.ok(!modelCodeFiles.includes('src/feature-checklist.mjs'));
  const modelFeature = report.features.find(item => item.id === 'models.private-selection');
  const selection = modelFeature.requirements.find(item => item.id === 'models.selection-in-chat');
  assert.ok(selection.evidence);
  assert.equal(selection.operationId, 'chat.text.wss');
  assert.equal(selection.evidence.selectedModeId, 'fast');
  assert.equal(selection.evidence.nativeSessionModel, 'fast');
  assert.equal(selection.evidence.serverAcknowledgementMatchedSelectedMode, true);
  assert.equal(selection.evidence.semanticHistoryReadbackVerified, true);
  assert.equal(selection.evidence.assistantTextLengthCodePoints, 2);
  assert.equal(selection.evidence.preferenceWriteForwarded, false);
  assert.equal(selection.evidence.providerBackendModelVersion, null);
  assert.equal(selection.evidence.providerBackendVersionObserved, false);
  assert.ok(!selection.blockers.includes('HANDLER_NOT_INSTALLED'));

  const renewalFeature = report.features.find(item => item.id === 'auth.session-renewal');
  assert.equal(renewalFeature.phaseClaims.find(item => item.id === 'auth.same-owner-handoff').status,
    'verified_phase_claim');
  assert.equal(renewalFeature.phaseClaims.find(item => item.id === 'auth.expired-provider-recovery').status,
    'unverified');
});
