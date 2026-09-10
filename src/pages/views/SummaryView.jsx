import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Card,
  CardHeader,
  List,
  ListItemStandard,
  MessageStrip,
  ObjectStatus,
  Title,
} from '@ui5/webcomponents-react'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'
import { computeRankings, computeBusiest } from '../../lib/summary'
import { computeSummaryScope, activeDurationBounds, activeWidgetPhaseBounds } from '../../lib/viewFilters'
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

  // The active duration threshold (from any view's duration filter —
  // Session/Action/Widget) applies to the rankings by each entity's OWN value —
  // so "< 2 min" hides long entities everywhere and "> 2 min" surfaces the long
  // ttfb/incomplete ones — rather than by session membership (excluded from the
  // scope above).
  const durationBounds = useMemo(
    () => activeDurationBounds({ viewUi }),
    [viewUi],
  )

  // The Widget view's per-phase thresholds (set by the p95 cards or the phase
  // duration menus). Each narrows only its matching widget ranking, so clicking
  // "p95 render" reshapes the Summary's render list to the same tail the Widget
  // table shows.
  const phaseBounds = useMemo(
    () => activeWidgetPhaseBounds({ viewUi }),
    [viewUi],
  )

  const rankings = useMemo(
    () => computeRankings(scopedRows, headers, { range: timelineRange, durationBounds, phaseBounds }),
    [scopedRows, headers, timelineRange, durationBounds, phaseBounds],
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
        { key: 'day', label: 'Busiest Day', period: busiest.day },
        { key: 'week', label: 'Busiest 7 Days', period: busiest.week },
        { key: 'month', label: 'Busiest 30 Days', period: busiest.month },
      ].filter((c) => c.period)
    : []

  // ── Ranking card (Card + List of up to 10 ListItemStandard rows) ────────
  const renderList = (list) => (
    <Card key={list.id} header={<CardHeader titleText={list.title} />}>
      {list.items.length === 0 ? (
        <p className="summary-top10-empty">No data for this metric.</p>
      ) : (
        <List selectionMode="None">
          {list.items.map((it, i) => (
            <ListItemStandard
              key={`${it.label}-${i}`}
              description={it.sublabel ?? undefined}
              additionalText={formatDurationMs(it.value)}
              type="Navigation"
              onClick={() => openEntity(it.nav)}
            >
              {i + 1}.&nbsp;{it.label}
            </ListItemStandard>
          ))}
        </List>
      )}
    </Card>
  )

  return (
    <>
      <HeaderPortal />

      {/* Timeline range banner — MessageStrip close button = "Clear" */}
      {timelineRange && (
        <div className="summary-ms-wrap">
          <MessageStrip design="Information" onClose={resetTimeline}>
            Busiest periods and rankings for the timeline window&nbsp;
            <strong>{formatTimeRangeLabel(timelineRange.min, timelineRange.max)}</strong>
          </MessageStrip>
        </div>
      )}

      {/* Busiest period cards — CardHeader interactive = full-header click target */}
      {busiestCards.length > 0 && (
        <div className="summary-busiest" role="group" aria-label="Busiest periods">
          {busiestCards.map((c) => (
            <Card
              key={c.key}
              className="summary-busiest-card-ui5"
              header={
                <CardHeader
                  titleText={c.label}
                  subtitleText={c.period.label}
                  interactive
                  onHeaderClick={() => focusTimeline(c.period.min, c.period.max)}
                  action={
                    <ObjectStatus state="Information">
                      {formatCount(c.period.count)}&nbsp;actions
                    </ObjectStatus>
                  }
                />
              }
            />
          ))}
        </div>
      )}

      {/* Slowest 10 */}
      <section className="summary-rank-section">
        <Title level="H4" className="summary-rank-title">Slowest 10</Title>
        <div className="summary-top10-grid">{rankings.slowest.map(renderList)}</div>
      </section>

      <hr className="summary-rank-divider" />

      {/* Fastest 10 */}
      <section className="summary-rank-section">
        <Title level="H4" className="summary-rank-title">Fastest 10</Title>
        <div className="summary-top10-grid">{rankings.fastest.map(renderList)}</div>
      </section>
    </>
  )
}

export default SummaryView
