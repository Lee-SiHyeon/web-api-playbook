/** Minimal dependency-free RSS 2.0 and Atom feed parser. */

export interface RssItem {
  title: string;
  link: string;
  pubDate: string;         // ISO 8601 or attempt to parse
  description?: string;
  imageUrl?: string;       // from <image>, <enclosure>, or og:image in description
  commentsCount?: number;
  guid?: string;           // stable item ID when available
}

/** Parse simple RSS 2.0 or Atom feed XML string. Returns array of items. */
export function parseRssFeed(xmlContent: string): RssItem[] {
  // HTTP 200 also occurs for HTML bot challenges. Empty results are healthy only after the response
  // identifies a supported, closed feed document; arbitrary HTML/text must never look like an empty feed.
  if (feedFormat(xmlContent) === 'atom') {
    return parseAtomFeed(xmlContent);
  } else {
    return parseRss2Feed(xmlContent);
  }
}

function feedFormat(xmlContent: string): 'rss' | 'atom' {
  const document = xmlContent.replace(/^\uFEFF/, '')
    .replace(/^(?:\s|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)*/, '')
    .replace(/(?:\s|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)*$/, '');
  const root = document.match(/^<((?:[\w.-]+:)?(?:rss|feed))(?=[\s/>])([^>]*)>/i);
  const invalid = () => { throw new Error('RSS_SCHEMA: expected a complete RSS or Atom feed'); };
  if (!root) return invalid();
  const name = root[1];
  const localName = name.split(':').at(-1)!.toLowerCase();
  const selfClosing = /\/\s*$/.test(root[2]);
  if (selfClosing && document !== root[0]) return invalid();
  if (!selfClosing && !new RegExp(`</${name.replaceAll('.', '\\.')}\\s*>$`, 'i').test(document)) return invalid();
  if (localName === 'feed') {
    const prefix = name.includes(':') ? `:${name.split(':')[0]}` : '';
    const namespace = new RegExp(`(?:^|\\s)xmlns${prefix.replaceAll('.', '\\.')}\\s*=\\s*(["'])http://www\\.w3\\.org/2005/Atom\\1`, 'i');
    if (!namespace.test(root[2])) return invalid();
    return 'atom';
  }
  const channel = document.match(/<(?:[\w.-]+:)?channel(?=[\s/>])([^>]*)>/i);
  if (selfClosing || !channel || (!/\/\s*$/.test(channel[1]) && !/<\/(?:[\w.-]+:)?channel\s*>/i.test(document))) return invalid();
  return 'rss';
}

/** Parse RSS 2.0 feed. */
function parseRss2Feed(xmlContent: string): RssItem[] {
  const items: RssItem[] = [];

  // Extract all <item>...</item> blocks
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let itemMatch;

  while ((itemMatch = itemRegex.exec(xmlContent)) !== null) {
    const itemXml = itemMatch[1];

    const titleMatch = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const pubDateMatch = itemXml.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const descMatch = itemXml.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const guidMatch = itemXml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const commentsMatch = itemXml.match(/<comments[^>]*>([\s\S]*?)<\/comments>/i);
    const enclosureMatch = itemXml.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image\//i);

    const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';
    const link = linkMatch ? decodeHtmlEntities(linkMatch[1].trim()).replace(/^http:\/\//, 'https://') : '';
    const pubDate = pubDateMatch ? normalizeDate(pubDateMatch[1].trim()) : new Date().toISOString();

    if (!title || !link) continue; // Skip incomplete items

    const item: RssItem = {
      title,
      link,
      pubDate,
      guid: guidMatch ? guidMatch[1].trim() : link,
    };

    if (descMatch) {
      item.description = decodeHtmlEntities(descMatch[1].trim().replace(/<[^>]+>/g, ''));
    }

    if (commentsMatch) {
      const count = parseInt(commentsMatch[1], 10);
      if (!isNaN(count)) item.commentsCount = count;
    }

    if (enclosureMatch) {
      item.imageUrl = enclosureMatch[1].trim();
    } else {
      item.imageUrl = extractImageFromDescription(descMatch ? descMatch[1] : '');
    }

    items.push(item);
  }

  return items;
}

/** Parse Atom feed. */
function parseAtomFeed(xmlContent: string): RssItem[] {
  const items: RssItem[] = [];

  // Extract all <entry>...</entry> blocks
  const entryRegex = /<(?:[\w.-]+:)?entry\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?entry>/gi;
  let entryMatch;

  while ((entryMatch = entryRegex.exec(xmlContent)) !== null) {
    const entryXml = entryMatch[1];

    const titleMatch = entryXml.match(/<(?:[\w.-]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?title>/i);
    const linkMatch = entryXml.match(/<(?:[\w.-]+:)?link\b[^>]*href="([^"]+)"/i);
    const publishedMatch = entryXml.match(/<(?:[\w.-]+:)?published\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?published>/i);
    const summaryMatch = entryXml.match(/<(?:[\w.-]+:)?summary\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?summary>/i);
    const idMatch = entryXml.match(/<(?:[\w.-]+:)?id\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?id>/i);

    const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';
    const link = linkMatch ? decodeHtmlEntities(linkMatch[1].trim()).replace(/^http:\/\//, 'https://') : '';
    const pubDate = publishedMatch ? normalizeDate(publishedMatch[1].trim()) : new Date().toISOString();

    if (!title || !link) continue;

    const item: RssItem = {
      title,
      link,
      pubDate,
      guid: idMatch ? idMatch[1].trim() : link,
    };

    if (summaryMatch) {
      item.description = decodeHtmlEntities(summaryMatch[1].trim().replace(/<[^>]+>/g, ''));
    }

    items.push(item);
  }

  return items;
}

/** Extract first image URL from description HTML. */
function extractImageFromDescription(html: string): string | undefined {
  // Look for <img src="...">
  const imgMatch = html.match(/<img[^>]*src="([^"]+)"/i);
  if (imgMatch) return imgMatch[1];

  // Look for <image>...</image>
  const imageMatch = html.match(/<image[^>]*>([\s\S]*?)<\/image>/i);
  if (imageMatch) {
    const urlMatch = imageMatch[1].match(/<url>([\s\S]*?)<\/url>/i);
    if (urlMatch) return urlMatch[1].trim();
  }

  return undefined;
}

/** Normalize date string to ISO 8601. */
function normalizeDate(dateStr: string): string {
  try {
    // Try RFC 822 (RSS standard): Mon, 01 Jan 2026 12:00:00 +0000
    // Or ISO 8601: 2026-01-01T12:00:00Z or 2026-01-01T12:00:00+00:00
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      // Fallback to now if parsing fails
      return new Date().toISOString();
    }
    return date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Decode common HTML entities. */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  };

  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'g'), char);
  }

  // Handle numeric entities &#123;
  result = result.replace(/&#(\d+);/g, (match, code) => {
    const num = parseInt(code, 10);
    return isNaN(num) ? match : String.fromCharCode(num);
  });

  return result;
}
