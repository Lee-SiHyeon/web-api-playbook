import { ScopedSession } from '../lib/scoped-session.mjs';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { WriteJournal } from '../lib/write-journal.mjs';
import { withSessionLock } from '../lib/session-lock.mjs';
import path from 'node:path';
import { options, jsonFile, stdinJson, fail, reserveOutput, report, sha256, safeError } from '../lib/cli.mjs';
import { validateProfile, requestFromProfile, validateResponse, serviceName } from '../lib/profile.mjs';

let output;
async function transaction(args, store) {
 let journal, journalKey, writeStarted = false, session, bundle, ownerVerified = false;
 try {
 const profile = validateProfile(await jsonFile(args.profile));
 const parameters = args.input ? await jsonFile(args.input) : {};
 const request = requestFromProfile(profile, args.operation, parameters);
 output = await reserveOutput(args.output);
 if (args['session-stdin']) bundle = await stdinJson(512 * 1024);
 else if (args.session) {
  if (!serviceName(args.session)) fail('SESSION_NAME_INVALID');
  const value = await store.read(args.session); if (!value) fail('PROVIDER_MISSING');
  try { bundle = JSON.parse(value); } catch { fail('SESSION_FORMAT_INVALID'); }
 }
 if (bundle) {
  if (bundle.schemaVersion !== 1 || bundle.serviceId !== profile.serviceId || !bundle.session || !bundle.identity || typeof bundle.identity !== 'object' || Array.isArray(bundle.identity)) fail('SESSION_FORMAT_INVALID');
  if (bundle.session.version !== undefined) {
   if (!Array.isArray(bundle.session.allowedOrigins) || !Array.isArray(bundle.session.cookieOrigins)
    || JSON.stringify([...bundle.session.allowedOrigins].sort()) !== JSON.stringify([...profile.allowedOrigins].sort())
    || JSON.stringify([...bundle.session.cookieOrigins].sort()) !== JSON.stringify([...(profile.cookieOrigins ?? profile.allowedOrigins)].sort())
    || (bundle.session.allowLoopbackHttp === true) !== (profile.allowLoopbackHttp === true)) fail('SESSION_SCOPE_MISMATCH');
   session = ScopedSession.fromJSON(bundle.session);
  } else {
   session = new ScopedSession({ allowedOrigins: profile.allowedOrigins, cookieOrigins: profile.cookieOrigins ?? profile.allowedOrigins,
    allowLoopbackHttp: profile.allowLoopbackHttp === true, cookies: bundle.session.cookies ?? [],
    headersByOrigin: bundle.session.headersByOrigin ?? {}, defaultHeaders: bundle.session.defaultHeaders ?? {} });
  }
 } else {
  if (request.operation.protected === true) fail('PROVIDER_MISSING');
  session = new ScopedSession({ allowedOrigins: profile.allowedOrigins, cookieOrigins: profile.cookieOrigins ?? profile.allowedOrigins, allowLoopbackHttp: profile.allowLoopbackHttp === true });
 }
 const isWrite = request.operation.semantics === 'write';
 if (isWrite && (args.execute !== true || typeof args.journal !== 'string')) fail('WRITE_EXECUTION_AND_JOURNAL_REQUIRED');
 if (request.operation.protected === true) {
  const probe = requestFromProfile(profile, profile.probeOperation);
  validateResponse(await session.request(probe.url, probe.init), probe.operation.expected, { identity: bundle?.identity ?? {} });
  ownerVerified = true;
 }
 if (isWrite) {
  journal = new WriteJournal({ root: args.journal, service: profile.serviceId });
  journalKey = journal.key(args.operation, { serviceId: profile.serviceId, urlHash: sha256(request.url) }, { method: request.init.method, bodyHash: sha256(request.init.body || '') });
  await journal.reserve(journalKey, { operation: args.operation, serviceId: profile.serviceId, requestFingerprint: journalKey });
 }
 let response;
 try { writeStarted = isWrite; response = await session.request(request.url, request.init); }
 catch (error) { if (isWrite) fail('WRITE_OUTCOME_UNKNOWN'); throw error; }
 const data = validateResponse(response, request.operation.expected, { identity: bundle?.identity ?? {} });
 const receipt = { schemaVersion: 1, checkedAt: new Date().toISOString(), serviceId: profile.serviceId, operation: args.operation,
   semantic: request.operation.semantics, httpStatus: response.status, mime: response.headers['content-type']?.split(';')[0],
   bytes: Buffer.byteLength(response.raw), responseSha256: sha256(response.raw), schemaChecksPassed: true,
   protectedOwnerVerified: ownerVerified, authProvider: args.session ? 'protected_store' : args['session-stdin'] ? 'stdin_memory' : 'none',
   executionMode: 'pure_http', browserUsed: false, readbackVerified: !isWrite,
   ...(isWrite ? { journalKey, next: 'Execute the named independent readback and compare exact target before marking verified' } : {}) };
 if (journal) await journal.finish(journalKey, 'acknowledged_requires_readback', receipt);
 await report(receipt, output);
 // Deliberately do not print raw JSON, account identities, response headers or bodies.
 void data;
} catch (error) {
 const code = writeStarted ? 'WRITE_RECONCILIATION_REQUIRED' : safeError(error);
 const receipt = { ok: false, code, ...(writeStarted ? { cause: safeError(error), journalKey, retryAllowed: false } : {}) };
 if (journal && writeStarted) await journal.finish(journalKey, 'outcome_unknown', receipt).catch(() => {});
 if (output) await output.writeFile(JSON.stringify(receipt) + '\n').catch(() => {});
 console.error(JSON.stringify(receipt)); process.exitCode = 1;
} finally {
 // Preserve rotations only for a transaction whose owner probe succeeded.
 if (store && bundle && ownerVerified) {
  try { await store.write(args.session, JSON.stringify({ ...bundle, session: session.toJSON(), protectedProbeVerified: true, verifiedAt: new Date().toISOString() })); }
  catch { console.error(JSON.stringify({ ok: false, code: 'ROTATED_SESSION_PERSISTENCE_FAILED' })); process.exitCode = 1; }
 }
 await output?.close(); session = null; bundle = null;
}
}
try {
 const args = options(process.argv.slice(2), ['profile','operation','input','session','session-stdin','store-dir','output','journal','execute']);
 if (typeof args.operation !== 'string' || args['session-stdin'] && args.session
   || args['session-stdin'] && args['session-stdin'] !== true || args.execute && args.execute !== true
   || args['store-dir'] !== undefined && typeof args['store-dir'] !== 'string') fail('ARGUMENT_INVALID');
 if (args.session) {
  if (!serviceName(args.session)) fail('SESSION_NAME_INVALID');
  const store = new ProtectedStore({ directory: args['store-dir'] });
  await withSessionLock(() => transaction(args, store), { root: path.join(store.directory, 'locks'), key: args.session });
 } else await transaction(args, null);
} catch (error) { console.error(JSON.stringify({ ok: false, code: safeError(error) })); process.exitCode = 1; }
