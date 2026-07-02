import { useMemo } from 'react'
import { useCsvData } from '../../context/useCsvData'
import { compareKpis, compareEntities } from '../../lib/compare'
import KpiDeltaStrip from '../../components/KpiDeltaStrip'
import DeltaTable from '../../components/DeltaTable'
import { formatDurationMs } from '../../lib/format'

/**
 * SessionCompare — session-level KPI + entity deltas between the baseline
 * and current CSV. Metric shown per-session is the max action duration.
 */
function SessionCompare() {
  const { baselinePayload, currentPayload } = useCsvData()

  const kpis = useMemo(
    () => compareKpis('session', baselinePayload, currentPayload),
    [baselinePayload, currentPayload]
  )
  const { matched, newInCurrent, droppedFromBaseline } = useMemo(
    () => compareEntities('session', baselinePayload, currentPayload),
    [baselinePayload, currentPayload]
  )

  return (
    <>
      <KpiDeltaStrip kpis={kpis} />
      <DeltaTable
        title="Sessions — Max action duration"
        metricLabel="Max duration"
        formatValue={formatDurationMs}
        matched={matched}
        newInCurrent={newInCurrent}
        droppedFromBaseline={droppedFromBaseline}
        regressionThresholdPct={10}
      />
    </>
  )
}

export default SessionCompare
