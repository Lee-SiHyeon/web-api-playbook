import { HubItem } from '../types';
import { guessCategory } from './parse-deal-title';
import { fetchCollectorResponse } from './fetch-response';

const SOURCE_URL = 'https://www.11st.co.kr/html/nc/deal/main.html';

interface ProductCard {
  title: string;
  url: string;
  productId: string;
  salePrice: number | null;
  originalPrice: number | null;
  discountPercent: number | null;
  deliveryText: string | null;
  imageUrl: string | null;
}

interface CollectorResult {
  items: Array<Partial<HubItem>>;
  fetched: number;
  blocked: boolean;
  error: string | null;
}

/**
 * Detect charset from HTML meta tag or default to utf-8.
 */
function detectCharset(html: string): string {
  // Look for <meta charset="...">
  const charsetMatch = html.match(/<meta\s+charset\s*=\s*["']?([^"'>\s]+)/i);
  if (charsetMatch) {
    return charsetMatch[1].toLowerCase();
  }
  // Look for <meta http-equiv="Content-Type" content="text/html; charset=...">
  const httpEquivMatch = html.match(/<meta\s+http-equiv\s*=\s*["']?Content-Type["']?[^>]*content\s*=\s*["']([^"']+)/i);
  if (httpEquivMatch) {
    const charsetInContent = httpEquivMatch[1].match(/charset=([^;]+)/i);
    if (charsetInContent) {
      return charsetInContent[1].toLowerCase();
    }
  }
  return 'utf-8';
}

/**
 * Decode response body with proper charset handling.
 */
function decodeResponse(buffer: Uint8Array, headers: Headers): string {
  const contentType = headers.get('content-type') || '';

  // Try to detect charset from Content-Type header
  let charset = 'utf-8';
  const headerCharset = contentType.match(/charset\s*=\s*([^;]+)/i);
  if (headerCharset) {
    charset = headerCharset[1].trim().toLowerCase();
  }

  // Decode with detected charset
  try {
    const decoder = new TextDecoder(charset);
    const html = decoder.decode(buffer);

    // Re-detect from meta tag if utf-8 was default
    if (charset === 'utf-8') {
      const metaCharset = detectCharset(html);
      if (metaCharset !== 'utf-8') {
        const decoder2 = new TextDecoder(metaCharset);
        return decoder2.decode(buffer);
      }
    }

    return html;
  } catch {
    // Fallback to utf-8 if TextDecoder fails with the detected charset
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(buffer);
  }
}

/**
 * Extract text content from HTML, clean it.
 */
function cleanText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/**
 * Extract attribute value from HTML tag.
 */
function getAttribute(tag: string, name: string): string {
  const regex = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(regex);
  return match ? decodeHtmlEntities(match[1] || match[2] || match[3] || '') : '';
}

/**
 * Decode HTML entities.
 */
function decodeHtmlEntities(text: string): string {
  const map: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  let result = text;
  for (const [entity, char] of Object.entries(map)) {
    result = result.replaceAll(entity, char);
  }
  // Handle numeric entities
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  result = result.replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  return result;
}

/**
 * Extract number from text (remove non-digit characters, parse).
 */
function extractNumber(text: string): number | null {
  if (!text) return null;
  const digits = text.replace(/[^\d]/g, '');
  if (!digits) return null;
  const parsed = parseInt(digits, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Extract percentage from text.
 */
function extractPercent(text: string): number | null {
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const parsed = parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Check if HTML looks like a bot challenge page.
 */
function isBlockedPage(status: number, html: string): boolean {
  if (status === 403) return true;
  const sample = html.slice(0, 100_000);
  return /captcha|cf-chl-|challenge|checking your browser|verify.*human|not a robot|access denied|bot detection|security|akamai|incapsula|perimeterx|datadome/i.test(
    sample,
  );
}

/**
 * Parse product cards from 11번가 HTML.
 * Extracts: title, URL, price, discount, delivery info.
 */
function parseProducts(html: string): ProductCard[] {
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) {
    throw new Error('SCHEMA: Not valid HTML');
  }

  // Remove scripts and styles to avoid parsing their content
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');

  const products: ProductCard[] = [];
  const seen = new Set<string>();

  // Find all links with href pointing to 11st product pages
  const linkRegex = /<a\b[^>]*>/gi;
  for (const match of markup.matchAll(linkRegex)) {
    const tag = match[0];
    const href = getAttribute(tag, 'href');

    if (!href) continue;

    // Parse product URL
    let url: URL;
    try {
      url = new URL(href, SOURCE_URL);
    } catch {
      continue;
    }

    // Must be 11st.co.kr domain
    if (!url.hostname.endsWith('11st.co.kr')) continue;

    // Extract product ID from /product/ or /products/ path
    const productMatch = url.pathname.match(/\/products?\/(\d+)(?:\/|$)/i);
    if (!productMatch) continue;

    const productId = productMatch[1];
    if (seen.has(productId)) continue;
    seen.add(productId);

    // Extract data attributes or nearby elements for product info
    const dataLogBody = getAttribute(tag, 'data-log-body');
    let title = '';
    if (dataLogBody) {
      try {
        const logData = JSON.parse(dataLogBody);
        if (typeof logData.content_name === 'string') {
          title = cleanText(logData.content_name);
        }
      } catch {
        // Ignore parse errors
      }
    }

    if (!title) {
      // Try to get title from surrounding content (next 500 chars)
      const endIdx = Math.min(match.index + 500, markup.length);
      const context = markup.slice(match.index, endIdx);
      // Look for common title patterns
      const titleMatch = context.match(/<(?:p|span|strong|div)\b[^>]*class\s*=\s*["']name["'][^>]*>([\s\S]*?)<\/(?:p|span|strong|div)>/i);
      if (titleMatch) {
        title = cleanText(titleMatch[1]);
      }
    }

    if (!title) continue;

    // Look for price info in nearby elements
    let salePrice: number | null = null;
    let originalPrice: number | null = null;
    let discountPercent: number | null = null;
    let deliveryText: string | null = null;
    let imageUrl: string | null = null;

    // Search context around the link (200 before and 1000 after)
    const contextStart = Math.max(0, match.index - 200);
    const contextEnd = Math.min(markup.length, match.index + 1000);
    const context = markup.slice(contextStart, contextEnd);

    // Look for image URLs (protocol-relative or https)
    const imgMatch = context.match(/<img\b[^>]*src\s*=\s*["']([^"']+)["']/i);
    if (imgMatch) {
      let url = imgMatch[1];
      // Convert protocol-relative URLs to HTTPS
      if (url.startsWith('//')) {
        url = 'https:' + url;
      }
      // Only accept HTTPS URLs
      if (url.startsWith('https://')) {
        imageUrl = url;
      }
    }

    // Find price elements
    const priceMatch = context.match(/<(?:s|span|strong)\b[^>]*class\s*=\s*["']normal_price["'][^>]*>([\s\S]*?)<\/(?:s|span|strong)>/i);
    if (priceMatch) {
      originalPrice = extractNumber(cleanText(priceMatch[1]));
    }

    const salePriceMatch = context.match(/<(?:strong|span|s)\b[^>]*class\s*=\s*["']sale_price["'][^>]*>([\s\S]*?)<\/(?:strong|span|s)>/i);
    if (salePriceMatch) {
      salePrice = extractNumber(cleanText(salePriceMatch[1]));
    }

    const discountMatch = context.match(/<(?:span|em|strong)\b[^>]*class\s*=\s*["']sale["'][^>]*>([\s\S]*?)<\/(?:span|em|strong)>/i);
    if (discountMatch) {
      discountPercent = extractPercent(cleanText(discountMatch[1]));
    }

    // Look for delivery info
    const deliveryMatches = context.match(/<div\b[^>]*class\s*=\s*["']info_flag["'][^>]*>([\s\S]*?)<\/div>/gi);
    if (deliveryMatches) {
      const deliveryTexts = deliveryMatches.map((m) => {
        const innerMatch = m.match(/>([\s\S]*?)<\/div>/);
        return innerMatch ? cleanText(innerMatch[1]) : '';
      });
      const deliveryInfo = deliveryTexts.filter((t) => t && /무료|배송|당일|도착|설치/i.test(t));
      if (deliveryInfo.length > 0) {
        deliveryText = deliveryInfo.join(' · ');
      }
    }

    products.push({
      title,
      url: url.href,
      productId,
      salePrice: salePrice || originalPrice,
      originalPrice,
      discountPercent,
      deliveryText,
      imageUrl,
    });
  }

  return products;
}

/**
 * Collect hotdeal items from 11번가 쇼킹딜.
 * Makes 1 request to fetch and parse the deal page.
 */
export async function collectEleventh(
  fetchImpl: typeof fetch,
  userAgent: string,
  now: Date,
): Promise<CollectorResult> {
  const result: CollectorResult = {
    items: [],
    fetched: 0,
    blocked: false,
    error: null,
  };

  try {
    const response = await fetchCollectorResponse(fetchImpl, SOURCE_URL, {
      headers: { 'User-Agent': userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });

    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        result.blocked = true;
        result.error = `HTTP ${response.status}`;
        return result;
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const html = decodeResponse(response.body, response.headers);

    // Check for blocked pages
    if (isBlockedPage(response.status, html)) {
      result.blocked = true;
      result.error = 'ACCESS_BLOCKED';
      return result;
    }

    // Parse products
    const products = parseProducts(html);
    result.fetched = products.length;

    // Convert to HubItem rows
    for (const product of products) {
      const tags: string[] = [];
      if (product.discountPercent && product.discountPercent > 0) {
        tags.push(`-${Math.round(product.discountPercent)}%`);
      }

      const row: Partial<HubItem> = {
        id: `eleventh:${product.productId}`,
        kind: 'hotdeal',
        category: guessCategory(product.title),
        title: product.title,
        store: '11번가',
        priceKrw: product.salePrice,
        shippingNote: product.deliveryText,
        imageUrl: product.imageUrl,
        source: 'eleventh',
        sourceUrl: product.url,
        affiliateUrl: null,
        postedAt: now.toISOString(),
        expiresAt: null,
        comments: null,
        votes: null,
        views: null,
        tags,
        summary: null,
        ended: false,
      };

      result.items.push(row);
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'unknown error';
    return result;
  }
}
