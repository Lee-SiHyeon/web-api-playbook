import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inventoryPlaybook, auditPlaybook, readAuditFile, renderPlaybookAudit } from '../lib/playbook-audit.mjs';

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, 'playbook-audit-test-'));
  t.after(async () => {
    const target = await realpath(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('playbook-audit-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const save = async (file, value) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  await save('package.json', { scripts: { read: 'node scripts/read.mjs', helper: 'node lib/helper.mjs' } });
  await save('scripts/read.mjs', 'export function read() { return 1; }');
  await save('lib/helper.mjs', 'throw new Error("must not execute inventory targets");');
  await save('lib/client.mjs', 'export function read() { return 1; }');
  await save('tests/read.test.mjs', 'import test from "node:test"; test("local", () => {});');
  await save('service-packs/demo/scripts/unmapped.mjs', 'const args = process.argv;');
  await save('service-packs/demo/references/api-catalog.json', [{ method: 'GET', url: 'https://example.test/a' }]);
  await save('service-packs/demo/extension/manifest.json', { manifest_version: 3, background: { service_worker: 'background.js' } });
  await save('service-packs/demo/extension/background.js', 'chrome.debugger.sendCommand();');
  await save('service-packs/demo/probe.ps1', "Join-Path $PSScriptRoot 'probe.js'");
  await save('service-packs/demo/probe.js', 'document.querySelector("button");');
  const cap = id => ({ id, title: id, priority: 'required', applicability: 'applicable', requirement: 'local',
    implementation: { files: [{ path: 'lib/client.mjs', exports: ['read'] }], cli: [{ path: 'scripts/read.mjs', tokens: ['read'] }], tests: ['tests/read.test.mjs'] }, evidence: [], sourceEvidence: [] });
  await save('checklists/services/demo.json', { schemaVersion: 1, service: 'demo', capabilities: [cap('data.first'), cap('data.second')] });
  return { root, save };
}

test('whole inventory includes package commands, undeclared pack entrypoints and recorded catalogs', async t => {
  const { root, save } = await fixture(t);
  await save('.venv-oliveyoung/Lib/site-packages/vendor/manifest.json', '{');
  await save('.venv-oliveyoung/Lib/site-packages/vendor/browser.py', 'browser.launch()');
  const result = await inventoryPlaybook(root);
  assert.equal(result.inventory.manifestFiles, 1);
  assert.ok(result.inventory.entrypoints.some(item => item.path === 'service-packs/demo/scripts/unmapped.mjs' && !item.declaredInManifest));
  assert.equal(result.inventory.catalogs[0].entries, 1);
  assert.equal(result.inventory.packageCommands.find(item => item.name === 'helper').declaredInManifest, false);
  assert.ok(result.inventory.entrypoints.some(item => item.path === 'lib/helper.mjs' && !item.declaredInManifest));
  assert.ok(result.inventory.runtimeEntrypoints.some(item => item.path === 'service-packs/demo/extension/background.js' && item.kind === 'browser_extension_service_worker' && item.sourcePresent));
  assert.ok(result.inventory.runtimeEntrypoints.some(item => item.path === 'service-packs/demo/probe.js' && item.kind === 'powershell_relative_js_reference'));
  assert.ok(result.inventory.browserMentions.some(item => item.path === 'service-packs/demo/extension/background.js'));
  assert.equal(result.inventory.sourceAssets.some(file => file.startsWith('.venv-oliveyoung/')), false);
  assert.deepEqual(result.errors, []);
  await assert.rejects(() => readAuditFile(root, '../outside.json'), /AUDIT_PATH_INVALID/);
});

test('audit runs a shared declared test once and never calls inventory-discovered entrypoints', async t => {
  const { root } = await fixture(t); const calls = [];
  const result = await auditPlaybook({ root, runTests: true, testRunner: async (_root, file) => { calls.push(file); return { state: 'passed' }; } });
  assert.deepEqual(calls, ['tests/read.test.mjs']);
  assert.equal(result.summary.capabilities, 2);
  assert.equal(result.summary.byStatus.verified_local, 2);
  assert.equal(result.liveReplaysScheduledByAudit, 0);
  assert.equal(result.liveReplaysExecutedByAudit, 'not_measured_in_tests');
  assert.equal(result.testExecution.networkIsolated, false);
  assert.equal(result.summary.currentRemoteReadiness, 'not_established_by_offline_audit');
  assert.ok(renderPlaybookAudit(result).includes('data.second'));
});

test('invalid manifests do not hide the other services and make completeness false', async t => {
  const { root, save } = await fixture(t);
  await save('checklists/services/broken.json', '{');
  await save('checklists/services/null-cap.json', { service: 'null-cap', capabilities: [null] });
  await save('service-packs/demo/package.json', '{');
  const result = await auditPlaybook({ root });
  assert.equal(result.services.length, 1);
  assert.equal(result.summary.manifestCount, 3);
  assert.equal(result.summary.allManifestAuditsCompleted, false);
  assert.equal(result.summary.allRequiredGatesPassed, false);
  assert.equal(result.errors.length, 3);
});

test('optional CLI declarations and planned missing files keep distinct audit states', async t => {
  const { root, save } = await fixture(t);
  await save('checklists/services/planned.json', { schemaVersion: 1, service: 'planned', capabilities: [{
    id: 'future.read', title: 'Future', priority: 'required', applicability: 'applicable', requirement: 'live',
    implementation: { files: [{ path: 'lib/not-built.mjs' }], tests: ['tests/not-built.test.mjs'] }, evidence: [], sourceEvidence: [] }] });
  const result = await auditPlaybook({ root, runTests: true, testRunner: async () => ({ state: 'passed' }) });
  assert.equal(result.summary.allManifestAuditsCompleted, true);
  assert.equal(result.summary.allReferencedFilesPresent, false);
  assert.equal(result.testFiles['tests/not-built.test.mjs'].state, 'missing');
  assert.equal(result.services.find(item => item.service === 'planned').capabilities[0].status, 'unimplemented');
});
