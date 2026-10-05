// The Stripe rail: paid Checkout Sessions, plus the subscription renewals that
// follow a "Fund monthly" signup.
//
// Split out of aggregate.mjs so it can be unit-tested, the way afdian.mjs is.
// The restricted key needs read on Checkout Sessions and Invoices, nothing
// else. Subscriptions stays unreadable on purpose: a renewal is tied back to
// its signup through the Checkout Session that created the subscription, which
// already carries the goal and the donor's name.

import { monthOf } from "./goals.mjs";

// The Stripe checkout custom field whose value is the donor's opt-in display
// name. Add it to each Payment Link as an OPTIONAL text field. Leaving it blank
// is how a donor stays anonymous, so it must never be required.
// Stripe derives the key from the label and permits alphanumerics only, so the
// label "Display name" yields `displayname`, no underscore, however the README
// once spelled it. Matched with non-alphanumerics stripped rather than compared
// literally, because the cost of guessing that spelling wrong is not an error:
// it is every donor silently landing on the wall as anonymous, indefinitely,
// with a green workflow run each time.
const NAME_FIELD = "displayname";
const fieldKey = (key) => (key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Currencies with no minor unit: the amount is already whole. Dividing these
 *  by 100 would report a ¥5000 donation as ¥50. */
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** `{ amount, currency }` from a Stripe minor-unit amount. */
function money(minorAmount, currency) {
  const code = (currency ?? "usd").toUpperCase();
  return { amount: (minorAmount ?? 0) / (ZERO_DECIMAL.has(code) ? 1 : 100), currency: code };
}

async function stripe(key, path, params, fetchImpl) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetchImpl(
    `https://api.stripe.com/v1/${path}${qs ? `?${qs}` : ""}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) {
    throw new Error(`Stripe ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Every object of a list endpoint, following `has_more`. */
async function listAll(key, path, params, fetchImpl) {
  const out = [];
  let startingAfter;
  do {
    const page = await stripe(
      key,
      path,
      { limit: "100", ...params, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      fetchImpl,
    );
    out.push(...page.data);
    startingAfter = page.has_more && page.data.length ? page.data.at(-1).id : null;
  } while (startingAfter);
  return out;
}

/** The subscription an invoice bills. Before API version 2025-03-31 it sat on
 *  `invoice.subscription`; since then it is under
 *  `parent.subscription_details`. Either may be an id or an expanded object. */
export function invoiceSubscription(inv) {
  const sub = inv?.subscription ?? inv?.parent?.subscription_details?.subscription;
  return typeof sub === "string" ? sub : (sub?.id ?? "");
}

/** The PaymentIntent behind an invoice, where the API version still puts one
 *  on the invoice itself. Used only to honor the hand-recorded skip list. */
const invoicePi = (inv) =>
  typeof inv?.payment_intent === "string" ? inv.payment_intent : (inv?.payment_intent?.id ?? "");

/** Every paid checkout session, as ledger-shaped records.
 *
 *  Amounts are read off `s.currency` / `s.amount_total` and pushed through the
 *  same `toUsd` the ledger uses, which is correct on both sides of an Adaptive
 *  Pricing API change and needs no special-casing:
 *
 *  - **Current API**: `currency` is YOUR settlement currency and what the
 *    customer actually saw moved to `presentment_details`. A Thai donor's $5
 *    arrives as `usd`/500, `toUsd` is the identity, and the figure is exact.
 *  - **Older API**: `currency` was the customer's (`thb`) and yours sat in
 *    `currency_conversion`. `toUsd` converts through the manifest's FX
 *    snapshot: a few percent off, but never the ~36x error that reading a
 *    THB amount as USD would book.
 *
 *  `currency_conversion` is deliberately not consulted: Stripe has deprecated
 *  it and tells integrations to read `amount_total` directly, so branching on
 *  it would add a second code path that is scheduled to stop existing.
 *
 *  `skipPi` holds PaymentIntent ids already written into ledger.json by hand.
 *  A payment recorded before this rail was switched on would otherwise be
 *  counted a second time the moment it was.
 *
 *  Returns the records and `bySubscription`, the record of each subscription
 *  signup keyed by subscription id, which is what a renewal is attributed by.
 *  A signup skipped through `skipPi` still lands in the map: its renewals are
 *  new money the hand entry never covered. */
export async function stripeSessions(key, {
  skipPi = new Set(),
  linkToGoal = {},
  defaultGoal,
  fetchImpl = fetch,
} = {}) {
  const entries = [];
  const bySubscription = new Map();
  const sessions = await listAll(key, "checkout/sessions", { status: "complete" }, fetchImpl);
  for (const s of sessions) {
    if (s.payment_status !== "paid") continue;
    const named = (s.custom_fields ?? []).find((f) => fieldKey(f.key) === NAME_FIELD);
    const record = {
      id: `stripe:${s.id}`,
      platform: "stripe",
      month: monthOf(s.created * 1000),
      // When the session opened, a minute or two before it was paid. It is
      // the one time a session carries.
      at: new Date(s.created * 1000).toISOString(),
      ...money(s.amount_total, s.currency),
      goal: linkToGoal[s.payment_link] ?? defaultGoal,
      // An absent field, an empty field, or a link carrying no field at all
      // all mean the same thing: counts toward the goal, not named.
      name: (named?.text?.value ?? "").trim(),
      link: "",
      recurring: s.mode === "subscription",
      // R-OCS.10: the donation code the app put on the link. Stripe hands it
      // back verbatim, so this rail needs nothing typed by the donor.
      client_reference_id: s.client_reference_id ?? "",
    };
    const sub = typeof s.subscription === "string" ? s.subscription : (s.subscription?.id ?? "");
    if (s.mode === "subscription" && sub) bySubscription.set(sub, { ...record, created: s.created });
    if (s.payment_intent && skipPi.has(s.payment_intent)) continue;
    entries.push(record);
  }
  return { entries, bySubscription };
}

/** Every paid subscription renewal, as ledger-shaped records.
 *
 *  Only `billing_reason: subscription_cycle` counts. The signup invoice
 *  (`subscription_create`) is the same money as its Checkout Session, which
 *  `stripeSessions` already booked. Each renewal takes the goal, the name and
 *  the donation code of the session that created its subscription, so it lands
 *  on the same card and adds that month to it. A renewal whose subscription no
 *  session created is skipped, never guessed: it is returned in `skipped` for
 *  the run log. Invoices are listed from the oldest signup on, since nothing
 *  earlier can be a renewal of one. */
export async function stripeRenewals(key, bySubscription, {
  skipPi = new Set(),
  fetchImpl = fetch,
} = {}) {
  if (!bySubscription.size) return { entries: [], skipped: 0 };
  const since = Math.min(...[...bySubscription.values()].map((r) => r.created));
  const invoices = await listAll(
    key,
    "invoices",
    { status: "paid", "created[gte]": String(since) },
    fetchImpl,
  );
  const entries = [];
  let skipped = 0;
  for (const inv of invoices) {
    if (inv.billing_reason !== "subscription_cycle") continue;
    const pi = invoicePi(inv);
    if (pi && skipPi.has(pi)) continue;
    const signup = bySubscription.get(invoiceSubscription(inv));
    if (!signup) {
      skipped += 1;
      continue;
    }
    // When the invoice was paid. A paid invoice always carries it; `created`
    // is the fallback for an object that somehow does not.
    const paidAt = (inv.status_transitions?.paid_at ?? inv.created) * 1000;
    entries.push({
      id: `stripe-inv:${inv.id}`,
      platform: "stripe",
      month: monthOf(paidAt),
      at: new Date(paidAt).toISOString(),
      ...money(inv.amount_paid, inv.currency),
      goal: signup.goal,
      name: signup.name,
      link: "",
      recurring: true,
      client_reference_id: signup.client_reference_id,
    });
  }
  return { entries, skipped };
}
