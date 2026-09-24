import { createHash } from 'node:crypto';
import { ApiError } from '../../scripts/client.mjs';

const terms = Object.freeze([
  'PostWrite', 'PostUpdate', 'PostDelete', 'documentModel', 'SmartEditor', 'editor',
  'sticker', 'upload', 'photo', 'video', 'autosave', 'draft', 'template', 'publish',
]);
const relevant = value => terms.some(term => value.toLowerCase().includes(term.toLowerCase()));
const safeField = /^[A-Za-z_$][\w$.-]{0,100}$/;

export function analyzePublicScript(source, base) {
  if (typeof source !== 'string' || typeof base !== 'string') throw new ApiError('INPUT', 'Supply script source and base URL');
  const baseUrl = new URL(base);
  if (baseUrl.protocol !== 'https:' || baseUrl.hostname !== 'ssl.pstatic.net' || !/\.js$/i.test(baseUrl.pathname)) {
    throw new ApiError('SCOPE', 'Only observed public Naver static JavaScript may be analyzed');
  }
  const identifiers = [...new Set([...source.matchAll(/\b([A-Za-z_$][\w$]{2,100})\s*(?=[:=(])/g)]
    .map(match => match[1]).filter(relevant))].slice(0, 300);
  const candidates = [];
  for (const match of source.matchAll(/["'`]((?:https:\/\/[^\s"'`<>]+)?\/[A-Za-z0-9_./?=&%{}:@+-]+)["'`]/g)) {
    if (!relevant(match[1])) continue;
    const absolute = match[1].startsWith('https://');
    let url;
    try { url = absolute ? new URL(match[1]) : new URL(match[1], 'https://placeholder.invalid'); } catch { continue; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) continue;
    if (absolute && !['naver.com', 'pstatic.net'].some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) continue;
    const queryFields = [...new Set([...url.searchParams.keys()].filter(field => safeField.test(field)))].sort();
    candidates.push({
      ...(absolute ? { url: url.origin + url.pathname } : { path: url.pathname, origin: null }),
      queryFields,
      terms: terms.filter(term => match[1].toLowerCase().includes(term.toLowerCase())),
      executable: false,
      source: 'public_script_string_candidate',
      literalKind: absolute ? 'absolute_url' : 'root_relative_path',
    });
  }
  const methodHints = [...new Set([...source.matchAll(/\b(?:method|type)\s*[:=]\s*["'](GET|POST|PUT|PATCH|DELETE)["']/gi)]
    .map(match => match[1].toUpperCase()))].sort();
  return {
    url: baseUrl.origin + baseUrl.pathname,
    bytes: Buffer.byteLength(source),
    sha256: createHash('sha256').update(source).digest('hex'),
    identifiers,
    candidates: [...new Map(candidates.map(candidate => [`${candidate.url ?? candidate.path}?${candidate.queryFields.join(',')}`, candidate])).values()].slice(0, 300),
    methodHints,
  };
}

export async function fetchAndAnalyzePublicScript(raw, { fetchImpl = globalThis.fetch,
  timeoutMs = 20000, maxBytes = 5 * 1024 * 1024 } = {}) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'ssl.pstatic.net' || !/\.js$/i.test(url.pathname)) {
    throw new ApiError('SCOPE', 'Only public Naver static JavaScript may be fetched');
  }
  const response = await fetchImpl(url.href, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/javascript,text/javascript;q=0.9,*/*;q=0.1' },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ApiError('HTTP', 'Public script fetch did not return HTTP 200', { httpStatus: response.status });
  }
  if (!response.body) throw new ApiError('SCHEMA', 'Public script response has no body');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError('SIZE', 'Public script exceeds response budget');
    chunks.push(chunk);
  }
  return analyzePublicScript(Buffer.concat(chunks).toString('utf8'), url.href);
}
