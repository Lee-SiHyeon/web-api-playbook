import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WriteJournal } from '../lib/write-journal.mjs';
import { createMyrealtripLinkFlow } from '../lib/myrealtrip-link-flow.mjs';
import { MyrealtripError } from '../service-packs/affiliate/apps/affiliate-api-hub/adapters/myrealtrip-marketing.mjs';

const TARGET_A = 'https://www.myrealtrip.com/offers/174730';
const TARGET_B = 'https://www.myrealtrip.com/offers/174731';
const owner = partnerId => ({ partnerId });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrt-link-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new WriteJournal({ root, service: 'myrealtrip' });
  return { root, journal };
}

function client(execute, ownerId = 42) {
  return { account: { identityVerified: true }, ownerId, execute };
}

function result(id) {
  return {
    data: { id, mylink: `https://myrealt.rip/L${id}`, expirationMinutes: 604800 },
    receipt: { httpStatus: 200, responseBytes: 79, checkedAt: new Date().toISOString() },
  };
}

const verified = async (_link, _target, { expectedLinkId }) => ({
  verified: true, destinationMatches: true, attributionMatches: true,
  credentialSent: false, followedRedirect: false, httpStatus: 301, expectedLinkId,
});

test('reserved journal survives restart and blocks another create when the POST boundary is unknown', async t => {
  const { root, journal } = await fixture(t);
  const key = journal.key('create_link', owner(42), { targetUrl: TARGET_A });
  await journal.reserve(key, { operation: 'createLink', phase: 'reserved_before_post' });
  let postCount = 0;
  const flow = createMyrealtripLinkFlow({
    client: client(async () => { postCount++; return result(101); }), ownerId: 42,
    journal: new WriteJournal({ root, service: 'myrealtrip' }),
    verify: verified,
  });

  const resumed = await flow.create({ targetUrl: TARGET_A });
  assert.equal(resumed.ok, false);
  assert.equal(resumed.code, 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(resumed.writeAttempted, null);
  assert.equal(resumed.journal.status, 'reserved');
  assert.equal(postCount, 0);
});

test('unknown POST is journaled and a new process never resends the same owner-target key', async t => {
  const { root } = await fixture(t);
  let postCount = 0;
  const first = createMyrealtripLinkFlow({
    client: client(async () => {
      postCount++;
      throw new MyrealtripError('WRITE_OUTCOME_UNKNOWN', { outcome: 'unknown', causeCode: 'TRANSPORT' });
    }), ownerId: 42,
    journal: new WriteJournal({ root, service: 'myrealtrip' }),
    verify: verified,
  });
  const initial = await first.create({ targetUrl: TARGET_A });
  assert.equal(initial.code, 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(initial.writeAttempted, null);
  assert.equal(initial.journal.status, 'needs-reconciliation');

  const restarted = createMyrealtripLinkFlow({
    client: client(async () => { postCount++; return result(102); }), ownerId: 42,
    journal: new WriteJournal({ root, service: 'myrealtrip' }),
    verify: verified,
  });
  const blocked = await restarted.create({ targetUrl: TARGET_A });
  assert.equal(blocked.code, 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(blocked.writeAttempted, null);
  assert.equal(blocked.journal.status, 'needs-reconciliation');
  assert.equal(postCount, 1);
});

test('a created link survives failed verification and a restart resumes with read-only verification', async t => {
  const { root, journal } = await fixture(t);
  let postCount = 0;
  let verificationMode = 'fail';
  const makeFlow = () => createMyrealtripLinkFlow({
    client: client(async () => { postCount++; return result(103); }), ownerId: 42,
    journal: new WriteJournal({ root, service: 'myrealtrip' }),
    verify: async (link, target, options) => {
      if (verificationMode === 'fail') throw Object.assign(new Error('hidden detail'), { code: 'LINK_REDIRECT' });
      return verified(link, target, options);
    },
  });

  const created = await makeFlow().create({ targetUrl: TARGET_A });
  assert.equal(created.ok, true);
  assert.equal(created.data.id, 103);
  assert.equal(created.data.mylink, 'https://myrealt.rip/L103');
  assert.equal(created.writeAttempted, true);
  assert.deepEqual(created.verification, { verified: false, code: 'LINK_REDIRECT' });
  assert.equal(created.journal.status, 'needs-reconciliation');
  assert.equal(created.journal.reused, false);
  assert.equal(postCount, 1);

  const key = journal.key('create_link', owner(42), { targetUrl: TARGET_A });
  const persisted = await journal.read(key);
  assert.equal(persisted.safeReceipt.linkId, 103);
  assert.equal(persisted.safeReceipt.shortLinkPath, 'L103');
  assert.doesNotMatch(await readFile(path.join(root, 'myrealtrip', `${key}.json`), 'utf8'), /https:\/\/www\.myrealtrip\.com\/offers\/174730|https:\/\/myrealt\.rip\/L103/);

  verificationMode = 'pass';
  const resumed = await makeFlow().create({ targetUrl: TARGET_A });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.id, 103);
  assert.equal(resumed.verification.verified, true);
  assert.equal(resumed.journal.status, 'reconciled');
  assert.equal(resumed.journal.reused, true);
  assert.equal(resumed.writeAttempted, false);
  assert.equal(postCount, 1);

  const repeated = await makeFlow().create({ targetUrl: TARGET_A });
  assert.equal(repeated.data.id, 103);
  assert.equal(repeated.journal.reused, true);
  assert.equal(repeated.writeAttempted, false);
  assert.equal(postCount, 1);
});

test('owner and normalized target form separate stable journal keys', async t => {
  const { root, journal } = await fixture(t);
  const issued = [];
  const flow = createMyrealtripLinkFlow({
    client: client(async (_operation, input) => {
      const id = issued.length + 200;
      issued.push({ targetUrl: input.targetUrl, id });
      return result(id);
    }),
    ownerId: 42, journal,
    verify: verified,
  });

  const otherOwnerFlow = createMyrealtripLinkFlow({
    client: client(async (_operation, input) => {
      const id = issued.length + 200;
      issued.push({ targetUrl: input.targetUrl, id });
      return result(id);
    }, 43),
    ownerId: 43,
    journal: new WriteJournal({ root, service: 'myrealtrip' }),
    verify: verified,
  });
  const results = await Promise.all([
    flow.create({ targetUrl: TARGET_A }),
    otherOwnerFlow.create({ targetUrl: TARGET_A }),
    flow.create({ targetUrl: TARGET_B }),
  ]);
  assert.equal(new Set(results.map(item => item.journal.status)).size, 1);
  assert.equal(results.every(item => item.ok && item.verification.verified), true);
  assert.equal(issued.length, 3);
  assert.equal(new Set(issued.map(item => item.targetUrl)).size, 2);

  const firstKey = journal.key('create_link', owner(42), { targetUrl: TARGET_A });
  const ownerKey = journal.key('create_link', owner(43), { targetUrl: TARGET_A });
  const targetKey = journal.key('create_link', owner(42), { targetUrl: TARGET_B });
  assert.equal(new Set([firstKey, ownerKey, targetKey]).size, 3);
  for (const key of [firstKey, ownerKey, targetKey]) {
    assert.equal((await journal.read(key)).status, 'reconciled');
  }
});
