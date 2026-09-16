// worker/donate, against a fake Stripe.
//
// The two mistakes that would cost money or trust are pinned first: an amount
// parsed into the wrong number of cents, and a session minted without the
// wall-name field being optional (which would make every custom donor type a
// name to pay). The rest is the route table.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  handle,
  parseAmount,
  sanitizeRef,
  sessionParams,
} from "../worker/donate/donate.js";

const ORIGIN = "https://polyvox-donate.example.workers.dev";

/** A fetch that answers like Stripe and records the one request it saw. */
function fakeStripe({ status = 200, body = { url: "https://checkout.stripe.com/c/pay/cs_test_1" } } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, params: new URLSearchParams(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { impl, calls };
}

const env = (extra = {}) => ({
  STRIPE_RESTRICTED_KEY: "rk_test_abc",
  DONATE_RL: { limit: async () => ({ success: true }) },
  ...extra,
});

const get = (path, headers = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "GET", headers });

test("parseAmount: whole dollars, one or two decimals, currency noise", () => {
  assert.deepEqual(parseAmount("12"), { cents: 1200 });
  assert.deepEqual(parseAmount("12.5"), { cents: 1250 });
  assert.deepEqual(parseAmount("12.50"), { cents: 1250 });
  assert.deepEqual(parseAmount(" $1,000 "), { cents: 100000 });
  assert.deepEqual(parseAmount("1"), { cents: 100 });
  assert.deepEqual(parseAmount("9999999999.99"), { cents: 999_999_999_999 });
});

test("parseAmount: refuses what a card could not pay or Stripe would reject", () => {
  assert.equal(parseAmount("0.99").error, "below minimum");
  assert.equal(parseAmount("0").error, "below minimum");
  assert.equal(parseAmount("10000000000").error, "above maximum");
  for (const bad of ["", "abc", "-5", "1e3", "12.345", "1 2", null, undefined, "NaN", "Infinity"]) {
    assert.equal(parseAmount(bad).error, "not a number", `${bad}`);
  }
});

test("sanitizeRef: the app's PV- code passes, anything else is dropped", () => {
  assert.equal(sanitizeRef("PV-1A2B3C4D"), "PV-1A2B3C4D");
  assert.equal(sanitizeRef(" PV-1A2B3C4D "), "PV-1A2B3C4D");
  assert.equal(sanitizeRef("a b"), "");
  assert.equal(sanitizeRef("x".repeat(201)), "");
  assert.equal(sanitizeRef("x".repeat(200)), "x".repeat(200));
  assert.equal(sanitizeRef(undefined), "");
  assert.equal(sanitizeRef("<script>"), "");
});

test("sessionParams: one-time donate of exactly the cents, wall name optional", () => {
  const p = sessionParams({ cents: 12345, ref: "PV-ABCD", origin: ORIGIN });
  assert.equal(p.get("mode"), "payment");
  assert.equal(p.get("submit_type"), "donate");
  assert.equal(p.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(p.get("line_items[0][price_data][unit_amount]"), "12345");
  assert.equal(p.get("line_items[0][quantity]"), "1");
  assert.ok(p.get("line_items[0][price_data][product_data][name]"));
  // aggregate.mjs strips non-alphanumerics and compares to "displayname".
  assert.equal(p.get("custom_fields[0][key]").replace(/[^a-z0-9]/g, ""), "displayname");
  assert.equal(p.get("custom_fields[0][type]"), "text");
  assert.equal(p.get("custom_fields[0][optional]"), "true");
  assert.ok(p.get("custom_fields[0][label][custom]").length <= 50);
  assert.equal(p.get("client_reference_id"), "PV-ABCD");
  assert.equal(p.get("success_url"), `${ORIGIN}/thanks`);
});

test("sessionParams: no ref means no client_reference_id at all", () => {
  const p = sessionParams({ cents: 100, ref: "", origin: ORIGIN });
  assert.equal(p.has("client_reference_id"), false);
});

test("GET /?amount mints a session and redirects to it", async () => {
  const stripe = fakeStripe();
  const res = await handle(get("/?amount=250&ref=PV-1A2B3C4D"), env(), stripe.impl);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(stripe.calls.length, 1);
  const { url, init, params } = stripe.calls[0];
  assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer rk_test_abc");
  assert.equal(params.get("line_items[0][price_data][unit_amount]"), "25000");
  assert.equal(params.get("client_reference_id"), "PV-1A2B3C4D");
  assert.equal(params.get("success_url"), `${ORIGIN}/thanks`);
});

test("a bad amount is a 400 and Stripe is never called", async () => {
  const stripe = fakeStripe();
  for (const q of ["", "?amount=0.5", "?amount=abc", "?amount=-3"]) {
    const res = await handle(get(`/${q}`), env(), stripe.impl);
    assert.equal(res.status, 400, q);
  }
  assert.equal(stripe.calls.length, 0);
});

test("no key: 503 on mint and on /health, and Stripe is never called", async () => {
  const stripe = fakeStripe();
  const noKey = env({ STRIPE_RESTRICTED_KEY: undefined });
  assert.equal((await handle(get("/?amount=5"), noKey, stripe.impl)).status, 503);
  assert.equal((await handle(get("/health"), noKey, stripe.impl)).status, 503);
  assert.equal(stripe.calls.length, 0);
});

test("/health is 200 with the key and never touches Stripe", async () => {
  const stripe = fakeStripe();
  const res = await handle(get("/health"), env(), stripe.impl);
  assert.equal(res.status, 200);
  assert.equal(stripe.calls.length, 0);
});

test("/thanks is a page, unknown paths are 404, non-GET is 405", async () => {
  const stripe = fakeStripe();
  const thanks = await handle(get("/thanks"), env(), stripe.impl);
  assert.equal(thanks.status, 200);
  assert.match(thanks.headers.get("content-type"), /text\/html/);
  assert.equal((await handle(get("/nope"), env(), stripe.impl)).status, 404);
  const post = new Request(`${ORIGIN}/?amount=5`, { method: "POST" });
  assert.equal((await handle(post, env(), stripe.impl)).status, 405);
  assert.equal(stripe.calls.length, 0);
});

test("the rate limiter answers 429 and Stripe is never called", async () => {
  const stripe = fakeStripe();
  const keys = [];
  const limited = env({
    DONATE_RL: {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      },
    },
  });
  const res = await handle(
    get("/?amount=5", { "CF-Connecting-IP": "203.0.113.9" }),
    limited,
    stripe.impl,
  );
  assert.equal(res.status, 429);
  assert.deepEqual(keys, ["203.0.113.9"]);
  assert.equal(stripe.calls.length, 0);
});

test("a Stripe refusal or a Stripe outage is a 502, never a redirect", async () => {
  const refused = fakeStripe({ status: 400, body: { error: { message: "no" } } });
  assert.equal((await handle(get("/?amount=5"), env(), refused.impl)).status, 502);
  const down = async () => {
    throw new Error("ECONNRESET");
  };
  assert.equal((await handle(get("/?amount=5"), env(), down)).status, 502);
  const empty = fakeStripe({ body: {} });
  assert.equal((await handle(get("/?amount=5"), env(), empty.impl)).status, 502);
});
