// R-OJJ.11: worker/card-route.js, POST /card, against a fake GitHub.
//
// What this pins: a license nobody signed, the shared transferable license and
// a real license whose code names no card are all refused with 403 before the
// edit file is touched; fields over their limits or off the preset lists are
// 400; one code gets one edit per interval; and an accepted edit lands in
// card-edits.json keyed by the code's hash with nothing of the license in it.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { CARD_EDIT_INTERVAL_S, CARD_LIMITS, checkEdit, isVrchatImage } from "../card-edit.mjs";
import {
  canonicalBodyOfSigned,
  codeHash,
  donationCode,
  handleCard,
  licenseSigned,
} from "../worker/card-route.js";
import doorman from "../worker/kofi-doorman.js";

const ENV = { GH_TOKEN: "gh", GH_REPO: "owner/repo" };
const NOW = Date.parse("2026-10-13T12:00:00Z");

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const KEYS = [new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))];

/** A license file as the app stores it, signed by the test key. */
async function licenseText(over = {}) {
  const signed = {
    licensee: "auto-2026-09-01",
    issued_at: "2026-09-01",
    hwid_hash: "0123456789abcdef0123",
    expires_at: null,
    role: "",
    ...over,
  };
  const msg = new TextEncoder().encode(JSON.stringify(canonicalBodyOfSigned(signed)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, msg));
  return JSON.stringify({ ...signed, signature: btoa(String.fromCharCode(...sig)) });
}

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

/** A fake contents API holding manifest.json and, optionally, card-edits.json. */
function fakeGitHub({ cardCodes = [], edits } = {}) {
  const files = new Map([["manifest.json", JSON.stringify({ card_codes: cardCodes })]]);
  if (edits) files.set("card-edits.json", JSON.stringify({ edits }));
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace("/repos/owner/repo/contents/", "");
    calls.push({ path, method: init.method ?? "GET" });
    if ((init.method ?? "GET") === "PUT") {
      const body = JSON.parse(init.body);
      files.set(path, Buffer.from(body.content, "base64").toString("utf8"));
      return new Response("{}", { status: 200 });
    }
    if (!files.has(path)) return new Response("{}", { status: 404 });
    return Response.json({ content: b64(files.get(path)), sha: `sha-${path}` });
  };
  return { fetch, files, calls };
}

async function post(body, { github, now = NOW } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = github.fetch;
  try {
    const res = await handleCard(
      new Request("https://doorman.example/card", { method: "POST", body: JSON.stringify(body) }),
      ENV,
      { now, keys: KEYS },
    );
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = real;
  }
}

test("the donation code matches the app's derivation, bit for bit", async () => {
  // Independent of the route's shift arithmetic: read the 30 bits through
  // BigInt off the hex digest, as license.rs does through a u32.
  for (const text of ["", "{}", '{"licensee":"x"}', "ÿþ license"]) {
    const d = createHash("sha256").update(text, "utf8").digest("hex");
    const bits = BigInt(`0x${d.slice(0, 8)}`) >> 2n;
    let want = "";
    for (let i = 5; i >= 0; i -= 1) want += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Number((bits >> BigInt(5 * i)) & 31n)];
    assert.equal(await donationCode(text), `PV-${want}`);
  }
  assert.equal(
    await codeHash("PV-C3WDTO"),
    createHash("sha256").update("PV-C3WDTO").digest("hex"),
  );
});

test("a signed license verifies and a tampered one does not", async () => {
  const text = await licenseText();
  assert.equal(await licenseSigned(JSON.parse(text), KEYS), true);
  assert.equal(await licenseSigned({ ...JSON.parse(text), licensee: "me" }, KEYS), false);
});

test("a code that names no card is refused with 403 and writes nothing", async () => {
  const github = fakeGitHub({ cardCodes: ["0".repeat(64)] });
  const r = await post({ license: await licenseText(), name: "Mei" }, { github });
  assert.deepEqual(r, { status: 403, body: { error: "no_card" } });
  assert.equal(github.calls.some((c) => c.method === "PUT"), false);
});

test("an unsigned, forged or transferable license is 403 before any GitHub call", async () => {
  const github = fakeGitHub();
  const forged = JSON.stringify({ ...JSON.parse(await licenseText()), licensee: "someone else" });
  for (const license of [undefined, "", "not json", forged, "{}"]) {
    const r = await post({ license, name: "Mei" }, { github });
    assert.deepEqual(r, { status: 403, body: { error: "bad_license" } }, String(license));
  }
  const shared = await post({ license: await licenseText({ hwid_hash: "transferable" }) }, { github });
  assert.deepEqual(shared, { status: 403, body: { error: "license_not_machine_bound" } });
  assert.equal(github.calls.length, 0);
});

test("fields over their limits or off the preset lists are 400", async () => {
  const github = fakeGitHub();
  const license = await licenseText();
  const bad = [
    [{ name: "x".repeat(CARD_LIMITS.name + 1) }, "name"],
    [{ name: "line\nbreak" }, "name"],
    [{ name: "‮evil" }, "name"],
    [{ name: 7 }, "name"],
    [{ tagline: "t".repeat(CARD_LIMITS.tagline + 1) }, "tagline"],
    [{ accent: "#ff0000" }, "accent"],
    [{ background: "upload.png" }, "background"],
    [{ avatar_url: "https://evil.example/a.png" }, "avatar_url"],
    [{ avatar_url: "http://api.vrchat.cloud/api/1/file/f/1/file" }, "avatar_url"],
    [{ avatar_url: "https://api.vrchat.cloud.evil.example/x" }, "avatar_url"],
  ];
  for (const [fields, field] of bad) {
    const r = await post({ license, ...fields }, { github });
    assert.deepEqual(r, { status: 400, body: { error: "invalid_field", field } }, JSON.stringify(fields));
  }
  // Limits count code points, so a CJK name uses its own length.
  assert.ok(checkEdit({ name: "灯".repeat(CARD_LIMITS.name) }).edit);
  assert.equal(isVrchatImage("https://api.vrchat.cloud/api/1/image/file_x/1/256"), true);
  assert.equal(isVrchatImage("https://files.vrchat.cloud/thumbnails/x.png"), true);
  assert.equal((await post("[]", { github })).status, 400);
});

test("an accepted edit lands keyed by the code hash, with nothing of the license", async () => {
  const license = await licenseText();
  const key = await codeHash(await donationCode(license));
  const github = fakeGitHub({ cardCodes: [key] });
  const r = await post(
    {
      license,
      name: "  Mei  ",
      tagline: "hi",
      accent: "sky",
      background: "ocean",
      avatar_url: "https://api.vrchat.cloud/api/1/file/file_abc/1/file",
    },
    { github },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.key, key);
  const written = github.files.get("card-edits.json");
  assert.deepEqual(JSON.parse(written).edits, {
    [key]: {
      name: "Mei",
      tagline: "hi",
      accent: "sky",
      background: "ocean",
      avatar_url: "https://api.vrchat.cloud/api/1/file/file_abc/1/file",
      at: new Date(NOW).toISOString(),
    },
  });
  assert.equal(written.includes("signature"), false);
  assert.equal(written.includes("0123456789abcdef0123"), false);
});

test("one code gets one edit per interval; clearing is an edit too", async () => {
  const license = await licenseText();
  const key = await codeHash(await donationCode(license));
  const at = new Date(NOW - 60_000).toISOString();
  const github = fakeGitHub({ cardCodes: [key], edits: { [key]: { name: "Mei", at } } });
  const early = await post({ license, clear: true }, { github });
  assert.equal(early.status, 429);
  assert.equal(early.body.error, "rate_limited");
  assert.equal(early.body.retry_after, CARD_EDIT_INTERVAL_S - 60);

  const later = await post({ license, clear: true }, { github, now: NOW + CARD_EDIT_INTERVAL_S * 1000 });
  assert.equal(later.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(github.files.get("card-edits.json")).edits[key]), ["at"]);
});

test("the doorman routes /card before the Ko-fi form branch", async () => {
  const github = fakeGitHub();
  const real = globalThis.fetch;
  globalThis.fetch = github.fetch;
  try {
    const res = await doorman.fetch(
      new Request("https://doorman.example/card", { method: "POST", body: "{}" }),
      ENV,
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "bad_license" });
  } finally {
    globalThis.fetch = real;
  }
});
