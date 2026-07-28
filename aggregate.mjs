// Rebuild manifest.json's goal totals and supporter wall from every rail.
//
// Runs in GitHub Actions (see .github/workflows/aggregate.yml) on a cron, on
// manual dispatch, and immediately after the Ko-fi doorman appends to the
// ledger. Needs one secret: STRIPE_RESTRICTED_KEY — a READ-ONLY restricted key
// (Checkout Sessions: read). Never commit it.
//
// Three sources, one output:
//
//   Stripe API      — polled here, attributed to a goal by payment-link id
//   ledger.json     — the push-only rails (Ko-fi via the Worker; Patreon,
//                     pixiv, BOOTH by hand). One record per payment.
//   overrides.json  — a manual per-goal USD nudge, plus the permanent
//                     founder entries that predate any payment rail.
//
// Node 20+ (global fetch, no npm install). Nothing secret and nothing
// identifying is ever written to manifest.json: aggregate USD per goal, and
// display names their owners opted into showing.

import { readFile, writeFile } from "node:fs/promises";

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
const NAME_FIELD = "display_name";

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
 *  `amount_total` is in the PRESENTMENT currency, which is not always yours:
 *  with Adaptive Pricing on, a Thai donor's $5 arrives as a THB session and
 *  reading it as USD would book it as several hundred dollars. Both the minor
 *  unit and the FX conversion therefore come off `s.currency`.
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
      const named = (s.custom_fields ?? []).find((f) => f.key === NAME_FIELD);
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

const key = process.env.STRIPE_RESTRICTED_KEY;
if (!key) {
  console.warn(
    "STRIPE_RESTRICTED_KEY not set — Stripe totals skipped; ledger + overrides still applied.",
  );
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
].map((e) => ({
  ...e,
  usd: toUsd(Number(e.amount ?? 0), e.currency, manifest.fx),
  goal: e.goal ?? DEFAULT_GOAL,
}));

for (const goal of manifest.goals) {
  const earned = records
    .filter((r) => r.goal === goal.id)
    .reduce((sum, r) => sum + r.usd, 0);
  const manual = overrides.manual_usd?.[goal.id] ?? 0;
  goal.current_usd = Math.round((earned + manual) * 100) / 100;
}

manifest.supporters = buildWall(records, overrides.founders ?? []);
manifest.updated_at = new Date().toISOString();

await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const earned = manifest.supporters.filter((s) => !s.permanent).length;
console.log(
  "Goals:",
  manifest.goals.map((g) => `${g.id}=$${g.current_usd}`).join("  "),
  `| wall: ${manifest.supporters.length} (${earned} earned)`,
  `| records: ${records.length}`,
);
