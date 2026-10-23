import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const EXTENSION_ID = 'lijandfhbjhbafhgbkeigepfcclohgjg';
const DEFAULT_PORT = 9417;
const MAX_WS_BYTES = 8 * 1024 * 1024;

export class FlowBridgeServer {
  constructor({ port = DEFAULT_PORT } = {}) {
    this.port = port;
    this.client = null;
    this.pending = new Map();
    this.readyWaiters = new Set();
  }

  async start() {
    this.server = new WebSocketServer({
      host: '127.0.0.1',
      port: this.port,
      maxPayload: MAX_WS_BYTES,
      verifyClient: ({ origin }, done) => done(origin === 'chrome-extension://' + EXTENSION_ID),
    });
    this.server.on('connection', (socket) => {
      if (this.client && this.client.readyState === 1) {
        socket.close(1008, 'Only one Flow bridge client is allowed.');
        return;
      }
      this.client = socket;
      socket.on('message', (bytes) => this.#onMessage(bytes.toString()));
      socket.on('close', () => {
        if (this.client === socket) this.client = null;
        this.#failPending('Flow extension disconnected.');
      });
      socket.on('error', () => {});
      for (const resolve of this.readyWaiters) resolve();
      this.readyWaiters.clear();
    });
    this.server.on('error', (error) => this.#failPending(error?.code === 'EADDRINUSE'
      ? new Error('Flow bridge port 9417 is already in use.')
      : new Error('Flow local bridge failed.')));
    return new Promise((resolve, reject) => {
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });
  }

  #onMessage(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message?.type === 'hello') {
      this.version = message.protocol;
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(String(message.error).slice(0, 160)));
    else pending.resolve(message.result);
  }

  #failPending(reason) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async waitForClient(timeoutMs = 30_000) {
    if (this.client?.readyState === 1) return;
    await new Promise((resolve, reject) => {
      const onReady = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.readyWaiters.delete(onReady);
        reject(new Error('Flow bridge extension is not connected. Install/enable it and open Flow in Chrome.'));
      }, timeoutMs);
      this.readyWaiters.add(onReady);
    });
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    await this.waitForClient(timeoutMs);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Flow bridge timed out during ' + method + '.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.client.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Flow bridge request could not be sent.'));
      });
    });
  }

  close() {
    this.#failPending('Flow bridge closed.');
    this.server?.close();
  }
}
