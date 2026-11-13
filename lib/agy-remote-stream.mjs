const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Google RPC streaming JSON has an outer array containing an open response-message array. */
export class AgyArrayFrames {
  #buffer = ''; #opened = 0; #bytes = 0;
  #scan = 0; #depth = 0; #quoted = false; #escape = false;
  constructor(maxBytes = 32 * 1024 * 1024) { this.maxBytes = maxBytes; }
  get pending() { const value = this.#buffer.replace(/^[\s,]+/, ''); return value.length > 0 && value[0] !== ']'; }
  push(text) {
    this.#bytes += Buffer.byteLength(text);
    if (this.#bytes > this.maxBytes) fail('AGY_STREAM_SIZE');
    this.#buffer += text;
    while (this.#opened < 2) {
      this.#buffer = this.#buffer.trimStart();
      if (!this.#buffer) return [];
      if (this.#buffer[0] !== '[') fail('AGY_STREAM_SCHEMA');
      this.#opened++; this.#buffer = this.#buffer.slice(1);
    }
    const frames = [];
    for (;;) {
      if (!this.#scan) this.#buffer = this.#buffer.replace(/^[\s,]+/, '');
      if (!this.#buffer || this.#buffer[0] === ']') break;
      if (this.#buffer[0] !== '[') fail('AGY_STREAM_SCHEMA');
      let end = -1;
      for (let i = this.#scan; i < this.#buffer.length; i++) {
        const c = this.#buffer[i];
        if (this.#quoted) { if (this.#escape) this.#escape = false; else if (c === '\\') this.#escape = true; else if (c === '"') this.#quoted = false; continue; }
        if (c === '"') this.#quoted = true;
        else if (c === '[' || c === '{') this.#depth++;
        else if (c === ']' || c === '}') { if (--this.#depth === 0) { end = i + 1; break; } }
      }
      if (end < 0) { this.#scan = this.#buffer.length; break; }
      let frame; try { frame = JSON.parse(this.#buffer.slice(0, end)); } catch { fail('AGY_STREAM_SCHEMA'); }
      frames.push(frame); this.#buffer = this.#buffer.slice(end); this.#scan = 0;
      this.#depth = 0; this.#quoted = false; this.#escape = false;
    }
    return frames;
  }
}

export function agyConnectEnvelope(value) {
  const data = Buffer.from(JSON.stringify(value)); const frame = Buffer.alloc(5 + data.length);
  frame.writeUInt32BE(data.length, 1); data.copy(frame, 5); return frame;
}

/** A subscription has no initial-snapshot-complete field. Report bounded quiescence honestly. */
export async function readAgySummarySnapshot(response, { maxBytes = 32 * 1024 * 1024, idleMs = 750 } = {}) {
  const reader = response.body?.getReader();
  if (!reader) fail('AGY_STREAM_BODY_REQUIRED');
  const parser = new AgyArrayFrames(maxBytes), decoder = new TextDecoder();
  let buffered = Buffer.alloc(0), batches = 0;
  const updates = Object.create(null), deleted = new Set();
  const finish = ended => ({ updates, deletes: [...deleted], observation: {
    kind: 'quiescent_subscription', complete: false, receivedBatches: batches, quiescenceMs: idleMs, subscriptionEnded: ended,
  } });
  const consume = raw => {
    let data; try { data = JSON.parse(raw); } catch { fail('AGY_STREAM_PAYLOAD_INVALID'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) fail('AGY_STREAM_REMOTE_REJECTED');
    if (data.updates !== undefined && (!data.updates || typeof data.updates !== 'object' || Array.isArray(data.updates))) fail('AGY_STREAM_PAYLOAD_INVALID');
    if (data.deletes !== undefined && (!Array.isArray(data.deletes) || data.deletes.some(x => typeof x !== 'string'))) fail('AGY_STREAM_PAYLOAD_INVALID');
    for (const [id, value] of Object.entries(data.updates ?? {})) { updates[id] = value; deleted.delete(id); }
    for (const id of data.deletes ?? []) { delete updates[id]; deleted.add(id); }
    batches++;
  };
  try {
    for (;;) {
      let timer;
      const next = reader.read();
      const read = batches ? await Promise.race([next, new Promise(resolve => { timer = setTimeout(() => resolve(null), idleMs); })]) : await next;
      clearTimeout(timer);
      if (read === null) {
        if (buffered.length || parser.pending) fail('AGY_STREAM_SNAPSHOT_INCOMPLETE');
        return finish(false);
      }
      const { done, value } = read;
      if (done) { if (batches && !buffered.length && !parser.pending) return finish(true); fail('AGY_STREAM_SNAPSHOT_INCOMPLETE'); }
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        if (!Array.isArray(frame) || typeof frame[0] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame[0])) fail('AGY_STREAM_SCHEMA');
        const bytes = Buffer.from(frame[0], 'base64');
        if (!bytes.length) continue;
        buffered = Buffer.concat([buffered, bytes]);
        if (buffered.length > maxBytes) fail('AGY_STREAM_SIZE');
        if (buffered[0] === 0x7b) { consume(buffered.toString('utf8')); buffered = Buffer.alloc(0); }
        else {
          // Connect envelopes are used when the host returns a framed stream.
          while (buffered.length >= 5) {
            const flag = buffered[0], length = buffered.readUInt32BE(1);
            if (![0, 2].includes(flag) || length > maxBytes) fail('AGY_STREAM_ENCODING');
            if (buffered.length < 5 + length) break;
            const raw = buffered.subarray(5, 5 + length).toString('utf8'); buffered = buffered.subarray(5 + length);
            if (!raw) continue;
            if (flag === 2) {
              let trailer; try { trailer = JSON.parse(raw); } catch { fail('AGY_STREAM_PAYLOAD_INVALID'); }
              if (trailer.error || !batches) fail('AGY_STREAM_REMOTE_REJECTED');
              return finish(true);
            }
            consume(raw);
          }
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
