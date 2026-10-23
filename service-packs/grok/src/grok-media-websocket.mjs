import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import { boundCredentials, GROK_WEB_ORIGIN } from './session.mjs';
import { fail } from './errors.mjs';

export const GROK_IMAGINE_SOCKET_PATH = '/ws/imagine/listen';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_MESSAGES = 64;
const ALLOWED_SDK_HEADERS = new Set(['x-statsig-id', 'x-xai-request-id']);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function safeCookieNames(names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > 32
    || names.some(name => typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name))) {
    throw fail('MEDIA_WS_COOKIE_BINDING_INVALID');
  }
  return [...new Set(names)];
}

function safeSdkHeaders(headers = {}) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) throw fail('MEDIA_WS_SDK_HEADERS_INVALID');
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!ALLOWED_SDK_HEADERS.has(normalized) || typeof value !== 'string' || !value.trim()
      || value.length > 1024 || /[\r\n\0]/.test(value)) throw fail('MEDIA_WS_SDK_HEADERS_INVALID');
    result[normalized] = value;
  }
  return result;
}

function challengeSignal(status, contentType, prefix, headers = {}) {
  if (status !== 403) return null;
  if (String(headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge') return 'challenge_header';
  if (!/html/i.test(contentType)) return null;
  const text = prefix.toString('utf8', 0, Math.min(prefix.length, 16 * 1024));
  if (/(?:challenge-platform|cf-chl-|cf-turnstile|captcha|verify you are human|checking your browser)/i.test(text)) {
    return 'challenge_markup';
  }
  return null;
}

export function encodeGrokWebSocketFrame(opcode, payload, { mask = randomBytes(4) } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 15 || data.length > MAX_FRAME_BYTES
    || !Buffer.isBuffer(mask) || mask.length !== 4) throw fail('MEDIA_WS_FRAME_INVALID');
  const lengthBytes = data.length < 126 ? 0 : data.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  if (!lengthBytes) header[1] = 0x80 | data.length;
  else if (lengthBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const maskAt = 2 + lengthBytes;
  mask.copy(header, maskAt);
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, masked]);
}

class GrokWebSocketConnection {
  #socket;
  #buffer;
  #queue = [];
  #waiters = [];
  #fragmentOpcode = null;
  #fragments = [];
  #fragmentBytes = 0;
  #closed = false;
  #failed = null;

  constructor(socket, head = Buffer.alloc(0), handshakeStatus = 101) {
    this.#socket = socket;
    this.#buffer = Buffer.from(head);
    this.handshakeStatus = handshakeStatus;
    socket.on('data', chunk => this.#consume(chunk));
    socket.on('error', () => this.#finish(fail('MEDIA_WS_CONNECTION_FAILED')));
    socket.on('close', () => this.#finish(fail('MEDIA_WS_CLOSED')));
    socket.on('end', () => this.#finish(fail('MEDIA_WS_CLOSED')));
    if (this.#buffer.length) this.#parse();
  }

  get closed() { return this.#closed; }

  sendJson(value) {
    if (this.#closed || this.#failed) throw fail('MEDIA_WS_NOT_OPEN');
    let text;
    try { text = JSON.stringify(value); } catch { throw fail('MEDIA_WS_MESSAGE_INVALID'); }
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FRAME_BYTES) throw fail('MEDIA_WS_MESSAGE_SIZE_LIMIT');
    this.#socket.write(encodeGrokWebSocketFrame(0x1, Buffer.from(text, 'utf8')));
  }

  nextMessage(timeoutMs = 30_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000) {
      return Promise.reject(fail('MEDIA_WS_TIMEOUT_INVALID'));
    }
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#failed) return Promise.reject(this.#failed);
    if (this.#closed) return Promise.reject(fail('MEDIA_WS_CLOSED'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter(item => item !== waiter);
        reject(fail('MEDIA_WS_READ_TIMEOUT'));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
    });
  }

  close() {
    if (this.#closed) return;
    for (const message of this.#queue) {
      if (Buffer.isBuffer(message)) message.fill(0);
    }
    this.#queue.length = 0;
    this.#buffer.fill(0);
    for (const fragment of this.#fragments) fragment.fill(0);
    this.#fragments.length = 0;
    this.#fragmentBytes = 0;
    try { this.#socket.write(encodeGrokWebSocketFrame(0x8, Buffer.alloc(0))); } catch { /* best effort close */ }
    this.#socket.end();
    this.#finish(fail('MEDIA_WS_CLOSED'));
  }

  #consume(chunk) {
    if (this.#closed || this.#failed) return;
    if (this.#buffer.length + chunk.length > MAX_FRAME_BYTES * 2) {
      this.#finish(fail('MEDIA_WS_BUFFER_LIMIT'));
      this.#socket.destroy();
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#parse();
  }

  #parse() {
    while (!this.#failed && !this.#closed) {
      if (this.#buffer.length < 2) return;
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (rsv !== 0 || masked) {
        this.#finish(fail('MEDIA_WS_FRAME_ENCODING_UNSUPPORTED'));
        this.#socket.destroy();
        return;
      }
      if (length === 126) {
        if (this.#buffer.length < offset + 2) return;
        length = this.#buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.#buffer.length < offset + 8) return;
        const largeLength = this.#buffer.readBigUInt64BE(offset);
        if (largeLength > BigInt(MAX_FRAME_BYTES)) {
          this.#finish(fail('MEDIA_WS_FRAME_SIZE_LIMIT'));
          this.#socket.destroy();
          return;
        }
        length = Number(largeLength);
        offset += 8;
      }
      if (length > MAX_FRAME_BYTES) {
        this.#finish(fail('MEDIA_WS_FRAME_SIZE_LIMIT'));
        this.#socket.destroy();
        return;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) {
        this.#finish(fail('MEDIA_WS_CONTROL_FRAME_INVALID'));
        this.#socket.destroy();
        return;
      }
      if (this.#buffer.length < offset + length) return;
      const payload = this.#buffer.subarray(offset, offset + length);
      this.#buffer = this.#buffer.subarray(offset + length);
      if (opcode === 0x9) {
        this.#socket.write(encodeGrokWebSocketFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x8) {
        this.#finish(fail('MEDIA_WS_CLOSED'));
        this.#socket.end();
        return;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.#fragmentOpcode !== null) {
          this.#finish(fail('MEDIA_WS_FRAGMENT_SEQUENCE_INVALID'));
          this.#socket.destroy();
          return;
        }
        if (fin) {
          this.#deliver(opcode, payload);
          continue;
        }
        this.#fragmentOpcode = opcode;
        this.#fragments = [Buffer.from(payload)];
        this.#fragmentBytes = payload.length;
        continue;
      }
      if (opcode === 0x0 && this.#fragmentOpcode !== null) {
        this.#fragmentBytes += payload.length;
        if (this.#fragmentBytes > MAX_FRAME_BYTES) {
          this.#finish(fail('MEDIA_WS_MESSAGE_SIZE_LIMIT'));
          this.#socket.destroy();
          return;
        }
        this.#fragments.push(Buffer.from(payload));
        if (fin) {
          const complete = Buffer.concat(this.#fragments, this.#fragmentBytes);
          const completeOpcode = this.#fragmentOpcode;
          this.#fragmentOpcode = null;
          this.#fragments = [];
          this.#fragmentBytes = 0;
          this.#deliver(completeOpcode, complete);
        }
        continue;
      }
      this.#finish(fail('MEDIA_WS_OPCODE_UNSUPPORTED'));
      this.#socket.destroy();
      return;
    }
  }

  #deliver(opcode, payload) {
    let value;
    if (opcode === 0x1) {
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch {
        this.#finish(fail('MEDIA_WS_JSON_INVALID'));
        this.#socket.destroy();
        return;
      }
    } else {
      value = Buffer.from(payload);
    }
    if (this.#waiters.length) {
      const waiter = this.#waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    if (this.#queue.length >= MAX_QUEUED_MESSAGES) {
      this.#finish(fail('MEDIA_WS_QUEUE_LIMIT'));
      this.#socket.destroy();
      return;
    }
    this.#queue.push(value);
  }

  #finish(error) {
    if (this.#closed || this.#failed) return;
    if (error?.code === 'MEDIA_WS_CLOSED') this.#closed = true;
    else this.#failed = error ?? fail('MEDIA_WS_CONNECTION_FAILED');
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      if (this.#failed) waiter.reject(this.#failed);
      else waiter.reject(fail('MEDIA_WS_CLOSED'));
    }
  }
}

function expectedAccept(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

function boundedBody(response, maxBytes = 16 * 1024) {
  return new Promise(resolve => {
    const chunks = [];
    let length = 0;
    response.on('data', chunk => {
      if (length >= maxBytes) return;
      const buffer = Buffer.from(chunk);
      const take = buffer.subarray(0, Math.min(buffer.length, maxBytes - length));
      chunks.push(take);
      length += take.length;
    });
    response.on('end', () => resolve(Buffer.concat(chunks, length)));
    response.on('close', () => resolve(Buffer.concat(chunks, length)));
  });
}

export async function openGrokImagineWebSocket({
  sessionPersistence,
  cookieNames,
  requestMetadataProvider,
  timeoutMs = 15_000,
  requestImpl = https.request,
} = {}) {
  if (!sessionPersistence || typeof sessionPersistence.read !== 'function' || typeof requestImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw fail('MEDIA_WS_OPTIONS_INVALID');
  const stored = await sessionPersistence.read();
  const session = stored?.session;
  if (stored?.kind !== 'grok-session' || !session || session.generation !== session.ownerBinding?.generation) {
    throw fail('OWNER_VERIFICATION_REQUIRED');
  }
  const bound = boundCredentials(session, GROK_WEB_ORIGIN, GROK_IMAGINE_SOCKET_PATH, {
    cookieNames: safeCookieNames(cookieNames),
    headerNames: [],
  });
  let sdkHeaders = {};
  if (requestMetadataProvider !== undefined) {
    if (typeof requestMetadataProvider !== 'function') throw fail('MEDIA_WS_SDK_PROVIDER_INVALID');
    sdkHeaders = safeSdkHeaders(await requestMetadataProvider({ operation: 'media.image.create', phase: 'websocket_handshake' }));
  }
  const key = randomBytes(16).toString('base64');
  const requestHeaders = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    Origin: GROK_WEB_ORIGIN,
    Referer: `${GROK_WEB_ORIGIN}/imagine`,
    Cookie: bound.cookieHeader,
    ...sdkHeaders,
  };

  const request = requestImpl({
    protocol: 'https:',
    hostname: 'grok.com',
    port: 443,
    method: 'GET',
    path: GROK_IMAGINE_SOCKET_PATH,
    headers: requestHeaders,
    timeout: timeoutMs,
  });

  const handshake = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    request.once('upgrade', (response, socket, head) => {
      const accept = response.headers['sec-websocket-accept'];
      const upgrade = String(response.headers.upgrade ?? '').toLowerCase();
      if (response.statusCode !== 101 || upgrade !== 'websocket' || accept !== expectedAccept(key)) {
        socket.destroy();
        finish(reject, fail('MEDIA_WS_HANDSHAKE_INVALID', { status: response.statusCode ?? null }));
        return;
      }
      finish(resolve, new GrokWebSocketConnection(socket, head, response.statusCode));
    });
    request.once('response', async response => {
      const status = Number.isInteger(response.statusCode) ? response.statusCode : 0;
      const contentType = String(response.headers['content-type'] ?? '').split(';', 1)[0].toLowerCase();
      const body = await boundedBody(response);
      const signal = challengeSignal(status, contentType, body, response.headers);
      body.fill(0);
      if (status >= 300 && status < 400) {
        finish(reject, fail('MEDIA_WS_REDIRECT_BLOCKED', { status }));
      } else if (signal) {
        finish(reject, fail('SECURITY_CHALLENGE_BLOCKED', { status, securitySignal: signal }));
      } else {
        finish(reject, fail(status === 401 ? 'AUTH_REQUIRED' : 'MEDIA_WS_HANDSHAKE_REJECTED', { status, contentType: contentType || null }));
      }
    });
    request.once('error', () => finish(reject, fail('MEDIA_WS_HANDSHAKE_FAILED')));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(reject, fail('MEDIA_WS_HANDSHAKE_TIMEOUT'));
    });
  });

  request.end();
  return handshake;
}

export async function sendGrokImagineFrames(connection, frames) {
  if (!connection || typeof connection.sendJson !== 'function' || !Array.isArray(frames) || ![1, 2].includes(frames.length)) {
    throw fail('MEDIA_WS_SUBMIT_INVALID');
  }
  for (const frame of frames) connection.sendJson(frame);
  return { framesSent: frames.length, operationFrameSent: 1, automaticRetries: false };
}

export async function readGrokImagineMessages(connection, {
  maxMessages = 64,
  timeoutMs = 10_000,
  overallTimeoutMs = timeoutMs * maxMessages,
  maxIdleTimeouts = 1,
  shouldStop = () => false,
  onMessage,
} = {}) {
  if (!connection || typeof connection.nextMessage !== 'function'
    || !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 64
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
    || !Number.isInteger(overallTimeoutMs) || overallTimeoutMs < 100 || overallTimeoutMs > 10 * 60_000
    || !Number.isInteger(maxIdleTimeouts) || maxIdleTimeouts < 1 || maxIdleTimeouts > 600
    || typeof shouldStop !== 'function' || (onMessage !== undefined && typeof onMessage !== 'function')) {
    throw fail('MEDIA_WS_READ_OPTIONS_INVALID');
  }
  const messages = [];
  const deadline = Date.now() + overallTimeoutMs;
  let idleTimeouts = 0;
  for (let i = 0; i < maxMessages; i++) {
    if (shouldStop() || Date.now() >= deadline) break;
    try {
      const value = await connection.nextMessage(Math.max(100, Math.min(timeoutMs, deadline - Date.now())));
      messages.push(value);
      idleTimeouts = 0;
      onMessage?.(value);
    } catch (error) {
      if (error?.code === 'MEDIA_WS_READ_TIMEOUT') {
        idleTimeouts++;
        if (idleTimeouts >= maxIdleTimeouts) break;
        continue;
      }
      if (error?.code === 'MEDIA_WS_CLOSED') break;
      throw error;
    }
  }
  return messages;
}

export function summarizeGrokImagineMessages(messages) {
  if (!Array.isArray(messages)) throw fail('MEDIA_WS_MESSAGE_SUMMARY_INVALID');
  return messages.slice(0, 64).map(value => {
    if (Buffer.isBuffer(value)) return { type: 'binary', bytes: value.length };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { type: 'other' };
    const item = value.item && typeof value.item === 'object' && !Array.isArray(value.item) ? value.item : null;
    const event = value.event && typeof value.event === 'object' && !Array.isArray(value.event) ? value.event : null;
    return {
      type: typeof value.type === 'string' ? value.type : null,
      fieldNames: Object.keys(value).sort().slice(0, 64),
      itemFieldNames: item ? Object.keys(item).sort().slice(0, 64) : [],
      eventType: typeof event?.type === 'string' ? event.type : null,
      eventFieldNames: event ? Object.keys(event).sort().slice(0, 64) : [],
    };
  });
}
