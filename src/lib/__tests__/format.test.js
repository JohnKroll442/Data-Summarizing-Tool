import { describe, it, expect } from 'vitest'
import {
  formatCsvTime,
  formatFileSize,
  formatCount,
  formatDurationMs,
} from '../format'

describe('formatDurationMs', () => {
  it('formats sub-millisecond values with two decimals', () => {
    expect(formatDurationMs(0.4)).toBe('0.40 ms')
  })

  it('rounds to the nearest ms under one second', () => {
    expect(formatDurationMs(847)).toBe('847 ms')
    expect(formatDurationMs(999.4)).toBe('999 ms')
  })

  it('switches to seconds under one minute', () => {
    expect(formatDurationMs(32700)).toBe('32.7 s')
    expect(formatDurationMs(1000)).toBe('1.0 s')
  })

  it('switches to minutes+seconds at 60s and above', () => {
    expect(formatDurationMs(72000)).toBe('1m 12s')
    expect(formatDurationMs(60000)).toBe('1m 0s')
  })

  it('returns empty string for non-finite / non-numeric values', () => {
    // Note: Number(null) === 0 (finite) — so null renders as '0.00 ms'.
    // Number(undefined) === NaN — so undefined renders as ''.
    expect(formatDurationMs(undefined)).toBe('')
    expect(formatDurationMs('not a number')).toBe('')
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('')
    expect(formatDurationMs(NaN)).toBe('')
  })

  it('treats null as 0 (Number(null) === 0)', () => {
    expect(formatDurationMs(null)).toBe('0.00 ms')
  })
})

describe('formatCsvTime', () => {
  it('returns empty string for empty / nullish input', () => {
    expect(formatCsvTime('')).toBe('')
    expect(formatCsvTime(null)).toBe('')
    expect(formatCsvTime(undefined)).toBe('')
  })

  it('strips insignificant trailing zeros on numeric strings', () => {
    expect(formatCsvTime('17:58.20000')).toBe('17:58.2')
    expect(formatCsvTime('17:58.0')).toBe('17:58')
    expect(formatCsvTime('17:58')).toBe('17:58')
  })

  it('formats a Date without hours as mm:ss', () => {
    const d = new Date(1899, 11, 30, 0, 17, 58, 200)
    expect(formatCsvTime(d)).toBe('17:58.2')
  })

  it('formats a Date with hours as h:mm:ss', () => {
    const d = new Date(1899, 11, 30, 1, 23, 45, 600)
    expect(formatCsvTime(d)).toBe('1:23:45.6')
  })

  it('coerces non-string non-Date values via String()', () => {
    expect(formatCsvTime(42)).toBe('42')
  })
})

describe('formatFileSize', () => {
  it('formats bytes, KB, MB, GB', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatFileSize(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})

describe('formatCount', () => {
  it('applies locale-aware thousand separators', () => {
    // Not pinning to en-US: some locales use "." others use ",". Any of these
    // proves the separator was applied.
    expect(formatCount(1234)).toMatch(/1[.,\s  ]?234/)
  })

  it('coerces numeric strings before formatting', () => {
    expect(formatCount('1000')).toMatch(/1[.,\s  ]?000/)
  })
})
