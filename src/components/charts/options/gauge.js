import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
} from '../../../lib/chartColors'

/**
 * Gauge chart — by default reads the first numeric value of `valueKey` across
 * `rows` and shows it as a percent of `max`. Pass `numericKpi: true` for a
 * detail-only "big number" presentation (no dial).
 */
export function buildGaugeOption(rows, { valueKey, max = 100, numericKpi = false } = {}) {
  if (!valueKey) return { series: [] }
  const nums = rows
    .map((r) => Number(r?.[valueKey]))
    .filter((n) => Number.isFinite(n))
  if (!nums.length) return { series: [] }
  const value = nums.reduce((a, b) => a + b, 0) / nums.length
  const computedMax = Math.max(max, Math.ceil(value * 1.2))
  const isDur = isDurationColumn(valueKey)
  const detailFmt = isDur
    ? (v) => formatDurationMs(v)
    : (v) => `${v.toFixed(1)}`

  if (numericKpi) {
    return {
      textStyle: BASE_TEXT_STYLE,
      series: [
        {
          type: 'gauge',
          radius: 0,
          axisLine: { show: false },
          progress: { show: false },
          pointer: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          detail: {
            offsetCenter: [0, 0],
            fontSize: 36,
            fontWeight: 700,
            color: SAP_BLUE,
            formatter: detailFmt,
          },
          data: [{ value }],
        },
      ],
    }
  }

  return {
    textStyle: BASE_TEXT_STYLE,
    tooltip: BASE_TOOLTIP,
    series: [
      {
        type: 'gauge',
        startAngle: 200,
        endAngle: -20,
        min: 0,
        max: computedMax,
        progress: { show: true, width: 12 },
        axisLine: { lineStyle: { width: 12 } },
        pointer: { width: 4, length: '60%' },
        anchor: { show: true, showAbove: true, size: 14, itemStyle: { color: SAP_BLUE } },
        ...(isDur
          ? { axisLabel: { formatter: (v) => formatDurationMs(v), fontSize: 10 } }
          : {}),
        detail: { fontSize: 22, color: SAP_BLUE, formatter: detailFmt },
        data: [{ value }],
      },
    ],
  }
}
