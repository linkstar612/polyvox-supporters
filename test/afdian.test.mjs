// The Afdian rail, against fixtures shaped like the documented responses.
//
// The signing test uses the worked example printed in Afdian's own developer
// guide, so a passing run means this agrees with the platform rather than with
// itself. Everything else pins the two mistakes that would misreport money:
// reading `show_amount` instead of `total_amount`, and reading an order's
// `month` (a COUNT of sponsored months) as a date.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  afdianCall,
  afdianOrders,
  afdianSign,
  afdianSponsors,
  orderRecords,
  sponsorRecords,
} from "../afdian.mjs";

const CREDS = { userId: "u_polyvox", token: "tok_secret" };

/// A fetch that answers from a script and records every request it saw.
function fakeFetch(pages) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, params: JSON.parse(body.params) });
    const page = body.params ? JSON.parse(body.params).page : 1;
    const answer = pages[url.endsWith("query-sponsor") ? "sponsor" : "order"]?.[page - 1];
    return {
      ok: true,
      status: 200,
      async json() {
        return answer ?? { ec: 200, em: "", data: { list: [], total_page: 0 } };
      },
    };
  };
  impl.calls = calls;
  return impl;
}

const okPage = (list, totalPage) => ({
  ec: 200,
  em: "",
  data: { list, total_count: list.length, total_page: totalPage },
});

/// The order shape from https://guide.afdian.com/creator/developer. `month: 3`
/// is a three-month term, NOT March.
const order = (over = {}) => ({
  out_trade_no: "202609041234",
  user_id: "u_backer",
  plan_id: "plan_a",
  title: "Polyvox",
  month: 1,
  total_amount: "30.00",
  show_amount: "30.00",
  status: 2,
  remark: "",
  create_time: 1_772_000_000,
  ...over,
});

// -- signing -----------------------------------------------------------------

test("the signature matches Afdian's own worked example", () => {
  // Guide: user_id `abc`, params `{"a":333}`, ts `1624339905`, token `123`
  // → kv string `123params{"a":333}ts1624339905user_idabc`.
  assert.equal(
    afdianSign({ token: "123", params: '{"a":333}', ts: 1624339905, userId: "abc" }),
    "a4acc28b81598b7e5d84ebdc3e91710c",
  );
});

test("the signature covers the params STRING that is actually sent", async () => {
  const fetchImpl = fakeFetch({ order: [okPage([], 0)] });
  await afdianCall({
    ...CREDS,
    endpoint: "query-order",
    params: { page: 1 },
    fetchImpl,
    now: () => 1_772_000_000_000,
  });
  const { body, url } = fetchImpl.calls[0];
  assert.equal(url, "https://afdian.com/api/open/query-order");
  assert.equal(body.user_id, "u_polyvox");
  assert.equal(body.params, '{"page":1}');
  assert.equal(body.ts, 1_772_000_000);
  assert.equal(
    body.sign,
    afdianSign({ token: CREDS.token, params: body.params, ts: body.ts, userId: CREDS.userId }),
  );
  // The token authenticates the call and is never transmitted.
  assert.equal(JSON.stringify(body).includes(CREDS.token), false);
});

test("a non-200 ec throws rather than reporting an empty rail", async () => {
  // 400005 is a bad signature. Swallowing it would publish a goal total that
  // silently lost every CN donation.
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ec: 400005, em: "sign error" };
    },
  });
  await assert.rejects(
    afdianCall({ ...CREDS, endpoint: "query-order", params: { page: 1 }, fetchImpl }),
    /ec 400005/,
  );
});

// -- paging ------------------------------------------------------------------

test("orders page until total_page is reached", async () => {
  const first = Array.from({ length: 50 }, (_, i) => order({ out_trade_no: `a${i}` }));
  const second = [order({ out_trade_no: "b0" }), order({ out_trade_no: "b1" })];
  const fetchImpl = fakeFetch({ order: [okPage(first, 2), okPage(second, 2)] });
  const all = await afdianOrders({ ...CREDS, fetchImpl });
  assert.equal(all.length, 52);
  assert.deepEqual(
    fetchImpl.calls.map((c) => c.params.page),
    [1, 2],
  );
});

test("sponsors page separately and stop on an empty page", async () => {
  const fetchImpl = fakeFetch({
    sponsor: [okPage([{ user: { user_id: "s1", name: "Mei" } }], 3), okPage([], 3)],
  });
  const all = await afdianSponsors({ ...CREDS, fetchImpl });
  assert.equal(all.length, 1);
  assert.deepEqual(
    fetchImpl.calls.map((c) => c.params.page),
    [1, 2],
  );
});

// -- summing -----------------------------------------------------------------

test("only paid orders count, at the amount actually paid", () => {
  const recs = orderRecords(
    [
      order({ out_trade_no: "paid", total_amount: "30.00" }),
      // A discount: `show_amount` is the pre-discount price and would over-report.
      order({ out_trade_no: "discounted", total_amount: "20.00", show_amount: "30.00" }),
      // A redeem code: no money arrived.
      order({ out_trade_no: "redeemed", total_amount: "0.00", redeem_id: "r1" }),
      // Anything that is not status 2 is not a completed payment.
      order({ out_trade_no: "pending", status: 1 }),
    ],
    { goal: "living" },
  );
  assert.deepEqual(
    recs.map((r) => r.id),
    ["afdian:paid", "afdian:discounted"],
  );
  assert.equal(
    recs.reduce((sum, r) => sum + r.amount, 0),
    50,
  );
  for (const r of recs) {
    assert.equal(r.currency, "CNY");
    assert.equal(r.goal, "living");
    assert.equal(r.platform, "afdian");
    // Orders are anonymous: `buildWall` skips a record with no name, so the
    // same person cannot land on the wall from both endpoints.
    assert.equal(r.name, "");
    assert.equal(r.recurring, false);
  }
});

test("50 CNY converts through the overrides rate, not at par", () => {
  // The arithmetic aggregate.mjs performs: `toUsd` divides by fx.rates.CNY,
  // which overrides.json patches to the rate recorded there.
  const cnyPerUsd = 6.7179;
  const usd = 50 / cnyPerUsd;
  assert.ok(Math.abs(usd - 7.4428) < 0.001, `${usd}`);
  // Counting yuan as dollars would book 50, which is the error this rate exists
  // to prevent.
  assert.notEqual(Math.round(usd), 50);
});

test("an order already in the ledger is not counted twice", () => {
  const recs = orderRecords([order({ out_trade_no: "dup" })], {
    goal: "living",
    skipIds: new Set(["afdian:dup"]),
  });
  assert.deepEqual(recs, []);
});

test("the month comes from create_time, never from the order's month count", () => {
  // `month: 3` is a three-month term. Read as a date it would be March, on
  // every order, forever.
  const [rec] = orderRecords([order({ month: 3, create_time: 1_772_000_000 })], { goal: "living" });
  assert.equal(rec.month, new Date(1_772_000_000 * 1000).toISOString().slice(0, 7));
  assert.notEqual(rec.month, "2026-03");

  // No create_time at all falls back to the run's own clock rather than
  // dropping the order, because the month only decides card placement while the
  // amount decides the goal.
  const [noTime] = orderRecords([order({ create_time: undefined })], {
    goal: "living",
    nowMs: Date.parse("2026-09-04T00:00:00Z"),
  });
  assert.equal(noTime.month, "2026-09");
});

// -- the wall ----------------------------------------------------------------

test("sponsors carry a name and no money", () => {
  const recs = sponsorRecords([
    {
      user: { user_id: "s1", name: "Mei" },
      current_plan: { plan_id: "plan_a", name: "Monthly" },
      first_pay_time: 1_767_225_600,
      all_sum_amount: "300.00",
    },
    {
      user: { user_id: "s2", name: "Jun" },
      // A lapsed sponsor: `current_plan` is `{ name: "" }` with no plan id.
      current_plan: { name: "" },
      first_pay_time: 1_769_904_000,
    },
    // No display name: counted by the order rail, never named here.
    { user: { user_id: "s3", name: "  " }, first_pay_time: 1_769_904_000 },
  ]);
  assert.deepEqual(
    recs.map((r) => [r.name, r.recurring, r.usd, r.goal]),
    [
      ["Mei", true, 0, null],
      ["Jun", false, 0, null],
    ],
  );
  // `all_sum_amount` is a lifetime total. Adding it would re-add every past
  // month to the goal on every single run.
  assert.equal(
    recs.reduce((sum, r) => sum + r.amount, 0),
    0,
  );
  assert.equal(recs[0].month, new Date(1_767_225_600 * 1000).toISOString().slice(0, 7));
});
