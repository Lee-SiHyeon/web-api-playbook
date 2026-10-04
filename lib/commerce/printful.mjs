import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { commerceFail, commerceJsonRequest, validateAccessToken } from './http.mjs';

const SERVICE = 'printful';
const API_ORIGIN = 'https://api.printful.com';
const FEED_ORIGIN = 'https://www.printful.com';
const FEED_PATH = '/custom-products/export';
const ZIP_ORIGIN = 'https://printful.s3.us-west-1.amazonaws.com';
const ZIP_PATH = '/productExport/printful_products.zip';
const HELP_URL = 'https://help.printful.com/hc/en-us/articles/50263594032401-Can-I-download-a-list-of-all-Printful-products';
const PRODUCT_SOURCE_URL = 'https://developers.printful.com/docs/v2-beta/';
const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_CSV_BYTES = 6 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED = 20 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_VARIANTS = 500;
const REGION_FILES = Object.freeze({
  USA: 'USA_printful_products.csv',
  Europe: 'Europe_printful_products.csv',
  Australia: 'Australia_printful_products.csv',
  Japan: 'Japan_printful_products.csv',
  Canada: 'Canada_printful_products.csv',
  Brazil: 'Brazil_printful_products.csv',
  UK: 'UK_printful_products.csv',
  China: 'China_printful_products.csv',
});
const REGION_SET = new Set([
  'worldwide', 'north_america', 'canada', 'europe', 'spain', 'latvia', 'uk', 'france',
  'germany', 'australia', 'japan', 'new_zealand', 'italy', 'brazil', 'southeast_asia',
  'republic_of_korea', 'all',
]);
const CSV_HEADERS = [
  'Variant ID', 'Product Name', 'Product Type', 'Product Color', 'Product Size', 'Product Image',
  'Product Weight (oz)', 'Height (In)', 'Length (In)', 'Width (In)', 'Categories',
  'Product Price', 'Notes',
];
const DECIMAL_PRICE = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;
const DECIMAL_MEASUREMENT = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,3})?$/;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 1000) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const safeInt = value => Number.isSafeInteger(value) && value >= 0;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const validDecimal = value => typeof value === 'string' && DECIMAL_PRICE.test(value);
const validMeasurement = value => typeof value === 'string' && DECIMAL_MEASUREMENT.test(value);

export class PrintfulCatalogError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'PrintfulCatalogError';
    this.code = code;
    this.receipt = receipt;
  }
}

function fail(code, receipt) {
  throw new PrintfulCatalogError(code, receipt);
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

async function readBounded(response, limit, code, receipt) {
  if (!response.body?.getReader) fail(code, receipt);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        fail('PRINTFUL_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: total });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function receipt(service, capabilityId, request, provenance = PRODUCT_SOURCE_URL) {
  return {
    schema: 'web-api-credentialed-read-receipt-v1',
    service,
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    authenticated: true,
    credentialsUsed: true,
    credentialBindingVerified: true,
    schemaVerified: true,
    expectedResultVerified: true,
    credentialBinding: {
      source: 'process-memory',
      serviceMatched: true,
      originMatched: true,
      persisted: false,
    },
    contractProvenance: { kind: 'first_party_documented_api', sourceURL: provenance },
    request,
  };
}

async function fetchCatalogZip(fetchImpl, now) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('PRINTFUL_CLIENT_INVALID');
  const checkedAt = new Date(now()).toISOString();
  const redirectRequestBase = {
    method: 'GET', origin: FEED_ORIGIN, path: FEED_PATH, checkedAt,
    browserUsed: false, anonymous: true, credentialsUsed: false, cookieSent: false,
  };
  let redirectResponse;
  try {
    redirectResponse = await fetchImpl(new URL(FEED_PATH, FEED_ORIGIN), {
      method: 'GET',
      headers: { accept: 'application/zip' },
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    fail('PRINTFUL_FEED_TRANSPORT_FAILED', {
      ...redirectRequestBase,
      causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
    });
  }
  const firstReceipt = {
    ...redirectRequestBase,
    httpStatus: redirectResponse.status,
    mime: mimeOf(redirectResponse),
  };
  const location = redirectResponse.headers?.get?.('location');
  if (redirectResponse.status !== 302 || !location) {
    await redirectResponse.body?.cancel().catch(() => {});
    fail('PRINTFUL_FEED_REDIRECT_INVALID', { ...firstReceipt, redirectFollowed: false });
  }
  let target;
  try { target = new URL(location, FEED_ORIGIN); }
  catch { fail('PRINTFUL_FEED_REDIRECT_INVALID', { ...firstReceipt, redirectFollowed: false }); }
  if (target.origin !== ZIP_ORIGIN || target.pathname !== ZIP_PATH || target.search || target.hash ||
      target.username || target.password) {
    await redirectResponse.body?.cancel().catch(() => {});
    fail('PRINTFUL_FEED_REDIRECT_INVALID', { ...firstReceipt, redirectFollowed: false });
  }
  await redirectResponse.body?.cancel().catch(() => {});
  const zipRequestBase = {
    method: 'GET', origin: ZIP_ORIGIN, path: ZIP_PATH, checkedAt,
    browserUsed: false, anonymous: true, credentialsUsed: false, cookieSent: false,
  };
  let zipResponse;
  try {
    zipResponse = await fetchImpl(target, {
      method: 'GET',
      headers: { accept: 'application/zip' },
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    fail('PRINTFUL_FEED_TRANSPORT_FAILED', {
      ...zipRequestBase,
      causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
    });
  }
  const zipReceipt = { ...zipRequestBase, httpStatus: zipResponse.status, mime: mimeOf(zipResponse) };
  if (zipResponse.status !== 200 || zipResponse.redirected || zipReceipt.mime !== 'application/zip') {
    await zipResponse.body?.cancel().catch(() => {});
    fail('PRINTFUL_FEED_RESPONSE_INVALID', { ...zipReceipt, redirectFollowed: false });
  }
  const archive = await readBounded(zipResponse, MAX_ZIP_BYTES, 'PRINTFUL_FEED_BODY_UNREADABLE', zipReceipt);
  if (archive.length < 22 || archive.subarray(0, 2).toString('hex') !== '504b') {
    fail('PRINTFUL_FEED_ARCHIVE_INVALID', { ...zipReceipt, responseBytes: archive.length });
  }
  return {
    archive,
    checkedAt,
    redirectRequest: firstReceipt,
    request: {
      ...zipReceipt,
      responseBytes: archive.length,
      responseSha256: createHash('sha256').update(archive).digest('hex'),
      ...(zipResponse.headers?.get?.('last-modified')
        ? { lastModified: zipResponse.headers.get('last-modified') } : {}),
    },
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findZipDirectory(bytes) {
  const min = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function unzipCsvEntries(archive) {
  const eocd = findZipDirectory(archive);
  if (eocd < 0 || eocd + 22 > archive.length) fail('PRINTFUL_FEED_ARCHIVE_INVALID');
  const disk = archive.readUInt16LE(eocd + 4);
  const directoryDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries ||
      totalEntries !== Object.keys(REGION_FILES).length || directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff || directoryOffset + directorySize > eocd ||
      eocd + 22 + commentLength > archive.length) fail('PRINTFUL_FEED_ARCHIVE_UNSUPPORTED');
  const wanted = new Set(Object.values(REGION_FILES));
  const output = new Map();
  let offset = directoryOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      fail('PRINTFUL_FEED_ARCHIVE_INVALID');
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const noteLength = archive.readUInt16LE(offset + 32);
    const startDisk = archive.readUInt16LE(offset + 34);
    const localOffset = archive.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + noteLength;
    if (recordEnd > archive.length || startDisk !== 0 || compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff || localOffset === 0xffffffff || flags & 1 ||
        flags & 0x40 || ![0, 8].includes(method)) fail('PRINTFUL_FEED_ARCHIVE_UNSUPPORTED');
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!wanted.has(name) || output.has(name)) fail('PRINTFUL_FEED_ARCHIVE_SCHEMA_INVALID');
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > MAX_CSV_BYTES || totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED ||
        localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      fail('PRINTFUL_FEED_ARCHIVE_INVALID');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    const contentEnd = contentStart + compressedSize;
    if (contentEnd > archive.length) fail('PRINTFUL_FEED_ARCHIVE_INVALID');
    const compressed = archive.subarray(contentStart, contentEnd);
    let uncompressed;
    try {
      uncompressed = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_CSV_BYTES });
    } catch {
      fail('PRINTFUL_FEED_ARCHIVE_INVALID');
    }
    if (uncompressed.length !== uncompressedSize || crc32(uncompressed) !== checksum) {
      fail('PRINTFUL_FEED_ARCHIVE_CHECKSUM_INVALID');
    }
    output.set(name, uncompressed);
    offset = recordEnd;
  }
  if (offset !== directoryOffset + directorySize || output.size !== wanted.size) {
    fail('PRINTFUL_FEED_ARCHIVE_SCHEMA_INVALID');
  }
  return output;
}

function parseCsv(textValue) {
  if (typeof textValue !== 'string' || Buffer.byteLength(textValue, 'utf8') > MAX_CSV_BYTES) {
    fail('PRINTFUL_FEED_CSV_INVALID');
  }
  const source = textValue.charCodeAt(0) === 0xfeff ? textValue.slice(1) : textValue;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') {
      if (field !== '') fail('PRINTFUL_FEED_CSV_INVALID');
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(cell => cell !== '') || rows.length > 0) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) fail('PRINTFUL_FEED_CSV_TOO_MANY_ROWS');
    } else field += char;
    if (field.length > 20_000) fail('PRINTFUL_FEED_CSV_FIELD_TOO_LARGE');
  }
  if (quoted) fail('PRINTFUL_FEED_CSV_INVALID');
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some(cell => cell !== '')) rows.push(row);
  }
  if (rows.length < 1 || rows.length > MAX_ROWS + 1) fail('PRINTFUL_FEED_CSV_INVALID');
  return rows;
}

function parseRegionalPrice(display, region) {
  if (!display) return null;
  const patterns = [
    [/^\$\s*(\d+(?:\.\d{1,2})?)$/, region === 'USA' ? 'USD' : null, '$'],
    [/^AU\$\s*(\d+(?:\.\d{1,2})?)$/, 'AUD', 'AU$'],
    [/^C\$\s*(\d+(?:\.\d{1,2})?)$/, 'CAD', 'C$'],
    [/^R\$\s*(\d+(?:\.\d{1,2})?)$/, 'BRL', 'R$'],
    [/^€\s*(\d+(?:\.\d{1,2})?)$/, 'EUR', '€'],
    [/^£\s*(\d+(?:\.\d{1,2})?)$/, 'GBP', '£'],
    [/^¥\s*(\d+(?:\.\d{1,2})?)$/, 'JPY', '¥'],
  ];
  for (const [pattern, currency, marker] of patterns) {
    const match = pattern.exec(display);
    if (match) return {
      display,
      amount: validDecimal(match[1]) ? match[1] : null,
      currency,
      currencyMarker: marker,
      currencyVerified: currency !== null,
      role: 'regional supplier base product price',
      shippingIncluded: false,
    };
  }
  return {
    display,
    amount: null,
    currency: null,
    currencyMarker: null,
    currencyVerified: false,
    role: 'regional supplier product price; currency marker not mapped',
    shippingIncluded: false,
  };
}

function safeImageUrl(value) {
  if (!text(value, 3000)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.toString() : null;
  } catch { return null; }
}

export function parsePrintfulCatalogCsv(csvText, region) {
  if (!Object.hasOwn(REGION_FILES, region)) fail('PRINTFUL_FEED_REGION_INVALID');
  const rows = parseCsv(csvText);
  if (JSON.stringify(rows[0]) !== JSON.stringify(CSV_HEADERS)) fail('PRINTFUL_FEED_CSV_SCHEMA_INVALID');
  const products = [];
  for (const row of rows.slice(1)) {
    if (row.length !== CSV_HEADERS.length || !/^\d+$/.test(row[0]) || row[0].length > 24 ||
        !text(row[1], 500) || !text(row[2], 200)) fail('PRINTFUL_FEED_CSV_ROW_INVALID');
    const imageUrl = row[5] === '' ? null : safeImageUrl(row[5]);
    if (row[5] !== '' && !imageUrl) fail('PRINTFUL_FEED_CSV_IMAGE_INVALID');
    const dimension = value => value === '' ? null : validMeasurement(value) ? value : null;
    for (const [value, label] of [[row[6], 'weight'], [row[7], 'height'], [row[8], 'length'], [row[9], 'width']]) {
      if (value !== '' && !validMeasurement(value)) fail(`PRINTFUL_FEED_CSV_${label.toUpperCase()}_INVALID`);
    }
    products.push({
      variantId: Number(row[0]),
      title: row[1],
      type: row[2],
      color: row[3] || null,
      size: row[4] || null,
      imageUrl,
      weightOz: dimension(row[6]),
      dimensionsInches: { height: dimension(row[7]), length: dimension(row[8]), width: dimension(row[9]) },
      categories: row[10] || null,
      productPrice: parseRegionalPrice(row[11], region),
      notes: row[12] || null,
    });
    if (products.length > MAX_ROWS) fail('PRINTFUL_FEED_CSV_TOO_MANY_ROWS');
  }
  if (products.length < 1) fail('PRINTFUL_FEED_CSV_EMPTY');
  return products;
}

function parseFeedArchive(archive, region) {
  if (!Object.hasOwn(REGION_FILES, region)) fail('PRINTFUL_FEED_REGION_INVALID');
  const entries = unzipCsvEntries(archive);
  const csv = entries.get(REGION_FILES[region]);
  if (!csv) fail('PRINTFUL_FEED_REGION_MISSING');
  return parsePrintfulCatalogCsv(csv.toString('utf8'), region);
}

function publicFeedReceipt(feed, regions) {
  const currencyByRegion = {
    USA: 'USD', Europe: 'EUR', Australia: 'AUD', Japan: 'JPY',
    Canada: 'CAD', Brazil: 'BRL', UK: 'GBP', China: null,
  };
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: SERVICE,
    capabilityId: 'catalog.public_price_feed',
    checkedAt: feed.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified: true,
    contractProvenance: { kind: 'first_party_documented_feed', sourceURL: HELP_URL },
    request: feed.request,
    redirectRequest: feed.redirectRequest,
    regions: regions.map(region => ({ region, priceCurrency: currencyByRegion[region] })),
    priceRole: 'regional supplier base product price; shipping and taxes are separate',
  };
}

function publicFeedRegion(region, products, sourceLastModified) {
  const currencyByRegion = {
    USA: 'USD', Europe: 'EUR', Australia: 'AUD', Japan: 'JPY',
    Canada: 'CAD', Brazil: 'BRL', UK: 'GBP', China: null,
  };
  return {
    region,
    productCount: products.length,
    priceCurrency: currencyByRegion[region],
    sourceLastModified,
    products,
  };
}

function normalizeProduct(item, expectedId) {
  if (!object(item) || item.id !== expectedId || !text(item.name, 500) || !text(item.type, 200) ||
      item.brand != null && !text(item.brand, 300) || item.model != null && !text(item.model, 300) ||
      !Number.isSafeInteger(item.variant_count) ||
      item.variant_count < 0 || typeof item.is_discontinued !== 'boolean') {
    fail('PRINTFUL_PRODUCT_SCHEMA_INVALID');
  }
  return {
    productId: item.id,
    title: item.name,
    type: item.type,
    brand: item.brand ?? null,
    model: item.model ?? null,
    variantCount: item.variant_count,
    discontinued: item.is_discontinued,
    imageUrl: safeImageUrl(item.image),
    categories: Array.isArray(item.categories) ? item.categories : [],
  };
}

function validatePaging(payload, requestedLimit, requestedOffset) {
  if (!object(payload?.paging) || !safeInt(payload.paging.total) ||
      payload.paging.limit !== requestedLimit || payload.paging.offset !== requestedOffset) {
    fail('PRINTFUL_PAGING_SCHEMA_INVALID');
  }
  return payload.paging;
}

function validateCurrency(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function normalizePrices(data, currency) {
  if (!object(data) || data.currency !== currency || !object(data.product) ||
      !Array.isArray(data.product.placements) || !Array.isArray(data.variants)) {
    fail('PRINTFUL_PRICE_SCHEMA_INVALID');
  }
  const placements = data.product.placements.map(item => {
    if (!object(item) || !text(item.id, 100) || !text(item.technique_key, 100) ||
        !validDecimal(item.price) || !validDecimal(item.discounted_price)) {
      fail('PRINTFUL_PRICE_SCHEMA_INVALID');
    }
    return {
      placementId: item.id,
      title: typeof item.title === 'string' ? item.title : null,
      technique: item.technique_key,
      price: { amount: item.price, currency, role: 'production base/placement cost' },
      discountedPrice: { amount: item.discounted_price, currency, role: 'first placement discount when applicable' },
      options: Array.isArray(item.placement_options) ? item.placement_options : [],
      layers: Array.isArray(item.layers) ? item.layers : [],
    };
  });
  const variants = data.variants.map(item => {
    if (!object(item) || !positiveId(item.id) || !Array.isArray(item.techniques)) fail('PRINTFUL_PRICE_SCHEMA_INVALID');
    return {
      variantId: item.id,
      techniques: item.techniques.map(technique => {
        if (!object(technique) || !text(technique.technique_key, 100) ||
            !validDecimal(technique.price) || !validDecimal(technique.discounted_price)) {
          fail('PRINTFUL_PRICE_SCHEMA_INVALID');
        }
        return {
          technique: technique.technique_key,
          displayName: typeof technique.technique_display_name === 'string' ? technique.technique_display_name : null,
          price: { amount: technique.price, currency, role: 'production base cost by variant/technique' },
          discountedPrice: { amount: technique.discounted_price, currency, role: 'discounted production price' },
        };
      }),
    };
  });
  return { currency, placements, variants, discountTiers: Array.isArray(data.discount_tiers) ? data.discount_tiers : [] };
}

/**
 * Printful v2 catalog API methods require an OAuth token at call time through
 * the in-memory factory argument. The official regional catalog feed is public
 * and works without a token, but is a ZIP/CSV feed rather than an XHR API.
 */
export function createPrintfulCatalogClient({
  accessToken,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxResponseBytes = 4 * 1024 * 1024,
} = {}) {
  if (accessToken !== undefined && accessToken !== null) validateAccessToken(SERVICE, accessToken);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('PRINTFUL_CLIENT_INVALID');

  async function api(path, { query = [] } = {}) {
    const token = validateAccessToken(SERVICE, accessToken);
    const result = await commerceJsonRequest({
      service: SERVICE,
      origin: API_ORIGIN,
      path,
      query,
      accessToken: token,
      authHeader: 'Authorization',
      userAgent: 'web-api-playbook supplier catalog read client',
      fetchImpl,
      now,
      maxBytes: maxResponseBytes,
    });
    return result;
  }

  return {
    async listProducts({ limit = 20, offset = 0, categoryIds = [], colors = [], sellingRegionName = 'worldwide' } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !safeInt(offset) || offset > 1_000_000 ||
          !Array.isArray(categoryIds) || categoryIds.length > 20 || categoryIds.some(id => !positiveId(id)) ||
          !Array.isArray(colors) || colors.length > 20 || colors.some(color => !text(color, 80)) ||
          !REGION_SET.has(sellingRegionName)) fail('PRINTFUL_LIST_ARGUMENT_INVALID');
      const query = [['limit', String(limit)], ['offset', String(offset)], ['selling_region_name', sellingRegionName]];
      if (categoryIds.length) query.push(['category_ids', categoryIds.join(',')]);
      if (colors.length) query.push(['colors', colors.join(',')]);
      const result = await api('/v2/catalog-products', { query });
      const payload = result.payload;
      if (!Array.isArray(payload?.data) || payload.data.length > limit) fail('PRINTFUL_PRODUCT_LIST_SCHEMA_INVALID', result.request);
      const paging = validatePaging(payload, limit, offset);
      const products = payload.data.map(item => {
        if (!object(item) || !positiveId(item.id) || !text(item.name, 500) || !text(item.type, 200) ||
            item.brand != null && !text(item.brand, 300) || item.model != null && !text(item.model, 300) ||
            !Number.isSafeInteger(item.variant_count) || item.variant_count < 0 ||
            typeof item.is_discontinued !== 'boolean') fail('PRINTFUL_PRODUCT_LIST_SCHEMA_INVALID', result.request);
        return {
          productId: item.id,
          title: item.name,
          type: item.type,
          brand: item.brand ?? null,
          model: typeof item.model === 'string' ? item.model : null,
          variantCount: item.variant_count,
          discontinued: item.is_discontinued,
          imageUrl: safeImageUrl(item.image),
          categories: Array.isArray(item.categories) ? item.categories : [],
        };
      });
      return {
        service: SERVICE,
        products,
        pagination: paging,
        sellingRegionName,
        receipt: receipt(SERVICE, 'catalog.search', result.request),
      };
    },

    async getProduct({ productId } = {}) {
      if (!positiveId(productId)) fail('PRINTFUL_PRODUCT_ID_INVALID');
      const result = await api(`/v2/catalog-products/${productId}`);
      const product = normalizeProduct(result.payload?.data, productId);
      return {
        service: SERVICE,
        product,
        receipt: receipt(SERVICE, 'catalog.product_detail', result.request),
      };
    },

    async listVariants({ productId, limit = 20, offset = 0 } = {}) {
      if (!positiveId(productId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
          !safeInt(offset) || offset > 1_000_000) fail('PRINTFUL_VARIANTS_ARGUMENT_INVALID');
      const result = await api(`/v2/catalog-products/${productId}/catalog-variants`, {
        query: [['limit', String(limit)], ['offset', String(offset)]],
      });
      const payload = result.payload;
      if (!Array.isArray(payload?.data) || payload.data.length > limit) fail('PRINTFUL_VARIANTS_SCHEMA_INVALID', result.request);
      const paging = validatePaging(payload, limit, offset);
      const variants = payload.data.map(item => {
        if (!object(item) || !positiveId(item.id) || item.catalog_product_id !== productId ||
            !text(item.name, 500)) fail('PRINTFUL_VARIANTS_SCHEMA_INVALID', result.request);
        return {
          variantId: item.id,
          productId: item.catalog_product_id,
          title: item.name,
          size: typeof item.size === 'string' ? item.size : null,
          color: typeof item.color === 'string' ? item.color : null,
          colorCode: typeof item.color_code === 'string' ? item.color_code : null,
          imageUrl: safeImageUrl(item.image),
          availability: item.availability ?? null,
        };
      });
      return {
        service: SERVICE,
        productId,
        variants,
        pagination: paging,
        receipt: receipt(SERVICE, 'catalog.variants', result.request),
      };
    },

    async getProductPrices({ productId, limit = 20, offset = 0, currency = 'USD',
      productionCurrency = 'USD', sellingRegionName = 'worldwide' } = {}) {
      if (!positiveId(productId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
          !safeInt(offset) || offset > 1_000_000 || !validateCurrency(currency) ||
          !validateCurrency(productionCurrency) || !REGION_SET.has(sellingRegionName)) {
        fail('PRINTFUL_PRICES_ARGUMENT_INVALID');
      }
      const query = [
        ['limit', String(limit)], ['offset', String(offset)],
        ['currency', currency], ['production_currency', productionCurrency],
        ['selling_region_name', sellingRegionName],
      ];
      const result = await api(`/v2/catalog-products/${productId}/prices`, { query });
      const payload = result.payload;
      const paging = validatePaging(payload, limit, offset);
      const data = payload?.data;
      if (!object(data) || !object(data.product) || data.product.id !== productId ||
          !validateCurrency(data.currency)) fail('PRINTFUL_PRICES_SCHEMA_INVALID', result.request);
      const prices = normalizePrices(data, currency);
      return {
        service: SERVICE,
        productId,
        prices: {
          ...prices,
          sellingRegionName,
          productionCurrency,
          currency,
          priceRole: 'Printful production/base cost; technique, variant, placement and quantity affect final price',
          shippingIncluded: false,
          taxesIncluded: false,
        },
        pagination: paging,
        receipt: receipt(SERVICE, 'catalog.product_prices', result.request),
      };
    },

    async listCategories({ limit = 20, offset = 0 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !safeInt(offset) || offset > 1_000_000) {
        fail('PRINTFUL_CATEGORIES_ARGUMENT_INVALID');
      }
      const result = await api('/v2/catalog-categories', {
        query: [['limit', String(limit)], ['offset', String(offset)]],
      });
      const payload = result.payload;
      if (!Array.isArray(payload?.data) || payload.data.length > limit) fail('PRINTFUL_CATEGORIES_SCHEMA_INVALID', result.request);
      const pagination = validatePaging(payload, limit, offset);
      const categories = payload.data.map(item => {
        if (!object(item) || !positiveId(item.id) || !text(item.name, 300)) {
          fail('PRINTFUL_CATEGORIES_SCHEMA_INVALID', result.request);
        }
        return { categoryId: item.id, name: item.name, parentId: positiveId(item.parent_id) ? item.parent_id : null };
      });
      return {
        service: SERVICE,
        categories,
        pagination,
        receipt: receipt(SERVICE, 'catalog.categories', result.request),
      };
    },

    async getPublicCatalogFeed({ region } = {}) {
      if (!Object.hasOwn(REGION_FILES, region)) fail('PRINTFUL_FEED_REGION_INVALID');
      const feed = await fetchCatalogZip(fetchImpl, now);
      const products = parseFeedArchive(feed.archive, region);
      const regionData = publicFeedRegion(region, products, feed.request.lastModified ?? null);
      return {
        service: SERVICE,
        sourceURL: `${FEED_ORIGIN}${FEED_PATH}`,
        helpURL: HELP_URL,
        ...regionData,
        receipt: publicFeedReceipt(feed, [region]),
      };
    },

    async getPublicCatalogFeeds({ regions = Object.keys(REGION_FILES) } = {}) {
      if (!Array.isArray(regions) || regions.length < 1 || regions.length > Object.keys(REGION_FILES).length ||
          regions.some(region => !Object.hasOwn(REGION_FILES, region)) || new Set(regions).size !== regions.length) {
        fail('PRINTFUL_FEED_REGION_INVALID');
      }
      const feed = await fetchCatalogZip(fetchImpl, now);
      const products = regions.map(region => publicFeedRegion(
        region, parseFeedArchive(feed.archive, region), feed.request.lastModified ?? null,
      ));
      return {
        service: SERVICE,
        sourceURL: `${FEED_ORIGIN}${FEED_PATH}`,
        helpURL: HELP_URL,
        feeds: products,
        receipt: publicFeedReceipt(feed, regions),
      };
    },
  };
}
