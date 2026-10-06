import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditProvider, checkProviders, loadProviderRepoConfig, parseProviderOptions, projectProviderReport } from '../scripts/check-ai-providers.mjs';

function incomplete() {
  return { schema: 'gemini-feature-audit-result-v1', service: 'gemini-web', status: 'incomplete',
    executionMode: 'offline_filesystem_only', currentNetworkVerified: false, networkRequests: 0,
    providerInvocations: 0, browserProcessesCreated: 0,
    summary: { total: 1, accepted: 0, unresolved: 1, strictPass: false },
    features: [{ id: 'identity', status: 'live_receipt_missing' }] };
}

test('local configuration accepts only credential-free absolute provider paths', async () => {
  const scratch = process.env.TMPDIR ?? path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(path.join(scratch, 'ai-repo-config-'));
  const file = path.join(dir, 'repos.json');
  try {
    await writeFile(file, JSON.stringify({ schema: 'web-api-ai-provider-repos-v1', repos: { grok: '/workspace/grok' } }));
    assert.deepEqual(await loadProviderRepoConfig(file), { grok: '/workspace/grok' });
    await writeFile(file, JSON.stringify({ schema: 'web-api-ai-provider-repos-v1', repos: { grok: '/workspace/grok' }, token: 'fixture-secret' }));
    await assert.rejects(loadProviderRepoConfig(file), /PROVIDER_CONFIG_INVALID/);
    await writeFile(file, JSON.stringify({ schema: 'web-api-ai-provider-repos-v1', repos: { grok: 'relative/path' } }));
    await assert.rejects(loadProviderRepoConfig(file), /PROVIDER_CONFIG_INVALID/);
    assert.deepEqual(await loadProviderRepoConfig(path.join(dir, 'missing.json'), { optional: true }), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an explicit configuration path is parsed without accepting duplicate or relative arguments', () => {
  assert.equal(parseProviderOptions(['--config', '/workspace/repos.json', '--strict']).configPath, '/workspace/repos.json');
  assert.throws(() => parseProviderOptions(['--config', 'relative.json']), /PROVIDER_CHECK_ARGUMENT_INVALID/);
  assert.throws(() => parseProviderOptions(['--config', '/one.json', '--config', '/two.json']), /PROVIDER_CHECK_ARGUMENT_INVALID/);
});

test('stored receipt gaps preserve strict exit two; no checkout is not success', async () => {
  const { report, exitCode } = await checkProviders(parseProviderOptions(['--strict']));
  assert.equal(exitCode, 2);
  assert.equal(report.currentNetworkVerified, false);
  assert.equal(report.strictPass, false);
  assert.deepEqual(report.providers.map(p => p.status), ['not_installed', 'not_installed']);
  assert.equal(projectProviderReport('gemini', incomplete(), 2).unresolved, 1);
});

test('child cannot claim a fresh network check or contradict its strict result', () => {
  assert.throws(() => projectProviderReport('gemini', { ...incomplete(), currentNetworkVerified: true }, 2), /PROVIDER_REPORT_INVALID/);
  assert.throws(() => projectProviderReport('gemini', incomplete(), 0), /PROVIDER_REPORT_INVALID/);
  assert.throws(() => projectProviderReport('gemini', { ...incomplete(), features: [] }, 2), /PROVIDER_REPORT_INVALID/);
});

test('a consistent stored receipt report is accepted without claiming fresh network verification', () => {
  const report = incomplete();
  report.status = 'stored_receipt_consistent';
  report.summary = { total: 1, accepted: 1, unresolved: 0, strictPass: true };
  report.features[0].status = 'stored_receipt_consistent';
  const result = projectProviderReport('gemini', report, 0);
  assert.equal(result.strictPass, true);
  assert.equal(result.status, 'stored_receipt_consistency');
  assert.equal(result.sourceStatus, 'stored_receipt_consistent');
});

test('a positive summary cannot conceal unresolved feature rows', () => {
  const report = incomplete();
  report.status = 'stored_receipt_consistent';
  report.summary = { total: 1, accepted: 1, unresolved: 0, strictPass: true };
  assert.throws(() => projectProviderReport('gemini', report, 0), /PROVIDER_REPORT_INVALID/);
  const grok = { schemaVersion: 1, serviceId: 'grok-web', status: 'stored_receipt_consistent',
    mode: 'strict', ioPolicy: 'offline; stored receipts only', currentNetworkVerified: false,
    summary: { requiredFeatures: 1, completeRequiredFeatures: 1, requiredOperations: 1,
      completeRequiredOperations: 1, missingRequiredFeatures: 0 },
    features: [{ id: 'identity', required: true, status: 'incomplete' }] };
  assert.throws(() => projectProviderReport('grok', grok, 0), /PROVIDER_REPORT_INVALID/);
});

test('raw malformed child output is discarded', async () => {
  const scratch = path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'provider-check-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'scripts', 'check-features.mjs'), "process.stdout.write('UNSAFE_EXAMPLE_PAYLOAD');");
    const result = await auditProvider('gemini', root);
    assert.equal(result.error, 'PROVIDER_REPORT_INVALID');
    assert.equal(JSON.stringify(result).includes('UNSAFE_EXAMPLE_PAYLOAD'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('credential environment is not passed and extra report payload is not returned', async () => {
  const scratch = path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'provider-check-'));
  const prior = process.env.PROVIDER_CHECK_TEST_SECRET;
  process.env.PROVIDER_CHECK_TEST_SECRET = 'UNSAFE_EXAMPLE_ENV';
  try {
    await mkdir(path.join(root, 'scripts'));
    const report = incomplete();
    await writeFile(path.join(root, 'scripts', 'check-features.mjs'),
      `const report=${JSON.stringify(report)};if(process.env.PROVIDER_CHECK_TEST_SECRET)report.features[0].status='secret_inherited';report.extra='UNSAFE_EXAMPLE_EXTRA';process.stdout.write(JSON.stringify(report));process.exitCode=2;`);
    const result = await auditProvider('gemini', root);
    assert.equal(result.features[0].status, 'live_receipt_missing');
    assert.equal(result.strictPass, false);
    assert.equal(JSON.stringify(result).includes('UNSAFE_EXAMPLE'), false);
  } finally {
    if (prior === undefined) delete process.env.PROVIDER_CHECK_TEST_SECRET; else process.env.PROVIDER_CHECK_TEST_SECRET = prior;
    await rm(root, { recursive: true, force: true });
  }
});
