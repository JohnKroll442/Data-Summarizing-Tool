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
