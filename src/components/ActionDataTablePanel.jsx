import ActionSummaryTable from './ActionSummaryTable'
import ActionWaterfallPanel from './ActionWaterfallPanel'
import DurationDistribution from './DurationDistribution'
import AnomalySummaryPanel from './AnomalySummaryPanel'

/**
 * Data Table view — the Action view's default panel: a sticky left rail
 * (duration histogram + anomaly summary) beside the one-row-per-action table,
 * with the inline waterfall panel opening below the table. Purely
 * presentational; ActionView owns all state and passes it down.
 */
function ActionDataTablePanel({
  // rail — duration histogram
  durations,
  bands,
  hoveredDuration,
  durationBucket,
  onSelectBucket,
  // rail — anomaly summary
  anomalyCounts,
  totalFlagged,
  totalActions,
  hoveredFlags,
  anomalyTypeFilter,
  onSelectAnomalyType,
  tierByType,
  // table
  rows,
  headers,
  onOpenWaterfall,
  onFilteredActionsChange,
  byActionKey,
  onHoverAction,
  onClearAnomalyFilter,
  durationBucketFilter,
  onClearDurationBucket,
  // inline waterfall
  waterfallOpen,
  waterfallActions,
  waterfallInitialKey,
  scopedRows,
  onCloseWaterfall,
  panelRef,
  // anomaly panel visibility
  showAnomalies = true,
  setShowAnomalies,
}) {
  return (
    <div className="action-view">
      <aside className="action-view__rail" aria-label="Action anomaly summary">
        <DurationDistribution
          durations={durations}
          bands={bands}
          highlightDuration={hoveredDuration}
          activeBucketKey={durationBucket}
          onSelectBucket={onSelectBucket}
        />
        {showAnomalies && (
          <AnomalySummaryPanel
            counts={anomalyCounts}
            totalFlagged={totalFlagged}
            totalActions={totalActions}
            hoveredFlags={hoveredFlags}
            activeType={anomalyTypeFilter}
            onSelectType={onSelectAnomalyType}
            tierByType={tierByType}
          />
        )}
      </aside>

      <div className="action-view__main">
        <ActionSummaryTable
          rows={rows}
          headers={headers}
          onOpenWaterfall={onOpenWaterfall}
          onFilteredActionsChange={onFilteredActionsChange}
          byActionKey={byActionKey}
          anomalyTypeFilter={anomalyTypeFilter}
          onHoverAction={onHoverAction}
          onClearAnomalyFilter={onClearAnomalyFilter}
          durationBucketFilter={durationBucketFilter}
          onClearDurationBucket={onClearDurationBucket}
          bands={bands}
          tierByType={tierByType}
          showAnomalies={showAnomalies}
          setShowAnomalies={setShowAnomalies}
        />

        {waterfallOpen && (
          <div ref={panelRef}>
            <ActionWaterfallPanel
              open={waterfallOpen}
              onClose={onCloseWaterfall}
              rows={scopedRows}
              headers={headers}
              actions={waterfallActions}
              initialKey={waterfallInitialKey}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default ActionDataTablePanel
