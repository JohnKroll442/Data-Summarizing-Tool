import { useMemo } from 'react'
import { useCsvData } from '../../context/useCsvData'
import { compareKpis, compareEntities } from '../../lib/compare'
import KpiDeltaStrip from '../../components/KpiDeltaStrip'
import DeltaTable from '../../components/DeltaTable'
import { formatDurationMs } from '../../lib/format'

/**
 * ActionCompare — action-level KPI + entity deltas between the baseline
 * and current CSV. Metric shown per-action is the average total duration.
 */
function ActionCompare() {
  const { baselinePayload, currentPayload } = useCsvData()

  const kpis = useMemo(
    () => compareKpis('action', baselinePayload, currentPayload),
    [baselinePayload, currentPayload]
  )
  const { matched, newInCurrent, droppedFromBaseline } = useMemo(
    () => compareEntities('action', baselinePayload, currentPayload),
    [baselinePayload, currentPayload]
  )

  return (
    <>
      <KpiDeltaStrip kpis={kpis} />
      <DeltaTable
        title="Actions — Avg total duration"
        metricLabel="Avg duration"
        formatValue={formatDurationMs}
        matched={matched}
        newInCurrent={newInCurrent}
        droppedFromBaseline={droppedFromBaseline}
        regressionThresholdPct={10}
      />
    </>
  )
}

export default ActionCompare
