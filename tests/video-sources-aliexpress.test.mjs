import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyMtopRet, mtopSign, mtopToken, parseMtopBody } from '../lib/video-sources/mtop-h5.mjs';
import { createAliExpressMediaClient, createAliExpressSessionState, parseAliExpressPdpMedia } from '../lib/video-sources/aliexpress-media.mjs';
import { downloadMedia } from '../lib/video-sources/media-download.mjs';
import { readCdpCookies, createCdpPageFetcher } from '../lib/video-sources/cdp-cookies.mjs';

const PID = '1005013075520990';
const playUrl = 'https://video.aliexpress-media.com/play/u/ae_sg_item/2215427586775/p/1/e/6/t/10301/5000512850330.mp4';
const result = {
  PRODUCT_TITLE: { text: '  IRIN PJ88C   접이식 디지털 피아노 ' },
  HEADER_IMAGE_PC: {
    imagePathList: ['https://ae-pic-a1.aliexpress-media.com/kf/A.jpg', 'https://evil.example/x.jpg', '//ae-pic-a1.aliexpress-media.com/kf/B.jpg'],
    productVideo: { posterUrl: 'https://ae-pic-a1.aliexpress-media.com/kf/P.jpg', videoId: 5000512850330,
      videoPlayInfo: { webUrl: playUrl, androidPhoneUrl: playUrl } },
  },
  SHOP_CARD_PC: { licenseInfo: { actionTarget: 'https://shoprenderview.aliexpress.com/credential/showcredential.htm?storeNum=1102638446&_lang=ko_KR' },
    benefitInfoList: [{ title: '#  180 일 만에 개 판매', value: '20,000+' }, { title: '좋아요 누름', value: '95.3%' }] },
};

test('mtop sign is md5(token&t&appKey&data) and token is the _m_h5_tk prefix', () => {
  const token = mtopToken('0123456789abcdef0123456789abcdef_1792234094258');
  assert.equal(token, '0123456789abcdef0123456789abcdef');
  assert.equal(mtopToken('not-a-token'), '');
  const data = '{"productId":"1"}';
  assert.equal(mtopSign({ token, t: '1792234094258', appKey: '12574478', data }),
    createHash('md5').update(`${token}&1792234094258&12574478&${data}`).digest('hex'));
  assert.throws(() => mtopSign({ token, t: 'x', appKey: '12574478', data }), { code: 'MTOP_SIGN_INPUT_INVALID' });
});

test('classifies observed MTOP ret codes and parses JSONP', () => {
  assert.equal(classifyMtopRet(['SUCCESS::调用成功']), 'success');
  assert.equal(classifyMtopRet(['FAIL_SYS_TOKEN_EXOIRED::令牌过期']), 'token_refresh');
  assert.equal(classifyMtopRet(['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试']), 'challenge');
  assert.equal(classifyMtopRet(['FAIL_BIZ_X::y']), 'error');
  assert.deepEqual(parseMtopBody('mtopjsonp1({"ret":["SUCCESS::ok"]})'), { ret: ['SUCCESS::ok'] });
  assert.equal(parseMtopBody('<html>'), null);
});

test('parses product video, first-party images and store signals only', () => {
  const media = parseAliExpressPdpMedia(result, PID);
  assert.equal(media.title, 'IRIN PJ88C 접이식 디지털 피아노');
  assert.deepEqual(media.video, { videoId: '5000512850330', playUrl, posterUrl: 'https://ae-pic-a1.aliexpress-media.com/kf/P.jpg',
    uploaderAccountId: '2215427586775', kind: 'seller_product_video' });
  assert.deepEqual(media.images, ['https://ae-pic-a1.aliexpress-media.com/kf/A.jpg', 'https://ae-pic-a1.aliexpress-media.com/kf/B.jpg']);
  assert.equal(media.store.storeNum, '1102638446');
  assert.equal(media.store.signals[0].label, '# 180 일 만에 개 판매');
  const noVideo = parseAliExpressPdpMedia({ ...result, HEADER_IMAGE_PC: { productVideo: { videoId: 1, videoPlayInfo: { webUrl: 'https://evil.example/v.mp4' } } } }, PID);
  assert.equal(noVideo.video, null);
  assert.equal(noVideo.hasVideo, false);
});

test('session import keeps only AliExpress cookies and requires the MTOP token pair', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/158.0.0.0';
  const cookies = [{ name: '_m_h5_tk', value: '0123456789abcdef0123456789abcdef_1', domain: '.aliexpress.com', path: '/' },
    { name: '_m_h5_tk_enc', value: 'e', domain: '.aliexpress.com', path: '/' }, { name: 'cna', value: 'c', domain: '.aliexpress.com', path: '/' },
    { name: 'NID', value: 'x', domain: '.google.com', path: '/' }];
  const state = createAliExpressSessionState(cookies, { userAgent: ua });
  assert.deepEqual(state.cookies.map(c => c.name), ['_m_h5_tk', '_m_h5_tk_enc', 'cna']);
  assert.throws(() => createAliExpressSessionState(cookies.slice(1), { userAgent: ua }), { code: 'ALIEXPRESS_SESSION_COOKIES_MISSING' });
});

function fakeTransport(responses) {
  const sent = [];
  return { sent, kind: 'test', async token() { return '0123456789abcdef0123456789abcdef'; },
    async send(url) { sent.push(new URL(url)); return responses.shift(); }, async afterSuccess() {} };
}

test('client re-signs once on token rotation, then returns parsed media with a receipt', async () => {
  let clock = 1_792_234_094_258;
  const transport = fakeTransport([
    { status: 200, raw: JSON.stringify({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] }) },
    { status: 200, raw: JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { result } }) },
  ]);
  const media = await createAliExpressMediaClient({ transport, now: () => (clock += 3000), minIntervalMs: 0 }).getProductMedia({ productId: PID });
  assert.equal(transport.sent.length, 2);
  const q = transport.sent[1].searchParams;
  assert.equal(transport.sent[1].origin + transport.sent[1].pathname, 'https://acs.aliexpress.com/h5/mtop.aliexpress.pdp.pc.query/1.0/');
  assert.equal(q.get('appKey'), '12574478');
  assert.equal(q.get('sign'), mtopSign({ token: '0123456789abcdef0123456789abcdef', t: q.get('t'), appKey: '12574478', data: q.get('data') }));
  assert.equal(JSON.parse(q.get('data')).productId, PID);
  assert.equal(media.video.videoId, '5000512850330');
  assert.deepEqual(media.receipt.attempts.map(a => a.verdict), ['token_refresh', 'success']);
});

test('client stops on an anti-bot challenge without retrying', async () => {
  const transport = fakeTransport([{ status: 200, raw: JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM'] }) },
    { status: 200, raw: '{}' }]);
  await assert.rejects(createAliExpressMediaClient({ transport, minIntervalMs: 0 }).getProductMedia({ productId: PID }),
    error => error.code === 'ALIEXPRESS_CHALLENGE_REQUIRED' && error.receipt.attempts.length === 1);
  assert.equal(transport.sent.length, 1);
  await assert.rejects(createAliExpressMediaClient({ transport, minIntervalMs: 0 }).getProductMedia({ productId: '12' }),
    { code: 'ALIEXPRESS_INPUT_INVALID' });
});

test('download writes the file plus a provenance sidecar and enforces host, mime and size', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  const bytes = new Uint8Array(4096).fill(7);
  const fetchImpl = async url => {
    const response = new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': '4096' } });
    Object.defineProperty(response, 'url', { value: url.replace('video.aliexpress-media.com', 'gv-vod-cdn.aliexpress-media.com') });
    return response;
  };
  const provenance = { sourcePlatform: 'aliexpress', sourceUrl: `https://ko.aliexpress.com/item/${PID}.html`, rightsBasis: 'seller_product_video_unverified' };
  const hosts = ['video.aliexpress-media.com', 'gv-vod-cdn.aliexpress-media.com'];
  const saved = await downloadMedia({ url: playUrl, outDir: dir, fileStem: 'clip', allowedHosts: hosts, provenance, fetchImpl, now: () => 0 });
  assert.equal(saved.bytes, 4096);
  assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'));
  const sidecar = JSON.parse(readFileSync(path.join(dir, 'clip.mp4.provenance.json'), 'utf8'));
  assert.equal(sidecar.reuseNote, 'third_party_work_verify_rights_before_publishing');
  await assert.rejects(downloadMedia({ url: playUrl, outDir: dir, fileStem: 'clip', allowedHosts: hosts, provenance, fetchImpl }), { code: 'MEDIA_TARGET_EXISTS' });
  await assert.rejects(downloadMedia({ url: playUrl, outDir: dir, fileStem: 'b', allowedHosts: ['video.aliexpress-media.com'], provenance, fetchImpl }),
    { code: 'MEDIA_REDIRECT_HOST_NOT_ALLOWED' });
  await assert.rejects(downloadMedia({ url: playUrl, outDir: dir, fileStem: 'c', allowedHosts: hosts, provenance: { ...provenance, rightsBasis: 'trust_me' }, fetchImpl }),
    { code: 'MEDIA_PROVENANCE_REQUIRED' });
  await assert.rejects(downloadMedia({ url: playUrl, outDir: dir, fileStem: 'd', allowedHosts: hosts, provenance, fetchImpl, maxBytes: 2048 }),
    { code: 'MEDIA_TOO_LARGE' });
  assert.equal(existsSync(path.join(dir, 'd.mp4')), false);
});

test('CDP helpers only talk to loopback endpoints and allowed request origins', async () => {
  await assert.rejects(readCdpCookies({ endpoint: 'http://10.0.0.5:9333', domainFilter: /x/ }), { code: 'CDP_ENDPOINT_NOT_LOOPBACK' });
  const fetcher = createCdpPageFetcher({ pageOrigin: 'https://ko.aliexpress.com', allowedRequestOrigins: ['https://acs.aliexpress.com'],
    fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(fetcher.fetchText('https://evil.example/x'), { code: 'CDP_REQUEST_ORIGIN_NOT_ALLOWED' });
});

// ---- 1688 ----
import { extractJsonObjectAfter, parse1688OfferDetail, parse1688SearchItems } from '../lib/video-sources/alibaba-1688.mjs';

test('1688 search items: strips highlight tags and keeps typed numbers', () => {
  const body = { data: { data: { OFFER: { items: [
    { data: { offerId: '1047106487219', title: '<font color=red>折叠</font>便携钢琴', priceInfo: { price: '129' }, bookedCount: '49',
      offerRepurchaseRate: '38%', offerPicUrl: 'https://cbu01.alicdn.com/img/ibank/O1.jpg' } },
    { data: { offerId: 'x', title: 'bad' } },
  ] } } } };
  assert.deepEqual(parse1688SearchItems(body), [{ offerId: '1047106487219', title: '折叠便携钢琴', priceCny: '129', bookedCount: 49,
    repurchaseRate: '38%', imageUrl: 'https://cbu01.alicdn.com/img/ibank/O1.jpg', offerUrl: 'https://detail.1688.com/offer/1047106487219.html' }]);
  assert.throws(() => parse1688SearchItems({}), { code: 'ALIBABA1688_SEARCH_SCHEMA_INVALID' });
});

test('1688 offer detail: brace-matched video object, images and supplier from server HTML', () => {
  const pad = 'x'.repeat(1200);
  const html = `<html>${pad}<script>window.context=(function(){})();var d={"offerTitle":"工厂批发折叠便携钢琴","mainImage":["https://cbu01.alicdn.com/img/ibank/A!!1-0-cib.jpg","https://cbu01.alicdn.com/img/ibank/B!!1-0-cib.jpg"],`
    + `"video":{"coverUrl":"https://img.alicdn.com/imgextra/i3/6/c.jpg","videoId":418199150043,"state":6,"title":"686弹奏视频 {演示}","videoUrl":"https://cloud.video.taobao.com/play/u/2215570254123/p/2/e/6/t/1/418199150043.mp4"},`
    + `"companyName":"晋江市科乐电子科技有限公司","sellerUserId":2215570254123,"sellerLoginId":"cnyuanle"};</script></html>`;
  const d = parse1688OfferDetail(html, '1047106487219');
  assert.equal(d.title, '工厂批发折叠便携钢琴');
  assert.equal(d.video.videoId, '418199150043');
  assert.equal(d.video.title, '686弹奏视频 {演示}');
  assert.equal(d.video.uploaderUserId, '2215570254123');
  assert.equal(d.images.length, 2);
  assert.deepEqual(d.supplier, { companyName: '晋江市科乐电子科技有限公司', sellerUserId: '2215570254123', sellerLoginId: 'cnyuanle' });
  const none = parse1688OfferDetail(html.replace('"videoId":418199150043', '"videoId":0'), '1');
  assert.equal(none.video, null);
  assert.equal(extractJsonObjectAfter('{"a":1}', 'video'), null);
  assert.throws(() => parse1688OfferDetail(`<html>_____tmd_____ punish x5secdata${pad}</html>`, '1'), { code: 'ALIBABA1688_CHALLENGE_REQUIRED' });
});
