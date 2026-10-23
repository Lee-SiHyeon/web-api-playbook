import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';
import { isChromeCompatibleFetch } from './chrome-http-fetch.mjs';

export const publicModelsEvidence = Object.freeze({
  operationId: 'public.models',
  method: 'POST',
  url: 'https://grok.com/rest/models',
  requestBody: Object.freeze({ locale: 'en' }),
  sourceFile: 'https://cdn.grok.com/_next/static/chunks/35ntlely29ab3.js',
  sourceFunction: 'modelsGetModelsRaw',
  sourceSha256: 'da50d0a6eedb65fa5f5ba402e96b3d9349e586855f07de34a3a21bf9b1b0f316',
  directReplay: Object.freeze({
    observedAt: '2026-10-03',
    status: 200,
    responseContentType: 'application/json',
    responseBytes: 898,
    responseSha256: '7b751e71ddb6a5e035763763736374683fae683abe45d519fda6d6ec69ad37ce',
    availableModelIds: Object.freeze(['grok-3', 'grok-420', 'grok-4-1-thinking-1129']),
    unavailableModelCount: 0,
    credentialFree: true,
    browserCaptured: false,
  }),
});

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOP_LEVEL_KEYS = new Set([
  'models', 'unavailableModels',
  'defaultAnonModel', 'defaultFreeModel', 'defaultProModel', 'defaultHeavyModel',
  'defaultAnonMode', 'defaultFreeMode', 'defaultProMode', 'defaultHeavyMode',
]);
const DEFAULT_FIELDS = [
  'defaultAnonModel', 'defaultFreeModel', 'defaultProModel', 'defaultHeavyModel',
  'defaultAnonMode', 'defaultFreeMode', 'defaultProMode', 'defaultHeavyMode',
];
const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedMime(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

async function readBounded(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isSafeInteger(n) || n < 0 || n > maxBytes) throw fail('PUBLIC_MODELS_SIZE_LIMIT');
  }
  if (!response.body) throw fail('PUBLIC_MODELS_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) throw fail('PUBLIC_MODELS_SIZE_LIMIT');
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error?.code === 'PUBLIC_MODELS_SIZE_LIMIT') throw error;
    throw fail('PUBLIC_MODELS_BODY_READ_FAILED');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function parseModelsPayload(value) {
  if (!isObject(value) || Object.keys(value).length !== TOP_LEVEL_KEYS.size
    || Object.keys(value).some(key => !TOP_LEVEL_KEYS.has(key))) throw fail('PUBLIC_MODELS_SCHEMA_INVALID');
  if (!Array.isArray(value.models) || !Array.isArray(value.unavailableModels)
    || value.models.length > 500 || value.unavailableModels.length > 500) throw fail('PUBLIC_MODELS_SCHEMA_INVALID');
  const model = (item, index, group) => {
    if (!isObject(item) || typeof item.modelId !== 'string' || !MODEL_ID.test(item.modelId)) {
      throw fail('PUBLIC_MODELS_SCHEMA_INVALID', { group, index });
    }
    if ((item.name !== undefined && typeof item.name !== 'string')
      || (item.description !== undefined && typeof item.description !== 'string')) {
      throw fail('PUBLIC_MODELS_SCHEMA_INVALID', { group, index });
    }
    return {
      modelId: item.modelId,
      name: typeof item.name === 'string' ? item.name.slice(0, 512) : '',
      description: typeof item.description === 'string' ? item.description.slice(0, 4096) : '',
    };
  };
  for (const key of DEFAULT_FIELDS) {
    if (typeof value[key] !== 'string' || !MODEL_ID.test(value[key])) throw fail('PUBLIC_MODELS_SCHEMA_INVALID', { field: key });
  }
  const models = value.models.map((item, index) => model(item, index, 'available'));
  const unavailableModels = value.unavailableModels.map((item, index) => model(item, index, 'unavailable'));
  if (new Set(models.map(item => item.modelId)).size !== models.length
    || new Set(unavailableModels.map(item => item.modelId)).size !== unavailableModels.length) {
    throw fail('PUBLIC_MODELS_SCHEMA_INVALID');
  }
  for (const key of DEFAULT_FIELDS.filter(field => field.endsWith('Mode'))) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value[key])) throw fail('PUBLIC_MODELS_SCHEMA_INVALID', { field: key });
  }
  return {
    models,
    unavailableModels,
    defaults: Object.fromEntries(DEFAULT_FIELDS.map(key => [key, value[key]])),
  };
}

export async function fetchPublicModels({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw fail('PUBLIC_MODELS_OPTIONS_INVALID');
  }
  let response;
  try {
    response = await fetchImpl(publicModelsEvidence.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(publicModelsEvidence.requestBody),
      credentials: 'omit',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw fail('PUBLIC_MODELS_TRANSPORT_FAILED');
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw fail('PUBLIC_MODELS_STATUS_UNEXPECTED', { status: response.status });
  }
  if (normalizedMime(response.headers.get('content-type')) !== 'application/json') {
    await response.body?.cancel().catch(() => {});
    throw fail('PUBLIC_MODELS_MIME_UNEXPECTED');
  }
  const bytes = await readBounded(response, DEFAULT_MAX_BYTES);
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw fail('PUBLIC_MODELS_JSON_INVALID');
  }
  const data = parseModelsPayload(payload);
  return {
    data,
    evidence: {
      operationId: publicModelsEvidence.operationId,
      sourceDerived: true,
      browserCaptured: false,
      transport: fetchImpl === globalThis.fetch ? 'node_fetch'
        : isChromeCompatibleFetch(fetchImpl) ? 'curl_cffi_chrome150_linux' : 'injected_fetch',
      credentialPropagated: 'not_applicable',
      credentialsUsed: false,
      directReadVerified: true,
      requestSucceeded: true,
      liveReplay: fetchImpl === globalThis.fetch || isChromeCompatibleFetch(fetchImpl),
      liveResponseStatus: response.status,
      httpVersion: response.transportEvidence?.httpVersion ?? null,
      liveResponseBytes: bytes.length,
      liveResponseSha256: createHash('sha256').update(bytes).digest('hex'),
      sourceFile: publicModelsEvidence.sourceFile,
      sourceFunction: publicModelsEvidence.sourceFunction,
      sourceSha256: publicModelsEvidence.sourceSha256,
      priorDirectReplay: { ...publicModelsEvidence.directReplay, availableModelIds: [...publicModelsEvidence.directReplay.availableModelIds] },
    },
  };
}
