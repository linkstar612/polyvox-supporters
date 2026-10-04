// A monthly goal starts over on the 1st.
//
// The pin: the "living" bar is labeled "/ month" in the app, so it may only
// count the current month. It once summed every record ever made, and on
// 2026-10-04 it still showed July through September as October's money.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { goalTotal, monthOf } from "../goals.mjs";

const MONTHLY = { id: "living", kind: "monthly", target_usd: 500 };
const ONE_TIME = { id: "dev_costs", kind: "one_time", target_usd: 200 };

const RECORDS = [
  { goal: "living", month: "2026-08", usd: 20 },
  { goal: "living", month: "2026-09", usd: 5 },
  { goal: "living", month: "2026-09", usd: 10.12 },
  { goal: "living", month: "2026-10", usd: 3 },
  { goal: "dev_costs", month: "2026-09", usd: 50 },
  { goal: "dev_costs", month: "2026-10", usd: 7 },
];

const at = (iso) => Date.parse(iso);

test("monthOf is the UTC month", () => {
  assert.equal(monthOf(at("2026-09-30T23:59:59Z")), "2026-09");
  assert.equal(monthOf(at("2026-10-01T00:00:00Z")), "2026-10");
  // 09:00 on the 1st in Tokyo is still the previous month's last evening in UTC.
  assert.equal(monthOf(at("2026-10-01T08:59:59+09:00")), "2026-09");
});

test("a monthly goal counts only the current UTC month", () => {
  assert.equal(goalTotal(MONTHLY, RECORDS, { nowMs: at("2026-09-30T23:59:59Z") }), 15.12);
  assert.equal(goalTotal(MONTHLY, RECORDS, { nowMs: at("2026-10-01T00:00:00Z") }), 3);
});

test("a monthly goal with nothing this month is zero", () => {
  assert.equal(goalTotal(MONTHLY, RECORDS, { nowMs: at("2026-11-01T00:00:00Z") }), 0);
});

test("any other kind counts every month", () => {
  assert.equal(goalTotal(ONE_TIME, RECORDS, { nowMs: at("2026-11-01T00:00:00Z") }), 57);
  assert.equal(goalTotal({ id: "living" }, RECORDS, { nowMs: at("2026-11-01T00:00:00Z") }), 38.12);
});

test("records for another goal never count", () => {
  assert.equal(goalTotal(MONTHLY, RECORDS, { nowMs: at("2026-10-15T12:00:00Z") }), 3);
});

test("the manual nudge is added in every month", () => {
  const manualUsd = { living: 4.5 };
  assert.equal(goalTotal(MONTHLY, RECORDS, { manualUsd, nowMs: at("2026-10-15T12:00:00Z") }), 7.5);
  assert.equal(goalTotal(MONTHLY, RECORDS, { manualUsd, nowMs: at("2026-11-15T12:00:00Z") }), 4.5);
  assert.equal(goalTotal(MONTHLY, [], { manualUsd: { living: "x" }, nowMs: 0 }), 0);
});
