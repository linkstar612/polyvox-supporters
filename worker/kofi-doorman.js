// Ko-fi → GitHub doorman. Cloudflare Worker, free tier.
//
// Ko-fi's webhook cannot reach GitHub directly: `repository_dispatch` requires
// an `Authorization` header and Ko-fi's webhook UI has no way to set one. It
// also POSTs a form whose single `data` field is a JSON *string*, not a JSON
// body. This Worker is the ~50 lines that bridge both gaps.
//
// It is also the privacy boundary. Ko-fi sends the donor's EMAIL on every
// donation; nothing downstream of here is private, so the email is dropped in
// this file and never travels further. `is_public` is the donor's own answer
// to "may I be named", and it is honoured as given.
//
// Deploy, from this directory, with `wrangler.jsonc` alongside:
//   1. npx wrangler deploy
//   2. Set three secrets — `wrangler secret put NAME`, once each. `deploy`
//      leaves existing secrets alone, so this is a one-time step:
//        KOFI_TOKEN   ko-fi.com/manage/webhooks → Advanced → Verification Token
//        GH_TOKEN     a fine-grained PAT scoped to ONLY the polyvox-supporters
//                     repo with "Contents: read and write" — nothing else.
//                     That is what POST /repos/…/dispatches requires; Actions
//                     scope is for `workflow_dispatch`, a different endpoint
//        GH_REPO      linkstar612/polyvox-supporters
//   3. ko-fi.com/manage/webhooks → Webhook URL → paste the deployed URL → Update.
//   4. Press "Send Test" there. A test donation should appear in ledger.json
//      within a minute or two, and the goal bar moves on the next app poll.
//
// The dashboard route still works if you prefer it — Workers & Pages → Create →
// Worker, paste this file, add the three under Settings → Variables as SECRETS
// (not plaintext vars).
//
// `/stripe` is a second door, for Stripe's webhook (see `stripeDoorbell`). It
// needs one more secret, STRIPE_WEBHOOK_SECRET: the endpoint's `whsec_…`
// signing secret from Stripe → Developers → Webhooks.
//
// `/card` is the third (R-OJJ.11): a supporter's own edit to their own card,
// proven by their license file. It needs no new secret; see card-route.js.

import { handleCard } from "./card-route.js";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("ko-fi doorman", { status: 405 });
    }
    const path = new URL(request.url).pathname;
    if (path === "/stripe") {
      return stripeDoorbell(request, env);
    }
    // Routed before the Ko-fi branch, which reads every other POST as a form.
    if (path === "/card") {
      return handleCard(request, env);
    }

    let event;
    try {
      const form = await request.formData();
      event = JSON.parse(form.get("data"));
    } catch {
      return new Response("bad payload", { status: 400 });
    }

    // A missing secret is a deployment fault, not a prober, and the two must not
    // share an answer. Saying "ok" here would tell Ko-fi a real donation was
    // delivered, and it would never retry — so pasting the webhook URL before
    // setting KOFI_TOKEN would silently eat every tip in between. Ko-fi retries
    // a non-2xx and the workflow dedupes by `id`, so failing is the safe half.
    if (!env.KOFI_TOKEN) {
      return new Response("doorman not configured", { status: 503 });
    }

    // The only thing standing between this endpoint and anyone who finds the
    // URL. Compared in full, and the response is deliberately identical in
    // shape to a success so a prober learns nothing.
    if (event.verification_token !== env.KOFI_TOKEN) {
      return new Response("ok", { status: 200 });
    }

    // Shop orders are merchandise, not donations toward a funding goal.
    if (!["Donation", "Subscription", "Commission"].includes(event.type)) {
      return new Response("ok", { status: 200 });
    }

    // When the money moved, in UTC like the other live rails. `month` is cut
    // from the same string so the two can never disagree, and both fall back to
    // the arrival time together when Ko-fi sends none. `at` decides the
    // first-of-the-month trophy (cards.mjs).
    const paid = Date.parse(event.timestamp ?? "");
    const at = new Date(Number.isNaN(paid) ? Date.now() : paid).toISOString();
    const entry = {
      id: `kofi:${event.kofi_transaction_id}`,
      platform: "kofi",
      month: at.slice(0, 7),
      at,
      amount: Number(event.amount ?? 0),
      currency: event.currency ?? "USD",
      // Ko-fi has no per-goal concept, so its money funds the general goal.
      // Change this to route Ko-fi at a different goal.
      goal: "living",
      // is_public is the consent gate. A private donation still counts toward
      // the goal; it simply never carries a name off this Worker. `message` is
      // deliberately not forwarded — it is free text a donor wrote for the
      // developer, not copy for a public wall.
      name: event.is_public ? String(event.from_name ?? "").trim() : "",
      recurring: Boolean(event.is_subscription_payment),
    };

    const res = await fetch(
      `https://api.github.com/repos/${env.GH_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "polyvox-kofi-doorman",
        },
        body: JSON.stringify({
          event_type: "kofi-donation",
          client_payload: entry,
        }),
      },
    );

    // Ko-fi retries on a non-2xx, and the workflow dedupes by `id`, so a retry
    // is safe. Surfacing the failure is what makes the retry happen at all.
    if (!res.ok) {
      return new Response(`dispatch failed: ${res.status}`, { status: 502 });
    }
    return new Response("ok", { status: 200 });
  },

  // GH_TOKEN is the one credential here that expires, and it is exercised only
  // when a real donation arrives — so it can lapse in a quiet month and the
  // first thing to notice would be a lost tip. This writes its remaining life
  // into the repo weekly; `.github/workflows/token-watch.yml` reads that file
  // and shouts. Nothing warns about a token that is already dead, which is why
  // the alert threshold is three weeks rather than three days.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(recordTokenHealth(env));
  },
};

// --- Stripe: a doorbell, not a delivery --------------------------------------
//
// The aggregator polls Stripe on a cron that the free tier runs 3 to 10 hours
// apart, so a paid tip used to wait that long for the wall. Stripe's webhook
// rings here instead and the aggregator runs within a minute or two.
//
// The Stripe destination is registered with THIN payloads, whose type reads
// `v1.checkout.session.completed` and whose body is an event type and an
// object id: nothing about the donor reaches this Worker. A snapshot payload
// (same type without the `v1.`) is accepted too; it does carry the donor's
// email, and is read only for the signature and the type. Either way the
// dispatch carries nothing, because the aggregator re-reads Stripe with its
// own read-only key.

const STRIPE_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
]);

// Stripe's own default. A resent event is signed afresh, so this never
// rejects a redelivery, only a captured request replayed later.
const STRIPE_TOLERANCE_S = 300;

async function stripeDoorbell(request, env) {
  // Same reasoning as KOFI_TOKEN above: a 503 makes Stripe retry, so a URL
  // registered before its secret loses nothing.
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response("doorman not configured", { status: 503 });
  }
  const body = await request.text();
  const signed = await stripeSigned(
    body,
    request.headers.get("stripe-signature") ?? "",
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!signed) return new Response("bad signature", { status: 400 });

  let type;
  try {
    type = String(JSON.parse(body).type ?? "").replace(/^v1\./, "");
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  if (!STRIPE_EVENTS.has(type)) return new Response("ok", { status: 200 });

  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "polyvox-kofi-doorman",
    },
    body: JSON.stringify({ event_type: "stripe-payment" }),
  });
  // Stripe retries a non-2xx for three days, and an extra aggregator run is
  // harmless, so a failed dispatch is surfaced rather than swallowed.
  if (!res.ok) {
    return new Response(`dispatch failed: ${res.status}`, { status: 502 });
  }
  return new Response("ok", { status: 200 });
}

/** Stripe's v1 signature: the header is `t=<unix>,v1=<hex>[,v1=<hex>…]`, each
 *  `v1` an HMAC-SHA256 of `${t}.${body}` under the endpoint secret. Several
 *  `v1` entries appear while a secret is being rolled; any one matching is
 *  enough. Exported for the tests. */
export async function stripeSigned(body, header, secret, now = Date.now()) {
  const fields = header.split(",").map((f) => f.trim().split("="));
  const t = fields.find(([k]) => k === "t")?.[1];
  const sigs = fields.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || !sigs.length) return false;
  if (!(Math.abs(now / 1000 - Number(t)) <= STRIPE_TOLERANCE_S)) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  const want = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => sameText(s, want));
}

// Compares every character whatever it finds, so the time taken says nothing
// about how much of a forged signature was right.
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const STATUS_PATH = "worker-status.json";

async function recordTokenHealth(env) {
  const gh = (path, init) =>
    fetch(`https://api.github.com/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "polyvox-kofi-doorman",
        ...init?.headers,
      },
    });

  // Any authenticated call carries the expiry; asking the repo endpoint also
  // proves the token still has the access the dispatch path depends on.
  const probe = await gh(`repos/${env.GH_REPO}`);
  // GitHub returns "YYYY-MM-DD HH:MM:SS UTC", which Date cannot parse as-is.
  const raw = probe.headers.get("github-authentication-token-expiration");
  const expires = raw ? new Date(raw.replace(" UTC", "Z").replace(" ", "T")) : null;

  const status = {
    checked: new Date().toISOString(),
    gh_token: {
      valid: probe.ok,
      // A token set to never expire reports no header at all — distinct from
      // one whose expiry could not be read, so it is stated rather than nulled.
      expires: expires ? expires.toISOString() : null,
      days_left: expires ? Math.floor((expires - Date.now()) / 86_400_000) : null,
    },
  };

  // Contents: write is the only permission this token has, so committing a file
  // is the whole notification channel — it cannot open an issue, and widening it
  // to do so would undo the narrowing that keeps this key boring to leak.
  const existing = await gh(`repos/${env.GH_REPO}/contents/${STATUS_PATH}`);
  const sha = existing.ok ? (await existing.json()).sha : undefined;

  await gh(`repos/${env.GH_REPO}/contents/${STATUS_PATH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "chore: record doorman token health",
      content: btoa(`${JSON.stringify(status, null, 2)}\n`),
      ...(sha ? { sha } : {}),
    }),
  });
}
