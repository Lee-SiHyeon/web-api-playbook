import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseSse } from '../src/sse.mjs';

test('SSE parser handles split UTF-8, CRLF, comments, and multiline data', async () => {
  const bytes = Buffer.from(': keepalive\r\nid: 9\r\nevent: delta\r\ndata: 안녕\r\ndata: world\r\n\r\n');
  const stream = Readable.toWeb(Readable.from([bytes.subarray(0, 18), bytes.subarray(18, 23), bytes.subarray(23)]));
  const events = [];
  for await (const event of parseSse(stream)) events.push(event);
  assert.deepEqual(events, [{ event: 'delta', id: '9', data: '안녕\nworld' }]);
});

test('SSE parser bounds event and line sizes and does not interpret provider terminal markers', async () => {
  const stream = Readable.toWeb(Readable.from([Buffer.from('data: [DONE]\n\n')]));
  const events = [];
  for await (const event of parseSse(stream)) events.push(event);
  assert.deepEqual(events, [{ data: '[DONE]' }]);
  const oversized = Readable.toWeb(Readable.from([Buffer.from('data: abcdef\n\n')]));
  await assert.rejects(async () => { for await (const _event of parseSse(oversized, { maxLineBytes: 5 })) {} },
    (error) => error.code === 'SSE_EVENT_TOO_LARGE');
});
