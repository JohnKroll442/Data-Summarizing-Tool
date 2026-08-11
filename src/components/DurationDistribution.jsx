import { useMemo } from 'react'
import { SLOW_ACTION_MS } from '../lib/anomalyDetect'
import { formatCount } from '../lib/format'
import './DurationDistribution.css'

/**
 * Fixed, semantic duration buckets for the Action view's distribution histogram.
 * Edges are the same round numbers a reader reasons in ("half a second", "five
 * seconds", "thirty seconds"), and the top edge (30s) is the slow_action cutoff
 * — so the ">30s" bar counts exactly the actions the slow_action flag counts.
 *
 * Each bucket is [min, max): min inclusive, max exclusive. The last bucket is
 * open-ended (max = Infinity) and tinted as the danger bucket.
 *
 * `tier` is a green/orange/red traffic light for at-a-glance health:
 *   good (green)  < 2s      — snappy
 *   okay (orange) 2s–30s    — noticeable but tolerable
 *   bad  (red)    ≥ 30s     — the slow_action bucket
 */
export const DURATION_GOOD_MAX = 2000            // < 2s  → green
export const DURATION_OKAY_MAX = SLOW_ACTION_MS  // < 30s → orange, else red

export function durationTier(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return null
  if (n < DURATION_GOOD_MAX) return 'good'
  if (n < DURATION_OKAY_MAX) return 'okay'
  return 'bad'
}

export const DURATION_BUCKETS = [
  { key: 'lt0_5', label: '<0.5s',  min: 0,               max: 500 },
  { key: '0_5_2', label: '0.5–2s', min: 500,             max: 2000 },
  { key: '2_5',   label: '2–5s',   min: 2000,            max: 5000 },
  { key: '5_10',  label: '5–10s',  min: 5000,            max: 10000 },
  { key: '10_30', label: '10–30s', min: 10000,           max: SLOW_ACTION_MS },
  { key: 'gt30',  label: '>30s',   min: SLOW_ACTION_MS,  max: Infinity, danger: true },
].map((b) => ({ ...b, tier: durationTier(b.min) }))

/**
 * The DURATION_BUCKETS key a single value lands in, or null for a blank /
 * non-finite value (which no bucket owns). This is the ONE place that decides
 * bucket membership — both the histogram tally below and the click-to-filter
 * predicate in the table go through it, so a bar's height always equals the
 * number of rows filtering to it selects.
 */
export function bucketKeyOf(value) {
  // Skip blanks before Number() — an empty string / null both coerce to a
  // (finite) 0 and would otherwise masquerade as instant 0-duration actions.
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  // Below the first bucket's floor (e.g. a negative span) still lands in the
  // first bucket so nothing is silently dropped.
  const i = DURATION_BUCKETS.findIndex((b) => n < b.max)
  return DURATION_BUCKETS[i === -1 ? DURATION_BUCKETS.length - 1 : i].key
}

/**
 * Tally each numeric value into DURATION_BUCKETS. Returns one entry per bucket
 * `{ key, label, min, max, danger?, count }` in bucket order. Non-finite values
 * (blank/unparseable durations) are skipped, not forced into a bucket.
 */
export function bucketDurations(values) {
  const out = DURATION_BUCKETS.map((b) => ({ ...b, count: 0 }))
  const index = new Map(out.map((b, i) => [b.key, i]))
  for (const v of values || []) {
    const key = bucketKeyOf(v)
    if (key === null) continue
    out[index.get(key)].count++
  }
  return out
}

/**
 * Horizontal duration-distribution histogram for the Action view's left rail.
 * One bar per semantic bucket, colored green/orange/red by its `tier` so the
 * health of the distribution reads at a glance (green < 2s, orange 2–30s, red
 * ≥ 30s — the last bucket ties to the slow_action flag). `durations` is the
 * list of per-action `action_duration` values (ms) for the actions in scope.
 *
 * When `highlightDuration` is set (a single action is hovered), the histogram
 * collapses to just THAT action: its bucket fills, every other bucket reads 0 —
 * so the reader sees exactly where the hovered action lands.
 *
 * When `onSelectBucket` is provided, each bar becomes a click-to-filter button:
 * clicking a bucket selects it (highlighted via `activeBucketKey`), clicking the
 * active one again clears. The bars keep the full distribution so this stays a
 * usable control even while a bucket is selected. Interactivity is suppressed in
 * the hovered-action ("this action") mode, which is a transient preview.
 */
function DurationDistribution({
  durations,
  highlightDuration = null,
  activeBucketKey = null,
  onSelectBucket,
}) {
  const isHighlight = highlightDuration !== null && highlightDuration !== undefined
  const interactive = !isHighlight && typeof onSelectBucket === 'function'
  const buckets = useMemo(
    () => bucketDurations(isHighlight ? [highlightDuration] : durations),
    [isHighlight, highlightDuration, durations],
  )
  const total = buckets.reduce((n, b) => n + b.count, 0)
  const max = buckets.reduce((m, b) => (b.count > m ? b.count : m), 0)

  return (
    <section className="duration-dist" aria-label="Action duration distribution">
      <div className="duration-dist__title">
        {isHighlight ? 'Action duration · this action' : 'Action duration'}
      </div>
      {total === 0 ? (
        <div className="duration-dist__empty">
          {isHighlight ? 'No duration for this action' : 'No actions in view'}
        </div>
      ) : (
        <ul className="duration-dist__list">
          {buckets.map((b) => {
            const pct = total ? Math.round((b.count / total) * 100) : 0
            const width = max ? (b.count / max) * 100 : 0
            const active = b.key === activeBucketKey
            const inner = (
              <>
                <span className="duration-dist__label">{b.label}</span>
                <span className="duration-dist__bar-track">
                  <span
                    className="duration-dist__bar"
                    style={{ width: `${width}%` }}
                  />
                </span>
                <span className="duration-dist__count" title={`${pct}% of actions`}>
                  {formatCount(b.count)}
                </span>
              </>
            )
            if (interactive) {
              return (
                <li key={b.key}>
                  <button
                    type="button"
                    className={`duration-dist__row is-${b.tier}${active ? ' is-active' : ''}`}
                    aria-pressed={active}
                    disabled={b.count === 0}
                    title={`Filter to actions in ${b.label}`}
                    onClick={() => onSelectBucket(b.key)}
                  >
                    {inner}
                  </button>
                </li>
              )
            }
            return (
              <li className={`duration-dist__row is-${b.tier}`} key={b.key}>
                {inner}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default DurationDistribution
