import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { AdpickClient, CrossOriginRedirect } from "../src/client.js";
import { LOGIN_SUCCESS_BODY } from "../src/contract.js";

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("google authorize url keeps the observed query", () => {
  const url = new URL(new AdpickClient().googleAuthorizeUrl());
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/auth");
  assert.equal(url.searchParams.get("state"), "GOOGLE_");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://www.adpick.co.kr/apis/sns-callback.php");
});

test("login success stores only adpick cookies and hides the password", async () => {
  const seen = [];
  const server = await listen((req, res) => {
    seen.push(req.method + " " + req.url);
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      res.setHeader("Set-Cookie", [
        "ADPICK_LOGIN_EVENT=secret-event; Path=/",
        "OTHER=nope; Domain=evil.example; Path=/",
      ]);
      res.end(LOGIN_SUCCESS_BODY);
      assert.equal(new URLSearchParams(raw).get("loginChk"), "on");
      assert.equal(new URLSearchParams(raw).get("captcha_str"), "123456");
    });
  });
  try {
    const client = new AdpickClient({
      fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.port}/login`, options),
    });
    const result = await client.login({
      email: "person@example.com",
      password: "secret-password",
      captcha: "123456",
      captchaCookie: "ADPICK_CAPTCHA=captcha-secret",
    });
    assert.equal(result.outcome, "login_succeeded");
    assert.deepEqual(result.cookieNames.sort(), ["ADPICK_CAPTCHA", "ADPICK_LOGIN_EVENT"]);
    assert.equal(JSON.stringify(result).includes("secret-password"), false);
    assert.equal(JSON.stringify(result).includes("secret-event"), true);
  } finally {
    await server.close();
  }
});

test("cross-origin redirect stops", async () => {
  const server = await listen((req, res) => {
    res.writeHead(302, { Location: "https://evil.example/steal" });
    res.end();
  });
  try {
    const client = new AdpickClient({
      fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.port}/go`, options),
    });
    await assert.rejects(
      () => client.request("https://www.adpick.co.kr/apis/shopping.php"),
      CrossOriginRedirect,
    );
  } finally {
    await server.close();
  }
});

test("product search posts the two observed forms", async () => {
  const bodies = [];
  const client = new AdpickClient({
    fetchImpl: async (url, options) => {
      bodies.push(options.body);
      const payload = bodies.length === 1
        ? { status: "sucsses" }
        : { status: "success", msg: "검색에 성공하였습니다.", total_cnt: "1", list: [{ title: "컵" }], mall_list: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.searchProducts("텀블러", { sort: "rel", page: 1 });
  assert.equal(result.startStatus, "sucsses");
  assert.equal(result.totalCount, "1");
  assert.equal(new URLSearchParams(bodies[0]).get("md"), "search");
  assert.equal(new URLSearchParams(bodies[1]).get("md"), "get_search_result_list");
});

test("product link poll does not send a second create", async () => {
  const calls = [];
  const client = new AdpickClient({
    fetchImpl: async (url, options) => {
      calls.push(`${options.method || "GET"} ${url.pathname || new URL(url).pathname}${url.search || new URL(url).search}`);
      const target = String(url);
      if ((options.method || "GET") === "POST") {
        return new Response(JSON.stringify({ mode: "legacy", time: 10, native_cnt: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 1, listCnt: 1, list: [{ slink: "https://example.invalid/s" }] }), { status: 200 });
    },
  });
  const result = await client.createProductLinks(["https://www.coupang.com/vp/products/1"]);
  assert.equal(result.outcome, "created");
  assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
});

test("campaign html cards are read from the observed markup", async () => {
  const html = "<div>로그아웃</div><div class='item adtype-6' data-offer='abcde'><h5 class='title'>샘플 </h5><span class='point icon-point has-number '>60</span></div>";
  const client = new AdpickClient({
    fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  });
  const result = await client.campaigns({ word: "쇼핑" });
  assert.equal(result.count, 1);
  assert.equal(result.items[0].title, "샘플");
  assert.equal(result.outcome, "listed");
});

test("dashboard without logout is reauth when the login form is present", async () => {
  const client = new AdpickClient({
    fetchImpl: async () => new Response("<form id=\"loginform\"></form>", { status: 200 }),
  });
  const session = await client.session();
  assert.equal(session.outcome, "reauth_required");
});

test("script dashboard responses use the protected link-list schema for session verification", async () => {
  const calls = [];
  const client = new AdpickClient({ cookie: 'remember=fixture', fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), method: options.method });
    return calls.length === 1 ? new Response('<script>/* dashboard navigation */</script>', { status: 200 })
      : new Response(JSON.stringify({ total_all: 1, total_cnt: 1, list: [{ indexno: 'fixture', offer: 'fixture', product_url: 'https://shop.example/product/1' }] }), { status: 200 });
  } });
  const result = await client.session();
  assert.equal(result.outcome, 'authenticated'); assert.equal(result.probe, 'private_link_list');
  assert.equal(calls[1].url.searchParams.get('md'), 'link_list');
  assert.equal(calls.every(call => call.method === 'GET'), true);
});

test("public catalog JSON and rejected private reads never count as an authenticated session", async () => {
  for (const payload of [{ list: [] }, { total_all: '0', total_cnt: '0', list: [] }, '<script>alert("login required")</script>']) {
    let calls = 0;
    const client = new AdpickClient({ cookie: 'remember=fixture', fetchImpl: async () => {
      calls++;
      return new Response(calls === 1 ? '<script>/* dashboard navigation */</script>'
        : typeof payload === 'string' ? payload : JSON.stringify(payload), { status: 200 });
    } });
    assert.equal((await client.session()).outcome, 'auth_unverified');
  }
});
