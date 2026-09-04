// R-DON.6: which opted-in testers are actually published.
//
// Owner's words for this list were "generated ... and staged for owner
// approval". Opting in through the app is a request to be listed, not the
// listing itself: the mint proves someone held an original license, and the
// owner decides whose name appears on a page they publish. So the gate is
// approval by INCLUSION. An entry nobody has approved is never in
// `manifest.testers`, however long it waits.
//
// Its own module, importable with no side effects, because `aggregate.mjs` runs
// its work at the top level and this is the part worth unit-testing.

/// The stable approval key.
///
/// `GET /wall` returns `id`, a one-way digest of the machine code computed by
/// the Worker (`worker/license-mint/src/wall.js`). It is what `wall_approved`
/// holds, and it is deliberately not the display name: a rename is a re-opt-in,
/// and an approval keyed on the old spelling would silently un-approve someone
/// for editing their own name. It is deliberately not the machine code either,
/// which is the seat key and the revoke key and does not belong in a file
/// anyone can clone.
///
/// A row with no `id` cannot be approved at all. That is the safe direction:
/// the failure is a name that stays pending, not a name published by accident.
export function approvalKey(entry) {
  return String(entry?.id ?? "").trim();
}

const fold = (s) => String(s ?? "").trim().toLowerCase();

/// Split the roster into what publishes and what is waiting.
///
/// `approved` is `overrides.json` -> `wall_approved`, a list of keys.
/// `excluded` is `wall_exclude`, the strike list, which wins over an approval
/// and matches either the key or the display name: a name already published is
/// pulled by whichever of the two the owner has to hand.
export function partitionTesters({ testers = [], approved = [], excluded = [] } = {}) {
  const ok = new Set(approved.map((k) => fold(k)));
  const struck = new Set(excluded.map((k) => fold(k)));

  const published = [];
  const pending = [];
  for (const t of testers) {
    // Trimmed first: a name of spaces is not a name, and publishing it would
    // put a blank card on the wall.
    const name = String(t?.name ?? "").trim().slice(0, 48);
    if (!name) continue;
    const key = approvalKey(t);
    const row = {
      name,
      badge: String(t?.badge ?? ""),
      since: String(t?.since ?? ""),
      key,
    };
    if (struck.has(fold(key)) || struck.has(fold(row.name))) continue;
    if (key && ok.has(fold(key))) {
      published.push({ name: row.name, badge: row.badge, since: row.since });
    } else {
      pending.push(row);
    }
  }

  const order = (a, b) => a.since.localeCompare(b.since) || a.name.localeCompare(b.name);
  published.sort(order);
  pending.sort(order);
  return { published, pending };
}
