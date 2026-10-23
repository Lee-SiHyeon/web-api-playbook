import { ChatGPTWebError } from './errors.mjs';

function createEvent(state) {
  if (!state.data.length && state.event === undefined && state.id === undefined && state.retry === undefined) return null;
  return {
    ...(state.event !== undefined ? { event: state.event } : {}),
    ...(state.id !== undefined ? { id: state.id } : {}),
    ...(state.retry !== undefined ? { retry: state.retry } : {}),
    data: state.data.join('\n'),
  };
}

function processLine(line, state, limits) {
  const size = Buffer.byteLength(line, 'utf8');
  state.eventBytes += size + 1;
  if (size > limits.maxLineBytes || state.eventBytes > limits.maxEventBytes) throw new ChatGPTWebError('SSE_EVENT_TOO_LARGE');
  if (line === '') {
    const event = createEvent(state);
    state.event = undefined;
    state.id = undefined;
    state.retry = undefined;
    state.data = [];
    state.eventBytes = 0;
    return event;
  }
  if (line.startsWith(':')) return null;
  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? '' : line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  if (field === 'data') state.data.push(value);
  else if (field === 'event') state.event = value;
  else if (field === 'id' && !value.includes('\0')) state.id = value;
  else if (field === 'retry' && /^\d+$/.test(value)) state.retry = Number(value);
  return null;
}

export async function* parseSse(stream, { maxEventBytes = 1_048_576, maxLineBytes = 65_536, signal } = {}) {
  if (!stream || typeof stream.getReader !== 'function') throw new ChatGPTWebError('SSE_STREAM_REQUIRED');
  if (!Number.isInteger(maxEventBytes) || maxEventBytes < 1 || maxEventBytes > 10_000_000
    || !Number.isInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > maxEventBytes) {
    throw new ChatGPTWebError('SSE_LIMIT_INVALID');
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const state = { event: undefined, id: undefined, retry: undefined, data: [], eventBytes: 0 };
  const limits = { maxEventBytes, maxLineBytes };
  let pending = '';
  try {
    while (true) {
      if (signal?.aborted) throw new ChatGPTWebError('SSE_STREAM_ABORTED');
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (pending.length > maxEventBytes * 2) throw new ChatGPTWebError('SSE_EVENT_TOO_LARGE');
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        let line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const event = processLine(line, state, limits);
        if (event) yield event;
      }
      if (done) break;
    }
    if (pending) {
      if (pending.endsWith('\r')) pending = pending.slice(0, -1);
      const event = processLine(pending, state, limits);
      if (event) yield event;
    }
    const finalEvent = createEvent(state);
    if (finalEvent) yield finalEvent;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ChatGPTWebError) throw error;
    throw new ChatGPTWebError('SSE_STREAM_FAILED');
  } finally {
    reader.releaseLock();
  }
}
