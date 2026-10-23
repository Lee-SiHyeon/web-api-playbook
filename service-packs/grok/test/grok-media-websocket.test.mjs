import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  encodeGrokWebSocketFrame,
  openGrokImagineWebSocket,
  readGrokImagineMessages,
  sendGrokImagineFrames,
  summarizeGrokImagineMessages,
} from '../src/grok-media-websocket.mjs';
import { GROK_WEB_ORIGIN } from '../src/session.mjs';

function decodeMaskedFrame(frame) {
  const opcode = frame[0] & 0x0f;
  const masked = (frame[1] & 0x80) !== 0;
  let length = frame[1] & 0x7f;
  let offset = 2;
  if (length === 126) { length = frame.readUInt16BE(offset); offset += 2; }
  else if (length === 127) { length = Number(frame.readBigUInt64BE(offset)); offset += 8; }
  assert.equal(masked, true);
  const mask = frame.subarray(offset, offset + 4); offset += 4;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload };
}

class FakeSocket extends EventEmitter {
  writes = [];
  write(value) { this.writes.push(Buffer.from(value)); return true; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

class FakeRequest extends EventEmitter {
  constructor(options) { super(); this.options = options; }
  setTimeout() {}
  end() {
    const key = this.options.headers['Sec-WebSocket-Key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    this.socket ??= new FakeSocket();
    setImmediate(() => this.emit('upgrade', { statusCode: 101, headers: { upgrade: 'websocket', 'sec-websocket-accept': accept } }, this.socket, Buffer.alloc(0)));
  }
  destroy() { this.destroyed = true; }
}

test('outgoing WebSocket frames are final, masked client frames with the correct payload', () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = encodeGrokWebSocketFrame(1, 'hello', { mask });
  const decoded = decodeMaskedFrame(frame);
  assert.equal(decoded.opcode, 1);
  assert.equal(decoded.payload.toString(), 'hello');
  assert.equal((frame[0] & 0x80) !== 0, true);
});

test('per-message API submits exactly the two observed frame shapes', async () => {
  const sent = [];
  const result = await sendGrokImagineFrames({ sendJson: async value => sent.push(value) }, [
    { type: 'conversation.item.create', item: { type: 'message', content: [{ type: 'reset' }] } },
    { type: 'conversation.item.create', item: { type: 'message', content: [{ type: 'input_text' }] } },
  ]);
  assert.equal(result.framesSent, 2);
  assert.equal(result.operationFrameSent, 1);
  assert.equal(result.automaticRetries, false);
  assert.equal(sent.length, 2);
  await assert.rejects(sendGrokImagineFrames({ sendJson() {} }, [{}, {}, {}]), { code: 'MEDIA_WS_SUBMIT_INVALID' });
});

test('WebSocket reads retain private correlation values in memory and summaries omit them', async () => {
  const frames = [
    { type: 'conversation.item.created', item: { id: 'private-id', status: 'accepted' } },
    { assetId: 'private-asset', url: 'https://assets.grok.com/signed' },
  ];
  const result = await readGrokImagineMessages({ nextMessage: async () => frames.shift() }, { maxMessages: 2, timeoutMs: 500 });
  assert.equal(result[0].item.id, 'private-id');
  assert.equal(result[1].assetId, 'private-asset');
  const summary = summarizeGrokImagineMessages(result);
  assert.deepEqual(summary[0], {
    type: 'conversation.item.created', fieldNames: ['item', 'type'], itemFieldNames: ['id', 'status'],
    eventType: null, eventFieldNames: [],
  });
  assert.doesNotMatch(JSON.stringify(summary), /private-id|private-asset|assets\.grok\.com|signed/);
});

test('WebSocket handshake requires an owner-bound in-memory session and scopes cookies', async () => {
  const socket = new FakeSocket();
  let optionsSeen;
  const session = {
    generation: 'generation-one',
    ownerBinding: { generation: 'generation-one' },
    origins: [{
      origin: GROK_WEB_ORIGIN,
      cookies: [{ name: 'sso', value: 'synthetic-cookie', origin: GROK_WEB_ORIGIN, domain: 'grok.com', path: '/', secure: true }],
      headers: [],
    }],
  };
  const sessionPersistence = {
    async read() { return { kind: 'grok-session', session }; },
  };
  const requestMetadataProvider = async ({ operation, phase }) => {
    assert.equal(operation, 'media.image.create');
    assert.equal(phase, 'websocket_handshake');
    return { 'x-xai-request-id': 'fresh-test-request-id' };
  };
  const connection = await openGrokImagineWebSocket({
    sessionPersistence,
    cookieNames: ['sso'],
    requestMetadataProvider,
    requestImpl(options) {
      optionsSeen = options;
      const request = new FakeRequest(options);
      request.socket = socket;
      return request;
    },
  });
  assert.equal(optionsSeen.hostname, 'grok.com');
  assert.equal(optionsSeen.path, '/ws/imagine/listen');
  assert.equal(optionsSeen.headers.Cookie, 'sso=synthetic-cookie');
  assert.equal(optionsSeen.headers.Origin, GROK_WEB_ORIGIN);
  assert.equal(optionsSeen.headers['x-xai-request-id'], 'fresh-test-request-id');
  connection.sendJson({ type: 'probe' });
  assert.equal(decodeMaskedFrame(socket.writes[0]).payload.toString(), '{"type":"probe"}');
  connection.close();
});

test('WebSocket handshake refuses a session without owner verification before networking', async () => {
  let networkCalls = 0;
  const sessionPersistence = { async read() { return { kind: 'grok-session', session: { generation: 'g1', ownerBinding: null } }; } };
  await assert.rejects(openGrokImagineWebSocket({
    sessionPersistence,
    cookieNames: ['sso'],
    requestImpl() { networkCalls++; return new FakeRequest({ headers: {} }); },
  }), { code: 'OWNER_VERIFICATION_REQUIRED' });
  assert.equal(networkCalls, 0);
});
