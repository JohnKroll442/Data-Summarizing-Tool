/**
 * Pure CSV-row → chart-ready shape transforms. Each helper is safe on
 * empty / malformed input and returns an empty array rather than throwing.
 */

/** Count occurrences of each distinct value in `key`. */
export function countByColumn(rows, key) {
  if (!rows?.length || !key) return []
  const counts = new Map()
  for (const row of rows) {
    const v = row?.[key]
    if (v === undefined || v === null || v === '') continue
    const label = String(v)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return Array.from(counts, ([name, value]) => ({ name, value }))
}

/** Sum numeric `valueKey` grouped by `groupKey`. */
export function sumByColumn(rows, groupKey, valueKey) {
  if (!rows?.length || !groupKey || !valueKey) return []
  const sums = new Map()
  for (const row of rows) {
    const g = row?.[groupKey]
    const n = Number(row?.[valueKey])
    if (g === undefined || g === null || g === '') continue
    if (!Number.isFinite(n)) continue
    const label = String(g)
    sums.set(label, (sums.get(label) ?? 0) + n)
  }
  return Array.from(sums, ([name, value]) => ({ name, value }))
}

/** Group rows by `key` into a Map<value, rows[]>. */
export function groupBy(rows, key) {
  const map = new Map()
  if (!rows?.length || !key) return map
  for (const row of rows) {
    const v = row?.[key]
    if (v === undefined || v === null) continue
    const k = String(v)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(row)
  }
  return map
}

/** Bin numeric values from `key` into `binCount` equal-width buckets. */
export function bin(rows, key, binCount = 10) {
  if (!rows?.length || !key) return []
  const nums = rows
    .map((r) => Number(r?.[key]))
    .filter((n) => Number.isFinite(n))
  if (nums.length === 0) return []
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  if (min === max) return [{ name: `${min}`, value: nums.length }]
  const width = (max - min) / binCount
  const bins = Array.from({ length: binCount }, (_, i) => ({
    name: `${(min + i * width).toFixed(1)}–${(min + (i + 1) * width).toFixed(1)}`,
    value: 0,
  }))
  for (const n of nums) {
    let idx = Math.floor((n - min) / width)
    if (idx >= binCount) idx = binCount - 1
    bins[idx].value++
  }
  return bins
}

/**
 * Build a financial-cumulative waterfall: each row contributes a delta to
 * a running total. Returns [{ label, value, runningBase }] — option builder
 * turns this into a stacked bar with a transparent base.
 */
export function cumulativeDeltas(rows, labelKey, valueKey) {
  if (!rows?.length || !labelKey || !valueKey) return []
  let running = 0
  const out = []
  for (const row of rows) {
    const label = row?.[labelKey]
    const value = Number(row?.[valueKey])
    if (label === undefined || label === null) continue
    if (!Number.isFinite(value)) continue
    const base = value >= 0 ? running : running + value
    out.push({ label: String(label), value, base })
    running += value
  }
  return out
}

/**
 * Convert rows into sankey-shape { nodes, links } using sourceKey → targetKey
 * and (optional) numeric valueKey. Each unique source/target string becomes
 * a node; rows aggregate into links by (source, target).
 */
export function toSankeyShape(rows, sourceKey, targetKey, valueKey) {
  if (!rows?.length || !sourceKey || !targetKey) return { nodes: [], links: [] }
  const nodeSet = new Set()
  const linkMap = new Map() // "src|tgt" → value
  for (const row of rows) {
    const s = row?.[sourceKey]
    const t = row?.[targetKey]
    if (s === undefined || s === null || s === '') continue
    if (t === undefined || t === null || t === '') continue
    const src = String(s)
    const tgt = String(t)
    if (src === tgt) continue
    nodeSet.add(src)
    nodeSet.add(tgt)
    const v = valueKey ? Number(row?.[valueKey]) : 1
    const add = Number.isFinite(v) ? v : 1
    const key = `${src}|${tgt}`
    linkMap.set(key, (linkMap.get(key) ?? 0) + add)
  }
  return {
    nodes: Array.from(nodeSet, (name) => ({ name })),
    links: Array.from(linkMap, ([key, value]) => {
      const [source, target] = key.split('|')
      return { source, target, value }
    }),
  }
}

/** Project numeric pairs out of rows; drop rows where either is non-finite. */
export function numericPairs(rows, xKey, yKey) {
  if (!rows?.length || !xKey || !yKey) return []
  const out = []
  for (const row of rows) {
    const x = Number(row?.[xKey])
    const y = Number(row?.[yKey])
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y])
  }
  return out
}

/** Project numeric triples (x, y, size) for bubble charts. */
export function numericTriples(rows, xKey, yKey, sizeKey) {
  if (!rows?.length || !xKey || !yKey) return []
  const out = []
  for (const row of rows) {
    const x = Number(row?.[xKey])
    const y = Number(row?.[yKey])
    const s = sizeKey ? Number(row?.[sizeKey]) : 10
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push([x, y, Number.isFinite(s) ? s : 10])
  }
  return out
}

/**
 * Profile each column of `rows` once so the chart picker can offer only
 * columns of the right shape for each field.
 *
 * Returns `{ [columnName]: { type, distinctCount, finiteCount, dateCount } }`
 * where `type` is one of:
 *   'numeric'     — ≥80% of non-empty values parse as finite numbers
 *   'date'        — ≥80% of non-empty values parse as a Date and aren't pure numbers
 *   'categorical' — everything else
 *
 * `distinctCount` counts the unique stringified values (used to weed out
 * IDs and other near-unique columns from dimension dropdowns).
 */
export function profileColumns(rows, headers) {
  const out = {}
  if (!rows?.length || !headers?.length) return out

  for (const key of headers) {
    let nonEmpty = 0
    let finite = 0
    let dateLike = 0
    const distinct = new Set()
    for (const row of rows) {
      const v = row?.[key]
      if (v === undefined || v === null || v === '') continue
      nonEmpty++
      distinct.add(typeof v === 'object' ? JSON.stringify(v) : String(v))
      const n = Number(v)
      if (Number.isFinite(n)) {
        finite++
        continue
      }
      const d = Date.parse(v)
      if (Number.isFinite(d)) dateLike++
    }
    let type = 'categorical'
    if (nonEmpty > 0) {
      if (finite / nonEmpty >= 0.8) type = 'numeric'
      else if (dateLike / nonEmpty >= 0.8) type = 'date'
    }
    out[key] = {
      type,
      distinctCount: distinct.size,
      finiteCount: finite,
      dateCount: dateLike,
      nonEmptyCount: nonEmpty,
    }
  }
  return out
}

/**
 * Count rows where every key in `keys` has a finite numeric value. Used
 * to pre-validate scatter/bubble Y-axis options after X has been picked.
 */
export function countRowsWithFiniteAll(rows, keys) {
  if (!rows?.length || !keys?.length) return 0
  let n = 0
  outer: for (const row of rows) {
    for (const k of keys) {
      if (!Number.isFinite(Number(row?.[k]))) continue outer
    }
    n++
  }
  return n
}
