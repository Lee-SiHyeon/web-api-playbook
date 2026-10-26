import { createInterface } from 'node:readline';

const VERSION = '2025-06-18';
const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const codeOf = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'OPERATION_FAILED';
const PARTIAL_OPERATIONS = Object.freeze({
  'kmong-search-collect': { operation: 'search', scopeKey: 'keyword', pageSize: 40 },
  'kmong-reviews-collect': { operation: 'reviews', scopeKey: 'gigId', pageSize: 5 },
});
const MAX_PARTIAL_RESULT_BYTES = 32 * 1024 * 1024;

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeJsonValue(value, stack = new Set(), budget = { nodes: 0 }, depth = 0) {
  if (++budget.nodes > 100_000 || depth > 40) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (!Array.isArray(value) && !plainObject(value) || stack.has(value)) return false;
  stack.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value).filter(key => key !== 'length');
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) valid = false;
    for (let index = 0; valid && index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
          !safeJsonValue(descriptor.value, stack, budget, depth + 1)) valid = false;
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') { valid = false; break; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
          !safeJsonValue(descriptor.value, stack, budget, depth + 1)) { valid = false; break; }
    }
  }
  stack.delete(value);
  return valid;
}

/** Return only the explicit, bounded Kmong read-collection error payload contract. */
export function readOnlyCollectionPartialResult(error) {
  try {
    if (!codeOf(error).startsWith('KMONG_')) return null;
    const partial = error?.partialResult;
    if (!plainObject(partial) || !safeJsonValue(partial)) return null;
    const keys = Reflect.ownKeys(partial);
    if (keys.length !== 3 || !['kind', 'operation', 'data'].every(key => keys.includes(key)) ||
        partial.kind !== 'kmong_read_only_collection') return null;
    const shape = PARTIAL_OPERATIONS[partial.operation];
    const data = partial.data;
    const scopeValue = plainObject(data) ? data.scope?.[shape?.scopeKey] : null;
    if (!shape || !plainObject(data) || data.service !== 'kmong' || data.operation !== shape.operation ||
        !['partial', 'unstable'].includes(data.status) || data.checkpointAuthenticated !== false ||
        typeof data.networkUsed !== 'boolean' || !plainObject(data.scope) || !plainObject(data.state) ||
        data.state.schemaVersion !== 1 || data.state.service !== 'kmong' ||
        data.state.operation !== shape.operation || data.state.complete !== false ||
        typeof data.state.resumeAllowed !== 'boolean' || !plainObject(data.state.scope) ||
        typeof scopeValue !== 'string' || !scopeValue ||
        shape.scopeKey === 'gigId' && !/^[1-9]\d{0,19}$/.test(scopeValue) ||
        data.scope[shape.scopeKey] !== data.state.scope[shape.scopeKey] ||
        data.scope.pageSize !== shape.pageSize || data.state.scope.pageSize !== shape.pageSize ||
        !Array.isArray(data.items) || !Array.isArray(data.pages) || !Array.isArray(data.requests) ||
        !Array.isArray(data.currentRequests) ||
        !Array.isArray(data.state.items) || !Array.isArray(data.state.pages) ||
        !Array.isArray(data.state.requests) || !Array.isArray(data.state.attempts) ||
        !Array.isArray(data.state.issues)) return null;
    const serialized = JSON.stringify(partial);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_PARTIAL_RESULT_BYTES) return null;
    return partial;
  } catch {
    return null;
  }
}

/** MCP stdio subset: initialization, ping, generated tools and cancellable calls. */
export function createOperationMcpHandler(registry) {
  let initialized = false;
  const running = new Map();
  const handle = async function handle(message) {
    const id = message?.id ?? null;
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        Object.hasOwn(message, 'id') && !['number', 'string'].includes(typeof message.id)) return errorResponse(id, -32600, 'Invalid Request');
    const request = Object.hasOwn(message, 'id');
    if (!request) {
      if (message.method === 'notifications/cancelled') running.get(message.params?.requestId)?.abort();
      return undefined;
    }
    if (message.method === 'initialize') {
      if (initialized || typeof message.params?.protocolVersion !== 'string') return errorResponse(id, -32602, 'Invalid initialization');
      initialized = true;
      return { jsonrpc: '2.0', id, result: { protocolVersion: VERSION, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'web-api-playbook', version: '1.0.0' } } };
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (!initialized) return errorResponse(id, -32000, 'Initialize first');
    if (message.method === 'tools/list') {
      if (message.params?.cursor !== undefined) return errorResponse(id, -32602, 'No next page');
      return { jsonrpc: '2.0', id, result: { tools: registry.tools() } };
    }
    if (message.method !== 'tools/call') return errorResponse(id, -32601, 'Method not found');
    const { name, arguments: args = {} } = message.params ?? {};
    if (typeof name !== 'string' || !registry.tools().some(tool => tool.name === name)) return errorResponse(id, -32602, 'Unknown tool');
    if (running.has(id)) return errorResponse(id, -32600, 'Duplicate request ID');
    const controller = new AbortController(); running.set(id, controller);
    try {
      const value = await registry.callTool(name, args, { signal: controller.signal });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } };
    } catch (error) {
      const failure = { ok: false, code: codeOf(error) };
      const partialResult = readOnlyCollectionPartialResult(error);
      if (partialResult) failure.partialResult = partialResult;
      return { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify(failure) }],
        ...(partialResult ? { structuredContent: failure } : {}),
        isError: true,
      } };
    } finally { running.delete(id); }
  };
  handle.close = () => { for (const controller of running.values()) controller.abort(); };
  return handle;
}

export async function serveOperationMcp(registry, { input = process.stdin, output = process.stdout, maxMessageBytes = 1024 * 1024, shutdownGraceMs = 1000 } = {}) {
  const handle = createOperationMcpHandler(registry), pending = new Set();
  const lines = createInterface({ input, crlfDelay: Infinity });
  const send = value => new Promise((resolve, reject) => output.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()));
  let outputFailure;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      if (Buffer.byteLength(line) > maxMessageBytes) throw new Error('message_too_large');
      message = JSON.parse(line);
    } catch { await send(errorResponse(null, -32700, 'Parse error')); continue; }
    const work = handle(message).then(value => value === undefined ? undefined : send(value));
    pending.add(work);
    work.catch(error => { outputFailure = error; }).finally(() => pending.delete(work));
  }
  const shutdownTimer = setTimeout(() => handle.close(), shutdownGraceMs);
  try { await Promise.allSettled(pending); } finally { clearTimeout(shutdownTimer); }
  if (outputFailure) throw outputFailure;
}
