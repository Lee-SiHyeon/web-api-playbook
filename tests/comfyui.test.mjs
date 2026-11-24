import test from 'node:test';
import assert from 'node:assert/strict';
import { createComfyHubClient, createComfyLocalClient, inspectWorkflow, loadCoreIndex, hfLicenses, workflowFileHref } from '../lib/comfyui.mjs';
import { createServiceRegistry } from '../lib/service-operations/index.mjs';

// Synthetic fixtures shaped like the observed comfy.org responses (2026-11-25); no third-party content is stored.
const page = (slugs, next) => ({ models: slugs.map((s, i) => ({ slug: `workflows/${s}`, name: s, href: `/hub/workflows/${s}/`, author: i ? 'someone' : 'ComfyUI',
  models: ['Z-Image'], categories: ['generate-images'], type: 'CLOUD', lastModified: '2026-11-20T00:00:00Z', summary: 'synthetic' })),
  pages: { workflows: { mode: 'cursor', page: 1, pageSize: 24, count: slugs.length, hasNext: !!next, nextCursor: next } }, facets: {} });
const json = (body, status = 200, extra = {}) => ({ ok: status < 400, status, url: extra.url ?? '', headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
const fakeFetch = routes => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); for (const [re, res] of routes) if (re.test(url)) return typeof res === 'function' ? res(url) : res; return json({}, 404); }; f.calls = calls; return f; };
const graph = (types, extra = {}) => ({ nodes: types.map((t, i) => ({ id: i + 1, type: t.type ?? t, properties: t.properties ?? { cnr_id: 'comfy-core' } })), links: [], ...extra });

test('hub list sends the observed catalogue contract and maps items + cursor', async () => {
  const f = fakeFetch([[/catalogue\.json/, json(page(['icon-set', 'turnaround'], 'c2'))]]);
  const r = await createComfyHubClient({ fetchImpl: f }).list({ q: 'icon', category: 'sprite-sheets-and-game-assets', sort: 'newest' });
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://comfy.org/models/catalogue.json');
  assert.deepEqual(Object.fromEntries(u.searchParams), { section: 'workflows', format: 'page', locale: 'en', audience: 'public-root', q: 'icon', category: 'sprite-sheets-and-game-assets', sort: 'newest' });
  assert.equal(f.calls[0].init.redirect, 'error'); assert.equal(f.calls[0].init.headers.Cookie, undefined);
  assert.deepEqual(r.items.map(i => i.slug), ['icon-set', 'turnaround']); assert.equal(r.nextCursor, 'c2'); assert.equal(r.items[0].url, 'https://comfy.org/hub/workflows/icon-set/');
  await assert.rejects(createComfyHubClient({ fetchImpl: f }).list({ category: 'not-a-category' }), { code: 'COMFYUI_CATEGORY_UNKNOWN' });
  const changed = fakeFetch([[/catalogue/, json([{ slug: 'x' }])]]);
  await assert.rejects(createComfyHubClient({ fetchImpl: changed }).list({}), { code: 'COMFYUI_CATALOGUE_SHAPE_CHANGED' });
});

test('hub graph: template path first, community uploads via the page workflowFiles href, slugs validated', async () => {
  const g = graph(['LoadImage', 'SaveImage']);
  const tpl = fakeFetch([[/workflow-graphs\/tpl\.json$/, json(g)]]);
  assert.equal((await createComfyHubClient({ fetchImpl: tpl }).graph('tpl')).source, 'https://comfy.org/workflow-graphs/tpl.json');
  const uid = '22a3c198-3d3f-4a29-95a6-46b34b5d2796', ver = '53f12c68-d8ad-4d25-b195-a8c7a9724ab0';
  const html = `<x data="{&quot;workflowFiles&quot;:[1,[[0,{&quot;name&quot;:[0,&quot;V1&quot;],&quot;href&quot;:[0,&quot;/catalog-media/${uid}/${ver}&quot;]}]]]}">`;
  const community = fakeFetch([[/workflow-graphs/, json({}, 404)], [/\/hub\/workflows\/comm-1\/$/, { ...json(html), headers: new Headers() }], [/catalog-media/, json(g)]]);
  const r = await createComfyHubClient({ fetchImpl: community }).graph('comm-1');
  assert.equal(r.source, `https://comfy.org/catalog-media/${uid}/${ver}`); assert.equal(r.graph.nodes.length, 2);
  assert.throws(() => workflowFileHref('<a href="https://evil.example/x.json">'), { code: 'COMFYUI_WORKFLOW_FILE_MISSING' });
  for (const bad of ['../etc', 'A', 'x/y', '']) await assert.rejects(createComfyHubClient({ fetchImpl: tpl }).graph(bad), { code: 'COMFYUI_SLUG_INVALID' });
});

test('inspect classifies local core, paid API, custom packs and UI-only nodes, including subgraphs', async () => {
  const index = await loadCoreIndex();
  assert.equal(index.comfyui, '0.46.3'); assert.ok(index.api.has('GeminiImage2Node')); assert.ok(index.local.has('KSampler'));
  const local = inspectWorkflow(graph(['LoadImage', 'MarkdownNote', 'sg-1'], { definitions: { subgraphs: [{ id: 'sg-1', nodes: [
    { type: 'UNETLoader', properties: { models: [{ name: 'z_image_turbo_bf16.safetensors', directory: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors' }] } },
    { type: 'KSampler' }, { type: 'SaveImage' }] }] } }), index);
  assert.equal(local.verdict, 'local-core-only'); assert.equal(local.counts.frontend, 1); assert.deepEqual(local.huggingfaceRepos, ['Comfy-Org/z_image_turbo']);
  assert.equal(local.nodes.some(n => n.type === 'sg-1'), false);
  assert.equal(inspectWorkflow(graph(['LoadImage', 'GeminiImage2Node', 'SaveImage']), index).verdict, 'paid-api-nodes');
  const custom = inspectWorkflow(graph([{ type: 'RMBG', properties: { cnr_id: 'comfyui-rmbg', ver: '2.9.0' } }, 'SaveImage']), index);
  assert.equal(custom.verdict, 'needs-custom-nodes'); assert.deepEqual(custom.customPacks, ['comfyui-rmbg']);
  assert.throws(() => inspectWorkflow({ nodes: 'x' }, index), { code: 'COMFYUI_GRAPH_INVALID' });
});

test('licences: non-commercial names win over "other", renamed repos may redirect only inside huggingface.co', async () => {
  const f = fakeFetch([
    [/FLUX\.1-dev$/, json({ cardData: { license: 'other', license_name: 'flux-1-dev-non-commercial-license' }, gated: 'auto' })],
    [/Qwen-Image$/, json({ cardData: { license: 'apache-2.0' } }, 200, { url: 'https://huggingface.co/api/models/Qwen/Qwen-Image' })],
    [/custom$/, json({ cardData: { license: 'other' } })],
    [/moved$/, json({ cardData: { license: 'mit' } }, 200, { url: 'https://evil.example/api/models/a/b' })]]);
  const r = await hfLicenses(['black-forest-labs/FLUX.1-dev', 'Qwen/Qwen-Image', 'a/custom', 'a/moved', 'bad repo'], { fetchImpl: f });
  assert.deepEqual(r.map(x => x.error ?? x.commercial), [false, true, null, 'COMFYUI_ORIGIN_NOT_ALLOWED', 'COMFYUI_HF_REPO_INVALID']);
});

test('local server: loopback bases only; status and node diff', async () => {
  assert.throws(() => createComfyLocalClient({ base: 'http://10.0.0.5:8188' }), { code: 'COMFYUI_LOCAL_BASE_NOT_LOOPBACK' });
  assert.throws(() => createComfyLocalClient({ base: 'https://127.0.0.1:8188' }), { code: 'COMFYUI_LOCAL_BASE_NOT_LOOPBACK' });
  const f = fakeFetch([
    [/system_stats/, json({ system: { comfyui_version: '0.46.3', python_version: '3.12.9 (x)', pytorch_version: '2.8.0+cu128' }, devices: [{ name: 'cuda:0 RTX 5080', type: 'cuda', vram_total: 17, vram_free: 9 }] })],
    [/queue/, json({ queue_running: [[1]], queue_pending: [] })],
    [/object_info/, json({ KSampler: {}, GeminiImage2Node: { api_node: true }, RMBG: {} })]]);
  const c = createComfyLocalClient({ base: 'http://127.0.0.1:18188', fetchImpl: f });
  const s = await c.status(); assert.equal(s.comfyui, '0.46.3'); assert.equal(s.python, '3.12.9'); assert.deepEqual(s.queue, { running: 1, pending: 0 });
  const n = await c.nodes(await loadCoreIndex()); assert.equal(n.api, 1); assert.deepEqual(n.notInCoreIndex, ['RMBG']); assert.ok(n.missingFromServer.length > 1000);
});

test('service registry: comfyui is read-only and returns a receipt without cookies', async () => {
  const f = fakeFetch([[/catalogue\.json/, json(page(['a'], null))]]);
  const reg = await createServiceRegistry('comfyui', { fetchImpl: f });
  try {
    const r = await reg.execute('hub-workflows', { query: { q: 'a' } });
    assert.equal(r.data.items[0].slug, 'a'); assert.equal(r.receipt.cookiesSent, false); assert.equal(r.receipt.untrustedContent, true);
    await assert.rejects(reg.execute('local-status', { query: { base: 'http://10.0.0.5:8188' } }));
  } finally { await reg.close(); }
});
