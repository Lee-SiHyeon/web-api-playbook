#!/usr/bin/env node
// One read per invocation. API key is accepted only through process-memory stdin, never argv/files.
import { createAdpickReadClient, AdpickReadError, safeAdpickError } from '../lib/commerce/adpick-shoppingmate.mjs';

const reject = () => { throw new AdpickReadError('ADPICK_INPUT_INVALID'); };
async function credentialFromStdin() {
  if (process.stdin.isTTY) throw new AdpickReadError('ADPICK_CREDENTIAL_UNAVAILABLE');
  const chunks = [];
  let size = 0;
  const timeout = setTimeout(() => process.stdin.destroy(new AdpickReadError('ADPICK_CREDENTIAL_UNAVAILABLE')), 10_000);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 258) throw new AdpickReadError('ADPICK_CREDENTIAL_UNAVAILABLE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  } finally { clearTimeout(timeout); }
}

try {
  const [operation, ...tokens] = process.argv.slice(2);
  if (operation === 'status' && tokens.length === 0) {
    console.log(JSON.stringify({ service: 'adpick_shoppingmate', networkUsed: false, supportedOperations: ['malls', 'search', 'best'],
      executionMode: 'pure_http', clientExists: true, credentialPropagated: 'not_verified', liveReplay: false,
      unsupportedOperations: ['login', 'key_management', 'link', 'directlink', 'conversion'],
      checklist: 'checklists/services/adpick.json' }));
  } else {
    if (!['malls', 'search', 'best'].includes(operation)) reject();
    const allowed = new Set(['credential-stdin', 'include-data', 'p-data', ...(operation === 'malls' ? ['rewardmalls', 'order']
      : operation === 'search' ? ['q', 'limit'] : ['area', 'limit'])]);
    const flags = {};
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token.startsWith('--') || !allowed.has(token.slice(2)) || Object.hasOwn(flags, token.slice(2))) reject();
      const name = token.slice(2);
      if (['credential-stdin', 'include-data'].includes(name)) flags[name] = true;
      else {
        if (typeof tokens[index + 1] !== 'string' || tokens[index + 1].startsWith('--')) reject();
        flags[name] = tokens[++index];
      }
    }
    if (!flags['credential-stdin']) throw new AdpickReadError('ADPICK_CREDENTIAL_UNAVAILABLE');
    if (flags.limit !== undefined && !/^(?:[1-9]|1[0-9]|20)$/.test(flags.limit)) reject();
    if (flags.rewardmalls !== undefined && !['true', 'false'].includes(flags.rewardmalls)) reject();
    const input = { ...(flags['p-data'] === undefined ? {} : { pData: flags['p-data'] }),
      ...(flags.limit === undefined ? {} : { limit: Number(flags.limit) }),
      ...(operation === 'malls' ? { ...(flags.order === undefined ? {} : { order: flags.order }),
        ...(flags.rewardmalls === undefined ? {} : { rewardmalls: flags.rewardmalls === 'true' }) }
        : operation === 'search' ? { q: flags.q } : { area: flags.area }) };
    const client = createAdpickReadClient({ apiKeyProvider: credentialFromStdin });
    const result = await (operation === 'malls' ? client.readMalls(input)
      : operation === 'search' ? client.searchProducts(input) : client.bestProducts(input));
    const count = Array.isArray(result.data) ? result.data.length : result.data.count;
    console.log(JSON.stringify({ ok: true, service: 'adpick_shoppingmate', executionMode: 'pure_http', browserUsed: false,
      operation, observedAt: result.observedAt, count, receipt: result.receipt, semantics: result.semantics,
      ...(flags['include-data'] ? { data: result.data } : { dataOmitted: true }) }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: safeAdpickError(error), ...(error instanceof AdpickReadError && error.receipt ? { receipt: error.receipt } : {}) }));
  process.exitCode = 1;
}
