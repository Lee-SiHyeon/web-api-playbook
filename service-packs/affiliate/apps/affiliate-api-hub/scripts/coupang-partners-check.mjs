// Run with ordinary Node so the default DPAPI provider and production link
// journal are used. Only safe request metadata and link receipts are emitted.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  issueCoupangLink, normalizeCoupangProductUrl, safeCoupangLinkReceipt,
} from '../adapters/coupang-partners-link.mjs';
import { createCoupangAuth } from '../../../../../lib/web-auth/coupang.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

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

export async function checkCoupangPartnersFreshProcess(productUrl = null) {
  if (productUrl !== null) normalizeCoupangProductUrl(productUrl);
  const requests = [];
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const row = { origin: url.origin, path: url.pathname, method: init.method ?? 'GET' };
    requests.push(row);
    const response = await nativeFetch(input, init);
    row.httpStatus = response.status;
    if (url.origin === 'https://partners.coupang.com') {
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
  const base = {
    schemaVersion: 1, operation: 'coupang-partners-fresh-process-check',
    checkedAt: new Date().toISOString(), execution: 'pure_http', browserUsed: false,
    credentialProvider: 'windows_dpapi_current_user', requests,
  };
  try {
    if (productUrl === null) {
      const result = await createCoupangAuth().health();
      return { ...base, ok: true, authenticated: result.authenticated === true,
        ownerVerified: result.ownerVerified === true,
        freshHttpIdentityRead: result.freshHttpIdentityRead === true };
    }
    const result = await issueCoupangLink(productUrl);
    return { ...base, ...safeCoupangLinkReceipt(result),
      generationRequests: requests.filter(row => row.path === '/api/v1/url/any').length };
  } catch (error) {
    return { ...base, ok: false,
      code: /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'COUPANG_CHECK_FAILED',
      providerFailure: safeCoupangProviderFailure(error),
      generationRequests: requests.filter(row => row.path === '/api/v1/url/any').length };
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

export async function main(args) {
  if (args.length > 1) throw new Error('COUPANG_CHECK_ARGUMENTS_INVALID');
  const result = await checkCoupangPartnersFreshProcess(args[0] ?? null);
  const directory = path.join(REPO_ROOT, 'runs', `coupang-partners-fresh-process-${Date.now()}-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...result, receiptDirectory: directory }));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    console.log(JSON.stringify({ ok: false, code: 'COUPANG_CHECK_FAILED' }));
    process.exitCode = 1;
  });
}
