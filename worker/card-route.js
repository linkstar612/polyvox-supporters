// R-OJJ.11: `POST /card`, a supporter's own edit to their own card.
//
// **Why the proof is the license file and not the donation code.** The code is
// six base32 characters, 30 bits of the license digest (license.rs,
// `supporter_code_from`). That is not a secret: `manifest.unlocks` publishes
// SHA-256 of every code, which a laptop inverts in seconds by trying all 2^30,
// and a donor who typed the code into a payment memo has it in ledger.json in
// plain text. A keyed hash of the code under a Worker secret does not help
// either, since the app could not compute it and the code underneath is still
// recoverable. So the app sends the license file the code was derived from.
// This route checks its Ed25519 signature against the two keys every shipped
// build carries, refuses the transferable license (it is compiled into every
// binary, so anyone holds it), and derives the code itself. Forging that needs
// a signing key; borrowing it needs the supporter's disk.
//
// The license is read, verified and dropped inside this request. It is never
// stored, logged or forwarded. What reaches the repo is the SHA-256 of the
// derived code (already public in `manifest.unlocks`) and the fields chosen.
//
// The edit is written to card-edits.json through the GitHub contents API with
// the doorman's existing GH_TOKEN (Contents: write). That is a push touching a
// watched path, so the aggregator runs and merges it (cards.mjs,
// `applyCardEdits`). The owner reverts any card through overrides.json ->
// `card_edit_reverts`. The Worker never writes overrides.json, so it can never
// race a hand edit there.

import { CARD_EDIT_INTERVAL_S, checkEdit } from "../card-edit.mjs";

/// The two Ed25519 public keys every shipped build verifies against
/// (crates/polyvox-license/src/lib.rs, PUBLIC_KEY_HEX then MINT_PUBLIC_KEY_HEX).
/// Public halves, compiled into every binary, so naming them discloses nothing.
export const LICENSE_KEYS_HEX = [
  "4430a8121a37b33b55928aa0be44d0702e87dc7e4ea6d2a93de73d699b413e67",
  "83c06a5e3ee80f8f1b58bbdfbf64a130c49b287ddd119aadd577a35c66c09e7c",
];

const TRANSFERABLE_HWID = "transferable";
const MAX_LICENSE_BYTES = 8192;
const MAX_BODY_BYTES = 16384;
const EDITS_PATH = "card-edits.json";
const MANIFEST_PATH = "manifest.json";

const EDITS_COMMENT =
  "Card edits supporters made from inside Polyvox (R-OJJ.11), written by the doorman Worker's POST /card and merged by aggregate.mjs. Keyed by SHA-256 of the app's donation code, the same key manifest.unlocks uses. Each value is the fields that supporter chose and when. To revert a card, add its name or key to overrides.json -> card_edit_reverts; deleting an entry here also works, but the supporter can send it again.";

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

// --- The license -----------------------------------------------------------

/// The signed body, field by field in `License`'s declaration order, with the
/// three optional tails omitted when unused. Ported from the license mint's
/// `canonical.js`; see there for why each rule is load-bearing.
export function canonicalBodyOfSigned(signed) {
  const body = {
    licensee: signed?.licensee,
    issued_at: signed?.issued_at,
    hwid_hash: signed?.hwid_hash,
    expires_at: signed?.expires_at ?? null,
    role: signed?.role ?? "",
  };
  if (signed?.bound_version) body.bound_version = signed.bound_version;
  if (signed?.min_version) body.min_version = signed.min_version;
  if (Array.isArray(signed?.entitlements) && signed.entitlements.length > 0) {
    body.entitlements = signed.entitlements;
  }
  return body;
}

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => Number.parseInt(h, 16));

function b64Bytes(b64) {
  try {
    return Uint8Array.from(atob(String(b64 ?? "").trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** True when any of `keys` (raw 32-byte Uint8Arrays) signed this license. */
export async function licenseSigned(signed, keys) {
  const sig = b64Bytes(signed?.signature);
  if (!sig || sig.length !== 64) return false;
  const msg = new TextEncoder().encode(JSON.stringify(canonicalBodyOfSigned(signed)));
  for (const raw of keys) {
    try {
      const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg)) return true;
    } catch {
      // A key that will not import is a deployment fault; try the next.
    }
  }
  return false;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The app's donation code for this exact license file text: `PV-` plus the
 *  first 30 bits of SHA-256 of the file's bytes, six base32 characters
 *  (license.rs, `supporter_code_from`). The text must be the file verbatim,
 *  as `read_to_string` returned it; a reformatted copy derives another code. */
export async function donationCode(licenseText) {
  const d = await sha256(new TextEncoder().encode(licenseText));
  const bits = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  let code = "PV-";
  for (let slot = 0; slot < 6; slot += 1) {
    code += ALPHABET[(bits >>> (32 - 5 * (slot + 1))) & 31];
  }
  return code;
}

export const codeHash = async (code) => hex(await sha256(new TextEncoder().encode(code)));

// --- GitHub ------------------------------------------------------------------

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "polyvox-kofi-doorman",
      ...init.headers,
    },
  });
}

const fromB64Utf8 = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));

function toB64Utf8(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A repo file's parsed JSON and blob sha, `{ data: null }` when it does not
 *  exist yet, or `{ failed: status }`. */
async function readRepoJson(env, path) {
  const res = await gh(env, path);
  if (res.status === 404) return { data: null, sha: undefined };
  if (!res.ok) return { failed: res.status };
  const file = await res.json();
  try {
    return { data: JSON.parse(fromB64Utf8(file.content ?? "")), sha: file.sha };
  } catch {
    return { failed: 500 };
  }
}

// --- The route -----------------------------------------------------------------

/** `POST /card`. `now` is injectable for the tests. */
export async function handleCard(request, env, { now = Date.now(), keys } = {}) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "bad_json" }, 400);

  // Fields first: free to check, and a refusal here costs no signature check.
  const clear = body.clear === true;
  const checked = clear ? { edit: {} } : checkEdit(body);
  if (checked.error) return json(checked, 400);

  // The proof. Every refusal here is 403, so a prober cannot tell a forged
  // license from a real one with no card.
  const licenseText = body.license;
  if (typeof licenseText !== "string" || !licenseText || licenseText.length > MAX_LICENSE_BYTES) {
    return json({ error: "bad_license" }, 403);
  }
  let signed;
  try {
    signed = JSON.parse(licenseText);
  } catch {
    return json({ error: "bad_license" }, 403);
  }
  if (!(await licenseSigned(signed, keys ?? LICENSE_KEYS_HEX.map(hexBytes)))) {
    return json({ error: "bad_license" }, 403);
  }
  if (String(signed.hwid_hash ?? "").trim().toLowerCase() === TRANSFERABLE_HWID) {
    return json({ error: "license_not_machine_bound" }, 403);
  }
  const key = await codeHash(await donationCode(licenseText));

  // Nothing above touched GitHub, so a prober spends none of the token.
  if (!env.GH_TOKEN || !env.GH_REPO) return json({ error: "not_configured" }, 503);

  const manifest = await readRepoJson(env, MANIFEST_PATH);
  if (manifest.failed) return json({ error: "upstream" }, 502);
  if (!(manifest.data?.card_codes ?? []).includes(key)) return json({ error: "no_card" }, 403);

  // Read, change, write with the blob sha; a 409 or 422 means somebody else
  // wrote first, so read again. The rate limit lives in the same file, which
  // needs no storage binding and survives a redeploy.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await readRepoJson(env, EDITS_PATH);
    if (file.failed) return json({ error: "upstream" }, 502);
    const edits = { ...(file.data?.edits ?? {}) };
    const last = Date.parse(edits[key]?.at ?? "");
    const wait = Number.isNaN(last) ? 0 : Math.ceil(CARD_EDIT_INTERVAL_S - (now - last) / 1000);
    if (wait > 0) {
      return json({ error: "rate_limited", retry_after: wait }, 429, { "retry-after": String(wait) });
    }
    const at = new Date(now).toISOString();
    if (clear) {
      // Kept as an empty edit with its time, so clearing is rate-limited too.
      edits[key] = { at };
    } else {
      edits[key] = { ...checked.edit, at };
    }
    const sorted = Object.fromEntries(Object.entries(edits).sort(([a], [b]) => a.localeCompare(b)));
    const content = `${JSON.stringify({ _comment: EDITS_COMMENT, edits: sorted }, null, 2)}\n`;
    const put = await gh(env, EDITS_PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: clear ? "card: a supporter cleared their card edit" : "card: a supporter edited their card",
        content: toB64Utf8(content),
        ...(file.sha ? { sha: file.sha } : {}),
      }),
    });
    if (put.ok) return json({ ok: true, key, edit: edits[key] });
    if (put.status !== 409 && put.status !== 422) return json({ error: "upstream" }, 502);
  }
  return json({ error: "upstream" }, 502);
}
