import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createPythonGrokTextRequestDispatcher } from '../src/grok-text-request-dispatcher.mjs';

const CONTROL = JSON.stringify({ event: {
  type: 'session.create',
  event_id: 'evt_init_00000000-0000-4000-8000-000000000001',
  session: { model: 'grok-4.7', x_grok: { connector_ids: ['connector-a', 'connector-b', 'connector-c'] } },
} });
const SESSION_ID = 'direct-session-issued-by-ack';

function businessFrameText(sessionId) {
  return JSON.stringify({
    session_id: sessionId,
    event: {
      type: 'response.create',
      event_id: '00000000-0000-4000-8000-000000000002',
      castle_request_token: 'fixture-only-token',
      item: {
        type: 'message',
        role: 'user',
        x_grok: {
          client_message_id: '00000000-0000-4000-8000-000000000003',
          input_chunks: [{ text: { text: 'fixture prompt' } }],
        },
      },
    },
  });
}

function result({ sent = false, ack = true } = {}) {
  return {
    kind: 'result',
    result: {
      handshakeStatus: 101,
      normalControlFrameSentCount: 1,
      serverSessionAcknowledgementObserved: ack,
      businessFrameBoundToServerSession: sent,
      businessFrameSentCount: sent ? 1 : 0,
      eventTypes: ['session.created', ...(sent ? ['response.completed'] : [])],
      terminalEventObserved: sent,
      conversationIdHints: [],
      responseIdHints: [],
    },
  };
}

class FakeChild extends EventEmitter {
  constructor(onPacket) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.pendingInput = '';
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.pendingInput += chunk.toString('utf8');
        for (;;) {
          const newline = this.pendingInput.indexOf('\n');
          if (newline < 0) break;
          const line = this.pendingInput.slice(0, newline);
          this.pendingInput = this.pendingInput.slice(newline + 1);
          try { onPacket(JSON.parse(line), this); } catch { callback(new Error('fake_packet_parse_failed')); return; }
        }
        callback();
      },
    });
  }

  emitFragmented(value) {
    const line = Buffer.from(`${JSON.stringify(value)}\n`);
    const cuts = [Math.min(7, line.length), Math.min(19, line.length)];
    this.stdout.write(line.subarray(0, cuts[0]));
    this.stdout.write(line.subarray(cuts[0], cuts[1]));
    this.stdout.write(line.subarray(cuts[1]));
  }

  close() {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = 0;
    this.stdout.end();
    this.emit('close', 0, null);
  }

  kill(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.killed = true;
    this.signalCode = signal;
    this.stdout.end();
    this.emit('close', null, signal);
    return true;
  }
}

function fixture({ duplicateAck = false, withholdResult = false, callbackRejects = false, sendNotConfirmed = false } = {}) {
  const state = { child: null, packets: [], businessPackets: [], callbackCount: 0 };
  const spawnImpl = () => {
    const child = new FakeChild((packet, current) => {
      state.packets.push(packet);
      if (packet.kind === 'start') {
        const ack = {
          kind: 'session_ack',
          handshakeStatus: 101,
          normalControlFrameSentCount: 1,
          serverSessionAcknowledgementObserved: true,
          sessionId: SESSION_ID,
        };
        current.emitFragmented(ack);
        if (duplicateAck) current.emitFragmented(ack);
      } else if (packet.kind === 'business_frame') {
        state.businessPackets.push(packet);
        if (!withholdResult) {
          setImmediate(() => {
            current.emitFragmented(result({ sent: !sendNotConfirmed }));
            current.close();
          });
        }
      } else if (packet.kind === 'abort') {
        setImmediate(() => {
          current.emitFragmented(result({ sent: false }));
          current.close();
        });
      }
    });
    state.child = child;
    return child;
  };
  const dispatch = createPythonGrokTextRequestDispatcher({
    pythonExecutable: 'python-fixture',
    timeoutMs: 1_000,
    spawnImpl,
  });
  return {
    state,
    async run(buildBusinessFrameText = async sessionId => {
      state.callbackCount++;
      if (callbackRejects) throw new Error('fixture_provider_failure');
      return businessFrameText(sessionId);
    }) {
      return dispatch({
        socketUrl: 'wss://grok.com/ws/mgw/?uid=fixture-uid',
        cookieHeader: 'sso=fixture-cookie',
        requestMetadataHeaders: { 'x-xai-request-id': 'fixture-request-id' },
        controlFrameText: CONTROL,
        buildBusinessFrameText,
      });
    },
  };
}

test('default Python dispatcher handles fragmented IPC and binds one frame to the new session acknowledgement', async () => {
  const f = fixture();
  const reply = await f.run();
  assert.equal(reply.handshakeStatus, 101);
  assert.equal(reply.normalControlFrameSentCount, 1);
  assert.equal(reply.serverSessionAcknowledgementObserved, true);
  assert.equal(reply.businessFrameSentCount, 1);
  assert.equal(reply.businessFrameBoundToServerSession, true);
  assert.equal(f.state.callbackCount, 1);
  assert.equal(f.state.businessPackets.length, 1);
  const wireFrame = JSON.parse(f.state.businessPackets[0].frameText);
  assert.equal(wireFrame.session_id, SESSION_ID);
  assert.equal(JSON.stringify(reply).includes('fixture-only-token'), false);
  assert.equal(JSON.stringify(reply).includes('fixture prompt'), false);
});

test('a Castle callback rejection sends only abort and no business frame', async () => {
  const f = fixture({ callbackRejects: true });
  const reply = await f.run();
  assert.equal(reply.serverSessionAcknowledgementObserved, true);
  assert.equal(reply.businessFrameSentCount, 0);
  assert.equal(reply.businessFrameBoundToServerSession, false);
  assert.equal(f.state.callbackCount, 1);
  assert.equal(f.state.packets.some(packet => packet.kind === 'abort'), true);
  assert.equal(f.state.businessPackets.length, 0);
});

test('duplicate acknowledgements do not call the builder or send the business frame twice', async () => {
  const f = fixture({ duplicateAck: true });
  const reply = await f.run();
  assert.equal(reply.businessFrameSentCount, 1);
  assert.equal(f.state.callbackCount, 1);
  assert.equal(f.state.businessPackets.length, 1);
});

test('timeout after one business IPC is an unknown dispatch outcome', async () => {
  const f = fixture({ withholdResult: true });
  await assert.rejects(f.run(), { code: 'TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN' });
  assert.equal(f.state.callbackCount, 1);
  assert.equal(f.state.businessPackets.length, 1);
  assert.equal(f.state.child.killed, true);
});

test('helper result cannot downgrade an issued business IPC to a proven no-send result', async () => {
  const f = fixture({ sendNotConfirmed: true });
  await assert.rejects(f.run(), { code: 'TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN' });
  assert.equal(f.state.callbackCount, 1);
  assert.equal(f.state.businessPackets.length, 1);
});

test('missing dispatcher input is rejected before starting a child process', () => {
  const f = fixture();
  assert.throws(() => createPythonGrokTextRequestDispatcher({ pythonExecutable: 'python-fixture', spawnImpl: null }),
    { code: 'TEXT_REQUEST_DISPATCH_OPTIONS_INVALID' });
  assert.equal(f.state.child, null);
});
