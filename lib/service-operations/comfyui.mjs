import { HUB_ORIGIN, HF_ORIGIN, LOCAL_ORIGINS, HUB_CATEGORIES, HUB_SORTS, createComfyHubClient, createComfyLocalClient,
  inspectWorkflow, loadCoreIndex, hfLicenses } from '../comfyui.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = (maxLength = 160) => ({ type: 'string', minLength: 1, maxLength });
const base = { type: 'string', enum: LOCAL_ORIGINS, default: LOCAL_ORIGINS[0] };
const evidence = 'lib/comfyui.mjs; references/comfyui.md; comfy.org/hub/workflows page requests observed 2026-11-25; ComfyUI v0.46.3 server routes';

const operations = {
  'hub-workflows': {
    description: 'Search or page the public Comfy Hub workflow catalogue (q, category, model, sort, cursor). No account.',
    inputs: { query: { q: text(120), category: { type: 'string', enum: HUB_CATEGORIES }, model: text(80), sort: { type: 'string', enum: HUB_SORTS },
      cursor: text(2048) } },
    run: async (q, deps) => createComfyHubClient(deps).list(q),
  },
  'hub-workflow': {
    description: 'Download one Hub workflow graph as data and classify every node: local core, paid API node, custom node pack, UI-only; list its models and their Hugging Face licences.',
    inputs: { query: { slug: { ...text(160), required: true }, licenses: { type: 'boolean', default: true } } },
    run: async (q, deps) => {
      const { graph, source } = await createComfyHubClient(deps).graph(q.slug);
      const report = inspectWorkflow(graph, await loadCoreIndex());
      return { slug: q.slug, url: `${HUB_ORIGIN}/hub/workflows/${q.slug}/`, download: source, ...report,
        licenses: q.licenses === false ? null : await hfLicenses(report.huggingfaceRepos, deps) };
    },
  },
  'local-status': {
    description: 'Read the owner ComfyUI server version, devices with free VRAM, and queue length (loopback or ssh -L tunnel only).',
    inputs: { query: { base } },
    run: async (q, deps) => createComfyLocalClient({ ...deps, base: q.base }).status(),
  },
  'local-nodes': {
    description: 'Count the owner server nodes (local vs paid API) and diff them against the bundled stock v0.46.3 core-node index (custom packs show up as notInCoreIndex).',
    inputs: { query: { base } },
    run: async (q, deps) => createComfyLocalClient({ ...deps, base: q.base }).nodes(await loadCoreIndex()),
  },
};

export const definitions = [{
  id: 'comfyui', aliases: ['comfy-hub'], title: 'ComfyUI (Comfy Hub workflows + own local server)',
  requires: ['nothing for hub-*', 'a running ComfyUI on 127.0.0.1:8188, or an ssh -L 18188 tunnel to one, for local-*'],
  checklistIds: ['comfyui'], verificationChecks: [{ operation: 'hub-workflows', input: { query: { q: 'icon' } }, kind: 'live_read' }],
  profile: { schemaVersion: 2, serviceId: 'comfyui', allowedOrigins: [HUB_ORIGIN, HF_ORIGIN, ...LOCAL_ORIGINS], allowLoopbackHttp: true,
    operations: Object.fromEntries(Object.entries(operations).map(([name, op]) => [name, {
      adapter: `comfyui.${name}`, semantics: 'read', description: op.description, inputs: op.inputs, evidence }])) },
  createAdapters(options = {}) {
    const active = new Set(); let closed = false;
    const adapters = Object.fromEntries(Object.entries(operations).map(([name, op]) => [`comfyui.${name}`, async (input, context = {}) => {
      if (closed) fail('COMFYUI_ADAPTER_CLOSED');
      const controller = new AbortController(); active.add(controller); let requests = 0;
      const fetchImpl = (url, init) => { requests++; return (options.fetchImpl ?? globalThis.fetch)(url, { ...init,
        signal: AbortSignal.any([controller.signal, context.signal, init?.signal].filter(Boolean)) }); };
      try {
        const data = await op.run(input.query ?? {}, { fetchImpl });
        return { data, receipt: { serviceId: 'comfyui', operation: name, networkUsed: requests > 0, browserUsed: false, cookiesSent: false,
          requestCount: requests, untrustedContent: name === 'hub-workflow' || name === 'hub-workflows' } };
      } catch (error) {
        if (typeof error?.code === 'string' && /^COMFYUI_[A-Z0-9_]+$/.test(error.code)) throw error;
        fail('COMFYUI_READ_FAILED');
      } finally { active.delete(controller); }
    }]));
    return { adapters, close() { closed = true; for (const c of active) c.abort(); active.clear(); } };
  },
}];
