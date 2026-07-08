import { profileColumns } from '../chartData'

const MAX_SAMPLE_ROWS = 2000
const MAX_SAMPLE_VALUES = 3

export function buildSchemaSummary({ activePayload, baselinePayload, currentPayload }) {
  return [
    describePayload(activePayload, 'active'),
    describePayload(baselinePayload, 'baseline'),
    describePayload(currentPayload, 'current'),
  ].filter(Boolean).join('\n\n')
}

function describePayload(payload, label) {
  if (!payload?.rows?.length) return `${label}: (none loaded)`
  const { rows, headers, fileName } = payload
  const profile = profileColumns(rows, headers)
  const sample = rows.slice(0, MAX_SAMPLE_ROWS)
  const lines = [`${label}: ${fileName || '(unnamed)'} (${rows.length.toLocaleString()} rows)`, '  columns:']
  for (const h of headers) {
    const info = profile[h] || {}
    const type = info.type || 'unknown'
    const distinct = info.distinctCount ?? 0
    const examples = collectExamples(sample, h)
    const bits = [`${type}`, `${distinct} distinct`]
    if (type === 'numeric') {
      const stats = numericStats(sample, h)
      if (stats) bits.push(`min ${stats.min}`, `p50 ${stats.p50}`, `max ${stats.max}`)
    }
    if (examples.length) bits.push(`e.g. ${examples.map(quoteExample).join(', ')}`)
    lines.push(`    ${h} (${bits.join(', ')})`)
  }
  return lines.join('\n')
}

function collectExamples(rows, key) {
  const seen = new Set()
  for (const row of rows) {
    const v = row?.[key]
    if (v === undefined || v === null || v === '') continue
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    seen.add(s)
    if (seen.size >= MAX_SAMPLE_VALUES) break
  }
  return [...seen]
}

function quoteExample(s) {
  const short = s.length > 40 ? s.slice(0, 37) + '…' : s
  return `"${short}"`
}

function numericStats(rows, key) {
  const nums = []
  for (const row of rows) {
    const n = Number(row?.[key])
    if (Number.isFinite(n)) nums.push(n)
  }
  if (!nums.length) return null
  nums.sort((a, b) => a - b)
  return {
    min: fmt(nums[0]),
    p50: fmt(nums[Math.floor(nums.length / 2)]),
    max: fmt(nums[nums.length - 1]),
  }
}

function fmt(n) {
  if (Math.abs(n) >= 1000) return n.toFixed(0)
  if (Math.abs(n) >= 1) return n.toFixed(1)
  return n.toFixed(3)
}
