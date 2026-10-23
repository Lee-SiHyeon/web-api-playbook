import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { GeminiWebClient } from '../src/client.mjs';
import { loadObservedContract } from '../src/contract.mjs';
import { readSessionBundleFromStdin } from '../src/session.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

async function readPacket() {
  if (!stdin || stdin.isTTY === true) fail('LIFECYCLE_OWNER_ENVELOPE_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += bytes.length;
    if (size > MAX_BYTES) fail('LIFECYCLE_OWNER_ENVELOPE_TOO_LARGE');
    chunks.push(Buffer.from(bytes));
  }
  if (!size) fail('LIFECYCLE_OWNER_ENVELOPE_REQUIRED');
  const raw = Buffer.concat(chunks, size);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { fail('LIFECYCLE_OWNER_ENVELOPE_INVALID'); }
  finally {
    raw.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function ReadableFromPacket(session) {
  const serialized = JSON.stringify(session);
  return Object.assign((async function* yieldText() { yield serialized; })(), { isTTY: false });
}

async function run(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || Object.keys(packet).some((key) => !['session', 'expectedOwner'].includes(key))
      || typeof packet.expectedOwner !== 'string'
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(packet.expectedOwner)) fail('LIFECYCLE_OWNER_ENVELOPE_INVALID');
  const normalized = packet.expectedOwner.trim().toLowerCase();
  const { createHash } = await import('node:crypto');
  if (createHash('sha256').update(normalized).digest('hex') !== OWNER_SHA256) fail('EXPECTED_OWNER_NOT_UNIQUE');
  const contract = await loadObservedContract();
  const session = await readSessionBundleFromStdin(contract, {
    input: ReadableFromPacket(packet.session), maxBytes: MAX_BYTES,
  });
  const client = new GeminiWebClient({ contract, session });
  try {
    const result = await client.verifyOwner(normalized);
    const requestHeaders = result.request.headerNames;
    return {
      operation: 'identity',
      ownerMatched: result.ownerMatched === true,
      anonymousOwnerAbsent: result.anonymousOwnerAbsent === true,
      httpStatus: result.httpStatus,
      anonymousHttpStatus: result.anonymousHttpStatus,
      contentType: contract.operations.identity.response.contentType,
      responseBytes: result.responseBytes,
      responseSha256: result.responseSha256,
      credentialPropagated: result.credentialPropagated,
      request: {
        method: result.request.method,
        origin: result.request.origin,
        path: result.request.path,
        queryKeys: result.request.queryKeys,
        headerNames: requestHeaders,
        bodyFieldNames: [],
        contentType: null,
        valuesPersisted: false,
      },
      secretsPersisted: false,
    };
  } finally {
    client.transport.session = null;
    client.verifiedOwner = null;
    packet.expectedOwner = '';
    packet.session = null;
  }
}

async function main() {
  let packet;
  try {
    packet = await readPacket();
    stdout.write(JSON.stringify(await run(packet)) + '\n');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'LIFECYCLE_OWNER_READ_FAILED';
    stdout.write(JSON.stringify({ operation: 'identity', verified: false, error: code,
      secretsPersisted: false }) + '\n');
    process.exitCode = 1;
  } finally {
    if (packet) {
      packet.expectedOwner = '';
      packet.session = null;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
