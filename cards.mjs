// The supporter card: who is on the wall, and what they are wearing.
//
// Split out of aggregate.mjs so it can be unit-tested. aggregate.mjs runs its
// work at the top level (it polls Stripe and Afdian and writes files), so
// anything importable has to live beside it, the way wall.mjs already does.
//
// Five derived fields, all additive to `schema: 1`:
//
//   rails    every place one person's money arrived from, sorted and deduped.
//            `platform` stays the first of them so an older app still reads a
//            card it understands.
//   level    1 to 4, from how many distinct months they have supported in. A
//            duration; apps from before `band` color the card by it.
//   place    1 for whoever has given the most in total, then down the wall
//            (R-DON.14). The supporters array is published in this order.
//   band     bronze, silver, gold, platinum or diamond, from that same total
//            (`BANDS`, moved by overrides.json -> `bands`). A band once earned
//            is kept in bands-earned.json, so a raised step never lowers a
//            card (R-OJJ.10). The order and the band show a range; the total
//            itself never reaches this file.
//   badges   trophy ids from manifest.achievements. The first donation earns
//            one by itself, which is the point: a wall you can join.
//
// The catalog itself ships in the manifest rather than in the app, so a new
// trophy needs no app release.

import { createHash } from "node:crypto";

import { checkEdit } from "./card-edit.mjs";

/// Every trophy the wall can show. `color` is the trophy's own, not the card's.
/// Ids are permanent: unlock rows and installed apps key on them, so a trophy
/// is renamed through its label (first_light reads "Backer" and two_rails
/// "Multi-platform" since 2026-10-09) and never through its id.
export const ACHIEVEMENTS = [
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
    label: "Backer",
    description: "Backed Polyvox with a donation.",
    color: "#fb923c",
  },
  {
    id: "two_rails",
    label: "Multi-platform",
    description: "Gave through more than one platform.",
    color: "#34d399",
  },
  {
    id: "three_months",
    label: "Three months",
    description: "Gave in three different months.",
    color: "#f472b6",
  },
  {
    id: "first_of_month",
    label: "First of the month",
    description: "Gave on the 1st, or before anyone else that month.",
    color: "#a3e635",
  },
];

/// Catalog order, so a card's trophy row is stable between runs.
const BADGE_RANK = new Map(ACHIEVEMENTS.map((a, i) => [a.id, i]));

/// The card styles a supporter may pick through the wall opt-in. The mint
/// Worker and this file validate against the same list, so an unknown id
/// falls back to the plain card rather than reaching the app.
export const CARD_STYLES = ["plain", "friend_gold", "visitor_cyan", "pulse", "aurora"];

export const fold = (s) => String(s ?? "").trim().toLowerCase();

/** One person, one card, even when a live rail spelled them differently.
 *  `aliases` maps a display name as a rail delivered it to the name the card
 *  wears (`overrides.json` -> `aliases`); both sides are case-folded. A ledger
 *  entry can be renamed in place, but Stripe and Afdian records are pulled
 *  fresh on every run, so for them this is the only place a rename can happen.
 *  Returns new records; the input is never mutated. */
export function applyAliases(records, aliases = {}) {
  const map = new Map(
    Object.entries(aliases ?? {}).map(([from, to]) => [fold(from), String(to ?? "").trim()]),
  );
  if (!map.size) return records ?? [];
  return (records ?? []).map((r) => {
    const to = map.get(fold(r?.name));
    return to ? { ...r, name: to } : r;
  });
}

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

/// The bands a card can wear, lowest first, with the total in USD that reaches
/// each (R-DON.14). Named after Google Play's five so the order reads without a
/// legend; the app draws each one as a material. The steps sit on the
/// quick-donate amounts: one $10 is silver, one $25 gold, one $50 platinum.
export const BANDS = [
  { id: "bronze", min_usd: 0 },
  { id: "silver", min_usd: 10 },
  { id: "gold", min_usd: 25 },
  { id: "platinum", min_usd: 50 },
  { id: "diamond", min_usd: 100 },
];

/// Whole cents, so a total that converted through CNY lands on the step it was
/// paid to reach rather than a float's width under it.
const cents = (usd) => Math.round((Number(usd) || 0) * 100);

/// The thresholds in force, from `overrides.json` -> `bands` (R-OJJ.10).
///
/// That map is the one value the owner edits to move a step, for example
/// `{ "diamond": 150 }`. A band it leaves out keeps its default from `BANDS`;
/// an unknown id, a negative number or a step that would sit below the one
/// before it is ignored, so a typo can never reorder the bands. Bronze is the
/// floor and always starts at 0.
export function resolveBands(config = {}) {
  let floor = 0;
  return BANDS.map((b, i) => {
    const asked = Number(config?.[b.id]);
    const min = i === 0 ? 0 : Number.isFinite(asked) && asked >= floor ? asked : Math.max(b.min_usd, floor);
    floor = min;
    return { id: b.id, min_usd: min };
  });
}

/// The highest band a total reaches under `bands` (today's, by default).
/// Everybody on the wall gave something, so the floor is bronze.
export function bandFor(usd, bands = BANDS) {
  const c = cents(usd);
  let band = bands[0].id;
  for (const b of bands) if (c >= Math.round(b.min_usd * 100)) band = b.id;
  return band;
}

const BAND_RANK = new Map(BANDS.map((b, i) => [b.id, i]));

/// The higher of two band ids. An id that is not a band ranks below bronze, so
/// a hand edit that misspells one cannot lift or sink anybody.
export function higherBand(a, b) {
  const ra = BAND_RANK.get(a) ?? -1;
  const rb = BAND_RANK.get(b) ?? -1;
  if (ra < 0 && rb < 0) return BANDS[0].id;
  return ra >= rb ? a : b;
}

/// The earned-band record after this run (R-OJJ.10): a supporter keeps the
/// highest band they ever reached, at the thresholds that were in force when
/// they reached it, so raising a step later never takes a band away.
///
/// `previous` is `bands-earned.json` -> `earned`, keyed by the case-folded card
/// name. `cards` is the wall as `buildWall` built it, whose `band` already is
/// the higher of the stored one and today's. An entry whose card is missing
/// this run is kept as it was: a run that could not reach Stripe drops every
/// Stripe donor for that run, and pruning here would delete their band.
/// Returns a new object; neither input is mutated.
export function updateEarned(previous = {}, cards = [], month = "") {
  const out = { ...(previous ?? {}) };
  for (const c of cards ?? []) {
    const key = fold(c?.name);
    if (!key || !BAND_RANK.has(c?.band)) continue;
    const prior = out[key];
    if (prior && higherBand(prior.band, c.band) === prior.band) continue;
    out[key] = { band: c.band, since: month };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
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
  firstOfMonth = false,
  prealpha = new Set(),
  eras = new Map(),
} = {}) {
  const key = fold(name);
  const out = new Set();
  if (prealpha.has(key) || eras.get(key) === "prealpha") out.add("prealpha");
  if (eras.get(key) === "alpha") out.add("alpha");
  if (entries > 0) out.add("first_light");
  if (rails.length >= 2) out.add("two_rails");
  if (monthCount >= 3) out.add("three_months");
  if (firstOfMonth) out.add("first_of_month");
  return [...out].sort((a, b) => (BADGE_RANK.get(a) ?? 99) - (BADGE_RANK.get(b) ?? 99));
}

// --- First of the month -------------------------------------------------------
//
// A monthly goal starts over at 00:00 UTC on the 1st (goals.mjs), and this is
// the trophy for opening it. Everyone who gave on the 1st earns it. A month
// nobody opened on the 1st goes to its earliest payment instead, and when that
// payment was anonymous the month stays unclaimed rather than passing to the
// second donor. Earned once per person, like every other trophy.
//
// `at` is when the money moved. The day is read on the record's own clock, the
// same one its `month` came from: UTC for Stripe, Afdian and Ko-fi, the bill's
// for a hand entry, so a WeChat payment at 07:00 Beijing time on the 1st counts
// as the 1st. The earliest payment is compared as an instant instead, because a
// day on one clock cannot be ordered against a day on another.
//
// A payment with no time cannot be placed. It never costs anybody a 1st they
// can show, but while one sits in a month nobody is named that month's first:
// it might have come first, and a trophy on the wrong person is worse than
// none. That is why July to September 2026, whose Ko-fi entries predate `at`,
// can only be won on the 1st.

/** "YYYY-MM-DD" a record was paid on, or "" when its `at` is missing or falls
 *  outside its own `month`. */
export function dayOf(record) {
  const at = String(record?.at ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(at) && at.slice(0, 7) === record?.month ? at.slice(0, 10) : "";
}

/** Epoch milliseconds of a timed `at`, or NaN for a bare date or none. */
function instantOf(record) {
  const at = String(record?.at ?? "");
  return dayOf(record) && /T\d{2}:\d{2}/.test(at) ? Date.parse(at) : NaN;
}

/** Every payment that earned the trophy, plus the months that could only be
 *  scored on the 1st because a payment in them carries no time. Wall-only rows
 *  carry no money and never open a month. */
export function firstOfMonth(records) {
  const byMonth = new Map();
  for (const r of records ?? []) {
    if (!(Number(r?.usd) > 0) || !/^\d{4}-\d{2}$/.test(String(r?.month ?? ""))) continue;
    byMonth.set(r.month, [...(byMonth.get(r.month) ?? []), r]);
  }
  const won = new Set();
  const untimed = [];
  for (const [month, list] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    const onFirst = list.filter((r) => dayOf(r) === `${month}-01`);
    if (onFirst.length) {
      for (const r of onFirst) won.add(r);
      continue;
    }
    const times = list.map(instantOf);
    if (times.some(Number.isNaN)) {
      untimed.push(month);
      continue;
    }
    const first = Math.min(...times);
    list.forEach((r, i) => {
      if (times[i] === first) won.add(r);
    });
  }
  return { won, untimed };
}

/** `records` with `first_of_month: true` on every payment that earned it. New
 *  objects; the input is never mutated. */
export function markFirstOfMonth(records) {
  const { won, untimed } = firstOfMonth(records);
  return {
    records: (records ?? []).map((r) => (won.has(r) ? { ...r, first_of_month: true } : r)),
    untimed,
  };
}

/// Fold every record for one person into the card the wall renders. Identity
/// is the display name, case-folded: a one-off Ko-fi donation carries no
/// stable donor id, and merging two people who chose the same public name is
/// the acceptable end of that trade. The same fold is what joins one person's
/// Ko-fi and WeChat rails onto a single card.
///
/// Every card comes from a payment. The hand-kept founders list is gone
/// (R-DON.14): nobody could fairly hold that trophy, so nothing grants it.
export function buildWall(records, options = {}) {
  const {
    patronUsd = 25,
    prealpha = new Set(),
    eras = new Map(),
    cardStyles = {},
    // R-OJJ.10: the thresholds in force, and the band each card already earned.
    bands = BANDS,
    earned = {},
  } = options;
  const earnedBand = (name) => earned?.[fold(name)]?.band;
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
      firstOfMonth: false,
      link: "",
      style: "",
    };
    if (r.platform) person.rails.add(String(r.platform));
    person.months.add(r.month);
    person.usd += r.usd;
    person.entries += 1;
    person.recurring ||= Boolean(r.recurring);
    person.firstOfMonth ||= r.first_of_month === true;
    person.link ||= r.link ?? "";
    // A style the supporter picked through the wall opt-in travels on the
    // record. First one wins; the hand-kept map below is the fallback.
    person.style ||= CARD_STYLES.includes(String(r.style ?? "")) ? String(r.style) : "";
    byPerson.set(key, person);
  }

  const cards = [...byPerson.values()].map((p) => {
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
      // Set once the wall is sorted, below.
      place: 0,
      // Never lower than the band already earned, whatever today's steps say.
      band: earnedBand(p.name)
        ? higherBand(earnedBand(p.name), bandFor(p.usd, bands))
        : bandFor(p.usd, bands),
      badges: badgesFor({
        name: p.name,
        rails,
        monthCount: months.length,
        entries: p.entries,
        firstOfMonth: p.firstOfMonth,
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

  // Most given first (R-DON.14). A tie goes to whoever supported in more
  // months, then to whoever came first, then to the name, so the order never
  // depends on which rail answered first. The totals stay in this function:
  // only the place they produce is published.
  const totals = new Map([...byPerson.entries()].map(([key, p]) => [key, cents(p.usd)]));
  cards.sort(
    (a, b) =>
      totals.get(fold(b.name)) - totals.get(fold(a.name)) ||
      Object.keys(b.months).length - Object.keys(a.months).length ||
      String(a.since).localeCompare(String(b.since)) ||
      fold(a.name).localeCompare(fold(b.name)),
  );
  cards.forEach((card, i) => {
    card.place = i + 1;
  });
  return cards;
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

/// A blank-name payment joins the card its donation code already named.
///
/// The code comes from the donor's own license, so a returning donor who left
/// the name field empty is still the person who typed a name last time, and no
/// email is consulted to know it (owner decision, 2026-10-12: a tip from a
/// named supporter landed anonymous because the field was skipped). A code
/// that has carried two different names links nothing, since either guess
/// would put money on the wrong card. A record that carries a name keeps it.
///
/// Run after `applyAliases`, so the alias target is the name that carries, and
/// before `markFirstOfMonth`, so a linked payment that opened a month earns
/// that card the trophy. Returns new records; the input is never mutated.
export function linkByCode(records) {
  const named = new Map();
  for (const r of records ?? []) {
    const name = String(r?.name ?? "").trim();
    const code = name ? codeFrom(r) : "";
    if (!code) continue;
    const names = named.get(code) ?? new Map();
    if (!names.has(fold(name))) names.set(fold(name), name);
    named.set(code, names);
  }
  if (!named.size) return records ?? [];
  return (records ?? []).map((r) => {
    if (String(r?.name ?? "").trim()) return r;
    const names = named.get(codeFrom(r));
    return names?.size === 1 ? { ...r, name: [...names.values()][0] } : r;
  });
}

/// Which card each donation code names, keyed by the code's hash (R-OJJ.11).
///
/// The same rule as `linkByCode`: a code carried by a named payment names that
/// card, and a code that has carried two different names names none. Run on
/// the records after `linkByCode`. The keys are published as
/// `manifest.card_codes`, which tells the doorman a code may edit a card and
/// says nothing about which: the names stay in this function.
export function cardCodes(records) {
  const names = new Map();
  for (const r of records ?? []) {
    const name = String(r?.name ?? "").trim();
    const code = name ? codeFrom(r) : "";
    if (!code) continue;
    const set = names.get(code) ?? new Set();
    set.add(fold(name));
    names.set(code, set);
  }
  const out = new Map();
  for (const [code, set] of names) if (set.size === 1) out.set(hashCode(code), [...set][0]);
  return out;
}

/// The fields a card edit can carry, in the order card-edit.mjs checks them.
const EDIT_FIELDS = ["name", "tagline", "accent", "background", "avatar_url"];

/// The wall with each supporter's own edit applied (R-OJJ.11).
///
/// `edits` is card-edits.json -> `edits`, keyed by code hash; `owners` is
/// `cardCodes`. Every field is checked again with the Worker's own rules
/// (card-edit.mjs), so a hand edit to the file cannot put anything on the wall
/// the editor could not. `reverts` is overrides.json -> `card_edit_reverts`:
/// a card name (as the ledger has it, or as edited) or a code hash, case-folded,
/// and an edit it matches is ignored, which is how the owner undoes one.
///
/// Applied last, after the bands, the unlocks and the tester merge, so a new
/// display name changes what the card reads and nothing that is keyed on the
/// name. A display name another card already uses is ignored. Returns new
/// cards; the input is never mutated.
export function applyCardEdits(cards, { edits = {}, owners = new Map(), reverts = [] } = {}) {
  const struck = new Set((reverts ?? []).map((r) => fold(r)));
  const byOwner = new Map();
  for (const [hash, raw] of Object.entries(edits ?? {})) {
    const owner = owners.get(hash);
    if (!owner || struck.has(fold(hash))) continue;
    // Field by field, so one bad value drops that field and keeps the rest.
    const edit = {};
    for (const f of EDIT_FIELDS) Object.assign(edit, checkEdit({ [f]: raw?.[f] }).edit ?? {});
    byOwner.set(owner, edit);
  }
  if (!byOwner.size) return cards ?? [];
  const taken = new Set((cards ?? []).map((c) => fold(c?.name)));
  return (cards ?? []).map((c) => {
    const key = fold(c?.name);
    const edit = byOwner.get(key);
    if (!edit || struck.has(key) || (edit.name && struck.has(fold(edit.name)))) return c;
    const out = { ...c };
    if (edit.name && (fold(edit.name) === key || !taken.has(fold(edit.name)))) {
      out.name = edit.name;
      taken.add(fold(edit.name));
    }
    for (const f of EDIT_FIELDS.slice(1)) {
      if (edit[f]) out[f] = edit[f];
    }
    return out;
  });
}

/// Which trophies each donation code has unlocked.
///
/// A donation always earns `first_light` by itself, which is the point. Beyond
/// that the code inherits whatever its own card wears, so somebody who gave on
/// two rails sees `two_rails` in the app without having to find their card. A
/// coded payment that opened a month unlocks `first_of_month` even when it was
/// anonymous and so has no card to wear it on.
export function buildUnlocks(records, wall = []) {
  const byName = new Map((wall ?? []).map((s) => [fold(s?.name), s]));
  const out = {};
  for (const r of records ?? []) {
    const code = codeFrom(r);
    if (!code) continue;
    const key = hashCode(code);
    const ids = new Set(out[key] ?? ["first_light"]);
    if (r.first_of_month === true) ids.add("first_of_month");
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
