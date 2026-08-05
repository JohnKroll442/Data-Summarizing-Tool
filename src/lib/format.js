/**
 * Format a CSV timestamp cell as a clean, YEAR-LESS time string. Handles three
 * shapes the parser actually produces:
 *
 *  1. A JS Date object — papaparse's `dynamicTyping` turns Excel-style
 *     time cells like "17:58.2" into a Date anchored on 1899-12-30. We
 *     want only the time-of-day portion.
 *  2. A string that already looks like a date-time ("2026-07-01 10:00:00.5",
 *     "2026-07-01T10:00:00.500Z") — drop the leading year (and normalize an
 *     ISO 'T'/'Z') so it reads "07-01 10:00:00.5". A time-only string
 *     ("17:58.2") has no year and is passed through, just stripping
 *     insignificant trailing zeros after the decimal point.
 *  3. Anything else — coerce to String.
 *
 * The year is intentionally never shown (per product decision): the data is
 * scoped to a single period, so the year is noise. Returns '' for empty /
 * null / undefined.
 */
export function formatCsvTime(value) {
  if (value === '' || value === null || value === undefined) return ''

  // Case 1: a real Date from papaparse
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const h = value.getHours()
    const m = String(value.getMinutes()).padStart(2, '0')
    const s = String(value.getSeconds()).padStart(2, '0')
    // Fractional second — keep one decimal place if it isn't zero
    const ms = value.getMilliseconds()
    const frac = ms === 0 ? '' : `.${Math.round(ms / 100)}`
    return h === 0 ? `${m}:${s}${frac}` : `${h}:${m}:${s}${frac}`
  }

  // Case 2/3: stringify, then drop a leading date year and clean up.
  const str = String(value).trim()
    // "2026-07-01 10:00:..." / "2026-07-01T10:00:..." → "07-01 10:00:..."
    // (keep month-day, drop the 4-digit year, normalize the ISO 'T' to a space)
    .replace(/^\d{4}[-/](\d{1,2})[-/](\d{1,2})[ T]/, '$1-$2 ')
    .replace(/Z$/, '') // drop a trailing ISO UTC marker if one remains
    .trim()
  // e.g. "07-01 10:00:00.20000" → "…10:00:00.2",  "17:58.0" → "17:58"
  return str.replace(/(\.\d*?)0+(?!\d)/, '$1').replace(/\.$/, '')
}

/**
 * Strip the prefix from a user/username value: drop everything up to and
 * including the FIRST underscore, so "APAC_jsmith" displays as "jsmith".
 * Values with no underscore pass through unchanged; empty / null / undefined
 * are returned as-is.
 */
export function stripUserPrefix(value) {
  if (value === '' || value === null || value === undefined) return value
  const str = String(value)
  const i = str.indexOf('_')
  return i === -1 ? str : str.slice(i + 1)
}

/**
 * Format a continuous epoch-ms window as a compact
 * "Jul 5, 03:35 → Jul 13, 17:04" label. Matches the Activity Timeline's window
 * labels so the tables' timeline-range banner reads the same.
 */
export function formatTimeRangeLabel(min, max) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const f = (ms) => {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return `${f(min)} → ${f(max)}`
}

/**
 * Convert raw bytes into a human-readable string (e.g. "1.2 MB").
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Format an integer with locale-aware thousands separators.
 */
export function formatCount(n) {
  return Number(n).toLocaleString()
}

/**
 * Detect whether a column key holds duration-in-milliseconds values, based on
 * the column name. Mirrors the aggregate tables' DURATION_COLUMNS sets:
 * "DURATION", "max_frontend/network/backend", "render/network/backend/offset"
 * all resolve to true. Used by chart builders to switch numeric axes and
 * tooltips over to formatDurationMs when the value being plotted is a
 * duration.
 */
export function isDurationColumn(key) {
  if (!key) return false
  const n = String(key).toLowerCase().replace(/[\s_\-.]+/g, '')
  return (
    n === 'duration' ||
    n.endsWith('duration') ||
    n.includes('durationms') ||
    n === 'render' || n === 'offset' || n === 'latency' ||
    n === 'maxfrontend' || n === 'maxnetwork' || n === 'maxbackend' ||
    n === 'network' || n === 'backend' || n === 'frontend' ||
    n.includes('renderduration') ||
    n.includes('backendduration') ||
    n.includes('networkduration') ||
    n.includes('frontendduration') ||
    // Synthetic measure columns: "Total Render", "Total Frontend", etc.
    n.startsWith('total')
  )
}

/**
 * Format a number-of-milliseconds value as a short, human-readable duration:
 *   < 1 ms       → "0.4 ms"
 *   < 1 s        → "847 ms"
 *   < 60 s       → "32.7 s"
 *   ≥ 60 s       → "1m 12s"
 *
 * Non-finite / empty values pass through as ''.
 */
export function formatDurationMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  if (n < 1) return `${n.toFixed(2)} ms`
  if (n < 1000) return `${Math.round(n)} ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`
  const totalSec = Math.round(n / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m ${s}s`
}
