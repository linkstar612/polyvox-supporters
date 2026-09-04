// The Afdian (爱发电) rail: the one CN payment route that can be polled.
//
// Its own module, and importable with no side effects, because `aggregate.mjs`
// runs its work at the top level and could not be unit-tested otherwise. Every
// network call goes through an injected `fetchImpl` for the same reason.
//
// Why this rail exists at all: アたる's personal WeChat and Alipay collection
// codes have no API of any kind. Money scanned into a personal wallet is
// invisible to every poller that will ever exist, so it reaches the goal bars
// only through a hand `ledger.json` entry. Afdian aggregates both wallets
// behind one creator page AND publishes an Open API, so it is the only CN money
// that can move a bar by itself.
//
// API shape, from https://guide.afdian.com/creator/developer (read 2026-09-04):
//
//   POST https://afdian.com/api/open/query-order   50 orders per page
//   POST https://afdian.com/api/open/query-sponsor  20 sponsors per page
//   body { user_id, params: "<json string>", ts: <unix seconds>, sign }
//   sign = md5(token + "params" + params + "ts" + ts + "user_id" + user_id)
//   → { ec: 200, em: "", data: { list: [...], total_count, total_page } }
//
// `ts` must be within 3600 seconds of Afdian's clock, and the token is never
// transmitted. Error codes: 400001 incomplete params, 400002 time expired,
// 400003 params not valid JSON, 400004 no valid token, 400005 sign failed.

import { createHash } from "node:crypto";

export const AFDIAN_API = "https://afdian.com/api/open";

/// Orders per page and sponsors per page are FIXED BY AFDIAN and differ from
/// each other. Both are only used to decide whether a short page means the end;
/// `total_page` is the authority.
export const ORDER_PAGE_SIZE = 50;
export const SPONSOR_PAGE_SIZE = 20;

/// A poller that cannot terminate is worse than one that misses a page. Afdian
/// returns `total_page`, so this only fires if that field is wrong.
const MAX_PAGES = 200;

/// `status: 2` is the only status Afdian pushes, and it means paid.
const STATUS_PAID = 2;

/// The signature Afdian checks.
///
/// Concatenation with no separators, in this exact order, and `params` is the
/// JSON STRING that will be sent, not the object: re-serializing it differently
/// on the way out changes the bytes and every call returns `ec: 400005`.
export function afdianSign({ token, params, ts, userId }) {
  return createHash("md5")
    .update(`${token}params${params}ts${ts}user_id${userId}`)
    .digest("hex");
}

/// One signed call. Throws on anything that is not `ec: 200`, because a silent
/// empty list would publish a goal total that quietly lost a rail.
export async function afdianCall({
  userId,
  token,
  endpoint,
  params,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const paramsJson = JSON.stringify(params);
  const ts = Math.floor(now() / 1000);
  const body = {
    user_id: userId,
    params: paramsJson,
    ts,
    sign: afdianSign({ token, params: paramsJson, ts, userId }),
  };
  const res = await fetchImpl(`${AFDIAN_API}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Afdian ${endpoint} → HTTP ${res.status}`);
  const json = await res.json();
  if (json?.ec !== 200) {
    throw new Error(`Afdian ${endpoint} → ec ${json?.ec} ${json?.em ?? ""}`.trim());
  }
  return json.data ?? {};
}

/// Every page of one endpoint, concatenated.
async function afdianAll({ endpoint, ...opts }) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await afdianCall({ endpoint, params: { page }, ...opts });
    const list = Array.isArray(data.list) ? data.list : [];
    out.push(...list);
    const totalPage = Number(data.total_page ?? 0);
    if (list.length === 0 || !Number.isFinite(totalPage) || page >= totalPage) break;
  }
  return out;
}

export const afdianOrders = (opts) => afdianAll({ endpoint: "query-order", ...opts });
export const afdianSponsors = (opts) => afdianAll({ endpoint: "query-sponsor", ...opts });

/// `YYYY-MM` from an Afdian timestamp, which is unix SECONDS.
///
/// Not to be confused with an order's own `month` field, which is a COUNT of
/// sponsored months (a 3-month upfront order carries `month: 3`). Reading that
/// as a date is the mistake this helper exists to make impossible.
function monthOf(unixSeconds, fallbackMs) {
  const s = Number(unixSeconds);
  const ms = Number.isFinite(s) && s > 0 ? s * 1000 : fallbackMs;
  return new Date(ms).toISOString().slice(0, 7);
}

/// Paid orders as ledger-shaped records, for the GOAL TOTAL only.
///
/// Deliberately anonymous (`name: ""`). An order carries a `user_id` and no
/// display name, so the person behind it is named by `sponsorRecords` instead,
/// off the endpoint that does carry one. Keeping the two apart is also what
/// stops a supporter being counted twice on the wall.
///
/// Amount is `total_amount`, the figure actually paid, in CNY. `show_amount` is
/// the pre-discount price and would over-report every discounted order;
/// `total_amount` is `0.00` when a redeem code was used, which is money that
/// never arrived and is dropped here.
export function orderRecords(orders, { goal, skipIds = new Set(), nowMs = Date.now() } = {}) {
  const out = [];
  for (const o of orders ?? []) {
    if (Number(o?.status) !== STATUS_PAID) continue;
    const amount = Number(o?.total_amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const id = `afdian:${o?.out_trade_no ?? ""}`;
    if (skipIds.has(id)) continue;
    out.push({
      id,
      platform: "afdian",
      month: monthOf(o?.create_time, nowMs),
      amount,
      currency: "CNY",
      goal,
      name: "",
      link: "",
      // Afdian has no auto-renew: every term is a fresh human action, so no
      // order is a standing commitment on its own. A sponsor holding a current
      // plan is where recurring is decided.
      recurring: false,
    });
  }
  return out;
}

/// Sponsors as wall-only records, carrying no money.
///
/// They must never reach the goal reduce: the same yuan is already counted by
/// `orderRecords`, and `all_sum_amount` is a lifetime total that would be added
/// again on every run.
export function sponsorRecords(sponsors, { nowMs = Date.now() } = {}) {
  const out = [];
  for (const s of sponsors ?? []) {
    const name = String(s?.user?.name ?? "").trim().slice(0, 48);
    if (!name) continue;
    out.push({
      id: `afdian-sponsor:${s?.user?.user_id ?? name}`,
      platform: "afdian",
      month: monthOf(s?.first_pay_time ?? s?.create_time, nowMs),
      amount: 0,
      currency: "USD",
      // No goal: this record is handed to the wall builder and to nothing else.
      goal: null,
      name,
      link: "",
      // `current_plan` is `{ name: "" }` with no `plan_id` when the sponsorship
      // has lapsed, so a plan id is what distinguishes a standing sponsor from
      // someone who paid once a year ago.
      recurring: Boolean(s?.current_plan?.plan_id),
      usd: 0,
    });
  }
  return out;
}
