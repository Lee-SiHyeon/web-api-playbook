import assert from "node:assert/strict";
import test from "node:test";
import { AdpickClient } from "../src/client.js";
import { affiliateLocation, boxPage, nativeSource, parseBanners, parseMedia } from "../src/tools.js";

const BANNER_ROW = `
<li class="table-tr">
<form action="?ac=tools&tac=banner&md=modify&code=10&page=1">
<input type="hidden" name="url" value="https://deg.kr/c/10">
<option value="rand" selected>캠페인 랜덤 노출</option>
</form>
<div class="td second"><a href="https://www.adpick.co.kr/?ac=guide" target=_blank>안내 </a></div>
<span class="label">클릭</span> 0
<span class="label">등록일</span> 2026. 10. 12
<span class="label">링크</span>
<a href="https://deg.kr/c/10" target=_blank>https://deg.kr/c/10</a>
</li>`;

test("banner row keeps the campaign, source, and short link", () => {
  const [item] = parseBanners(BANNER_ROW);
  assert.equal(item.code, "10");
  assert.equal(item.offer, "rand");
  assert.equal(item.sourceTitle, "안내");
  assert.equal(item.clicks, "0");
  assert.equal(item.link, "https://deg.kr/c/10");
});

test("shopbox posts the observed save fields", async () => {
  let seen;
  const client = new AdpickClient({
    fetchImpl: async (_url, options) => {
      seen = options;
      return new Response(JSON.stringify({ ret: "success", msg: "ok" }), { status: 200 });
    },
  });
  const result = await client.saveShopbox({ title: "핫딜", category: "hot", listnum: "6", style: "list" });
  assert.equal(result.outcome, "saved");
  assert.equal(seen.headers["X-Requested-With"], "XMLHttpRequest");
  assert.equal(seen.body.get("md"), "save");
  assert.equal(seen.body.get("category"), "hot");
  assert.equal(seen.body.get("listnum"), "6");
});

test("native source uses the affid argument and popup types force one item", () => {
  const source = nativeSource({ affid: "abc123", bannerType: "type12", limit: 4 });
  assert.equal(source.popup, true);
  assert.equal(source.limit, 1);
  assert.match(source.html, /affid=abc123/);
  assert.match(source.html, /bannerType=type12/);
  assert.match(source.html, /data-adpick_nativeAD_popup="true"/);
  assert.match(source.html, /nativeAD\/script\.js/);
});

test("box page uses the affid only as the path", () => {
  assert.equal(boxPage("shopbox", "abc123"), "https://deg.kr/shopbox/abc123");
  assert.equal(boxPage("appbox", ""), "");
});

test("affiliate redirect allows only the short-link hosts", () => {
  assert.equal(affiliateLocation("https://deg.kr/c/10"), "https://deg.kr/c/10");
  assert.equal(affiliateLocation("https://bitl.bz/abc"), "https://bitl.bz/abc");
  assert.equal(affiliateLocation("https://deg.kr/cps/click.php?apikey=secret&url=https%3A%2F%2Fexample.com"), "");
  assert.equal(affiliateLocation("https://evil.example/out"), "");
});

test("media list reads the card text", () => {
  const html = `<span class="label">내 매체</span><span class="num">1 개</span>
<li><span class="subject"><a href="javascript:void bookmark('blog_1');"><span class="type_blog">블로그</span></a>
<span class="txt-title">네이버 - <a href="https://blog.example/me" target="_blank">일기</a></span>
<span class="label">팔로워</span> 1 ~ 50명 <span class="label">갱신일</span> 11분 전
<a href="?ac=tools&tac=media&md=reg&code=9">수정</a></span></li>`;
  const parsed = parseMedia(html);
  assert.equal(parsed.count, "1");
  assert.equal(parsed.items[0].kind, "blog");
  assert.equal(parsed.items[0].url, "https://blog.example/me");
  assert.equal(parsed.items[0].code, "9");
  assert.equal(parsed.items[0].followers, "1 ~ 50명");
});
