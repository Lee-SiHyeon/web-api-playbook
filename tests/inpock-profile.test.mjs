import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInpockProfileClient } from '../lib/inpock-profile.mjs';
import { WriteJournal } from '../lib/write-journal.mjs';

const API = 'https://link-rest.inpock.co.kr';
const ACTOR = { id: 42, username: 'owner_test' };
const OWNER = { authenticated: true, ownerVerified: true, user: { username: ACTOR.username } };
const response = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, raw: JSON.stringify(value) });
const fullDesign = () => ({
  profile_image: null, title: 'Current title', bio: 'Current bio',
  sns: [{ id: 9, type: 'instagram', value: 'existing', order: 0 }], sns_position: 'top',
  layout_type: 'profile', cover_image: null, profile_alignment: 'center',
  profile_size: 'medium', theme: null, background_type: null,
  background_color: '#ffffff', background_image: null, typography: 'pretendard',
  block_shape: 'square-rounded', block_animation: null, block_shadow: null,
  block_alignment: 'center', notice: { id: 8, background_color: null, text_color: null, contents: null },
  brand_image: null, brand_url: null, brand_image_policy: 'default',
  using_short_link: false, allow_offers: false, using_search: false,
  show_tiktok_browser_popup: true,
});
const editInput = (snapshotHash, changes = { title: 'Updated title' }, editId = 'edit-20261005-001') => ({
  ownerUsername: ACTOR.username, expectedSnapshotHash: snapshotHash, changes, editId, confirm: true,
});

async function harness(t, options = {}) {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await fs.mkdir(scratch, { recursive: true });
  const journalRoot = await fs.mkdtemp(path.join(scratch, 'inpock-profile-tests-'));
  t.after(() => fs.rm(journalRoot, { recursive: true, force: true }));
  const journal = new WriteJournal({ root: journalRoot, service: 'inpock' });
  const state = { design: fullDesign(), isDraft: false, postCalls: 0, calls: [], publicCalls: [],
    publicOverride: null, ownerReadOverride: null, postMode: 'accept', authSaveError: false, authCalls: 0 };
  const session = { request: async (url, init = {}) => {
    const parsed = new URL(url), method = init.method || 'GET';
    assert.equal(parsed.origin, API);
    state.calls.push({ path: parsed.pathname, method, init });
    if (method === 'GET' && parsed.pathname === '/v2/users/design') {
      return response({ data: state.ownerReadOverride ?? state.design, is_draft: state.isDraft,
        history: { can_undo: false, can_redo: false, undo_count: 0, redo_count: 0 } });
    }
    if (method === 'POST' && parsed.pathname === '/v2/users/design/save') {
      state.postCalls++;
      assert.deepEqual(init.headers, { 'content-type': 'application/json' });
      const payload = JSON.parse(init.body);
      assert.equal(payload.user_id, ACTOR.id);
      assert.equal(Object.keys(payload).length, 27);
      state.lastPayload = payload;
      if (state.postMode === 'throw') throw Object.assign(new Error('secret response detail'), { code: 'SCOPED_SESSION_TIMEOUT' });
      if (state.postMode === 'accept') state.design = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'user_id'));
      if (state.postMode === 'reject-apply') {
        state.design = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'user_id'));
        return response({ error: 'conflict' }, 409);
      }
      if (state.postMode === 'html-apply') {
        state.design = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'user_id'));
        return { status: 200, headers: { 'content-type': 'text/html' }, raw: '<html>Login</html>' };
      }
      if (state.postMode === 'json-error-apply') {
        state.design = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'user_id'));
        return response({ error: 'application rejected' });
      }
      return response({ ok: true });
    }
    assert.fail('unexpected authenticated route ' + parsed.pathname);
  } };
  const auth = { withSession: async callback => {
    state.authCalls++;
    const answer = await callback(session, options.owner ?? OWNER, options.actor ?? ACTOR);
    if (state.authSaveError) throw Object.assign(new Error('secret persistence detail'), { code: 'PROTECTED_STORE_OPERATION_FAILED' });
    return answer;
  } };
  const anonymousFetch = async (url, init) => {
    const parsed = new URL(url), headers = new Headers(init.headers);
    assert.equal(parsed.origin, API);
    assert.equal(parsed.pathname, '/v2/users/owner_test/public');
    assert.equal(init.method, 'GET');
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('authorization'), null);
    state.publicCalls.push({ url, headers: Object.fromEntries(headers) });
    const publicDesign = state.publicOverride ?? {
      ...state.design, profile_image: state.design.profile_image ?? '',
      cover_image: state.design.cover_image ?? '', background_image: state.design.background_image ?? '',
    };
    return new Response(JSON.stringify({ user: {
      user_id: options.publicOwnerId ?? ACTOR.id, username: ACTOR.username, design: publicDesign,
      slug: ACTOR.username,
    }, blocks: [], cta_block: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createInpockProfileClient({ auth, journalRoot, journal, anonymousFetch,
    readAttempts: 1, wait: async () => {}, now: () => Date.parse('2026-10-05T01:00:00Z') });
  return { client, state, journal, journalRoot };
}

test('snapshot and preview retain live nulls, notice ID, and untouched fields', async t => {
  const h = await harness(t);
  const snapshot = await h.client.snapshot();
  assert.deepEqual(snapshot.profile, fullDesign());
  assert.equal(snapshot.isDraft, false);
  const preview = await h.client.preview({ ownerUsername: ACTOR.username, changes: { title: 'Updated title' } });
  assert.equal(preview.snapshotHash, snapshot.snapshotHash);
  assert.equal(preview.target.title, 'Updated title');
  assert.equal(preview.target.theme, null);
  assert.equal(preview.target.background_type, null);
  assert.deepEqual(preview.target.notice, fullDesign().notice);
  assert.deepEqual(preview.target.sns, fullDesign().sns);
  assert.deepEqual(preview.changedFields, ['title']);
  assert.equal(h.state.postCalls, 0);
});

test('edit sends one complete owner-bound save, verifies owner and cookie-free public state, then suppresses repeat', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  const result = await h.client.edit(editInput(snapshotHash));
  assert.equal(result.status, 'desired_state_verified_after_unverified_ack');
  assert.equal(result.editPerformed, 'unknown');
  assert.equal(result.writeReceipt.applicationAckVerified, false);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.publicVerified, true);
  assert.equal(result.postAttempts, 1);
  assert.equal(h.state.postCalls, 1);
  assert.equal(h.state.publicCalls.length, 1);
  assert.equal(h.state.lastPayload.theme, null);
  assert.equal(h.state.lastPayload.background_type, null);
  assert.deepEqual(h.state.lastPayload.notice, fullDesign().notice);
  assert.deepEqual(h.state.lastPayload.sns, fullDesign().sns);
  assert.deepEqual(Object.keys(h.state.lastPayload).sort(), [...Object.keys(fullDesign()), 'user_id'].sort());
  const record = await h.journal.read(result.journalKey);
  assert.equal(record.status, 'reconciled');
  assert.equal(record.reconciliation.result, 'found');
  assert.equal(JSON.stringify(record).includes('Updated title'), false);
  assert.equal(JSON.stringify(record).includes('Current bio'), false);
  const repeat = await h.client.edit(editInput(snapshotHash));
  assert.equal(repeat.status, 'desired_state_verified_after_unverified_ack');
  assert.equal(repeat.postAttempts, 0);
  assert.equal(h.state.postCalls, 1);
});

test('new SNS values normalize handles and order while existing notice remains untouched', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  const changes = { sns: [
    { type: 'instagram', value: '@newhandle', order: 99 },
    { type: 'website', value: 'https://example.com/path', order: 55 },
  ] };
  const result = await h.client.edit(editInput(snapshotHash, changes));
  assert.equal(result.status, 'desired_state_verified_after_unverified_ack');
  assert.deepEqual(h.state.lastPayload.sns, [
    { type: 'instagram', value: 'newhandle', order: 0 },
    { type: 'website', value: 'https://example.com/path', order: 1 },
  ]);
  assert.deepEqual(h.state.lastPayload.notice, fullDesign().notice);
});

test('confirmation, owner, stale snapshot, existing draft, unknown fields and unverified image references block POST', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  await assert.rejects(h.client.edit({ ...editInput(snapshotHash), confirm: false }), { code: 'INPOCK_PROFILE_CONFIRM_REQUIRED' });
  const authCalls = h.state.authCalls;
  await assert.rejects(h.client.edit({ ...editInput(snapshotHash), ownerUsername: undefined }), { code: 'INPOCK_ACTOR_INVALID' });
  await assert.rejects(h.client.edit({ ...editInput(snapshotHash), ownerUsername: null }), { code: 'INPOCK_ACTOR_INVALID' });
  await assert.rejects(h.client.preview({ ownerUsername: undefined, changes: { title: 'Changed' } }), { code: 'INPOCK_ACTOR_INVALID' });
  await assert.rejects(h.client.preview({ ownerUsername: null, changes: { title: 'Changed' } }), { code: 'INPOCK_ACTOR_INVALID' });
  assert.equal(h.state.authCalls, authCalls);
  await assert.rejects(h.client.edit({ ...editInput(snapshotHash), ownerUsername: 'other' }), { code: 'OWNER_MISMATCH' });
  await assert.rejects(h.client.edit(editInput('a'.repeat(64))), { code: 'INPOCK_PROFILE_STALE_SNAPSHOT' });
  await assert.rejects(h.client.preview({ ownerUsername: ACTOR.username, changes: { new_field: 1 } }),
    { code: 'INPOCK_PROFILE_CHANGES_INVALID' });
  await assert.rejects(h.client.edit(editInput(snapshotHash, { profile_image: 'https://example.com/new.jpg' })),
    { code: 'INPOCK_PROFILE_IMAGE_REFERENCE_UNVERIFIED' });
  h.state.isDraft = true;
  await assert.rejects(h.client.edit(editInput(snapshotHash)), { code: 'INPOCK_PROFILE_EXISTING_DRAFT' });
  assert.equal(h.state.postCalls, 0);
});

test('invalid current shape blocks a complete save rather than inventing or dropping fields', async t => {
  const h = await harness(t);
  h.state.design = { ...fullDesign(), unrecognized_setting: true };
  await assert.rejects(h.client.snapshot(), { code: 'INPOCK_PROFILE_DESIGN_SCHEMA_INVALID' });
  h.state.design = { ...fullDesign(), notice: { ...fullDesign().notice, unknown: 'x' } };
  await assert.rejects(h.client.snapshot(), { code: 'INPOCK_PROFILE_NOTICE_INVALID' });
  assert.equal(h.state.postCalls, 0);
});

test('same edit ID with changed intent conflicts and does not POST again', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  await h.client.edit(editInput(snapshotHash));
  await assert.rejects(h.client.edit(editInput(snapshotHash, { title: 'Different title' })),
    { code: 'INPOCK_PROFILE_EDIT_CONFLICT' });
  assert.equal(h.state.postCalls, 1);
});

test('unchanged edit is a true no-op and cannot bypass a pending older edit', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  const unchanged = await h.client.edit(editInput(snapshotHash, { title: 'Current title' }));
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.postAttempts, 0);
  assert.equal(h.state.postCalls, 0);
  h.state.postMode = 'throw';
  await h.client.edit(editInput(snapshotHash));
  await assert.rejects(h.client.edit(editInput(snapshotHash, { title: 'Current title' }, 'edit-20261005-002')),
    { code: 'INPOCK_PROFILE_PENDING_EDIT' });
  assert.equal(h.state.postCalls, 1);
});

test('uncertain POST blocks resend and a newer edit ID until read-only reconciliation', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  h.state.postMode = 'throw';
  const first = await h.client.edit(editInput(snapshotHash));
  assert.equal(first.status, 'outcome_unknown');
  assert.equal(h.state.postCalls, 1);
  const again = await h.client.edit(editInput(snapshotHash));
  assert.equal(again.status, 'outcome_unknown');
  assert.equal(again.postAttempts, 0);
  await assert.rejects(h.client.edit(editInput(snapshotHash, { bio: 'Another change' }, 'edit-20261005-002')),
    { code: 'INPOCK_PROFILE_PENDING_EDIT' });
  assert.equal(h.state.postCalls, 1);
  h.state.design.title = 'Updated title';
  const reconciled = await h.client.edit(editInput(snapshotHash));
  assert.equal(reconciled.status, 'desired_state_verified_after_unclear_write');
  assert.equal(h.state.postCalls, 1);
});

test('owner or public readback mismatch never reports a verified edit', async t => {
  for (const mismatch of ['owner', 'public']) {
    const h = await harness(t);
    const { snapshotHash } = await h.client.snapshot();
    if (mismatch === 'owner') h.state.postMode = 'ignore';
    else h.state.publicOverride = { ...fullDesign(), title: 'Stale public title' };
    const result = await h.client.edit(editInput(snapshotHash));
    assert.equal(result.status, 'outcome_unknown');
    assert.equal(result.readbackVerified, false);
    assert.equal(h.state.postCalls, 1);
    const record = await h.journal.read(result.journalKey);
    assert.equal(record.status, 'needs-reconciliation');
  }
});

test('a non-2xx POST with matching later state does not claim this edit was accepted', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  h.state.postMode = 'reject-apply';
  const result = await h.client.edit(editInput(snapshotHash));
  assert.equal(result.status, 'desired_state_verified_after_unclear_write');
  assert.equal(result.editPerformed, 'unknown');
  assert.equal(result.writeReceipt.httpStatus, 409);
  assert.equal(result.readbackVerified, true);
  assert.equal(h.state.postCalls, 1);
});

test('2xx HTML and JSON error replies never become confirmed application ACKs', async t => {
  for (const mode of ['html-apply', 'json-error-apply']) {
    const h = await harness(t);
    const { snapshotHash } = await h.client.snapshot();
    h.state.postMode = mode;
    const result = await h.client.edit(editInput(snapshotHash));
    assert.equal(result.status, 'desired_state_verified_after_unclear_write');
    assert.equal(result.editPerformed, 'unknown');
    assert.equal(result.writeReceipt.applicationAckVerified, false);
    assert.equal(result.writeReceipt.applicationErrorSignaled, mode === 'json-error-apply');
    assert.equal(h.state.postCalls, 1);
  }
});

test('publicly exposed setting is checked against the cookie-free public design', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  const result = await h.client.edit(editInput(snapshotHash, { using_search: true }));
  assert.equal(result.status, 'desired_state_verified_after_unverified_ack');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.publicVerified, true);
  assert.equal(result.anonymousPublicVerified, true);
  assert.equal(h.state.publicCalls.length, 1);
  const stale = await harness(t);
  const staleHash = (await stale.client.snapshot()).snapshotHash;
  stale.state.publicOverride = { ...fullDesign(), using_search: false };
  const unknown = await stale.client.edit(editInput(staleHash, { using_search: true }));
  assert.equal(unknown.status, 'outcome_unknown');
  assert.equal(unknown.diagnostics.publicComparisons.using_search, false);
});

test('post-send local failure is reported as unknown, with the durable reservation suppressing replay', async t => {
  const h = await harness(t);
  const { snapshotHash } = await h.client.snapshot();
  h.state.authSaveError = true;
  await assert.rejects(h.client.edit(editInput(snapshotHash)), error => {
    assert.equal(error.code, 'INPOCK_PROFILE_WRITE_OUTCOME_UNKNOWN');
    assert.equal(error.receipt.writeSent, true);
    assert.equal(error.receipt.postAttempts, 1);
    assert.equal(JSON.stringify(error.receipt).includes('secret persistence detail'), false);
    return true;
  });
  h.state.authSaveError = false;
  const repeat = await h.client.edit(editInput(snapshotHash));
  assert.equal(repeat.status, 'desired_state_verified_after_unverified_ack');
  assert.equal(h.state.postCalls, 1);
});
