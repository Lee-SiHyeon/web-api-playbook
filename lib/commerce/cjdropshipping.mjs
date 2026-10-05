import { commerceFail, commerceJsonRequest, validateAccessToken } from './http.mjs';

const SERVICE = 'cjdropshipping';
const ORIGIN = 'https://developers.cjdropshipping.com';
const MAX_TEXT = 200;
const MAX_PRODUCTS = 100;
const MAX_VARIANTS = 2000;
const COUNTRY = /^[A-Z]{2}$/;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT &&
  !/[\x00-\x1f\x7f]/.test(value);
const positiveInt = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;
const safeInt = value => Number.isSafeInteger(value) && value >= 0;

export class CjDropshippingError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'CjDropshippingError';
    this.code = code;
    this.receipt = receipt;
  }
}

function fail(code, receipt) {
  throw new CjDropshippingError(code, receipt);
}

function credentialedReceipt(capabilityId, request) {
  return {
    schema: 'web-api-credentialed-read-receipt-v1',
    service: SERVICE,
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
    contractProvenance: {
      kind: 'first_party_documented_api',
      sourceURL: 'https://developers.cjdropshipping.com/en/api/api2/api/product.html',
    },
    request,
  };
}

function validateEnvelope(payload, request) {
  if (!object(payload) || payload.code !== 200 || payload.result !== true || !('data' in payload)) {
    fail('CJDROPSHIPPING_BUSINESS_REJECTED', {
      ...request,
      ...(Number.isSafeInteger(payload?.code) ? { businessCode: payload.code } : {}),
    });
  }
  return payload.data;
}

function price(raw, field) {
  const value = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? String(raw) : raw;
  if (typeof value !== 'string' || value.length > 80 || !/^(?:\d+(?:\.\d{1,4})?)(?:-\d+(?:\.\d{1,4})?)?$/.test(value)) {
    return null;
  }
  return {
    raw: value,
    currency: 'USD',
    currencySource: 'CJ API documentation',
    priceField: field,
    priceMeaning: 'CJ catalog sell price; distinct from the direct wholesale price object',
  };
}

function summarizeSearchProduct(product) {
  if (!object(product) || !text(product.id) || !text(product.nameEn) ||
      product.nameEn.length > 500 || !text(product.sku) || !text(product.bigImage)) {
    fail('CJDROPSHIPPING_PRODUCT_SCHEMA_INVALID');
  }
  const sellPrice = price(product.sellPrice, 'sellPrice');
  if (!sellPrice) fail('CJDROPSHIPPING_PRICE_SCHEMA_INVALID');
  const nowPrice = product.nowPrice == null || product.nowPrice === ''
    ? null : price(product.nowPrice, 'nowPrice');
  const discountPrice = product.discountPrice == null || product.discountPrice === ''
    ? null : price(product.discountPrice, 'discountPrice');
  if (product.nowPrice != null && product.nowPrice !== '' && !nowPrice ||
      product.discountPrice != null && product.discountPrice !== '' && !discountPrice) {
    fail('CJDROPSHIPPING_PRICE_SCHEMA_INVALID');
  }
  return {
    productId: product.id,
    title: product.nameEn,
    sku: product.sku,
    imageUrl: product.bigImage,
    category: {
      id: typeof product.categoryId === 'string' ? product.categoryId : null,
      name: typeof product.threeCategoryName === 'string' ? product.threeCategoryName : null,
    },
    prices: { sellPrice, currentPrice: nowPrice, bestDiscountPrice: discountPrice },
    listedCount: safeInt(product.listedNum) ? product.listedNum : null,
    inventory: {
      warehouseInventory: safeInt(product.warehouseInventoryNum) ? product.warehouseInventoryNum : null,
      verifiedInventory: safeInt(product.totalVerifiedInventory) ? product.totalVerifiedInventory : null,
    },
    shipping: { freeShipping: product.addMarkStatus === 1 },
    saleStatus: product.saleStatus ?? null,
  };
}

function flattenCategories(data) {
  if (!Array.isArray(data) || data.length > 1000) fail('CJDROPSHIPPING_CATEGORY_SCHEMA_INVALID');
  const flat = [];
  const add = (id, name, parentId, level) => {
    if (!text(name) || flat.length >= 5000) fail('CJDROPSHIPPING_CATEGORY_SCHEMA_INVALID');
    flat.push({ ...(text(id) ? { id } : {}), name, parentId, level });
  };
  for (const first of data) {
    if (!object(first) || !text(first.categoryFirstName) || !Array.isArray(first.categoryFirstList)) {
      fail('CJDROPSHIPPING_CATEGORY_SCHEMA_INVALID');
    }
    add(null, first.categoryFirstName, null, 1);
    for (const second of first.categoryFirstList) {
      if (!object(second) || !text(second.categorySecondName) || !Array.isArray(second.categorySecondList)) {
        fail('CJDROPSHIPPING_CATEGORY_SCHEMA_INVALID');
      }
      add(null, second.categorySecondName, first.categoryFirstName, 2);
      for (const third of second.categorySecondList) {
        if (!object(third) || !text(third.categoryId) || !text(third.categoryName)) {
          fail('CJDROPSHIPPING_CATEGORY_SCHEMA_INVALID');
        }
        add(third.categoryId, third.categoryName, second.categorySecondName, 3);
      }
    }
  }
  return flat;
}

function normalizeWholesale(wholesalePrice) {
  if (wholesalePrice == null) return null;
  if (!object(wholesalePrice)) fail('CJDROPSHIPPING_WHOLESALE_SCHEMA_INVALID');
  const cj = wholesalePrice.cjWholesalePrice;
  const direct = wholesalePrice.directWholesalePrice;
  if (cj != null && !Array.isArray(cj) || direct != null && !Array.isArray(direct)) {
    fail('CJDROPSHIPPING_WHOLESALE_SCHEMA_INVALID');
  }
  return {
    cjWholesalePrice: Array.isArray(cj) ? cj.slice(0, 100) : null,
    directWholesalePrice: Array.isArray(direct) ? direct.slice(0, 100) : null,
    updatePriceDate: safeInt(wholesalePrice.updatePriceDate) ? wholesalePrice.updatePriceDate : null,
    currency: null,
    currencyNote: 'The documented wholesale array schema does not declare a currency or amount unit.',
  };
}

function summarizeVariant(variant, productId, inventoryByVariant) {
  if (!object(variant) || !text(variant.id) ||
      (variant.pid != null && variant.pid !== productId)) {
    fail('CJDROPSHIPPING_VARIANT_SCHEMA_INVALID');
  }
  const sellPrice = variant.sellprice == null ? null : price(variant.sellprice, 'sellprice');
  if (variant.sellprice != null && !sellPrice) fail('CJDROPSHIPPING_PRICE_SCHEMA_INVALID');
  return {
    variantId: variant.id,
    productId,
    sku: typeof variant.sku === 'string' ? variant.sku : null,
    title: typeof variant.nameen === 'string' ? variant.nameen : null,
    optionValues: typeof variant.variantkey === 'string' ? variant.variantkey : null,
    price: sellPrice,
    inventory: {
      variantReportedTotal: safeInt(variant.totalInventory) ? variant.totalInventory : null,
      byCountry: inventoryByVariant.get(variant.id) ?? [],
      semantics: 'country rows distinguish CJ actual stock, virtual factory stock, total, and verification status',
    },
    wholesalePrice: normalizeWholesale(variant.wholesalePrice),
  };
}

function normalizeInventoryRows(rows) {
  if (rows == null) return new Map();
  if (!Array.isArray(rows) || rows.length > MAX_VARIANTS) fail('CJDROPSHIPPING_INVENTORY_SCHEMA_INVALID');
  const result = new Map();
  for (const row of rows) {
    if (!object(row) || !text(row.vid) || !Array.isArray(row.inventory) || row.inventory.length > 100 || result.has(row.vid)) {
      fail('CJDROPSHIPPING_INVENTORY_SCHEMA_INVALID');
    }
    const countries = row.inventory.map(stock => {
      if (!object(stock) || typeof stock.countryCode !== 'string' || !COUNTRY.test(stock.countryCode) ||
          !(stock.cjInventory == null || safeInt(stock.cjInventory)) ||
          !(stock.factoryInventory == null || safeInt(stock.factoryInventory)) ||
          !(stock.totalInventory == null || safeInt(stock.totalInventory)) ||
          !(stock.verifiedWarehouse == null || stock.verifiedWarehouse === 1 || stock.verifiedWarehouse === 2)) {
        fail('CJDROPSHIPPING_INVENTORY_SCHEMA_INVALID');
      }
      return {
        countryCode: stock.countryCode,
        cjActual: safeInt(stock.cjInventory) ? stock.cjInventory : null,
        factoryVirtual: safeInt(stock.factoryInventory) ? stock.factoryInventory : null,
        total: safeInt(stock.totalInventory) ? stock.totalInventory : null,
        verifiedWarehouse: stock.verifiedWarehouse ?? null,
      };
    });
    result.set(row.vid, countries);
  }
  return result;
}

/**
 * CJ API V2 read-only client. The access token is retained only in this process
 * closure and is never copied into a result or receipt.
 */
export function createCjDropshippingClient({
  accessToken,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxResponseBytes = 4 * 1024 * 1024,
} = {}) {
  const token = validateAccessToken(SERVICE, accessToken);

  async function request(path, { query = [], method = 'GET', body } = {}) {
    const result = await commerceJsonRequest({
      service: SERVICE,
      origin: ORIGIN,
      path,
      method,
      query,
      ...(body === undefined ? {} : { jsonBody: body }),
      accessToken: token,
      authHeader: 'CJ-Access-Token',
      fetchImpl,
      now,
      maxBytes: maxResponseBytes,
    });
    const data = validateEnvelope(result.payload, result.request);
    return { data, request: result.request };
  }

  return {
    async searchProducts({ keyword, page = 1, size = 20, categoryId, countryCode,
      startSellPrice, endSellPrice } = {}) {
      if (keyword !== undefined && (typeof keyword !== 'string' || keyword.length > 200 || /[\x00-\x1f\x7f]/.test(keyword)) ||
          !positiveInt(page, 1000) || !positiveInt(size, 100) ||
          categoryId !== undefined && !text(categoryId) ||
          countryCode !== undefined && (typeof countryCode !== 'string' || !COUNTRY.test(countryCode)) ||
          startSellPrice !== undefined && (typeof startSellPrice !== 'number' || !Number.isFinite(startSellPrice) || startSellPrice < 0) ||
          endSellPrice !== undefined && (typeof endSellPrice !== 'number' || !Number.isFinite(endSellPrice) || endSellPrice < 0) ||
          startSellPrice !== undefined && endSellPrice !== undefined && startSellPrice > endSellPrice) {
        fail('CJDROPSHIPPING_SEARCH_ARGUMENT_INVALID');
      }
      const query = [['page', String(page)], ['size', String(size)]];
      if (keyword !== undefined && keyword !== '') query.push(['keyWord', keyword]);
      if (categoryId !== undefined) query.push(['categoryId', categoryId]);
      if (countryCode !== undefined) query.push(['countryCode', countryCode]);
      if (startSellPrice !== undefined) query.push(['startSellPrice', String(startSellPrice)]);
      if (endSellPrice !== undefined) query.push(['endSellPrice', String(endSellPrice)]);
      const response = await request('/api2.0/v1/product/listV2', { query });
      const data = response.data;
      if (!object(data) || !safeInt(data.pageSize) || !positiveInt(data.pageNumber, 1000) ||
          !safeInt(data.totalRecords) || !safeInt(data.totalPages) || !Array.isArray(data.content) ||
          data.content.length > size || data.pageNumber !== page || data.pageSize !== size) {
        fail('CJDROPSHIPPING_SEARCH_SCHEMA_INVALID', response.request);
      }
      const products = [];
      for (const group of data.content) {
        if (!object(group) || !Array.isArray(group.productList) || group.productList.length > size) {
          fail('CJDROPSHIPPING_SEARCH_SCHEMA_INVALID', response.request);
        }
        for (const item of group.productList) {
          if (products.length >= MAX_PRODUCTS) fail('CJDROPSHIPPING_SEARCH_SCHEMA_INVALID', response.request);
          products.push(summarizeSearchProduct(item));
        }
      }
      return {
        service: SERVICE,
        products,
        pagination: {
          page: data.pageNumber,
          pageSize: data.pageSize,
          totalRecords: data.totalRecords,
          totalPages: data.totalPages,
          maximumDocumentedRecords: 6000,
        },
        receipt: credentialedReceipt('catalog.search', response.request),
      };
    },

    async getProductDetail({ productId } = {}) {
      if (!text(productId)) {
        fail('CJDROPSHIPPING_PRODUCT_ID_INVALID');
      }
      const response = await request('/api2.0/v1/product/productDetail/query', {
        method: 'POST', body: { id: productId },
      });
      const data = response.data;
      const returnedId = data?.id ?? data?.pid;
      if (!object(data) || returnedId !== productId || !text(data.nameen) || !text(data.sku) ||
          !Array.isArray(data.stanProducts) || data.stanProducts.length > MAX_VARIANTS) {
        fail('CJDROPSHIPPING_PRODUCT_SCHEMA_INVALID', response.request);
      }
      const productPrice = data.sellprice == null ? null : price(data.sellprice, 'sellprice');
      if (data.sellprice != null && !productPrice) fail('CJDROPSHIPPING_PRICE_SCHEMA_INVALID', response.request);
      const inventoryByVariant = normalizeInventoryRows(data.variantInventory);
      const variants = data.stanProducts.map(item => summarizeVariant(item, productId, inventoryByVariant));
      const listedVariantIds = new Set(data.stanProducts.map(item => item?.id));
      const inventoryRowsWithoutListedVariant = [...inventoryByVariant.entries()]
        .filter(([variantId]) => !listedVariantIds.has(variantId))
        .map(([variantId, byCountry]) => ({ variantId, byCountry }));
      return {
        service: SERVICE,
        product: {
          productId: returnedId,
          title: data.nameen,
          sku: data.sku,
          imageUrl: typeof data.bigimg === 'string' ? data.bigimg : null,
          category: {
            id: typeof data.categoryid === 'string' ? data.categoryid : null,
            name: typeof data.category === 'string' ? data.category : null,
          },
          price: productPrice,
          priceRole: 'CJ catalog sell price; use wholesalePrice for distinct supplier wholesale quotes',
          variants,
          inventoryRowsWithoutListedVariant,
        },
        receipt: {
          ...credentialedReceipt('catalog.product_detail', response.request),
          productIdMatched: true,
        },
      };
    },

    async getCategories() {
      const response = await request('/api2.0/v1/product/getCategory');
      return {
        service: SERVICE,
        categories: flattenCategories(response.data),
        receipt: credentialedReceipt('catalog.categories', response.request),
      };
    },
  };
}
