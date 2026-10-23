import { Worker } from 'node:worker_threads';

const ISSUER_ORIGIN = 'https://www.google.com';
const ACTION = 'VIDEO_GENERATION';
const MAX_COOKIE_COUNT = 64;
const MAX_COOKIE_VALUE_LENGTH = 16_384;
const MAX_SITE_KEY_LENGTH = 512;
const SAFE_WORKER_ERRNOS = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'ABORT_ERR']);
// Worker startup can be slow on the constrained Windows host while jsdom is
// loading. Keep an explicit upper bound; SDK execution itself remains 45s.
const DEFAULT_ISSUER_TIMEOUT_MS = 90_000;
const SAFE_RECEIPT_KEYS = Object.freeze([
  'mode', 'nodeVersion', 'jsdomVersion', 'siteKeyFromCurrentFlowDocument', 'cookieValuesRecorded',
  'tokenValuesRecorded', 'browserEngineUsed', 'browserSignalsOverridden', 'sdkSourceModified',
  'stage', 'workerStage', 'failureCode', 'elapsedMs', 'workerOnline', 'workerErrorName', 'workerErrorCode', 'workerErrorFrames', 'blockedRequests',
  'loader', 'runtime', 'anchor', 'worker', 'execute', 'reload', 'clear', 'runtimeError', 'networkBlockedCount',
  'startedAt', 'completedAt',
]);

function failure(code, message = 'Node reCAPTCHA issuer failed.') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validTime(cookie, nowSeconds) {
  const expires = cookie.expires ?? cookie.expirationDate;
  if (expires === undefined || expires === null || expires === -1) return cookie.session === true || expires === -1;
  return Number.isFinite(Number(expires)) && Number(expires) > nowSeconds;
}

function scopedCookies(transport, now) {
  const cookies = transport?.bundle?.cookies;
  if (!Array.isArray(cookies) || cookies.length > MAX_COOKIE_COUNT) {
    throw failure('FLOW_NODE_ISSUER_SESSION_UNAVAILABLE', 'The started Flow transport has no scoped cookie bundle.');
  }
  const nowSeconds = now / 1000;
  const result = cookies.filter(cookie => {
    const domain = typeof cookie?.domain === 'string' ? cookie.domain.toLowerCase().replace(/^\./, '') : '';
    return domain === 'google.com' && (cookie.hostOnly === false
        || (!Object.hasOwn(cookie, 'hostOnly') && typeof cookie.domain === 'string' && cookie.domain.startsWith('.')))
      && typeof cookie.name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,100}$/.test(cookie.name)
      && typeof cookie.value === 'string' && cookie.value.length <= MAX_COOKIE_VALUE_LENGTH
      && !/[;\r\n\0]/.test(cookie.value)
      && typeof cookie.path === 'string' && cookie.path.startsWith('/')
      && typeof cookie.secure === 'boolean' && validTime(cookie, nowSeconds);
  }).map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: '.google.com',
    hostOnly: false,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly === true,
    ...(typeof cookie.sameSite === 'string' ? { sameSite: cookie.sameSite } : {}),
    ...(Number.isFinite(Number(cookie.expires ?? cookie.expirationDate))
      && Number(cookie.expires ?? cookie.expirationDate) > 0
      ? { expires: Number(cookie.expires ?? cookie.expirationDate) } : { session: true }),
  }));
  if (result.length === 0) {
    throw failure('FLOW_NODE_ISSUER_COOKIE_SCOPE', 'The started Flow transport has no shared Google cookies.');
  }
  return result;
}

function sanitizeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const safe = {};
  for (const key of SAFE_RECEIPT_KEYS) {
    const value = receipt[key];
    if (key === 'failureCode') {
      if (typeof value === 'string' && /^FLOW_NODE_ISSUER_[A-Z0-9_]{1,80}$/.test(value)) safe[key] = value;
      continue;
    }
    if (key === 'stage' || key === 'workerStage') {
      if (typeof value === 'string' && /^[a-z][a-z0-9_]{0,48}$/.test(value)) safe[key] = value;
      continue;
    }
    if (key === 'elapsedMs') {
      if (Number.isInteger(value) && value >= 0 && value <= 120_000) safe[key] = value;
      continue;
    }
    if (key === 'workerOnline') {
      if (typeof value === 'boolean') safe[key] = value;
      continue;
    }
    if (key === 'workerErrorName') {
      if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError'].includes(value)) safe[key] = value;
      continue;
    }
    if (key === 'workerErrorCode') {
      if (typeof value === 'string' && /^(?:ERR_[A-Z0-9_]{1,64}|FLOW_NODE_ISSUER_[A-Z0-9_]{1,80})$/.test(value)) safe[key] = value;
      continue;
    }
    if (key === 'workerErrorFrames') {
      if (Array.isArray(value)) safe[key] = sanitizeErrorFrames(value);
      continue;
    }
    if (key === 'blockedRequests') {
      if (Array.isArray(value)) safe[key] = sanitizeBlockedRequests(value);
      continue;
    }
    if (key === 'loader' || key === 'runtime' || key === 'anchor' || key === 'worker'
      || key === 'execute' || key === 'reload' || key === 'clear' || key === 'runtimeError') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const clean = {};
        for (const [childKey, childValue] of Object.entries(value)) {
          if (!/^(?:host|path|method|status|mime|bytes|locale|sdkVersion|sha256|scriptStatus|scriptBytes|scriptSha256|runtimeStatus|runtimeBytes|runtimeSha256|queryKeyCount|configuredKeyMatches|hiddenTokenPresent|constructed|initialized|sourceModified|callCount|returnedNonemptyToken|returnedTokenLength|matchesReloadReply|postCount|requestBytes|responseBytes|decodedResponseBytes|responseSchemaValid|sdkVersionMatchesAnchor|anchorTokenMatchesRequest|actionMatches|siteKeyMatches|outcomeUncertain|sendFinishedAt|responseEndedAt|name|category|missingProperty|missingConstructor|missingFunction|sourceHost|sourcePath|sourceLine|errorName|errorCode|exitCode|frames)$/.test(childKey)) continue;
          if (childKey === 'frames') {
            if (Array.isArray(childValue)) clean.frames = sanitizeErrorFrames(childValue);
            continue;
          }
          if ((typeof childValue === 'string' && childValue.length <= 160
            && (!childKey.toLowerCase().includes('sha256') || /^[a-f0-9]{64}$/.test(childValue))
            && (!['path', 'sourcePath'].includes(childKey) || /^\/[A-Za-z0-9_./-]{0,160}$/.test(childValue))
            && (childKey !== 'sourceHost' || ['www.google.com', 'www.gstatic.com'].includes(childValue))
            && (childKey !== 'name' || /^(?:Error|SyntaxError)$/.test(childValue))
            && (childKey !== 'errorName' || /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError)$/.test(childValue))
            && (childKey !== 'errorCode' || safeWorkerErrorCode(childValue))
            && (childKey !== 'category' || /^(?:message_transfer|message_origin|network|relative_url|syntax|missing_capability|unclassified)$/.test(childValue))
            && (childKey !== 'missingProperty' || /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(childValue))
            && (!childKey.endsWith('At') || Number.isFinite(Date.parse(childValue)))
          ) || typeof childValue === 'boolean'
          || (Number.isInteger(childValue) && childValue >= 0 && childValue <= 10_000_000)) clean[childKey] = childValue;
        }
        safe[key] = clean;
      }
      continue;
    }
    if (typeof value === 'string' && value.length <= 160
      || typeof value === 'boolean'
      || Number.isInteger(value) && value >= 0 && value <= 10_000_000) safe[key] = value;
  }
  return safe;
}

function safeWorkerCode(value) {
  return typeof value === 'string' && /^FLOW_NODE_ISSUER_[A-Z0-9_]{1,80}$/.test(value)
    ? value : 'FLOW_NODE_ISSUER_WORKER_FAILED';
}

function safeWorkerErrorCode(value) {
  return typeof value === 'string' && (SAFE_WORKER_ERRNOS.has(value)
    || /^(?:ERR_[A-Z0-9_]{1,64}|FLOW_NODE_ISSUER_[A-Z0-9_]{1,80})$/.test(value))
    ? value : null;
}

function sanitizeErrorFrames(frames) {
  if (!Array.isArray(frames)) return [];
  return frames.slice(0, 5).map(frame => ({
    functionIdentifier: typeof frame?.functionIdentifier === 'string'
        && /^[A-Za-z0-9_.$<>-]{1,120}$/.test(frame.functionIdentifier) ? frame.functionIdentifier : null,
    moduleBasename: typeof frame?.moduleBasename === 'string'
        && /^[A-Za-z0-9_.-]{1,100}\.(?:js|mjs|cjs)$/.test(frame.moduleBasename) ? frame.moduleBasename : null,
  }));
}

function sanitizeBlockedRequests(items) {
  const reasonKeys = ['unparsed', 'nonHttps', 'nonDefaultPort', 'hasAuth', 'pathNotAllowlisted', 'methodNotAllowed',
    'nonstandardAgent', 'customConnection', 'customSocketPath', 'customLookup', 'customNetworkBinding',
    'customTlsIdentity', 'unexpectedServername'];
  const optionKeys = new Set(['defaultPort', 'keepAlive', 'keepAliveMsecs', 'maxFreeSockets', 'maxSockets',
    'maxTotalSockets', 'noDelay', 'path', 'protocol', 'rejectUnauthorized', 'timeout', 'other']);
  const reasonNames = new Set(['unparsed', 'non_https', 'non_default_port', 'has_auth', 'path_not_allowlisted',
    'method_not_allowed', 'nonstandard_agent', 'custom_connection', 'custom_socket_path', 'custom_lookup',
    'custom_network_binding', 'custom_tls_identity', 'unexpected_servername', 'other']);
  if (!Array.isArray(items)) return [];
  return items.slice(0, 12).map(item => {
    const path = typeof item?.path === 'string' && (
      /^\/recaptcha\/enterprise\/(?:anchor|webworker\.js|reload)$/.test(item.path)
      || /^\/recaptcha\/releases\/[A-Za-z0-9_-]{1,80}\/(?:recaptcha__(?:en|ko)\.js|styles__(?:ltr|rtl)\.css)$/.test(item.path)
    ) ? item.path : '/other';
    const reasons = {};
    for (const key of reasonKeys) if (typeof item?.reasons?.[key] === 'boolean') reasons[key] = item.reasons[key];
    const agent = item?.agent && typeof item.agent === 'object' ? {
      className: ['none', 'https.Agent', 'http.Agent', 'other'].includes(item.agent.className) ? item.agent.className : 'other',
      optionKeys: Array.isArray(item.agent.optionKeys) ? item.agent.optionKeys.slice(0, 12)
        .map(key => typeof key === 'string' && optionKeys.has(key) ? key : 'other') : [],
      optionKeyCount: Number.isInteger(item.agent.optionKeyCount) && item.agent.optionKeyCount >= 0 && item.agent.optionKeyCount <= 32
        ? item.agent.optionKeyCount : 0,
      prototypeNative: item.agent.prototypeNative === true,
      createConnectionNative: item.agent.createConnectionNative === true,
      ownCreateConnection: item.agent.ownCreateConnection === true,
      optionsNullPrototype: item.agent.optionsNullPrototype === true,
      keepAlive: typeof item.agent.keepAlive === 'boolean' ? item.agent.keepAlive : null,
      rejectUnauthorized: typeof item.agent.rejectUnauthorized === 'boolean' ? item.agent.rejectUnauthorized : null,
      defaultPortExpected: item.agent.defaultPortExpected === true,
      protocolHttps: item.agent.protocolHttps === true,
      noDelay: item.agent.noDelay === true,
      pathNull: item.agent.pathNull === true,
    } : undefined;
    const itemOut = {
      host: ['www.google.com', 'www.gstatic.com', 'other'].includes(item?.host) ? item.host : 'other',
      path,
      method: typeof item?.method === 'string' && /^[A-Z]{3,10}$/.test(item.method) ? item.method : 'OTHER',
      reason: typeof item?.reason === 'string' && reasonNames.has(item.reason) ? item.reason : 'other',
      reasons,
    };
    if (agent) itemOut.agent = agent;
    return itemOut;
  });
}

function safeWorkerFrames(error) {
  return sanitizeErrorFrames(String(error?.stack || '').split(/\r?\n/).slice(1, 6).map(line => ({
    functionIdentifier: /\bat\s+(?:async\s+)?([A-Za-z0-9_.$<>-]{1,120})(?:\s|\()/.exec(line)?.[1] || null,
    moduleBasename: /(?:^|[\\/])([A-Za-z0-9_.-]+\.(?:js|mjs|cjs)):\d+:\d+/.exec(line)?.[1] || null,
  })));
}

/**
 * A lazy provider for the unmodified public Google reCAPTCHA Enterprise SDK.
 * Call acquire only after FlowHttpTransport.start() and the caller's baseline
 * project read. The issuer worker receives the in-memory scoped cookie snapshot
 * and current public site key; it never reloads Flow credentials from DPAPI.
 */
export function createNodeRecaptchaProvider({
  transport,
  WorkerImpl = Worker,
  clock = Date.now,
  timeoutMs = DEFAULT_ISSUER_TIMEOUT_MS,
} = {}) {
  if (!transport || typeof WorkerImpl !== 'function' || typeof clock !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 90_000) {
    throw new TypeError('Node reCAPTCHA provider dependencies are invalid.');
  }
  let acquired = false;
  let lastReceipt = null;

  return Object.freeze({
    mode: 'pure_http',
    issuerOrigin: ISSUER_ORIGIN,
    getLastReceipt() { return lastReceipt ? structuredClone(lastReceipt) : null; },
    async acquire(request) {
      if (acquired) throw failure('FLOW_NODE_ISSUER_ALREADY_USED');
      acquired = true;
      if (request?.mode !== 'pure_http' || request.issuerOrigin !== ISSUER_ORIGIN || request.action !== ACTION
        || !request.binding || request.binding.projectId?.toLowerCase() !== transport.bundle?.projectId?.toLowerCase()) {
        throw failure('FLOW_NODE_ISSUER_BINDING_INVALID');
      }
      const siteKey = transport.document?.siteKey;
      if (typeof siteKey !== 'string' || !siteKey.trim() || siteKey.length > MAX_SITE_KEY_LENGTH
        || /[\r\n\0]/.test(siteKey)) {
        throw failure('FLOW_NODE_ISSUER_SITE_KEY_UNAVAILABLE', 'The current Flow document has no usable public site key.');
      }
      const startedAt = clock();
      if (!Number.isFinite(startedAt)) throw failure('FLOW_NODE_ISSUER_CLOCK_INVALID');
      const cookies = scopedCookies(transport, startedAt);
      const receiptStartedAt = clock();
      lastReceipt = {
        mode: 'node_jsdom_unmodified_sdk',
        nodeVersion: process.version,
        jsdomVersion: '26.1.0',
        siteKeyFromCurrentFlowDocument: true,
        cookieValuesRecorded: false,
        tokenValuesRecorded: false,
        browserEngineUsed: false,
        browserSignalsOverridden: false,
        sdkSourceModified: false,
        stage: 'worker_created',
        workerStage: 'worker_not_started',
        failureCode: null,
        elapsedMs: 0,
        workerOnline: false,
      };

      let worker;
      try {
        worker = new WorkerImpl(new URL('./recaptcha-node-issuer-worker.mjs', import.meta.url), {
          workerData: { siteKey, projectId: request.binding.projectId, cookies },
          resourceLimits: { maxOldGenerationSizeMb: 384, stackSizeMb: 8 },
        });
      } catch {
        lastReceipt = { ...lastReceipt, stage: 'worker_create_failed', failureCode: 'FLOW_NODE_ISSUER_WORKER_FAILED',
          elapsedMs: Math.max(0, Math.min(120_000, Math.round(clock() - receiptStartedAt))) };
        throw failure('FLOW_NODE_ISSUER_WORKER_FAILED');
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        let workerOnline = false;
        const elapsed = () => Math.max(0, Math.min(120_000, Math.round(clock() - receiptStartedAt)));
        const updateParentReceipt = ({ stage, workerStage, failureCode, workerErrorName, workerErrorCode, workerErrorFrames } = {}) => {
          lastReceipt = {
            ...lastReceipt,
            ...(stage ? { stage } : {}),
            ...(workerStage ? { workerStage } : {}),
            ...(failureCode ? { failureCode: safeWorkerCode(failureCode) } : {}),
            ...(workerErrorName && ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError'].includes(workerErrorName)
              ? { workerErrorName } : {}),
            ...(safeWorkerErrorCode(workerErrorCode) ? { workerErrorCode: safeWorkerErrorCode(workerErrorCode) } : {}),
            ...(Array.isArray(workerErrorFrames) ? { workerErrorFrames: sanitizeErrorFrames(workerErrorFrames) } : {}),
            elapsedMs: elapsed(),
            workerOnline,
          };
        };
        const timer = setTimeout(() => finish(failure('FLOW_NODE_ISSUER_TIMEOUT'), undefined, 'timed_out'), timeoutMs);
        const finish = (error, result, failureStage, failureDetails = {}) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) updateParentReceipt({ stage: failureStage || (error.code === 'FLOW_NODE_ISSUER_TIMEOUT' ? 'timed_out' : 'failed'), failureCode: error.code, ...failureDetails });
          Promise.resolve(worker.terminate()).catch(() => {});
          if (error) reject(error);
          else resolve(result);
        };
        worker.on('online', () => {
          workerOnline = true;
          updateParentReceipt({ stage: 'worker_online' });
        });
        worker.on('message', packet => {
          if (packet?.kind === 'receipt') {
            const receipt = sanitizeReceipt(packet.receipt);
            if (receipt) {
              lastReceipt = { ...lastReceipt, ...receipt, workerOnline };
              updateParentReceipt({ workerStage: receipt.stage, stage: receipt.stage || lastReceipt.stage });
            }
            return;
          }
          if (packet?.kind === 'failed') {
            finish(failure(safeWorkerCode(packet.code)), undefined, 'worker_failed');
            return;
          }
          if (packet?.kind !== 'issued') return;
          const token = packet.token;
          const issuedAt = packet.issuedAt;
          if (typeof token !== 'string' || !token.trim() || token.length > 8_192 || /[\r\n\0]/.test(token)
            || !Number.isFinite(issuedAt) || issuedAt > clock() + 5_000 || issuedAt < clock() - 120_000) {
            finish(failure('FLOW_NODE_ISSUER_RESULT_INVALID'));
            return;
          }
          const receipt = sanitizeReceipt(packet.receipt);
          if (receipt) {
            lastReceipt = { ...lastReceipt, ...receipt, workerOnline };
            updateParentReceipt({ workerStage: receipt.stage, stage: receipt.stage || lastReceipt.stage });
          }
          if (!receipt || receipt.siteKeyFromCurrentFlowDocument !== true
            || receipt.browserEngineUsed !== false || receipt.browserSignalsOverridden !== false
            || receipt.sdkSourceModified !== false || receipt.execute?.callCount !== 1
            || receipt.execute?.returnedNonemptyToken !== true || receipt.execute?.matchesReloadReply !== true
            || receipt.reload?.postCount !== 1 || receipt.reload?.status !== 200
            || receipt.reload?.responseSchemaValid !== true || receipt.anchor?.configuredKeyMatches !== true
            || receipt.anchor?.hiddenTokenPresent !== true) {
            finish(failure('FLOW_NODE_ISSUER_RECEIPT_UNVERIFIED'));
            return;
          }
          finish(null, {
            mode: 'pure_http',
            issuerOrigin: ISSUER_ORIGIN,
            action: ACTION,
            binding: request.binding,
            token,
            issuedAt,
            // Local freshness ceiling required by generation-input; not a claim about server token TTL.
            expiresAt: issuedAt + 120_000,
            oneTime: true,
          });
        });
        worker.on('error', error => finish(failure('FLOW_NODE_ISSUER_WORKER_FAILED'), undefined, 'worker_error', {
          workerErrorName: error?.name,
          workerErrorCode: safeWorkerErrorCode(error?.code) || safeWorkerErrorCode(error?.message),
          workerErrorFrames: safeWorkerFrames(error),
        }));
        worker.on('exit', code => {
          if (!settled) finish(failure(code === 0 ? 'FLOW_NODE_ISSUER_RESULT_MISSING' : 'FLOW_NODE_ISSUER_WORKER_FAILED'), undefined, 'worker_exited');
        });
      });
    },
  });
}

export const NODE_RECAPTCHA_ISSUER_ORIGIN = ISSUER_ORIGIN;
export const NODE_RECAPTCHA_ACTION = ACTION;
