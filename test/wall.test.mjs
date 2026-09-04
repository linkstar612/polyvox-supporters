// R-DON.6: the wall publishes by approval, not by absence of objection.
//
// The distinction this file exists to pin: an opted-in tester nobody has
// approved must NOT reach manifest.testers. The earlier design published
// everyone and relied on the owner striking names afterwards, which is approval
// by exclusion and gets the default exactly backwards on a page the owner
// publishes under their own name.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { approvalKey, partitionTesters } from "../wall.mjs";

const ZOE = { id: "a1b2c3d4e5f60718", name: "Zoe", badge: "prealpha", since: "2026-07-04" };
const ADA = { id: "0f1e2d3c4b5a6978", name: "Ada", badge: "alpha", since: "2026-08-31" };
const BO = { id: "1122334455667788", name: "Bo", badge: "prealpha", since: "2026-07-04" };

test("an opted-in tester nobody approved stays out of the manifest", () => {
  const { published, pending } = partitionTesters({ testers: [ZOE, ADA] });
  assert.deepEqual(published, []);
  assert.deepEqual(pending, [
    { name: "Zoe", badge: "prealpha", since: "2026-07-04", key: ZOE.id },
    { name: "Ada", badge: "alpha", since: "2026-08-31", key: ADA.id },
  ]);
});

test("an approved tester publishes, and carries no key into the manifest", () => {
  const { published, pending } = partitionTesters({
    testers: [ZOE, ADA],
    approved: [ZOE.id],
  });
  assert.deepEqual(published, [{ name: "Zoe", badge: "prealpha", since: "2026-07-04" }]);
  assert.deepEqual(
    pending.map((p) => p.name),
    ["Ada"],
  );
  // The approval key is the owner's bookkeeping. It never reaches the app.
  assert.equal(JSON.stringify(published).includes(ZOE.id), false);
});

test("a strike beats an approval", () => {
  const { published, pending } = partitionTesters({
    testers: [ZOE, ADA],
    approved: [ZOE.id, ADA.id],
    excluded: [ZOE.id],
  });
  assert.deepEqual(
    published.map((p) => p.name),
    ["Ada"],
  );
  // Struck, not returned to the queue: leaving it pending would offer the same
  // decision again on every single run.
  assert.deepEqual(pending, []);
});

test("a strike also matches the display name, case-folded", () => {
  const { published, pending } = partitionTesters({
    testers: [ZOE],
    approved: [ZOE.id],
    excluded: ["  zoe "],
  });
  assert.deepEqual(published, []);
  assert.deepEqual(pending, []);
});

test("an entry with no key can never be approved", () => {
  // The safe direction: a Worker that stopped returning `id` leaves everyone
  // pending rather than publishing everyone.
  const { published, pending } = partitionTesters({
    testers: [{ name: "Nameless key", badge: "alpha", since: "2026-08-31" }],
    approved: [""],
  });
  assert.deepEqual(published, []);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].key, "");
  assert.equal(approvalKey({}), "");
});

test("both lists sort by since then name, and an entry with no name is dropped", () => {
  const { published, pending } = partitionTesters({
    testers: [ADA, ZOE, BO, { id: "deadbeefdeadbeef", name: "  ", badge: "alpha", since: "2026-01-01" }],
    approved: [ADA.id, ZOE.id, BO.id],
  });
  assert.deepEqual(
    published.map((p) => p.name),
    ["Bo", "Zoe", "Ada"],
  );
  assert.deepEqual(pending, []);
});
