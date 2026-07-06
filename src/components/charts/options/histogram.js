import { bin } from '../../../lib/chartData'
import { formatDurationMs, isDurationColumn } from '../../../lib/format'
import {
  BASE_GRID,
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
} from '../../../lib/chartColors'

/** Histogram — bins values of `key` into `binCount` equal-width buckets. */
export function buildHistogramOption(rows, { key, binCount = 10 } = {}) {
  if (!key) return { series: [] }
  const bins = bin(rows, key, binCount)
  const isDur = isDurationColumn(key)
  const labels = isDur
    ? bins.map((b) => formatBinRange(b.name))
    : bins.map((b) => b.name)
  return {
    color: [SAP_BLUE],
    textStyle: BASE_TEXT_STYLE,
    tooltip: { ...BASE_TOOLTIP, trigger: 'axis' },
    grid: BASE_GRID,
    xAxis: { type: 'category', data: labels, axisLabel: { rotate: 30, fontSize: 10 } },
    yAxis: { type: 'value' },
    series: [
      {
        type: 'bar',
        barCategoryGap: '5%',
        data: bins.map((b) => b.value),
        itemStyle: { borderRadius: [3, 3, 0, 0] },
      },
    ],
  }
}

/**
 * `bin` produces labels like "12.34 – 56.78". Reformat each numeric endpoint
 * as a duration so a histogram of DURATION values shows "1.2 s – 2.5 s"
 * instead of raw millisecond numbers.
 */
function formatBinRange(label) {
  const s = String(label ?? '')
  const parts = s.split(/[–-]/)
  if (parts.length !== 2) return s
  const lo = Number(parts[0])
  const hi = Number(parts[1])
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return s
  return `${formatDurationMs(lo)} – ${formatDurationMs(hi)}`
}
