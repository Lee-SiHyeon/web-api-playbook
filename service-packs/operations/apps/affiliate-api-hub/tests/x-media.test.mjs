import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildXImageUploadPlan, parseXMediaResponse, runXImageUploadProtocol, runXVideoUploadProtocol } from '../scripts/sns/writers/x-media.mjs';
import { createHash } from 'node:crypto';

function mp4Bytes(size = 4096) {
  const bytes = Buffer.alloc(size);
  Buffer.from('ftyp').copy(bytes, 4);
  return bytes;
}

function pngBytes(size = 128) {
  const bytes = Buffer.alloc(size);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(3, 20);
  return bytes;
}

function response(status, body = '') {
  return { status, raw: Buffer.from(body) };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'x-media-protocol-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('X media response parser accepts empty APPEND and rejects provider or malformed errors without echoing them', () => {
  assert.equal(parseXMediaResponse('APPEND', response(204), { allowEmpty: true }), null);
  assert.throws(() => parseXMediaResponse('INIT', response(200)), { code: 'X_MEDIA_INIT_RESPONSE_INVALID' });
  assert.throws(() => parseXMediaResponse('STATUS', response(200, '{bad')), { code: 'X_MEDIA_STATUS_RESPONSE_INVALID' });
  assert.throws(() => parseXMediaResponse('APPEND', response(200, '{"errors":[{"message":"cookie=never-show"}]}')),
    error => error.code === 'X_MEDIA_APPEND_REJECTED' && !error.message.includes('never-show'));
  assert.throws(() => parseXMediaResponse('INIT', response(429, 'secret body')),
    error => error.code === 'X_MEDIA_INIT_FAILED' && error.httpStatus === 429 && !error.message.includes('secret body'));
});

test('X video upload runs INIT, multipart APPEND, FINALIZE and STATUS once and journals only safe request summaries', async t => {
  const journalDir = await tempDir(t);
  const mediaId = '9876543210123456789';
  const requests = [];
  const result = await runXVideoUploadProtocol(mp4Bytes(), {
    runKey: 'video-protocol-test', journalDir, sleep: async () => {},
    sendRequest: async request => {
      requests.push(request);
      const query = new URL(request.url).searchParams;
      if (query.get('command') === 'INIT') return response(200, JSON.stringify({ media_id_string: mediaId }));
      if (query.get('command') === 'APPEND') return response(204);
      if (query.get('command') === 'FINALIZE') return response(200, JSON.stringify({ processing_info: { state: 'pending', check_after_secs: 1 } }));
      if (query.get('command') === 'STATUS') return response(200, JSON.stringify({ processing_info: { state: 'succeeded' } }));
      throw new Error('UNEXPECTED_X_MEDIA_COMMAND');
    },
  });

  assert.deepEqual(result, { mediaId, bytes: 4096, processed: true });
  assert.deepEqual(requests.map(request => new URL(request.url).searchParams.get('command')),
    ['INIT', 'APPEND', 'FINALIZE', 'STATUS']);
  assert.equal(requests[0].method, 'POST');
  assert.equal(new URL(requests[0].url).searchParams.get('media_category'), 'tweet_video');
  assert.match(requests[1].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(requests[1].body.includes(Buffer.from('name="media"')), true);
  assert.equal(requests[3].method, 'GET');

  const files = await readdir(journalDir);
  assert.equal(files.length, 4);
  const journal = (await Promise.all(files.map(file => readFile(path.join(journalDir, file), 'utf8')))).join('');
  assert.equal(journal.includes(mediaId), false);
  assert.equal(journal.includes('cookie'), false);
  assert.equal(journal.includes('secret'), false);
  assert.equal((journal.match(/"type":"intent"/g) ?? []).length, 4);
  assert.equal((journal.match(/"type":"result"/g) ?? []).length, 4);
});

test('X requires explicit processing state and an APPEND service error stops the sequence', async t => {
  const finalizeJournal = await tempDir(t);
  let finalizeCalls = 0;
  await assert.rejects(runXVideoUploadProtocol(mp4Bytes(), { runKey: 'video-finalize-no-state', journalDir: finalizeJournal,
    sendRequest: async request => {
      finalizeCalls += 1;
      const command = new URL(request.url).searchParams.get('command');
      if (command === 'INIT') return response(200, '{"media_id_string":"1001"}');
      if (command === 'APPEND') return response(204);
      return response(200, '{"media_id_string":"1001"}');
    } }), { code: 'X_MEDIA_FINALIZE_SCHEMA' });
  assert.equal(finalizeCalls, 3);

  const statusJournal = await tempDir(t);
  await assert.rejects(runXVideoUploadProtocol(mp4Bytes(), { runKey: 'video-status-no-state', journalDir: statusJournal,
    sleep: async () => {}, sendRequest: async request => {
      const command = new URL(request.url).searchParams.get('command');
      if (command === 'INIT') return response(200, '{"media_id_string":"1003"}');
      if (command === 'APPEND') return response(204);
      if (command === 'FINALIZE') return response(200, '{"processing_info":{"state":"pending","check_after_secs":1}}');
      return response(200, '{"media_id_string":"1003"}');
    } }), { code: 'X_MEDIA_STATUS_SCHEMA' });

  const failedJournal = await tempDir(t);
  const failedCommands = [];
  await assert.rejects(runXVideoUploadProtocol(mp4Bytes(), { runKey: 'video-append-error', journalDir: failedJournal,
    sendRequest: async request => {
      const command = new URL(request.url).searchParams.get('command');
      failedCommands.push(command);
      return command === 'INIT' ? response(200, '{"media_id_string":"1002"}')
        : response(200, '{"errors":[{"message":"token=must-not-leak"}]}');
    } }), error => error.code === 'X_MEDIA_APPEND_REJECTED' && !error.message.includes('must-not-leak'));
  assert.deepEqual(failedCommands, ['INIT', 'APPEND']);
  const journal = (await Promise.all((await readdir(failedJournal)).map(file => readFile(path.join(failedJournal, file), 'utf8')))).join('');
  // A four-digit ID can occur by chance inside a digest or ISO timestamp.
  // Validate those typed fields before checking all remaining persisted data.
  const semanticJournal = JSON.stringify(journal.trim().split('\n').map(JSON.parse), (key, value) => {
    if (key === 'bodySha256') { assert.match(value, /^[a-f0-9]{64}$/); return '[sha256]'; }
    if (key === 'at') { assert.equal(new Date(value).toISOString(), value); return '[timestamp]'; }
    return value;
  });
  assert.equal(semanticJournal.includes('1002'), false);
  assert.equal(journal.includes('must-not-leak'), false);
});

test('X image upload plan follows the observed tweet_image INIT/APPEND/FINALIZE contract without loading a session', () => {
  const bytes = pngBytes();
  const plan = buildXImageUploadPlan({ bytes, filename: 'product.png', mimeType: 'image/png' });
  assert.equal(plan.operation, 'x_image_upload');
  assert.equal(plan.mediaCategory, 'tweet_image');
  assert.equal(plan.attachedPostIndex, 0);
  assert.equal(plan.imageSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(plan.requests.map(request => request.command), ['INIT', 'APPEND', 'FINALIZE']);
  const init = new URL(plan.requests[0].url);
  assert.equal(init.searchParams.get('media_type'), 'image/png');
  assert.equal(init.searchParams.get('media_category'), 'tweet_image');
  assert.equal(plan.requests[1].multipart.mimeType, 'image/png');
  assert.equal(plan.requests[2].url.includes('media_id'), true);
  assert.throws(() => buildXImageUploadPlan({ bytes: Buffer.from('bad'), filename: 'x.png', mimeType: 'image/png' }),
    { code: 'X_IMAGE_SIGNATURE_INVALID' });
});

test('X image upload journals the image digest and accepts the image finalize response without video processing_info', async t => {
  const journalDir = await tempDir(t);
  const bytes = pngBytes();
  const imageSha256 = createHash('sha256').update(bytes).digest('hex');
  const mediaId = '9876543210123456790';
  const requests = [];
  const result = await runXImageUploadProtocol({ bytes, filename: 'product.png', mimeType: 'image/png' }, {
    runKey: 'image-protocol-test', journalDir,
    sendRequest: async request => {
      requests.push(request);
      const command = new URL(request.url).searchParams.get('command');
      if (command === 'INIT') return response(200, JSON.stringify({ media_id_string: mediaId }));
      if (command === 'APPEND') return response(204);
      if (command === 'FINALIZE') return response(200, JSON.stringify({ media_id_string: mediaId }));
      throw new Error('UNEXPECTED_X_MEDIA_COMMAND');
    },
  });
  assert.deepEqual(result, { mediaId, bytes: bytes.length, processed: true, imageSha256 });
  assert.deepEqual(requests.map(request => new URL(request.url).searchParams.get('command')), ['INIT', 'APPEND', 'FINALIZE']);
  assert.equal(new URL(requests[0].url).searchParams.get('media_category'), 'tweet_image');
  assert.match(requests[1].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(requests[1].body.toString('latin1'), /Content-Type: image\/png/);
  const files = await readdir(journalDir);
  const journal = (await Promise.all(files.map(file => readFile(path.join(journalDir, file), 'utf8')))).join('');
  assert.equal((journal.match(new RegExp(imageSha256, 'g')) ?? []).length, 3);
  assert.equal(journal.includes(mediaId), false);
  assert.equal(journal.includes(bytes.toString('base64')), false);
});
