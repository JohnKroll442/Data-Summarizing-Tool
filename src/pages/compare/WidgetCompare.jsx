import { useMemo } from 'react'
import { useCsvData } from '../../context/useCsvData'
import { compareKpis, compareEntities } from '../../lib/compare'
import KpiDeltaStrip from '../../components/KpiDeltaStrip'
import DeltaTable from '../../components/DeltaTable'
import { formatDurationMs } from '../../lib/format'

/**
 * WidgetCompare — widget-level KPI + entity deltas between the baseline
 * and current CSV. Metric shown per-widget is render time.
 */
function WidgetCompare() {
  const { baselinePayload, currentPayload } = useCsvData()

  const kpis = useMemo(
    () => compareKpis('widget', baselinePayload, currentPayload),
    [baselinePayload, currentPayload]
  )
  const { matched, newInCurrent, droppedFromBaseline } = useMemo(
    () => compareEntities('widget', baselinePayload, currentPayload),
    [baselinePayload, currentPayload]
  )

  return (
    <>
      <KpiDeltaStrip kpis={kpis} />
      <DeltaTable
        title="Widgets — Render time"
        metricLabel="Render"
        formatValue={formatDurationMs}
        matched={matched}
        newInCurrent={newInCurrent}
        droppedFromBaseline={droppedFromBaseline}
        regressionThresholdPct={10}
      />
    </>
  )
}

export default WidgetCompare
