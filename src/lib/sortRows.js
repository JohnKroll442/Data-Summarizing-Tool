/**
 * Generic row sorter for the summary tables.
 *
 * Empty / null / undefined cells always sort LAST regardless of direction —
 * users almost never want "—" rows clustered at the top.
 *
 * `sortType` controls the comparator:
 *   'number'   — coerce both sides via Number()
 *   'duration' — same as number (timings are raw ms)
 *   'string'   — case-insensitive localeCompare (default)
 *
 * `Array.prototype.sort` is stable in modern engines, so ties preserve the
 * caller's incoming order (i.e. the filtered order from the summary table).
 */

const EMPTY = (v) => v === null || v === undefined || v === ''

export function compareValues(a, b, sortType = 'string') {
  const aEmpty = EMPTY(a)
  const bEmpty = EMPTY(b)
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1

  if (sortType === 'number' || sortType === 'duration') {
    const an = Number(a)
    const bn = Number(b)
    const aBad = !Number.isFinite(an)
    const bBad = !Number.isFinite(bn)
    if (aBad && bBad) return 0
    if (aBad) return 1
    if (bBad) return -1
    return an - bn
  }

  return String(a).localeCompare(String(b), undefined, {
    sensitivity: 'base',
    numeric: true,
  })
}

export function sortRows(rows, key, dir, sortType = 'string') {
  if (!key || !dir) return rows
  const mult = dir === 'desc' ? -1 : 1
  const copy = rows.slice()
  copy.sort((ra, rb) => mult * compareValues(ra?.[key], rb?.[key], sortType))
  return copy
}
