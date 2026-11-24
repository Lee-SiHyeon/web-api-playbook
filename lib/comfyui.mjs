// ComfyUI: public Comfy Hub workflow catalogue + workflow graphs (comfy.org), and an owner's local ComfyUI server (loopback only).
// Read-only. The Hub contracts were observed on comfy.org/hub/workflows (2026-11-25): the page loads
// /models/catalogue.json?section=workflows&format=page (items in `models`, cursor in pages.workflows.nextCursor) and each detail page
// links /workflow-graphs/<slug>.json ("Download workflow JSON"). Workflow graphs are untrusted data: they are parsed, never executed.
import { readFile } from 'node:fs/promises';

export const HUB_ORIGIN = 'https://comfy.org';
export const LOCAL_ORIGINS = ['http://127.0.0.1:8188', 'http://127.0.0.1:18188'];
export const HUB_CATEGORIES = ['3d-models-and-textures', 'animate-characters', 'anime-pixel-art-and-comics', 'architecture-and-interiors',
  'controlnet-and-tools', 'edit-images', 'edit-video', 'generate-images', 'generate-video', 'lip-sync-and-avatars', 'music-and-sound',
  'product-fashion-and-ads', 'sprite-sheets-and-game-assets', 'storyboards', 'swap-faces-and-characters', 'upscale-and-restore',
  'vfx-and-motion-transfer', 'voice-and-speech'];
export const HUB_SORTS = ['popular', 'newest', 'name'];
const FRONTEND_ONLY = new Set(['Reroute', 'Note', 'MarkdownNote', 'PrimitiveNode']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,159}$/;
const MAX_BYTES = 12 << 20;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function getJson(url, { fetchImpl, signal, origins, follow = false }) {
  if (!origins.includes(url.origin)) fail('COMFYUI_ORIGIN_NOT_ALLOWED');
  let res;
  try { res = await fetchImpl(url.href, { method: 'GET', redirect: follow ? 'follow' : 'error', signal, headers: { Accept: 'application/json' } }); }
  catch (error) { if (error?.code?.startsWith?.('COMFYUI_')) throw error; fail('COMFYUI_NETWORK_FAILED'); }
  if (follow && res.url && !origins.includes(new URL(res.url).origin)) fail('COMFYUI_ORIGIN_NOT_ALLOWED');   // renamed HF repos redirect within huggingface.co
  if (res.status === 404) fail('COMFYUI_NOT_FOUND');
  if (!res.ok) fail('COMFYUI_HTTP_' + res.status);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) fail('COMFYUI_RESPONSE_TOO_LARGE');
  const text = await res.text();
  if (text.length > MAX_BYTES) fail('COMFYUI_RESPONSE_TOO_LARGE');
  try { return JSON.parse(text); } catch { fail('COMFYUI_RESPONSE_NOT_JSON'); }
}

async function getText(url, { fetchImpl, signal, origins }) {
  if (!origins.includes(url.origin)) fail('COMFYUI_ORIGIN_NOT_ALLOWED');
  let res; try { res = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal, headers: { Accept: 'text/html' } }); } catch { fail('COMFYUI_NETWORK_FAILED'); }
  if (res.status === 404) fail('COMFYUI_NOT_FOUND');
  if (!res.ok) fail('COMFYUI_HTTP_' + res.status);
  const text = await res.text(); if (text.length > MAX_BYTES) fail('COMFYUI_RESPONSE_TOO_LARGE'); return text;
}

/** First workflow file of a community Hub page (Astro props, HTML-escaped). Only same-site /catalog-media/<uuid>/<uuid> paths are accepted. */
export function workflowFileHref(html) {
  const t = html.replaceAll('&quot;', '"'); const i = t.indexOf('"workflowFiles"'); if (i < 0) fail('COMFYUI_WORKFLOW_FILE_MISSING');
  const m = /"href":\[0,"(\/catalog-media\/[0-9a-f-]{36}\/[0-9a-f-]{36})"\]/.exec(t.slice(i, i + 4000));
  if (!m) fail('COMFYUI_WORKFLOW_FILE_MISSING'); return m[1];
}

const pickItem = item => ({
  slug: String(item.slug ?? '').replace(/^workflows\//, ''), name: item.name ?? null, summary: item.summary ?? null,
  author: item.author ?? null, authorUsername: item.authorUsername ?? null, models: item.models ?? [], categories: item.categories ?? [],
  useCases: item.useCases ?? [], modality: item.modality ?? null, type: item.type ?? null, lastModified: item.lastModified ?? null,
  url: item.href ? new URL(item.href, HUB_ORIGIN).href : null,
});

/** Public Comfy Hub reads. No cookies, no account. */
export function createComfyHubClient({ fetchImpl = globalThis.fetch, signal } = {}) {
  const ctx = { fetchImpl, signal, origins: [HUB_ORIGIN] };
  return {
    async list({ q, category, model, sort, cursor, locale = 'en' } = {}) {
      if (category !== undefined && !HUB_CATEGORIES.includes(category)) fail('COMFYUI_CATEGORY_UNKNOWN');
      if (sort !== undefined && !HUB_SORTS.includes(sort)) fail('COMFYUI_SORT_UNKNOWN');
      const url = new URL('/models/catalogue.json', HUB_ORIGIN);
      for (const [k, v] of Object.entries({ section: 'workflows', format: 'page', locale, audience: 'public-root', q, category, model, sort, cursor })) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
      }
      const data = await getJson(url, ctx);
      if (!object(data) || !Array.isArray(data.models) || !object(data.pages?.workflows)) fail('COMFYUI_CATALOGUE_SHAPE_CHANGED');
      const page = data.pages.workflows;
      return { items: data.models.map(pickItem), nextCursor: page.hasNext ? page.nextCursor ?? null : null, hasNext: !!page.hasNext,
        count: page.count ?? data.models.length, query: { q: q ?? null, category: category ?? null, model: model ?? null, sort: sort ?? null } };
    },
    async graph(slug) {
      if (typeof slug !== 'string' || !SLUG.test(slug)) fail('COMFYUI_SLUG_INVALID');
      let graph, source = `/workflow-graphs/${slug}.json`;   // ComfyUI-authored templates
      try { graph = await getJson(new URL(source, HUB_ORIGIN), ctx); }
      catch (error) {
        if (error.code !== 'COMFYUI_NOT_FOUND') throw error;   // community uploads: the detail page lists workflowFiles[].href = /catalog-media/<uid>/<version>
        source = workflowFileHref(await getText(new URL(`/hub/workflows/${slug}/`, HUB_ORIGIN), ctx));
        graph = await getJson(new URL(source, HUB_ORIGIN), ctx);
      }
      if (!object(graph) || !Array.isArray(graph.nodes)) fail('COMFYUI_GRAPH_SHAPE_CHANGED');
      return { graph, source: new URL(source, HUB_ORIGIN).href };
    },
  };
}

export async function loadCoreIndex(file = new URL('../references/comfyui-core-nodes-v0.46.3.json', import.meta.url)) {
  const d = JSON.parse(await readFile(file, 'utf8'));
  return { comfyui: d.comfyui, api: new Set(d.api), local: new Set(d.local), nonCore: new Set(d.nonCore) };
}

/** Classify every node of a UI-format workflow graph (incl. subgraphs) against a core-node index:
 *  local = core node that runs on our GPU, api = core node that calls a paid partner API, custom = needs a third-party node pack,
 *  frontend = UI-only helper. Models come from the nodes' own properties.models (name, url, directory). Nothing is executed. */
export function inspectWorkflow(graph, index) {
  if (!object(graph) || !Array.isArray(graph.nodes)) fail('COMFYUI_GRAPH_INVALID');
  const subgraphs = Array.isArray(graph.definitions?.subgraphs) ? graph.definitions.subgraphs : [];
  const subIds = new Set(subgraphs.map(s => s?.id).filter(Boolean));
  const all = [...graph.nodes, ...subgraphs.flatMap(s => (Array.isArray(s?.nodes) ? s.nodes : []))].filter(object);
  const seen = new Map(); const models = new Map();
  for (const node of all) {
    const type = typeof node.type === 'string' ? node.type : '';
    if (!type || subIds.has(type)) continue;
    const props = object(node.properties) ? node.properties : {};
    const kind = FRONTEND_ONLY.has(type) ? 'frontend' : index.api.has(type) ? 'api' : index.local.has(type) ? 'local' : 'custom';
    const entry = seen.get(type) ?? { type, kind, count: 0, pack: null };
    entry.count++;
    if (kind === 'custom') entry.pack = (props.cnr_id && props.cnr_id !== 'comfy-core' ? props.cnr_id : null) ?? props.aux_id ?? entry.pack ?? null;
    seen.set(type, entry);
    for (const m of Array.isArray(props.models) ? props.models : []) {
      if (object(m) && typeof m.name === 'string' && !models.has(m.name)) models.set(m.name, { name: m.name, directory: m.directory ?? null, url: m.url ?? null });
    }
  }
  const nodes = [...seen.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.type.localeCompare(b.type));
  const by = kind => nodes.filter(n => n.kind === kind);
  const custom = by('custom'); const api = by('api');
  const verdict = custom.length ? 'needs-custom-nodes' : api.length ? 'paid-api-nodes' : 'local-core-only';
  return { verdict, coreIndex: index.comfyui, nodeCount: all.length, counts: { local: by('local').length, api: api.length, custom: custom.length, frontend: by('frontend').length },
    customPacks: [...new Set(custom.map(n => n.pack).filter(Boolean))].sort(), nodes, models: [...models.values()],
    huggingfaceRepos: [...new Set([...models.values()].map(m => /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\//.exec(m.url ?? '')?.[1]).filter(Boolean))].sort() };
}

export const HF_ORIGIN = 'https://huggingface.co';
const NON_COMMERCIAL = /(^|[-_ ])(nc|non-?commercial)([-_ ]|$)|flux-1-dev|flux-dev|flux\.2-dev|cc-by-nc|research/i;
/** Licence of each Hugging Face repo a workflow downloads from (public model API). `commercial: false` when the card names a
 *  non-commercial licence (FLUX dev family, CC-BY-NC, research-only); `null` when the card gives none ("other" needs a human read). */
export async function hfLicenses(repos, { fetchImpl = globalThis.fetch, signal } = {}) {
  const out = [];
  for (const repo of repos.slice(0, 20)) {
    if (!/^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,96}$/.test(repo)) { out.push({ repo, license: null, error: 'COMFYUI_HF_REPO_INVALID' }); continue; }
    try {
      const d = await getJson(new URL(`/api/models/${repo}`, HF_ORIGIN), { fetchImpl, signal, origins: [HF_ORIGIN], follow: true });
      const license = d.cardData?.license ?? null; const name = d.cardData?.license_name ?? null;
      out.push({ repo, license, licenseName: name, gated: d.gated ?? false,
        commercial: NON_COMMERCIAL.test(`${license ?? ''} ${name ?? ''}`) ? false : license === null || license === 'other' ? null : true });
    } catch (error) { out.push({ repo, license: null, error: error.code ?? 'COMFYUI_HF_READ_FAILED' }); }
  }
  return out;
}

/** Owner's own ComfyUI server. Loopback origins only (the server or an ssh -L tunnel to it). */
export function createComfyLocalClient({ base = LOCAL_ORIGINS[0], fetchImpl = globalThis.fetch, signal } = {}) {
  let origin; try { origin = new URL(base).origin; } catch { fail('COMFYUI_LOCAL_BASE_INVALID'); }
  if (!LOCAL_ORIGINS.includes(origin)) fail('COMFYUI_LOCAL_BASE_NOT_LOOPBACK');
  const ctx = { fetchImpl, signal, origins: [origin] };
  return {
    async status() {
      const s = await getJson(new URL('/system_stats', origin), ctx); const q = await getJson(new URL('/queue', origin), ctx);
      return { comfyui: s.system?.comfyui_version ?? null, python: s.system?.python_version?.split(' ')[0] ?? null, pytorch: s.system?.pytorch_version ?? null,
        devices: (s.devices ?? []).map(d => ({ name: d.name, type: d.type, vramTotal: d.vram_total ?? null, vramFree: d.vram_free ?? null })),
        queue: { running: (q.queue_running ?? []).length, pending: (q.queue_pending ?? []).length } };
    },
    async nodes(index) {
      const info = await getJson(new URL('/object_info', origin), ctx);
      if (!object(info)) fail('COMFYUI_OBJECT_INFO_INVALID');
      const names = Object.keys(info); const api = names.filter(n => info[n]?.api_node);
      const known = index ? new Set([...index.local, ...index.api, ...index.nonCore]) : null;
      return { count: names.length, api: api.length, local: names.length - api.length,
        notInCoreIndex: known ? names.filter(n => !known.has(n)).sort() : null, missingFromServer: known ? [...known].filter(n => !info[n]).sort() : null };
    },
  };
}
