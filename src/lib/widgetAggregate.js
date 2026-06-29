/**
 * Widget-level aggregation for the Widget View summary table.
 *
 * One row per distinct WIDGET_ID. Columns:
 *   Widget ID · Widget name · Render · Network · Backend
 *
 * In this CSV shape each row carries a WIDGET_MEASURE flag of
 *   render | backend | network | offset
 * and the timing lives in DURATION. So per-widget timings are computed as
 *   max(DURATION) where WIDGET_MEASURE = 'render'  → Render
 *   max(DURATION) where WIDGET_MEASURE = 'network' → Network
 *   max(DURATION) where WIDGET_MEASURE = 'backend' → Backend
 *
 * Returns { rows, columns, mapping } so the table can render predictable
 * columns and we can flag missing fields.
 */

export function aggregateByWidget(rows, headers) {
  const mapping = detectMapping(headers)

  const columns = [
    { key: 'widget_id',   label: 'Widget ID' },
    { key: 'widget_name', label: 'Widget name' },
    { key: 'render',      label: 'Render' },
    { key: 'network',     label: 'Network' },
    { key: 'backend',     label: 'Backend' },
  ]

  if (!mapping.widgetId || !rows?.length) {
    return { rows: [], columns, mapping }
  }

  const groups = new Map()
  for (const row of rows) {
    const wid = row?.[mapping.widgetId]
    if (wid === undefined || wid === null || wid === '') continue
    const key = String(wid)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const outRows = []
  for (const [widgetId, groupRows] of groups) {
    outRows.push({
      widget_id:   widgetId,
      widget_name: firstNonEmpty(groupRows, mapping.widgetName),
      render:      maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['render', 'frontend']),
      network:     maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['network']),
      backend:     maxNumericWhere(groupRows, mapping.duration, mapping.measure, ['backend']),
    })
  }

  return { rows: outRows, columns, mapping }
}

/* ——— helpers ——— */

function firstNonEmpty(rows, key) {
  if (!key) return ''
  for (const r of rows) {
    const v = r?.[key]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

function maxNumericWhere(rows, durationKey, measureKey, targets) {
  if (!durationKey || !measureKey) return ''
  const wanted = new Set(targets.map((t) => t.toLowerCase()))
  let max = -Infinity
  let found = false
  for (const r of rows) {
    const m = r?.[measureKey]
    if (m === undefined || m === null) continue
    if (!wanted.has(String(m).toLowerCase())) continue
    const n = Number(r?.[durationKey])
    if (Number.isFinite(n)) {
      if (n > max) max = n
      found = true
    }
  }
  return found ? max : ''
}

function detectMapping(headers) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_\-.]+/g, '')

  const find = (exacts, substrings, reject = () => false) => {
    for (const h of headers) {
      if (reject(h)) continue
      if (exacts.includes(norm(h))) return h
    }
    for (const h of headers) {
      if (reject(h)) continue
      const n = norm(h)
      if (substrings.some((s) => n.includes(s))) return h
    }
    return ''
  }

  const widgetId = find(['widgetid'], ['widgetid'])

  // `widgetname` is an unambiguous exact match — no need for substring
  // rejection (and the previous reject('id') accidentally caught
  // "widgetname" because "wIDgetname" literally contains the letters "id").
  const widgetName = find(['widgetname'], ['widgetname'])

  const measure = find(
    ['widgetmeasure', 'measure'],
    ['widgetmeasure'],
    (h) => norm(h).includes('sub'),
  )

  const duration = find(
    ['duration'],
    ['duration'],
    (h) => {
      const n = norm(h)
      return n.startsWith('widget') || n.includes('action') ||
             n.includes('story') || n.includes('session')
    },
  ) || find(['duration'], ['duration'])

  return { widgetId, widgetName, measure, duration }
}
