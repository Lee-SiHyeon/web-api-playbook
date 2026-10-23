import { parseFragment } from 'parse5';
import { readPublicPage, readPublicResource, textContent } from '../../lib/cps-public-reader.mjs';
import { observedNumber, observedCount } from '../../lib/cps-values.mjs';
import { readPulmuoneReviews } from './pulmuone-reviews.mjs';

const SITE = 'https://shop.pulmuone.co.kr/';
const descendants = (node, predicate, output = []) => {
  if (predicate(node)) output.push(node);
  for (const child of node.childNodes ?? []) descendants(child, predicate, output);
  return output;
};
const attr = (node, key) => node.attrs?.find(row => row.name === key)?.value ?? null;
const clean = value => typeof value === 'string' && value.trim() ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500) : null;

/** Nuxt devalue scalar references are data indexes, never executable JavaScript. */
export function parsePulmuoneHome(html, receipt) {
  const root = parseFragment(html);
  const script = descendants(root, node => node.tagName === 'script' && attr(node, 'id') === '__NUXT_DATA__')[0];
  if (!script) return { records: [], nodeCount: 0, candidateCount: 0, currencyEvidence: null };
  const source = (script.childNodes ?? []).map(node => node.value ?? '').join('');
  if (Buffer.byteLength(source) > 7 * 1024 * 1024) throw new Error('PULMUONE_PAYLOAD_TOO_LARGE');
  const nodes = JSON.parse(source);
  if (!Array.isArray(nodes)) throw new Error('PULMUONE_NUXT_FLAT_ARRAY_REQUIRED');
  const scalar = index => {
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length) return null;
    const value = nodes[index];
    return ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
  };
  const visibleText = textContent(root, 150000) ?? '';
  const displayedWon = /\b([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,})\s*원(?=\s|$|[.,()·])/.exec(visibleText);
  const currencyEvidence = displayedWon ? { locator: 'visible document text: number followed by 원', text: displayedWon[0], currency: 'KRW' } : null;
  const byId = new Map();
  let candidateCount = 0;
  for (const [index, row] of nodes.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || (!('goodsId' in row) && !('ilGoodsId' in row)) || !('goodsName' in row) || !('salePrice' in row)) continue;
    candidateCount += 1;
    const id = scalar(row.goodsId ?? row.ilGoodsId);
    const title = clean(scalar(row.goodsName));
    if ((typeof id !== 'number' && typeof id !== 'string') || !title || byId.has(String(id))) continue;
    const amount = observedNumber(scalar(row.salePrice));
    const listAmount = observedNumber(scalar(row.recommendedPrice));
    const rawScore = observedNumber(scalar(row.satisfactionScore));
    const satisfactionCount = observedCount(scalar(row.satisfactionCount));
    const value = rawScore === 0 && !(satisfactionCount > 0) ? null : rawScore;
    const brand = clean(scalar(row.brandName));
    const description = clean(scalar(row.goodsDescription));
    const fields = ['type', 'sourceLocalId', 'title'];
    if (amount !== null) fields.push('price');
    if (value !== null || satisfactionCount !== null) fields.push('rating');
    if (brand) fields.push('brand');
    if (description) fields.push('description');
    byId.set(String(id), {
      type: 'RetailProduct', sourceLocalId: String(id), title, url: null, sourcePageUrl: SITE,
      brand, description,
      price: amount === null ? null : { amount, currency: currencyEvidence?.currency ?? null, priceText: String(amount), listAmount,
        priceKind: 'displayed_catalog_sale', condition: 'Public salePrice; employeeDiscountPrice is excluded.',
        qualifiers: { currencyBasis: currencyEvidence?.text ?? null, rawStatusCode: clean(scalar(row.statusCode)), inventoryQuantityObserved: false } },
      rating: value === null && satisfactionCount === null ? null : { value, best: null, worst: null, reviewCount: null, ratingCount: null,
        sourceMetrics: { satisfactionCount, countMeaning: 'source satisfactionCount; review-versus-rating semantics unverified' } },
      variants: [], reviewSamples: [],
      retrievalContext: { type: 'homepage_inventory_payload', queryApplied: false, nodeIndex: index },
      evidence: [{ receiptId: receipt.id, locator: `script#__NUXT_DATA__[${index}]; each field dereferenced through payload[fieldIndex]`, fields },
        ...(currencyEvidence ? [{ receiptId: receipt.id, locator: currencyEvidence.locator, fields: ['price.currency'], value: currencyEvidence.text }] : [])],
    });
  }
  return { records: [...byId.values()], nodeCount: nodes.length, candidateCount, currencyEvidence };
}

export async function readPulmuoneProduct(goodsId) {
  if (!/^\d{1,12}$/.test(String(goodsId))) throw new Error('PULMUONE_GOODS_ID_INVALID');
  // Observed in the page-linked useGoodsViewSEO module and replayed for goods 39271.
  const url = new URL(`/shop/goodsView/${goodsId}`, SITE).href;
  const page = await readPublicPage(url, { allowedHosts: ['shop.pulmuone.co.kr'] });
  const parsed = page.ok ? parsePulmuoneHome(page.html, page.receipt) : { records: [] };
  const records = parsed.records.filter(record => record.sourceLocalId === String(goodsId)).map(record => ({
    ...record, url, sourcePageUrl: url, retrievalContext: { type: 'product_detail_payload', queryApplied: false },
    evidence: record.evidence.map(evidence => ({ ...evidence, fields: [...evidence.fields, 'url'] })),
  }));
  return { merchantId: 'pulmuone', siteUrl: SITE, checkedAt: new Date().toISOString(), receipts: page.receipt ? [page.receipt] : [], records,
    contracts: [{ operation: 'product_detail', method: 'GET', url, receiptId: page.receipt?.id ?? null, state: records.length ? 'live_replay_verified' : page.stopReason ?? 'identity_not_found' }],
    operations: { product_detail: { liveReplay: records.length > 0, browserRequired: false, credentialsRequired: false } },
    frontier: [{ operation: 'reviews', state: 'review_list_contract_not_replayed' }], status: records.length ? 'verified_public_product_detail' : page.stopReason ?? 'detail_without_matching_record' };
}

export function attachPulmuoneReviews(report, goodsId, result) {
  const record = report.records.find(value => value.sourceLocalId === String(goodsId));
  if (!record) throw new Error('PULMUONE_REVIEW_PRODUCT_NOT_IN_REPORT');
  if (Date.parse(result.checkedAt) > Date.parse(report.checkedAt ?? '1970-01-01')) report.checkedAt = result.checkedAt;
  const seen = new Set(report.receipts.map(receipt => receipt.id ?? receipt.receiptId));
  for (const receipt of result.receipts ?? []) if (!seen.has(receipt.id ?? receipt.receiptId)) report.receipts.push(receipt);
  report.contracts.push(...(result.contracts ?? []));
  report.operations.reviews = result.operations?.reviews ?? { state: result.state };
  report.frontier = report.frontier.filter(row => row.operation !== 'reviews');
  if (result.state === 'live_replay_verified') {
    record.reviewSamples = result.reviewSamples;
    record.evidence.push({ receiptId: result.fieldProof.receiptId,
      locator: 'data.dataList[] filtered by displayYn === Y; satisfactionScore/createDate/comment/image', fields: ['reviewSamples'] });
    report.frontier.push({ operation: 'reviews', state: 'first_review_page_observed', complete: false,
      goodsId: String(goodsId), page: result.page.page, total: result.page.total,
      nextPage: result.page.page * result.page.limit < result.page.total ? result.page.page + 1 : null });
  } else report.frontier.push({ operation: 'reviews', state: result.state, reason: result.stopReason });
  return report;
}

export async function collectPulmuone({ includeSampleDetail = true, includeSampleReviews = true } = {}) {
  const page = await readPublicPage(SITE, { allowedHosts: ['shop.pulmuone.co.kr'], maxBytes: 8 * 1024 * 1024 });
  const row = { merchantId: 'pulmuone', siteUrl: SITE, checkedAt: new Date().toISOString(), receipts: page.receipt ? [page.receipt] : [], records: [], contracts: [], operations: {}, frontier: [], status: page.stopReason ?? 'unavailable' };
  if (!page.ok) {
    row.frontier.push({ url: SITE, state: page.blocked ? 'stopped_at_host_block' : 'unavailable', reason: page.stopReason, retry: false });
    return row;
  }
  const parsed = parsePulmuoneHome(page.html, page.receipt);
  row.records = parsed.records;
  // Refresh field semantics only from module URLs linked by this exact page.
  const dom = parseFragment(page.html);
  const scriptUrl = descendants(dom, node => node.tagName === 'script' && attr(node, 'type') === 'module')
    .map(node => attr(node, 'src')).find(value => /^\/_nuxt\/entry\.[^/]+\.js$/.test(value ?? ''));
  if (scriptUrl) {
    const entry = await readPublicResource(new URL(scriptUrl, SITE).href, { allowedHosts: ['shop.pulmuone.co.kr'] });
    if (entry.receipt) row.receipts.push(entry.receipt);
    if (entry.ok) {
      const listModule = entry.body.match(/["'](\.\/GoodsListPage\.[^"'\s/]+\.js)["']/)?.[1];
      if (listModule) {
        const semanticsUrl = new URL(listModule, entry.url).href;
        const semantics = await readPublicResource(semanticsUrl, { allowedHosts: ['shop.pulmuone.co.kr'] });
        if (semantics.receipt) row.receipts.push(semantics.receipt);
        if (semantics.ok) {
          const hasKrw = /salePrice[\s\S]{0,300}priceCurrency\s*:\s*["']KRW["']/.test(semantics.body);
          const hasReviewCount = /reviewCount\s*:\s*Number\([^)]*\.satisfactionCount\)/.test(semantics.body);
          const hasBestFive = /bestRating\s*:\s*5/.test(semantics.body);
          for (const record of row.records) {
            const semanticFields = [];
            if (record.price && hasKrw) {
              record.price.currency = 'KRW';
              record.price.qualifiers.currencyBasis = 'Observed GoodsListPage schema.org mapping explicitly declares salePrice in KRW';
              semanticFields.push('price.currency');
            }
            if (record.rating && hasReviewCount) {
              record.rating.reviewCount = record.rating.sourceMetrics.satisfactionCount;
              record.rating.sourceMetrics.countMeaning = 'Observed source maps satisfactionCount to schema.org reviewCount';
              if (hasBestFive) record.rating.best = 5;
              semanticFields.push('rating.reviewCount', ...(hasBestFive ? ['rating.best'] : []));
            }
            if (semanticFields.length) record.evidence.push({ receiptId: semantics.receipt.id,
              locator: 'GoodsListPage public schema.org mapping of salePrice, priceCurrency and satisfactionCount', fields: semanticFields });
          }
          row.contracts.push({ operation: 'catalog_field_semantics', url: semanticsUrl, state: 'source_mapping_observed',
            receiptId: semantics.receipt.id, linkedFromReceiptId: entry.receipt.id, currencyKrwObserved: hasKrw, satisfactionCountIsReviewCount: hasReviewCount, bestRatingFiveObserved: hasBestFive });
        } else if (semantics.blocked) row.frontier.push({ operation: 'module_semantics', state: 'stopped_at_host_block', reason: semantics.stopReason });
      }
    } else if (entry.blocked) row.frontier.push({ operation: 'module_semantics', state: 'stopped_at_host_block', reason: entry.stopReason });
  }
  row.status = row.records.length ? 'verified_public_embedded_catalog' : 'reachable_without_offerings';
  row.contracts.push({ operation: 'homepage_nuxt_catalog', method: 'GET', url: SITE, receiptId: page.receipt.id,
    state: 'live_replay_verified', parser: 'nuxt_flat_scalar_reference', flatNodeCount: parsed.nodeCount,
    candidateCount: parsed.candidateCount, distinctGoods: row.records.length, currencyEvidence: parsed.currencyEvidence,
    scope: 'Homepage inventory samples; not an exhaustive catalog or query search.' });
  row.operations = {
    catalog_sample: { captured: true, client: 'adapters/cps-vendors/pulmuone.mjs', browserRequired: false, credentialsRequired: false, liveReplay: row.records.length > 0, recordCount: row.records.length },
    price: { state: row.records.some(record => record.price?.currency) ? 'live_replay_verified' : 'amount_observed_currency_unverified' },
    rating: { state: row.records.some(record => record.rating?.reviewCount != null) ? 'live_replay_verified' : row.records.some(record => record.rating) ? 'value_observed_count_semantics_unverified' : 'not_observed' },
    reviews: { state: 'not_captured', sampleCount: 0 },
  };
  row.frontier.push({ operation: 'detail', state: 'product_id_observed_detail_route_not_replayed' },
    { operation: 'reviews', state: 'public_review_list_contract_not_captured' },
    { operation: 'catalog_pagination', state: 'homepage_inventory_only_complete_catalog_not_established' });
  if (includeSampleDetail && row.records.length && !row.frontier.some(frontier => frontier.state === 'stopped_at_host_block')) {
    const detail = await readPulmuoneProduct(row.records[0].sourceLocalId);
    row.receipts.push(...detail.receipts);
    row.records.push(...detail.records);
    row.contracts.push(...detail.contracts);
    row.operations.product_detail = detail.operations.product_detail;
    if (detail.records.length) {
      row.frontier = row.frontier.filter(frontier => frontier.operation !== 'detail');
      row.frontier.push({ operation: 'detail', state: 'one_observed_id_replayed', complete: false });
    }
  }
  if (includeSampleReviews && row.records.length && !row.frontier.some(frontier => frontier.state === 'stopped_at_host_block')
    && !row.receipts.some(receipt => [401, 403, 418, 429].includes(receipt.responseStatus ?? receipt.httpStatus ?? receipt.status))) {
    const goodsId = row.records[0].sourceLocalId;
    attachPulmuoneReviews(row, goodsId, await readPulmuoneReviews(goodsId));
  }
  return row;
}
