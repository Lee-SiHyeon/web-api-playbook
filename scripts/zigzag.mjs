#!/usr/bin/env node
// Zigzag (지그재그, zigzag.kr) anonymous public reads. JSON on stdout.
//   node scripts/zigzag.mjs categories [--parent=-1]          (category tree; 689 = 패션잡화)
//   node scripts/zigzag.mjs rank --category=<alias|id[,id]> [--limit=10] [--sort=popular]
//   node scripts/zigzag.mjs rank --all [--limit=10]
//   node scripts/zigzag.mjs search <keyword words> [--sort=popular] [--limit=30]
//   node scripts/zigzag.mjs goods <id> [--reviews=10]
//   node scripts/zigzag.mjs images <id> --out=<new or empty dir> [--reviews=30]
// Aliases (women's tree): tops=474 상의, bottoms=547,560 팬츠+스커트, dress=507 원피스, outer=436 아우터,
//   swim=751 비치웨어, bag=623 가방, hat=702 모자, sunglasses=745 선글라스.
// --transport=cdp (default): the GraphQL POST runs inside a zigzag.kr tab that this process opens on the
//   Chrome Canary CDP endpoint (127.0.0.1:9333) and closes again. Canary itself is never stopped.
// --transport=http: plain Node fetch. CloudFront answers it with an empty 200 (see references/commerce-zigzag.md).
// Common flags: --interval-ms=<>=3000> (minimum gap between requests), --output=<new file> (JSON copy).
// Sort keys: popular(인기순, 200) review(리뷰많은순, 201) recommend(추천순, 205) new(신상품순, 206)
//   price-asc(203) price-desc(204) discount(할인율, 207).
// Rank = order of the popularity-sorted listing with ad cards removed (zigzag exposes no rank field).
import { existsSync, constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fail, report, reserveOutput, safeError } from '../lib/cli.mjs';
import { classifyResponse } from '../lib/commerce/backoff.mjs';

const SCHEMA = 'web-api-zigzag-result-v1';
const WEB = 'https://zigzag.kr';
const GRAPHQL = 'https://api.zigzag.kr/api/2/graphql/';
const CDP = process.env.ZIGZAG_CDP || 'http://127.0.0.1:9333';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
const SORT = { popular: '200', review: '201', recommend: '205', new: '206', 'price-asc': '203', 'price-desc': '204', discount: '207' };
const ALIAS = { tops: ['474'], bottoms: ['547', '560'], dress: ['507'], outer: ['436'], swim: ['751'], bag: ['623'], hat: ['702'], sunglasses: ['745'] };
const ALIAS_LABEL = { tops: '상의', bottoms: '하의(팬츠·스커트)', dress: '원피스', outer: '아우터', swim: '수영복·비치웨어', bag: '가방', hat: '모자', sunglasses: '선글라스' };
const ALLOWED = {
  categories: ['parent', 'output', 'interval-ms', 'transport'],
  rank: ['category', 'all', 'limit', 'sort', 'output', 'interval-ms', 'transport'],
  search: ['sort', 'limit', 'output', 'interval-ms', 'transport'],
  goods: ['reviews', 'output', 'interval-ms', 'transport'],
  images: ['out', 'reviews', 'interval-ms', 'transport'],
};
const VALUE_FLAGS = new Set(['parent', 'category', 'limit', 'sort', 'output', 'interval-ms', 'transport', 'reviews', 'out']);
// GraphQL operations, copied verbatim from the zigzag web client (observed 2026-10-20). Persisted hashes are not used.
const Q = { categories: "fragment UxAdDisplayBannerGroup on UxAdDisplayBannerGroup { type id position aspect_ratio is_auto_rolling update_interval item_list { ...UxAdDisplayXLargeBanner } } fragment UxAdDisplayXLargeBanner on UxAdDisplayXLargeBanner { type id position image_url main_copy sub_copy landing_url log background_color { ...UxCommonColor } } fragment UxCommonColor on UxCommonColor { normal } query GetClpTopComponentList($page_id: String!, $ddp_component_id: String, $display_category_id_list: [String!]) { clp_top_component_list( page_id: $page_id ddp_component_id: $ddp_component_id display_category_id_list: $display_category_id_list ) { category_list { type category_list { id name sub_category_list { id name } } } ui_item_list { ...UxAdDisplayBannerGroup } } }", search: "fragment DefaultInput on SearchFilterValue { key type value attribute } fragment RangeInput on SearchFilterValue { key type attribute min_value { ...DecimalUnitNumber } max_value { ...DecimalUnitNumber } } fragment DecimalUnitNumber on DecimalUnitNumber { display_unit decimal is_unit_prefix number_without_decimal unit } fragment UxGoodsCardItemPart on UxGoodsCardItem { browsing_type position type image_url webp_image_url jpeg_image_url video_url log ubl { server_log } image_ratio aid uuid product_url shop_id shop_product_no shop_name title discount_rate discount_info { image_url title color } column_count catalog_product_id goods_id one_day_delivery { ...UxCommonText } has_coupon is_zpay_discount is_saved_product price final_price final_price_with_currency { currency decimal price_without_decimal display_currency is_currency_prefix } max_price max_price_with_currency { currency decimal price_without_decimal display_currency is_currency_prefix } is_zonly is_brand free_shipping zpay ranking sellable_status is_ad is_exclusive similar_search review_score display_review_count badge_list { image_url dark_image_url small_image_url small_dark_image_url } thumbnail_nudge_badge_list { image_url dark_image_url small_image_url small_dark_image_url } thumbnail_emblem_badge_list { image_url dark_image_url small_image_url small_dark_image_url } brand_name_badge_list { image_url dark_image_url small_image_url small_dark_image_url } managed_category_list { id category_id value key depth } is_plp_v2 } fragment UxCommonText on UxCommonText { text color { normal } html { normal } } fragment UxText on UxText { type text style is_html_text } fragment UxButton on UxButton { type text is_html_text style log link_url } fragment UxSearchedShop on UxSearchedShop { id name bookmark_count category category_list { doc_count key } alias_list status is_disabled is_zpay style_list typical_image_url is_saved_shop main_domain department_badge { size text text_color font_weight background_color background_opacity border { color style width radius } } } query GetSearchResult($input: SearchResultInput!) { search_result(input: $input) { end_cursor has_next filter_list { name collapse component_list { key name type ... on SearchChipButtonFilterComponent { value_list { count selected value image_url input { ...DefaultInput } } } ... on SearchBreadcrumbFilterComponent { value_list { id name order path input { ...DefaultInput } } } ... on SearchListFilterComponent { value_list { count id name path selected input { ...DefaultInput } } } ... on SearchRangeSliderFilterComponent { input { ...RangeInput } interval { ...DecimalUnitNumber } max_without_decimal min_without_decimal selected_max_without_decimal selected_min_without_decimal } ... on SearchMessageFilterComponent { text } } } ui_item_list { __typename ... on UxSearchResultHeader { type position total_count } ... on UxNoResults { type position no_results_main_title { type text is_html_text style } no_results_sub_title { type text is_html_text style } image_url aspect_ratio } ... on UxImageBannerGroup { type id aspect_ratio is_auto_rolling update_interval item_list { id image_url landing_url log } } ... on UxFullWidthImageBannerGroup { type id aspect_ratio is_auto_rolling update_interval item_list { id image_url landing_url log } } ... on UxTextTitle { type text sub_text info { title desc } } ...UxGoodsCardItemPart ... on UxGoodsGroup { type group_type id main_title { ...UxText } sub_title { ...UxText } image { type image_url aspect_ratio log link_url } more_button { ...UxButton } action_button { ...UxButton } goods_carousel { type style line_count item_column_count more_button { ...UxButton } component_list { ...UxGoodsCardItemPart } } is_ad } ... on UxShopRankingCardItem { type position shop_id ranking_shop_name: shop_name shop_typical_image_url ranking is_saved_shop variance { type value color } component_list { ...UxGoodsCardItemPart } action_button { ...UxButton } } ... on UxGoodsCarousel { type style line_count item_column_count more_button { ...UxButton } component_list { ...UxGoodsCardItemPart } } ... on UxLineWithMargin { type color height margin { top left bottom right } } ... on UxCheckButtonAndSorting { type check_button_item_list { str_id name selected image_url disabled html_name { normal } } sorting_item_list { str_id name selected description } zigzin_filter_item_list { str_id name selected html_name { normal } } } ... on UxTextAndMoreButton { type position total_count main_title { ...UxText } more_button { ...UxButton } } ... on UxSearchedShopCarousel { type position searched_shop_list { ...UxSearchedShop } } ... on UxGoodsFilterList { type filter_list { key name selected selected_count } } } } }", pdp: "query GetPdpIntegratedData($catalog_product_id: ID!, $limit_count: Int, $order: UxReviewListOrderType) { related_product_review_summary: ux_review_group_summary(product_id: $catalog_product_id) { overview { description { text color { normal } } aggregate { internal { count average_rating } total { count average_rating } exposed { count average_rating } } } } ux_review_list( input: { product_id: $catalog_product_id type_list: [\"PHOTO\", \"VIDEO\"] order: $order pagination: { limit_count: $limit_count } } ) { item_list { id contents rating requested_user { is_abuse_reported } image_list { thumbnail_url } video_list { thumbnail_url } reviewer { profile { masked_email } } } } pdp_base_info(catalog_product_id: $catalog_product_id) { catalog_product { extra_notice_banner { title notice_id } } epick_list { id image_url landing_url nickname } size_recommendation { recommendation_type option_value_list { ranking name height_range { min max } weight_range { min max } size_with_category answer { percent value } purchase_percent } user_account { name body { height weight size_text } } user_body_input_info { html_title selection_list { key label min max gap measure_unit selected_value anchor placeholder } } is_review_button_visible } fitting_model_list { item_list { id name badge { label } fitting_size_list size_text_list profile_image_url } } policy_list { main_title content_list { title description } } } pdp_size_info(catalog_product_id: $catalog_product_id) { item_list { image_url value_list description is_size_comparable is_edit_request_clicked is_ai_image_zoom_button_visible } } pdp_short_form_contents(catalog_product_id: $catalog_product_id) { content_list { id title thumbnail_image_url video_url } } pdp_option_info(catalog_product_id: $catalog_product_id) { catalog_product { is_only_zigzin_button_visible matching_catalog_product_info { id pdp_url browsing_type external_code item_list { id badge_image_url } shipping_fee { fee_type base_fee minimum_free_shipping_fee } } } } }", option: "fragment OptionItemList on PdpCatalogItem { id name price price_delta final_price item_code sales_status display_status remain_stock is_zigzin delivery_type badge_image_url zonly_badge_image_url expected_delivery_date expected_delivery_time option_type discount_info { image_url title color order } item_attribute_list { id name value value_id } wms_notification_info { active } } query GetCatalogProductDetailPageOption($catalog_product_id: ID!, $input: PdpBaseInfoInput) { pdp_option_info(catalog_product_id: $catalog_product_id, input: $input) { catalog_product { shop_id shop_name shop_main_domain id name fulfillment_type external_code minimum_order_quantity maximum_order_quantity coupon_available_status scheduled_sale_date discount_info { image_url title color } estimated_shipping_date { estimate_list { day probability } } shipping_fee { fee_type base_fee minimum_free_shipping_fee } shipping_company { return_company } managed_category_list { id category_id value key depth } meta_catalog_product_info { id is_able_to_buy pdp_url browsing_type } product_price { first_order_discount { price promotion_id discount_type discount_amount discount_rate_bp min_required_amount } coupon_discount_info_list { target_type discount_type discount_amount discount_rate_bp discount_amount_of_amount_coupon min_required_amount max_discount_amount } display_final_price { final_price { badge { text color { normal } } color { normal } } final_price_additional { badge { text } color { normal } } } product_promotion_discount_info { discount_amount } max_price_info { price } final_discount_info { discount_price } } trait_list { type } promotion_info { promotion_id promotion_type bogo_info { required_quantity discount_type discount_amount discount_rate_bp badge { image_url } } } product_image_list { url origin_url pdp_thumbnail_url pdp_static_image_url image_type } product_option_list { id order name code required option_type value_list { id code value static_url jpeg_url } } matching_catalog_product_info { id name is_able_to_buy pdp_url fulfillment_type browsing_type external_code product_price { max_price_info { price color { normal } badge { text color { normal } } } final_discount_info { discount_price } first_order_discount { price promotion_id discount_type discount_amount discount_rate_bp min_required_amount } coupon_discount_info_list { target_type discount_type discount_amount discount_rate_bp discount_amount_of_amount_coupon min_required_amount max_discount_amount } } discount_info { color title image_url order } shipping_fee { fee_type base_fee minimum_free_shipping_fee } option_list { id order name code required option_type value_list { id code value static_url jpeg_url } } } product_additional_option_list { id order name code required option_type value_list { id code value static_url jpeg_url } } custom_input_option_list { name is_required: required max_length } matched_item_list { ...OptionItemList } zigzin_item_list { ...OptionItemList } additional_item_list { ...OptionItemList } is_only_zigzin_button_visible color_image_list { is_main image_url image_width image_height webp_image_url color_list } store_deal_banner { title guide_text } category_list { category_id value } shipping_fee { fee_type base_fee minimum_free_shipping_fee additional_shipping_fee_text } minimum_order_quantity_type option_size_recommendation { option_recommend_text option_value } } flags { is_purchase_only_one_at_time is_cart_button_visible } key_color { buy_button { text { disabled enabled } background { disabled enabled } } discount_info_of_atf } } }" };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const int = (v, d, max) => {
  if (v === undefined) return d;
  if (!/^\d{1,6}$/.test(String(v))) fail('ZIGZAG_ARGUMENT_INVALID');
  const n = Number(v);
  if (n < 1 || n > max) fail('ZIGZAG_ARGUMENT_INVALID');
  return n;
};
const str = v => (typeof v === 'string' && v.length ? v : null);
const toInt = v => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return Number.isSafeInteger(n) ? n : null; };
const stripHtml = s => (typeof s === 'string' ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null);
const isId = v => /^\d{1,12}$/.test(String(v ?? ''));
// Counts arrive as "1,105" strings on cards; null means the field was absent.
const count = v => {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  return typeof v === 'string' && /^\d{1,3}(,\d{3})*$|^\d{1,9}$/.test(v.trim()) ? Number(v.replace(/,/g, '')) : null;
};
const pad = n => String(n).padStart(2, '0');
const originalOf = url => (typeof url === 'string' ? url.split('?')[0] : null);
// Some product images come back as the raw S3 origin, which answers 403 to anonymous clients. The CDN host serves the same key.
const publicUrl = url => {
  const u = originalOf(url);
  return u ? u.replace(/^https:\/\/s3\.ap-northeast-2\.amazonaws\.com\/product-image\.s\.zigzag\.kr\//, 'https://cf.product-image.s.zigzag.kr/') : null;
};
// Judge by file signature, not Content-Type (review photos come back as application/octet-stream).
const sniffImageExt = buf => {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  const head = buf.subarray(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') return '.gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
};

function parseArgs(args, allowed) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!m) { positional.push(arg); continue; }
    const [, key, inline] = m;
    if (!allowed.includes(key) || Object.hasOwn(flags, key)) fail('ZIGZAG_ARGUMENT_INVALID');
    if (inline !== undefined) flags[key] = inline;
    else if (VALUE_FLAGS.has(key) && i + 1 < args.length && !args[i + 1].startsWith('--')) flags[key] = args[++i];
    else flags[key] = true;
  }
  return { flags, positional };
}

// ---- transports ---------------------------------------------------------------------------------------------
function httpTransport() {
  return {
    name: 'http',
    browserUsed: false,
    async request({ url, method = 'POST', headers = {}, body = null, binary = false }) {
      let res;
      try { res = await fetch(url, { method, headers: { 'User-Agent': UA, ...headers }, body, redirect: 'manual' }); }
      catch { fail('ZIGZAG_NETWORK_ERROR'); }
      const contentType = res.headers.get('content-type');
      if (binary) return { status: res.status, contentType, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      return { status: res.status, contentType, text: await res.text(), headers: res.headers };
    },
    async close() {},
  };
}

async function closeTab(id) { await fetch(`${CDP}/json/close/${id}`).catch(() => {}); }

async function cdpTransport() {
  let tab;
  try { tab = await (await fetch(`${CDP}/json/new?${WEB}/`, { method: 'PUT' })).json(); }
  catch { fail('ZIGZAG_CDP_UNAVAILABLE'); }
  let ws;
  try {
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('ws')); });
  } catch { await closeTab(tab.id); fail('ZIGZAG_CDP_UNAVAILABLE'); }
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = event => { const m = JSON.parse(String(event.data)); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); no(Object.assign(new Error('timeout'), { code: 'ZIGZAG_BROWSER_TIMEOUT' })); }, 120000);
    waiting.set(id, m => { clearTimeout(timer); ok(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return { failed: Boolean(m.result?.exceptionDetails), value: m.result?.result?.value };
  };
  // Network-level "Failed to fetch" from a fresh tab is retried (bounded, reads only); HTTP statuses are not.
  const evaluateFetch = async expression => {
    let last;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      last = await evaluate(expression);
      if (!last.failed) return last.value;
      if (attempt < 3) await sleep(4000);
    }
    return fail('ZIGZAG_BROWSER_FETCH_FAILED');
  };
  const transport = {
    name: 'cdp',
    browserUsed: true,
    async request({ url, method = 'POST', headers = {}, body = null, binary = false }) {
      const init = JSON.stringify({ method, headers, body, credentials: 'omit', redirect: 'manual' });
      const value = await evaluateFetch(`(async () => {
        const r = await fetch(${JSON.stringify(url)}, ${init});
        const contentType = r.headers.get('content-type');
        if (${binary}) {
          const u8 = new Uint8Array(await r.arrayBuffer());
          let s = '';
          for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
          return { status: r.status, contentType, base64: btoa(s) };
        }
        return { status: r.status, contentType, text: await r.text() };
      })()`);
      const headerView = { 'content-type': value?.contentType ?? '' };
      if (binary) return { status: value?.status, contentType: value?.contentType ?? null, bytes: Buffer.from(value?.base64 ?? '', 'base64'), headers: headerView };
      return { status: value?.status, contentType: value?.contentType ?? null, text: value?.text ?? '', headers: headerView };
    },
    async close() {
      try { ws.close(); } catch {}
      await closeTab(tab.id);
    },
  };
  try {
    for (let i = 0; i < 80 && (await evaluate('document.readyState')).value !== 'complete'; i += 1) await sleep(500);
    await sleep(3000);
  } catch (error) {
    await transport.close();
    throw error;
  }
  return transport;
}

function openTransport(kind) {
  if (kind === 'http') return httpTransport();
  if (kind !== 'cdp') fail('ZIGZAG_TRANSPORT_INVALID');
  return cdpTransport();
}

// ---- client -------------------------------------------------------------------------------------------------
const stopCode = (verdict, status) => {
  if (verdict.reason === 'challenge_detected') return 'ZIGZAG_CHALLENGE';
  if (status === 401 || status === 403) return 'ZIGZAG_ACCESS_DENIED';
  return 'ZIGZAG_HTTP_ERROR';
};

function client(transport, minIntervalMs) {
  const receipts = [];
  let last = 0;
  const pace = async () => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
  async function gql(operation, query, variables) {
    await pace();
    const res = await transport.request({ url: GRAPHQL + operation, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
    const text = res.text ?? '';
    receipts.push({ operation, transport: transport.name, httpStatus: res.status, contentType: res.contentType ?? null, responseBytes: Buffer.byteLength(text), checkedAt: new Date().toISOString(), anonymous: true, credentialsUsed: false, cookiesSent: false, browserUsed: transport.browserUsed });
    if (res.status === 200 && !res.contentType && text.length === 0) fail('ZIGZAG_EDGE_EMPTY_RESPONSE', { httpStatus: 200, path: operation });
    const verdict = classifyResponse({ status: res.status, headers: res.headers, bodySample: text });
    if (verdict.action === 'stop') fail(stopCode(verdict, res.status), { httpStatus: res.status, path: operation, vendor: verdict.vendor });
    if (verdict.action === 'retry') fail('ZIGZAG_RATE_LIMITED', { httpStatus: res.status, path: operation });
    let json;
    try { json = JSON.parse(text); } catch { fail('ZIGZAG_SCHEMA_INVALID', { path: operation }); }
    if (Array.isArray(json.errors) && json.errors.length) fail('ZIGZAG_GRAPHQL_ERROR', { path: operation });
    if (!json.data) fail('ZIGZAG_SCHEMA_INVALID', { path: operation });
    return json.data;
  }
  async function binary(url) {
    await pace();
    const res = await transport.request({ url, method: 'GET', binary: true });
    receipts.push({ operation: 'IMAGE_GET', transport: transport.name, httpStatus: res.status, contentType: res.contentType ?? null, responseBytes: res.bytes?.length ?? 0, checkedAt: new Date().toISOString(), anonymous: true, credentialsUsed: false, cookiesSent: false, browserUsed: transport.browserUsed });
    return res;
  }
  return { gql, binary, receipts };
}

// ---- parsers ------------------------------------------------------------------------------------------------
function cardsFrom(uiItems) {
  const out = [];
  for (const item of uiItems ?? []) {
    if (item?.type === 'UX_GOODS_CARD_ITEM') out.push(item);
    else for (const sub of item?.component_list ?? item?.goods_carousel?.component_list ?? []) if (sub?.type === 'UX_GOODS_CARD_ITEM') out.push(sub);
  }
  return out.filter(card => isId(card.goods_id ?? card.catalog_product_id));
}

function cardOf(card, listPosition) {
  const id = String(card.goods_id ?? card.catalog_product_id);
  return {
    rank: null,
    id,
    shop: { id: toInt(card.shop_id), name: str(card.shop_name) },
    name: str(card.title),
    priceKrw: { original: toInt(card.price), sale: toInt(card.final_price), discountRate: toInt(card.discount_rate) },
    image: str(card.image_url) ?? str(card.jpeg_image_url),
    productUrl: `${WEB}/catalog/products/${id}`,
    reviews: { count: count(card.display_review_count), rating: typeof card.review_score === 'number' ? card.review_score : null },
    sellableStatus: str(card.sellable_status),
    isAd: card.is_ad === true,
    listPosition,
  };
}

// One listing read. mode=category uses display_category_id_list; mode=search uses q. Pages follow end_cursor.
async function listGoods(c, { mode, categoryIds, query, sort, limit, skipAds }) {
  const items = [];
  const seen = new Set();
  let position = 0;
  let adsSkipped = 0;
  let after = null;
  let pages = 0;
  let totalCount = null;
  let hasNext = true;
  while (items.length < limit && hasNext && pages < 6) {
    const input = mode === 'category'
      ? { display_category_id_list: categoryIds, page_id: 'web_srp_clp_category', filter_id_list: [sort], ...(after ? { after } : {}) }
      : { q: query, page_id: 'srp_item', filter_id_list: [sort], filter_list: [], sub_filter_id_list: [], after };
    const { search_result: sr } = await c.gql('GetSearchResult', Q.search, { input });
    pages += 1;
    totalCount = totalCount ?? (sr.ui_item_list ?? []).find(x => x.type === 'UX_SEARCH_RESULT_HEADER')?.total_count ?? null;
    for (const card of cardsFrom(sr.ui_item_list)) {
      position += 1;
      const item = cardOf(card, position);
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (skipAds && item.isAd) { adsSkipped += 1; continue; }
      if (skipAds) item.rank = items.length + 1;
      items.push(item);
      if (items.length >= limit) break;
    }
    hasNext = Boolean(sr.has_next && sr.end_cursor);
    after = hasNext ? sr.end_cursor : null;
  }
  return { items, adsSkipped, pagesRead: pages, totalCount, endReached: !hasNext };
}

function resolveCategory(key) {
  if (Object.hasOwn(ALIAS, key)) return { alias: key, label: ALIAS_LABEL[key], ids: ALIAS[key] };
  if (/^\d{1,12}(,\d{1,12}){0,4}$/.test(key)) return { alias: null, label: null, ids: key.split(',') };
  return fail('ZIGZAG_CATEGORY_UNKNOWN');
}

async function rankOne(c, target, { limit, sort }) {
  const r = await listGoods(c, { mode: 'category', categoryIds: target.ids, sort, limit, skipAds: true });
  return { category: target, sort: sortName(sort), items: r.items, adsSkipped: r.adsSkipped, pagesRead: r.pagesRead, endReached: r.endReached };
}

const sortName = value => Object.keys(SORT).find(k => SORT[k] === value) ?? value;

async function categories(c, parent) {
  if (!/^-?\d{1,12}$/.test(parent)) fail('ZIGZAG_ARGUMENT_INVALID');
  const data = await c.gql('GetClpTopComponentList', Q.categories, { display_category_id_list: [parent], page_id: 'srp_clp_category' });
  const list = data.clp_top_component_list?.category_list?.category_list ?? [];
  return {
    parent,
    categories: list.map(x => ({ id: String(x.id), name: str(x.name), children: (x.sub_category_list ?? []).map(s => ({ id: String(s.id), name: str(s.name) })) })),
  };
}

// Product detail = GetPdpIntegratedData (reviews) + GetCatalogProductDetailPageOption (name, price, images, options).
async function goods(c, id, reviewLimit) {
  if (!isId(id)) fail('ZIGZAG_ID_INVALID');
  const pdp = await c.gql('GetPdpIntegratedData', Q.pdp, { catalog_product_id: id, limit_count: reviewLimit, order: 'EXPERIENCE_GROUP_BEST_SCORE_DESC' });
  const opt = await c.gql('GetCatalogProductDetailPageOption', Q.option, { catalog_product_id: id, input: { catalog_product_id: id } });
  const p = opt.pdp_option_info?.catalog_product;
  if (!p || String(p.id) !== id) fail('ZIGZAG_PRODUCT_NOT_FOUND');
  const agg = pdp.related_product_review_summary?.overview?.aggregate?.total ?? {};
  const reviewPhotos = [];
  const samples = (pdp.ux_review_list?.item_list ?? []).map(r => {
    const photos = (r.image_list ?? []).map(i => originalOf(i.thumbnail_url)).filter(Boolean);
    for (const url of photos) reviewPhotos.push({ url, reviewId: String(r.id) });
    return { id: String(r.id), rating: toInt(r.rating), text: (r.contents ?? '').slice(0, 200), photoCount: photos.length };
  });
  return {
    id,
    name: str(p.name),
    shop: { id: toInt(p.shop_id), name: str(p.shop_name) },
    productUrl: `${WEB}/catalog/products/${id}`,
    category: {
      managed: (p.managed_category_list ?? []).map(m => ({ id: String(m.id), key: str(m.key), name: str(m.value), depth: toInt(m.depth) })),
      listed: (p.category_list ?? []).map(x => ({ id: String(x.category_id), name: str(x.value) })),
    },
    priceKrw: {
      original: toInt(p.product_price?.max_price_info?.price),
      sale: toInt(p.product_price?.final_discount_info?.discount_price),
      couponAvailableStatus: str(p.coupon_available_status),
    },
    shipping: { feeType: str(p.shipping_fee?.fee_type), baseFeeKrw: toInt(p.shipping_fee?.base_fee), note: stripHtml(p.shipping_fee?.additional_shipping_fee_text) },
    options: (p.product_option_list ?? []).flatMap(g => (g.value_list ?? []).map(v => ({
      group: str(g.name), required: g.required === true, optionId: String(v.id), label: str(v.value),
      colorHex: /^#[0-9A-Fa-f]{3,8}$/.test(v.code ?? '') ? v.code : null,
    }))),
    images: {
      product: (p.product_image_list ?? []).map((i, n) => ({ n: n + 1, imageType: str(i.image_type), url: publicUrl(i.url ?? i.origin_url) })).filter(x => x.url),
      reviewPhotos,
    },
    reviews: { count: toInt(agg.count), averageRating: typeof agg.average_rating === 'number' ? agg.average_rating : null, sampled: samples.length, samples },
  };
}

// Download to a fresh local temp folder first, then copy into --out. Nothing is written to --out until every
// download has finished, and --out must be new or empty.
async function downloadImages(c, detail, out) {
  const plan = [
    ...detail.images.product.map(i => ({ kind: 'product', imageType: i.imageType, url: i.url, base: `product-${pad(i.n)}-${(i.imageType ?? 'img').toLowerCase()}` })),
    ...detail.images.reviewPhotos.map((r, k) => ({ kind: 'review', reviewId: r.reviewId, url: r.url, base: `review-${pad(k + 1)}` })),
  ];
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zigzag-images-'));
  try {
    const files = [];
    for (const item of plan) {
      const meta = { file: null, kind: item.kind, imageType: item.imageType ?? null, reviewId: item.reviewId ?? null, sourceUrl: item.url };
      let res;
      try { res = await c.binary(item.url); }
      catch (error) { files.push({ ...meta, ok: false, code: safeError(error) }); continue; }
      const ext = res.status === 200 && res.bytes?.length ? sniffImageExt(res.bytes) : null;
      if (!ext) {
        files.push({ ...meta, ok: false, code: 'ZIGZAG_IMAGE_UNAVAILABLE', httpStatus: res.status });
        continue;
      }
      const file = `${item.base}${ext}`;
      await writeFile(path.join(tmp, file), res.bytes, { flag: 'wx' });
      files.push({ ...meta, file, ok: true, bytes: res.bytes.length, sha256: createHash('sha256').update(res.bytes).digest('hex') });
    }
    await mkdir(out, { recursive: true });
    for (const f of files.filter(x => x.ok)) await copyFile(path.join(tmp, f.file), path.join(out, f.file), constants.COPYFILE_EXCL);
    const manifest = { schema: 'web-api-zigzag-images-v1', productId: detail.id, name: detail.name, shop: detail.shop, productUrl: detail.productUrl, checkedAt: new Date().toISOString(), downloaded: files.filter(f => f.ok).length, failed: files.filter(f => !f.ok).length, files };
    await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { out, ...manifest };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---- main ---------------------------------------------------------------------------------------------------
const [command, ...rest] = process.argv.slice(2);
let handle;
try {
  if (!Object.hasOwn(ALLOWED, command ?? '')) fail('ZIGZAG_COMMAND_INVALID');
  const { flags, positional } = parseArgs(rest, ALLOWED[command]);
  const intervalMs = int(flags['interval-ms'], 3000, 60000);
  if (intervalMs < 3000) fail('ZIGZAG_INTERVAL_TOO_SHORT');
  const transportKind = flags.transport ?? 'cdp';
  if (flags.transport !== undefined && !['cdp', 'http'].includes(transportKind)) fail('ZIGZAG_TRANSPORT_INVALID');
  if (flags.sort !== undefined && !Object.hasOwn(SORT, flags.sort)) fail('ZIGZAG_SORT_INVALID');
  const sort = SORT[flags.sort ?? 'popular'];
  let outDir = null;
  if (command === 'images') {
    if (typeof flags.out !== 'string') fail('ZIGZAG_OUT_REQUIRED');
    outDir = path.resolve(flags.out);
    if (existsSync(outDir) && (await readdir(outDir)).length) fail('ZIGZAG_OUT_NOT_EMPTY');
  }
  if (flags.output) handle = await reserveOutput(flags.output);
  const transport = await openTransport(transportKind);
  try {
    const c = client(transport, intervalMs);
    let data;
    if (command === 'categories') data = await categories(c, flags.parent ?? '-1');
    else if (command === 'rank') {
      if (flags.all) {
        const groups = [];
        for (const key of Object.keys(ALIAS)) groups.push(await rankOne(c, resolveCategory(key), { limit: int(flags.limit, 10, 100), sort }));
        data = { groups };
      } else {
        if (typeof flags.category !== 'string') fail('ZIGZAG_CATEGORY_REQUIRED');
        data = await rankOne(c, resolveCategory(flags.category), { limit: int(flags.limit, 10, 100), sort });
      }
    } else if (command === 'search') {
      const query = positional.join(' ').trim();
      if (!query || query.length > 60) fail('ZIGZAG_KEYWORD_INVALID');
      const r = await listGoods(c, { mode: 'search', query, sort, limit: int(flags.limit, 30, 100), skipAds: false });
      data = { query, sort: sortName(sort), items: r.items, pagesRead: r.pagesRead, totalCount: r.totalCount, endReached: r.endReached };
    } else if (command === 'goods') {
      if (positional.length !== 1) fail('ZIGZAG_ID_REQUIRED');
      data = await goods(c, positional[0], int(flags.reviews, 10, 50));
    } else {
      if (positional.length !== 1) fail('ZIGZAG_ID_REQUIRED');
      const detail = await goods(c, positional[0], int(flags.reviews, 30, 50));
      data = await downloadImages(c, detail, outDir);
    }
    await report({
      schema: SCHEMA, service: 'zigzag', command, ok: true, checkedAt: new Date().toISOString(),
      executionMode: transport.name === 'cdp' ? 'browser_page_fetch' : 'pure_http', browserUsed: transport.browserUsed,
      accountLogin: false, writesSubmitted: 0,
      session: 'anonymous GraphQL; credentials omitted, script sends no cookies; no account login',
      requests: c.receipts, data,
    }, handle);
  } finally {
    await transport.close();
  }
} catch (error) {
  const out = { code: safeError(error) };
  for (const key of ['httpStatus', 'path', 'vendor']) if (error?.[key] !== undefined) out[key] = error[key];
  await report({ schema: SCHEMA, service: 'zigzag', command: command ?? null, ok: false, error: out }, handle).catch(() => {});
  process.exitCode = 1;
} finally {
  await handle?.close();
}
