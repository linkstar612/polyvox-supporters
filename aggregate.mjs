// Refresh each goal's `current_usd` in manifest.json from Stripe.
//
// Runs in GitHub Actions on a cron (see .github/workflows/aggregate.yml).
// Needs one secret: STRIPE_RESTRICTED_KEY — a READ-ONLY restricted key
// (Charges/Checkout Sessions/PaymentIntents/Balance: read). Never commit it.
//
// Node 20+ (global fetch, no npm install). No secrets are ever written to
// manifest.json — only aggregate USD totals and the public links/recognition
// already in the file.

import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.STRIPE_RESTRICTED_KEY;
if (!KEY) {
  console.warn(
    "STRIPE_RESTRICTED_KEY not set — skipping refresh. Add the repo secret to enable auto-update.",
  );
  process.exit(0); // green no-op until the key is configured
}

// Map each Stripe Payment Link id (pl_…) to the goal it funds. Find the ids at
// Dashboard → Payment Links, or `GET /v1/payment_links`. Any link NOT listed
// here (quick-donate tiers, the custom-amount link) funds DEFAULT_GOAL.
const LINK_TO_GOAL = {
  // "pl_...dev200":       "dev_costs",
  // "pl_...expedited400": "expedited",
  // "pl_...living500":    "living",
  // "pl_...livingMonthly":"living",
};
const DEFAULT_GOAL = "living";

async function stripe(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(
    `https://api.stripe.com/v1/${path}${qs ? `?${qs}` : ""}`,
    { headers: { Authorization: `Bearer ${KEY}` } },
  );
  if (!res.ok) {
    throw new Error(`Stripe ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Sum paid Checkout Sessions per goal (running total each goal has raised).
async function sumByGoal() {
  const totals = {};
  let startingAfter;
  do {
    const page = await stripe("checkout/sessions", {
      limit: "100",
      status: "complete",
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const s of page.data) {
      if (s.payment_status !== "paid") continue;
      const goal = LINK_TO_GOAL[s.payment_link] ?? DEFAULT_GOAL;
      totals[goal] = (totals[goal] ?? 0) + (s.amount_total ?? 0) / 100;
    }
    startingAfter = page.has_more ? page.data.at(-1).id : null;
  } while (startingAfter);
  return totals;
}

// Donor wall (future): each session also carries `custom_fields` (the opt-in
// display name / link the donor typed at checkout) and `customer_details`.
// Once the wall's publish/amount/field decisions are settled, read those here
// and rebuild manifest.supporters — opt-in only, https-scheme-gated links,
// never emails or raw PII. Left out until then.

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
let overrides = { manual_usd: {} };
try {
  overrides = JSON.parse(await readFile("overrides.json", "utf8"));
} catch {
  /* no overrides file — Stripe totals only */
}

const stripeTotals = await sumByGoal();
for (const goal of manifest.goals) {
  const auto = stripeTotals[goal.id] ?? 0;
  const manual = overrides.manual_usd?.[goal.id] ?? 0;
  goal.current_usd = Math.round((auto + manual) * 100) / 100;
}
manifest.updated_at = new Date().toISOString();

await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  "Refreshed:",
  manifest.goals.map((g) => `${g.id}=$${g.current_usd}`).join("  "),
);
