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
  CARD_STYLES,
  badgesFor,
  buildWall,
  levelFor,
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
    [],
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
    [],
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

  const one = buildWall([rec({ name: "A", usd: 500 })], []);
  assert.equal(one[0].level, 1);
  const four = buildWall(
    ["2026-01", "2026-02", "2026-03", "2026-04"].map((m) =>
      rec({ name: "B", month: m, usd: 1 }),
    ),
    [],
  );
  assert.equal(four[0].level, 3);
});

test("a first donation unlocks a trophy on its own", () => {
  const wall = buildWall([rec({ name: "New" })], []);
  assert.deepEqual(wall[0].badges, ["first_light"]);
});

test("two rails and three months each earn their own trophy", () => {
  const wall = buildWall(
    [
      rec({ name: "Wen", platform: "kofi", month: "2026-07" }),
      rec({ name: "Wen", platform: "wechat", month: "2026-08" }),
      rec({ name: "Wen", platform: "wechat", month: "2026-09" }),
    ],
    [],
  );
  assert.deepEqual(wall[0].badges, ["first_light", "two_rails", "three_months"]);
});

test("the hand-kept pre-alpha list stamps a card, case-folded", () => {
  const wall = buildWall([rec({ name: "Flizee" })], [], {
    prealpha: new Set(["flizee"]),
  });
  assert.deepEqual(wall[0].badges, ["prealpha", "first_light"]);
});

test("a mint era stamps a card the hand list never mentions", () => {
  const wall = buildWall([rec({ name: "Zoe" })], [], {
    eras: new Map([["zoe", "prealpha"]]),
  });
  assert.ok(wall[0].badges.includes("prealpha"));
  const alpha = buildWall([rec({ name: "Ada" })], [], {
    eras: new Map([["ada", "alpha"]]),
  });
  assert.ok(alpha[0].badges.includes("alpha"));
});

test("a founder wears the founder trophy and no donation trophy", () => {
  const wall = buildWall([], [{ name: "F", tier: "founder", permanent: true }]);
  assert.deepEqual(wall[0].badges, ["founder"]);
  assert.equal(wall[0].permanent, true);
});

test("badges come out in catalog order", () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  const out = badgesFor({
    name: "x",
    rails: ["a", "b"],
    monthCount: 3,
    entries: 1,
    founder: true,
    prealpha: new Set(["x"]),
  });
  const ranks = out.map((id) => ids.indexOf(id));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("a hand-kept style lands on the card and an unknown one does not", () => {
  const good = buildWall([rec({ name: "Wen" })], [], {
    cardStyles: { wen: "aurora" },
  });
  assert.equal(good[0].style, "aurora");
  const bad = buildWall([rec({ name: "Wen" })], [], {
    cardStyles: { Wen: "drop-tables" },
  });
  assert.equal(bad[0].style, undefined);
  assert.ok(CARD_STYLES.includes("plain"));
});

test("a style the supporter picked beats the hand-kept fallback", () => {
  const wall = buildWall([rec({ name: "Wen", style: "pulse" })], [], {
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

test("the catalog is complete and every entry is renderable", () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  for (const id of ["founder", "prealpha", "alpha", "first_light", "two_rails", "three_months"]) {
    assert.ok(ids.includes(id), `catalog is missing ${id}`);
  }
  for (const a of ACHIEVEMENTS) {
    assert.match(a.color, /^#[0-9a-f]{6}$/);
    assert.ok(a.label.length > 0 && a.label.length <= 35, `label cap: ${a.label}`);
    assert.ok(a.description.length <= 120, `description cap: ${a.description}`);
    assert.equal(a.description.includes("—"), false, "no em dash in a shipped string");
  }
});
