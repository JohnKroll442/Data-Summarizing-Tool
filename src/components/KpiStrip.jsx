import { useMemo } from 'react'
import { Card, AnalyticalCardHeader } from '@ui5/webcomponents-react'
import { computeKpis } from '../lib/kpis'
import './KpiStrip.css'

function KpiStrip({ variant, rows, headers, kpis: kpisProp, columns }) {
  const kpis = useMemo(
    () => (kpisProp !== undefined ? kpisProp : computeKpis(variant, rows, headers)),
    [kpisProp, variant, rows, headers],
  )
  if (!kpis) return null
  const style = columns
    ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
    : undefined
  return (
    <div className="kpi-strip" role="group" aria-label={`${variant} KPIs`} style={style}>
      {kpis.map((k) => {
        const clickable = typeof k.onClick === 'function'
        return (
          <Card
            key={k.label}
            className={
              clickable
                ? `kpi-card-ui5 is-clickable${k.active ? ' is-active' : ''}`
                : 'kpi-card-ui5'
            }
            header={
              <AnalyticalCardHeader
                titleText={k.label}
                value={String(k.value)}
                state={k.state ?? 'None'}
                onClick={clickable ? k.onClick : undefined}
                aria-pressed={clickable ? String(Boolean(k.active)) : undefined}
                tooltip={k.hint || undefined}
              />
            }
          />
        )
      })}
    </div>
  )
}

export default KpiStrip
