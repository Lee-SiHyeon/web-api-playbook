import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInpockAuth } from './web-auth/inpock.mjs';
import { createInpockSessionReader } from './inpock-read.mjs';
import { WriteJournal } from './write-journal.mjs';
import { ScopedSession } from './scoped-session.mjs';
import { WebAuthError } from './web-auth/myrealtrip.mjs';

const API = 'https://link-rest.inpock.co.kr';
const FIELDS = ['block_type', 'url', 'title', 'style', 'image', 'button_text', 'is_open'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, receipt) => { throw new WebAuthError(code, receipt); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]]));
const validId = id => Number.isSafeInteger(id) && id > 0;
const exact = (row, payload) => object(row) && FIELDS.every(key => row[key] === payload[key]);
function shape(value, depth = 0) {
  if (depth >= 3) return typeof value;
  if (Array.isArray(value)) return { type: 'array', length: value.length, items: value.length ? shape(value[0], depth + 1) : null };
  if (object(value)) return Object.fromEntries(Object.entries(value).slice(0,50).map(([k,v]) => [k,shape(v,depth + 1)]));
  return value === null ? 'null' : typeof value;
}
function validate(input) {
  if (!object(input) || Object.keys(input).some(k => !['confirm','ownerUsername','sourceIdentity','payload'].includes(k)) || input.confirm !== true) fail('INPOCK_CONFIRM_REQUIRED');
  if (typeof input.ownerUsername !== 'string' || !/^[A-Za-z0-9_.-]{1,320}$/.test(input.ownerUsername)) fail('INPOCK_ACTOR_INVALID');
  if (!object(input.sourceIdentity) || !Object.keys(input.sourceIdentity).length || Object.keys(input.sourceIdentity).length > 12 ||
      Object.entries(input.sourceIdentity).some(([k,v]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k) || /password|cookie|token|secret|credential|session|authorization/i.test(k) ||
        typeof v !== 'string' || !v || v.length > 320 || /[\x00-\x20\x7f]/.test(v) || v.includes('://'))) fail('INPOCK_SOURCE_IDENTITY_INVALID');
  const p = input.payload;
  if (!object(p) || Object.keys(p).length !== FIELDS.length || Object.keys(p).some(k => !FIELDS.includes(k)) ||
      p.block_type !== 'link' || p.style !== 'simple' || p.image !== '' || p.button_text !== '' || p.is_open !== true ||
      typeof p.title !== 'string' || !p.title.trim() || p.title !== p.title.trim() || p.title.length > 150 || /[\x00-\x1f\x7f]/.test(p.title)) fail('INPOCK_CARD_INPUT_INVALID');
  let url;
  try { url = new URL(p.url); } catch { fail('INPOCK_CARD_URL_INVALID'); }
  if (typeof p.url !== 'string' || p.url.length > 4096 || url.protocol !== 'https:' || url.username || url.password ||
      /[\x00-\x20\x7f\\]/.test(p.url) || [...url.searchParams.keys()].some(k => /password|token|credential|session|csrf|signature/i.test(k))) fail('INPOCK_CARD_URL_INVALID');
  return { ...input, sourceIdentity: canonical(input.sourceIdentity), payload: canonical(p) };
}

export function createInpockPublisher({ auth = createInpockAuth(), journal = new WriteJournal({
  root: path.join(os.homedir(), '.config', 'xhr-to-api-only', 'journal'), service: 'inpock',
}), now = Date.now, readAttempts = 3, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), anonymousFetch = fetch } = {}) {
  return {
    publish: async input => {
      const checked = validate(input);
      if (!Number.isInteger(readAttempts) || readAttempts < 1 || readAttempts > 5) fail('INPOCK_READBACK_BUDGET_INVALID');
      const progress = { writeSent: false, postAttempts: 0, automaticResendAllowed: false };
      try { return await auth.withSession(async (session, owner, actor) => {
        if (actor.username !== checked.ownerUsername || actor.username !== owner.user.username) fail('OWNER_MISMATCH');
        const reader = createInpockSessionReader({ session, owner, actor, now });
        const anonymous = createInpockSessionReader({ owner, actor, now, session: new ScopedSession({
          allowedOrigins: [API], cookieOrigins: [], fetchImpl: anonymousFetch,
          defaultHeaders: { accept: 'application/json' },
          headersByOrigin: { [API]: { origin: 'https://link.inpock.co.kr', referer: 'https://link.inpock.co.kr/' } },
          timeoutMs: 15000, maxResponseBytes: 1024 * 1024, maxRedirects: 0,
        }) });
        const sourceHash = hash(checked.sourceIdentity), payloadFingerprint = hash(checked.payload);
        const key = journal.key('create-link', { ownerId: actor.id }, { sourceIdentity: checked.sourceIdentity });
        progress.journalKey = key;
        let record = await journal.read(key);
        const hadPrior = record !== null;
        if (record && (record.safeRecord?.ownerId !== actor.id || record.safeRecord?.sourceHash !== sourceHash ||
            record.safeRecord?.payloadFingerprint !== payloadFingerprint)) fail('INPOCK_CARD_PAYLOAD_CONFLICT');
        const before = await reader.listBlocks({ maxPages: 20 });
        if (!before.complete) fail('INPOCK_OWNER_LIST_INCOMPLETE');
        const candidates = before.blocks.filter(b => b.block_type === 'link' && b.url === checked.payload.url);
        if (candidates.length > 1) fail('INPOCK_CARD_AMBIGUOUS');
        if (candidates.length && (!exact(candidates[0], checked.payload) || !validId(candidates[0].id))) fail('INPOCK_CARD_REMOTE_CONFLICT');
        if (!record) {
          await journal.reserve(key, { operation: 'create-link', ownerId: actor.id, sourceHash, payloadFingerprint });
          record = await journal.read(key);
        }
        let writeSent = false, writeReceipt = null, ackId = null, ackConfirmed = false;
        if (!hadPrior && !candidates.length) {
          let response, data = null;
          writeSent = true;
          progress.writeSent = true;
          progress.postAttempts = 1;
          try {
            response = await session.request(API + '/blocks', { method: 'POST',
              headers: { 'content-type': 'application/json' }, body: JSON.stringify(checked.payload) });
            try { data = JSON.parse(response.raw); } catch { /* unknown ACK still requires readback */ }
            const mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? null;
            writeReceipt = { method: 'POST', origin: API, path: '/blocks', httpStatus: response.status, mime,
              responseBytes: Buffer.byteLength(response.raw), responseSchema: shape(data), browserUsed: false,
              checkedAt: new Date(now()).toISOString() };
            // Observed 2026-10-05: successful creation returns {block:{id,...full card fields}}.
            // Bind the returned resource to the full intended card before trusting its ID.
            if (exact(data?.block, checked.payload) && validId(data.block.id)) ackId = data.block.id;
          } catch (error) {
            writeReceipt = { method: 'POST', origin: API, path: '/blocks', httpStatus: null, browserUsed: false,
              code: /^SCOPED_SESSION_[A-Z_]+$/.test(error.code || '') ? error.code : 'TRANSPORT_ERROR' };
          }
          ackConfirmed = response?.status >= 200 && response.status < 300 &&
            writeReceipt.mime === 'application/json' && exact(data?.block, checked.payload) && validId(data.block.id);
          try {
            await journal.finish(key, ackConfirmed ? 'acknowledged_requires_readback' : 'outcome_unknown', {
              httpStatus: response?.status ?? null, ackSchemaFingerprint: hash(shape(data)),
              ...(ackId !== null ? { blockId: ackId } : {}), postAttempts: 1,
            });
          } catch { fail('INPOCK_ACK_PERSIST_UNKNOWN', { writeSent: true, postAttempts: 1, journalKey: key }); }
        } else if (!hadPrior) {
          await journal.finish(key, 'existing_requires_readback', { blockId: candidates[0].id, postAttempts: 0 });
        }
        record = await journal.read(key);
        const expectedId = ackId ?? record.safeReceipt?.blockId ?? record.reconciliation?.blockId ?? null;
        let diagnostics = null;
        for (let attempt = 0; attempt < readAttempts; attempt++) {
          try {
            const owned = await reader.listBlocks({ maxPages: 20 });
            if (!owned.complete) fail('INPOCK_OWNER_LIST_INCOMPLETE');
            const matches = owned.blocks.filter(b => b.block_type === 'link' && b.url === checked.payload.url);
            const publicPage = await anonymous.publicProfile();
            const match = matches.length === 1 ? matches[0] : null;
            const publicMatches = match ? publicPage.blocks.filter(b => b.id === match.id) : [];
            const publicMatch = publicMatches.length === 1 ? publicMatches[0] : null;
            diagnostics = { ownerRecordCount: owned.recordCount, publicRecordCount: publicPage.recordCount,
              matchingUrlCount: matches.length, ownerSchema: shape(match), publicSchema: shape(publicMatch ?? null),
              ownerComparisons: match ? Object.fromEntries(FIELDS.map(k => [k, match[k] === checked.payload[k]])) : null,
              publicComparisons: publicMatch ? Object.fromEntries(FIELDS.map(k => [k, publicMatch[k] === checked.payload[k]])) : null };
            if (match && validId(match.id) && exact(match, checked.payload) && exact(publicMatch, checked.payload) &&
                (expectedId === null || match.id === expectedId)) {
              if (record.status !== 'reconciled') await journal.reconcile(key, {
                result: 'found', independentRead: true, blockId: match.id, ownerVerified: true,
                publicVerified: true, exactFieldsVerified: true, payloadFingerprint,
              });
              progress.readbackVerified = true;
              progress.publicVerified = true;
              progress.blockId = match.id;
              return { status: writeSent ? ackConfirmed ? 'created_verified' : 'desired_state_verified_after_unclear_write' : hadPrior ? 'already_verified' : 'existing_verified',
                publicationPerformed: writeSent ? ackConfirmed ? true : 'unknown' : false, writeSent,
                writeSuppressed: !writeSent, postAttempts: writeSent ? 1 : 0,
                authenticated: true, ownerVerified: true, readbackVerified: true, publicVerified: true, browserUsed: false,
                anonymousPublicVerified: true, publicCredentialsSent: false,
                blockId: match.id, blockIdSource: ackId === match.id ? 'ack_full_card' : 'independent_readback',
                publicProfileUrl: 'https://link.inpock.co.kr/' + encodeURIComponent(actor.username),
                sourceHash, payloadFingerprint, journalKey: key, writeReceipt,
                readReceipts: { owner: owned.receipts, public: publicPage.receipt }, checkedAt: new Date(now()).toISOString() };
            }
          } catch (error) {
            diagnostics = { code: /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'READBACK_FAILED' };
          }
          if (attempt + 1 < readAttempts) await wait(1500);
        }
        if (record.status !== 'reconciled') await journal.reconcile(key, { result: 'ambiguous', independentRead: true });
        return { status: 'outcome_unknown', publicationPerformed: writeSent ? 'unknown' : false, writeSent, writeSuppressed: !writeSent,
          postAttempts: writeSent ? 1 : 0, readbackVerified: false, publicVerified: false, browserUsed: false,
          journalKey: key, sourceHash, payloadFingerprint, writeReceipt, diagnostics, automaticResendAllowed: false };
      }); } catch (error) {
        if (progress.writeSent) fail(error.code === 'INPOCK_ACK_PERSIST_UNKNOWN' ? error.code : 'INPOCK_WRITE_OUTCOME_UNKNOWN', {
          ...progress, phase: 'post_send_local_failure',
          causeCode: /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'LOCAL_ERROR',
        });
        throw error;
      }
    },
  };
}
