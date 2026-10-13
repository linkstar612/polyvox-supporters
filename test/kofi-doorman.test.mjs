// worker/kofi-doorman.js, against a fake GitHub.
//
// What this pins: the dispatch carries the payment time in UTC, with `month`
// cut from the same string, so the ledger can never hold an `at` outside its
// month. A missing timestamp falls back to the arrival time for both.

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import doorman, { stripeSigned } from "../worker/kofi-doorman.js";

const ENV = { KOFI_TOKEN: "tok", GH_TOKEN: "gh", GH_REPO: "owner/repo" };

async function deliver(event) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, payload: JSON.parse(init.body).client_payload });
    return new Response(null, { status: 204 });
  };
  try {
    const form = new FormData();
    form.set(
      "data",
      JSON.stringify({
        verification_token: "tok",
        type: "Donation",
        kofi_transaction_id: "t1",
        amount: "5.00",
        currency: "USD",
        is_public: true,
        from_name: "Wen",
        ...event,
      }),
    );
    const res = await doorman.fetch(
      new Request("https://doorman.example/", { method: "POST", body: form }),
      ENV,
    );
    return { status: res.status, sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the dispatch carries the payment time, and the month is cut from it", async () => {
  const { status, sent } = await deliver({ timestamp: "2026-10-01T00:04:30Z" });
  assert.equal(status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.at, "2026-10-01T00:04:30.000Z");
  assert.equal(sent[0].payload.month, "2026-10");
  assert.equal(sent[0].payload.id, "kofi:t1");
});

test("no timestamp falls back to the arrival time for both fields", async () => {
  const before = Date.now();
  const { sent } = await deliver({ timestamp: undefined });
  const at = Date.parse(sent[0].payload.at);
  assert.ok(at >= before && at <= Date.now());
  assert.equal(sent[0].payload.month, sent[0].payload.at.slice(0, 7));
});

test("the donor's email never leaves the Worker", async () => {
  const { sent } = await deliver({ timestamp: "2026-10-01T00:04:30Z", email: "a@b.example" });
  assert.equal(JSON.stringify(sent[0].payload).includes("a@b.example"), false);
});

// --- /stripe: the doorbell ---------------------------------------------------
//
// What this pins: only a correctly signed, fresh Stripe event of a paid kind
// rings, and the ring carries nothing from the event. The donor's email is in
// every checkout event Stripe sends; the dispatch body must never hold it.

const SECRET = "whsec_test";
const STRIPE_ENV = { ...ENV, STRIPE_WEBHOOK_SECRET: SECRET };

const sign = (body, t, secret = SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

async function ring({ type = "checkout.session.completed", header, env = STRIPE_ENV, t } = {}) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  try {
    const body = JSON.stringify({
      type,
      data: { object: { customer_details: { email: "a@b.example", name: "Somebody" } } },
    });
    const now = t ?? Math.floor(Date.now() / 1000);
    const res = await doorman.fetch(
      new Request("https://doorman.example/stripe", {
        method: "POST",
        headers: { "stripe-signature": header ?? sign(body, now) },
        body,
      }),
      env,
    );
    return { status: res.status, sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a signed paid checkout rings the aggregator and forwards nothing", async () => {
  const { status, sent } = await ring();
  assert.equal(status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.github.com/repos/owner/repo/dispatches");
  assert.deepEqual(sent[0].body, { event_type: "stripe-payment" });
});

test("renewals, delayed payments and thin v1. events ring too", async () => {
  for (const type of [
    "invoice.paid",
    "checkout.session.async_payment_succeeded",
    "v1.checkout.session.completed",
    "v1.invoice.paid",
  ]) {
    const { sent } = await ring({ type });
    assert.equal(sent.length, 1, type);
  }
});

test("an unsigned, forged or stale request rings nothing", async () => {
  const forged = await ring({ header: "t=1,v1=00" });
  assert.equal(forged.status, 400);
  assert.equal(forged.sent.length, 0);

  const wrongKey = await ring({ header: sign("{}", Math.floor(Date.now() / 1000), "whsec_other") });
  assert.equal(wrongKey.status, 400);

  const stale = await ring({ t: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(stale.status, 400);
  assert.equal(stale.sent.length, 0);
});

test("other event types are acknowledged and ignored", async () => {
  for (const type of ["v1.checkout.session.expired", "v2.core.event_destination.ping"]) {
    const thin = await ring({ type });
    assert.equal(thin.sent.length, 0, type);
  }
  const { status, sent } = await ring({ type: "charge.refunded" });
  assert.equal(status, 200);
  assert.equal(sent.length, 0);
});

test("no signing secret answers 503 so Stripe retries", async () => {
  const { status, sent } = await ring({ env: ENV });
  assert.equal(status, 503);
  assert.equal(sent.length, 0);
});

test("any one v1 matching is enough while a secret is rolled", async () => {
  const body = "{}";
  const t = Math.floor(Date.now() / 1000);
  const header = `${sign(body, t, "whsec_old")},v1=${sign(body, t).split("v1=")[1]}`;
  assert.equal(await stripeSigned(body, header, SECRET), true);
  assert.equal(await stripeSigned(body, sign(body, t, "whsec_old"), SECRET), false);
});
