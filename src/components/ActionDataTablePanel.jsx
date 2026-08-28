import ActionSummaryTable from './ActionSummaryTable'
import ActionCellDetail from './ActionCellDetail'
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
  // inline waterfall → action detail (ActionCellDetail)
  waterfallOpen,
  waterfallActions,
  waterfallInitialKey,
  scopedRows,
  onCloseWaterfall,
  panelRef,
  // action-detail props (ActionCellDetail-style left list + right waterfall)
  detailCell,
  detailActionName,
  detailStory,
  detailInitialTs,
  // anomaly panel visibility
  showAnomalies = true,
  setShowAnomalies,
  // configurable detection thresholds — forwarded to AnomalySummaryPanel
  thresholds,
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
            thresholds={thresholds}
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

        {waterfallOpen && detailCell && (
          <ActionCellDetail
            story={detailStory}
            action={detailActionName}
            cell={detailCell}
            rows={scopedRows}
            headers={headers}
            byActionKey={byActionKey}
            tierByType={tierByType}
            initialInstanceTs={detailInitialTs}
            onClose={onCloseWaterfall}
            detailRef={panelRef}
          />
        )}
      </div>
    </div>
  )
}

export default ActionDataTablePanel
