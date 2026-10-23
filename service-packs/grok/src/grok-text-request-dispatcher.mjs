import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.mjs';

const HELPER_PATH = fileURLToPath(new URL('../scripts/grok-text-request-transport.py', import.meta.url));
const SOCKET_PATH = '/ws/mgw/';
const MAX_START_PACKET_BYTES = 256 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_CASTLE_TOKEN_BYTES = 8_192;
const MAX_RESULT_LINE_BYTES = 64 * 1024;
const REQUEST_METADATA_HEADERS = new Set(['x-statsig-id', 'x-xai-request-id']);
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeHeaders(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !REQUEST_METADATA_HEADERS.has(key.toLowerCase()))) {
    throw fail('TEXT_REQUEST_METADATA_HEADERS_INVALID');
  }
  const result = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== 'string' || !header.trim() || header.length > 2_048 || /[\r\n\0]/.test(header)) {
      throw fail('TEXT_REQUEST_METADATA_HEADERS_INVALID');
    }
    result[name.toLowerCase()] = header;
  }
  return result;
}

function validateSocketUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('TEXT_REQUEST_SOCKET_URL_INVALID'); }
  const queryKeys = [...url.searchParams.keys()];
  if (url.protocol !== 'wss:' || url.hostname !== 'grok.com' || url.port || url.username || url.password
    || url.pathname !== SOCKET_PATH || url.hash || queryKeys.length !== 1 || queryKeys[0] !== 'uid'
    || !url.searchParams.get('uid') || url.searchParams.getAll('uid').length !== 1) {
    throw fail('TEXT_REQUEST_SOCKET_URL_INVALID');
  }
  return url.href;
}

function validateCookieHeader(value) {
  if (typeof value !== 'string' || !value.startsWith('sso=') || !value.slice(4)
    || value.includes(';') || value.length > 16_384 || /[\r\n\0]/.test(value)) {
    throw fail('TEXT_REQUEST_COOKIE_SCOPE_INVALID');
  }
  return value;
}

function validateControlFrame(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 64 * 1024) {
    throw fail('TEXT_REQUEST_CONTROL_FRAME_INVALID');
  }
  let frame;
  try { frame = JSON.parse(value); } catch { throw fail('TEXT_REQUEST_CONTROL_FRAME_INVALID'); }
  const event = frame?.event;
  if (!plainObject(frame) || JSON.stringify(Object.keys(frame).sort()) !== JSON.stringify(['event'])
    || !plainObject(event) || event.type !== 'session.create' || !UUID4.test(String(event.event_id ?? '').replace(/^evt_init_/, ''))
    || !plainObject(event.session) || typeof event.session.model !== 'string' || !event.session.model.trim()) {
    throw fail('TEXT_REQUEST_CONTROL_FRAME_INVALID');
  }
  return value;
}

function validateBusinessFrame(value, sessionId) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_FRAME_BYTES) {
    throw fail('TEXT_REQUEST_BUSINESS_FRAME_INVALID');
  }
  let frame;
  try { frame = JSON.parse(value); } catch { throw fail('TEXT_REQUEST_BUSINESS_FRAME_INVALID'); }
  const event = frame?.event;
  const item = event?.item;
  const xGrok = item?.x_grok;
  const chunks = xGrok?.input_chunks;
  const token = event?.castle_request_token;
  const text = chunks?.[0]?.text?.text;
  if (!plainObject(frame) || JSON.stringify(Object.keys(frame).sort()) !== JSON.stringify(['event', 'session_id'])
    || frame.session_id !== sessionId || !plainObject(event)
    || JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(['castle_request_token', 'event_id', 'item', 'type'])
    || event.type !== 'response.create' || !UUID4.test(event.event_id)
    || typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token)
    || Buffer.byteLength(token, 'utf8') > MAX_CASTLE_TOKEN_BYTES
    || !plainObject(item) || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['role', 'type', 'x_grok'])
    || item.type !== 'message' || item.role !== 'user' || !plainObject(xGrok)
    || JSON.stringify(Object.keys(xGrok).sort()) !== JSON.stringify(['client_message_id', 'input_chunks'])
    || !UUID4.test(xGrok.client_message_id) || !Array.isArray(chunks) || chunks.length !== 1
    || !plainObject(chunks[0]) || JSON.stringify(Object.keys(chunks[0]).sort()) !== JSON.stringify(['text'])
    || !plainObject(chunks[0].text) || JSON.stringify(Object.keys(chunks[0].text).sort()) !== JSON.stringify(['text'])
    || typeof text !== 'string' || !text.trim() || /\0/.test(text)) {
    throw fail('TEXT_REQUEST_BUSINESS_FRAME_INVALID');
  }
  return value;
}

function childEnvironment() {
  const environment = { PYTHONDONTWRITEBYTECODE: '1' };
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function noBusinessResult({ handshakeStatus = 0, normalControlFrameSentCount = 0, serverSessionAcknowledgementObserved = false } = {}) {
  return {
    handshakeStatus,
    normalControlFrameSentCount,
    serverSessionAcknowledgementObserved,
    businessFrameBoundToServerSession: false,
    businessFrameSentCount: 0,
    eventTypes: [],
    terminalEventObserved: false,
    privateConversationIdHints: [],
    privateResponseIdHints: [],
  };
}

function normalizeResult(value, { businessCommandSent, ackSessionId }) {
  if (!plainObject(value) || value.kind !== 'result' || !plainObject(value.result)) throw fail('TEXT_REQUEST_TRANSPORT_RESULT_INVALID');
  const result = value.result;
  const int = field => Number.isInteger(result[field]) ? result[field] : null;
  const status = int('handshakeStatus');
  const controlCount = int('normalControlFrameSentCount');
  const businessCount = int('businessFrameSentCount');
  const ack = result.serverSessionAcknowledgementObserved === true;
  const bound = result.businessFrameBoundToServerSession === true;
  if (status === null || controlCount === null || controlCount < 0 || controlCount > 1
    || businessCount === null || businessCount < 0 || businessCount > 1
    || businessCount > Number(businessCommandSent) || businessCount === 1 && (!ack || !bound || !businessCommandSent)
    || businessCommandSent && businessCount !== 1
    || ack && !ackSessionId || bound && !ack) {
    throw fail('TEXT_REQUEST_TRANSPORT_RESULT_INVALID');
  }
  const eventTypes = result.eventTypes ?? [];
  const hints = (name) => {
    const values = result[name] ?? [];
    if (!Array.isArray(values) || values.length > 32
      || values.some(item => typeof item !== 'string' || !item || item.length > 512 || /[\r\n\0]/.test(item))) {
      throw fail('TEXT_REQUEST_TRANSPORT_RESULT_INVALID');
    }
    return [...new Set(values)];
  };
  if (!Array.isArray(eventTypes) || eventTypes.length > 128
    || eventTypes.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_.-]{0,95}$/.test(item))) {
    throw fail('TEXT_REQUEST_TRANSPORT_RESULT_INVALID');
  }
  return {
    handshakeStatus: status,
    normalControlFrameSentCount: controlCount,
    serverSessionAcknowledgementObserved: ack,
    businessFrameBoundToServerSession: bound,
    businessFrameSentCount: businessCount,
    eventTypes: [...new Set(eventTypes)],
    terminalEventObserved: result.terminalEventObserved === true,
    privateConversationIdHints: hints('conversationIdHints'),
    privateResponseIdHints: hints('responseIdHints'),
  };
}

/** Create the checked-in two-phase Python WSS dispatcher used by text requests. */
export function createPythonGrokTextRequestDispatcher({
  pythonExecutable,
  timeoutMs = 120_000,
  spawnImpl = spawn,
} = {}) {
  const executable = pythonExecutable ?? process.env.GROK_TEXT_WS_PYTHON ?? 'python3';
  if (typeof executable !== 'string' || !executable.trim() || /[\r\n\0]/.test(executable)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000
    || typeof spawnImpl !== 'function') {
    throw fail('TEXT_REQUEST_DISPATCH_OPTIONS_INVALID');
  }

  return async function dispatchTextRequest({
    socketUrl,
    cookieHeader,
    requestMetadataHeaders,
    controlFrameText,
    buildBusinessFrameText,
  } = {}) {
    const startPacket = {
      kind: 'start',
      socketUrl: validateSocketUrl(socketUrl),
      cookieHeader: validateCookieHeader(cookieHeader),
      requestMetadataHeaders: safeHeaders(requestMetadataHeaders ?? {}),
      controlFrameText: validateControlFrame(controlFrameText),
      timeoutMs,
    };
    const startLine = Buffer.from(`${JSON.stringify(startPacket)}\n`, 'utf8');
    if (startLine.length > MAX_START_PACKET_BYTES) {
      startLine.fill(0);
      throw fail('TEXT_REQUEST_PACKET_TOO_LARGE');
    }
    if (typeof buildBusinessFrameText !== 'function') {
      startLine.fill(0);
      throw fail('TEXT_REQUEST_FRAME_BUILDER_REQUIRED');
    }

    return await new Promise((resolve, reject) => {
      let child;
      let lineReader;
      let ackSessionId = null;
      let builderCalled = false;
      let businessCommandSent = false;
      let businessFrameBuildFailed = false;
      let settled = false;
      let stageTimer;

      const fallback = () => noBusinessResult({
        handshakeStatus: ackSessionId ? 101 : 0,
        normalControlFrameSentCount: ackSessionId ? 1 : 0,
        serverSessionAcknowledgementObserved: Boolean(ackSessionId),
      });
      const stopChild = () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGTERM'); } catch { /* The helper may already have exited. */ }
        }
      };
      const finish = (error, result, { kill = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(stageTimer);
        lineReader?.close();
        startLine.fill(0);
        if (error || kill) {
          stopChild();
          if (error) reject(error);
          else resolve(result);
        } else {
          try { child?.stdin?.end(); } catch { /* A completed helper may already have closed stdin. */ }
          resolve(result);
        }
      };
      const stageTimeout = () => {
        if (businessCommandSent) finish(fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN'));
        else finish(null, fallback(), { kill: true });
      };
      const armStageTimeout = milliseconds => {
        clearTimeout(stageTimer);
        stageTimer = setTimeout(stageTimeout, milliseconds);
      };
      const writeCommand = value => new Promise((ok, bad) => {
        let packet;
        try { packet = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); } catch { bad(fail('TEXT_REQUEST_IPC_INVALID')); return; }
        if (packet.length > MAX_FRAME_BYTES + 8_192) {
          packet.fill(0);
          bad(fail('TEXT_REQUEST_IPC_SIZE_INVALID'));
          return;
        }
        try {
          child.stdin.write(packet, error => {
            packet.fill(0);
            if (error) bad(fail('TEXT_REQUEST_IPC_WRITE_FAILED'));
            else ok();
          });
        } catch {
          packet.fill(0);
          bad(fail('TEXT_REQUEST_IPC_WRITE_FAILED'));
        }
      });
      const abortBeforeSend = async () => {
        businessFrameBuildFailed = true;
        try { await writeCommand({ kind: 'abort' }); } catch { /* No business frame is sent on this branch. */ }
        if (!settled) armStageTimeout(2_000);
      };
      const onLine = async line => {
        if (settled) return;
        if (Buffer.byteLength(line, 'utf8') > MAX_RESULT_LINE_BYTES) {
          finish(businessCommandSent ? fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN') : fail('TEXT_REQUEST_IPC_RESULT_INVALID'));
          return;
        }
        let message;
        try { message = JSON.parse(line); } catch {
          finish(businessCommandSent ? fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN') : fail('TEXT_REQUEST_IPC_RESULT_INVALID'));
          return;
        }
        if (message?.kind === 'session_ack') {
          const id = message.sessionId;
          if (message.handshakeStatus !== 101 || message.normalControlFrameSentCount !== 1
            || message.serverSessionAcknowledgementObserved !== true
            || typeof id !== 'string' || !id.trim() || id.length > 512 || /[\r\n\0]/.test(id)) {
            finish(businessCommandSent ? fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN') : fail('TEXT_REQUEST_SESSION_ACK_INVALID'));
            return;
          }
          if (ackSessionId !== null) {
            if (ackSessionId !== id) finish(businessCommandSent ? fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN') : fail('TEXT_REQUEST_SESSION_ACK_CONFLICT'));
            return;
          }
          ackSessionId = id;
          if (builderCalled) return;
          builderCalled = true;
          clearTimeout(stageTimer);
          armStageTimeout(timeoutMs + 2_000);
          let frameText;
          try {
            frameText = await buildBusinessFrameText(id);
            if (settled) return;
            validateBusinessFrame(frameText, id);
          } catch {
            await abortBeforeSend();
            return;
          }
          if (settled) return;
          businessCommandSent = true;
          try {
            await writeCommand({ kind: 'business_frame', frameText });
            frameText = null;
            if (!settled) armStageTimeout(timeoutMs + 2_000);
          } catch {
            finish(fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN'));
          }
          return;
        }
        if (message?.kind === 'result') {
          if (businessFrameBuildFailed && message.result?.businessFrameSentCount === 1) {
            finish(fail('TEXT_REQUEST_TRANSPORT_RESULT_INVALID'));
            return;
          }
          try { finish(null, normalizeResult(message, { businessCommandSent, ackSessionId })); }
          catch (error) { finish(businessCommandSent ? fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN') : error); }
          return;
        }
        finish(businessCommandSent ? fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN') : fail('TEXT_REQUEST_IPC_RESULT_INVALID'));
      };

      try {
        child = spawnImpl(executable, [HELPER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment() });
      } catch {
        finish(fail('TEXT_REQUEST_TRANSPORT_START_FAILED'));
        return;
      }
      if (!child?.stdin || !child?.stdout || !child?.stderr) {
        finish(fail('TEXT_REQUEST_TRANSPORT_START_FAILED'));
        return;
      }
      lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lineReader.on('line', line => { void onLine(line); });
      child.stderr.on('data', () => {});
      child.on('error', () => finish(businessCommandSent
        ? fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN') : fail('TEXT_REQUEST_TRANSPORT_START_FAILED')));
      child.on('close', () => {
        if (settled) return;
        if (businessCommandSent) finish(fail('TEXT_REQUEST_DISPATCH_OUTCOME_UNKNOWN'));
        else finish(null, fallback());
      });
      armStageTimeout(Math.min(20_000, timeoutMs) + 3_000);
      child.stdin.write(startLine, error => {
        startLine.fill(0);
        if (error) finish(fail('TEXT_REQUEST_TRANSPORT_START_FAILED'));
      });
    });
  };
}
