// Coupang Partners dynamic banner (carousel widget) — owner 2026-10-08: "다이나믹 배너좀 … 파트너스 안붙는 ai글같은 곳에도".
// Contract read from the portal's widget page (https://partners.coupang.com/static/js/main.aefc650b.js, class ns + page jl):
//   GET  /api/v1/widgets                         → {datasetTypes, datasets, widgetInstance}
//   GET  /api/v1/widgets/datasets?dataType=T     → datasets of that type (RECOMMENDATION_PRODUCTION = 고객 관심 기반 추천)
//   POST /api/v1/widgets/instances/search {page} → {content, total}
//   POST /api/v1/widgets/instances {width, height, widgetName:'carousel', widgetInstanceName, datatype, datasetId, bordered}
//        → the saved instance with its iframe / js / widgetHTML codes
// Saving creates an instance (a write), so it is done once per name: a journal entry is written before the call and an
// unsettled entry is reconciled against the instance list by name before any new attempt.
import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createCoupangBanner } from './coupang-banner.mjs';
import { WebAuthError } from './myrealtrip.mjs';

const fail = (code, extra = {}) => { throw Object.assign(new WebAuthError(code), extra); };
export const WIDGET_CACHE = path.join(process.env.LOCALAPPDATA ?? '.', 'affiliate-content-operations', 'coupang-partners', 'widgets.json');
const SIZE = /^\d{2,4}(%|px)?$/;

// The iframe code the portal hands out for an instance; only Coupang-hosted srcs are accepted.
export function parseWidgetInstance(inst) {
  if (!inst || inst.widgetInstanceId == null) fail('WIDGET_RESPONSE_INVALID');
  const iframe = typeof inst.iframe === 'string' && inst.iframe.length <= 5000 ? inst.iframe : null;
  const src = iframe ? /<iframe[^>]+src="([^"]+)"/i.exec(iframe)?.[1] ?? null : null;
  let host = null; try { host = new URL(src).hostname; } catch {}
  if (!iframe || !host || !/(^|\.)coupang\.com$|(^|\.)coupa\.ng$/.test(host)) fail('WIDGET_IFRAME_INVALID', { host });
  return { widgetInstanceId: inst.widgetInstanceId, name: inst.widgetInstanceName ?? null, datasetId: inst.datasetId ?? null,
    width: inst.width ?? null, height: inst.height ?? null, iframe, src,
    js: typeof inst.js === 'string' && inst.js.length <= 5000 ? inst.js : null };
}

const readCache = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { schemaVersion: 1, widgets: {} }; } };
const writeCache = (file, cache) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(cache, null, 2)); renameSync(file + '.tmp', file); };

export function createCoupangWidget({ banner = createCoupangBanner(), cacheFile = WIDGET_CACHE } = {}) {
  const list = call => call('/api/v1/widgets/instances/search', { page: { pageNumber: 0, size: 50 } }).then(d => d?.content ?? []);

  // One carousel per name; the default is the per-visitor recommendation feed, full width.
  async function ensure({ name, datatype = 'RECOMMENDATION_PRODUCTION', datasetId = 39, width = '100%', height = '140', bordered = 'false' }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 50) fail('WIDGET_NAME_INVALID');
    if (!SIZE.test(String(width)) || !SIZE.test(String(height))) fail('WIDGET_SIZE_INVALID');
    const cache = readCache(cacheFile);
    if (cache.widgets[name]?.status === 'created') return { ...cache.widgets[name].widget, cached: true };
    return banner.portal(async ({ call }) => {
      const prior = readCache(cacheFile).widgets[name];
      const existing = (await list(call)).find(w => w.widgetInstanceName === name);
      if (existing) {
        // Created earlier (or by an unsettled attempt): read its codes instead of saving again.
        const widget = { ...parseWidgetInstance(await call(`/api/v1/widgets/instances/${existing.widgetInstanceId}`)), createdAt: prior?.at ?? null, reconciled: true };
        writeCache(cacheFile, { ...readCache(cacheFile), widgets: { ...readCache(cacheFile).widgets, [name]: { status: 'created', widget } } });
        return { ...widget, cached: false };
      }
      if (prior?.status === 'started' && Date.now() - Date.parse(prior.at) < 10 * 60e3) fail('WIDGET_OUTCOME_UNCERTAIN_RECONCILE_LATER');
      const datasets = await call(`/api/v1/widgets/datasets?dataType=${encodeURIComponent(datatype)}`);
      if (!(datasets ?? []).some(d => d.datasetId === datasetId && d.active)) fail('WIDGET_DATASET_UNAVAILABLE');
      const c = readCache(cacheFile); c.widgets[name] = { status: 'started', at: new Date().toISOString() }; writeCache(cacheFile, c);
      let saved;
      try { saved = await call('/api/v1/widgets/instances', { width, height, widgetName: 'carousel', widgetInstanceName: name, datatype, datasetId, bordered }); }
      catch (e) { e.widgetOutcome = 'uncertain'; throw e; }
      const widget = { ...parseWidgetInstance(saved), createdAt: new Date().toISOString() };
      const d = readCache(cacheFile); d.widgets[name] = { status: 'created', widget }; writeCache(cacheFile, d);
      return { ...widget, cached: false };
    });
  }
  return { ensure, cacheFile, cached: name => readCache(cacheFile).widgets[name] ?? null, list: () => banner.portal(({ call }) => list(call)) };
}
