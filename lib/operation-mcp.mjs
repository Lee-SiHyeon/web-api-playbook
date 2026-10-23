import { createInterface } from 'node:readline';

const VERSION = '2025-06-18';
const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const codeOf = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'OPERATION_FAILED';

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
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: codeOf(error) }) }], isError: true } };
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
