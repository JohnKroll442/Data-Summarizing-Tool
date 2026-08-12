/**
 * Data-derived duration bands for the Action view's distribution histogram.
 *
 * Bands are NOT a fixed global anymore — `computeDurationBands(durations)` seeds
 * edges from the dataset's own quantiles (so the histogram gets resolution WHERE
 * the actions actually cluster), then snaps each edge to a round, readable time
 * value. The band range adapts to the data in two directions:
 *   - adapts DOWN: a dataset whose actions top out under a minute ends at the
 *     round band containing its slowest action (e.g. "30s–1m"), with no empty
 *     ">2m" bar.
 *   - capped UP: 2m is a hard ceiling — anything ≥ 2m always lands in a terminal
 *     open ">2m" danger band. No edge is ever placed above 2m.
 *
 * Membership is decided in ONE place (`bucketKeyOf`), shared by the histogram
 * tally, the table's click-to-filter, and (via the same computed band set) the
 * detector's `large_offset` threshold — so a bar's height always equals the
 * number of rows filtering to it selects.
 *
 * `tier` stays ABSOLUTE (green<5s / orange / yellow / deep-orange / red≥2m) so
 * band COLOR still means objectively fast/slow even as band WIDTHS adapt: a
 * dataset with no truly-slow actions simply never shows red.
 */

import { percentile } from './kpis'

const SEC = 1000
const MIN = 60000

export const DURATION_GOOD_MAX = 5 * SEC // < 5s → green
export const DURATION_CEIL_MS = 2 * MIN // 2m — the top edge / slow ceiling

// Curated ladder of round, human-readable durations (ms). Quantile cut points
// snap to the nearest of these so band edges read as "half a second", "thirty
// seconds", "one minute". 2m (the ceiling) is the last rung.
export const ROUND_LADDER = [
  250, 500, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 30000, 45000, 60000, 90000, 120000,
]

// Aim for ~6 bands: quantile cuts at k/6 for k = 1..5, then snapped + deduped.
const TARGET_BANDS = 6

/**
 * The absolute 5-band health color for a duration (ms), or null for non-finite.
 * Independent of the (adaptive) band edges — it's a fixed traffic light.
 */
export function durationTier(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return null
  if (n < DURATION_GOOD_MAX) return 'good'
  if (n < 30 * SEC) return 'neutral'
  if (n < MIN) return 'watch'
  if (n < 2 * MIN) return 'warn'
  return 'bad'
}

// Compact edge label: 0.25s, 0.5s, 2s, 30s, 45s, 90s, 1m, 2m.
function fmtEdge(ms) {
  if (!Number.isFinite(ms)) return ''
  if (ms < MIN) return `${ms / SEC}s`
  if (ms % MIN === 0) return `${ms / MIN}m`
  return `${ms / SEC}s`
}

function bandLabel(min, max) {
  if (min <= 0) return `<${fmtEdge(max)}`
  if (!Number.isFinite(max)) return `>${fmtEdge(min)}`
  return `${fmtEdge(min)}–${fmtEdge(max)}`
}

// A band spanning [min, max): min inclusive, max exclusive. The open-ended
// terminal band (max = Infinity) is the ">2m" danger bucket.
function makeBand(min, max) {
  const band = {
    key: `${min}_${max}`,
    label: bandLabel(min, max),
    min,
    max,
    tier: durationTier(min),
  }
  if (max === Infinity) band.danger = true
  return band
}

function buildBands(boundaries, terminalOpen, topEdge) {
  const bands = []
  let prev = 0
  for (const b of boundaries) {
    bands.push(makeBand(prev, b))
    prev = b
  }
  bands.push(makeBand(prev, topEdge)) // last sub-terminal / closed terminal band
  if (terminalOpen) bands.push(makeBand(topEdge, Infinity)) // ">2m" danger
  return bands
}

// The fixed ladder used when there's nothing to derive bands from (empty scope).
// Matches the app's original 8-band layout up to the 2m ceiling.
const FALLBACK_BANDS = buildBands([500, 2000, 5000, 10000, 30000, 60000], true, DURATION_CEIL_MS)

function snapToLadder(x) {
  let best = ROUND_LADDER[0]
  let bestDist = Math.abs(x - best)
  for (const v of ROUND_LADDER) {
    const d = Math.abs(x - v)
    if (d < bestDist) {
      bestDist = d
      best = v
    }
  }
  return best
}

/**
 * Compute the dataset's duration bands from its action durations (ms). Returns
 * `[{ key, label, min, max, tier, danger? }]` in ascending order. Empty /
 * all-non-finite input falls back to the fixed ladder.
 */
export function computeDurationBands(durations) {
  const D = []
  for (const v of durations || []) {
    if (v === '' || v === null || v === undefined) continue
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) D.push(n)
  }
  if (D.length === 0) return FALLBACK_BANDS
  D.sort((a, b) => a - b)
  const maxD = D[D.length - 1]

  // Terminal band: the ">2m" ceiling when the data reaches it, else the round
  // band containing the slowest action (adapt down).
  const hasCeil = maxD >= DURATION_CEIL_MS
  const topEdge = hasCeil
    ? DURATION_CEIL_MS
    : ROUND_LADDER.find((v) => v > maxD) ?? DURATION_CEIL_MS

  // Interior cut points from evenly-spaced quantiles, snapped to the ladder and
  // kept strictly inside (0, topEdge). Skewed data collapses duplicates, which
  // is fine — that's just fewer, wider bands where the data is sparse.
  const edges = new Set()
  for (let k = 1; k < TARGET_BANDS; k++) {
    const q = percentile(D, k / TARGET_BANDS)
    if (q === '' || !Number.isFinite(q)) continue
    const snapped = snapToLadder(q)
    if (snapped > 0 && snapped < topEdge) edges.add(snapped)
  }

  const boundaries = [...edges].sort((a, b) => a - b)
  return buildBands(boundaries, hasCeil, topEdge)
}

/**
 * The band key a single value lands in, or null for a blank / non-finite value.
 * Min-inclusive, max-exclusive; a value at/above every max falls into the last
 * band (nothing is silently dropped). `bands` defaults to the fallback ladder.
 */
export function bucketKeyOf(value, bands) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const list = bands && bands.length ? bands : FALLBACK_BANDS
  const i = list.findIndex((b) => n < b.max)
  return list[i === -1 ? list.length - 1 : i].key
}

/**
 * Tally each numeric value into `bands`. Returns one `{ ...band, count }` entry
 * per band, in order. Non-finite values are skipped, not forced into a band.
 */
export function bucketDurations(values, bands) {
  const list = bands && bands.length ? bands : FALLBACK_BANDS
  const out = list.map((b) => ({ ...b, count: 0 }))
  const index = new Map(out.map((b, i) => [b.key, i]))
  for (const v of values || []) {
    const key = bucketKeyOf(v, list)
    if (key === null) continue
    const idx = index.get(key)
    if (idx !== undefined) out[idx].count++
  }
  return out
}
