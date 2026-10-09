// R-OCS.10: one person, one card, however many rails their money arrived on.
//
// The three things this pins, because each of them is silent when wrong:
// a second rail must merge onto the existing card instead of adding a second
// one; `level` must come from how many months somebody supported in and never
// from an amount; and a first donation must unlock a trophy by itself, which is
// the whole reason the wall is worth joining.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ACHIEVEMENTS,
  BANDS,
  CARD_STYLES,
  applyAliases,
  badgesFor,
  bandFor,
  buildUnlocks,
  buildWall,
  codeFrom,
  dayOf,
  firstOfMonth,
  hashCode,
  levelFor,
  markFirstOfMonth,
  mergeTesters,
} from "../cards.mjs";

const rec = (over) => ({
  name: "",
  platform: "kofi",
  month: "2026-08",
  usd: 5,
  recurring: false,
  link: "",
  ...over,
});

test("two rails fold into one card, and platform still names the first", () => {
  const wall = buildWall(
    [
      rec({ name: "Wen", platform: "kofi", month: "2026-08" }),
      rec({ name: "wen", platform: "wechat", month: "2026-09", usd: 0.15 }),
    ],
  );
  assert.equal(wall.length, 1);
  assert.equal(wall[0].name, "Wen");
  assert.deepEqual(wall[0].rails, ["kofi", "wechat"]);
  assert.equal(wall[0].platform, "kofi");
  assert.deepEqual(Object.keys(wall[0].months), ["2026-08", "2026-09"]);
});

test("rails are sorted and deduped", () => {
  const wall = buildWall(
    [
      rec({ name: "Wen", platform: "wechat" }),
      rec({ name: "Wen", platform: "wechat", month: "2026-09" }),
      rec({ name: "Wen", platform: "kofi", month: "2026-09" }),
    ],
  );
  assert.deepEqual(wall[0].rails, ["kofi", "wechat"]);
});

test("level counts months, not money", () => {
  assert.equal(levelFor(0), 1);
  assert.equal(levelFor(1), 1);
  assert.equal(levelFor(2), 2);
  assert.equal(levelFor(3), 2);
  assert.equal(levelFor(4), 3);
  assert.equal(levelFor(6), 3);
  assert.equal(levelFor(7), 4);
  assert.equal(levelFor(30), 4);

  const one = buildWall([rec({ name: "A", usd: 500 })]);
  assert.equal(one[0].level, 1);
  const four = buildWall(
    ["2026-01", "2026-02", "2026-03", "2026-04"].map((m) =>
      rec({ name: "B", month: m, usd: 1 }),
    ),
  );
  assert.equal(four[0].level, 3);
});

test("a first donation unlocks a trophy on its own", () => {
  const wall = buildWall([rec({ name: "New" })]);
  assert.deepEqual(wall[0].badges, ["first_light"]);
});

test("two rails and three months each earn their own trophy", () => {
  const wall = buildWall(
    [
      rec({ name: "Wen", platform: "kofi", month: "2026-07" }),
      rec({ name: "Wen", platform: "wechat", month: "2026-08" }),
      rec({ name: "Wen", platform: "wechat", month: "2026-09" }),
    ],
  );
  assert.deepEqual(wall[0].badges, ["first_light", "two_rails", "three_months"]);
});

test("the hand-kept pre-alpha list stamps a card, case-folded", () => {
  const wall = buildWall([rec({ name: "Flizee" })], {
    prealpha: new Set(["flizee"]),
  });
  assert.deepEqual(wall[0].badges, ["prealpha", "first_light"]);
});

test("a mint era stamps a card the hand list never mentions", () => {
  const wall = buildWall([rec({ name: "Zoe" })], {
    eras: new Map([["zoe", "prealpha"]]),
  });
  assert.ok(wall[0].badges.includes("prealpha"));
  const alpha = buildWall([rec({ name: "Ada" })], {
    eras: new Map([["ada", "alpha"]]),
  });
  assert.ok(alpha[0].badges.includes("alpha"));
});

test("nothing grants the founder trophy any more", () => {
  assert.equal(ACHIEVEMENTS.some((a) => a.id === "founder"), false);
  const wall = buildWall([rec({ name: "F" })], { prealpha: new Set(["f"]) });
  assert.equal(wall.length, 1);
  assert.equal(wall[0].badges.includes("founder"), false);
  assert.equal(wall[0].permanent, false);
});

test("badges come out in catalog order", () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  const out = badgesFor({
    name: "x",
    rails: ["a", "b"],
    monthCount: 3,
    entries: 1,
    prealpha: new Set(["x"]),
  });
  const ranks = out.map((id) => ids.indexOf(id));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("a hand-kept style lands on the card and an unknown one does not", () => {
  const good = buildWall([rec({ name: "Wen" })], {
    cardStyles: { wen: "aurora" },
  });
  assert.equal(good[0].style, "aurora");
  const bad = buildWall([rec({ name: "Wen" })], {
    cardStyles: { Wen: "drop-tables" },
  });
  assert.equal(bad[0].style, undefined);
  assert.ok(CARD_STYLES.includes("plain"));
});

test("a style the supporter picked beats the hand-kept fallback", () => {
  const wall = buildWall([rec({ name: "Wen", style: "pulse" })], {
    cardStyles: { wen: "aurora" },
  });
  assert.equal(wall[0].style, "pulse");
});

test("a hand-listed tester with no donation is published as a tester", () => {
  const out = mergeTesters({
    testers: [{ name: "Zoe", badge: "prealpha", since: "2026-07-04" }],
    prealpha: ["Zoe", "灯灯", "flizee"],
    onWall: ["Flizee"],
  });
  assert.deepEqual(out, [
    { name: "灯灯", badge: "prealpha", since: "" },
    { name: "Zoe", badge: "prealpha", since: "2026-07-04" },
  ]);
});

test("a donation code is found in a note, a message or a Stripe reference", () => {
  assert.equal(codeFrom({ note: "thanks! PV-A2B3C4 here" }), "PV-A2B3C4");
  assert.equal(codeFrom({ message: "pv-a2b3c4" }), "PV-A2B3C4");
  assert.equal(codeFrom({ client_reference_id: "PV-ZZZZ77" }), "PV-ZZZZ77");
  assert.equal(codeFrom({ note: "no code here" }), "");
  assert.equal(codeFrom({}), "");
  // Base32 has no 0, 1 or 8, so a lookalike is not a code.
  assert.equal(codeFrom({ note: "PV-A0B1C8" }), "");
});

test("a coded donation unlocks its own card's trophies, keyed by hash", () => {
  const wall = buildWall(
    [
      rec({ name: "Wen", platform: "kofi", month: "2026-08", note: "PV-A2B3C4" }),
      rec({ name: "Wen", platform: "wechat", month: "2026-09" }),
    ],
  );
  const unlocks = buildUnlocks(
    [rec({ name: "Wen", platform: "kofi", month: "2026-08", note: "PV-A2B3C4" })],
    wall,
  );
  const key = hashCode("PV-A2B3C4");
  assert.deepEqual(Object.keys(unlocks), [key]);
  assert.deepEqual(unlocks[key], ["first_light", "two_rails"]);
  // The published key is a one-way digest, never the code itself.
  assert.equal(key.length, 64);
  assert.equal(JSON.stringify(unlocks).includes("PV-"), false);
});

test("an anonymous coded donation still unlocks the first trophy", () => {
  const unlocks = buildUnlocks([rec({ note: "PV-A2B3C4" })], []);
  assert.deepEqual(unlocks[hashCode("PV-A2B3C4")], ["first_light"]);
});

test("a donation with no code publishes nothing", () => {
  assert.deepEqual(buildUnlocks([rec({ name: "Wen" })], []), {});
});

test("an alias folds a live-rail name onto the card it belongs to", () => {
  const raw = [
    rec({
      name: "Name on Stripe",
      platform: "stripe",
      month: "2026-09",
      usd: 25,
      client_reference_id: "PV-A2B3C4",
    }),
    rec({ name: "Wen", platform: "wechat", month: "2026-09", usd: 0.15 }),
  ];
  const records = applyAliases(raw, { "name on stripe": "Wen" });
  // The input is untouched and the canonical spelling wins.
  assert.equal(raw[0].name, "Name on Stripe");
  assert.deepEqual(
    records.map((r) => r.name),
    ["Wen", "Wen"],
  );
  const wall = buildWall(records, { prealpha: new Set(["wen"]) });
  assert.equal(wall.length, 1);
  assert.deepEqual(wall[0].rails, ["stripe", "wechat"]);
  // The code rode the aliased record, so the hash wears the merged card's trophies.
  const unlocks = buildUnlocks(records, wall);
  assert.deepEqual(unlocks[hashCode("PV-A2B3C4")], ["prealpha", "first_light", "two_rails"]);
});

test("an empty alias map returns the records unchanged", () => {
  const raw = [rec({ name: "Wen" })];
  assert.deepEqual(applyAliases(raw, {}), raw);
  assert.deepEqual(applyAliases(raw), raw);
});

test("the catalog is complete and every entry is renderable", () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  for (const id of [
    "prealpha",
    "alpha",
    "first_light",
    "two_rails",
    "three_months",
    "first_of_month",
  ]) {
    assert.ok(ids.includes(id), `catalog is missing ${id}`);
  }
  for (const a of ACHIEVEMENTS) {
    assert.match(a.color, /^#[0-9a-f]{6}$/);
    assert.ok(a.label.length > 0 && a.label.length <= 35, `label cap: ${a.label}`);
    assert.ok(a.description.length <= 120, `description cap: ${a.description}`);
    assert.equal(a.description.includes("—"), false, "no em dash in a shipped string");
  }
});

// -- first of the month ---------------------------------------------------------

const badgesOf = (wall, name) => wall.find((c) => c.name === name)?.badges ?? [];

test("everyone who gave on the 1st opens the month", () => {
  const { records } = markFirstOfMonth([
    rec({ name: "Wen", month: "2026-10", at: "2026-10-01T00:04:00Z" }),
    rec({ name: "Mei", month: "2026-10", at: "2026-10-01T22:40:00Z" }),
    rec({ name: "Jun", month: "2026-10", at: "2026-10-02T09:00:00Z" }),
  ]);
  const wall = buildWall(records);
  assert.ok(badgesOf(wall, "Wen").includes("first_of_month"));
  assert.ok(badgesOf(wall, "Mei").includes("first_of_month"));
  assert.equal(badgesOf(wall, "Jun").includes("first_of_month"), false);
});

test("with nobody on the 1st, the earliest payment takes the month", () => {
  const { records, untimed } = markFirstOfMonth([
    rec({ name: "Jun", month: "2026-10", at: "2026-10-03T08:00:00Z" }),
    rec({ name: "Wen", month: "2026-10", at: "2026-10-02T12:00:00Z" }),
    rec({ name: "Mei", month: "2026-10", at: "2026-10-02T12:00:01Z" }),
  ]);
  const wall = buildWall(records);
  assert.deepEqual(
    wall.filter((c) => c.badges.includes("first_of_month")).map((c) => c.name),
    ["Wen"],
  );
  assert.deepEqual(untimed, []);
});

test("a payment with no time blocks the earliest rule but never the 1st", () => {
  const { records, untimed } = markFirstOfMonth([
    // October: an undated Ko-fi entry might have come first, so the 3rd wins nothing.
    rec({ name: "Old", month: "2026-10" }),
    rec({ name: "Jun", month: "2026-10", at: "2026-10-03T08:00:00Z" }),
    // November: the same gap cannot take away a 1st somebody can show.
    rec({ name: "Old", month: "2026-11" }),
    rec({ name: "Wen", month: "2026-11", at: "2026-11-01" }),
  ]);
  const wall = buildWall(records);
  assert.equal(badgesOf(wall, "Jun").includes("first_of_month"), false);
  assert.equal(badgesOf(wall, "Old").includes("first_of_month"), false);
  assert.ok(badgesOf(wall, "Wen").includes("first_of_month"), "a bare date on the 1st counts");
  assert.deepEqual(untimed, ["2026-10"]);
});

test("an anonymous first leaves the month unclaimed, but its code unlocks it", () => {
  const { records } = markFirstOfMonth([
    rec({ month: "2026-10", at: "2026-10-02T03:00:00Z", note: "PV-A2B3C4" }),
    rec({ name: "Wen", month: "2026-10", at: "2026-10-05T03:00:00Z" }),
  ]);
  const wall = buildWall(records);
  // Not passed down to the second donor.
  assert.equal(badgesOf(wall, "Wen").includes("first_of_month"), false);
  assert.deepEqual(buildUnlocks(records, wall)[hashCode("PV-A2B3C4")], [
    "first_light",
    "first_of_month",
  ]);
});

test("a bill in Beijing time counts its own 1st and is ordered by instant", () => {
  // 07:00 on the 1st in Beijing is 23:00 UTC on the 30th, and the bill files it
  // under October: it opened October on the clock it was paid on.
  const early = markFirstOfMonth([
    rec({ name: "Mei", platform: "wechat", month: "2026-10", at: "2026-10-01T07:00:00+08:00" }),
    rec({ name: "Wen", platform: "kofi", month: "2026-10", at: "2026-10-01T00:30:00Z" }),
  ]);
  const both = buildWall(early.records);
  assert.ok(badgesOf(both, "Mei").includes("first_of_month"));
  assert.ok(badgesOf(both, "Wen").includes("first_of_month"));

  // Nobody on the 1st: the bill's 3rd is the 2nd in UTC, and earlier than a
  // Ko-fi payment on the UTC 2nd, so it is first however the days read.
  const later = markFirstOfMonth([
    rec({ name: "Mei", platform: "wechat", month: "2026-10", at: "2026-10-03T07:00:00+08:00" }),
    rec({ name: "Wen", platform: "kofi", month: "2026-10", at: "2026-10-02T23:30:00Z" }),
  ]);
  const wall = buildWall(later.records);
  assert.ok(badgesOf(wall, "Mei").includes("first_of_month"));
  assert.equal(badgesOf(wall, "Wen").includes("first_of_month"), false);
});

test("an at outside its own month is no time at all", () => {
  assert.equal(dayOf({ month: "2026-10", at: "2026-10-01T07:00:00+08:00" }), "2026-10-01");
  assert.equal(dayOf({ month: "2026-10", at: "2026-09-30T23:00:00Z" }), "");
  assert.equal(dayOf({ month: "2026-10" }), "");
  assert.equal(dayOf({ month: "2026-10", at: "soon" }), "");
});

test("wall-only rows never open a month, and the input is not mutated", () => {
  const input = [
    // An Afdian sponsor row: a name and no money.
    rec({ name: "Jun", platform: "afdian", month: "2026-10", usd: 0, at: "2026-10-01T00:00:00Z" }),
    rec({ name: "Wen", month: "2026-10", at: "2026-10-04T00:00:00Z" }),
  ];
  const { won } = firstOfMonth(input);
  assert.deepEqual([...won].map((r) => r.name), ["Wen"]);
  const { records } = markFirstOfMonth(input);
  assert.equal("first_of_month" in input[1], false);
  assert.equal(records[1].first_of_month, true);
});

test("the trophy is earned once, however many months it was opened in", () => {
  const { records } = markFirstOfMonth([
    rec({ name: "Wen", month: "2026-10", at: "2026-10-01T01:00:00Z" }),
    rec({ name: "Wen", month: "2026-11", at: "2026-11-01T01:00:00Z" }),
  ]);
  const [card] = buildWall(records);
  assert.equal(card.badges.filter((b) => b === "first_of_month").length, 1);
  // Catalog order keeps it after the older trophies.
  assert.deepEqual(card.badges, ["first_light", "first_of_month"]);
});

// R-DON.14: the wall is ranked by what each person gave in total, and the
// total itself never leaves cards.mjs.

test("the wall is ordered by total given, and place counts from 1", () => {
  const wall = buildWall([
    rec({ name: "Small", usd: 5 }),
    rec({ name: "Big", usd: 30 }),
    rec({ name: "Mid", platform: "kofi", usd: 5 }),
    rec({ name: "mid", platform: "wechat", month: "2026-09", usd: 7 }),
  ]);
  assert.deepEqual(wall.map((c) => c.name), ["Big", "Mid", "Small"]);
  assert.deepEqual(wall.map((c) => c.place), [1, 2, 3]);
});

test("a tie goes to more months, then the earlier month, then the name", () => {
  const wall = buildWall([
    rec({ name: "Zed", month: "2026-07", usd: 5 }),
    rec({ name: "bob", month: "2026-08", usd: 5 }),
    rec({ name: "Amy", month: "2026-08", usd: 5 }),
    rec({ name: "Two", month: "2026-08", usd: 2.5 }),
    rec({ name: "Two", month: "2026-09", usd: 2.5 }),
  ]);
  assert.deepEqual(wall.map((c) => c.name), ["Two", "Zed", "Amy", "bob"]);
});

test("bands step at $10, $25, $50 and $100, read in whole cents", () => {
  assert.deepEqual(
    BANDS.map((b) => b.id),
    ["bronze", "silver", "gold", "platinum", "diamond"],
  );
  assert.equal(bandFor(0.15), "bronze");
  assert.equal(bandFor(9.99), "bronze");
  assert.equal(bandFor(10), "silver");
  assert.equal(bandFor(24.99), "silver");
  assert.equal(bandFor(25), "gold");
  assert.equal(bandFor(50), "platinum");
  assert.equal(bandFor(99.99), "platinum");
  assert.equal(bandFor(100), "diamond");
  assert.equal(bandFor(5000), "diamond");
  // A total a float's width under a step still reaches it.
  assert.equal(bandFor(10 - 1e-9), "silver");
});

test("a card's band follows the person's total across every rail", () => {
  const [card] = buildWall([
    rec({ name: "Wen", platform: "kofi", usd: 5 }),
    rec({ name: "wen", platform: "alipay", month: "2026-09", usd: 80 / 6.7179 }),
  ]);
  assert.equal(card.band, "silver");
  assert.deepEqual(card.rails, ["alipay", "kofi"]);
});

test("no supporter row carries an amount", () => {
  const wall = buildWall([
    rec({ name: "Big", usd: 120 }),
    rec({ name: "Small", usd: 1, recurring: true }),
  ]);
  for (const card of wall) {
    for (const key of Object.keys(card)) {
      assert.equal(/usd|amount|total|sum/i.test(key), false, `row carries ${key}`);
    }
    assert.equal(JSON.stringify(card).includes("120"), false, "the total leaked into a row");
  }
});

test("first_light reads Backer and two_rails reads Multi-platform", () => {
  const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
  assert.equal(byId.get("first_light").label, "Backer");
  assert.equal(byId.get("two_rails").label, "Multi-platform");
});
