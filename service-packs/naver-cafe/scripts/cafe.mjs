import { pathToFileURL } from 'node:url';
import { CafeApiError, CafeSession, DEFAULT_CAFE } from '../lib/session.mjs';
import { bootstrapSharedCafeSession, createStoredCafeClient, renewCafeSessionFromStoredActorPin } from '../lib/client.mjs';

const flags = new Set(['--id', '--page', '--menu', '--query', '--expected-actor-hash', '--cafe-id', '--cafe-slug']);
const commandFlags = {
  status: ['--cafe-id', '--cafe-slug'],
  'bootstrap-shared': ['--expected-actor-hash', '--cafe-id', '--cafe-slug'],
  'renew-shared': ['--cafe-id', '--cafe-slug'],
  member: ['--cafe-id', '--cafe-slug'],
  article: ['--id', '--cafe-id', '--cafe-slug'],
  comments: ['--id', '--cafe-id', '--cafe-slug'],
  list: ['--page', '--menu', '--cafe-id', '--cafe-slug'],
  search: ['--query', '--page', '--menu', '--cafe-id', '--cafe-slug'],
  menus: ['--cafe-id', '--cafe-slug'],
};

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!command || !/^(?:status|bootstrap-shared|renew-shared|member|article|comments|list|search|menus)$/.test(command)) {
    throw new CafeApiError('USAGE', 'Expected a supported Cafe command');
  }
  const values = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index];
    if (!flags.has(flag) || index + 1 >= tokens.length || values.has(flag)) throw new CafeApiError('USAGE', 'Invalid or duplicate Cafe option');
    const value = tokens[++index];
    if (value.startsWith('--')) throw new CafeApiError('USAGE', 'Cafe option value is missing');
    values.set(flag, value);
  }
  if ([...values.keys()].some(flag => !commandFlags[command].includes(flag))) {
    throw new CafeApiError('USAGE', 'Option is not valid for this Cafe command');
  }
  return { command, values };
}

function contextFrom(values) {
  return {
    cafeId: values.get('--cafe-id') ?? DEFAULT_CAFE.id,
    cafeSlug: values.get('--cafe-slug') ?? DEFAULT_CAFE.slug,
  };
}

function positiveInteger(value, fallback, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new CafeApiError('INPUT', `Invalid ${label}`);
  return number;
}

function safeError(error) {
  const code = error instanceof CafeApiError ? error.code : 'INTERNAL';
  const result = { error: code };
  const httpStatus = error?.details?.httpStatus;
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
  const safeToken = value => {
    const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    return typeof text === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : null;
  };
  const applicationStatus = error?.details?.applicationStatus;
  if (typeof applicationStatus === 'number' && Number.isFinite(applicationStatus)) result.applicationStatus = applicationStatus;
  else if (safeToken(applicationStatus)) result.applicationStatus = safeToken(applicationStatus);
  const applicationErrorCode = error?.details?.applicationErrorCode ?? error?.details?.errorCode;
  if (safeToken(applicationErrorCode)) result.applicationErrorCode = safeToken(applicationErrorCode);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  const context = contextFrom(values);
  if (command === 'status') return CafeSession.availability({ context });
  if (command === 'renew-shared') return renewCafeSessionFromStoredActorPin({ context });
  if (command === 'bootstrap-shared') {
    const expectedActorHash = values.get('--expected-actor-hash');
    return bootstrapSharedCafeSession({ context, expectedActorHash });
  }
  const client = await createStoredCafeClient({ context });
  switch (command) {
    case 'member': return client.membership();
    case 'article': return client.article({ articleId: values.get('--id') ?? DEFAULT_CAFE.articleId });
    case 'comments': return client.comments({ articleId: values.get('--id') ?? DEFAULT_CAFE.articleId });
    case 'list': return client.list({
      page: positiveInteger(values.get('--page'), 1, 'page'),
      menu: values.get('--menu') == null ? undefined : positiveInteger(values.get('--menu'), null, 'menu'),
    });
    case 'search': {
      const query = values.get('--query');
      if (!query) throw new CafeApiError('INPUT', 'Search command requires --query');
      return client.search({
        query,
        page: positiveInteger(values.get('--page'), 1, 'page'),
        menu: values.get('--menu') == null ? undefined : positiveInteger(values.get('--menu'), null, 'menu'),
      });
    }
    case 'menus': return client.menus();
    default: throw new CafeApiError('USAGE', 'Unsupported Cafe command');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
    process.exitCode = 1;
  }
}
