/**
 * Cross-navigation memoization for the pure aggregate / filter helpers.
 *
 * The summary tabs (Raw / Session / Action / Widget) are separate routes, so
 * navigating between them unmounts the old view and mounts the new one —
 * discarding every component-level `useMemo`. That makes each tab switch
 * re-run the full O(rows) aggregation and filtering from scratch, and the work
 * is duplicated within a view (the KPI strip and the summary table each scope
 * and aggregate independently).
 *
 * These caches live at MODULE scope, so they survive unmount/remount and are
 * shared across every caller. Keys are argument references (WeakMap), so the
 * cache auto-evicts when a file swap drops the old `rows` array — no manual
 * eviction. Both helpers assume the wrapped function is PURE and its results
 * are treated as read-only (the tables copy before sorting/mutating).
 */

/**
 * Memoize a pure `(rows, headers) => result` aggregate by the identity of both
 * arguments. Cache shape: `WeakMap<rows, WeakMap<headers, result>>`.
 *
 * Falls back to calling through (no caching) when `rows` or `headers` isn't an
 * object — e.g. kpis.js's `deriveHeaders` fallback can pass a freshly-built
 * headers array, and WeakMap keys must be objects.
 */
export function memoizeAggregate(fn) {
  const cache = new WeakMap() // rows -> WeakMap<headers, result>
  return (rows, headers) => {
    if (!isObject(rows) || !isObject(headers)) return fn(rows, headers)
    let byHeaders = cache.get(rows)
    if (!byHeaders) {
      byHeaders = new WeakMap()
      cache.set(rows, byHeaders)
    }
    if (byHeaders.has(headers)) return byHeaders.get(headers)
    const result = fn(rows, headers)
    byHeaders.set(headers, result)
    return result
  }
}

/**
 * Memoize a pure `(rows, headers, arg) => scopedRows` filter. Cache shape:
 * `WeakMap<rows, Map<sig, scopedRows>>` where `sig = sigFn(arg)`.
 *
 * The point is to return a STABLE scoped-array reference for the same inputs,
 * so a downstream `memoizeAggregate` still hits even when different callers
 * (KPI strip vs. summary table) scope the rows independently. `headers` isn't
 * part of the signature because it changes only alongside `rows` (both come
 * from the same file), and `rows` is already the outer WeakMap key.
 */
export function memoizeFilter(fn, sigFn) {
  const cache = new WeakMap() // rows -> Map<sig, scopedRows>
  return (rows, headers, arg) => {
    if (!isObject(rows)) return fn(rows, headers, arg)
    let bySig = cache.get(rows)
    if (!bySig) {
      bySig = new Map()
      cache.set(rows, bySig)
    }
    const sig = sigFn(arg)
    if (bySig.has(sig)) return bySig.get(sig)
    const result = fn(rows, headers, arg)
    bySig.set(sig, result)
    return result
  }
}

function isObject(v) {
  return v !== null && typeof v === 'object'
}
