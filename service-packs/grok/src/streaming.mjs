import { fail } from './errors.mjs';

const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

function asWebStream(source) {
  if (source && typeof source.getReader === 'function') return source;
  throw fail('STREAM_SOURCE_INVALID');
}

function parseData(data) {
  if (data === '[DONE]') return { done: true, value: null };
  try { return { done: false, value: JSON.parse(data) }; } catch { return { done: false, value: data }; }
}

export async function* parseSseStream(source, {
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  signal,
} = {}) {
  const reader = asWebStream(source).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let totalBytes = 0;
  let dataLines = [];
  let eventType = '';
  let eventId = null;
  let frameBytes = 0;
  let stopped = false;

  const dispatch = () => {
    if (!dataLines.length) {
      eventType = '';
      eventId = null;
      frameBytes = 0;
      return null;
    }
    const data = dataLines.join('\n');
    const parsed = parseData(data);
    const frame = parsed.done ? null : { event: eventType || 'message', id: eventId, data: parsed.value };
    dataLines = [];
    eventType = '';
    frameBytes = 0;
    eventId = null;
    if (parsed.done) stopped = true;
    return frame;
  };

  try {
    while (!stopped) {
      if (signal?.aborted) throw fail('STREAM_ABORTED');
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxTotalBytes) throw fail('STREAM_TOO_LARGE');
      text += decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = text.indexOf('\n');
        if (newline < 0) break;
        let line = text.slice(0, newline);
        text = text.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        frameBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (frameBytes > maxFrameBytes) throw fail('STREAM_FRAME_TOO_LARGE');
        if (line === '') {
          const frame = dispatch();
          if (frame) yield frame;
          if (stopped) break;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let fieldValue = colon < 0 ? '' : line.slice(colon + 1);
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
        if (field === 'data') dataLines.push(fieldValue);
        else if (field === 'event') eventType = fieldValue;
        else if (field === 'id' && !fieldValue.includes('\0')) eventId = fieldValue;
      }
      if (Buffer.byteLength(text, 'utf8') > maxFrameBytes) throw fail('STREAM_FRAME_TOO_LARGE');
    }
    if (!stopped) {
      text += decoder.decode();
      if (text.length) {
        const line = text.endsWith('\r') ? text.slice(0, -1) : text;
        if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) throw fail('STREAM_FRAME_TOO_LARGE');
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      const frame = dispatch();
      if (frame) yield frame;
    }
  } finally {
    if (!stopped) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* parseNdjsonStream(source, {
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxLineBytes = DEFAULT_MAX_FRAME_BYTES,
  signal,
} = {}) {
  const reader = asWebStream(source).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let totalBytes = 0;
  let lineNumber = 0;
  let stopped = false;
  const parseLine = line => {
    lineNumber++;
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized.trim()) return undefined;
    if (Buffer.byteLength(normalized, 'utf8') > maxLineBytes) throw fail('STREAM_LINE_TOO_LARGE');
    try { return JSON.parse(normalized); } catch { throw fail('STREAM_JSON_INVALID', { line: lineNumber }); }
  };

  try {
    while (!stopped) {
      if (signal?.aborted) throw fail('STREAM_ABORTED');
      const { value, done } = await reader.read();
      if (done) { stopped = true; break; }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxTotalBytes) throw fail('STREAM_TOO_LARGE');
      text += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, newline);
        text = text.slice(newline + 1);
        const valueParsed = parseLine(line);
        if (valueParsed !== undefined) yield valueParsed;
      }
      if (Buffer.byteLength(text, 'utf8') > maxLineBytes) throw fail('STREAM_LINE_TOO_LARGE');
    }
    text += decoder.decode();
    const last = parseLine(text);
    if (last !== undefined) yield last;
  } finally {
    if (!stopped) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function collectStream(source, mode, options) {
  const values = [];
  const parser = mode === 'sse' ? parseSseStream : mode === 'ndjson' ? parseNdjsonStream : null;
  if (!parser) throw fail('STREAM_MODE_UNSUPPORTED');
  for await (const value of parser(source, options)) values.push(value);
  return values;
}
