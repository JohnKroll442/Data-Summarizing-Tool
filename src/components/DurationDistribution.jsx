import { useMemo } from 'react'
import { formatCount } from '../lib/format'
import { bucketDurations, computeDurationBands } from '../lib/durationBands'
import './DurationDistribution.css'


/**
 * Horizontal duration-distribution histogram for the Action view's left rail.
 * One bar per semantic bucket, colored on a 5-band green→red scale by its `tier`
 * so the health of the distribution reads at a glance (green < 5s, orange 5–30s,
 * yellow 30s–1m, deep-orange 1–2m, red ≥ 2m — the last bucket ties to the slow_action
 * flag). `durations` is the list of per-action `action_duration` values (ms) for
 * the actions in scope.
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
  bands = null,
  highlightDuration = null,
  activeBucketKey = null,
  onSelectBucket,
}) {
  const isHighlight = highlightDuration !== null && highlightDuration !== undefined
  const interactive = !isHighlight && typeof onSelectBucket === 'function'
  // The band EDGES are the canonical set passed in (computed once over the full
  // scope, so they stay put while the table filters); fall back to deriving them
  // from `durations` when used standalone. Only the COUNTS reflect the visible /
  // hovered set.
  const activeBands = useMemo(
    () => (bands && bands.length ? bands : computeDurationBands(durations)),
    [bands, durations],
  )
  const buckets = useMemo(
    () => bucketDurations(isHighlight ? [highlightDuration] : durations, activeBands),
    [isHighlight, highlightDuration, durations, activeBands],
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
