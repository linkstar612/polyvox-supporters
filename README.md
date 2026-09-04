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
| `manifest.json` | The live data the app polls (schema 1). Rebuilt by the Action — do not hand-edit goals or supporters. The two top-level `cn_alipay_url` / `cn_wechat_url` keys are the exception: hand-kept payloads of the mainland wallet codes, which `aggregate.mjs` parses and writes back untouched (see the app repo's `docs/CN-QR-DONATION-SETUP.md`). |
| `aggregate.mjs` | Folds Stripe + Afdian + `ledger.json` + `overrides.json` into the goal totals and the wall, and pulls the tester roster from the license mint. |
| `afdian.mjs` | The Afdian (爱发电) rail: signing, paging, and the order/sponsor split. Importable with no side effects, which is what makes it testable. |
| `test/` | `npm test` (`node --test "test/**/*.test.mjs"`). No dependencies. |
| `ledger.json` | Append-only record of donations Stripe cannot see. One entry per payment. |
| `ledger-append.mjs` | Adds one entry from a `repository_dispatch` payload; dedupes and strips anything not allowlisted. |
| `overrides.json` | Permanent founder entries, a manual per-goal $ nudge for money with no donor attached, the CNY rate, the Afdian goal, and the tester-wall approval and strike lists. |
| `wall.mjs` | Splits the opted-in roster into what is approved and what is waiting. |
| `wall-pending.json` | Opted-in testers waiting for the owner. Rebuilt every run; a queue, never a roster. |
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
   key `displayname`, labelled something like *"Name for the supporters wall
   (leave blank to stay anonymous)"*. Blank is anonymous; the money still counts. Stripe derives the field key from the label and permits alphanumerics only, so a label of "Display name" yields the key displayname, with no underscore; it must match NAME_FIELD in aggregate.mjs.
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

## Recording a WeChat or Alipay payment

**Nothing polls these, and nothing ever will.** アたる's WeChat and Alipay
collection codes are *personal* codes tied to her own account. Neither wallet
exposes an API for one, so a payment scanned into it is invisible to
`aggregate.mjs` until a human writes it down. Until that entry exists the goal
bars have not moved and the donor is nowhere on the wall.

Record it by adding an entry to `ledger.json` and letting the Action rebuild.
`platform` is the rail (`wechat` or `alipay`; `ledger-append.mjs` accepts any
non-empty value and does not need a code change for these), and `amount` is the
figure actually received:

```json
{
  "id": "wechat:2026-09-04-01",
  "platform": "wechat",
  "month": "2026-09",
  "amount": 50,
  "currency": "CNY",
  "goal": "living",
  "name": "",
  "link": "",
  "recurring": false
}
```

- **Record the yuan, not the dollars.** `currency: "CNY"` and the raw amount;
  `aggregate.mjs` converts through `overrides.json` → `fx.cny_per_usd`
  (patched over the manifest's own snapshot). Converting by hand and writing
  `USD` freezes that day's rate into the ledger forever. If you must record USD,
  divide by the same `cny_per_usd` and say so in a `note`.
- **`id` must be unique.** It is the only dedupe key. Date plus a counter is
  enough; a screenshot filename is not, because it changes.
- **`name` only with consent.** Blank counts toward the goal and names nobody,
  which is the correct default for a wallet transfer: the payer was never asked.
  Fill it in once they have said yes, on every entry that is theirs.
- **Never put a WeChat ID, an Alipay account, a phone number or a transfer memo
  in this file.** It is world-readable and mirrored by anyone who cloned it.

Refresh `fx.cny_per_usd` and `fx.as_of` in `overrides.json` when the rate has
drifted enough to matter. It applies to the Afdian rail as well.

## Afdian (爱发电)

The one CN rail that moves the bars by itself. Orders fund the goal named by
`overrides.json` → `afdian_goal`; sponsors (who carry a display name) become
cards on the wall. Both are polled by the same cron that polls Stripe.

**The one owner step**: on afdian.com, open the creator dashboard's developer
page (开发者 / API), copy the **user id** and the **token**, then add both here as
Actions secrets:

| Secret | Value |
|---|---|
| `AFDIAN_USER_ID` | The developer user id from that page |
| `AFDIAN_TOKEN` | The token from that page. Rotating it there requires updating it here. |

Both or neither. With either missing, `aggregate.mjs` prints
`AFDIAN_USER_ID / AFDIAN_TOKEN not set. Afdian orders and sponsors skipped` and
publishes every other rail as usual.

Details worth knowing:

- **Money is `total_amount`, in CNY.** `show_amount` is the pre-discount price
  and would over-report; an order paid with a redeem code has `total_amount`
  `0.00` and is dropped, because no money arrived.
- **Orders are anonymous; sponsors are named.** An order carries a user id and
  no display name, so orders only feed the total. The name on a card comes from
  `query-sponsor`, which is the same name Afdian already shows publicly on the
  creator page. There is no separate consent flag on that endpoint, so
  `overrides.json` → `wall_exclude` is the strike list: add a name to it and the
  next rebuild drops the card while keeping the money.
- **A standing plan is a patron.** Afdian has no auto-renew, so a sponsor
  holding a `current_plan` is someone who chose to renew, and that is what earns
  the recurring chip. No amount ever reaches the app per person.
- **An Afdian order recorded by hand** uses the id `afdian:<out_trade_no>`,
  which is what stops the poller counting it again.

## The opt-in pre-alpha tester wall (R-DON.6)

`manifest.testers` is a roster of people who *asked* to be acknowledged as early
testers **and whom the owner then approved**. It is not derived here:
`aggregate.mjs` reads `GET /wall` from the license mint Worker, which is the only
thing that can check an Ed25519 signature against the shipped keys.

Opting in through the app is a **request**. Nothing is published until its key is
in `overrides.json` → `wall_approved`, so an unreviewed name cannot appear on a
page the owner publishes under their own name.

| Secret | Value |
|---|---|
| `MINT_ADMIN_TOKEN` | The same value as the Worker's `ADMIN_TOKEN` secret. |

Set `MINT_BASE_URL` as an Actions *variable* only if the Worker ever moves.

- **Unset is safe.** The run prints
  `MINT_ADMIN_TOKEN not set. Tester wall skipped` and leaves `manifest.testers`
  exactly as the last good run wrote it. An unreachable Worker does the same and
  logs an error rather than failing the run: this script also publishes the
  donation totals, and failing it over a badge would cost a donation its record.
- **Four fields per person**, and the endpoint returns nothing else:

  ```json
  { "id": "a1b2c3d4e5f60718", "name": "Sam", "badge": "prealpha", "since": "2026-07-04" }
  ```

  No machine code, no license, no role. A value that never crosses the wire
  cannot end up in this public file by mistake. `id` is the approval key; only
  `name`, `badge` and `since` reach `manifest.testers`.
- **`overrides.json` → `wall_exclude`** strikes someone already approved,
  matching either the key or the display name (case-folded), and beats an
  approval. Leaving instead of being struck is `DELETE /wall/opt-in` from the
  app, which is theirs to do.

### Approving a tester

1. Every run rewrites **`wall-pending.json`** with everyone who has opted in and
   is not yet approved, and prints one `PENDING` line each plus a count:

   ```
   PENDING a1b2c3d4e5f60718  prealpha since 2026-07-04  Zoe
   Tester wall: 0 published, 1 awaiting approval (copy a key above into overrides.json → wall_approved to publish it)
   ```

2. To publish someone, copy their **`key`** into `overrides.json` →
   `wall_approved` and commit. The next run moves them into `manifest.testers`
   and drops them from the pending file.
3. To turn someone down, do nothing. They stay in `wall-pending.json`, which is
   a queue and not a roster: nothing is ever published from it.
4. To remove someone already published, add their key or their name to
   `wall_exclude`. That beats the approval, and they do not return to the queue.

The key is a one-way digest of the machine code, computed by the Worker. It is
stable across a rename, which is why approval is not keyed on the display name,
and it is not the machine code, which is the seat key and does not belong in a
public file.

## Notes

- **Nobody is named without opting in.** Ko-fi's `is_public` flag and Stripe's
  blank-able `displayname` field are the two consent gates, and
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
