import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fail } from './errors.mjs';
import { downloadValidatedFile } from './file-download.mjs';
import { createRequestDigest } from './transport.mjs';

export const GROK_CONVERSATION_FILE_OPERATION_IDS = Object.freeze({
  list: 'conversation.files.list',
  content: 'conversation.file.content.resolve',
  zip: 'conversation.files.zip.resolve',
  workspaceZip: 'conversation.workspace.zip.resolve',
});

const FILE_QUERY_FIELDS = new Set(['conversationId', 'path', 'pageToken', 'pageSize']);
const MAX_PRIVATE_FILE_BYTES = 64 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateConversationId(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 128 || /[\r\n\0]/.test(value)) {
    throw fail('CONVERSATION_FILE_ID_INVALID');
  }
  return value;
}

function validateFilePath(value, { optional = false, allowEmpty = false } = {}) {
  if (value === undefined && optional) return value;
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.length > 4096 || /[\r\n\0\\]/.test(value)) {
    throw fail('CONVERSATION_FILE_PATH_INVALID');
  }
  let decoded = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (decoded.split('/').some(part => part === '..')) throw fail('CONVERSATION_FILE_PATH_INVALID');
    let next;
    try { next = decodeURIComponent(decoded); } catch { break; }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.split('/').some(part => part === '..') || decoded.includes('\\')) {
    throw fail('CONVERSATION_FILE_PATH_INVALID');
  }
  return value;
}

function normalizeSize(value, code) {
  if (value === undefined) return value;
  if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_PRIVATE_FILE_BYTES) return value;
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
    const normalized = Number(value);
    if (Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= MAX_PRIVATE_FILE_BYTES) return normalized;
  }
  throw fail(code);
}

function normalizeFileCount(value, code) {
  if (value === undefined) return value;
  if (Number.isSafeInteger(value) && value >= 0 && value <= 100_000) return value;
  if (typeof value === 'string' && /^\d{1,10}$/.test(value)) {
    const normalized = Number(value);
    if (Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= 100_000) return normalized;
  }
  throw fail(code);
}

function shapeFailure(code, result) {
  return fail(code, {
    status: result.status,
    contentType: result.contentType ?? null,
    responseBytes: result.responseBytes ?? null,
    requestDigest: result.requestDigest ?? null,
    responseDigest: result.rawResponseDigest ?? result.responseDigest ?? null,
    responseShape: safeResponseShape(result.data),
  });
}

function validateInput(input, { pathRequired = false, allowEmptyPath = false } = {}) {
  if (!plainObject(input) || Object.keys(input).some(key => !FILE_QUERY_FIELDS.has(key))) {
    throw fail('CONVERSATION_FILE_INPUT_INVALID');
  }
  validateConversationId(input.conversationId);
  validateFilePath(input.path, { optional: !pathRequired, allowEmpty: allowEmptyPath });
  if (input.pageToken !== undefined
      && (typeof input.pageToken !== 'string' || !input.pageToken.length || input.pageToken.length > 8192
        || /[\r\n\0]/.test(input.pageToken))) throw fail('CONVERSATION_FILE_PAGE_TOKEN_INVALID');
  if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1000)) {
    throw fail('CONVERSATION_FILE_PAGE_SIZE_INVALID');
  }
  return input;
}

function resultMetadata(result) {
  const transport = safeDownloadTransport(result);
  return {
    status: result.status,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    requestDigest: result.requestDigest,
    responseDigest: result.responseDigest,
    rawResponseDigest: result.rawResponseDigest ?? null,
    transportEvidence: transport,
  };
}

function safeDownloadTransport(response) {
  const transport = response?.transportEvidence;
  if (!transport) return null;
  return {
    httpVersion: transport.httpVersion ?? null,
    profile: transport.profile ?? null,
    tlsVerified: transport.tlsVerified === true,
    trustEnv: transport.trustEnv === false,
    redirectsFollowed: transport.redirectsFollowed === false,
    explicitRetries: Number.isInteger(transport.explicitRetries) ? transport.explicitRetries : null,
    requestHeaderNames: Array.isArray(transport.requestHeaderNames) ? transport.requestHeaderNames : [],
    cookieNamesPrepared: Array.isArray(transport.cookieNamesPrepared) ? transport.cookieNamesPrepared : [],
  };
}

function parseDataUrl(dataUrl, expectedMimeType) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_PRIVATE_FILE_BYTES * 4 / 3) + 8192) {
    throw fail('CONVERSATION_FILE_DATA_URL_INVALID');
  }
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[1].toLowerCase() !== expectedMimeType.toLowerCase()) throw fail('CONVERSATION_FILE_DATA_URL_INVALID');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_PRIVATE_FILE_BYTES || bytes.toString('base64') !== match[2]) {
    bytes.fill(0);
    throw fail('CONVERSATION_FILE_DATA_URL_INVALID');
  }
  return bytes;
}

async function persistSourceResolvedFile({
  source,
  fetchSourceResolvedArtifact,
  outputDir,
  suggestedName,
  expectedMimeType,
  expectedSize,
  allowOctetStreamAsZip = false,
}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw fail('CONVERSATION_FILE_DOWNLOAD_SOURCE_INVALID');
  if (source.isTruncated === true) throw fail('CONVERSATION_FILE_CONTENT_TRUNCATED');
  const mimeType = expectedMimeType ?? source.mimeType;
  if (typeof mimeType !== 'string' || !mimeType.trim()) throw fail('CONVERSATION_FILE_MIME_MISSING');
  const maxBytes = MAX_PRIVATE_FILE_BYTES;
  if (Number.isSafeInteger(source.size) && (source.size < 0 || source.size > maxBytes)) {
    throw fail('CONVERSATION_FILE_SIZE_LIMIT');
  }
  if (Number.isSafeInteger(expectedSize) && (expectedSize < 0 || expectedSize > maxBytes)) {
    throw fail('CONVERSATION_FILE_SIZE_LIMIT');
  }

  const sourceUrl = source.downloadSignedUrl || source.signedUrl || source.downloadUrl;
  let response;
  let downloadRequestDigest = null;
  const redirectRequestDigests = [];
  const redirectOrigins = [];
  let redirectCount = 0;
  if (typeof sourceUrl === 'string' && sourceUrl.length) {
    let parsed;
    try { parsed = new URL(sourceUrl); } catch { throw fail('FILE_ARTIFACT_URL_INVALID'); }
    if (parsed.protocol === 'data:') {
      const bytes = parseDataUrl(sourceUrl, mimeType);
      response = new Response(bytes, { status: 200, headers: { 'content-type': mimeType } });
    } else {
      if (typeof fetchSourceResolvedArtifact !== 'function') throw fail('FILE_ARTIFACT_FETCH_UNAVAILABLE');
      if (parsed.protocol !== 'https:') throw fail('FILE_ARTIFACT_URL_SCOPE');
      const seen = new Set();
      for (let attempt = 0; attempt <= 5; attempt += 1) {
        if (seen.has(parsed.href)) throw fail('FILE_ARTIFACT_REDIRECT_CYCLE');
        seen.add(parsed.href);
        redirectRequestDigests.push(createRequestDigest({ method: 'GET', url: parsed.href }));
        redirectOrigins.push(parsed.origin);
        response = await fetchSourceResolvedArtifact(parsed.href, { maxBytes });
        if (response.status === 200) break;
        if (!REDIRECT_STATUSES.has(response.status) || attempt === 5) {
          const status = response.status;
          await response.body?.cancel().catch(() => {});
          throw fail('FILE_ARTIFACT_STATUS_UNEXPECTED', { status });
        }
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (typeof location !== 'string' || !location.trim() || location.length > 8192 || /[\r\n\0]/.test(location)) {
          throw fail('FILE_ARTIFACT_REDIRECT_LOCATION_INVALID');
        }
        try { parsed = new URL(location, parsed); } catch { throw fail('FILE_ARTIFACT_REDIRECT_LOCATION_INVALID'); }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
          throw fail('FILE_ARTIFACT_REDIRECT_SCOPE');
        }
        redirectCount += 1;
      }
      downloadRequestDigest = redirectRequestDigests.length === 1
        ? redirectRequestDigests[0]
        : createHash('sha256').update(redirectRequestDigests.join('\n'), 'utf8').digest('hex');
    }
  } else if (typeof source.dataUrl === 'string') {
    const bytes = parseDataUrl(source.dataUrl, mimeType);
    response = new Response(bytes, { status: 200, headers: { 'content-type': mimeType } });
  } else {
    throw fail('CONVERSATION_FILE_DOWNLOAD_SOURCE_MISSING');
  }

  const transportEvidence = safeDownloadTransport(response);
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw fail('FILE_ARTIFACT_STATUS_UNEXPECTED', { status: response.status });
  }
  const downloaded = await downloadValidatedFile(response, {
    outputDir,
    suggestedName,
    allowedMimeTypes: [mimeType],
    maxBytes,
    allowOctetStreamAsZip,
  });
  const expected = Number.isSafeInteger(expectedSize) ? expectedSize : source.size;
  if (Number.isSafeInteger(expected) && downloaded.bytes !== expected) {
    await rm(downloaded.path, { force: true }).catch(() => {});
    throw fail('CONVERSATION_FILE_SIZE_READBACK_MISMATCH');
  }
  return {
    ...downloaded,
    downloadRequestDigest,
    redirectCount,
    redirectOrigins: [...new Set(redirectOrigins)],
    transportEvidence,
  };
}

function assertOwner(client) {
  return client.status().then(status => {
    if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
    return status;
  });
}

function requireFileList(data) {
  if (!plainObject(data) || !Array.isArray(data.files)
      || data.files.some(file => !plainObject(file)
        || typeof file.name !== 'string' || typeof file.path !== 'string'
        || typeof file.isDirectory !== 'boolean'
        || (file.mimeType !== undefined && typeof file.mimeType !== 'string')
        || (file.modifiedAt !== undefined && typeof file.modifiedAt !== 'string'))
      || (data.path !== undefined && typeof data.path !== 'string')
      || (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')) {
    throw fail('CONVERSATION_FILE_LIST_SHAPE_INVALID');
  }
  try {
    return { ...data, files: data.files.map(file => ({ ...file,
      ...(file.size === undefined ? {} : { size: normalizeSize(file.size, 'CONVERSATION_FILE_LIST_SHAPE_INVALID') }),
    })) };
  } catch { throw fail('CONVERSATION_FILE_LIST_SHAPE_INVALID'); }
}

function requireContentMetadata(data) {
  if (!plainObject(data)
      || (data.mimeType !== undefined && typeof data.mimeType !== 'string')
      || (data.isTruncated !== undefined && typeof data.isTruncated !== 'boolean')
      || (data.dataUrl !== undefined && typeof data.dataUrl !== 'string')
      || (data.signedUrl !== undefined && typeof data.signedUrl !== 'string')
      || (data.downloadSignedUrl !== undefined && typeof data.downloadSignedUrl !== 'string')) {
    throw fail('CONVERSATION_FILE_CONTENT_SHAPE_INVALID');
  }
  try {
    return { ...data, ...(data.size === undefined ? {} : { size: normalizeSize(data.size, 'CONVERSATION_FILE_CONTENT_SHAPE_INVALID') }) };
  } catch { throw fail('CONVERSATION_FILE_CONTENT_SHAPE_INVALID'); }
}

function safeResponseShape(value, depth = 0) {
  if (depth > 6) return { type: Array.isArray(value) ? 'array' : typeof value };
  if (Array.isArray(value)) {
    const item = value.find(entry => plainObject(entry));
    return { type: 'array', count: value.length, itemFieldNames: item ? Object.keys(item).sort().slice(0, 80) : [] };
  }
  if (!plainObject(value)) return { type: value === null ? 'null' : typeof value };
  const fields = {};
  for (const [key, child] of Object.entries(value).slice(0, 128)) {
    if (Array.isArray(child)) fields[key] = safeResponseShape(child, depth + 1);
    else if (plainObject(child)) fields[key] = { type: 'object', fieldNames: Object.keys(child).sort().slice(0, 80) };
    else fields[key] = { type: child === null ? 'null' : typeof child };
  }
  return { type: 'object', topLevelFieldNames: Object.keys(value).sort().slice(0, 128), fields };
}

function normalizedZipMetadata(data, code, kind) {
  if (!plainObject(data)
      || (data.downloadUrl !== undefined && typeof data.downloadUrl !== 'string')
      || (data.expiresAt !== undefined && typeof data.expiresAt !== 'string')) {
    throw fail(code);
  }
  try {
    if (kind === 'files') return {
      ...data,
      ...(data.fileCount === undefined ? {} : { fileCount: normalizeFileCount(data.fileCount, code) }),
      ...(data.totalSize === undefined ? {} : { totalSize: normalizeSize(data.totalSize, code) }),
    };
    return {
      ...data,
      ...(data.sizeBytes === undefined ? {} : { sizeBytes: normalizeSize(data.sizeBytes, code) }),
    };
  } catch { throw fail(code); }
}

export function createGrokConversationFilesClient({ client, fetchSourceResolvedArtifact } = {}) {
  if (!client || typeof client.read !== 'function' || typeof client.status !== 'function') {
    throw fail('CONVERSATION_FILE_CLIENT_REQUIRED');
  }

  async function read(operationId, input, expectedOwnerScopeSha256) {
    await assertOwner(client);
    return client.read(operationId, input, {
      sourceDiscoveryPermit: `first-read:${operationId}`,
      ...(expectedOwnerScopeSha256 === undefined ? {} : { expectedOwnerScopeSha256 }),
    });
  }

  return Object.freeze({
    async listFiles(input, { expectedOwnerScopeSha256 } = {}) {
      validateInput(input);
      const result = await read(GROK_CONVERSATION_FILE_OPERATION_IDS.list, input, expectedOwnerScopeSha256);
      let data;
      try { data = requireFileList(result.data); }
      catch (error) {
        if (error?.code !== 'CONVERSATION_FILE_LIST_SHAPE_INVALID') throw error;
        throw shapeFailure('CONVERSATION_FILE_LIST_SHAPE_INVALID', result);
      }
      return {
        ...resultMetadata(result),
        path: data.path ?? null,
        nextPageToken: data.nextPageToken ?? null,
        files: data.files.map(file => ({
          name: file.name,
          path: file.path,
          isDirectory: file.isDirectory,
          size: file.size ?? null,
          mimeType: file.mimeType ?? null,
          modifiedAt: file.modifiedAt ?? null,
        })),
      };
    },

    async resolveFileContent(input, { expectedOwnerScopeSha256 } = {}) {
      validateInput(input, { pathRequired: true });
      const result = await read(GROK_CONVERSATION_FILE_OPERATION_IDS.content, input, expectedOwnerScopeSha256);
      let data;
      try { data = requireContentMetadata(result.data); }
      catch (error) {
        if (error?.code !== 'CONVERSATION_FILE_CONTENT_SHAPE_INVALID') throw error;
        throw shapeFailure('CONVERSATION_FILE_CONTENT_SHAPE_INVALID', result);
      }
      return {
        ...resultMetadata(result),
        mimeType: data.mimeType ?? null,
        size: data.size ?? null,
        isTruncated: data.isTruncated ?? null,
        dataUrlPresent: typeof data.dataUrl === 'string' && data.dataUrl.length > 0,
        signedUrlPresent: typeof data.signedUrl === 'string' && data.signedUrl.length > 0,
        downloadSignedUrlPresent: typeof data.downloadSignedUrl === 'string' && data.downloadSignedUrl.length > 0,
      };
    },

    async resolveZip(input, { expectedOwnerScopeSha256 } = {}) {
      validateInput(input, { allowEmptyPath: true });
      const result = await read(GROK_CONVERSATION_FILE_OPERATION_IDS.zip, input, expectedOwnerScopeSha256);
      let data;
      try { data = normalizedZipMetadata(result.data, 'CONVERSATION_FILE_ZIP_SHAPE_INVALID', 'files'); }
      catch (error) {
        if (error?.code !== 'CONVERSATION_FILE_ZIP_SHAPE_INVALID') throw error;
        throw shapeFailure('CONVERSATION_FILE_ZIP_SHAPE_INVALID', result);
      }
      return {
        ...resultMetadata(result),
        fileCount: data.fileCount ?? null,
        totalSize: data.totalSize ?? null,
        downloadUrlPresent: typeof data.downloadUrl === 'string' && data.downloadUrl.length > 0,
      };
    },

    async resolveWorkspaceZip(input, { expectedOwnerScopeSha256 } = {}) {
      if (!plainObject(input) || Object.keys(input).some(key => !['conversationId', 'path'].includes(key))) {
        throw fail('CONVERSATION_WORKSPACE_ZIP_INPUT_INVALID');
      }
      const conversationId = validateConversationId(input.conversationId);
      const filePath = validateFilePath(input.path, { optional: true, allowEmpty: true });
      await assertOwner(client);
      const result = await client.read(GROK_CONVERSATION_FILE_OPERATION_IDS.workspaceZip,
        { conversationId, body: filePath === undefined ? {} : { path: filePath } }, {
          sourceDiscoveryPermit: `first-read:${GROK_CONVERSATION_FILE_OPERATION_IDS.workspaceZip}`,
          ...(expectedOwnerScopeSha256 === undefined ? {} : { expectedOwnerScopeSha256 }),
        });
      let data;
      try { data = normalizedZipMetadata(result.data, 'CONVERSATION_WORKSPACE_ZIP_SHAPE_INVALID', 'workspace'); }
      catch (error) {
        if (error?.code !== 'CONVERSATION_WORKSPACE_ZIP_SHAPE_INVALID') throw error;
        throw shapeFailure('CONVERSATION_WORKSPACE_ZIP_SHAPE_INVALID', result);
      }
      return {
        ...resultMetadata(result),
        sizeBytes: data.sizeBytes ?? null,
        expiresAtPresent: typeof data.expiresAt === 'string' && data.expiresAt.length > 0,
        downloadUrlPresent: typeof data.downloadUrl === 'string' && data.downloadUrl.length > 0,
      };
    },

    async downloadFile(input, { expectedOwnerScopeSha256, outputDir, suggestedName = 'conversation-file' } = {}) {
      validateInput(input, { pathRequired: true });
      const result = await read(GROK_CONVERSATION_FILE_OPERATION_IDS.content, input, expectedOwnerScopeSha256);
      let source;
      try { source = requireContentMetadata(result.data); }
      catch (error) {
        if (error?.code !== 'CONVERSATION_FILE_CONTENT_SHAPE_INVALID') throw error;
        throw fail('CONVERSATION_FILE_CONTENT_SHAPE_INVALID', {
          status: result.status,
          contentType: result.contentType ?? null,
          responseBytes: result.responseBytes ?? null,
          requestDigest: result.requestDigest ?? null,
          responseDigest: result.rawResponseDigest ?? result.responseDigest ?? null,
          responseShape: safeResponseShape(result.data),
        });
      }
      const downloaded = await persistSourceResolvedFile({
        source,
        fetchSourceResolvedArtifact,
        outputDir,
        suggestedName,
        expectedMimeType: source.mimeType,
        expectedSize: source.size,
      });
      return { ...downloaded, resolverStatus: result.status, resolverRequestDigest: result.requestDigest,
        resolverResponseDigest: result.rawResponseDigest ?? result.responseDigest,
        resolverTransportEvidence: resultMetadata(result).transportEvidence };
    },

    async downloadZip(input, { expectedOwnerScopeSha256, expectedFileCount, expectedTotalSize,
      outputDir, suggestedName = 'conversation-files' } = {}) {
      validateInput(input);
      const resolverResult = await read(GROK_CONVERSATION_FILE_OPERATION_IDS.zip, input, expectedOwnerScopeSha256);
      let data;
      try { data = normalizedZipMetadata(resolverResult.data, 'CONVERSATION_FILE_ZIP_SHAPE_INVALID', 'files'); }
      catch (error) {
        if (error?.code !== 'CONVERSATION_FILE_ZIP_SHAPE_INVALID') throw error;
        throw shapeFailure('CONVERSATION_FILE_ZIP_SHAPE_INVALID', resolverResult);
      }
      if (typeof data.downloadUrl !== 'string' || !data.downloadUrl) {
        throw shapeFailure('CONVERSATION_FILE_ZIP_SHAPE_INVALID', resolverResult);
      }
      if (expectedFileCount !== undefined && data.fileCount !== expectedFileCount
          || expectedTotalSize !== undefined && data.totalSize !== expectedTotalSize) {
        throw fail('CONVERSATION_FILE_ZIP_METADATA_MISMATCH');
      }
      const downloaded = await persistSourceResolvedFile({
        source: { downloadUrl: data.downloadUrl },
        fetchSourceResolvedArtifact,
        outputDir,
        suggestedName,
        expectedMimeType: 'application/zip',
      });
      return { ...downloaded, resolverStatus: resolverResult.status,
        resolverRequestDigest: resolverResult.requestDigest,
        resolverResponseDigest: resolverResult.rawResponseDigest ?? resolverResult.responseDigest,
        resolverTransportEvidence: resultMetadata(resolverResult).transportEvidence,
        fileCount: data.fileCount ?? null,
        totalSize: data.totalSize ?? null };
    },

    async downloadWorkspaceZip(input, { expectedOwnerScopeSha256, outputDir, suggestedName = 'conversation-workspace' } = {}) {
      if (!plainObject(input) || Object.keys(input).some(key => !['conversationId', 'path'].includes(key))) {
        throw fail('CONVERSATION_WORKSPACE_ZIP_INPUT_INVALID');
      }
      const conversationId = validateConversationId(input.conversationId);
      const filePath = validateFilePath(input.path, { optional: true });
      await assertOwner(client);
      const resolverResult = await client.read(GROK_CONVERSATION_FILE_OPERATION_IDS.workspaceZip,
        { conversationId, body: filePath === undefined ? {} : { path: filePath } }, {
          sourceDiscoveryPermit: `first-read:${GROK_CONVERSATION_FILE_OPERATION_IDS.workspaceZip}`,
          ...(expectedOwnerScopeSha256 === undefined ? {} : { expectedOwnerScopeSha256 }),
        });
      let data;
      try { data = normalizedZipMetadata(resolverResult.data, 'CONVERSATION_WORKSPACE_ZIP_SHAPE_INVALID', 'workspace'); }
      catch (error) {
        if (error?.code !== 'CONVERSATION_WORKSPACE_ZIP_SHAPE_INVALID') throw error;
        throw shapeFailure('CONVERSATION_WORKSPACE_ZIP_SHAPE_INVALID', resolverResult);
      }
      if (typeof data.downloadUrl !== 'string' || !data.downloadUrl) {
        throw shapeFailure('CONVERSATION_WORKSPACE_ZIP_SHAPE_INVALID', resolverResult);
      }
      const downloaded = await persistSourceResolvedFile({
        source: { downloadUrl: data.downloadUrl },
        fetchSourceResolvedArtifact,
        outputDir,
        suggestedName,
        expectedMimeType: 'application/zip',
        expectedSize: data.sizeBytes,
        allowOctetStreamAsZip: true,
      });
      return { ...downloaded, resolverStatus: resolverResult.status,
        resolverRequestDigest: resolverResult.requestDigest,
        resolverResponseDigest: resolverResult.rawResponseDigest ?? resolverResult.responseDigest,
        resolverTransportEvidence: resultMetadata(resolverResult).transportEvidence };
    },
  });
}
