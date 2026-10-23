import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditGeminiFeatures,
  matchesLocalModelSelectionReadback,
  validateLocalModelControlEvidence,
  validateRequestOnlyBatchMutationEvidence,
} from '../src/feature-checklist.mjs';
import { featureAuditExitCode, parseFeatureAuditOptions } from '../scripts/check-features.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';
import { contract, operation, rawContract } from './helpers.mjs';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function codeSetHash(files) {
  const canonical = [...files].map(({ path: filePath, sha256: digest }) => ({ path: filePath, sha256: digest }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return hash(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

async function digestFile(relativePath) {
  return hash(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', relativePath)));
}

async function hashesFor(files) {
  return Object.fromEntries(await Promise.all([...new Set(files)].map(async filePath => [filePath, await digestFile(filePath)])));
}

async function putJson(root, relativePath, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return hash(bytes);
}

function miniChecklist() {
  return {
    schema: 'gemini-feature-checklist-v1',
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    policy: {
      ownerIdentityFeatureId: 'identity', ownerIdentityOperationId: 'history',
      ownerIdentityOperationCaseId: 'owner',
      unknownApplicabilityBlocksStrict: true, publicStatusCanCompletePrivateFeature: false,
    },
    features: [{
      id: 'text_generation', title: 'Text generation', applicability: 'required',
      basis: { kind: 'user_scope', reference: 'fixture', note: 'Fixture.' },
      contractOperations: ['text', 'history'],
      requiredOperationCases: [
        { operation: 'text', caseId: 'generate' },
        { operation: 'history', caseId: 'generated_response' },
      ],
      requiredEffects: { text: 'mutation', history: 'read' },
      readbackOperations: ['history'], requiresOwnerIdentity: true, requiresReadback: true,
      requiredReadbackBindings: [{
        writeOperation: 'text', writeCaseId: 'generate',
        readOperation: 'history', readCaseId: 'generated_response',
      }],
      receiptPath: 'verification/features/text_generation.json',
    }],
  };
}

function pairEvidence({ featureId, operationId, caseId, operationContract, contractHash, clientCodeSha256, correlationId, readbackOfOperation, readbackOfCaseId, mocked = false }) {
  const request = operationContract.request;
  return {
    schema: 'gemini-feature-pair-evidence-v1',
    service: SERVICE_ID,
    featureId,
    operationId,
    caseId,
    contractSha256: contractHash,
    clientCodeSha256,
    observedAt: '2026-10-05T10:00:00.000Z',
    executionHost: 'linux_worker',
    transport: 'direct_http',
    evidenceClass: mocked ? 'synthetic_fixture' : 'direct_http_live',
    mocked,
    publicOnly: false,
    requestResponsePaired: true,
    authenticatedOwnerVerified: true,
    expectedOutcomeVerified: true,
    ...(operationId === 'history' && featureId === 'identity' ? { identityMatchVerified: true } : {}),
    ...(readbackOfOperation ? { readbackOfOperation } : {}),
    ...(readbackOfCaseId ? { readbackOfCaseId } : {}),
    request: {
      method: request.method,
      origin: request.origin,
      path: request.path,
      queryKeys: [...request.queryKeys],
      headerNames: [...request.headerNames],
      ...(request.contentType ? { contentType: request.contentType } : {}),
      valuesPersisted: false,
      ...(correlationId ? { correlationId } : {}),
    },
    response: {
      status: 200,
      contentType: 'application/json',
      bytes: 25,
      bodySha256: 'a'.repeat(64),
      framing: operationContract.response.framing,
    },
    secretsPersisted: false,
  };
}

async function fixture({ positive = false, mocked = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gemini-feature-audit-'));
  await mkdir(path.join(root, 'discovery'), { recursive: true });
  await putJson(root, 'discovery/feature-checklist.json', miniChecklist());
  const contract = rawContract({ operations: {
    text: operation({ effect: 'mutation', method: 'POST', path: '/captured/text', contentType: 'application/x-www-form-urlencoded' }),
    history: operation({ path: '/captured/history' }),
  } });
  const contractHash = await putJson(root, 'discovery/observed-contract.json', contract);

  if (positive || mocked) {
    const sourcePath = 'src/text-adapter.mjs';
    const sourceBytes = Buffer.from('export const adapterVersion = 1;\n');
    const identitySourcePath = 'src/identity-adapter.mjs';
    const identitySourceBytes = Buffer.from('export const identityAdapterVersion = 1;\n');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, sourcePath), sourceBytes);
    await writeFile(path.join(root, identitySourcePath), identitySourceBytes);
    const codeFiles = [{ path: sourcePath, sha256: hash(sourceBytes) }];
    const identityCodeFiles = [{ path: identitySourcePath, sha256: hash(identitySourceBytes) }];
    const codeHash = codeSetHash(codeFiles);
    const identityCodeHash = codeSetHash(identityCodeFiles);

    const identityPath = 'verification/feature-evidence/identity--history--owner.json';
    const identityHash = await putJson(root, identityPath, pairEvidence({
      featureId: 'identity', operationId: 'history', caseId: 'owner', operationContract: contract.operations.history,
      contractHash, clientCodeSha256: identityCodeHash,
    }));
    const correlationId = 'write-readback-001';
    const writePath = 'verification/feature-evidence/text_generation--text--generate.json';
    const writeHash = await putJson(root, writePath, pairEvidence({
      featureId: 'text_generation', operationId: 'text', caseId: 'generate', operationContract: contract.operations.text,
      contractHash, clientCodeSha256: codeHash, correlationId, mocked,
    }));
    const readPath = 'verification/feature-evidence/text_generation--history--generated_response.json';
    const readHash = await putJson(root, readPath, {
      ...pairEvidence({
        featureId: 'text_generation', operationId: 'history', caseId: 'generated_response', operationContract: contract.operations.history,
        contractHash, clientCodeSha256: codeHash, correlationId, readbackOfOperation: 'text', readbackOfCaseId: 'generate', mocked,
      }),
    });
    await putJson(root, 'verification/features/text_generation.json', {
      schema: 'gemini-feature-live-receipt-v1',
      service: SERVICE_ID,
      featureId: 'text_generation',
      outcome: 'verified',
      checkedAt: '2026-10-05T10:01:00.000Z',
      evidenceClass: 'direct_http_live',
      transport: 'direct_http',
      executionHost: 'linux_worker',
      mocked: false,
      publicOnly: false,
      authenticatedOwnerVerified: true,
      secretsPersisted: false,
      contractSha256: contractHash,
      implementationFiles: codeFiles,
      implementationSetSha256: codeHash,
      ownerIdentityEvidence: {
        path: identityPath, sha256: identityHash,
        implementationFiles: identityCodeFiles, implementationSetSha256: identityCodeHash,
      },
      operationEvidence: [
        { operationId: 'text', caseId: 'generate', path: writePath, sha256: writeHash },
        { operationId: 'history', caseId: 'generated_response', path: readPath, sha256: readHash },
      ],
      readbackBindings: [{
        writeOperation: 'text', writeCaseId: 'generate', readOperation: 'history', readCaseId: 'generated_response', correlationId,
        sameOwner: true, requestCorrelationVerified: true, expectedStateVerified: true,
      }],
    });
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const IDENTITY_FILES = [
  'src/client.mjs', 'src/constants.mjs', 'src/contract.mjs', 'src/http-session-bootstrap.mjs',
  'src/http-transport.mjs', 'src/https-transport.mjs', 'src/session.mjs',
];
const HISTORY_FILES = [
  'src/batch-response.mjs', ...IDENTITY_FILES, 'src/cli.mjs', 'src/http-session-bootstrap.mjs', 'src/rpc-adapters.mjs',
];
const LOGIN_FILES = [...new Set([
  ...IDENTITY_FILES, 'scripts/gemini-settings-update-once.py', 'src/cli.mjs', 'src/client.mjs',
  'src/constants.mjs', 'src/contract.mjs', 'src/http-session-bootstrap.mjs', 'src/http-transport.mjs',
  'src/https-transport.mjs', 'src/session.mjs',
])];

function mappedChecklist() {
  const feature = (id, operation, caseId) => ({
    id,
    title: id,
    applicability: 'required',
    basis: { kind: 'user_scope', reference: 'fixture', note: 'A focused checker fixture.' },
    contractOperations: [operation],
    requiredEffects: { [operation]: 'read' },
    readbackOperations: [],
    requiresOwnerIdentity: true,
    receiptPath: `verification/features/${id}.json`,
    requiredOperationCases: [{ operation, caseId }],
  });
  return {
    schema: 'gemini-feature-checklist-v1',
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    policy: {
      ownerIdentityFeatureId: 'identity',
      ownerIdentityOperationId: 'identity',
      ownerIdentityOperationCaseId: 'owner',
      unknownApplicabilityBlocksStrict: true,
      publicStatusCanCompletePrivateFeature: false,
    },
    features: [feature('identity', 'identity', 'owner'), feature('login', 'identity', 'owner'), feature('history', 'history_list', 'list')],
  };
}

function mappedContract() {
  return contract({ operations: {
    identity: operation({ path: '/app', responseContentType: 'text/html', framing: 'text' }),
    history_list: operation({
      method: 'POST',
      path: '/_/BardChatUi/data/batchexecute',
      queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
      headerNames: ['content-type', 'referer'],
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      responseContentType: 'application/json',
      framing: 'batchexecute',
      rpcId: 'MaZiqc',
    }),
  } });
}

function mappedPair({ featureId, operationId, caseId, operationContract, contractHash, codeHash, identityMatch = false, headerNames }) {
  return {
    schema: 'gemini-feature-pair-evidence-v1',
    service: SERVICE_ID,
    featureId,
    operationId,
    caseId,
    contractSha256: contractHash,
    clientCodeSha256: codeHash,
    observedAt: '2026-10-06T00:00:00.000Z',
    executionHost: 'linux_worker',
    transport: 'direct_http',
    evidenceClass: 'direct_http_live',
    mocked: false,
    publicOnly: false,
    requestResponsePaired: true,
    authenticatedOwnerVerified: true,
    expectedOutcomeVerified: true,
    ...(operationId === 'identity' ? { credentialPropagated: true } : {}),
    ...(identityMatch ? { identityMatchVerified: true } : {}),
    request: {
      method: operationContract.request.method,
      origin: operationContract.request.origin,
      path: operationContract.request.path,
      queryKeys: [...operationContract.request.queryKeys],
      headerNames: headerNames ? [...headerNames] : [...operationContract.request.headerNames],
      ...(operationContract.request.contentType ? { contentType: operationContract.request.contentType } : {}),
      valuesPersisted: false,
    },
    response: {
      status: 200,
      contentType: operationContract.response.contentType,
      bytes: 64,
      bodySha256: 'e'.repeat(64),
      framing: operationContract.response.framing,
    },
    secretsPersisted: false,
  };
}

function mappedReceipt({ featureId, operationId, operationCase, pairPath, pairHash, contractHash, implementationFiles, implementationHash, identityPath, identityHash, identityFiles, identityImplementationHash, sessionHandoffVerified = false, authBootstrapEvidence }) {
  return {
    schema: 'gemini-feature-live-receipt-v1',
    service: SERVICE_ID,
    featureId,
    outcome: 'verified',
    checkedAt: '2026-10-06T00:02:00.000Z',
    evidenceClass: 'direct_http_live',
    transport: 'direct_http',
    executionHost: 'linux_worker',
    mocked: false,
    publicOnly: false,
    authenticatedOwnerVerified: true,
    secretsPersisted: false,
    contractSha256: contractHash,
    implementationFiles,
    implementationSetSha256: implementationHash,
    ownerIdentityEvidence: {
      path: identityPath,
      sha256: identityHash,
      implementationFiles: identityFiles,
      implementationSetSha256: identityImplementationHash,
    },
    operationEvidence: [{ operationId, caseId: operationCase, path: pairPath, sha256: pairHash }],
    ...(sessionHandoffVerified ? { sessionHandoffVerified: true, authBootstrapEvidence } : {}),
  };
}

async function mappedFixture({ identityHeaderNames } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gemini-mapped-feature-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const checklist = mappedChecklist();
    const contract = mappedContract();
    const contractHash = await putJson(root, 'discovery/feature-checklist.json', checklist);
    const actualContractHash = await putJson(root, 'discovery/observed-contract.json', contract);
    assert.equal(contractHash.length, 64);
    const implementationPaths = [...new Set([...IDENTITY_FILES, ...HISTORY_FILES, ...LOGIN_FILES])];
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const runtimeModules = (await readdir(path.join(sourceRoot, 'src')))
      .filter(name => name.endsWith('.mjs')).map(name => `src/${name}`);
    for (const relativePath of new Set([...implementationPaths, ...runtimeModules])) {
      const sourceBytes = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', relativePath));
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, sourceBytes);
    }
    const identityFiles = await hashesFor(IDENTITY_FILES);
    const historyFiles = await hashesFor(HISTORY_FILES);
    const loginFiles = await hashesFor(LOGIN_FILES);
    const codeHashes = await hashesFor(implementationPaths);
    const identityImplementationHash = codeSetHash(Object.entries(identityFiles).map(([filePath, digest]) => ({ path: filePath, sha256: digest })));
    const historyImplementationHash = codeSetHash(Object.entries(historyFiles).map(([filePath, digest]) => ({ path: filePath, sha256: digest })));
    const loginImplementationHash = codeSetHash(Object.entries(loginFiles).map(([filePath, digest]) => ({ path: filePath, sha256: digest })));
    const identityPairPath = 'verification/feature-evidence/identity--identity--owner.json';
    const identityPairHash = await putJson(root, identityPairPath, mappedPair({
      featureId: 'identity', operationId: 'identity', caseId: 'owner',
      operationContract: contract.operations.identity, contractHash: actualContractHash,
      codeHash: identityImplementationHash, identityMatch: true, headerNames: identityHeaderNames,
    }));
    const ownerIdentityReference = {
      path: identityPairPath,
      sha256: identityPairHash,
      implementationFiles: Object.entries(identityFiles).map(([filePath, digest]) => ({ path: filePath, sha256: digest })),
      implementationSetSha256: identityImplementationHash,
    };
    const identityReceiptValue = mappedReceipt({
      featureId: 'identity', operationId: 'identity', operationCase: 'owner', pairPath: identityPairPath,
      pairHash: identityPairHash, contractHash: actualContractHash,
      implementationFiles: ownerIdentityReference.implementationFiles,
      implementationHash: identityImplementationHash,
      identityPath: identityPairPath, identityHash: identityPairHash,
      identityFiles: ownerIdentityReference.implementationFiles,
      identityImplementationHash,
    });
    await putJson(root, 'verification/features/identity.json', identityReceiptValue);

    const historyPairPath = 'verification/feature-evidence/history--history_list--list.json';
    const historyPairHash = await putJson(root, historyPairPath, mappedPair({
      featureId: 'history', operationId: 'history_list', caseId: 'list',
      operationContract: contract.operations.history_list, contractHash: actualContractHash,
      codeHash: historyImplementationHash,
    }));
    await putJson(root, 'verification/features/history.json', mappedReceipt({
      featureId: 'history', operationId: 'history_list', operationCase: 'list', pairPath: historyPairPath,
      pairHash: historyPairHash, contractHash: actualContractHash,
      implementationFiles: Object.entries(historyFiles).map(([filePath, digest]) => ({ path: filePath, sha256: digest })),
      implementationHash: historyImplementationHash,
      identityPath: identityPairPath, identityHash: identityPairHash,
      identityFiles: ownerIdentityReference.implementationFiles,
      identityImplementationHash,
    }));

    const loginPairPath = 'verification/feature-evidence/login--identity--owner.json';
    const loginPairHash = await putJson(root, loginPairPath, mappedPair({
      featureId: 'login', operationId: 'identity', caseId: 'owner',
      operationContract: contract.operations.identity, contractHash: actualContractHash,
      codeHash: identityImplementationHash, identityMatch: true, headerNames: identityHeaderNames,
    }));
    const bootstrapFiles = Object.entries(loginFiles).map(([filePath, digest]) => ({ path: filePath, sha256: digest }));
    const bootstrapCodeHash = codeSetHash(bootstrapFiles);
    const authBootstrapEvidence = {
      schema: 'gemini-native-auth-bootstrap-evidence-v2',
      executionHost: 'linux_worker',
      context: 'native_browser_session_handoff',
      providerAuthenticatedSessionObserved: true,
      nativeBrowserProfile: true,
      sessionHandoffVerified: true,
      passwordSubmittedToProviderApi: false,
      challengeBypassUsed: false,
      evidenceScope: 'same_authenticated_owner',
      ownerIdentityEvidenceSha256: identityPairHash,
      observedAt: '2026-10-06T00:01:00.000Z',
      recordedAt: '2026-10-06T00:01:30.000Z',
      secretsPersisted: false,
      implementationFiles: bootstrapFiles,
      implementationSetSha256: bootstrapCodeHash,
    };
    await putJson(root, 'verification/features/login.json', mappedReceipt({
      featureId: 'login', operationId: 'identity', operationCase: 'owner', pairPath: loginPairPath,
      pairHash: loginPairHash, contractHash: actualContractHash,
      implementationFiles: Object.entries(identityFiles).map(([filePath, digest]) => ({ path: filePath, sha256: digest })),
      implementationHash: identityImplementationHash,
      identityPath: identityPairPath, identityHash: identityPairHash,
      identityFiles: ownerIdentityReference.implementationFiles,
      identityImplementationHash,
      sessionHandoffVerified: true,
      authBootstrapEvidence,
    }));
    return { root, cleanup, codeHashes };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test('public app-shell HTTP 200 and published source candidates do not satisfy private feature checks', async () => {
  const setup = await fixture();
  try {
    await putJson(setup.root, 'discovery/public-status.json', {
      status: 200, directReadVerified: true, authenticationVerified: false,
    });
    await putJson(setup.root, 'discovery/source-candidates.json', {
      operations: ['StreamGenerate'], candidateOnly: true,
    });
    const result = await auditGeminiFeatures({ root: setup.root });
    assert.equal(result.executionMode, 'offline_filesystem_only');
    assert.equal(result.status, 'incomplete');
    assert.equal(result.networkRequests, 0);
    assert.equal(result.providerInvocations, 0);
    assert.equal(result.browserProcessesCreated, 0);
    assert.equal(result.features[0].status, 'implementation_missing');
    assert.equal(result.summary.strictPass, false);
  } finally {
    await setup.cleanup();
  }
});

test('a request-only capture remains a contract blocker and cannot be decoded as a paired response', async () => {
  const setup = await fixture();
  try {
    const contractValue = rawContract({ operations: {
      text: {
        ...operation({ effect: 'mutation', method: 'POST', path: '/captured/text', contentType: 'application/x-www-form-urlencoded' }),
        observation: { request: true, requestResponse: false },
        request: {
          method: 'POST', origin: SERVICE_ORIGIN, path: '/captured/text', queryKeys: [], headerNames: ['content-type'],
          contentType: 'application/x-www-form-urlencoded', bodyFieldNames: ['f.req', 'at'],
        },
        response: undefined,
      },
      history: operation({ path: '/captured/history' }),
    } });
    delete contractValue.operations.text.response;
    await putJson(setup.root, 'discovery/observed-contract.json', contractValue);
    const result = await auditGeminiFeatures({ root: setup.root });
    assert.equal(result.features[0].status, 'captured_contract_missing');
    assert.ok(result.features[0].reasons.some(reason => reason.includes('request/response pair is incomplete: text')));
    assert.equal(result.summary.strictPass, false);
  } finally {
    await setup.cleanup();
  }
});

test('installed adapters without canonical live receipts report live_evidence_missing', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = await mkdtemp(path.join(os.tmpdir(), 'gemini-missing-live-receipts-'));
  try {
    await mkdir(path.join(root, 'discovery'), { recursive: true });
    await writeFile(path.join(root, 'discovery/feature-checklist.json'),
      await readFile(path.join(repo, 'discovery/feature-checklist.json')));
    await writeFile(path.join(root, 'discovery/observed-contract.json'),
      await readFile(path.join(repo, 'discovery/observed-contract.json')));
    const result = await auditGeminiFeatures({ root });
    const byId = new Map(result.features.map((feature) => [feature.id, feature.status]));
    assert.equal(byId.get('login'), 'live_evidence_missing');
    assert.equal(byId.get('identity'), 'live_evidence_missing');
    assert.equal(byId.get('text_generation'), 'live_evidence_missing');
    assert.equal(byId.get('history'), 'live_evidence_missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('image and video handlers bind to the captured request-only StreamGenerate contract without inventing wire operations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gemini-media-adapter-alias-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await mkdir(path.join(root, 'discovery'), { recursive: true });
    const feature = {
      id: 'image_generation', title: 'Image generation', applicability: 'required',
      basis: { kind: 'user_scope', reference: 'fixture', note: 'Operation adapter fixture.' },
      contractOperations: ['image'], requiredEffects: { image: 'mutation' },
      readbackOperations: [], requiresOwnerIdentity: true,
      receiptPath: 'verification/features/image_generation.json',
      requiredOperationCases: [{ operation: 'image', caseId: 'generate' }],
    };
    const videoFeature = {
      ...feature,
      id: 'video_generation',
      title: 'Video generation',
      contractOperations: ['video'],
      requiredEffects: { video: 'mutation' },
      requiredOperationCases: [{ operation: 'video', caseId: 'generate' }],
      receiptPath: 'verification/features/video_generation.json',
    };
    await putJson(root, 'discovery/feature-checklist.json', {
      schema: 'gemini-feature-checklist-v1', service: SERVICE_ID, origin: SERVICE_ORIGIN,
      policy: {
        ownerIdentityFeatureId: 'identity', ownerIdentityOperationId: 'identity', ownerIdentityOperationCaseId: 'owner',
        unknownApplicabilityBlocksStrict: true, publicStatusCanCompletePrivateFeature: false,
      },
      features: [feature, videoFeature],
    });
    const text = operation({
      effect: 'mutation', method: 'POST', path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
      queryKeys: ['bl', 'f.sid', 'hl', '_reqid', 'rt'], headerNames: ['content-type'],
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    });
    text.observation = { request: true, requestResponse: false };
    text.request.bodyFieldNames = ['f.req', 'at'];
    delete text.response;
    const contractValue = rawContract({
      assetOrigins: ['https://lh3.googleusercontent.com', 'https://contribution.usercontent.google.com'],
      operations: { text },
    });
    contractValue.mediaAssetDownload = {
      version: 1, taskBinding: 'hNvQHb_prompt_and_api_id',
      sources: [{ capability: 'image', origin: 'https://lh3.googleusercontent.com', pathFamily: '/gg/{id}',
        queryKeyNames: [], mimeTypes: ['image/png'], headerNames: [] },
      { capability: 'video', origin: 'https://contribution.usercontent.google.com', pathFamily: '/download',
        queryKeyNames: ['c', 'filename', 'opi'], mimeTypes: ['video/mp4'], headerNames: [] }],
      redirectEdges: [], cookieScopes: [], excludedCandidates: [],
    };
    await putJson(root, 'discovery/observed-contract.json', contractValue);
    const result = await auditGeminiFeatures({ root });
    assert.equal(result.features[0].status, 'live_evidence_missing');
    assert.ok(result.features[0].reasons.some(reason => reason.includes('feature receipt is absent')));
    assert.deepEqual(result.features[0].contractOperations, ['image']);
    assert.equal(result.features[1].status, 'live_evidence_missing');
    assert.deepEqual(result.features[1].contractOperations, ['video']);
    assert.equal(contractValue.operations.image, undefined);
    assert.equal(contractValue.operations.video, undefined);

    contractValue.mediaAssetDownload.sources = contractValue.mediaAssetDownload.sources.filter((source) => source.capability !== 'video');
    await putJson(root, 'discovery/observed-contract.json', contractValue);
    const missingArtifactSource = await auditGeminiFeatures({ root });
    assert.equal(missingArtifactSource.features[0].status, 'live_evidence_missing');
    assert.equal(missingArtifactSource.features[1].status, 'captured_contract_missing');
    assert.ok(missingArtifactSource.features[1].reasons.some(reason => reason.includes('task-media download contract')));
  } finally {
    await cleanup();
  }
});

test('checked-in checklist retains all requested groups and evidence-resolved applicability', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const checklist = JSON.parse(await readFile(path.join(root, 'discovery/feature-checklist.json'), 'utf8'));
  const featureMap = new Map(checklist.features.map((feature) => [feature.id, feature]));
  for (const id of [
    'login', 'identity', 'text_generation', 'history', 'readbacks', 'edit', 'delete', 'share',
    'attachments_upload', 'attachments_download', 'model_selection', 'settings', 'image_generation',
    'video_generation', 'session_renewal', 'model_catalog',
  ]) assert.ok(featureMap.has(id), `missing feature: ${id}`);
  assert.equal(featureMap.get('edit').applicability, 'unknown');
  assert.equal(featureMap.get('image_generation').applicability, 'required');
  assert.equal(featureMap.get('video_generation').applicability, 'required');
  assert.equal(featureMap.get('attachments_upload').applicability, 'required');
  assert.ok(featureMap.get('image_generation').basis.note.includes('original/full-resolution remains unverified'));
  assert.equal(featureMap.get('text_generation').basis.kind, 'published_source_candidate');
  const models = featureMap.get('model_selection');
  assert.deepEqual(models.contractOperations, ['model_list', 'model_select', 'selection_state']);
  assert.deepEqual(models.requiredOperationCases, [
    { operation: 'model_list', caseId: 'available' },
    { operation: 'model_select', caseId: 'select' },
    { operation: 'model_list', caseId: 'selected' },
    { operation: 'selection_state', caseId: 'selected' },
  ]);
  assert.deepEqual(models.readbackOperations, ['selection_state']);
  assert.deepEqual(models.requiredReadbackBindings, [{
    writeOperation: 'model_select', writeCaseId: 'select', readOperation: 'selection_state', readCaseId: 'selected',
  }]);
  const audit = await auditGeminiFeatures({ root });
  assert.equal(audit.executionMode, 'offline_filesystem_only');
  // The checked-in identity evidence predates source-scoped receipts and must
  // not be silently rebound to the current handler hash.
  assert.equal(audit.features.find((feature) => feature.id === 'identity').status, 'needs_reverification');
});

test('historical proofs cannot substitute for absent canonical receipts', async (t) => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'gemini-historical-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Copy historical inputs only. This case must remain independent of any
  // new live canonical receipts written into the working checkout.
  for (const relativePath of [
    'discovery/feature-checklist.json', 'discovery/observed-contract.json',
    'verification/one-shot/gemini-protocol-decoder-verification-2026-10-06.json',
    'discovery/media-browser-capture-2026-10-06.json', 'discovery/media-api-readback-2026-10-06.json',
    'discovery/media-asset-verify-2026-10-06.json', 'discovery/media-download-direct-2026-10-06.json',
    'discovery/gemini-model-selection-live-2026-10-06.json',
  ]) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), await readFile(path.join(repo, relativePath)));
  }
  const installedContract = JSON.parse(await readFile(path.join(root, 'discovery/observed-contract.json')));
  installedContract.mediaAssetDownload.sources = installedContract.mediaAssetDownload.sources.filter((source) => source.capability !== 'video');
  await putJson(root, 'discovery/observed-contract.json', installedContract);
  const historicalModelPath = 'discovery/gemini-model-selection-live-2026-10-06.json';
  const historicalModel = JSON.parse(await readFile(path.join(root, historicalModelPath)));
  // This synthetic scenario represents the guarded UI-only selection trials,
  // before the separate later Pro text dispatch. Do not modify the live receipt.
  delete historicalModel.proTextDispatchReadback;
  historicalModel.writeAndGenerationBoundary.businessDispatchCount = 0;
  historicalModel.evidenceMode = 'synthetic_historical_ui_selection_fixture';
  await putJson(root, historicalModelPath, historicalModel);
  const result = await auditGeminiFeatures({ root });
  const byId = new Map(result.features.map((feature) => [feature.id, feature]));
  assert.equal(result.summary.total, 16);
  assert.equal(result.currentNetworkVerified, false);
  assert.equal(byId.get('text_generation').status, 'needs_reverification');
  assert.equal(byId.get('text_generation').recordedEvidence.implementationHashesBound, false);
  assert.equal(byId.get('history').status, 'live_evidence_missing');
  assert.equal(byId.get('history').recordedEvidence.taskDetailReadbackBoundToText, true);
  assert.equal(byId.get('history').recordedEvidence.historySearchReceipt, false);
  assert.equal(byId.get('image_generation').status, 'needs_reverification');
  assert.equal(byId.get('image_generation').recordedEvidence.artifactDownloadVerified, true);
  assert.equal(byId.get('image_generation').recordedEvidence.implementationHashesBound, false);
  assert.equal(byId.get('video_generation').status, 'needs_reverification');
  assert.equal(byId.get('video_generation').recordedEvidence.exactTaskHashReadback, true);
  assert.equal(byId.get('video_generation').recordedEvidence.artifactDownloadVerified, true);
  assert.equal(byId.get('video_generation').recordedEvidence.currentVideoDownloadSourceInstalled, false);
  assert.equal(byId.get('video_generation').recordedEvidence.currentNetworkVerified, false);
  assert.equal(byId.get('model_selection').status, 'needs_reverification');
  assert.equal(byId.get('model_selection').recordedEvidence.evidenceClass, 'historical_guarded_local_model_selection');
  assert.equal(byId.get('model_selection').recordedEvidence.catalogModelCount, 3);
  assert.equal(byId.get('model_selection').recordedEvidence.catalogBackedUiModelChoiceCount, 3);
  assert.equal(byId.get('model_selection').recordedEvidence.separateThinkingControlCount, 1);
  assert.equal(byId.get('model_selection').recordedEvidence.perModelQuotaEligibility, 'unknown');
  assert.equal(byId.get('model_selection').recordedEvidence.modeCategoryMapping, 'unresolved_for_catalog_rows');
  assert.equal(byId.get('model_selection').recordedEvidence.implementationHashesBound, false);
  assert.equal(byId.get('model_selection').recordedEvidence.currentNetworkVerified, false);
});

test('validates request-only batchexecute delete separately from a paired response contract', () => {
  const contractHash = 'a'.repeat(64);
  const codeHash = 'b'.repeat(64);
  const operation = {
    observation: { request: true, requestResponse: false },
    effect: 'mutation', retryPolicy: 'never',
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
      queryKeys: ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
      headerNames: ['content-type', 'referer', 'x-same-domain'],
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyFieldNames: ['f.req', 'at'],
      rpcId: 'GzXR5e', rpcArgsTemplate: ['{{conversationId}}'], rpcCallTail: [null, 'generic'],
    },
  };
  const pair = {
    schema: 'gemini-feature-pair-evidence-v1', service: SERVICE_ID,
    featureId: 'delete', operationId: 'delete', caseId: 'removed',
    contractSha256: contractHash, clientCodeSha256: codeHash,
    observedAt: '2026-10-06T12:00:00.000Z', executionHost: 'linux_worker',
    transport: 'direct_http', evidenceClass: 'direct_http_live', mocked: false, publicOnly: false,
    requestResponsePaired: false, authenticatedOwnerVerified: true, expectedOutcomeVerified: true,
    request: {
      method: 'POST', origin: SERVICE_ORIGIN, path: '/_/BardChatUi/data/batchexecute',
      queryKeys: [...operation.request.queryKeys], headerNames: [...operation.request.headerNames],
      bodyFieldNames: ['f.req', 'at'], contentType: operation.request.contentType,
      valuesPersisted: false, correlationId: 'c'.repeat(64), rpcId: 'GzXR5e',
      rpcArgsShape: { type: 'array', length: 1, items: [{ type: 'string', length: 18, conversationIdMatched: true }] },
      rpcCallTailShape: { type: 'array', length: 2, items: ['null', { type: 'string', length: 7 }] },
      conversationIdOccurrenceCount: 1,
    },
    response: { status: 200, contentType: 'application/json', bytes: 120, bodySha256: 'd'.repeat(64), framing: 'batchexecute' },
    directReplay: {
      evidenceType: 'request_only_batchexecute_mutation',
      sourceRpcMatched: true, rpcArgsBoundExactlyOnce: true,
      browserRequestAborted: true, browserResponseCount: 0,
      directDispatchCount: 1, retryCount: 0, requestBodyMatchesCapture: true,
      responseRpcDecoded: true, responseContractCaptured: false,
      ownerMatched: true, exactTaskReadbackVerified: true,
      targetAbsentFromOwnerHistory: true, targetAbsentFromSearch: true,
      journalReconciled: true,
    },
    secretsPersisted: false,
  };
  assert.equal(validateRequestOnlyBatchMutationEvidence(pair, { id: 'delete' }, 'delete', 'removed', operation, contractHash, codeHash), true);
  const paired = structuredClone(pair);
  paired.requestResponsePaired = true;
  assert.equal(validateRequestOnlyBatchMutationEvidence(paired, { id: 'delete' }, 'delete', 'removed', operation, contractHash, codeHash), false);
  const browserResponse = structuredClone(pair);
  browserResponse.directReplay.browserResponseCount = 1;
  assert.equal(validateRequestOnlyBatchMutationEvidence(browserResponse, { id: 'delete' }, 'delete', 'removed', operation, contractHash, codeHash), false);
});

test('model selection checker accepts only local state evidence whose prepared metadata exactly matches', () => {
  const modeId = 'e6fa609c3fa255c0';
  const contractSha256 = 'a'.repeat(64);
  const clientCodeSha256 = 'b'.repeat(64);
  const feature = { id: 'model_selection' };
  const selection = {
    schema: 'gemini-feature-local-control-evidence-v1',
    service: SERVICE_ID,
    featureId: 'model_selection',
    operationId: 'model_select',
    caseId: 'select',
    contractSha256,
    clientCodeSha256,
    observedAt: '2026-10-06T01:00:00.000Z',
    executionHost: 'linux_worker',
    transport: 'local_process',
    evidenceClass: 'local_control_live',
    mocked: false,
    publicOnly: false,
    authenticatedOwnerVerified: true,
    expectedOutcomeVerified: true,
    secretsPersisted: false,
    selectionCorrelationId: 'select-readback-001',
    selectedChoiceId: `model:${modeId}`,
    selectedModeId: modeId,
    modeCategory: null,
    thinkingLevel: 'THINKING_LEVEL_EXTENDED',
    preparedRequestMetadata: { modeId, thinkingLevel: 'THINKING_LEVEL_EXTENDED', isTemporaryChat: false },
    serverPreferenceWritePerformed: false,
    businessRequestDispatched: false,
    catalogModelIdMatched: true,
  };
  const readback = {
    ...selection,
    operationId: 'selection_state',
    caseId: 'selected',
    readbackOfOperation: 'model_select',
    readbackOfCaseId: 'select',
  };
  const binding = {
    writeOperation: 'model_select', writeCaseId: 'select',
    readOperation: 'selection_state', readCaseId: 'selected',
    bindingKind: 'local_control_state', correlationId: 'select-readback-001',
    sameOwner: true, stateCorrelationVerified: true, expectedStateVerified: true,
  };
  assert.equal(validateLocalModelControlEvidence(selection, feature, 'model_select', 'select', contractSha256, clientCodeSha256), true);
  assert.equal(validateLocalModelControlEvidence(readback, feature, 'selection_state', 'selected', contractSha256, clientCodeSha256), true);
  assert.equal(matchesLocalModelSelectionReadback(selection, readback, binding), true);
  const thinkingSelection = { ...selection, selectedChoiceId: 'thinking:thinking-level-extended' };
  const thinkingReadback = { ...readback, selectedChoiceId: 'thinking:thinking-level-extended' };
  assert.equal(validateLocalModelControlEvidence(thinkingSelection, feature, 'model_select', 'select', contractSha256, clientCodeSha256), true);
  assert.equal(matchesLocalModelSelectionReadback(thinkingSelection, thinkingReadback, binding), true);
  const proSelection = {
    ...selection,
    modeCategory: 'MODE_CATEGORY_PRO',
    preparedRequestMetadata: {
      modeId, modeCategory: 'MODE_CATEGORY_PRO', thinkingLevel: 'THINKING_LEVEL_EXTENDED', isTemporaryChat: false,
    },
  };
  const proReadback = { ...readback, ...proSelection, operationId: 'selection_state', caseId: 'selected',
    readbackOfOperation: 'model_select', readbackOfCaseId: 'select' };
  assert.equal(validateLocalModelControlEvidence(proSelection, feature, 'model_select', 'select', contractSha256, clientCodeSha256), true);
  assert.equal(validateLocalModelControlEvidence(proReadback, feature, 'selection_state', 'selected', contractSha256, clientCodeSha256), true);
  assert.equal(matchesLocalModelSelectionReadback(proSelection, proReadback, binding), true);
  assert.equal(matchesLocalModelSelectionReadback(selection, {
    ...readback,
    preparedRequestMetadata: { thinkingLevel: 'THINKING_LEVEL_EXTENDED', isTemporaryChat: false, modeId },
  }, binding), true);

  assert.equal(validateLocalModelControlEvidence({ ...readback,
    preparedRequestMetadata: { modeId: '8c46e95b1a07cecc', thinkingLevel: 'THINKING_LEVEL_EXTENDED', isTemporaryChat: false },
  }, feature, 'selection_state', 'selected', contractSha256, clientCodeSha256), false);
  assert.equal(validateLocalModelControlEvidence({ ...selection, serverPreferenceWritePerformed: true },
    feature, 'model_select', 'select', contractSha256, clientCodeSha256), false);
  assert.equal(matchesLocalModelSelectionReadback(selection, { ...readback, selectionCorrelationId: 'other-readback-001' }, binding), false);
});

test('a positive-looking receipt cannot complete a feature without an exported operation adapter', async () => {
  const setup = await fixture({ positive: true, mocked: true });
  try {
    const result = await auditGeminiFeatures({ root: setup.root });
    assert.equal(result.features[0].status, 'implementation_missing');
    assert.ok(result.features[0].reasons.some(reason => /operation-specific API adapter is not exported/.test(reason)));
    assert.equal(result.summary.strictPass, false);
  } finally {
    await setup.cleanup();
  }
});

test('unknown feature applicability remains a strict blocker until authenticated UI evidence resolves it', async () => {
  const setup = await fixture();
  try {
    const checklist = miniChecklist();
    checklist.features[0].applicability = 'unknown';
    await putJson(setup.root, 'discovery/feature-checklist.json', checklist);
    const result = await auditGeminiFeatures({ root: setup.root });
    assert.equal(result.features[0].status, 'applicability_unresolved');
    assert.equal(result.summary.strictPass, false);
  } finally {
    await setup.cleanup();
  }
});

test('mapped live receipts pass as stored evidence and expose their owner scope and timestamp', async () => {
  const setup = await mappedFixture();
  try {
    const result = await auditGeminiFeatures({ root: setup.root });
    assert.equal(result.schema, 'gemini-feature-audit-result-v1');
    assert.equal(result.executionMode, 'offline_filesystem_only');
    assert.equal(result.status, 'stored_receipt_consistent', JSON.stringify(result.features.map(item => ({ id: item.id, status: item.status, reasons: item.reasons }))));
    assert.equal(result.evidenceFreshness, 'recorded_receipts_only_current_network_not_checked');
    assert.equal(result.currentNetworkVerified, false);
    assert.equal(result.summary.strictPass, true);
    assert.ok(result.features.every(feature => feature.status === 'stored_receipt_consistent'));
    const login = result.features.find(feature => feature.id === 'login');
    assert.equal(login.recordedEvidence.evidenceScope, 'same_authenticated_owner');
    assert.equal(login.recordedEvidence.passwordSubmittedToProviderApi, false);
  } finally {
    await setup.cleanup();
  }
});

test('identity direct replay permits omitted optional browser hint headers but rejects unobserved headers', async () => {
  const accepted = await mappedFixture({ identityHeaderNames: [] });
  try {
    const result = await auditGeminiFeatures({ root: accepted.root });
    assert.equal(result.features.find((item) => item.id === 'identity').status, 'stored_receipt_consistent');
    assert.equal(result.features.find((item) => item.id === 'login').status, 'stored_receipt_consistent');
  } finally {
    await accepted.cleanup();
  }

  const rejected = await mappedFixture({ identityHeaderNames: ['x-unobserved'] });
  try {
    const result = await auditGeminiFeatures({ root: rejected.root });
    assert.equal(result.features.find((item) => item.id === 'identity').status, 'live_evidence_missing');
    assert.equal(result.features.find((item) => item.id === 'login').status, 'live_evidence_missing');
  } finally {
    await rejected.cleanup();
  }
});

test('historical scoped model evidence retains current handler drift after an unrelated CLI addition', async (t) => {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'gemini-scoped-canonicalization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const contract = JSON.parse(await readFile(path.join(repo, 'discovery/observed-contract.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(path.join(repo, 'verification/features/model_catalog.json'), 'utf8'));
  const modelPairPath = 'verification/feature-evidence/model_catalog--model_list--available.json';
  const identityPairPath = receipt.ownerIdentityEvidence.path;
  const modelPair = JSON.parse(await readFile(path.join(repo, modelPairPath), 'utf8'));
  const identityPair = JSON.parse(await readFile(path.join(repo, identityPairPath), 'utf8'));
  const feature = {
    id: 'model_catalog', title: 'Read the model catalog', applicability: 'required',
    basis: { kind: 'fixture', reference: 'scoped source receipt', note: 'Tests relevant operation binding.' },
    contractOperations: ['model_list'], requiredEffects: { model_list: 'read' },
    readbackOperations: [], requiresOwnerIdentity: true,
    ownerIdentityEvidenceCaseId: 'model_catalog_owner',
    receiptPath: 'verification/features/model_catalog.json',
    requiredOperationCases: [{ operation: 'model_list', caseId: 'available' }],
  };
  await putJson(root, 'discovery/feature-checklist.json', {
    schema: 'gemini-feature-checklist-v1', service: SERVICE_ID, origin: SERVICE_ORIGIN,
    policy: {
      ownerIdentityFeatureId: 'identity', ownerIdentityOperationId: 'identity',
      ownerIdentityOperationCaseId: 'owner', unknownApplicabilityBlocksStrict: true,
      publicStatusCanCompletePrivateFeature: false,
    },
    features: [feature],
  });
  contract.operations.history = structuredClone(contract.operations.history_list);
  await putJson(root, 'discovery/observed-contract.json', contract);
  await putJson(root, 'verification/features/model_catalog.json', receipt);
  await putJson(root, modelPairPath, modelPair);
  await putJson(root, identityPairPath, identityPair);

  const units = [
    ...receipt.sourceScope.implementationUnits,
    ...receipt.ownerIdentityEvidence.sourceScope.implementationUnits,
  ];
  for (const item of units) {
    const relative = item.path.split('#', 1)[0];
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(repo, relative)));
  }
  const cliPath = path.join(root, 'src/cli.mjs');
  const before = await auditGeminiFeatures({ root });
  const beforeModel = before.features.find((item) => item.id === 'model_catalog');
  assert.equal(beforeModel.status, 'needs_reverification');
  await writeFile(cliPath, `${await readFile(cliPath, 'utf8')}\nfunction unrelatedCliBranch() { return false; }\n`);

  const result = await auditGeminiFeatures({ root });
  assert.equal(result.features.find((item) => item.id === 'model_catalog').status, beforeModel.status);
});

test('a source code hash change invalidates a previously bound live receipt', async () => {
  const setup = await mappedFixture();
  try {
    const before = await auditGeminiFeatures({ root: setup.root });
    assert.equal(before.summary.strictPass, true);
    await writeFile(path.join(setup.root, 'src/client.mjs'), 'changed implementation bytes\n');
    const after = await auditGeminiFeatures({ root: setup.root });
    assert.ok(after.features.every(feature => feature.status === 'needs_reverification'));
    assert.equal(after.summary.strictPass, false);
  } finally {
    await setup.cleanup();
  }
});

test('feature checker options reject unsupported and repeated flags', () => {
  assert.deepEqual(parseFeatureAuditOptions(['--strict', '--json']), { strict: true, json: true });
  assert.throws(() => parseFeatureAuditOptions(['--network']), { code: 'FEATURE_AUDIT_ARGUMENT_INVALID' });
  assert.throws(() => parseFeatureAuditOptions(['--json', '--json']), { code: 'FEATURE_AUDIT_ARGUMENT_INVALID' });
  assert.equal(featureAuditExitCode({ summary: { strictPass: false } }, true), 2);
  assert.equal(featureAuditExitCode({ summary: { strictPass: false } }, false), 0);
});

test('strict offline output states that the current provider was not checked', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, ['scripts/check-features.mjs', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {},
  });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.currentNetworkVerified, false);
  assert.equal(report.evidenceFreshness, 'recorded_receipts_only_current_network_not_checked');
  assert.equal(report.networkRequests, 0);
});

test('a malformed checklist schema fails closed with the schema error code', async () => {
  const setup = await fixture();
  try {
    await putJson(setup.root, 'discovery/feature-checklist.json', { schema: 'wrong-version' });
    await assert.rejects(auditGeminiFeatures({ root: setup.root }), { code: 'FEATURE_AUDIT_SCHEMA_INVALID' });
  } finally {
    await setup.cleanup();
  }
});
