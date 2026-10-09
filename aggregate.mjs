// Rebuild manifest.json's goal totals and supporter wall from every rail.
//
// Runs in GitHub Actions (see .github/workflows/aggregate.yml) on a cron, on
// manual dispatch, and immediately after the Ko-fi doorman appends to the
// ledger. Needs one secret: STRIPE_RESTRICTED_KEY — a READ-ONLY restricted key
// (Checkout Sessions: read, Invoices: read). Never commit it.
//
// Four sources, two outputs:
//
//   Stripe API      · polled through stripe.mjs, attributed to a goal by
//                     payment-link id. A subscription renewal is an
//                     invoice, attributed through its signup session.
//   Afdian API      · the CN rail, polled through afdian.mjs. Orders move the
//                     goal, sponsors name the wall (AFDIAN_USER_ID +
//                     AFDIAN_TOKEN). WeChat and Alipay personal codes are NOT
//                     this rail and cannot be polled by anything: that money
//                     reaches a goal only as a hand ledger.json entry.
//   ledger.json     · the push-only rails (Ko-fi via the Worker; Patreon,
//                     pixiv, BOOTH, WeChat and Alipay by hand). One record per
//                     payment.
//   overrides.json  · a manual per-goal USD nudge, the CNY rate, the wall
//                     strike list, the pre-alpha roster and name aliases.
//
// The second output is `manifest.testers` (R-DON.6): the opt-in pre-alpha
// tester roster, read from the license mint with MINT_ADMIN_TOKEN. Nobody is on
// it who did not ask to be AND was not then approved by the owner; everyone
// else waits in `wall-pending.json`.
//
// Node 20+ (global fetch, no npm install). Nothing secret and nothing
// identifying is ever written to manifest.json: aggregate USD per goal, and
// display names their owners opted into showing.

import { readFile, writeFile } from "node:fs/promises";

import { afdianOrders, afdianSponsors, orderRecords, sponsorRecords } from "./afdian.mjs";
import { donateHealthy, publishCustomAmount } from "./custom-amount.mjs";
import {
  ACHIEVEMENTS,
  applyAliases,
  buildUnlocks,
  buildWall,
  fold,
  markFirstOfMonth,
  mergeTesters,
} from "./cards.mjs";
import { goalTotal } from "./goals.mjs";
import { stripeRenewals, stripeSessions } from "./stripe.mjs";
import { partitionTesters } from "./wall.mjs";

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

const read = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

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

// --- main -------------------------------------------------------------------

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const overrides = await read("overrides.json", { manual_usd: {} });
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

// Renewals of a "Fund monthly" subscription are invoices, attributed to the
// goal and the donor of the Checkout Session that started the subscription.
let stripeRecords = [];
if (key) {
  const { entries, bySubscription } = await stripeSessions(key, {
    skipPi,
    linkToGoal: LINK_TO_GOAL,
    defaultGoal: DEFAULT_GOAL,
  });
  const renewals = await stripeRenewals(key, bySubscription, { skipPi });
  stripeRecords = [...entries, ...renewals.entries];
  console.log(
    `Stripe: ${entries.length} session(s), ${renewals.entries.length} renewal(s)` +
      (renewals.skipped
        ? `; ${renewals.skipped} renewal(s) skipped, their subscription has no known Checkout Session`
        : ""),
  );
}

// Both rails now speak amount+currency; the USD conversion happens once, here.
// The first-of-the-month trophy is marked on the records themselves, after the
// aliases, so it rides into the wall and the unlocks with everything else.
const { records, untimed } = markFirstOfMonth(
  applyAliases(
    [
      ...stripeRecords,
      ...ledger.entries,
      ...afdianEntries,
    ].map((e) => ({
      ...e,
      usd: toUsd(Number(e.amount ?? 0), e.currency, fx),
      goal: e.goal ?? DEFAULT_GOAL,
    })),
    // overrides.json -> aliases: a name a live rail delivered, folded onto the
    // card it belongs to. Applied at the source so the wall and the unlocks
    // agree on who a coded donation was from.
    overrides.aliases ?? {},
  ),
);
// An Afdian order is anonymous by design (afdian.mjs) and its sponsor row
// carries the name, so an order that opened a month hands the trophy to that
// row. Anybody else anonymous leaves their month unclaimed.
const afdianFirsts = new Set(
  records
    .filter((r) => r.first_of_month && r.platform === "afdian" && r.afdian_user_id)
    .map((r) => `afdian-sponsor:${r.afdian_user_id}`),
);
afdianWall = afdianWall.map((s) => (afdianFirsts.has(s.id) ? { ...s, first_of_month: true } : s));
console.log(
  `First of the month: ${records.filter((r) => r.first_of_month).length} payment(s) earned it` +
    (untimed.length ? `; scored on the 1st only (a payment has no time): ${untimed.join(", ")}` : ""),
);

// A monthly goal counts this UTC month only (goals.mjs). `records` itself stays
// whole: the wall's month history and levels read every month.
for (const goal of manifest.goals) {
  goal.current_usd = goalTotal(goal, records, { manualUsd: overrides.manual_usd });
}

// --- R-DON.6: the opt-in pre-alpha tester roster ------------------------------
//
// Read from the mint rather than derived here, because the mint is the only
// thing that can check an Ed25519 signature against the shipped keys, and an
// opt-in anyone could forge is not a verification.
//
// Never fatal. A missing token or an unreachable Worker leaves `manifest.testers`
// exactly as the last good run wrote it: this same script publishes the donation
// totals, and failing the run over a badge would cost a donation its record.
// Read before the wall is built, because the era the mint proved is what earns
// the pre-alpha trophy on a supporter card.
let mintTesters = Array.isArray(manifest.testers) ? manifest.testers : [];
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
    const { published, pending } = partitionTesters({
      testers: Array.isArray(testers) ? testers : [],
      approved: overrides.wall_approved ?? [],
      excluded: overrides.wall_exclude ?? [],
    });
    mintTesters = published;

    // Written whether or not anything is waiting, because an empty file is the
    // only way "nobody is pending" can be told apart from "the pull failed and
    // this file is stale".
    await writeFile(
      "wall-pending.json",
      `${JSON.stringify(
        {
          _comment: "Opted-in testers waiting for the owner. Rebuilt by aggregate.mjs on every run; editing it does nothing. This file is PUBLIC, like everything here, so an opt-in is visible before it is approved. To publish someone, copy their `key` into overrides.json -> wall_approved. To turn someone down, add their key to overrides.json -> wall_exclude, which drops them from this file on the next run.",
          updated_at: new Date().toISOString(),
          pending,
        },
        null,
        2,
      )}
`,
    );
    for (const p of pending) {
      console.log(`PENDING ${p.key}  ${p.badge.padEnd(8)} since ${p.since}  ${p.name}`);
    }
    console.log(
      `Tester wall: ${published.length} published, ${pending.length} awaiting approval` +
        (pending.length
          ? " (copy a key above into overrides.json -> wall_approved to publish it)"
          : ""),
    );
  } catch (e) {
    console.error(`Tester wall not refreshed (${e.message}); manifest.testers left unchanged.`);
  }
}

// --- R-OCS.10: the wall, its levels and its trophies --------------------------
//
// The trophy catalog ships in the manifest so the app renders a new one without
// a release. Hand-kept `badges.prealpha` names the testers who were here before
// the mint could prove it; `card_styles` is the fallback for a card style
// picked before the mint carried one.
const prealpha = new Set((overrides.badges?.prealpha ?? []).map((n) => fold(n)));
const eras = new Map(mintTesters.map((t) => [fold(t?.name), String(t?.badge ?? "")]));

manifest.achievements = ACHIEVEMENTS;
manifest.supporters = buildWall(
  [...records, ...applyAliases(afdianWall, overrides.aliases ?? {})],
  {
  patronUsd: PATRON_USD,
  prealpha,
  eras,
  cardStyles: overrides.card_styles ?? {},
});

// A donation that carried the app's code unlocks its trophies for that
// install. Only the hash of the code is published: the file names nobody, and
// the app recognizes its own row by hashing the code it already holds.
manifest.unlocks = buildUnlocks(records, manifest.supporters);

// A hand-listed tester with no donation has no supporter card to wear the
// trophy on, so they get a tester row instead. Written only when there is
// something to write, so a mint outage still leaves the last good roster alone.
const testers = mergeTesters({
  testers: mintTesters,
  prealpha: overrides.badges?.prealpha ?? [],
  onWall: manifest.supporters.map((s) => s.name),
});
if (testers.length || Array.isArray(manifest.testers)) manifest.testers = testers;

// The custom-amount minter (worker/donate) is published on the Stripe link
// only while it answers /health: the app draws its amount field off
// `custom_url`, so a Worker with no key, or a revoked one, withdraws the
// field instead of sending a donor to an error page (custom-amount.mjs).
const customAmountOn = await donateHealthy();
if (!customAmountOn) {
  console.warn(
    "worker/donate reports no Stripe key; custom_url left out of the manifest.",
  );
}
publishCustomAmount(manifest.links, { healthy: customAmountOn });

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
