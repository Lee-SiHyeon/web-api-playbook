// Fresh-process Coupang Partners check. Windows keeps DPAPI defaults; Linux
// requires an explicit process-memory provider and never persists session state.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  issueCoupangLink, normalizeCoupangProductUrl, safeCoupangLinkReceipt,
} from '../adapters/coupang-partners-link.mjs';
import { createCoupangAuth } from '../../../../../lib/web-auth/coupang.mjs';
import { ScopedSession } from '../../../../../lib/scoped-session.mjs';
import { ProtectedStore } from '../../../../../lib/protected-store.mjs';
import { withSessionLock } from '../../../../../lib/session-lock.mjs';
import { coupangForbiddenCode } from '../../../../../lib/web-auth/coupang-response.mjs';
import {
  assertCoupangOwnerBinding,
  COUPANG_AUTH_COOKIE_NAMES,
  COUPANG_PARTNERS_ORIGIN,
  COUPANG_ROUTING_COOKIE_NAMES,
  createCoupangServiceFetch,
  verifyCoupangBoundOwner,
} from '../../../../../lib/web-auth/coupang-attested-session.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const STATE_NAME = 'coupang-web-state';
const MAX_STATE_BYTES = 1024 * 1024;
const PARTNERS_ORIGIN = 'https://partners.coupang.com';
const LEGACY_ORIGINS = [PARTNERS_ORIGIN, 'https://login.coupang.com'];
const ATTESTED_ORIGINS = [COUPANG_PARTNERS_ORIGIN];
const MEMORY_STATE_ROOT = path.join(os.homedir(), '.nad-scratch', 'web-api-playbook', 'coupang-partners');
const MEMORY_LINK_CACHE = 'links.json';
const MEMORY_LINK_JOURNAL = 'link-operations.json';
const ROOT_KEYS_V1 = new Set(['version', 'email', 'affiliateCode', 'session', 'updatedAt']);
const ROOT_KEYS_V2 = new Set([...ROOT_KEYS_V1, 'ownerBinding']);
const SESSION_KEYS = new Set([
  'version', 'allowedOrigins', 'cookieOrigins', 'allowLoopbackHttp', 'defaultHeaders',
  'headersByOrigin', 'cookieJar', 'timeoutMs', 'maxResponseBytes', 'maxRequestBytes', 'maxRedirects',
]);
const SAFE_DEFAULT_HEADER_NAMES = new Set(['user-agent']);
const SAFE_ORIGIN_HEADER_NAMES = new Set(['accept', 'referer', 'lang', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code) { throw coded(code); }

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && !/[\u0000-\u0020\u007f]/.test(value)
    && /^[^@]+@[^@]+\.[^@]+$/.test(value);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function validHeaders(value, allowedNames) {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || Object.keys(value).length > 16) return false;
  return Object.entries(value).every(([name, content]) => allowedNames.has(name.toLowerCase())
    && typeof content === 'string' && content.length <= 4096 && !/[\r\n\0]/.test(content));
}

function validOriginHeaders(value, origins) {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || Object.keys(value).length > origins.length) return false;
  return Object.entries(value).every(([origin, headers]) => origins.includes(origin)
    && validHeaders(headers, SAFE_ORIGIN_HEADER_NAMES));
}

/** Validate the protected record's bounded shape before putting it in process memory. */
export function validateCoupangProtectedStateRecord(value) {
  if (!isRecord(value) || ![1, 2].includes(value.version)) fail('COUPANG_STATE_RECORD_INVALID');
  const allowedRootKeys = value.version === 1 ? ROOT_KEYS_V1 : ROOT_KEYS_V2;
  if (!onlyKeys(value, allowedRootKeys) || !validEmail(value.email)
      || typeof value.affiliateCode !== 'string' || !value.affiliateCode.trim()
      || value.affiliateCode.length > 256 || /[\u0000-\u001f\u007f]/.test(value.affiliateCode)
      || !isRecord(value.session) || !onlyKeys(value.session, SESSION_KEYS)) {
    fail('COUPANG_STATE_RECORD_INVALID');
  }
  if (value.version === 2 && !isRecord(value.ownerBinding)) fail('COUPANG_STATE_RECORD_INVALID');
  if (value.version === 1 && Object.hasOwn(value, 'ownerBinding')) fail('COUPANG_STATE_RECORD_INVALID');
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string'
      || value.updatedAt.length > 80 || !Number.isFinite(Date.parse(value.updatedAt)))) {
    fail('COUPANG_STATE_RECORD_INVALID');
  }

  const expectedOrigins = value.version === 1 ? LEGACY_ORIGINS : ATTESTED_ORIGINS;
  const session = value.session;
  if (session.version !== 1 || session.allowLoopbackHttp !== false
      || JSON.stringify(session.allowedOrigins) !== JSON.stringify(expectedOrigins)
      || JSON.stringify(session.cookieOrigins) !== JSON.stringify(expectedOrigins)
      || !isRecord(session.cookieJar) || !Array.isArray(session.cookieJar.cookies)
      || session.cookieJar.cookies.length < 1 || session.cookieJar.cookies.length > 1024) {
    fail('COUPANG_STATE_RECORD_INVALID');
  }
  if (!validHeaders(session.defaultHeaders, SAFE_DEFAULT_HEADER_NAMES)
      || !validOriginHeaders(session.headersByOrigin, expectedOrigins)) fail('COUPANG_STATE_RECORD_INVALID');
  for (const cookie of session.cookieJar.cookies) {
    if (!isRecord(cookie) || typeof cookie.key !== 'string'
        || !(cookie.value === undefined || typeof cookie.value === 'string')) {
      fail('COUPANG_STATE_RECORD_INVALID');
    }
  }
  return value;
}

export async function readCoupangProtectedStateFromStdin(stream = process.stdin) {
  if (stream.isTTY) fail('COUPANG_STATE_STDIN_MUST_BE_PIPED');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_STATE_BYTES) fail('COUPANG_STATE_STDIN_TOO_LARGE');
    chunks.push(buffer);
  }
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { fail('COUPANG_STATE_RECORD_INVALID'); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('COUPANG_STATE_RECORD_INVALID'); }
  return validateCoupangProtectedStateRecord(parsed);
}

export function createCoupangLinkDependencies(store, fetchImpl = globalThis.fetch) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    fail('COUPANG_STORE_PROVIDER_INVALID');
  }
  const serviceFetch = createCoupangServiceFetch(fetchImpl);
  return {
    store,
    sessionFromJSON: state => ScopedSession.fromJSON(state.session, { fetchImpl: serviceFetch }),
    withSessionLock,
    coupangForbiddenCode,
    createCoupangServiceFetch,
    attestedCookieNames: [...COUPANG_AUTH_COOKIE_NAMES, ...COUPANG_ROUTING_COOKIE_NAMES],
    assertCoupangOwnerBinding,
    verifyCoupangBoundOwner,
  };
}

function providerLabel(store, selectedProvider) {
  try {
    const status = store?.status?.(STATE_NAME);
    if (status?.provider === 'process-memory') return 'process-memory';
    if (status?.provider === 'Windows DPAPI CurrentUser') return 'windows_dpapi_current_user';
  } catch { /* provider failures are reported by the auth/read path */ }
  if (selectedProvider === 'memory') return 'process-memory';
  if (selectedProvider === 'dpapi') return 'windows_dpapi_current_user';
  return 'unavailable';
}

function authStatus(code) {
  if (code === 'SESSION_MISSING') return 'session_missing';
  if (code === 'PROTECTED_STORE_PROVIDER_REQUIRED') return 'provider_required';
  if (code === 'PROTECTED_STORE_PROVIDER_UNSUPPORTED') return 'provider_unsupported';
  if (['AUTH_STATE_INVALID', 'SCOPED_SESSION_STATE_INVALID', 'COUPANG_OWNER_BINDING_INVALID', 'COUPANG_ATTESTATION_INVALID', 'COUPANG_STATE_RECORD_INVALID'].includes(code)) return 'invalid_session';
  if (['REAUTH_REQUIRED', 'COUPANG_REAUTH_REQUIRED'].includes(code)) return 'reauth_required';
  if (['OWNER_MISMATCH', 'COUPANG_OWNER_MISMATCH'].includes(code)) return 'owner_mismatch';
  if (['COUPANG_HTTP_ACCESS_DENIED', 'AUTH_FORBIDDEN'].includes(code)) return 'access_denied';
  if (['AUTH_THROTTLED', 'COUPANG_AUTH_THROTTLED'].includes(code)) return 'throttled';
  if (code === 'COUPANG_LINK_OUTCOME_UNCERTAIN') return 'outcome_unknown';
  if (code === 'COUPANG_LINK_ATTRIBUTION_UNVERIFIED') return 'attribution_unverified';
  return 'failed';
}

function latestHttpStatus(requests) {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    if (Number.isSafeInteger(requests[index].httpStatus)) return requests[index].httpStatus;
  }
  return 0;
}

function memoryStateDirectory(input) {
  const directory = path.resolve(input ?? MEMORY_STATE_ROOT);
  const relative = path.relative(REPO_ROOT, directory);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) fail('COUPANG_MEMORY_STATE_DIRECTORY_UNSAFE');
  return directory;
}

async function ensurePrivateMemoryDirectory(directory) {
  let target = memoryStateDirectory(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  target = await import('node:fs/promises').then(({ realpath }) => realpath(target));
  const relative = path.relative(REPO_ROOT, target);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) fail('COUPANG_MEMORY_STATE_DIRECTORY_UNSAFE');
  return target;
}

function privateFilePath(directory, value, fallback) {
  const target = path.resolve(value ?? path.join(directory, fallback));
  const relative = path.relative(directory, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('COUPANG_LINK_STATE_PATH_UNSAFE');
  return target;
}

async function safeMemoryFile(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  try {
    const stat = await import('node:fs/promises').then(({ lstat }) => lstat(file));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('COUPANG_LINK_STATE_FILE_INVALID');
    if ((stat.mode & 0o077) !== 0) await chmod(file, 0o600);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('COUPANG_LINK_STATE_FILE_INVALID');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error?.code && /^[A-Z0-9_]+$/.test(error.code)) throw error;
    fail('COUPANG_LINK_STATE_FILE_INVALID');
  }
}

export function safeCoupangProviderFailure(error) {
  if (!['PROTECTED_STORE_READ_FAILED', 'PROTECTED_STORE_OPERATION_FAILED'].includes(error?.code)) return null;
  const detail = error?.detail;
  return {
    stage: /^[a-z-]{1,32}$/.test(detail?.stage ?? '') ? detail.stage : null,
    timedOut: detail?.timedOut === true,
    exitStatus: Number.isInteger(detail?.exitStatus) && detail.exitStatus >= 0 && detail.exitStatus <= 255
      ? detail.exitStatus : null,
  };
}

function makeObservedFetch(requests, fetchImpl) {
  return async (input, init = {}) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input); }
    catch { fail('COUPANG_REQUEST_URL_INVALID'); }
    const row = { origin: url.origin, path: url.pathname, method: init.method ?? 'GET' };
    requests.push(row);
    const response = await fetchImpl(input, init);
    row.httpStatus = response.status;
    if (url.origin === PARTNERS_ORIGIN) {
      const sent = new Map((new Headers(init.headers).get('cookie') ?? '').split(';').map(part => {
        const separator = part.indexOf('=');
        return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
      }));
      row.changedCookieNames = (response.headers.getSetCookie?.() ?? []).flatMap(part => {
        const pair = part.split(';', 1)[0];
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator).trim();
        return sent.has(name) && sent.get(name) !== pair.slice(separator + 1).trim() ? [name] : [];
      });
    }
    return response;
  };
}

function linkDependenciesUseStore(dependencies, store) {
  return dependencies?.store === store
    && typeof dependencies.sessionFromJSON === 'function'
    && typeof dependencies.withSessionLock === 'function'
    && typeof dependencies.coupangForbiddenCode === 'function'
    && typeof dependencies.createCoupangServiceFetch === 'function'
    && typeof dependencies.assertCoupangOwnerBinding === 'function'
    && typeof dependencies.verifyCoupangBoundOwner === 'function'
    && Array.isArray(dependencies.attestedCookieNames);
}

function safeMemoryLinkReceipt(result) {
  const receipt = safeCoupangLinkReceipt(result);
  const { shortUrl, productUrl, ...metadata } = receipt;
  return { ...metadata, shortUrlPresent: typeof shortUrl === 'string', productUrlMatched: typeof productUrl === 'string' };
}

function memoryCacheOptions(directory, options) {
  const cacheFile = privateFilePath(directory, options.cacheFile, MEMORY_LINK_CACHE);
  const journalFile = privateFilePath(directory, options.journalFile, MEMORY_LINK_JOURNAL);
  return { cacheFile, journalFile };
}

function baseReceipt(provider, requests) {
  return {
    schemaVersion: 1,
    operation: 'coupang-partners-fresh-process-check',
    checkedAt: new Date().toISOString(),
    execution: 'pure_http',
    browserUsed: false,
    credentialProvider: provider,
    sessionStatePersisted: provider === 'windows_dpapi_current_user',
    authenticationStatus: 'not_checked',
    httpStatus: 0,
    requests,
  };
}

export async function checkCoupangPartnersFreshProcess(productUrl = null, options = {}) {
  if (productUrl !== null) normalizeCoupangProductUrl(productUrl);
  const requests = [];
  const nativeFetch = options.fetchImpl ?? globalThis.fetch;
  const observedFetch = makeObservedFetch(requests, nativeFetch);
  const selectedProvider = options.provider ?? (process.platform === 'win32' ? 'dpapi' : null);
  let store = options.store;
  let actualProvider = 'unavailable';
  let stage = 'provider';
  try {
    if (!store) {
      if (selectedProvider === 'memory') {
        const directory = await ensurePrivateMemoryDirectory(options.stateDirectory);
        store = new ProtectedStore({ provider: 'memory', directory: path.join(directory, 'protected-store') });
      } else if (selectedProvider === 'dpapi') {
        store = new ProtectedStore({ provider: 'dpapi' });
      } else {
        store = new ProtectedStore(); // On Linux this fails closed with PROVIDER_REQUIRED.
      }
    }
    actualProvider = providerLabel(store, selectedProvider);

    if (options.stateInput !== undefined) {
      stage = 'state_input';
      if (actualProvider !== 'process-memory') fail('COUPANG_STATE_INPUT_REQUIRES_MEMORY_PROVIDER');
      const state = validateCoupangProtectedStateRecord(options.stateInput);
      const writeReceipt = store.write(STATE_NAME, JSON.stringify(state));
      if (writeReceipt?.stored !== true || writeReceipt.persistent !== false || writeReceipt.provider !== 'process-memory') {
        fail('COUPANG_STATE_INPUT_NOT_MEMORY_ONLY');
      }
    }

    let cacheOptions = {};
    if (actualProvider === 'process-memory' && productUrl !== null) {
      stage = 'link_state';
      const directory = await ensurePrivateMemoryDirectory(options.stateDirectory);
      cacheOptions = memoryCacheOptions(directory, options);
      await Promise.all([safeMemoryFile(cacheOptions.cacheFile), safeMemoryFile(cacheOptions.journalFile)]);
    }
    stage = 'link_dependencies';
    const dependencies = options.linkDependencies ?? createCoupangLinkDependencies(store, observedFetch);
    if (productUrl !== null && !linkDependenciesUseStore(dependencies, store)) fail('COUPANG_LINK_DEPENDENCY_STORE_MISMATCH');

    const base = baseReceipt(actualProvider, requests);
    stage = 'owner_health';
    const auth = createCoupangAuth({ store, fetchImpl: observedFetch });
    const result = await auth.health();
    const authenticated = result.authenticated === true && result.ownerVerified === true;
    const authStatusValue = authenticated ? 'authenticated' : 'owner_verification_failed';
    const freshHttpIdentityRead = result.freshHttpIdentityRead === true
      || requests.some(row => row.path === '/api/v1/config' && row.httpStatus === 200);
    if (productUrl === null) {
      return {
        ...base,
        ok: authenticated,
        authenticated,
        ownerVerified: result.ownerVerified === true,
        freshHttpIdentityRead,
        authenticationStatus: authStatusValue,
        httpStatus: latestHttpStatus(requests),
      };
    }

    if (!authenticated) {
      return {
        ...base, ok: false, authenticated: false, ownerVerified: false,
        code: 'COUPANG_OWNER_VERIFICATION_FAILED', authenticationStatus: authStatusValue,
        httpStatus: latestHttpStatus(requests), generationRequests: 0,
      };
    }
    const linkDependencies = dependencies;
    const linkOptions = {
      dependencies: linkDependencies,
      ...cacheOptions,
    };
    stage = 'link_issue';
    let issued;
    const previousUmask = process.umask(0o077);
    try { issued = await issueCoupangLink(productUrl, linkOptions); }
    finally {
      process.umask(previousUmask);
      if (actualProvider === 'process-memory') {
        await Promise.all([safeMemoryFile(cacheOptions.cacheFile), safeMemoryFile(cacheOptions.journalFile)]);
      }
    }
    const linkReceipt = actualProvider === 'process-memory'
      ? safeMemoryLinkReceipt(issued)
      : safeCoupangLinkReceipt(issued);
    return {
      ...base,
      ok: true,
      authenticated: true,
      ownerVerified: true,
      authenticationStatus: 'authenticated',
      httpStatus: latestHttpStatus(requests),
      ...linkReceipt,
      generationRequests: requests.filter(row => row.path === '/api/v1/url/any').length,
    };
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '')
      ? error.code : /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COUPANG_CHECK_FAILED';
    const base = baseReceipt(actualProvider, requests);
    return {
      ...base,
      ok: false,
      authenticated: false,
      ownerVerified: false,
      code,
      authenticationStatus: authStatus(code),
      httpStatus: latestHttpStatus(requests),
      failureStage: stage,
      providerFailure: safeCoupangProviderFailure(error),
      generationRequests: requests.filter(row => row.path === '/api/v1/url/any').length,
    };
  }
}

async function readBoundedStdin(stream = process.stdin) {
  if (stream.isTTY) fail('COUPANG_STATE_STDIN_MUST_BE_PIPED');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_STATE_BYTES) fail('COUPANG_STATE_STDIN_TOO_LARGE');
    chunks.push(buffer);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { fail('COUPANG_STATE_RECORD_INVALID'); }
  let state;
  try { state = JSON.parse(text); } catch { fail('COUPANG_STATE_RECORD_INVALID'); }
  return validateCoupangProtectedStateRecord(state);
}

function parseArgs(args, platform = process.platform) {
  const options = { productUrl: null, provider: platform === 'win32' ? 'dpapi' : null, stateStdin: false, stateDirectory: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      if (args.length !== 1) fail('COUPANG_CHECK_ARGUMENTS_INVALID');
      return { help: true };
    } else if (arg === '--provider') {
      if (seen.has(arg)) fail('COUPANG_CHECK_ARGUMENTS_INVALID');
      seen.add(arg);
      const value = args[++index];
      if (value !== 'memory' && value !== 'dpapi') fail('COUPANG_CHECK_ARGUMENTS_INVALID');
      options.provider = value;
    } else if (arg === '--state-stdin') {
      if (seen.has(arg)) fail('COUPANG_CHECK_ARGUMENTS_INVALID');
      seen.add(arg);
      options.stateStdin = true;
    } else if (arg === '--state-dir') {
      if (seen.has(arg)) fail('COUPANG_CHECK_ARGUMENTS_INVALID');
      seen.add(arg);
      const value = args[++index];
      if (!value || value.startsWith('--') || !path.isAbsolute(value)) fail('COUPANG_CHECK_ARGUMENTS_INVALID');
      options.stateDirectory = value;
    } else if (arg.startsWith('--') || options.productUrl !== null) {
      fail('COUPANG_CHECK_ARGUMENTS_INVALID');
    } else {
      options.productUrl = arg;
    }
  }
  if (options.stateStdin && options.provider !== 'memory') fail('COUPANG_STATE_INPUT_REQUIRES_MEMORY_PROVIDER');
  return options;
}

function safeReceiptDirectory(pathname) {
  const relative = path.relative(REPO_ROOT, pathname);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function writeReceipt(result, provider, stateDirectory) {
  if (provider === 'process-memory') {
    const directory = await ensurePrivateMemoryDirectory(stateDirectory);
    const receiptDirectory = path.join(directory, 'runs', `coupang-partners-fresh-process-${Date.now()}-${process.pid}`);
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    await chmod(receiptDirectory, 0o700);
    await writeFile(path.join(receiptDirectory, 'receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return receiptDirectory;
  }
  const directory = path.join(REPO_ROOT, 'runs', `coupang-partners-fresh-process-${Date.now()}-${process.pid}`);
  if (safeReceiptDirectory(directory)) fail('COUPANG_RECEIPT_PATH_UNSAFE');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return directory;
}

export async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log([
      'Coupang Partners check (Windows DPAPI default; Linux requires explicit process memory)',
      '',
      '  npm run --silent coupang:partners',
      '  npm run --silent coupang:partners -- --provider memory',
      '  <same-host protected state provider> | npm run --silent coupang:partners -- --provider memory --state-stdin',
      '  <same-host protected state provider> | npm run --silent coupang:partners -- --provider memory --state-stdin <exact product URL>',
      '',
      'The state record is bounded to 1 MiB, consumed from stdin only, and is not persisted.',
      'Use --state-dir <absolute path outside this repository> to choose the private link cache and journal directory.',
    ].join('\n'));
    return;
  }
  if (options.stateStdin) options.stateInput = await readBoundedStdin();
  const result = await checkCoupangPartnersFreshProcess(options.productUrl, options);
  const directory = await writeReceipt(result, result.credentialProvider, options.stateDirectory);
  console.log(JSON.stringify({ ...result, receiptDirectory: directory }));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '')
      ? error.code : /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COUPANG_CHECK_FAILED';
    console.log(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  });
}
