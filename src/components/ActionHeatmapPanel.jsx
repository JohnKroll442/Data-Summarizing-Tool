import ActionStoryHeatmap from './ActionStoryHeatmap'
import ActionCellDetail from './ActionCellDetail'

/**
 * Story × Action view — a full-width max-duration heatmap with an in-place cell
 * drill-down beneath it. Presentational; ActionView owns the matrix, the
 * selection, and the cell-toggle logic (passed as onSelectCell).
 */
function ActionHeatmapPanel({
  matrix,
  selectedKey,
  selectedCell,
  selectedCellData,
  onSelectCell,
  scopedRows,
  headers,
  byActionKey,
  tierByType,
  onCloseDetail,
  detailRef,
}) {
  return (
    <section className="action-view-fullscreen" aria-label="Story by action heatmap">
      <ActionStoryHeatmap matrix={matrix} selectedKey={selectedKey} onSelectCell={onSelectCell} />
      {selectedCell && selectedCellData && (
        <ActionCellDetail
          story={selectedCell.story}
          action={selectedCell.action}
          cell={selectedCellData}
          rows={scopedRows}
          headers={headers}
          byActionKey={byActionKey}
          tierByType={tierByType}
          onClose={onCloseDetail}
          detailRef={detailRef}
        />
      )}
    </section>
  )
}

export default ActionHeatmapPanel
