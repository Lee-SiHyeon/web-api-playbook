import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { WriteJournal } from './write-journal.mjs';
import { normalizeMyrealtripLinkTarget, verifyMyrealtripLink } from '../service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs';

const SHORT_ORIGIN = 'https://myrealt.rip';
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function codeOf(value, fallback) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}

function linkRecord(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Number.isSafeInteger(data.id) || data.id <= 0
    || !Number.isSafeInteger(data.expirationMinutes) || data.expirationMinutes <= 0
    || typeof data.mylink !== 'string') return null;
  let url;
  try { url = new URL(data.mylink); } catch { return null; }
  if (url.origin !== SHORT_ORIGIN || url.username || url.password || url.port
    || !/^\/[A-Za-z0-9]+$/.test(url.pathname) || url.search || url.hash) return null;
  return {
    id: data.id,
    shortLinkPath: url.pathname.slice(1),
    expirationMinutes: data.expirationMinutes,
    mylink: url.href,
  };
}

function publicLink(saved) {
  if (!saved || !Number.isSafeInteger(saved.linkId) || saved.linkId <= 0
    || !Number.isSafeInteger(saved.expirationMinutes) || saved.expirationMinutes <= 0
    || typeof saved.shortLinkPath !== 'string' || !/^[A-Za-z0-9]+$/.test(saved.shortLinkPath)) return null;
  return {
    id: saved.linkId,
    mylink: `${SHORT_ORIGIN}/${saved.shortLinkPath}`,
    expirationMinutes: saved.expirationMinutes,
  };
}

function defaultJournal() {
  return new WriteJournal({
    root: path.join(os.homedir(), '.config', 'xhr-to-api-only', 'write-journals'),
    service: 'myrealtrip',
  });
}

function failure({ code, outcome, writeAttempted, journalStatus, causeCode, journalCode }) {
  return {
    ok: false,
    operation: 'createLink',
    code: codeOf(code, 'MYREALTRIP_LINK_FAILED'),
    outcome,
    writeAttempted,
    ...(causeCode ? { causeCode: codeOf(causeCode, 'MYREALTRIP_LINK_FAILED') } : {}),
    ...(journalCode ? { journalCode: codeOf(journalCode, 'WRITE_JOURNAL_FAILED') } : {}),
    journal: { status: journalStatus },
  };
}

export function createMyrealtripLinkFlow({ client, ownerId, journal = defaultJournal(), verify = verifyMyrealtripLink } = {}) {
  if (!client || typeof client.execute !== 'function' || client.account?.identityVerified !== true
    || !Number.isSafeInteger(ownerId) || ownerId <= 0 || client.ownerId !== ownerId
    || !journal || !['key', 'reserve', 'read', 'finish', 'reconcile'].every(method => typeof journal[method] === 'function')
    || typeof verify !== 'function') {
    throw Object.assign(new Error('MYREALTRIP_LINK_FLOW_DEPENDENCIES_INVALID'), { code: 'MYREALTRIP_LINK_FLOW_DEPENDENCIES_INVALID' });
  }

  async function persistVerification(key, prior, verification) {
    if (prior.status === 'reconciled') return prior;
    const result = verification.verified ? 'found' : 'ambiguous';
    const evidence = verification.verified ? 'public_redirect_target_and_link_id_verified' : 'public_redirect_verification_failed';
    const readback = {
      result,
      evidence,
      linkId: prior.safeReceipt.linkId,
      destinationMatches: verification.verified,
      attributionMatches: verification.verified,
      ...(Number.isSafeInteger(verification.httpStatus) ? { httpStatus: verification.httpStatus } : {}),
      ...(!verification.verified ? { failureCode: codeOf(verification.code, 'LINK_VERIFY_FAILED') } : {}),
    };
    try { return await journal.reconcile(key, readback); }
    catch { return prior; }
  }

  async function verifyOnly({ key, prior, targetUrl, link, reused }) {
    let verification;
    try {
      const result = await verify(link.mylink, targetUrl, { expectedLinkId: link.id });
      verification = result?.verified === true
        ? { verified: true, destinationMatches: true, attributionMatches: true,
          credentialSent: false, followedRedirect: false,
          ...(Number.isSafeInteger(result.httpStatus) ? { httpStatus: result.httpStatus } : {}) }
        : { verified: false, code: codeOf(result?.code, 'LINK_VERIFY_FAILED') };
    } catch (error) {
      verification = { verified: false, code: codeOf(error?.code, 'LINK_VERIFY_FAILED') };
    }
    const saved = await persistVerification(key, prior, verification);
    return {
      ok: true,
      operation: 'createLink',
      identityVerified: true,
      data: link,
      ...(prior.safeReceipt?.postReceipt ? { receipt: prior.safeReceipt.postReceipt } : {}),
      verification,
      outcome: 'created',
      writeAttempted: reused ? false : true,
      journal: { status: saved.status, reused },
    };
  }

  async function create({ targetUrl } = {}) {
    let normalizedTarget;
    try { normalizedTarget = normalizeMyrealtripLinkTarget(targetUrl); }
    catch (error) {
      return failure({ code: codeOf(error?.code, 'TARGET_INVALID'), outcome: 'not_sent', writeAttempted: false, journalStatus: 'not_created' });
    }

    const key = journal.key('create_link', { partnerId: ownerId }, { targetUrl: normalizedTarget });
    const safeRecord = {
      operation: 'createLink',
      ownerFingerprint: digest(`myrealtrip-partner:${ownerId}`),
      targetFingerprint: digest(normalizedTarget),
      phase: 'reserved_before_post',
    };
    let reserved;
    try { reserved = await journal.reserve(key, safeRecord); }
    catch (error) {
      if (error?.code !== 'WRITE_JOURNAL_EXISTS') {
        return failure({ code: 'WRITE_JOURNAL_FAILED', outcome: 'not_sent', writeAttempted: false,
          journalStatus: 'not_created', journalCode: error?.code });
      }
      let prior;
      try { prior = await journal.read(key); }
      catch (readError) {
        return failure({ code: 'WRITE_JOURNAL_READ_FAILED', outcome: 'unknown', writeAttempted: null,
          journalStatus: 'unreadable', journalCode: readError?.code });
      }
      if (!prior) return failure({ code: 'WRITE_JOURNAL_READ_FAILED', outcome: 'unknown', writeAttempted: null, journalStatus: 'missing' });
      const savedLink = publicLink(prior.safeReceipt);
      if (savedLink && ['finished', 'needs-reconciliation', 'reconciled'].includes(prior.status)) {
        return verifyOnly({ key, prior, targetUrl: normalizedTarget, link: savedLink, reused: true });
      }
      const outcome = prior.status === 'finished' && prior.safeReceipt?.outcome === 'rejected'
        ? 'rejected'
        : prior.status === 'finished' && prior.safeReceipt?.outcome === 'not_sent'
          ? 'not_sent'
          : 'unknown';
      return failure({
        code: outcome === 'unknown' ? 'WRITE_OUTCOME_UNKNOWN' : 'LINK_ALREADY_ATTEMPTED',
        outcome,
        writeAttempted: outcome === 'rejected' ? true : outcome === 'not_sent' ? false : null,
        journalStatus: prior.status,
        causeCode: prior.safeReceipt?.failureCode ?? prior.safeReceipt?.causeCode,
      });
    }

    let created;
    try {
      const result = await client.execute('createLink', { targetUrl: normalizedTarget });
      created = linkRecord(result?.data);
      if (!created) {
        const error = Object.assign(new Error('WRITE_OUTCOME_UNKNOWN'), { code: 'WRITE_OUTCOME_UNKNOWN', outcome: 'unknown', causeCode: 'RESPONSE_SCHEMA_INVALID' });
        throw error;
      }
      const postReceipt = result.receipt && typeof result.receipt === 'object'
        ? {
          ...(Number.isSafeInteger(result.receipt.httpStatus) ? { httpStatus: result.receipt.httpStatus } : {}),
          ...(Number.isSafeInteger(result.receipt.responseBytes) ? { responseBytes: result.receipt.responseBytes } : {}),
          ...(typeof result.receipt.checkedAt === 'string' && Number.isFinite(Date.parse(result.receipt.checkedAt)) ? { checkedAt: result.receipt.checkedAt } : {}),
        }
        : {};
      reserved = await journal.finish(key, 'verification_pending', {
        outcome: 'created',
        writeAttempted: true,
        linkId: created.id,
        shortLinkPath: created.shortLinkPath,
        expirationMinutes: created.expirationMinutes,
        postReceipt,
      });
      return await verifyOnly({ key, prior: reserved, targetUrl: normalizedTarget, link: {
        id: created.id, mylink: created.mylink, expirationMinutes: created.expirationMinutes,
      }, reused: false });
    } catch (error) {
      if (created) {
        return {
          ok: true,
          operation: 'createLink',
          identityVerified: true,
          data: { id: created.id, mylink: created.mylink, expirationMinutes: created.expirationMinutes },
          verification: { verified: false, code: 'WRITE_JOURNAL_COMMIT_FAILED' },
          outcome: 'created',
          writeAttempted: true,
          journal: { status: 'reserved', reused: false, updateCode: codeOf(error?.code, 'WRITE_JOURNAL_FAILED') },
        };
      }
      const outcome = ['not_sent', 'rejected'].includes(error?.outcome) ? error.outcome : 'unknown';
      const writeAttempted = outcome === 'not_sent' ? false : outcome === 'rejected' ? true : null;
      const failureCode = codeOf(error?.code, 'CREATE_LINK_FAILED');
      const causeCode = error?.causeCode ? codeOf(error.causeCode, failureCode) : undefined;
      const state = outcome === 'unknown' ? 'write_outcome_unknown' : outcome === 'rejected' ? 'server_rejected' : 'not_sent';
      try {
        reserved = await journal.finish(key, state, {
          outcome,
          writeAttempted,
          failureCode,
          ...(causeCode ? { causeCode } : {}),
        });
      } catch (journalError) {
        return failure({ code: failureCode, outcome, writeAttempted,
          journalStatus: 'reserved', causeCode, journalCode: journalError?.code });
      }
      return failure({ code: outcome === 'unknown' ? 'WRITE_OUTCOME_UNKNOWN' : failureCode,
        outcome, writeAttempted, journalStatus: reserved.status, causeCode });
    }
  }

  return Object.freeze({ create });
}

export { defaultJournal as createDefaultMyrealtripLinkJournal };
