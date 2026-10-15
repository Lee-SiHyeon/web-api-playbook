import { parseHTML } from 'linkedom';
const ORIGIN = 'https://www.amazon.com';
const ASIN = /^[A-Z0-9]{10}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = n => n?.textContent.replace(/\s+/g, ' ').trim() ?? '';
const limited = (value, max = 20000) => value.slice(0, max);
const imageUrl = value => {
  try { const u = new URL(value); return u.origin === 'https://m.media-amazon.com' && !u.username && !u.password
    && !u.search && !u.hash && u.pathname.startsWith('/images/I/') ? u.href : null; } catch { return null; }
};
function price(node) {
  if (!node) return null;
  let displayText = text(node.querySelector('.a-offscreen'));
  if (!displayText) displayText = text(node.querySelector('.a-price-symbol')) + text(node.querySelector('.a-price-whole'))
    + (text(node.querySelector('.a-price-fraction')) ? `.${text(node.querySelector('.a-price-fraction'))}` : '');
  displayText = displayText.replace(/\.{2,}/g, '.').trim();
  if (!displayText) return null;
  const match = /^(?:(?<code>[A-Z]{3})\s*|(?<symbol>[$€£¥₹])\s*)(?<amount>(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,3})?)$/.exec(displayText);
  const currency = match?.groups.code;
  return { displayText, amount: match?.groups.amount.replaceAll(',', '') ?? null,
    currencyCode: currency && Intl.supportedValuesOf('currency').includes(currency) ? currency : null,
    currencyVerified: Boolean(currency && Intl.supportedValuesOf('currency').includes(currency)),
    basis: 'displayed_product_page', checkoutPriceVerified: false };
}

export function parseAmazonProductDocument(html, { asin } = {}) {
  if (!ASIN.test(asin ?? '')) fail('AMAZON_PRODUCT_INPUT_INVALID');
  if (typeof html !== 'string' || Buffer.byteLength(html) > 4 * 1024 * 1024) fail('AMAZON_PRODUCT_RESPONSE_INVALID');
  const doc = parseHTML(html).document;
  if (doc.querySelector('form[action*="validateCaptcha"], #captchacharacters')) fail('AMAZON_PRODUCT_CHALLENGE');
  const title = text(doc.querySelector('#productTitle'));
  const identity = doc.querySelector('input[name="ASIN"]')?.getAttribute('value');
  if (!title || title.length > 2000) fail('AMAZON_PRODUCT_LAYOUT_CHANGED');
  if (identity !== asin) fail('AMAZON_PRODUCT_IDENTITY_MISMATCH');
  for (const node of doc.querySelectorAll('script,style,noscript,iframe')) node.remove();
  const features = [...doc.querySelectorAll('#feature-bullets li')].map(text).filter(Boolean).map(v => limited(v, 3000)).slice(0,40);
  const images = new Map();
  const addImage = (url, role, dimensions = null) => {
    url = imageUrl(url); if (url && !images.has(url)) images.set(url, { url, role, dimensions });
  };
  for (const node of doc.querySelectorAll('#imageBlock img, #altImages img')) {
    const main = node.id === 'landingImage' || node.id === 'imgBlkFront';
    addImage(node.getAttribute('data-old-hires'), main ? 'main_high_resolution' : 'observed_high_resolution');
    addImage(node.getAttribute('src'), main ? 'main_display' : 'thumbnail');
    const dynamic = node.getAttribute('data-a-dynamic-image');
    if (dynamic && dynamic.length <= 20000) {
      let entries; try { entries = Object.entries(JSON.parse(dynamic)); } catch { fail('AMAZON_PRODUCT_IMAGE_SCHEMA'); }
      for (const [url, size] of entries.slice(0,30)) if (Array.isArray(size) && size.length === 2
        && size.every(v => Number.isInteger(v) && v > 0 && v <= 20000)) addImage(url, 'main_responsive', { width: size[0], height: size[1] });
    }
  }
  const dimensions = [];
  for (const group of doc.querySelectorAll('[id^="inline-twister-row-"], [id^="variation_"]')) {
    const dimension = group.id.replace(/^(?:inline-twister-row-|variation_)/, '');
    if (!/^[a-z_]{1,80}$/.test(dimension)) continue;
    const choices = new Map();
    for (const li of group.querySelectorAll('li[data-asin], li[data-defaultasin]')) {
      const childAsin = li.getAttribute('data-asin') ?? li.getAttribute('data-defaultasin');
      const label = li.querySelector('img[alt]')?.getAttribute('alt')?.trim()
        || text(li.querySelector('.a-button-text')) || li.getAttribute('title')?.trim();
      if (!ASIN.test(childAsin ?? '') || !label || label.length > 1000) continue;
      choices.set(childAsin, { asin: childAsin, label, selected: childAsin === asin,
        productUrl: `${ORIGIN}/-/ko/dp/${childAsin}/`, priceVerified: false, stockVerified: false });
    }
    if (choices.size) dimensions.push({ dimension, choices: [...choices.values()] });
  }
  const specifications = [];
  for (const row of doc.querySelectorAll('[id^="productDetails_"] tr, #productOverview_feature_div tr')) {
    const cells = [...row.querySelectorAll('th,td')];
    if (cells.length === 2 && text(cells[0]) && text(cells[1])) specifications.push({ label: limited(text(cells[0]), 200), value: limited(text(cells[1]), 3000) });
  }
  const availabilityText = text(doc.querySelector('#availability')) || null;
  const reviews = [...doc.querySelectorAll('[data-hook="review"]')].map(node => ({
    body: text(node.querySelector('[data-hook="review-body"]')),
    ratingText: text(node.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]')) || null,
    dateText: text(node.querySelector('[data-hook="review-date"]')) || null,
  })).filter(row => row.body).map(row => ({ ...row, body: limited(row.body) })).slice(0,20);
  return { asin, productUrl: `${ORIGIN}/-/ko/dp/${asin}/`, title,
    brandDisplayText: text(doc.querySelector('#bylineInfo')) || null,
    description: limited(text(doc.querySelector('#productDescription'))) || null, features,
    displayedPrice: price(doc.querySelector('#corePriceDisplay_desktop_feature_div .priceToPay')),
    displayedReferencePrice: price(doc.querySelector('#corePriceDisplay_desktop_feature_div .apex-basisprice-value')),
    availability: { displayText: availabilityText, status: /^(?:In Stock\.?|재고\s*있음)$/i.test(availabilityText ?? '') ? 'displayed_in_stock' : 'unknown', quantity: null },
    images: [...images.values()], dimensions, specifications, embeddedReviews: reviews,
    coverage: { identityVerified: true, completeGallery: false, allVariantCombinations: false,
      optionOffersVerified: false, allReviews: false, reviewPaginationVerified: false, checkoutPriceVerified: false } };
}
