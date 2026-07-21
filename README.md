# polyvox-supporters

Live data for the **Polyvox VRC** Supporters page. The app fetches
[`manifest.json`](./manifest.json) (a plain public `GET`, no auth) and renders
the funding-goal bars, donation links, and supporter list from it. A GitHub
Action refreshes the goal totals from Stripe on a schedule, so the bars move
without shipping an app update.

Kept **separate** from the release repo on purpose: this repo holds a Stripe API
key and a bot that commits every ~30 min, and neither belongs anywhere near the
software-update channel.

## What's here

| File | Role |
|---|---|
| `manifest.json` | The live data the app polls (schema 1). |
| `aggregate.mjs` | Sums paid Stripe checkouts into each goal's `current_usd`. |
| `overrides.json` | Manual per-goal $ for rails with no read API (Ko-fi, Patreon, pixiv, BOOTH). |
| `.github/workflows/aggregate.yml` | Cron (~2×/hour) that runs the aggregator and commits changes. |

## One-time setup

1. **Restricted Stripe key** — Stripe Dashboard → Developers → API keys →
   *Create restricted key*. Grant **read** on *Charges*, *Checkout Sessions*,
   *PaymentIntents*, *Balance*; everything else **None**. Copy the `rk_live_…`.
2. Add it here as a secret: repo **Settings → Secrets and variables → Actions →
   New repository secret**, named `STRIPE_RESTRICTED_KEY`. (Never commit the key.)
3. **Map your links to goals** — edit `LINK_TO_GOAL` at the top of
   `aggregate.mjs` with your Payment Link ids (`pl_…`, from Dashboard → Payment
   Links). Anything unmapped (quick-donate tiers, custom amount) funds `living`.
4. Run it once: **Actions → aggregate-supporters → Run workflow**. Confirm
   `manifest.json` updates.

Until the secret exists the Action is a green no-op and the app just shows the
seed numbers — nothing breaks.

## Point the app at it

In the app repo, set `MANIFEST_URL` in
`src-tauri/src/commands/supporters.rs` to this file's raw URL:

```
https://raw.githubusercontent.com/linkstar612/polyvox-supporters/main/manifest.json
```

For testing without a rebuild, launch the app with
`POLYVOX_SUPPORTERS_MANIFEST_URL=<that URL>`.

## Notes

- **Ko-fi / Patreon / pixiv / BOOTH** have no read API — put their totals in
  `overrides.json` by hand; the aggregator adds them on top of the Stripe sums.
- **Cron lag**: GitHub's free scheduler runs the job 10–45 min late and skips
  under load. A donation shows on the bar within ~an hour, not instantly.
- **Privacy**: `manifest.json` only ever contains aggregate USD totals and
  public links/names — never emails, card data, or raw Stripe records.
- **Donor wall** (opt-in name/link display) is a planned addition: the checkout
  `custom_fields` are already available to `aggregate.mjs`; wiring waits on the
  publish/amount/field decisions.
