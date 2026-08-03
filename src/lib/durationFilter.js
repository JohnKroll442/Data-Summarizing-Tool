/**
 * Threshold filter for a duration column (Session View's "Total action
 * duration"). A filter is `{ op, ms }` — `op` is 'below' or 'above' and `ms`
 * is the boundary in milliseconds — or `null` when inactive.
 *
 * Kept tiny and pure so the table can reuse `matchesDurationFilter` in both its
 * visible-row predicate and its faceted-option predicate, and so the menu can
 * convert a typed value+unit into milliseconds without duplicating the math.
 */

// Units the menu offers, each with its millisecond multiplier.
export const DURATION_UNITS = [
  { id: 'sec', label: 'seconds', ms: 1000 },
  { id: 'min', label: 'minutes', ms: 60_000 },
]

// Convert a typed amount + unit id into milliseconds. Returns null for a blank,
// non-numeric, or negative amount (i.e. "no threshold set") and for an
// unknown unit — callers treat null as "filter inactive".
export function toMs(amount, unitId) {
  if (amount === '' || amount === null || amount === undefined) return null
  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0) return null
  const unit = DURATION_UNITS.find((u) => u.id === unitId)
  return unit ? n * unit.ms : null
}

/**
 * Does a row satisfy the duration filter? A null filter matches every row. A
 * blank or non-numeric value in `key` never matches an ACTIVE filter (you can't
 * be "below 2m" if there's no duration). 'below' / 'above' are strict (< / >),
 * matching the words: exactly-at-the-boundary rows fall outside both.
 */
export function matchesDurationFilter(row, key, filter) {
  if (!filter) return true
  const raw = row?.[key]
  // Blank means "no duration recorded" — Number('') is 0, which would sneak
  // into a "below" filter, so reject empties before the numeric compare.
  if (raw === '' || raw === null || raw === undefined) return false
  const v = Number(raw)
  if (!Number.isFinite(v)) return false
  return filter.op === 'below' ? v < filter.ms : v > filter.ms
}
