import {
  BASE_TEXT_STYLE,
  BASE_TOOLTIP,
  SAP_BLUE,
  SAP_GOLD,
  chartFontSizes,
} from '../../../lib/chartColors'

/**
 * buildStoryAnomalyOption — horizontal grouped bar chart.
 *
 * Two bars per story (category on the Y axis):
 *   Total actions   →  SAP blue
 *   Anomalous actions → SAP gold/amber
 *
 * The category axis is rendered bottom-to-top in ECharts, so the input data
 * (which arrives sorted highest→lowest anomaly count) is reversed here so the
 * story with the most anomalies always appears at the TOP of the chart.
 *
 * Tooltip shows all four values: story name, total, anomaly count, and rate.
 *
 * @param {Array<{
 *   story: string,
 *   total: number,
 *   anomalies: number,
 *   anomalyRatio: number   // e.g. 41.3  (percent, not decimal)
 * }>} data  Pre-sorted descending by anomaly count, already sliced to top-N.
 * @returns {object} ECharts option object.
 */
export function buildStoryAnomalyOption(data) {
  if (!data?.length) return { series: [] }

  const sz = chartFontSizes()

  // Reverse so the first array item (highest anomalies) lands at the TOP
  // of the horizontal chart, not the bottom.
  const rows      = data.slice().reverse()
  const stories   = rows.map((d) => d.story)
  const totals    = rows.map((d) => d.total)
  const anomalies = rows.map((d) => d.anomalies)
  const ratios    = rows.map((d) => d.anomalyRatio)

  return {
    textStyle: BASE_TEXT_STYLE,

    tooltip: {
      ...BASE_TOOLTIP,
      // 'axis' trigger groups both series in one card — better for grouped bars
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter(params) {
        if (!params?.length) return ''
        const idx   = params[0].dataIndex
        const story = stories[idx] ?? ''
        const total = totals[idx] ?? 0
        const anom  = anomalies[idx] ?? 0
        const ratio = ratios[idx] ?? 0
        return [
          `<strong style="font-size:13px">${story}</strong>`,
          `Total actions: <strong>${total.toLocaleString()}</strong>`,
          `Anomalies: <strong>${anom.toLocaleString()}</strong>`,
          `Anomaly rate: <strong>${ratio}%</strong>`,
        ].join('<br/>')
      },
    },

    legend: {
      data: ['Total', 'Anomalies'],
      top: 4,
      right: 8,
      textStyle: { fontSize: sz.legend, ...BASE_TEXT_STYLE },
    },

    // containLabel: true lets ECharts absorb long story-name labels into the
    // grid without them overflowing the chart container.
    grid: {
      left: 8,
      right: 52,   // room for end-of-bar value labels
      top: 36,
      bottom: 8,
      containLabel: true,
    },

    xAxis: {
      type: 'value',
      axisLabel: {
        fontSize: sz.axis,
        // Abbreviate large counts (1 000 → 1k) to keep the axis compact
        formatter: (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v),
      },
    },

    yAxis: {
      type: 'category',
      data: stories,
      axisLabel: {
        fontSize: sz.axis,
        // containLabel:true in the grid means ECharts automatically widens
        // the left margin to fit the longest name — no truncation needed.
      },
    },

    series: [
      {
        name: 'Total',
        type: 'bar',
        data: totals,
        itemStyle: {
          color: SAP_BLUE,
          borderRadius: [0, 3, 3, 0],
        },
        label: {
          show: true,
          position: 'right',
          fontSize: sz.barLabel,
          color: BASE_TEXT_STYLE.color,
          formatter: (p) => (p.value > 0 ? p.value.toLocaleString() : ''),
        },
      },
      {
        name: 'Anomalies',
        type: 'bar',
        data: anomalies,
        itemStyle: {
          color: SAP_GOLD,
          borderRadius: [0, 3, 3, 0],
        },
        label: {
          show: true,
          position: 'right',
          fontSize: sz.barLabel,
          color: BASE_TEXT_STYLE.color,
          formatter: (p) => (p.value > 0 ? p.value.toLocaleString() : ''),
        },
      },
    ],
  }
}
