import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { flightText, parseCategoryCafes, parseCafePosts, parsePost } from './daangn-reference-scout.mjs';

const MANIFEST = new URL('./daangn-side-hustle-sources.json', import.meta.url);
const MAX_BYTES = 1_000_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

export function validateDaangnSources(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.sources) || manifest.sources.length < 1
    || new Set(manifest.sources.map(row => row.url)).size !== manifest.sources.length) throw fail('DAANGN_SOURCE_MANIFEST');
  for (const row of manifest.sources) {
    let url;
    try { url = new URL(row.url); } catch { throw fail('DAANGN_SOURCE_MANIFEST'); }
    const kind = url.pathname.startsWith('/categories/') ? 'category' : url.pathname.includes('/posts/') ? 'post' : 'cafe';
    if (url.origin !== 'https://cafe.daangn.com' || url.search || url.hash || url.username || url.password
      || kind !== row.kind || !/^[a-z0-9-]+$/.test(row.sourceRecordId || '')) throw fail('DAANGN_SOURCE_MANIFEST');
  }
  return manifest.sources;
}

export async function fetchDaangnSideHustle(_limit = 1, { fetchImpl = globalThis.fetch, manifest = null } = {}) {
  const sourceList = validateDaangnSources(manifest ?? JSON.parse(await readFile(MANIFEST, 'utf8')));
  const rows = [];
  for (const source of sourceList) {
    const response = await fetchImpl(source.url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12_000),
      headers: { accept: 'text/html' },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw fail(`DAANGN_SOURCE_HTTP_${response.status}`);
    }
    const mime = response.headers.get('content-type')?.toLowerCase() || '';
    if (!mime.startsWith('text/html')) {
      await response.body?.cancel();
      throw fail('DAANGN_SOURCE_MIME');
    }
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BYTES) {
      await response.body?.cancel();
      throw fail('DAANGN_SOURCE_TOO_LARGE');
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BYTES) throw fail('DAANGN_SOURCE_TOO_LARGE');
    const html = body.toString('utf8');
    let parsed;
    try {
      if (!flightText(html)) throw fail('DAANGN_SOURCE_SCHEMA');
      if (source.kind === 'category') parsed = { cafes: parseCategoryCafes(html).length };
      else if (source.kind === 'cafe') parsed = { posts: parseCafePosts(html, new URL(source.url).pathname.slice(1)).length };
      else {
        const post = parsePost(html);
        parsed = { title: String(post.title || '').slice(0, 300), blocks: post.blocks.length,
          paragraphs: post.blocks.filter(block => block.type === 'paragraph').length };
      }
      if (!(parsed.cafes > 0 || parsed.posts > 0 || parsed.blocks > 0)) throw fail('DAANGN_SOURCE_SCHEMA');
    } catch { throw fail('DAANGN_SOURCE_SCHEMA'); }
    rows.push({ sourceRecordId: source.sourceRecordId, url: source.url, kind: source.kind,
      httpStatus: response.status, contentType: mime, responseBytes: body.length,
      responseSha256: hash(body), parsed });
  }
  const groupedHash = hash(rows.map(row => `${row.url}\n${row.responseSha256}`).join('\n'));
  return {
    items: [{
      title: '당근 카페 재택 부업 자료: 주제·활동·지급 주장 구분',
      summary: `공개 카테고리 ${rows.filter(row => row.kind === 'category').length}건, 카페 ${rows.filter(row => row.kind === 'cafe').length}곳, 게시글 ${rows.filter(row => row.kind === 'post').length}건의 원문 구조를 읽었다. 게시글의 수익·채용·순위 주장은 독립 검증되지 않았다.`,
      url: sourceList[0].url, urls: sourceList.map(row => row.url),
      sourceRecordIds: sourceList.map(row => row.sourceRecordId), ontologyRefs: ['acada:side-hustle'],
      publisher: 'Daangn Cafe', contentCoverage: 'multi_source_public_pages',
    }],
    receipt: { sourceUrl: sourceList[0].url, collectionMethod: 'public_html_next_f', method: 'GET',
      httpStatus: 200, httpStatuses: [200], responseSha256: groupedHash,
      observedItems: 1, sourcePages: rows, contentCoverage: 'directory_profiles_and_post_blocks',
      browserUsed: false, credentialsUsed: false, executionMode: 'pure_http', liveReplay: true },
  };
}
