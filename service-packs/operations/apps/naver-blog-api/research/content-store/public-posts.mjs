import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseThreadsPublic } from './threads-public.mjs';
import { fetchXPost } from './x-post.mjs';
import { fetchYouTubePost, youtubeIdentity } from './youtube-post.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const MAX_X_BYTES = 1_000_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_PDF_BYTES = 12_000_000;
const MAX_PDF_TEXT_BYTES = 8_000_000;
const TIMEOUT_MS = 15_000;

export function inspectPostUrl(input) {
  let url;
  try { url = new URL(input); } catch { return { platform: 'unsupported', code: 'POST_URL_INVALID' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { platform: 'unsupported', code: 'POST_URL_UNSUPPORTED' };
  }
  let match;
  const video = youtubeIdentity(url.href);
  if (video) return video;
  if (['x.com', 'www.x.com'].includes(url.hostname)) {
    match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
    return match ? { platform: 'x', url: `https://x.com/${match[1]}/status/${match[2]}`, handle: match[1], id: match[2] }
      : { platform: 'unsupported', code: 'POST_URL_UNSUPPORTED' };
  }
  if (['threads.com', 'www.threads.com'].includes(url.hostname)) {
    match = url.pathname.match(/^\/share\/([A-Za-z0-9_-]{5,40})\/?$/);
    if (match) return { platform: 'threads_share', url: `https://www.threads.com/share/${match[1]}/`, id: match[1] };
    match = url.pathname.match(/^\/@([A-Za-z0-9_.]{1,30})\/post\/([A-Za-z0-9_-]{5,30})\/?$/);
    return match ? { platform: 'threads', url: `https://www.threads.com/@${match[1]}/post/${match[2]}`, handle: match[1], id: match[2] }
      : { platform: 'unsupported', code: 'POST_URL_UNSUPPORTED' };
  }
  if (['reddit.com', 'www.reddit.com'].includes(url.hostname)) {
    match = url.pathname.match(/^\/r\/([A-Za-z0-9_]{2,30})\/comments\/([a-z0-9]{5,12})\/([^/]+)\/?$/i);
    return match ? { platform: 'reddit', url: `https://www.reddit.com/r/${match[1]}/comments/${match[2]}/${match[3]}/`, subreddit: match[1], id: match[2] }
      : { platform: 'unsupported', code: 'POST_URL_UNSUPPORTED' };
  }
  // Explicit article URLs from scouting may use any public HTTPS publisher. The
  // reader below keeps redirects on this hostname (or its www alias), sends no
  // session material and accepts only a substantive article container.
  if (url.pathname === '/' || !url.hostname.includes('.') || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')
    || isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    return { platform: 'unsupported', code: 'POST_URL_UNSUPPORTED' };
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
  return { platform: 'web_article', url: url.href, host: url.hostname };
}

async function readBody(response, limit) {
  if (!response.body) return { text: '', responseSha256: sha256(''), responseBytes: 0, tooLarge: false };
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) {
      await response.body.cancel().catch(() => {});
      return { text: '', responseSha256: null, responseBytes: size, tooLarge: true };
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return { text: bytes.toString('utf8'), responseSha256: sha256(bytes), responseBytes: bytes.length, tooLarge: false };
}

async function readBinaryBody(response, limit) {
  if (!response.body) return { bytes: Buffer.alloc(0), responseSha256: sha256(''), responseBytes: 0, tooLarge: false };
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) {
      await response.body.cancel().catch(() => {});
      return { bytes: null, responseSha256: null, responseBytes: size, tooLarge: true };
    }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, responseSha256: sha256(bytes), responseBytes: bytes.length, tooLarge: false };
}

export function extractPdfText(bytes, { spawnImpl = spawn, timeoutMs = TIMEOUT_MS } = {}) {
  const input = Buffer.from(bytes);
  if (input.length > MAX_PDF_BYTES) return Promise.resolve({ ok: false, code: 'WEB_PDF_TOO_LARGE' });
  if (!input.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return Promise.resolve({ ok: false, code: 'WEB_PDF_SIGNATURE' });
  return new Promise(resolve => {
    let child; let settled = false; let output = Buffer.alloc(0); let overflow = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child?.kill(); finish({ ok: false, code: 'WEB_PDF_EXTRACT_TIMEOUT' }); }, timeoutMs);
    try {
      const helper = fileURLToPath(new URL('./pdf-text-extract.py', import.meta.url));
      child = spawnImpl('python', ['-X', 'utf8', helper], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.on('data', chunk => {
        if (output.length + chunk.length > MAX_PDF_TEXT_BYTES) { overflow = true; child.kill(); return; }
        output = Buffer.concat([output, chunk]);
      });
      child.on('error', () => finish({ ok: false, code: 'WEB_PDF_EXTRACTOR_UNAVAILABLE' }));
      child.on('close', code => {
        if (settled) return;
        if (overflow) return finish({ ok: false, code: 'WEB_PDF_TEXT_TOO_LARGE' });
        try {
          const parsed = JSON.parse(output.toString('utf8'));
          if (parsed?.ok !== true) return finish({ ok: false, code: parsed?.code || 'WEB_PDF_EXTRACT_FAILED' });
          if (code !== 0 || typeof parsed.text !== 'string' || !Number.isInteger(parsed.pageCount)
            || parsed.pageCount < 1 || parsed.pageCount > 300) return finish({ ok: false, code: 'WEB_PDF_EXTRACT_FAILED' });
          finish({ ok: true, title: typeof parsed.title === 'string' ? parsed.title.slice(0, 300) : '',
            text: parsed.text, pageCount: parsed.pageCount, parserVersion: typeof parsed.parserVersion === 'string' ? parsed.parserVersion : null });
        } catch { finish({ ok: false, code: 'WEB_PDF_EXTRACT_FAILED' }); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } catch { finish({ ok: false, code: 'WEB_PDF_EXTRACTOR_UNAVAILABLE' }); }
  });
}

function unavailable(sourceUrl, code, httpStatus = null, details = {}) {
  return { status: 'unavailable', items: [], receipt: {
    sourceUrl, collectionMethod: details.collectionMethod || 'not_requested',
    httpStatus, httpStatuses: details.httpStatuses || (httpStatus === null ? [] : [httpStatus]),
    browserUsed: false, credentialsUsed: false, readerReturnedContent: false,
    ...(details.responseSha256 ? { responseSha256: details.responseSha256 } : {}), code,
    ...(details.responseBodyRead !== undefined ? { responseBodyRead: details.responseBodyRead } : {}),
    ...(details.responseBytes !== undefined ? { responseBytes: details.responseBytes } : {}),
    ...(details.postContentValidated !== undefined ? { postContentValidated: details.postContentValidated } : {}),
  } };
}

function decodeEntities(value) {
  return String(value || '').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_all, n) => { const cp = Number(n); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; })
    .replace(/&#x([\da-f]+);/gi, (_all, n) => { const cp = Number.parseInt(n, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; });
}

function visibleText(html) {
  return decodeEntities(String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) values[match[1].toLowerCase()] = decodeEntities(match[3]);
  return values;
}

function metaValue(html, keys) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const row = attributes(match[0]);
    const key = String(row.property || row.name || '').toLowerCase();
    if (keys.includes(key) && row.content) return row.content.trim();
  }
  return null;
}

function jsonLdArticles(html) {
  const rows = [];
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const type = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (type.some(x => /^(Article|NewsArticle|BlogPosting|ReportageNewsArticle)$/i.test(String(x)))) rows.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1].replace(/<\//g, '<\/'))); } catch { /* malformed page metadata is not article content */ }
  }
  return rows;
}

function smartstoreFaqArticle(html, url) {
  const page = new URL(url);
  if (page.hostname !== 'help.sell.smartstore.naver.com' || page.pathname !== '/faq/content.help') return null;
  const faqId = page.searchParams.get('faqId');
  if (!/^\d{1,8}$/.test(faqId || '')) return null;
  const safeHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const escapedId = faqId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const questionMatch = new RegExp(`<a\\b[^>]*\\bdata-content-no\\s*=\\s*(["'])${escapedId}\\1[^>]*>([\\s\\S]*?)<\\/a>`, 'i').exec(safeHtml);
  if (!questionMatch) return null;

  const divTag = /<\/?div\b[^>]*>/gi;
  divTag.lastIndex = questionMatch.index + questionMatch[0].length;
  let opening;
  while ((opening = divTag.exec(safeHtml))) {
    if (/^<\//.test(opening[0])) continue;
    const classes = String(attributes(opening[0]).class || '').split(/\s+/);
    if (!classes.includes('cus_answer')) continue;
    const contentStart = divTag.lastIndex;
    let depth = 1;
    let closing;
    while ((closing = divTag.exec(safeHtml))) {
      if (/^<\//.test(closing[0])) depth--;
      else if (!/\/\s*>$/.test(closing[0])) depth++;
      if (depth === 0) {
        const summary = visibleText(safeHtml.slice(contentStart, closing.index));
        const question = visibleText(questionMatch[2]);
        if (summary.length < 300 || !question) return null;
        return { title: `스마트스토어 고객센터 도움말: ${question}`.slice(0, 300), summary,
          bodySha256: sha256(summary), bodyLength: summary.length, bodyTruncated: false,
          contentCoverage: 'full_text', sourceKind: 'official_service_help',
          publisher: '네이버 스마트스토어 고객센터', url: page.href,
          publishedAt: null, publishedAtPrecision: 'unknown', evidenceLevel: 'official_help_html' };
      }
    }
    return null;
  }
  return null;
}

function parseWebArticle(html, url) {
  const smartstoreFaq = smartstoreFaqArticle(html, url);
  if (smartstoreFaq) return { item: smartstoreFaq };
  const jsonLd = jsonLdArticles(html);
  const containers = [];
  for (const pattern of [/<article\b[^>]*>([\s\S]*?)<\/article>/gi, /<main\b[^>]*>([\s\S]*?)<\/main>/gi]) {
    for (const match of html.matchAll(pattern)) {
      const text = visibleText(match[1]);
      if (text.length >= 300) containers.push(text);
    }
  }
  for (const row of jsonLd) if (typeof row.articleBody === 'string' && row.articleBody.trim().length >= 300) containers.push(row.articleBody.replace(/\s+/g, ' ').trim());
  const body = containers.sort((a, b) => b.length - a.length)[0] || '';
  const heading = visibleText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '');
  const title = heading || jsonLd.find(row => typeof row.headline === 'string')?.headline
    || metaValue(html, ['og:title', 'twitter:title'])
    || visibleText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '')
    || null;
  if (!title || body.length < 300) return { code: 'WEB_ARTICLE_CONTENT_UNVERIFIED' };
  const canonical = (() => {
    const raw = /<link\b[^>]*>/gi;
    for (const tag of html.matchAll(raw)) {
      const row = attributes(tag[0]);
      if (String(row.rel || '').toLowerCase().split(/\s+/).includes('canonical') && row.href) {
        try { const link = new URL(row.href, url); if (link.protocol === 'https:' && link.hostname === new URL(url).hostname) return link.href; } catch {}
      }
    }
    return url;
  })();
  const dateText = metaValue(html, ['article:published_time', 'date', 'datepublished'])
    || jsonLd.find(row => typeof row.datePublished === 'string')?.datePublished || null;
  const parsedDate = dateText && Date.parse(dateText);
  return { item: { title: title.slice(0, 300), summary: body.slice(0, 1500), bodySha256: sha256(body), bodyLength: body.length,
    bodyTruncated: false, contentCoverage: 'full_text', sourceKind: 'public_web_article',
    publisher: metaValue(html, ['og:site_name'])
      || jsonLd.find(row => typeof row.publisher?.name === 'string')?.publisher.name
      || new URL(url).hostname,
    url: canonical, publishedAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
    publishedAtPrecision: Number.isFinite(parsedDate) ? 'second' : 'unknown', evidenceLevel: 'public_article_html' } };
}

async function fetchWebArticle(input, fetchImpl, pdfExtractor = extractPdfText) {
  const original = new URL(input.url), baseHost = original.hostname.replace(/^www\./i, '');
  const samePublisher = host => host === baseHost || host === `www.${baseHost}`;
  const statuses = []; const visited = new Set(); let current = input.url;
  for (let hop = 0; hop < 4; hop++) {
    if (visited.has(current)) return unavailable(input.url, 'WEB_ARTICLE_REDIRECT_CYCLE', statuses.at(-1), { httpStatuses: statuses, collectionMethod: 'public_article_html' });
    visited.add(current);
    let url;
    try { url = new URL(current); } catch { return unavailable(input.url, 'WEB_ARTICLE_REDIRECT_INVALID', statuses.at(-1), { httpStatuses: statuses, collectionMethod: 'public_article_html' }); }
    if (url.protocol !== 'https:' || !samePublisher(url.hostname) || url.username || url.password || url.port) {
      return unavailable(input.url, 'WEB_ARTICLE_REDIRECT_SCOPE', statuses.at(-1), { httpStatuses: statuses, collectionMethod: 'public_article_html' });
    }
    let response;
    try { response = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'text/html,application/xhtml+xml;q=0.9' } }); }
    catch { return unavailable(input.url, 'WEB_ARTICLE_TRANSPORT', null, { httpStatuses: statuses, collectionMethod: 'public_article_html' }); }
    statuses.push(response.status);
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || hop === 3) return unavailable(input.url, 'WEB_ARTICLE_REDIRECT_LIMIT', response.status, { httpStatuses: statuses, collectionMethod: 'public_article_html' });
      let next;
      try { next = new URL(location, current); } catch { return unavailable(input.url, 'WEB_ARTICLE_REDIRECT_INVALID', response.status, { httpStatuses: statuses, collectionMethod: 'public_article_html' }); }
      if (next.protocol !== 'https:' || !samePublisher(next.hostname) || next.username || next.password || next.port) {
        return unavailable(input.url, 'WEB_ARTICLE_REDIRECT_SCOPE', response.status, { httpStatuses: statuses, collectionMethod: 'public_article_html' });
      }
      next.hash = ''; current = next.href; continue;
    }
    if (response.status !== 200) {
      const body = await readBody(response, MAX_HTML_BYTES);
      return unavailable(input.url, `WEB_ARTICLE_HTTP_${response.status}`, response.status,
        { collectionMethod: 'public_article_html', httpStatuses: statuses, responseSha256: body.responseSha256, responseBodyRead: !body.tooLarge, responseBytes: body.responseBytes });
    }
    const contentType = response.headers.get('content-type') || '';
    if (/application\/pdf|application\/octet-stream/i.test(contentType)) {
      const body = await readBinaryBody(response, MAX_PDF_BYTES);
      if (body.tooLarge) return unavailable(input.url, 'WEB_PDF_TOO_LARGE', response.status,
        { collectionMethod: 'public_pdf_http', httpStatuses: statuses, responseBytes: body.responseBytes });
      if (!body.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return unavailable(input.url,
        /application\/pdf/i.test(contentType) ? 'WEB_PDF_SIGNATURE' : 'WEB_ARTICLE_CONTENT_TYPE', response.status,
        { collectionMethod: 'public_pdf_http', httpStatuses: statuses, responseSha256: body.responseSha256, responseBodyRead: true, responseBytes: body.responseBytes });
      let parsed;
      try { parsed = await pdfExtractor(body.bytes); } catch { parsed = { ok: false, code: 'WEB_PDF_EXTRACT_FAILED' }; }
      const text = typeof parsed?.text === 'string' ? parsed.text.replace(/\u0000/g, '').replace(/\r/g, '\n').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
      const title = typeof parsed?.title === 'string' ? parsed.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      if (parsed?.ok !== true || !title || text.length < 300) return unavailable(input.url,
        parsed?.ok === true ? 'WEB_PDF_CONTENT_UNVERIFIED' : parsed?.code || 'WEB_PDF_EXTRACT_FAILED', response.status,
        { collectionMethod: 'public_pdf_http', httpStatuses: statuses, responseSha256: body.responseSha256, responseBodyRead: true,
          responseBytes: body.responseBytes, postContentValidated: false });
      return { status: 'collected', items: [{ title, summary: text.slice(0, 1500), bodySha256: sha256(text), bodyLength: text.length,
        bodyTruncated: false, contentCoverage: 'full_text', sourceKind: 'public_web_article', publisher: new URL(current).hostname,
        url: current, publishedAt: null, publishedAtPrecision: 'unknown', evidenceLevel: 'public_pdf_text' }],
      receipt: { sourceUrl: input.url, resolvedUrl: current, collectionMethod: 'public_pdf_http', httpStatus: response.status,
        httpStatuses: statuses, contentType, responseSha256: body.responseSha256, responseBytes: body.responseBytes,
        observedItems: 1, responseBodyRead: true, postContentValidated: true, browserUsed: false, credentialsUsed: false,
        readerReturnedContent: true, contentCoverage: 'full_text', extractedCharacters: text.length,
        pageCount: parsed.pageCount, parserVersion: parsed.parserVersion || null, executionMode: 'pure_http', liveReplay: true } };
    }
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      const body = await readBody(response, MAX_HTML_BYTES);
      return unavailable(input.url, 'WEB_ARTICLE_CONTENT_TYPE', response.status,
        { collectionMethod: 'public_article_html', httpStatuses: statuses, responseSha256: body.responseSha256, responseBodyRead: !body.tooLarge, responseBytes: body.responseBytes });
    }
    const body = await readBody(response, MAX_HTML_BYTES);
    if (body.tooLarge) return unavailable(input.url, 'WEB_ARTICLE_TOO_LARGE', response.status,
      { collectionMethod: 'public_article_html', httpStatuses: statuses, responseBytes: body.responseBytes });
    const parsed = parseWebArticle(body.text, current);
    if (!parsed.item) return unavailable(input.url, parsed.code, response.status,
      { collectionMethod: 'public_article_html', httpStatuses: statuses, responseSha256: body.responseSha256, responseBodyRead: true, responseBytes: body.responseBytes, postContentValidated: false });
    return { status: 'collected', items: [parsed.item], receipt: { sourceUrl: input.url, resolvedUrl: current, collectionMethod: 'public_article_html',
      httpStatus: response.status, httpStatuses: statuses, responseSha256: body.responseSha256, responseBytes: body.responseBytes,
      observedItems: 1, responseBodyRead: true, postContentValidated: true, browserUsed: false, credentialsUsed: false,
      readerReturnedContent: true, contentCoverage: 'full_text', executionMode: 'pure_http', liveReplay: true } };
  }
  return unavailable(input.url, 'WEB_ARTICLE_REDIRECT_LIMIT', statuses.at(-1) || null, { httpStatuses: statuses, collectionMethod: 'public_article_html' });
}

function xIdentity(raw, handle, id, { author = false } = {}) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return false;
    if (author) return url.pathname.replace(/\/$/, '').toLowerCase() === `/${handle}`.toLowerCase();
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
    return Boolean(match && match[1].toLowerCase() === handle.toLowerCase() && match[2] === id);
  } catch { return false; }
}

function parseOEmbedDate(html, handle, id) {
  const months = new Map(['jan feb mar apr may jun jul aug sep oct nov dec'].join(' ').split(' ').map((month, index) => [month, index + 1]));
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!xIdentity(decodeEntities(match[2]), handle, id)) continue;
    const text = visibleText(match[3]);
    if (!text) continue;
    if (/\b\d{1,2}:\d{2}\b/.test(text)) {
      if (Number.isFinite(Date.parse(text.replace(/[·•]/g, ' ')))) return { publishedAt: null, publishedAtText: text, publishedAtPrecision: 'localized_time' };
      continue;
    }
    const date = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (date) {
      const month = months.get(date[1].slice(0, 3).toLowerCase());
      const day = Number(date[2]); const year = Number(date[3]);
      const check = new Date(Date.UTC(year, month - 1, day));
      if (month && check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day) {
        return { publishedAt: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, publishedAtText: text, publishedAtPrecision: 'day' };
      }
    }
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      const year = Number(iso[1]); const month = Number(iso[2]); const day = Number(iso[3]);
      const check = new Date(Date.UTC(year, month - 1, day));
      if (check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day) {
        return { publishedAt: text, publishedAtText: text, publishedAtPrecision: 'day' };
      }
    }
  }
  return null;
}

function parseXEmbed(text, input) {
  let value;
  try { value = JSON.parse(text); } catch { return { code: 'X_OEMBED_NOT_JSON' }; }
  if (!value || typeof value !== 'object' || !xIdentity(value.url, input.handle, input.id)
    || !xIdentity(value.author_url, input.handle, input.id, { author: true }) || typeof value.html !== 'string') return { code: 'X_OEMBED_IDENTITY' };
  const blockquote = value.html.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1] || '';
  const body = visibleText(blockquote.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '');
  const time = parseOEmbedDate(value.html, input.handle, input.id);
  if (!body) return { code: 'X_OEMBED_BODY_UNAVAILABLE' };
  if (!time) return { code: 'X_OEMBED_TIME_UNAVAILABLE' };
  // oEmbed can silently shorten long posts, even below our local length limit.
  // A preview is not proof of the full body; the authenticated detail path is.
  const previewTruncated = /(?:…|\.{3})(?:\s|$)/.test(body);
  return { item: { title: body.slice(0, 220), summary: body.slice(0, 1500), bodySha256: sha256(body), bodyLength: body.length,
    bodyTruncated: body.length > 1500 || previewTruncated, contentCoverage: 'preview',
    url: input.url, ...time, evidenceLevel: 'public_oembed' } };
}

async function fetchX(input, fetchImpl) {
  const endpoint = new URL('https://publish.twitter.com/oembed');
  endpoint.searchParams.set('url', input.url);
  endpoint.searchParams.set('omit_script', '1');
  let requestUrl = endpoint;
  const statuses = [];
  for (let hop = 0; hop < 2; hop++) {
    const response = await fetchImpl(requestUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' } });
    statuses.push(response.status);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      let next;
      try { next = new URL(location, requestUrl); } catch { return unavailable(input.url, 'X_OEMBED_REDIRECT_INVALID', response.status, { collectionMethod: 'public_oembed', httpStatuses: statuses }); }
      const allowedHost = ['publish.twitter.com', 'publish.x.com'].includes(next.hostname);
      if (!allowedHost || next.protocol !== 'https:' || next.username || next.password || next.port || next.pathname !== '/oembed'
        || next.searchParams.get('url') !== input.url || next.searchParams.get('omit_script') !== '1' || hop !== 0) {
        return unavailable(input.url, 'X_OEMBED_REDIRECT_UNEXPECTED', response.status, { collectionMethod: 'public_oembed', httpStatuses: statuses });
      }
      requestUrl = next;
      continue;
    }
    if (response.status !== 200) {
      const body = await readBody(response, MAX_X_BYTES);
      return unavailable(input.url, `X_OEMBED_HTTP_${response.status}`, response.status,
        { collectionMethod: 'public_oembed', httpStatuses: statuses, responseSha256: body.responseSha256, responseBodyRead: !body.tooLarge, responseBytes: body.responseBytes, postContentValidated: false });
    }
    if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
      const body = await readBody(response, MAX_X_BYTES);
      return unavailable(input.url, 'X_OEMBED_CONTENT_TYPE', response.status,
        { collectionMethod: 'public_oembed', httpStatuses: statuses, responseSha256: body.responseSha256, responseBodyRead: !body.tooLarge, responseBytes: body.responseBytes, postContentValidated: false });
    }
    const body = await readBody(response, MAX_X_BYTES);
    if (body.tooLarge) return unavailable(input.url, 'X_OEMBED_TOO_LARGE', response.status,
      { collectionMethod: 'public_oembed', httpStatuses: statuses, responseBytes: body.responseBytes });
    const parsed = parseXEmbed(body.text, input);
    if (!parsed.item) return unavailable(input.url, parsed.code, response.status,
      { collectionMethod: 'public_oembed', httpStatuses: statuses, responseSha256: body.responseSha256, responseBodyRead: true, responseBytes: body.responseBytes, postContentValidated: false });
    return { status: 'partial', items: [parsed.item], receipt: { sourceUrl: input.url, collectionMethod: 'public_oembed',
      httpStatus: response.status, httpStatuses: statuses, responseSha256: body.responseSha256, responseBytes: body.responseBytes, observedItems: 1,
      responseBodyRead: true, postContentValidated: true,
      browserUsed: false, credentialsUsed: false, readerReturnedContent: true, contentCoverage: 'preview',
      liveReplay: true, executionMode: 'pure_http', code: 'X_PREVIEW_ONLY' } };
  }
  return unavailable(input.url, 'X_OEMBED_REDIRECT_LIMIT', statuses.at(-1) || null,
    { collectionMethod: 'public_oembed', httpStatuses: statuses });
}

async function fetchThreads(input, fetchImpl) {
  const response = await fetchImpl(input.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'text/html' } });
  if (response.status !== 200) {
    const body = await readBody(response, MAX_HTML_BYTES);
    return unavailable(input.url, `THREADS_HTTP_${response.status}`, response.status,
      { collectionMethod: 'public_html_embedded_json', responseSha256: body.responseSha256, responseBodyRead: !body.tooLarge, responseBytes: body.responseBytes, postContentValidated: false });
  }
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
    const body = await readBody(response, MAX_HTML_BYTES);
    return unavailable(input.url, 'THREADS_CONTENT_TYPE', response.status,
      { collectionMethod: 'public_html_embedded_json', responseSha256: body.responseSha256, responseBodyRead: !body.tooLarge, responseBytes: body.responseBytes, postContentValidated: false });
  }
  const body = await readBody(response, MAX_HTML_BYTES);
  if (body.tooLarge) return unavailable(input.url, 'THREADS_TOO_LARGE', response.status, { collectionMethod: 'public_html_embedded_json', responseBytes: body.responseBytes });
  let matches;
  try { matches = parseThreadsPublic(body.text, input.handle).filter(item => item.url === input.url); }
  catch { matches = []; }
  const item = matches[0];
  if (!item || !item.summary || !Number.isFinite(Date.parse(item.publishedAt))) return unavailable(input.url, 'THREADS_POST_UNAVAILABLE', response.status,
    { collectionMethod: 'public_html_embedded_json', responseSha256: body.responseSha256, responseBodyRead: true, responseBytes: body.responseBytes, postContentValidated: false });
  const text = item.summary;
  return { status: 'collected', items: [{ title: text.slice(0, 220), summary: text.slice(0, 1500), bodySha256: item.bodySha256 || sha256(text), bodyLength: item.bodyLength ?? text.length,
    bodyTruncated: item.bodyTruncated ?? text.length > 1500, contentCoverage: 'post_text',
    publisher: item.publisher, engagement: item.engagement, format: item.format,
    url: input.url, publishedAt: item.publishedAt, publishedAtText: item.publishedAt,
    publishedAtPrecision: 'second', evidenceLevel: 'public_html_embedded_json' }], receipt: { sourceUrl: input.url,
    collectionMethod: 'public_html_embedded_json', httpStatus: response.status, httpStatuses: [response.status],
    responseSha256: body.responseSha256, responseBytes: body.responseBytes, observedItems: 1,
    responseBodyRead: true, postContentValidated: true, browserUsed: false, credentialsUsed: false, readerReturnedContent: true,
    contentCoverage: 'post_text', executionMode: 'pure_http', liveReplay: true } };
}

async function fetchThreadsShare(input, fetchImpl) {
  const statuses = []; const visited = new Set(); let current = input;
  for (let hop = 0; hop < 3; hop++) {
    if (visited.has(current.url)) return unavailable(input.url, 'THREADS_SHARE_REDIRECT_CYCLE', statuses.at(-1), { httpStatuses: statuses });
    visited.add(current.url);
    const response = await fetchImpl(current.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'text/html' } });
    statuses.push(response.status);
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (![301,302,303,307,308].includes(response.status) || !location) return unavailable(input.url, 'THREADS_SHARE_NOT_RESOLVED', response.status, { httpStatuses: statuses });
    let resolved;
    try { resolved = inspectPostUrl(new URL(location, current.url).href); } catch {}
    if (!resolved || !['threads', 'threads_share'].includes(resolved.platform)) return unavailable(input.url, 'THREADS_SHARE_REDIRECT_UNEXPECTED', response.status, { httpStatuses: statuses });
    if (resolved.platform === 'threads') {
      const result = await fetchThreads(resolved, fetchImpl);
      result.receipt = { ...result.receipt, inputUrl: input.url, resolvedUrl: resolved.url,
        resolutionMethod: 'observed_same_service_redirect', httpStatuses: [...statuses, ...result.receipt.httpStatuses] };
      return result;
    }
    current = resolved;
  }
  return unavailable(input.url, 'THREADS_SHARE_REDIRECT_LIMIT', statuses.at(-1), { httpStatuses: statuses });
}

async function fetchReddit(input, fetchImpl) {
  const response = await fetchImpl(input.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'text/html' } });
  const body = await readBody(response, MAX_HTML_BYTES);
  if (response.status !== 200) return unavailable(input.url, `REDDIT_HTTP_${response.status}`, response.status,
    { collectionMethod: 'public_permalink_http', responseSha256: body.responseSha256, responseBodyRead: !body.tooLarge, responseBytes: body.responseBytes, postContentValidated: false });
  // A 200 response is not considered a post read until a public body/time parser is independently observed.
  return unavailable(input.url, body.tooLarge ? 'REDDIT_TOO_LARGE' : 'REDDIT_PUBLIC_READER_UNVERIFIED', response.status,
    { collectionMethod: 'public_permalink_http', responseSha256: body.responseSha256, responseBodyRead: !body.tooLarge,
      responseBytes: body.responseBytes, postContentValidated: false });
}

export async function fetchPublicPost(url, { fetchImpl = globalThis.fetch, xPostReader = fetchXPost, pdfExtractor = extractPdfText } = {}) {
  const input = inspectPostUrl(url);
  if (input.platform === 'unsupported') {
    let sourceUrl = null;
    try { const safe = new URL(url); safe.search = ''; safe.hash = ''; safe.username = ''; safe.password = ''; sourceUrl = safe.href; } catch {}
    return unavailable(sourceUrl, input.code);
  }
  try {
    if (input.platform === 'x') {
      try {
        const authenticated = await xPostReader(input, { fetchImpl });
        if (authenticated) return authenticated;
      } catch (error) {
        const code = /^[A-Z_0-9]+$/.test(error.code || error.message || '') ? (error.code || error.message) : 'X_AUTHENTICATED_READ_FAILED';
        const result = unavailable(input.url, code, error.receipt?.httpStatus || null, { collectionMethod: 'authenticated_graphql' });
        result.receipt.credentialProvider = 'windows_dpapi_current_user';
        result.receipt.authenticationAttempted = true;
        result.receipt.credentialsUsed = error.receipt?.authenticationMode === 'user_session' ? true : null;
        return result;
      }
      return await fetchX(input, fetchImpl);
    }
    if (input.platform === 'youtube') return await fetchYouTubePost(input, fetchImpl);
    if (input.platform === 'threads_share') return await fetchThreadsShare(input, fetchImpl);
    if (input.platform === 'threads') return await fetchThreads(input, fetchImpl);
    if (input.platform === 'web_article') return await fetchWebArticle(input, fetchImpl, pdfExtractor);
    return await fetchReddit(input, fetchImpl);
  } catch {
    return unavailable(input.url, `${input.platform.toUpperCase()}_NETWORK_UNAVAILABLE`, null,
      { collectionMethod: input.platform === 'x' ? 'public_oembed' : input.platform === 'youtube' ? 'youtube_oembed_metadata'
        : input.platform.startsWith('threads') ? 'public_html_embedded_json' : 'public_permalink_http' });
  }
}
