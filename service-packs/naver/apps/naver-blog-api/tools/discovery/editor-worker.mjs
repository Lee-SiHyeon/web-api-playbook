import { createInterface } from 'node:readline';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { authorizedSession } from './authorized-session.mjs';
import { ADMIN_ROOT, PUBLIC_ROOT, resourceId, metadata, discoverHTML, scanSource, fetchDocument } from './editor-contracts.mjs';
import { ApiError } from '../../scripts/client.mjs';

// Discovery helper only. Production scripts neither import nor start it.
const bodies = new Map();
const observed = new Map([ADMIN_ROOT, PUBLIC_ROOT].map(url => [resourceId(url), { id: resourceId(url), url, kind: 'link' }]));
const receipts = [];
const scans = [];
let session = null;
let publicOnly = false;

function clear() {
  session?.clear(); session = null; publicOnly = false; bodies.clear();
}
async function inspect({ id, url } = {}) {
  if (!session && !publicOnly) throw new ApiError('AUTH_MISSING', 'Bootstrap the session or explicitly select public mode');
  const target = observed.get(id || resourceId(url || (publicOnly ? PUBLIC_ROOT : ADMIN_ROOT)));
  if (!target) throw new ApiError('UNOBSERVED', 'Choose a previously observed read candidate by id');
  const { receipt, body } = await fetchDocument(target.url, { kind: target.kind, session });
  receipts.push(receipt);
  if (body === null) return receipt;
  bodies.set(target.id, body);
  if (receipt.mime === 'text/html') {
    const { links, formFieldNames, executable } = discoverHTML(body, target.url);
    for (const entry of executable) observed.set(entry.id, entry);
    return { ...receipt, links, formFieldNames };
  }
  return receipt;
}
function scan({ id, terms } = {}) {
  if (!id || !bodies.has(id)) throw new ApiError('UNOBSERVED', 'Choose an inspected document id');
  const result = scanSource(bodies.get(id), observed.get(id).url, terms);
  scans.push(result);
  // Deliberately do not add source strings to executable navigation.
  return result;
}
async function persist() {
  const destination = new URL('../../evidence/editor-discovery-2026-09-13.json', import.meta.url);
  let previous = { receipts: [], sourceScans: [] };
  try {
    const parsed = JSON.parse(await readFile(destination, 'utf8'));
    previous = Array.isArray(parsed) ? { receipts: parsed, sourceScans: [] } : parsed;
    if (!Array.isArray(previous.receipts) || !Array.isArray(previous.sourceScans)) throw Error();
  } catch (error) { if (error.code !== 'ENOENT') throw new ApiError('CHECKPOINT', 'Existing evidence could not be read; it was not overwritten'); }
  const unique = items => [...new Map(items.map(x => [JSON.stringify(x), x])).values()];
  const data = { receipts: unique([...previous.receipts, ...receipts]), sourceScans: unique([...previous.sourceScans, ...scans]) };
  const temporary = new URL(`../../evidence/editor-discovery-${process.pid}.tmp`, import.meta.url);
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n');
  await rename(temporary, destination);
  return { receipts: data.receipts.length, sourceScans: data.sourceScans.length, credentialsPersisted: false };
}
const methods = {
  bootstrapPublic: () => { clear(); publicOnly = true; return { provider: 'unauthenticated_public_HTTP', authenticated: false }; },
  bootstrap: async () => {
    clear(); session = await authorizedSession({ fromChrome: process.argv.includes('--from-chrome') });
    return { provider: session.provider, browserDisconnected: true, credentialsReturned: false, authenticated: 'not_established' };
  },
  inspect, scan, persist,
  frontier: () => [...observed.values()].map(x => ({ ...metadata(x.url), kind: x.kind, inspected: bodies.has(x.id) })),
  status: () => ({ sessionInMemory: Boolean(session), publicOnly, inspected: bodies.size, observedLinks: observed.size, browserNavigationCount: 0, writes: 0 }),
  stop: () => { clear(); return { sessionCleared: true, publicOnly: false }; },
};
console.log(JSON.stringify({ ready: true, browserNavigationCount: 0, writes: 0 }));
const lines = createInterface({ input: process.stdin });
process.once('SIGINT', () => { clear(); lines.close(); process.exitCode = 130; });
for await (const line of lines) {
  let command;
  try {
    if (Buffer.byteLength(line) > 16384) throw new ApiError('INPUT', 'Command exceeds input budget');
    command = JSON.parse(line);
    if (!Object.hasOwn(methods, command?.method)) throw new ApiError('INPUT', 'Unknown command');
    console.log(JSON.stringify({ id: command.id, result: await methods[command.method](command.args) }));
  } catch (error) {
    console.log(JSON.stringify({ id: command?.id, error: { code: error instanceof ApiError ? error.code : 'DISCOVERY_FAILED',
      message: error instanceof ApiError ? error.message : 'Discovery failed; raw details omitted',
      ...(error instanceof ApiError && Object.keys(error.details).length ? { details: error.details } : {}) } }));
  }
}
clear();
