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
