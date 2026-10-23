import { TextDecoder } from 'node:util';
import { GeminiClientError } from './errors.mjs';

const XSSI = Buffer.from(")]}'", 'utf8');
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (input instanceof Uint8Array) return Buffer.from(input);
  throw new GeminiClientError('BATCH_RESPONSE_INVALID', 'The batch response must be bytes or UTF-8 text.');
}

function decodeUtf8(bytes) {
  try { return utf8.decode(bytes); }
  catch { throw new GeminiClientError('BATCH_RESPONSE_INVALID_UTF8', 'The batch response was not valid UTF-8.'); }
}

function skipLineEndings(buffer, index) {
  let cursor = index;
  while (cursor < buffer.length && (buffer[cursor] === 10 || buffer[cursor] === 13)) cursor += 1;
  return cursor;
}

function stripXssi(buffer) {
  if (buffer.length < XSSI.length || !buffer.subarray(0, XSSI.length).equals(XSSI)) return buffer;
  return buffer.subarray(skipLineEndings(buffer, XSSI.length));
}

function parseDirectJson(buffer) {
  const source = decodeUtf8(buffer).trim();
  if (!source) throw new GeminiClientError('BATCH_RESPONSE_EMPTY', 'The batch response was empty.');
  try { return [JSON.parse(source)]; }
  catch { throw new GeminiClientError('BATCH_RESPONSE_INVALID_JSON', 'The batch response was not valid JSON or length-framed JSON.'); }
}

function parseLengthFrames(buffer) {
  const frames = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    cursor = skipLineEndings(buffer, cursor);
    if (cursor >= buffer.length) break;
    const lineEnd = buffer.indexOf(10, cursor);
    if (lineEnd < 0) throw new GeminiClientError('BATCH_FRAME_LENGTH_MISSING', 'A length-framed response ended before its frame header.');
    let header = buffer.subarray(cursor, lineEnd).toString('ascii');
    if (header.endsWith('\r')) header = header.slice(0, -1);
    if (!/^(0|[1-9][0-9]*)$/.test(header)) {
      throw new GeminiClientError('BATCH_FRAME_LENGTH_INVALID', 'A length-framed response contained a non-decimal frame length.');
    }
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new GeminiClientError('BATCH_FRAME_LENGTH_INVALID', 'A response frame length was outside the supported range.');
    }
    const payloadStart = lineEnd + 1;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buffer.length) throw new GeminiClientError('BATCH_FRAME_TRUNCATED', 'A length-framed response ended before the declared frame length.');
    const payloadText = decodeUtf8(buffer.subarray(payloadStart, payloadEnd));
    try { frames.push(JSON.parse(payloadText)); }
    catch { throw new GeminiClientError('BATCH_FRAME_INVALID_JSON', 'A length-framed response contained invalid JSON.'); }
    cursor = payloadEnd;
    if (cursor < buffer.length && buffer[cursor] === 13) cursor += 1;
    if (cursor < buffer.length && buffer[cursor] === 10) cursor += 1;
    if (cursor < buffer.length && buffer[cursor] !== 10 && buffer[cursor] !== 13
        && !/^[0-9]/.test(String.fromCharCode(buffer[cursor]))) {
      throw new GeminiClientError('BATCH_FRAME_TRAILING_DATA', 'A length-framed response contained unexpected bytes between frames.');
    }
  }
  if (!frames.length) throw new GeminiClientError('BATCH_RESPONSE_EMPTY', 'The length-framed response contained no frames.');
  return frames;
}

function findJsonValueEnd(source, start) {
  const first = source[start];
  if (first === '"') {
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === '\\') { index += 1; continue; }
      if (source[index] === '"') return index + 1;
    }
    throw new GeminiClientError('BATCH_FRAME_TRUNCATED', 'A JSON string frame ended before its closing quote.');
  }
  if (first === '[' || first === '{') {
    const closing = [];
    let inString = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (character === '\\') { index += 1; continue; }
        if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === '[') { closing.push(']'); continue; }
      if (character === '{') { closing.push('}'); continue; }
      if (character === ']' || character === '}') {
        if (closing.pop() !== character) throw new GeminiClientError('BATCH_FRAME_INVALID_JSON', 'A batch response contained mismatched JSON delimiters.');
        if (!closing.length) return index + 1;
      }
    }
    throw new GeminiClientError('BATCH_FRAME_TRUNCATED', 'A JSON batch frame ended before its closing delimiter.');
  }
  let cursor = start;
  while (cursor < source.length && !/[\r\n\t ]/.test(source[cursor])) cursor += 1;
  if (cursor === start) throw new GeminiClientError('BATCH_FRAME_INVALID_JSON', 'A batch frame did not begin with a JSON value.');
  return cursor;
}

function parseLengthFramesUtf16(buffer, { frameLengthOverheadUnits = 0 } = {}) {
  const source = decodeUtf8(buffer);
  const frames = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /[\r\n\t ]/.test(source[cursor])) cursor += 1;
    if (cursor >= source.length) break;
    const lineEnd = source.indexOf('\n', cursor);
    if (lineEnd < 0) throw new GeminiClientError('BATCH_FRAME_LENGTH_MISSING', 'A length-framed response ended before its frame header.');
    let header = source.slice(cursor, lineEnd);
    if (header.endsWith('\r')) header = header.slice(0, -1);
    if (!/^(0|[1-9][0-9]*)$/.test(header)) {
      throw new GeminiClientError('BATCH_FRAME_LENGTH_INVALID', 'A length-framed response contained a non-decimal frame length.');
    }
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new GeminiClientError('BATCH_FRAME_LENGTH_INVALID', 'A response frame length was outside the supported range.');
    }
    const payloadStart = lineEnd + 1;
    let valueStart = payloadStart;
    while (valueStart < source.length && /[\r\n\t ]/.test(source[valueStart])) valueStart += 1;
    const valueEnd = findJsonValueEnd(source, valueStart);
    const consumedUnits = valueEnd - payloadStart;
    if (valueEnd > payloadStart + length || consumedUnits + frameLengthOverheadUnits !== length) {
      throw new GeminiClientError(
        'BATCH_FRAME_LENGTH_MISMATCH',
        'A Gemini batch JSON value did not match its captured UTF-16 length overhead.',
        {
          declaredFrameUnits: length,
          jsonValueUnits: consumedUnits,
          frameLengthOverheadUnits,
        },
      );
    }
    try { frames.push(JSON.parse(source.slice(valueStart, valueEnd))); }
    catch { throw new GeminiClientError('BATCH_FRAME_INVALID_JSON', 'A length-framed response contained invalid JSON.'); }
    cursor = valueEnd;
  }
  if (!frames.length) throw new GeminiClientError('BATCH_RESPONSE_EMPTY', 'The length-framed response contained no frames.');
  return frames;
}

export function parseBatchResponse(input, { maxBytes = MAX_RESPONSE_BYTES, lengthUnit = 'utf16_code_units', frameLengthOverheadUnits = 0 } = {}) {
  const original = toBuffer(input);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || original.length > maxBytes) {
    throw new GeminiClientError('BATCH_RESPONSE_TOO_LARGE', 'The batch response exceeded the configured size limit.');
  }
  if (!['utf16_code_units', 'bytes'].includes(lengthUnit)
      || !Number.isSafeInteger(frameLengthOverheadUnits) || frameLengthOverheadUnits < 0 || frameLengthOverheadUnits > 8
      || (lengthUnit === 'bytes' && frameLengthOverheadUnits !== 0)) {
    throw new GeminiClientError('BATCH_FRAME_LENGTH_UNIT_INVALID', 'The batch framing mode must come from the observed operation contract.');
  }
  const body = stripXssi(original);
  let cursor = 0;
  while (cursor < body.length && [9, 10, 13, 32].includes(body[cursor])) cursor += 1;
  const firstLineEnd = body.indexOf(10, cursor);
  const firstLine = firstLineEnd < 0 ? '' : body.subarray(cursor, firstLineEnd).toString('ascii').replace(/\r$/, '');
  if (/^(0|[1-9][0-9]*)$/.test(firstLine)) {
    const framed = body.subarray(cursor);
    return lengthUnit === 'bytes'
      ? parseLengthFrames(framed)
      : parseLengthFramesUtf16(framed, { frameLengthOverheadUnits });
  }
  return parseDirectJson(body);
}

function decodeRpcData(rawData) {
  if (typeof rawData !== 'string') return rawData;
  try { return JSON.parse(rawData); }
  catch { return rawData; }
}

export function collectRpcResponses(frames) {
  const result = [];
  const pending = [];
  for (let index = frames.length - 1; index >= 0; index -= 1) pending.push(frames[index]);
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      if (current[0] === 'wrb.fr' && typeof current[1] === 'string') {
        result.push(Object.freeze({
          rpcId: current[1],
          rawData: current.length > 2 ? current[2] : null,
          data: decodeRpcData(current.length > 2 ? current[2] : null),
        }));
        continue;
      }
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
    } else if (current && typeof current === 'object') {
      for (const value of Object.values(current)) pending.push(value);
    }
  }
  return result;
}

export function requireRpcResponse(frames, expectedRpcId) {
  if (typeof expectedRpcId !== 'string' || !expectedRpcId) {
    throw new GeminiClientError('RPC_ID_NOT_OBSERVED', 'An expected RPC id must come from an observed operation contract.');
  }
  const matches = collectRpcResponses(frames).filter((entry) => entry.rpcId === expectedRpcId);
  if (matches.length !== 1) {
    throw new GeminiClientError(matches.length ? 'RPC_RESPONSE_AMBIGUOUS' : 'RPC_RESPONSE_MISSING',
      'The response did not contain exactly one result for the observed RPC id.');
  }
  return matches[0];
}

export function collectNullSelectorResponses(frames) {
  const matches = [];
  const pending = [];
  for (let index = frames.length - 1; index >= 0; index -= 1) pending.push(frames[index]);
  let visited = 0;
  while (pending.length) {
    visited += 1;
    if (visited > 200000) throw new GeminiClientError('BATCH_RESPONSE_TOO_COMPLEX', 'The batch response exceeded the nested-value limit.');
    const current = pending.pop();
    if (Array.isArray(current)) {
      if (current[0] === 'wrb.fr' && current[1] === null) {
        if (typeof current[2] !== 'string') throw new GeminiClientError('NULL_SELECTOR_RESPONSE_INVALID', 'A null-selector response did not contain a serialized JSON value.');
        try {
          matches.push(Object.freeze({ selector: null, rawData: current[2], data: JSON.parse(current[2]) }));
        } catch {
          throw new GeminiClientError('NULL_SELECTOR_RESPONSE_INVALID_JSON', 'A null-selector response did not contain valid JSON.');
        }
        continue;
      }
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
    } else if (current && typeof current === 'object') {
      for (const value of Object.values(current)) pending.push(value);
    }
  }
  return matches;
}

function parseStreamGenerateResponseFrames(input, {
  lengthUnit,
  frameLengthOverheadUnits,
} = {}) {
  const frames = parseBatchResponse(input, { lengthUnit, frameLengthOverheadUnits });
  const matches = collectNullSelectorResponses(frames);
  if (!matches.length) {
    throw new GeminiClientError('NULL_SELECTOR_RESPONSE_MISSING',
      'The captured StreamGenerate response did not contain a null-selector result.');
  }
  // StreamGenerate may return several ordered progress frames. Keep them all;
  // text-response.mjs selects and binds the usable main-candidate frame.
  return Object.freeze({ selector: null, responses: Object.freeze(matches) });
}

export function parseCapturedStreamGenerateResponse(input, {
  operation,
  lengthUnit,
  frameLengthOverheadUnits,
} = {}) {
  if (!operation || operation.observation?.requestResponse !== true
      || operation.effect !== 'mutation' || operation.retryPolicy !== 'never'
      || operation.request?.method !== 'POST'
      || operation.request?.path !== '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
      || operation.response?.selector !== 'null') {
    throw new GeminiClientError('TEXT_RESPONSE_CONTRACT_REQUIRED', 'The browser-paired null-selector decoder requires the captured StreamGenerate response contract.');
  }
  return parseStreamGenerateResponseFrames(input, { lengthUnit, frameLengthOverheadUnits });
}

/** Decode the response to a captured request-only StreamGenerate replay without
 * changing the browser-observation state in the contract. */
export function parseRequestOnlyStreamGenerateResponse(input, {
  operation,
  contentType,
  lengthUnit = 'utf16_code_units',
  frameLengthOverheadUnits = 2,
} = {}) {
  if (!operation || operation.observation?.request !== true || operation.observation?.requestResponse !== false
      || operation.effect !== 'mutation' || operation.retryPolicy !== 'never'
      || operation.request?.method !== 'POST'
      || operation.request?.path !== '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
      || operation.response !== undefined || contentType !== 'application/json') {
    throw new GeminiClientError('TEXT_RESPONSE_CONTRACT_REQUIRED', 'Request-only StreamGenerate decoding requires the current captured request and a JSON direct response.');
  }
  return parseStreamGenerateResponseFrames(input, { lengthUnit, frameLengthOverheadUnits });
}
