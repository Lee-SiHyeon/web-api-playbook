import { createBrandconnectAuth, BrandconnectError } from '../lib/web-auth/brandconnect.mjs';

const COMMANDS = new Map([
  ['status', { method: 'status', input: false }],
  ['health', { method: 'health', input: false }],
  ['import-session', { method: 'importSession', input: true }],
  ['renew-session', { method: 'renewSession', input: true }],
  ['shopping-search', { method: 'shoppingSearch', input: true }],
  ['shopping-stores', { method: 'shoppingStores', input: true }],
  ['shopping-featured', { method: 'shoppingFeatured', input: false }],
  ['shopping-detail', { method: 'shoppingDetail', input: true }],
  ['shopping-links', { method: 'shoppingLinks', input: true }],
  ['shopping-create-link', { method: 'shoppingCreateLink', input: true }],
  ['travel-search', { method: 'travelSearch', input: true }],
  ['travel-rates', { method: 'travelRates', input: false }],
  ['travel-tabs', { method: 'travelTabs', input: false }],
  ['travel-recommend', { method: 'travelRecommend', input: true }],
  ['travel-detail', { method: 'travelDetail', input: true }],
  ['travel-links', { method: 'travelLinks', input: true }],
  ['travel-create-link', { method: 'travelCreateLink', input: true }],
]);

async function readInput(limit = 256 * 1024) {
  if (process.stdin.isTTY) throw new BrandconnectError('STDIN_REQUIRED');
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > limit) throw new BrandconnectError('INPUT_TOO_LARGE');
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new BrandconnectError('INPUT_JSON_INVALID'); }
  finally { raw = ''; }
}

const command = process.argv[2];
if (process.argv.length > 3 || !COMMANDS.has(command)) {
  process.stdout.write(JSON.stringify({ ok: false, code: 'COMMAND_INVALID' }) + '\n');
  process.exitCode = 2;
} else {
  const { method, input: needsInput } = COMMANDS.get(command);
  const auth = createBrandconnectAuth();
  try {
    const result = await auth[method](needsInput ? await readInput() : undefined);
    process.stdout.write(JSON.stringify({ ok: true, service: 'naver-brandconnect', command, ...result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      service: 'naver-brandconnect',
      command,
      code: error instanceof BrandconnectError ? error.code : 'BRANDCONNECT_FAILED',
      ...(error instanceof BrandconnectError && error.receipt ? { receipt: error.receipt } : {}),
    }) + '\n');
    process.exitCode = 2;
  }
}
