#!/usr/bin/env node
import { chmod, mkdir, lstat, open, readFile, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { GrokWebClient, loadContractRegistry, readinessMatrix } from './client.mjs';
import { publicError } from './errors.mjs';
import { fetchPublicModels } from './public-models.mjs';
import { receiveOneEncryptedSession } from './bootstrap-receive.mjs';
import { createChromeCompatibleFetch } from './chrome-http-fetch.mjs';
import { createInMemoryGrokAttachmentRuntime, createInMemoryGrokConversationRuntime, createInMemoryGrokModelSelectionRuntime, createInMemoryGrokRuntime, createInMemoryGrokWorkspaceRuntime } from './runtime.mjs';
import { createInMemoryGrokAttachmentChatRuntime } from './grok-attachment-chat-runtime.mjs';
import { GROK_WORKSPACE_OPERATION_IDS } from './grok-workspaces.mjs';
import { GROK_CONVERSATION_OPERATION_IDS, GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS } from './grok-conversations.mjs';
import { createGrokConversationRestoreClient, GROK_CONVERSATION_RESTORE_OPERATION_IDS,
  GROK_CONVERSATION_RESTORE_SOURCE_PERMITS } from './grok-conversation-restore.mjs';
import { createGrokConversationFilesClient } from './grok-conversation-files.mjs';
import { createInMemoryGrokConversationFilesRuntime } from './grok-conversation-files-runtime.mjs';
import { GROK_CONVERSATION_WSS_OPERATION_ID, submitGrokConversationRegenerationWssOnce } from './grok-conversation-wss.mjs';
import { GROK_MODEL_MODE_OPERATION_ID } from './grok-model-selection.mjs';
import { submitGrokTextInSelectedMode } from './grok-mode-selected-text.mjs';
import { submitCapturedGrokTextOnce } from './grok-text-websocket.mjs';
import { createGrokMediaApi } from './grok-media-api.mjs';
import { submitGrokImagineImage, submitProvisionalCapturedGrokVideoOnce, reconcileUnknownGrokVideoOnce } from './grok-media-operations.mjs';
import { GrokMediaIntentJournal } from './grok-media-intent.mjs';
import { createGrokCffiAssetReader, validateGrokAssetRequestContext } from './grok-media-asset-reader.mjs';
import { createGrokCffiVideoFetch } from './grok-media-video-transport.mjs';
import { createRequestDigest } from './transport.mjs';
import { readMp4DurationFromFile } from './mp4-duration.mjs';
import { persistGrokAttachmentApiAudit } from './attachment-audit-store.mjs';
import { MAX_NATIVE_DIRECT_UPLOAD_BYTES, MAX_NATIVE_UPLOAD_FILE_BYTES } from './grok-attachment-constants.mjs';

const MAX_STDIN_BYTES = 256 * 1024;
const MAX_CAPTURED_FRAME_STDIN_BYTES = 8 * 1024 * 1024;
const MAX_PRIVATE_JSON_OUTPUT_BYTES = 8 * 1024 * 1024;
const GROK_ATTACHMENT_CHAT_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const GROK_RETAINED_ATTACHMENT = Object.freeze({
  fileName: 'codex-attachment-retain-20261007.txt',
  mimeType: 'text/plain',
  bytes: 20,
  sha256: 'ea16634bdedacb0115b413cdb78cc31b7fcbd04bd15b80e0a49c9e52195bbf3f',
  artifactPath: path.join(homedir(), 'artifacts', 'grok-attachments-20261006', 'grok-retained-20b-api-readback-20261006.bin'),
});
const SECRET_RESPONSE_FIELD = /(?:cookie|token|secret|auth|session|password|credential|signature|nonce|email|user.?id|conversation.?id|response.?id|asset.?id|task.?id|job.?id|(?:signed)?url|uri|href|(?:^|[_-])id$)/i;
const CALLER_CHAIN_RESOURCE_ID_FIELD = /^(?:conversation|response|asset|upload|task|job|workspace|shareLink)Id$/i;

async function readStdinJson(maxBytes = MAX_STDIN_BYTES) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      size += bytes.length;
      if (size > maxBytes) throw Object.assign(new Error('INPUT_TOO_LARGE'), { code: 'CLI_INPUT_TOO_LARGE' });
    }
    const bytes = Buffer.concat(chunks, size);
    try {
      return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes };
    } catch {
      bytes.fill(0);
      throw Object.assign(new Error('JSON_INVALID'), { code: 'CLI_JSON_INVALID' });
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeResponseShape(value, depth = 0) {
  if (depth > 8) return { type: Array.isArray(value) ? 'array' : typeof value };
  if (Array.isArray(value)) {
    const item = value.find(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
    return { type: 'array', count: value.length, itemFieldNames: item ? Object.keys(item).sort().slice(0, 100) : [] };
  }
  if (!value || typeof value !== 'object') return { type: value === null ? 'null' : typeof value };
  const fields = {};
  for (const [key, child] of Object.entries(value).slice(0, 200)) {
    if (Array.isArray(child)) fields[key] = { type: 'array', count: child.length,
      itemFieldNames: child.find(item => item && typeof item === 'object' && !Array.isArray(item))
        ? Object.keys(child.find(item => item && typeof item === 'object' && !Array.isArray(item))).sort().slice(0, 100) : [] };
    else if (child && typeof child === 'object') fields[key] = { type: 'object', fieldNames: Object.keys(child).sort().slice(0, 100) };
    else fields[key] = { type: child === null ? 'null' : typeof child };
  }
  return { type: 'object', topLevelFieldNames: Object.keys(value).sort().slice(0, 200), fields };
}

function safeBusinessData(value, depth = 0) {
  if (depth > 32) throw Object.assign(new Error('OUTPUT_DEPTH_LIMIT'), { code: 'CLI_OUTPUT_DEPTH_LIMIT' });
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw Object.assign(new Error('OUTPUT_ARRAY_LIMIT'), { code: 'CLI_OUTPUT_SIZE_LIMIT' });
    return value.map(item => safeBusinessData(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_RESPONSE_FIELD.test(key) && !CALLER_CHAIN_RESOURCE_ID_FIELD.test(key)) continue;
    output[key] = safeBusinessData(child, depth + 1);
  }
  return output;
}

function parseModelsOptions(args) {
  let transport = 'node';
  let pythonExecutable;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--transport' && (args[index + 1] === 'node' || args[index + 1] === 'chrome')) {
      transport = args[++index];
    } else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) {
      pythonExecutable = args[++index];
    } else {
      throw Object.assign(new Error('MODELS_OPTIONS_INVALID'), { code: 'CLI_MODELS_OPTIONS_INVALID' });
    }
  }
  if (transport !== 'chrome' && pythonExecutable !== undefined) {
    throw Object.assign(new Error('MODELS_OPTIONS_INVALID'), { code: 'CLI_MODELS_OPTIONS_INVALID' });
  }
  if (transport === 'chrome') {
    pythonExecutable ??= process.env.GROK_CHROME_PYTHON;
    if (typeof pythonExecutable !== 'string' || !pythonExecutable.trim()) {
      throw Object.assign(new Error('CHROME_PYTHON_REQUIRED'), { code: 'CHROME_PYTHON_REQUIRED' });
    }
  }
  return { transport, pythonExecutable };
}

function parsePrivateCommandOptions(args, command) {
  const options = { sessionStdin: false, confirm: false, intentId: null, pythonExecutable: undefined, output: 'summary' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm' && command === 'submit') options.confirm = true;
    else if (flag === '--intent-id' && command === 'submit' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (command === 'read' && (flag === '--include-content' || flag === '--output=json')) options.output = 'json';
    else if (command === 'read' && flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index++; }
    else throw Object.assign(new Error('PRIVATE_COMMAND_OPTIONS_INVALID'), { code: 'CLI_PRIVATE_OPTIONS_INVALID' });
  }
  if (command === 'submit' && (!options.sessionStdin || !options.confirm || !options.intentId?.trim())) {
    throw Object.assign(new Error('PRIVATE_SUBMIT_OPTIONS_REQUIRED'), { code: 'CLI_PRIVATE_SUBMIT_OPTIONS_REQUIRED' });
  }
  if (command === 'read' && (options.confirm || options.intentId)) {
    throw Object.assign(new Error('PRIVATE_READ_OPTIONS_INVALID'), { code: 'CLI_PRIVATE_OPTIONS_INVALID' });
  }
  return options;
}

function parseTextWssOptions(args) {
  const options = { sessionStdin: false, confirm: false, intentId: null, expectedResponse: undefined,
    pythonExecutable: undefined, websocketPythonExecutable: undefined, output: 'summary' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm') options.confirm = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--expected-response' && typeof args[index + 1] === 'string') options.expectedResponse = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--websocket-python' && typeof args[index + 1] === 'string' && args[index + 1]) options.websocketPythonExecutable = args[++index];
    else if (flag === '--include-content' || flag === '--output=json') options.output = 'json';
    else if (flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index++; }
    else throw Object.assign(new Error('TEXT_WSS_OPTIONS_INVALID'), { code: 'CLI_TEXT_WSS_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin || !options.confirm || !options.intentId?.trim()) {
    throw Object.assign(new Error('TEXT_WSS_OPTIONS_REQUIRED'), { code: 'CLI_TEXT_WSS_OPTIONS_REQUIRED' });
  }
  return options;
}

function parseMediaImageOptions(args) {
  const options = { sessionStdin: false, confirm: false, intentId: null, pythonExecutable: undefined, output: 'summary' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm') options.confirm = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--include-content' || flag === '--output=json') options.output = 'json';
    else if (flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index++; }
    else throw Object.assign(new Error('MEDIA_IMAGE_OPTIONS_INVALID'), { code: 'CLI_MEDIA_IMAGE_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin || !options.confirm || !options.intentId?.trim()) {
    throw Object.assign(new Error('MEDIA_IMAGE_OPTIONS_REQUIRED'), { code: 'CLI_MEDIA_IMAGE_OPTIONS_REQUIRED' });
  }
  return options;
}

function parseMediaVideoOptions(args) {
  const options = { sessionStdin: false, confirm: false, intentId: null, pythonExecutable: undefined, output: 'summary' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm') options.confirm = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--output=json') options.output = 'json';
    else if (flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index++; }
    else throw Object.assign(new Error('MEDIA_VIDEO_OPTIONS_INVALID'), { code: 'CLI_MEDIA_VIDEO_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin || !options.confirm || !options.intentId?.trim()) {
    throw Object.assign(new Error('MEDIA_VIDEO_OPTIONS_REQUIRED'), { code: 'CLI_MEDIA_VIDEO_OPTIONS_REQUIRED' });
  }
  return options;
}

function parseMediaVideoReconcileOptions(args) {
  const options = { sessionStdin: false, intentId: null, pythonExecutable: undefined };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else throw Object.assign(new Error('MEDIA_RECONCILE_OPTIONS_INVALID'), { code: 'CLI_MEDIA_RECONCILE_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin || !options.intentId?.trim()) {
    throw Object.assign(new Error('MEDIA_RECONCILE_OPTIONS_REQUIRED'), { code: 'CLI_MEDIA_RECONCILE_OPTIONS_REQUIRED' });
  }
  return options;
}

function parseMediaIntentPrepareOptions(args) {
  const options = { sessionStdin: false, pythonExecutable: undefined };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else throw Object.assign(new Error('MEDIA_INTENT_OPTIONS_INVALID'), { code: 'CLI_MEDIA_INTENT_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin) throw Object.assign(new Error('MEDIA_INTENT_SESSION_REQUIRED'), { code: 'CLI_MEDIA_INTENT_SESSION_REQUIRED' });
  return options;
}

function parseAttachmentUploadOptions(args) {
  const options = { sessionStdin: false, confirm: false, intentId: null, pythonExecutable: undefined, cleanupTaskAsset: false, output: 'summary' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm') options.confirm = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--cleanup-task-asset' && !options.cleanupTaskAsset) options.cleanupTaskAsset = true;
    else if (flag === '--output=json') options.output = 'json';
    else if (flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index++; }
    else throw Object.assign(new Error('ATTACHMENT_UPLOAD_OPTIONS_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin || !options.confirm || !options.intentId?.trim()) {
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_OPTIONS_REQUIRED'), { code: 'CLI_ATTACHMENT_UPLOAD_OPTIONS_REQUIRED' });
  }
  return options;
}

function parseAttachmentChatOptions(args) {
  const options = { sessionStdin: false, confirm: false, intentId: null, pythonExecutable: undefined,
    websocketPythonExecutable: undefined };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm') options.confirm = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--websocket-python' && typeof args[index + 1] === 'string' && args[index + 1]) options.websocketPythonExecutable = args[++index];
    else throw Object.assign(new Error('ATTACHMENT_CHAT_OPTIONS_INVALID'), { code: 'CLI_ATTACHMENT_CHAT_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin || !options.confirm || !options.intentId?.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.intentId)) {
    throw Object.assign(new Error('ATTACHMENT_CHAT_OPTIONS_REQUIRED'), { code: 'CLI_ATTACHMENT_CHAT_OPTIONS_REQUIRED' });
  }
  return options;
}

async function validateAttachmentChatPacket(value) {
  const allowed = new Set(['sessionBundle', 'expectedIdentity', 'expectedOwnerIdentityDigest', 'sourcePageRole', 'capture',
    'conversationId', 'fileName', 'fileMimeType', 'expectedFileBytes', 'expectedFileSha256', 'prompt', 'expectedAssistantText']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))
    || Object.keys(value).length !== allowed.size
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim() || value.expectedIdentity.length > 512
    || /[\r\n\0]/.test(value.expectedIdentity)
    || value.expectedOwnerIdentityDigest !== GROK_ATTACHMENT_CHAT_OWNER_SHA256
    || value.sourcePageRole !== 'codex-grok-attachment-chat-20261006'
    || !value.capture || typeof value.capture !== 'object' || Array.isArray(value.capture)
    || value.capture.sourcePageRole !== value.sourcePageRole
    || typeof value.conversationId !== 'string' || value.conversationId.length < 16 || value.conversationId.length > 512
    || /[\r\n\0]/.test(value.conversationId)
    || value.fileName !== GROK_RETAINED_ATTACHMENT.fileName || value.fileMimeType !== GROK_RETAINED_ATTACHMENT.mimeType
    || value.expectedFileBytes !== GROK_RETAINED_ATTACHMENT.bytes || value.expectedFileSha256 !== GROK_RETAINED_ATTACHMENT.sha256
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4_000 || /[\r\n\0]/.test(value.prompt)
    || typeof value.expectedAssistantText !== 'string' || !value.expectedAssistantText.trim()
    || Buffer.byteLength(`${value.expectedAssistantText}\n`, 'utf8') !== GROK_RETAINED_ATTACHMENT.bytes
    || createHash('sha256').update(`${value.expectedAssistantText}\n`, 'utf8').digest('hex') !== GROK_RETAINED_ATTACHMENT.sha256) {
    throw Object.assign(new Error('ATTACHMENT_CHAT_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_CHAT_PACKET_INVALID' });
  }
  const origins = value.sessionBundle.origins;
  if (value.sessionBundle.schemaVersion !== 1 || value.sessionBundle.serviceId !== 'grok-web'
    || value.sessionBundle.origin !== 'https://grok.com' || !Array.isArray(origins) || origins.length !== 1
    || origins[0]?.origin !== 'https://grok.com' || !Array.isArray(origins[0].cookies) || origins[0].cookies.length !== 1
    || origins[0].cookies[0]?.name !== 'sso' || !Array.isArray(origins[0].headers) || origins[0].headers.length !== 0) {
    throw Object.assign(new Error('ATTACHMENT_CHAT_SESSION_SCOPE_INVALID'), { code: 'CLI_ATTACHMENT_CHAT_SESSION_SCOPE_INVALID' });
  }
  const stat = await lstat(GROK_RETAINED_ATTACHMENT.artifactPath).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || (stat.mode & 0o022) !== 0 || stat.size !== GROK_RETAINED_ATTACHMENT.bytes) {
    throw Object.assign(new Error('RETAINED_ATTACHMENT_FILE_PROOF_INVALID'), { code: 'CLI_RETAINED_ATTACHMENT_FILE_INVALID' });
  }
  const fileBytes = await readFile(GROK_RETAINED_ATTACHMENT.artifactPath);
  try {
    if (fileBytes.length !== GROK_RETAINED_ATTACHMENT.bytes
      || createHash('sha256').update(fileBytes).digest('hex') !== GROK_RETAINED_ATTACHMENT.sha256) {
      throw Object.assign(new Error('RETAINED_ATTACHMENT_FILE_PROOF_INVALID'), { code: 'CLI_RETAINED_ATTACHMENT_FILE_INVALID' });
    }
    const expected = new TextDecoder('utf-8', { fatal: true }).decode(fileBytes)
      .replace(/(?:\r\n|\r|\n)$/, '');
    if (expected !== value.expectedAssistantText) {
      throw Object.assign(new Error('RETAINED_ATTACHMENT_EXPECTED_TEXT_MISMATCH'), { code: 'CLI_RETAINED_ATTACHMENT_TEXT_MISMATCH' });
    }
  } finally { fileBytes.fill(0); }
  return value;
}

function parseUploadReferenceOptions(args, mutating) {
  const options = { sessionStdin: false, referenceKey: null, confirm: false, intentId: null, pythonExecutable: undefined };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--reference-key' && args[index + 1]) options.referenceKey = args[++index];
    else if (flag === '--python' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--intent-id' && args[index + 1]) options.intentId = args[++index];
    else if (flag === '--confirm') options.confirm = true;
    else throw Object.assign(new Error('UPLOAD_REFERENCE_OPTIONS_INVALID'), { code: 'CLI_UPLOAD_REFERENCE_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin || !options.referenceKey || mutating && (!options.confirm || !options.intentId)) {
    throw Object.assign(new Error('UPLOAD_REFERENCE_OPTIONS_REQUIRED'), { code: 'CLI_UPLOAD_REFERENCE_OPTIONS_REQUIRED' });
  }
  return options;
}

function validateAttachmentUploadPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['directUploadMaxSizeBytes', 'maxUploadFileSizeBytes'])
    || !Number.isSafeInteger(value.directUploadMaxSizeBytes) || value.directUploadMaxSizeBytes < 1
    || value.directUploadMaxSizeBytes > MAX_NATIVE_DIRECT_UPLOAD_BYTES
    || !Number.isSafeInteger(value.maxUploadFileSizeBytes)
    || value.maxUploadFileSizeBytes < value.directUploadMaxSizeBytes
    || value.maxUploadFileSizeBytes > MAX_NATIVE_UPLOAD_FILE_BYTES) {
    throw Object.assign(new Error('ATTACHMENT_NATIVE_UPLOAD_POLICY_INVALID'), { code: 'CLI_ATTACHMENT_NATIVE_POLICY_INVALID' });
  }
  return Object.freeze({
    directUploadMaxSizeBytes: value.directUploadMaxSizeBytes,
    maxUploadFileSizeBytes: value.maxUploadFileSizeBytes,
  });
}

async function readHomeAttachmentFile(filePath, policy) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.length > 4096 || /[\r\n\0]/.test(filePath)) {
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
  }
  const userRoot = path.resolve(homedir());
  let pathInfo;
  try { pathInfo = await lstat(filePath); } catch {
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
  }
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) {
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
  }
  let resolved;
  try { resolved = await realpath(filePath); } catch {
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
  }
  const relative = path.relative(userRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
  }
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || info.nlink !== 1 || (info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) || (info.mode & 0o022) !== 0
      || info.size < 1) {
      throw new Error('invalid');
    }
    if (info.size > policy.maxUploadFileSizeBytes) {
      throw Object.assign(new Error('ATTACHMENT_SIZE_EXCEEDS_NATIVE_MAX'), { code: 'CLI_ATTACHMENT_SIZE_EXCEEDS_NATIVE_MAX' });
    }
    if (info.size > policy.directUploadMaxSizeBytes) {
      throw Object.assign(new Error('ATTACHMENT_PRESIGNED_ROUTE_REQUIRED'), { code: 'CLI_ATTACHMENT_PRESIGNED_ROUTE_REQUIRED' });
    }
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length < 1 || bytes.length > policy.directUploadMaxSizeBytes) {
      bytes.fill(0);
      throw new Error('invalid');
    }
    return bytes;
  } catch (error) {
    if (error?.code === 'CLI_ATTACHMENT_PRESIGNED_ROUTE_REQUIRED'
      || error?.code === 'CLI_ATTACHMENT_SIZE_EXCEEDS_NATIVE_MAX') throw error;
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
  } finally { await handle?.close().catch(() => {}); }
}

async function validateAttachmentUploadPacket(value) {
  const allowed = new Set(['sessionBundle', 'expectedIdentity', 'fileName', 'fileMimeType', 'fileBytesBase64', 'filePath', 'policy',
    'assetServerOrigin', 'assetCookieScope', 'assetSsoCookie', 'assetRequestHeaders']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim() || value.expectedIdentity.length > 512
    || /[\r\n\0]/.test(value.expectedIdentity)
    || typeof value.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.fileName)
    || typeof value.fileMimeType !== 'string' || !/^[A-Za-z0-9.+-]{1,80}\/[A-Za-z0-9.+-]{1,80}$/.test(value.fileMimeType)
    || (typeof value.filePath === 'string') === (typeof value.fileBytesBase64 === 'string')
    || Object.hasOwn(value, 'filePath') && typeof value.filePath !== 'string'
    || Object.hasOwn(value, 'fileBytesBase64') && typeof value.fileBytesBase64 !== 'string'
    || typeof value.assetServerOrigin !== 'string' || value.assetServerOrigin !== 'https://assets.grok.com'
    || !value.assetCookieScope || typeof value.assetCookieScope !== 'object' || Array.isArray(value.assetCookieScope)
    || JSON.stringify(Object.keys(value.assetCookieScope).sort()) !== JSON.stringify(['domain', 'httpOnly', 'path', 'secure'])
    || typeof value.assetCookieScope.domain !== 'string' || value.assetCookieScope.domain !== '.grok.com'
    || value.assetCookieScope.path !== '/' || value.assetCookieScope.secure !== true || value.assetCookieScope.httpOnly !== true
    || !value.assetSsoCookie || typeof value.assetSsoCookie !== 'object' || Array.isArray(value.assetSsoCookie)
    || JSON.stringify(Object.keys(value.assetSsoCookie).sort()) !== JSON.stringify(['domain', 'httpOnly', 'name', 'path', 'secure', 'value'])
    || value.assetSsoCookie.name !== 'sso' || value.assetSsoCookie.domain !== '.grok.com' || value.assetSsoCookie.path !== '/'
    || value.assetSsoCookie.secure !== true || value.assetSsoCookie.httpOnly !== true
    || typeof value.assetSsoCookie.value !== 'string' || !value.assetSsoCookie.value || value.assetSsoCookie.value.length > 8192
    || /[\r\n\0;]/.test(value.assetSsoCookie.value)
    || !value.assetRequestHeaders || typeof value.assetRequestHeaders !== 'object' || Array.isArray(value.assetRequestHeaders)) {
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
  }
  const policy = validateAttachmentUploadPolicy(value.policy);
  const origins = value.sessionBundle.origins;
  if (value.sessionBundle.schemaVersion !== 1 || value.sessionBundle.serviceId !== 'grok-web'
    || value.sessionBundle.origin !== 'https://grok.com' || !Array.isArray(origins) || origins.length !== 1
    || origins[0]?.origin !== 'https://grok.com' || !Array.isArray(origins[0].cookies) || origins[0].cookies.length !== 1
    || origins[0].cookies[0]?.name !== 'sso' || !Array.isArray(origins[0].headers) || origins[0].headers.length !== 0) {
    throw Object.assign(new Error('ATTACHMENT_SESSION_SCOPE_INVALID'), { code: 'CLI_ATTACHMENT_SESSION_SCOPE_INVALID' });
  }
  const headerNames = new Set(['accept', 'accept-language', 'origin', 'referer', 'user-agent', 'sec-ch-ua',
    'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site']);
  for (const [name, headerValue] of Object.entries(value.assetRequestHeaders)) {
    if (!headerNames.has(name.toLowerCase()) || typeof headerValue !== 'string' || !headerValue.trim()
      || headerValue.length > 2048 || /[\r\n\0]/.test(headerValue)) {
      throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
    }
  }
  let fileBytes;
  if (typeof value.filePath === 'string') fileBytes = await readHomeAttachmentFile(value.filePath, policy);
  else {
    if (typeof value.fileBytesBase64 !== 'string') {
      throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
    }
    fileBytes = Buffer.from(value.fileBytesBase64, 'base64');
    if (fileBytes.length > policy.maxUploadFileSizeBytes) {
      fileBytes.fill(0);
      throw Object.assign(new Error('ATTACHMENT_SIZE_EXCEEDS_NATIVE_MAX'), { code: 'CLI_ATTACHMENT_SIZE_EXCEEDS_NATIVE_MAX' });
    }
    if (fileBytes.length > policy.directUploadMaxSizeBytes) {
      fileBytes.fill(0);
      throw Object.assign(new Error('ATTACHMENT_PRESIGNED_ROUTE_REQUIRED'), { code: 'CLI_ATTACHMENT_PRESIGNED_ROUTE_REQUIRED' });
    }
    if (!fileBytes.length || fileBytes.toString('base64') !== value.fileBytesBase64) {
      fileBytes.fill(0);
      throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
    }
  }
  if (fileBytes.length > policy.maxUploadFileSizeBytes) {
    fileBytes.fill(0);
    throw Object.assign(new Error('ATTACHMENT_UPLOAD_PACKET_INVALID'), { code: 'CLI_ATTACHMENT_UPLOAD_PACKET_INVALID' });
  }
  return { ...value, policy, fileMimeType: value.fileMimeType.toLowerCase(), fileBytes };
}

async function validatePresignedAttachmentPacket(value) {
  const allowed = new Set(['sessionBundle', 'expectedIdentity', 'fileName', 'fileMimeType', 'fileBytesBase64',
    'filePath', 'policy', 'allowedSignedUploadOrigins', 'fileSource', 'sourceConversationId',
    'initRequestMetadataHeaders', 'requiredUploadMethod']);
  const invalid = () => Object.assign(new Error('PRESIGNED_ATTACHMENT_PACKET_INVALID'), { code: 'CLI_PRESIGNED_ATTACHMENT_PACKET_INVALID' });
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object'
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim() || /[\r\n\0]/.test(value.expectedIdentity)
    || typeof value.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.fileName)
    || typeof value.fileMimeType !== 'string' || !/^[A-Za-z0-9.+-]{1,80}\/[A-Za-z0-9.+-]{1,80}$/.test(value.fileMimeType)
    || !value.policy || typeof value.policy !== 'object' || Array.isArray(value.policy)
    || !Array.isArray(value.allowedSignedUploadOrigins) || !value.allowedSignedUploadOrigins.length
    || value.allowedSignedUploadOrigins.length > 8
    || (typeof value.filePath === 'string') === (typeof value.fileBytesBase64 === 'string')
    || [value.fileSource, value.sourceConversationId].some(field => field !== undefined
      && (typeof field !== 'string' || !field || field.length > 512 || /[\r\n\0]/.test(field)))) throw invalid();
  const metadataHeaders = value.initRequestMetadataHeaders;
  const allowedMetadataHeaders = new Set(['x-statsig-id', 'x-xai-request-id']);
  if (metadataHeaders !== undefined && (!metadataHeaders || typeof metadataHeaders !== 'object'
    || Array.isArray(metadataHeaders) || Object.keys(metadataHeaders).some(name => !allowedMetadataHeaders.has(name))
    || Object.values(metadataHeaders).some(headerValue => typeof headerValue !== 'string'
      || !headerValue || Buffer.byteLength(headerValue, 'utf8') > 2048 || /[\r\n\0]/.test(headerValue)))) throw invalid();
  if (value.requiredUploadMethod !== undefined && value.requiredUploadMethod !== 'multipart') throw invalid();
  const origins = new Set();
  for (const candidate of value.allowedSignedUploadOrigins) {
    let url;
    try { url = new URL(candidate); } catch { throw invalid(); }
    if (url.protocol !== 'https:' || url.origin !== candidate || url.pathname !== '/' || url.search || url.hash
      || url.username || url.password || isIP(url.hostname.replace(/^\[|\]$/g, ''))
      || /^(?:localhost)$|\.localhost$/i.test(url.hostname)) throw invalid();
    origins.add(url.origin);
  }
  let fileBytes;
  if (typeof value.filePath === 'string') {
    if (!path.isAbsolute(value.filePath) || value.filePath.length > 4096 || /[\r\n\0]/.test(value.filePath)) throw invalid();
    const info = await lstat(value.filePath);
    const resolved = await realpath(value.filePath);
    const userRoot = path.resolve(homedir());
    if (!info.isFile() || info.isSymbolicLink() || !resolved.startsWith(userRoot + path.sep)
      || info.size < 1 || info.size > 256 * 1024 * 1024) throw invalid();
    fileBytes = await readFile(resolved);
    if (fileBytes.length !== info.size) { fileBytes.fill(0); throw invalid(); }
  } else {
    if (value.fileBytesBase64.length > MAX_CAPTURED_FRAME_STDIN_BYTES) throw invalid();
    fileBytes = Buffer.from(value.fileBytesBase64, 'base64');
    if (!fileBytes.length || fileBytes.toString('base64') !== value.fileBytesBase64) {
      fileBytes.fill(0); throw invalid();
    }
  }
  return { ...value, fileMimeType: value.fileMimeType.toLowerCase(), fileBytes,
    signedUrlPolicy: async candidate => { try { return origins.has(new URL(candidate).origin); } catch { return false; } } };
}

function parseWorkspaceOptions(args, { mutating }) {
  const options = { sessionStdin: false, confirm: false, intentId: null, pythonExecutable: undefined, output: 'summary' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm') options.confirm = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--include-content' || flag === '--output=json') options.output = 'json';
    else if (flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index++; }
    else throw Object.assign(new Error('WORKSPACE_OPTIONS_INVALID'), { code: 'CLI_WORKSPACE_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin) throw Object.assign(new Error('WORKSPACE_SESSION_STDIN_REQUIRED'), { code: 'CLI_WORKSPACE_SESSION_REQUIRED' });
  if (mutating && (!options.confirm || !options.intentId?.trim())) {
    throw Object.assign(new Error('WORKSPACE_MUTATION_OPTIONS_REQUIRED'), { code: 'CLI_WORKSPACE_MUTATION_OPTIONS_REQUIRED' });
  }
  if (!mutating && (options.confirm || options.intentId)) {
    throw Object.assign(new Error('WORKSPACE_READ_OPTIONS_INVALID'), { code: 'CLI_WORKSPACE_OPTIONS_INVALID' });
  }
  return options;
}

function validateWorkspacePacket(value) {
  const allowed = new Set(['sessionBundle', 'expectedIdentity', 'input']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()) {
    throw Object.assign(new Error('WORKSPACE_PACKET_INVALID'), { code: 'CLI_WORKSPACE_PACKET_INVALID' });
  }
  const input = value.input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('WORKSPACE_PACKET_INVALID'), { code: 'CLI_WORKSPACE_PACKET_INVALID' });
  }
  return { ...value, input };
}

function parseConversationOptions(args, { mutating, subcommand }) {
  const options = { sessionStdin: false, confirm: false, intentId: null, sourceDiscoveryPermit: null,
    pythonExecutable: undefined, websocketPythonExecutable: undefined, recoverNoBusinessAttempt: false, output: 'summary' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm') options.confirm = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--first-live-source-permit' && ['create', 'update', 'settings-update', 'share-set', 'share-revoke', 'delete', 'restore'].includes(subcommand)) {
      options.sourceDiscoveryPermit = subcommand === 'create' ? GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.create
        : subcommand === 'update' ? GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.titleUpdate
        : subcommand === 'settings-update' ? GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.settingsUpdate
          : subcommand === 'share-set' ? GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.sharingSet
            : subcommand === 'share-revoke' ? GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.sharingRevoke
              : subcommand === 'delete' ? GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.delete
                : GROK_CONVERSATION_RESTORE_SOURCE_PERMITS.restore;
    }
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--websocket-python' && subcommand === 'regenerate' && typeof args[index + 1] === 'string' && args[index + 1]) options.websocketPythonExecutable = args[++index];
    else if (flag === '--recover-verified-no-business' && subcommand === 'regenerate') options.recoverNoBusinessAttempt = true;
    else if (flag === '--include-content' || flag === '--output=json') options.output = 'json';
    else if (flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index++; }
    else throw Object.assign(new Error('CONVERSATION_OPTIONS_INVALID'), { code: 'CLI_CONVERSATION_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin) throw Object.assign(new Error('CONVERSATION_SESSION_STDIN_REQUIRED'), { code: 'CLI_CONVERSATION_SESSION_REQUIRED' });
  if (mutating && (!options.confirm || !options.intentId?.trim())) {
    throw Object.assign(new Error('CONVERSATION_MUTATION_OPTIONS_REQUIRED'), { code: 'CLI_CONVERSATION_MUTATION_OPTIONS_REQUIRED' });
  }
  if (!mutating && (options.confirm || options.intentId)) {
    throw Object.assign(new Error('CONVERSATION_READ_OPTIONS_INVALID'), { code: 'CLI_CONVERSATION_OPTIONS_INVALID' });
  }
  return options;
}

function validateConversationPacket(value) {
  const allowed = new Set(['sessionBundle', 'expectedIdentity', 'input']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()) {
    throw Object.assign(new Error('CONVERSATION_PACKET_INVALID'), { code: 'CLI_CONVERSATION_PACKET_INVALID' });
  }
  const input = value.input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('CONVERSATION_PACKET_INVALID'), { code: 'CLI_CONVERSATION_PACKET_INVALID' });
  }
  return { ...value, input };
}

function parseConversationFilesOptions(args) {
  const options = { sessionStdin: false, pythonExecutable: undefined, output: 'summary', outputDir: undefined, suggestedName: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--output-dir' && typeof args[index + 1] === 'string') options.outputDir = args[++index];
    else if (flag === '--name' && typeof args[index + 1] === 'string') options.suggestedName = args[++index];
    else if (flag === '--include-content' || flag === '--output=json') options.output = 'json';
    else if (flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index += 1; }
    else throw Object.assign(new Error('CONVERSATION_FILES_OPTIONS_INVALID'), { code: 'CLI_CONVERSATION_FILES_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin) {
    throw Object.assign(new Error('CONVERSATION_FILES_SESSION_REQUIRED'), { code: 'CLI_CONVERSATION_FILES_SESSION_REQUIRED' });
  }
  if (options.outputDir !== undefined) {
    const resolved = path.resolve(options.outputDir);
    const home = path.resolve(homedir());
    const relative = path.relative(home, resolved);
    if (!path.isAbsolute(options.outputDir) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`)
        || /[\r\n\0]/.test(options.outputDir)) {
      throw Object.assign(new Error('CONVERSATION_FILES_OUTPUT_DIR_INVALID'), { code: 'CLI_CONVERSATION_FILES_OUTPUT_DIR_INVALID' });
    }
    options.outputDir = resolved;
  }
  if (options.suggestedName !== undefined
      && (!options.suggestedName.trim() || options.suggestedName.length > 160 || /[\r\n\0]/.test(options.suggestedName))) {
    throw Object.assign(new Error('CONVERSATION_FILES_NAME_INVALID'), { code: 'CLI_CONVERSATION_FILES_NAME_INVALID' });
  }
  return options;
}

function validateConversationFilesPacket(value) {
  const allowed = new Set(['sessionBundle', 'expectedIdentity', 'input']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
    || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
    throw Object.assign(new Error('CONVERSATION_FILES_PACKET_INVALID'), { code: 'CLI_CONVERSATION_FILES_PACKET_INVALID' });
  }
  return value;
}

function validateTextWssPacket(value) {
  const keys = new Set(['sessionBundle', 'expectedIdentity', 'capture']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
    || !value.capture || typeof value.capture !== 'object' || Array.isArray(value.capture)) {
    throw Object.assign(new Error('TEXT_WSS_PACKET_INVALID'), { code: 'CLI_TEXT_WSS_PACKET_INVALID' });
  }
  return value;
}

function validateMediaImagePacket(value) {
  const keys = new Set(['sessionBundle', 'expectedIdentity', 'prompt', 'capturedFrames', 'requestMetadataHeaders', 'assetRequestContext']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
    || typeof value.prompt !== 'string' || !value.prompt.trim()
    || !value.capturedFrames || typeof value.capturedFrames !== 'object' || Array.isArray(value.capturedFrames)
    || !value.assetRequestContext || typeof value.assetRequestContext !== 'object' || Array.isArray(value.assetRequestContext)) {
    throw Object.assign(new Error('MEDIA_IMAGE_PACKET_INVALID'), { code: 'CLI_MEDIA_IMAGE_PACKET_INVALID' });
  }
  const headers = value.requestMetadataHeaders ?? {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)
    || Object.keys(headers).some(name => !['x-statsig-id', 'x-xai-request-id'].includes(name.toLowerCase()))
    || Object.values(headers).some(header => typeof header !== 'string' || !header.trim() || /[\r\n\0]/.test(header))) {
    throw Object.assign(new Error('MEDIA_IMAGE_PACKET_INVALID'), { code: 'CLI_MEDIA_IMAGE_PACKET_INVALID' });
  }
  validateGrokAssetRequestContext(
    'https://assets.grok.com/users/owner/generated/asset.jpg?cache=1',
    value.assetRequestContext,
    value.assetRequestContext.ownerIdentityDigest,
  );
  return { ...value, requestMetadataHeaders: headers };
}

function validateMediaVideoPacket(value, intentId) {
  const keys = new Set(['sessionBundle', 'expectedIdentity', 'prompt', 'capturedRequest', 'assetRequestContext',
    'generationMode', 'referenceAssetId', 'referencePromptSha256']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
    || typeof value.prompt !== 'string' || !value.prompt.trim()
    || !value.capturedRequest || typeof value.capturedRequest !== 'object' || Array.isArray(value.capturedRequest)
    || value.capturedRequest.intentId !== intentId
    || !value.assetRequestContext || typeof value.assetRequestContext !== 'object' || Array.isArray(value.assetRequestContext)) {
    throw Object.assign(new Error('MEDIA_VIDEO_PACKET_INVALID'), { code: 'CLI_MEDIA_VIDEO_PACKET_INVALID' });
  }
  const generationMode = value.generationMode ?? 'text';
  if (!['text', 'image_reference'].includes(generationMode)
    || generationMode === 'image_reference' && (typeof value.referenceAssetId !== 'string'
      || value.referenceAssetId.length < 1 || value.referenceAssetId.length > 256 || /[\r\n\0]/.test(value.referenceAssetId)
      || typeof value.referencePromptSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.referencePromptSha256))
    || generationMode === 'text' && (value.referenceAssetId !== undefined || value.referencePromptSha256 !== undefined)) {
    throw Object.assign(new Error('MEDIA_VIDEO_REFERENCE_PACKET_INVALID'), { code: 'CLI_MEDIA_VIDEO_REFERENCE_PACKET_INVALID' });
  }
  validateGrokAssetRequestContext(
    'https://assets.grok.com/users/owner/generated/video.mp4?cache=1',
    value.assetRequestContext,
    value.assetRequestContext.ownerIdentityDigest,
  );
  return value;
}

function validateMediaVideoReconcilePacket(value) {
  const keys = new Set(['sessionBundle', 'expectedIdentity', 'prompt', 'assetRequestContext', 'generationMode',
    'referenceAssetIdSha256', 'referencePromptSha256', 'referenceAssetId', 'candidateAssetId', 'candidateAssetIdSha256']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4_000
    || !value.assetRequestContext || typeof value.assetRequestContext !== 'object' || Array.isArray(value.assetRequestContext)) {
    throw Object.assign(new Error('MEDIA_VIDEO_RECONCILE_PACKET_INVALID'), { code: 'CLI_MEDIA_VIDEO_RECONCILE_PACKET_INVALID' });
  }
  const generationMode = value.generationMode ?? 'text';
  if (!['text', 'image_reference'].includes(generationMode)
    || (value.candidateAssetId !== undefined && (typeof value.candidateAssetId !== 'string'
      || value.candidateAssetId.length < 16 || value.candidateAssetId.length > 512 || /[\r\n\0]/.test(value.candidateAssetId)
      || typeof value.candidateAssetIdSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.candidateAssetIdSha256)
      || createHash('sha256').update(value.candidateAssetId, 'utf8').digest('hex') !== value.candidateAssetIdSha256.toLowerCase()))
    || ((value.candidateAssetId === undefined) !== (value.candidateAssetIdSha256 === undefined))
    || generationMode === 'image_reference' && (typeof value.referenceAssetIdSha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.referenceAssetIdSha256)
      || typeof value.referencePromptSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.referencePromptSha256)
      || value.candidateAssetId !== undefined && (typeof value.referenceAssetId !== 'string'
        || value.referenceAssetId.length < 16 || value.referenceAssetId.length > 512 || /[\r\n\0]/.test(value.referenceAssetId)
        || createHash('sha256').update(value.referenceAssetId, 'utf8').digest('hex') !== value.referenceAssetIdSha256.toLowerCase()))
    || generationMode === 'text' && (value.referenceAssetIdSha256 !== undefined || value.referencePromptSha256 !== undefined
      || value.referenceAssetId !== undefined)) {
    throw Object.assign(new Error('MEDIA_VIDEO_RECONCILE_REFERENCE_PACKET_INVALID'), { code: 'CLI_MEDIA_VIDEO_RECONCILE_REFERENCE_PACKET_INVALID' });
  }
  return { ...value, generationMode };
}

export async function loadVerifiedImage03ReadbackProof({ ownerIdentityDigest, assetIdSha256, promptSha256 }) {
  const verificationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'verification');
  const attribution = JSON.parse(await readFile(path.join(verificationRoot, 'grok-media-readback-reconcile-2026-10-06.json'), 'utf8'));
  const byteReceipt = JSON.parse(await readFile(path.join(verificationRoot, 'grok-media-readback-status-2026-10-06.json'), 'utf8'));
  const attributed = attribution?.image;
  if (attribution?.ownerVerified !== true || attributed?.generationAttributionVerified !== true
    || attributed?.byteDownloadVerified !== true || attributed?.exactUniquePromptMatched !== true
    || attributed?.promptSha256 !== promptSha256 || !Array.isArray(attributed?.assetIdSha256)
    || attributed.assetIdSha256.filter(value => value === assetIdSha256).length !== 1) {
    throw Object.assign(new Error('MEDIA_REFERENCE_PRIOR_TASK_RECEIPT_INVALID'), { code: 'CLI_MEDIA_REFERENCE_PRIOR_TASK_RECEIPT_INVALID' });
  }
  const historyCandidates = Array.isArray(attributed.nearbyCandidateEvidence)
    ? attributed.nearbyCandidateEvidence.filter(item => item?.assetIdSha256 === assetIdSha256
      && item.sourceConversationMatchesDetail === true && item.promptExactTaskMatch === true
      && item.uniqueUserPromptCount === 1 && item.assetResponseIdInHistory === true
      && Array.isArray(item.userPromptEvidence) && item.userPromptEvidence.some(prompt => prompt?.taskPrompt === true
        && prompt.sha256 === promptSha256)) : [];
  if (historyCandidates.length !== 1) {
    throw Object.assign(new Error('MEDIA_REFERENCE_PRIOR_HISTORY_PROOF_INVALID'), { code: 'CLI_MEDIA_REFERENCE_PRIOR_HISTORY_PROOF_INVALID' });
  }
  const artifactPath = path.join(homedir(), 'artifacts', 'grok-media-20261006', 'image-03.jpg');
  const downloads = Array.isArray(byteReceipt?.image?.cffiDownloads) ? byteReceipt.image.cffiDownloads.filter(item =>
    item?.assetIdSha256 === assetIdSha256 && item.artifactPath === artifactPath && item.assetHttpStatus === 200
      && item.mimeType === 'image/jpeg' && item.magicVerified === true && item.sha256 === '1bfe89b659df5e36b2e5c46fcd4a98ac92dec96a3b64b53848be4e89e4c7cea9'
      && item.bodyBytes === 216268 && item.cookiesUsed === true && JSON.stringify(item.cookieNamesUsed) === JSON.stringify(['sso'])) : [];
  if (byteReceipt?.image?.generationAttributionVerified !== true || byteReceipt?.image?.byteDownloadVerified !== true
    || downloads.length !== 1) {
    throw Object.assign(new Error('MEDIA_REFERENCE_PRIOR_BYTES_PROOF_INVALID'), { code: 'CLI_MEDIA_REFERENCE_PRIOR_BYTES_PROOF_INVALID' });
  }
  const info = await lstat(artifactPath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== downloads[0].bodyBytes) {
    throw Object.assign(new Error('MEDIA_REFERENCE_PRIOR_ARTIFACT_INVALID'), { code: 'CLI_MEDIA_REFERENCE_PRIOR_ARTIFACT_INVALID' });
  }
  const bytes = await readFile(artifactPath);
  try {
    const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
    if (artifactSha256 !== downloads[0].sha256 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw Object.assign(new Error('MEDIA_REFERENCE_PRIOR_ARTIFACT_CHANGED'), { code: 'CLI_MEDIA_REFERENCE_PRIOR_ARTIFACT_CHANGED' });
    }
    return {
      schemaVersion: 1,
      ownerIdentityDigest,
      assetIdSha256,
      promptSha256,
      artifactSha256,
      bodyBytes: bytes.length,
      mimeType: 'image/jpeg',
      privateGenerated: true,
      sourceTaskHistoryVerified: true,
      sourceBytesVerified: true,
    };
  } finally {
    bytes.fill(0);
  }
}

function validateMediaIntentPreparePacket(value) {
  const keys = new Set(['operation', 'prompt', 'sessionBundle', 'expectedIdentity', 'intentId', 'payloadProfile']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.has(key))
    || !['media.image.create', 'media.video.create'].includes(value.operation)
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4_000
    || /[\0]/.test(value.prompt)
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
    || (value.intentId !== undefined && (typeof value.intentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.intentId)))) {
    throw Object.assign(new Error('MEDIA_INTENT_INPUT_INVALID'), { code: 'CLI_MEDIA_INTENT_INPUT_INVALID' });
  }
  const defaultProfile = value.operation === 'media.image.create'
    ? 'image-quality2-native-batch4' : 'video-6s-480p-no-audio';
  const payloadProfile = value.payloadProfile ?? defaultProfile;
  const allowedProfiles = value.operation === 'media.image.create'
    ? new Set(['image-quality2-native-batch4'])
    : new Set(['video-6s-480p-no-audio', 'video-image-reference-6s-480p-no-audio']);
  if (typeof payloadProfile !== 'string' || !allowedProfiles.has(payloadProfile)) {
    throw Object.assign(new Error('MEDIA_INTENT_PROFILE_INVALID'), { code: 'CLI_MEDIA_INTENT_PROFILE_INVALID' });
  }
  return {
    ...value,
    payloadProfile,
  };
}

function validateSessionCommandPacket(value, { allowRequestMetadata = false } = {}) {
  const allowedKeys = allowRequestMetadata
    ? new Set(['sessionBundle', 'expectedIdentity', 'input', 'requestMetadataHeaders'])
    : new Set(['sessionBundle', 'expectedIdentity', 'input']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowedKeys.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
    || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
    throw Object.assign(new Error('SESSION_STDIN_PACKET_INVALID'), { code: 'CLI_SESSION_PACKET_INVALID' });
  }
  if (value.requestMetadataHeaders !== undefined
    && (!value.requestMetadataHeaders || typeof value.requestMetadataHeaders !== 'object' || Array.isArray(value.requestMetadataHeaders))) {
    throw Object.assign(new Error('SESSION_STDIN_PACKET_INVALID'), { code: 'CLI_SESSION_PACKET_INVALID' });
  }
  return value;
}

async function inMemoryClient(registry, pythonExecutable) {
  return createInMemoryGrokRuntime({ registry, pythonExecutable });
}

function parseSessionRefreshOptions(args) {
  let sessionStdin = false, pythonExecutable;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--session-stdin' && !sessionStdin) sessionStdin = true;
    else if (args[index] === '--python' && pythonExecutable === undefined
      && typeof args[index + 1] === 'string' && args[index + 1] && !args[index + 1].startsWith('--')) {
      pythonExecutable = args[++index];
    } else throw Object.assign(new Error('SESSION_REFRESH_OPTIONS_INVALID'), { code: 'CLI_SESSION_REFRESH_OPTIONS_INVALID' });
  }
  if (!sessionStdin) throw Object.assign(new Error('SESSION_STDIN_REQUIRED'), { code: 'CLI_SESSION_REFRESH_STDIN_REQUIRED' });
  return { pythonExecutable };
}

function parseModelSelectionOptions(args) {
  const options = { sessionStdin: false, pythonExecutable: undefined };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else throw Object.assign(new Error('MODEL_SELECTION_OPTIONS_INVALID'), { code: 'CLI_MODEL_SELECTION_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin) throw Object.assign(new Error('MODEL_SELECTION_SESSION_STDIN_REQUIRED'), { code: 'CLI_MODEL_SELECTION_SESSION_REQUIRED' });
  return options;
}

function parseModelSelectionTextOptions(args) {
  const options = { sessionStdin: false, confirm: false, intentId: null, pythonExecutable: undefined,
    websocketPythonExecutable: undefined, output: 'summary' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--session-stdin') options.sessionStdin = true;
    else if (flag === '--confirm') options.confirm = true;
    else if (flag === '--intent-id' && typeof args[index + 1] === 'string') options.intentId = args[++index];
    else if (flag === '--python' && typeof args[index + 1] === 'string' && args[index + 1]) options.pythonExecutable = args[++index];
    else if (flag === '--websocket-python' && typeof args[index + 1] === 'string' && args[index + 1]) options.websocketPythonExecutable = args[++index];
    else if (flag === '--include-content' || flag === '--output=json') options.output = 'json';
    else if (flag === '--output' && args[index + 1] === 'json') { options.output = 'json'; index++; }
    else throw Object.assign(new Error('MODEL_SELECTION_TEXT_OPTIONS_INVALID'), { code: 'CLI_MODEL_SELECTION_TEXT_OPTIONS_INVALID' });
  }
  if (!options.sessionStdin || !options.confirm || !options.intentId?.trim()) {
    throw Object.assign(new Error('MODEL_SELECTION_TEXT_OPTIONS_REQUIRED'), { code: 'CLI_MODEL_SELECTION_TEXT_OPTIONS_REQUIRED' });
  }
  return options;
}

function validateModelSelectionTextPacket(value) {
  const allowed = new Set(['sessionBundle', 'replacementSessionBundle', 'expectedIdentity', 'expectedOwnerScopeSha256',
    'modeId', 'expectedPageRole', 'selectionEvidence', 'capture', 'expectedPrompt', 'expectedAssistantText']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || !value.replacementSessionBundle || typeof value.replacementSessionBundle !== 'object' || Array.isArray(value.replacementSessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
    || typeof value.expectedOwnerScopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedOwnerScopeSha256)
    || typeof value.modeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.modeId)
    || typeof value.expectedPageRole !== 'string' || !/^codex-grok-[A-Za-z0-9-]{8,96}$/.test(value.expectedPageRole)
    || !value.selectionEvidence || typeof value.selectionEvidence !== 'object' || Array.isArray(value.selectionEvidence)
    || !value.capture || typeof value.capture !== 'object' || Array.isArray(value.capture)
    || typeof value.expectedPrompt !== 'string' || !value.expectedPrompt.trim()
    || Buffer.byteLength(value.expectedPrompt, 'utf8') > 64 * 1024
    || typeof value.expectedAssistantText !== 'string' || !value.expectedAssistantText.trim()
    || value.expectedAssistantText.length > 4096 || /[\r\n\0]/.test(value.expectedAssistantText)) {
    throw Object.assign(new Error('MODEL_SELECTION_TEXT_PACKET_INVALID'), { code: 'CLI_MODEL_SELECTION_TEXT_PACKET_INVALID' });
  }
  return value;
}

function validateModelSelectionPacket(value, subcommand) {
  const allowed = new Set(['sessionBundle', 'expectedIdentity', 'input']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))
    || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
    || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()) {
    throw Object.assign(new Error('MODEL_SELECTION_PACKET_INVALID'), { code: 'CLI_MODEL_SELECTION_PACKET_INVALID' });
  }
  const input = value.input ?? {};
  const validInput = input && typeof input === 'object' && !Array.isArray(input);
  if (!validInput) throw Object.assign(new Error('MODEL_SELECTION_INPUT_INVALID'), { code: 'CLI_MODEL_SELECTION_INPUT_INVALID' });
  const allowedInput = subcommand === 'modes' ? new Set(['locale']) : new Set(['modeId']);
  if (Object.keys(input).some(key => !allowedInput.has(key))) {
    throw Object.assign(new Error('MODEL_SELECTION_INPUT_INVALID'), { code: 'CLI_MODEL_SELECTION_INPUT_INVALID' });
  }
  if (subcommand === 'modes' && input.locale !== undefined
    && (typeof input.locale !== 'string' || !input.locale.trim() || input.locale.length > 32 || /[\r\n\0]/.test(input.locale))) {
    throw Object.assign(new Error('MODEL_SELECTION_LOCALE_INVALID'), { code: 'CLI_MODEL_SELECTION_LOCALE_INVALID' });
  }
  if (subcommand === 'select' && (typeof input.modeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.modeId))) {
    throw Object.assign(new Error('MODEL_SELECTION_MODE_ID_INVALID'), { code: 'CLI_MODEL_SELECTION_MODE_ID_INVALID' });
  }
  return { ...value, input };
}

function safeModelModeChoice(mode) {
  const availability = mode.availability ?? { available: 'unknown' };
  return {
    modeId: mode.id,
    title: mode.title,
    ...(mode.description ? { description: mode.description } : {}),
    ...(mode.badgeText?.trim() ? { badgeText: mode.badgeText.trim() } : {}),
    availability: availability.available,
    ...(availability.requiresUpgrade?.minimumSubscriptionTier
      ? { minimumSubscriptionTier: availability.requiresUpgrade.minimumSubscriptionTier } : {}),
  };
}

async function run(args) {
  const [command, subcommand, identifier] = args;
  if (!command) throw Object.assign(new Error('COMMAND_REQUIRED'), { code: 'CLI_COMMAND_REQUIRED' });
  if (command === 'models') {
    const options = parseModelsOptions(args.slice(1));
    const fetchImpl = options.transport === 'chrome'
      ? createChromeCompatibleFetch({ pythonExecutable: options.pythonExecutable }) : globalThis.fetch;
    const result = await fetchPublicModels({ fetchImpl });
    print(result);
    return;
  }
  if (command === 'auth' && subcommand === 'bootstrap' && args.length === 2) {
    await receiveOneEncryptedSession();
    return;
  }
  const registry = await loadContractRegistry();
  if (command === 'session-refresh') {
    const options = parseSessionRefreshOptions(args.slice(1));
    const { value, bytes } = await readStdinJson();
    let runtime;
    try {
      const allowed = new Set(['sessionBundle', 'replacementSessionBundle', 'expectedIdentity']);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.has(key))
        || !value.sessionBundle || typeof value.sessionBundle !== 'object' || Array.isArray(value.sessionBundle)
        || !value.replacementSessionBundle || typeof value.replacementSessionBundle !== 'object' || Array.isArray(value.replacementSessionBundle)
        || typeof value.expectedIdentity !== 'string' || !value.expectedIdentity.trim()
        || value.expectedIdentity.length > 512 || /[\r\n\0]/.test(value.expectedIdentity)) {
        throw Object.assign(new Error('SESSION_REFRESH_PACKET_INVALID'), { code: 'CLI_SESSION_REFRESH_PACKET_INVALID' });
      }
      runtime = await inMemoryClient(registry, options.pythonExecutable);
      await runtime.client.importSession(value.sessionBundle);
      await runtime.client.verifyOwner(value.expectedIdentity);
      const refreshed = await runtime.client.renewSession({ expectedIdentity: value.expectedIdentity,
        acquireSession: async () => value.replacementSessionBundle });
      print({ serviceId: 'grok-web', operation: 'session-refresh', ...refreshed });
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'operations' && args.length === 1) {
    print(readinessMatrix(registry));
    return;
  }
  const client = new GrokWebClient({ registry });
  if (command === 'status' && args.length === 1) {
    print(await client.status());
    return;
  }
  if (command === 'auth' && subcommand === 'status' && args.length === 2) {
    const status = await client.status();
    print(status.session);
    return;
  }
  if (command === 'auth' && subcommand === 'clear' && args.length === 2) {
    print(await client.clearSession());
    return;
  }
  if (command === 'read' && typeof subcommand === 'string') {
    const options = parsePrivateCommandOptions(args.slice(2), 'read');
    if (options.output === 'json' && subcommand === 'auth.owner.read') {
      throw Object.assign(new Error('IDENTITY_OUTPUT_BLOCKED'), { code: 'CLI_IDENTITY_OUTPUT_BLOCKED' });
    }
    const { value, bytes } = options.sessionStdin || args.length === 3
      ? await readStdinJson() : { value: {}, bytes: Buffer.alloc(0) };
    let runtime;
    try {
      let activeClient = client;
      let ownerVerified = false;
      let input = value;
      if (options.sessionStdin) {
        const packet = validateSessionCommandPacket(value);
        runtime = await inMemoryClient(registry, options.pythonExecutable);
        await runtime.client.importSession(packet.sessionBundle);
        await runtime.client.verifyOwner(packet.expectedIdentity);
        ownerVerified = true;
        activeClient = runtime.client;
        input = packet.input;
      }
      const result = await activeClient.read(subcommand, input);
      const receipt = {
        operationId: subcommand,
        status: result.status,
        contentType: result.contentType,
        responseBytes: result.responseBytes,
        ownerVerified,
        requestDigest: result.requestDigest,
        responseDigest: result.responseDigest,
        responseShape: safeResponseShape(result.data),
      };
      if (options.output === 'json') {
        const businessData = safeBusinessData(result.data);
        const encoded = JSON.stringify(businessData);
        if (Buffer.byteLength(encoded) > MAX_PRIVATE_JSON_OUTPUT_BYTES) {
          throw Object.assign(new Error('OUTPUT_TOO_LARGE'), { code: 'CLI_OUTPUT_SIZE_LIMIT' });
        }
        receipt.data = businessData;
      }
      print(receipt);
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'workspace' && typeof subcommand === 'string') {
    const supported = new Set(['list', 'shared-list', 'read', 'create', 'update', 'delete']);
    if (!supported.has(subcommand)) throw Object.assign(new Error('WORKSPACE_COMMAND_INVALID'), { code: 'CLI_WORKSPACE_COMMAND_INVALID' });
    const needsIdentifier = ['read', 'update', 'delete'].includes(subcommand);
    const targetId = needsIdentifier ? args[2] : undefined;
    const extraPositionals = !needsIdentifier && typeof args[2] === 'string' && !args[2].startsWith('--');
    if ((needsIdentifier && (typeof targetId !== 'string' || !targetId || targetId.startsWith('--'))) || extraPositionals) {
      throw Object.assign(new Error('WORKSPACE_TARGET_INVALID'), { code: 'CLI_WORKSPACE_TARGET_INVALID' });
    }
    const optionStart = needsIdentifier ? 3 : 2;
    const mutating = ['create', 'update', 'delete'].includes(subcommand);
    const options = parseWorkspaceOptions(args.slice(optionStart), { mutating });
    const { value, bytes } = await readStdinJson();
    let runtime;
    try {
      const packet = validateWorkspacePacket(value);
      runtime = await createInMemoryGrokWorkspaceRuntime({ registry, pythonExecutable: options.pythonExecutable });
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);

      if (subcommand === 'list' || subcommand === 'shared-list') {
        const result = subcommand === 'list'
          ? await runtime.workspaces.list(packet.input)
          : await runtime.workspaces.listShared(packet.input);
        const receipt = {
          operationId: subcommand === 'list' ? GROK_WORKSPACE_OPERATION_IDS.list : GROK_WORKSPACE_OPERATION_IDS.sharedList,
          ownerVerified: true,
          status: result.status,
          contentType: result.contentType,
          responseBytes: result.responseBytes,
          responseShape: safeResponseShape(result.data),
        };
        if (options.output === 'json') receipt.data = safeBusinessData(result.data);
        print(receipt);
      } else if (subcommand === 'read') {
        const result = await runtime.workspaces.read(targetId);
        const receipt = {
          operationId: GROK_WORKSPACE_OPERATION_IDS.read,
          ownerVerified: true,
          status: result.status,
          contentType: result.contentType,
          responseBytes: result.responseBytes,
          responseShape: safeResponseShape(result.data),
        };
        if (options.output === 'json') receipt.data = safeBusinessData(result.data);
        print(receipt);
      } else if (subcommand === 'create') {
        const result = await runtime.workspaces.create(packet.input, { confirm: true, intentId: options.intentId });
        print({ operationId: GROK_WORKSPACE_OPERATION_IDS.create, ownerVerified: true, state: result.state,
          verified: result.verified, httpStatus: result.httpStatus, readbackStatus: result.readbackStatus,
          workspace: safeBusinessData(result.workspace) });
      } else if (subcommand === 'update') {
        const result = await runtime.workspaces.update(targetId, packet.input, { confirm: true, intentId: options.intentId });
        print({ operationId: GROK_WORKSPACE_OPERATION_IDS.update, ownerVerified: true, state: result.state,
          verified: result.verified, httpStatus: result.httpStatus, readbackStatus: result.readbackStatus,
          workspace: safeBusinessData(result.workspace) });
      } else {
        const result = await runtime.workspaces.delete(targetId, { confirm: true, intentId: options.intentId });
        print({ operationId: GROK_WORKSPACE_OPERATION_IDS.delete, ownerVerified: true, state: result.state,
          verified: result.verified, httpStatus: result.httpStatus, readbackStatus: result.readbackStatus });
      }
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'conversation' && typeof subcommand === 'string') {
    const supported = new Set(['list', 'list-pages', 'search', 'read', 'nodes', 'load', 'tasks', 'deleted-list', 'share-read', 'share-link-read', 'settings', 'settings-update', 'modes', 'imagine-overrides', 'create', 'update', 'regenerate', 'delete', 'restore', 'share-set', 'share-revoke']);
    if (!supported.has(subcommand)) throw Object.assign(new Error('CONVERSATION_COMMAND_INVALID'), { code: 'CLI_CONVERSATION_COMMAND_INVALID' });
    const mutating = ['create', 'update', 'regenerate', 'delete', 'restore', 'share-set', 'share-revoke', 'settings-update'].includes(subcommand);
    const needsIdentifier = ['update', 'regenerate', 'delete', 'restore', 'share-set', 'share-revoke'].includes(subcommand);
    const positionalTargetId = needsIdentifier && typeof args[2] === 'string' && !args[2].startsWith('--') ? args[2] : undefined;
    const extraPositionals = !needsIdentifier && typeof args[2] === 'string' && !args[2].startsWith('--');
    if (extraPositionals) {
      throw Object.assign(new Error('CONVERSATION_TARGET_INVALID'), { code: 'CLI_CONVERSATION_TARGET_INVALID' });
    }
    const optionStart = positionalTargetId ? 3 : 2;
    const options = parseConversationOptions(args.slice(optionStart), { mutating, subcommand });
    const { value, bytes } = await readStdinJson();
    let runtime;
    try {
      const packet = validateConversationPacket(value);
      const targetId = positionalTargetId ?? packet.input.conversationId;
      if (needsIdentifier && (typeof targetId !== 'string' || !targetId || targetId.startsWith('--'))
        || positionalTargetId && packet.input.conversationId !== undefined && packet.input.conversationId !== positionalTargetId) {
        throw Object.assign(new Error('CONVERSATION_TARGET_INVALID'), { code: 'CLI_CONVERSATION_TARGET_INVALID' });
      }
      runtime = await createInMemoryGrokConversationRuntime({ registry, pythonExecutable: options.pythonExecutable });
      await runtime.client.importSession(packet.sessionBundle);
      const ownerVerification = await runtime.client.verifyOwner(packet.expectedIdentity);
      let result;
      let operationId;
      if (subcommand === 'list-pages') {
        if (Object.keys(packet.input).length !== 1 || !Number.isInteger(packet.input.pageSize)
          || packet.input.pageSize < 1 || packet.input.pageSize > 1000) {
          throw Object.assign(new Error('CONVERSATION_LIST_INPUT_INVALID'), { code: 'CLI_CONVERSATION_LIST_INPUT_INVALID' });
        }
        const first = await runtime.conversations.list({ pageSize: packet.input.pageSize });
        const nextPageToken = first.data?.nextPageToken;
        if (typeof nextPageToken !== 'string' || !nextPageToken) {
          throw Object.assign(new Error('CONVERSATION_NEXT_PAGE_NOT_OBSERVED'), { code: 'CLI_CONVERSATION_NEXT_PAGE_NOT_OBSERVED' });
        }
        const next = await runtime.conversations.list({ pageSize: packet.input.pageSize, pageToken: nextPageToken });
        const summarizePage = (name, page, requestFieldNames) => ({
          name,
          status: page.status,
          contentType: page.contentType,
          responseBytes: page.responseBytes ?? null,
          requestDigest: page.requestDigest ?? null,
          rawResponseDigest: page.rawResponseDigest ?? null,
          rawResponseDigestKind: page.rawResponseDigestKind ?? null,
          parsedResponseDigest: page.responseDigest ?? null,
          requestFieldNames,
          conversationCount: Array.isArray(page.data?.conversations) ? page.data.conversations.length : null,
          nextPageTokenPresent: typeof page.data?.nextPageToken === 'string' && page.data.nextPageToken.length > 0,
          responseShape: safeResponseShape(page.data),
        });
        operationId = GROK_CONVERSATION_OPERATION_IDS.list;
        print({ operationId, ownerVerified: true,
          ownerIdentityRead: {
            status: ownerVerification.httpStatus,
            contentType: ownerVerification.contentType,
            responseBytes: ownerVerification.responseBytes ?? null,
            requestDigest: ownerVerification.requestDigest ?? null,
            rawResponseDigest: ownerVerification.rawResponseDigest ?? null,
            rawResponseDigestKind: ownerVerification.rawResponseDigestKind ?? null,
            parsedResponseDigest: ownerVerification.responseDigest ?? null,
          },
          readVariants: [
            summarizePage('first_page', first, ['pageSize']),
            summarizePage('next_page', next, ['pageSize', 'pageToken']),
          ],
          rawPageTokenPersisted: false,
          rawConversationIdsPersisted: false,
          rawTitlesPersisted: false,
        });
        return;
      } else if (subcommand === 'list') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.list;
        result = await runtime.conversations.list(packet.input);
      } else if (subcommand === 'search') {
        const { searchQuery, ...searchOptions } = packet.input;
        operationId = GROK_CONVERSATION_OPERATION_IDS.list;
        result = await runtime.conversations.search(searchQuery, searchOptions);
      } else if (subcommand === 'read') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.read;
        result = await runtime.conversations.read(packet.input.conversationId);
      } else if (subcommand === 'nodes') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.responseNodes;
        result = await runtime.conversations.responseNodes(packet.input.conversationId, { includeThreads: packet.input.includeThreads });
      } else if (subcommand === 'load') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.loadResponses;
        result = await runtime.conversations.loadResponses(packet.input.conversationId, packet.input.responseIds);
      } else if (subcommand === 'tasks') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.taskResponses;
        result = await runtime.conversations.taskResponses(packet.input.conversationId);
      } else if (subcommand === 'deleted-list') {
        operationId = GROK_CONVERSATION_RESTORE_OPERATION_IDS.deletedList;
        const restoreClient = createGrokConversationRestoreClient({ client: runtime.client, journal: runtime.journal });
        result = await restoreClient.deletedConversations(packet.input);
      } else if (subcommand === 'share-read') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.sharingRead;
        result = await runtime.conversations.sharing(packet.input.conversationId, packet.input.responseId);
      } else if (subcommand === 'share-link-read') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.sharingLinkRead;
        result = await runtime.conversations.shareLink(packet.input.shareLinkId);
        const link = result.data ?? {};
        const conversation = link.conversation && typeof link.conversation === 'object' ? link.conversation : {};
        print({ operationId, ownerVerified: true, status: result.status, contentType: result.contentType,
          responseBytes: result.responseBytes, responseShape: safeResponseShape(link),
          ...(options.output === 'json' ? { data: {
            isPublic: link.isPublic === true,
            allowIndexing: typeof link.allowIndexing === 'boolean' ? link.allowIndexing : null,
            conversationId: typeof conversation.conversationId === 'string' ? conversation.conversationId : undefined,
            responseCount: Array.isArray(link.responses) ? link.responses.length : null,
          } } : {}) });
        return;
      } else if (subcommand === 'settings') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.settingsRead;
        result = await runtime.conversations.settings();
      } else if (subcommand === 'settings-update') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.settingsUpdate;
        const changed = await runtime.conversations.updateSettingsPreference(packet.input.preferenceName, packet.input.preferenceValue, {
          confirm: true,
          intentId: options.intentId,
          sourceDiscoveryPermit: options.sourceDiscoveryPermit,
        });
        const source = changed.sourceDiscoveryReceipt;
        print({ operationId, ownerVerified: true, state: changed.state, verified: changed.verified,
          httpStatus: changed.httpStatus, readbackStatus: changed.readbackStatus,
          preferenceName: changed.preferenceName, beforeValue: changed.beforeValue, afterValue: changed.afterValue,
          otherPreferencesUnchanged: changed.otherPreferencesUnchanged, otherSettingsUnchanged: changed.otherSettingsUnchanged,
          requestDigest: source?.requestDigest ?? changed.requestDigest ?? null,
          intentDigest: source?.intentDigest ?? changed.intentDigest ?? null,
          sourceDiscovery: source ? {
            sourceFunctionName: source.sourceFunctionName,
            method: source.method, pathTemplate: source.pathTemplate,
            responseStatus: source.responseStatus,
            responseContentType: source.responseContentType,
            responseBytes: source.responseBytes,
            responseDigest: source.responseDigest,
            responseTopLevelFieldNames: source.responseTopLevelFieldNames,
            requestHeaderNames: source.requestHeaderNames,
            cookieNames: source.cookieNames,
            transportHttpVersion: source.transportHttpVersion,
            tlsVerified: source.tlsVerified, trustEnv: source.trustEnv,
            redirectsFollowed: source.redirectsFollowed,
            explicitRetries: source.explicitRetries,
            attemptCount: source.attemptCount,
            ownerVerified: source.ownerVerified,
          } : null });
        return;
      } else if (subcommand === 'modes') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.modes;
        result = await runtime.conversations.modes(packet.input.locale ?? 'en');
      } else if (subcommand === 'imagine-overrides') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.imagineModelOverrides;
        result = await runtime.conversations.imagineModelOverrides(packet.input.body);
      } else if (subcommand === 'create') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.create;
        const submitted = await runtime.conversations.create(packet.input.body, {
          confirm: true,
          intentId: options.intentId,
          ...(options.sourceDiscoveryPermit ? { sourceDiscoveryPermit: options.sourceDiscoveryPermit } : {}),
        });
        const source = submitted.sourceDiscoveryReceipt;
        const receipt = submitted.responseReceipt ?? {};
        const operationEvidence = registry.operations.find(item => item.id === operationId)?.evidence ?? {};
        print({ operationId, ownerVerified: true, state: submitted.state, verified: submitted.verified,
          httpStatus: submitted.httpStatus, readbackStatus: submitted.readbackStatus,
          requestDigest: submitted.requestDigest ?? receipt.requestDigest ?? source?.requestDigest ?? null,
          intentDigest: submitted.intentDigest ?? receipt.intentDigest ?? source?.intentDigest ?? null,
          responseDigest: receipt.responseDigest ?? source?.responseDigest ?? null,
          responseBytes: receipt.responseBytes ?? source?.responseBytes ?? null,
          requestHeaderNames: receipt.requestHeaderNames ?? source?.requestHeaderNames ?? [],
          cookieNames: receipt.cookieNames ?? source?.cookieNames ?? [],
          responseJobIdObserved: submitted.jobIdObserved === true,
          sourceFunctionName: source?.sourceFunctionName ?? operationEvidence.sourceFunctionName ?? null,
          method: receipt.method ?? source?.method ?? operationEvidence.method ?? null,
          sourcePathTemplate: source?.pathTemplate ?? operationEvidence.requestPath ?? null,
          sourceDiscovery: source ? {
            sourceFunctionName: source.sourceFunctionName,
            method: source.method,
            pathTemplate: source.pathTemplate,
            requestDigest: source.requestDigest,
            intentDigest: source.intentDigest,
            responseStatus: source.responseStatus,
            responseContentType: source.responseContentType,
            responseBytes: source.responseBytes,
            responseDigest: source.responseDigest,
            responseTopLevelFieldNames: source.responseTopLevelFieldNames,
            responseJobIdObserved: source.responseJobIdObserved,
            requestHeaderNames: source.requestHeaderNames,
            cookieNames: source.cookieNames,
            transportHttpVersion: source.transportHttpVersion,
            tlsVerified: source.tlsVerified,
            trustEnv: source.trustEnv,
            redirectsFollowed: source.redirectsFollowed,
            explicitRetries: source.explicitRetries,
            attemptCount: source.attemptCount,
            ownerVerified: source.ownerVerified,
            businessResponsePersisted: source.businessResponsePersisted,
          } : null,
          ...(options.output === 'json' && submitted.conversationId ? { conversationId: submitted.conversationId } : {}) });
        return;
      } else if (subcommand === 'update') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.update;
        const updated = await runtime.conversations.update(targetId, packet.input.body, {
          confirm: true,
          intentId: options.intentId,
          ...(options.sourceDiscoveryPermit ? { sourceDiscoveryPermit: options.sourceDiscoveryPermit } : {}),
        });
        const source = updated.sourceDiscoveryReceipt;
        print({ operationId, ownerVerified: true, state: updated.state, verified: updated.verified,
          httpStatus: updated.httpStatus, readbackStatus: updated.readbackStatus,
          sourceDiscovery: source ? {
            operationId: source.operationId,
            sourceFunctionName: source.sourceFunctionName,
            method: source.method,
            pathTemplate: source.pathTemplate,
            requestDigest: source.requestDigest,
            intentDigest: source.intentDigest,
            responseStatus: source.responseStatus,
            responseContentType: source.responseContentType,
            responseBytes: source.responseBytes,
            responseDigest: source.responseDigest,
            responseTopLevelFieldNames: source.responseTopLevelFieldNames,
            responseJobIdObserved: source.responseJobIdObserved,
            requestHeaderNames: source.requestHeaderNames,
            cookieNames: source.cookieNames,
            transportHttpVersion: source.transportHttpVersion,
            tlsVerified: source.tlsVerified,
            trustEnv: source.trustEnv,
            redirectsFollowed: source.redirectsFollowed,
            explicitRetries: source.explicitRetries,
            attemptCount: source.attemptCount,
            ownerVerified: source.ownerVerified,
            businessResponsePersisted: source.businessResponsePersisted,
          } : null });
        return;
      } else if (subcommand === 'regenerate') {
        const regenerated = await submitGrokConversationRegenerationWssOnce({
          client: runtime.client,
          sessionPersistence: runtime.sessionPersistence,
          operationJournal: runtime.journal,
          conversationId: targetId,
          responseId: packet.input.responseId,
          responseIds: packet.input.responseIds,
          targetProof: {
            expectedParentMessageSha256: packet.input.expectedParentMessageSha256,
            expectedAssistantPattern: packet.input.expectedAssistantPattern,
          },
          capture: packet.input.capture,
          confirm: true,
          intentId: options.intentId,
          pythonExecutable: options.websocketPythonExecutable,
          allowVerifiedNoBusinessRecovery: options.recoverNoBusinessAttempt,
          previousAttemptEvidence: packet.input.previousAttemptEvidence ?? null,
          ownerVerificationStatus: ownerVerification.httpStatus,
        });
        operationId = GROK_CONVERSATION_WSS_OPERATION_ID;
        print({ operationId, ownerVerified: true, state: regenerated.state, verified: regenerated.verified,
          handshakeStatus: regenerated.handshakeStatus, controlFrameSent: regenerated.controlFrameSent,
          serverSessionAcknowledgementObserved: regenerated.serverSessionAcknowledgementObserved,
          businessFrameBoundToServerSession: regenerated.businessFrameBoundToServerSession,
          capturedSessionIdMatchedAcknowledgement: regenerated.capturedSessionIdMatchedAcknowledgement,
          directBusinessFrameSent: regenerated.directBusinessFrameSent,
          terminalEventObserved: regenerated.terminalEventObserved, eventTypes: regenerated.eventTypes,
          browserBusinessFramesDelivered: regenerated.browserBusinessFramesDelivered,
          castleRequestTokenPresent: regenerated.castleRequestTokenPresent,
          requestDigest: regenerated.requestDigest,
          intentDigest: regenerated.intentDigest,
          recoveryOfRequestDigest: regenerated.recoveryOfRequestDigest ?? null,
          verifiedNoBusinessRecoveryUsed: regenerated.verifiedNoBusinessRecoveryUsed === true,
          ownerVerificationStatus: regenerated.ownerVerificationStatus,
          conversationReadStatus: regenerated.conversationReadStatus,
          responseNodesStatus: regenerated.responseNodesStatus,
          loadResponsesStatus: regenerated.loadResponsesStatus,
          responseCountBefore: regenerated.responseCountBefore,
          responseCountAfter: regenerated.responseCountAfter,
          userResponseCountBefore: regenerated.userResponseCountBefore,
          userResponseCountAfter: regenerated.userResponseCountAfter,
          readbackStatus: regenerated.readbackStatus,
          addedAssistantResponseCount: regenerated.addedAssistantResponseCount ?? 0,
          exactParentMatched: regenerated.exactParentMatched,
          targetResponseParentMatched: regenerated.targetResponseParentMatched,
          newAssistantParentMatched: regenerated.newAssistantParentMatched,
          targetAssistantUnchanged: regenerated.targetAssistantUnchanged,
          taskAssistantPatternMatched: regenerated.taskAssistantPatternMatched,
          regeneratedAssistantNonempty: regenerated.regeneratedAssistantNonempty,
          regeneratedPatternMatched: regenerated.regeneratedPatternMatched,
          userResponseCountUnchanged: regenerated.userResponseCountUnchanged });
        return;
      } else if (subcommand === 'restore') {
        operationId = GROK_CONVERSATION_RESTORE_OPERATION_IDS.restore;
        const restoreClient = createGrokConversationRestoreClient({ client: runtime.client, journal: runtime.journal });
        const restored = await restoreClient.restore(targetId, {
          confirm: true, intentId: options.intentId, sourceDiscoveryPermit: options.sourceDiscoveryPermit,
        });
        const wire = restored.responseReceipt ?? restored.sourceDiscoveryReceipt ?? {};
        print({ operationId, ownerVerified: true, state: restored.state, verified: restored.verified,
          httpStatus: restored.httpStatus, readbackStatus: restored.readbackStatus,
          conversationPresent: restored.conversationPresent === true,
          deletedEntryAbsent: restored.deletedEntryAbsent === true,
          otherActiveConversationsUnchanged: restored.otherActiveConversationsUnchanged === true,
          otherDeletedConversationsUnchanged: restored.otherDeletedConversationsUnchanged === true,
          requestDigest: restored.requestDigest ?? wire.requestDigest ?? null,
          intentDigest: restored.intentDigest ?? wire.intentDigest ?? null,
          responseDigest: wire.responseDigest ?? null, responseBytes: wire.responseBytes ?? null });
        return;
      } else if (subcommand === 'delete') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.delete;
        const deleted = await runtime.conversations.delete(targetId, { confirm: true, intentId: options.intentId,
          sourceDiscoveryPermit: options.sourceDiscoveryPermit });
        const source = deleted.sourceDiscoveryReceipt;
        print({ operationId, ownerVerified: true, state: deleted.state, verified: deleted.verified,
          conversationAbsent: deleted.conversationAbsent === true,
          httpStatus: deleted.httpStatus, readbackStatus: deleted.readbackStatus,
          requestDigest: source?.requestDigest ?? deleted.requestDigest ?? null,
          intentDigest: source?.intentDigest ?? deleted.intentDigest ?? null,
          sourceDiscovery: source ? {
            sourceFunctionName: source.sourceFunctionName,
            method: source.method,
            pathTemplate: source.pathTemplate,
            responseStatus: source.responseStatus,
            responseContentType: source.responseContentType,
            responseBytes: source.responseBytes,
            parsedResponseDigest: source.responseDigest,
            responseTopLevelFieldNames: source.responseTopLevelFieldNames,
            requestHeaderNames: source.requestHeaderNames,
            cookieNames: source.cookieNames,
            transportHttpVersion: source.transportHttpVersion,
            tlsVerified: source.tlsVerified,
            trustEnv: source.trustEnv,
            redirectsFollowed: source.redirectsFollowed,
            explicitRetries: source.explicitRetries,
            attemptCount: source.attemptCount,
            ownerVerified: source.ownerVerified,
            responseDigestPersisted: source.responseDigestPersisted,
          } : null });
        return;
      } else if (subcommand === 'share-revoke') {
        operationId = GROK_CONVERSATION_OPERATION_IDS.sharingRevoke;
        const revoked = await runtime.conversations.revokeSharingLink(targetId, packet.input.responseId,
          packet.input.shareLinkId, { confirm: true, intentId: options.intentId,
            sourceDiscoveryPermit: options.sourceDiscoveryPermit });
        const source = revoked.sourceDiscoveryReceipt;
        print({ operationId, ownerVerified: true, state: revoked.state, verified: revoked.verified,
          httpStatus: revoked.httpStatus, readbackStatus: revoked.readbackStatus, shareLinkAbsent: revoked.shareLinkAbsent,
          requestDigest: source?.requestDigest ?? revoked.requestDigest ?? null,
          intentDigest: source?.intentDigest ?? revoked.intentDigest ?? null,
          sourceDiscovery: source ? {
            sourceFunctionName: source.sourceFunctionName,
            method: source.method, pathTemplate: source.pathTemplate,
            responseStatus: source.responseStatus,
            responseContentType: source.responseContentType,
            responseBytes: source.responseBytes,
            responseDigest: source.responseDigest,
            responseTopLevelFieldNames: source.responseTopLevelFieldNames,
            requestHeaderNames: source.requestHeaderNames,
            cookieNames: source.cookieNames,
            transportHttpVersion: source.transportHttpVersion,
            tlsVerified: source.tlsVerified, trustEnv: source.trustEnv,
            redirectsFollowed: source.redirectsFollowed,
            explicitRetries: source.explicitRetries,
            attemptCount: source.attemptCount,
            ownerVerified: source.ownerVerified,
          } : null });
        return;
      } else {
        operationId = GROK_CONVERSATION_OPERATION_IDS.sharingSet;
        const shared = await runtime.conversations.setSharing(targetId, packet.input.body, {
          confirm: true, intentId: options.intentId, sourceDiscoveryPermit: options.sourceDiscoveryPermit,
        });
        const source = shared.sourceDiscoveryReceipt;
        print({ operationId, ownerVerified: true, state: shared.state, verified: shared.verified,
          httpStatus: shared.httpStatus, readbackStatus: shared.readbackStatus,
          allowIndexing: shared.allowIndexing, isPublic: shared.isPublic, shareLinkReadbackStatus: shared.shareLinkReadbackStatus,
          ...(options.output === 'json' && shared.shareLinkId ? { data: { shareLinkId: shared.shareLinkId, publicId: shared.publicId ?? null } } : {}),
          requestDigest: source?.requestDigest ?? shared.requestDigest ?? null,
          intentDigest: source?.intentDigest ?? shared.intentDigest ?? null,
          sourceDiscovery: source ? {
            sourceFunctionName: source.sourceFunctionName,
            method: source.method, pathTemplate: source.pathTemplate,
            responseStatus: source.responseStatus,
            responseContentType: source.responseContentType,
            responseBytes: source.responseBytes,
            responseDigest: source.responseDigest,
            responseTopLevelFieldNames: source.responseTopLevelFieldNames,
            requestHeaderNames: source.requestHeaderNames,
            cookieNames: source.cookieNames,
            transportHttpVersion: source.transportHttpVersion,
            tlsVerified: source.tlsVerified, trustEnv: source.trustEnv,
            redirectsFollowed: source.redirectsFollowed,
            explicitRetries: source.explicitRetries,
            attemptCount: source.attemptCount,
            ownerVerified: source.ownerVerified,
          } : null });
        return;
      }
      const receipt = {
        operationId,
        ownerVerified: true,
        ownerIdentityRead: {
          status: ownerVerification.httpStatus,
          contentType: ownerVerification.contentType,
          responseBytes: ownerVerification.responseBytes ?? null,
          requestDigest: ownerVerification.requestDigest ?? null,
          rawResponseDigest: ownerVerification.rawResponseDigest ?? null,
          rawResponseDigestKind: ownerVerification.rawResponseDigestKind ?? null,
          parsedResponseDigest: ownerVerification.responseDigest ?? null,
        },
        status: result.status,
        contentType: result.contentType,
        responseBytes: result.responseBytes,
        requestDigest: result.requestDigest ?? null,
        rawResponseDigest: result.rawResponseDigest ?? null,
        rawResponseDigestKind: result.rawResponseDigestKind ?? null,
        parsedResponseDigest: result.responseDigest ?? null,
        responseShape: safeResponseShape(result.data),
      };
      if (options.output === 'json') receipt.data = safeBusinessData(result.data);
      print(receipt);
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'conversation-files' && typeof subcommand === 'string') {
    const supported = new Set(['list', 'content', 'zip', 'workspace-zip', 'download', 'zip-download', 'workspace-zip-download']);
    if (!supported.has(subcommand)) throw Object.assign(new Error('CONVERSATION_FILES_COMMAND_INVALID'), { code: 'CLI_CONVERSATION_FILES_COMMAND_INVALID' });
    const options = parseConversationFilesOptions(args.slice(2));
    const { value, bytes } = await readStdinJson();
    let runtime;
    try {
      const packet = validateConversationFilesPacket(value);
      runtime = ['download', 'zip-download', 'workspace-zip-download'].includes(subcommand)
        ? await createInMemoryGrokConversationFilesRuntime({ registry, pythonExecutable: options.pythonExecutable })
        : await createInMemoryGrokRuntime({ registry, pythonExecutable: options.pythonExecutable });
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      const ownerState = await runtime.sessionPersistence.read();
      const ownerScopeSha256 = ownerState?.session?.ownerBinding?.identityDigest;
      if (typeof ownerScopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ownerScopeSha256)) {
        throw Object.assign(new Error('OWNER_SCOPE_DIGEST_UNAVAILABLE'), { code: 'OWNER_SCOPE_DIGEST_UNAVAILABLE' });
      }
      const files = runtime.files ?? createGrokConversationFilesClient({ client: runtime.client });
      const downloading = ['download', 'zip-download', 'workspace-zip-download'].includes(subcommand);
      if (downloading && !options.outputDir) {
        throw Object.assign(new Error('CONVERSATION_FILES_OUTPUT_DIR_REQUIRED'), { code: 'CLI_CONVERSATION_FILES_OUTPUT_DIR_REQUIRED' });
      }
      const downloadOptions = {
        expectedOwnerScopeSha256: ownerScopeSha256,
        outputDir: options.outputDir,
        ...(options.suggestedName ? { suggestedName: options.suggestedName } : {}),
      };
      const result = subcommand === 'list'
        ? await files.listFiles(packet.input, { expectedOwnerScopeSha256: ownerScopeSha256 })
        : subcommand === 'content'
          ? await files.resolveFileContent(packet.input, { expectedOwnerScopeSha256: ownerScopeSha256 })
          : subcommand === 'zip'
            ? await files.resolveZip(packet.input, { expectedOwnerScopeSha256: ownerScopeSha256 })
            : subcommand === 'workspace-zip'
              ? await files.resolveWorkspaceZip(packet.input, { expectedOwnerScopeSha256: ownerScopeSha256 })
              : subcommand === 'download'
                ? await files.downloadFile(packet.input, downloadOptions)
                : subcommand === 'zip-download'
                  ? await files.downloadZip(packet.input, downloadOptions)
                  : await files.downloadWorkspaceZip(packet.input, downloadOptions);
      const output = {
        operationId: subcommand === 'list' ? 'conversation.files.list'
          : subcommand === 'content' ? 'conversation.file.content.resolve'
            : subcommand === 'zip' ? 'conversation.files.zip.resolve'
              : subcommand === 'workspace-zip' ? 'conversation.workspace.zip.resolve'
                : subcommand === 'download' ? 'artifact.conversation-file.download'
                  : subcommand === 'zip-download' ? 'artifact.conversation-files.zip'
                    : subcommand === 'workspace-zip-download' ? 'artifact.conversation-workspace.zip' : 'unknown',
        ownerVerified: true,
        status: downloading ? result.httpStatus : result.status,
        contentType: downloading ? result.mimeType : result.contentType,
        responseBytes: downloading ? result.bytes : result.responseBytes,
        requestDigest: downloading ? result.downloadRequestDigest ?? result.resolverRequestDigest ?? null : result.requestDigest,
        responseDigest: downloading ? result.sha256 : result.responseDigest,
        ...(downloading ? { responseDigestKind: 'raw_http_body' } : {}),
      };
      if (downloading) {
        output.downloadRequestDigest = result.downloadRequestDigest ?? null;
        output.resolverStatus = result.resolverStatus ?? null;
        output.resolverRequestDigest = result.resolverRequestDigest ?? null;
        output.downloadTransportEvidence = result.downloadTransportEvidence ?? null;
        output.artifact = {
          path: result.path,
          bytes: result.bytes,
          mimeType: result.mimeType,
          sha256: result.sha256,
          magicVerified: result.magicVerified,
          textEncodingVerified: result.textEncodingVerified,
          redirectCount: result.redirectCount ?? 0,
          redirectOrigins: result.redirectOrigins ?? [],
        };
      } else if (options.output === 'json') {
        output.data = subcommand === 'list'
          ? { path: result.path, nextPageToken: result.nextPageToken, files: result.files }
          : subcommand === 'content'
            ? { mimeType: result.mimeType, size: result.size, isTruncated: result.isTruncated,
              dataUrlPresent: result.dataUrlPresent, signedUrlPresent: result.signedUrlPresent,
              downloadSignedUrlPresent: result.downloadSignedUrlPresent }
            : subcommand === 'zip'
              ? { fileCount: result.fileCount, totalSize: result.totalSize, downloadUrlPresent: result.downloadUrlPresent }
              : { sizeBytes: result.sizeBytes, expiresAtPresent: result.expiresAtPresent,
                downloadUrlPresent: result.downloadUrlPresent };
      } else {
        output.responseShape = subcommand === 'list'
          ? { files: { type: 'array', count: result.files.length,
              itemFieldNames: ['isDirectory', 'mimeType', 'modifiedAt', 'name', 'path', 'size'] },
            nextPageTokenPresent: Boolean(result.nextPageToken) }
          : subcommand === 'content'
            ? { mimeType: result.mimeType, size: result.size, isTruncated: result.isTruncated,
              dataUrlPresent: result.dataUrlPresent, signedUrlPresent: result.signedUrlPresent,
              downloadSignedUrlPresent: result.downloadSignedUrlPresent }
            : subcommand === 'zip'
              ? { fileCount: result.fileCount, totalSize: result.totalSize, downloadUrlPresent: result.downloadUrlPresent }
              : { sizeBytes: result.sizeBytes, expiresAtPresent: result.expiresAtPresent,
                downloadUrlPresent: result.downloadUrlPresent };
      }
      print(output);
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'model-selection' && (subcommand === 'modes' || subcommand === 'select')) {
    const options = parseModelSelectionOptions(args.slice(2));
    const { value, bytes } = await readStdinJson();
    let runtime;
    try {
      const packet = validateModelSelectionPacket(value, subcommand);
      runtime = await createInMemoryGrokModelSelectionRuntime({ registry, pythonExecutable: options.pythonExecutable });
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      const result = await runtime.modelSelection.modes(packet.input.locale ?? 'en');
      const catalog = result.data;
      if (subcommand === 'modes') {
        const localSelection = runtime.modelSelection.selected();
        print({
          operationId: GROK_MODEL_MODE_OPERATION_ID,
          ownerVerified: true,
          status: result.status,
          contentType: result.contentType,
          responseBytes: result.responseBytes,
          defaultModeId: catalog.defaultModeId,
          selectedModeId: localSelection ?? catalog.defaultModeId,
          selectedModeSource: localSelection === null ? 'catalog_default' : 'process_memory_sdk_state',
          selectionScope: 'current_cli_process',
          choices: catalog.modes.map(safeModelModeChoice),
        });
      } else {
        const previousModeId = runtime.modelSelection.selected() ?? catalog.defaultModeId;
        const selected = runtime.modelSelection.select(catalog, packet.input.modeId);
        const mode = catalog.modes.find(choice => choice.id === selected.selectedModeId);
        print({
          operationId: GROK_MODEL_MODE_OPERATION_ID,
          ownerVerified: true,
          previousModeId,
          selectedMode: mode ? safeModelModeChoice(mode) : { modeId: selected.selectedModeId },
          selectionSource: selected.selectionSource,
          selectionEffect: 'process_memory_only',
          serverPreferenceWritePerformed: false,
        });
      }
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'model-selection' && subcommand === 'text') {
    const options = parseModelSelectionTextOptions(args.slice(2));
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let packet;
    let runtime;
    try {
      packet = validateModelSelectionTextPacket(value);
      runtime = await createInMemoryGrokModelSelectionRuntime({ registry,
        pythonExecutable: options.pythonExecutable,
        websocketPythonExecutable: options.websocketPythonExecutable });
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      let persisted = await runtime.sessionPersistence.read();
      const digestBeforeRenewal = persisted?.session?.ownerBinding?.identityDigest;
      persisted = null;
      if (digestBeforeRenewal !== packet.expectedOwnerScopeSha256) {
        throw Object.assign(new Error('OWNER_SCOPE_MISMATCH'), { code: 'OWNER_SCOPE_MISMATCH' });
      }
      const renewal = await runtime.client.renewSession({
        expectedIdentity: packet.expectedIdentity,
        acquireSession: async () => packet.replacementSessionBundle,
      });
      persisted = await runtime.sessionPersistence.read();
      const digestAfterRenewal = persisted?.session?.ownerBinding?.identityDigest;
      persisted = null;
      if (digestAfterRenewal !== packet.expectedOwnerScopeSha256) {
        throw Object.assign(new Error('OWNER_SCOPE_MISMATCH'), { code: 'OWNER_SCOPE_MISMATCH' });
      }
      const result = await runtime.submitTextInSelectedMode({
        modeId: packet.modeId,
        expectedPageRole: packet.expectedPageRole,
        selectionEvidence: packet.selectionEvidence,
        capture: packet.capture,
        expectedPrompt: packet.expectedPrompt,
        expectedAssistantText: packet.expectedAssistantText,
        intentId: options.intentId,
        confirm: true,
        includeContent: options.output === 'json',
      });
      const output = {
        operation: result.operation,
        ownerVerified: true,
        ownerScopeSha256Matched: true,
        renewal: {
          renewed: renewal.renewed === true,
          mechanism: renewal.mechanism,
          httpStatus: renewal.httpStatus,
          responseBytes: renewal.responseBytes,
          credentialChanged: renewal.credentialChanged === true,
          providerCookieRotationVerified: renewal.providerCookieRotationVerified === true,
          expiredProviderSessionRecoveryVerified: renewal.expiredProviderSessionRecoveryVerified === true,
          mutationRetried: renewal.mutationRetried === true,
        },
        state: result.state,
        transport: 'direct_ws',
        handshakeStatus: result.handshakeStatus,
        normalControlFrameSent: result.normalControlFrameSent === true,
        serverSessionAcknowledgementObserved: result.serverSessionAcknowledgementObserved === true,
        businessFrameSent: result.businessFrameSent === true,
        businessFrameBoundToServerSession: result.businessFrameBoundToServerSession === true,
        terminalEventObserved: result.terminalEventObserved === true,
        eventTypes: result.eventTypes ?? [],
        readbackVerified: result.readbackVerified === true,
        exactPromptSha256: result.exactPromptSha256,
        readbackConversationIdSha256: result.readbackConversationIdSha256 ?? null,
        readbackAssistantResponseIdSha256: result.readbackAssistantResponseIdSha256 ?? null,
        readbackResponseIdHintMatched: result.readbackResponseIdHintMatched ?? null,
        readbackEvidence: result.readbackEvidence ?? null,
        journalEvidence: result.journalEvidence ?? null,
        modelSelection: {
          selectedModeId: result.selectedModeId,
          selectedModeTitle: result.modeBinding?.modeTitle ?? null,
          selectionSource: result.selectionSource,
          selectionEffect: result.selectionEffect,
          serverPreferenceWritePerformed: result.serverPreferenceWritePerformed === true,
          sourceSessionModel: result.modeBinding?.sessionModel ?? null,
          sourceSessionModelMatchesSelectedMode: result.modeBinding?.sessionModelEqualsSelectedModeId === true,
          serverSessionAcknowledgementModeEchoed: result.serverSessionAcknowledgementModeEchoed ?? null,
          terminalResponseModeEchoed: result.terminalResponseModeEchoed ?? null,
          modelSelectionAcceptance: result.modelSelectionAcceptance,
          providerBackendModelVersion: result.providerBackendModelVersion ?? null,
          providerHonoringSelectedMode: result.providerHonoringSelectedMode,
        },
        providerModelMetadata: result.providerModelMetadata ?? null,
        terminalMetadata: result.terminalMetadata ?? null,
        ...(options.output === 'json' && result.state === 'completed' && result.businessOutput
          ? { businessOutput: safeBusinessData(result.businessOutput) } : {}),
      };
      print(output);
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
      if (packet && typeof packet === 'object') {
        packet.expectedIdentity = '';
        packet.expectedPrompt = '';
        packet.expectedAssistantText = '';
        packet.capture = null;
        packet.sessionBundle = null;
        packet.replacementSessionBundle = null;
      }
    }
    return;
  }
  if (command === 'submit-wss' && args.length >= 2) {
    const options = parseTextWssOptions(args.slice(1));
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let runtime;
    try {
      const packet = validateTextWssPacket(value);
      runtime = await inMemoryClient(registry, options.pythonExecutable);
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      const result = await submitCapturedGrokTextOnce({
        sessionPersistence: runtime.sessionPersistence,
        operationJournal: runtime.journal,
        client: runtime.client,
        capture: packet.capture,
        intentId: options.intentId,
        confirm: true,
        pythonExecutable: options.websocketPythonExecutable,
        includeContent: options.output === 'json',
        expectedAssistantText: options.expectedResponse,
      });
      const output = {
        operation: result.operation,
        ownerVerified: true,
        state: result.state,
        transport: 'direct_ws',
        handshakeStatus: result.handshakeStatus,
        normalControlFrameSent: result.normalControlFrameSent,
        serverSessionAcknowledgementObserved: result.serverSessionAcknowledgementObserved,
        businessFrameSent: result.businessFrameSent,
        businessFrameBoundToServerSession: result.businessFrameBoundToServerSession,
        terminalEventObserved: result.terminalEventObserved,
        eventTypes: result.eventTypes ?? [],
        readbackVerified: result.readbackVerified,
      };
      if (options.output === 'json' && result.state === 'completed' && result.businessOutput) {
        output.businessOutput = safeBusinessData(result.businessOutput);
      }
      print(output);
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'media' && subcommand === 'image-submit') {
    const options = parseMediaImageOptions(args.slice(2));
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let runtime;
    let packet;
    try {
      packet = validateMediaImagePacket(value);
      runtime = await inMemoryClient(registry, options.pythonExecutable);
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      const ownerSession = await runtime.sessionPersistence.read();
      const expectedOwnerIdentityDigest = ownerSession?.session?.ownerBinding?.identityDigest;
      if (ownerSession?.kind !== 'grok-session' || typeof expectedOwnerIdentityDigest !== 'string') {
        throw Object.assign(new Error('OWNER_VERIFICATION_REQUIRED'), { code: 'CLI_OWNER_VERIFICATION_REQUIRED' });
      }
      validateGrokAssetRequestContext(
        'https://assets.grok.com/users/owner/generated/asset.jpg?cache=1',
        packet.assetRequestContext,
        expectedOwnerIdentityDigest,
      );
      const pythonExecutable = options.pythonExecutable ?? process.env.GROK_CHROME_PYTHON ?? 'python3';
      const assetReader = createGrokCffiAssetReader({ pythonExecutable });
      const mediaApi = createGrokMediaApi({ client: runtime.client, assetReader,
        assetServerUrl: `${packet.assetRequestContext.assetOrigin}/` });
      const intentJournal = new GrokMediaIntentJournal({
        filePath: path.join(homedir(), '.nad-scratch', 'grok-web-xhr-client', 'media-intents.json'),
      });
      const result = await submitGrokImagineImage({
        client: runtime.client,
        operationJournal: runtime.journal,
        mediaApi,
        sessionPersistence: runtime.sessionPersistence,
        cookieNames: ['sso'],
        requestMetadataProvider: async () => packet.requestMetadataHeaders,
        intentJournal,
        intentId: options.intentId,
        prompt: packet.prompt,
        capturedFrames: packet.capturedFrames,
        assetRequestContext: packet.assetRequestContext,
        confirm: true,
        verifyAsset: (asset, context) => mediaApi.verifyAssetBytes(asset, context),
      });
      const output = {
        operation: result.operation,
        ownerVerified: true,
        transport: result.transport,
        state: result.state,
        writeRequestsSent: result.writeRequestsSent,
        protocolFramesSent: result.protocolFramesSent,
        readbackVerified: result.readbackVerified,
        assetCount: result.assets?.length ?? 0,
        mediaVerifications: result.mediaVerifications ?? [],
        socketMessages: result.socketMessages ?? [],
      };
      if (options.output === 'json') output.data = safeBusinessData(result);
      print(output);
    } finally {
      if (packet) {
        packet.expectedIdentity = '';
        packet.prompt = '';
        if (Array.isArray(packet.capturedFrames?.frames)) packet.capturedFrames.frames.length = 0;
        for (const cookie of packet.assetRequestContext?.cookies ?? []) cookie.value = '';
        for (const origin of packet.sessionBundle?.origins ?? []) {
          for (const cookie of origin.cookies ?? []) cookie.value = '';
        }
      }
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'media' && subcommand === 'intent-prepare') {
    const options = parseMediaIntentPrepareOptions(args.slice(2));
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let packet;
    let runtime;
    let stage = 'packet_validate';
    try {
      packet = validateMediaIntentPreparePacket(value);
      runtime = await inMemoryClient(registry, options.pythonExecutable);
      stage = 'session_import';
      await runtime.client.importSession(packet.sessionBundle);
      stage = 'owner_verification';
      await runtime.client.verifyOwner(packet.expectedIdentity);
      stage = 'owner_binding_readback';
      const ownerSession = await runtime.sessionPersistence.read();
      const ownerIdentityDigest = ownerSession?.session?.ownerBinding?.identityDigest;
      if (ownerSession?.kind !== 'grok-session' || typeof ownerIdentityDigest !== 'string'
        || !/^[a-f0-9]{64}$/i.test(ownerIdentityDigest)) {
        throw Object.assign(new Error('OWNER_VERIFICATION_REQUIRED'), { code: 'CLI_OWNER_VERIFICATION_REQUIRED' });
      }
      const intentJournal = new GrokMediaIntentJournal({
        filePath: path.join(homedir(), '.nad-scratch', 'grok-web-xhr-client', 'media-intents.json'),
      });
      stage = 'intent_prepare';
      const intent = await intentJournal.prepare({
        operation: packet.operation,
        prompt: packet.prompt,
        payloadProfile: packet.payloadProfile,
        ownerIdentityDigest,
        ...(packet.intentId ? { intentId: packet.intentId } : {}),
      });
      print({ operation: intent.operation, intentId: intent.intentId, state: intent.state, attemptNumber: intent.attemptNumber, ownerVerified: true });
    } catch (error) {
      if (typeof error?.code === 'string') error.details = { stage };
      throw error;
    } finally {
      if (packet) {
        packet.prompt = '';
        packet.expectedIdentity = '';
      }
      if (value && typeof value === 'object') {
        if (typeof value.prompt === 'string') value.prompt = '';
        if (typeof value.expectedIdentity === 'string') value.expectedIdentity = '';
        for (const origin of value.sessionBundle?.origins ?? []) {
          for (const cookie of origin.cookies ?? []) cookie.value = '';
        }
      }
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'media' && subcommand === 'video-submit') {
    const options = parseMediaVideoOptions(args.slice(2));
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let runtime;
    let packet;
    let videoStage = 'packet_validate';
    try {
      packet = validateMediaVideoPacket(value, options.intentId);
      videoStage = 'session_import';
      runtime = await inMemoryClient(registry, options.pythonExecutable);
      await runtime.client.importSession(packet.sessionBundle);
      videoStage = 'owner_verification';
      await runtime.client.verifyOwner(packet.expectedIdentity);
      videoStage = 'owner_binding_readback';
      const ownerSession = await runtime.sessionPersistence.read();
      const expectedOwnerIdentityDigest = ownerSession?.session?.ownerBinding?.identityDigest;
      if (ownerSession?.kind !== 'grok-session' || typeof expectedOwnerIdentityDigest !== 'string'
        || expectedOwnerIdentityDigest !== packet.assetRequestContext.ownerIdentityDigest) {
        throw Object.assign(new Error('OWNER_VERIFICATION_REQUIRED'), { code: 'CLI_OWNER_VERIFICATION_REQUIRED' });
      }
      validateGrokAssetRequestContext(
        'https://assets.grok.com/users/owner/generated/video.mp4?cache=1',
        packet.assetRequestContext,
        expectedOwnerIdentityDigest,
      );
      videoStage = 'transport_setup';
      const pythonExecutable = options.pythonExecutable ?? process.env.GROK_CHROME_PYTHON ?? 'python3';
      const assetReader = createGrokCffiAssetReader({ pythonExecutable });
      const videoFetch = createGrokCffiVideoFetch({
        pythonExecutable,
        assetRequestContext: packet.assetRequestContext,
        expectedOwnerIdentityDigest,
      });
      const mediaApi = createGrokMediaApi({ client: runtime.client, assetReader,
        assetServerUrl: `${packet.assetRequestContext.assetOrigin}/` });
      const mediaReadbackOperationIds = [
        'media.assets.list', 'conversation.read', 'history.response-nodes', 'history.load-responses',
      ];
      const mediaReadbackReceipts = new Map();
      const originalClientRead = runtime.client.read.bind(runtime.client);
      runtime.client.read = async (operationId, input, readOptions) => {
        const readResult = await originalClientRead(operationId, input, readOptions);
        if (mediaReadbackOperationIds.includes(operationId)) {
          mediaReadbackReceipts.set(operationId, {
            operationId,
            httpStatus: readResult.status,
            responseBytes: readResult.responseBytes ?? null,
            responseDigest: readResult.rawResponseDigest ?? null,
            responseDigestKind: readResult.rawResponseDigestKind ?? null,
          });
        }
        return readResult;
      };
      const directRequestDigest = createRequestDigest({
        method: 'POST',
        url: 'https://grok.com/rest/app-chat/conversations/new',
        body: packet.capturedRequest.bodyText,
      });
      const directRequestBodyDigest = createHash('sha256').update(packet.capturedRequest.bodyText, 'utf8').digest('hex');
      const directIntentDigest = createHash('sha256')
        .update(`media.video.create\n${expectedOwnerIdentityDigest}\n${options.intentId}`, 'utf8').digest('hex');
      videoStage = 'artifact_preflight';
      const artifactRoot = path.join(homedir(), 'artifacts', 'grok-media-20261006');
      await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
      const artifactName = (packet.generationMode ?? 'text') === 'image_reference'
        ? 'video-image-reference-01.mp4' : 'video-direct-01.mp4';
      const artifactPath = path.join(artifactRoot, artifactName);
      try { await lstat(artifactPath); throw Object.assign(new Error('MEDIA_ASSET_OUTPUT_EXISTS'), { code: 'CLI_MEDIA_ASSET_OUTPUT_EXISTS' }); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const intentJournal = new GrokMediaIntentJournal({
        filePath: path.join(homedir(), '.nad-scratch', 'grok-web-xhr-client', 'media-intents.json'),
      });
      const mediaAssetDownloadReadbacks = [];
      videoStage = 'media_api_preflight_and_submit';
      const result = await submitProvisionalCapturedGrokVideoOnce({
        client: runtime.client,
        sessionPersistence: runtime.sessionPersistence,
        mediaApi,
        operationJournal: runtime.journal,
        intentJournal,
        intentId: options.intentId,
        prompt: packet.prompt,
        generationMode: packet.generationMode ?? 'text',
        ...(packet.generationMode === 'image_reference' ? {
          referenceAssetId: packet.referenceAssetId,
          referencePromptSha256: packet.referencePromptSha256,
        } : {}),
        confirm: true,
        capturedRequest: packet.capturedRequest,
        assetRequestContext: packet.assetRequestContext,
        fetchImpl: videoFetch,
        verifyAsset: async (asset, context) => {
          const downloaded = await mediaApi.downloadAssetToFile(asset, {
            ...context,
            outputRoot: artifactRoot,
            outputName: artifactName,
          });
          mediaAssetDownloadReadbacks.push({
            httpStatus: downloaded.status,
            mimeType: downloaded.mimeType,
            bodyBytes: downloaded.bodyBytes,
            sha256: downloaded.sha256,
            magicVerified: downloaded.magicVerified,
            artifactPath: downloaded.artifactPath,
          });
          const durationSeconds = await readMp4DurationFromFile(downloaded.artifactPath);
          if (durationSeconds < 4.5 || durationSeconds > 7.5) {
            throw Object.assign(new Error('MEDIA_VIDEO_DURATION_INVALID'), { code: 'CLI_MEDIA_VIDEO_DURATION_INVALID' });
          }
          return { ...downloaded, durationSeconds };
        },
      });
      const output = {
        operation: result.operation,
        generationMode: packet.generationMode ?? 'text',
        ownerVerified: true,
        state: result.state,
        writeRequestsSent: result.writeRequestsSent,
        readbackVerified: result.readbackVerified,
        httpStatus: result.httpStatus,
        responseContentType: result.responseContentType,
        responseBytes: result.responseBytes,
        responseBodySha256: result.responseBodySha256 ?? null,
        responseShape: result.responseShape,
        transportEvidence: result.transportEvidence,
        requestDigest: directRequestDigest,
        intentDigest: directIntentDigest,
        requestBodyDigest: directRequestBodyDigest,
        operationReadbacks: mediaReadbackOperationIds.map(operationId => mediaReadbackReceipts.get(operationId) ?? null),
        noWireProofPersisted: result.noWireProofPersisted ?? false,
        intentRecoveryRecorded: result.intentRecoveryRecorded ?? false,
        sameIntentPreparedForRecovery: result.sameIntentPreparedForRecovery ?? false,
        helperErrorCode: result.helperErrorCode ?? null,
        persistenceErrorCode: result.persistenceErrorCode ?? null,
        paymentOrUpgradeSignal: result.paymentOrUpgradeSignal,
        assetCount: result.assets?.length ?? 0,
        mediaVerifications: result.mediaVerifications ?? [],
        mediaAssetDownloadReadbacks,
        correlation: result.correlation,
        directVideoCreateRequestsSent: result.writeRequestsSent,
        reasonCode: result.reasonCode,
      };
      if (options.output === 'json') output.data = safeBusinessData(result);
      print(output);
    } catch (error) {
      const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? error.details : {};
      error.details = { ...details, stage: typeof details.stage === 'string' ? details.stage : videoStage };
      throw error;
    } finally {
      if (packet) {
        packet.expectedIdentity = '';
        packet.prompt = '';
        if (packet.capturedRequest) {
          packet.capturedRequest.bodyText = '';
          packet.capturedRequest.intentId = '';
          for (const collection of [packet.capturedRequest.headers, packet.capturedRequest.ordinaryHeaders]) {
            if (collection && typeof collection === 'object') for (const key of Object.keys(collection)) collection[key] = '';
          }
        }
        for (const cookie of packet.assetRequestContext?.cookies ?? []) cookie.value = '';
        for (const origin of packet.sessionBundle?.origins ?? []) {
          for (const cookie of origin.cookies ?? []) cookie.value = '';
        }
      }
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'media' && subcommand === 'video-reconcile') {
    const options = parseMediaVideoReconcileOptions(args.slice(2));
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let runtime;
    let packet;
    let reconcileStage = 'packet_validate';
    try {
      packet = validateMediaVideoReconcilePacket(value);
      reconcileStage = 'session_import';
      runtime = await inMemoryClient(registry, options.pythonExecutable);
      await runtime.client.importSession(packet.sessionBundle);
      reconcileStage = 'owner_verification';
      await runtime.client.verifyOwner(packet.expectedIdentity);
      reconcileStage = 'owner_binding_readback';
      const ownerSession = await runtime.sessionPersistence.read();
      const expectedOwnerIdentityDigest = ownerSession?.session?.ownerBinding?.identityDigest;
      if (ownerSession?.kind !== 'grok-session' || typeof expectedOwnerIdentityDigest !== 'string'
        || expectedOwnerIdentityDigest !== packet.assetRequestContext.ownerIdentityDigest) {
        throw Object.assign(new Error('OWNER_VERIFICATION_REQUIRED'), { code: 'CLI_OWNER_VERIFICATION_REQUIRED' });
      }
      reconcileStage = 'reference_source_proof';
      const verifiedReferenceImageProof = packet.generationMode === 'image_reference'
        ? await loadVerifiedImage03ReadbackProof({
          ownerIdentityDigest: expectedOwnerIdentityDigest,
          assetIdSha256: packet.referenceAssetIdSha256,
          promptSha256: packet.referencePromptSha256,
      }) : undefined;
      reconcileStage = 'asset_context_validation';
      validateGrokAssetRequestContext(
        'https://assets.grok.com/users/owner/generated/video.mp4?cache=1',
        packet.assetRequestContext,
        expectedOwnerIdentityDigest,
      );
      reconcileStage = 'asset_reader_setup';
      const pythonExecutable = options.pythonExecutable ?? process.env.GROK_CHROME_PYTHON ?? 'python3';
      const assetReader = createGrokCffiAssetReader({ pythonExecutable });
      const mediaApi = createGrokMediaApi({
        client: runtime.client,
        assetReader,
        assetServerUrl: `${packet.assetRequestContext.assetOrigin}/`,
      });
      const artifactRoot = path.join(homedir(), 'artifacts', 'grok-media-20261006');
      reconcileStage = 'artifact_root_prepare';
      await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
      const artifactName = packet.generationMode === 'image_reference' ? 'video-image-reference-01.mp4' : 'video-direct-01.mp4';
      const artifactPath = path.join(artifactRoot, artifactName);
      try { await lstat(artifactPath); throw Object.assign(new Error('MEDIA_ASSET_OUTPUT_EXISTS'), { code: 'CLI_MEDIA_ASSET_OUTPUT_EXISTS' }); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      reconcileStage = 'intent_journal_load';
      const intentJournal = new GrokMediaIntentJournal({
        filePath: path.join(homedir(), '.nad-scratch', 'grok-web-xhr-client', 'media-intents.json'),
      });
      reconcileStage = 'asset_history_and_download';
      const result = await reconcileUnknownGrokVideoOnce({
        client: runtime.client,
        sessionPersistence: runtime.sessionPersistence,
        mediaApi,
        operationJournal: runtime.journal,
        intentJournal,
        intentId: options.intentId,
        prompt: packet.prompt,
        generationMode: packet.generationMode,
        ...(packet.generationMode === 'image_reference' ? {
          ...(packet.referenceAssetId !== undefined ? { referenceAssetId: packet.referenceAssetId } : {}),
          referenceAssetIdSha256: packet.referenceAssetIdSha256,
          referencePromptSha256: packet.referencePromptSha256,
          verifiedReferenceImageProof,
        } : {}),
        ...(packet.candidateAssetId !== undefined ? {
          candidateAssetId: packet.candidateAssetId,
          candidateAssetIdSha256: packet.candidateAssetIdSha256,
        } : {}),
        assetRequestContext: packet.assetRequestContext,
        verifyAsset: async (asset, context) => {
          const downloaded = await mediaApi.downloadAssetToFile(asset, {
            ...context,
            outputRoot: artifactRoot,
            outputName: artifactName,
          });
          const durationSeconds = await readMp4DurationFromFile(downloaded.artifactPath);
          if (durationSeconds < 4.5 || durationSeconds > 7.5) {
            throw Object.assign(new Error('MEDIA_VIDEO_DURATION_INVALID'), { code: 'CLI_MEDIA_VIDEO_DURATION_INVALID' });
          }
          return { ...downloaded, durationSeconds };
        },
      });
      reconcileStage = 'safe_result_output';
      print({
        operation: result.operation,
        generationMode: packet.generationMode,
        ownerVerified: true,
        state: result.state,
        readbackVerified: result.readbackVerified,
        directHttpStatus: result.directHttpStatus ?? null,
        reconciliationReadMethod: result.reconciliationReadMethod ?? null,
        directVideoCreateRequestsSent: result.writeRequestsSent,
        reconciliationBusinessWritesSent: 0,
        referenceImageTaskVerified: result.referenceImageTaskVerified ?? null,
        referenceImageProofSource: result.referenceImageProofSource ?? null,
        readbackFailure: result.readbackFailure ?? null,
        retryAfterSeconds: result.retryAfterSeconds ?? null,
        assetCount: result.assets?.length ?? 0,
        mediaVerifications: result.mediaVerifications ?? [],
        correlation: result.correlation,
        reasonCode: result.reasonCode,
      });
    } catch (error) {
      const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? error.details : {};
      error.details = { ...details, stage: typeof details.stage === 'string' ? details.stage : reconcileStage };
      throw error;
    } finally {
      if (packet) {
        packet.prompt = '';
        packet.expectedIdentity = '';
        packet.referenceAssetIdSha256 = '';
        packet.referencePromptSha256 = '';
        packet.referenceAssetId = '';
        packet.candidateAssetId = '';
        packet.candidateAssetIdSha256 = '';
        for (const cookie of packet.assetRequestContext?.cookies ?? []) cookie.value = '';
      }
      if (value && typeof value === 'object') {
        if (typeof value.prompt === 'string') value.prompt = '';
        if (typeof value.expectedIdentity === 'string') value.expectedIdentity = '';
        if (typeof value.referenceAssetIdSha256 === 'string') value.referenceAssetIdSha256 = '';
        if (typeof value.referencePromptSha256 === 'string') value.referencePromptSha256 = '';
        if (typeof value.referenceAssetId === 'string') value.referenceAssetId = '';
        if (typeof value.candidateAssetId === 'string') value.candidateAssetId = '';
        if (typeof value.candidateAssetIdSha256 === 'string') value.candidateAssetIdSha256 = '';
        for (const cookie of value.assetRequestContext?.cookies ?? []) cookie.value = '';
        for (const origin of value.sessionBundle?.origins ?? []) {
          for (const cookie of origin.cookies ?? []) cookie.value = '';
        }
      }
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'attachment' && ['status', 'abort'].includes(subcommand)) {
    const options = parseUploadReferenceOptions(args.slice(2), subcommand === 'abort');
    const { value, bytes } = await readStdinJson();
    let runtime;
    try {
      if (!value?.sessionBundle || typeof value.expectedIdentity !== 'string'
        || Object.keys(value).some(key => !['sessionBundle', 'expectedIdentity'].includes(key))) {
        throw Object.assign(new Error('UPLOAD_REFERENCE_PACKET_INVALID'), { code: 'CLI_UPLOAD_REFERENCE_PACKET_INVALID' });
      }
      runtime = await createInMemoryGrokAttachmentRuntime({ registry, pythonExecutable: options.pythonExecutable,
        signedUrlPolicy: async () => false });
      await runtime.client.importSession(value.sessionBundle);
      await runtime.client.verifyOwner(value.expectedIdentity);
      const ticket = await runtime.uploadReferences.openForResume(options.referenceKey);
      const uploadRef = await runtime.presignedAttachments.restoreUploadReference(ticket);
      if (subcommand === 'status') {
        const result = await runtime.presignedAttachments.status({ uploadRef, intentId: options.intentId ?? `status-${randomUUID()}` });
        print({ ...result, referenceKey: options.referenceKey });
      } else {
        await runtime.uploadReferences.claimAbort(options.referenceKey, options.intentId);
        const result = await runtime.presignedAttachments.abort({ uploadRef, intentId: options.intentId, confirm: true });
        const detail = result.diagnostics?.find(item => item.stage === 'abort');
        const observedStatus = result.httpStatus ?? detail?.httpStatus;
        await runtime.uploadReferences.finishAbort(options.referenceKey, {
          state: result.state === 'aborted' ? 'aborted' : result.state === 'abort_requested' ? 'abort_requested' : 'outcome_unknown',
          ...(Number.isInteger(observedStatus) ? { httpStatus: observedStatus } : {}),
          ...(detail?.responseBytes !== undefined ? { responseBytes: detail.responseBytes } : {}),
          ...(detail?.responseDigest ? { responseDigest: detail.responseDigest, responseDigestKind: detail.responseDigestKind } : {}),
          ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
        });
        print({ ...result, referenceKey: options.referenceKey });
      }
    } finally {
      if (value && typeof value === 'object') {
        value.expectedIdentity = '';
        for (const origin of value.sessionBundle?.origins ?? []) for (const cookie of origin.cookies ?? []) cookie.value = '';
      }
      bytes.fill(0); await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'attachment' && subcommand === 'attach-chat') {
    const options = parseAttachmentChatOptions(args.slice(2));
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let packet;
    let runtime;
    try {
      packet = await validateAttachmentChatPacket(value);
      runtime = await createInMemoryGrokAttachmentChatRuntime({
        registry,
        pythonExecutable: options.pythonExecutable,
        continuationPythonExecutable: options.websocketPythonExecutable,
        expectedPageRole: packet.sourcePageRole,
        expectedOwnerIdentityDigest: packet.expectedOwnerIdentityDigest,
      });
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      const state = await runtime.sessionPersistence.read();
      if (state?.session?.ownerBinding?.identityDigest !== GROK_ATTACHMENT_CHAT_OWNER_SHA256) {
        throw Object.assign(new Error('ATTACHMENT_CHAT_OWNER_MISMATCH'), { code: 'CLI_ATTACHMENT_CHAT_OWNER_MISMATCH' });
      }
      const result = await runtime.attachmentChat.submit({
        capture: packet.capture,
        conversationId: packet.conversationId,
        file: {
          fileName: packet.fileName,
          mimeType: packet.fileMimeType,
          bytes: packet.expectedFileBytes,
          sha256: packet.expectedFileSha256,
        },
        prompt: packet.prompt,
        expectedAssistantText: packet.expectedAssistantText,
        intentId: options.intentId,
        confirm: true,
      });
      print(result);
    } finally {
      for (const source of [packet, value]) {
        if (!source || typeof source !== 'object') continue;
        source.expectedIdentity = '';
        source.conversationId = '';
        source.prompt = '';
        source.expectedAssistantText = '';
        const capture = source.capture;
        if (capture && typeof capture === 'object') {
          capture.socketUrl = '';
          capture.controlFrameText = '';
          capture.frameText = '';
          capture.businessFrames = [];
          capture.httpBodies = [];
        }
        for (const origin of source.sessionBundle?.origins ?? []) {
          for (const cookie of origin.cookies ?? []) cookie.value = '';
        }
      }
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'attachment' && subcommand === 'upload-presigned') {
    const options = parseAttachmentUploadOptions(args.slice(2));
    if (options.cleanupTaskAsset) throw Object.assign(new Error('PRESIGNED_CLEANUP_OPTION_UNSUPPORTED'), { code: 'CLI_PRESIGNED_CLEANUP_OPTION_UNSUPPORTED' });
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let packet;
    let runtime;
    try {
      packet = await validatePresignedAttachmentPacket(value);
      runtime = await createInMemoryGrokAttachmentRuntime({ registry, pythonExecutable: options.pythonExecutable,
        signedUrlPolicy: packet.signedUrlPolicy,
        getUploadRequestMetadataHeaders: ({ operationId }) => operationId === 'attachment.upload.init'
          ? packet.initRequestMetadataHeaders ?? {} : {} });
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      const state = await runtime.sessionPersistence.read();
      const result = await runtime.presignedAttachments.upload({
        fileName: packet.fileName, mimeType: packet.fileMimeType, bytes: packet.fileBytes,
        ownerIdentityDigest: state?.session?.ownerBinding?.identityDigest,
        intentId: options.intentId, confirm: true, policy: packet.policy,
        ...(packet.requiredUploadMethod ? { requiredUploadMethod: packet.requiredUploadMethod } : {}),
        ...(packet.fileSource ? { fileSource: packet.fileSource } : {}),
        ...(packet.sourceConversationId ? { sourceConversationId: packet.sourceConversationId } : {}),
      });
      let uploadReference = null;
      let referencePersistence = null;
      if (result.uploadRef) {
        try {
          const ref = await runtime.presignedAttachments.describeUploadReference(result.uploadRef);
          if (ref.initCheckpointPath) {
            const checkpointBytes = await readFile(ref.initCheckpointPath);
            try {
              uploadReference = await runtime.uploadReferences.issueFromValidatedInit({
                callerIntentId: ref.intentId, fileName: ref.fileName, mimeType: ref.mimeType,
                fileBytes: ref.fileBytes, fileSha256: result.fileSha256,
                uploadId: ref.uploadId, assetId: ref.assetId, initialState: result.state,
                initCheckpointPath: ref.initCheckpointPath,
                initCheckpointSha256: createHash('sha256').update(checkpointBytes).digest('hex'),
              });
              referencePersistence = { state: 'stored' };
            } finally { checkpointBytes.fill(0); }
          } else referencePersistence = { state: 'unavailable', businessRetryAllowed: false };
        } catch (error) {
          referencePersistence = { state: 'failed', errorCode: typeof error?.code === 'string'
            && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'UPLOAD_REFERENCE_PERSISTENCE_FAILED',
          businessRetryAllowed: false };
        }
      }
      print({ ...result, ...(uploadReference ? { uploadReference } : {}),
        ...(referencePersistence ? { referencePersistence } : {}),
      });
    } finally {
      for (const source of [packet, value]) {
        const headers = source?.initRequestMetadataHeaders;
        if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
          for (const name of Object.keys(headers)) headers[name] = '';
        }
        if (source && typeof source === 'object') source.initRequestMetadataHeaders = {};
      }
      packet?.fileBytes?.fill(0);
      if (packet) { packet.expectedIdentity = ''; packet.fileBytesBase64 = ''; }
      if (value && typeof value === 'object') {
        value.expectedIdentity = ''; value.fileBytesBase64 = '';
        for (const origin of value.sessionBundle?.origins ?? []) {
          for (const cookie of origin.cookies ?? []) cookie.value = '';
        }
      }
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'attachment' && subcommand === 'upload') {
    const options = parseAttachmentUploadOptions(args.slice(2));
    const { value, bytes } = await readStdinJson(MAX_CAPTURED_FRAME_STDIN_BYTES);
    let packet;
    let runtime;
    try {
      packet = await validateAttachmentUploadPacket(value);
      runtime = await createInMemoryGrokAttachmentRuntime({ registry, pythonExecutable: options.pythonExecutable });
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      const stored = await runtime.sessionPersistence.read();
      const ownerIdentityDigest = stored?.session?.ownerBinding?.identityDigest;
      const sessionSso = stored?.session?.origins?.find(origin => origin.origin === 'https://grok.com')
        ?.cookies?.find(cookie => cookie.name === 'sso');
      if (stored?.kind !== 'grok-session' || typeof ownerIdentityDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(ownerIdentityDigest) || !sessionSso
        || sessionSso.value !== packet.assetSsoCookie.value) {
        throw Object.assign(new Error('ATTACHMENT_OWNER_OR_COOKIE_BINDING_INVALID'), { code: 'CLI_ATTACHMENT_OWNER_BINDING_INVALID' });
      }
      const artifactRoot = path.join(homedir(), 'artifacts', 'grok-attachments-20261006');
      await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
      await chmod(artifactRoot, 0o700);
      const artifactInfo = await lstat(artifactRoot);
      if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink()) {
        throw Object.assign(new Error('ATTACHMENT_OUTPUT_ROOT_INVALID'), { code: 'CLI_ATTACHMENT_OUTPUT_ROOT_INVALID' });
      }
      const api = runtime.attachments;
      let apiAuditPath = null;
      const intentSuffix = createHash('sha256').update(options.intentId).digest('hex').slice(0, 16);
      const auditFileName = `grok-attachment-upload-api-live-${new Date().toISOString().slice(0, 10)}-${intentSuffix}.json`;
      const result = await api.uploadDirect({
        fileName: packet.fileName,
        mimeType: packet.fileMimeType,
        bytes: packet.fileBytes,
        policy: packet.policy,
        assetServerOrigin: packet.assetServerOrigin,
        assetCookieScope: packet.assetCookieScope,
        assetSsoCookieValue: packet.assetSsoCookie.value,
        assetRequestHeaders: packet.assetRequestHeaders,
        ownerIdentityDigest,
        outputRoot: artifactRoot,
        outputName: `${intentSuffix}-${packet.fileName.slice(0, 111)}`,
        intentId: options.intentId,
        confirm: true,
        cleanupTaskAsset: options.cleanupTaskAsset,
        onSafeAudit: async safeResult => { apiAuditPath = await persistGrokAttachmentApiAudit(safeResult, { fileName: auditFileName }); },
      });
      print({ ...result, apiAuditPath,
        ...(options.output === 'json' && result.attachmentRef ? { attachmentRef: result.attachmentRef } : {}),
      });
    } finally {
      if (packet?.fileBytes) packet.fileBytes.fill(0);
      if (packet) {
        packet.expectedIdentity = '';
        packet.fileBytesBase64 = '';
        packet.filePath = '';
        packet.assetSsoCookie.value = '';
      }
      if (value && typeof value === 'object') {
        value.expectedIdentity = '';
        value.fileBytesBase64 = '';
        value.filePath = '';
        if (value.assetSsoCookie) value.assetSsoCookie.value = '';
        for (const origin of value.sessionBundle?.origins ?? []) {
          for (const cookie of origin.cookies ?? []) cookie.value = '';
        }
      }
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'submit' && typeof subcommand === 'string') {
    const options = parsePrivateCommandOptions(args.slice(2), 'submit');
    const { value, bytes } = await readStdinJson();
    let runtime;
    try {
      const packet = validateSessionCommandPacket(value, { allowRequestMetadata: true });
      runtime = await inMemoryClient(registry, options.pythonExecutable);
      await runtime.client.importSession(packet.sessionBundle);
      await runtime.client.verifyOwner(packet.expectedIdentity);
      const result = await runtime.client.submit(subcommand, packet.input, {
        confirm: true,
        intentId: options.intentId,
        requestMetadataHeaders: packet.requestMetadataHeaders ?? {},
      });
      print({
        operationId: subcommand,
        ownerVerified: true,
        state: result.state,
        httpStatus: result.httpStatus,
        jobIdObserved: result.jobIdObserved,
        responseReturned: result.responseReturned,
      });
    } finally {
      bytes.fill(0);
      await runtime?.client.clearSession().catch(() => {});
    }
    return;
  }
  if (command === 'reconcile' && typeof subcommand === 'string' && args.length === 2) {
    print(await client.reconcile(subcommand));
    return;
  }
  if (command === 'journal' && args.length === 1) {
    print(await client.listJournal());
    return;
  }
  throw Object.assign(new Error('COMMAND_INVALID'), { code: 'CLI_COMMAND_INVALID' });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  run(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
    process.exitCode = 1;
  });
}
