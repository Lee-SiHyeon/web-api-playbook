#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK_CACHE = path.join(os.homedir(), '.nad-scratch/provider-runtime-20261005/grok-fast-task-private-reference/verified-fast-task.json');
const RECEIPT = path.join(ROOT, 'verification/grok-fast-task-readonly-cli-live-2026-10-06-r7.json');
const OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const CACHE_MAX_BYTES = 16 * 1024;
const PACKET_MAX_BYTES = 1024 * 1024;
const CLI_MAX_BYTES = 20 * 1024 * 1024;
const CLI = path.join(ROOT, 'src/cli.mjs');
const PYTHON = '/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python';
const REQUIRED_READS = Object.freeze([
  'conversation.list.read',
  'conversation.read',
  'history.response-nodes',
  'history.load-responses',
]);
const CODE_FILES = Object.freeze([
  'src/cli.mjs',
  'src/runtime.mjs',
  'src/client.mjs',
  'src/transport.mjs',
  'src/contracts.mjs',
  'src/session.mjs',
  'src/protected-json-store.mjs',
  'src/grok-conversations.mjs',
  'src/authenticated-chrome-fetch.mjs',
  'scripts/authenticated-chrome-transport.py',
  'scripts/grok-fast-task-readonly-cli-once.mjs',
  'scripts/grok-fast-task-readonly-live-once.py',
]);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function scrub(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (typeof value[i] === 'string') value[i] = '';
      else scrub(value[i], seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else scrub(value[key], seen);
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function safeResponseShape(value, depth = 0) {
  if (depth > 8) return { type: Array.isArray(value) ? 'array' : typeof value };
  if (Array.isArray(value)) {
    const item = value.find(plainObject);
    return { type: 'array', count: value.length, itemFieldNames: item ? Object.keys(item).sort().slice(0, 80) : [] };
  }
  if (!plainObject(value)) return { type: value === null ? 'null' : typeof value };
  return {
    type: 'object',
    topLevelFieldNames: Object.keys(value).sort().slice(0, 128),
    fields: Object.fromEntries(Object.entries(value).slice(0, 128).map(([key, child]) => [
      key, Array.isArray(child) ? { type: 'array', count: child.length }
        : plainObject(child) ? { type: 'object', fieldNames: Object.keys(child).sort().slice(0, 80) }
          : { type: child === null ? 'null' : typeof child },
    ])),
  };
}
async function readPacket() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > PACKET_MAX_BYTES) throw Object.assign(new Error('PACKET_TOO_LARGE'), { code: 'FAST_READ_PACKET_TOO_LARGE' });
    chunks.push(bytes);
  }
  if (!size) throw Object.assign(new Error('PACKET_REQUIRED'), { code: 'FAST_READ_PACKET_REQUIRED' });
  const raw = Buffer.concat(chunks, size);
  let value;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('PACKET_INVALID'), { code: 'FAST_READ_PACKET_INVALID' }); }
  raw.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!plainObject(value) || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify(['sessionBundle', 'expectedIdentity', 'ownerBootstrap'].sort())
      || !plainObject(value.sessionBundle) || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
      || sha256(value.expectedIdentity.trim().toLowerCase()) !== OWNER_SHA256
      || !plainObject(value.ownerBootstrap) || value.ownerBootstrap.status !== 200
      || value.ownerBootstrap.method !== 'GET' || value.ownerBootstrap.path !== '/api/auth/session'
      || value.ownerBootstrap.contentType !== 'application/json'
      || !Number.isSafeInteger(value.ownerBootstrap.responseBytes) || value.ownerBootstrap.responseBytes < 1
      || value.ownerBootstrap.responseBytes > 16 * 1024 || !validDigest(value.ownerBootstrap.rawResponseDigest)
      || JSON.stringify(value.ownerBootstrap.cookieNames) !== JSON.stringify(['sso'])
      || value.ownerBootstrap.redirectsFollowed !== false) {
    scrub(value);
    throw Object.assign(new Error('PACKET_INVALID'), { code: 'FAST_READ_PACKET_INVALID' });
  }
  const bundle = value.sessionBundle;
  const origins = bundle.origins;
  if (bundle.schemaVersion !== 1 || bundle.serviceId !== 'grok-web' || bundle.origin !== 'https://grok.com'
      || !Array.isArray(origins) || origins.length !== 1 || origins[0]?.origin !== 'https://grok.com'
      || !Array.isArray(origins[0].cookies) || origins[0].cookies.length !== 1
      || origins[0].cookies[0]?.name !== 'sso' || origins[0].cookies[0]?.domain !== 'grok.com'
      || origins[0].cookies[0]?.path !== '/' || origins[0].cookies[0]?.secure !== true
      || typeof origins[0].cookies[0]?.value !== 'string' || !origins[0].cookies[0].value
      || !Array.isArray(origins[0].headers) || origins[0].headers.length !== 0) {
    scrub(value);
    throw Object.assign(new Error('SESSION_SCOPE_INVALID'), { code: 'FAST_READ_SESSION_SCOPE_INVALID' });
  }
  return value;
}

async function readTaskCache() {
  const stat = await lstat(TASK_CACHE).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > CACHE_MAX_BYTES) {
    throw Object.assign(new Error('TASK_CACHE_INVALID'), { code: 'FAST_TASK_CACHE_INVALID' });
  }
  const bytes = await readFile(TASK_CACHE);
  let cache;
  let cacheDigest;
  try {
    cache = JSON.parse(bytes.toString('utf8'));
    cacheDigest = sha256(bytes);
  } catch { throw Object.assign(new Error('TASK_CACHE_INVALID'), { code: 'FAST_TASK_CACHE_INVALID' }); }
  finally { bytes.fill(0); }
  if (!plainObject(cache) || cache.schemaVersion !== 1 || cache.serviceId !== 'grok-web'
      || cache.ownerScopeSha256 !== OWNER_SHA256 || typeof cache.conversationId !== 'string'
      || cache.conversationId.length < 16 || cache.conversationId.length > 512 || /[\r\n\0]/.test(cache.conversationId)
      || typeof cache.assistantResponseId !== 'string' || cache.assistantResponseId.length < 16
      || cache.assistantResponseId.length > 512 || /[\r\n\0]/.test(cache.assistantResponseId)
      || !validDigest(cache.expectedPromptSha256) || !validDigest(cache.assistantTextSha256)
      || typeof cache.verifiedAt !== 'string'
      || cache.verifiedBy !== 'conversation.read+history.response-nodes+history.load-responses') {
    scrub(cache);
    throw Object.assign(new Error('TASK_CACHE_INVALID'), { code: 'FAST_TASK_CACHE_INVALID' });
  }
  return { cache, cacheDigest };
}

async function sourceSnapshot() {
  const codeSha256 = {};
  for (const relative of CODE_FILES) {
    const bytes = await readFile(path.join(ROOT, relative));
    codeSha256[relative] = sha256(bytes);
    bytes.fill(0);
  }
  const registryBytes = await readFile(path.join(ROOT, 'contracts/grok-web.v1.json'));
  let registry;
  try { registry = JSON.parse(registryBytes.toString('utf8')); }
  finally { registryBytes.fill(0); }
  const identityOperationId = registry.identityOperationId;
  const operationIds = [identityOperationId, ...REQUIRED_READS];
  const contractOperationSha256 = {};
  for (const operationId of operationIds) {
    const operation = registry.operations.find(item => item.id === operationId);
    if (!operation) throw Object.assign(new Error('READ_OPERATION_SOURCE_MISSING'), { code: 'FAST_READ_SOURCE_OPERATION_MISSING' });
    contractOperationSha256[operationId] = sha256(Buffer.from(JSON.stringify(canonical(operation)), 'utf8'));
  }
  scrub(registry);
  return {
    capturedAt: new Date().toISOString(),
    identityOperationId,
    operationIds: [...REQUIRED_READS],
    codeSha256,
    contractOperationSha256,
  };
}

function childEnvironment() {
  const environment = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

async function runCli(subcommand, input, sessionBundle, expectedIdentity) {
  const child = spawn(process.execPath, [CLI, 'conversation', subcommand, '--session-stdin', '--output=json', '--python', PYTHON], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment(),
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60_000);
  const packet = { sessionBundle: structuredClone(sessionBundle), expectedIdentity, input };
  const wire = Buffer.from(JSON.stringify(packet), 'utf8');
  scrub(packet);
  child.stdout.on('data', chunk => {
    stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
    if (stdout.length > CLI_MAX_BYTES) child.kill('SIGKILL');
  });
  child.stderr.on('data', chunk => {
    stderr = Buffer.concat([stderr, Buffer.from(chunk)]);
    if (stderr.length > 16 * 1024) child.kill('SIGKILL');
  });
  child.stdin.on('error', () => {});
  child.stdin.end(wire, () => wire.fill(0));
  const exitCode = await new Promise(resolve => {
    child.once('error', () => resolve(-1));
    child.once('close', code => resolve(code ?? -1));
  }).finally(() => clearTimeout(timer));
  if (timedOut || stdout.length > CLI_MAX_BYTES) {
    stdout.fill(0);
    stderr.fill(0);
    throw Object.assign(new Error('CLI_READ_LIMIT'), { code: timedOut ? 'FAST_READ_CLI_TIMEOUT' : 'FAST_READ_CLI_OUTPUT_LIMIT' });
  }
  let output;
  try { output = JSON.parse(stdout.toString('utf8')); }
  catch {
    stdout.fill(0);
    let stderrOutput;
    try { stderrOutput = JSON.parse(stderr.toString('utf8')); } catch { stderrOutput = null; }
    stderr.fill(0);
    const code = typeof stderrOutput?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(stderrOutput.error.code)
      ? stderrOutput.error.code : 'FAST_READ_CLI_OUTPUT_INVALID';
    scrub(stderrOutput);
    throw Object.assign(new Error('CLI_READ_OUTPUT_INVALID'), { code });
  }
  stdout.fill(0);
  stderr.fill(0);
  if (exitCode !== 0 || !plainObject(output) || output.operationId === undefined || output.ownerVerified !== true) {
    const code = typeof output?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(output.error.code)
      ? output.error.code : 'FAST_READ_CLI_COMMAND_FAILED';
    scrub(output);
    throw Object.assign(new Error('CLI_READ_FAILED'), { code });
  }
  return output;
}

function safeHttpSummary(output) {
  const owner = plainObject(output.ownerIdentityRead) ? output.ownerIdentityRead : {};
  return {
    operationId: output.operationId,
    ownerVerified: output.ownerVerified === true,
    ownerIdentityRead: {
      status: Number.isInteger(owner.status) ? owner.status : null,
      contentType: typeof owner.contentType === 'string' ? owner.contentType : null,
      responseBytes: Number.isSafeInteger(owner.responseBytes) ? owner.responseBytes : null,
      requestDigest: validDigest(owner.requestDigest) ? owner.requestDigest : null,
      rawResponseDigest: validDigest(owner.rawResponseDigest) ? owner.rawResponseDigest : null,
      rawResponseDigestKind: owner.rawResponseDigestKind === 'raw_http_body' ? owner.rawResponseDigestKind : null,
      parsedResponseDigest: validDigest(owner.parsedResponseDigest) ? owner.parsedResponseDigest : null,
    },
    status: Number.isInteger(output.status) ? output.status : null,
    contentType: typeof output.contentType === 'string' ? output.contentType : null,
    responseBytes: Number.isSafeInteger(output.responseBytes) ? output.responseBytes : null,
    requestDigest: validDigest(output.requestDigest) ? output.requestDigest : null,
    rawResponseDigest: validDigest(output.rawResponseDigest) ? output.rawResponseDigest : null,
    rawResponseDigestKind: output.rawResponseDigestKind === 'raw_http_body' ? output.rawResponseDigestKind : null,
    parsedResponseDigest: validDigest(output.parsedResponseDigest) ? output.parsedResponseDigest : null,
    responseShape: output.responseShape ?? null,
  };
}

function hasRawHttpProof(summary) {
  const owner = summary?.ownerIdentityRead;
  return summary?.status === 200 && Number.isSafeInteger(summary.responseBytes)
    && validDigest(summary.requestDigest) && validDigest(summary.rawResponseDigest)
    && summary.rawResponseDigestKind === 'raw_http_body'
    && owner?.status === 200 && Number.isSafeInteger(owner.responseBytes)
    && validDigest(owner.requestDigest) && validDigest(owner.rawResponseDigest)
    && owner.rawResponseDigestKind === 'raw_http_body';
}

function senderKind(value) {
  const sender = typeof value === 'string' ? value.toLowerCase() : '';
  return sender === 'user' || sender === 'human' ? 'user'
    : sender === 'assistant' || sender === 'model' ? 'assistant' : 'other';
}

function scrubOutput(output) { scrub(output); }

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { await lstat(filePath); throw Object.assign(new Error('RECEIPT_EXISTS'), { code: 'FAST_READ_RECEIPT_EXISTS' }); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function main() {
  let packet;
  let cache;
  let outputs = [];
  const receipt = {
    schemaVersion: 1,
    serviceId: 'grok-web',
    operationId: 'conversation.history.fast-task-readback',
    recordedAt: new Date().toISOString(),
    status: 'needs_review',
    ownerVerified: false,
    sameAuthenticatedOwner: false,
    ownerScopeSha256: null,
    ownerBootstrap: null,
    privateTaskCacheVerified: false,
    task: null,
    reads: {},
    sourceSnapshot: { before: null, after: null, stable: false },
    persistenceAssertions: {
      rawConversationIdsPersisted: false,
      rawResponseIdsPersisted: false,
      rawTitlesPersisted: false,
      rawMessagesPersisted: false,
      rawRequestBodiesPersisted: false,
      rawResponseBodiesPersisted: false,
      credentialsPersisted: false,
    },
  };
  try {
    packet = await readPacket();
    const loaded = await readTaskCache();
    cache = loaded.cache;
    receipt.ownerScopeSha256 = cache.ownerScopeSha256;
    receipt.ownerBootstrap = { ...packet.ownerBootstrap, cookieNames: [...packet.ownerBootstrap.cookieNames] };
    receipt.privateTaskCacheVerified = true;
    receipt.task = {
      conversationIdSha256: sha256(cache.conversationId),
      assistantResponseIdSha256: sha256(cache.assistantResponseId),
      expectedPromptSha256: cache.expectedPromptSha256,
      expectedAssistantTextSha256: cache.assistantTextSha256,
      taskCacheSha256: loaded.cacheDigest,
    };
    receipt.sourceSnapshot.before = await sourceSnapshot();
    const identitySha = sha256(packet.expectedIdentity.trim().toLowerCase());
    if (identitySha !== cache.ownerScopeSha256 || identitySha !== OWNER_SHA256) {
      throw Object.assign(new Error('OWNER_CACHE_MISMATCH'), { code: 'FAST_READ_OWNER_CACHE_MISMATCH' });
    }

    const list = await runCli('list', { pageSize: 100 }, packet.sessionBundle, packet.expectedIdentity);
    outputs.push(list);
    const listRows = Array.isArray(list.data?.conversations) ? list.data.conversations : [];
    const listMatches = listRows.filter(row => row?.conversationId === cache.conversationId);
    receipt.reads.ownerAndList = safeHttpSummary(list);
    receipt.reads.ownerAndList.pageRows = listRows.length;
    receipt.reads.ownerAndList.exactTaskMatchCount = listMatches.length;
    receipt.reads.ownerAndList.nextPagePresent = typeof list.data?.nextPageToken === 'string' && list.data.nextPageToken.length > 0;
    receipt.ownerVerified = list.ownerVerified === true && list.ownerIdentityRead?.status === 200;
    receipt.sameAuthenticatedOwner = identitySha === OWNER_SHA256 && receipt.ownerVerified;

    const detail = await runCli('read', { conversationId: cache.conversationId }, packet.sessionBundle, packet.expectedIdentity);
    outputs.push(detail);
    const record = plainObject(detail.data?.conversation) ? detail.data.conversation : detail.data;
    receipt.reads.detail = safeHttpSummary(detail);
    receipt.reads.detail.conversationIdMatched = record?.conversationId === cache.conversationId;
    receipt.reads.detail.viewerIsOwner = record?.viewerIsOwner === true;
    receipt.reads.detail.readonly = record?.isReadonly === true;
    receipt.reads.detail.accessLevelOwner = record?.accessLevel === undefined || record?.accessLevel === 'OWNER';

    const nodesResult = await runCli('nodes', { conversationId: cache.conversationId }, packet.sessionBundle, packet.expectedIdentity);
    outputs.push(nodesResult);
    const nodes = Array.isArray(nodesResult.data?.responseNodes) ? nodesResult.data.responseNodes : [];
    const inflight = Array.isArray(nodesResult.data?.inflightResponses) ? nodesResult.data.inflightResponses : [];
    const exactAssistantNodes = nodes.filter(node => node?.responseId === cache.assistantResponseId
      && senderKind(node?.sender) === 'assistant');
    const taskUserNodes = nodes.filter(node => senderKind(node?.sender) === 'user');
    const assistantParentId = exactAssistantNodes.length === 1
      && typeof exactAssistantNodes[0].parentResponseId === 'string' ? exactAssistantNodes[0].parentResponseId : null;
    const exactUserNodes = assistantParentId
      ? taskUserNodes.filter(node => node.responseId === assistantParentId) : [];
    receipt.reads.responseNodes = safeHttpSummary(nodesResult);
    receipt.reads.responseNodes.nodeCount = nodes.length;
    receipt.reads.responseNodes.inflightCount = inflight.length;
    receipt.reads.responseNodes.userNodeCount = taskUserNodes.length;
    receipt.reads.responseNodes.assistantNodeCount = nodes.filter(node => senderKind(node?.sender) === 'assistant').length;
    receipt.reads.responseNodes.cachedAssistantNodeCount = exactAssistantNodes.length;
    receipt.reads.responseNodes.parentUserNodeCount = exactUserNodes.length;
    receipt.reads.responseNodes.userNodeIdSha256 = taskUserNodes.length === 1 && typeof taskUserNodes[0].responseId === 'string'
      ? sha256(taskUserNodes[0].responseId) : null;
    receipt.reads.responseNodes.assistantNodeParentResponseIdSha256 = assistantParentId ? sha256(assistantParentId) : null;
    receipt.reads.responseNodes.assistantNodeParentFieldType = exactAssistantNodes.length === 1
      ? exactAssistantNodes[0].parentResponseId === null ? 'null'
        : typeof exactAssistantNodes[0].parentResponseId === 'string' ? 'string' : 'missing'
      : null;
    receipt.reads.responseNodes.parentBindingObserved = exactUserNodes.length === 1;

    if (exactAssistantNodes.length === 1 && taskUserNodes.length === 1
        && typeof taskUserNodes[0].responseId === 'string') {
      const userId = taskUserNodes[0].responseId;
      const loaded = await runCli('load', {
        conversationId: cache.conversationId,
        responseIds: [userId, cache.assistantResponseId],
      }, packet.sessionBundle, packet.expectedIdentity);
      outputs.push(loaded);
      const responses = Array.isArray(loaded.data?.responses) ? loaded.data.responses : [];
      const user = responses.find(row => row?.responseId === userId && senderKind(row?.sender) === 'user');
      const assistant = responses.find(row => row?.responseId === cache.assistantResponseId
        && senderKind(row?.sender) === 'assistant');
      const loadedIdSetMatches = responses.length === 2
        && new Set(responses.map(row => row?.responseId)).size === 2
        && responses.every(row => [userId, cache.assistantResponseId].includes(row?.responseId));
      const userText = typeof user?.message === 'string' ? user.message : null;
      const assistantText = typeof assistant?.message === 'string' ? assistant.message : null;
      const nodeParentId = typeof exactAssistantNodes[0].parentResponseId === 'string'
        ? exactAssistantNodes[0].parentResponseId : null;
      const loadedParentId = typeof assistant?.parentResponseId === 'string' ? assistant.parentResponseId : null;
      const parentRelationshipStatus = nodeParentId && loadedParentId && nodeParentId !== loadedParentId
        ? 'mismatch' : (loadedParentId ?? nodeParentId) === userId
          ? 'matched' : (loadedParentId ?? nodeParentId) === null ? 'not_observed' : 'mismatch';
      receipt.reads.loadResponses = safeHttpSummary(loaded);
      receipt.reads.loadResponses.responseCount = responses.length;
      receipt.reads.loadResponses.exactRequestedIdSetMatched = loadedIdSetMatches;
      receipt.reads.loadResponses.exactPromptHashMatched = userText !== null
        && sha256(userText) === cache.expectedPromptSha256;
      receipt.reads.loadResponses.exactAssistantHashMatched = assistantText !== null
        && sha256(assistantText) === cache.assistantTextSha256;
      receipt.reads.loadResponses.userResponseIdSha256 = sha256(userId);
      receipt.reads.loadResponses.assistantResponseIdSha256 = sha256(cache.assistantResponseId);
      receipt.reads.loadResponses.assistantParentFieldType = assistant
        ? assistant.parentResponseId === null ? 'null'
          : typeof assistant.parentResponseId === 'string' ? 'string' : 'missing'
        : 'assistant_missing';
      receipt.reads.loadResponses.assistantParentRelationship = parentRelationshipStatus;
      receipt.reads.loadResponses.assistantParentMatched = parentRelationshipStatus === 'matched';
      const listedTarget = listMatches[0];
      const rawSearchQuery = typeof record?.title === 'string' && record.title.trim()
        ? record.title : typeof listedTarget?.title === 'string' ? listedTarget.title : userText;
      const searchQuery = typeof rawSearchQuery === 'string'
        ? rawSearchQuery.trim().replace(/\s+/g, ' ').slice(0, 512) : '';
      if (!searchQuery || /[\r\n\0]/.test(searchQuery)) {
        receipt.reads.listVariants = { status: 'needs_review', reason: 'exact_task_search_query_unavailable' };
      } else {
        const pagePair = await runCli('list-pages', { pageSize: 20 }, packet.sessionBundle, packet.expectedIdentity);
        outputs.push(pagePair);
        const pairVariants = Array.isArray(pagePair.readVariants) ? pagePair.readVariants : [];
        const firstFields = pairVariants[0] ?? null;
        const nextFields = pairVariants[1] ?? null;
        const searchVariantResult = await runCli('search', { pageSize: 10, searchQuery }, packet.sessionBundle, packet.expectedIdentity);
        outputs.push(searchVariantResult);
        const searchFields = safeHttpSummary(searchVariantResult);
        const searchRows = Array.isArray(searchVariantResult.data?.conversations)
          ? searchVariantResult.data.conversations : [];
        const textSearchMatches = Array.isArray(searchVariantResult.data?.textSearchMatches)
          ? searchVariantResult.data.textSearchMatches : [];
        const toVariant = (name, summary, requestFieldNames, conversationCount, nextPageTokenPresent, extra = {}) => ({
          name,
          requestDigest: summary?.requestDigest ?? null,
          responseDigest: summary?.rawResponseDigest ?? null,
          httpStatus: summary?.status ?? null,
          responseBytes: summary?.responseBytes ?? null,
          requestFieldNames,
          conversationCount,
          nextPageTokenPresent,
          ...extra,
        });
        receipt.reads.listVariants = {
          status: 'captured',
          variants: [
            toVariant('first_page', firstFields, ['pageSize'], firstFields?.conversationCount ?? 0,
              firstFields?.nextPageTokenPresent === true),
            toVariant('next_page', nextFields, ['pageSize', 'pageToken'], nextFields?.conversationCount ?? 0,
              nextFields?.nextPageTokenPresent === true),
            toVariant('search', searchFields, ['pageSize', 'searchQuery'], searchRows.length,
              typeof searchVariantResult.data?.nextPageToken === 'string' && searchVariantResult.data.nextPageToken.length > 0, {
                searchQuerySha256: sha256(searchQuery),
                textSearchMatchCount: textSearchMatches.length,
                targetConversationMatched: searchRows.some(row => row?.conversationId === cache.conversationId),
              }),
          ],
          exactTaskSearchMatched: searchRows.some(row => row?.conversationId === cache.conversationId),
        };
      }
    } else {
      receipt.reads.loadResponses = { status: null, skippedReason: 'unique_user_and_cached_assistant_nodes_not_bound' };
    }

    receipt.sourceSnapshot.after = await sourceSnapshot();
    receipt.sourceSnapshot.stable = JSON.stringify(receipt.sourceSnapshot.before.codeSha256)
      === JSON.stringify(receipt.sourceSnapshot.after.codeSha256)
      && JSON.stringify(receipt.sourceSnapshot.before.contractOperationSha256)
        === JSON.stringify(receipt.sourceSnapshot.after.contractOperationSha256);
    const proofComplete = receipt.ownerVerified && receipt.sameAuthenticatedOwner
      && hasRawHttpProof(receipt.reads.ownerAndList)
      && receipt.reads.ownerAndList.status === 200 && receipt.reads.ownerAndList.exactTaskMatchCount === 1
      && hasRawHttpProof(receipt.reads.detail)
      && receipt.reads.detail.status === 200 && receipt.reads.detail.conversationIdMatched
      && receipt.reads.detail.viewerIsOwner && !receipt.reads.detail.readonly && receipt.reads.detail.accessLevelOwner
      && hasRawHttpProof(receipt.reads.responseNodes)
      && receipt.reads.responseNodes.status === 200 && receipt.reads.responseNodes.inflightCount === 0
      && receipt.reads.responseNodes.cachedAssistantNodeCount === 1
      && hasRawHttpProof(receipt.reads.loadResponses)
      && receipt.reads.loadResponses.status === 200 && receipt.reads.loadResponses.exactRequestedIdSetMatched
      && receipt.reads.loadResponses.exactPromptHashMatched && receipt.reads.loadResponses.exactAssistantHashMatched
      && receipt.reads.loadResponses.assistantParentRelationship !== 'mismatch'
      && receipt.reads.listVariants?.status === 'captured'
      && receipt.reads.listVariants.variants?.length === 3
      && receipt.reads.listVariants.variants.every(variant => variant.httpStatus === 200
        && validDigest(variant.requestDigest) && validDigest(variant.responseDigest)
        && Number.isSafeInteger(variant.responseBytes))
      && receipt.reads.listVariants.variants[0].nextPageTokenPresent === true
      && receipt.reads.listVariants.variants[2].targetConversationMatched === true
      && receipt.reads.listVariants.variants[2].textSearchMatchCount > 0
      && receipt.sourceSnapshot.stable;
    receipt.status = proofComplete ? 'completed' : 'needs_review';
    receipt.recordedAt = new Date().toISOString();
    await atomicJson(RECEIPT, receipt);
    process.stdout.write(JSON.stringify({
      operationId: receipt.operationId,
      status: receipt.status,
      ownerVerified: receipt.ownerVerified,
      exactTaskMatchCount: receipt.reads.ownerAndList.exactTaskMatchCount,
      detailStatus: receipt.reads.detail.status,
      responseNodesStatus: receipt.reads.responseNodes.status,
      responseNodeCount: receipt.reads.responseNodes.nodeCount,
      loadResponsesStatus: receipt.reads.loadResponses.status ?? null,
      exactPromptHashMatched: receipt.reads.loadResponses.exactPromptHashMatched === true,
      exactAssistantHashMatched: receipt.reads.loadResponses.exactAssistantHashMatched === true,
      parentBinding: receipt.reads.loadResponses.assistantParentRelationship ?? 'unavailable',
      listVariantsCaptured: receipt.reads.listVariants?.status === 'captured',
      searchTargetMatched: receipt.reads.listVariants?.exactTaskSearchMatched === true,
      sourceSnapshotStable: receipt.sourceSnapshot.stable,
      receiptPath: path.relative(ROOT, RECEIPT).split(path.sep).join('/'),
      rawIdentifiersPersisted: false,
      rawMessagesPersisted: false,
      rawBodiesPersisted: false,
    }) + '\n');
  } finally {
    for (const output of outputs) scrubOutput(output);
    if (packet) scrub(packet);
    if (cache) scrub(cache);
  }
}

main().catch(async error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
    ? error.code : 'FAST_READ_FAILED';
  process.stdout.write(JSON.stringify({ operationId: 'conversation.history.fast-task-readback',
    status: 'needs_review', errorCode: code, rawIdentifiersPersisted: false, rawMessagesPersisted: false }) + '\n');
  process.exitCode = 1;
});
