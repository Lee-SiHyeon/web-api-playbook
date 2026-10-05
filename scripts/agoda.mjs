import { AgodaHotelClient } from '../lib/travel/agoda.mjs';
import { stdinJson } from '../lib/cli.mjs';

const HELP = `Agoda public hotel reader

Usage:
  node scripts/agoda.mjs --help
  node scripts/agoda.mjs rates < rates-input.json
  node scripts/agoda.mjs campaigns

Rates input is public JSON on stdin (maximum 32 KiB):
  {"checkIn":"YYYY-MM-DD","checkOut":"YYYY-MM-DD","propertyIds":[25575116]}

Only observed property IDs, 2 adults, 0 children, 1 room, and KRW are supported.
This reader sends anonymous public HTTP requests and does not book, activate coupons, or create affiliate links.`;

function commandError(code) {
  return Object.assign(new Error(code), { code });
}

function safeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const metadata = {};
  if (value.origin === 'https://www.agoda.com') metadata.origin = value.origin;
  if (typeof value.path === 'string' && /^\/[A-Za-z0-9/_-]{1,120}$/.test(value.path)) metadata.path = value.path;
  if (value.method === 'GET' || value.method === 'POST') metadata.method = value.method;
  if (Number.isSafeInteger(value.status) && value.status >= 100 && value.status <= 599) metadata.status = value.status;
  if (typeof value.contentType === 'string' && /^[A-Za-z0-9.+/-]{1,80}(?:;\s*charset=[A-Za-z0-9._-]{1,20})?$/i.test(value.contentType)) {
    metadata.contentType = value.contentType;
  }
  if (value.auth === 'anonymous') metadata.auth = value.auth;
  if (typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))) metadata.observedAt = value.observedAt;
  if (Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= 4 * 1024 * 1024) metadata.bytes = value.bytes;
  return Object.keys(metadata).length ? metadata : undefined;
}

function failure(error) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : 'AGODA_OPERATION_FAILED';
  return {
    ok: false,
    error: {
      code,
      ...(safeMetadata(error?.metadata) ? { metadata: safeMetadata(error.metadata) } : {}),
    },
  };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (args.length === 1 && args[0] === 'campaigns') {
    const output = await new AgodaHotelClient().campaigns();
    process.stdout.write(`${JSON.stringify({ ok: true, ...output })}\n`);
    return;
  }
  if (args.length === 1 && args[0] === 'rates') {
    const input = await stdinJson(32 * 1024);
    const output = await new AgodaHotelClient().rates(input);
    process.stdout.write(`${JSON.stringify({ ok: true, ...output })}\n`);
    return;
  }
  throw commandError('AGODA_ARGUMENT_INVALID');
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stdout.write(`${JSON.stringify(failure(error))}\n`);
  process.exitCode = 2;
}
