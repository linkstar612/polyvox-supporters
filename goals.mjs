// The dollar figure on each Supporters-tab goal bar.
//
// Split out of aggregate.mjs so it can be unit-tested, the way cards.mjs and
// wall.mjs are.
//
// A goal whose `kind` is "monthly" counts only the records stamped with the
// current month, so its bar starts over at 00:00 UTC on the 1st. Any other kind
// counts every record. Stripe, Afdian and Ko-fi stamp `month` in UTC (`monthOf`
// below, afdian.mjs, the doorman). A hand-written ledger entry carries the month
// on its bill, which for cn-record.mjs is China time.

/** "YYYY-MM" in UTC, the month a record carries. */
export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

/** One goal's total in USD, rounded to cents. `records` are already converted
 *  (`usd`) and attributed (`goal`). `manualUsd` is overrides.json's per-goal
 *  nudge and is added on every run, so on a monthly goal it lands in every
 *  month. */
export function goalTotal(goal, records, { manualUsd = {}, nowMs = Date.now() } = {}) {
  const month = goal?.kind === "monthly" ? monthOf(nowMs) : null;
  const earned = (records ?? [])
    .filter((r) => r.goal === goal.id && (month === null || r.month === month))
    .reduce((sum, r) => sum + r.usd, 0);
  const manual = Number(manualUsd?.[goal.id]) || 0;
  return Math.round((earned + manual) * 100) / 100;
}
