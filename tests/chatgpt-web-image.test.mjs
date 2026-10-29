import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UsageError, conversationIdFromPath, decodeDataUrl, findGeneratedImages, imageGenLimit, parseArgs, redactFileId, selectImageCandidate,
} from '../lib/chatgpt-web-image.mjs';

test('parseArgs: phone is the default target and uses the forwarded CDP port 9471', () => {
  const opts = parseArgs(['out/a.png', '--prompt=고양이']);
  assert.equal(opts.target, 'phone');
  assert.equal(opts.cdp, 'http://127.0.0.1:9471');
  assert.equal(opts.cdpOverride, false);
  assert.equal(opts.out, 'out/a.png');
  assert.equal(opts.prompt, '고양이');
  assert.equal(opts.timeoutSec, 300);
  assert.equal(opts.probe, false);
  assert.equal(opts.keepTab, false);
});

test('parseArgs: pc target uses the PC Canary port 9333', () => {
  const opts = parseArgs(['a.png', '--prompt=x', '--target=pc']);
  assert.equal(opts.cdp, 'http://127.0.0.1:9333');
});

test('parseArgs: --cdp overrides the target default and is marked as an override', () => {
  const opts = parseArgs(['a.png', '--prompt=x', '--target=pc', '--cdp=http://127.0.0.1:9999/']);
  assert.equal(opts.cdp, 'http://127.0.0.1:9999');
  assert.equal(opts.cdpOverride, true);
});

test('parseArgs: prompt may contain "=" and flags can come before the output path', () => {
  const opts = parseArgs(['--timeout=60', '--prompt=a=b c', '--keep-tab', 'out.png']);
  assert.equal(opts.prompt, 'a=b c');
  assert.equal(opts.timeoutSec, 60);
  assert.equal(opts.keepTab, true);
  assert.equal(opts.out, 'out.png');
});

test('parseArgs: --probe needs neither output path nor prompt', () => {
  const opts = parseArgs(['--probe']);
  assert.equal(opts.probe, true);
  assert.equal(opts.out, null);
});

test('parseArgs: --quota needs neither output path nor prompt', () => {
  const opts = parseArgs(['--quota']);
  assert.equal(opts.quota, true);
  assert.equal(parseArgs(['--quota', '--target=pc']).cdp, 'http://127.0.0.1:9333');
});

test('parseArgs: rejects bad input with UsageError', () => {
  assert.throws(() => parseArgs(['a.png']), UsageError);
  assert.throws(() => parseArgs(['--prompt=x']), UsageError);
  assert.throws(() => parseArgs(['a.png', '--prompt=x', '--target=tablet']), UsageError);
  assert.throws(() => parseArgs(['a.png', '--prompt=x', '--target']), UsageError);
  assert.throws(() => parseArgs(['a.png', '--prompt=x', '--cdp=9333']), UsageError);
  assert.throws(() => parseArgs(['a.png', '--prompt=x', '--timeout=0']), UsageError);
  assert.throws(() => parseArgs(['a.png', '--prompt=x', '--timeout']), UsageError);
  assert.throws(() => parseArgs(['a.png', 'b.png', '--prompt=x']), UsageError);
  assert.throws(() => parseArgs(['a.png', '--prompt=x', '--bogus']), UsageError);
  assert.throws(() => parseArgs(['a.png', '--prompt=x', '--target=constructor']), UsageError);
});

const big = (src, extra = {}) => ({ src, alt: '', w: 1672, previewParent: false, ...extra });

test('selectImageCandidate: ignores images narrower than 512 px', () => {
  const picked = selectImageCandidate([big('blob:a', { w: 511 }), big('blob:b', { w: 512 })]);
  assert.equal(picked.src, 'blob:b');
  assert.equal(selectImageCandidate([big('blob:a', { w: 300 })]), null);
});

test('selectImageCandidate: ignores srcs that were present before sending', () => {
  const candidates = [big('blob:old'), big('blob:new')];
  assert.equal(selectImageCandidate(candidates, new Set(['blob:old'])).src, 'blob:new');
  assert.equal(selectImageCandidate(candidates, ['blob:old', 'blob:new']), null);
});

test('selectImageCandidate: prefers the generated-image preview over plain large images', () => {
  const picked = selectImageCandidate([
    big('blob:plain'),
    big('blob:preview', { previewParent: true }),
    big('blob:later-plain'),
  ]);
  assert.equal(picked.src, 'blob:preview');
});

test('selectImageCandidate: prefers the generated alt text, and the last of equal candidates', () => {
  assert.equal(selectImageCandidate([big('blob:x', { alt: '사진' }), big('blob:y', { alt: '생성된 이미지 1' })]).src, 'blob:y');
  assert.equal(selectImageCandidate([big('blob:x', { alt: 'Generated image 1' }), big('blob:y', { alt: 'Generated image 2' })]).src, 'blob:y');
  assert.equal(selectImageCandidate([big('blob:x'), big('blob:y')]).src, 'blob:y');
});

test('selectImageCandidate: empty input returns null', () => {
  assert.equal(selectImageCandidate([]), null);
});

test('decodeDataUrl: base64 PNG gives mime and exact bytes', () => {
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { mime, bytes } = decodeDataUrl(`data:image/png;base64,${raw.toString('base64')}`);
  assert.equal(mime, 'image/png');
  assert.deepEqual(bytes, raw);
});

test('decodeDataUrl: non-base64 data URL is percent-decoded', () => {
  const { mime, bytes } = decodeDataUrl('data:text/plain,a%20b');
  assert.equal(mime, 'text/plain');
  assert.equal(bytes.toString('utf8'), 'a b');
});

test('decodeDataUrl: missing mime falls back to application/octet-stream', () => {
  assert.equal(decodeDataUrl('data:;base64,AAE=').mime, 'application/octet-stream');
});

test('decodeDataUrl: rejects anything that is not a data URL', () => {
  assert.throws(() => decodeDataUrl('blob:https://chatgpt.com/abc'), /not a data URL/);
  assert.throws(() => decodeDataUrl(undefined), /not a data URL/);
});

// Synthetic fixture shaped like GET /backend-api/conversations/{id} (ids and content invented).
const FILE_A = 'file_0123456789abcdef0123456789abcdef';
const FILE_B = 'file_fedcba9876543210fedcba9876543210';
const imagePart = (fileId, extra = {}) => ({
  content_type: 'image_asset_pointer',
  asset_pointer: `sediment://${fileId}`,
  mime_type: 'image/png',
  size_bytes: 1042248,
  width: 1672,
  height: 941,
  metadata: { dalle: { gen_id: 'gen_synthetic' } },
  ...extra,
});
const toolMessage = (id, parts, extra = {}) => ({
  id,
  author: { role: 'tool', name: 't2uay3k.image_gen' },
  content: { content_type: 'multimodal_text', parts },
  status: 'finished_successfully',
  ...extra,
});

test('findGeneratedImages: reads finished image-tool pointers from a mapping tree', () => {
  const conversation = {
    current_node: 'n3',
    mapping: {
      n1: { message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['Create an image'] } } },
      n2: { message: { id: 't1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['text'] } } },
      n3: { message: toolMessage('t2', [imagePart(FILE_A), 'ignored text']) },
    },
  };
  assert.deepEqual(findGeneratedImages(conversation), [{
    fileId: FILE_A, mimeType: 'image/png', width: 1672, height: 941, sizeBytes: 1042248, genId: 'gen_synthetic',
  }]);
});

test('findGeneratedImages: also reads a messages array and dedupes by file id', () => {
  const conversation = { messages: [toolMessage('t1', [imagePart(FILE_A)]), toolMessage('t2', [imagePart(FILE_A), imagePart(FILE_B)])] };
  assert.deepEqual(findGeneratedImages(conversation).map((i) => i.fileId), [FILE_A, FILE_B]);
});

test('findGeneratedImages: ignores unfinished messages, other tools, and non-image parts', () => {
  const conversation = {
    messages: [
      toolMessage('running', [imagePart(FILE_A)], { status: 'in_progress' }),
      toolMessage('other', [imagePart(FILE_A)], { author: { role: 'tool', name: 'python' } }),
      { id: 'asst', author: { role: 'assistant' }, content: { content_type: 'multimodal_text', parts: [imagePart(FILE_B)] }, status: 'finished_successfully' },
      toolMessage('bad', [imagePart('https://example.test/x.png')]),
    ],
  };
  assert.deepEqual(findGeneratedImages(conversation), []);
  assert.deepEqual(findGeneratedImages({}), []);
  assert.deepEqual(findGeneratedImages(null), []);
});

test('redactFileId keeps only the last six characters', () => {
  assert.equal(redactFileId(FILE_A), `…${FILE_A.slice(-6)}`);
  assert.ok(!redactFileId(FILE_A).includes(FILE_A.slice(0, 20)));
});

test('conversationIdFromPath reads /c/<id> only', () => {
  assert.equal(conversationIdFromPath('/c/69abc-def01'), '69abc-def01');
  assert.equal(conversationIdFromPath('/c/abc-123/extra'), 'abc-123');
  assert.equal(conversationIdFromPath('/'), null);
  assert.equal(conversationIdFromPath(undefined), null);
});

test('imageGenLimit picks the image_gen entry from conversation/init', () => {
  const init = {
    type: 'conversation_detail_metadata',
    limits_progress: [
      { feature_name: 'deep_research', remaining: 250, reset_after: '2026-11-28T00:00:14.419782+00:00' },
      { feature_name: 'image_gen', remaining: 1000, reset_after: '2026-10-30T00:00:14.419800+00:00' },
    ],
  };
  assert.deepEqual(imageGenLimit(init), { remaining: 1000, resetAfter: '2026-10-30T00:00:14.419800+00:00' });
  assert.equal(imageGenLimit({ limits_progress: [] }), null);
  assert.equal(imageGenLimit({}), null);
});
