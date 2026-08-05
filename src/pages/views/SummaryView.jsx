import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'
import { computeRankings, computeBusiest } from '../../lib/summary'
import { computeSummaryScope, activeDurationBounds } from '../../lib/viewFilters'
import { formatDurationMs, formatCount, formatTimeRangeLabel } from '../../lib/format'
import './SummaryView.css'

/**
 * SummaryView — the landing tab. A "busiest periods" strip (day / week / month
 * by action count), then two clearly-split ranking sections: the SLOWEST 10 and
 * the FASTEST 10 for each category. Each list row links to the entity's view.
 *
 * Everything here recomputes over the SAME entities the view tables currently
 * show: the busiest periods and rankings reflect the filters set in the
 * Session / Action / Widget views (intersected — a Session filter drops that
 * session's actions and widgets, etc.) AND the Activity Timeline window
 * (`timelineRange`), which compose together. `computeSummaryScope` re-derives
 * each view's filtered set from persisted context state (the tables aren't
 * mounted here) and narrows the raw rows once before re-aggregation.
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
    pushNavSnapshot,
    viewUi,
    sessionFilter,
    actionFilter,
    sessionMultiFilter,
    actionMultiFilter,
    actionInvocationFilter,
    widgetMultiFilter,
    timeSelections,
  } = useCsvData()
  const navigate = useNavigate()
  const location = useLocation()

  // Re-derive the entities each view currently shows and intersect them into a
  // scoped raw-row set, so the Summary rebuilds from exactly what's filtered.
  const { scopedRows } = useMemo(
    () => computeSummaryScope(rows, headers, {
      viewUi,
      sessionFilter,
      actionFilter,
      sessionMultiFilter,
      actionMultiFilter,
      actionInvocationFilter,
      widgetMultiFilter,
      timeSelections,
      timelineRange,
    }),
    [
      rows, headers, viewUi, sessionFilter, actionFilter, sessionMultiFilter,
      actionMultiFilter, actionInvocationFilter, widgetMultiFilter,
      timeSelections, timelineRange,
    ],
  )

  // The active duration threshold (from Session/Action View's duration filter)
  // applies to the rankings by each entity's OWN value — so "< 2 min" hides
  // long entities everywhere and "> 2 min" surfaces the long ttfb/incomplete
  // ones — rather than by session membership (excluded from the scope above).
  const durationBounds = useMemo(
    () => activeDurationBounds({ viewUi }),
    [viewUi],
  )

  const rankings = useMemo(
    () => computeRankings(scopedRows, headers, { range: timelineRange, durationBounds }),
    [scopedRows, headers, timelineRange, durationBounds],
  )
  const busiest = useMemo(
    () => computeBusiest(scopedRows, headers, { range: timelineRange }),
    [scopedRows, headers, timelineRange],
  )

  // Open a ranked row in its view with the entity pre-filtered. A widget ranking
  // also carries a `scope` (the session + activity where that phase's max
  // occurred); we set those as the shared session/action filters so the target
  // view shows them as pills under the Back button, while the `columns` (widget
  // id) still narrow it to exactly the clicked widget. Rankings without a scope
  // (actions) clear any stale drill so the target definitely shows just the
  // clicked entity. Column filters pass as router state — a one-shot the target
  // table seeds from on mount (survives StrictMode; not re-applied on tab clicks).
  const openEntity = (nav) => {
    // Record the Summary view so Back can return to it.
    pushNavSnapshot(location.pathname)
    setSessionFilter(null)
    setActionFilter(null)
    setSessionMultiFilter(nav.scope?.session ? [nav.scope.session] : [])
    setActionMultiFilter(nav.scope?.action ? [nav.scope.action] : [])
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
      <HeaderPortal>
        <h2 className="view-heading">Summary</h2>
      </HeaderPortal>

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
