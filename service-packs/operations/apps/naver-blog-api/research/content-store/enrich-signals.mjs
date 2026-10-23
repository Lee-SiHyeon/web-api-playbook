import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchText, assertStatus } from '../trend-radar/lib/http.mjs';
import { parseNews, hash } from './collect.mjs';
import { candidatesFrom } from '../topic-fit.mjs';

// Search signals (autocomplete keywords) arrive without URLs, so topic-fit can only hold them as
// insufficient_source_context. This step attaches discovery headlines for the keyword. Headlines are
// discovery hints, never verified claims, and an empty feed stays empty.
export const isSearchSignal = candidate => !(candidate.urls || []).length
  && (candidate.sourceKind === 'search_signal' || (candidate.sourceKinds || []).includes('search_signal') || /^autocomplete/.test(candidate.evidenceLevel || ''));

export function newsSearchUrl(query, window) {
  const url = new URL('https://news.google.com/rss/search');
  for (const [key, value] of Object.entries({ q: `${query} when:${window}`, hl: 'ko', gl: 'KR', ceid: 'KR:ko' })) url.searchParams.set(key, value);
  return url;
}

export async function enrichSignals(input, { fetchImpl = globalThis.fetch, now = new Date(), maxQueries = 40, perCandidate = 3, window = '14d' } = {}) {
  if (!Number.isInteger(maxQueries) || maxQueries < 1 || maxQueries > 100 || !Number.isInteger(perCandidate) || perCandidate < 1 || perCandidate > 5) throw new Error('ENRICH_LIMIT');
  if (!/^\d{1,2}d$/.test(window)) throw new Error('ENRICH_WINDOW');
  const checkedAt = now.toISOString();
  const summary = { candidates: 0, requested: 0, enriched: 0, empty: 0, failed: 0, skippedByLimit: 0 };
  const candidates = [];
  for (const candidate of candidatesFrom(input)) {
    summary.candidates++;
    if (!isSearchSignal(candidate)) { candidates.push(candidate); continue; }
    if (summary.requested >= maxQueries) { summary.skippedByLimit++; candidates.push({ ...candidate, enrichment: { status: 'skipped_by_limit', checkedAt } }); continue; }
    summary.requested++;
    const query = candidate.title.slice(0, 100);
    const url = newsSearchUrl(query, window);
    try {
      const result = await fetchText(url, { fetchImpl, attempts: 1, timeoutMs: 12000, headers: { accept: 'application/rss+xml' } });
      assertStatus(result.response);
      if (Buffer.byteLength(result.text) > 2000000) throw new Error('SOURCE_TOO_LARGE');
      const items = parseNews(result.text).slice(0, perCandidate);
      const receipt = { query, sourceUrl: url.href, httpStatus: result.response.status, responseSha256: hash(result.text), observedItems: items.length, checkedAt, browserUsed: false };
      if (!items.length) { summary.empty++; candidates.push({ ...candidate, enrichment: { status: 'empty', ...receipt } }); continue; }
      summary.enriched++;
      const dates = items.map(item => Date.parse(item.publishedAt)).filter(Number.isFinite);
      candidates.push({ ...candidate,
        urls: items.map(item => item.url),
        summary: items.map(item => `${item.title}${item.publisher ? ` (${item.publisher})` : ''}`).join('; ').slice(0, 1500),
        sourceKinds: [...new Set([...(candidate.sourceKinds || []), 'headline_enrichment'])],
        evidenceLevel: 'feed_headline_via_query',
        enrichment: { status: 'enriched', ...receipt, publishers: [...new Set(items.map(item => item.publisher).filter(Boolean))],
          newestHeadlineAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null } });
    } catch (error) {
      summary.failed++;
      candidates.push({ ...candidate, enrichment: { status: 'failed', query, checkedAt, code: error.code || (/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'ENRICH_FAILED') } });
    }
  }
  return { schemaVersion: 1, kind: 'enriched_candidates', checkedAt, inputCheckedAt: input?.checkedAt ?? null, window, summary,
    policy: { headlinesAreNotVerifiedClaims: true, enrichmentIsDiscoveryOnly: true, publicationReady: false }, candidates };
}

export async function main(args) {
  const [inputPath, output] = args;
  if (!inputPath || !output) throw new Error('Use enrich-signals.mjs INPUT_JSON NEW_OUTPUT_JSON');
  const input = JSON.parse(await readFile(path.resolve(inputPath), 'utf8'));
  const target = path.resolve(output);
  try { await lstat(target); throw new Error('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = await enrichSignals(input);
  await writeFile(target, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: target, ...record.summary }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(error => { console.error(/^[A-Z_]+$/.test(error?.message || '') ? error.message : 'ENRICH_FAILED'); process.exitCode = 1; });
