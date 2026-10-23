import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { GrokMediaIntentJournal } from '../src/grok-media-intent.mjs';

async function makeJournalPath() {
  const base = path.join(homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'grok-media-intent-'));
  return { directory, filePath: path.join(directory, 'intent.json') };
}

test('durable media intent stores only safe metadata and prevents a second write attempt', async t => {
  const { directory, filePath } = await makeJournalPath();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const journal = new GrokMediaIntentJournal({ filePath });
  const prompt = 'A private test phrase that must not reach the journal';
  const intentId = '00000000-0000-4000-8000-000000000101';
  const ownerIdentityDigest = 'a'.repeat(64);
  const intent = await journal.begin({ operation: 'media.video.create', prompt, payloadProfile: 'video-6s-480p-no-audio', intentId, ownerIdentityDigest });
  assert.equal(intent.state, 'prepared');
  assert.deepEqual(await journal.get(intentId), {
    intentId,
    operation: 'media.video.create',
    state: 'prepared',
    attemptNumber: 1,
    payloadProfile: 'video-6s-480p-no-audio',
    promptLength: prompt.length,
    promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    ownerIdentityDigest,
    reasonCode: null,
  });
  await journal.transition(intent.intentId, 'sending');
  await journal.transition(intent.intentId, 'accepted', { httpStatus: 200 });
  await assert.rejects(
    journal.transition(intent.intentId, 'completed', { httpStatus: 200, reasonCode: 'MEDIA_ASSET_READBACK_VERIFIED' }),
    { code: 'MEDIA_INTENT_READBACK_REQUIRED' },
  );
  await journal.transition(intent.intentId, 'completed', {
    httpStatus: 200,
    readback: { assetCount: 1, mimeTypes: ['video/mp4'], magicVerified: true, bodyBytes: 2048 },
  });

  const text = await readFile(filePath, 'utf8');
  assert.doesNotMatch(text, /private test phrase|cookie|sessionId|assetId|signedUrl/);
  assert.match(text, /video-6s-480p-no-audio/);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await journal.status(), {
    intents: [{
      operation: 'media.video.create', state: 'completed', attemptNumber: 1, httpStatus: 200,
      reasonCode: null, readback: { assetCount: 1, mimeTypes: ['video/mp4'], magicVerified: true, bodyBytes: 2048 },
    }],
  });
  await assert.rejects(
    journal.begin({ operation: 'media.video.create', prompt, payloadProfile: 'video-6s-480p-no-audio', intentId }),
    { code: 'MEDIA_INTENT_ALREADY_ATTEMPTED' },
  );
  const laterIntent = await journal.begin({
    operation: 'media.video.create', prompt: 'a separate authorized request', payloadProfile: 'video-6s-480p-no-audio',
    intentId: '00000000-0000-4000-8000-000000000102',
  });
  assert.equal(laterIntent.state, 'prepared');
});

test('preparing a media intent binds an exact prompt hash and verified owner before submission', async t => {
  const { directory, filePath } = await makeJournalPath();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new GrokMediaIntentJournal({ filePath });
  const prompt = 'neutral bind test';
  const intentId = '00000000-0000-4000-8000-000000000151';
  const ownerIdentityDigest = 'b'.repeat(64);
  await journal.begin({ operation: 'media.video.create', prompt, payloadProfile: 'video-6s-480p-no-audio', intentId });
  const bound = await journal.prepare({
    operation: 'media.video.create', prompt, payloadProfile: 'video-6s-480p-no-audio',
    ownerIdentityDigest, intentId,
  });
  assert.equal(bound.intentId, intentId);
  assert.equal(bound.state, 'prepared');
  assert.equal(bound.promptSha256, createHash('sha256').update(prompt, 'utf8').digest('hex'));
  assert.equal(bound.ownerIdentityDigest, ownerIdentityDigest);
  await assert.rejects(journal.prepare({
    operation: 'media.video.create', prompt: prompt.replace('test', 'rest'),
    payloadProfile: 'video-6s-480p-no-audio', ownerIdentityDigest, intentId,
  }), { code: 'MEDIA_INTENT_PREPARED_PROMPT_MISMATCH' });
  await assert.rejects(journal.prepare({
    operation: 'media.video.create', prompt, payloadProfile: 'video-6s-480p-no-audio',
    ownerIdentityDigest: 'c'.repeat(64), intentId,
  }), { code: 'MEDIA_INTENT_PREPARED_OWNER_MISMATCH' });
  const text = await readFile(filePath, 'utf8');
  assert.equal(text.includes(prompt), false);
  assert.equal((await journal.get(intentId)).promptSha256, bound.promptSha256);
  assert.equal((await journal.get(intentId)).ownerIdentityDigest, ownerIdentityDigest);
});

test('unknown outcome cannot be retried and only verified media readback can reconcile it', async t => {
  const { directory, filePath } = await makeJournalPath();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new GrokMediaIntentJournal({ filePath });
  const prompt = 'neutral geometric test';
  const intentId = '00000000-0000-4000-8000-000000000201';
  const intent = await journal.begin({ operation: 'media.image.create', prompt, payloadProfile: 'image-quality2-batch4', intentId });
  await journal.transition(intent.intentId, 'sending');
  await journal.transition(intent.intentId, 'outcome_unknown', { reasonCode: 'HTTP_TRANSPORT_FAILED' });
  await assert.rejects(
    journal.transition(intent.intentId, 'completed', { reasonCode: 'MEDIA_ASSET_READBACK_VERIFIED' }),
    { code: 'MEDIA_INTENT_READBACK_REQUIRED' },
  );
  await journal.transition(intent.intentId, 'completed', {
    reasonCode: 'MEDIA_ASSET_READBACK_VERIFIED',
    readback: { assetCount: 4, mimeTypes: ['image/jpeg'], magicVerified: true, bodyBytes: 4096 },
  });
  await assert.rejects(
    journal.begin({ operation: 'media.image.create', prompt, payloadProfile: 'image-quality2-batch4', intentId }),
    { code: 'MEDIA_INTENT_ALREADY_ATTEMPTED' },
  );
  assert.equal((await journal.status()).intents[0].state, 'completed');
  const later = await journal.begin({
    operation: 'media.image.create', prompt, payloadProfile: 'image-quality2-batch4',
    intentId: '00000000-0000-4000-8000-000000000202',
  });
  assert.equal(later.state, 'prepared');
});

test('held needs-review media intent can complete only after verified asset readback', async t => {
  const { directory, filePath } = await makeJournalPath();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new GrokMediaIntentJournal({ filePath });
  const intent = await journal.begin({
    operation: 'media.image.create', prompt: 'neutral image readback', payloadProfile: 'image-quality2-batch4',
    intentId: '00000000-0000-4000-8000-000000000301',
  });
  await journal.transition(intent.intentId, 'sending');
  await journal.transition(intent.intentId, 'accepted');
  await journal.transition(intent.intentId, 'needs_review', { reasonCode: 'WS_RESPONSE_SCHEMA_UNKNOWN' });
  await assert.rejects(
    journal.transition(intent.intentId, 'completed', { reasonCode: 'MEDIA_ASSET_READBACK_VERIFIED' }),
    { code: 'MEDIA_INTENT_READBACK_REQUIRED' },
  );
  await journal.transition(intent.intentId, 'completed', {
    reasonCode: 'MEDIA_ASSET_READBACK_VERIFIED',
    readback: { assetCount: 4, mimeTypes: ['image/jpeg'], magicVerified: true, bodyBytes: 848_759 },
  });
  assert.equal((await journal.status()).intents[0].state, 'completed');
});
