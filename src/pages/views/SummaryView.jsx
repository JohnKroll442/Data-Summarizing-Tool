import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCsvData } from '../../context/useCsvData'
import { computeRankings, computeBusiest } from '../../lib/summary'
import { formatDurationMs, formatCount, formatTimeRangeLabel } from '../../lib/format'
import './SummaryView.css'

/**
 * SummaryView — the landing tab. A "busiest periods" strip (day / week / month
 * by action count), then two clearly-split ranking sections: the SLOWEST 10 and
 * the FASTEST 10 for each category. Each list row links to the entity's view.
 *
 * When the Activity Timeline has a focused window (`timelineRange`), everything
 * here recomputes WITHIN that window — the busiest periods and the rankings
 * answer "…within this time period" — matching the timeline-scoped counts in
 * the Session / Action / Widget tables. A banner shows the active window and
 * clears it.
 */
function SummaryView() {
  const {
    rows,
    headers,
    setSessionFilter,
    setActionFilter,
    setSessionMultiFilter,
    setActionMultiFilter,
    focusTimeline,
    timelineRange,
    resetTimeline,
  } = useCsvData()
  const navigate = useNavigate()

  const rankings = useMemo(
    () => computeRankings(rows, headers, { range: timelineRange }),
    [rows, headers, timelineRange],
  )
  const busiest = useMemo(
    () => computeBusiest(rows, headers, { range: timelineRange }),
    [rows, headers, timelineRange],
  )

  // Open a ranked row in its view with the entity pre-filtered. Clear any stale
  // drill-down scope first so the target definitely shows the clicked entity,
  // then pass the column filters as router state — a one-shot the target table
  // seeds from on mount (survives StrictMode; not re-applied on tab clicks).
  const openEntity = (nav) => {
    setSessionFilter(null)
    setActionFilter(null)
    setSessionMultiFilter([])
    setActionMultiFilter([])
    const hasColumns = nav.columns && Object.keys(nav.columns).length > 0
    navigate(`/summary/${nav.view}`, hasColumns ? { state: { summaryFilters: nav.columns } } : undefined)
  }

  const busiestCards = busiest
    ? [
        { key: 'day', label: 'Busiest day', period: busiest.day },
        { key: 'week', label: 'Busiest 7 days', period: busiest.week },
        { key: 'month', label: 'Busiest 30 Days', period: busiest.month },
      ].filter((c) => c.period)
    : []

  const renderList = (list) => (
    <section className="summary-top10-card" key={list.id}>
      <h4 className="summary-top10-title">{list.title}</h4>
      {list.items.length === 0 ? (
        <p className="summary-top10-empty">No data for this metric.</p>
      ) : (
        <ol className="summary-top10-list">
          {list.items.map((it, i) => (
            <li key={`${it.label}-${i}`}>
              <button
                type="button"
                className="summary-top10-row"
                onClick={() => openEntity(it.nav)}
                title={`Open in ${it.nav.view} view`}
              >
                <span className="summary-top10-rank">{i + 1}</span>
                <span className="summary-top10-name">
                  <span className="summary-top10-primary">{it.label}</span>
                  {it.sublabel && <span className="summary-top10-sub">{it.sublabel}</span>}
                </span>
                <span className="summary-top10-value">{formatDurationMs(it.value)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )

  return (
    <>
      <header className="summary-view-header">
        <h2 className="view-heading">Summary</h2>
      </header>

      {timelineRange && (
        <div className="summary-active-window is-centered" role="status">
          Busiest periods and rankings for the timeline range{' '}
          <strong>{formatTimeRangeLabel(timelineRange.min, timelineRange.max)}</strong>
          <button
            type="button"
            className="summary-active-window-clear"
            onClick={resetTimeline}
            title="Reset the Activity Timeline to its full range"
          >
            Clear
          </button>
        </div>
      )}

      {busiestCards.length > 0 && (
        <div className="summary-busiest" role="group" aria-label="Busiest periods">
          {busiestCards.map((c) => (
            <button
              type="button"
              className="summary-busiest-card"
              key={c.key}
              onClick={() => focusTimeline(c.period.min, c.period.max)}
              title="Focus the Activity Timeline on this period"
            >
              <div className="summary-busiest-label">{c.label}</div>
              <div className="summary-busiest-period">{c.period.label}</div>
              <div className="summary-busiest-count">
                {formatCount(c.period.count)} actions
              </div>
            </button>
          ))}
        </div>
      )}

      <section className="summary-rank-section summary-rank-slowest">
        <h3 className="summary-rank-heading">
          <span className="summary-rank-dot" aria-hidden="true" />
          Slowest 10
        </h3>
        <div className="summary-top10-grid">{rankings.slowest.map(renderList)}</div>
      </section>

      <hr className="summary-rank-divider" />

      <section className="summary-rank-section summary-rank-fastest">
        <h3 className="summary-rank-heading">
          <span className="summary-rank-dot" aria-hidden="true" />
          Fastest 10
        </h3>
        <div className="summary-top10-grid">{rankings.fastest.map(renderList)}</div>
      </section>
    </>
  )
}

export default SummaryView
