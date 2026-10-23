import assert from "node:assert/strict";
import test from "node:test";
import { AdpickError } from "../src/client.js";
import { AdpickSdk } from "../src/sdk.js";

test("sdk reads the key and affid only from the constructor", async () => {
  const seen = [];
  const sdk = new AdpickSdk({
    apiKey: "test-key",
    affid: "abc123",
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify([{ apOffer: "x" }]), { status: 200 });
    },
  });
  const offers = await sdk.offers({ order: "randone" });
  assert.equal(offers.json[0].apOffer, "x");
  const called = new URL(seen[0]);
  assert.equal(called.hostname, "adpick.co.kr");
  assert.equal(called.pathname, "/apis/offers.php");
  assert.equal(called.searchParams.get("affid"), "abc123");
  assert.equal(called.searchParams.get("order"), "randone");
  assert.equal(called.searchParams.has("os"), false);
});

test("profit link calls deg.kr with print=1 and does not echo the key in errors", async () => {
  const sdk = new AdpickSdk({
    apiKey: "secret-key",
    fetchImpl: async (url) => {
      const current = new URL(url);
      assert.equal(current.hostname, "deg.kr");
      assert.equal(current.searchParams.get("print"), "1");
      assert.equal(current.searchParams.get("apikey"), "secret-key");
      assert.equal(current.searchParams.get("forceredirect"), "true");
      return new Response(JSON.stringify({ link: "https://deg.kr/example" }), { status: 200 });
    },
  });
  const result = await sdk.profitLink({ url: "https://shop.example/p", forceRedirect: true });
  assert.equal(result.link, "https://deg.kr/example");
  await assert.rejects(() => new AdpickSdk().profitLink({ url: "https://shop.example/p" }), (error) => {
    assert.equal(error.outcome, "provider_missing");
    assert.equal(error instanceof AdpickError, true);
    return true;
  });
});

test("missing affid stops before a request", async () => {
  let called = false;
  const sdk = new AdpickSdk({
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(() => sdk.shopping(), (error) => error.outcome === "provider_missing");
  assert.equal(called, false);
});
