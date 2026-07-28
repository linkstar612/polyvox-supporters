// Append one donation to ledger.json from a repository_dispatch payload.
//
// The Ko-fi doorman Worker cannot write files — it only fires a
// `repository_dispatch` — so the workflow runs this, then aggregate.mjs, then
// commits both. Reads the payload from LEDGER_ENTRY (raw JSON).
//
// This is the last gate before a donor's name becomes world-readable, so it
// re-checks the two things the Worker already checked. Defence in depth is
// cheap here and a mistake is not retractable: the file is public and mirrored
// by anyone who cloned it.

import { readFile, writeFile } from "node:fs/promises";

const raw = process.env.LEDGER_ENTRY;
if (!raw) {
  console.error("LEDGER_ENTRY not set — nothing to append.");
  process.exit(1);
}

const incoming = JSON.parse(raw);

// Allowlist, not blocklist: anything the Worker invents beyond these keys is
// dropped rather than trusted. `email` is the field this exists to stop.
const entry = {
  id: String(incoming.id ?? "").slice(0, 128),
  platform: String(incoming.platform ?? "").slice(0, 32),
  month: String(incoming.month ?? "").slice(0, 7),
  amount: Number(incoming.amount ?? 0),
  currency: String(incoming.currency ?? "USD").slice(0, 8).toUpperCase(),
  goal: String(incoming.goal ?? "living").slice(0, 32),
  name: String(incoming.name ?? "").trim().slice(0, 48),
  link: "",
  // NOT `Boolean(...)`: a dispatch sent as form fields (`gh api -f`, curl)
  // delivers the string "false", and `Boolean("false")` is true — which would
  // read as a standing subscription and promote a one-off donor to patron.
  recurring: incoming.recurring === true || incoming.recurring === "true",
  // Only set when a Stripe payment was recorded by hand before the poller was
  // switched on: it is how aggregate.mjs knows not to count it twice.
  ...(incoming.stripe_pi
    ? { stripe_pi: String(incoming.stripe_pi).slice(0, 64) }
    : {}),
};

if (!entry.id || !entry.platform || !/^\d{4}-\d{2}$/.test(entry.month)) {
  console.error("Malformed entry (id / platform / month) — refusing.", entry);
  process.exit(1);
}
if (!Number.isFinite(entry.amount) || entry.amount <= 0) {
  console.error("Non-positive amount — refusing.", entry);
  process.exit(1);
}

const ledger = JSON.parse(await readFile("ledger.json", "utf8"));
// Ko-fi retries a webhook it thinks failed, and a retry carries the same
// kofi_transaction_id — without this the same coffee is counted twice.
if (ledger.entries.some((e) => e.id === entry.id)) {
  console.log(`Already recorded: ${entry.id} — no change.`);
  process.exit(0);
}

ledger.entries.push(entry);
await writeFile("ledger.json", `${JSON.stringify(ledger, null, 2)}\n`);
console.log(
  `Recorded ${entry.platform} ${entry.amount} ${entry.currency} → ${entry.goal}` +
    ` (${entry.name ? "named" : "anonymous"})`,
);
