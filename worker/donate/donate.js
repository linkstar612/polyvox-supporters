// Custom-amount donation minter. Cloudflare Worker, free tier.
//
// The quick-donate pills are Stripe Payment Links, and a Payment Link is a
// fixed price: the presets stop at $50, and Stripe's "customer chooses" link
// caps at $10,000, cannot take the amount from a URL, and makes the donor type
// the number twice. This Worker takes the amount the app already asked for,
// mints a one-time Checkout Session for exactly that, and sends the browser
// there. Nothing is stored here and no donor detail passes through: the
// browser leaves for checkout.stripe.com and Stripe owns everything after.
//
// Routes:
//   GET /?amount=<usd>&ref=<code>  mint a session for <usd> and 303 to it.
//                                  `ref` is the app's supporter code
//                                  (R-OCS.10); it rides as client_reference_id,
//                                  the field the Payment Links already carry,
//                                  so aggregate.mjs needs no new case.
//   GET /health                    200 when STRIPE_RESTRICTED_KEY is set, 503
//                                  until then. aggregate.mjs polls this and
//                                  publishes `custom_url` only while it is 200.
//   GET /thanks                    where Stripe returns the donor afterwards.
//
// Deploy, from this directory:
//   1. npx wrangler deploy
//   2. npx wrangler secret put STRIPE_RESTRICTED_KEY
//      Dashboard -> Developers -> API keys -> Create restricted key. Grant
//      WRITE on Checkout Sessions and nothing else, then paste the rk_live_...
//      Never the sk_live_ secret key, and not the read-only key the Action
//      holds: this one creates sessions, that one lists them, and neither
//      needs the other's permission.
//   Until step 2 every mint answers 503 and the manifest carries no
//   `custom_url`, so the app shows no amount field rather than a dead one.
//
// Stripe's ceiling is the only cap. Cards take up to 999,999,999,999 in minor
// units (docs.stripe.com/currencies), so the range check below refuses
// nothing a card could pay.

const MIN_CENTS = 100;
const MAX_CENTS = 999_999_999_999;
const REF_RE = /^[A-Za-z0-9_-]{1,200}$/;
const PRODUCT_NAME = "Polyvox donation";

// aggregate.mjs matches the wall-name field with non-alphanumerics stripped
// against "displayname", so the key stays alphanumeric. Optional, always:
// leaving it blank is how a donor stays anonymous, and the money still counts.
const NAME_FIELD_KEY = "displayname";
const NAME_FIELD_LABEL = "Name for the supporters wall (blank = anonymous)";

const STRIPE_SESSIONS = "https://api.stripe.com/v1/checkout/sessions";

/** Parse the `amount` query value into cents, or say why not.
 *  Accepts "12", "12.5", "12.50", "$1,000", surrounding whitespace. Refuses
 *  signs, exponents, a third decimal, and anything outside Stripe's range. */
export function parseAmount(raw) {
  const text = String(raw ?? "")
    .trim()
    .replace(/^\$/, "")
    .replace(/,/g, "");
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(text)) return { error: "not a number" };
  const [whole, frac = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (cents < MIN_CENTS) return { error: "below minimum" };
  if (cents > MAX_CENTS) return { error: "above maximum" };
  return { cents };
}

/** The supporter code, or "" when it is missing or not something Stripe
 *  accepts as a reference. Codes are `PV-` plus hex, so a real one never
 *  trips this. */
export function sanitizeRef(raw) {
  const text = String(raw ?? "").trim();
  return REF_RE.test(text) ? text : "";
}

/** The form body for POST /v1/checkout/sessions. Bracket keys are Stripe's
 *  encoding for nested params. */
export function sessionParams({ cents, ref, origin }) {
  const p = new URLSearchParams();
  p.set("mode", "payment");
  p.set("submit_type", "donate");
  p.set("line_items[0][price_data][currency]", "usd");
  p.set("line_items[0][price_data][unit_amount]", String(cents));
  p.set("line_items[0][price_data][product_data][name]", PRODUCT_NAME);
  p.set("line_items[0][quantity]", "1");
  p.set("custom_fields[0][key]", NAME_FIELD_KEY);
  p.set("custom_fields[0][label][type]", "custom");
  p.set("custom_fields[0][label][custom]", NAME_FIELD_LABEL);
  p.set("custom_fields[0][type]", "text");
  p.set("custom_fields[0][optional]", "true");
  p.set("success_url", `${origin}/thanks`);
  p.set("metadata[source]", "polyvox-app-custom-amount");
  if (ref) p.set("client_reference_id", ref);
  return p;
}

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
};

/** A one-paragraph page. Every non-redirect answer a donor can see is one of
 *  these: short, plain, and saying only what to do next. */
function page(status, title, text) {
  const body =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style>` +
    `</head><body><h1>${title}</h1><p>${text}</p></body></html>`;
  return new Response(body, { status, headers: HEADERS });
}

export async function handle(request, env, fetchImpl = fetch) {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return new Response(env.STRIPE_RESTRICTED_KEY ? "ok" : "no key", {
      status: env.STRIPE_RESTRICTED_KEY ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/thanks") {
    return page(
      200,
      "Thank you",
      "Your donation went through. You can close this tab.",
    );
  }
  if (url.pathname !== "/") {
    return new Response("not found", { status: 404 });
  }

  if (!env.STRIPE_RESTRICTED_KEY) {
    return page(
      503,
      "Not available yet",
      "Custom-amount donations are not switched on yet. The preset amounts in Polyvox still work.",
    );
  }

  const parsed = parseAmount(url.searchParams.get("amount"));
  if (parsed.error) {
    return page(400, "Amount", "Enter an amount of $1.00 or more.");
  }

  // Ten mints a minute per address. A donor needs one; a script that found
  // the URL would otherwise fill the Stripe dashboard with open sessions.
  if (env.DONATE_RL) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.DONATE_RL.limit({ key: ip });
    if (!success) {
      return page(
        429,
        "Slow down",
        "Too many requests from this connection. Wait a minute and try again.",
      );
    }
  }

  const ref = sanitizeRef(url.searchParams.get("ref"));
  const body = sessionParams({ cents: parsed.cents, ref, origin: url.origin });

  let res;
  try {
    res = await fetchImpl(STRIPE_SESSIONS, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "polyvox-donate",
      },
      body: body.toString(),
    });
  } catch (err) {
    console.error(`stripe unreachable: ${err?.message ?? err}`);
    return page(502, "Stripe", "Stripe did not answer. Try again in a moment.");
  }

  if (!res.ok) {
    // The key never reaches the log; the message is Stripe's own text.
    const detail = await res.text().catch(() => "");
    console.error(`stripe ${res.status}: ${detail.slice(0, 300)}`);
    return page(
      502,
      "Stripe",
      "Stripe did not accept the request. Try again in a moment.",
    );
  }

  const session = await res.json().catch(() => null);
  if (!session?.url) {
    console.error("stripe answered without a session url");
    return page(502, "Stripe", "Stripe did not answer. Try again in a moment.");
  }

  return new Response(null, {
    status: 303,
    headers: { Location: session.url, "cache-control": "no-store" },
  });
}

export default {
  fetch: (request, env) => handle(request, env, fetch),
};
