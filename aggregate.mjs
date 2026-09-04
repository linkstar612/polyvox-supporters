// Rebuild manifest.json's goal totals and supporter wall from every rail.
//
// Runs in GitHub Actions (see .github/workflows/aggregate.yml) on a cron, on
// manual dispatch, and immediately after the Ko-fi doorman appends to the
// ledger. Needs one secret: STRIPE_RESTRICTED_KEY — a READ-ONLY restricted key
// (Checkout Sessions: read). Never commit it.
//
// Four sources, two outputs:
//
//   Stripe API      · polled here, attributed to a goal by payment-link id
//   Afdian API      · the CN rail, polled through afdian.mjs. Orders move the
//                     goal, sponsors name the wall (AFDIAN_USER_ID +
//                     AFDIAN_TOKEN). WeChat and Alipay personal codes are NOT
//                     this rail and cannot be polled by anything: that money
//                     reaches a goal only as a hand ledger.json entry.
//   ledger.json     · the push-only rails (Ko-fi via the Worker; Patreon,
//                     pixiv, BOOTH, WeChat and Alipay by hand). One record per
//                     payment.
//   overrides.json  · a manual per-goal USD nudge, the CNY rate, the wall
//                     strike list, and the permanent founder entries that
//                     predate any payment rail.
//
// The second output is `manifest.testers` (R-DON.6): the opt-in pre-alpha
// tester roster, read from the license mint with MINT_ADMIN_TOKEN. Nobody is on
// it who did not ask to be.
//
// Node 20+ (global fetch, no npm install). Nothing secret and nothing
// identifying is ever written to manifest.json: aggregate USD per goal, and
// display names their owners opted into showing.

import { readFile, writeFile } from "node:fs/promises";

import { afdianOrders, afdianSponsors, orderRecords, sponsorRecords } from "./afdian.mjs";

/// The license mint that holds the tester wall. Its hostname is compiled into
/// every shipped build (`TRUSTED_INGEST_HOSTS`), so naming it here is not a
/// disclosure; the admin token that reads it is the secret.
const MINT_BASE_URL = "https://polyvox-license-mint.terry61295.workers.dev";

// Map each Stripe Payment Link id to the goal it funds. The id is the `plink_…`
// on the object — NOT the `buy.stripe.com/…` slug in the browser bar, and not
// the `pl_…` this file used to claim. Find them at Dashboard → Payment Links
// (the id is on the link's own page) or `GET /v1/payment_links`. Any link NOT
// listed here — the quick-donate tiers, the custom-amount link — funds
// DEFAULT_GOAL.
const LINK_TO_GOAL = {
  // "plink_...dev200":        "dev_costs",
  // "plink_...dev200Monthly": "dev_costs",
  // "plink_...expedited400":  "expedited",
  // "plink_...living500":     "living",
  // "plink_...livingMonthly": "living",
};
const DEFAULT_GOAL = "living";

// Cumulative USD at which a supporter is shown as a patron. Recurring support
// promotes regardless of total — a standing commitment is the thing being
// recognised, not its size. Tiers carry NO amount to the UI either way; this
// only picks which of the three chips a card wears (§1.3).
const PATRON_USD = 25;

// The Stripe checkout custom field whose value is the donor's opt-in display
// name. Add it to each Payment Link as an OPTIONAL text field — leaving it
// blank is how a donor stays anonymous, so it must never be required.
// Stripe derives the key from the label and permits alphanumerics only, so the
// label "Display name" yields `displayname` — no underscore, however the README
// once spelled it. Matched with non-alphanumerics stripped rather than compared
// literally, because the cost of guessing that spelling wrong is not an error:
// it is every donor silently landing on the wall as anonymous, indefinitely,
// with a green workflow run each time.
const NAME_FIELD = "displayname";
const fieldKey = (key) => (key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const read = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

// --- Stripe ----------------------------------------------------------------

async function stripe(key, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(
    `https://api.stripe.com/v1/${path}${qs ? `?${qs}` : ""}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) {
    throw new Error(`Stripe ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Currencies with no minor unit — `amount_total` is already whole. Dividing
 *  these by 100 would report a ¥5000 donation as ¥50. */
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

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
 *    snapshot — a few percent off, but never the ~36x error that reading a
 *    THB amount as USD would book.
 *
 *  `currency_conversion` is deliberately not consulted: Stripe has deprecated
 *  it and tells integrations to read `amount_total` directly, so branching on
 *  it would add a second code path that is scheduled to stop existing.
 *
 *  `skipPi` holds PaymentIntent ids already written into ledger.json by hand —
 *  a payment recorded before this rail was switched on would otherwise be
 *  counted a second time the moment it was. */
async function stripeEntries(key, skipPi) {
  const entries = [];
  let startingAfter;
  do {
    const page = await stripe(key, "checkout/sessions", {
      limit: "100",
      status: "complete",
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const s of page.data) {
      if (s.payment_status !== "paid") continue;
      if (s.payment_intent && skipPi.has(s.payment_intent)) continue;
      const named = (s.custom_fields ?? []).find((f) => fieldKey(f.key) === NAME_FIELD);
      const currency = (s.currency ?? "usd").toUpperCase();
      const minor = ZERO_DECIMAL.has(currency) ? 1 : 100;
      entries.push({
        id: `stripe:${s.id}`,
        platform: "stripe",
        month: monthOf(s.created * 1000),
        amount: (s.amount_total ?? 0) / minor,
        currency,
        goal: LINK_TO_GOAL[s.payment_link] ?? DEFAULT_GOAL,
        // An absent field, an empty field, or a link carrying no field at all
        // all mean the same thing: counts toward the goal, not named.
        name: (named?.text?.value ?? "").trim(),
        link: "",
        recurring: s.mode === "subscription",
      });
    }
    startingAfter = page.has_more ? page.data.at(-1).id : null;
  } while (startingAfter);
  return entries;
}

// --- shared -----------------------------------------------------------------

/** Ledger amounts are recorded in the currency actually charged, so they need
 *  the manifest's own USD-base FX snapshot to be comparable. `fx.rates[CUR]`
 *  is USD→CUR, so the inverse converts back. An unknown currency counts at par
 *  rather than being dropped — a goal that silently loses money is worse than
 *  one that is a few percent optimistic. */
function toUsd(amount, currency, fx) {
  const code = (currency || "USD").toUpperCase();
  if (code === "USD") return amount;
  const rate = fx?.rates?.[code];
  return typeof rate === "number" && rate > 0 ? amount / rate : amount;
}

/** Fold every record for one person into the card the wall renders. Identity
 *  is the display name, case-folded: a one-off Ko-fi donation carries no
 *  stable donor id, and merging two people who chose the same public name is
 *  the acceptable end of that trade. */
function buildWall(records, founders) {
  const byPerson = new Map();
  for (const r of records) {
    if (!r.name) continue; // anonymous — counted in the goal, never named
    const key = r.name.toLowerCase();
    const person = byPerson.get(key) ?? {
      name: r.name,
      platform: r.platform,
      months: new Set(),
      usd: 0,
      recurring: false,
      link: "",
    };
    person.months.add(r.month);
    person.usd += r.usd;
    person.recurring ||= Boolean(r.recurring);
    person.link ||= r.link ?? "";
    byPerson.set(key, person);
  }

  const derived = [...byPerson.values()].map((p) => {
    const tier = p.recurring || p.usd >= PATRON_USD ? "patron" : "supporter";
    const months = [...p.months].sort();
    return {
      name: p.name,
      tier,
      since: months[0],
      link: p.link,
      permanent: false,
      platform: p.platform,
      // Every month is stamped with the tier the card wears today rather than
      // whatever was held back then: the strip exists to show duration, and
      // one that changed colour part-way would read as a rank history.
      months: Object.fromEntries(months.map((m) => [m, tier])),
    };
  });

  // Founders are hand-kept and never derived — a payment cannot grant the
  // tier, and lapsing cannot remove it (design §2, `permanent`).
  return [...founders, ...derived];
}

// --- main -------------------------------------------------------------------

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const overrides = await read("overrides.json", { manual_usd: {}, founders: [] });
const ledger = await read("ledger.json", { entries: [] });

// One FX table, not two. `overrides.fx.cny_per_usd` is patched over the
// manifest's own snapshot rather than becoming a second conversion path: the CN
// rail bills in yuan, the manifest snapshot is only refreshed when someone
// remembers to, and two converters would eventually disagree about the same
// donation.
const fx = { ...(manifest.fx ?? {}), rates: { ...(manifest.fx?.rates ?? {}) } };
const cnyPerUsd = Number(overrides.fx?.cny_per_usd);
if (Number.isFinite(cnyPerUsd) && cnyPerUsd > 0) fx.rates.CNY = cnyPerUsd;

const key = process.env.STRIPE_RESTRICTED_KEY;
if (!key) {
  console.warn(
    "STRIPE_RESTRICTED_KEY not set — Stripe totals skipped; ledger + overrides still applied.",
  );
}

// --- Afdian (爱发电), the CN rail ---------------------------------------------

const afdianUserId = process.env.AFDIAN_USER_ID;
const afdianToken = process.env.AFDIAN_TOKEN;
// Which goal CN money funds. The owner names it in overrides.json; the fallback
// is the first goal rather than DEFAULT_GOAL so a renamed or reordered goal list
// cannot silently drop the rail into a goal that no longer exists.
const afdianGoal = overrides.afdian_goal ?? manifest.goals?.[0]?.id ?? DEFAULT_GOAL;
let afdianEntries = [];
let afdianWall = [];
if (!afdianUserId || !afdianToken) {
  console.warn(
    "AFDIAN_USER_ID / AFDIAN_TOKEN not set. Afdian orders and sponsors skipped; every other rail still applied.",
  );
} else {
  const creds = { userId: afdianUserId, token: afdianToken };
  // An Afdian order recorded by hand before this rail existed carries the same
  // `afdian:<out_trade_no>` id, which is what stops it being counted twice.
  const skipIds = new Set(ledger.entries.map((e) => e.id).filter(Boolean));
  afdianEntries = orderRecords(await afdianOrders(creds), { goal: afdianGoal, skipIds });
  // Sponsors carry a display name and no money. They are handed to the wall and
  // to nothing else: the same yuan is already in `afdianEntries`, and
  // `all_sum_amount` is a lifetime total that would be re-added on every run.
  afdianWall = sponsorRecords(await afdianSponsors(creds));
}

// Anything hand-recorded from Stripe carries the PaymentIntent it came from,
// so the poller can recognise it. The two rails cannot dedupe on `id` — the
// ledger knows a `pi_…`, the poller sees a `cs_…` — which is what this is for.
const skipPi = new Set(
  ledger.entries.map((e) => e.stripe_pi).filter(Boolean),
);

// Both rails now speak amount+currency; the USD conversion happens once, here.
const records = [
  ...(key ? await stripeEntries(key, skipPi) : []),
  ...ledger.entries,
  ...afdianEntries,
].map((e) => ({
  ...e,
  usd: toUsd(Number(e.amount ?? 0), e.currency, fx),
  goal: e.goal ?? DEFAULT_GOAL,
}));

for (const goal of manifest.goals) {
  const earned = records
    .filter((r) => r.goal === goal.id)
    .reduce((sum, r) => sum + r.usd, 0);
  const manual = overrides.manual_usd?.[goal.id] ?? 0;
  goal.current_usd = Math.round((earned + manual) * 100) / 100;
}

manifest.supporters = buildWall([...records, ...afdianWall], overrides.founders ?? []);

// --- R-DON.6: the opt-in pre-alpha tester roster ------------------------------
//
// Read from the mint rather than derived here, because the mint is the only
// thing that can check an Ed25519 signature against the shipped keys, and an
// opt-in anyone could forge is not a verification.
//
// Never fatal. A missing token or an unreachable Worker leaves `manifest.testers`
// exactly as the last good run wrote it: this same script publishes the donation
// totals, and failing the run over a badge would cost a donation its record.
const mintToken = process.env.MINT_ADMIN_TOKEN;
if (!mintToken) {
  console.warn("MINT_ADMIN_TOKEN not set. Tester wall skipped; manifest.testers left unchanged.");
} else {
  const base = (process.env.MINT_BASE_URL ?? MINT_BASE_URL).replace(/[/]+$/, "");
  try {
    const res = await fetch(`${base}/wall`, {
      headers: { authorization: `Bearer ${mintToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { testers } = await res.json();
    // The owner's strike list. Matched case-folded on the display name, which
    // is the only identifier this endpoint returns.
    const struck = new Set(
      (overrides.wall_exclude ?? []).map((n) => String(n).trim().toLowerCase()),
    );
    manifest.testers = (Array.isArray(testers) ? testers : [])
      .filter((t) => t?.name && !struck.has(String(t.name).trim().toLowerCase()))
      .map((t) => ({
        name: String(t.name).trim().slice(0, 48),
        badge: String(t.badge ?? ""),
        since: String(t.since ?? ""),
      }))
      .sort((a, b) => a.since.localeCompare(b.since) || a.name.localeCompare(b.name));
  } catch (e) {
    console.error(`Tester wall not refreshed (${e.message}); manifest.testers left unchanged.`);
  }
}

manifest.updated_at = new Date().toISOString();

await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const earned = manifest.supporters.filter((s) => !s.permanent).length;
console.log(
  "Goals:",
  manifest.goals.map((g) => `${g.id}=$${g.current_usd}`).join("  "),
  `| wall: ${manifest.supporters.length} (${earned} earned)`,
  `| testers: ${(manifest.testers ?? []).length}`,
  `| records: ${records.length}`,
);
