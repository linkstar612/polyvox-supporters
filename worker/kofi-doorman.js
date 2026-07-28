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
// Deploy:
//   1. dash.cloudflare.com → Workers & Pages → Create → Worker. Paste this.
//   2. Settings → Variables → add three SECRETS (not plaintext vars):
//        KOFI_TOKEN   ko-fi.com/manage/webhooks → Advanced → Verification Token
//        GH_TOKEN     a fine-grained PAT scoped to ONLY the polyvox-supporters
//                     repo with "Contents: read and write" — nothing else
//        GH_REPO      linkstar612/polyvox-supporters
//   3. Deploy, copy the *.workers.dev URL.
//   4. ko-fi.com/manage/webhooks → Webhook URL → paste it → Update.
//   5. Press "Send Test" there. A test donation should appear in ledger.json
//      within a minute or two, and the goal bar moves on the next app poll.

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("ko-fi doorman", { status: 405 });
    }

    let event;
    try {
      const form = await request.formData();
      event = JSON.parse(form.get("data"));
    } catch {
      return new Response("bad payload", { status: 400 });
    }

    // The only thing standing between this endpoint and anyone who finds the
    // URL. Compared in full, and the response is deliberately identical in
    // shape to a success so a prober learns nothing.
    if (!env.KOFI_TOKEN || event.verification_token !== env.KOFI_TOKEN) {
      return new Response("ok", { status: 200 });
    }

    // Shop orders are merchandise, not donations toward a funding goal.
    if (!["Donation", "Subscription", "Commission"].includes(event.type)) {
      return new Response("ok", { status: 200 });
    }

    const entry = {
      id: `kofi:${event.kofi_transaction_id}`,
      platform: "kofi",
      month: (event.timestamp ?? new Date().toISOString()).slice(0, 7),
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
};
