# polyvox-supporters

Live data for the **Polyvox VRC** Supporters page. The app fetches
[`manifest.json`](./manifest.json) (a plain public `GET`, no auth) and renders
the funding-goal bars, the donation links, and the supporter wall from it. A
GitHub Action rebuilds it — on a schedule for Stripe, and within seconds of a
Ko-fi donation — so both move without shipping an app update.

Kept **separate** from the release repo on purpose: this repo holds a Stripe API
key and a bot that commits on every donation, and neither belongs anywhere near
the software-update channel.

## What's here

| File | Role |
|---|---|
| `manifest.json` | The live data the app polls (schema 1). Rebuilt by the Action — do not hand-edit goals or supporters. |
| `aggregate.mjs` | Folds Stripe + `ledger.json` + `overrides.json` into the goal totals and the wall. |
| `ledger.json` | Append-only record of donations Stripe cannot see. One entry per payment. |
| `ledger-append.mjs` | Adds one entry from a `repository_dispatch` payload; dedupes and strips anything not allowlisted. |
| `overrides.json` | Permanent founder entries, plus a manual per-goal $ nudge for money with no donor attached. |
| `worker/kofi-doorman.js` | Cloudflare Worker that turns a Ko-fi webhook into a `repository_dispatch`. |
| `.github/workflows/aggregate.yml` | Runs the above on dispatch, on cron (~2×/hour), and on demand. |

## How a donation reaches the app

```
Ko-fi ──webhook──▶ Cloudflare Worker ──repository_dispatch──▶ Action
                   (verifies token,                            │
                    DROPS the email,                    ledger-append.mjs
                    honours is_public)                         │
Stripe ◀──polled by the cron───────────────────────────▶ aggregate.mjs
                                                               │
                                                    commit manifest.json
                                                               │
                                    raw.githubusercontent.com/…/manifest.json
                                                               │
                                          app polls it (get_supporters_manifest)
```

Ko-fi is push-only with no read API, and its webhook cannot set an
`Authorization` header — which is exactly what `repository_dispatch` needs.
That gap is the only reason the Worker exists.

## One-time setup

1. **Restricted Stripe key** — Dashboard → Developers → API keys → *Create
   restricted key*. Grant **read** on *Checkout Sessions*; everything else
   **None**, including *Payment Intents*. `aggregate.mjs` only ever lists
   Checkout Sessions and reads `payment_intent` as the plain string id the list
   response already carries — it never expands or retrieves the intent, so
   granting that permission would widen the key for nothing. Copy the
   `rk_live_…`. Never use your `sk_live_` secret key here.
2. Add it here as a secret: **Settings → Secrets and variables → Actions → New
   repository secret**, named `STRIPE_RESTRICTED_KEY`. Never commit the key.
3. **Map your links to goals** — edit `LINK_TO_GOAL` at the top of
   `aggregate.mjs` with your Payment Link ids. That is the **`plink_…`** on the
   link's own page (or `GET /v1/payment_links`) — *not* the `buy.stripe.com/…`
   slug from the address bar. Anything unmapped (quick-donate tiers, custom
   amount) funds `living`.
4. **Deploy the Ko-fi doorman** — instructions are in the header comment of
   [`worker/kofi-doorman.js`](./worker/kofi-doorman.js).
5. **Add the name field to checkout** (this is what makes the wall opt-in for
   Stripe): on each Payment Link, add an **optional** text custom field with the
   key `display_name`, labelled something like *"Name for the supporters wall
   (leave blank to stay anonymous)"*. Blank is anonymous; the money still counts.
6. Run it once: **Actions → aggregate-supporters → Run workflow**.

Until the Stripe secret exists the Action still runs — it just skips the Stripe
rail and applies the ledger and overrides. Nothing breaks.

## Point the app at it

`MANIFEST_URL` in the app's `src-tauri/src/commands/supporters.rs` and
`native/app/src/supporters_data.rs` already points at this file's raw URL:

```
https://raw.githubusercontent.com/linkstar612/polyvox-supporters/main/manifest.json
```

For testing without a rebuild, launch the app with
`POLYVOX_SUPPORTERS_MANIFEST_URL=<that URL>`.

## Recording a donation by hand

Patreon, pixiv and BOOTH have no read API and no webhook we can receive, so they
are hand-appended. Add an entry to `ledger.json` and let the Action rebuild:

```json
{
  "id": "patreon:2026-07-alex",
  "platform": "patreon",
  "month": "2026-07",
  "amount": 10,
  "currency": "USD",
  "goal": "living",
  "name": "Alex",
  "link": "",
  "recurring": true
}
```

`id` must be unique — it is the dedupe key. `name: ""` counts toward the goal
without naming anyone.

### …including a Stripe payment that predates the poller

If you record a **Stripe** payment by hand — one that arrived before
`STRIPE_RESTRICTED_KEY` was configured — add its PaymentIntent as `stripe_pi`:

```json
{ "id": "stripe:pi_3Twkkw…", "platform": "stripe", "…": "…",
  "stripe_pi": "pi_3Twkkw…" }
```

Without it the payment is counted **twice** the moment the poller goes live:
the ledger knows a `pi_…` and the poller sees a `cs_…`, so they cannot match on
`id` alone. `stripe_pi` is what makes `aggregate.mjs` skip that session.

### Naming someone later

Everyone in `ledger.json` with `name: ""` is anonymous — counted, never shown.
To name them once they have said yes, set `name` on **every** entry that is
theirs (that is what groups a person across months) and let the Action rebuild.
Removing a name is the same edit in reverse.

## Notes

- **Nobody is named without opting in.** Ko-fi's `is_public` flag and Stripe's
  blank-able `display_name` field are the two consent gates, and
  `ledger-append.mjs` allowlists the fields that may be written at all. The
  donor's Ko-fi *message* is never forwarded — it was written to the developer,
  not to a public wall.
- **`manifest.json` is rebuilt, not patched.** A name added to it by hand will
  be gone on the next run; put founders in `overrides.json` and everyone else in
  `ledger.json`.
- **Amounts never reach the app per person.** The manifest carries aggregate USD
  per goal and a tier chip per supporter; the amount that earned the tier stays
  in `ledger.json`.
- **Cron lag**: GitHub's free scheduler runs 10–45 min late and skips under
  load, so Stripe donations show within ~an hour. The Ko-fi path does not wait
  on cron — it dispatches immediately.
