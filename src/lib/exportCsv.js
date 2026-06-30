/**
 * Tiny CSV exporter for the summary tables.
 *
 * Writes RAW underlying values, not display-formatted strings — a duration
 * of 72340 ms is more useful for re-aggregation in Excel than "1m 12s".
 *
 * Quoting follows RFC 4180-ish rules: any field containing comma, double
 * quote, CR, or LF is wrapped in double quotes; internal quotes are doubled.
 */

export function rowsToCsv(rows, columns) {
  const cols =
    columns && columns.length > 0
      ? columns
      : rows.length > 0
        ? Object.keys(rows[0]).map((k) => ({ key: k, label: k }))
        : []
  if (cols.length === 0) return ''

  const header = cols.map((c) => quoteField(c.label ?? c.key)).join(',')
  const lines = rows.map((row) =>
    cols.map((c) => quoteField(row?.[c.key])).join(',')
  )
  return [header, ...lines].join('\r\n')
}

function quoteField(v) {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revoke so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function buildExportFilename(baseName, viewId, now = new Date()) {
  const base = (baseName || 'data').replace(/\.[^.]+$/, '')
  const pad = (n) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${base}-${viewId}-${stamp}.csv`
}
