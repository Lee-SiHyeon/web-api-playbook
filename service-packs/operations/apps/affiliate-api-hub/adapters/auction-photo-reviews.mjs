import { parseFragment } from 'parse5';

class ShoppingReadError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'ShoppingReadError'; this.code = code; this.details = details; }
}

const apiOrigin = 'https://bamboo.auction.co.kr';
const apiPath = '/Review/Review/PhotoViewerReviewList';
function nodes(node, predicate, found = []) {
  if (!node) return found;
  if (predicate(node)) found.push(node);
  for (const child of node.childNodes ?? []) nodes(child, predicate, found);
  return found;
}
function attr(node, name) { return node?.attrs?.find(a => a.name === name)?.value; }
function cls(node, name) { return (attr(node, 'class') ?? '').split(/\s+/).includes(name); }
function first(node, name) { return nodes(node, n => cls(n, name))[0]; }
function text(node) {
  if (!node || ['script', 'style'].includes(node.tagName)) return '';
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(text).join(' ').replace(/\s+/g, ' ').trim();
}

export function parseAuctionPhotoReviews(html, { page = 1 } = {}) {
  if (typeof html !== 'string') throw new ShoppingReadError('AUCTION_PHOTO_SCHEMA');
  const cards = nodes(parseFragment(html), n => cls(n, 'js-box__review-item'));
  // An empty page's end-of-list contract has not been observed; do not label it complete.
  if (!cards.length) throw new ShoppingReadError('AUCTION_PHOTO_EMPTY_OR_SCHEMA');
  return cards.map((card, i) => {
    const id = attr(card, 'id')?.match(/^review_(\d+)$/)?.[1];
    const bodyNode = first(card, 'js-box__review-text');
    const body = text(bodyNode);
    const date = text(first(card, 'text__date')).match(/\d{4}\.\d{2}\.\d{2}/)?.[0].replace(/\./g, '-');
    const rating = text(first(card, 'box__star')).match(/^([0-5](?:\.\d+)?)\s*점$/)?.[1];
    const count = text(first(card, 'js-text__count')).replace(/,/g, '');
    if (!id || !bodyNode || !date || rating === undefined || Number(rating) > 5 || !/^\d+$/.test(count)) throw new ShoppingReadError('AUCTION_PHOTO_ITEM_SCHEMA');
    return { reviewId: id, page, position: i + 1, text: body, rating: Number(rating), publishedDate: date,
      optionText: text(first(card, 'text__option-selected')) || null, helpfulCount: Number(count) };
  });
}

function identity(productUrl) {
  let url; try { url = new URL(productUrl); } catch { throw new ShoppingReadError('PRODUCT_URL_INPUT'); }
  if (url.origin !== 'https://itempage3.auction.co.kr' || url.pathname !== '/DetailView.aspx' || url.username || url.password) throw new ShoppingReadError('PRODUCT_URL_SCOPE');
  const itemNo = [...url.searchParams].find(([key]) => key.toLowerCase() === 'itemno')?.[1];
  if (!/^[A-Z0-9]+$/.test(itemNo ?? '')) throw new ShoppingReadError('PRODUCT_ID_INPUT');
  return { itemNo, productUrl: 'https://itempage3.auction.co.kr/DetailView.aspx?itemno=' + itemNo };
}

export async function readAuctionPhotoReviews({ productUrl, maxPages = 1, fetchImpl = globalThis.fetch } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 25) throw new ShoppingReadError('PAGE_LIMIT_INPUT');
  const product = identity(productUrl);
  const reviews = []; const receipts = []; const seen = new Set(); let duplicateCount = 0;
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(apiPath, apiOrigin);
    url.searchParams.set('ItemNo', product.itemNo); url.searchParams.set('PageIndex', String(page));
    let response;
    try { response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000),
      headers: { accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' } }); }
    catch { throw new ShoppingReadError('TRANSPORT_FAILED'); }
    const chunks = []; let bytes = 0;
    if (response.body) for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new ShoppingReadError('RESPONSE_SIZE'); chunks.push(chunk); }
    const html = Buffer.concat(chunks).toString('utf8');
    const receipt = { checkedAt: new Date().toISOString(), path: apiPath, page, status: response.status,
      contentType: response.headers.get('content-type') ?? '', bytes, browserUsed: false, credentialsUsed: false };
    if (response.headers.get('cf-mitigated') === 'challenge' || /challenge-platform|<title>\s*Just a moment/i.test(html)) throw new ShoppingReadError('SITE_CHALLENGE', { ...receipt, retry: false });
    if (response.status !== 200) throw new ShoppingReadError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_REJECTED', { ...receipt, retryAfter: response.headers.get('retry-after'), retry: false });
    if (!/text\/html/i.test(receipt.contentType)) throw new ShoppingReadError('CONTENT_TYPE', receipt);
    const parsed = parseAuctionPhotoReviews(html, { page }); let added = 0;
    for (const review of parsed) {
      if (seen.has(review.reviewId)) { duplicateCount++; continue; }
      seen.add(review.reviewId); reviews.push(review); added++;
    }
    if (!added) throw new ShoppingReadError('PAGINATION_NO_PROGRESS');
    receipts.push({ ...receipt, returnedReviews: parsed.length });
  }
  return { source: 'auction', scope: 'photo_review_full_text', productUrl: product.productUrl, reviewCount: reviews.length, duplicateCount, reviews, receipts,
    pagination: { pagesRead: maxPages, totalPages: null, nextPageCandidate: maxPages + 1, complete: false, stopReason: 'page_budget', endOfListContract: 'not_observed' },
    browserUsed: false, executionMode: 'pure_http', credentialsUsed: false,
    state: { captured: true, client_exists: true, remnant_free: fetchImpl === globalThis.fetch, credential_propagated: 'not_required', live_replay: fetchImpl === globalThis.fetch },
    limitations: ['Photo reviews only; text-only reviews are outside this endpoint.', 'The endpoint pages photos, so review counts vary and adjacent pages may overlap.',
      'The page budget is not evidence of a complete review history; an empty-page contract is not verified.', 'Reviewer identifiers and profiles are excluded. Review IDs identify public reviews, not reviewers.'] };
}
