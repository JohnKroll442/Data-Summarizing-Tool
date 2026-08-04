/**
 * Range filter for a duration column (Session View's "Total action duration",
 * Action View's "Action duration"). A filter is `{ minMs, maxMs }` — the open
 * lower/upper bounds in milliseconds, either of which may be `null` for an
 * open-ended side — or `null` when inactive. A row matches when its value sits
 * strictly between the bounds: `minMs < value < maxMs`.
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
// non-numeric, or negative amount (i.e. "no bound set") and for an unknown unit
// — callers treat null as "this side of the range is open".
export function toMs(amount, unitId) {
  if (amount === '' || amount === null || amount === undefined) return null
  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0) return null
  const unit = DURATION_UNITS.find((u) => u.id === unitId)
  return unit ? n * unit.ms : null
}

/**
 * Does a row satisfy the duration range filter? A null filter (or one with both
 * bounds open) matches every row. A blank or non-numeric value in `key` never
 * matches an ACTIVE filter (a row with no duration can't be inside a range).
 * Both bounds are strict (min < value < max), so a value sitting exactly on
 * either boundary falls outside the range.
 */
export function matchesDurationFilter(row, key, filter) {
  if (!filter) return true
  const raw = row?.[key]
  // Blank means "no duration recorded" — Number('') is 0, which would sneak
  // past an upper bound, so reject empties before the numeric compare.
  if (raw === '' || raw === null || raw === undefined) return false
  return valueMatchesDuration(raw, filter)
}

/**
 * Value-level twin of `matchesDurationFilter` — tests a already-extracted
 * millisecond value (not a row/key) against the same `{ minMs, maxMs }` bounds
 * with the same strict semantics. Used by the Summary rankings, where each
 * entity's ranked value (a widget's network ms, an action's duration, …) is
 * compared directly against the active duration threshold. A null filter or a
 * non-numeric value that can't sit in a range returns the same as the row form.
 */
export function valueMatchesDuration(value, filter) {
  if (!filter) return true
  const { minMs = null, maxMs = null } = filter
  if (minMs === null && maxMs === null) return true
  const v = Number(value)
  if (!Number.isFinite(v)) return false
  if (minMs !== null && !(v > minMs)) return false
  if (maxMs !== null && !(v < maxMs)) return false
  return true
}
