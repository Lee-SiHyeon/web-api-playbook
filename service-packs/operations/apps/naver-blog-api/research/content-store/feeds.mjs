import { createHash } from 'node:crypto';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function fail(code, extra = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function checkedHttpsUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw fail('FEED_URL'); }
  if (parsed.protocol !== 'https:') throw fail('FEED_PROTOCOL');
  if (parsed.username || parsed.password) throw fail('FEED_URL_CREDENTIALS');
  return parsed;
}

function header(response, name) {
  return response?.headers?.get?.(name) || '';
}

function declaredCharset(contentType) {
  const match = String(contentType).match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  return (match?.[1] || match?.[2] || match?.[3] || '').trim();
}

function xmlDeclaredCharset(bytes) {
  // XML declaration names are ASCII, including in legacy encodings such as EUC-KR.
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).toString('latin1');
  return prefix.match(/^\uFEFF?\s*<\?xml\b[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/i)?.[2]?.trim() || '';
}

function decodeXml(bytes, contentType) {
  const charset = declaredCharset(contentType) || xmlDeclaredCharset(bytes) || 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); }
  catch { throw fail('FEED_CHARSET'); }
  return { text: decoder.decode(bytes), charset: decoder.encoding };
}

async function readBoundedBody(response) {
  const length = header(response, 'content-length');
  if (/^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) throw fail('SOURCE_TOO_LARGE');

  const stream = response?.body;
  if (!stream?.getReader) {
    let bytes;
    try { bytes = new Uint8Array(await response.arrayBuffer()); }
    catch { throw fail('FEED_TRANSPORT'); }
    if (bytes.byteLength > MAX_BODY_BYTES) throw fail('SOURCE_TOO_LARGE');
    return bytes;
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* Ignore cancellation errors after the size limit is reached. */ }
        throw fail('SOURCE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.code) throw error;
    throw fail('FEED_TRANSPORT');
  } finally {
    try { reader.releaseLock(); } catch { /* Some custom streams do not expose a releasable lock. */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function decodeEntities(text) {
  return text.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos);/gi, (entity, key) => {
    if (key[0] !== '#') {
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key.toLowerCase()] ?? entity;
    }
    const codePoint = key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(codePoint);
  });
}

function cleanText(value) {
  return decodeEntities(String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function rootFormat(xml) {
  const documentStart = xml.replace(/^\uFEFF/, '').replace(/^(?:\s|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)+/, '');
  const match = documentStart.match(/^<(?:[\w.-]+:)?([\w.-]+)\b/);
  const root = match?.[1]?.toLowerCase();
  if (root === 'rss') return 'rss';
  if (root === 'feed') return 'atom';
  throw fail('RSS_SCHEMA');
}

function elementMatches(xml, name) {
  const regex = new RegExp(`<(?:(?:[\\w.-]+):)?${name}\\b([^>]*)>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${name}\\s*>`, 'gi');
  return [...xml.matchAll(regex)].map(match => ({ attributes: match[1], content: match[2] }));
}

function firstElement(xml, name) {
  return elementMatches(xml, name)[0]?.content ?? '';
}

function firstText(xml, name) {
  return cleanText(firstElement(xml, name));
}

function parseDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

// upgradeHost: feeds such as Ppomppu publish http:// item links for a host that also serves https.
// Only links on the feed's own host are upgraded; any other http link is still dropped.
function secureItemUrl(rawUrl, upgradeHost = null) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' && upgradeHost && parsed.hostname === upgradeHost) parsed.protocol = 'https:';
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

function rssItems(xml, upgradeHost) {
  return elementMatches(xml, 'item').map(({ content }) => {
    const source = firstText(content, 'source');
    const author = firstText(content, 'author');
    return {
      title: firstText(content, 'title'),
      url: secureItemUrl(firstText(content, 'link'), upgradeHost),
      publishedAt: parseDate(firstText(content, 'pubDate')),
      publisher: source || author || null,
      summary: firstText(content, 'description').slice(0, 1500),
    };
  }).filter(item => item.title && item.url);
}

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeEntities(match[2]).trim() : '';
}

function atomLinks(entry, upgradeHost) {
  const links = [];
  const regex = /<(?:[\w.-]+:)?link\b([^>]*)>/gi;
  for (const match of entry.matchAll(regex)) {
    const href = attribute(match[1], 'href');
    if (href) links.push({ href, rel: attribute(match[1], 'rel').toLowerCase() });
  }
  const selected = links.find(link => link.rel === 'alternate') || links[0];
  return secureItemUrl(selected?.href || '', upgradeHost);
}

function atomItems(xml, upgradeHost) {
  return elementMatches(xml, 'entry').map(({ content }) => {
    const authorBlock = firstElement(content, 'author');
    const author = firstText(authorBlock, 'name') || cleanText(authorBlock);
    const published = firstText(content, 'published') || firstText(content, 'updated');
    const summary = firstText(content, 'summary') || firstText(content, 'content');
    return {
      title: firstText(content, 'title'),
      url: atomLinks(content, upgradeHost),
      publishedAt: parseDate(published),
      publisher: author || null,
      summary: summary.slice(0, 1500),
    };
  }).filter(item => item.title && item.url);
}

function parseFeedDocument(xml, upgradeHost = null) {
  if (typeof xml !== 'string' || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw fail('RSS_SCHEMA');
  const format = rootFormat(xml);
  return { format, items: format === 'rss' ? rssItems(xml, upgradeHost) : atomItems(xml, upgradeHost) };
}

export function parseFeed(xml, { upgradeHost = null } = {}) {
  return parseFeedDocument(xml, upgradeHost).items;
}

export async function fetchFeed(url, { fetchImpl = globalThis.fetch, limit = 30, upgradeSameHostHttp = false } = {}) {
  if (!Number.isInteger(limit) || limit < 0) throw fail('FEED_LIMIT');
  if (typeof fetchImpl !== 'function') throw fail('FEED_TRANSPORT');

  const source = checkedHttpsUrl(url);
  let current = source;
  let response;
  for (let redirects = 0; ; redirects++) {
    try {
      response = await fetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
      });
    } catch { throw fail('FEED_TRANSPORT'); }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = header(response, 'location');
      if (!location) throw fail('REDIRECT_LOCATION');
      if (redirects >= MAX_REDIRECTS) throw fail('REDIRECT_LIMIT');
      let destination;
      try { destination = new URL(location, current); }
      catch { throw fail('REDIRECT_URL'); }
      if (destination.protocol !== 'https:') throw fail('REDIRECT_PROTOCOL');
      if (destination.username || destination.password) throw fail('REDIRECT_URL_CREDENTIALS');
      current = destination;
      continue;
    }

    if (response.status !== 200) throw fail('HTTP_STATUS', { status: response.status });
    break;
  }

  const bytes = await readBoundedBody(response);
  const { text: xml, charset } = decodeXml(bytes, header(response, 'content-type'));
  const parsed = parseFeedDocument(xml, upgradeSameHostHttp ? current.hostname : null);
  const items = parsed.items.slice(0, limit);
  return {
    items,
    receipt: {
      httpStatus: response.status,
      sourceUrl: source.href,
      finalUrl: current.href,
      charset,
      responseSha256: createHash('sha256').update(bytes).digest('hex'),
      observedItems: parsed.items.length,
      format: parsed.format,
      browserUsed: false,
    },
  };
}
