import { createAmazonPublicClient } from './amazon.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** A bounded search traversal. The checkpoint is data, never a background job. */
export async function crawlAmazonSearch({ query, maxPages = 3, checkpoint = null,
  client = createAmazonPublicClient() } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 120 || /[\u0000-\u001f\u007f]/.test(query)
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) fail('AMAZON_CRAWL_INPUT_INVALID');
  query = query.trim().replace(/\s+/g, ' ');
  if (checkpoint !== null && (checkpoint.schema !== 'amazon-search-checkpoint-v1'
    || checkpoint.query !== query || !Number.isInteger(checkpoint.nextPage)
    || checkpoint.nextPage < 1 || checkpoint.nextPage > 20
    || !Array.isArray(checkpoint.visitedPages) || checkpoint.visitedPages.length !== checkpoint.nextPage - 1
    || checkpoint.visitedPages.some((page, index) => page !== index + 1))) fail('AMAZON_CRAWL_CHECKPOINT_INVALID');
  let nextPage = checkpoint?.nextPage ?? 1;
  const visitedPages = [...(checkpoint?.visitedPages ?? [])]; const pages = [];
  const products = new Map(); let stopReason = 'request_budget'; let failure = null;
  let paginationTerminationVerified = false;
  for (let attempt = 0; attempt < maxPages; attempt++) {
    const requestedPage = nextPage;
    let result;
    try { result = await client.searchProducts({ query, page: requestedPage }); }
    catch (error) {
      failure = { page: requestedPage, code: /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'AMAZON_CRAWL_READ_FAILED',
        ...(Number.isInteger(error?.status) ? { status: error.status } : {}) };
      stopReason = 'read_failed'; break;
    }
    if (result.query !== query || result.page !== requestedPage || !Array.isArray(result.items)) fail('AMAZON_CRAWL_RESULT_MISMATCH');
    pages.push(result); visitedPages.push(requestedPage);
    for (const item of result.items) if (!products.has(item.asin)) products.set(item.asin, item);
    if (result.pagination?.terminationVerified === true && result.pagination.hasNext === false) {
      paginationTerminationVerified = true; nextPage = null; stopReason = 'explicit_next_disabled'; break;
    }
    if (result.pagination?.hasNext !== true || result.pagination.nextPage !== requestedPage + 1) {
      nextPage = null; stopReason = 'pagination_unobserved'; break;
    }
    nextPage = result.pagination.nextPage;
    if (nextPage > 20) { stopReason = 'client_page_limit'; break; }
  }
  return { query, pages, items: [...products.values()], failure, stopReason,
    pagesRead: pages.length, visitedPages, nextPage, paginationTerminationVerified,
    wholeQueryMainCardsComplete: checkpoint === null && paginationTerminationVerified
      && pages.every(p => p.mainResultFrameCountMatched === true),
    completeCatalog: false, browserUsed: false, credentialsUsed: false, executionMode: 'pure_http',
    checkpoint: nextPage === null ? null : { schema: 'amazon-search-checkpoint-v1', query, nextPage, visitedPages },
    checkpointIsBackgroundJob: false };
}
