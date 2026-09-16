// custom-amount.mjs: the manifest carries the minter's URL only while the
// minter is configured. Pins both directions, because the failure that
// matters is a `custom_url` that survives a revoked key.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DONATE_MIN_USD,
  DONATE_URL,
  donateHealthy,
  publishCustomAmount,
} from "../custom-amount.mjs";

const links = () => [
  { platform: "kofi", url: "https://ko-fi.com/x" },
  { platform: "stripe", url: "https://buy.stripe.com/a", tiers: [{ amount_usd: 5, url: "u" }] },
];

test("healthy: the Stripe link gains custom_url and custom_min_usd", () => {
  const l = links();
  const touched = publishCustomAmount(l, { healthy: true });
  assert.equal(touched.platform, "stripe");
  assert.equal(l[1].custom_url, DONATE_URL);
  assert.equal(l[1].custom_min_usd, DONATE_MIN_USD);
  assert.equal("custom_url" in l[0], false);
});

test("unhealthy: a previously published custom_url is removed", () => {
  const l = links();
  l[1].custom_url = DONATE_URL;
  l[1].custom_min_usd = 1;
  publishCustomAmount(l, { healthy: false });
  assert.equal("custom_url" in l[1], false);
  assert.equal("custom_min_usd" in l[1], false);
});

test("no Stripe link: nothing to publish on, nothing thrown", () => {
  assert.equal(publishCustomAmount([{ platform: "kofi", url: "k" }], { healthy: true }), null);
  assert.equal(publishCustomAmount(undefined, { healthy: true }), null);
});

test("donateHealthy is true only on a 200 from /health", async () => {
  const seen = [];
  const answer = (status) => async (url) => {
    seen.push(url);
    return { status };
  };
  assert.equal(await donateHealthy(answer(200)), true);
  assert.equal(await donateHealthy(answer(503)), false);
  assert.equal(await donateHealthy(answer(404)), false);
  const down = async () => {
    throw new Error("ENOTFOUND");
  };
  assert.equal(await donateHealthy(down), false);
  assert.equal(seen[0], `${DONATE_URL}/health`);
});
