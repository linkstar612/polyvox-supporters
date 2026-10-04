// ledger-append.mjs, the last gate before a donation lands in the public ledger.
//
// What this pins: a payment time inside its own month is kept, and a bad one is
// dropped while the donation is still recorded. Refusing the entry would lose
// the donation outright, because the doorman has already answered Ko-fi.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ledger-append.mjs");

function append(entry) {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-append-"));
  try {
    writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({ entries: [] }));
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      env: { ...process.env, LEDGER_ENTRY: JSON.stringify(entry) },
      encoding: "utf8",
    });
    const { entries } = JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8"));
    return { status: run.status, entries, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const kofi = (over) => ({
  id: "kofi:t1",
  platform: "kofi",
  month: "2026-10",
  amount: 5,
  currency: "USD",
  name: "Wen",
  ...over,
});

test("a payment time inside its month is kept", () => {
  for (const at of ["2026-10-01T00:04:30.000Z", "2026-10-01T07:00:00+08:00", "2026-10-02"]) {
    const { status, entries } = append(kofi({ at }));
    assert.equal(status, 0);
    assert.equal(entries[0].at, at);
  }
});

test("a bad payment time is dropped and the donation is still recorded", () => {
  for (const at of ["2026-09-30T23:59:00Z", "yesterday", "2026-10-01T07:00:00"]) {
    const { status, entries, stderr } = append(kofi({ at }));
    assert.equal(status, 0, `refused over at=${at}`);
    assert.equal(entries.length, 1);
    assert.equal("at" in entries[0], false, `kept at=${at}`);
    assert.match(stderr, /Ignoring at/);
  }
});

test("no payment time at all is an ordinary entry", () => {
  const { status, entries } = append(kofi({}));
  assert.equal(status, 0);
  assert.equal("at" in entries[0], false);
});
