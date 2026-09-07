// The supporter card: who is on the wall, and what they are wearing.
//
// Split out of aggregate.mjs so it can be unit-tested. aggregate.mjs runs its
// work at the top level (it polls Stripe and Afdian and writes files), so
// anything importable has to live beside it, the way wall.mjs already does.
//
// Three derived fields, all additive to `schema: 1`:
//
//   rails    every place one person's money arrived from, sorted and deduped.
//            `platform` stays the first of them so an older app still reads a
//            card it understands.
//   level    1 to 4, from how many distinct months they have supported in. The
//            app picks the card color from it. It is a duration, not a rank:
//            no amount reaches this file (design 1.3).
//   badges   trophy ids from manifest.achievements. The first donation earns
//            one by itself, which is the point: a wall you can join.
//
// The catalog itself ships in the manifest rather than in the app, so a new
// trophy needs no app release.

import { createHash } from "node:crypto";

/// Every trophy the wall can show. `color` is the trophy's own, not the card's.
export const ACHIEVEMENTS = [
  {
    id: "founder",
    label: "Founder",
    description: "Here before there was anything to support.",
    color: "#f2c14e",
  },
  {
    id: "prealpha",
    label: "Pre-alpha tester",
    description: "Ran Polyvox before the first alpha build.",
    color: "#a78bfa",
  },
  {
    id: "alpha",
    label: "Alpha tester",
    description: "Ran Polyvox during the alpha.",
    color: "#38bdf8",
  },
  {
    id: "first_light",
    label: "First light",
    description: "Sent a first donation.",
    color: "#fb923c",
  },
  {
    id: "two_rails",
    label: "Two rails",
    description: "Gave from two different places.",
    color: "#34d399",
  },
  {
    id: "three_months",
    label: "Three months",
    description: "Gave in three different months.",
    color: "#f472b6",
  },
];

/// Catalog order, so a card's trophy row is stable between runs.
const BADGE_RANK = new Map(ACHIEVEMENTS.map((a, i) => [a.id, i]));

/// The card styles a supporter may pick through the wall opt-in. The mint
/// Worker and this file validate against the same list, so an unknown id
/// falls back to the plain card rather than reaching the app.
export const CARD_STYLES = ["plain", "friend_gold", "visitor_cyan", "pulse", "aurora"];

export const fold = (s) => String(s ?? "").trim().toLowerCase();

/// Months supported, mapped to the four card colors.
///
/// One month is a real level, not a zero: somebody who gave once is on the
/// wall and should look like it. The steps widen as they go because the gap
/// between a first month and a second is the one worth showing.
export function levelFor(monthCount) {
  const n = Number(monthCount) || 0;
  if (n >= 7) return 4;
  if (n >= 4) return 3;
  if (n >= 2) return 2;
  return 1;
}

/// Which trophies a card wears.
///
/// `prealpha` is the only one that is not derived: it is the hand-kept list in
/// overrides.json, or an era the license mint already proved. Everything else
/// falls out of the ledger, which is what makes a first donation unlock one on
/// its own.
export function badgesFor({
  name = "",
  rails = [],
  monthCount = 0,
  entries = 0,
  founder = false,
  prealpha = new Set(),
  eras = new Map(),
} = {}) {
  const key = fold(name);
  const out = new Set();
  if (founder) out.add("founder");
  if (prealpha.has(key) || eras.get(key) === "prealpha") out.add("prealpha");
  if (eras.get(key) === "alpha") out.add("alpha");
  if (entries > 0) out.add("first_light");
  if (rails.length >= 2) out.add("two_rails");
  if (monthCount >= 3) out.add("three_months");
  return [...out].sort((a, b) => (BADGE_RANK.get(a) ?? 99) - (BADGE_RANK.get(b) ?? 99));
}

/// Fold every record for one person into the card the wall renders. Identity
/// is the display name, case-folded: a one-off Ko-fi donation carries no
/// stable donor id, and merging two people who chose the same public name is
/// the acceptable end of that trade. The same fold is what joins one person's
/// Ko-fi and WeChat rails onto a single card.
export function buildWall(records, founders, options = {}) {
  const {
    patronUsd = 25,
    prealpha = new Set(),
    eras = new Map(),
    cardStyles = {},
  } = options;
  const styles = new Map(
    Object.entries(cardStyles).map(([n, s]) => [fold(n), String(s ?? "")]),
  );
  const styleFor = (name) => {
    const s = styles.get(fold(name));
    return s && CARD_STYLES.includes(s) ? s : "";
  };

  const byPerson = new Map();
  for (const r of records) {
    if (!r.name) continue; // anonymous: counted in the goal, never named
    const key = fold(r.name);
    const person = byPerson.get(key) ?? {
      name: r.name,
      platform: r.platform,
      rails: new Set(),
      months: new Set(),
      usd: 0,
      entries: 0,
      recurring: false,
      link: "",
      style: "",
    };
    if (r.platform) person.rails.add(String(r.platform));
    person.months.add(r.month);
    person.usd += r.usd;
    person.entries += 1;
    person.recurring ||= Boolean(r.recurring);
    person.link ||= r.link ?? "";
    // A style the supporter picked through the wall opt-in travels on the
    // record. First one wins; the hand-kept map below is the fallback.
    person.style ||= CARD_STYLES.includes(String(r.style ?? "")) ? String(r.style) : "";
    byPerson.set(key, person);
  }

  const derived = [...byPerson.values()].map((p) => {
    const tier = p.recurring || p.usd >= patronUsd ? "patron" : "supporter";
    const months = [...p.months].sort();
    const rails = [...p.rails].sort();
    const style = p.style || styleFor(p.name);
    return {
      name: p.name,
      tier,
      since: months[0],
      link: p.link,
      permanent: false,
      // The first rail, kept for readers that predate `rails`.
      platform: p.platform,
      rails,
      level: levelFor(months.length),
      badges: badgesFor({
        name: p.name,
        rails,
        monthCount: months.length,
        entries: p.entries,
        prealpha,
        eras,
      }),
      ...(style ? { style } : {}),
      // Every month is stamped with the tier the card wears today rather than
      // whatever was held back then: the strip exists to show duration, and
      // one that changed color part-way would read as a rank history.
      months: Object.fromEntries(months.map((m) => [m, tier])),
    };
  });

  // Founders are hand-kept and never derived. A payment cannot grant the tier,
  // and lapsing cannot remove it (design section 2, `permanent`).
  const permanent = (founders ?? []).map((f) => {
    const style = styleFor(f.name);
    return {
      ...f,
      rails: Array.isArray(f.rails) ? f.rails : [],
      level: levelFor(f.level ?? 4),
      badges: badgesFor({ name: f.name, founder: true, prealpha, eras }),
      ...(style ? { style } : {}),
    };
  });

  return [...permanent, ...derived];
}

// --- R-OCS.10: tying a donation back to the app that made it -----------------
//
// The app derives a short code from the license on disk and shows it. On
// Stripe it rides the link as `client_reference_id`; on every other rail the
// donor types it into the payment note. Here it becomes a SHA-256 key, and the
// app recognizes its own row by hashing its own code.
//
// Only the hash is published, so this file still names nobody: a reader who
// does not already hold the code learns nothing from the key, and a machine
// that never donated finds no row.

/// `PV-` plus six RFC 4648 base32 characters. Matched anywhere in the text
/// because a payment note is a sentence, not a field.
const CODE_RE = /PV-[A-Z2-7]{6}/;

export const hashCode = (code) => createHash("sha256").update(code).digest("hex");

/// The code a record carries, or "". Upper-cased first: base32 has no
/// lowercase, and somebody typing it into a phone keyboard will send one.
export function codeFrom(record) {
  const haystack = [record?.client_reference_id, record?.note, record?.message]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  return haystack.match(CODE_RE)?.[0] ?? "";
}

/// Which trophies each donation code has unlocked.
///
/// A donation always earns `first_light` by itself, which is the point. Beyond
/// that the code inherits whatever its own card wears, so somebody who gave on
/// two rails sees `two_rails` in the app without having to find their card.
export function buildUnlocks(records, wall = []) {
  const byName = new Map((wall ?? []).map((s) => [fold(s?.name), s]));
  const out = {};
  for (const r of records ?? []) {
    const code = codeFrom(r);
    if (!code) continue;
    const key = hashCode(code);
    const ids = new Set(out[key] ?? ["first_light"]);
    for (const b of byName.get(fold(r.name))?.badges ?? []) ids.add(b);
    out[key] = [...ids].sort((a, b) => (BADGE_RANK.get(a) ?? 99) - (BADGE_RANK.get(b) ?? 99));
  }
  return out;
}

/// A hand-listed pre-alpha tester who never donated still belongs on the wall.
///
/// The mint roster (R-DON.6) is the approved list and wins on every field it
/// carries; this only fills the gap for somebody the mint cannot see, and it
/// skips anybody who already has a supporter card, where the trophy shows
/// instead.
export function mergeTesters({ testers = [], prealpha = [], onWall = [] } = {}) {
  const out = [...testers];
  const seen = new Set(out.map((t) => fold(t?.name)));
  const walled = new Set(onWall.map((n) => fold(n)));
  for (const raw of prealpha) {
    const name = String(raw ?? "").trim().slice(0, 48);
    const key = fold(name);
    if (!name || seen.has(key) || walled.has(key)) continue;
    seen.add(key);
    // No mint row means no opt-in date to publish. Empty sorts first, which
    // reads as "was here before the record started", and it is.
    out.push({ name, badge: "prealpha", since: "" });
  }
  out.sort(
    (a, b) =>
      String(a.since).localeCompare(String(b.since)) ||
      String(a.name).localeCompare(String(b.name)),
  );
  return out;
}
