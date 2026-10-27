#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditCapabilityChecklist, safeRelativePath } from '../lib/capability-checklist.mjs';
import { verifyManifestImplementation } from '../lib/recorded-evidence-provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MANIFEST_PATH = 'verification/jobs-freelance-2026-10-27/manifest.json';
const MANIFEST_PATH_PATTERN = /^verification\/jobs-freelance-(\d{4}-\d{2}-\d{2})\/manifest\.json$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };

function validDateFolder(value) {
  const timestamp = Date.parse(value + 'T00:00:00.000Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function selectManifestPath(args = []) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    fail('ARGUMENT_INVALID', 'Expected only --manifest=verification/jobs-freelance-YYYY-MM-DD/manifest.json');
  }
  if (args.length === 0) return DEFAULT_MANIFEST_PATH;
  if (args.length !== 1 || !args[0].startsWith('--manifest=')) {
    fail('ARGUMENT_INVALID', 'Expected only --manifest=verification/jobs-freelance-YYYY-MM-DD/manifest.json');
  }
  const manifestPath = args[0].slice('--manifest='.length);
  const match = MANIFEST_PATH_PATTERN.exec(manifestPath);
  if (!match || !validDateFolder(match[1]) || !safeRelativePath(manifestPath)) {
    fail('MANIFEST_PATH_INVALID', 'Manifest path must be verification/jobs-freelance-YYYY-MM-DD/manifest.json');
  }
  return manifestPath;
}

const readFromRoot = async file => {
  assert.ok(safeRelativePath(file), 'Unsafe evidence path');
  return readFile(path.join(root, file));
};
const json = async file => JSON.parse((await readFromRoot(file)).toString('utf8'));
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function nonSecret(value) {
  if (Array.isArray(value)) { value.forEach(nonSecret); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(?:cookie|cookies|authorization|accessToken|refreshToken|apiKey|password|rawHtml|rawBody|storageState)$/i.test(key),
      `Unexpected sensitive evidence field: ${key}`);
    if (typeof child === 'string') assert.ok(!/[?&](?:access_token|__cf_chl_rt_tk|api_key)=/i.test(child), 'Sensitive URL in evidence');
    nonSecret(child);
  }
}
function verifyRequest(request) {
  assert.equal(request.method, 'GET');
  assert.equal(request.httpStatus, 200);
  assert.ok(['application/json', 'text/html'].includes(request.mime));
  assert.equal(request.browserUsed, false);
  assert.equal(request.anonymous, true);
  assert.equal(request.credentialsUsed, false);
  assert.notEqual(request.cookieSent, true);
  assert.notEqual(request.cookiesSent, true);
  assert.ok(validTime(request.checkedAt));
  assert.ok(Number.isSafeInteger(request.responseBytes) && request.responseBytes > 0);
  assert.match(request.responseSha256, /^[a-f0-9]{64}$/);
  const url = new URL(request.path, request.origin);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, request.origin);
  assert.equal(url.pathname, request.path);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
}

async function main(args = process.argv.slice(2)) {
  try {
    const manifestPath = selectManifestPath(args);
    const folder = path.posix.dirname(manifestPath) + '/';
    const manifest = await json(manifestPath);
    assert.equal(manifest.schema, 'web-api-jobs-freelance-verification-v1');
    assert.ok(validTime(manifest.recordedAt));
    assert.match(manifest.baseCommit, /^[a-f0-9]{40}$/);
    nonSecret(manifest);
    const implementation = await verifyManifestImplementation({ implementation: manifest.implementation,
      readFile: readFromRoot, sha256: sha, verificationToolKinds: {
        'scripts/verify-jobs-freelance.mjs': 'offline_verifier',
        'lib/capability-checklist.mjs': 'evidence_validator',
      } });
    // The blocked TokyoDev HTTP adapter is checked against local document parsing
    // evidence, separately from the implementations exercised over the network.
    for (const [file, hash] of Object.entries(manifest.offlineImplementation ?? {})) {
      assert.equal(sha(await readFromRoot(file)), hash, `Offline implementation changed: ${file}`);
    }
    for (const [file, hash] of Object.entries(manifest.artifacts)) {
      assert.equal(sha(await readFromRoot(folder + file)), hash, `Evidence changed: ${file}`);
      nonSecret(await json(folder + file));
    }
    const executions = new Map();
    for (const entry of manifest.executions) {
      const run = await json(folder + entry.file);
      assert.equal(run.schema, 'web-api-public-document-result-v1');
      assert.equal(run.service, entry.service);
      assert.equal(run.ok, true);
      assert.equal(run.executionMode, 'pure_http');
      assert.equal(run.anonymous, true);
      for (const field of ['browserUsed', 'credentialsUsed', 'completeCatalog']) assert.equal(run[field], false);
      assert.equal(run.writesSubmitted, 0);
      assert.equal(run.fiveStates.captured, false);
      assert.equal(run.fiveStates.live_replay, true);
      assert.equal(run.dataSha256, sha(JSON.stringify(run.data)));
      assert.equal(run.data.items.length, entry.resultCount);
      assert.equal(new Set(run.data.items.map(item => String(item.id))).size, run.data.items.length);
      assert.ok(run.requests.length > 0);
      run.requests.forEach(verifyRequest);
      if (run.coverage?.complete === false) assert.ok(run.coverage.reason || run.coverage.pageWalked === false);
      executions.set(entry.name, run);
    }
    for (const pair of manifest.identityReadbacks) {
      const list = executions.get(pair.list), detail = executions.get(pair.detail);
      assert.ok(list && detail);
      assert.ok(Date.parse(detail.checkedAt) > Date.parse(list.checkedAt));
      assert.equal(detail.data.items.length, 1);
      assert.ok(list.data.items.some(item => item.id === detail.data.items[0].id));
    }
    const local = await json(folder + 'local-validation.json');
    assert.equal(local.networkUsed, false);
    assert.equal(local.liveReplay, false);
    assert.equal(local.tokyodev.executionMode, 'offline');
    assert.equal(local.tokyodev.jobCount, local.tokyodev.uniqueJobCount);
    assert.equal(local.snapshots.missingInterpretation, 'not_proof_of_closure');
    assert.ok(local.tools.jobs > 0 && local.tools.freelance > 0);
    for (const [service, ids] of Object.entries(manifest.recordedCapabilities)) {
      const audit = await auditCapabilityChecklist({ root, service });
      for (const id of ids) assert.equal(audit.capabilities.find(cap => cap.id === id)?.status,
        'recorded_live', `${service}:${id}`);
    }
    console.log(JSON.stringify({ ok: true, verification: 'recorded_evidence_revalidated',
      manifestPath,
      recordedAt: manifest.recordedAt, checkedAt: new Date().toISOString(), networkUsed: false,
      liveCheckedNow: false, executionCount: executions.size,
      recordedCapabilities: manifest.recordedCapabilities, boundaries: manifest.boundaries,
      ...implementation }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, verification: 'recorded_evidence_revalidation_failed',
      networkUsed: false, code: error.code ?? 'EVIDENCE_INVALID', message: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
