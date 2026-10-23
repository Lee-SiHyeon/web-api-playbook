import { createHash } from 'node:crypto';
import { parse } from 'parse5';

export const MODETOUR_DOCUMENT_URL = 'https://www.modetour.com/package/overseas';
const QUERY_KEY = 'getPackageGetRecommendedProduct({"theme":"Package"})';
const MAX_BYTES = 2 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const cleanText = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const hash = value => createHash('sha256').update(value).digest('hex');

function* walk(node) {
  yield node;
  for (const child of node.childNodes ?? []) yield* walk(child);
  if (node.content) yield* walk(node.content);
}

/** Parse inert JSON from the observed Document response. Never execute its scripts. */
export function parseModetourDocument(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) throw fail('DOCUMENT_BODY_INVALID');
  const scripts = [...walk(parse(html))].filter(node => node.tagName === 'script'
    && node.attrs?.some(attr => attr.name === 'id' && attr.value === '__NEXT_DATA__')
    && node.attrs?.some(attr => attr.name === 'type' && attr.value === 'application/json'));
  if (scripts.length !== 1) throw fail('HTML_LAYOUT_CHANGED');
  let data;
  try { data = JSON.parse(scripts[0].childNodes.map(node => node.value ?? '').join('')); }
  catch { throw fail('DOCUMENT_JSON_INVALID'); }
  if (data.page !== '/package/overseas') throw fail('HTML_LAYOUT_CHANGED');
  const payload = data.props?.pageProps?.initialState?.api?.queries?.[QUERY_KEY]?.data;
  const rows = payload?.result?.package;
  if (payload?.isOK !== true || !Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw fail('HTML_LAYOUT_CHANGED');
  }
  const items = rows.map(row => {
    const master = row?.productMaster;
    const title = cleanText(row?.productsName);
    const id = row?.masterCodeNo ?? master?.masterCodeNo;
    if (!title || !/^\d{1,12}$/.test(String(id ?? '')) || amount(row?.price) === null) {
      throw fail('DOCUMENT_PRODUCT_SCHEMA_CHANGED');
    }
    // Deliberate projection: unrelated Redux state, credentials, cookies and context never leave this parser.
    return {
      sellerProductId: String(id),
      displayTitle: title,
      productMasterTitle: cleanText(master?.masterProductName) || null,
      summaryAmount: amount(row.price),
      productMasterAmount: amount(master?.price),
      currency: cleanText(row.currency ?? row.currencyCode ?? row.priceCurrency) || null,
      quotedBasis: cleanText(row.quotedBasis ?? row.priceBasis ?? row.basis) || null,
    };
  });
  if (new Set(items.map(item => item.sellerProductId)).size !== items.length) {
    throw fail('DOCUMENT_DUPLICATE_PRODUCT');
  }
  const selectors = ['script#__NEXT_DATA__[type="application/json"]'];
  const fields = ['page', 'props.pageProps.initialState.api.queries', QUERY_KEY, 'data.isOK', 'data.result.package',
    'productsName', 'masterCodeNo', 'price'];
  return {
    items,
    fingerprint: { selectors, fields, sha256: hash(JSON.stringify({ selectors, fields })) },
    source: { resourceType: 'Document', representation: 'html_embedded_json', scriptId: '__NEXT_DATA__', queryKey: QUERY_KEY },
    coverage: { initialRecommendationCount: items.length, snapshotComplete: false,
      scope: 'Initial recommendation feed only; other landing-page sections, pagination, options and date-specific inventory are not collected.' },
  };
}

async function readBounded(response) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) {
    await response.body?.cancel();
    throw fail('DOCUMENT_BODY_TOO_LARGE');
  }
  if (!response.body?.getReader) throw fail('DOCUMENT_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw fail('DOCUMENT_BODY_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

/** One anonymous, no-redirect HTTP GET. No browser, cookie jar, SDK header or file capture. */
export async function collectModetourDocument({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const response = await fetchImpl(MODETOUR_DOCUMENT_URL, {
    method: 'GET', redirect: 'manual', credentials: 'omit',
    headers: { accept: 'text/html,application/xhtml+xml;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw fail(`DOCUMENT_HTTP_${response.status}`);
  }
  const mime = response.headers.get('content-type') ?? '';
  if (!/^text\/html(?:;|$)/i.test(mime)) {
    await response.body?.cancel();
    throw fail('DOCUMENT_CONTENT_TYPE_INVALID');
  }
  const bytes = await readBounded(response);
  return {
    ...parseModetourDocument(bytes.toString('utf8')),
    request: { method: 'GET', url: MODETOUR_DOCUMENT_URL, requestHeaderNames: ['accept'] },
    response: { status: response.status, contentType: mime, bytes: bytes.length, sha256: hash(bytes) },
    checkedAt: new Date().toISOString(), executionMode: 'pure_http',
    browserUsed: false, rawDocumentPersisted: false, credentialsUsed: false,
  };
}

/** Match displayed feed titles and amounts, retaining detail amounts and unknown price semantics separately. */
export function compareModetourDocumentToBrowser(items, rendered) {
  if (!Array.isArray(rendered) || rendered.length !== items.length || items.length === 0) {
    return { ok: false, reason: 'CARD_COUNT_MISMATCH', documentCount: items.length, browserCount: rendered?.length ?? 0, matched: 0 };
  }
  const remaining = rendered.map(row => cleanText(row?.text));
  let matched = 0;
  for (const item of items) {
    const index = remaining.findIndex(text => text.includes(item.displayTitle)
      && Number(text.match(/([\d,]+)\s*원\s*~/)?.[1]?.replaceAll(',', '')) === item.summaryAmount);
    if (index < 0) continue;
    remaining.splice(index, 1);
    matched += 1;
  }
  return { ok: matched === items.length, reason: matched === items.length ? null : 'TITLE_OR_DISPLAY_AMOUNT_MISMATCH',
    documentCount: items.length, browserCount: rendered.length, matched };
}
