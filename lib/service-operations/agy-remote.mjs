import { ProtectedStore } from '../protected-store.mjs';
import { AGY_STORE, AGY_ORIGIN, AGY_API, AGY_LS } from '../agy-remote.mjs';
import { createAgyRemoteRuntime } from '../agy-remote-runtime.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const str = (required = true, maxLength = 160) => ({ type: 'string', minLength: 1, maxLength, ...(required ? { required: true } : {}) });
const reads = new Set(['GetUserStatus','GetAllCascadeTrajectories','GetCascadeTrajectory',
  'GetCascadeTrajectorySteps','GetCascadeModelConfigData','ListProjects','ReadProjects']);
const inputs = {
  remotes: {}, owner: { remote: str() }, models: { remote: str() }, projects: { remote: str() },
  sessions: { remote: str(), limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    cursor: str(false, 1024), projectId: str(false), query: str(false, 256) },
  conversation: { remote: str(), id: str(true, 36) },
};
const descriptions = {
  remotes: 'List the current account\'s remote instances, retaining offline status.',
  owner: 'Verify the selected online remote reports the bootstrap account email.',
  models: 'Read the selected remote\'s available model identifiers.',
  projects: 'List and read projects on one explicitly selected remote.',
  sessions: 'Read a bounded persisted-summary subscription plus loaded trajectories; no initial-snapshot-complete flag exists.',
  conversation: 'Read a remote-bound conversation with step pagination and without hidden generator internals.',
};

export const definitions = [{
  id: 'agy-remote', aliases: ['antigravity-remote', 'agy-rc'], title: 'Antigravity Remote Control',
  requires: ['owner-bound encrypted session from agy-remote-bootstrap.mjs', 'explicit remote for all device operations'],
  checklistIds: ['agy-remote'], verificationChecks: [{ operation: 'remotes', input: {}, kind: 'live_read' }],
  profile: { schemaVersion: 2, serviceId: 'agy-remote', allowedOrigins: [AGY_ORIGIN],
    operations: Object.fromEntries(Object.keys(inputs).map(name => [name, {
      adapter: `agy-remote.${name}`, semantics: 'read', description: descriptions[name], inputs: { query: inputs[name] },
      evidence: 'lib/agy-remote.mjs; references/agy-remote.md; first-party UI-observed ApiService and LanguageServerService contracts',
    }])) },
  createAdapters(options = {}) {
    const active = new Set(); let closed = false;
    const adapters = Object.fromEntries(Object.keys(inputs).map(name => [`agy-remote.${name}`, async (input, context = {}) => {
      if (closed) fail('AGY_ADAPTER_CLOSED');
      const controller = new AbortController(); active.add(controller);
      let store, state, requests = 0;
      try {
        if (options.credentialProvider) state = await options.credentialProvider('agy-remote');
        else {
          store = new ProtectedStore({ directory: options.storeDirectory, provider: process.platform === 'win32' ? undefined : 'file' });
          const raw = store.read(options.sessionName ?? AGY_STORE); if (!raw) fail('AGY_BOOTSTRAP_REQUIRED'); state = JSON.parse(raw);
        }
        if (!state) fail('AGY_BOOTSTRAP_REQUIRED');
        const fetchImpl = async (rawUrl, init) => {
          const url = new URL(rawUrl);
          if (url.origin !== AGY_ORIGIN || init.method !== 'POST') fail('AGY_COMMON_READ_ONLY');
          const method = url.pathname.slice(AGY_API.length);
          if (!url.pathname.startsWith(AGY_API) || !['ListInstances','ProxyCommand','StreamProxyCommand'].includes(method)) fail('AGY_COMMON_READ_ONLY');
          let body; try { body = JSON.parse(init.body); } catch { fail('AGY_COMMON_READ_ONLY'); }
          if (method !== 'ListInstances') {
            if (!Array.isArray(body) || typeof body[1] !== 'string' || !body[1].startsWith(AGY_LS)) fail('AGY_COMMON_READ_ONLY');
            const rpc = body[1].slice(AGY_LS.length);
            if (method === 'StreamProxyCommand' ? rpc !== 'JetboxSubscribeToSummaries' : !reads.has(rpc)) fail('AGY_COMMON_READ_ONLY');
          }
          requests++;
          const signals = [controller.signal, context.signal, init.signal].filter(Boolean);
          return (options.fetchImpl ?? globalThis.fetch)(rawUrl, { ...init, signal: AbortSignal.any(signals) });
        };
        const q = input.query ?? {};
        // Caller-supplied credential envelopes never gain access to the operator's browser.
        const runtime = createAgyRemoteRuntime({ state, fetchImpl, store, remote: q.remote,
          sessionName: options.sessionName ?? AGY_STORE, allowMaintenance: !!store });
        const data = await runtime.run(async client => {
        let data;
        if (name === 'remotes') data = { remotes: await client.instances() };
        else if (name === 'conversation') data = await client.read(q.remote, q.id);
        else if (name === 'sessions') { const { remote, ...rest } = q; data = await client.sessions(remote, rest); }
        else data = await client[name](q.remote);
        return data;
        });
        return { data, receipt: { serviceId: 'agy-remote', operation: name, networkUsed: requests > 0,
          browserUsed: runtime.maintenance.usedBrowser, businessBrowserUsed: false,
          sessionMaintenance: runtime.maintenance, ownerVerified: name !== 'remotes', requestCount: requests } };
      } catch (error) {
        if (typeof error?.code === 'string' && /^(?:AGY_|SCOPED_SESSION_|PROTECTED_STORE_)[A-Z_]+$/.test(error.code)) throw error;
        fail('AGY_COMMON_READ_FAILED');
      } finally { active.delete(controller); }
    }]));
    return { adapters, close() { closed = true; for (const controller of active) controller.abort(); active.clear(); } };
  },
}];
