import test from 'node:test';
import assert from 'node:assert/strict';
import { createSephoraReviewsClient } from '../lib/commerce/sephora-reviews.mjs';

const PUBLIC_TEST_KEY = 'fixture-public-bazaarvoice-key-00001';
const bootstrap = token => `<script>Sephora.configurationSettings={bvApi_rwdRating_desktop_read:{host:"api.bazaarvoice.com",token:"${token}",version:"5.4"}}</script>`;
const photo = (id = 'img-1') => ({
  Id: id,
  Caption: 'Photo caption',
  Sizes: {
    large: { Url: `https://photos-us.bazaarvoice.com/photo/${id}/large`, Width: 1200, Height: 900 },
    thumbnail: { Url: `https://photos-us.bazaarvoice.com/photo/${id}/thumb`, Width: 160, Height: 120 },
  },
});
const review = ({ id, sku, rating = 5, body = 'A public product review.', photos = [] }) => ({
  Id: String(id), ProductId: sku, Rating: rating, ReviewText: body,
  Title: 'A review title', SubmissionTime: '2026-10-04T18:39:58.000+00:00',
  Photos: photos,
  // Reviewer identity fields deliberately exist in the upstream shape but must not escape.
  AuthorId: 'private-reviewer-id', UserNickname: 'private-display-name', UserLocation: 'private-location',
});
const fixturePage = (offset = 0) => ({
  Limit: 2, Offset: offset, TotalResults: 3, HasErrors: false, Errors: [],
  Results: offset === 0
    ? [review({ id: 101, sku: '900001', photos: [photo()] }), review({ id: 102, sku: '900002', rating: 4 })]
    : [review({ id: 103, sku: '900003', rating: 3, body: 'Last page review.' })],
  Includes: { Products: {
    '900001': { Attributes: { BV_FE_FAMILY: { Values: [{ Value: 'P12345' }] } } },
    '900002': { Attributes: { BV_FE_FAMILY: { Values: [{ Value: 'P12345' }] } } },
    '900003': { Attributes: { BV_FE_FAMILY: { Values: [{ Value: 'P12345' }] } } },
  } },
});

const jsonResponse = (value, status = 200, mime = 'application/json; charset=utf-8') =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': mime } });
const htmlResponse = (value, status = 200, mime = 'text/html; charset=utf-8') =>
  new Response(value, { status, headers: { 'content-type': mime } });

function publicFetch({ offsets = [0, 2], bootstrapHtml = bootstrap(PUBLIC_TEST_KEY), mutateReview } = {}) {
  let bootstrapCalls = 0;
  const apiOffsets = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('authorization'), null);
    if (url.origin === 'https://www.sephora.com') {
      bootstrapCalls++;
      assert.equal(url.pathname, '/');
      assert.equal(headers.get('accept').startsWith('text/html'), true);
      return htmlResponse(bootstrapHtml);
    }
    assert.equal(url.origin, 'https://api.bazaarvoice.com');
    assert.equal(url.pathname, '/data/reviews.json');
    assert.deepEqual(url.searchParams.getAll('Filter'), ['ProductId:P12345', 'contentlocale:en*']);
    assert.equal(url.searchParams.get('Limit'), '2');
    assert.equal(url.searchParams.get('Include'), 'Products,Comments');
    assert.equal(url.searchParams.get('Stats'), 'Reviews');
    assert.equal(url.searchParams.get('passkey'), PUBLIC_TEST_KEY);
    assert.equal(url.searchParams.get('apiversion'), '5.4');
    assert.equal(url.searchParams.get('Locale'), 'en_US');
    const offset = Number(url.searchParams.get('Offset'));
    assert.ok(offsets.includes(offset));
    apiOffsets.push(offset);
    const body = fixturePage(offset);
    if (mutateReview) mutateReview(body, offset);
    return jsonResponse(body);
  };
  return { fetchImpl, apiOffsets, getBootstrapCalls: () => bootstrapCalls };
}

test('anonymous review API bootstraps the public key in memory and returns family-bound body/rating/date/photos', async () => {
  const fake = publicFetch({ offsets: [0] });
  const client = createSephoraReviewsClient({ fetchImpl: fake.fetchImpl,
    now: () => Date.parse('2026-10-05T00:00:00Z') });
  const result = await client.getReviews({ productId: 'P12345', page: 1, pageSize: 2 });

  assert.equal(fake.getBootstrapCalls(), 1);
  assert.deepEqual(fake.apiOffsets, [0]);
  assert.equal(result.productIdMatched, true);
  assert.equal(result.sourceFilter, 'ProductId:P12345');
  assert.equal(result.totalReviews, 3);
  assert.equal(result.reviews.length, 2);
  assert.equal(result.reviews[0].reviewId, '101');
  assert.equal(result.reviews[0].productId, 'P12345');
  assert.equal(result.reviews[0].variantId, '900001');
  assert.equal(result.reviews[0].body, 'A public product review.');
  assert.equal(result.reviews[0].rating, 5);
  assert.equal(result.reviews[0].postedAt, '2026-10-04T18:39:58.000Z');
  assert.deepEqual(result.reviews[0].images, [{
    url: 'https://photos-us.bazaarvoice.com/photo/img-1/large',
    thumbnailUrl: 'https://photos-us.bazaarvoice.com/photo/img-1/thumb',
    caption: 'Photo caption',
  }]);
  assert.equal(result.reviews[0].UserNickname, undefined);
  assert.equal(result.reviews[0].AuthorId, undefined);
  assert.equal(result.pagination.verified, true);
  assert.equal(result.pagination.hasMore, true);
  assert.equal(result.pagination.nextPage, 2);
  assert.equal(result.receipt.request.httpStatus, 200);
  assert.equal(result.receipt.capabilityId, 'catalog.reviews.read');
  assert.equal(result.receipt.publicKeyBootstrap.httpStatus, 200);
  assert.equal(result.receipt.publicApiKeyUsed, true);
  assert.equal(result.receipt.publicApiKeyPersisted, false);
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(JSON.stringify(result).includes(PUBLIC_TEST_KEY), false);
});

test('anonymous review pagination verifies the final partial page and reuses only in-memory bootstrap state', async () => {
  const fake = publicFetch();
  const client = createSephoraReviewsClient({ fetchImpl: fake.fetchImpl });
  const first = await client.getReviews({ productId: 'P12345', page: 1, pageSize: 2 });
  const last = await client.getReviews({ productId: 'P12345', page: 2, pageSize: 2 });
  assert.deepEqual(fake.apiOffsets, [0, 2]);
  assert.equal(fake.getBootstrapCalls(), 1);
  assert.equal(first.pagination.hasMore, true);
  assert.equal(first.pagination.nextPage, 2);
  assert.equal(last.reviews.length, 1);
  assert.equal(last.pagination.totalReviews, 3);
  assert.equal(last.pagination.hasMore, false);
  assert.equal(last.pagination.nextPage, null);
  assert.equal(last.pagination.verified, true);
  assert.equal(last.receipt.capabilityId, 'catalog.reviews.pagination');
});

test('reviews reject unsafe identifiers, wrong product families, malformed pages, and invalid public config', async () => {
  let calls = 0;
  const noCalls = createSephoraReviewsClient({ fetchImpl: async () => { calls++; throw new Error('unexpected request'); } });
  for (const args of [
    {}, { productId: 'not-a-product' }, { productId: 'P12345', skuId: '../sku' },
    { productId: 'P12345', page: 0 }, { productId: 'P12345', pageSize: 101 },
    { productId: 'P12345', countryCode: 'CA' },
  ]) await assert.rejects(noCalls.getReviews(args), { code: 'SEPHORA_REVIEW_INPUT_INVALID' });
  assert.equal(calls, 0);

  const mismatch = createSephoraReviewsClient({ fetchImpl: publicFetch({ offsets: [0], mutateReview: data => {
    data.Includes.Products['900001'].Attributes.BV_FE_FAMILY.Values[0].Value = 'P99999';
  } }).fetchImpl });
  await assert.rejects(mismatch.getReviews({ productId: 'P12345', pageSize: 2 }), {
    code: 'SEPHORA_REVIEW_IDENTITY_MISMATCH',
  });

  const badConfig = createSephoraReviewsClient({ fetchImpl: publicFetch({ offsets: [0],
    bootstrapHtml: '<html>no review config</html>' }).fetchImpl });
  await assert.rejects(badConfig.getReviews({ productId: 'P12345', pageSize: 2 }), {
    code: 'SEPHORA_REVIEW_CONFIG_MISSING',
  });
});

test('SKU-filtered reviews preserve the native ProductId filter and exclude product-family reviews', async () => {
  let calls = 0;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), null);
    if (url.origin === 'https://www.sephora.com') return htmlResponse(bootstrap(PUBLIC_TEST_KEY));
    calls++;
    assert.deepEqual(url.searchParams.getAll('Filter'), ['ProductId:900001', 'contentlocale:en*']);
    assert.equal(url.searchParams.get('ExcludeFamily'), 'True');
    const payload = fixturePage(0);
    payload.Results = [payload.Results[0]];
    payload.TotalResults = 1;
    payload.Limit = 2;
    payload.Offset = 0;
    return jsonResponse(payload);
  };
  const result = await createSephoraReviewsClient({ fetchImpl })
    .getReviews({ productId: 'P12345', skuId: '900001', pageSize: 2 });
  assert.equal(calls, 1);
  assert.equal(result.sourceFilter, 'ProductId:900001;ExcludeFamily:True');
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].variantId, '900001');
  assert.equal(result.pagination.hasMore, false);
});

test('rating-only entries keep an empty body instead of inventing review text', async () => {
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.origin === 'https://www.sephora.com') return htmlResponse(bootstrap(PUBLIC_TEST_KEY));
    const payload = fixturePage(0);
    payload.TotalResults = 1;
    payload.Results = [{ ...payload.Results[0], ReviewText: null, IsRatingsOnly: true }];
    payload.Includes.Products = { '900001': payload.Includes.Products['900001'] };
    return jsonResponse(payload);
  };
  const result = await createSephoraReviewsClient({ fetchImpl })
    .getReviews({ productId: 'P12345', page: 1, pageSize: 2 });
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].body, '');
  assert.equal(result.reviews[0].bodyAvailable, false);
  assert.equal(result.reviews[0].isRatingsOnly, true);
  assert.equal(result.pagination.verified, true);
});
