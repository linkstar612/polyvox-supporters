// The custom-amount rail: publish the minter's URL on the Stripe link only
// while the minter says it is configured.
//
// `worker/donate` answers /health with 200 once STRIPE_RESTRICTED_KEY is set
// and 503 until then. The app renders its amount field only when the manifest
// carries `custom_url`, so this probe is the switch: setting the secret
// publishes the field on the next run, revoking it withdraws the field, and
// nobody edits manifest.json by hand for either.

export const DONATE_URL = "https://polyvox-donate.terry61295.workers.dev";
export const DONATE_MIN_USD = 1;

/** True when the minter reports itself configured. Any failure (network,
 *  5xx, a Worker that does not exist yet) is "not healthy": the field stays
 *  off rather than pointing at an error page. */
export async function donateHealthy(fetchImpl = fetch, base = DONATE_URL) {
  try {
    const res = await fetchImpl(`${base}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Set or clear `custom_url` / `custom_min_usd` on the Stripe link, in place.
 *  Returns the link it touched, or null when there is no Stripe link. */
export function publishCustomAmount(
  links,
  { healthy, url = DONATE_URL, minUsd = DONATE_MIN_USD },
) {
  const link = (links ?? []).find((l) => l.platform === "stripe");
  if (!link) return null;
  if (healthy) {
    link.custom_url = url;
    link.custom_min_usd = minUsd;
  } else {
    delete link.custom_url;
    delete link.custom_min_usd;
  }
  return link;
}
