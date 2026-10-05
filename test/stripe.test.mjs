// Stripe subscription renewals reach the goal their signup funded.
//
// A "Fund monthly" subscription makes one Checkout Session, at signup, and an
// invoice every month after. Before renewals were read, a subscriber counted
// in their first month only. These pin that each renewal counts once, on the
// signup's goal and card, that the signup invoice is never booked a second
// time, and that a renewal nobody can attribute is skipped rather than guessed.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildWall } from "../cards.mjs";
import { goalTotal } from "../goals.mjs";
import { invoiceSubscription, stripeRenewals, stripeSessions } from "../stripe.mjs";

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

/// A fetch that answers each Stripe list endpoint from pages, following
/// `starting_after`, and records every URL it saw.
function fakeStripe({ sessions = [], invoices = [], pageSize = 100 } = {}) {
  const lists = { "checkout/sessions": sessions, invoices };
  const calls = [];
  const impl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const path = u.pathname.replace("/v1/", "");
    const all = lists[path];
    if (!all) return { ok: false, status: 403, text: async () => "forbidden" };
    const after = u.searchParams.get("starting_after");
    const start = after ? all.findIndex((o) => o.id === after) + 1 : 0;
    const data = all.slice(start, start + pageSize);
    return {
      ok: true,
      json: async () => ({ data, has_more: start + pageSize < all.length }),
    };
  };
  impl.calls = calls;
  return impl;
}

const signup = {
  id: "cs_signup",
  mode: "subscription",
  subscription: "sub_known",
  payment_status: "paid",
  payment_link: "plink_living_monthly",
  created: sec("2026-08-14T10:00:00Z"),
  amount_total: 500,
  currency: "usd",
  payment_intent: null,
  client_reference_id: "PV-ABCDEF",
  custom_fields: [{ key: "displayname", text: { value: "Monthly Mia" } }],
};

const oneOff = {
  id: "cs_oneoff",
  mode: "payment",
  payment_status: "paid",
  payment_link: "plink_dev",
  created: sec("2026-09-02T10:00:00Z"),
  amount_total: 2000,
  currency: "usd",
  payment_intent: "pi_oneoff",
  custom_fields: [],
};

const invoice = (id, reason, paidIso, over = {}) => ({
  id,
  billing_reason: reason,
  status: "paid",
  subscription: "sub_known",
  amount_paid: 500,
  currency: "usd",
  created: sec(paidIso) - 3600,
  status_transitions: { paid_at: sec(paidIso) },
  ...over,
});

const INVOICES = [
  // The signup's own invoice: already counted through its session.
  invoice("in_create", "subscription_create", "2026-08-14T10:01:00Z"),
  invoice("in_sep", "subscription_cycle", "2026-09-14T11:00:00Z"),
  invoice("in_oct", "subscription_cycle", "2026-10-14T11:00:00Z"),
  // A manual invoice is not a renewal.
  invoice("in_manual", "manual", "2026-10-02T11:00:00Z", { subscription: null }),
  // A subscription nothing on this account's Checkout Sessions started.
  invoice("in_stranger", "subscription_cycle", "2026-10-03T11:00:00Z", { subscription: "sub_unknown" }),
];

const OPTS = {
  linkToGoal: { plink_living_monthly: "living", plink_dev: "dev_costs" },
  defaultGoal: "living",
};

async function run({ sessions = [signup, oneOff], invoices = INVOICES, pageSize, skipPi } = {}) {
  const fetchImpl = fakeStripe({ sessions, invoices, pageSize });
  const s = await stripeSessions("rk_test", { ...OPTS, skipPi, fetchImpl });
  const r = await stripeRenewals("rk_test", s.bySubscription, { skipPi, fetchImpl });
  return { ...s, renewals: r, fetchImpl };
}

test("a signup plus two renewals counts three payments, once each", async () => {
  const { entries, renewals } = await run();
  assert.deepEqual(entries.map((e) => e.id), ["stripe:cs_signup", "stripe:cs_oneoff"]);
  assert.deepEqual(renewals.entries.map((e) => e.id), ["stripe-inv:in_sep", "stripe-inv:in_oct"]);
  for (const r of renewals.entries) {
    assert.equal(r.goal, "living");
    assert.equal(r.name, "Monthly Mia");
    assert.equal(r.client_reference_id, "PV-ABCDEF");
    assert.equal(r.recurring, true);
    assert.equal(r.platform, "stripe");
    assert.equal(r.amount, 5);
    assert.equal(r.currency, "USD");
  }
});

test("a renewal is timed by when it was paid", async () => {
  const { renewals } = await run();
  const oct = renewals.entries.find((e) => e.id === "stripe-inv:in_oct");
  assert.equal(oct.at, "2026-10-14T11:00:00.000Z");
  assert.equal(oct.month, "2026-10");
});

test("the monthly goal counts only this month's renewal", async () => {
  const { entries, renewals } = await run();
  const records = [...entries, ...renewals.entries].map((e) => ({ ...e, usd: e.amount }));
  const living = { id: "living", kind: "monthly" };
  assert.equal(goalTotal(living, records, { nowMs: Date.parse("2026-10-20T00:00:00Z") }), 5);
  assert.equal(goalTotal(living, records, { nowMs: Date.parse("2026-08-20T00:00:00Z") }), 5);
  assert.equal(goalTotal(living, records, { nowMs: Date.parse("2026-11-20T00:00:00Z") }), 0);
  // The one-off on another goal never leaks into the monthly one.
  assert.equal(goalTotal({ id: "dev_costs" }, records), 20);
});

test("renewals add months to the subscriber's one card", async () => {
  const { entries, renewals } = await run();
  const records = [...entries, ...renewals.entries].map((e) => ({ ...e, usd: e.amount }));
  const wall = buildWall(records, []);
  assert.equal(wall.length, 1);
  assert.deepEqual(Object.keys(wall[0].months), ["2026-08", "2026-09", "2026-10"]);
});

test("a renewal with no known subscription is skipped and counted", async () => {
  const { renewals } = await run();
  assert.equal(renewals.skipped, 1);
  assert.ok(!renewals.entries.some((e) => e.id === "stripe-inv:in_stranger"));
});

test("both pages of sessions and invoices are read", async () => {
  const { entries, renewals, fetchImpl } = await run({ pageSize: 2 });
  assert.equal(entries.length, 2);
  assert.equal(renewals.entries.length, 2);
  assert.equal(renewals.skipped, 1);
  const invoiceCalls = fetchImpl.calls.filter((u) => u.pathname === "/v1/invoices");
  assert.equal(invoiceCalls.length, 3);
  assert.deepEqual(
    invoiceCalls.map((u) => u.searchParams.get("starting_after")),
    [null, "in_sep", "in_manual"],
  );
  for (const u of invoiceCalls) {
    assert.equal(u.searchParams.get("status"), "paid");
    assert.equal(u.searchParams.get("created[gte]"), String(signup.created));
  }
});

test("no subscription signup means no invoice read at all", async () => {
  const { renewals, fetchImpl } = await run({ sessions: [oneOff] });
  assert.equal(renewals.entries.length, 0);
  assert.ok(!fetchImpl.calls.some((u) => u.pathname === "/v1/invoices"));
});

test("a hand-recorded PaymentIntent is skipped on both paths", async () => {
  const invoices = [
    invoice("in_sep", "subscription_cycle", "2026-09-14T11:00:00Z", { payment_intent: "pi_hand" }),
    invoice("in_oct", "subscription_cycle", "2026-10-14T11:00:00Z"),
  ];
  const { entries, renewals } = await run({ invoices, skipPi: new Set(["pi_oneoff", "pi_hand"]) });
  assert.deepEqual(entries.map((e) => e.id), ["stripe:cs_signup"]);
  assert.deepEqual(renewals.entries.map((e) => e.id), ["stripe-inv:in_oct"]);
});

test("a hand-recorded signup still attributes its renewals", async () => {
  const hand = { ...signup, payment_intent: "pi_signup" };
  const { entries, renewals } = await run({ sessions: [hand], skipPi: new Set(["pi_signup"]) });
  assert.equal(entries.length, 0);
  assert.equal(renewals.entries.length, 2);
});

test("the subscription id is read on either side of the 2025-03-31 API change", () => {
  assert.equal(invoiceSubscription({ subscription: "sub_a" }), "sub_a");
  assert.equal(invoiceSubscription({ subscription: { id: "sub_b" } }), "sub_b");
  assert.equal(
    invoiceSubscription({ parent: { subscription_details: { subscription: "sub_c" } } }),
    "sub_c",
  );
  assert.equal(invoiceSubscription({}), "");
});

test("a zero-decimal renewal is not divided by 100", async () => {
  const yen = { ...signup, currency: "jpy", amount_total: 800 };
  const invoices = [invoice("in_jpy", "subscription_cycle", "2026-09-14T11:00:00Z", { currency: "jpy", amount_paid: 800 })];
  const { renewals } = await run({ sessions: [yen], invoices });
  assert.equal(renewals.entries[0].amount, 800);
  assert.equal(renewals.entries[0].currency, "JPY");
});
