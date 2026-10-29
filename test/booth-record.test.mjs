// booth-record.mjs, the BOOTH rail: the shop's order mail to an anonymous ledger entry.
//
// What this pins: a paid order lands once as `booth:<order>` on Japan time with no
// name, a free order and every other mail record nothing, a mail without BOOTH's
// DKIM pass or in an unexpected shape fails loudly instead of guessing, and a
// resumed mbox scan never records an order twice. Order numbers here are made up.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodeQuotedPrintable, parseOrderMail } from "../booth-record.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "booth-record.mjs");
const DKIM_PASS = "mx.google.com;\r\n       dkim=pass header.i=@booth.pm header.s=s1 header.b=abc;";

/** UTF-8 bytes above ASCII and "=" as =XX, the way BOOTH's mail encodes its body. */
const qp = (text) =>
  [...Buffer.from(text, "utf8")]
    .map((b) => (b >= 0x80 || b === 0x3d ? `=${b.toString(16).toUpperCase().padStart(2, "0")}` : String.fromCharCode(b)))
    .join("");

function orderMail({
  order = "11112222",
  total = "500",
  date = "Tue, 27 Oct 2026 21:55:22 +0000 (UTC)",
  from = "=?UTF-8?b?Qk9PVEjkuovli5nlsYA=?= <noreply@booth.pm>",
  auth = DKIM_PASS,
  link = order,
  subject = `Someone placed an order on your shop (Order Number: ${order}) [BOOTH]`,
  gift = false,
} = {}) {
  const summary = `${gift ? "(gift)" : ""}Polyvox VRC: VRChat向けリアルタイム音声翻訳 (無料 / Free) (サポート 500 / Support)`;
  const half = Math.floor(summary.length / 2);
  return [
    "From - Wed Oct 28 10:53:26 2026",
    "X-Mozilla-Status: 0001",
    ...(auth === null ? [] : [`Authentication-Results: ${auth}`]),
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Type: text/plain; charset=utf-8",
    `Date: ${date}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    "",
    "Greetings from BOOTH.",
    "",
    "=E2=96=A0 Order details",
    `https://manage.booth.pm/orders/${link}`,
    "",
    "=E2=96=A0 Order summary",
    `${qp(summary.slice(0, half))}=`,
    qp(summary.slice(half)),
    `${total} JPY`,
    "",
    "",
    ...(total === null ? [] : [`Total: ${total} JPY`]),
    "",
  ].join("\r\n");
}

test("a paid order becomes an anonymous booth:<order> entry on Japan time", () => {
  const parsed = parseOrderMail(orderMail({ order: "11112222", total: "1,000", date: "Mon, 14 Sep 2026 13:06:44 +0000", gift: true }));
  assert.deepEqual(parsed.entry, {
    id: "booth:11112222",
    platform: "booth",
    month: "2026-09",
    at: "2026-09-14T22:06:44+09:00",
    amount: 1000,
    currency: "JPY",
    goal: "living",
    name: "",
    link: "",
    recurring: false,
  });
});

test("the month follows Japan time, the clock the order page shows", () => {
  const { entry } = parseOrderMail(orderMail({ date: "Sat, 31 Oct 2026 20:30:00 +0000" }));
  assert.equal(entry.at, "2026-11-01T05:30:00+09:00");
  assert.equal(entry.month, "2026-11");
});

test("a 0 JPY order records nothing", () => {
  const parsed = parseOrderMail(orderMail({ total: "0" }));
  assert.equal(parsed.entry, null);
  assert.equal(parsed.amount, 0);
});

test("mail that is not a BOOTH order notice is ignored", () => {
  assert.equal(parseOrderMail(orderMail({ from: "Someone <someone@example.com>" })), null);
  assert.equal(parseOrderMail(orderMail({ subject: "You received a message [BOOTH]" })), null);
});

test("a mail that only claims to be BOOTH is refused", () => {
  assert.throws(() => parseOrderMail(orderMail({ auth: null })), /DKIM/);
  assert.throws(() => parseOrderMail(orderMail({ auth: "mx.google.com; dkim=fail header.i=@booth.pm" })), /DKIM/);
  assert.throws(() => parseOrderMail(orderMail({ auth: "mx.google.com; dkim=pass header.i=@example.com" })), /DKIM/);
});

test("an order notice in an unexpected shape fails loudly", () => {
  assert.throws(() => parseOrderMail(orderMail({ link: "99999999" })), /does not link/);
  assert.throws(() => parseOrderMail(orderMail({ total: null })), /Total/);
});

test("quoted-printable decoding keeps the Japanese line across a soft break", () => {
  assert.equal(decodeQuotedPrintable(`${qp("サポート 5")}=\r\n${qp("00 / Support")}`), "サポート 500 / Support");
});

test("an mbox scan records each paid order once and resumes without a duplicate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "booth-record-"));
  try {
    const known = { id: "booth:11111111", platform: "booth", month: "2026-09", amount: 1000, currency: "JPY", goal: "living", name: "", link: "", recurring: false };
    writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({ entries: [known] }));
    const other = ["From - Wed Oct 28 10:00:00 2026", "From: A Friend <friend@example.com>", "Subject: hi", "", "noreply@booth.pm is in this body", ""].join("\r\n");
    const mbox = path.join(dir, "INBOX");
    writeFileSync(
      mbox,
      [
        orderMail({ order: "11111111", total: "1,000", date: "Mon, 14 Sep 2026 13:06:44 +0000" }),
        other,
        orderMail({ order: "22222222", total: "500" }),
        orderMail({ order: "33333333", total: "0" }),
      ].join("\r\n"),
    );
    const state = path.join(dir, "state.json");
    const run = () =>
      spawnSync(process.execPath, [SCRIPT, "--mbox", mbox, "--state", state, "--next-state", state], { cwd: dir, encoding: "utf8" });
    const ids = () => JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8")).entries.map((e) => e.id);

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /full scan, 4 candidate message\(s\)/);
    assert.match(first.stdout, /booth:11111111 1000 JPY .* already in the ledger/);
    assert.match(first.stdout, /booth:33333333 is 0 JPY, nothing to record/);
    assert.deepEqual(ids(), ["booth:11111111", "booth:22222222"]);
    const added = JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8")).entries[1];
    assert.equal(added.at, "2026-10-28T06:55:22+09:00");
    assert.equal(added.name, "");

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /resumed at byte \d+/);
    assert.deepEqual(ids(), ["booth:11111111", "booth:22222222"]);

    // Compaction rewrites the file: the saved bytes no longer match, so it reads from the top.
    writeFileSync(mbox, `${other}\r\n${readFileSync(mbox, "utf8")}`);
    const third = run();
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /full scan/);
    assert.deepEqual(ids(), ["booth:11111111", "booth:22222222"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
