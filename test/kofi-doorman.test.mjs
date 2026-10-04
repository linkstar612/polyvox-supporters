// worker/kofi-doorman.js, against a fake GitHub.
//
// What this pins: the dispatch carries the payment time in UTC, with `month`
// cut from the same string, so the ledger can never hold an `at` outside its
// month. A missing timestamp falls back to the arrival time for both.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import doorman from "../worker/kofi-doorman.js";

const ENV = { KOFI_TOKEN: "tok", GH_TOKEN: "gh", GH_REPO: "owner/repo" };

async function deliver(event) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, payload: JSON.parse(init.body).client_payload });
    return new Response(null, { status: 204 });
  };
  try {
    const form = new FormData();
    form.set(
      "data",
      JSON.stringify({
        verification_token: "tok",
        type: "Donation",
        kofi_transaction_id: "t1",
        amount: "5.00",
        currency: "USD",
        is_public: true,
        from_name: "Wen",
        ...event,
      }),
    );
    const res = await doorman.fetch(
      new Request("https://doorman.example/", { method: "POST", body: form }),
      ENV,
    );
    return { status: res.status, sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the dispatch carries the payment time, and the month is cut from it", async () => {
  const { status, sent } = await deliver({ timestamp: "2026-10-01T00:04:30Z" });
  assert.equal(status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.at, "2026-10-01T00:04:30.000Z");
  assert.equal(sent[0].payload.month, "2026-10");
  assert.equal(sent[0].payload.id, "kofi:t1");
});

test("no timestamp falls back to the arrival time for both fields", async () => {
  const before = Date.now();
  const { sent } = await deliver({ timestamp: undefined });
  const at = Date.parse(sent[0].payload.at);
  assert.ok(at >= before && at <= Date.now());
  assert.equal(sent[0].payload.month, sent[0].payload.at.slice(0, 7));
});

test("the donor's email never leaves the Worker", async () => {
  const { sent } = await deliver({ timestamp: "2026-10-01T00:04:30Z", email: "a@b.example" });
  assert.equal(JSON.stringify(sent[0].payload).includes("a@b.example"), false);
});
